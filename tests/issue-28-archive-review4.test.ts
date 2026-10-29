import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

// Regressions for the open findings of the 2.9.0 and 2.9.1 adversarial
// reviews of the issue #28 archive (G, I-M, 2.9.1 #4-#8 and the surviving
// mutants M12-M14). Faults are injected through test hooks, not file modes,
// so every test also runs as root.

const DAY = 24 * 3600_000;
const HOUR = 3600_000;
const KEY = "proxy/gpt-5.5";

function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function withAgentDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-issue-28-review4-"));
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
  const jiti = createJiti(join(process.cwd(), "tests", `issue-28-review4-${label}.ts`), { interopDefault: false, moduleCache: false });
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

/** A 2.9.0-format archive.json with one bucket of `requests` requests and the given absorbed ids. */
async function legacyArchive(I: any, at: number, requests: number, absorbed: Record<string, number> = {}): Promise<string> {
  const day = localDay(at);
  return JSON.stringify({
    version: 1, kind: "pi-cache-optimizer-archive", updatedAt: at, absorbed,
    buckets: [{
      globalEpoch: await I.readGlobalStatsEpoch(), sessionHash: "s", modelKey: KEY, modelEpoch: await I.readModelStatsEpoch(KEY),
      day, provider: "proxy", modelId: "gpt-5.5", updatedAt: at,
      stats: { day, totalRequests: requests, hitRequests: requests, cachedInputTokens: 10 * requests, cacheWriteInputTokens: 0, totalInputTokens: 20 * requests },
    }],
    routed: [],
  }) + "\n";
}

describe("G: an unreadable archive heals without double counting", () => {
  test("a damaged newest generation falls back to the previous one; the next pass publishes above it and quarantines it", async () => {
    await withAgentDir(async () => {
      const I = await load("g-corrupt");
      const now = Date.now();
      await writeClosedShard(I, now - 6 * DAY, 2);
      await I.compactStatsShardsV7(now); // generation 1: 2
      // Generation 2 absorbed a second shard but the delete failed (the raw
      // file is still there), then generation 2 was damaged on disk.
      const leftover = await writeClosedShard(I, now - 5 * DAY, 3);
      await I.compactStatsShardsV7(now);
      await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, `${leftover}.json`), await shardDoc(I, leftover, now - 5 * DAY, 3));
      assert.deepEqual(await I.listStatsArchiveGenerations(), [1, 2]);
      await writeFile(genPath(I, 2), "{\"version\":2,\"kind\":\"pi-cache-optimizer-archive\",\"generation\":2,\"absor");
      const old = new Date(now - HOUR);
      await utimes(genPath(I, 2), old, old);

      const reader = await load("g-corrupt-reader");
      const view = await reader.readStatsArchiveView();
      assert.equal(view.corrupt, false);
      assert.equal(view.generation, 1, "readers fall back to the newest readable generation");
      assert.deepEqual(view.corruptGenerations, [2]);
      assert.equal(await sessionRequests(reader), 5, "the leftover is counted raw again, exactly once");

      const { value: healed, warnings } = await quietly(() => reader.compactStatsShardsV7(now));
      assert.equal(healed.skippedCorrupt, false);
      assert.equal(healed.generation, 3, "published above the unreadable generation");
      assert.equal(warnings.length, 1);
      const names = await readdir(archiveDir(I));
      assert.ok(names.some((name) => /^archive\.000000000002\.corrupt-\d+\.json$/.test(name)), names.join(", "));
      assert.deepEqual(await I.listStatsArchiveGenerations(), [3]);
      assert.deepEqual(await readdir(I.SHARD_FILES_DIR), []);
      assert.equal(await sessionRequests(await load("g-corrupt-reader-2")), 5);
    });
  });

  test("when no generation is readable, compaction starts over from the raw shards", async () => {
    await withAgentDir(async () => {
      const I = await load("g-all");
      const now = Date.now();
      await mkdir(archiveDir(I), { recursive: true });
      await writeFile(genPath(I, 4), "garbage");
      const old = new Date(now - HOUR);
      await utimes(genPath(I, 4), old, old);
      await writeClosedShard(I, now - 4 * DAY, 6);
      assert.equal(await sessionRequests(I), 6);
      const { value: result } = await quietly(() => I.compactStatsShardsV7(now));
      assert.equal(result.generation, 5);
      assert.equal(result.absorbed, 1);
      assert.equal(await sessionRequests(await load("g-all-reader")), 6);
    });
  });

  test("a 2.9.0 archive.json that does not parse is set aside and the first generation starts over", async () => {
    await withAgentDir(async () => {
      const I = await load("g-legacy");
      const now = Date.now();
      await mkdir(archiveDir(I), { recursive: true });
      await writeFile(I.SHARD_ARCHIVE_PATH, "{ not json");
      await writeClosedShard(I, now - 4 * DAY, 6);
      assert.equal(await sessionRequests(I), 6);
      const { value: result, warnings } = await quietly(() => I.compactStatsShardsV7(now));
      assert.equal(result.skippedCorrupt, false);
      assert.equal(result.generation, 1);
      assert.equal(warnings.length, 1);
      assert.equal((await lstat(I.SHARD_ARCHIVE_PATH)).isDirectory(), true, "2.9.0 is locked out");
      const kept = (await readdir(archiveDir(I))).filter((name) => /^archive\.legacy-\d+\.json$/.test(name));
      assert.equal(kept.length, 1);
      assert.equal(await readFile(join(archiveDir(I), kept[0]!), "utf8"), "{ not json");
      assert.equal(await sessionRequests(await load("g-legacy-reader")), 6);
    });
  });

  test("an archive in a newer format is never recovered past or overwritten", async () => {
    await withAgentDir(async () => {
      const I = await load("g-newer");
      const now = Date.now();
      await writeClosedShard(I, now - 6 * DAY, 2);
      await I.compactStatsShardsV7(now);
      const future = JSON.stringify({ version: 3, kind: "pi-cache-optimizer-archive", generation: 2 });
      await writeFile(genPath(I, 2), future);
      await writeClosedShard(I, now - 5 * DAY, 3);
      const result = await I.compactStatsShardsV7(now);
      assert.equal(result.skippedCorrupt, true);
      assert.equal(await readFile(genPath(I, 2), "utf8"), future);
      assert.equal((await readdir(I.SHARD_FILES_DIR)).length, 1, "nothing absorbed or deleted");
    });
  });
});

