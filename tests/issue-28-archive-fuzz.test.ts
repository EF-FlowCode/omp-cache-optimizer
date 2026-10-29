import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

// Issue #28 phase 2, adversarial review: a randomized multi-process model of
// shard writers, day rollovers, crashes, resets, compaction and readers.
//
// Each simulated Pi process is backed by a real child process (so its pid is
// alive while it runs and dead after it "crashes"), and the processes share
// a few independently loaded module instances (jiti moduleCache: false), so
// parsed-shard and archive caches are per "process" exactly as in production.
//
// The oracle is the reference aggregation applied to the *logical* state:
// the latest content every instance ever wrote. Compaction must be invisible
// to every view the footer reads, at every quiescent point and for every read
// that races a compaction.

const KEYS = ["proxy/gpt-5.5", "anthropic/claude-opus-5", "deepseek/deepseek-v4"];
const SESSIONS = ["s-a", "s-b", "s-c", "s-d"];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function localDay(ms: number): string {
  const date = new RealDate(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const RealDate = Date;
let fakeNow = RealDate.now();
/** Global fake clock: currentLocalDay() and Date.now() in every module instance read it. */
function installFakeClock(): () => void {
  class FakeDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(fakeNow);
      else super(...(args as [any]));
    }
    static now(): number { return fakeNow; }
  }
  (globalThis as any).Date = FakeDate;
  return () => { (globalThis as any).Date = RealDate; };
}

type Sim = {
  I: any;
  child: ChildProcess;
  pid: number;
  id: string;
  session: string;
  day: string;
  createdAt: number;
  startedAt: number;
  globalEpoch: string;
  models: Record<string, any>;
  routed?: { provider: string; id: string; name: string };
};

async function spawnSleeper(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1e9)"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("spawn", () => resolve()); child.once("error", reject); });
  return child;
}

async function killSleeper(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited; // reaped, so kill(pid, 0) reports it dead
}

async function loadInstance(label: string): Promise<any> {
  const jiti = createJiti(join(process.cwd(), "tests", `issue-28-fuzz-${label}.ts`), { interopDefault: false, moduleCache: false });
  const loaded = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
  return loaded.__internals_for_tests as any;
}

type View = { bySession: unknown; lastRouted: unknown; todayTotals: unknown; todayBySession: unknown; todayInstances: unknown; todayRouted: unknown };

async function viewOf(I: any, shards: any[]): Promise<View> {
  const all = await I.aggregateStatsShardsV7(structuredClone(shards), null);
  const today = await I.aggregateStatsShardsV7(structuredClone(shards));
  return {
    bySession: all.bySession,
    lastRouted: all.lastRoutedModelBySession,
    todayTotals: today.totalsByModel,
    todayBySession: today.bySession,
    todayInstances: today.instancesByModel,
    todayRouted: today.lastRoutedModelBySession,
  };
}

/** refreshShardAggregate's disk read: directory first, then the archive, absorbed ids filtered. */
async function readerShards(I: any): Promise<any[]> {
  const raw = await I.readValidStatsShardsV7();
  // Real readers can stall between the two reads (GC, a slow disk, another
  // handler); widen that window so racing compactions land inside it.
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 4));
  const archive = await I.readStatsArchive();
  return [...raw.filter((shard: any) => !archive.absorbedIds.has(shard.instanceId)), ...archive.shards];
}

/**
 * The extension's own refresh path: the same reads, aggregated through the
 * archive view's reduced forms instead of synthetic shards. Must equal the
 * reference view of the same reads.
 */
async function readerViews(I: any, oracle: any): Promise<{ reference: View; reduced: View }> {
  const raw = await I.readValidStatsShardsV7();
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 4));
  const archive = await I.readStatsArchiveView();
  const leading = raw.filter((shard: any) => !archive.absorbedIds.has(shard.instanceId));
  const reference = await viewOf(oracle, [...leading, ...archive.shards]);
  const all = await I.aggregateStatsWithArchiveV7(leading, archive, [], null);
  const today = await I.aggregateStatsWithArchiveV7(leading, archive, []);
  return {
    reference,
    reduced: {
      bySession: all.bySession,
      lastRouted: all.lastRoutedModelBySession,
      todayTotals: today.totalsByModel,
      todayBySession: today.bySession,
      todayInstances: today.instancesByModel,
      todayRouted: today.lastRoutedModelBySession,
    },
  };
}

