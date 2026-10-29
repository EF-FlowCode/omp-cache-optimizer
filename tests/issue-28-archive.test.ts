import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

// Issue #28 phase 2: closed past-day shards are folded into one archive file,
// so the shard directory (and every refresh scan) only grows with today's
// processes instead of the whole 60-day retention window.

type Handler = (event: any, context: any) => unknown;
const KEYS = ["proxy/gpt-5.5", "anthropic/claude-opus-5", "deepseek/deepseek-v4"];
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function withAgentDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-issue-28-archive-"));
  const names = ["PI_CODING_AGENT_DIR", "PI_CACHE_RETENTION", "PI_CACHE_OPTIMIZER_FOOTER_MODE"];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.PI_CODING_AGENT_DIR = dir;
    await run(dir);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function load(label: string) {
  const jiti = createJiti(join(process.cwd(), "tests", `issue-28-archive-${label}.ts`), { interopDefault: false, moduleCache: false });
  const loaded = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
  return { loaded, I: loaded.__internals_for_tests as any };
}

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

type ShardOptions = {
  sessionHash: string;
  day: string;
  updatedAt: number;
  state?: "active" | "closed";
  pid?: number;
  globalEpoch: string;
  models: Record<string, { modelEpoch: string; requests: number; hits: number; cached: number; input: number }>;
  routed?: string;
};

async function writeShard(I: any, options: ShardOptions): Promise<string> {
  const instanceId = randomUUID();
  const models: Record<string, unknown> = {};
  for (const [key, m] of Object.entries(options.models)) {
    const [provider, modelId] = key.split("/");
    models[key] = {
      modelEpoch: m.modelEpoch, provider, modelId, modelName: `${modelId} name`,
      stats: { day: options.day, totalRequests: m.requests, hitRequests: m.hits, cachedInputTokens: m.cached, cacheWriteInputTokens: 0, totalInputTokens: m.input },
    };
  }
  await mkdir(I.SHARD_FILES_DIR, { recursive: true });
  await writeFile(join(I.SHARD_FILES_DIR, `${instanceId}.json`), JSON.stringify({
    version: 7, kind: "pi-cache-optimizer-shard", instanceId, sessionHash: options.sessionHash,
    process: { pid: options.pid ?? 1, ppid: 0, instanceStartedAt: 1 },
    lifecycle: { state: options.state ?? "closed", createdAt: options.updatedAt - 1000, updatedAt: options.updatedAt, ...(options.state === "active" ? {} : { closedAt: options.updatedAt }) },
    day: options.day, globalEpoch: options.globalEpoch, models,
    ...(options.routed ? { lastRoutedModel: { provider: options.routed.split("/")[0], id: options.routed.split("/")[1], name: options.routed } } : {}),
  }));
  return instanceId;
}

/**
 * The same combination refreshShardAggregate performs, minus in-memory state:
 * the directory first, then the archive (never concurrently: an old archive
 * paired with a post-delete listing would drop counters).
 */
async function combinedShards(I: any): Promise<any[]> {
  const { rawShards, archive } = await I.readStatsSnapshot();
  return [...rawShards.filter((shard: any) => !archive.absorbedIds.has(shard.instanceId)), ...archive.shards];
}

async function views(I: any, shards: any[]) {
  const all = await I.aggregateStatsShardsV7(shards, null);
  const today = await I.aggregateStatsShardsV7(shards);
  return { bySession: all.bySession, lastRouted: all.lastRoutedModelBySession, today };
}

