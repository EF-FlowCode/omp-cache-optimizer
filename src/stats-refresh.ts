/**
 * Incremental footer refresh (2.10): a tiered shard index and a
 * single-flight refresh scheduler.
 *
 * Why: a footer refresh used to lstat every raw shard (about 400 on a busy
 * day) and Pi awaited it on every tool call, message and settle. On Windows
 * (antivirus-scanned AppData) that was ~28 ms per refresh on the critical
 * path of the agent loop.
 *
 * TieredShardIndex
 * - Every refresh lists the directory (creations and deletions are seen at
 *   once) and lstats only new names and the hot set: shards that are active,
 *   were updated within STATS_HOT_WINDOW_MS, are unreadable or not regular
 *   files, or were marked dirty (by the TUI watcher, or by a transient
 *   error). Content is re-read only when the file identity changed.
 * - Since 2.8.20 only a live process rewrites a shard, and only its own.
 *   A closed shard is rewritten only when the same extension instance starts
 *   another session under the same id (Pi keeps the extension across
 *   /new, /resume and fork: session_shutdown closes the shard, session_start
 *   writes it active again). Usually that is within minutes, which the hot
 *   window covers; after a longer idle gap it is a cold shard changing, which
 *   the full scan below bounds. Cold (closed, older) shards are re-checked by a
 *   background full scan at most every STATS_FULL_SCAN_INTERVAL_MS while
 *   refreshes are requested, with at most STATS_FULL_SCAN_CONCURRENCY calls
 *   in flight. The staleness of a cold shard is bounded by that interval
 *   plus the scan time; hot shards and this process's own shard are never
 *   stale.
 * - The output is the valid shards in readdir order, exactly what
 *   readValidStatsShardsV7 returns for the same listing and contents (minus
 *   this process's own name, which callers replace by their in-memory copy).
 *   Aggregation is a full in-memory re-aggregation of these cached inputs,
 *   so the result equals the reference aggregation by construction.
 * - refresh() resolves only after every read of the shard phase completed,
 *   and returns a fresh array of shared, never-mutated shard objects: a
 *   snapshot that later index updates cannot change. Callers list the
 *   archive only afterwards (see readStatsSnapshot).
 * - Compaction, cleanup and the kill switch keep using
 *   readValidStatsShardsV7 (stat every file); they never trust this index.
 *
 * StatsRefreshScheduler
 * - At most one refresh runs; requests made meanwhile share one trailing
 *   run that starts after it, so a caller never gets a result read before
 *   its call. A run must not request a refresh itself (asserted: that would
 *   wait for the trailing run, which waits for the run).
 * - Background requests are refused while the gate is closed (shutdown);
 *   drain() waits for everything in flight.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { type Stats, watch } from "node:fs";
import { getErrorCode } from "./common.ts";
import { statsReadFs } from "./stats-fs.ts";
import {
  type PersistedStatsShardV7,
  type StatsFileIdentity,
  SHARD_FILE_NAME_PATTERN,
  SHARD_IO_CONCURRENCY,
  applyShardStatHook,
  mapWithConcurrency,
  parseShardFileText,
  sameStatsFileIdentity,
  statsFileIdentityOf,
} from "./stats-store.ts";

/** A shard updated this recently (by its lifecycle.updatedAt) is stat-ed on every refresh. */
export const STATS_HOT_WINDOW_MS = 15 * 60 * 1000;
/** Cold shards are re-checked by a background full scan at most this often (while refreshes are requested). */
export const STATS_FULL_SCAN_INTERVAL_MS = 30 * 1000;
/** Calls a background full scan keeps in flight (libuv has 4 threads; leave room for Pi's own I/O). */
export const STATS_FULL_SCAN_CONCURRENCY = 2;

type IndexEntry = {
  /** Undefined for a name that is not a regular file. */
  identity?: StatsFileIdentity;
  /** Valid shard whose instanceId matches the file name. */
  shard?: PersistedStatsShardV7;
  /** Schema-valid parse regardless of the name. */
  parsed?: PersistedStatsShardV7;
};

export type ShardIndexRefreshStats = {
  names: number;
  /** Names lstat-ed in the foreground. */
  statted: number;
  /** Files read and parsed in the foreground. */
  read: number;
  /** Hot names among the statted ones (excluding new names). */
  hot: number;
  full: boolean;
};

