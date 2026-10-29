/**
 * Archive snapshot for closed past-day stats shards (issue #28, phase 2).
 *
 * Every Pi process writes one shard per local day. Shards are kept for
 * SHARD_RETENTION_MS so session-scoped footer totals survive long
 * conversations, which left ~1,500 files to stat and parse on every refresh.
 *
 * Past-day shards that are closed (or abandoned by a dead process) never
 * change again, so maintenance folds them into one archive snapshot and
 * deletes the originals. The directory then only holds today's shards.
 *
 * Correctness rules:
 * - Buckets keep the global and model epochs they were written under. Readers
 *   filter them with the same epoch checks as raw shards, so a reset hides
 *   archived counters at once, before the next compaction drops them.
 * - The archive records every instanceId it absorbed. Readers ignore raw
 *   shards (and in-memory retired shards) with an absorbed id, so a crash
 *   between publishing the archive and deleting the originals, or two
 *   processes compacting at once, never double counts.
 * - Archived data only feeds the all-days (session-scoped) aggregate. Its
 *   buckets keep their original day, so the current-day aggregate filters
 *   them out exactly as it filters the raw past-day shards they replace.
 *
 * Storage (generations): each snapshot is an immutable file
 * `archive/archive.<generation>.json`. A compactor that read generation N
 * publishes N+1 with link(temp, target), which fails with EEXIST when anyone
 * else already published N+1. That makes publishing a compare-and-swap on
 * Windows and POSIX alike: a holder that stalled past the stale-lock window
 * (laptop sleep) and lost its lock can never replace a newer snapshot, and it
 * deletes no raw shard unless its own snapshot is the newest one. Readers use
 * the highest generation; old generations are removed one generation late
 * and readers retry when the file they listed is gone.
 *
 * Without hard links (FAT/exFAT, some NAS mounts) a generation is created
 * exclusively in place (O_EXCL, the same compare-and-swap) and only counts
 * once it parses completely.
 *
 * Recovery: every generation is self-consistent (its counters cover exactly
 * the raw shards it lists as absorbed), so a generation that cannot be read
 * (damaged on disk, truncated by a crash) is skipped for the previous one,
 * which never double counts. The next compaction publishes above it and
 * quarantines it as `archive.<generation>.corrupt-<time>.json`. A generation
 * in a newer format is never skipped or overwritten.
 *
 * 2.9.0 compatibility: 2.9.0 kept a single `archive/archive.json`. It is still
 * read while no generation exists and migrated by the next compaction, which
 * moves it aside to a placeholder, verifies the moved bytes are the ones it
 * read, replaces it with a directory of the same name, and then links the
 * first generation. 2.9.0 treats that directory as an unreadable archive: it
 * never compacts (so it cannot overwrite or delete anything) and its footer
 * shows only history that is not archived, exactly like the versions before
 * 2.9.0. A file that 2.9.0 still manages to write there afterwards (only if
 * that directory is removed) is never counted: it is set aside as
 * `archive.legacy-<time>.json`, trading the counters it absorbed for a
 * guarantee against double counting. An unreadable archive.json is set aside
 * the same way and the first generation starts over from the raw shards.
 */
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LOG_PREFIX, asRecord, getErrorCode, isNonEmptyString, isProcessAlive } from "./common.ts";
import {
  type CacheStats,
  type PersistedRoutedModelRef,
  type PersistedStatsShardV7,
  type ShardAggregate,
  type ShardAggregator,
  type ShardContribution,
  type ShardEpochs,
  SHARD_CLEANUP_MARKER_PATH,
  SHARD_FILES_DIR,
  SHARD_IO_CONCURRENCY,
  SHARD_MAINTENANCE_DIR,
  SHARD_RETENTION_MS,
  SHARD_STATE_DIR,
  SHARD_TEMP_RETENTION_MS,
  acquireStatsMaintenanceLock,
  cleanupStatsShardsV7,
  cloneCacheStats,
  createShardAggregatorSync,
  createShardAggregatorV7,
  currentLocalDay,
  isMaintenanceMarkerDue,
  mapWithConcurrency,
  mergeStatsAcrossDays,
  parseCacheStats,
  parsePersistedRoutedModelRef,
  holdsStatsMaintenanceLock,
  readGlobalStatsEpochStrict,
  readModelStatsEpochStrict,
  readValidStatsShardsV7,
  releaseStatsMaintenanceLock,
  renameWithRetry,
  sameStatsFileIdentity,
  statsFileIdentityOf,
  type StatsFileIdentity,
  SHARD_CLEANUP_INTERVAL_MS,
  touchStatsMaintenanceLock,
  writeMaintenanceMarker,
} from "./stats-store.ts";
import { statsReadFs } from "./stats-fs.ts";

export const SHARD_ARCHIVE_DIR = join(SHARD_STATE_DIR, "archive");
/**
 * 2.9.0's single-file archive. Read (and migrated) while no generation file
 * exists; afterwards a directory blocks 2.9.0 from writing it. The other
 * archive functions take this path and keep generations next to it.
 */
export const SHARD_ARCHIVE_PATH = join(SHARD_ARCHIVE_DIR, "archive.json");
export const SHARD_COMPACTION_MARKER_PATH = join(SHARD_MAINTENANCE_DIR, "last-compaction");

/**
 * An active shard is only treated as abandoned once its process is gone and
 * it has not been touched for this long, so a recycled Windows PID or a
 * transient process-check failure cannot fold a live shard away.
 */
export const ARCHIVE_ABANDONED_ACTIVE_MS = 24 * 60 * 60 * 1000;

/** How soon maintenance retries a compaction pass that failed with an error. */
export const COMPACTION_RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;

/** How often a running maintenance pass refreshes the lock's mtime. */
export const STATS_MAINTENANCE_HEARTBEAT_MS = 5 * 60 * 1000;

export type StatsArchiveBucketV1 = {
  globalEpoch: string;
  sessionHash: string;
  modelKey: string;
  modelEpoch: string;
  /** Day of the shards folded into this bucket. */
  day: string;
  provider: string;
  modelId: string;
  modelName?: string;
  api?: string;
  /** Latest lifecycle.updatedAt among the folded shards. */
  updatedAt: number;
  stats: CacheStats;
};

export type StatsArchiveRoutedV1 = {
  globalEpoch: string;
  sessionHash: string;
  day: string;
  updatedAt: number;
  model: PersistedRoutedModelRef;
};

/** In-memory archive contents (and 2.9.0's on-disk format). */
export type StatsArchiveV1 = {
  version: 1;
  kind: "pi-cache-optimizer-archive";
  updatedAt: number;
  /** instanceId -> time it was folded in. */
  absorbed: Record<string, number>;
  buckets: StatsArchiveBucketV1[];
  routed: StatsArchiveRoutedV1[];
};

/**
 * On-disk generation format: the same entries as v1 with every string
 * interned in one table, so a bucket is one short row of numbers.
 * models rows: [provider, modelId, modelName | -1, api | -1] (string indexes).
 * buckets rows: [globalEpoch, sessionHash, model, modelEpoch, day, updatedAt,
 *   stats.day, totalRequests, hitRequests, cachedInputTokens,
 *   cacheWriteInputTokens, totalInputTokens] (strings and model are indexes).
 * routed rows: [globalEpoch, sessionHash, day, updatedAt, provider, id, name | -1].
 */
