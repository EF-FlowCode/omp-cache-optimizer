import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LOG_PREFIX, asRecord, getErrorCode, getNonNegativeNumber, isNonEmptyString, isProcessAlive } from "./common.ts";
import { STATE_DIR } from "./paths.ts";
import { statsReadFs } from "./stats-fs.ts";

export type CacheProviderId = "deepseek" | "openai" | "claude" | "gemini";

/** 1.x 单文件统计（v5），2.0 起改为分片统计后作为过时文件删除。 */
export const STATE_FILE_PATH = join(STATE_DIR, "omp-cache-optimizer-stats.json");

export const LEGACY_STATE_FILE_PATH = join(STATE_DIR, "deepseek-cache-optimizer-stats.json");

/**
 * 分片统计目录。分片/归档文件里的 `kind`（"pi-cache-optimizer-shard" 等）沿用上游
 * 的内部格式标识，便于与上游同步；目录本身是 OMP 专用的，不会与 Pi 混用。
 */
export const SHARD_STATE_DIR = join(STATE_DIR, "omp-cache-optimizer-stats.d");

export const SHARD_FILES_DIR = join(SHARD_STATE_DIR, "shards");

export const SHARD_EPOCH_DIR = join(SHARD_STATE_DIR, "epochs");

export const SHARD_MODEL_EPOCH_DIR = join(SHARD_EPOCH_DIR, "models");

export const SHARD_MAINTENANCE_DIR = join(SHARD_STATE_DIR, "maintenance");

export const SHARD_GLOBAL_EPOCH_PATH = join(SHARD_EPOCH_DIR, "global.json");

export const SHARD_CLEANUP_LOCK_PATH = join(SHARD_MAINTENANCE_DIR, "cleanup.lock");

export const SHARD_CLEANUP_MARKER_PATH = join(SHARD_MAINTENANCE_DIR, "last-cleanup");

// Retain closed and inactive shards for roughly two months so session-scoped
// statistics can survive long-running conversations without meaningful disk use.
export const SHARD_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

export const SHARD_TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;

export const SHARD_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const SHARD_CLEANUP_LOCK_STALE_MS = 60 * 60 * 1000;

export const CACHE_PROVIDER_IDS: CacheProviderId[] = ["deepseek", "openai", "claude", "gemini"];

export type CacheStats = {
  day: string;
  totalRequests: number;
  hitRequests: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalInputTokens: number;
};

/** Per-model-key scoped state. Used in memory and for v3 persistence. */
export type PersistedRoutedModelRef = {
  provider: string;
  id: string;
  name?: string;
};

export type UsageSnapshot = {
  cacheRead: number;
  cacheWrite: number;
  totalInput: number;
};

/**
 * Per-request sample stored for trend analysis and usage-field-missing detection.
 * Contains only numeric counters and booleans — never message content, prompts,
 * payloads, headers, API keys, or model outputs.
 */
export type PersistedStatsShardV7 = {
  version: 7;
  kind: "pi-cache-optimizer-shard";
  instanceId: string;
  sessionHash: string;
  process: {
    pid: number;
    ppid: number;
    instanceStartedAt: number;
  };
  lifecycle: {
    state: "active" | "closed";
    createdAt: number;
    updatedAt: number;
    closedAt?: number;
  };
  day: string;
  globalEpoch: string;
  models: Record<string, {
    modelEpoch: string;
    provider: string;
    modelId: string;
    modelName?: string;
    api?: string;
    stats: CacheStats;
  }>;
  lastRoutedModel?: PersistedRoutedModelRef;
};

export type ShardAggregate = {
  bySession: Record<string, Record<string, CacheStats>>;
  totalsByModel: Record<string, CacheStats>;
  instancesBySession: Record<string, number>;
  instancesBySessionModel: Record<string, Record<string, number>>;
  sessionsByModel: Record<string, number>;
  instancesByModel: Record<string, number>;
  modelRefsByKey: Record<string, PersistedRoutedModelRef>;
  lastRoutedModelBySession: Record<string, PersistedRoutedModelRef>;
};

export function currentLocalDay(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function emptyCacheStats(day = currentLocalDay()): CacheStats {
  return {
    day,
    totalRequests: 0,
    hitRequests: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalInputTokens: 0,
  };
}

export function emptyAllCacheStats(day = currentLocalDay()): Partial<Record<CacheProviderId, CacheStats>> {
  return Object.fromEntries(CACHE_PROVIDER_IDS.map((id) => [id, emptyCacheStats(day)])) as Partial<Record<CacheProviderId, CacheStats>>;
}

export function addUsageToCacheStats(stats: CacheStats, usage: UsageSnapshot): void {
  stats.totalRequests += 1;
  if (usage.cacheRead > 0) stats.hitRequests += 1;
  stats.cachedInputTokens += usage.cacheRead;
  stats.cacheWriteInputTokens += usage.cacheWrite;
  stats.totalInputTokens += usage.totalInput;
}

export function parseCacheStats(value: unknown): CacheStats | undefined {
  const stats = asRecord(value);
  if (!stats || typeof stats.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stats.day)) {
    return undefined;
  }

  const totalRequests = getNonNegativeNumber(stats, "totalRequests");
  const hitRequests = getNonNegativeNumber(stats, "hitRequests");
  const cachedInputTokens = getNonNegativeNumber(stats, "cachedInputTokens");
  const cacheWriteInputTokens = getNonNegativeNumber(stats, "cacheWriteInputTokens") ?? 0;
  const totalInputTokens = getNonNegativeNumber(stats, "totalInputTokens");

  if (
    totalRequests === undefined ||
    hitRequests === undefined ||
    cachedInputTokens === undefined ||
    totalInputTokens === undefined ||
    hitRequests > totalRequests ||
    cachedInputTokens > totalInputTokens ||
    cacheWriteInputTokens > totalInputTokens
  ) {
    return undefined;
  }

  return {
    day: stats.day,
    totalRequests,
    hitRequests,
    cachedInputTokens,
    cacheWriteInputTokens,
    totalInputTokens,
  };
}

