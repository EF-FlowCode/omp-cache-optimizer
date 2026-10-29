import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

// Regressions from the second (adversarial) review of the issue #28 archive.

const DAY = 24 * 3600_000;
const HOUR = 3600_000;
const KEY = "proxy/gpt-5.5";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function withAgentDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-issue-28-review-"));
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

/** A separately loaded module instance: its own parsed-shard and archive caches, like another Pi process. */
async function load(label: string): Promise<any> {
  const jiti = createJiti(join(process.cwd(), "tests", `issue-28-review-${label}.ts`), { interopDefault: false, moduleCache: false });
  return (await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"))).__internals_for_tests as any;
}

async function closedShard(I: any, instanceId: string, at: number, requests: number) {
  const day = localDay(at);
  return {
    version: 7, kind: "pi-cache-optimizer-shard", instanceId, sessionHash: "s",
    process: { pid: 1, ppid: 0, instanceStartedAt: 1 },
    lifecycle: { state: "closed", createdAt: at, updatedAt: at, closedAt: at },
    day, globalEpoch: await I.readGlobalStatsEpoch(),
    models: {
      [KEY]: {
        modelEpoch: await I.readModelStatsEpoch(KEY), provider: "proxy", modelId: "gpt-5.5",
        stats: { day, totalRequests: requests, hitRequests: requests, cachedInputTokens: 10 * requests, cacheWriteInputTokens: 0, totalInputTokens: 20 * requests },
      },
    },
  };
}

/** refreshShardAggregate's disk read order. */
async function sessionRequests(I: any): Promise<number | undefined> {
  const raw = await I.readValidStatsShardsV7();
  const archive = await I.readStatsArchive();
  const shards = [...raw.filter((shard: any) => !archive.absorbedIds.has(shard.instanceId)), ...archive.shards];
  return (await I.aggregateStatsShardsV7(shards, null)).bySession.s?.[KEY]?.totalRequests;
}

describe("issue #28 archive: adversarial review regressions", () => {
  test("an absorbed leftover that is unreadable during the next pass stays absorbed (no permanent double count)", { skip: isRoot && "root ignores file modes" }, async () => {
    await withAgentDir(async () => {
      const first = await load("leftover-a");
      const now = Date.now();
      const id = "11111111-1111-4111-8111-111111111111";
      const path = join(first.SHARD_FILES_DIR, `${id}.json`);
      const shard = await closedShard(first, id, now - 3 * DAY, 5);
      await first.writeStatsShardV7(path, shard);
      assert.equal(await sessionRequests(first), 5);

      await first.compactStatsShardsV7(now);
      // The delete failed (Windows EPERM, or a crash right after publishing):
      // the original is still on disk next to the archive that absorbed it.
      await first.writeStatsShardV7(path, shard);
      assert.equal(await sessionRequests(first), 5);

      // Hours later another process compacts while something (a scanner, a
      // sync client) holds the leftover: unreadable and undeletable for now.
      const second = await load("leftover-b");
      await chmod(path, 0o000);
      await chmod(second.SHARD_FILES_DIR, 0o555);
      try {
        await second.compactStatsShardsV7(now + HOUR);
      } finally {
        await chmod(second.SHARD_FILES_DIR, 0o755);
        await chmod(path, 0o644);
      }
      const archive = (await second.readStatsArchive()).archive;
      assert.ok(id in archive.absorbed, "the id of a still-present leftover is not pruned");

      const reader = await load("leftover-c");
      assert.equal(await sessionRequests(reader), 5, "the leftover is not counted next to its archived copy");
      const third = await reader.compactStatsShardsV7(now + 2 * HOUR);
      assert.equal(third.absorbed, 0, "the leftover is not folded in a second time");
      assert.equal(third.removed, 1);
      assert.equal(await sessionRequests(reader), 5);
      assert.deepEqual(await readdir(reader.SHARD_FILES_DIR), []);
    });
  });

  test("a 2.8.x-style takeover (lock directory without an owner file) revokes a 2.9 holder", async () => {
    await withAgentDir(async () => {
      const I = await load("legacy-takeover");
      const lockPath = join(I.SHARD_FILES_DIR, "..", "maintenance", "cleanup.lock");
      const token = await I.acquireStatsMaintenanceLock();
      assert.ok(token);
      assert.equal(await I.holdsStatsMaintenanceLock(token), true);
      // Our lock went stale (laptop sleep); 2.8.x replaces it with rm + mkdir
      // and writes no owner file.
      await rm(lockPath, { recursive: true, force: true });
      await mkdir(lockPath);
      assert.equal(await I.holdsStatsMaintenanceLock(token), false, "the missing owner file is not mistaken for ours");

      const now = Date.now();
      await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, "22222222-2222-4222-8222-222222222222.json"), await closedShard(I, "22222222-2222-4222-8222-222222222222", now - 2 * DAY, 3));
      const result = await I.compactStatsShardsV7(now, I.SHARD_FILES_DIR, I.SHARD_ARCHIVE_PATH, { lockToken: token });
      assert.equal(result.skippedConcurrent, true, "the displaced holder publishes nothing");
      assert.equal((await readdir(I.SHARD_FILES_DIR)).length, 1);

      await I.releaseStatsMaintenanceLock(token);
      assert.ok((await readdir(join(lockPath, ".."))).includes("cleanup.lock"), "the legacy owner's lock survives");
    });
  });

  test("a lock whose owner file could never be written still behaves like a legacy lock for its holder", async () => {
    await withAgentDir(async () => {
      const I = await load("legacy-own");
      const lockPath = join(I.SHARD_FILES_DIR, "..", "maintenance", "cleanup.lock");
      // A 2.8.x-style lock that went stale is taken over normally.
      await mkdir(lockPath, { recursive: true });
      const old = new Date(Date.now() - 2 * HOUR);
      await utimes(lockPath, old, old);
      const token = await I.acquireStatsMaintenanceLock();
      assert.ok(token);
      assert.equal(await I.holdsStatsMaintenanceLock(token), true);
      await I.releaseStatsMaintenanceLock(token);
      assert.equal((await readdir(join(lockPath, ".."))).includes("cleanup.lock"), false);
    });
  });

  test("an unreadable owner file fails closed for publishing but still lets the holder release", { skip: isRoot && "root ignores file modes" }, async () => {
    await withAgentDir(async () => {
      const I = await load("owner-unreadable");
      const lockPath = join(I.SHARD_FILES_DIR, "..", "maintenance", "cleanup.lock");
      const token = await I.acquireStatsMaintenanceLock();
      assert.ok(token);
      await chmod(join(lockPath, "owner"), 0o000);
      try {
        assert.equal(await I.holdsStatsMaintenanceLock(token), false);
        const now = Date.now();
        await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, "33333333-3333-4333-8333-333333333333.json"), await closedShard(I, "33333333-3333-4333-8333-333333333333", now - 2 * DAY, 2));
        const result = await I.compactStatsShardsV7(now, I.SHARD_FILES_DIR, I.SHARD_ARCHIVE_PATH, { lockToken: token });
        assert.equal(result.skippedConcurrent, true);
        await I.releaseStatsMaintenanceLock(token);
        assert.equal((await readdir(join(lockPath, ".."))).includes("cleanup.lock"), false);
      } finally {
        await chmod(join(lockPath, "owner"), 0o600).catch(() => undefined);
      }
    });
  });
});

