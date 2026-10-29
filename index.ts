import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type ExtensionAPI, type ExtensionContext
} from "@oh-my-pi/pi-coding-agent";
import { LOG_PREFIX, type PiModel, asRecord, getErrorCode, isNonEmptyString, readEnv } from "./src/common.ts";
import { STATE_DIR, resolveAgentDir } from "./src/paths.ts";
import { type FixSuggestion } from "./src/fix-types.ts";
import { atomicCreateTextFileNoReplace, atomicReplaceTextFilePreservingMode, atomicRestoreFileFromBackup, backupTimestamp, hashText } from "./src/atomic-fs.ts";
import { getAssistantMessageModelTokenValues, getModelIdNameTokenValues } from "./src/model-detect.ts";
import { getEffectiveCompatSources, mergeCacheCompat, resolveEffectiveCompat, resolveExplicitCompat } from "./src/compat-config.ts";
import { ARCHIVE_ABANDONED_ACTIVE_MS, SHARD_ARCHIVE_PATH, isArchivableShard, type StatsSnapshot, aggregateEpochKeys, aggregateStatsWithArchiveSync, aggregateStatsWithArchiveV7, readStatsArchiveForRefresh, compactStatsShardsV7, encodeStatsArchiveV2, listStatsArchiveGenerations, maybeRunStatsMaintenance, parseStatsArchiveV2, readStatsArchive, readStatsArchiveDetailed, readStatsArchiveView, readStatsSnapshot, setStatsArchiveTestHooks, StatsArchiveView, statsArchiveGenerationPath } from "./src/stats-archive.ts";
import { type CacheProviderId, type CacheStats, LEGACY_STATE_FILE_PATH, acquireStatsMaintenanceLock, isMaintenanceMarkerDue, renameWithRetry, setStatsFsTestHooks, holdsStatsMaintenanceLock, releaseStatsMaintenanceLock, touchStatsMaintenanceLock, type PersistedRoutedModelRef, type PersistedStatsShardV7, SHARD_FILES_DIR, SHARD_GLOBAL_EPOCH_PATH, SHARD_RETENTION_MS, SHARD_STATE_DIR, STATE_FILE_PATH, type ShardAggregate, type UsageSnapshot, addUsageToCacheStats, advanceGlobalStatsEpoch, advanceModelStatsEpoch, aggregateStatsShardsV7, cleanupStatsShardsV7, cloneCacheStats, mapWithConcurrency, currentLocalDay, emptyAllCacheStats, emptyCacheStats, initialEpoch, loadStatsShardAggregateV7, modelEpochPath, parseCacheStats, parsePersistedRoutedModelRef, parsePersistedStatsShardV7, readGlobalStatsEpoch, readModelStatsEpoch, readValidStatsShardsV7, removeLegacyStatsFiles, writeStatsShardV7, type ShardEpochs, readEpochFileResult, readEpochFileWithRetry, createShardAggregatorSync, SHARD_FILE_NAME_PATTERN } from "./src/stats-store.ts";
import { STATS_FULL_SCAN_INTERVAL_MS, StatsRefreshScheduler, type StatsWatchHandle, createFsShardWatch, TieredShardIndex, getStatsRefreshTestHooks, setStatsRefreshTestHooks } from "./src/stats-refresh.ts";
import { countingStatsReadFs, setStatsReadFsForTests, statsReadFs } from "./src/stats-fs.ts";
import { getCompat, getExplicitCompat, isAnthropicMessagesApi, isKnownThirdPartyOpenAIEndpoint, isMistralConversationsApi, isOfficialOpenAIBaseUrl, isOpenAICompatibleApi, isOpenAICompatibleProxyApi, isOpenAIFamilyAssistantMessage, isOpenAIFamilyModel, isOpenAIFamilyToken, isResponsesPromptRewriteBypassApi, isRoutedFallbackModel, modelKey } from "./src/model-identity.ts";
import { CONFIG_FILE_PATH, FOOTER_MODE_ENV, OPENAI_CACHE_KEY_ENV, NO_OPENAI_CACHE_KEY_ENV, PERSISTED_CACHE_OPTIMIZER_FEATURES, PROMPT_REWRITE_ENV, STATS_INCREMENTAL_ENV, STATS_TIMING_ENV, STATS_VERIFY_ENV, TOOL_ORDER_ENV, featureEnabled, footerStatsMode, formatOptimizerRuntimeMode, formatPersistentFeatureConfig, getOptimizerRuntimeModeLines, isEnabledEnv, isPromptRewriteEnabled, isRuntimeOptimizerEnabled, isStatsIncrementalEnabled, isStatsVerifyEnabled, isToolOrderEnabled, isZeroPriceWarmingEnabled, parseFooterStatsMode, parsePersistedCacheOptimizerConfig, readPersistedCacheOptimizerConfig, readPersistedFooterMode, resolveFooterStatsMode, runtimeOptimizerEnabled, setPersistedCacheOptimizerConfig, setRuntimeOptimizerEnabled, shouldInjectOpenAIPromptCacheKey, statsTimingLogPath, writePersistedCacheOptimizerConfig, writePersistedFeature, writePersistedFooterMode } from "./src/config.ts";
import { buildCacheWarmingDiagnosis, decideZeroPriceWarming, isZeroPriced, readCacheWarmingMode } from "./src/cache-warming.ts";
import { LONG_CACHE_RETENTION_VALUE, OMP_CACHE_RETENTION_ENV, PI_CACHE_RETENTION_BASELINE_SYMBOL, PI_CACHE_RETENTION_ENV, STARTUP_CACHE_RETENTION_ENV, captureCacheRetentionEnv, getOrCaptureCacheRetentionBaseline, decidePromptCacheRetention, readCacheRetentionValue, recordPromptCacheRetentionDecision, requestLongCacheRetention, restoreCacheRetentionEnv, userRequestedLongCacheRetention } from "./src/retention.ts";
import { compareToolOrderEntries, getToolNameForPayload, isKnownToolOrderApi, isToolOrderingEligibleModel, isVerifiedToolForApi, normalizeToolsInPayload, sortToolsInPayload } from "./src/tool-ordering.ts";
import { describePromptRewriteOutcome, extractSystemPrompt, fingerprintPrompt, getLastPromptRewriteOutcome, joinSystemPromptBlocks, mapSystemPromptBlocks, mapSystemPromptText, normalizeSystemPromptBlocks, recordPromptRewriteOutcome, stripSessionOverviewChurn, systemPromptBlocksEqual } from "./src/prompt-rewrite.ts";
import { addOpenAIPromptCacheKey, applyPromptCacheKeyToPayload, clampPromptCacheKey, collectAnthropicCacheControlsInWireOrder, derivePromptCacheKey, downgradeAnthropicLongCacheControls, getPromptCacheKeySource, hasAnthropicCacheTtlOrderError, hasEffectivePromptCacheKey, isPromptCacheKeyOmittedForModel, normalizeAnthropicCacheControlTtlOrder, normalizePromptCacheKeyForWire, omitOpenAIPromptCacheKeys, shouldInjectOpenAIPromptCacheKeyForModel, withAnthropicCacheTtlRepair, withoutPromptCacheRetention } from "./src/request-payload.ts";
import { PI_CACHE_HINTS_SYMBOL, PI_ROUTING_REGISTRY_SYMBOL, type PiCacheHintsInput, type PiCacheHintsOutput, type PiCacheHintSnapshot, buildProjectPromptCacheKey, ensureRoutingRegistry, findModelInRegistry, getCacheHintsService, getProtocolGlobal, getRoutingRegistry, getSessionPromptCacheKey, hashSessionId, installCacheHintsService, isOptimizerOwnedCacheHintsService, isSessionScopedPromptCacheKey, markOptimizerOwnedCacheHintsService, normalizePromptCacheEndpoint, parseRouteSnapshot, promptCacheKeyOptionsForApi, resolveActiveRouteSnapshot, resolvePromptCacheKey, resolveRouteModel, routeSnapshotToPiModel, sessionHashFromContext } from "./src/routing.ts";
import { CONFIG_RECEIPT_PATH, applyPromptCacheKeyConfigFix, configReceiptBackupPath, isActionablePromptCacheKeyConfigReceipt, parsePromptCacheKeyConfigReceipt, readPromptCacheKeyConfigReceipt, readPromptCacheKeyConfigReceiptSnapshot, rollbackPromptCacheKeyConfig, writePromptCacheKeyConfigReceipt } from "./src/prompt-cache-key-config.ts";
import { buildDeepSeekCompatSuggestion, buildDeepSeekCompatWarningText, buildModelCompatOverride, buildOpenAIProxyCompatWarningText, buildProviderCompatOverride, buildSafeOpenAIProxyCompatSuggestion, describeMissingCacheCompatForModel, describeMissingDeepSeekCompat, describeMissingOpenAICompatibleProxyCompat, formatYamlSnippet, getAgentDirDisplayPath, getModelsYmlDisplayPath, isDeepSeekWireCompatApplicable } from "./src/compat-advice.ts";
import { type CacheProviderAdapter, isVirtualRoutingModel, modelFromAssistantMessage, selectAdapterForAssistantMessage, selectAdapterForModel } from "./src/adapters.ts";
import { type CacheUsageSample, type PromptDiagnosticSample, MAX_RECENT_SAMPLES, buildAllStatsOutput, buildContributorsStatsOutput, buildExactRouterStatusEntry, buildSessionStatsOutput, buildStatsOutput, consolidateDirectProviderStatsModel, createSerializedAsyncRunner, deriveTotalsByModelFromSessionStats, filterRestorableStatsForSession, findBestRouterModelStats, formatCacheStats, formatCompactStats, formatHitRatio, formatRecentPromptDiagnostics, formatRecentTrendSummary, formatTokenCount, formatTokenM, hasMissingUsageFields, keyForModelExt, makeSessionModelKey, mergeCacheSessions, mergeCacheTotals, mergeLastRoutedModels, modelKeyFromSessionKey, parsePersistedCacheStats, parsePersistedTotalsByModel, prefixFooterStatus, readPersistedCacheStats, routedModelRefToPiModel, selectFooterStatsForModel, writePersistedCacheStats } from "./src/stats-report.ts";
import { buildCompatDiagnosis, buildDoctorDiagnosis, buildFixSuggestion, buildLowHitDiagnosis, describeOptionalOpenAICompatibleProxyCompat, describeRouterChannelDiagnostics, getCompatCheckNotApplicableLines, getOptionalAssistantHttpStatus, getPromptCacheRetentionUnsupportedHint, isCompatCheckApplicable, isDeepSeekCompatCheckApplicable, isOpenAISdkHeader403Applicable, isPromptCacheKeyUnsupportedApplicable, isPromptCacheRetention400Applicable } from "./src/diagnostics.ts";
import { REASONING_PROTOCOL_FALLBACK_SYMBOL, buildReasoningProtocolFixSuggestion, getAnthropicTtlFallbackState, getReasoningProtocolFallbackState, hasPromptCacheKeyUnsupportedErrorMessage, hasPromptCacheKeyUnsupportedSignal, hasPromptCacheKeyUnsupportedText, hasPromptCacheRetentionUnsupportedErrorMessage, hasPromptCacheRetentionUnsupportedSignal, hasPromptCacheRetentionUnsupportedText, hasReasoningProtocolRejectionErrorMessage, hasReasoningProtocolRejectionSignal, hasReasoningProtocolRejectionText, isExplicitPromptCacheRetentionUnsupportedApplicable, isReasoningProtocolRejectionForModel, isReasoningProtocolRejectionSignalApplicable, mergeFixSuggestions, notifyReasoningProtocolObservation } from "./src/provider-errors.ts";
import { getCacheOptimizerArgumentCompletions } from "./src/command-completion.ts";
import { MAX_PROVIDER_REQUEST_STATES, type ProviderRequestState, pruneProviderRequestStates, snapshotProviderRequestModel } from "./src/request-state.ts";
import { buildManualFixLines, createCacheOptimizerCommandHandler } from "./src/command.ts";

const STATUS_KEY = "omp-cache-stats";

function notifyCacheCompatIfNeeded(
  model: PiModel | undefined,
  ctx: ExtensionContext,
  warnedModels: Set<string>,
): void {
  if (!model) return;

  // A protocol rejection is retained separately from ordinary compat warnings;
  // it is surfaced once by the response hook and can be used by a later fix.
  // Do not turn it into an automatic write here.
  //
  // OMP divergence: no adaptive-thinking compat check (OMP's catalog handles
  // adaptive thinking itself; see compat-advice.ts).

  const adapter = selectAdapterForModel(model);
  const text = adapter?.warningText?.(model);
  if (!adapter || !text) return;

  const affinityOnly = adapter.warningText !== undefined &&
    describeMissingOpenAICompatibleProxyCompat(model).length === 1 &&
    describeMissingCacheCompatForModel(model).length === 1;
  const key = affinityOnly
    ? `proxy-affinity:${model.provider}`
    : `${adapter.id}:${modelKey(model)}`;
  if (warnedModels.has(key)) return;
  warnedModels.add(key);

  ctx.ui.notify(text, "warning");
}

// Internal helpers exported only so the test suite can exercise them. They are
// not part of the extension's public API; OMP only invokes the default export below.
// Most recent background stats restore started by any extension instance in
// this module. Tests await it after session_start; runtime code uses the
// per-instance promise instead.
let latestStatsRestoreForTests: Promise<void> = Promise.resolve();
/** Per extension instance in this module: resolves once no footer refresh (or its publish) is in flight. */
const statsRefreshSettledForTests = new Set<() => Promise<void>>();
/** Per extension instance in this module: resolves once no message_end handler is still recording. */
const messageEndSettledForTests = new Set<() => Promise<void>>();

