import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

// Regressions for the 2.9.2 adversarial review of the issue #28 archive.
// Faults are injected through test hooks, not file modes, so every test
// also runs as root.

const DAY = 24 * 3600_000;
const HOUR = 3600_000;
const KEY = "proxy/gpt-5.5";

function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function withAgentDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-issue-28-review5-"));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await run(dir);
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

/** A separately loaded module instance: its own caches and lock tokens, like another Pi process. */
async function loadModule(label: string) {
  const jiti = createJiti(join(process.cwd(), "tests", `issue-28-review5-${label}.ts`), { interopDefault: false, moduleCache: false });
  return jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
}
async function load(label: string): Promise<any> {
  return (await loadModule(label)).__internals_for_tests as any;
}

let idCounter = 0;
function nextId(): string {
  idCounter++;
  return `${String(idCounter).padStart(8, "0")}-0000-4000-8000-${String(Date.now() % 1e12).padStart(12, "0")}`;
}

async function shardDoc(I: any, id: string, at: number, requests: number, overrides: Record<string, unknown> = {}) {
  const day = localDay(at);
  return {
    version: 7, kind: "pi-cache-optimizer-shard", instanceId: id, sessionHash: "s",
    process: { pid: 1, ppid: 0, instanceStartedAt: 1 },
    lifecycle: { state: "closed", createdAt: at, updatedAt: at, closedAt: at },
    day, globalEpoch: await I.readGlobalStatsEpoch(),
    models: {
      [KEY]: {
        modelEpoch: await I.readModelStatsEpoch(KEY), provider: "proxy", modelId: "gpt-5.5",
        stats: { day, totalRequests: requests, hitRequests: requests, cachedInputTokens: 10 * requests, cacheWriteInputTokens: 0, totalInputTokens: 20 * requests },
      },
    },
    ...overrides,
  };
}

async function writeClosedShard(I: any, at: number, requests: number): Promise<string> {
  const id = nextId();
  await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, `${id}.json`), await shardDoc(I, id, at, requests));
  return id;
}

/** refreshShardAggregate's read (directory first, then archive), as a session total. */
async function sessionRequests(I: any): Promise<number | undefined> {
  const { rawShards, archive } = await I.readStatsSnapshot();
  const raw = rawShards.filter((shard: any) => !archive.absorbedIds.has(shard.instanceId));
  return (await I.aggregateStatsWithArchiveV7(raw, archive, [], null)).bySession.s?.[KEY]?.totalRequests;
}

const archiveDir = (I: any) => join(I.SHARD_ARCHIVE_PATH, "..");
const genPath = (I: any, generation: number) => I.statsArchiveGenerationPath(I.SHARD_ARCHIVE_PATH, generation);
const errno = (code: string) => Object.assign(new Error(`${code}: injected`), { code });

async function quietly(run: () => Promise<any>): Promise<{ value: any; warnings: unknown[][] }> {
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    return { value: await run(), warnings };
  } finally {
    console.warn = warn;
  }
}

describe("2.9.2 review: an in-place writer that lost its lock deletes nothing", () => {
  test("a no-hard-link writer suspended mid-write past a lock takeover cannot delete shards the new holder's base does not cover", async () => {
    await withAgentDir(async () => {
      const I = await load("inplace-takeover");
      const now = Date.now();
      await writeClosedShard(I, now - 5 * DAY, 2);
      await I.compactStatsShardsV7(now); // generation 1 (hard link)
      await writeClosedShard(I, now - 4 * DAY, 3);

      const tokenA = await I.acquireStatsMaintenanceLock(now);
      assert.ok(tokenA);
      let releaseC!: () => void;
      const cAtBase = new Promise<void>((resolve) => { releaseC = resolve; });
      let resolveADone!: () => void;
      const aDone = new Promise<void>((resolve) => { resolveADone = resolve; });
      let cPass: Promise<any> | undefined;
      let armed = false;
      I.setStatsArchiveTestHooks({
        // Only generation 2 (the suspended writer's) goes in place.
        link: async (from: string, to: string) => {
          if (to === genPath(I, 2)) throw errno("EPERM");
          await link(from, to);
        },
        afterExclusiveCreate: async (target: string) => {
          if (target !== genPath(I, 2)) return;
          // A was suspended right after creating generation 2 for over an
          // hour: its file is empty and old, its lock is stale and taken over.
          const old = new Date(now - 2 * HOUR);
          await utimes(target, old, old);
          const tokenC = await I.acquireStatsMaintenanceLock(now + 2 * HOUR);
          assert.ok(tokenC, "the stale lock is taken over");
          armed = true;
          cPass = quietly(() => I.compactStatsShardsV7(now, I.SHARD_FILES_DIR, I.SHARD_ARCHIVE_PATH, { lockToken: tokenC }));
          await cAtBase;
          // A wakes up and finishes its generation.
        },
        beforeLstat: async (path: string) => {
          // C recovers past the (still incomplete) generation 2 to generation 1,
          // then reads the shard directory only after A finished.
          if (!armed || path !== genPath(I, 1)) return;
          armed = false;
          releaseC();
          await aDone;
        },
      });
      const a = await I.compactStatsShardsV7(now, I.SHARD_FILES_DIR, I.SHARD_ARCHIVE_PATH, { lockToken: tokenA });
      resolveADone();
      const { value: c } = await cPass!;
      I.setStatsArchiveTestHooks(undefined);
      assert.equal(a.removed, 0, "a holder that lost its lock deletes no raw shard");
      assert.equal(c.generation, 3);
      assert.equal(await sessionRequests(await load("inplace-takeover-reader")), 5, "nothing is lost");
    });
  });
});

