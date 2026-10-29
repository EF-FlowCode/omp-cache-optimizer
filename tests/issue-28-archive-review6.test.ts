import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

// Regressions for the low findings R5-R9 of the 2.9.2 review of the issue
// #28 archive. Faults are injected through test hooks, not file modes, so
// every test also runs as root.

const DAY = 24 * 3600_000;
const HOUR = 3600_000;
const KEY = "proxy/gpt-5.5";

function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function withAgentDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-issue-28-review6-"));
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
  const jiti = createJiti(join(process.cwd(), "tests", `issue-28-review6-${label}.ts`), { interopDefault: false, moduleCache: false });
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

async function writeClosedShard(I: any, at: number, requests: number): Promise<string> {
  const id = nextId();
  const day = localDay(at);
  await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, `${id}.json`), {
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
  });
  return id;
}

/** 2.9.0's archive.json document. */
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

/** refreshShardAggregate's read (directory first, then archive), as a session total. */
async function sessionRequests(I: any): Promise<number | undefined> {
  const { rawShards, archive } = await I.readStatsSnapshot();
  const raw = rawShards.filter((shard: any) => !archive.absorbedIds.has(shard.instanceId));
  return (await I.aggregateStatsWithArchiveV7(raw, archive, [], null)).bySession.s?.[KEY]?.totalRequests;
}

const archiveDir = (I: any) => join(I.SHARD_ARCHIVE_PATH, "..");
const errno = (code: string) => Object.assign(new Error(`${code}: injected`), { code });
const placeholdersIn = async (I: any) => (await readdir(archiveDir(I))).filter((name) => name.startsWith("archive.migrating-")).sort();

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

describe("R5: several migration placeholders", () => {
  test("readers and the next compaction use the newest placeholder, not the last uuid", async () => {
    await withAgentDir(async () => {
      const I = await load("r5");
      const now = Date.now();
      await mkdir(I.SHARD_ARCHIVE_PATH, { recursive: true }); // tombstone: a migration was interrupted
      // 2.9.2 names (uuid only). The older one sorts last by name.
      const older = join(archiveDir(I), "archive.migrating-ffffffff-ffff-4fff-8fff-ffffffffffff.json");
      const newer = join(archiveDir(I), "archive.migrating-00000000-0000-4000-8000-000000000000.json");
      await writeFile(older, await legacyArchive(I, now - 6 * DAY, 3));
      await writeFile(newer, await legacyArchive(I, now - 5 * DAY, 7));
      await utimes(older, new Date(now - 2 * HOUR), new Date(now - 2 * HOUR));
      await utimes(newer, new Date(now - HOUR), new Date(now - HOUR));
      await writeClosedShard(I, now - 4 * DAY, 1);

      const reader = await load("r5-reader");
      assert.equal(await sessionRequests(reader), 8, "the newest placeholder (7) plus the raw shard");
      const { value } = await quietly(() => reader.compactStatsShardsV7(now));
      assert.equal(value.generation, 1);
      assert.equal(await sessionRequests(await load("r5-reader-2")), 8, "migrated from the newest placeholder");
      assert.deepEqual(await placeholdersIn(I), [], "the older one is set aside, not left as a placeholder");
    });
  });

  test("a placeholder this version creates carries the time it was moved aside (newest also sorts last for 2.9.2)", async () => {
    await withAgentDir(async () => {
      const I = await load("r5-name");
      const now = Date.now();
      await mkdir(archiveDir(I), { recursive: true });
      await writeFile(I.SHARD_ARCHIVE_PATH, await legacyArchive(I, now - 5 * DAY, 4));
      const before = Date.now();
      I.setStatsArchiveTestHooks({ link: async () => { throw errno("EIO"); } }); // dies right before linking
      await assert.rejects(I.compactStatsShardsV7(now), /EIO/);
      I.setStatsArchiveTestHooks(undefined);
      const [name, ...rest] = await placeholdersIn(I);
      assert.equal(rest.length, 0);
      const match = /^archive\.migrating-(\d{13})-[0-9a-f-]+\.json$/.exec(name!);
      assert.ok(match, name);
      assert.ok(Number(match![1]) >= before && Number(match![1]) <= Date.now());
    });
  });
});