describe("#7: filesystems without hard links", () => {
  test("link EPERM/ENOTSUP/EINVAL publishes by exclusive in-place creation; readers and totals are unchanged", async () => {
    for (const code of ["EPERM", "ENOTSUP", "EINVAL"]) {
      await withAgentDir(async () => {
        const I = await load(`nolink-${code}`);
        const now = Date.now();
        I.setStatsArchiveTestHooks({ link: async () => { throw errno(code); } });
        await writeClosedShard(I, now - 5 * DAY, 2);
        const first = await I.compactStatsShardsV7(now);
        assert.equal(first.generation, 1, code);
        await writeClosedShard(I, now - 4 * DAY, 3);
        const second = await I.compactStatsShardsV7(now);
        assert.equal(second.generation, 2, code);
        assert.deepEqual(await readdir(I.SHARD_FILES_DIR), []);
        const doc = JSON.parse(await readFile(genPath(I, 2), "utf8"));
        assert.equal(doc.complete, true, "carries the completeness marker");
        assert.equal(Object.keys(doc).at(-1), "complete", "as the last property");
        assert.equal(await sessionRequests(await load(`nolink-${code}-reader`)), 5);
      });
    }
  });

  test("other link errors still fail the pass without publishing or deleting", async () => {
    await withAgentDir(async () => {
      const I = await load("nolink-eio");
      const now = Date.now();
      I.setStatsArchiveTestHooks({ link: async () => { throw errno("EIO"); } });
      await writeClosedShard(I, now - 5 * DAY, 2);
      await assert.rejects(I.compactStatsShardsV7(now), /EIO/);
      assert.deepEqual(await I.listStatsArchiveGenerations(), []);
      assert.equal((await readdir(I.SHARD_FILES_DIR)).length, 1);
    });
  });

  test("the in-place path is still a compare-and-swap: a writer that finds the generation taken deletes nothing", async () => {
    await withAgentDir(async () => {
      const I = await load("nolink-race");
      const other = await load("nolink-race-other");
      const now = Date.now();
      await writeClosedShard(I, now - 5 * DAY, 2);
      I.setStatsArchiveTestHooks({
        link: async () => {
          // The other process wins generation 1 first (its own link works),
          // including a shard this pass never saw.
          await writeClosedShard(other, now - 4 * DAY, 5);
          await other.compactStatsShardsV7(now);
          throw errno("EPERM");
        },
      });
      const lost = await I.compactStatsShardsV7(now);
      assert.equal(lost.skippedConcurrent, true);
      assert.equal(lost.removed, 0);
      assert.equal(await sessionRequests(await load("nolink-race-reader")), 7, "the winner's generation is not overwritten");
    });
  });

  test("an incomplete in-place generation is skipped by readers, waited for while young, and recovered past once old", async () => {
    await withAgentDir(async () => {
      const I = await load("nolink-incomplete");
      const now = Date.now();
      await writeClosedShard(I, now - 5 * DAY, 2);
      await I.compactStatsShardsV7(now);
      await writeClosedShard(I, now - 4 * DAY, 3);
      // A writer is (or crashed while) writing generation 2 in place.
      const text = JSON.stringify(I.encodeStatsArchiveV2((await I.readStatsArchive()).archive, 2)) + "\n";
      await writeFile(genPath(I, 2), text.slice(0, Math.floor(text.length / 2)));
      const reader = await load("nolink-incomplete-reader");
      assert.equal((await reader.readStatsArchiveView()).generation, 1);
      assert.equal(await sessionRequests(reader), 5);
      const waiting = await reader.compactStatsShardsV7(now);
      assert.equal(waiting.skippedConcurrent, true, "a young incomplete generation may still be written");
      assert.equal((await readdir(I.SHARD_FILES_DIR)).length, 1);

      const old = new Date(now - HOUR);
      await utimes(genPath(I, 2), old, old);
      const { value: healed } = await quietly(() => reader.compactStatsShardsV7(now));
      assert.equal(healed.generation, 3);
      assert.equal(await sessionRequests(await load("nolink-incomplete-reader-2")), 5);
    });
  });
});