describe("issue #28 archive: clock set back", () => {
  test("a crashed lock and maintenance markers dated in the future do not suspend maintenance", async () => {
    await withAgentDir(async () => {
      const I = await load("clock-back");
      const maintenance = join(I.SHARD_FILES_DIR, "..", "maintenance");
      const lockPath = join(maintenance, "cleanup.lock");
      const now = Date.now();
      const future = new Date(now + 30 * DAY);
      // Written while the clock ran a month ahead, then the process crashed
      // and the clock was corrected.
      await mkdir(lockPath, { recursive: true });
      await utimes(lockPath, future, future);
      for (const name of ["last-cleanup", "last-compaction"]) {
        await writeFile(join(maintenance, name), `${future.getTime()}\n`);
        await utimes(join(maintenance, name), future, future);
      }
      await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, "44444444-4444-4444-8444-444444444444.json"), await closedShard(I, "44444444-4444-4444-8444-444444444444", now - 2 * DAY, 4));
      const result = await I.maybeRunStatsMaintenance(now);
      assert.ok(result.compaction, "maintenance ran");
      assert.equal(result.compaction.absorbed, 1);
      assert.equal(await sessionRequests(I), 4);
      // A lock taken a moment "after" this caller sampled its clock is fresh.
      const token = await I.acquireStatsMaintenanceLock();
      assert.ok(token);
      assert.equal(await I.acquireStatsMaintenanceLock(now - 1000), undefined, "small skew does not make a live lock stale");
      await I.releaseStatsMaintenanceLock(token);
    });
  });
});

