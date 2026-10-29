import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

// Issue #28: on Windows, restoring historical footer statistics from ~1,450
// shard files blocked Pi's session_start for ~19 s. Restoration now runs in
// the background with a single directory scan and bounded-concurrency I/O.

type Handler = (event: any, context: any) => unknown;

function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function withAgentDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-issue-28-"));
  const names = ["PI_CODING_AGENT_DIR", "PI_CACHE_RETENTION", "PI_CACHE_OPTIMIZER_FOOTER_MODE"];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE = "total";
    await run(dir);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function loadExtension(label: string) {
  const jiti = createJiti(join(process.cwd(), "tests", `issue-28-${label}.ts`), { interopDefault: false, moduleCache: false });
  const loaded = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
  const handlers = new Map<string, Handler>();
  loaded.default({
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    registerCommand() {},
  } as any);
  const statuses: Array<string | undefined> = [];
  const context = {
    model: {
      provider: "proxy", id: "gpt-5.5", name: "GPT-5.5", api: "openai-completions",
      baseUrl: "https://api.openai.com/v1", compat: {}, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192,
    },
    mode: "json",
    hasUI: false,
    sessionManager: { getSessionId: () => `issue-28-${label}` },
    modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
    ui: { notify() {}, setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
  };
  return { loaded, I: loaded.__internals_for_tests, handlers, statuses, context };
}

describe("issue #28 startup stats restoration", () => {
  test("mapWithConcurrency preserves input order and never exceeds its limit", async () => {
    const { I } = await loadExtension("pool");
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, index) => index);
    const results = await I.mapWithConcurrency(items, 4, async (item: number) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, (item * 7) % 5));
      inFlight -= 1;
      return item * 2;
    });
    assert.deepEqual(results, items.map((item) => item * 2));
    assert.ok(peak <= 4, `peak concurrency ${peak} exceeded the limit`);
    assert.ok(peak > 1, "work should actually overlap");
    assert.deepEqual(await I.mapWithConcurrency([], 4, async () => 1), []);
  });

  test("session_start returns before historical stats are restored, then publishes the full aggregate", async () => {
    await withAgentDir(async () => {
      const { I, handlers, statuses, context } = await loadExtension("background");
      const day = localDay();
      const key = "proxy/gpt-5.5";
      const globalEpoch = await I.readGlobalStatsEpoch();
      const modelEpoch = await I.readModelStatsEpoch(key);
      const shardDir = I.SHARD_FILES_DIR;
      await mkdir(shardDir, { recursive: true });
      const shardCount = 300;
      await Promise.all(Array.from({ length: shardCount }, async (_, index) => {
        const instanceId = randomUUID();
        await writeFile(join(shardDir, `${instanceId}.json`), JSON.stringify({
          version: 7, kind: "pi-cache-optimizer-shard", instanceId, sessionHash: `other-session-${index}`,
          process: { pid: 1, ppid: 0, instanceStartedAt: 1 },
          lifecycle: { state: "closed", createdAt: 1, updatedAt: Date.now(), closedAt: Date.now() },
          day, globalEpoch,
          models: { [key]: { modelEpoch, provider: "proxy", modelId: "gpt-5.5", stats: { day, totalRequests: 1, hitRequests: 1, cachedInputTokens: 50, cacheWriteInputTokens: 0, totalInputTokens: 100 } } },
        }));
      }));

      await handlers.get("session_start")!({ reason: "startup" }, context);
      assert.equal(statuses.length, 0, "session_start must not wait for the shard scan before returning");

      await I.waitForStatsRestore();
      assert.match(statuses.at(-1) ?? "", new RegExp(`${shardCount}/${shardCount}`));

      // Later lifecycle events keep working against the restored aggregate.
      await handlers.get("message_end")!({ message: { role: "assistant", provider: "proxy", model: "gpt-5.5", api: "openai-completions", stopReason: "stop", usage: { input: 100, cacheRead: 0, cacheWrite: 0 } } }, context);
      await I.statsRefreshSettled();
      assert.match(statuses.at(-1) ?? "", new RegExp(`${shardCount}/${shardCount + 1}`));
      await handlers.get("session_shutdown")!({}, context);
      const own = (await I.readValidStatsShardsV7()).filter((shard: { sessionHash: string }) => !shard.sessionHash.startsWith("other-session-"));
      assert.equal(own.length, 1);
      assert.equal(own[0].lifecycle.state, "closed");
    });
  });

  test("lifecycle events that arrive during restoration wait for it instead of racing it", async () => {
    await withAgentDir(async () => {
      const { I, handlers, statuses, context } = await loadExtension("race");
      const message = { role: "assistant", provider: "proxy", model: "gpt-5.5", api: "openai-completions", stopReason: "stop", usage: { input: 100, cacheRead: 40, cacheWrite: 0 } };
      await handlers.get("session_start")!({ reason: "startup" }, context);
      // Do not await the restore: message_end's refresh must serialize
      // behind it (2.10: in the background, so wait for that refresh).
      await handlers.get("message_end")!({ message }, context);
      await I.statsRefreshSettled();
      assert.match(statuses.at(-1) ?? "", /1\/1/);
      await handlers.get("session_shutdown")!({}, context);
      const shards = await I.readValidStatsShardsV7();
      assert.equal(shards.length, 1);
      assert.equal(shards[0].models["proxy/gpt-5.5"]?.stats.hitRequests, 1);
    });
  });

  test("a superseded restore does not publish a stale footer after a newer session_start", async () => {
    await withAgentDir(async () => {
      const { I, handlers, context } = await loadExtension("supersede");
      const firstStatuses: Array<string | undefined> = [];
      const firstContext = { ...context, ui: { notify() {}, setStatus(_key: string, value: string | undefined) { firstStatuses.push(value); } } };
      await handlers.get("session_start")!({ reason: "startup" }, firstContext);
      await handlers.get("session_start")!({ reason: "new" }, context);
      await I.waitForStatsRestore();
      assert.equal(firstStatuses.length, 0, "the superseded session context must not receive a footer");
      await handlers.get("session_shutdown")!({}, context);
    });
  });

  test("startup maintenance removes expired shards before the single aggregate scan", async () => {
    await withAgentDir(async () => {
      const { I, handlers, context } = await loadExtension("cleanup");
      const shardDir = I.SHARD_FILES_DIR;
      await mkdir(shardDir, { recursive: true });
      const old = new Date(Date.now() - 90 * 86400_000);
      const instanceId = randomUUID();
      const path = join(shardDir, `${instanceId}.json`);
      await writeFile(path, JSON.stringify({
        version: 7, kind: "pi-cache-optimizer-shard", instanceId, sessionHash: "expired-session",
        process: { pid: 1, ppid: 0, instanceStartedAt: 1 },
        lifecycle: { state: "closed", createdAt: 1, updatedAt: old.getTime(), closedAt: old.getTime() },
        day: localDay(old), globalEpoch: await I.readGlobalStatsEpoch(), models: {},
      }));
      await utimes(path, old, old);
      await handlers.get("session_start")!({ reason: "startup" }, context);
      await I.waitForStatsRestore();
      assert.equal((await readdir(shardDir)).includes(`${instanceId}.json`), false);
      await handlers.get("session_shutdown")!({}, context);
    });
  });
});