describe("2.9.1 #4: migrating from a 2.9.0 archive.json", () => {
  test("moving archive.json aside waits out a scanner holding it for over a second", async () => {
    await withAgentDir(async () => {
      const I = await load("m4-budget");
      const now = Date.now();
      await mkdir(archiveDir(I), { recursive: true });
      await writeFile(I.SHARD_ARCHIVE_PATH, await legacyArchive(I, now - 5 * DAY, 4));
      const started = Date.now();
      I.setStatsFsTestHooks({
        beforeRename: (from: string) => {
          if (from === I.SHARD_ARCHIVE_PATH && Date.now() - started < 1_200) throw errno("EPERM");
        },
      });
      const result = await I.compactStatsShardsV7(now);
      assert.equal(result.generation, 1);
      assert.equal((await lstat(I.SHARD_ARCHIVE_PATH)).isDirectory(), true);
      assert.equal(await sessionRequests(await load("m4-budget-reader")), 4);
    });
  });

  test("a migration interrupted after moving archive.json aside is read from, and finished from, its placeholder", async () => {
    await withAgentDir(async () => {
      const I = await load("m4-crash");
      const now = Date.now();
      await mkdir(archiveDir(I), { recursive: true });
      await writeFile(I.SHARD_ARCHIVE_PATH, await legacyArchive(I, now - 5 * DAY, 4));
      await writeClosedShard(I, now - 4 * DAY, 1);
      I.setStatsArchiveTestHooks({ link: async () => { throw errno("EIO"); } }); // dies right before linking
      await assert.rejects(I.compactStatsShardsV7(now), /EIO/);
      assert.equal((await lstat(I.SHARD_ARCHIVE_PATH)).isDirectory(), true, "2.9.0 is already locked out");
      assert.ok((await readdir(archiveDir(I))).some((name) => /^archive\.migrating-.+\.json$/.test(name)));
      const reader = await load("m4-crash-reader");
      assert.equal(await sessionRequests(reader), 5, "readers use the placeholder");
      const finished = await reader.compactStatsShardsV7(now);
      assert.equal(finished.generation, 1);
      assert.ok(!(await readdir(archiveDir(I))).some((name) => name.startsWith("archive.migrating-") || name.startsWith("archive.legacy-")));
      assert.equal(await sessionRequests(await load("m4-crash-reader-2")), 5);
    });
  });
});