export function cloneCacheStats(stats: CacheStats): CacheStats {
  return { ...stats };
}

export function addCacheStatsTotals(target: CacheStats, source: CacheStats): void {
  target.totalRequests += source.totalRequests;
  target.hitRequests += source.hitRequests;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheWriteInputTokens += source.cacheWriteInputTokens;
  target.totalInputTokens += source.totalInputTokens;
}

export function mergeCacheStatsForTotal(existing: CacheStats | undefined, incoming: CacheStats): CacheStats {
  if (!existing) return cloneCacheStats(incoming);
  if (incoming.day > existing.day) return cloneCacheStats(incoming);
  if (incoming.day < existing.day) return existing;
  addCacheStatsTotals(existing, incoming);
  return existing;
}

/** Merge counters while retaining historical days for an explicitly session-scoped view. */
export function mergeStatsAcrossDays(existing: CacheStats | undefined, incoming: CacheStats, day: string | null): CacheStats {
  if (day !== null) return mergeCacheStatsForTotal(existing, incoming);
  if (!existing) return cloneCacheStats(incoming);
  addCacheStatsTotals(existing, incoming);
  existing.day = incoming.day > existing.day ? incoming.day : existing.day;
  return existing;
}

export function parsePersistedRoutedModelRef(value: unknown): PersistedRoutedModelRef | undefined {
  const record = asRecord(value);
  const provider = record?.provider;
  const id = record?.id;
  const name = record?.name;
  if (!isNonEmptyString(provider) || !isNonEmptyString(id)) return undefined;

  return {
    provider: provider.trim(),
    id: id.trim(),
    name: isNonEmptyString(name) ? name.trim() : id.trim(),
  };
}

export function modelEpochPath(modelKeyValue: string): string {
  return join(SHARD_MODEL_EPOCH_DIR, `${createHash("sha256").update(modelKeyValue).digest("hex")}.json`);
}

export function initialEpoch(scope: string): string {
  return `initial:${scope}`;
}

export function parseEpochRecord(value: unknown): string | undefined {
  const record = asRecord(value);
  return record?.version === 1 && isNonEmptyString(record.epoch) ? record.epoch.trim() : undefined;
}

/** Outcome of a footer epoch read: an epoch, or an I/O error the caller must not mistake for "no reset". */
export type EpochReadResult = { ok: true; epoch: string } | { ok: false; error: unknown };

/**
 * Footer (non-strict) epoch read. A missing file means no reset ever
 * happened (the fallback); so does a file that is not a valid epoch record,
 * which every reader since 2.8.20 treats the same way, so processes of
 * different versions keep agreeing. Any other read failure (a Windows
 * EPERM/EBUSY while a reset renames the file or a scanner holds it) is
 * reported as an error: before 2.10 it fell back to the initial epoch, and a
 * refresh then "adopted" that epoch and wiped this process's unsaved usage.
 */
export async function readEpochFileResult(path: string, fallback: string): Promise<EpochReadResult> {
  let text: string;
  try {
    text = (await statsReadFs().readFile(path)).toString("utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return { ok: true, epoch: fallback };
    return { ok: false, error };
  }
  try {
    return { ok: true, epoch: parseEpochRecord(JSON.parse(text)) ?? fallback };
  } catch {
    return { ok: true, epoch: fallback };
  }
}

const EPOCH_TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "EACCES", "EAGAIN"]);
const EPOCH_RETRY_DELAYS_MS = [15, 60];

/**
 * readEpochFileResult, retrying a transient Windows error briefly. The
 * delay is deliberately not unref'd (see renameWithRetry): awaited reads
 * must not let print mode exit mid-handler.
 */
export async function readEpochFileWithRetry(path: string, fallback: string): Promise<EpochReadResult> {
  for (let attempt = 0; ; attempt++) {
    const result = await readEpochFileResult(path, fallback);
    if (result.ok || attempt >= EPOCH_RETRY_DELAYS_MS.length || !EPOCH_TRANSIENT_CODES.has(getErrorCode(result.error) ?? "")) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, EPOCH_RETRY_DELAYS_MS[attempt]));
  }
}