describe("R6: undoing a move aside never overwrites a newer archive.json", () => {
  test("a 2.9.0 write landing between removing the tombstone and restoring the placeholder is kept", async () => {
    await withAgentDir(async () => {
      const I = await load("r6");
      const now = Date.now();
      await mkdir(archiveDir(I), { recursive: true });
      await writeFile(I.SHARD_ARCHIVE_PATH, await legacyArchive(I, now - 5 * DAY, 4));
      const republished = await legacyArchive(I, now - 5 * DAY, 6); // 2.9.0 republishes after this pass read
      const later = await legacyArchive(I, now - 5 * DAY, 9); // and once more during the undo
      let undoSteps = 0;
      I.setStatsArchiveTestHooks({
        afterMigrationStep: async (step: string) => {
          if (step !== "undo-removed-tombstone") return;
          undoSteps++;
          await writeFile(`${I.SHARD_ARCHIVE_PATH}.w.tmp`, later);
          await rename(`${I.SHARD_ARCHIVE_PATH}.w.tmp`, I.SHARD_ARCHIVE_PATH);
        },
      });
      const result = await I.compactStatsShardsV7(now, I.SHARD_FILES_DIR, I.SHARD_ARCHIVE_PATH, {
        beforeCommit: async () => { await writeFile(I.SHARD_ARCHIVE_PATH, republished); },
      });
      I.setStatsArchiveTestHooks(undefined);
      assert.equal(undoSteps, 1);
      assert.equal(result.skippedConcurrent, true);
      assert.equal(await readFile(I.SHARD_ARCHIVE_PATH, "utf8"), later, "2.9.0's newest archive.json is not overwritten");
      const [kept] = await placeholdersIn(I);
      assert.ok(kept, "the moved-aside file is kept for inspection");
      assert.equal(await readFile(join(archiveDir(I), kept!), "utf8"), republished);

      const { value } = await quietly(() => (async () => I.compactStatsShardsV7(now))());
      assert.equal(value.generation, 1);
      assert.equal(await sessionRequests(await load("r6-reader")), 9, "the next pass migrates the newest file, nothing twice");
    });
  });

  test("without a concurrent write the undo restores the moved file and leaves no placeholder", async () => {
    await withAgentDir(async () => {
      const I = await load("r6-plain");
      const now = Date.now();
      await mkdir(archiveDir(I), { recursive: true });
      await writeFile(I.SHARD_ARCHIVE_PATH, await legacyArchive(I, now - 5 * DAY, 4));
      const republished = await legacyArchive(I, now - 5 * DAY, 6);
      const result = await I.compactStatsShardsV7(now, I.SHARD_FILES_DIR, I.SHARD_ARCHIVE_PATH, {
        beforeCommit: async () => { await writeFile(I.SHARD_ARCHIVE_PATH, republished); },
      });
      assert.equal(result.skippedConcurrent, true);
      assert.equal((await lstat(I.SHARD_ARCHIVE_PATH)).isFile(), true);
      assert.equal(await readFile(I.SHARD_ARCHIVE_PATH, "utf8"), republished);
      assert.deepEqual(await placeholdersIn(I), []);
      assert.equal((await I.compactStatsShardsV7(now)).generation, 1);
      assert.equal(await sessionRequests(await load("r6-plain-reader")), 6);
    });
  });
});