/** Random multi-day, multi-session, multi-model fixture including stale epochs and active shards. */
async function writeRandomFixture(I: any, seed: number, now: number): Promise<number> {
  const random = rng(seed);
  const globalEpoch = await I.readGlobalStatsEpoch();
  const staleGlobal = "stale-global-epoch";
  let count = 0;
  for (let i = 0; i < 160; i++) {
    const daysAgo = Math.floor(random() * 10); // includes today
    const updatedAt = now - daysAgo * DAY - Math.floor(random() * 6 * HOUR) - HOUR;
    const day = localDay(new Date(updatedAt));
    const models: ShardOptions["models"] = {};
    for (const key of KEYS) {
      if (random() < 0.5) continue;
      const requests = 1 + Math.floor(random() * 20);
      const hits = Math.floor(random() * (requests + 1));
      const input = 1000 + Math.floor(random() * 100_000);
      models[key] = {
        modelEpoch: random() < 0.1 ? "stale-model-epoch" : await I.readModelStatsEpoch(key),
        requests, hits, cached: Math.floor(random() * input), input,
      };
    }
    const roll = random();
    await writeShard(I, {
      sessionHash: `session-${Math.floor(random() * 8)}`,
      day,
      updatedAt,
      // Mostly closed; some active-and-alive (this pid), some active-and-dead.
      state: roll < 0.8 ? "closed" : "active",
      pid: roll < 0.9 ? 999_999_99 : process.pid,
      globalEpoch: random() < 0.08 ? staleGlobal : globalEpoch,
      models,
      ...(random() < 0.6 ? { routed: KEYS[Math.floor(random() * KEYS.length)] } : {}),
    });
    count++;
  }
  return count;
}