/** readEpochFileResult that throws on an I/O error (callers keep their current epoch). */
export async function readEpochFile(path: string, fallback: string): Promise<string> {
  const result = await readEpochFileResult(path, fallback);
  if (result.ok) return result.epoch;
  throw result.error;
}

/**
 * Like readEpochFile, but only a missing file maps to the fallback. Any other
 * read or parse failure throws, so destructive maintenance (archive
 * compaction drops counters whose epoch differs) never mistakes a transient
 * Windows EPERM/EBUSY or a damaged epoch file for "no reset ever happened".
 */
export async function readEpochFileStrict(path: string, fallback: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return fallback;
    throw error;
  }
  const epoch = parseEpochRecord(JSON.parse(text));
  if (!epoch) throw new Error(`invalid stats epoch file ${path}`);
  return epoch;
}

export async function readGlobalStatsEpoch(): Promise<string> {
  return readEpochFile(SHARD_GLOBAL_EPOCH_PATH, initialEpoch("global"));
}

export async function readModelStatsEpoch(modelKeyValue: string): Promise<string> {
  return readEpochFile(modelEpochPath(modelKeyValue), initialEpoch(`model:${modelKeyValue}`));
}

export async function readGlobalStatsEpochStrict(): Promise<string> {
  return readEpochFileStrict(SHARD_GLOBAL_EPOCH_PATH, initialEpoch("global"));
}

export async function readModelStatsEpochStrict(modelKeyValue: string): Promise<string> {
  return readEpochFileStrict(modelEpochPath(modelKeyValue), initialEpoch(`model:${modelKeyValue}`));
}

export async function writeStatsEpoch(path: string, epoch: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify({ version: 1, epoch, createdAt: Date.now() }, null, 2) + "\n", "utf8");
    // Compaction reads every epoch file strictly, so on Windows a reset can
    // meet a reader (or a scanner) holding the target: retry like the shards.
    await renameWithRetry(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function advanceGlobalStatsEpoch(): Promise<string> {
  const epoch = `${Date.now()}-${randomUUID()}`;
  await writeStatsEpoch(SHARD_GLOBAL_EPOCH_PATH, epoch);
  return epoch;
}

export async function advanceModelStatsEpoch(modelKeyValue: string): Promise<string> {
  const epoch = `${Date.now()}-${randomUUID()}`;
  await writeStatsEpoch(modelEpochPath(modelKeyValue), epoch);
  return epoch;
}

export function parsePersistedStatsShardV7(value: unknown): PersistedStatsShardV7 | undefined {
  const record = asRecord(value);
  const processRecord = asRecord(record?.process);
  const lifecycle = asRecord(record?.lifecycle);
  const rawModels = asRecord(record?.models);
  if (
    record?.version !== 7 ||
    record.kind !== "pi-cache-optimizer-shard" ||
    !isNonEmptyString(record.instanceId) ||
    !isNonEmptyString(record.sessionHash) ||
    !processRecord ||
    !Number.isInteger(processRecord.pid) ||
    !Number.isInteger(processRecord.ppid) ||
    typeof processRecord.instanceStartedAt !== "number" ||
    !lifecycle ||
    (lifecycle.state !== "active" && lifecycle.state !== "closed") ||
    typeof lifecycle.createdAt !== "number" ||
    typeof lifecycle.updatedAt !== "number" ||
    !isNonEmptyString(record.day) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(record.day) ||
    !isNonEmptyString(record.globalEpoch) ||
    !rawModels
  ) return undefined;

  const models: PersistedStatsShardV7["models"] = {};
  for (const [key, rawEntry] of Object.entries(rawModels)) {
    const entry = asRecord(rawEntry);
    const stats = parseCacheStats(entry?.stats);
    if (
      !entry || !stats || !isNonEmptyString(entry.modelEpoch) ||
      !isNonEmptyString(entry.provider) || !isNonEmptyString(entry.modelId) ||
      key !== `${entry.provider.trim()}/${entry.modelId.trim()}`
    ) continue;
    models[key] = {
      modelEpoch: entry.modelEpoch.trim(),
      provider: entry.provider.trim(),
      modelId: entry.modelId.trim(),
      ...(isNonEmptyString(entry.modelName) ? { modelName: entry.modelName.trim() } : {}),
      ...(isNonEmptyString(entry.api) ? { api: entry.api.trim() } : {}),
      stats,
    };
  }

  const lastRoutedModel = parsePersistedRoutedModelRef(record.lastRoutedModel);
  return {
    version: 7,
    kind: "pi-cache-optimizer-shard",
    instanceId: record.instanceId.trim(),
    sessionHash: record.sessionHash.trim(),
    process: {
      pid: Number(processRecord.pid),
      ppid: Number(processRecord.ppid),
      instanceStartedAt: processRecord.instanceStartedAt,
    },
    lifecycle: {
      state: lifecycle.state,
      createdAt: lifecycle.createdAt,
      updatedAt: lifecycle.updatedAt,
      ...(typeof lifecycle.closedAt === "number" ? { closedAt: lifecycle.closedAt } : {}),
    },
    day: record.day,
    globalEpoch: record.globalEpoch.trim(),
    models,
    ...(lastRoutedModel ? { lastRoutedModel } : {}),
  };
}

export async function writeStatsShardV7(path: string, shard: PersistedStatsShardV7): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(shard, null, 2) + "\n", "utf8");
    await renameWithRetry(tempPath, path);
  } catch (error) {
    // Do not leave an orphaned temp file behind until the next cleanup pass.
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * What a parse cache compares to decide a file is unchanged. Besides inode,
 * size and mtime it includes ctime and birthtime: on Windows the inode is a
 * 64-bit file id that loses precision as a double, FAT/exFAT and some
 * network drives report 0, and FAT mtimes have a 2 s resolution, so a
 * same-size rewrite (a new file renamed into place) could otherwise look
 * unchanged. A renamed-in file always has a new ctime/birthtime.
 */
export type StatsFileIdentity = { ino: number | bigint; size: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number };

export function statsFileIdentityOf(info: import("node:fs").Stats): StatsFileIdentity {
  return { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, birthtimeMs: info.birthtimeMs };
}

export function sameStatsFileIdentity(cached: StatsFileIdentity, info: import("node:fs").Stats): boolean {
  return cached.ino === info.ino && cached.size === info.size && cached.mtimeMs === info.mtimeMs &&
    cached.ctimeMs === info.ctimeMs && cached.birthtimeMs === info.birthtimeMs;
}

/** Test hooks for filesystem faults; production never sets them. */
export type StatsFsTestHooks = {
  /** Runs before every rename attempt in renameWithRetry; throw to simulate a Windows sharing violation. */
  beforeRename?: (from: string, to: string) => void | Promise<void>;
  /** Rewrites the stats a shard read sees (e.g. ino 0 and a coarse mtime). */
  shardStat?: (path: string, info: import("node:fs").Stats) => import("node:fs").Stats;
};
let statsFsTestHooks: StatsFsTestHooks = {};
export function setStatsFsTestHooks(hooks: StatsFsTestHooks | undefined): void {
  statsFsTestHooks = hooks ?? {};
}

type CachedShardRead = StatsFileIdentity & {
  /** Valid shard whose embedded instanceId matches its filename. */
  shard: PersistedStatsShardV7 | undefined;
  /** Schema-valid parse regardless of filename match (used by retention). */
  parsed: PersistedStatsShardV7 | undefined;
};

/**
 * Upper bound on concurrent filesystem operations during shard scans. Startup
 * on Windows (antivirus-scanned AppData) was dominated by thousands of
 * serialized lstat/readFile awaits; a small pool hides per-call latency
 * without opening an unbounded number of descriptors.
 */
export const SHARD_IO_CONCURRENCY = 16;

/** Run `worker` over `items` with at most `limit` in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index] as T, index);
    }
  };
  const pool = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: pool }, run));
  return results;
}

type ShardFileRead = {
  info: import("node:fs").Stats;
  /** Valid shard with matching filename instanceId. */
  shard: PersistedStatsShardV7 | undefined;
  /** Schema-valid parse regardless of filename match. */
  parsed: PersistedStatsShardV7 | undefined;
};