export type StatsArchiveV2Document = {
  version: 2;
  kind: "pi-cache-optimizer-archive";
  generation: number;
  updatedAt: number;
  /** sha256 of the 2.9.0 archive.json this archive was migrated from. */
  legacySha256?: string;
  absorbed: Record<string, number>;
  strings: string[];
  models: number[][];
  buckets: number[][];
  routed: number[][];
  /**
   * Completeness marker, always the last property: a generation written in
   * place (filesystems without hard links) is only valid once it parses,
   * and a truncated document never does. Older versions ignore it.
   */
  complete?: true;
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GENERATION_FILE_PATTERN = /^archive\.(\d{1,15})\.json$/;
/**
 * 2.9.0's archive.json while it is being migrated (see compactStatsShardsV7):
 * `archive.migrating-<moved-at ms, 13 digits>-<uuid>.json`, or
 * `archive.migrating-<uuid>.json` as 2.9.2 named it. Both match this pattern
 * (2.9.2 reads both).
 */
const MIGRATION_PLACEHOLDER_PATTERN = /^archive\.migrating-[0-9a-f-]+\.json$/;
const MIGRATION_PLACEHOLDER_MOVED_AT_PATTERN = /^archive\.migrating-(\d{13})-[0-9a-f]{8}-[0-9a-f-]+\.json$/;

function migrationPlaceholderPath(archivePath: string, movedAt = Date.now()): string {
  return join(dirname(archivePath), `archive.migrating-${String(Math.max(0, Math.floor(movedAt))).padStart(13, "0")}-${randomUUID()}.json`);
}

export function emptyStatsArchive(now = Date.now()): StatsArchiveV1 {
  return { version: 1, kind: "pi-cache-optimizer-archive", updatedAt: now, absorbed: {}, buckets: [], routed: [] };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseArchiveBucket(raw: unknown): StatsArchiveBucketV1 | undefined {
  const entry = asRecord(raw);
  const stats = parseCacheStats(entry?.stats);
  if (
    !entry || !stats ||
    !isNonEmptyString(entry.globalEpoch) || !isNonEmptyString(entry.sessionHash) ||
    !isNonEmptyString(entry.modelKey) || !isNonEmptyString(entry.modelEpoch) ||
    !isNonEmptyString(entry.provider) || !isNonEmptyString(entry.modelId) ||
    typeof entry.day !== "string" || !DAY_PATTERN.test(entry.day) ||
    !isFiniteNumber(entry.updatedAt) ||
    entry.modelKey !== `${entry.provider}/${entry.modelId}`
  ) return undefined;
  return {
    globalEpoch: entry.globalEpoch,
    sessionHash: entry.sessionHash,
    modelKey: entry.modelKey,
    modelEpoch: entry.modelEpoch,
    day: entry.day,
    provider: entry.provider,
    modelId: entry.modelId,
    ...(isNonEmptyString(entry.modelName) ? { modelName: entry.modelName } : {}),
    ...(isNonEmptyString(entry.api) ? { api: entry.api } : {}),
    updatedAt: entry.updatedAt,
    stats,
  };
}

function parseArchiveRouted(raw: unknown): StatsArchiveRoutedV1 | undefined {
  const entry = asRecord(raw);
  const model = parsePersistedRoutedModelRef(entry?.model);
  if (
    !entry || !model ||
    !isNonEmptyString(entry.globalEpoch) || !isNonEmptyString(entry.sessionHash) ||
    typeof entry.day !== "string" || !DAY_PATTERN.test(entry.day) ||
    !isFiniteNumber(entry.updatedAt)
  ) return undefined;
  return { globalEpoch: entry.globalEpoch, sessionHash: entry.sessionHash, day: entry.day, updatedAt: entry.updatedAt, model };
}

function parseAbsorbed(value: unknown): Record<string, number> | undefined {
  const rawAbsorbed = asRecord(value);
  if (!rawAbsorbed) return undefined;
  const absorbed: Record<string, number> = {};
  for (const [id, at] of Object.entries(rawAbsorbed)) {
    if (isNonEmptyString(id) && isFiniteNumber(at)) absorbed[id] = at;
  }
  return absorbed;
}

/** Strict parse of 2.9.0's format: undefined when the document is not a v1 archive. Invalid entries are dropped. */
export function parseStatsArchive(value: unknown): StatsArchiveV1 | undefined {
  const record = asRecord(value);
  if (!record || record.version !== 1 || record.kind !== "pi-cache-optimizer-archive") return undefined;
  const absorbed = parseAbsorbed(record.absorbed);
  if (!absorbed || !Array.isArray(record.buckets) || !Array.isArray(record.routed)) return undefined;
  const buckets: StatsArchiveBucketV1[] = [];
  for (const raw of record.buckets) {
    const bucket = parseArchiveBucket(raw);
    if (bucket) buckets.push(bucket);
  }
  const routed: StatsArchiveRoutedV1[] = [];
  for (const raw of record.routed) {
    const entry = parseArchiveRouted(raw);
    if (entry) routed.push(entry);
  }
  return {
    version: 1,
    kind: "pi-cache-optimizer-archive",
    updatedAt: isFiniteNumber(record.updatedAt) ? record.updatedAt : 0,
    absorbed,
    buckets,
    routed,
  };
}

/** Encode an archive in the compact generation format. */
export function encodeStatsArchiveV2(archive: StatsArchiveV1, generation: number, legacySha256?: string): StatsArchiveV2Document {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const str = (value: string): number => {
    let index = stringIndex.get(value);
    if (index === undefined) {
      index = strings.length;
      strings.push(value);
      stringIndex.set(value, index);
    }
    return index;
  };
  const optional = (value: string | undefined): number => (value === undefined ? -1 : str(value));
  const models: number[][] = [];
  const modelIndex = new Map<string, number>();
  const model = (bucket: StatsArchiveBucketV1): number => {
    const row = [str(bucket.provider), str(bucket.modelId), optional(bucket.modelName), optional(bucket.api)];
    const id = row.join(",");
    let index = modelIndex.get(id);
    if (index === undefined) {
      index = models.length;
      models.push(row);
      modelIndex.set(id, index);
    }
    return index;
  };
  const buckets = archive.buckets.map((bucket) => [
    str(bucket.globalEpoch), str(bucket.sessionHash), model(bucket), str(bucket.modelEpoch), str(bucket.day), bucket.updatedAt,
    str(bucket.stats.day), bucket.stats.totalRequests, bucket.stats.hitRequests, bucket.stats.cachedInputTokens,
    bucket.stats.cacheWriteInputTokens, bucket.stats.totalInputTokens,
  ]);
  const routed = archive.routed.map((entry) => [
    str(entry.globalEpoch), str(entry.sessionHash), str(entry.day), entry.updatedAt,
    str(entry.model.provider), str(entry.model.id), optional(entry.model.name),
  ]);
  return {
    version: 2,
    kind: "pi-cache-optimizer-archive",
    generation,
    updatedAt: archive.updatedAt,
    ...(legacySha256 ? { legacySha256 } : {}),
    absorbed: archive.absorbed,
    strings,
    models,
    buckets,
    routed,
    complete: true,
  };
}

/**
 * Strict parse of a generation file: undefined when the document itself is
 * not a v2 archive. Rows with bad indexes or values are dropped, applying the
 * same per-entry validation as v1.
 */
export function parseStatsArchiveV2(value: unknown): { archive: StatsArchiveV1; generation: number; legacySha256?: string } | undefined {
  const record = asRecord(value);
  if (!record || record.version !== 2 || record.kind !== "pi-cache-optimizer-archive") return undefined;
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1) return undefined;
  const absorbed = parseAbsorbed(record.absorbed);
  const { strings, models, buckets: rawBuckets, routed: rawRouted } = record;
  if (
    !absorbed || !Array.isArray(strings) || !Array.isArray(models) || !Array.isArray(rawBuckets) || !Array.isArray(rawRouted) ||
    !strings.every((entry) => typeof entry === "string")
  ) return undefined;
  const str = (index: unknown): string | undefined =>
    Number.isInteger(index) && (index as number) >= 0 && (index as number) < strings.length ? strings[index as number] as string : undefined;
  const row = (value: unknown, length: number): unknown[] | undefined => (Array.isArray(value) && value.length === length ? value : undefined);

  const modelTable = models.map((raw) => {
    const entry = row(raw, 4);
    return entry ? { provider: str(entry[0]), modelId: str(entry[1]), modelName: str(entry[2]), api: str(entry[3]) } : undefined;
  });
  const buckets: StatsArchiveBucketV1[] = [];
  for (const raw of rawBuckets) {
    const entry = row(raw, 12);
    if (!entry) continue;
    const modelEntry = Number.isInteger(entry[2]) ? modelTable[entry[2] as number] : undefined;
    if (!modelEntry) continue;
    const bucket = parseArchiveBucket({
      globalEpoch: str(entry[0]),
      sessionHash: str(entry[1]),
      modelKey: `${modelEntry.provider}/${modelEntry.modelId}`,
      modelEpoch: str(entry[3]),
      day: str(entry[4]),
      provider: modelEntry.provider,
      modelId: modelEntry.modelId,
      modelName: modelEntry.modelName,
      api: modelEntry.api,
      updatedAt: entry[5],
      stats: {
        day: str(entry[6]), totalRequests: entry[7], hitRequests: entry[8], cachedInputTokens: entry[9],
        cacheWriteInputTokens: entry[10], totalInputTokens: entry[11],
      },
    });
    if (bucket) buckets.push(bucket);
  }
  const routed: StatsArchiveRoutedV1[] = [];
  for (const raw of rawRouted) {
    const entry = row(raw, 7);
    if (!entry) continue;
    const parsed = parseArchiveRouted({
      globalEpoch: str(entry[0]),
      sessionHash: str(entry[1]),
      day: str(entry[2]),
      updatedAt: entry[3],
      model: { provider: str(entry[4]), id: str(entry[5]), name: str(entry[6]) },
    });
    if (parsed) routed.push(parsed);
  }
  return {
    archive: {
      version: 1,
      kind: "pi-cache-optimizer-archive",
      updatedAt: isFiniteNumber(record.updatedAt) ? record.updatedAt : 0,
      absorbed,
      buckets,
      routed,
    },
    generation: record.generation as number,
    ...(isNonEmptyString(record.legacySha256) ? { legacySha256: record.legacySha256 } : {}),
  };
}

export function statsArchiveGenerationPath(archivePath: string, generation: number): string {
  return join(dirname(archivePath), `archive.${String(generation).padStart(12, "0")}.json`);
}

/** Published generations next to `archivePath`, ascending. */
export async function listStatsArchiveGenerations(archivePath: string = SHARD_ARCHIVE_PATH): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(dirname(archivePath));
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return [];
    throw error;
  }
  const generations: number[] = [];
  for (const name of names) {
    const match = GENERATION_FILE_PATTERN.exec(name);
    if (match) generations.push(Number(match[1]));
  }
  return generations.sort((a, b) => a - b);
}

function bucketToSyntheticShard(bucket: StatsArchiveBucketV1, index: number): PersistedStatsShardV7 {
  const shard = syntheticShardBase(`archive-bucket-${index}`, bucket.sessionHash, bucket.day, bucket.globalEpoch, bucket.updatedAt);
  shard.models[bucket.modelKey] = {
    modelEpoch: bucket.modelEpoch,
    provider: bucket.provider,
    modelId: bucket.modelId,
    ...(bucket.modelName ? { modelName: bucket.modelName } : {}),
    ...(bucket.api ? { api: bucket.api } : {}),
    stats: cloneCacheStats(bucket.stats),
  };
  return shard;
}

function routedToSyntheticShard(entry: StatsArchiveRoutedV1, index: number): PersistedStatsShardV7 {
  const shard = syntheticShardBase(`archive-routed-${index}`, entry.sessionHash, entry.day, entry.globalEpoch, entry.updatedAt);
  shard.lastRoutedModel = { ...entry.model };
  return shard;
}

function syntheticShardBase(id: string, sessionHash: string, day: string, globalEpoch: string, updatedAt: number): PersistedStatsShardV7 {
  return {
    version: 7,
    kind: "pi-cache-optimizer-shard",
    instanceId: id,
    sessionHash,
    process: { pid: 0, ppid: 0, instanceStartedAt: 0 },
    lifecycle: { state: "closed", createdAt: updatedAt, updatedAt, closedAt: updatedAt },
    day,
    globalEpoch,
    models: {},
  };
}

/**
 * Archive entries as synthetic closed shards: the reference semantics.
 * Aggregating these (after the raw shards) is what the archive must be
 * equivalent to; readers use StatsArchiveView's reduced forms instead.
 */
export function archiveToSyntheticShards(archive: StatsArchiveV1): PersistedStatsShardV7[] {
  return [
    ...archive.buckets.map(bucketToSyntheticShard),
    ...archive.routed.map(routedToSyntheticShard),
  ];
}

export type LoadedStatsArchive = {
  /** False when no archive exists; true for a parsed (or unreadable) one. */
  present: boolean;
  /** True when an archive exists but cannot be parsed; compaction then refuses to overwrite it. */
  corrupt: boolean;
  /** Generation this snapshot came from; 0 for 2.9.0's archive.json or no archive. */
  generation: number;
  archive: StatsArchiveV1;
  absorbedIds: ReadonlySet<string>;
  /** Every archive entry as a synthetic shard (reference form, built on first access). Do not mutate. */
  readonly shards: readonly PersistedStatsShardV7[];
};

type BucketGroup = {
  /** Index of the group's first bucket in the archive: groups keep the order of their first appearance. */
  order: number;
  globalEpoch: string;
  sessionHash: string;
  key: string;
  modelEpoch: string;
  /** The single bucket's own stats until a second bucket is merged (then a private copy). */
  stats: CacheStats;
  count: number;
  /** First bucket (in archive order) with the group's newest updatedAt. */
  bestUpdatedAt: number;
  bestIndex: number;
  /** Index of the first bucket an aggregation could record a ref from (updatedAt > -1); Infinity if none. */
  firstEligibleIndex: number;
};

type RoutedGroup = {
  globalEpoch: string;
  sessionHash: string;
  bestUpdatedAt: number;
  model: PersistedRoutedModelRef;
  /** Index of the first entry an aggregation could pick (updatedAt > -1); Infinity if none. */
  firstEligibleIndex: number;
};

/** One session's buckets folded per (globalEpoch, model, modelEpoch), and its routed entries per globalEpoch. */
type ReducedSession = {
  groups: BucketGroup[];
  routed: RoutedGroup[];
  /** Model keys with buckets in this session under each global epoch. */
  keysByGlobalEpoch: Map<string, Set<string>>;
};

/** Get (or create) the value for `key` in a nested map level. */
function slotOf<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) map.set(key, value = create());
  return value;
}

/**
 * One parsed archive snapshot, cached per file identity. Besides the raw
 * entries it lazily builds what a refresh needs: the per-day synthetic shards
 * for the current-day view (archived days are past days, so normally none)
 * and, per set of current epochs, the all-days aggregate pre-reduced to one
 * entry per (session, model).
 */