describe("R7: an awaited retry holds the process open", () => {
  // OMP's print mode exits by letting the event loop drain (main() is not
  // awaited). An unref'd retry delay inside an awaited handler lets the
  // process exit mid-handler: session_shutdown never runs and the last usage
  // is lost (2.9.3 review). The delays must stay ref'd.
  async function captureTimers(run: () => Promise<unknown>): Promise<Array<{ hasRef(): boolean }>> {
    const timers: Array<{ hasRef(): boolean }> = [];
    const original = globalThis.setTimeout;
    (globalThis as any).setTimeout = (...args: Parameters<typeof setTimeout>) => {
      const timer = original(...args);
      timers.push(timer);
      return timer;
    };
    try {
      await run();
    } finally {
      globalThis.setTimeout = original;
    }
    return timers;
  }

  test("renameWithRetry's backoff timers keep the event loop alive", async () => {
    await withAgentDir(async (dir) => {
      const I = await load("r7-rename");
      await writeFile(join(dir, "a"), "x");
      let failures = 0;
      I.setStatsFsTestHooks({ beforeRename: async () => { if (failures < 3) { failures++; throw errno("EBUSY"); } } });
      const timers = await captureTimers(() => I.renameWithRetry(join(dir, "a"), join(dir, "b")));
      I.setStatsFsTestHooks(undefined);
      assert.equal(failures, 3);
      assert.ok(timers.length >= 3);
      assert.deepEqual(timers.map((timer) => timer.hasRef()), timers.map(() => true));
      assert.equal(await readFile(join(dir, "b"), "utf8"), "x");
    });
  });

  test("the footer's transient archive read retry timers keep the event loop alive", async () => {
    await withAgentDir(async () => {
      const I = await load("r7-read");
      const now = Date.now();
      await writeClosedShard(I, now - 5 * DAY, 2);
      await I.compactStatsShardsV7(now);
      const reader = await load("r7-read-reader");
      let failures = 0;
      reader.setStatsArchiveTestHooks({ beforeReadFile: async () => { if (failures < 2) { failures++; throw errno("EBUSY"); } } });
      let read: any;
      const timers = await captureTimers(async () => { read = await reader.readStatsArchiveDetailed(); });
      reader.setStatsArchiveTestHooks(undefined);
      assert.equal(failures, 2);
      assert.equal(read.stale, false);
      assert.ok(timers.length >= 2);
      assert.deepEqual(timers.map((timer) => timer.hasRef()), timers.map(() => true));
    });
  });

  test("print mode: a transient archive read retry in agent_end does not end the process before session_shutdown", async () => {
    await withAgentDir(async (dir) => {
      const script = `
        const loaded = await import(${JSON.stringify(join(process.cwd(), "index.ts"))});
        const extension = typeof loaded.default === "function" ? loaded.default : loaded.default.default;
        const I = loaded.__internals_for_tests ?? loaded.default.__internals_for_tests;
        const { writeFileSync, readdirSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const at = Date.now() - 5 * 86400000;
        const date = new Date(at);
        const day = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
        const old = "00000001-0000-4000-8000-000000000001";
        await I.writeStatsShardV7(join(I.SHARD_FILES_DIR, old + ".json"), {
          version: 7, kind: "pi-cache-optimizer-shard", instanceId: old, sessionHash: "s",
          process: { pid: 1, ppid: 0, instanceStartedAt: 1 },
          lifecycle: { state: "closed", createdAt: at, updatedAt: at, closedAt: at },
          day, globalEpoch: await I.readGlobalStatsEpoch(),
          models: { "${KEY}": { modelEpoch: await I.readModelStatsEpoch("${KEY}"), provider: "proxy", modelId: "gpt-5.5",
            stats: { day, totalRequests: 2, hitRequests: 2, cachedInputTokens: 20, cacheWriteInputTokens: 0, totalInputTokens: 40 } } },
        });
        await I.compactStatsShardsV7(Date.now());
        const handlers = new Map();
        extension({ on(name, handler) { handlers.set(name, handler); }, registerCommand() {} });
        const context = {
          model: {
            provider: "proxy", id: "gpt-5.5", name: "GPT-5.5", api: "openai-completions",
            baseUrl: "https://api.openai.com/v1", compat: {}, reasoning: false, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192,
          },
          mode: "json", hasUI: false,
          sessionManager: { getSessionId: () => "issue-28-review6-r7-settled" },
          modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
          ui: { notify() {}, setStatus() {} },
        };
        await handlers.get("session_start")({ reason: "startup" }, context);
        await I.waitForStatsRestore();
        await handlers.get("message_end")({ message: { role: "assistant", provider: "proxy", model: "gpt-5.5", api: "openai-completions", stopReason: "stop", usage: { input: 100, cacheRead: 0, cacheWrite: 0 } } }, context);
        let failures = 0;
        // 2.10: agent_end's refresh runs in the background, and an
        // unchanged clean generation is confirmed by its listing alone (no
        // lstat), so the fault is injected at the listing. The retry must
        // still finish (its timers keep the process alive) and
        // session_shutdown must drain it before flushing.
        I.setStatsArchiveTestHooks({ afterList: async () => { if (failures < 2) { failures++; throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); } } });
        await handlers.get("agent_end")({}, context);
        await handlers.get("session_shutdown")({ reason: "quit" }, context);
        I.setStatsArchiveTestHooks(undefined);
        const [name] = readdirSync(I.SHARD_FILES_DIR).filter((file) => file.endsWith(".json"));
        const shard = JSON.parse(readFileSync(join(I.SHARD_FILES_DIR, name), "utf8"));
        writeFileSync(${JSON.stringify(join(dir, "flushed"))}, JSON.stringify({ failures, state: shard.lifecycle.state, requests: shard.models["${KEY}"]?.stats.totalRequests }));
      `;
      const child = spawn(process.execPath, ["--import", "jiti/register", "--input-type=module", "-e", script], {
        cwd: process.cwd(), stdio: "ignore", env: { ...process.env, PI_CODING_AGENT_DIR: dir },
      });
      const exit = await new Promise<number | null | "killed">((resolve) => {
        const kill = setTimeout(() => { child.kill("SIGKILL"); resolve("killed"); }, 30_000);
        child.on("exit", (code) => { clearTimeout(kill); resolve(code); });
      });
      const flushed = await readFile(join(dir, "flushed"), "utf8").then((text) => JSON.parse(text), () => undefined);
      assert.deepEqual(flushed, { failures: 2, state: "closed", requests: 1 }, "agent_end finished and session_shutdown flushed");
      assert.equal(exit, 0, "no unsettled top-level await (exit 13)");
    });
  });
});