/**
 * Stat a shard file and return its parsed contents, re-reading only when the
 * inode/size/mtime changed. Returns undefined for non-regular files. Throws on
 * read/parse failure (after dropping any cache entry) so callers can apply
 * their own policy.
 */
async function readShardFileCached(path: string, name: string): Promise<ShardFileRead | undefined> {
  try {
    let info = await lstat(path);
    if (statsFsTestHooks.shardStat) info = statsFsTestHooks.shardStat(path, info);
    if (!info.isFile() || info.isSymbolicLink()) {
      shardReadCache.delete(path);
      return undefined;
    }
    const cached = shardReadCache.get(path);
    if (cached && sameStatsFileIdentity(cached, info)) {
      return { info, shard: cached.shard, parsed: cached.parsed };
    }
    const filenameInstanceId = name.slice(0, -".json".length);
    const parsed = parsePersistedStatsShardV7(JSON.parse(await readFile(path, "utf8")));
    const shard = parsed && parsed.instanceId === filenameInstanceId ? parsed : undefined;
    shardReadCache.set(path, { ...statsFileIdentityOf(info), shard, parsed });
    return { info, shard, parsed };
  } catch (error) {
    shardReadCache.delete(path);
    throw error;
  }
}

/**
 * Parsed-shard cache keyed by path and validated by the file identity.
 * Writers always publish through temp-file + rename, so an updated shard gets
 * a new inode; unchanged shards are not re-read or re-parsed on every refresh.
 */
const shardReadCache = new Map<string, CachedShardRead>();

export function clearStatsShardReadCache(): void {
  shardReadCache.clear();
}

function cloneShard(shard: PersistedStatsShardV7): PersistedStatsShardV7 {
  return structuredClone(shard);
}

/** File names the shard directory holds shards under (every version since 2.8.20). */
export const SHARD_FILE_NAME_PATTERN = /^[0-9a-f-]+\.json$/i;

/**
 * Parse one shard file's text the way readShardFileCached does: `parsed` is
 * the schema-valid shard, `shard` the same only when its instanceId matches
 * the file name. Throws SyntaxError on malformed JSON.
 */
