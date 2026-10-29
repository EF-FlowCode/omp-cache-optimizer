import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

// Issue #28 archive, review findings F (publishing was check-then-act, not a
// compare-and-swap, and the lock had no heartbeat) and H (refresh cost), plus
// the 2.9.0 compatibility of the generation format that fixes F.

const DAY = 24 * 3600_000;
const HOUR = 3600_000;
const KEY = "proxy/gpt-5.5";

function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function withAgentDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-issue-28-cas-"));
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

/** A separately loaded module instance: its own lock tokens and caches, like another Pi process. */
async function load(label: string): Promise<any> {
  const jiti = createJiti(join(process.cwd(), "tests", `issue-28-cas-${label}.ts`), { interopDefault: false, moduleCache: false });
  return (await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"))).__internals_for_tests as any;
}

let idCounter = 0;
function nextId(): string {
  idCounter++;
  return `${String(idCounter).padStart(8, "0")}-0000-4000-8000-${String(Date.now() % 1e12).padStart(12, "0")}`;
}

async function writeClosedShard(I: any, at: number, requests: number, sessionHash = "s"): Promise<string> {
  const id = nextId();
  const day = localDay(at);
  await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, `${id}.json`), {
    version: 7, kind: "pi-cache-optimizer-shard", instanceId: id, sessionHash,
    process: { pid: 1, ppid: 0, instanceStartedAt: 1 },
    lifecycle: { state: "closed", createdAt: at, updatedAt: at, closedAt: at },
    day, globalEpoch: await I.readGlobalStatsEpoch(),
    models: {
      [KEY]: {
        modelEpoch: await I.readModelStatsEpoch(KEY), provider: "proxy", modelId: "gpt-5.5",
        stats: { day, totalRequests: requests, hitRequests: requests, cachedInputTokens: 10 * requests, cacheWriteInputTokens: 0, totalInputTokens: 20 * requests },
      },
    },
  });
  return id;
}

/** refreshShardAggregate's disk read order (reference form). */
async function sessionRequests(I: any): Promise<number | undefined> {
  const raw = await I.readValidStatsShardsV7();
  const archive = await I.readStatsArchive();
  const shards = [...raw.filter((shard: any) => !archive.absorbedIds.has(shard.instanceId)), ...archive.shards];
  return (await I.aggregateStatsShardsV7(shards, null)).bySession.s?.[KEY]?.totalRequests;
}

const lockPathOf = (I: any) => join(I.SHARD_FILES_DIR, "..", "maintenance", "cleanup.lock");

async function ageLock(I: any): Promise<void> {
  const old = new Date(Date.now() - 2 * HOUR);
  await utimes(lockPathOf(I), old, old);
}