describe("2.9.2 review: a persistent transient archive error does not freeze other processes' shards", () => {
  test("while the served archive is still the newest generation, the fresh shard listing is used", async () => {
    await withAgentDir(async () => {
      const A = await load("j-freeze-reader");
      const B = await load("j-freeze-writer");
      const now = Date.now();
      await writeClosedShard(A, now - 6 * DAY, 2);
      await B.compactStatsShardsV7(now); // generation 1
      const first = await A.readStatsSnapshot();
      assert.equal(first.archive.generation, 1);
      assert.equal(first.rawShards.length, 0);

      // generation 1 stays unreadable (a scanner, a broken ACL) ...
      A.setStatsArchiveTestHooks({ beforeLstat: async (path: string) => { if (path === genPath(A, 1)) throw errno("EBUSY"); } });
      // ... while another process keeps writing today's shard.
      await writeClosedShard(B, now, 4);
      const second = await A.readStatsSnapshot(first);
      assert.equal(second.archive, first.archive, "the last good archive is served");
      assert.equal(second.rawShards.length, 1, "the new shard is not hidden behind the old snapshot");
      const raw = second.rawShards.filter((shard: any) => !second.archive.absorbedIds.has(shard.instanceId));
      assert.equal((await A.aggregateStatsWithArchiveV7(raw, second.archive, [], null)).bySession.s[KEY].totalRequests, 6);

      // A newer generation that cannot be read still reuses the old snapshot (J).
      await writeClosedShard(B, now - 5 * DAY, 3);
      await B.compactStatsShardsV7(now); // generation 2 absorbs the 3 and deletes it
      A.setStatsArchiveTestHooks({ beforeLstat: async (path: string) => { if (path.includes("archive.0")) throw errno("EBUSY"); } });
      const third = await A.readStatsSnapshot(second);
      assert.equal(third, second);
      A.setStatsArchiveTestHooks(undefined);
    });
  });
});

describe("2.9.2 review: an old unreadable generation is not re-read on every refresh", () => {
  test("its parse result is cached by file identity once it is too old to be still written", async () => {
    await withAgentDir(async () => {
      const I = await load("corrupt-cache");
      const now = Date.now();
      await writeClosedShard(I, now - 5 * DAY, 2);
      await I.compactStatsShardsV7(now);
      await writeFile(genPath(I, 2), "{ damaged");
      const old = new Date(now - HOUR);
      await utimes(genPath(I, 2), old, old);
      const reader = await load("corrupt-cache-reader");
      let reads = 0;
      reader.setStatsArchiveTestHooks({ beforeReadFile: async (path: string) => { if (path === genPath(I, 2)) reads++; } });
      for (let i = 0; i < 3; i++) assert.equal(await sessionRequests(reader), 2);
      assert.equal(reads, 1);
      // A young one (possibly still being written in place) is re-read.
      await writeFile(genPath(I, 3), "{ partial");
      let youngReads = 0;
      reader.setStatsArchiveTestHooks({ beforeReadFile: async (path: string) => { if (path === genPath(I, 3)) youngReads++; } });
      for (let i = 0; i < 2; i++) assert.equal(await sessionRequests(reader), 2);
      assert.equal(youngReads, 2);
      reader.setStatsArchiveTestHooks(undefined);
    });
  });
});