export function parseShardFileText(name: string, text: string): { shard: PersistedStatsShardV7 | undefined; parsed: PersistedStatsShardV7 | undefined } {
  const filenameInstanceId = name.slice(0, -".json".length);
  const parsed = parsePersistedStatsShardV7(JSON.parse(text));
  return { parsed, shard: parsed && parsed.instanceId === filenameInstanceId ? parsed : undefined };
}

/** The test hook view of a shard lstat (production: the stats unchanged). */
export function applyShardStatHook(path: string, info: import("node:fs").Stats): import("node:fs").Stats {
  return statsFsTestHooks.shardStat ? statsFsTestHooks.shardStat(path, info) : info;
}

export async function readValidStatsShardsV7(directory: string = SHARD_FILES_DIR): Promise<PersistedStatsShardV7[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return [];
    throw error;
  }
  const seenPaths = new Set<string>();
  const candidates = names.filter((name) => /^[0-9a-f-]+\.json$/i.test(name));
  for (const name of candidates) seenPaths.add(join(directory, name));
  const reads = await mapWithConcurrency(candidates, SHARD_IO_CONCURRENCY, async (name) => {
    try {
      return (await readShardFileCached(join(directory, name), name))?.shard;
    } catch {
      // Ignore malformed or transiently unavailable shards. Atomic writers will
      // publish a complete replacement on the next successful update.
      return undefined;
    }
  });
  // Callers may mutate the aggregate they build; hand out copies so the cache
  // stays authoritative. Preserve directory order for deterministic ties.
  const shards: PersistedStatsShardV7[] = [];
  for (const shard of reads) if (shard) shards.push(cloneShard(shard));
  for (const path of Array.from(shardReadCache.keys())) {
    if (!seenPaths.has(path) && path.startsWith(directory)) shardReadCache.delete(path);
  }
  return shards;
}

/**
 * Pre-reduced counters from many shards (the stats archive), already filtered
 * to the current global and model epochs. Merging one into an aggregator
 * gives the same result as feeding it the shards it was reduced from, at that
 * position of the shard sequence. Only valid for the all-days (`day === null`)
 * aggregate. Entries are listed in the order their first shard contributed,
 * so key order in the result matches too. Treat as read-only.
 */
export type ShardContribution = {
  sessions: ReadonlyArray<{
    sessionHash: string;
    /** Contributing shards of this session (each counts once in instancesBySession). */
    instances: number;
    models: ReadonlyArray<{ key: string; stats: CacheStats; instances: number }>;
  }>;
  models: ReadonlyArray<{
    key: string;
    stats: CacheStats;
    instances: number;
    sessions: readonly string[];
  }>;
  /**
   * Per model, the first shard with the newest lifecycle.updatedAt that
   * carried it, in the order an aggregation would first record each one.
   */
  refs: ReadonlyArray<{ key: string; updatedAt: number; ref: PersistedRoutedModelRef }>;
  /** Per session, the first entry with the newest updatedAt. */
  routed: ReadonlyArray<{ sessionHash: string; updatedAt: number; model: PersistedRoutedModelRef }>;
};

export type ShardAggregator = {
  readonly day: string | null;
  readonly globalEpoch: string;
  /** The model epoch this aggregation filters `key` with (read once per aggregation). */
  modelEpoch(key: string): Promise<string>;
  add(shard: PersistedStatsShardV7): Promise<void>;
  addContribution(contribution: ShardContribution): void;
  finish(): ShardAggregate;
};

/** One consistent set of epochs (global plus every model key an aggregation meets), read before aggregating. */
export type ShardEpochs = {
  readonly globalEpoch: string;
  /** Must cover every model key the aggregation meets (throws otherwise: a missing prefetch is a bug). */
  modelEpoch(key: string): string;
};

/** Synchronous form of the aggregator, over epochs read beforehand: no await between the first add and finish. */
export type SyncShardAggregator = {
  readonly day: string | null;
  readonly globalEpoch: string;
  add(shard: PersistedStatsShardV7): void;
  addContribution(contribution: ShardContribution): void;
  finish(): ShardAggregate;
};

/** Model keys `add(shard)` would look up an epoch for (none when the shard is filtered out up front). */
export function shardEpochKeys(shard: PersistedStatsShardV7, day: string | null, globalEpoch: string): string[] {
  if ((day !== null && shard.day !== day) || shard.globalEpoch !== globalEpoch) return [];
  return Object.keys(shard.models);
}