export class StatsArchiveView implements LoadedStatsArchive {
  readonly absorbedIds: ReadonlySet<string>;
  private syntheticShards?: PersistedStatsShardV7[];
  private dayIndex?: Map<string, { buckets: number[]; routed: number[] }>;
  private dayShards?: { day: string; shards: readonly PersistedStatsShardV7[] };
  private bySessionIndex?: { buckets: Map<string, number[]>; routed: Map<string, number[]> };
  private readonly reducedSessions = new Map<string, ReducedSession>();
  private contributionCache?: { fingerprint: string; contribution: ShardContribution };

  /** Highest generation listed, including unreadable ones above `generation`; the next publish targets newestGeneration + 1. */
  readonly newestGeneration: number;
  /** Unreadable generations above the one this snapshot came from (recovered from; quarantined by the next publish). */
  readonly corruptGenerations: readonly number[];
  /** The newest generation does not parse yet but is young: it may still be written in place (no-hard-link fallback). */
  readonly pendingGeneration: boolean;
  /** 2.9.0's file this snapshot was read from: archive.json, or a migration placeholder after an interrupted migration. */
  readonly legacySourcePath?: string;
  /** sha256 of the legacy source file's bytes (also set when it is unreadable, to verify it is unchanged before healing). */
  readonly legacySourceSha256?: string;
  /** No generation exists and 2.9.0's archive.json is unreadable: the next publish starts over and sets the file aside. */
  readonly legacyCorrupt: boolean;

  constructor(
    readonly archive: StatsArchiveV1,
    readonly present: boolean,
    readonly corrupt: boolean,
    readonly generation: number,
    /** For 2.9.0's archive.json: its sha256; for a generation: the legacy file it was migrated from. */
    readonly legacySha256?: string,
    recovery: {
      newestGeneration?: number;
      corruptGenerations?: readonly number[];
      pendingGeneration?: boolean;
      legacySourcePath?: string;
      legacySourceSha256?: string;
      legacyCorrupt?: boolean;
    } = {},
  ) {
    this.absorbedIds = new Set(Object.keys(archive.absorbed));
    this.newestGeneration = Math.max(generation, recovery.newestGeneration ?? 0);
    this.corruptGenerations = recovery.corruptGenerations ?? [];
    this.pendingGeneration = recovery.pendingGeneration ?? false;
    this.legacySourcePath = recovery.legacySourcePath;
    this.legacySourceSha256 = recovery.legacySourceSha256;
    this.legacyCorrupt = recovery.legacyCorrupt ?? false;
  }

  /** The same snapshot, recovered from below unreadable newer generations. */
  withRecovery(newestGeneration: number, corruptGenerations: readonly number[], pendingGeneration: boolean): StatsArchiveView {
    const key = JSON.stringify([newestGeneration, corruptGenerations, pendingGeneration]);
    if (this.recovered?.key === key) return this.recovered.view;
    const view = new StatsArchiveView(this.archive, this.present, this.corrupt, this.generation, this.legacySha256, {
      newestGeneration, corruptGenerations, pendingGeneration,
      legacySourcePath: this.legacySourcePath, legacySourceSha256: this.legacySourceSha256,
    });
    this.recovered = { key, view };
    return view;
  }
  private recovered?: { key: string; view: StatsArchiveView };

  get shards(): readonly PersistedStatsShardV7[] {
    return this.syntheticShards ??= archiveToSyntheticShards(this.archive);
  }

  /** The synthetic shards of `day`, in archive order. Do not mutate. */
  shardsForDay(day: string): readonly PersistedStatsShardV7[] {
    if (this.dayShards?.day === day) return this.dayShards.shards;
    if (!this.dayIndex) {
      this.dayIndex = new Map();
      const slot = (entryDay: string) => {
        let entry = this.dayIndex!.get(entryDay);
        if (!entry) {
          entry = { buckets: [], routed: [] };
          this.dayIndex!.set(entryDay, entry);
        }
        return entry;
      };
      this.archive.buckets.forEach((bucket, index) => slot(bucket.day).buckets.push(index));
      this.archive.routed.forEach((entry, index) => slot(entry.day).routed.push(index));
    }
    const indexes = this.dayIndex.get(day);
    const shards = indexes
      ? [
        ...indexes.buckets.map((index) => bucketToSyntheticShard(this.archive.buckets[index]!, index)),
        ...indexes.routed.map((index) => routedToSyntheticShard(this.archive.routed[index]!, index)),
      ]
      : [];
    this.dayShards = { day, shards };
    return shards;
  }

  /** Bucket and routed indexes per session: one pass, no per-entry key building. */
  private sessionIndex(): { buckets: Map<string, number[]>; routed: Map<string, number[]> } {
    if (this.bySessionIndex) return this.bySessionIndex;
    const buckets = new Map<string, number[]>();
    const routed = new Map<string, number[]>();
    const { buckets: archiveBuckets, routed: archiveRouted } = this.archive;
    for (let index = 0; index < archiveBuckets.length; index++) slotOf(buckets, archiveBuckets[index]!.sessionHash, () => []).push(index);
    for (let index = 0; index < archiveRouted.length; index++) slotOf(routed, archiveRouted[index]!.sessionHash, () => []).push(index);
    return this.bySessionIndex = { buckets, routed };
  }

  /**
   * One session's reduced form, built on first use. Groups are keyed by
   * nested maps (no JSON.stringify per bucket, no separator that a string
   * could contain), and only the sessions a refresh asks for are reduced.
   */
  private reduceSession(sessionHash: string): ReducedSession {
    const cached = this.reducedSessions.get(sessionHash);
    if (cached) return cached;
    const index = this.sessionIndex();
    const groups: BucketGroup[] = [];
    const groupIndex = new Map<string, Map<string, Map<string, BucketGroup>>>();
    const keysByGlobalEpoch = new Map<string, Set<string>>();
    for (const bucketIndex of index.buckets.get(sessionHash) ?? []) {
      const bucket = this.archive.buckets[bucketIndex]!;
      const byModelEpoch = slotOf(slotOf(groupIndex, bucket.globalEpoch, () => new Map()), bucket.modelKey, () => new Map<string, BucketGroup>());
      const group = byModelEpoch.get(bucket.modelEpoch);
      if (!group) {
        const created: BucketGroup = {
          order: bucketIndex,
          globalEpoch: bucket.globalEpoch,
          sessionHash: bucket.sessionHash,
          key: bucket.modelKey,
          modelEpoch: bucket.modelEpoch,
          stats: bucket.stats,
          count: 1,
          bestUpdatedAt: bucket.updatedAt,
          bestIndex: bucketIndex,
          firstEligibleIndex: bucket.updatedAt > -1 ? bucketIndex : Infinity,
        };
        byModelEpoch.set(bucket.modelEpoch, created);
        groups.push(created);
        slotOf(keysByGlobalEpoch, bucket.globalEpoch, () => new Set()).add(bucket.modelKey);
        continue;
      }
      if (group.count === 1) group.stats = cloneCacheStats(group.stats);
      mergeStatsAcrossDays(group.stats, bucket.stats, null);
      group.count++;
      if (group.firstEligibleIndex === Infinity && bucket.updatedAt > -1) group.firstEligibleIndex = bucketIndex;
      if (bucket.updatedAt > group.bestUpdatedAt) {
        group.bestUpdatedAt = bucket.updatedAt;
        group.bestIndex = bucketIndex;
      }
    }
    const routed: RoutedGroup[] = [];
    const routedIndex = new Map<string, RoutedGroup>();
    for (const entryIndex of index.routed.get(sessionHash) ?? []) {
      const entry = this.archive.routed[entryIndex]!;
      const group = routedIndex.get(entry.globalEpoch);
      const eligible = entry.updatedAt > -1 ? entryIndex : Infinity;
      if (!group) {
        const created: RoutedGroup = { globalEpoch: entry.globalEpoch, sessionHash: entry.sessionHash, bestUpdatedAt: entry.updatedAt, model: entry.model, firstEligibleIndex: eligible };
        routedIndex.set(entry.globalEpoch, created);
        routed.push(created);
        continue;
      }
      if (group.firstEligibleIndex === Infinity) group.firstEligibleIndex = eligible;
      if (entry.updatedAt > group.bestUpdatedAt) {
        group.bestUpdatedAt = entry.updatedAt;
        group.model = entry.model;
      }
    }
    const reduced: ReducedSession = { groups, routed, keysByGlobalEpoch };
    this.reducedSessions.set(sessionHash, reduced);
    return reduced;
  }

  /** The sessions a contribution covers: `only`, or every archived session. */
  private sessionsFor(only?: ReadonlySet<string>): Iterable<string> {
    if (only) return only;
    const index = this.sessionIndex();
    return new Set([...index.buckets.keys(), ...index.routed.keys()]);
  }

  /**
   * Every model key the archive's share of an all-days aggregate (of `only`,
   * when given) can look up an epoch for, under any global epoch: what a
   * refresh reads before aggregating synchronously.
   */
  contributionKeys(only?: ReadonlySet<string>): string[] {
    const keys = new Set<string>();
    for (const session of this.sessionsFor(only)) {
      for (const set of this.reduceSession(session).keysByGlobalEpoch.values()) for (const key of set) keys.add(key);
    }
    return Array.from(keys);
  }

  /**
   * The archive's share of an all-days aggregate under the aggregator's
   * epochs. Equivalent to adding `shards` (only those of `sessions`, when
   * given) at that point of the sequence; cached until an epoch, the
   * session selection, or the archive changes.
   */
  async contribution(aggregator: Pick<ShardAggregator, "globalEpoch" | "modelEpoch">, only?: ReadonlySet<string>): Promise<ShardContribution> {
    const keys = this.keysUnder(aggregator.globalEpoch, only);
    const epochs = new Map<string, string>();
    for (const key of keys) epochs.set(key, await aggregator.modelEpoch(key));
    return this.contributionSync({ globalEpoch: aggregator.globalEpoch, modelEpoch: (key) => epochs.get(key)! }, only);
  }

  /** Model keys of `only` (or all sessions) with buckets under `globalEpoch`, sorted. */
  private keysUnder(globalEpoch: string, only?: ReadonlySet<string>): string[] {
    const keys = new Set<string>();
    for (const session of this.sessionsFor(only)) {
      for (const key of this.reduceSession(session).keysByGlobalEpoch.get(globalEpoch) ?? []) keys.add(key);
    }
    return Array.from(keys).sort();
  }