/**
 * The 2.10 incremental refresh path: a tiered shard index per reader (stat
 * only new, hot and dirty names), the shard phase complete before the
 * archive listing, an unchanged clean generation confirmed by its listing
 * alone, and the previous consistent snapshot reused on a stale read.
 */
type IncrementalReader = { index: any; previous?: any };
const incrementalReaders = new WeakMap<any, IncrementalReader>();
function incrementalReaderOf(I: any): IncrementalReader {
  let reader = incrementalReaders.get(I);
  if (!reader) incrementalReaders.set(I, reader = { index: new I.TieredShardIndex(I.SHARD_FILES_DIR, { freeze: true }) });
  return reader;
}

async function incrementalSnapshot(I: any): Promise<{ leading: any[]; archive: any }> {
  const reader = incrementalReaderOf(I);
  reader.previous = await I.readStatsSnapshot(reader.previous, I.SHARD_FILES_DIR, I.SHARD_ARCHIVE_PATH, {
    reuseArchive: true,
    readShards: async () => {
      const shards = await reader.index.refresh({});
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 4));
      return shards;
    },
  });
  const { rawShards, archive } = reader.previous;
  return { leading: rawShards.filter((shard: any) => !archive.absorbedIds.has(shard.instanceId)), archive };
}

/** The incremental reads, as reference shards and through the synchronous aggregation over pre-read epochs. */
async function incrementalViews(I: any, oracle: any): Promise<{ reference: View; synchronous: View }> {
  const { leading, archive } = await incrementalSnapshot(I);
  const reference = await viewOf(oracle, [...leading, ...archive.shards]);
  const today = localDay(fakeNow);
  const keys = new Set<string>([...I.aggregateEpochKeys(leading, archive, [], null, undefined), ...I.aggregateEpochKeys(leading, archive, [], today, undefined)]);
  const globalEpoch = await I.readGlobalStatsEpoch();
  const modelEpochs = new Map<string, string>();
  for (const key of keys) modelEpochs.set(key, await I.readModelStatsEpoch(key));
  const epochs = { globalEpoch, modelEpoch: (key: string) => { const epoch = modelEpochs.get(key); if (epoch === undefined) throw new Error(`epoch of ${key} not prefetched`); return epoch; } };
  const all = I.aggregateStatsWithArchiveSync(leading, archive, [], null, undefined, epochs);
  const day = I.aggregateStatsWithArchiveSync(leading, archive, [], today, undefined, epochs);
  return {
    reference,
    synchronous: {
      bySession: all.bySession,
      lastRouted: all.lastRoutedModelBySession,
      todayTotals: day.totalsByModel,
      todayBySession: day.bySession,
      todayInstances: day.instancesByModel,
      todayRouted: day.lastRoutedModelBySession,
    },
  };
}