/** The aggregation itself (aggregateStatsShardsV7's semantics), over pre-read epochs. */
export function createShardAggregatorSync(day: string | null, epochs: ShardEpochs): SyncShardAggregator {
  const globalEpoch = epochs.globalEpoch;
  const result: ShardAggregate = {
    bySession: {},
    totalsByModel: {},
    instancesBySession: {},
    instancesBySessionModel: {},
    sessionsByModel: {},
    instancesByModel: {},
    modelRefsByKey: {},
    lastRoutedModelBySession: {},
  };
  const routedUpdatedAt = new Map<string, number>();
  const modelRefUpdatedAt = new Map<string, number>();
  const modelSessions = new Map<string, Set<string>>();

  return {
    day,
    globalEpoch,
    add(shard) {
      if ((day !== null && shard.day !== day) || shard.globalEpoch !== globalEpoch) return;
      let contributed = false;
      if (shard.lastRoutedModel && (routedUpdatedAt.get(shard.sessionHash) ?? -1) < shard.lifecycle.updatedAt) {
        routedUpdatedAt.set(shard.sessionHash, shard.lifecycle.updatedAt);
        // A copy: shards are shared, read-only cache entries (no per-refresh clone).
        result.lastRoutedModelBySession[shard.sessionHash] = { ...shard.lastRoutedModel };
      }
      for (const [key, entry] of Object.entries(shard.models)) {
        if (entry.modelEpoch !== epochs.modelEpoch(key) || (day !== null && entry.stats.day !== day)) continue;
        contributed = true;
        const sessionModels = result.bySession[shard.sessionHash] ??= {};
        sessionModels[key] = mergeStatsAcrossDays(sessionModels[key], entry.stats, day);
        result.totalsByModel[key] = mergeStatsAcrossDays(result.totalsByModel[key], entry.stats, day);
        result.instancesByModel[key] = (result.instancesByModel[key] ?? 0) + 1;
        if ((modelRefUpdatedAt.get(key) ?? -1) < shard.lifecycle.updatedAt) {
          modelRefUpdatedAt.set(key, shard.lifecycle.updatedAt);
          result.modelRefsByKey[key] = {
            provider: entry.provider,
            id: entry.modelId,
            name: entry.modelName ?? entry.modelId,
          };
        }
        const sessionInstances = result.instancesBySessionModel[shard.sessionHash] ??= {};
        sessionInstances[key] = (sessionInstances[key] ?? 0) + 1;
        const sessions = modelSessions.get(key) ?? new Set<string>();
        sessions.add(shard.sessionHash);
        modelSessions.set(key, sessions);
      }
      if (contributed) {
        result.instancesBySession[shard.sessionHash] = (result.instancesBySession[shard.sessionHash] ?? 0) + 1;
      }
    },
    addContribution(contribution) {
      if (day !== null) throw new Error("shard contributions only apply to the all-days aggregate");
      for (const entry of contribution.routed) {
        if ((routedUpdatedAt.get(entry.sessionHash) ?? -1) < entry.updatedAt) {
          routedUpdatedAt.set(entry.sessionHash, entry.updatedAt);
          result.lastRoutedModelBySession[entry.sessionHash] = { ...entry.model };
        }
      }
      for (const model of contribution.models) {
        // mergeStatsAcrossDays clones on first insert, so the shared
        // contribution is never handed out (callers mutate the aggregate).
        result.totalsByModel[model.key] = mergeStatsAcrossDays(result.totalsByModel[model.key], model.stats, null);
        result.instancesByModel[model.key] = (result.instancesByModel[model.key] ?? 0) + model.instances;
        const sessions = modelSessions.get(model.key) ?? new Set<string>();
        for (const sessionHash of model.sessions) sessions.add(sessionHash);
        modelSessions.set(model.key, sessions);
      }
      for (const entry of contribution.refs) {
        if ((modelRefUpdatedAt.get(entry.key) ?? -1) < entry.updatedAt) {
          modelRefUpdatedAt.set(entry.key, entry.updatedAt);
          result.modelRefsByKey[entry.key] = { ...entry.ref };
        }
      }
      for (const session of contribution.sessions) {
        const sessionModels = result.bySession[session.sessionHash] ??= {};
        const sessionInstances = result.instancesBySessionModel[session.sessionHash] ??= {};
        for (const model of session.models) {
          sessionModels[model.key] = mergeStatsAcrossDays(sessionModels[model.key], model.stats, null);
          sessionInstances[model.key] = (sessionInstances[model.key] ?? 0) + model.instances;
        }
        result.instancesBySession[session.sessionHash] = (result.instancesBySession[session.sessionHash] ?? 0) + session.instances;
      }
    },
    finish() {
      for (const [key, sessions] of modelSessions) result.sessionsByModel[key] = sessions.size;
      return result;
    },
  };
}

/** Incremental form of aggregateStatsShardsV7: add shards (and pre-reduced contributions) in order, then finish. */
export async function createShardAggregatorV7(day: string | null = currentLocalDay()): Promise<ShardAggregator> {
  const globalEpoch = await readGlobalStatsEpoch();
  const modelEpochs = new Map<string, string>();
  const modelEpoch = async (key: string): Promise<string> => {
    let epoch = modelEpochs.get(key);
    if (!epoch) {
      epoch = await readModelStatsEpoch(key);
      modelEpochs.set(key, epoch);
    }
    return epoch;
  };
  const core = createShardAggregatorSync(day, {
    globalEpoch,
    modelEpoch: (key) => {
      const epoch = modelEpochs.get(key);
      if (epoch === undefined) throw new Error(`model epoch of ${key} was not read before aggregating`);
      return epoch;
    },
  });
  return {
    day,
    globalEpoch,
    modelEpoch,
    async add(shard) {
      for (const key of shardEpochKeys(shard, day, globalEpoch)) if (!modelEpochs.has(key)) await modelEpoch(key);
      core.add(shard);
    },
    addContribution: (contribution) => core.addContribution(contribution),
    finish: () => core.finish(),
  };
}