  /** contribution() over epochs read beforehand (ShardEpochs must cover contributionKeys). */
  contributionSync(epochSource: ShardEpochs, only?: ReadonlySet<string>): ShardContribution {
    const globalEpoch = epochSource.globalEpoch;
    const keys = this.keysUnder(globalEpoch, only);
    const epochs = new Map<string, string>();
    for (const key of keys) epochs.set(key, epochSource.modelEpoch(key));
    const fingerprint = JSON.stringify([globalEpoch, ...keys.flatMap((key) => [key, epochs.get(key)]), only ? Array.from(only).sort() : null]);
    if (this.contributionCache?.fingerprint === fingerprint) return this.contributionCache.contribution;

    const groupList: BucketGroup[] = [];
    const routedList: RoutedGroup[] = [];
    for (const session of this.sessionsFor(only)) {
      const reduced = this.reduceSession(session);
      for (const group of reduced.groups) groupList.push(group);
      for (const group of reduced.routed) routedList.push(group);
    }
    // Groups of several sessions in the order of their first bucket (what a
    // full reduction in archive order produces).
    groupList.sort((a, b) => a.order - b.order);

    type SessionOut = { sessionHash: string; instances: number; models: Array<{ key: string; stats: CacheStats; instances: number }> };
    type ModelOut = { key: string; stats: CacheStats; instances: number; sessions: string[]; refUpdatedAt: number; refIndex: number; firstEligibleIndex: number };
    const sessions = new Map<string, SessionOut>();
    const models = new Map<string, ModelOut>();
    for (const group of groupList) {
      if (group.globalEpoch !== globalEpoch || group.modelEpoch !== epochs.get(group.key)) continue;
      let session = sessions.get(group.sessionHash);
      if (!session) sessions.set(group.sessionHash, session = { sessionHash: group.sessionHash, instances: 0, models: [] });
      session.models.push({ key: group.key, stats: group.stats, instances: group.count });
      session.instances += group.count;
      const model = models.get(group.key);
      if (!model) {
        models.set(group.key, {
          key: group.key,
          stats: cloneCacheStats(group.stats),
          instances: group.count,
          sessions: [group.sessionHash],
          refUpdatedAt: group.bestUpdatedAt,
          refIndex: group.bestIndex,
          firstEligibleIndex: group.firstEligibleIndex,
        });
        continue;
      }
      model.firstEligibleIndex = Math.min(model.firstEligibleIndex, group.firstEligibleIndex);
      mergeStatsAcrossDays(model.stats, group.stats, null);
      model.instances += group.count;
      model.sessions.push(group.sessionHash);
      // The sequential aggregation keeps the first shard with the newest updatedAt.
      if (group.bestUpdatedAt > model.refUpdatedAt || (group.bestUpdatedAt === model.refUpdatedAt && group.bestIndex < model.refIndex)) {
        model.refUpdatedAt = group.bestUpdatedAt;
        model.refIndex = group.bestIndex;
      }
    }
    const routed = routedList
      .filter((group) => group.globalEpoch === globalEpoch && group.firstEligibleIndex !== Infinity)
      .sort((a, b) => a.firstEligibleIndex - b.firstEligibleIndex)
      .map((group) => ({ sessionHash: group.sessionHash, updatedAt: group.bestUpdatedAt, model: group.model }));
    const contribution: ShardContribution = {
      sessions: Array.from(sessions.values()),
      models: Array.from(models.values(), ({ key, stats, instances, sessions: list }) => ({ key, stats, instances, sessions: list })),
      refs: Array.from(models.values())
        .filter((model) => model.firstEligibleIndex !== Infinity)
        .sort((a, b) => a.firstEligibleIndex - b.firstEligibleIndex)
        .map((model) => {
          const bucket = this.archive.buckets[model.refIndex]!;
          return { key: model.key, updatedAt: model.refUpdatedAt, ref: { provider: bucket.provider, id: bucket.modelId, name: bucket.modelName ?? bucket.modelId } };
        }),
      routed,
    };
    this.contributionCache = { fingerprint, contribution };
    return contribution;
  }
}

/**
 * Aggregate `leading` shards, then the archive, then `trailing` shards: the
 * same result as aggregateStatsShardsV7([...leading, ...archive.shards,
 * ...trailing], day), without materializing the archive. With `sessions`,
 * only shards of those sessions take part. The current-day view only sees
 * archive entries of that day; the all-days view merges the archive's
 * pre-reduced contribution.
 */
export async function aggregateStatsWithArchiveV7(
  leading: readonly PersistedStatsShardV7[],
  archive: StatsArchiveView,
  trailing: readonly PersistedStatsShardV7[] = [],
  day: string | null = currentLocalDay(),
  sessions?: ReadonlySet<string>,
): Promise<ShardAggregate> {
  const aggregator = await createShardAggregatorV7(day);
  const include = (shard: PersistedStatsShardV7) => !sessions || sessions.has(shard.sessionHash);
  for (const shard of leading) if (include(shard)) await aggregator.add(shard);
  if (day === null) aggregator.addContribution(await archive.contribution(aggregator, sessions));
  else for (const shard of archive.shardsForDay(day)) if (include(shard)) await aggregator.add(shard);
  for (const shard of trailing) if (include(shard)) await aggregator.add(shard);
  return aggregator.finish();
}

/**
 * aggregateStatsWithArchiveV7 over epochs read beforehand, without a single
 * await: a refresh commits it in the same synchronous step that builds its
 * trailing (in-memory) shard, so usage recorded meanwhile is never lost.
 */
export function aggregateStatsWithArchiveSync(
  leading: readonly PersistedStatsShardV7[],
  archive: StatsArchiveView,
  trailing: readonly PersistedStatsShardV7[],
  day: string | null,
  sessions: ReadonlySet<string> | undefined,
  epochs: ShardEpochs,
): ShardAggregate {
  const aggregator = createShardAggregatorSync(day, epochs);
  const include = (shard: PersistedStatsShardV7) => !sessions || sessions.has(shard.sessionHash);
  for (const shard of leading) if (include(shard)) aggregator.add(shard);
  if (day === null) aggregator.addContribution(archive.contributionSync(epochs, sessions));
  else for (const shard of archive.shardsForDay(day)) if (include(shard)) aggregator.add(shard);
  for (const shard of trailing) if (include(shard)) aggregator.add(shard);
  return aggregator.finish();
}

/** Every model key aggregateStatsWithArchiveSync may look up an epoch for (a superset). */
export function aggregateEpochKeys(
  leading: readonly PersistedStatsShardV7[],
  archive: StatsArchiveView,
  trailing: readonly PersistedStatsShardV7[],
  day: string | null,
  sessions: ReadonlySet<string> | undefined,
): Set<string> {
  const keys = new Set<string>();
  const include = (shard: PersistedStatsShardV7) => !sessions || sessions.has(shard.sessionHash);
  const addShard = (shard: PersistedStatsShardV7) => {
    if (include(shard)) for (const key of Object.keys(shard.models)) keys.add(key);
  };
  for (const shard of leading) addShard(shard);
  for (const shard of trailing) addShard(shard);
  if (day === null) for (const key of archive.contributionKeys(sessions)) keys.add(key);
  else for (const shard of archive.shardsForDay(day)) addShard(shard);
  return keys;
}

/** Test hooks for archive I/O races and faults; production never sets them. */
export type StatsArchiveTestHooks = {
  /** Runs after each directory listing a reader makes (to land a concurrent migration or publish in between). */
  afterList?: (archivePath: string) => void | Promise<void>;
  /** Runs before a reader's lstat of a generation or legacy file; throw to simulate a fault. */
  beforeLstat?: (path: string) => void | Promise<void>;
  /** Runs before a reader's readFile of a generation or legacy file; throw to simulate a fault. */
  beforeReadFile?: (path: string) => void | Promise<void>;
  /** Replaces link() when publishing (e.g. throw EPERM like a filesystem without hard links). */
  link?: (existingPath: string, newPath: string) => Promise<void>;
  /** Runs right after the no-hard-link fallback created a generation file exclusively, before writing it. */
  afterExclusiveCreate?: (target: string) => Promise<void>;
  /**
   * Runs between the steps of moving 2.9.0's archive.json aside (to land a
   * concurrent 2.9.0 write there): "moved-aside" right after archive.json was
   * renamed to its placeholder, before the tombstone directory is made;
   * "undo-removed-tombstone" when undoing, right after the tombstone was
   * removed, before the placeholder is put back.
   */
  afterMigrationStep?: (step: "moved-aside" | "undo-removed-tombstone", archivePath: string, placeholder: string) => Promise<void>;
  /** Overrides the maintenance heartbeat interval. */
  heartbeatMs?: number;
};
let testHooks: StatsArchiveTestHooks = {};
export function setStatsArchiveTestHooks(hooks: StatsArchiveTestHooks | undefined): void {
  testHooks = hooks ?? {};
}

type ArchiveListing = { generations: number[]; placeholders: string[] };

async function listArchiveDirectory(archivePath: string): Promise<ArchiveListing> {
  let names: string[];
  try {
    names = await statsReadFs().readdir(dirname(archivePath));
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return { generations: [], placeholders: [] };
    throw error;
  }
  const generations: number[] = [];
  const placeholders: string[] = [];
  for (const name of names) {
    const match = GENERATION_FILE_PATTERN.exec(name);
    if (match) generations.push(Number(match[1]));
    else if (MIGRATION_PLACEHOLDER_PATTERN.test(name)) placeholders.push(join(dirname(archivePath), name));
  }
  return { generations: generations.sort((a, b) => a - b), placeholders: placeholders.sort() };
}

/**
 * The newest of several migration placeholders, chosen deterministically.
 * Two exist only after a migration kept one for inspection (a 2.9.0 write
 * landed between its move and its mkdir) and a later one was interrupted
 * after its own move: the later one holds what 2.9.0 wrote after the first
 * was moved, so it is the one to read and migrate from (the older one is set
 * aside once a generation exists). Ordered by the time the file was moved
 * aside (in its name), or for 2.9.2's uuid-only names by its mtime (rename
 * keeps it; content 2.9.0 wrote after an earlier move is always newer than
 * that move), then by mtime, then by name. A file that disappeared sorts
 * first; the caller re-lists when it is gone.
 */