describe("2.9.1 #5/#6, M13/M14: readers racing a migration or a cleanup", () => {
  test("#5: archive.json vanishing between the listing and the lstat (migration in progress) re-lists instead of reading no archive", async () => {
    await withAgentDir(async () => {
      const I = await load("m5");
      const now = Date.now();
      await mkdir(archiveDir(I), { recursive: true });
      await writeFile(I.SHARD_ARCHIVE_PATH, await legacyArchive(I, now - 5 * DAY, 4));
      const migrator = await load("m5-migrator");
      const reader = await load("m5-reader");
      let once = true;
      reader.setStatsArchiveTestHooks({
        afterList: async () => {
          if (!once) return;
          once = false;
          // 2.9.1's migration between the reader's listing and its lstat:
          // generation 1 linked, archive.json retired, tombstone not yet made.
          const legacy = (await migrator.readStatsArchive()).archive;
          await writeFile(genPath(I, 1), JSON.stringify(migrator.encodeStatsArchiveV2(legacy, 1)) + "\n");
          await rename(I.SHARD_ARCHIVE_PATH, `${I.SHARD_ARCHIVE_PATH}.retired.tmp`);
        },
      });
      const view = await reader.readStatsArchiveView();
      assert.equal(view.generation, 1);
      assert.equal(await sessionRequests(reader), 4);
    });
  });

  test("M13: a tombstone directory without a generation in the listing re-lists (the listing raced the migration)", async () => {
    await withAgentDir(async () => {
      const I = await load("m13");
      const now = Date.now();
      await mkdir(archiveDir(I), { recursive: true });
      await writeFile(I.SHARD_ARCHIVE_PATH, await legacyArchive(I, now - 5 * DAY, 4));
      const migrator = await load("m13-migrator");
      const reader = await load("m13-reader");
      let once = true;
      reader.setStatsArchiveTestHooks({
        afterList: async () => {
          if (!once) return;
          once = false;
          await migrator.compactStatsShardsV7(now); // the complete migration
        },
      });
      const view = await reader.readStatsArchiveView();
      assert.equal(view.generation, 1);
      assert.equal(view.present, true);
    });
  });

  for (const op of ["lstat", "readFile"] as const) {
    test(`${op === "lstat" ? "#6" : "M14"}: ${op} EPERM on a generation being deleted (Windows delete-pending) moves on to the newer one`, async () => {
      await withAgentDir(async () => {
        const I = await load(`m6-${op}`);
        const now = Date.now();
        await writeClosedShard(I, now - 6 * DAY, 1);
        await I.compactStatsShardsV7(now);
        const doc = JSON.parse(await readFile(genPath(I, 1), "utf8"));
        const reader = await load(`m6-${op}-reader`);
        // A busy compactor supersedes the generation the reader picked, again
        // and again; each superseded file fails with EPERM while it is being
        // deleted. More times in a row than transient retries allow.
        let newest = 1;
        const hook = async (path: string) => {
          if (path !== genPath(I, newest) || newest >= 6) return;
          newest++;
          await writeFile(genPath(I, newest), JSON.stringify({ ...doc, generation: newest }) + "\n");
          throw errno("EPERM");
        };
        reader.setStatsArchiveTestHooks(op === "lstat" ? { beforeLstat: hook } : { beforeReadFile: hook });
        const read = await reader.readStatsArchiveDetailed();
        assert.equal(read.stale, false);
        assert.equal(read.view.generation, 6);
        await assert.doesNotReject(reader.readStatsArchiveView(I.SHARD_ARCHIVE_PATH, { strict: true }));
      });
    });
  }
});

describe("J: a transient archive read error never pairs an old archive with a newer shard listing", () => {
  test("the previous consistent snapshot is reused when the archive read keeps failing", async () => {
    await withAgentDir(async () => {
      const A = await load("j-reader");
      const B = await load("j-compactor");
      const now = Date.now();
      await writeClosedShard(A, now - 6 * DAY, 2);
      await B.compactStatsShardsV7(now); // generation 1
      await writeClosedShard(A, now - 5 * DAY, 3);
      const first = await A.readStatsSnapshot();
      assert.equal(first.archive.generation, 1);
      assert.equal(first.rawShards.length, 1);

      await B.compactStatsShardsV7(now); // generation 2 absorbs the 3 and deletes it
      A.setStatsArchiveTestHooks({ beforeReadFile: async (path: string) => { if (path === genPath(A, 2)) throw errno("EBUSY"); } });
      const second = await A.readStatsSnapshot(first);
      assert.equal(second, first, "the old archive is not paired with the new listing");
      const raw = second.rawShards.filter((shard: any) => !second.archive.absorbedIds.has(shard.instanceId));
      assert.equal((await A.aggregateStatsWithArchiveV7(raw, second.archive, [], null)).bySession.s[KEY].totalRequests, 5);

      A.setStatsArchiveTestHooks(undefined);
      const third = await A.readStatsSnapshot(second);
      assert.equal(third.archive.generation, 2);
      assert.equal(await sessionRequests(A), 5);
    });
  });
});