describe("issue #28 archive: retention parity", () => {
  test("a shard closed weeks after its day does not keep its day's earlier shards alive past retention", async () => {
    await withAgentDir(async () => {
      const I = await load("retention-parity");
      const now = Date.now();
      const early = await closedShard(I, "55555555-5555-4555-8555-555555555551", now - 50 * DAY, 7);
      // Same session, model and day, but an idle process closed it 30 days later.
      const late = await closedShard(I, "55555555-5555-4555-8555-555555555552", now - 50 * DAY, 3);
      late.lifecycle.updatedAt = late.lifecycle.closedAt = now - 20 * DAY;
      for (const shard of [early, late]) await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, `${shard.instanceId}.json`), shard);
      await I.compactStatsShardsV7(now);
      assert.equal(await sessionRequests(I), 10);

      // 15 days later raw retention would have deleted only the early shard.
      const later = now + 15 * DAY;
      await I.compactStatsShardsV7(later);
      const raw = [early, late].filter((shard) => later - shard.lifecycle.updatedAt < I.SHARD_RETENTION_MS);
      const expected = (await I.aggregateStatsShardsV7(raw, null)).bySession.s?.[KEY]?.totalRequests;
      assert.equal(expected, 3);
      assert.equal(await sessionRequests(I), expected);
    });
  });
});

describe("issue #28 archive: the extension's own reader", () => {
  // The other archive tests re-implement the reader. This one drives
  // refreshShardAggregate itself, so dropping its absorbed-id filter fails.
  test("the session footer ignores raw shards the archive already absorbed", async () => {
    await withAgentDir(async () => {
      const jiti = createJiti(join(process.cwd(), "tests", "issue-28-review-footer.ts"), { interopDefault: false, moduleCache: false });
      const loaded = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
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
        sessionManager: { getSessionId: () => "issue-28-review-footer" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: { notify() {}, setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
      };
      const sessionHash = I.hashSessionId("issue-28-review-footer");
      const now = Date.now();
      const shards: any[] = [];
      for (let i = 0; i < 6; i++) {
        const shard = await closedShard(I, `66666666-6666-4666-8666-66666666666${i}`, now - (1 + i) * DAY, 2);
        shard.sessionHash = sessionHash;
        shards.push(shard);
        await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, `${shard.instanceId}.json`), shard);
      }
      await I.compactStatsShardsV7(now);
      // Crash leftovers: the originals are back next to the archive, and
      // maintenance is not due, so startup reads both.
      for (const shard of shards) await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, `${shard.instanceId}.json`), shard);
      const maintenance = join(I.SHARD_FILES_DIR, "..", "maintenance");
      await mkdir(maintenance, { recursive: true });
      for (const name of ["last-cleanup", "last-compaction"]) await writeFile(join(maintenance, name), `${now}\n`);

      await handlers.get("session_start")!({ reason: "startup" }, context);
      await I.waitForStatsRestore();
      assert.match(statuses.at(-1) ?? "", /12\/12/, "each archived request is counted once");
      await handlers.get("session_shutdown")!({}, context);
    });
  });
});