export const __internals_for_tests = {
  waitForStatsRestore: (): Promise<void> => latestStatsRestoreForTests,
  /**
   * Footer refreshes after tool_execution_end, agent_end and message_end
   * never hold up OMP's handlers. Tests await this before asserting on what
   * such a refresh publishes.
   */
  statsRefreshSettled: async (): Promise<void> => {
    for (const settled of messageEndSettledForTests) await settled();
    for (const settled of statsRefreshSettledForTests) await settled();
  },
  setStatsRefreshTestHooks,
  setStatsReadFsForTests,
  countingStatsReadFs,
  TieredShardIndex,
  StatsRefreshScheduler,
  createFsShardWatch,
  aggregateStatsWithArchiveSync,
  aggregateEpochKeys,
  createShardAggregatorSync,
  readStatsArchiveForRefresh,
  readEpochFileResult,
  isStatsIncrementalEnabled,
  statsTimingLogPath,
  STATS_INCREMENTAL_ENV,
  STATS_TIMING_ENV,
  STATS_VERIFY_ENV,
  isStatsVerifyEnabled,
  decidePromptCacheRetention,
  userRequestedLongCacheRetention,
  derivePromptCacheKey,
  withAnthropicCacheTtlRepair,
  withoutPromptCacheRetention,
  stripSessionOverviewChurn,
  normalizeSystemPromptBlocks,
  joinSystemPromptBlocks,
  mapSystemPromptBlocks,
  mapSystemPromptText,
  systemPromptBlocksEqual,
  extractSystemPrompt,
  getLastPromptRewriteOutcome,
  describePromptRewriteOutcome,
  PROMPT_REWRITE_ENV,
  isPromptRewriteEnabled,
  isEnabledEnv,
  readEnv,
  featureEnabled,
  writePersistedFeature,
  PERSISTED_CACHE_OPTIMIZER_FEATURES,
  // OpenAI-family cache-key helpers
  addOpenAIPromptCacheKey,
  applyPromptCacheKeyToPayload,
  clampPromptCacheKey,
  normalizePromptCacheKeyForWire,
  hasEffectivePromptCacheKey,
  omitOpenAIPromptCacheKeys,
  isPromptCacheKeyOmittedForModel,
  getPromptCacheKeySource,
  resolvePromptCacheKey,
  promptCacheKeyOptionsForApi,
  isSessionScopedPromptCacheKey,
  buildProjectPromptCacheKey,
  normalizePromptCacheEndpoint,
  getSessionPromptCacheKey,
  isNonEmptyString,
  shouldInjectOpenAIPromptCacheKey,
  shouldInjectOpenAIPromptCacheKeyForModel,
  OPENAI_CACHE_KEY_ENV,
  NO_OPENAI_CACHE_KEY_ENV,
  isOpenAICompatibleApi,
  isAnthropicMessagesApi,
  isOpenAICompatibleProxyApi,
  collectAnthropicCacheControlsInWireOrder,
  downgradeAnthropicLongCacheControls,
  hasAnthropicCacheTtlOrderError,
  normalizeAnthropicCacheControlTtlOrder,
  isResponsesPromptRewriteBypassApi,
  isMistralConversationsApi,
  isOpenAIFamilyModel,
  isOpenAIFamilyAssistantMessage,
  isOpenAIFamilyToken,
  describeMissingOpenAICompatibleProxyCompat,
  describeOptionalOpenAICompatibleProxyCompat,
  describeMissingDeepSeekCompat,
  isDeepSeekWireCompatApplicable,
  isDeepSeekCompatCheckApplicable,
  describeMissingCacheCompatForModel,
  buildDeepSeekCompatSuggestion,
  buildDeepSeekCompatWarningText,
  buildSafeOpenAIProxyCompatSuggestion,
  getPromptCacheRetentionUnsupportedHint,
  isOfficialOpenAIBaseUrl,
  isKnownThirdPartyOpenAIEndpoint,
  isCompatCheckApplicable,
  isPromptCacheRetention400Applicable,
  isOpenAISdkHeader403Applicable,
  getOptionalAssistantHttpStatus,
  hasPromptCacheRetentionUnsupportedSignal,
  hasPromptCacheRetentionUnsupportedErrorMessage,
  hasPromptCacheRetentionUnsupportedText,
  hasPromptCacheKeyUnsupportedText,
  hasPromptCacheKeyUnsupportedSignal,
  hasPromptCacheKeyUnsupportedErrorMessage,
  isPromptCacheKeyUnsupportedApplicable,
  isExplicitPromptCacheRetentionUnsupportedApplicable,
  hasReasoningProtocolRejectionText,
  hasReasoningProtocolRejectionSignal,
  hasReasoningProtocolRejectionErrorMessage,
  isReasoningProtocolRejectionSignalApplicable,
  isReasoningProtocolRejectionForModel,
  buildReasoningProtocolFixSuggestion,
  mergeFixSuggestions,
  selectAdapterForModel,
  selectAdapterForAssistantMessage,
  buildOpenAIProxyCompatWarningText,
  getModelIdNameTokenValues,
  getAssistantMessageModelTokenValues,
  mergeCacheCompat,
  getEffectiveCompatSources,
  resolveEffectiveCompat,
  resolveExplicitCompat,
  getCompat,
  getExplicitCompat,
  isKnownToolOrderApi,
  getToolNameForPayload,
  compareToolOrderEntries,
  isVerifiedToolForApi,
  normalizeToolsInPayload,
  sortToolsInPayload,
  isToolOrderingEligibleModel,
  modelKey,
  modelFromAssistantMessage,
  consolidateDirectProviderStatsModel,
  // Platform-friendly path helpers
  STATE_DIR,
  resolveAgentDir,
  getAgentDirDisplayPath,
  getModelsYmlDisplayPath,
  formatYamlSnippet,
  buildProviderCompatOverride,
  buildModelCompatOverride,
  buildManualFixLines,
  captureCacheRetentionEnv,
  requestLongCacheRetention,
  restoreCacheRetentionEnv,
  readCacheRetentionValue,
  setRuntimeOptimizerEnabled,
  isRuntimeOptimizerEnabled,
  getOptimizerRuntimeModeLines,
  formatOptimizerRuntimeMode,
  formatPersistentFeatureConfig,
  OMP_CACHE_RETENTION_ENV,
  PI_CACHE_RETENTION_ENV,
  LONG_CACHE_RETENTION_VALUE,
  STARTUP_CACHE_RETENTION_ENV,
  TOOL_ORDER_ENV,
  isToolOrderEnabled,
  // Cache warming
  buildCacheWarmingDiagnosis,
  decideZeroPriceWarming,
  isZeroPriced,
  readCacheWarmingMode,
  isZeroPriceWarmingEnabled,
  // Diagnostic command helpers
  buildDoctorDiagnosis,
  buildCompatDiagnosis,
  buildLowHitDiagnosis,
  describeRouterChannelDiagnostics,
  getCompatCheckNotApplicableLines,
  // Cache stats helpers
  addUsageToCacheStats,
  formatCacheStats,
  formatCompactStats,
  formatTokenCount,
  prefixFooterStatus,
  getCacheOptimizerArgumentCompletions,
  emptyCacheStats,
  emptyAllCacheStats,
  parseCacheStats,
  parsePersistedCacheStats,
  deriveTotalsByModelFromSessionStats,
  parsePersistedTotalsByModel,
  // Recent sample / stats output / diagnosis helpers
  MAX_RECENT_SAMPLES,
  buildStatsOutput,
  buildSessionStatsOutput,
  buildAllStatsOutput,
  buildContributorsStatsOutput,
  formatRecentTrendSummary,
  formatRecentPromptDiagnostics,
  formatHitRatio,
  formatTokenM,
  hasMissingUsageFields,
  keyForModelExt,
  // Session-scoped helpers
  hashSessionId,
  sessionHashFromContext,
  makeSessionModelKey,
  modelKeyFromSessionKey,
  filterRestorableStatsForSession,
  parsePersistedRoutedModelRef,
  routedModelRefToPiModel,
  buildExactRouterStatusEntry,
  findBestRouterModelStats,
  selectFooterStatsForModel,
  parseFooterStatsMode,
  parsePersistedCacheOptimizerConfig,
  readPersistedCacheOptimizerConfig,
  writePersistedCacheOptimizerConfig,
  readPersistedFooterMode,
  writePersistedFooterMode,
  setPersistedCacheOptimizerConfig,
  resolveFooterStatsMode,
  footerStatsMode,
  CONFIG_FILE_PATH,
  CONFIG_RECEIPT_PATH,
  parsePromptCacheKeyConfigReceipt,
  isActionablePromptCacheKeyConfigReceipt,
  readPromptCacheKeyConfigReceipt,
  readPromptCacheKeyConfigReceiptSnapshot,
  writePromptCacheKeyConfigReceipt,
  applyPromptCacheKeyConfigFix,
  rollbackPromptCacheKeyConfig,
  configReceiptBackupPath,
  FOOTER_MODE_ENV,
  // Routing-provider protocol helpers
  PI_ROUTING_REGISTRY_SYMBOL,
  PI_CACHE_HINTS_SYMBOL,
  REASONING_PROTOCOL_FALLBACK_SYMBOL,
  ensureRoutingRegistry,
  getRoutingRegistry,
  parseRouteSnapshot,
  resolveActiveRouteSnapshot,
  routeSnapshotToPiModel,
  isRoutedFallbackModel,
  resolveRouteModel,
  isVirtualRoutingModel,
  findModelInRegistry,
  pruneProviderRequestStates,
  snapshotProviderRequestModel,
  MAX_PROVIDER_REQUEST_STATES,
  installCacheHintsService,
  getCacheHintsService,
  markOptimizerOwnedCacheHintsService,
  isOptimizerOwnedCacheHintsService,
  getOrCaptureCacheRetentionBaseline,
  PI_CACHE_RETENTION_BASELINE_SYMBOL,
  // Persistence helpers (for reload/reset tests)
  mergeCacheSessions,
  mergeCacheTotals,
  mergeLastRoutedModels,
  createSerializedAsyncRunner,
  writePersistedCacheStats,
  readPersistedCacheStats,
  parsePersistedStatsShardV7,
  writeStatsShardV7,
  readValidStatsShardsV7,
  aggregateStatsShardsV7,
  loadStatsShardAggregateV7,
  cleanupStatsShardsV7,
  compactStatsShardsV7,
  maybeRunStatsMaintenance,
  readStatsArchive,
  readStatsArchiveView,
  readStatsArchiveDetailed,
  readStatsSnapshot,
  setStatsArchiveTestHooks,
  setStatsFsTestHooks,
  renameWithRetry,
  isArchivableShard,
  isMaintenanceMarkerDue,
  aggregateStatsWithArchiveV7,
  encodeStatsArchiveV2,
  parseStatsArchiveV2,
  listStatsArchiveGenerations,
  statsArchiveGenerationPath,
  StatsArchiveView,
  touchStatsMaintenanceLock,
  acquireStatsMaintenanceLock,
  holdsStatsMaintenanceLock,
  releaseStatsMaintenanceLock,
  SHARD_ARCHIVE_PATH,
  SHARD_RETENTION_MS,
  mapWithConcurrency,
  removeLegacyStatsFiles,
  readGlobalStatsEpoch,
  readModelStatsEpoch,
  advanceGlobalStatsEpoch,
  advanceModelStatsEpoch,
  modelEpochPath,
  STATE_FILE_PATH,
  LEGACY_STATE_FILE_PATH,
  SHARD_STATE_DIR,
  SHARD_FILES_DIR,
  SHARD_GLOBAL_EPOCH_PATH,
  backupTimestamp,
  atomicReplaceTextFilePreservingMode,
  atomicCreateTextFileNoReplace,
  atomicRestoreFileFromBackup,
  hashText,
  // Fix suggestion builder
  buildFixSuggestion,
};