describe("K: a compaction pass that throws retries soon", () => {
  test("the compaction marker is backdated so the next pass is due in minutes, not six hours", async () => {
    await withAgentDir(async () => {
      const I = await load("k");
      const now = Date.now();
      await writeClosedShard(I, now - 5 * DAY, 2);
      // An epoch file that cannot be read (EISDIR stands in for a Windows EPERM).
      const epochPath = I.SHARD_GLOBAL_EPOCH_PATH;
      await mkdir(epochPath, { recursive: true });
      const marker = join(I.SHARD_FILES_DIR, "..", "maintenance", "last-compaction");
      const { value: failed } = await quietly(() => I.maybeRunStatsMaintenance(now));
      assert.equal(failed.compaction, undefined);
      assert.equal(await I.isMaintenanceMarkerDue(marker, now + 60_000), false, "no retry storm on every startup");
      assert.equal(await I.isMaintenanceMarkerDue(marker, now + 11 * 60_000), true, "retried after a short backoff");
      await rm(epochPath, { recursive: true });
      const retried = await I.maybeRunStatsMaintenance(now + 11 * 60_000);
      assert.equal(retried.compaction?.absorbed, 1);
      assert.equal(await I.isMaintenanceMarkerDue(marker, now + 11 * 60_000 + HOUR), false, "a successful pass waits the full interval");
    });
  });
});

describe("L: Windows file system behaviour", () => {
  test("writing an epoch file retries a transient rename failure", async () => {
    await withAgentDir(async () => {
      const I = await load("l-epoch");
      let failures = 0;
      I.setStatsFsTestHooks({
        beforeRename: (_from: string, to: string) => {
          if (to === I.SHARD_GLOBAL_EPOCH_PATH && failures < 2) {
            failures++;
            throw errno("EPERM");
          }
        },
      });
      const epoch = await I.advanceGlobalStatsEpoch();
      assert.equal(failures, 2);
      assert.equal(await I.readGlobalStatsEpoch(), epoch);
      assert.ok(!(await readdir(join(I.SHARD_GLOBAL_EPOCH_PATH, ".."))).some((name) => name.endsWith(".tmp")));
    });
  });

  test("renameWithRetry keeps retrying for well over the old 300 ms budget", async () => {
    await withAgentDir(async (dir) => {
      const I = await load("l-budget");
      const from = join(dir, "from");
      const to = join(dir, "to");
      await writeFile(from, "x");
      const started = Date.now();
      I.setStatsFsTestHooks({ beforeRename: () => { if (Date.now() - started < 800) throw errno("EBUSY"); } });
      await I.renameWithRetry(from, to);
      assert.equal(await readFile(to, "utf8"), "x");
      I.setStatsFsTestHooks({ beforeRename: () => { throw errno("EBUSY"); } });
      await writeFile(from, "y");
      const before = Date.now();
      await assert.rejects(I.renameWithRetry(from, to, 100), /EBUSY/);
      assert.ok(Date.now() - before < 1_000, "the budget still bounds it");
    });
  });

  test("a shard rewritten in place is re-read even when the inode is 0 and the mtime is coarse (FAT, SMB)", async () => {
    await withAgentDir(async () => {
      const I = await load("l-ino");
      const now = Date.now();
      I.setStatsFsTestHooks({
        shardStat: (_path: string, info: any) => {
          info.ino = 0;
          info.mtimeMs = Math.floor(now / 2000) * 2000;
          return info;
        },
      });
      const id = nextId();
      const path = join(I.SHARD_FILES_DIR, `${id}.json`);
      await I.writeStatsShardV7(path, await shardDoc(I, id, now - DAY, 5));
      assert.equal((await I.readValidStatsShardsV7())[0].models[KEY].stats.totalRequests, 5);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await I.writeStatsShardV7(path, await shardDoc(I, id, now - DAY, 6)); // same size
      assert.equal((await I.readValidStatsShardsV7())[0].models[KEY].stats.totalRequests, 6);
    });
  });
});