describe("R7: the shutdown flush is not abandoned", () => {
  test("OMP's print mode (exit by draining the event loop) still completes a final flush whose rename is being retried", async () => {
    await withAgentDir(async (dir) => {
      const script = `
        const loaded = await import(${JSON.stringify(join(process.cwd(), "index.ts"))});
        const extension = typeof loaded.default === "function" ? loaded.default : loaded.default.default;
        const I = loaded.__internals_for_tests ?? loaded.default.__internals_for_tests;
        const { writeFileSync, readdirSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const handlers = new Map();
        extension({ on(name, handler) { handlers.set(name, handler); }, registerCommand() {} });
        const context = {
          model: {
            provider: "proxy", id: "gpt-5.5", name: "GPT-5.5", api: "openai-completions",
            baseUrl: "https://api.openai.com/v1", compat: {}, reasoning: false, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192,
          },
          mode: "json", hasUI: false,
          sessionManager: { getSessionId: () => "issue-28-review6-r7-shutdown" },
          modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
          ui: { notify() {}, setStatus() {} },
        };
        await handlers.get("session_start")({ reason: "startup" }, context);
        await I.waitForStatsRestore();
        await handlers.get("message_end")({ message: { role: "assistant", provider: "proxy", model: "gpt-5.5", api: "openai-completions", stopReason: "stop", usage: { input: 100, cacheRead: 0, cacheWrite: 0 } } }, context);
        let failures = 0;
        I.setStatsFsTestHooks({ beforeRename: async (_from, to) => {
          if (to.startsWith(I.SHARD_FILES_DIR) && failures < 3) { failures++; throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }
        } });
        await handlers.get("session_shutdown")({ reason: "quit" }, context);
        const [name] = readdirSync(I.SHARD_FILES_DIR).filter((file) => file.endsWith(".json"));
        const shard = JSON.parse(readFileSync(join(I.SHARD_FILES_DIR, name), "utf8"));
        writeFileSync(${JSON.stringify(join(dir, "flushed"))}, JSON.stringify({ failures, state: shard.lifecycle.state, requests: shard.models["${KEY}"]?.stats.totalRequests }));
      `;
      const child = spawn(process.execPath, ["--import", "jiti/register", "--input-type=module", "-e", script], {
        cwd: process.cwd(), stdio: "ignore", env: { ...process.env, PI_CODING_AGENT_DIR: dir },
      });
      const exit = await new Promise<number | null | "killed">((resolve) => {
        const kill = setTimeout(() => { child.kill("SIGKILL"); resolve("killed"); }, 30_000);
        child.on("exit", (code) => { clearTimeout(kill); resolve(code); });
      });
      const flushed = await readFile(join(dir, "flushed"), "utf8").then((text) => JSON.parse(text), () => undefined);
      assert.deepEqual(flushed, { failures: 3, state: "closed", requests: 1 }, "the final flush completed");
      assert.equal(exit, 0);
    });
  });
});