export type ShardIndexOptions = {
  hotWindowMs?: number;
  fullScanIntervalMs?: number;
  fullScanConcurrency?: number;
  /** Monotonic clock (ms) for scan scheduling. */
  monotonicNow?: () => number;
  /** Wall clock (ms) compared with lifecycle.updatedAt. */
  wallNow?: () => number;
  /** Deep-freeze cached shards (tests: any mutation throws). */
  freeze?: boolean;
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

type ReadOutcome = "unchanged" | "read" | "removed" | "transient";

export class TieredShardIndex {
  private readonly entries = new Map<string, IndexEntry>();
  private readonly dirty = new Set<string>();
  private lastFullScanAt = -Infinity;
  private scan?: Promise<boolean>;
  private readonly hotWindowMs: number;
  private readonly fullScanIntervalMs: number;
  private readonly fullScanConcurrency: number;
  private readonly monotonicNow: () => number;
  private readonly wallNow: () => number;
  private readonly freeze: boolean;
  /** Last foreground refresh's counters (timing logs and tests). */
  lastRefresh?: ShardIndexRefreshStats;

  constructor(readonly directory: string, options: ShardIndexOptions = {}) {
    this.hotWindowMs = options.hotWindowMs ?? STATS_HOT_WINDOW_MS;
    this.fullScanIntervalMs = options.fullScanIntervalMs ?? STATS_FULL_SCAN_INTERVAL_MS;
    this.fullScanConcurrency = options.fullScanConcurrency ?? STATS_FULL_SCAN_CONCURRENCY;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.freeze = options.freeze ?? false;
  }

  /** A watcher saw `name` change: stat it on the next refresh. */
  markDirty(name: string): void {
    if (SHARD_FILE_NAME_PATTERN.test(name)) this.dirty.add(name);
  }

  /** A watcher lost events (no file name, overflow, error): the next refresh starts a full scan. */
  requestFullScan(): void {
    this.lastFullScanAt = -Infinity;
  }

  get fullScanInFlight(): boolean {
    return this.scan !== undefined;
  }

  /** Resolves when the background scan in flight (if any) finished. */
  async settled(): Promise<void> {
    while (this.scan) await this.scan.catch(() => false);
  }

  private isHot(entry: IndexEntry, now: number): boolean {
    const shard = entry.parsed;
    if (!shard || !entry.identity) return true;
    return shard.lifecycle.state === "active" || now - shard.lifecycle.updatedAt < this.hotWindowMs;
  }

  private async listNames(): Promise<string[]> {
    try {
      return await statsReadFs().readdir(this.directory);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * lstat `name` (and read it if its identity changed). `expected` guards a
   * background scan: its result is applied only while the entry is still
   * the one it started from, so a slow scan never replaces content a newer
   * foreground read stored.
   */
  private async statAndRead(name: string, background: boolean): Promise<ReadOutcome> {
    const path = join(this.directory, name);
    const expected = this.entries.get(name);
    const stale = () => background && this.entries.get(name) !== expected;
    let info: Stats;
    try {
      info = applyShardStatHook(path, await statsReadFs().lstat(path));
    } catch (error) {
      if (stale()) return "unchanged";
      if (getErrorCode(error) === "ENOENT") {
        this.entries.delete(name);
        this.dirty.delete(name);
        return "removed";
      }
      // Transient (Windows EPERM/EBUSY): keep the last known content and retry next refresh.
      this.dirty.add(name);
      return "transient";
    }
    if (stale()) return "unchanged";
    if (!info.isFile() || info.isSymbolicLink()) {
      this.dirty.delete(name);
      // Already known as not a regular file: unchanged (a full scan must not
      // report a change, and trigger another refresh, every time).
      if (expected && !expected.identity) return "unchanged";
      this.entries.set(name, {});
      return "read";
    }
    if (expected?.identity && sameStatsFileIdentity(expected.identity, info)) {
      this.dirty.delete(name);
      return "unchanged";
    }
    let text: string;
    try {
      text = (await statsReadFs().readFile(path)).toString("utf8");
    } catch (error) {
      if (stale()) return "unchanged";
      if (getErrorCode(error) === "ENOENT") {
        this.entries.delete(name);
        this.dirty.delete(name);
        return "removed";
      }
      this.dirty.add(name);
      return "transient";
    }
    if (stale()) return "unchanged";
    let parsed: { shard?: PersistedStatsShardV7; parsed?: PersistedStatsShardV7 };
    try {
      parsed = parseShardFileText(name, text);
    } catch {
      parsed = {};
    }
    if (this.freeze) deepFreeze(parsed.parsed);
    this.entries.set(name, { identity: statsFileIdentityOf(info), shard: parsed.shard, parsed: parsed.parsed });
    this.dirty.delete(name);
    return "read";
  }

  /**
   * The shard phase of a refresh. `own` (this process's shard file name) is
   * never stat-ed or read: callers use their in-memory copy. With `full`,
   * every name is stat-ed (what readValidStatsShardsV7 does): commands,
   * flush and restore use it. Resolves only after every read finished.
   */
  async refresh({ own, full = false }: { own?: string; full?: boolean } = {}): Promise<PersistedStatsShardV7[]> {
    const names = await this.listNames();
    const candidates = names.filter((name) => SHARD_FILE_NAME_PATTERN.test(name) && name !== own);
    const now = this.wallNow();
    let hot = 0;
    const toStat = full ? candidates : candidates.filter((name) => {
      const entry = this.entries.get(name);
      if (!entry || this.dirty.has(name)) return true;
      if (!this.isHot(entry, now)) return false;
      hot++;
      return true;
    });
    let read = 0;
    await mapWithConcurrency(toStat, SHARD_IO_CONCURRENCY, async (name) => {
      if ((await this.statAndRead(name, false)) === "read") read++;
    });
    if (full) this.lastFullScanAt = this.monotonicNow();
    const listed = new Set(candidates);
    for (const name of Array.from(this.entries.keys())) if (!listed.has(name)) this.entries.delete(name);
    for (const name of Array.from(this.dirty)) if (!listed.has(name)) this.dirty.delete(name);
    const shards: PersistedStatsShardV7[] = [];
    for (const name of candidates) {
      const shard = this.entries.get(name)?.shard;
      if (shard) shards.push(shard);
    }
    this.lastRefresh = { names: candidates.length, statted: toStat.length, read, hot, full };
    return this.freeze ? Object.freeze(shards) as PersistedStatsShardV7[] : shards;
  }

  /** Whether a background full scan is due now. */
  fullScanDue(): boolean {
    return this.scan === undefined && this.monotonicNow() - this.lastFullScanAt >= this.fullScanIntervalMs;
  }

  /**
   * Start a background full scan when one is due. Resolves to true when it
   * found a change (callers then refresh again). Never rejects.
   */
  maybeStartFullScan(own: () => string | undefined): Promise<boolean> | undefined {
    if (!this.fullScanDue()) return undefined;
    this.lastFullScanAt = this.monotonicNow();
    const scan = (async (): Promise<boolean> => {
      const names = await this.listNames();
      const ownName = own();
      const candidates = names.filter((name) => SHARD_FILE_NAME_PATTERN.test(name) && name !== ownName);
      let changed = false;
      await mapWithConcurrency(candidates, this.fullScanConcurrency, async (name) => {
        const outcome = await this.statAndRead(name, true);
        if (outcome === "read" || outcome === "removed") changed = true;
      });
      this.lastFullScanAt = this.monotonicNow();
      return changed;
    })().catch(() => false).finally(() => {
      if (this.scan === scan) this.scan = undefined;
    });
    this.scan = scan;
    return scan;
  }

  /**
   * Opt-in field check of the identity cache (OMP_CACHE_OPTIMIZER_STATS_VERIFY):
   * re-read every cached shard whose identity, lstat-ed before and after the
   * read, still equals the cached one, and compare the contents. A
   * difference means the filesystem reports an unchanged identity for
   * changed content (no inode and coarse timestamps: FAT, some SMB servers),
   * which no amount of stat-ing would notice. Files that changed or failed
   * meanwhile are skipped (no verdict), so a racing writer never counts.
   * A mismatched entry keeps its content for output but loses its identity,
   * so the next refresh reads it again. Returns the mismatched names.
   */
  async verifyCachedContents(own?: string): Promise<string[]> {
    const names = (await this.listNames()).filter((name) => SHARD_FILE_NAME_PATTERN.test(name) && name !== own);
    const mismatched: string[] = [];
    await mapWithConcurrency(names, this.fullScanConcurrency, async (name) => {
      const entry = this.entries.get(name);
      if (!entry?.identity) return;
      const path = join(this.directory, name);
      try {
        if (!sameStatsFileIdentity(entry.identity, applyShardStatHook(path, await statsReadFs().lstat(path)))) return;
        const text = (await statsReadFs().readFile(path)).toString("utf8");
        if (!sameStatsFileIdentity(entry.identity, applyShardStatHook(path, await statsReadFs().lstat(path)))) return;
        if (this.entries.get(name) !== entry) return;
        let parsed: PersistedStatsShardV7 | undefined;
        try {
          parsed = parseShardFileText(name, text).parsed;
        } catch {
          parsed = undefined;
        }
        if (JSON.stringify(parsed) === JSON.stringify(entry.parsed)) return;
        mismatched.push(name);
        this.entries.set(name, { shard: entry.shard, parsed: entry.parsed });
      } catch {
        // Gone or transiently unreadable: not a verdict.
      }
    });
    return mismatched;
  }

  /** Test helper: the cached entry names. */
  cachedNames(): string[] {
    return Array.from(this.entries.keys());
  }
}

export class ReentrantStatsRefreshError extends Error {
  constructor() {
    super("a stats refresh requested another refresh from inside its own run (it would wait for itself)");
  }
}

/** Single-flight refresh with one trailing run, a shutdown gate and drain. */
export class StatsRefreshScheduler<T> {
  private running?: Promise<T>;
  private trailing?: { promise: Promise<T>; full: boolean; resolve: (value: T) => void; reject: (error: unknown) => void };
  private closed = false;
  private readonly context = new AsyncLocalStorage<object>();
  private readonly token = {};

  constructor(private readonly run: (full: boolean) => Promise<T>) {}

  /** True while called from inside a run (directly or from work it started). */
  insideRun(): boolean {
    return this.context.getStore() === this.token;
  }

  /** Run `work` outside the run's async context (for background work a run starts). */
  outsideRun<R>(work: () => R): R {
    return this.context.exit(work);
  }

  /**
   * A refresh whose reads all start after this call. Runs now when idle;
   * otherwise joins the single trailing run (`full` if any joiner asked).
   */
  request(full = false): Promise<T> {
    if (this.insideRun()) return Promise.reject(new ReentrantStatsRefreshError());
    if (!this.running) return this.start(full);
    if (this.trailing) {
      this.trailing.full ||= full;
      return this.trailing.promise;
    }
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    this.trailing = { promise, full, resolve, reject };
    return promise;
  }

  /** request() unless the gate is closed (then resolves undefined without refreshing). */
  background(full = false): Promise<T | undefined> {
    return this.closed ? Promise.resolve(undefined) : this.request(full);
  }

  private start(full: boolean): Promise<T> {
    const run = this.context.run(this.token, () => this.run(full));
    this.running = run;
    const settle = () => {
      if (this.running === run) this.running = undefined;
      const next = this.trailing;
      this.trailing = undefined;
      if (next) this.start(next.full).then(next.resolve, next.reject);
    };
    run.then(settle, settle);
    return run;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get idle(): boolean {
    return !this.running && !this.trailing;
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.closed = false;
  }

  /** Wait until no run is in flight or queued (errors are the callers' to handle). */
  async drain(): Promise<void> {
    while (this.running || this.trailing) {
      await (this.trailing?.promise ?? this.running)!.then(() => undefined, () => undefined);
    }
  }
}

/** What a shard directory watcher must provide (the real one wraps fs.watch). */
export type StatsWatchHandle = { close(): void };
export type StatsWatchFactory = (
  directory: string,
  onName: (name: string | null) => void,
  onError: (error: unknown) => void,
) => StatsWatchHandle;

/**
 * The real watcher: fs.watch with an 'error' listener (without one, the
 * EventEmitter throws the error; on Windows deleting the watched directory
 * emits EPERM, which crashed Pi through its uncaughtException handler).
 * unref'd: it never keeps the process alive.
 */
export const createFsShardWatch: StatsWatchFactory = (directory, onName, onError) => {
  const watcher = watch(directory, (_type, filename) => onName(filename == null ? null : String(filename)));
  watcher.on("error", onError);
  watcher.unref?.();
  return watcher;
};

/** Test hooks for the incremental refresh; production never sets them. */
export type StatsRefreshTestHooks = {
  /** Replaces fs.watch for the TUI shard watcher (a fake that tests drive). */
  watch?: StatsWatchFactory;
  /** Deep-freeze every shard the index caches (any mutation then throws). */
  freezeShards?: boolean;
  /** Overrides the full scan interval of indexes created afterwards. */
  fullScanIntervalMs?: number;
  /** Runs inside every refresh after the shard phase, before the archive is listed. */
  afterShardPhase?: () => void | Promise<void>;
  /** Runs inside every refresh after the snapshot, before the epochs are read. */
  beforeEpochRead?: () => void | Promise<void>;
  /** Runs inside every refresh after the epochs were read, right before the synchronous commit. */
  beforeCommit?: () => void | Promise<void>;
  /** Receives every committed (current-day) aggregate, synchronously. */
  afterCommit?: (aggregate: import("./stats-store.ts").ShardAggregate) => void;
};
let statsRefreshTestHooks: StatsRefreshTestHooks = {};
export function setStatsRefreshTestHooks(hooks: StatsRefreshTestHooks | undefined): void {
  statsRefreshTestHooks = hooks ?? {};
}
export function getStatsRefreshTestHooks(): StatsRefreshTestHooks {
  return statsRefreshTestHooks;
}