async function runScenario(seed: number, steps: number): Promise<{ compactions: number; absorbed: number }> {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const dir = await mkdtemp(join(tmpdir(), `pi-cache-issue-28-fuzz-${seed}-`));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const restoreClock = installFakeClock();
  // Start well inside the retention window; scenarios span < 30 simulated days.
  fakeNow = RealDate.now() - 25 * DAY;
  const instances = [await loadInstance(`${seed}-a`), await loadInstance(`${seed}-b`), await loadInstance(`${seed}-c`)];
  // One instance publishes as on a filesystem without hard links: exclusive
  // in-place creation, readable only once complete. It must interleave with
  // the hard-link publishers without double counting or losing anything.
  instances[2].setStatsArchiveTestHooks({ link: async () => { throw Object.assign(new Error("EPERM: no hard links"), { code: "EPERM" }); } });
  const oracle = instances[0];
  const logical = new Map<string, any>();
  const running: Sim[] = [];
  const children: ChildProcess[] = [];
  let compactions = 0;
  let absorbedTotal = 0;
  const trace: string[] = [];

  const tick = () => { fakeNow += 1 + Math.floor(random() * 50); };

  async function persist(p: Sim, state: "active" | "closed"): Promise<void> {
    tick();
    const shard = {
      version: 7, kind: "pi-cache-optimizer-shard", instanceId: p.id, sessionHash: p.session,
      process: { pid: p.pid, ppid: 0, instanceStartedAt: p.startedAt },
      lifecycle: { state, createdAt: p.createdAt, updatedAt: fakeNow, ...(state === "closed" ? { closedAt: fakeNow } : {}) },
      day: p.day, globalEpoch: p.globalEpoch, models: structuredClone(p.models),
      ...(p.routed ? { lastRoutedModel: { ...p.routed } } : {}),
    };
    await p.I.writeStatsShardV7(join(p.I.SHARD_FILES_DIR, `${p.id}.json`), shard);
    logical.set(p.id, structuredClone(shard));
  }

  /** What refreshShardAggregate does with another process's reset. */
  async function adoptEpochs(p: Sim): Promise<void> {
    const global = await p.I.readGlobalStatsEpoch();
    if (global !== p.globalEpoch) {
      p.globalEpoch = global;
      p.models = {};
      p.routed = undefined;
      return;
    }
    for (const key of Object.keys(p.models)) {
      if ((await p.I.readModelStatsEpoch(key)) !== p.models[key].modelEpoch) delete p.models[key];
    }
  }

  async function startProcess(): Promise<Sim> {
    const child = await spawnSleeper();
    children.push(child);
    const I = pick(instances);
    const p: Sim = {
      I, child, pid: child.pid!, id: randomUUID(), session: pick(SESSIONS), day: localDay(fakeNow),
      createdAt: fakeNow, startedAt: fakeNow, globalEpoch: await I.readGlobalStatsEpoch(), models: {},
    };
    running.push(p);
    await persist(p, "active");
    return p;
  }

  async function rollOverIfNeeded(p: Sim): Promise<void> {
    const today = localDay(fakeNow);
    if (p.day === today) return;
    await adoptEpochs(p);
    await persist(p, "closed");
    p.id = randomUUID();
    p.day = today;
    p.createdAt = fakeNow;
    p.models = {};
    await persist(p, "active");
  }

  async function usage(p: Sim): Promise<void> {
    await adoptEpochs(p);
    const key = pick(KEYS);
    const [provider, modelId] = key.split("/") as [string, string];
    // Usage recorded before the rollover check lands in the old day's shard
    // with today's stats.day, exactly like message_end before publishStatus.
    const entry = p.models[key] ??= {
      modelEpoch: await p.I.readModelStatsEpoch(key), provider, modelId, modelName: `${modelId} name`,
      stats: p.I.emptyCacheStats(localDay(fakeNow)),
    };
    const input = 100 + Math.floor(random() * 10_000);
    const cached = Math.floor(random() * input);
    entry.stats.totalRequests += 1;
    if (cached > 0) entry.stats.hitRequests += 1;
    entry.stats.cachedInputTokens += cached;
    entry.stats.totalInputTokens += input;
    if (random() < 0.4) p.routed = { provider, id: modelId, name: modelId };
    await rollOverIfNeeded(p);
    await persist(p, "active");
  }

  async function compact(I: any): Promise<void> {
    const token = await I.acquireStatsMaintenanceLock(fakeNow);
    if (!token) return;
    try {
      const result = await I.compactStatsShardsV7(fakeNow, I.SHARD_FILES_DIR, I.SHARD_ARCHIVE_PATH, { lockToken: token });
      compactions++;
      absorbedTotal += result.absorbed;
    } finally {
      await I.releaseStatsMaintenanceLock(token);
    }
  }

  async function check(label: string, I: any = pick(instances)): Promise<void> {
    const expected = await viewOf(oracle, [...logical.values()]);
    const actual = await viewOf(oracle, await readerShards(I));
    assert.deepEqual(actual, expected, `seed ${seed} ${label}\n${trace.slice(-12).join("\n")}`);
    const { reference, reduced } = await readerViews(I, oracle);
    assert.deepEqual(reference, expected, `seed ${seed} ${label} (view reads)`);
    assert.deepEqual(reduced, reference, `seed ${seed} ${label} (reduced view)`);
    const incremental = await incrementalViews(I, oracle);
    assert.deepEqual(incremental.reference, expected, `seed ${seed} ${label} (incremental reads)`);
    assert.deepEqual(incremental.synchronous, expected, `seed ${seed} ${label} (incremental synchronous aggregation)`);
  }

  try {
    for (let i = 0; i < 3; i++) await startProcess();
    for (let step = 0; step < steps; step++) {
      const roll = random();
      if (running.length === 0) await startProcess();
      if (roll < 0.40) {
        const p = pick(running);
        trace.push(`usage ${p.id.slice(0, 8)}`);
        await usage(p);
      } else if (roll < 0.55) {
        const delta = random() < 0.15 ? 20 * HOUR + Math.floor(random() * 20 * HOUR) : MINUTE + Math.floor(random() * 6 * HOUR);
        fakeNow += delta;
        trace.push(`advance ${Math.round(delta / MINUTE)}min -> ${localDay(fakeNow)}`);
      } else if (roll < 0.62) {
        const p = pick(running);
        trace.push(`shutdown ${p.id.slice(0, 8)}`);
        await rollOverIfNeeded(p);
        await adoptEpochs(p);
        await persist(p, "closed");
        running.splice(running.indexOf(p), 1);
        await killSleeper(p.child);
        await startProcess();
      } else if (roll < 0.66) {
        const p = pick(running);
        trace.push(`crash ${p.id.slice(0, 8)}`);
        running.splice(running.indexOf(p), 1);
        await killSleeper(p.child);
        await startProcess();
      } else if (roll < 0.68) {
        const p = pick(running);
        trace.push(`reset-global by ${p.id.slice(0, 8)}`);
        await p.I.advanceGlobalStatsEpoch();
        await adoptEpochs(p);
        await persist(p, "active");
      } else if (roll < 0.71) {
        const p = pick(running);
        const key = pick(KEYS);
        trace.push(`reset-model ${key} by ${p.id.slice(0, 8)}`);
        await p.I.advanceModelStatsEpoch(key);
        await adoptEpochs(p);
        await persist(p, "active");
      } else if (roll < 0.86) {
        // Compaction racing readers in other module instances: the logical
        // state is fixed during the batch, so every read must match.
        trace.push("compact || readers");
        const expected = await viewOf(oracle, [...logical.values()]);
        const views: View[] = [];
        let done = false;
        const compactor = pick(instances);
        const work: Promise<unknown>[] = [compact(compactor)];
        if (random() < 0.3) work.push(compact(pick(instances)));
        if (random() < 0.25) {
          // The first compactor stalls past the stale-lock window (laptop
          // sleep) and a second one takes the lock over mid-pass.
          trace.push("stale-takeover");
          work.push((async () => {
            for (let i = Math.floor(random() * 6); i > 0; i--) await new Promise((resolve) => setImmediate(resolve));
            const old = new RealDate(fakeNow - 2 * HOUR);
            await utimes(join(compactor.SHARD_FILES_DIR, "..", "maintenance", "cleanup.lock"), old, old).catch(() => undefined);
            await compact(pick(instances));
          })());
        }
        const crashAfter = random() < 0.25;
        const finished = Promise.all(work).finally(() => { done = true; });
        // Readers in every module instance loop for as long as compaction runs.
        const readers = instances.map(async (reader) => {
          do {
            views.push(await viewOf(oracle, await readerShards(reader)));
            const { reference, reduced } = await readerViews(reader, oracle);
            views.push(reference, reduced);
            const incremental = await incrementalViews(reader, oracle);
            views.push(incremental.reference, incremental.synchronous);
            await new Promise((resolve) => setImmediate(resolve));
          } while (!done);
        });
        await Promise.all([finished, ...readers]);
        for (const view of views) {
          assert.deepEqual(view, expected, `seed ${seed} racing read at step ${step}\n${trace.slice(-12).join("\n")}`);
        }
        if (crashAfter) {
          // A crash between publishing the archive and deleting the
          // originals: some absorbed raw files are still on disk.
          trace.push("crash-before-unlink");
          const archive = await oracle.readStatsArchive();
          const presentIds = new Set((await oracle.readValidStatsShardsV7()).map((s: any) => s.instanceId));
          for (const [id, shard] of logical) {
            if (random() < 0.5) continue;
            if (archive.absorbedIds.has(id) && !presentIds.has(id)) {
              await oracle.writeStatsShardV7(join(oracle.SHARD_FILES_DIR, `${id}.json`), shard);
            }
          }
          await check(`after crash at step ${step}`);
        }
      } else {
        trace.push("check");
        await check(`step ${step}`);
      }
    }
    await compact(pick(instances));
    await check("final");
    return { compactions, absorbed: absorbedTotal };
  } finally {
    restoreClock();
    await Promise.all(children.map(killSleeper));
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("issue #28 phase 2: randomized multi-process archive model", () => {
  test("compaction never double counts, never loses unreset data, and never changes today's aggregate", async () => {
    let totalAbsorbed = 0;
    for (const seed of (process.env.FUZZ_SEEDS ?? "3,17,2026").split(",").map(Number)) {
      const { compactions, absorbed } = await runScenario(seed, 220);
      assert.ok(compactions > 5, `seed ${seed} exercised compaction`);
      totalAbsorbed += absorbed;
    }
    assert.ok(totalAbsorbed > 10, "the scenarios actually folded shards into the archive");
  });
});