export async function aggregateStatsShardsV7(
  shards: PersistedStatsShardV7[],
  day: string | null = currentLocalDay(),
): Promise<ShardAggregate> {
  const aggregator = await createShardAggregatorV7(day);
  for (const shard of shards) await aggregator.add(shard);
  return aggregator.finish();
}

export async function loadStatsShardAggregateV7(directory: string = SHARD_FILES_DIR): Promise<ShardAggregate> {
  return aggregateStatsShardsV7(await readValidStatsShardsV7(directory));
}

export async function removeLegacyStatsFiles(): Promise<void> {
  for (const path of [STATE_FILE_PATH, LEGACY_STATE_FILE_PATH]) {
    try {
      await unlink(path);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") console.warn(`${LOG_PREFIX}: failed to remove obsolete stats file ${path}`, error);
    }
  }
}

export async function cleanupStatsShardsV7(now = Date.now(), directory: string = SHARD_FILES_DIR): Promise<number> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    return getErrorCode(error) === "ENOENT" ? 0 : Promise.reject(error);
  }
  const today = currentLocalDay();
  const candidates = names.filter((name) => /^[0-9a-f-]+\.json$/i.test(name) || name.endsWith(".tmp"));
  const outcomes = await mapWithConcurrency(candidates, SHARD_IO_CONCURRENCY, async (name): Promise<number> => {
    const isTemp = !/^[0-9a-f-]+\.json$/i.test(name);
    const path = join(directory, name);
    try {
      if (isTemp) {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) return 0;
        if (now - info.mtimeMs < SHARD_TEMP_RETENTION_MS) return 0;
      } else {
        let read: ShardFileRead | undefined;
        let mtimeMs: number;
        try {
          read = await readShardFileCached(path, name);
          if (!read) return 0;
          mtimeMs = read.info.mtimeMs;
        } catch (error) {
          // A corrupt JSON shard has no usable lifecycle metadata. Apply the
          // same mtime retention as schema-invalid shards instead of keeping
          // it forever; read failures still leave the file untouched.
          if (!(error instanceof SyntaxError)) return 0;
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink()) return 0;
          mtimeMs = info.mtimeMs;
        }
        const parsed = read?.parsed;
        if (parsed?.day === today) return 0;
        const updatedAt = parsed?.lifecycle.updatedAt ?? mtimeMs;
        if (now - updatedAt < SHARD_RETENTION_MS) return 0;
        if (parsed?.lifecycle.state === "active" && isProcessAlive(parsed.process.pid)) return 0;
      }
      await unlink(path);
      shardReadCache.delete(path);
      return 1;
    } catch {
      // Best-effort maintenance must never block the extension.
      return 0;
    }
  });
  return outcomes.reduce((sum, value) => sum + value, 0);
}

const SHARD_CLEANUP_LOCK_OWNER_FILE = "owner";

/**
 * Tokens whose owner file this process actually wrote. For those, a lock
 * directory without an owner file can only mean the directory was replaced
 * (a 2.8.x stale-lock takeover writes none, and a 2.9 takeover is caught
 * between its mkdir and its owner write), so ownership is lost.
 */
const writtenLockTokens = new Set<string>();

/**
 * Take the cross-process maintenance lock (a directory, so creation is atomic
 * on every platform). A lock older than SHARD_CLEANUP_LOCK_STALE_MS is
 * treated as abandoned by a crashed process and replaced. Resolves to an
 * owner token (truthy) on success, undefined otherwise. The token lets a
 * holder whose lock was taken over avoid releasing the new owner's lock.
 */