describe("issue #28 archive F: publishing is a compare-and-swap", () => {
  test("a holder that stalls past the stale-lock window cannot overwrite the archive its successor published", async () => {
    await withAgentDir(async () => {
      const a = await load("stalled-a");
      const b = await load("stalled-b");
      const now = Date.now();
      // An earlier pass already archived 2 requests.
      await writeClosedShard(a, now - 5 * DAY, 2);
      await a.compactStatsShardsV7(now);
      await writeClosedShard(a, now - 3 * DAY, 5);
      assert.equal(await sessionRequests(a), 7);

      const token = await a.acquireStatsMaintenanceLock(now);
      assert.ok(token);
      let successor: any;
      const stalled = await a.compactStatsShardsV7(now, a.SHARD_FILES_DIR, a.SHARD_ARCHIVE_PATH, {
        lockToken: token,
        // A passed every publish check, then the laptop slept for hours: its
        // lock went stale, another process took it over, archived a shard A
        // never saw and deleted the originals.
        beforeCommit: async () => {
          await writeClosedShard(b, now - 2 * DAY, 11);
          await ageLock(a);
          successor = await b.maybeRunStatsMaintenance(now);
        },
      });
      assert.equal(successor.compaction?.absorbed, 2, "the successor took over and archived both raw shards");
      assert.deepEqual(await readdir(b.SHARD_FILES_DIR), [], "the successor deleted the originals");

      assert.equal(stalled.skippedConcurrent, true, "the stalled holder notices it lost the race");
      assert.equal(stalled.removed, 0);
      const reader = await load("stalled-reader");
      assert.equal(await sessionRequests(reader), 18, "no counter is lost and none is counted twice");
      await a.releaseStatsMaintenanceLock(token);
    });
  });

  test("two compactors that read the same generation: exactly one publishes, the loser deletes nothing", async () => {
    await withAgentDir(async () => {
      const a = await load("race-a");
      const b = await load("race-b");
      const now = Date.now();
      await writeClosedShard(a, now - 4 * DAY, 3);
      await a.compactStatsShardsV7(now);
      const kept = await writeClosedShard(a, now - 3 * DAY, 4);
      let inner: any;
      const outer = await a.compactStatsShardsV7(now, a.SHARD_FILES_DIR, a.SHARD_ARCHIVE_PATH, {
        // Both have planned on the same generation; B commits first.
        beforeCommit: async () => { inner = await b.compactStatsShardsV7(now); },
      });
      assert.equal(inner.skippedConcurrent, false);
      assert.equal(inner.generation, 2);
      assert.equal(outer.skippedConcurrent, true);
      assert.equal(outer.generation, undefined);
      assert.deepEqual(await a.listStatsArchiveGenerations(), [1, 2]);
      assert.ok((await b.readStatsArchive()).absorbedIds.has(kept));
      assert.equal(await sessionRequests(await load("race-reader")), 7);
    });
  });

  test("a stalled holder whose base generation was cleaned up meanwhile publishes invisibly and deletes nothing", async () => {
    await withAgentDir(async () => {
      const a = await load("hole-a");
      const others = [await load("hole-b"), await load("hole-c"), await load("hole-d")];
      const now = Date.now();
      await writeClosedShard(a, now - 6 * DAY, 1);
      await a.compactStatsShardsV7(now); // generation 1
      // A shard that only the stalled holder can see: the others' passes run
      // while it is (transiently) out of the directory.
      const hidden = await writeClosedShard(a, now - 3 * DAY, 9);
      const hiddenPath = join(a.SHARD_FILES_DIR, `${hidden}.json`);
      const parked = join(a.SHARD_FILES_DIR, "..", "parked.json");
      const stalled = await a.compactStatsShardsV7(now, a.SHARD_FILES_DIR, a.SHARD_ARCHIVE_PATH, {
        beforeCommit: async () => {
          await rename(hiddenPath, parked);
          // Three newer passes: generation 2 (A's target) is removed again
          // once generation 4 exists, so A's exclusive link succeeds.
          for (const [index, other] of others.entries()) {
            await writeClosedShard(other, now - 2 * DAY, 100 * (index + 1));
            await other.compactStatsShardsV7(now);
          }
          assert.deepEqual(await a.listStatsArchiveGenerations(), [3, 4]);
          await rename(parked, hiddenPath);
        },
      });
      assert.equal(stalled.skippedConcurrent, true, "a generation above its own means it lost");
      assert.equal(stalled.removed, 0, "the shard only its invisible snapshot covers is not deleted");
      assert.ok((await readdir(a.SHARD_FILES_DIR)).includes(`${hidden}.json`));
      const reader = await load("hole-reader");
      assert.equal(await sessionRequests(reader), 1 + 9 + 100 + 200 + 300);
      // The next pass archives it normally.
      await reader.compactStatsShardsV7(now);
      assert.equal(await sessionRequests(await load("hole-reader-2")), 1 + 9 + 100 + 200 + 300);
    });
  });

  test("old generations are removed one generation late; a bogus newest entry is not trusted", async () => {
    await withAgentDir(async () => {
      const I = await load("cleanup");
      const reader = await load("cleanup-reader");
      const now = Date.now();
      let expected = 0;
      for (let i = 1; i <= 5; i++) {
        await writeClosedShard(I, now - (2 + i) * DAY, i);
        expected += i;
        await I.compactStatsShardsV7(now);
        assert.equal(await sessionRequests(reader), expected);
      }
      assert.deepEqual(await I.listStatsArchiveGenerations(), [4, 5]);
      // A generation that is listed but vanishes before it is opened.
      const ghost = I.statsArchiveGenerationPath(I.SHARD_ARCHIVE_PATH, 6);
      await mkdir(ghost);
      const view = await reader.readStatsArchiveView();
      // Not trusted, and since review G not fatal either: readers use the
      // newest readable generation and the next publish goes above it.
      assert.equal(view.corrupt, false);
      assert.equal(view.generation, 5, "a non-file generation is skipped");
      assert.equal(view.newestGeneration, 6);
      assert.deepEqual(view.corruptGenerations, [6]);
      await rm(ghost, { recursive: true });
      assert.equal((await reader.readStatsArchiveView()).generation, 5);
    });
  });
});

