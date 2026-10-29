import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

// Regressions from the third (adversarial) review of the issue #28 archive:
// the 2.9.0 -> generation migration.

const DAY = 24 * 3600_000;
const KEY = "proxy/gpt-5.5";

function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function withAgentDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-issue-28-review3-"));
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

/** A separately loaded module instance: its own caches, like another Pi process. */
async function load(label: string): Promise<any> {
  const jiti = createJiti(join(process.cwd(), "tests", `issue-28-review3-${label}.ts`), { interopDefault: false, moduleCache: false });
  return (await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"))).__internals_for_tests as any;
}

/** A 2.9.0-format archive.json with one bucket of `requests` requests. */
async function legacyArchive(I: any, at: number, requests: number): Promise<string> {
  const day = localDay(at);
  return JSON.stringify({
    version: 1, kind: "pi-cache-optimizer-archive", updatedAt: at, absorbed: {},
    buckets: [{
      globalEpoch: await I.readGlobalStatsEpoch(), sessionHash: "s", modelKey: KEY, modelEpoch: await I.readModelStatsEpoch(KEY),
      day, provider: "proxy", modelId: "gpt-5.5", updatedAt: at,
      stats: { day, totalRequests: requests, hitRequests: requests, cachedInputTokens: 10 * requests, cacheWriteInputTokens: 0, totalInputTokens: 20 * requests },
    }],
    routed: [],
  }) + "\n";
}

async function archivedRequests(I: any): Promise<number | undefined> {
  const view = await I.readStatsArchiveView();
  return (await I.aggregateStatsWithArchiveV7([], view, [], null)).bySession.s?.[KEY]?.totalRequests;
}

describe("issue #28 archive: 2.9.0 migration (third review)", () => {
  test("migration re-reads 2.9.0's archive.json even when its cached identity still matches", async () => {
    await withAgentDir(async () => {
      const I = await load("legacy-cache");
      const now = Date.now();
      await mkdir(join(I.SHARD_ARCHIVE_PATH, ".."), { recursive: true });
      // Fixed whole-second mtime so an in-place rewrite can restore it exactly.
      const stamp = Math.floor((now - DAY) / 1000);
      await writeFile(I.SHARD_ARCHIVE_PATH, await legacyArchive(I, now - 3 * DAY, 3));
      await utimes(I.SHARD_ARCHIVE_PATH, stamp, stamp);
      assert.equal(await archivedRequests(I), 3, "a refresh caches the parsed archive.json");

      // 2.9.0 republishes in place: same inode and size, and an mtime that a
      // coarse filesystem (FAT/SMB, 2 s) or a fast rewrite cannot tell apart.
      // Windows also reports ino 0 on such filesystems.
      await writeFile(I.SHARD_ARCHIVE_PATH, await legacyArchive(I, now - 3 * DAY, 4));
      await utimes(I.SHARD_ARCHIVE_PATH, stamp, stamp);

      const migrated = await I.compactStatsShardsV7(now);
      assert.equal(migrated.generation, 1);
      assert.equal(await archivedRequests(await load("legacy-cache-reader")), 4, "the generation is built from the file on disk, not a stale parse");
    });
  });

  test("a 2.9.0 archive.json with nothing new to absorb is still migrated, and the migrated file is removed silently", async () => {
    await withAgentDir(async () => {
      const I = await load("legacy-idle");
      const now = Date.now();
      await mkdir(join(I.SHARD_ARCHIVE_PATH, ".."), { recursive: true });
      await writeFile(I.SHARD_ARCHIVE_PATH, await legacyArchive(I, now - 3 * DAY, 5));
      const warnings: unknown[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args); };
      let result: any;
      try {
        result = await I.compactStatsShardsV7(now);
      } finally {
        console.warn = warn;
      }
      assert.equal(result.absorbed, 0);
      assert.equal(result.generation, 1, "published only to lock 2.9.0 out");
      assert.deepEqual(await I.listStatsArchiveGenerations(), [1]);
      assert.equal((await lstat(I.SHARD_ARCHIVE_PATH)).isDirectory(), true);
      assert.deepEqual(warnings, [], "the file it was migrated from is not reported as a foreign write");
      const names = await readdir(join(I.SHARD_ARCHIVE_PATH, ".."));
      assert.ok(!names.some((name) => name.startsWith("archive.legacy-") || name.endsWith(".tmp")), names.join(", "));
      assert.equal(await archivedRequests(await load("legacy-idle-reader")), 5);
    });
  });
});