describe("M: the current-day view across time zones", () => {
  test("a day is archived only once it is over in every time zone", async () => {
    await withAgentDir(async () => {
      const I = await load("m-guard");
      const shard = await shardDoc(I, nextId(), Date.UTC(2026, 9, 15, 10), 1, { day: "2026-10-15" });
      for (const entry of Object.values(shard.models) as any[]) entry.stats.day = "2026-10-15";
      assert.equal(I.isArchivableShard(shard, Date.UTC(2026, 9, 16, 11, 59), "2026-10-16"), false, "still 2026-10-15 in UTC-12");
      assert.equal(I.isArchivableShard(shard, Date.UTC(2026, 9, 16, 12, 0), "2026-10-16"), true);
      // Usage recorded after midnight before the rollover stays raw.
      for (const entry of Object.values(shard.models) as any[]) entry.stats.day = "2026-10-16";
      assert.equal(I.isArchivableShard(shard, Date.UTC(2026, 9, 20), "2026-10-20"), false);
    });
  });

  test("a process whose day is still running elsewhere keeps exact instance counts after another process compacts", async () => {
    await withAgentDir(async () => {
      const I = await load("m-tz");
      const day = localDay(Date.now() - 3 * DAY);
      const [y, m, d] = day.split("-").map(Number) as [number, number, number];
      const midnight = Date.UTC(y, m - 1, d);
      // Two closed shards of `day` (same session, model and close time: one
      // archive bucket), compacted 30 hours after that day's UTC midnight,
      // when it is still `day` in UTC-10.
      for (let i = 0; i < 2; i++) {
        const id = nextId();
        await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, `${id}.json`), await shardDoc(I, id, midnight + 10 * HOUR, 2, { day }));
      }
      const before = await I.aggregateStatsShardsV7(await I.readValidStatsShardsV7(), day);
      assert.equal(before.instancesByModel[KEY], 2);
      await I.compactStatsShardsV7(midnight + 30 * HOUR);
      const { rawShards, archive } = await I.readStatsSnapshot();
      const raw = rawShards.filter((shard: any) => !archive.absorbedIds.has(shard.instanceId));
      const after = await I.aggregateStatsWithArchiveV7(raw, archive, [], day);
      assert.deepEqual(after, before, "that process's current-day view is unchanged");
      // Once the day is over everywhere it is archived.
      const later = await I.compactStatsShardsV7(midnight + 36 * HOUR);
      assert.equal(later.absorbed, 2);
    });
  });
});

describe("I: a live process whose own shard was absorbed (PID namespace mismatch)", () => {
  test("it continues under a new id with only what the archive does not have: no double count, no lost usage", async () => {
    await withAgentDir(async () => {
      const loaded = await loadModule("i-live");
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
        sessionManager: { getSessionId: () => "issue-28-review4-i" },
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

      // Another process (in another PID namespace) saw it idle for a day and
      // absorbed it: the archive now counts that version; the file is gone.
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

      await handlers.get("message_end")!(message, context);
      await handlers.get("tool_execution_end")!({ toolCallId: "t1" }, context);
      await I.statsRefreshSettled();
      assert.match(statuses.at(-1) ?? "", /0\/2/, "two requests in total, the absorbed one counted once");
      await handlers.get("session_shutdown")!({}, context);
      const files = await readdir(I.SHARD_FILES_DIR);
      assert.equal(files.length, 1);
      assert.notEqual(files[0], name, "it moved to a new id");
      const rest = JSON.parse(await readFile(join(I.SHARD_FILES_DIR, files[0]!), "utf8"));
      assert.equal(rest.models[KEY].stats.totalRequests, 1, "only the usage the archive does not hold");
      const fresh = await load("i-live-reader");
      assert.equal((await fresh.aggregateStatsWithArchiveV7(await fresh.readValidStatsShardsV7(), await fresh.readStatsArchiveView(), [], null)).bySession[persisted.sessionHash][KEY].totalRequests, 2);
    });
  });
});

describe("2.9.1 #8 / M12: the maintenance heartbeat is wired", () => {
  test("a long maintenance pass keeps refreshing the lock", async () => {
    await withAgentDir(async () => {
      const I = await load("m12");
      const lockPath = join(I.SHARD_FILES_DIR, "..", "maintenance", "cleanup.lock");
      let ageDuringPass: number | undefined;
      let once = true;
      I.setStatsArchiveTestHooks({
        heartbeatMs: 20,
        afterList: async () => {
          if (!once) return;
          once = false;
          const old = new Date(Date.now() - 2 * HOUR);
          await utimes(lockPath, old, old);
          await new Promise((resolve) => setTimeout(resolve, 200));
          ageDuringPass = Date.now() - (await stat(lockPath)).mtimeMs;
        },
      });
      await I.maybeRunStatsMaintenance();
      assert.ok(ageDuringPass !== undefined && ageDuringPass < HOUR, `lock age during the pass: ${ageDuringPass}`);
    });
  });
});