async function newestMigrationPlaceholder(placeholders: readonly string[]): Promise<string | undefined> {
  if (placeholders.length <= 1) return placeholders[0];
  const keyed = await Promise.all(placeholders.map(async (path) => {
    const info = await statsReadFs().lstat(path).catch((error) => {
      if (getErrorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    const mtime = info?.mtimeMs ?? -Infinity;
    const moved = MIGRATION_PLACEHOLDER_MOVED_AT_PATTERN.exec(path.slice(dirname(path).length + 1));
    return { path, time: info ? (moved ? Number(moved[1]) : mtime) : -Infinity, mtime };
  }));
  keyed.sort((a, b) => a.time - b.time || a.mtime - b.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return keyed.at(-1)!.path;
}

const SOURCE_ATTEMPTS = 6;
/** Retries (with these delays) of a transient lstat/read failure before a reader gives up on this refresh. */
const TRANSIENT_RETRY_DELAYS_MS = [15, 60, 150];
const TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "EACCES", "EAGAIN"]);
/**
 * A newest generation that does not parse and is younger than this may still
 * be being written in place (the no-hard-link fallback): compaction waits
 * instead of recovering past it. Readers always skip it.
 */
export const ARCHIVE_PENDING_GENERATION_MS = 10 * 60 * 1000;

type ParsedArchiveFile =
  | { kind: "ok"; view: StatsArchiveView }
  /** Not an archive this version can read (damaged, truncated, wrong generation). */
  | { kind: "invalid"; sha256: string }
  /** A well-formed archive in a newer format: never recovered past or overwritten. */
  | { kind: "unsupported" };

type CachedArchiveFile = StatsFileIdentity & { parsed: ParsedArchiveFile };
/** Parsed archive files by path (generations are immutable; archive.json is re-validated by identity). */
const archiveFileCache = new Map<string, CachedArchiveFile>();
/** The last good snapshot per archive path, served (stale) when a transient error persists. */
const lastGoodArchive = new Map<string, StatsArchiveView>();

export function clearStatsArchiveCache(): void {
  archiveFileCache.clear();
  lastGoodArchive.clear();
}

const emptyView = (): StatsArchiveView => new StatsArchiveView(emptyStatsArchive(0), false, false, 0);
const corruptView = (): StatsArchiveView => new StatsArchiveView(emptyStatsArchive(0), true, true, 0);

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseArchiveBytes(kind: "legacy" | "generation", generation: number, path: string, bytes: Buffer): ParsedArchiveFile {
  const invalid = (): ParsedArchiveFile => ({ kind: "invalid", sha256: sha256(bytes) });
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return invalid();
  }
  const record = asRecord(value);
  const supported = kind === "legacy" ? 1 : 2;
  if (record?.kind === "pi-cache-optimizer-archive" && isFiniteNumber(record.version) && record.version > supported) {
    return { kind: "unsupported" };
  }
  if (kind === "legacy") {
    const archive = parseStatsArchive(value);
    const sha = sha256(bytes);
    return archive
      ? { kind: "ok", view: new StatsArchiveView(archive, true, false, 0, sha, { legacySourcePath: path, legacySourceSha256: sha }) }
      : invalid();
  }
  const parsed = parseStatsArchiveV2(value);
  if (!parsed || parsed.generation !== generation) return invalid();
  return { kind: "ok", view: new StatsArchiveView(parsed.archive, true, false, parsed.generation, parsed.legacySha256) };
}

class ArchiveRestart extends Error {}

/**
 * A retry delay. Deliberately not unref'd: the read is awaited by a Pi
 * handler (agent_settled, model_select, session_shutdown...), and in print
 * mode an unref'd delay lets the event loop drain mid-handler, so Pi exits
 * without session_shutdown (see renameWithRetry).
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type ReadStatsArchiveOptions = {
  /** Throw on a transient I/O failure instead of serving the last good snapshot (compaction). */
  strict?: boolean;
};

export type StatsArchiveRead = {
  view: StatsArchiveView;
  /**
   * True when a transient I/O failure persisted and `view` is the last good
   * snapshot (or an empty corrupt one): it may be older than a directory
   * listing taken just before. See readStatsSnapshot.
   */
  stale: boolean;
};

/**
 * Read the newest usable archive snapshot.
 *
 * - The highest generation wins. A generation that is not a readable
 *   archive (damaged on disk, truncated by a crash of the in-place fallback,
 *   not a regular file) is skipped for the next lower one: every published
 *   generation is self-consistent (its counters cover exactly the raw shards
 *   it lists as absorbed), so falling back never double counts; it only
 *   misses what the unreadable one absorbed and already deleted. The next
 *   compaction publishes above it and quarantines it. A generation in a newer
 *   format is never skipped: it is reported as corrupt, like before.
 * - Without generations, 2.9.0's archive.json (or a migration placeholder
 *   left by an interrupted migration) is read. An unreadable archive.json is
 *   treated as empty, and the next compaction starts over from it.
 * - A file that disappears between listing and reading (superseded and
 *   removed, or migrated) makes the reader list again, as does a missing or
 *   directory archive.json, which a migration in progress produces.
 * - Transient errors (Windows EPERM/EBUSY while a scanner holds a file) are
 *   retried briefly; if they persist, the last good snapshot is served and
 *   flagged stale (never cached as an empty archive).
 */
export async function readStatsArchiveDetailed(archivePath: string = SHARD_ARCHIVE_PATH, options: ReadStatsArchiveOptions = {}): Promise<StatsArchiveRead> {
  let transientRetries = 0;
  let lastError: unknown;
  for (let attempt = 0; attempt < SOURCE_ATTEMPTS + TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const view = await locateAndReadArchive(archivePath, options, attempt);
      if (view === undefined) continue;
      if (!view.corrupt) lastGoodArchive.set(archivePath, view);
      else lastGoodArchive.delete(archivePath);
      return { view, stale: false };
    } catch (error) {
      if (error instanceof ArchiveRestart) continue;
      lastError = error;
      if (TRANSIENT_CODES.has(getErrorCode(error) ?? "") && transientRetries < TRANSIENT_RETRY_DELAYS_MS.length) {
        await sleep(TRANSIENT_RETRY_DELAYS_MS[transientRetries++]!);
        continue;
      }
      break;
    }
  }
  lastError ??= new Error(`stats archive ${archivePath} kept changing while being read`);
  if (options.strict) throw lastError;
  return { view: lastGoodArchive.get(archivePath) ?? corruptView(), stale: true };
}

/**
 * One attempt. Resolves undefined (or throws ArchiveRestart) to list again;
 * throws other errors for the caller's transient policy.
 */
async function locateAndReadArchive(archivePath: string, options: ReadStatsArchiveOptions, attempt: number): Promise<StatsArchiveView | undefined> {
  const listing = await listArchiveDirectory(archivePath);
  await testHooks.afterList?.(archivePath);
  const restartIfNewer = async (generation: number, error: unknown): Promise<never> => {
    const code = getErrorCode(error);
    // Superseded and removed (or migrated) between listing and reading.
    if (code === "ENOENT") throw new ArchiveRestart();
    // On Windows, opening or stat-ing a generation that is being deleted
    // while someone holds it open fails with EPERM; a newer one exists then.
    if (generation > 0) {
      const newest = await listArchiveDirectory(archivePath).then((l) => l.generations.at(-1), () => undefined);
      if (newest !== undefined && newest > generation) throw new ArchiveRestart();
    }
    throw error;
  };
  if (listing.generations.length > 0) {
    const newest = listing.generations.at(-1)!;
    const corrupt: number[] = [];
    let pending = false;
    for (let index = listing.generations.length - 1; index >= 0; index--) {
      const generation = listing.generations[index]!;
      const path = statsArchiveGenerationPath(archivePath, generation);
      const parsed = await readArchiveFile(path, "generation", generation, options, restartIfNewer);
      if (parsed === undefined || parsed.parsed.kind === "invalid") {
        const age = parsed ? Date.now() - parsed.mtimeMs : Infinity;
        if (generation === newest && Math.abs(age) < ARCHIVE_PENDING_GENERATION_MS) pending = true;
        corrupt.unshift(generation);
        continue;
      }
      if (parsed.parsed.kind === "unsupported") return corruptView();
      const view = parsed.parsed.view;
      return corrupt.length > 0 ? view.withRecovery(newest, corrupt, pending) : view;
    }
    // No generation is readable: start over from an empty archive. Raw
    // shards the unreadable generations absorbed but did not delete yet are
    // counted raw again (their ids are no longer known to be absorbed).
    return new StatsArchiveView(emptyStatsArchive(0), false, false, 0, undefined, { newestGeneration: newest, corruptGenerations: corrupt, pendingGeneration: pending });
  }

  // No generation: 2.9.0's archive.json, or a placeholder of an interrupted migration.
  let info: import("node:fs").Stats | undefined;
  try {
    await testHooks.beforeLstat?.(archivePath);
    info = await statsReadFs().lstat(archivePath);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
  if (info?.isFile() && !info.isSymbolicLink()) {
    const parsed = await readArchiveFile(archivePath, "legacy", 0, options, restartIfNewer);
    if (!parsed) throw new ArchiveRestart();
    if (parsed.parsed.kind === "ok") return parsed.parsed.view;
    if (parsed.parsed.kind === "unsupported") return corruptView();
    return legacyCorruptView(archivePath, parsed.parsed.sha256);
  }
  if (info && !info.isDirectory()) return legacyCorruptView(archivePath, undefined);
  const placeholder = await newestMigrationPlaceholder(listing.placeholders);
  if (placeholder) {
    const parsed = await readArchiveFile(placeholder, "legacy", 0, options, restartIfNewer);
    if (!parsed) throw new ArchiveRestart();
    if (parsed.parsed.kind === "ok") return parsed.parsed.view;
    if (parsed.parsed.kind === "unsupported") return corruptView();
    return legacyCorruptView(placeholder, parsed.parsed.sha256);
  }
  // archive.json is missing or is the migration tombstone, which exists only
  // once a generation does (or while a migration moves archive.json aside):
  // the listing raced a migration or a cleanup. List again before concluding
  // there is no archive.
  if (attempt < 2) return undefined;
  return emptyView();
}

function legacyCorruptView(path: string, sha: string | undefined): StatsArchiveView {
  return new StatsArchiveView(emptyStatsArchive(0), true, false, 0, undefined, { legacySourcePath: path, legacySourceSha256: sha, legacyCorrupt: true });
}

/** lstat + cached parse of one archive file; undefined when it is not a regular file. */
async function readArchiveFile(
  path: string,
  kind: "legacy" | "generation",
  generation: number,
  options: ReadStatsArchiveOptions,
  onError: (generation: number, error: unknown) => Promise<never>,
): Promise<{ parsed: ParsedArchiveFile; mtimeMs: number } | undefined> {
  let info: import("node:fs").Stats;
  try {
    await testHooks.beforeLstat?.(path);
    info = await statsReadFs().lstat(path);
  } catch (error) {
    return onError(generation, error);
  }
  if (!info.isFile() || info.isSymbolicLink()) return undefined;
  const cached = archiveFileCache.get(path);
  // Generations are immutable, so their identity is a safe cache key. 2.9.0
  // rewrites archive.json in place, and on filesystems with ino 0 and coarse
  // mtimes (FAT/SMB on Windows) a rewrite of the same size may keep the same
  // identity. Compaction migrates from it and then deletes shards, so it
  // always re-reads that file instead of trusting the cache.
  const cacheable = !(options.strict && kind === "legacy");
  if (cacheable && cached && sameStatsFileIdentity(cached, info)) return { parsed: cached.parsed, mtimeMs: info.mtimeMs };
  let bytes: Buffer;
  try {
    await testHooks.beforeReadFile?.(path);
    bytes = await statsReadFs().readFile(path);
  } catch (error) {
    archiveFileCache.delete(path);
    return onError(generation, error);
  }
  const parsed = parseArchiveBytes(kind, generation, path, bytes);
  // A young unparseable generation may still be written in place: do not
  // cache it. An old one stays unreadable until compaction quarantines it
  // (possibly hours later); cache it like any other file so readers do not
  // re-read and re-parse it on every refresh. Completing a write would
  // change its size, so the identity check still notices that.
  const young = Math.abs(Date.now() - info.mtimeMs) < ARCHIVE_PENDING_GENERATION_MS;
  if (!(parsed.kind === "invalid" && kind === "generation" && young)) archiveFileCache.set(path, { ...statsFileIdentityOf(info), parsed });
  else archiveFileCache.delete(path);
  if (archiveFileCache.size > 16) {
    for (const key of archiveFileCache.keys()) {
      if (archiveFileCache.size <= 16) break;
      if (key !== path) archiveFileCache.delete(key);
    }
  }
  return { parsed, mtimeMs: info.mtimeMs };
}

/** Read the newest archive snapshot (see readStatsArchiveDetailed). */
export async function readStatsArchiveView(archivePath: string = SHARD_ARCHIVE_PATH, options: ReadStatsArchiveOptions = {}): Promise<StatsArchiveView> {
  return (await readStatsArchiveDetailed(archivePath, options)).view;
}

export type StatsSnapshot = { rawShards: readonly PersistedStatsShardV7[]; archive: StatsArchiveView };

/** A snapshot can reuse its archive without stat-ing it: see readStatsArchiveForRefresh. */
function isReusableArchiveView(view: StatsArchiveView): boolean {
  return view.present && !view.corrupt && view.generation > 0 && view.corruptGenerations.length === 0 &&
    !view.pendingGeneration && view.newestGeneration === view.generation;
}

/**
 * readStatsArchiveDetailed for a footer refresh that holds the previous
 * snapshot's view. Generation files are immutable (published by link or by
 * an exclusive create that only counts once complete; never rewritten), so
 * while the newest listed generation is the one `previous` was read from
 * and that view is a clean read of it, the listing alone confirms it and the
 * file is not stat-ed again. Every other state goes through the full read
 * exactly as before: 2.9.0's archive.json (generation 0, rewritten in place
 * by 2.9.0) and migration placeholders, a newest generation that is still
 * pending (written in place) or unreadable (the view recovered below it), or
 * a newer generation.
 */
export async function readStatsArchiveForRefresh(previous: StatsArchiveView | undefined, archivePath: string = SHARD_ARCHIVE_PATH): Promise<StatsArchiveRead & { reused: boolean }> {
  if (previous && isReusableArchiveView(previous)) {
    let newest: number | undefined;
    try {
      newest = (await listArchiveDirectory(archivePath)).generations.at(-1);
      await testHooks.afterList?.(archivePath);
    } catch {
      newest = undefined;
    }
    if (newest !== undefined && newest === previous.generation) return { view: previous, stale: false, reused: true };
  }
  return { ...(await readStatsArchiveDetailed(archivePath)), reused: false };
}

export type ReadStatsSnapshotOptions = {
  /**
   * The shard phase. Defaults to readValidStatsShardsV7 (stat every file).
   * Whatever it is, it must have finished every read (listing, lstat and
   * readFile) before it resolves: the archive is only listed afterwards.
   */
  readShards?: () => Promise<readonly PersistedStatsShardV7[]>;
  /** Confirm an unchanged clean generation by its listing alone (readStatsArchiveForRefresh). */
  reuseArchive?: boolean;
};

/**
 * The raw shards and the archive as one consistent snapshot. Order matters:
 * compaction publishes the archive before deleting the shards it absorbed,
 * so reading the directory first and the archive second always sees each
 * absorbed shard in at least one of them. When the archive read hit a
 * persistent transient error and served the last good snapshot, that
 * snapshot may predate shards deleted since; pairing it with the fresh
 * listing would undercount, so the previous snapshot is reused as a whole
 * (it was consistent when read) when it holds that same archive. The
 * previous snapshot's rawShards are the shard contents read then (shared,
 * immutable objects), not names to look up again.
 */
export async function readStatsSnapshot(
  previous?: StatsSnapshot,
  directory: string = SHARD_FILES_DIR,
  archivePath: string = SHARD_ARCHIVE_PATH,
  options: ReadStatsSnapshotOptions = {},
): Promise<StatsSnapshot> {
  // Shard phase first, complete (every lstat and readFile), then the archive.
  const rawShards = options.readShards ? await options.readShards() : await readValidStatsShardsV7(directory);
  const { view, stale } = options.reuseArchive
    ? await readStatsArchiveForRefresh(previous?.archive, archivePath)
    : await readStatsArchiveDetailed(archivePath);
  if (stale && previous && previous.archive === view) {
    // Only a newer generation can have deleted shards this archive misses.
    // While it is still the newest one (highest generations never go back:
    // only lower ones are removed, and an unreadable newest one only once a
    // higher one exists), the fresh listing pairs with it consistently, so
    // a persistent error on its file does not freeze everyone else's shards.
    if (!view.corrupt && view.generation > 0 && view.corruptGenerations.length === 0) {
      const newest = await listStatsArchiveGenerations(archivePath).then((generations) => generations.at(-1), () => undefined);
      if (newest === view.generation) return { rawShards, archive: view };
    }
    return previous;
  }
  return { rawShards, archive: view };
}

/** Reference-form read (used by tests and tools): the snapshot with synthetic shards available. */
export async function readStatsArchive(archivePath: string = SHARD_ARCHIVE_PATH, options: ReadStatsArchiveOptions = {}): Promise<LoadedStatsArchive> {
  return readStatsArchiveView(archivePath, options);
}

/** Remove archive temp files a crash left behind (shard cleanup only covers shards/). */
async function cleanupStaleArchiveTemps(archivePath: string, now: number): Promise<void> {
  const directory = dirname(archivePath);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".tmp")) continue;
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink() && now - info.mtimeMs >= SHARD_TEMP_RETENTION_MS) await unlink(path);
    } catch {}
  }
}