describe("issue #28 archive F: lock heartbeat", () => {
  test("the holder refreshes the lock's mtime; a displaced holder does not touch the new owner's lock", async () => {
    await withAgentDir(async () => {
      const I = await load("heartbeat");
      const token = await I.acquireStatsMaintenanceLock();
      await ageLock(I);
      assert.equal(await I.touchStatsMaintenanceLock(token), true);
      assert.ok(Date.now() - (await stat(lockPathOf(I))).mtimeMs < HOUR, "a touched lock is not stale");
      assert.equal(await I.acquireStatsMaintenanceLock(), undefined);

      await ageLock(I);
      const other = await load("heartbeat-other");
      const successor = await other.acquireStatsMaintenanceLock();
      assert.ok(successor);
      await ageLock(I);
      assert.equal(await I.touchStatsMaintenanceLock(token), false);
      assert.ok(Date.now() - (await stat(lockPathOf(I))).mtimeMs >= HOUR, "the displaced holder left it alone");
      await other.releaseStatsMaintenanceLock(successor);
      await I.releaseStatsMaintenanceLock(token);
    });
  });
});

describe("issue #28 archive: 2.9.0 compatibility", () => {
  test("an archive.json that 2.9.0 writes after the migration is set aside, never merged", async () => {
    await withAgentDir(async () => {
      const I = await load("orphan");
      const now = Date.now();
      await writeClosedShard(I, now - 3 * DAY, 3);
      await I.compactStatsShardsV7(now);
      assert.equal((await lstat(I.SHARD_ARCHIVE_PATH)).isDirectory(), true);
      // Someone removed the tombstone and a 2.9.0 process (from an empty
      // archive) re-absorbed a crash leftover of an already archived shard.
      await rm(I.SHARD_ARCHIVE_PATH, { recursive: true });
      const generation = JSON.parse(await readFile(I.statsArchiveGenerationPath(I.SHARD_ARCHIVE_PATH, 1), "utf8"));
      const v1 = (await I.readStatsArchive()).archive;
      assert.equal(generation.buckets.length, v1.buckets.length);
      await writeFile(I.SHARD_ARCHIVE_PATH, JSON.stringify({ ...v1, updatedAt: now + 1 }));
      assert.equal(await sessionRequests(I), 3, "readers ignore archive.json once a generation exists");
      const warnings: unknown[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args); };
      try {
        await writeClosedShard(I, now - 2 * DAY, 2);
        await I.compactStatsShardsV7(now);
      } finally {
        console.warn = warn;
      }
      assert.equal(warnings.length, 1);
      assert.equal((await lstat(I.SHARD_ARCHIVE_PATH)).isDirectory(), true);
      assert.ok((await readdir(join(I.SHARD_ARCHIVE_PATH, ".."))).some((name) => /^archive\.legacy-\d+\.json$/.test(name)));
      assert.equal(await sessionRequests(I), 5);
    });
  });
});