describe("issue #28 phase 2: archive snapshot", () => {
  test("compaction is invisible to every aggregate the footer reads (randomized equivalence)", async () => {
    for (const seed of [1, 7, 42]) {
      await withAgentDir(async () => {
        const { I } = await load(`equivalence-${seed}`);
        const now = Date.now();
        const written = await writeRandomFixture(I, seed, now);
        const before = await views(I, await I.readValidStatsShardsV7());

        const result = await I.compactStatsShardsV7(now);
        assert.ok(result.absorbed > 0, "the fixture has archivable shards");
        assert.equal(result.removed, result.absorbed);
        const remaining = await readdir(I.SHARD_FILES_DIR);
        assert.equal(remaining.length, written - result.absorbed);

        const after = await views(I, await combinedShards(I));
        assert.deepEqual(after.bySession, before.bySession, `seed ${seed}: session totals`);
        assert.deepEqual(after.lastRouted, before.lastRouted, `seed ${seed}: last routed model`);
        assert.deepEqual(after.today.totalsByModel, before.today.totalsByModel, `seed ${seed}: today totals`);
        assert.deepEqual(after.today.bySession, before.today.bySession, `seed ${seed}: today by session`);
        assert.deepEqual(after.today.instancesByModel, before.today.instancesByModel, `seed ${seed}: today instance counts`);

        // A second pass changes nothing.
        const again = await I.compactStatsShardsV7(now);
        assert.equal(again.absorbed, 0);
        assert.deepEqual((await views(I, await combinedShards(I))).bySession, before.bySession);
      });
    }
  });

  test("only closed past-day shards and long-abandoned active shards are archived", async () => {
    await withAgentDir(async () => {
      const { I } = await load("eligibility");
      const now = Date.now();
      const globalEpoch = await I.readGlobalStatsEpoch();
      const models = {};
      // Archived once the day is over in every time zone (issue #28 review M).
      const yesterday = now - 3 * DAY;
      const ids = {
        today: await writeShard(I, { sessionHash: "s", day: localDay(new Date(now)), updatedAt: now - 1000, globalEpoch, models }),
        closedPast: await writeShard(I, { sessionHash: "s", day: localDay(new Date(yesterday)), updatedAt: yesterday, globalEpoch, models }),
        activeAlive: await writeShard(I, { sessionHash: "s", day: localDay(new Date(now - 3 * DAY)), updatedAt: now - 3 * DAY, state: "active", pid: process.pid, globalEpoch, models }),
        activeDeadRecent: await writeShard(I, { sessionHash: "s", day: localDay(new Date(now - 30 * 60_000 - DAY)), updatedAt: now - 2 * HOUR, state: "active", pid: 999_999_99, globalEpoch, models }),
        activeDeadOld: await writeShard(I, { sessionHash: "s", day: localDay(new Date(now - 3 * DAY)), updatedAt: now - 3 * DAY, state: "active", pid: 999_999_99, globalEpoch, models }),
      };
      await I.compactStatsShardsV7(now);
      const left = new Set((await readdir(I.SHARD_FILES_DIR)).map((name) => name.slice(0, -5)));
      assert.ok(left.has(ids.activeAlive), "a live process keeps its shard");
      assert.ok(left.has(ids.activeDeadRecent), "an active shard touched within 24h is kept");
      assert.equal(left.has(ids.closedPast), false);
      assert.equal(left.has(ids.activeDeadOld), false);
      // A shard from today is never archived, even when closed.
      if (localDay(new Date(now - 1000)) === localDay(new Date(now))) assert.ok(left.has(ids.today));
    });
  });

  test("a crash between publishing the archive and deleting the originals never double counts", async () => {
    await withAgentDir(async (dir) => {
      const { I } = await load("crash");
      const now = Date.now();
      await writeRandomFixture(I, 99, now);
      const before = await views(I, await I.readValidStatsShardsV7());
      const backup = join(dir, "backup");
      await mkdir(backup);
      for (const name of await readdir(I.SHARD_FILES_DIR)) await copyFile(join(I.SHARD_FILES_DIR, name), join(backup, name));

      await I.compactStatsShardsV7(now);
      // Simulate the crash: the originals are still on disk next to the archive.
      for (const name of await readdir(backup)) await copyFile(join(backup, name), join(I.SHARD_FILES_DIR, name));
      assert.deepEqual((await views(I, await combinedShards(I))).bySession, before.bySession, "readers ignore absorbed raw shards");

      const retry = await I.compactStatsShardsV7(now);
      assert.equal(retry.absorbed, 0, "already-absorbed shards are not merged twice");
      assert.ok(retry.removed > 0, "the leftover originals are deleted");
      assert.deepEqual((await views(I, await combinedShards(I))).bySession, before.bySession);
      // Absorbed ids whose files are gone are pruned, so the list cannot grow forever.
      const archive = (await I.readStatsArchive()).archive;
      await I.compactStatsShardsV7(now);
      const pruned = (await I.readStatsArchive()).archive;
      assert.ok(Object.keys(archive.absorbed).length > 0);
      assert.equal(Object.keys(pruned.absorbed).length, 0);
    });
  });

  test("concurrent maintenance in several processes is serialized by the lock", async () => {
    await withAgentDir(async () => {
      const { I } = await load("concurrent");
      // Separately loaded module instances: their own lock tokens and caches, like other Pi processes.
      const others = await Promise.all([1, 2, 3, 4].map(async (index) => (await load(`concurrent-${index}`)).I));
      const now = Date.now();
      await writeRandomFixture(I, 5, now);
      const before = await views(I, await I.readValidStatsShardsV7());
      const results = await Promise.all(others.map((other) => other.maybeRunStatsMaintenance(now)));
      assert.equal(results.filter((r: any) => r.compaction).length, 1, "exactly one runner holds the lock");
      assert.deepEqual((await views(I, await combinedShards(I))).bySession, before.bySession);
    });
  });

  test("a reset hides archived counters immediately and the next compaction drops them", async () => {
    await withAgentDir(async () => {
      const { I } = await load("reset");
      const now = Date.now();
      await writeRandomFixture(I, 11, now);
      await I.compactStatsShardsV7(now);
      const archived = (await I.readStatsArchive()).archive;
      assert.ok(archived.buckets.length > 0);

      // Model-scoped reset: only that model disappears.
      await I.advanceModelStatsEpoch(KEYS[0]);
      let view = await views(I, await combinedShards(I));
      for (const models of Object.values(view.bySession) as any[]) assert.equal(models[KEYS[0]], undefined);
      assert.ok(Object.values(view.bySession).some((models: any) => models[KEYS[1]] || models[KEYS[2]]));
      const afterModelReset = await I.compactStatsShardsV7(now);
      assert.ok(afterModelReset.dropped > 0);

      // Global reset: everything archived is hidden at once.
      await I.advanceGlobalStatsEpoch();
      view = await views(I, await combinedShards(I));
      assert.deepEqual(view.bySession, {});
      await I.compactStatsShardsV7(now);
      const emptied = (await I.readStatsArchive()).archive;
      assert.deepEqual(emptied.buckets, []);
      assert.deepEqual(emptied.routed, []);
    });
  });

  test("archived buckets expire with the shard retention window", async () => {
    await withAgentDir(async () => {
      const { I } = await load("retention");
      const now = Date.now();
      const globalEpoch = await I.readGlobalStatsEpoch();
      const modelEpoch = await I.readModelStatsEpoch(KEYS[0]);
      const at = now - 10 * DAY;
      await writeShard(I, { sessionHash: "s", day: localDay(new Date(at)), updatedAt: at, globalEpoch, models: { [KEYS[0]]: { modelEpoch, requests: 2, hits: 1, cached: 10, input: 100 } }, routed: KEYS[0] });
      await I.compactStatsShardsV7(now);
      assert.equal((await I.readStatsArchive()).archive.buckets.length, 1);
      const later = now + I.SHARD_RETENTION_MS;
      const result = await I.compactStatsShardsV7(later);
      assert.equal(result.dropped, 2);
      const archive = (await I.readStatsArchive()).archive;
      assert.deepEqual(archive.buckets, []);
      assert.deepEqual(archive.routed, []);
    });
  });

  test("an unreadable archive is set aside, never merged, and raw shards stay authoritative", async () => {
    await withAgentDir(async () => {
      const { I } = await load("corrupt");
      const now = Date.now();
      await writeRandomFixture(I, 3, now);
      await mkdir(join(I.SHARD_ARCHIVE_PATH, ".."), { recursive: true });
      await writeFile(I.SHARD_ARCHIVE_PATH, "{ not json");
      const before = await views(I, await I.readValidStatsShardsV7());
      assert.deepEqual((await views(I, await combinedShards(I))).bySession, before.bySession, "read as an empty archive");
      // Since review G it no longer blocks compaction forever: the next pass
      // starts over from the raw shards and keeps the file for inspection.
      const warn = console.warn;
      console.warn = () => {};
      let result: any;
      try {
        result = await I.compactStatsShardsV7(now);
      } finally {
        console.warn = warn;
      }
      assert.equal(result.skippedCorrupt, false);
      assert.ok(result.absorbed > 0);
      const kept = (await readdir(join(I.SHARD_ARCHIVE_PATH, ".."))).filter((name) => /^archive\.legacy-\d+\.json$/.test(name));
      assert.equal(kept.length, 1);
      assert.equal(await readFile(join(I.SHARD_ARCHIVE_PATH, "..", kept[0]!), "utf8"), "{ not json");
      assert.deepEqual((await views(I, await combinedShards(I))).bySession, before.bySession);
    });
  });

  test("the session footer keeps archived history after startup maintenance compacts it", async () => {
    await withAgentDir(async () => {
      const { loaded, I } = await load("footer");
      const handlers = new Map<string, Handler>();
      loaded.default({ on(name: string, handler: Handler) { handlers.set(name, handler); }, registerCommand() {} } as any);
      const statuses: Array<string | undefined> = [];
      const context = {
        model: {
          provider: "proxy", id: "gpt-5.5", name: "GPT-5.5", api: "openai-completions",
          baseUrl: "https://api.openai.com/v1", compat: {}, reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192,
        },
        mode: "json", hasUI: false,
        sessionManager: { getSessionId: () => "issue-28-archive-footer" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: { notify() {}, setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
      };
      const sessionHash = I.hashSessionId("issue-28-archive-footer");
      const globalEpoch = await I.readGlobalStatsEpoch();
      const modelEpoch = await I.readModelStatsEpoch(KEYS[0]);
      const now = Date.now();
      for (let i = 1; i <= 40; i++) {
        const at = now - (2 + (i % 5)) * DAY;
        await writeShard(I, { sessionHash, day: localDay(new Date(at)), updatedAt: at, globalEpoch, models: { [KEYS[0]]: { modelEpoch, requests: 1, hits: 1, cached: 50, input: 100 } } });
      }
      await handlers.get("session_start")!({ reason: "startup" }, context);
      await I.waitForStatsRestore();
      assert.match(statuses.at(-1) ?? "", /40\/40/);
      // Startup maintenance folded all 40 past-day shards; only this process's shard remains.
      assert.equal((await readdir(I.SHARD_FILES_DIR)).length, 1);
      await handlers.get("message_end")!({ message: { role: "assistant", provider: "proxy", model: "gpt-5.5", api: "openai-completions", stopReason: "stop", usage: { input: 100, cacheRead: 0, cacheWrite: 0 } } }, context);
      await I.statsRefreshSettled();
      assert.match(statuses.at(-1) ?? "", /40\/41/);
      await handlers.get("tool_execution_end")!({ toolCallId: "t1" }, context);
      await I.statsRefreshSettled();
      assert.match(statuses.at(-1) ?? "", /40\/41/);
      await handlers.get("session_shutdown")!({}, context);
    });
  });
  test("an unreadable epoch file aborts compaction instead of dropping every counter as stale", async () => {
    await withAgentDir(async () => {
      const { I } = await load("epoch-unreadable");
      await I.advanceGlobalStatsEpoch();
      const now = Date.now();
      const written = await writeRandomFixture(I, 21, now);
      const before = await views(I, await I.readValidStatsShardsV7());
      assert.ok(Object.keys(before.bySession).length > 0);
      // Simulate a transient Windows EPERM/EBUSY (or a damaged file): the
      // lenient reader would fall back to the initial epoch. A directory in
      // its place fails to read even as root (where chmod 000 would not).
      const epochText = await readFile(I.SHARD_GLOBAL_EPOCH_PATH, "utf8");
      await rm(I.SHARD_GLOBAL_EPOCH_PATH);
      await mkdir(I.SHARD_GLOBAL_EPOCH_PATH);
      const warn = console.warn;
      console.warn = () => {};
      try {
        await assert.rejects(I.compactStatsShardsV7(now));
        const maintenance = await I.maybeRunStatsMaintenance(now);
        assert.equal(maintenance.compaction, undefined, "the failure is contained by maintenance");
      } finally {
        console.warn = warn;
        await rm(I.SHARD_GLOBAL_EPOCH_PATH, { recursive: true });
        await writeFile(I.SHARD_GLOBAL_EPOCH_PATH, epochText);
      }
      assert.equal((await readdir(I.SHARD_FILES_DIR)).length, written, "no shard was absorbed or deleted");
      assert.equal((await I.readStatsArchive()).present, false, "no archive was published");
      assert.deepEqual((await views(I, await combinedShards(I))).bySession, before.bySession);
      // Once the epoch is readable again compaction proceeds normally.
      await rm(join(I.SHARD_FILES_DIR, "..", "maintenance", "last-compaction"), { force: true });
      const result = await I.compactStatsShardsV7(now);
      assert.ok(result.absorbed > 0);
      assert.deepEqual((await views(I, await combinedShards(I))).bySession, before.bySession);
    });
  });

  test("compaction publishes nothing when the archive or an epoch changed during the pass", async () => {
    await withAgentDir(async () => {
      const { I } = await load("optimistic");
      const now = Date.now();
      const written = await writeRandomFixture(I, 31, now);
      const before = await views(I, await I.readValidStatsShardsV7());

      // Another compactor (e.g. after a stale-lock takeover) published meanwhile.
      const foreign = { version: 1, kind: "pi-cache-optimizer-archive", updatedAt: now, absorbed: {}, buckets: [], routed: [] };
      const raced = await I.compactStatsShardsV7(now, I.SHARD_FILES_DIR, I.SHARD_ARCHIVE_PATH, {
        beforePublish: async () => {
          await mkdir(join(I.SHARD_ARCHIVE_PATH, ".."), { recursive: true });
          await writeFile(I.SHARD_ARCHIVE_PATH, JSON.stringify(foreign));
        },
      });
      assert.equal(raced.skippedConcurrent, true);
      assert.equal(raced.removed, 0);
      assert.equal((await readdir(I.SHARD_FILES_DIR)).length, written, "nothing deleted");
      assert.deepEqual((await I.readStatsArchive()).archive, foreign, "the other archive is not overwritten");

      // A reset landed during the pass.
      const reset = await I.compactStatsShardsV7(now, I.SHARD_FILES_DIR, I.SHARD_ARCHIVE_PATH, {
        beforePublish: async () => { await I.advanceModelStatsEpoch(KEYS[1]); },
      });
      assert.equal(reset.skippedConcurrent, true);
      assert.equal((await readdir(I.SHARD_FILES_DIR)).length, written);

      // A clean pass afterwards still matches the raw view (under the new epochs).
      const expected = await views(I, await I.readValidStatsShardsV7());
      const clean = await I.compactStatsShardsV7(now);
      assert.equal(clean.skippedConcurrent, false);
      assert.ok(clean.absorbed > 0);
      assert.deepEqual((await views(I, await combinedShards(I))).bySession, expected.bySession);
      assert.notDeepEqual(expected.bySession, before.bySession, "the model reset is visible");
    });
  });

  test("a holder whose stale lock was taken over neither publishes nor releases the new owner's lock", async () => {
    await withAgentDir(async () => {
      const { I } = await load("lock-owner");
      const lockPath = join(I.SHARD_FILES_DIR, "..", "maintenance", "cleanup.lock");
      const first = await I.acquireStatsMaintenanceLock();
      assert.ok(first);
      assert.equal(await I.acquireStatsMaintenanceLock(), undefined, "a fresh lock is exclusive");
      const old = new Date(Date.now() - 2 * HOUR);
      await utimes(lockPath, old, old);
      const second = await I.acquireStatsMaintenanceLock();
      assert.ok(second, "a stale lock is taken over");
      assert.equal(await I.holdsStatsMaintenanceLock(first), false);
      assert.equal(await I.holdsStatsMaintenanceLock(second), true);

      await writeRandomFixture(I, 41, Date.now());
      const stale = await I.compactStatsShardsV7(Date.now(), I.SHARD_FILES_DIR, I.SHARD_ARCHIVE_PATH, { lockToken: first });
      assert.equal(stale.skippedConcurrent, true, "the displaced holder does not publish");

      await I.releaseStatsMaintenanceLock(first);
      assert.ok((await readdir(join(lockPath, ".."))).includes("cleanup.lock"), "the new owner's lock survives");
      await I.releaseStatsMaintenanceLock(second);
      assert.equal((await readdir(join(lockPath, ".."))).includes("cleanup.lock"), false);
    });
  });

  test("reading the shard directory before the archive never loses a shard compaction absorbed in between", async () => {
    await withAgentDir(async () => {
      const { I } = await load("read-order");
      const now = Date.now();
      await writeRandomFixture(I, 51, now);
      const before = await views(I, await I.readValidStatsShardsV7());
      // refreshShardAggregate's order: directory, then archive. A compaction
      // may complete anywhere in between.
      const raw = await I.readValidStatsShardsV7();
      await I.compactStatsShardsV7(now);
      const archive = await I.readStatsArchive();
      const combined = [...raw.filter((shard: any) => !archive.absorbedIds.has(shard.instanceId)), ...archive.shards];
      assert.deepEqual((await views(I, combined)).bySession, before.bySession);
    });
  });

  test("a transient archive read failure is not cached as an empty archive", async () => {
    await withAgentDir(async () => {
      const { I } = await load("archive-transient");
      const now = Date.now();
      await writeRandomFixture(I, 61, now);
      await I.compactStatsShardsV7(now);
      const good = await I.readStatsArchive();
      assert.equal(good.corrupt, false);
      assert.ok(good.shards.length > 0);
      // Another process republishes the archive; this process cannot read it yet.
      const latest = I.statsArchiveGenerationPath(I.SHARD_ARCHIVE_PATH, (await I.listStatsArchiveGenerations()).at(-1));
      const text = await readFile(latest, "utf8");
      const tmp = `${latest}.test.tmp`;
      await writeFile(tmp, text.replace(/\n$/, "\n\n"));
      await rm(latest);
      await copyFile(tmp, latest);
      await rm(tmp);
      // Injected rather than chmod 000, so the test also holds as root.
      I.setStatsArchiveTestHooks({ beforeReadFile: async (path: string) => { if (path === latest) throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } });
      try {
        const during = await I.readStatsArchive();
        assert.equal(during.corrupt, false, "the last good archive is served");
        assert.equal(during.shards.length, good.shards.length);
      } finally {
        I.setStatsArchiveTestHooks(undefined);
      }
      const after = await I.readStatsArchive();
      assert.equal(after.corrupt, false);
      assert.equal(after.shards.length, good.shards.length);
      assert.notEqual(after, good, "the new file was parsed, not a cached failure");
    });
  });
});