describe("R8: I rebase across a session_start", () => {
  // "new": another session (another sessionHash). "reload": the same session
  // (same sessionHash) but cleared counters, which a sessionHash comparison
  // alone would get wrong.
  for (const reason of ["new", "reload"] as const) test(`a version absorbed from before a session_start (${reason}) is not subtracted from the counters that followed it`, async () => {
    await withAgentDir(async () => {
      const loaded = await loadModule(`r8-${reason}`);
      const I = loaded.__internals_for_tests as any;
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      loaded.default({ on(name: string, handler: any) { handlers.set(name, handler); }, registerCommand() {} } as any);
      const statuses: Array<string | undefined> = [];
      const contextFor = (session: string) => ({
        model: {
          provider: "proxy", id: "gpt-5.5", name: "GPT-5.5", api: "openai-completions",
          baseUrl: "https://api.openai.com/v1", compat: {}, reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192,
        },
        mode: "json", hasUI: false,
        sessionManager: { getSessionId: () => session },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: { notify() {}, setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
      });
      const first = contextFor("issue-28-review6-r8-a");
      const second = reason === "new" ? contextFor("issue-28-review6-r8-b") : first;
      const message = { message: { role: "assistant", provider: "proxy", model: "gpt-5.5", api: "openai-completions", stopReason: "stop", usage: { input: 100, cacheRead: 0, cacheWrite: 0 } } };
      await handlers.get("session_start")!({ reason: "startup" }, first);
      await I.waitForStatsRestore();
      await handlers.get("message_end")!(message, first);
      await new Promise((resolve) => setTimeout(resolve, 2_600)); // the debounced persist
      const [name] = await readdir(I.SHARD_FILES_DIR);
      const persisted = JSON.parse(await readFile(join(I.SHARD_FILES_DIR, name!), "utf8"));
      assert.equal(persisted.models[KEY].stats.totalRequests, 1);

      // A new session in the same process (same id, counters cleared), its
      // first persist a day later (the clock is shifted; the local day, read
      // from new Date(), is not, so no rollover gives it a new id).
      const realNow = Date.now;
      Date.now = () => realNow() + DAY + 2 * HOUR;
      try {
        await handlers.get("session_start")!({ reason }, second);
        await I.waitForStatsRestore();
      } finally {
        Date.now = realNow;
      }
      // Meanwhile another process absorbed the first session's version.
      const absorbedAt = persisted.lifecycle.updatedAt + DAY + HOUR;
      const archive = {
        version: 1, kind: "pi-cache-optimizer-archive", updatedAt: absorbedAt,
        absorbed: { [persisted.instanceId]: absorbedAt },
        buckets: [{
          globalEpoch: persisted.globalEpoch, sessionHash: persisted.sessionHash, modelKey: KEY, modelEpoch: persisted.models[KEY].modelEpoch,
          day: persisted.day, provider: "proxy", modelId: "gpt-5.5", updatedAt: persisted.lifecycle.updatedAt, stats: persisted.models[KEY].stats,
        }],
        routed: [],
      };
      const generation = ((await I.listStatsArchiveGenerations()).at(-1) ?? 0) + 1;
      await mkdir(archiveDir(I), { recursive: true });
      await writeFile(I.statsArchiveGenerationPath(I.SHARD_ARCHIVE_PATH, generation), JSON.stringify(I.encodeStatsArchiveV2(archive, generation)) + "\n");
      await unlink(join(I.SHARD_FILES_DIR, name!)).catch(() => undefined);

      await handlers.get("message_end")!(message, second);
      await handlers.get("tool_execution_end")!({ toolCallId: "t1" }, second);
      await I.statsRefreshSettled();
      // The session footer: after a reload the archived request is this
      // session's too (same sessionHash), so it shows both.
      const expected = reason === "new" ? /0\/1\b/ : /0\/2\b/;
      assert.match(statuses.at(-1) ?? "", expected, "the request after the session_start is visible");
      await handlers.get("session_shutdown")!({}, second);
      const files = await readdir(I.SHARD_FILES_DIR);
      assert.equal(files.length, 1);
      assert.notEqual(files[0], name);
      const rest = JSON.parse(await readFile(join(I.SHARD_FILES_DIR, files[0]!), "utf8"));
      assert.equal(rest.models[KEY].stats.totalRequests, 1, "the new session's request is kept, not subtracted");
    });
  });
});

describe("R8: the session guard keeps the no-double-count fallback", () => {
  // When the absorbed version cannot be identified (clock skew: no persisted
  // version is a day older than the absorption), the archive is assumed to
  // hold everything. That fallback version is built on the spot and must
  // count as built from the current counters, or the guard would subtract
  // nothing and count the usage twice (2.9.3 review).
  test("an unidentifiable absorbed version still subtracts all current counters", async () => {
    await withAgentDir(async () => {
      const loaded = await loadModule("r8-fallback");
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
        sessionManager: { getSessionId: () => "issue-28-review6-r8-fallback" },
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

      // Absorbed by a process whose clock is behind: only an hour after the
      // version it read, so no persisted version qualifies.
      const absorbedAt = persisted.lifecycle.updatedAt + HOUR;
      const archive = {
        version: 1, kind: "pi-cache-optimizer-archive", updatedAt: absorbedAt,
        absorbed: { [persisted.instanceId]: absorbedAt },
        buckets: [{
          globalEpoch: persisted.globalEpoch, sessionHash: persisted.sessionHash, modelKey: KEY, modelEpoch: persisted.models[KEY].modelEpoch,
          day: persisted.day, provider: "proxy", modelId: "gpt-5.5", updatedAt: persisted.lifecycle.updatedAt, stats: persisted.models[KEY].stats,
        }],
        routed: [],
      };
      const generation = ((await I.listStatsArchiveGenerations()).at(-1) ?? 0) + 1;
      await mkdir(archiveDir(I), { recursive: true });
      await writeFile(I.statsArchiveGenerationPath(I.SHARD_ARCHIVE_PATH, generation), JSON.stringify(I.encodeStatsArchiveV2(archive, generation)) + "\n");
      await unlink(join(I.SHARD_FILES_DIR, name!)).catch(() => undefined);

      // A refresh notices the absorption (counters: the 1 absorbed request).
      await handlers.get("tool_execution_end")!({ toolCallId: "t0" }, context);
      await I.statsRefreshSettled();
      assert.match(statuses.at(-1) ?? "", /0\/1\b/, "the absorbed request is counted once");
      await handlers.get("message_end")!(message, context);
      await handlers.get("tool_execution_end")!({ toolCallId: "t1" }, context);
      await I.statsRefreshSettled();
      assert.match(statuses.at(-1) ?? "", /0\/2\b/, "archived 1 + new 1, the archived request not counted twice");
      await handlers.get("session_shutdown")!({}, context);
      const files = await readdir(I.SHARD_FILES_DIR);
      assert.equal(files.length, 1);
      assert.notEqual(files[0], name);
      const rest = JSON.parse(await readFile(join(I.SHARD_FILES_DIR, files[0]!), "utf8"));
      assert.equal(rest.models[KEY].stats.totalRequests, 1, "only the request after the absorption");
    });
  });
});

describe("R9: #4 move aside racing a 2.9.0 publish before the tombstone", () => {
  test("a 2.9.0 archive.json written between the move and the mkdir is kept as the archive and migrated next, not set aside", async () => {
    await withAgentDir(async () => {
      const I = await load("r9");
      const now = Date.now();
      await mkdir(archiveDir(I), { recursive: true });
      await writeFile(I.SHARD_ARCHIVE_PATH, await legacyArchive(I, now - 5 * DAY, 4));
      await writeClosedShard(I, now - 4 * DAY, 1);
      // 2.9.0 (after a stale lock takeover) started over and absorbed (and
      // deleted) raw shards worth 5 requests: its file replaces the one
      // moved aside.
      const landed = await legacyArchive(I, now - 5 * DAY, 5);
      I.setStatsArchiveTestHooks({
        afterMigrationStep: async (step: string) => {
          if (step === "moved-aside") await writeFile(I.SHARD_ARCHIVE_PATH, landed);
        },
      });
      const result = await I.compactStatsShardsV7(now);
      I.setStatsArchiveTestHooks(undefined);
      assert.equal(result.skippedConcurrent, true);
      assert.equal(result.generation, undefined);
      assert.deepEqual(await I.listStatsArchiveGenerations(), []);
      assert.equal(await readFile(I.SHARD_ARCHIVE_PATH, "utf8"), landed);
      assert.equal((await placeholdersIn(I)).length, 1, "the moved file is kept for inspection");
      assert.equal(await sessionRequests(await load("r9-reader")), 6, "2.9.0's file plus the raw shard");

      const { value } = await quietly(() => I.compactStatsShardsV7(now));
      assert.equal(value.generation, 1);
      assert.equal((await lstat(I.SHARD_ARCHIVE_PATH)).isDirectory(), true);
      assert.deepEqual(await placeholdersIn(I), []);
      assert.equal(await sessionRequests(await load("r9-reader-2")), 6, "migrated from 2.9.0's newest file, nothing lost or twice");
    });
  });
});