/** Identity of whatever sits at 2.9.0's archive.json path (undefined when nothing does). */
async function legacyArchiveIdentity(archivePath: string): Promise<string | undefined> {
  try {
    const info = await lstat(archivePath);
    return JSON.stringify([String(info.ino), info.size, info.mtimeMs, info.isFile()]);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Test hooks for the publish protocol; production never sets them. */
export type ArchivePublishHooks = {
  /** Runs after every publish check passed, right before the new generation becomes visible (and before a migration moves archive.json). */
  beforeCommit?: () => Promise<void>;
};

/** Flush a directory entry change (link, rename) to stable storage where the platform supports it. */
async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return; // directories cannot be opened for fsync there
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {}
}

/** link() failures that mean "this filesystem has no hard links" (FAT/exFAT, some NAS/SMB mounts). */
const NO_HARDLINK_CODES = new Set(["EPERM", "ENOTSUP", "EINVAL"]);

/** A snapshot written and flushed to a private temp file, ready to be published. */
type PreparedGeneration = { target: string; tempPath: string; text: string };

async function prepareStatsArchiveGeneration(archivePath: string, generation: number, text: string): Promise<PreparedGeneration> {
  await mkdir(dirname(archivePath), { recursive: true });
  const target = statsArchiveGenerationPath(archivePath, generation);
  const tempPath = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tempPath, "wx");
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  return { target, tempPath, text };
}

/**
 * Publish a prepared generation atomically and exclusively: hard-link the
 * flushed temp file to its final name. link() fails with EEXIST when that
 * generation already exists, on Windows and POSIX alike, so of all writers
 * that read generation N exactly one can publish N+1. Resolves false when
 * another writer won.
 *
 * Without hard links (link fails with EPERM/ENOTSUP/EINVAL), the generation
 * is created exclusively in place (O_EXCL, the same compare-and-swap) and
 * written and flushed there. Until it is complete it does not parse, so
 * readers skip it for the previous generation, and compaction treats a
 * young unparseable newest generation as still being written. The writer
 * deletes raw shards only after it completed, so nothing is counted twice
 * or lost at any point; a crash mid-write leaves an unreadable generation
 * that the next pass recovers past.
 */
async function commitPreparedGeneration(prepared: PreparedGeneration): Promise<boolean> {
  try {
    await (testHooks.link ?? link)(prepared.tempPath, prepared.target);
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "EEXIST") return false;
    if (!NO_HARDLINK_CODES.has(code ?? "")) throw error;
    let handle;
    try {
      handle = await open(prepared.target, "wx");
    } catch (openError) {
      if (getErrorCode(openError) === "EEXIST") return false;
      throw openError;
    }
    try {
      await testHooks.afterExclusiveCreate?.(prepared.target);
      await handle.writeFile(prepared.text, "utf8");
      await handle.sync();
    } catch (writeError) {
      await handle.close().catch(() => undefined);
      // Ours (created exclusively) and incomplete: never leave it published.
      await unlink(prepared.target).catch(() => undefined);
      throw writeError;
    }
    await handle.close();
  }
  await fsyncDirectory(dirname(prepared.target));
  return true;
}

/**
 * Drop generations older than the one before `current`. The previous one is
 * kept for readers that listed the directory just before `current` appeared;
 * a reader that still finds its file gone re-lists and reads a newer one.
 */
async function removeSupersededGenerations(archivePath: string, current: number): Promise<void> {
  for (const generation of await listStatsArchiveGenerations(archivePath).catch(() => [] as number[])) {
    if (generation >= current - 1) continue;
    await unlink(statsArchiveGenerationPath(archivePath, generation)).catch(() => undefined);
  }
}

/** Move an unreadable generation out of the generation namespace, keeping it for inspection. */
async function quarantineGeneration(archivePath: string, generation: number): Promise<void> {
  const path = statsArchiveGenerationPath(archivePath, generation);
  const kept = path.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
  try {
    await renameWithRetry(path, kept);
    console.warn(`${LOG_PREFIX}: stats archive generation ${generation} was unreadable; recovered from the previous one and kept it as ${kept}`);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") await unlink(path).catch(() => undefined);
  }
}

/** Retry budget for moving 2.9.0's archive.json (a scanner may hold it for seconds). */
export const LEGACY_ARCHIVE_RENAME_BUDGET_MS = 5_000;

const LEGACY_TOMBSTONE_README =
  "pi-cache-optimizer stores its stats archive in the archive.<generation>.json files next to this directory.\n" +
  "This directory replaces the single archive.json of version 2.9.0 so that 2.9.0 can no longer write it\n" +
  "(it would publish without a compare-and-swap). 2.9.0 reports the archive as unreadable and keeps raw shards.\n" +
  "Do not remove it while any Pi process might still run pi-cache-optimizer 2.9.0.\n";

async function createLegacyTombstone(archivePath: string): Promise<void> {
  await mkdir(archivePath);
  await writeFile(join(archivePath, "README.txt"), LEGACY_TOMBSTONE_README, "utf8").catch(() => undefined);
}

/** Keep a legacy file that is not part of any generation, for inspection. */
async function setAsideLegacyFile(path: string, reason: string): Promise<void> {
  let stamp = Date.now();
  let kept = join(dirname(path), `archive.legacy-${stamp}.json`);
  while (await lstat(kept).then(() => true, () => false)) kept = join(dirname(path), `archive.legacy-${++stamp}.json`);
  await renameWithRetry(path, kept, LEGACY_ARCHIVE_RENAME_BUDGET_MS).catch(() => undefined);
  console.warn(`${LOG_PREFIX}: ${reason}; kept as ${kept}`);
}

/**
 * Whenever generations exist, make sure 2.9.0 cannot write archive.json:
 * move a file there aside and put a directory in its place, and resolve
 * migration placeholders. A file whose content is the one the newest
 * generation was migrated from is simply deleted. Anything else is never
 * counted, because merging it could double count, and is kept for
 * inspection: a file 2.9.0 wrote after the migration (only possible if the
 * directory was removed), or a placeholder of a migration that another
 * compactor overtook.
 */