describe("issue #28 archive H: compact format and reduced reads", () => {
  test("the generation format round-trips every entry exactly and is much smaller than 2.9.0's", async () => {
    await withAgentDir(async () => {
      const I = await load("format");
      const archive = {
        version: 1, kind: "pi-cache-optimizer-archive", updatedAt: 5, absorbed: { a: 1, b: 2 },
        buckets: Array.from({ length: 300 }, (_, i) => ({
          globalEpoch: "g", sessionHash: `session-${i % 40}-${"x".repeat(40)}`, modelKey: i % 3 ? "p/m" : "q/n", modelEpoch: `e${i % 2}`,
          day: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`, provider: i % 3 ? "p" : "q", modelId: i % 3 ? "m" : "n",
          ...(i % 5 ? { modelName: "Name" } : {}), ...(i % 7 ? { api: "openai" } : {}), updatedAt: 1_790_000_000_000 + i,
          stats: { day: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`, totalRequests: 9 + i, hitRequests: i, cachedInputTokens: 100 * i, cacheWriteInputTokens: i % 4, totalInputTokens: 1000 * i + 5 },
        })),
        routed: [{ globalEpoch: "g", sessionHash: "s", day: "2026-09-02", updatedAt: 3, model: { provider: "p", id: "m", name: "m" } }],
      };
      const reparsed = I.parseStatsArchiveV2(JSON.parse(JSON.stringify(I.encodeStatsArchiveV2(archive, 3, "abc"))));
      assert.deepEqual(reparsed, { archive, generation: 3, legacySha256: "abc" });
      const v2Size = JSON.stringify(I.encodeStatsArchiveV2(archive, 3)).length;
      assert.ok(v2Size * 3 < JSON.stringify(archive).length, `v2 ${v2Size} bytes`);
      // A damaged row is dropped, not trusted.
      const doc = I.encodeStatsArchiveV2(archive, 3);
      doc.buckets[0][0] = 999_999;
      doc.buckets[1][8] = 10_000_000; // hitRequests > totalRequests
      assert.equal(I.parseStatsArchiveV2(doc).archive.buckets.length, 298);
      assert.equal(I.parseStatsArchiveV2({ ...doc, strings: [1] }), undefined);
    });
  });

  test("the reduced all-days and per-day reads equal aggregating every archived bucket (randomized, key order included)", async () => {
    await withAgentDir(async () => {
      const I = await load("reduced");
      const g = await I.readGlobalStatsEpoch();
      const keys = ["p/a", "p/b", "q/c"];
      const epochs: Record<string, string> = {};
      for (const key of keys) epochs[key] = await I.readModelStatsEpoch(key);
      let state = 7;
      const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)] as T;
      const days = ["2026-09-01", "2026-09-02", "2026-09-03", localDay(Date.now())];
      for (let round = 0; round < 25; round++) {
        const buckets = Array.from({ length: 80 }, () => {
          const key = pick(keys);
          const [provider, modelId] = key.split("/");
          const day = pick(days);
          const total = 1 + Math.floor(random() * 9);
          return {
            globalEpoch: random() < 0.1 ? "old-global" : g, sessionHash: pick(["s1", "s2", "s3", "s4", "s5"]), modelKey: key,
            modelEpoch: random() < 0.15 ? "old-model" : epochs[key], day, provider, modelId,
            ...(random() < 0.5 ? { modelName: pick(["A", "B"]) } : {}), ...(random() < 0.5 ? { api: "x" } : {}),
            // Small range: plenty of ties; some at or below -1.
            updatedAt: Math.floor(random() * 8) - 2,
            stats: { day: pick(days), totalRequests: total, hitRequests: Math.floor(random() * total), cachedInputTokens: 3, cacheWriteInputTokens: 1, totalInputTokens: 50 },
          };
        });
        const routed = Array.from({ length: 12 }, () => ({
          globalEpoch: random() < 0.15 ? "old-global" : g, sessionHash: pick(["s1", "s2", "s3", "s6"]), day: pick(days),
          updatedAt: Math.floor(random() * 6) - 2, model: { provider: "p", id: pick(["a", "b"]), name: pick(["a", "b"]) },
        }));
        const archive = { version: 1, kind: "pi-cache-optimizer-archive", updatedAt: 0, absorbed: {}, buckets, routed };
        const view = new I.StatsArchiveView(archive, true, false, 1);
        const shard = (sessionHash: string, updatedAt: number, day: string, key?: string) => ({
          version: 7, kind: "pi-cache-optimizer-shard", instanceId: `raw-${random()}`, sessionHash,
          process: { pid: 1, ppid: 0, instanceStartedAt: 0 }, lifecycle: { state: "closed", createdAt: 0, updatedAt },
          day, globalEpoch: g,
          models: key ? { [key]: { modelEpoch: epochs[key], provider: key.split("/")[0], modelId: key.split("/")[1], stats: { day, totalRequests: 2, hitRequests: 1, cachedInputTokens: 1, cacheWriteInputTokens: 0, totalInputTokens: 9 } } } : {},
          ...(random() < 0.6 ? { lastRoutedModel: { provider: "q", id: "c", name: "c" } } : {}),
        });
        const leading = Array.from({ length: 4 }, () => shard(pick(["s1", "s7"]), Math.floor(random() * 8) - 2, pick(days), pick([...keys, undefined as any])));
        const trailing = [shard("s2", Math.floor(random() * 8) - 2, pick(days), pick(keys))];
        for (const day of [null, ...days, "2026-01-01"]) {
          const expected = await I.aggregateStatsShardsV7(structuredClone([...leading, ...view.shards, ...trailing]), day);
          for (let pass = 0; pass < 2; pass++) { // second pass hits the caches
            const actual = await I.aggregateStatsWithArchiveV7(leading, view, trailing, day);
            assert.deepEqual(actual, expected, `round ${round} day ${day}`);
            assert.equal(JSON.stringify(actual), JSON.stringify(expected), `round ${round} day ${day}: key order`);
          }
        }
        // Restricted to some sessions (the refresh builds the current one only).
        for (const only of [["s1"], ["s2"], ["s4", "s1"], ["s6", "s7"], [], ["missing"]]) {
          const set = new Set(only);
          const shards = [...leading, ...view.shards, ...trailing].filter((s: any) => set.has(s.sessionHash));
          for (const day of [null, days[0]]) {
            const expected = await I.aggregateStatsShardsV7(structuredClone(shards), day);
            const actual = await I.aggregateStatsWithArchiveV7(leading, view, trailing, day, set);
            assert.equal(JSON.stringify(actual), JSON.stringify(expected), `round ${round} sessions ${only} day ${day}`);
          }
        }
        // Nothing the aggregate hands out aliases the cached reduction.
        const handed = await I.aggregateStatsWithArchiveV7([], view, [], null);
        for (const models of Object.values(handed.bySession) as any[]) for (const stats of Object.values(models) as any[]) stats.totalRequests += 1000;
        for (const ref of Object.values(handed.lastRoutedModelBySession) as any[]) ref.id = "mutated";
        assert.deepEqual(await I.aggregateStatsWithArchiveV7([], view, [], null), await I.aggregateStatsShardsV7(structuredClone([...view.shards]), null));
      }
      // A reset changes the reduction (fingerprinted by the epochs).
      const view = new I.StatsArchiveView({ version: 1, kind: "pi-cache-optimizer-archive", updatedAt: 0, absorbed: {}, routed: [], buckets: [
        { globalEpoch: g, sessionHash: "s", modelKey: "p/a", modelEpoch: epochs["p/a"], day: "2026-09-01", provider: "p", modelId: "a", updatedAt: 1, stats: { day: "2026-09-01", totalRequests: 1, hitRequests: 1, cachedInputTokens: 1, cacheWriteInputTokens: 0, totalInputTokens: 1 } },
      ] }, true, false, 1);
      assert.equal((await I.aggregateStatsWithArchiveV7([], view, [], null)).bySession.s["p/a"].totalRequests, 1);
      await I.advanceModelStatsEpoch("p/a");
      assert.deepEqual((await I.aggregateStatsWithArchiveV7([], view, [], null)).bySession, {});
    });
  });
});