export async function acquireStatsMaintenanceLock(now = Date.now()): Promise<string | undefined> {
  await mkdir(SHARD_MAINTENANCE_DIR, { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const claim = async (): Promise<string> => {
    // Best effort: an older version (or a failed write) leaves no owner file,
    // which only disables the ownership check, never the lock itself.
    try {
      await writeFile(join(SHARD_CLEANUP_LOCK_PATH, SHARD_CLEANUP_LOCK_OWNER_FILE), token, "utf8");
      writtenLockTokens.add(token);
    } catch {}
    return token;
  };
  try {
    await mkdir(SHARD_CLEANUP_LOCK_PATH);
    return await claim();
  } catch (error) {
    if (getErrorCode(error) !== "EEXIST") return undefined;
    try {
      const lock = await stat(SHARD_CLEANUP_LOCK_PATH);
      // A lock dated more than the stale window in the future was left by a
      // crash while the clock ran ahead; without this it would block
      // maintenance until the wall clock caught up (possibly for months).
      const age = now - lock.mtimeMs;
      if (age <= SHARD_CLEANUP_LOCK_STALE_MS && age >= -SHARD_CLEANUP_LOCK_STALE_MS) return undefined;
      await rm(SHARD_CLEANUP_LOCK_PATH, { recursive: true, force: true });
      await mkdir(SHARD_CLEANUP_LOCK_PATH);
      return await claim();
    } catch {
      return undefined;
    }
  }
}

/**
 * False when the lock directory records a different owner, is gone, or lost
 * the owner file this holder wrote. An unreadable owner file fails closed
 * (destructive publishes are skipped and retried) unless `failOpen` is set.
 */
export async function holdsStatsMaintenanceLock(token: string | undefined, { failOpen = false }: { failOpen?: boolean } = {}): Promise<boolean> {
  if (!token) return true;
  try {
    const owner = await readFile(join(SHARD_CLEANUP_LOCK_PATH, SHARD_CLEANUP_LOCK_OWNER_FILE), "utf8");
    return owner === token;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") return failOpen;
    // Lock directory gone: someone treated us as stale. Owner file missing
    // inside an existing lock: ours only if we never managed to write one.
    try {
      await stat(SHARD_CLEANUP_LOCK_PATH);
      return !writtenLockTokens.has(token);
    } catch {
      return false;
    }
  }
}

export async function releaseStatsMaintenanceLock(token?: string): Promise<void> {
  try {
    // Do not delete a lock another process took over after ours went stale.
    if (token && !(await holdsStatsMaintenanceLock(token, { failOpen: true }))) return;
    await rm(SHARD_CLEANUP_LOCK_PATH, { recursive: true, force: true });
  } finally {
    if (token) writtenLockTokens.delete(token);
  }
}

/**
 * Heartbeat: refresh the lock directory's mtime so a long maintenance pass is
 * not mistaken for a crashed holder and taken over. A no-op (false) unless
 * `token` still owns the lock. It cannot help while the process is suspended
 * (laptop sleep); archive publishing is a compare-and-swap for that case.
 */
export async function touchStatsMaintenanceLock(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    if (!(await holdsStatsMaintenanceLock(token))) return false;
    const now = new Date();
    await utimes(SHARD_CLEANUP_LOCK_PATH, now, now);
    return true;
  } catch {
    return false;
  }
}

/** True when the marker file is missing or older than `intervalMs`. */
export async function isMaintenanceMarkerDue(path: string, now = Date.now(), intervalMs = SHARD_CLEANUP_INTERVAL_MS): Promise<boolean> {
  try {
    const marker = await stat(path);
    const age = now - marker.mtimeMs;
    // A marker from the future (the clock was set back) must not suspend
    // maintenance until the wall clock reaches it again.
    return age >= intervalMs || age < -intervalMs;
  } catch {
    return true;
  }
}

/**
 * Write a maintenance marker. `markedAt` (default `now`) becomes its mtime,
 * which isMaintenanceMarkerDue measures: a marker dated earlier makes the
 * next run due sooner (a failed pass retries after a short backoff).
 */
export async function writeMaintenanceMarker(path: string, now = Date.now(), markedAt = now): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${now}\n`, "utf8");
    if (markedAt !== now) await utimes(tempPath, new Date(markedAt), new Date(markedAt));
    await renameWithRetry(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Default total time renameWithRetry keeps retrying (a Defender scan easily holds a file for over a second). */
export const RENAME_RETRY_BUDGET_MS = 2_000;
const RENAME_RETRY_MAX_DELAY_MS = 250;

/**
 * rename() that retries on the transient errors Windows raises while another
 * process (or an antivirus scanner) holds the source or target open: backoff
 * from 20 ms up to 250 ms per attempt, for `budgetMs` in total.
 */
export async function renameWithRetry(from: string, to: string, budgetMs = RENAME_RETRY_BUDGET_MS): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 0; ; attempt++) {
    try {
      await statsFsTestHooks.beforeRename?.(from, to);
      await rename(from, to);
      return;
    } catch (error) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !RENAME_RETRY_CODES.has(getErrorCode(error) ?? "")) throw error;
      const delay = Math.min(20 * 2 ** attempt, RENAME_RETRY_MAX_DELAY_MS, remaining);
      // Deliberately not unref'd: every caller awaits this rename (a Pi
      // handler, or the restore that session_shutdown awaits), and Pi's
      // print mode exits by letting the event loop drain. An unref'd delay
      // would let the process exit in the middle of an awaited handler,
      // skipping session_shutdown and its final flush. The delay is bounded
      // by budgetMs, and interactive mode exits with process.exit anyway.
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Run due retention maintenance; resolves to the number of files removed (0 when skipped). */
export async function maybeCleanupStatsShardsV7(now = Date.now()): Promise<number> {
  await mkdir(SHARD_MAINTENANCE_DIR, { recursive: true });
  if (!(await isMaintenanceMarkerDue(SHARD_CLEANUP_MARKER_PATH, now))) return 0;
  const lockToken = await acquireStatsMaintenanceLock(now);
  if (!lockToken) return 0;
  try {
    const removed = await cleanupStatsShardsV7(now);
    await writeMaintenanceMarker(SHARD_CLEANUP_MARKER_PATH, now);
    return removed;
  } finally {
    await releaseStatsMaintenanceLock(lockToken);
  }
}