async function ensureLegacyArchiveTombstone(archivePath: string, migratedFromSha256: string | undefined): Promise<void> {
  const resolve = async (path: string): Promise<void> => {
    let sha: string | undefined;
    try {
      sha = sha256(await readFile(path));
    } catch {}
    if (sha !== undefined && sha === migratedFromSha256) await unlink(path).catch(() => undefined);
    else await setAsideLegacyFile(path, "ignored a stats archive of an older pi-cache-optimizer that is not part of the current archive");
  };
  const listing = await listArchiveDirectory(archivePath).catch(() => undefined);
  for (const placeholder of listing?.placeholders ?? []) await resolve(placeholder);

  let info: import("node:fs").Stats | undefined;
  try {
    info = await lstat(archivePath);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") return;
  }
  if (info?.isDirectory()) return;
  if (info) {
    const retired = `${archivePath}.${process.pid}.${randomUUID()}.retired.tmp`;
    try {
      await renameWithRetry(archivePath, retired, LEGACY_ARCHIVE_RENAME_BUDGET_MS);
    } catch {
      return; // retried by the next pass; readers ignore archive.json once a generation exists
    }
    await resolve(retired);
  }
  await createLegacyTombstone(archivePath).catch(() => undefined);
}

/**
 * Migration step, run after every publish check passed and before the first
 * generation is linked: move 2.9.0's archive.json aside to a placeholder,
 * put the tombstone directory in its place, and verify that the moved bytes
 * are exactly the snapshot this pass built on.
 *
 * The rename is atomic, so a 2.9.0 process that took the lock over while this
 * pass was suspended and republished archive.json is caught here (the bytes
 * differ: the move is undone and the next pass migrates its file), instead
 * of having its newly absorbed counters set aside after the fact. Once the
 * directory is in place, 2.9.0 sees an unreadable archive and neither
 * compacts nor deletes. If this pass dies before linking, readers and the
 * next compaction migrate from the placeholder.
 *
 * Resolves false when the migration must be retried by a later pass.
 */
async function moveLegacyArchiveAside(archivePath: string, base: StatsArchiveView): Promise<boolean> {
  const source = base.legacySourcePath;
  if (!source) return true;
  const expected = base.legacySourceSha256;
  let placeholder = source;
  if (source === archivePath) {
    placeholder = migrationPlaceholderPath(archivePath);
    try {
      await renameWithRetry(archivePath, placeholder, LEGACY_ARCHIVE_RENAME_BUDGET_MS);
    } catch {
      return false;
    }
    await testHooks.afterMigrationStep?.("moved-aside", archivePath, placeholder);
  }
  try {
    await createLegacyTombstone(archivePath);
  } catch (error) {
    if (getErrorCode(error) !== "EEXIST") return false;
    const info = await lstat(archivePath).catch(() => undefined);
    // Another 2.9.0 publish landed between the move and the mkdir. Its file
    // replaces the one moved aside (it read it first, or started over): keep
    // it as the archive and keep the placeholder only for inspection.
    if (!info?.isDirectory()) return false;
  }
  let sha: string | undefined;
  try {
    sha = sha256(await readFile(placeholder));
  } catch {}
  if (expected === undefined ? !base.legacyCorrupt : sha !== expected) {
    // 2.9.0 republished between this pass's read and the move: undo, so the
    // next pass migrates the newer file.
    await rm(archivePath, { recursive: true, force: true }).catch(() => undefined);
    await testHooks.afterMigrationStep?.("undo-removed-tombstone", archivePath, placeholder);
    await restoreLegacyArchive(placeholder, archivePath);
    return false;
  }
  await fsyncDirectory(dirname(archivePath));
  return true;
}

/**
 * Undo a move aside: put the placeholder back as archive.json without ever
 * replacing a file there. Between removing the tombstone and this step a
 * 2.9.0 process (holding the lock after a stale takeover) may already have
 * published archive.json again; a rename would silently overwrite it, losing
 * what it absorbed (its raw shards are already deleted). link() is a
 * compare-and-swap: EEXIST keeps 2.9.0's newer file as the archive and keeps
 * the placeholder for inspection (set aside once a generation exists, never
 * counted, so nothing is counted twice). Without hard links the rename is
 * the only way back (the window stays open on such filesystems).
 */
async function restoreLegacyArchive(placeholder: string, archivePath: string): Promise<void> {
  try {
    await (testHooks.link ?? link)(placeholder, archivePath);
  } catch (error) {
    if (getErrorCode(error) === "EEXIST") return;
    await renameWithRetry(placeholder, archivePath, LEGACY_ARCHIVE_RENAME_BUDGET_MS).catch(() => undefined);
    return;
  }
  // Both names are the same file now; drop the placeholder. If that fails it
  // is resolved later (its bytes are the ones the next migration reads).
  await unlink(placeholder).catch(() => undefined);
}

/** Instance ids of every shard-named file in `directory`, readable or not. */
async function listShardInstanceIds(directory: string): Promise<Set<string>> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return new Set();
    throw error;
  }
  return new Set(names.filter((name) => /^[0-9a-f-]+\.json$/i.test(name)).map((name) => name.slice(0, -".json".length)));
}

/**
 * A local day can still be "today" for a Pi process in another time zone
 * (up to UTC+14 and down to UTC-12) until 12:00 UTC of the next day, i.e.
 * 36 hours after its UTC midnight. Archived buckets merge shards (instance
 * counts become bucket counts) and only feed the current-day view of their
 * own day, so a day is archived only once it is over everywhere: then no
 * process's current-day view (totals, instance counts) can differ from the
 * raw shards it replaces.
 */
const DAY_OVER_EVERYWHERE_MS = 36 * 60 * 60 * 1000;

function dayIsOverEverywhere(day: string, now: number): boolean {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return now >= Date.UTC(year, month - 1, date) + DAY_OVER_EVERYWHERE_MS;
}

/** A shard maintenance may fold away: from a past day and no longer written to. */
export function isArchivableShard(shard: PersistedStatsShardV7, now: number, today: string): boolean {
  if (shard.day >= today || !dayIsOverEverywhere(shard.day, now)) return false;
  // Usage recorded after midnight but before the day rollover carries the
  // next day in stats.day. The current-day view skips such an entry on
  // either day, but a merged bucket keeps only the latest stats.day and
  // could hide its whole bucket from that day's view; such rare shards stay
  // raw (retention removes them).
  for (const entry of Object.values(shard.models)) if (entry.stats.day !== shard.day) return false;
  if (now - shard.lifecycle.updatedAt >= SHARD_RETENTION_MS) return false; // retention deletes it instead
  if (shard.lifecycle.state === "closed") return true;
  return now - shard.lifecycle.updatedAt >= ARCHIVE_ABANDONED_ACTIVE_MS && !isProcessAlive(shard.process.pid);
}

export type CompactionResult = {
  /** Raw shards newly folded into the archive. */
  absorbed: number;
  /** Raw shard files deleted (newly or previously absorbed). */
  removed: number;
  /** Archive entries dropped for an old epoch or past retention. */
  dropped: number;
  /** True when an unreadable archive blocked compaction. */
  skippedCorrupt: boolean;
  /**
   * True when the archive, an epoch, or lock ownership changed while this
   * pass ran (e.g. a stale-lock takeover or a concurrent reset), or another
   * compactor published a newer generation first. No raw shard was deleted
   * and no visible archive was replaced; the next pass retries.
   */
  skippedConcurrent: boolean;
  /** Generation this pass published, when it published one. */
  generation?: number;
};

export type CompactionOptions = {
  /** Owner token from acquireStatsMaintenanceLock; ownership is re-checked before publishing. */
  lockToken?: string;
  /** Test hook: runs after the plan is built, right before the publish checks. */
  beforePublish?: () => Promise<void>;
} & ArchivePublishHooks;

/**
 * Buckets expire by their newest folded shard. Shards of one day can be
 * closed much later (an idle process closes yesterday's shard at its next
 * rollover, possibly weeks later), so buckets are also split by the UTC day
 * of `updatedAt`. Otherwise the earliest shard would outlive its own 60-day
 * retention by as long as the latest one, and archived totals would exceed
 * what the raw shards would have shown. The remaining error is under a day.
 */
const ARCHIVE_EXPIRY_GRANULARITY_MS = 24 * 60 * 60 * 1000;
const bucketId = (b: Pick<StatsArchiveBucketV1, "globalEpoch" | "sessionHash" | "modelKey" | "modelEpoch" | "day" | "updatedAt">): string =>
  JSON.stringify([b.globalEpoch, b.sessionHash, b.modelKey, b.modelEpoch, b.day, Math.floor(b.updatedAt / ARCHIVE_EXPIRY_GRANULARITY_MS)]);
const routedId = (r: Pick<StatsArchiveRoutedV1, "globalEpoch" | "sessionHash">): string =>
  JSON.stringify([r.globalEpoch, r.sessionHash]);

/**
 * Fold archivable shards into the archive, then delete them. Call only while
 * holding the maintenance lock. Order matters for crash safety: the archive
 * (with the absorbed ids) is published before any raw shard is deleted, and
 * only by a pass whose generation is the newest one.
 */