export default function (pi: ExtensionAPI) {
  const warnedModels = new Set<string>();
  const promptCacheRetention400Models = new Set<string>();
  const warnedPromptCacheRetention400Models = new Set<string>();
  const anthropicTtlFallbackState = getAnthropicTtlFallbackState();
  const anthropicTtlOrderErrorModels = anthropicTtlFallbackState.modelKeys;
  const warnedAnthropicTtlOrderErrorModels = anthropicTtlFallbackState.warnedModelKeys;
  const openAISdkHeader403Models = new Set<string>();
  const warnedOpenAISdkHeader403Models = new Set<string>();
  const reasoningProtocolFallbackState = getReasoningProtocolFallbackState();
  const reasoningProtocolRejectedModels = reasoningProtocolFallbackState.modelKeys;
  const warnedReasoningProtocolRejectedModels = reasoningProtocolFallbackState.warnedModelKeys;
  const promptCacheKeyRejectedModels = new Set<string>();
  const warnedPromptCacheKeyRejectedModels = new Set<string>();
  let cacheStatsByModel: Record<string, CacheStats> = {};
  let cacheStatsProcessByModel: Record<string, CacheStats> = {};
  let cacheStatsTotalsByModel: Record<string, CacheStats> = {};
  let cacheStatsLegacyFamily: Partial<Record<CacheProviderId, CacheStats>> = emptyAllCacheStats();
  let lastStatusText: string | undefined;
  let persistenceWarningShown = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let shardRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let shardWatcher: StatsWatchHandle | undefined;
  // Historical stats are restored in the background so a large shard
  // directory never holds up Pi's session_start (issue #28). Handlers that
  // read or persist aggregated stats await this first.
  let statsRestorePromise: Promise<void> = Promise.resolve();
  let statsRestoreGeneration = 0;
  async function waitForStatsRestore(): Promise<void> {
    // A session_start may chain a newer restore while we wait; keep waiting
    // until the chain is stable so callers never act on a half-restored view.
    let current: Promise<void>;
    do {
      current = statsRestorePromise;
      await current;
    } while (current !== statsRestorePromise);
  }
  const enqueuePersist = createSerializedAsyncRunner();
  let instanceId = randomUUID();
  const instanceStartedAt = Date.now();
  let instanceShardPath = join(SHARD_FILES_DIR, `${instanceId}.json`);
  let shardDay = currentLocalDay();
  let rolloverPromise: Promise<void> | undefined;
  // Failed day-close writes remain visible in memory until persisted or reload.
  const retiredShards = new Map<string, PersistedStatsShardV7>();
  const modelApiByKey = new Map<string, string>();
  const modelNameByKey = new Map<string, string>();
  const modelEpochByKey = new Map<string, string>();
  let currentGlobalEpoch = initialEpoch("global");
  let currentSessionId = "";
  let currentSessionHash = "";
  let currentSessionHashSet = false;
  let lastActualRoutedModel: PersistedRoutedModelRef | undefined;
  let latestCacheHint: PiCacheHintSnapshot | undefined;
  // Pi's response hooks do not expose a request id. Track one FIFO lifecycle
  // record per request and mark records when their response hook arrives. A
  // finalized assistant message consumes the oldest completed record, falling
  // back to the oldest request only when a transport emitted no response hook.
  // This preserves response A when request B/C starts before message_end(A).
  const providerRequestStates: ProviderRequestState[] = [];
  let shardCreatedAt = Date.now();
  const PERSIST_DEBOUNCE_MS = 2000;
  const SHARD_REFRESH_DEBOUNCE_MS = 250;

  function buildObservedRuntimeFixSuggestion(model: PiModel): FixSuggestion | undefined {
    const key = modelKey(model);
    const slashIdx = key.indexOf("/");
    const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;

    // OMP compat names: Anthropic 1h TTL is `supportsLongCacheRetention`,
    // OpenAI Responses 24h retention is `supportsLongPromptCacheRetention`.
    if (anthropicTtlOrderErrorModels.has(key)) {
      return {
        providerLabel,
        modelId: model.id,
        compatKeys: { supportsLongCacheRetention: false },
        forceModelLevel: true,
      };
    }
    if (isPromptCacheRetention400Applicable(model) && promptCacheRetention400Models.has(key)) {
      return {
        providerLabel,
        modelId: model.id,
        compatKeys: { supportsLongPromptCacheRetention: false },
        forceModelLevel: true,
      };
    }
    return undefined;
  }

  function buildCommandFixSuggestion(model: PiModel): FixSuggestion | undefined {
    const regular = buildFixSuggestion(model);
    const observedReasoning = buildReasoningProtocolFixSuggestion(
      model,
      reasoningProtocolRejectedModels.has(modelKey(model)),
    );
    const observed = mergeFixSuggestions(
      buildObservedRuntimeFixSuggestion(model),
      observedReasoning,
    );
    if (!regular) return observed;
    if (!observed) return regular;
    return {
      providerLabel: regular.providerLabel,
      modelId: regular.modelId,
      compatKeys: { ...regular.compatKeys, ...observed.compatKeys },
      forceModelLevel: regular.forceModelLevel || observed.forceModelLevel,
    };
  }

  function promptCacheKeyFixApplies(model: PiModel): boolean {
    return isPromptCacheKeyUnsupportedApplicable(model) && promptCacheKeyRejectedModels.has(modelKey(model));
  }

  function buildPromptCacheKeyConfigPreview(model: PiModel): string[] {
    const key = modelKey(model);
    return [
      `目标：${key}`,
      `操作：在 ${CONFIG_FILE_PATH} 持久化 prompt_cache_key 模式 = omit。`,
      "最终请求体会同时去掉 prompt_cache_key 和 promptCacheKey。",
      "这可能降低该模型在 provider 侧的 prompt 缓存复用；不会改变 prompt、凭据、header 或其他模型。",
      "该设置在 OMP 核心生成 payload 之后生效，包括 OMP 自己已经提供 key 的情况。",
    ];
  }
  /** In-memory recent usage samples per model key (not persisted, cleared on reload). */
  const recentSamplesByModelKey = new Map<string, CacheUsageSample[]>();
  /** Provider-request prompt diagnostics per session model key (memory only; not paired with message_end usage). */
  const recentPromptDiagnosticsByModelKey = new Map<string, PromptDiagnosticSample[]>();
  /**
   * message_end handlers still recording. OMP does not wait for message_end,
   * so a session switch drains these before the counters move to the next
   * session (an aborted turn can emit one last message_end late).
   */
  const pendingMessageEndOperations = new Set<Promise<unknown>>();
  async function drainPendingMessageEnds(): Promise<void> {
    while (pendingMessageEndOperations.size > 0) {
      await Promise.allSettled(Array.from(pendingMessageEndOperations));
    }
  }
  messageEndSettledForTests.add(drainPendingMessageEnds);

  /**
   * OMP keeps one extension instance across /new, /resume, /fork and branch
   * transitions, and background refreshes hold contexts whose session manager
   * already reports the next session. Adopt a different session id only on
   * the first sync or during an explicit transition (startSessionStats), so a
   * late refresh can never move the counters before the outgoing shard is
   * retired; turn_start catches a transition no event announced.
   */
  let adoptNextSessionId = false;
  function syncSessionHash(ctx: Pick<ExtensionContext, "sessionManager">): void {
    const sid = ctx.sessionManager.getSessionId();
    if (currentSessionHashSet && sid !== currentSessionId && !adoptNextSessionId) return;
    if (sid && (sid !== currentSessionId || !currentSessionHashSet)) {
      currentSessionId = sid;
      currentSessionHash = hashSessionId(sid);
      currentSessionHashSet = true;
      lastActualRoutedModel = undefined;
    }
  }

  // The hints carry the prompt and cache key OMP will actually send, so they
  // stay published while prompt rewrite is off (then the prompt is unchanged).
  // OMP runs one extension instance per session, including concurrent
  // subagents; only the top-level session publishes the process-wide service
  // (installed at its session_start), so a finishing subagent never removes it.
  const cacheHintsService = markOptimizerOwnedCacheHintsService({
    version: 1,
    getHints(input: PiCacheHintsInput): PiCacheHintsOutput | undefined {
      if (!runtimeOptimizerEnabled) return undefined;
      const hint = latestCacheHint;
      if (!hint) return undefined;
      if (input.sessionIdHash && hint.sessionIdHash && input.sessionIdHash !== hint.sessionIdHash) return undefined;
      if (input.virtualProvider && hint.virtualProvider && input.virtualProvider !== hint.virtualProvider) return undefined;
      if (input.virtualModelId && hint.virtualModelId && input.virtualModelId !== hint.virtualModelId) return undefined;
      if (input.upstreamProvider && hint.upstreamProvider && input.upstreamProvider !== hint.upstreamProvider) return undefined;
      if (input.upstreamModelId && hint.upstreamModelId && input.upstreamModelId !== hint.upstreamModelId) return undefined;
      if (input.api && hint.api && input.api !== hint.api) return undefined;

      return {
        systemPrompt: hint.systemPrompt,
        promptCacheKey: hint.promptCacheKey,
        cacheRetention: hint.cacheRetention,
      };
    },
  });
  let uninstallCacheHintsService: (() => void) | undefined;

  function recordPromptDiagnosticSample(modelKeyStr: string, sample: Omit<PromptDiagnosticSample, "timestamp">): void {
    let samples = recentPromptDiagnosticsByModelKey.get(modelKeyStr);
    if (!samples) {
      samples = [];
      recentPromptDiagnosticsByModelKey.set(modelKeyStr, samples);
    }
    samples.push({ timestamp: Date.now(), ...sample });
    if (samples.length > MAX_RECENT_SAMPLES) {
      samples.splice(0, samples.length - MAX_RECENT_SAMPLES);
    }
  }

  function getRecentPromptDiagnostics(modelKeyStr: string): PromptDiagnosticSample[] {
    return recentPromptDiagnosticsByModelKey.get(modelKeyStr) ?? [];
  }

  /**
   * Build a session-scoped stats key from the current session hash + model key.
   * Returns `${sessionHash}:${provider}/${id}`.
   */
  function sessionModelKey(model: { provider: string; id: string }): string {
    const hash = currentSessionHash || "_nosession";
    return `${hash}:${model.provider}/${model.id}`;
  }

  /**
   * Extract the user-facing model key from a session-scoped key.
   * "abc123:otokapi/gpt-5.5" → "otokapi/gpt-5.5"
   */
  function modelKeyFromSessionScoped(sKey: string): string {
    const idx = sKey.indexOf(":");
    return idx >= 0 ? sKey.slice(idx + 1) : sKey;
  }

  function recordRecentSample(modelKeyStr: string, usage: UsageSnapshot, missingUsageFields: boolean): void {
    let samples = recentSamplesByModelKey.get(modelKeyStr);
    if (!samples) {
      samples = [];
      recentSamplesByModelKey.set(modelKeyStr, samples);
    }
    samples.push({
      timestamp: Date.now(),
      hit: usage.cacheRead > 0,
      cachedInputTokens: usage.cacheRead,
      cacheWriteInputTokens: usage.cacheWrite,
      totalInputTokens: usage.totalInput,
      missingUsageFields,
    });
    if (samples.length > MAX_RECENT_SAMPLES) {
      samples.splice(0, samples.length - MAX_RECENT_SAMPLES);
    }
  }

  function getRecentSamples(modelKeyStr: string): CacheUsageSample[] {
    return recentSamplesByModelKey.get(modelKeyStr) ?? [];
  }

  function clearRecentSamples(): void {
    recentSamplesByModelKey.clear();
    recentPromptDiagnosticsByModelKey.clear();
  }

  /**
   * Shards this instance persisted under its current id that compaction
   * could have absorbed: the latest one, plus each one that was followed by
   * a gap of at least ARCHIVE_ABANDONED_ACTIVE_MS (compaction only takes an
   * active shard nobody wrote for that long). Used when this live process's
   * own shard was absorbed anyway (see adoptAbsorbedOwnShard).
   */
  let persistedOwnShards: PersistedStatsShardV7[] = [];
  /**
   * Which lifetime of the in-memory counters a built shard snapshots: bumped
   * whenever session_start clears them (see adoptAbsorbedOwnShard).
   */
  let countersSession = 0;
  const countersSessionOfShard = new WeakMap<PersistedStatsShardV7, number>();
  function recordPersistedOwnShard(shard: PersistedStatsShardV7): void {
    if (shard.instanceId !== instanceId) return;
    const last = persistedOwnShards.at(-1);
    if (last && shard.lifecycle.updatedAt - last.lifecycle.updatedAt < ARCHIVE_ABANDONED_ACTIVE_MS) persistedOwnShards.pop();
    persistedOwnShards.push(shard);
  }

  /**
   * Compaction absorbed this live instance's active shard: its process looked
   * dead (a PID namespace the compactor cannot see: containers, WSL, a shared
   * NFS agent dir) and it had been idle for a day. The archive now counts the
   * version it read, which this instance must neither count again (as its
   * in-memory shard) nor keep writing to (a write to an absorbed id is
   * ignored and then deleted, losing the usage since). Continue under a new
   * id holding only what the archive does not have: the in-memory counters
   * minus the absorbed version, which is the newest persisted one dated at
   * least ARCHIVE_ABANDONED_ACTIVE_MS before the absorption.
   */
  function adoptAbsorbedOwnShard(absorbedAt: number): void {
    const candidates = persistedOwnShards.filter((shard) => shard.lifecycle.updatedAt <= absorbedAt - ARCHIVE_ABANDONED_ACTIVE_MS);
    // Not identifiable (clock skew between the processes): assume the
    // archive holds everything, so nothing is ever counted twice.
    const absorbed = candidates.at(-1) ?? buildCurrentStatsShard();
    // Session guard: subtract only a version built from the counters held
    // now. session_start clears them (switching to another session, or the
    // same one on reload) but keeps the id, so a version persisted before it
    // counts usage these counters no longer hold: subtracting it would hide
    // this session's usage. Its sessionHash alone cannot tell: a reload keeps
    // it, and it changes without a reset when the session id first becomes
    // known after usage (then the counters still hold that usage).
    const sameSession = countersSessionOfShard.get(absorbed) === countersSession;
    const remaining: Record<string, CacheStats> = {};
    for (const [key, stats] of Object.entries(cacheStatsProcessByModel)) {
      const entry = sameSession && absorbed.globalEpoch === currentGlobalEpoch ? absorbed.models[key] : undefined;
      const sameEpoch = entry && entry.modelEpoch === (modelEpochByKey.get(key) ?? initialEpoch(`model:${key}`));
      const delta = cloneCacheStats(stats);
      if (sameEpoch) {
        delta.totalRequests = Math.max(0, stats.totalRequests - entry.stats.totalRequests);
        delta.hitRequests = Math.max(0, stats.hitRequests - entry.stats.hitRequests);
        delta.cachedInputTokens = Math.max(0, stats.cachedInputTokens - entry.stats.cachedInputTokens);
        delta.cacheWriteInputTokens = Math.max(0, stats.cacheWriteInputTokens - entry.stats.cacheWriteInputTokens);
        delta.totalInputTokens = Math.max(0, stats.totalInputTokens - entry.stats.totalInputTokens);
        delta.hitRequests = Math.min(delta.hitRequests, delta.totalRequests);
      }
      if (delta.totalRequests > 0 || delta.totalInputTokens > 0 || delta.cachedInputTokens > 0 || delta.cacheWriteInputTokens > 0) {
        remaining[key] = delta;
      }
    }
    cacheStatsProcessByModel = remaining;
    instanceId = randomUUID();
    instanceShardPath = join(SHARD_FILES_DIR, `${instanceId}.json`);
    shardCreatedAt = Date.now();
    persistedOwnShards = [];
    lastStatusText = undefined;
    // The new id keeps the old shard's day; the next status update rolls it
    // over as usual. Persist in the background (the aggregate below already
    // counts the in-memory shard). Once shutdown began (the refresh gate is
    // closed), never write an active shard: the flush closes this one.
    void persistCacheStats(undefined, refreshScheduler.isClosed ? "closed" : "active");
  }

  let lastStatsSnapshot: StatsSnapshot | undefined;

  // ── Epoch reads: one sequence, so a slow read never rolls back a newer one ──
  // Every footer epoch read (refresh, message_end, restore) takes a number
  // when it starts; local resets take one when they wrote. currentGlobalEpoch
  // and each modelEpochByKey entry remember the number of the read that set
  // them, and only a read that started later may change them. Without this a
  // refresh that read E1 before another process reset to E2 could, after
  // message_end already adopted E2 and recorded usage under it, switch back
  // to E1 and clear that usage.
  let epochReadSeq = 0;
  let globalEpochSeq = 0;
  /** Model epoch reads at or below this never set a model epoch (global change, session start, local reset). */
  let modelEpochFloorSeq = 0;
  const modelEpochSeq = new Map<string, number>();
  function nextEpochSeq(): number {
    return ++epochReadSeq;
  }
  /** Whether a global epoch read numbered `seq` may set currentGlobalEpoch (and records it when it may). */
  function acceptGlobalEpochRead(seq: number): boolean {
    if (seq <= globalEpochSeq) return false;
    globalEpochSeq = seq;
    return true;
  }
  function acceptModelEpochRead(seq: number, key: string): boolean {
    if (seq <= modelEpochFloorSeq || seq <= (modelEpochSeq.get(key) ?? 0)) return false;
    modelEpochSeq.set(key, seq);
    return true;
  }
  /**
   * acceptModelEpochRead for the read message_end labels new usage with. A
   * read the floor rejects (a newer read changed the global epoch, or a
   * session started, while it was in flight) is still the newest knowledge
   * of this key's epoch when nothing newer set the key: a global reset never
   * changes model epoch files, and voiding cleared what was known, not what
   * this read saw. Without it the usage is recorded with no model epoch,
   * that is the initial one, which every reader filters out when the model
   * was ever reset, and the next message_end then drops it.
   */
  function acceptModelEpochReadForUsage(seq: number, key: string): boolean {
    if (acceptModelEpochRead(seq, key)) return true;
    if (modelEpochByKey.has(key) || (modelEpochSeq.get(key) ?? 0) > seq) return false;
    modelEpochSeq.set(key, seq);
    return true;
  }
  /** Model epochs known so far are void (they were cleared): older reads must not set them again. */
  function voidModelEpochs(seq: number): void {
    modelEpochSeq.clear();
    modelEpochFloorSeq = Math.max(modelEpochFloorSeq, seq);
  }

  type EpochSnapshot = { seq: number; global: string; models: Map<string, string> };

  /** Read the global epoch and `keys` in parallel, once, for one refresh. Throws on a persistent I/O error. */
  async function readEpochSnapshot(keys: Iterable<string>): Promise<EpochSnapshot> {
    const seq = nextEpochSeq();
    const keyList = Array.from(keys);
    const results = await Promise.all([
      readEpochFileWithRetry(SHARD_GLOBAL_EPOCH_PATH, initialEpoch("global")),
      ...keyList.map((key) => readEpochFileWithRetry(modelEpochPath(key), initialEpoch(`model:${key}`))),
    ]);
    const epochs = results.map((result) => {
      if (!result.ok) throw result.error;
      return result.epoch;
    });
    return { seq, global: epochs[0]!, models: new Map(keyList.map((key, index) => [key, epochs[index + 1]!])) };
  }

  // ── Footer refresh: tiered index + single flight ──
  const fullScanIntervalMs = getStatsRefreshTestHooks().fullScanIntervalMs ?? STATS_FULL_SCAN_INTERVAL_MS;
  const shardIndex = new TieredShardIndex(SHARD_FILES_DIR, {
    freeze: getStatsRefreshTestHooks().freezeShards,
    fullScanIntervalMs,
  });
  /**
   * When the archive was last read in full (its newest generation lstat-ed
   * and its identity checked). Between such reads an unchanged clean
   * generation is confirmed by the listing alone; but a generation number is
   * only unique while the archive directory lives: if the stats directory is
   * deleted and another process compacts from scratch, a new generation 1
   * replaces the old one under the same name. So the identity is re-checked
   * on every full refresh and at least every full scan interval, which
   * bounds that case like a cold shard instead of until the next generation.
   */
  let archiveVerifiedAt = -Infinity;
  const refreshScheduler = new StatsRefreshScheduler<ShardAggregate>((full) => runStatsRefresh(full));
  /** Background refresh chains (and their publish) in flight; shutdown drains them. */
  const backgroundStatsTasks = new Set<Promise<void>>();
  let backgroundRefreshWarned = false;
  /** The context of the latest session_start, for refreshes no handler asked for (watcher, scans). */
  let latestStatsCtx: ExtensionContext | undefined;

  function trackBackgroundStatsTask(task: Promise<unknown>): void {
    const tracked = task.then(() => undefined, warnBackgroundRefreshOnce);
    backgroundStatsTasks.add(tracked);
    void tracked.then(() => backgroundStatsTasks.delete(tracked));
  }

  function warnBackgroundRefreshOnce(error: unknown): void {
    if (backgroundRefreshWarned) return;
    backgroundRefreshWarned = true;
    console.warn(`${LOG_PREFIX}: background footer stats refresh failed (further failures are not reported)`, error);
  }

  /**
   * The one entry point for refreshes Pi does not wait for (tool_execution_end,
   * agent_settled, message_end, the watcher, scans). Never rejects: every
   * failure, including a stale ctx after reload, is caught and warned once.
   * Publishes outside the refresh's critical section (a day rollover inside
   * publishStatus requests refreshes of its own), and not at all once the
   * gate closed or a newer session_start superseded this one.
   */
  function refreshAndPublishInBackground(ctx: ExtensionContext | undefined, pickModel?: () => PiModel | undefined): void {
    if (refreshScheduler.isClosed) return;
    const generation = statsRestoreGeneration;
    trackBackgroundStatsTask((async () => {
      await waitForStatsRestore();
      const aggregate = await refreshScheduler.background(false);
      if (aggregate === undefined || refreshScheduler.isClosed || generation !== statsRestoreGeneration || !ctx) return;
      ensureShardWatcher();
      await publishStatus(ctx, pickModel ? pickModel() : ctx.model);
    })());
  }

  /**
   * A refresh whose reads start after this call (see StatsRefreshScheduler).
   * `full` (default) stats every shard file: commands, doctor, flush and
   * restore. Lifecycle refreshes use the tiered index.
   */
  function refreshShardAggregate({ full = true }: { full?: boolean } = {}): Promise<ShardAggregate> {
    return refreshScheduler.request(full);
  }

  function startFullScanIfDue(): void {
    // The shutdown flush's own refreshes run with the gate closed: no new background scan then.
    if (refreshScheduler.isClosed) return;
    const scan = shardIndex.maybeStartFullScan(() => `${instanceId}.json`);
    if (!scan) return;
    trackBackgroundStatsTask(scan.then(async (changed) => {
      await checkShardWatcherDirectory();
      const mismatched = isStatsVerifyEnabled() && !refreshScheduler.isClosed
        ? await shardIndex.verifyCachedContents(`${instanceId}.json`)
        : [];
      noteStatsVerifyResult(mismatched);
      if (changed || mismatched.length > 0) refreshAndPublishInBackground(latestStatsCtx);
    }));
  }

  // PI_CACHE_OPTIMIZER_STATS_VERIFY: warn (once) when two verifications found
  // shard content that changed behind an unchanged file identity. A check
  // only judges files whose identity was the cached one before and after its
  // read, so a racing writer on a filesystem with real identities is never a
  // verdict; requiring two keeps a single oddity from warning. (Consecutive
  // is not required: the re-read after a verdict makes the next check clean.)
  let statsVerifyMismatches = 0;
  let statsVerifyWarned = false;
  function noteStatsVerifyResult(mismatched: readonly string[]): void {
    if (mismatched.length > 0) statsVerifyMismatches++;
    const timingPath = statsTimingLogPath();
    if (timingPath && mismatched.length > 0) writeStatsTiming(timingPath, { at: new Date().toISOString(), pid: process.pid, verifyMismatched: mismatched.length });
    if (statsVerifyMismatches < 2 || statsVerifyWarned) return;
    statsVerifyWarned = true;
    console.warn(
      `${LOG_PREFIX}: footer stats: ${mismatched.length} shard file(s) changed while their identity (inode, size, timestamps) did not; ` +
      `this filesystem hides changes from the incremental refresh. Set ${STATS_INCREMENTAL_ENV}=0 and please report it.`,
    );
  }

  async function runStatsRefresh(full: boolean): Promise<ShardAggregate> {
    const startedAt = performance.now();
    const ownName = `${instanceId}.json`;
    const incremental = isStatsIncrementalEnabled();
    let shardPhaseMs = 0;
    // Order matters (readStatsSnapshot): compaction publishes the archive
    // before deleting the shards it absorbed, so the shard phase (listing,
    // every lstat and readFile) completes before the archive is listed.
    // Reading them concurrently could pair an old archive with a post-delete
    // listing and drop those counters. A persistent transient archive read
    // error reuses the previous consistent snapshot (its shard contents, not
    // names) instead of pairing an old archive with a new listing.
    const verifyArchive = full || startedAt - archiveVerifiedAt >= fullScanIntervalMs;
    const snapshot = incremental
      ? await readStatsSnapshot(lastStatsSnapshot, SHARD_FILES_DIR, SHARD_ARCHIVE_PATH, {
        reuseArchive: !verifyArchive,
        readShards: async () => {
          const shards = await shardIndex.refresh({ own: ownName, full });
          await getStatsRefreshTestHooks().afterShardPhase?.();
          shardPhaseMs = performance.now() - startedAt;
          return shards;
        },
      })
      : await readStatsSnapshot(lastStatsSnapshot);
    lastStatsSnapshot = snapshot;
    if (verifyArchive || !incremental) archiveVerifiedAt = startedAt;
    const snapshotMs = performance.now() - startedAt;
    if (incremental) refreshScheduler.outsideRun(startFullScanIfDue);
    await getStatsRefreshTestHooks().beforeEpochRead?.();
    // Every epoch the aggregation can look up, read once and in parallel,
    // shared by both views and the adoption below.
    const day = currentLocalDay();
    const sessionsAtRead = new Set(currentSessionHashSet ? [currentSessionHash] : []);
    const keys = aggregateEpochKeys(snapshot.rawShards, snapshot.archive, [], day, undefined);
    for (const key of aggregateEpochKeys(snapshot.rawShards, snapshot.archive, [], null, sessionsAtRead)) keys.add(key);
    for (const shard of retiredShards.values()) for (const key of Object.keys(shard.models)) keys.add(key);
    for (const key of Object.keys(cacheStatsProcessByModel)) keys.add(key);
    const epochs = await readEpochSnapshot(keys);
    await getStatsRefreshTestHooks().beforeCommit?.();
    // ── Synchronous commit: no await from here on. ──
    // Usage message_end records meanwhile is in the in-memory counters this
    // step snapshots, so a refresh never overwrites it with older totals.
    const aggregate = commitStatsRefresh(snapshot, epochs, day);
    getStatsRefreshTestHooks().afterCommit?.(aggregate);
    const timingPath = statsTimingLogPath();
    if (timingPath) {
      const totalMs = performance.now() - startedAt;
      writeStatsTiming(timingPath, {
        at: new Date().toISOString(), pid: process.pid, incremental, full,
        totalMs: round(totalMs), shardPhaseMs: round(shardPhaseMs), archivePhaseMs: round(snapshotMs - shardPhaseMs),
        epochAndCommitMs: round(totalMs - snapshotMs), epochKeys: keys.size,
        shards: snapshot.rawShards.length, index: incremental ? shardIndex.lastRefresh : undefined,
      });
    }
    return aggregate;
  }

  const round = (value: number) => Math.round(value * 100) / 100;
  let timingLinesWritten = 0;
  let timingWrites: Promise<void> = Promise.resolve();
  /** Opt-in (PI_CACHE_OPTIMIZER_STATS_TIMING) JSON lines, serialized, capped, failures ignored. */
  function writeStatsTiming(path: string, record: Record<string, unknown>): void {
    if (timingLinesWritten >= 20_000) return;
    timingLinesWritten++;
    const line = JSON.stringify(record) + "\n";
    timingWrites = timingWrites.then(() => appendFile(path, line, "utf8")).catch(() => undefined);
  }

  /** The model epoch a refresh's aggregation filters `key` with. */
  function aggregationModelEpoch(key: string, epochs: EpochSnapshot): string {
    // A read (or local reset) newer than this snapshot set our value: it wins.
    if ((modelEpochSeq.get(key) ?? 0) > epochs.seq && modelEpochByKey.has(key)) return modelEpochByKey.get(key)!;
    // Keys first seen after the snapshot (usage recorded meanwhile) use the
    // epoch this process recorded them under.
    return epochs.models.get(key) ?? modelEpochByKey.get(key) ?? initialEpoch(`model:${key}`);
  }

  function commitStatsRefresh(snapshot: StatsSnapshot, epochs: EpochSnapshot, day: string): ShardAggregate {
    // A reset from another process can advance epochs while this instance is
    // idle. Adopt those epochs during every refresh, not only when a later
    // message_end arrives, so this instance cannot keep an old in-memory
    // process bucket visible in `process` mode or rewrite stale counters during
    // shutdown. Model-scoped resets clear only the affected local bucket. A
    // read older than the one that set the current value is ignored.
    let globalChanged = false;
    if (acceptGlobalEpochRead(epochs.seq) && currentGlobalEpoch !== epochs.global) {
      globalChanged = true;
      currentGlobalEpoch = epochs.global;
      cacheStatsProcessByModel = {};
      modelEpochByKey.clear();
      voidModelEpochs(epochs.seq);
      modelApiByKey.clear();
      modelNameByKey.clear();
      lastActualRoutedModel = undefined;
    }
    if (!globalChanged) {
      for (const key of Object.keys(cacheStatsProcessByModel)) {
        const latestModelEpoch = epochs.models.get(key);
        // A key first recorded after this snapshot was read: message_end read its epoch.
        if (latestModelEpoch === undefined || !acceptModelEpochRead(epochs.seq, key)) continue;
        if ((modelEpochByKey.get(key) ?? initialEpoch(`model:${key}`)) === latestModelEpoch) continue;
        delete cacheStatsProcessByModel[key];
        modelEpochByKey.set(key, latestModelEpoch);
        modelApiByKey.delete(key);
        modelNameByKey.delete(key);
      }
    }

    const { rawShards, archive } = snapshot;
    const ownAbsorbedAt = archive.archive.absorbed[instanceId];
    if (ownAbsorbedAt !== undefined) adoptAbsorbedOwnShard(ownAbsorbedAt);
    // Shards folded into the archive are counted there. Ignore their raw file
    // (a crash may leave it behind) and this process's in-memory retired copy.
    for (const id of archive.absorbedIds) retiredShards.delete(id);
    // A retired copy gives way to its file once the file is at least as new
    // (its closing write landed). An older file (the id's last active write,
    // when the closing write failed or is still queued) is ignored instead:
    // it may hold fewer counters than the retired copy.
    const persistedShards = rawShards.filter((shard) => {
      if (archive.absorbedIds.has(shard.instanceId)) return false;
      const retired = retiredShards.get(shard.instanceId);
      if (!retired) return true;
      if (shard.lifecycle.updatedAt < retired.lifecycle.updatedAt) return false;
      retiredShards.delete(shard.instanceId);
      return true;
    });
    // This process's own file is not even read by the tiered index (its
    // in-memory copy, the trailing shard, replaces it); the kill-switch path
    // reads it and drops it here. If a day rollover changed the id while the
    // snapshot was read, the previous id's content is its retired copy.
    const shards = persistedShards.filter((shard) => shard.instanceId !== instanceId);
    shards.push(...retiredShards.values());
    const trailing = currentSessionHashSet ? [buildCurrentStatsShard()] : [];
    const epochSource: ShardEpochs = { globalEpoch: currentGlobalEpoch, modelEpoch: (key) => aggregationModelEpoch(key, epochs) };
    // Keep lifetime session footer data separate from daily totals/commands.
    // Both equal aggregating [...shards, ...archive.shards, ...trailing]
    // (issue #28 review H): the current day only sees archive entries of that
    // day (normally none: the archive holds past days), and the all-days view
    // merges the archive's pre-reduced per-(session, model) entries instead
    // of re-aggregating every archived bucket. The all-days view is only read
    // for the current session (cacheStatsByModel lookups and the last routed
    // model), so it is built for that session alone.
    const aggregate = aggregateStatsWithArchiveSync(shards, archive, trailing, day, undefined, epochSource);
    const sessionAggregate = aggregateStatsWithArchiveSync(
      shards, archive, trailing, null, new Set(currentSessionHashSet ? [currentSessionHash] : []), epochSource,
    );

    cacheStatsByModel = {};
    for (const [sessionHash, models] of Object.entries(sessionAggregate.bySession)) {
      for (const [key, stats] of Object.entries(models)) {
        cacheStatsByModel[`${sessionHash}:${key}`] = stats;
      }
    }
    cacheStatsTotalsByModel = aggregate.totalsByModel;
    if (currentSessionHashSet) {
      lastActualRoutedModel = sessionAggregate.lastRoutedModelBySession[currentSessionHash];
    }
    lastStatusText = undefined;
    return aggregate;
  }

  // ── TUI shard watcher: an accelerator only (marks names dirty) ──
  let shardWatcherWanted = false;
  let shardWatcherDirectory: string | undefined;
  let shardWatcherRetryAt = 0;

  function closeShardWatcher(): void {
    const watcher = shardWatcher;
    shardWatcher = undefined;
    shardWatcherDirectory = undefined;
    try {
      watcher?.close();
    } catch {}
  }

  /**
   * Create the watcher when wanted (TUI, gate open) and missing. Called after
   * the background restore (which creates the directory) and after
   * successful background refreshes, so a watcher that failed (the directory
   * did not exist yet, or an error closed it) is recreated once the
   * directory can be listed again, at most every STATS_FULL_SCAN_INTERVAL_MS.
   */
  function ensureShardWatcher(): void {
    if (!shardWatcherWanted || shardWatcher || refreshScheduler.isClosed) return;
    const now = performance.now();
    if (now < shardWatcherRetryAt) return;
    shardWatcherRetryAt = now + STATS_FULL_SCAN_INTERVAL_MS;
    try {
      const factory = getStatsRefreshTestHooks().watch ?? createFsShardWatch;
      shardWatcher = factory(SHARD_FILES_DIR, onShardWatchName, onShardWatchError);
      shardWatcherRetryAt = 0;
      void statsReadFs().stat(SHARD_FILES_DIR).then((info) => {
        if (shardWatcher) shardWatcherDirectory = `${String(info.ino)}:${info.birthtimeMs}`;
      }, () => undefined);
    } catch {
      // ENOENT, ENOSPC (inotify watches exhausted), EPERM: lifecycle
      // refreshes, the hot set and full scans keep the footer correct.
      shardWatcher = undefined;
    }
  }

  function onShardWatchName(name: string | null): void {
    if (refreshScheduler.isClosed || !shardWatcher) return;
    const file = name === null ? undefined : basename(name);
    if (file === undefined) {
      // Overflow, or a platform that gives no name: re-check everything.
      shardIndex.requestFullScan();
    } else if (file.endsWith(".tmp")) {
      return; // the rename that publishes it reports the target name
    } else if (file === `${instanceId}.json`) {
      return; // this process's own writes: its in-memory copy is authoritative
    } else if (SHARD_FILE_NAME_PATTERN.test(file)) {
      shardIndex.markDirty(file);
    } else {
      shardIndex.requestFullScan();
    }
    scheduleShardRefresh(latestStatsCtx);
  }

  /**
   * A watcher 'error' (Windows: the watched directory was deleted) would
   * otherwise be thrown by the EventEmitter and crash Pi. Close the handle
   * (holding it would keep a deleted directory pending on Windows), fall
   * back to full scans, and recreate it only once the directory lists again.
   */
  function onShardWatchError(): void {
    closeShardWatcher();
    shardWatcherRetryAt = performance.now() + STATS_FULL_SCAN_INTERVAL_MS;
    shardIndex.requestFullScan();
  }

  /** After a full scan: a watcher whose directory was replaced (Linux keeps it on the old inode, silently) is recreated. */
  async function checkShardWatcherDirectory(): Promise<void> {
    if (!shardWatcher || shardWatcherDirectory === undefined) return;
    const watched = shardWatcherDirectory;
    let current: string | undefined;
    try {
      const info = await statsReadFs().stat(SHARD_FILES_DIR);
      current = `${String(info.ino)}:${info.birthtimeMs}`;
    } catch {
      current = undefined;
    }
    if (current !== watched && shardWatcherDirectory === watched) {
      closeShardWatcher();
      shardWatcherRetryAt = 0;
      if (current !== undefined) ensureShardWatcher();
    }
  }

  /** session_shutdown, first step: refuse new background work and stop its sources. */
  function closeStatsRefreshGate(): void {
    refreshScheduler.close();
    shardWatcherWanted = false;
    if (shardRefreshTimer !== null) clearTimeout(shardRefreshTimer);
    shardRefreshTimer = null;
    closeShardWatcher();
  }

  /** Wait for every refresh, publish and scan in flight. */
  async function drainStatsRefresh(): Promise<void> {
    for (;;) {
      await Promise.all(Array.from(backgroundStatsTasks));
      await refreshScheduler.drain();
      await shardIndex.settled();
      if (backgroundStatsTasks.size === 0 && refreshScheduler.idle && !shardIndex.fullScanInFlight) return;
    }
  }
  statsRefreshSettledForTests.add(drainStatsRefresh);

  function buildCurrentStatsShard(state: "active" | "closed" = "active"): PersistedStatsShardV7 {
    const now = Date.now();
    const models: PersistedStatsShardV7["models"] = {};
    for (const [key, stats] of Object.entries(cacheStatsProcessByModel)) {
      const slash = key.indexOf("/");
      if (slash <= 0 || slash >= key.length - 1) continue;
      models[key] = {
        modelEpoch: modelEpochByKey.get(key) ?? initialEpoch(`model:${key}`),
        provider: key.slice(0, slash),
        modelId: key.slice(slash + 1),
        ...(modelNameByKey.get(key) ? { modelName: modelNameByKey.get(key) } : {}),
        ...(modelApiByKey.get(key) ? { api: modelApiByKey.get(key) } : {}),
        stats: cloneCacheStats(stats),
      };
    }
    const shard: PersistedStatsShardV7 = {
      version: 7,
      kind: "pi-cache-optimizer-shard",
      instanceId,
      sessionHash: currentSessionHash || "_nosession",
      process: { pid: process.pid, ppid: process.ppid, instanceStartedAt },
      lifecycle: {
        state,
        createdAt: shardCreatedAt,
        updatedAt: now,
        ...(state === "closed" ? { closedAt: now } : {}),
      },
      day: shardDay,
      globalEpoch: currentGlobalEpoch,
      models,
      ...(lastActualRoutedModel ? { lastRoutedModel: { ...lastActualRoutedModel } } : {}),
    };
    countersSessionOfShard.set(shard, countersSession);
    return shard;
  }

  function scheduleShardRefresh(ctx?: ExtensionContext): void {
    if (refreshScheduler.isClosed) return;
    if (shardRefreshTimer !== null) clearTimeout(shardRefreshTimer);
    shardRefreshTimer = setTimeout(() => {
      shardRefreshTimer = null;
      refreshAndPublishInBackground(ctx);
    }, SHARD_REFRESH_DEBOUNCE_MS);
    shardRefreshTimer.unref?.();
  }

  /** Look up visible cumulative stats for a model, falling back to legacy family. */
  function getStatsForModel(model: PiModel | undefined, adapter: CacheProviderAdapter): CacheStats {
    if (model) {
      const key = modelKey(model);
      const existing = cacheStatsTotalsByModel[key];
      if (existing) return existing;
    }

    // Fallback: legacy family bucket — used when model key is unknown.
    const family = cacheStatsLegacyFamily[adapter.id];
    if (family) return family;

    const created = emptyCacheStats();
    cacheStatsLegacyFamily[adapter.id] = created;
    return created;
  }

  /** Get or create a session-scoped stats entry for the given key. */
  function getOrCreateStatsByModelKey(key: string): CacheStats {
    const existing = cacheStatsByModel[key];
    if (existing) return existing;

    const created = emptyCacheStats();
    cacheStatsByModel[key] = created;
    return created;
  }

  /** Get or create the current-process provider/model stats entry. */
  function getOrCreateProcessStatsForModel(model: PiModel): CacheStats {
    const key = modelKey(model);
    const existing = cacheStatsProcessByModel[key];
    if (existing) return existing;

    const created = emptyCacheStats();
    cacheStatsProcessByModel[key] = created;
    return created;
  }

  /** Get or create the cumulative provider/model stats entry shown in the footer. */
  function getOrCreateTotalStatsForModel(model: PiModel): CacheStats {
    const key = modelKey(model);
    const existing = cacheStatsTotalsByModel[key];
    if (existing) return existing;

    const created = emptyCacheStats();
    cacheStatsTotalsByModel[key] = created;
    return created;
  }

  async function resetStatsForModel(model: PiModel): Promise<void> {
    const displayKey = modelKey(model);
    const nextEpoch = await advanceModelStatsEpoch(displayKey);
    modelEpochByKey.set(displayKey, nextEpoch);
    modelEpochSeq.set(displayKey, nextEpochSeq());
    delete cacheStatsProcessByModel[displayKey];
    delete cacheStatsTotalsByModel[displayKey];
    for (const key of Object.keys(cacheStatsByModel)) {
      if (modelKeyFromSessionScoped(key) === displayKey) delete cacheStatsByModel[key];
    }
    for (const key of Array.from(recentSamplesByModelKey.keys())) {
      if (modelKeyFromSessionScoped(key) === displayKey) recentSamplesByModelKey.delete(key);
    }
    for (const key of Array.from(recentPromptDiagnosticsByModelKey.keys())) {
      if (modelKeyFromSessionScoped(key) === displayKey) recentPromptDiagnosticsByModelKey.delete(key);
    }
    lastStatusText = undefined;
  }

  async function resetCurrentSessionStats(): Promise<void> {
    currentGlobalEpoch = await advanceGlobalStatsEpoch();
    globalEpochSeq = nextEpochSeq();
    voidModelEpochs(globalEpochSeq);
    cacheStatsByModel = {};
    cacheStatsTotalsByModel = {};
    cacheStatsProcessByModel = {};
    modelEpochByKey.clear();
    modelApiByKey.clear();
    modelNameByKey.clear();
    clearRecentSamples();
    lastActualRoutedModel = undefined;
    lastStatusText = undefined;
  }

  function persistCacheStats(ctx?: ExtensionContext, lifecycleState: "active" | "closed" = "active"): Promise<void> {
    const shard = buildCurrentStatsShard(lifecycleState);
    const path = instanceShardPath;
    return enqueuePersist(async () => {
      try {
        await writeStatsShardV7(path, shard);
        if (path === instanceShardPath) recordPersistedOwnShard(shard);
      } catch (error) {
        console.warn(`${LOG_PREFIX}: failed to persist cache stats shard`, error);
        if (!persistenceWarningShown) {
          persistenceWarningShown = true;
          ctx?.ui.notify(
            `${LOG_PREFIX}: failed to persist footer stats; using in-memory stats for this process.`,
            "warning",
          );
        }
      }
    });
  }

  function schedulePersistCacheStats(ctx?: ExtensionContext): void {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      // A persist scheduled while a background restore runs (e.g. a routed
      // model change without usage) must not race the restore's own write.
      trackBackgroundStatsTask(waitForStatsRestore()
        .then(() => persistCacheStats(ctx))
        .then(() => refreshScheduler.background(false))
        .catch(() => undefined));
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  }

  async function flushPersistCacheStats(ctx?: ExtensionContext, lifecycleState: "active" | "closed" = "active"): Promise<void> {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await rollOverStatsIfNeeded(ctx);
    // Adopt resets performed by another Pi process before capturing the shard
    // snapshot. Otherwise shutdown/command flush could rewrite stale local
    // counters under an old epoch even though aggregation already hid them.
    // A refresh that fails (a persistent read error) must not cost the
    // persist: write the counters under the epochs known so far.
    try {
      await refreshShardAggregate();
    } catch (error) {
      console.warn(`${LOG_PREFIX}: footer stats refresh before persisting failed`, error);
    }
    await persistCacheStats(ctx, lifecycleState);
    try {
      await refreshShardAggregate();
    } catch (error) {
      console.warn(`${LOG_PREFIX}: footer stats refresh after persisting failed`, error);
    }
    // That refresh may have continued an absorbed own shard under a new id
    // and queued its write: let it land before the flush (and a shutdown)
    // returns, or interactive mode's process.exit could cut it off.
    await enqueuePersist(() => Promise.resolve());
  }

  async function rollOverStatsIfNeeded(ctx?: ExtensionContext): Promise<void> {
    if (rolloverPromise) return rolloverPromise;
    const day = currentLocalDay();
    if (shardDay === day) return;
    rolloverPromise = (async () => {
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      // Adopt other processes' epoch resets before the snapshot below.
      await refreshShardAggregate();
      // A session_start on this instance may have retired the shard (and
      // moved to today's day) while that refresh ran: nothing left to roll.
      if (shardDay === day) return;
      // Preserve yesterday under its original UUID/day before clearing daily
      // counters. Each day owns a new shard so total never includes yesterday.
      const closing = retireCurrentShard(day, ctx);
      cacheStatsProcessByModel = {};
      cacheStatsLegacyFamily = emptyAllCacheStats();
      lastStatusText = undefined;
      await closing;
      await persistCacheStats(ctx);
      await refreshShardAggregate();
    })();
    try { await rolloverPromise; }
    finally { rolloverPromise = undefined; }
  }

  /**
   * Retired shards whose closing write failed: counted from memory only, so
   * they would be lost when the process exits. The shutdown flush writes
   * each one once more (see retryUnpersistedRetiredShards).
   */
  const unpersistedRetiredShards = new Map<string, { shard: PersistedStatsShardV7; path: string; landed: boolean }>();

  /**
   * One more closing write for each retired shard whose write failed, at
   * shutdown. Skipped once its retired copy is gone: compaction absorbed the
   * id (the archive counts it), or a file at least as new already landed.
   * Also skipped when an earlier write of the id had landed but its file is
   * gone now: compaction folded it into the archive and deleted it (a later
   * pass then forgets the id, so a refresh that missed the archive in
   * between still holds the retired copy). Writing it back would count it
   * twice. A second failure only warns: there is nothing left to retry with.
   */
  async function retryUnpersistedRetiredShards(): Promise<void> {
    for (const [id, { shard, path, landed }] of Array.from(unpersistedRetiredShards)) {
      unpersistedRetiredShards.delete(id);
      if (retiredShards.get(id) !== shard) continue;
      await enqueuePersist(async () => {
        try {
          if (landed && await lstat(path).then(() => false, (error) => getErrorCode(error) === "ENOENT")) return;
          await writeStatsShardV7(path, shard);
        } catch (error) {
          console.warn(`${LOG_PREFIX}: failed again to persist a retired stats shard at shutdown; its usage is lost`, error);
        }
      });
    }
  }

  /**
   * Retire the current shard: snapshot it closed, keep that snapshot as its
   * retired copy, continue under a new id on `day`, and queue the snapshot's
   * write (a failure warns and the retired copy keeps counting it; the
   * shutdown flush writes it once more). The written and the retired copy
   * are one object, so once its write lands the file (same updatedAt)
   * replaces the retired copy. Synchronous up to
   * the queued write, so usage recorded after this goes to the new id.
   */
  function retireCurrentShard(day: string, ctx?: ExtensionContext): Promise<void> {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const closed = buildCurrentStatsShard("closed");
    const closedPath = instanceShardPath;
    const landed = persistedOwnShards.length > 0;
    retiredShards.set(instanceId, closed);
    instanceId = randomUUID();
    instanceShardPath = join(SHARD_FILES_DIR, `${instanceId}.json`);
    persistedOwnShards = [];
    shardCreatedAt = Date.now();
    shardDay = day;
    return enqueuePersist(async () => {
      try {
        await writeStatsShardV7(closedPath, closed);
      } catch (error) {
        unpersistedRetiredShards.set(closed.instanceId, { shard: closed, path: closedPath, landed });
        console.warn(`${LOG_PREFIX}: failed to persist a retired stats shard`, error);
        if (!persistenceWarningShown) {
          persistenceWarningShown = true;
          ctx?.ui.notify(
            `${LOG_PREFIX}: failed to persist footer stats; using in-memory stats for this process.`,
            "warning",
          );
        }
      }
    });
  }

  /**
   * session_start calls this instance has handled. Pi 1.3 builds a new
   * extension instance for every session (new/resume/fork/reload), but a
   * host that keeps one instance across sessions sends it a second
   * session_start, which clears the in-memory counters.
   */
  let sessionStartsHandled = 0;

  /**
   * Before a second session_start on the same instance clears the counters,
   * retire the shard holding them and continue under a new id, as the day
   * rollover does. Without this, the next persist rewrites the old id with
   * the cleared counters and the earlier session's usage for the day is lost
   * (the shutdown flush closed it, but the id was reused). See
   * retireCurrentShard.
   */
  function retireShardForSessionStart(): void {
    // The retired shard keeps its own day; the new id starts on today's, so
    // the restore does not roll over again into an empty extra shard.
    void retireCurrentShard(currentLocalDay());
  }

  /**
   * Synchronous part of a session restore: reset in-memory state immediately
   * at session_start, so usage recorded before the background disk restore
   * finishes is never wiped by a reset that runs later.
   */
  function resetStatsForSessionStart(reason: string, ctx: ExtensionContext): void {
    syncSessionHash(ctx);
    lastStatusText = undefined;
    cacheStatsProcessByModel = {};
    countersSession++;
    cacheStatsLegacyFamily = emptyAllCacheStats();
    modelEpochByKey.clear();
    voidModelEpochs(nextEpochSeq());
    modelApiByKey.clear();
    modelNameByKey.clear();
    if (reason === "reload") {
      clearRecentSamples();
    }
  }

  async function restoreCacheStats(ctx: ExtensionContext): Promise<void> {
    // Session identity was synced by resetStatsForSessionStart. Usage may
    // already have been recorded (message_end does not wait to record), and
    // message_end syncs the epoch before recording. If the disk epoch differs
    // now, a reset happened after that usage: adopt it and drop the stale
    // process bucket instead of re-labelling old counters with the new epoch.
    // A read error keeps the epoch known so far (it is not "no reset").
    const seq = nextEpochSeq();
    const latest = await readEpochFileWithRetry(SHARD_GLOBAL_EPOCH_PATH, initialEpoch("global"));
    if (latest.ok && acceptGlobalEpochRead(seq) && latest.epoch !== currentGlobalEpoch) {
      currentGlobalEpoch = latest.epoch;
      cacheStatsProcessByModel = {};
      modelEpochByKey.clear();
      voidModelEpochs(seq);
      modelApiByKey.clear();
      modelNameByKey.clear();
    }
    await removeLegacyStatsFiles();
    await mkdir(SHARD_FILES_DIR, { recursive: true });
    await rollOverStatsIfNeeded(ctx);
    // Run due retention maintenance before the single startup scan, so the
    // aggregate never retains counters from files maintenance just removed and
    // no second directory pass is needed. Cleanup also warms the parsed-shard
    // cache, so the scan below only re-stats files.
    try {
      await maybeRunStatsMaintenance();
    } catch (error) {
      console.warn(`${LOG_PREFIX}: stats shard maintenance failed`, error);
    }
    // One scan adopts other processes' epochs and restores this session's
    // routed-model metadata before this instance publishes its own shard.
    // In-memory process counters were cleared above, so no pre-persist
    // re-scan is needed; this instance's own shard is always replaced by its
    // in-memory copy during aggregation, so no post-persist scan either.
    await refreshShardAggregate();
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persistCacheStats(ctx);
  }

  async function publishStatus(ctx: ExtensionContext, model: PiModel | undefined = ctx.model): Promise<void> {
    syncSessionHash(ctx);
    await rollOverStatsIfNeeded(ctx);

    const routedModel = resolveRouteModel(model, ctx);
    const displayModel = routedModel ?? model;
    const adapter = selectAdapterForModel(displayModel);
    const activeIsVirtualRoute = !!routedModel || isVirtualRoutingModel(model, ctx);
    let statusText: string | undefined;
    const mode = footerStatsMode();
    const sessionHash = currentSessionHashSet ? currentSessionHash : undefined;
    // Recent samples are this session's requests: only meaningful next to
    // session or process counters, not the all-sessions daily total.
    const recentSamplesFor = (target: PiModel): CacheUsageSample[] => mode === "total" ? [] : getRecentSamples(sessionModelKey(target));

    if (!adapter && !routedModel && activeIsVirtualRoute) {
      // On a model change (existing footer), keep the existing cache footer
      // visible instead of clearing it. On session start (no footer yet
      // after reload/fresh start), restore the exact last actual routed model
      // for this session when available; fall back to older best-effort
      // heuristics only when no exact metadata exists.
      if (lastStatusText !== undefined) return;
      const realEntry = buildExactRouterStatusEntry(
        sessionHash,
        cacheStatsByModel,
        lastActualRoutedModel,
        cacheStatsTotalsByModel,
        mode,
        cacheStatsProcessByModel,
      ) ?? findBestRouterModelStats(
        mode,
        sessionHash,
        cacheStatsByModel,
        cacheStatsTotalsByModel,
        cacheStatsProcessByModel,
      );
      if (realEntry) {
        const statsText = formatCacheStats(realEntry.adapter, realEntry.stats, recentSamplesFor(realEntry.model));
        statusText = runtimeOptimizerEnabled
          ? statsText
          : `缓存优化已关闭 · ${statsText}`;
      }
    }

    if (adapter) {
      // Footer mode defaults to current-session provider/model totals. Users may
      // select all-current-day or current-process counters through persistent
      // command config or the environment variable.
      const stats = displayModel
        ? selectFooterStatsForModel(mode, sessionHash, cacheStatsByModel, cacheStatsTotalsByModel, displayModel, cacheStatsProcessByModel)
        : undefined;
      const statsText = formatCacheStats(adapter, stats ?? emptyCacheStats(), displayModel ? recentSamplesFor(displayModel) : []);
      statusText = runtimeOptimizerEnabled ? statsText : `缓存优化已关闭 · ${statsText}`;
    }

    // ⚠️ compat footer marker: only safe-fixable missing compat keys trigger
    // it. Optional/advisory-only flags (e.g. supportsLongPromptCacheRetention
    // on third-party Responses endpoints) do NOT; doctor/compat still mention
    // them. Re-evaluated on every status update so the marker persists through
    // stats changes and day rollovers.
    if (runtimeOptimizerEnabled && statusText !== undefined && displayModel) {
      if (buildFixSuggestion(displayModel) !== undefined) {
        statusText = statusText + " ⚠️ 配置";
      }
    }

    statusText = prefixFooterStatus(statusText);
    if (statusText === lastStatusText) return;

    lastStatusText = statusText;
    ctx.ui.setStatus(STATUS_KEY, statusText);
  }

  ensureRoutingRegistry();

  /**
   * OMP only emits `prompt_cache_retention` on `api: openai-responses` when the
   * resolved compat says the host accepts it (official OpenAI by detection, or
   * an explicit models.yml `supportsLongPromptCacheRetention: true`). That
   * resolved value is OMP's own decision, so it counts as the opt-in; the gate
   * below only undoes the field after the provider explicitly rejected it.
   */
  function hasExplicitLongRetentionOptIn(model: PiModel): boolean {
    return getCompat(model).supportsLongPromptCacheRetention === true;
  }

  /** Subagent sessions (task tool, eval agent(), /tan clones) run their own extension instance. */
  function isSubagentContext(ctx: unknown): boolean {
    return asRecord(asRecord(ctx)?.agent)?.kind === "sub";
  }

  /** This instance serves the top-level session: it owns process-wide state (env, hints, legacy global). */
  let isMainSessionInstance = false;
  /** Last model key the footer/compat warning was published for (OMP has no model_select event). */
  let lastModelKeyForStatus: string | undefined;

  /**
   * Begin stats for the session ctx now points at. OMP emits session_start once
   * per extension instance and then reuses the same instance for /new,
   * /resume, /fork and branch transitions (session_switch / session_branch),
   * so every later call retires the shard holding the previous session.
   */
  function startSessionStats(ctx: ExtensionContext, reason: string): void {
    if (runtimeOptimizerEnabled) requestLongCacheRetention();
    // Do not block OMP's startup on historical stats (issue #28). The
    // restore runs in the background (chained after any earlier restore so
    // two never interleave) and the footer is published when it finishes.
    // A newer start supersedes an older restore, which then must not
    // publish a stale footer. Handlers that read or persist stats await
    // waitForStatsRestore() first.
    const generation = ++statsRestoreGeneration;
    refreshScheduler.open();
    latestStatsCtx = ctx;
    const tui = ctx.mode === "tui" && !isSubagentContext(ctx);
    if (sessionStartsHandled++ > 0) retireShardForSessionStart();
    adoptNextSessionId = true;
    try {
      resetStatsForSessionStart(reason, ctx);
    } finally {
      adoptNextSessionId = false;
    }
    lastModelKeyForStatus = undefined;
    const previousRestore = statsRestorePromise;
    statsRestorePromise = previousRestore
      // A restore superseded before it started is skipped entirely: the newer
      // one redoes all of its work, and its ctx may already be stale.
      .then(() => (generation === statsRestoreGeneration ? restoreCacheStats(ctx) : undefined))
      .then(async () => {
        if (generation === statsRestoreGeneration) await publishStatus(ctx);
      })
      .catch((error) => {
        console.warn(`${LOG_PREFIX}: failed to restore cache stats`, error);
      })
      .then(() => {
        // TUI only, and only after the restore created the directory.
        if (tui && generation === statsRestoreGeneration && !refreshScheduler.isClosed) {
          shardWatcherWanted = true;
          shardWatcherRetryAt = 0;
          ensureShardWatcher();
        }
      });
    latestStatsRestoreForTests = statsRestorePromise;
  }

  /** Persist the outgoing session's counters before the instance moves on. */
  async function flushOutgoingSession(ctx: ExtensionContext): Promise<void> {
    // message_end is fire-and-forget in OMP: let handlers that already
    // started (an abort can emit one last message_end) finish recording
    // under the outgoing session first.
    await drainPendingMessageEnds();
    await waitForStatsRestore();
    try {
      await flushPersistCacheStats(ctx);
    } catch (error) {
      console.warn(`${LOG_PREFIX}: failed to persist cache stats before a session switch`, error);
    }
  }

  async function switchSessionStats(ctx: ExtensionContext, reason: string): Promise<void> {
    await flushOutgoingSession(ctx);
    latestCacheHint = undefined;
    providerRequestStates.length = 0;
    startSessionStats(ctx, reason);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!isSubagentContext(ctx)) {
      isMainSessionInstance = true;
      uninstallCacheHintsService ??= installCacheHintsService(cacheHintsService, { discardPrevious: isOptimizerOwnedCacheHintsService });
    }
    startSessionStats(ctx, "startup");
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    await flushOutgoingSession(ctx);
  });

  pi.on("session_switch", async (event, ctx) => {
    await switchSessionStats(ctx, asRecord(event)?.reason === "new" ? "new" : "resume");
  });

  pi.on("session_branch", async (_event, ctx) => {
    // A branch that keeps the session id keeps its counters.
    if (!currentSessionHashSet || ctx.sessionManager.getSessionId() === currentSessionId) return;
    await switchSessionStats(ctx, "branch");
  });

  pi.on("turn_start", async (_event, ctx) => {
    // Safety net for a session change this instance saw no event for: move
    // the counters before anything is recorded under the new session.
    const sessionId = ctx.sessionManager.getSessionId();
    if (currentSessionHashSet && sessionId && sessionId !== currentSessionId) {
      await switchSessionStats(ctx, "resume");
    }
    // OMP has no model_select event: publish the footer and compat warning
    // once per model change, on the first turn that uses the new model.
    const model = resolveRouteModel(ctx.model, ctx) ?? ctx.model;
    const key = model ? modelKey(model) : undefined;
    if (key === lastModelKeyForStatus) return;
    lastModelKeyForStatus = key;
    if (runtimeOptimizerEnabled && model && !isSubagentContext(ctx)) notifyCacheCompatIfNeeded(model, ctx, warnedModels);
    await waitForStatsRestore();
    await refreshShardAggregate({ full: false });
    await publishStatus(ctx, ctx.model);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    // Nested tool calls end before their parent; one refresh covers the batch.
    if (isNonEmptyString((event as { parentToolCallId?: unknown } | undefined)?.parentToolCallId)) return;
    // Refresh in the background; never hold up the next turn.
    refreshAndPublishInBackground(ctx);
  });

  // OMP native prompt-cache warming: keep it running for models whose prices
  // are unknown (all-zero cost), where OMP would otherwise stop with "cache
  // economics unavailable".
  pi.on("cache_warming_decision", (event, ctx) => {
    if (!isZeroPriceWarmingEnabled()) return undefined;
    const action = decideZeroPriceWarming(event, ctx.model);
    return action ? { action } : undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    // No provider request of this run is still in flight. Drop leftover
    // lifecycle records (a request whose message never ended, or a record
    // consumed out of order) so they cannot be correlated with the next run.
    providerRequestStates.length = 0;
    refreshAndPublishInBackground(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      // Close the gate first (no new background refresh, watcher event or
      // scan-triggered publish), then let what is in flight finish, then
      // flush. The flush's own refreshes are awaited and still run.
      closeStatsRefreshGate();
      await drainPendingMessageEnds();
      await waitForStatsRestore();
      await drainStatsRefresh();
      try {
        await flushPersistCacheStats(ctx, "closed");
      } finally {
        // Also when the flush failed (e.g. its rollover's refresh threw).
        await retryUnpersistedRetiredShards();
      }
    } finally {
      closeStatsRefreshGate();
      latestCacheHint = undefined;
      providerRequestStates.length = 0;
      // A finishing subagent must not undo process-wide state the
      // top-level session (and its other subagents) still rely on.
      if (isMainSessionInstance) {
        delete getProtocolGlobal().__ompCacheOptimizerCacheKey__;
        uninstallCacheHintsService?.();
        uninstallCacheHintsService = undefined;
        restoreCacheRetentionEnv(STARTUP_CACHE_RETENTION_ENV);
      }
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    latestCacheHint = undefined;
    // Clear the legacy global before any disable early return. A valid path
    // republishes the current session key below; otherwise callers must not
    // observe a stale key from the previously selected model/route.
    if (isMainSessionInstance) delete getProtocolGlobal().__ompCacheOptimizerCacheKey__;
    const routeSnapshot = resolveActiveRouteSnapshot(ctx.model, ctx);
    const routedModel = routeSnapshot
      ? findModelInRegistry(ctx.modelRegistry, routeSnapshot.provider, routeSnapshot.modelId) ?? routeSnapshotToPiModel(routeSnapshot, ctx.model)
      : undefined;
    const model = routedModel ?? ctx.model;

    // OMP hands the system prompt as ordered blocks (string[]). The rewrite is
    // block-local and in place: block order and skill text stay byte-for-byte,
    // only <session-overview> churn is stripped, and only when explicitly enabled.
    const originalBlocks = normalizeSystemPromptBlocks(asRecord(event)?.systemPrompt);
    let finalBlocks = originalBlocks;
    const recordOutcome = (applied: boolean, reason?: string) =>
      recordPromptRewriteOutcome({ applied, ...(reason ? { reason } : {}), blocks: originalBlocks.length, at: Date.now() });
    if (!runtimeOptimizerEnabled) {
      recordOutcome(false, "本进程已关闭优化器（/cache-optimizer disable）");
    } else if (!isPromptRewriteEnabled()) {
      recordOutcome(false, `prompt 重写未开启（默认关闭；用 ${PROMPT_REWRITE_ENV}=1 或 /cache-optimizer config prompt-rewrite on 开启）`);
    } else if (originalBlocks.length === 0) {
      recordOutcome(false, "OMP 没有提供 system prompt 块");
    } else {
      finalBlocks = mapSystemPromptBlocks(originalBlocks, stripSessionOverviewChurn);
      const changed = !systemPromptBlocksEqual(finalBlocks, originalBlocks);
      recordOutcome(changed, changed ? undefined : "没有可清理的 <session-overview> 易变字段");
    }

    if (originalBlocks.length > 0) {
      const sessionKey = model && isOpenAICompatibleApi(model.api)
        ? resolvePromptCacheKey(ctx, model, promptCacheKeyOptionsForApi(model.api))?.key
        : undefined;
      const promptCacheKey = sessionKey ?? getSessionPromptCacheKey(ctx);
      latestCacheHint = {
        sessionIdHash: currentSessionHashSet ? currentSessionHash : sessionHashFromContext(ctx),
        virtualProvider: routeSnapshot?.virtualProvider ?? ctx.model?.provider,
        virtualModelId: routeSnapshot?.virtualModelId ?? ctx.model?.id,
        upstreamProvider: routeSnapshot?.provider ?? model?.provider,
        upstreamModelId: routeSnapshot?.modelId ?? model?.id,
        api: model?.api,
        systemPrompt: joinSystemPromptBlocks(finalBlocks),
        promptCacheKey,
        cacheRetention: readCacheRetentionValue(process.env) === LONG_CACHE_RETENTION_VALUE ? LONG_CACHE_RETENTION_VALUE : undefined,
        timestamp: Date.now(),
      };
      if (isMainSessionInstance) {
        const globals = getProtocolGlobal();
        if (promptCacheKey) {
          globals.__ompCacheOptimizerCacheKey__ = promptCacheKey;
        } else {
          delete globals.__ompCacheOptimizerCacheKey__;
        }
      }
    }

    return systemPromptBlocksEqual(finalBlocks, originalBlocks) ? {} : { systemPrompt: finalBlocks };
  });

  pi.on("before_provider_request", (event, ctx) => {
    const requestModel = resolveRouteModel(ctx.model, ctx) ?? ctx.model;
    // Request-local identity is also needed by the always-on Anthropic TTL
    // validity repair, so retain the credential-blind snapshot even while the
    // optional runtime optimizer features are disabled.
    const snapshot = snapshotProviderRequestModel(requestModel);
    if (snapshot) {
      providerRequestStates.push({
        model: snapshot,
        selectionModelKey: ctx.model ? modelKey(ctx.model) : modelKey(snapshot),
        virtualSelection: isVirtualRoutingModel(ctx.model, ctx),
        responseReceived: false,
        correlationAmbiguous: false,
      });
      pruneProviderRequestStates(providerRequestStates);
    }
    let requestPayload: unknown = event.payload;
    let toolOrderChanged = false;

    if (isToolOrderEnabled() && isToolOrderingEligibleModel(requestModel)) {
      const normalized = normalizeToolsInPayload(requestPayload, requestModel.api);
      requestPayload = normalized.payload;
      toolOrderChanged = normalized.changed;
    }

    // Every mutation below works on a copy and is returned explicitly: OMP's
    // event.payload is never modified in place.
    let payloadChanged = toolOrderChanged;

    // Anthropic rejects mixed cache breakpoints when a 1h block appears after
    // a 5m/default block in wire order (tools → system → messages). Repair any
    // conflict visible in the final payload immediately. Some proxies inject
    // hidden short breakpoints after this hook; only models that have actually
    // returned the explicit TTL-order error receive the process-local 5m fallback.
    if (requestModel && isAnthropicMessagesApi(requestModel.api)) {
      const repaired = withAnthropicCacheTtlRepair(requestPayload, anthropicTtlOrderErrorModels.has(modelKey(requestModel)));
      if (repaired !== undefined) {
        requestPayload = repaired;
        payloadChanged = true;
      }
    }

    // Prompt rewrite safety net: requests built without a before_agent_start
    // pass (or after another extension replaced the prompt) still get the
    // same block-local session-overview strip.
    if (requestModel && isPromptRewriteEnabled() && extractSystemPrompt(requestPayload)?.includes("<session-overview>")) {
      const stripped = mapSystemPromptText(requestPayload, stripSessionOverviewChurn);
      if (stripped !== undefined) {
        requestPayload = stripped;
        payloadChanged = true;
      }
    }

    // prompt_cache_retention gate. This extension requests long retention,
    // which OMP turns into `prompt_cache_retention: "24h"` where the resolved
    // compat allows it. The gate removes it only for an endpoint that already
    // rejected it, or where the field appears without OMP's own opt-in.
    if (
      runtimeOptimizerEnabled &&
      requestModel &&
      isOpenAICompatibleApi(requestModel.api) &&
      typeof asRecord(requestPayload)?.prompt_cache_retention === "string"
    ) {
      const decision = decidePromptCacheRetention({
        providerRejected: promptCacheRetention400Models.has(modelKey(requestModel)),
        officialOpenAI: isOfficialOpenAIBaseUrl(requestModel),
        explicitOptIn: hasExplicitLongRetentionOptIn(requestModel),
        userRequestedLong: userRequestedLongCacheRetention(),
      });
      recordPromptCacheRetentionDecision(modelKey(requestModel), decision);
      if (!decision.keep) {
        const stripped = withoutPromptCacheRetention(requestPayload);
        if (stripped !== undefined) {
          requestPayload = stripped;
          payloadChanged = true;
        }
      }
    }

    // prompt_cache_key: an explicit per-model omit wins; otherwise resolve the
    // fork's key (header key > project key for Responses-family APIs > hashed
    // session key for Chat Completions). Only a missing or session-default key
    // is replaced; a custom key is always kept.
    let resolvedPromptCacheKey: ReturnType<typeof resolvePromptCacheKey>;
    if (isPromptCacheKeyOmittedForModel(requestModel)) {
      const omitted = omitOpenAIPromptCacheKeys(requestPayload);
      if (omitted !== undefined) {
        requestPayload = omitted;
        payloadChanged = true;
      }
    } else if (requestModel && shouldInjectOpenAIPromptCacheKey() && shouldInjectOpenAIPromptCacheKeyForModel(requestModel)) {
      resolvedPromptCacheKey = resolvePromptCacheKey(ctx, requestModel, promptCacheKeyOptionsForApi(requestModel.api));
      const sessionId = ctx.sessionManager.getSessionId();
      const withCacheKey = applyPromptCacheKeyToPayload(
        requestPayload,
        resolvedPromptCacheKey?.key,
        (key) => isSessionScopedPromptCacheKey(key, sessionId),
      );
      if (withCacheKey !== undefined) {
        requestPayload = withCacheKey;
        payloadChanged = true;
      }
    }

    // Request-level prompt diagnostics (memory only, never paired with usage):
    // a truncated hash of the final system prompt and where its cache key came from.
    if (requestModel) {
      const diagnosticsSessionHash = sessionHashFromContext(ctx) ?? (currentSessionHash || "_nosession");
      recordPromptDiagnosticSample(makeSessionModelKey(diagnosticsSessionHash, requestModel.provider, requestModel.id), {
        promptRewriteEnabled: isPromptRewriteEnabled(),
        systemPromptFingerprint: fingerprintPrompt(extractSystemPrompt(requestPayload)),
        promptCacheKeySource: getPromptCacheKeySource(requestPayload, requestModel.api, resolvedPromptCacheKey),
      });
    }

    return payloadChanged ? requestPayload : undefined;
  });

  pi.on("after_provider_response", async (event, ctx) => {
    const pendingStates = providerRequestStates.filter((state) => !state.responseReceived);
    let responseState: ProviderRequestState | undefined;
    if (pendingStates.length === 1) {
      responseState = pendingStates[0];
    } else if (pendingStates.length > 1) {
      const pendingModelKeys = new Set(pendingStates.map((state) => modelKey(state.model)));
      if (pendingModelKeys.size === 1) {
        // Identity is still exact when concurrent requests use the same model.
        responseState = pendingStates[0];
      } else {
        // OMP supplies no request id here, so out-of-order concurrent responses
        // cannot be assigned safely. Preserve the lifecycle records for a
        // message-local identity, but never turn ambiguous headers into a
        // model-scoped persistent-fix suggestion.
        for (const state of pendingStates) state.correlationAmbiguous = true;
      }
    }
    if (responseState) responseState.responseReceived = true;
    const model = responseState
      ? responseState.model
      : (pendingStates.length === 0 ? (resolveRouteModel(ctx.model, ctx) ?? ctx.model) : undefined);
    if (!runtimeOptimizerEnabled || !model) return;
    const headers = asRecord(event.headers) as Record<string, string> | undefined;

    // Keep only the category, never the provider's complete error text. This
    // is evidence for a later, model-scoped `/fix`; it never edits config from
    // a response hook.
    if (
      isReasoningProtocolRejectionSignalApplicable(model) &&
      event.status === 400 &&
      hasReasoningProtocolRejectionSignal(headers)
    ) {
      await notifyReasoningProtocolObservation(
        model,
        ctx,
        reasoningProtocolRejectedModels,
        warnedReasoningProtocolRejectedModels,
      );
    }

    // ── 400: prompt_cache_key unsupported ──
    if (event.status === 400 && isPromptCacheKeyUnsupportedApplicable(model) && hasPromptCacheKeyUnsupportedSignal(headers)) {
      notePromptCacheKeyRejected(model, ctx);
    }

    // ── 400: prompt_cache_retention unsupported ──
    if (
      event.status === 400 &&
      isPromptCacheRetention400Applicable(model) &&
      hasPromptCacheRetentionUnsupportedSignal(headers)
    ) {
      notePromptCacheRetentionRejected(model, ctx);
    }

    // ── 403: proxy/CDN/WAF blocking the OpenAI SDK request fingerprint ──
    // Provider-specific; never auto-fixed by writing a User-Agent because the
    // right value depends on the endpoint.
    if (event.status === 403 && isOpenAISdkHeader403Applicable(model)) {
      const key403 = modelKey(model);
      openAISdkHeader403Models.add(key403);
      if (warnedOpenAISdkHeader403Models.has(key403)) return;
      warnedOpenAISdkHeader403Models.add(key403);
      ctx.ui.notify(
        `⚠️ ${LOG_PREFIX}：${key403} 返回了 HTTP 403。` +
        `代理/CDN 可能在拦截 OpenAI JS SDK 的 User-Agent / X-Stainless-* header。` +
        `运行 /cache-optimizer doctor 查看手动排查建议；/cache-optimizer fix 不会自动写 User-Agent header。`,
        "warning",
      );
    }
  });

  function notePromptCacheKeyRejected(model: PiModel, ctx: ExtensionContext): void {
    const key = modelKey(model);
    promptCacheKeyRejectedModels.add(key);
    if (warnedPromptCacheKeyRejectedModels.has(key)) return;
    warnedPromptCacheKeyRejectedModels.add(key);
    ctx.ui.notify(
      `⚠️ ${LOG_PREFIX}：${key} 拒绝了 prompt_cache_key。运行 /cache-optimizer fix 查看只对该模型生效的关闭方案。未自动修改任何配置。`,
      "warning",
    );
  }

  function notePromptCacheRetentionRejected(model: PiModel, ctx: ExtensionContext): void {
    const key = modelKey(model);
    promptCacheRetention400Models.add(key);
    if (warnedPromptCacheRetention400Models.has(key)) return;
    warnedPromptCacheRetention400Models.add(key);
    ctx.ui.notify(
      `⚠️ ${LOG_PREFIX}：${key} 拒绝了 prompt_cache_retention，本进程后续请求会自动去掉该字段。` +
      getPromptCacheRetentionUnsupportedHint() +
      " 运行 /cache-optimizer doctor 查看具体编辑位置。",
      "warning",
    );
  }

  async function recordMessageEnd(message: unknown, ctx: ExtensionContext): Promise<void> {
    syncSessionHash(ctx);
    const msgRecord = asRecord(message);
    const requestCorrelationForMessage = msgRecord?.role === "assistant"
      ? (() => {
        const explicitModel = modelFromAssistantMessage(message, undefined, true);
        const explicitIndex = explicitModel
          ? providerRequestStates.findIndex((state) => modelKey(state.model) === modelKey(explicitModel))
          : -1;
        const completedIndex = providerRequestStates.findIndex((state) => state.responseReceived);
        const index = explicitIndex >= 0 ? explicitIndex : (completedIndex >= 0 ? completedIndex : 0);
        const state = providerRequestStates.splice(index, 1)[0];
        if (!state) return { model: undefined, ambiguous: false, virtualSelection: undefined, selectionModelKey: undefined };
        // A current selection cannot correlate an unknown echoed alias. Even
        // before response headers arrive, different outstanding models make
        // that fallback ambiguous; keep the message's own identity instead.
        const ambiguous = explicitIndex < 0 && (
          state.correlationAmbiguous ||
          providerRequestStates.some((other) => modelKey(other.model) !== modelKey(state.model))
        );
        return {
          model: ambiguous ? undefined : state.model,
          ambiguous,
          virtualSelection: state.virtualSelection,
          selectionModelKey: state.selectionModelKey,
        };
      })()
      : { model: undefined, ambiguous: false, virtualSelection: undefined, selectionModelKey: undefined };
    const requestModelForMessage = requestCorrelationForMessage.model;
    const contextualFallbackForMessage = requestCorrelationForMessage.ambiguous
      ? undefined
      : (resolveRouteModel(ctx.model, ctx) ?? ctx.model);
    const errorModelFor = (): PiModel | undefined => {
      const fallbackModel = requestModelForMessage ?? contextualFallbackForMessage;
      const messageModel = modelFromAssistantMessage(message, fallbackModel) ?? fallbackModel;
      return messageModel
        ? findModelInRegistry(ctx.modelRegistry, messageModel.provider, messageModel.id) ?? messageModel
        : undefined;
    };

    // Some providers expose an HTTP 400 error body only through the finalized
    // assistant error message; after_provider_response may carry the status
    // without diagnostic headers (or not fire at all for a failed request).
    // Record only the model-scoped category from that authoritative identity.
    if (runtimeOptimizerEnabled && hasReasoningProtocolRejectionErrorMessage(message)) {
      const errorModel = errorModelFor();
      if (errorModel && isReasoningProtocolRejectionForModel(message, errorModel)) {
        await notifyReasoningProtocolObservation(
          errorModel,
          ctx,
          reasoningProtocolRejectedModels,
          warnedReasoningProtocolRejectedModels,
        );
      }
    }
    if (runtimeOptimizerEnabled && hasPromptCacheKeyUnsupportedErrorMessage(message)) {
      const errorModel = errorModelFor();
      if (errorModel && isPromptCacheKeyUnsupportedApplicable(errorModel)) notePromptCacheKeyRejected(errorModel, ctx);
    }
    if (runtimeOptimizerEnabled && hasPromptCacheRetentionUnsupportedErrorMessage(message)) {
      const errorModel = errorModelFor();
      if (errorModel && isExplicitPromptCacheRetentionUnsupportedApplicable(errorModel)) notePromptCacheRetentionRejected(errorModel, ctx);
    }

    // Record only Anthropic's explicit mixed-TTL ordering error. The fallback
    // applies to the next request (and to a retry only if another layer
    // initiates one).
    if (hasAnthropicCacheTtlOrderError(message)) {
      const fallbackModel = requestModelForMessage ?? contextualFallbackForMessage;
      const errorModel = modelFromAssistantMessage(message, fallbackModel) ?? fallbackModel;
      if (errorModel && isAnthropicMessagesApi(errorModel.api)) {
        const key = modelKey(errorModel);
        anthropicTtlOrderErrorModels.add(key);
        if (!warnedAnthropicTtlOrderErrorModels.has(key)) {
          warnedAnthropicTtlOrderErrorModels.add(key);
          ctx.ui.notify(
            `⚠️ ${LOG_PREFIX}：${key} 返回了 Anthropic cache-control TTL 顺序错误。` +
            `下一次请求会回退到默认 5 分钟缓存 TTL。` +
            `运行 /cache-optimizer fix 查看持久设置模型级 supportsLongCacheRetention: false 的片段。`,
            "warning",
          );
        }
      }
    }

    // Only a finalized assistant message carries provider usage. OMP also
    // emits message_end for user and tool-result messages; recording those
    // would add a usage-less sample per turn and make every model look like
    // its proxy drops usage fields.
    if (msgRecord?.role !== "assistant") return;

    const currentSelectionIsVirtual = isVirtualRoutingModel(ctx.model, ctx);
    const requestSelectionIsVirtual = requestCorrelationForMessage.virtualSelection ?? currentSelectionIsVirtual;
    const directSelection = !requestSelectionIsVirtual;
    const statsFallback = requestModelForMessage ?? ctx.model;
    let statsModel = modelFromAssistantMessage(message, statsFallback, directSelection) ?? statsFallback;
    if (directSelection && statsModel) {
      // Catalog identity wins over an echoed response alias. Older/custom
      // transports can still echo an unknown id; consolidate those only with
      // the request-local snapshot, never a newly selected same-family model.
      const catalogModel = findModelInRegistry(ctx.modelRegistry, statsModel.provider, statsModel.id);
      statsModel = catalogModel && !isVirtualRoutingModel(catalogModel, ctx)
        ? catalogModel
        : consolidateDirectProviderStatsModel(statsModel, requestModelForMessage, ctx);
    }
    const adapter = selectAdapterForModel(statsModel) ?? selectAdapterForAssistantMessage(message, statsModel);
    if (!adapter) return;

    const usage = adapter.normalizeUsage(message);

    // A failed or aborted attempt that carries no usage (network retry,
    // user abort before the provider answered) is not a request the provider
    // served: counting it would inflate totalRequests and skew the hit rate.
    // An aborted response that already reported usage did read/write the
    // cache, so it still counts.
    const stopReason = msgRecord?.stopReason;
    if ((stopReason === "error" || stopReason === "aborted") && (usage?.totalInput ?? 0) <= 0) {
      return;
    }

    let routedModelChanged = false;
    if (requestSelectionIsVirtual && statsModel && !isVirtualRoutingModel(statsModel, ctx)) {
      const nextRoutedModel: PersistedRoutedModelRef = {
        provider: statsModel.provider,
        id: statsModel.id,
        name: statsModel.name || statsModel.id,
      };
      if (
        !lastActualRoutedModel ||
        lastActualRoutedModel.provider !== nextRoutedModel.provider ||
        lastActualRoutedModel.id !== nextRoutedModel.id ||
        (lastActualRoutedModel.name || lastActualRoutedModel.id) !== (nextRoutedModel.name || nextRoutedModel.id)
      ) {
        lastActualRoutedModel = nextRoutedModel;
        routedModelChanged = true;
      }
    }

    // Record recent sample (even when usage is missing, for trend diagnosis)
    if (statsModel) {
      const sk = sessionModelKey(statsModel);
      const missingFields = usage === undefined || (usage.cacheRead === 0 && usage.cacheWrite === 0 && usage.totalInput === 0)
        ? true
        : hasMissingUsageFields(message, adapter);
      recordRecentSample(sk, usage ?? { cacheRead: 0, cacheWrite: 0, totalInput: 0 }, missingFields);
    }

    if (!usage) {
      if (routedModelChanged) schedulePersistCacheStats(ctx);
      return;
    }

    await rollOverStatsIfNeeded(ctx);

    // Update session, process-local, and cumulative buckets for the actual
    // routed model.
    if (statsModel) {
      const key = modelKey(statsModel);
      // Fresh reads, numbered like every footer epoch read: a refresh that
      // read older epochs can no longer switch back and clear this usage. A
      // read error keeps the epochs known so far.
      const seq = nextEpochSeq();
      const [latestGlobal, latestModel] = await Promise.all([
        readEpochFileWithRetry(SHARD_GLOBAL_EPOCH_PATH, initialEpoch("global")),
        readEpochFileWithRetry(modelEpochPath(key), initialEpoch(`model:${key}`)),
      ]);
      if (latestGlobal.ok && acceptGlobalEpochRead(seq) && currentGlobalEpoch !== latestGlobal.epoch) {
        currentGlobalEpoch = latestGlobal.epoch;
        cacheStatsProcessByModel = {};
        modelEpochByKey.clear();
        voidModelEpochs(seq - 1);
      }
      if (latestModel.ok && acceptModelEpochReadForUsage(seq, key) && modelEpochByKey.get(key) !== latestModel.epoch) {
        delete cacheStatsProcessByModel[key];
        modelEpochByKey.set(key, latestModel.epoch);
      }
      modelApiByKey.set(key, statsModel.api ?? "");
      modelNameByKey.set(key, statsModel.name || statsModel.id);
      const sk = sessionModelKey(statsModel);
      addUsageToCacheStats(getOrCreateStatsByModelKey(sk), usage);
      addUsageToCacheStats(getOrCreateProcessStatsForModel(statsModel), usage);
      addUsageToCacheStats(getOrCreateTotalStatsForModel(statsModel), usage);
    } else {
      addUsageToCacheStats(getStatsForModel(undefined, adapter), usage);
    }

    schedulePersistCacheStats(ctx);
    // The counters above are already updated in memory; the refresh and the
    // footer update run in the background.
    refreshAndPublishInBackground(ctx, () => {
      // A late response from an older selection must not replace the active
      // footer. Only a routed response that still belongs to the currently
      // selected virtual/router model may publish its physical model directly.
      const responseBelongsToCurrentSelection =
        requestCorrelationForMessage.selectionModelKey !== undefined &&
        ctx.model !== undefined &&
        requestCorrelationForMessage.selectionModelKey === modelKey(ctx.model);
      return requestSelectionIsVirtual && responseBelongsToCurrentSelection ? statsModel : ctx.model;
    });
  }

  pi.on("message_end", (event, ctx) => {
    // OMP does not wait for message_end; track the handler so a session
    // switch or shutdown can drain it before the counters move on.
    const operation = recordMessageEnd(event.message, ctx).catch((error) => {
      console.warn(`${LOG_PREFIX}: failed to record cache stats for a message`, error);
    });
    pendingMessageEndOperations.add(operation);
    void operation.finally(() => pendingMessageEndOperations.delete(operation));
    return operation;
  });

  // ────────────────────────────────────────────────────────────────
  // Register /cache-optimizer command
  // Subcommands:
  //   enable  — enable runtime prompt/cache optimizations for this process
  //   disable — disable runtime prompt/cache optimizations for this process
  //   doctor  — show current model/provider/api/baseUrl/compat status
  //             with low-hit diagnosis
  //   stats   — show detailed current-session models; `stats all` shows all local shards
  //   compat  — show compat suggestion with file path
  //   config footer-mode total|session|process — persist footer mode override
  //   config <feature> on|off — persist a feature switch
  //   fix     — show models.yml compat snippets; `fix prompt-cache-key` writes extension config (UI)
  //   rollback — undo the latest confirmed prompt-cache-key opt-out
  //   reset   — reset current provider/model footer stats bucket (local only)
  //   (no args) — interactive menu (with UI) or help summary
  // ────────────────────────────────────────────────────────────────
  const handleCacheOptimizerCommand = createCacheOptimizerCommandHandler({
    syncSessionHash,
    resetCurrentSessionStats,
    resetStatsForModel,
    flushPersistCacheStats,
    publishStatus,
    refreshShardAggregate,
    sessionModelKey,
    getRecentSamples,
    getRecentPromptDiagnostics,
    promptCacheKeyFixApplies,
    buildCommandFixSuggestion,
    buildPromptCacheKeyConfigPreview,
    providerRequestStates,
    promptCacheRetention400Models,
    promptCacheKeyRejectedModels,
    anthropicTtlOrderErrorModels,
    openAISdkHeader403Models,
    getCacheStatsTotalsByModel: () => cacheStatsTotalsByModel,
    getCurrentSessionHashSet: () => currentSessionHashSet,
    getCurrentSessionHash: () => currentSessionHash,
    getLastStatusText: () => lastStatusText,
    clearLastStatusText: () => { lastStatusText = undefined; },
    getCacheWarmingMode: () => readCacheWarmingMode(),
  });

  pi.registerCommand("cache-optimizer", {
    description: "诊断与配置 OMP 缓存优化",
    getArgumentCompletions: getCacheOptimizerArgumentCompletions,
    handler: async (args: string, cmdCtx: Parameters<typeof handleCacheOptimizerCommand>[1]) => {
      // Commands read and reset aggregated stats; let a background restore
      // finish first so they never act on a half-restored view.
      await waitForStatsRestore();
      return handleCacheOptimizerCommand(args, cmdCtx);
    },
  });
}