describe("2.9.2 review: I rebase across a reset", () => {
  for (const reset of ["model", "global"] as const) {
    test(`a ${reset} reset after the absorbed version keeps the post-reset usage (nothing subtracted across epochs)`, async () => {
      await withAgentDir(async () => {
        const loaded = await loadModule(`i-reset-${reset}`);
        const I = loaded.__internals_for_tests as any;
        const handlers = new Map<string, (event: any, context: any) => unknown>();
        loaded.default({ on(name: string, handler: any) { handlers.set(name, handler); }, registerCommand() {} } as any);
        const statuses: Array<string | undefined> = [];
        const context = {
          model: {
            provider: "proxy", id: "gpt-5.5", name: "GPT-5.5", api: "openai-completions",
            baseUrl: "https://api.openai.com/v1", compat: {}, reasoning: false, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192,
          },
          mode: "json", hasUI: false,
          sessionManager: { getSessionId: () => `issue-28-review5-i-${reset}` },
          modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
          ui: { notify() {}, setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
        };
        const message = { message: { role: "assistant", provider: "proxy", model: "gpt-5.5", api: "openai-completions", stopReason: "stop", usage: { input: 100, cacheRead: 0, cacheWrite: 0 } } };
        await handlers.get("session_start")!({ reason: "startup" }, context);
        await I.waitForStatsRestore();
        await handlers.get("message_end")!(message, context);
        await new Promise((resolve) => setTimeout(resolve, 2_600)); // the debounced persist
        const [name] = await readdir(I.SHARD_FILES_DIR);
        const persisted = JSON.parse(await readFile(join(I.SHARD_FILES_DIR, name!), "utf8"));
        assert.equal(persisted.models[KEY].stats.totalRequests, 1);
        const archive = {
          version: 1, kind: "pi-cache-optimizer-archive", updatedAt: persisted.lifecycle.updatedAt + DAY + HOUR,
          absorbed: { [persisted.instanceId]: persisted.lifecycle.updatedAt + DAY + HOUR },
          buckets: [{
            globalEpoch: persisted.globalEpoch, sessionHash: persisted.sessionHash, modelKey: KEY, modelEpoch: persisted.models[KEY].modelEpoch,
            day: persisted.day, provider: "proxy", modelId: "gpt-5.5", updatedAt: persisted.lifecycle.updatedAt, stats: persisted.models[KEY].stats,
          }],
          routed: [],
        };
        await mkdir(archiveDir(I), { recursive: true });
        await writeFile(genPath(I, 1), JSON.stringify(I.encodeStatsArchiveV2(archive, 1)) + "\n");
        await unlink(join(I.SHARD_FILES_DIR, name!));
        // A reset elsewhere; this process's next usage is under the new epoch.
        if (reset === "model") await I.advanceModelStatsEpoch(KEY);
        else await I.advanceGlobalStatsEpoch();

        await handlers.get("message_end")!(message, context);
        await handlers.get("tool_execution_end")!({ toolCallId: "t1" }, context);
        await I.statsRefreshSettled();
        assert.match(statuses.at(-1) ?? "", /0\/1\b/, "only the post-reset request is visible");
        await handlers.get("session_shutdown")!({}, context);
        const files = await readdir(I.SHARD_FILES_DIR);
        assert.equal(files.length, 1);
        assert.notEqual(files[0], name);
        const rest = JSON.parse(await readFile(join(I.SHARD_FILES_DIR, files[0]!), "utf8"));
        assert.equal(rest.models[KEY].stats.totalRequests, 1, "the post-reset request is kept, not subtracted");
      });
    });
  }
});

describe("2.9.2 review: test gaps found by mutation", () => {
  test("shard writes go through the retrying rename", async () => {
    await withAgentDir(async () => {
      const I = await load("shard-rename");
      let failures = 0;
      I.setStatsFsTestHooks({ beforeRename: async (_from: string, to: string) => { if (to.endsWith(".json") && failures < 2) { failures++; throw errno("EPERM"); } } });
      try {
        await writeClosedShard(I, Date.now(), 1);
      } finally {
        I.setStatsFsTestHooks(undefined);
      }
      assert.equal(failures, 2);
      assert.equal((await readdir(I.SHARD_FILES_DIR)).filter((name) => name.endsWith(".json")).length, 1);
    });
  });

  test("an in-place write that fails removes its own incomplete generation", async () => {
    await withAgentDir(async () => {
      const I = await load("inplace-fail");
      const now = Date.now();
      await writeClosedShard(I, now - 5 * DAY, 2);
      I.setStatsArchiveTestHooks({
        link: async () => { throw errno("ENOTSUP"); },
        afterExclusiveCreate: async () => { throw errno("ENOSPC"); },
      });
      await assert.rejects(I.compactStatsShardsV7(now), /ENOSPC/);
      I.setStatsArchiveTestHooks(undefined);
      assert.deepEqual(await I.listStatsArchiveGenerations(), [], "no unreadable generation is left to block the next pass");
      assert.equal((await readdir(I.SHARD_FILES_DIR)).length, 1);
      assert.equal((await I.compactStatsShardsV7(now)).generation, 1);
    });
  });

  test("an unreadable newest generation dated in the future is not mistaken for one still being written", async () => {
    await withAgentDir(async () => {
      const I = await load("future-corrupt");
      const now = Date.now();
      await writeClosedShard(I, now - 5 * DAY, 2);
      await I.compactStatsShardsV7(now);
      await writeFile(genPath(I, 2), "{ damaged");
      const future = new Date(now + 2 * DAY);
      await utimes(genPath(I, 2), future, future);
      const { value } = await quietly(() => I.compactStatsShardsV7(now));
      assert.equal(value.skippedConcurrent, false);
      assert.equal(value.generation, 3);
    });
  });
});