export async function compactStatsShardsV7(
  now = Date.now(),
  directory: string = SHARD_FILES_DIR,
  archivePath: string = SHARD_ARCHIVE_PATH,
  options: CompactionOptions = {},
): Promise<CompactionResult> {
  const result: CompactionResult = { absorbed: 0, removed: 0, dropped: 0, skippedCorrupt: false, skippedConcurrent: false };
  await cleanupStaleArchiveTemps(archivePath, now);
  // Taken before the read so a 2.9.0 write racing it is noticed below.
  const legacyIdentityAtRead = await legacyArchiveIdentity(archivePath);
  // The snapshot this pass builds on. Generations are immutable, so the
  // readers' cached parse is safe to reuse; the publish below is a
  // compare-and-swap against exactly this generation.
  const base = await readStatsArchiveView(archivePath, { strict: true });
  if (base.corrupt) {
    // A newer format this version cannot read: never overwrite it.
    result.skippedCorrupt = true;
    return result;
  }
  if (base.pendingGeneration) {
    // The newest generation does not parse yet and is young: it may still be
    // written in place (no-hard-link fallback) by a holder that lost the
    // lock. Retry later rather than recover past it.
    result.skippedConcurrent = true;
    return result;
  }
  // 2.9.0's archive.json (readable or not): publish the first generation
  // even when nothing else changed, so 2.9.0 can be locked out of writing
  // it. Unreadable generations: publish above them so they are recovered
  // from and quarantined.
  const migrating = base.newestGeneration === 0 && base.legacySourcePath !== undefined;
  const healing = base.corruptGenerations.length > 0;
  const previous = base.archive;
  const today = currentLocalDay();
  // Strict reads: compaction permanently drops counters whose epoch differs,
  // so an unreadable epoch file must abort instead of falling back to the
  // initial epoch (which would discard every archived and absorbed counter).
  const globalEpoch = await readGlobalStatsEpochStrict();
  const modelEpochs = new Map<string, string>();
  const currentModelEpoch = async (key: string): Promise<string> => {
    let epoch = modelEpochs.get(key);
    if (!epoch) {
      epoch = await readModelStatsEpochStrict(key);
      modelEpochs.set(key, epoch);
    }
    return epoch;
  };

  // Carry forward live entries; drop ones a reset or retention invalidated.
  const buckets = new Map<string, StatsArchiveBucketV1>();
  for (const bucket of previous.buckets) {
    if (
      bucket.globalEpoch !== globalEpoch ||
      bucket.modelEpoch !== await currentModelEpoch(bucket.modelKey) ||
      now - bucket.updatedAt >= SHARD_RETENTION_MS
    ) {
      result.dropped++;
      continue;
    }
    buckets.set(bucketId(bucket), { ...bucket, stats: cloneCacheStats(bucket.stats) });
  }
  const routed = new Map<string, StatsArchiveRoutedV1>();
  for (const entry of previous.routed) {
    if (entry.globalEpoch !== globalEpoch || now - entry.updatedAt >= SHARD_RETENTION_MS) {
      result.dropped++;
      continue;
    }
    routed.set(routedId(entry), { ...entry, model: { ...entry.model } });
  }

  const shards = await readValidStatsShardsV7(directory);
  // Keep ids whose raw file still exists (a crash or a failed delete left it).
  // Presence is decided by the directory listing, not by a successful parse:
  // a leftover that is only transiently unreadable (Windows EPERM/EBUSY while
  // a scanner or sync client holds it) must stay absorbed, or it would be
  // counted raw again once readable and then folded into the archive twice.
  const presentIds = await listShardInstanceIds(directory);
  for (const shard of shards) presentIds.add(shard.instanceId);
  const absorbed: Record<string, number> = {};
  for (const [id, at] of Object.entries(previous.absorbed)) if (presentIds.has(id)) absorbed[id] = at;

  for (const shard of shards) {
    if (shard.instanceId in absorbed || !isArchivableShard(shard, now, today)) continue;
    absorbed[shard.instanceId] = now;
    result.absorbed++;
    if (shard.globalEpoch !== globalEpoch) continue; // reset away: nothing to keep
    if (shard.lastRoutedModel) {
      const id = routedId({ globalEpoch, sessionHash: shard.sessionHash });
      const existing = routed.get(id);
      if (!existing || existing.updatedAt < shard.lifecycle.updatedAt) {
        routed.set(id, { globalEpoch, sessionHash: shard.sessionHash, day: shard.day, updatedAt: shard.lifecycle.updatedAt, model: { ...shard.lastRoutedModel } });
      }
    }
    for (const [key, entry] of Object.entries(shard.models)) {
      if (entry.modelEpoch !== await currentModelEpoch(key)) continue;
      const id = bucketId({ globalEpoch, sessionHash: shard.sessionHash, modelKey: key, modelEpoch: entry.modelEpoch, day: shard.day, updatedAt: shard.lifecycle.updatedAt });
      const existing = buckets.get(id);
      const newer = !existing || existing.updatedAt <= shard.lifecycle.updatedAt;
      buckets.set(id, {
        globalEpoch,
        sessionHash: shard.sessionHash,
        modelKey: key,
        modelEpoch: entry.modelEpoch,
        day: shard.day,
        provider: newer ? entry.provider : existing.provider,
        modelId: newer ? entry.modelId : existing.modelId,
        ...((newer ? entry.modelName : existing.modelName) ? { modelName: newer ? entry.modelName : existing.modelName } : {}),
        ...((newer ? entry.api : existing.api) ? { api: newer ? entry.api : existing.api } : {}),
        updatedAt: Math.max(existing?.updatedAt ?? 0, shard.lifecycle.updatedAt),
        stats: mergeStatsAcrossDays(existing?.stats, entry.stats, null),
      });
    }
  }

  await touchStatsMaintenanceLock(options.lockToken);

  const absorbedChanged =
    Object.keys(absorbed).length !== Object.keys(previous.absorbed).length ||
    Object.keys(absorbed).some((id) => !(id in previous.absorbed));
  const skip = (): CompactionResult => {
    result.skippedConcurrent = true;
    result.absorbed = 0;
    result.dropped = 0;
    return result;
  };
  if (result.absorbed > 0 || result.dropped > 0 || absorbedChanged || migrating || healing) {
    await options.beforePublish?.();
    // Cheap early exits: lost the lock, someone published meanwhile, or a
    // reset landed during the pass (counters written under the new epoch
    // would be dropped as stale). The compare-and-swap below is what makes
    // a stale holder safe; these only avoid wasted work.
    let concurrent =
      !(await holdsStatsMaintenanceLock(options.lockToken)) ||
      ((await listStatsArchiveGenerations(archivePath)).at(-1) ?? 0) !== base.newestGeneration ||
      (base.newestGeneration === 0 && (await legacyArchiveIdentity(archivePath)) !== legacyIdentityAtRead) ||
      (await readGlobalStatsEpochStrict()) !== globalEpoch;
    for (const [key, epoch] of modelEpochs) {
      if (concurrent) break;
      if ((await readModelStatsEpochStrict(key)) !== epoch) concurrent = true;
    }
    if (concurrent) return skip();
    const next: StatsArchiveV1 = {
      version: 1,
      kind: "pi-cache-optimizer-archive",
      updatedAt: now,
      absorbed,
      buckets: Array.from(buckets.values()),
      routed: Array.from(routed.values()),
    };
    // Above every listed generation, readable or not, so a holder that read
    // an older one can never publish over an unreadable newer one.
    const generation = base.newestGeneration + 1;
    const text = JSON.stringify(encodeStatsArchiveV2(next, generation, base.legacySha256)) + "\n";
    const prepared = await prepareStatsArchiveGeneration(archivePath, generation, text);
    try {
      await options.beforeCommit?.();
      if (migrating && !(await moveLegacyArchiveAside(archivePath, base))) return skip();
      if (!(await commitPreparedGeneration(prepared))) return skip();
    } finally {
      await unlink(prepared.tempPath).catch(() => undefined);
    }
    // A generation above ours means ours is invisible to readers (only
    // possible after our base was superseded and cleaned up while this pass
    // was suspended): it must not delete what its snapshot covers.
    if (((await listStatsArchiveGenerations(archivePath)).at(-1) ?? 0) !== generation) return skip();
    // The in-place fallback is not atomic: its generation exists (empty or
    // partial) from the exclusive create until the write completes. A holder
    // suspended in between for longer than the stale-lock window has its
    // lock taken over, and the new holder may treat the old, still
    // unparseable generation as abandoned and build on the one below it.
    // If this writer then finished and deleted its absorbed shards before
    // the new holder listed the shard directory, they would be lost: the
    // new holder publishes above this generation and quarantines it. The new
    // holder takes the lock before reading anything, so a writer that still
    // holds it here cannot have been overtaken; one that lost it deletes
    // nothing (its absorbed files stay ignored and a later pass removes them).
    if (!(await holdsStatsMaintenanceLock(options.lockToken))) return skip();
    result.generation = generation;
    try {
      const path = statsArchiveGenerationPath(archivePath, generation);
      const info = await lstat(path);
      const view = new StatsArchiveView(next, true, false, generation, base.legacySha256);
      archiveFileCache.set(path, { ...statsFileIdentityOf(info), parsed: { kind: "ok", view } });
      lastGoodArchive.set(archivePath, view);
    } catch {}
    for (const corrupt of base.corruptGenerations) await quarantineGeneration(archivePath, corrupt);
    await removeSupersededGenerations(archivePath, generation);
  }
  if (result.generation !== undefined || base.newestGeneration > 0) await ensureLegacyArchiveTombstone(archivePath, base.legacySha256);
  await touchStatsMaintenanceLock(options.lockToken);

  // Only now that the archive covering them is durable, delete the originals.
  const toDelete = Object.keys(absorbed);
  const outcomes = await mapWithConcurrency(toDelete, SHARD_IO_CONCURRENCY, async (id): Promise<number> => {
    try {
      await unlink(join(directory, `${id}.json`));
      return 1;
    } catch {
      // ENOENT: already gone. Anything else: the id stays absorbed (so the
      // file is ignored by readers) and the next compaction retries.
      return 0;
    }
  });
  result.removed = outcomes.reduce((sum, value) => sum + value, 0);
  return result;
}

export type StatsMaintenanceResult = { cleanupRemoved: number; compaction?: CompactionResult };

/**
 * Due retention cleanup and archive compaction under one lock. Each has its
 * own marker so the first run after upgrading compacts immediately even when
 * cleanup ran recently.
 */
export async function maybeRunStatsMaintenance(now = Date.now()): Promise<StatsMaintenanceResult> {
  const result: StatsMaintenanceResult = { cleanupRemoved: 0 };
  await mkdir(SHARD_MAINTENANCE_DIR, { recursive: true });
  const cleanupDue = await isMaintenanceMarkerDue(SHARD_CLEANUP_MARKER_PATH, now);
  const compactionDue = await isMaintenanceMarkerDue(SHARD_COMPACTION_MARKER_PATH, now);
  if (!cleanupDue && !compactionDue) return result;
  const lockToken = await acquireStatsMaintenanceLock(now);
  if (!lockToken) return result;
  // Heartbeat so a long pass (a huge archive on a slow, scanned disk) is not
  // taken over as stale. It stops while the process is suspended; the
  // archive compare-and-swap covers that case.
  const heartbeat = setInterval(() => void touchStatsMaintenanceLock(lockToken), testHooks.heartbeatMs ?? STATS_MAINTENANCE_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    if (cleanupDue) {
      result.cleanupRemoved = await cleanupStatsShardsV7(now);
      await writeMaintenanceMarker(SHARD_CLEANUP_MARKER_PATH, now);
    }
    if (compactionDue) {
      let failed = false;
      try {
        result.compaction = await compactStatsShardsV7(now, SHARD_FILES_DIR, SHARD_ARCHIVE_PATH, { lockToken });
        if (result.compaction.skippedCorrupt) {
          console.warn(`${LOG_PREFIX}: stats archive ${SHARD_ARCHIVE_PATH} is in a newer format this version cannot read; keeping raw shards`);
        }
      } catch (error) {
        failed = true;
        console.warn(`${LOG_PREFIX}: stats archive compaction failed`, error);
      }
      // A pass that lost a race published nothing; let the next startup retry
      // instead of waiting out the full interval. A pass that failed (a
      // transient Windows EPERM on an epoch or archive file, a full disk)
      // published nothing either: retry after a short backoff, not 6 hours
      // later, without retrying on every single startup.
      if (failed) {
        await writeMaintenanceMarker(SHARD_COMPACTION_MARKER_PATH, now, now - SHARD_CLEANUP_INTERVAL_MS + COMPACTION_RETRY_AFTER_FAILURE_MS);
      } else if (!result.compaction?.skippedConcurrent) {
        await writeMaintenanceMarker(SHARD_COMPACTION_MARKER_PATH, now);
      }
    }
  } finally {
    clearInterval(heartbeat);
    await releaseStatsMaintenanceLock(lockToken);
  }
  return result;
}
