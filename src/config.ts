import { type AtomicTargetGuard, atomicCreateTextFileNoReplace, atomicReplaceTextFilePreservingMode, hashText, withModelsJsonTransactionLock } from "./atomic-fs.ts";
import { LOG_PREFIX, type MutableEnv, asRecord, getErrorCode, hasEnv, isNonEmptyString, readEnv } from "./common.ts";
import { STATE_DIR } from "./paths.ts";
import { OMP_CACHE_RETENTION_ENV, STARTUP_CACHE_RETENTION_ENV, readCacheRetentionValue, requestLongCacheRetention, restoreCacheRetentionEnv } from "./retention.ts";
import { type Stats, readFileSync } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";


export const CONFIG_FILE_PATH = join(STATE_DIR, "omp-cache-optimizer-config.json");

export const OPENAI_CACHE_KEY_ENV = "OMP_CACHE_OPTIMIZER_OPENAI_CACHE_KEY";

export const NO_OPENAI_CACHE_KEY_ENV = "OMP_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY";

export const TOOL_ORDER_ENV = "OMP_CACHE_OPTIMIZER_TOOL_ORDER";

export const NO_ZERO_PRICE_WARMING_ENV = "OMP_CACHE_OPTIMIZER_NO_ZERO_PRICE_WARMING";

export const FOOTER_MODE_ENV = "OMP_CACHE_OPTIMIZER_FOOTER_MODE";

/** Kill switch for the incremental footer refresh: 0/false/off/no restores a full scan per refresh. */
export const STATS_INCREMENTAL_ENV = "OMP_CACHE_OPTIMIZER_STATS_INCREMENTAL";

/** Opt-in check (1/true/on/yes) that the footer's shard cache never misses a change the file identity hides (see TieredShardIndex.verifyCachedContents). */
export const STATS_VERIFY_ENV = "OMP_CACHE_OPTIMIZER_STATS_VERIFY";

export function isStatsVerifyEnabled(env: MutableEnv = process.env): boolean {
  return isEnabledEnv(readEnv(env, STATS_VERIFY_ENV));
}

/** Opt-in footer refresh timing log: 1/true/on/yes writes JSON lines to STATS_TIMING_LOG_PATH; an absolute path writes there. */
export const STATS_TIMING_ENV = "OMP_CACHE_OPTIMIZER_STATS_TIMING";

export type FooterStatsMode = "session" | "total" | "process";

export type FooterStatsModeSource = "config" | "env" | "default";

export type PersistedCacheOptimizerConfigV1 = {
  version: 1;
  footerMode?: FooterStatsMode;
};

/**
 * OMP 版可持久化的特性开关。上游的 virtualRewrite（Pi 原生虚拟模型）与
 * skillCompression（Pi systemPromptOptions.skills）在 OMP 上没有对应宿主能力，已移除。
 */
export type PersistedCacheOptimizerFeature = "promptRewrite" | "openAICacheKey" | "toolOrder" | "zeroPriceWarming" | "statsIncremental";

export const PERSISTED_CACHE_OPTIMIZER_FEATURES: readonly PersistedCacheOptimizerFeature[] = ["promptRewrite", "openAICacheKey", "toolOrder", "zeroPriceWarming", "statsIncremental"];

export type PersistedCacheOptimizerConfigV2 = {
  version: 2;
  footerMode?: FooterStatsMode;
  promptCacheKey?: {
    omit?: string[];
  };
};

export type PersistedCacheOptimizerConfigV3 = {
  version: 2 | 3;
  footerMode?: FooterStatsMode;
  promptCacheKey?: { omit?: string[] };
  features?: Partial<Record<PersistedCacheOptimizerFeature, boolean>>;
};

export type PersistedCacheOptimizerConfig = PersistedCacheOptimizerConfigV1 | PersistedCacheOptimizerConfigV2 | PersistedCacheOptimizerConfigV3;

export let runtimeOptimizerEnabled = true;

export function isEnabledEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function featureEnabled(
  feature: PersistedCacheOptimizerFeature,
  envName: string,
  defaultValue: boolean,
  env: MutableEnv = process.env,
  config: PersistedCacheOptimizerConfigV3 = persistedCacheOptimizerConfig,
): boolean {
  const configured = config.features?.[feature];
  if (configured !== undefined) return configured;
  // OMP fork：prompt 改写默认关闭，仅 OMP_CACHE_OPTIMIZER_PROMPT_REWRITE=1（或持久化配置）开启。
  if (feature === "promptRewrite") return isEnabledEnv(readEnv(env, envName));
  if (feature === "openAICacheKey") {
    return !isEnabledEnv(readEnv(env, envName)) && !isDisabledEnv(readEnv(env, OPENAI_CACHE_KEY_ENV));
  }
  if (feature === "zeroPriceWarming") {
    return !isEnabledEnv(readEnv(env, envName));
  }
  if (feature === "statsIncremental") return !isDisabledEnv(readEnv(env, envName));
  return isEnabledEnv(readEnv(env, envName)) || defaultValue;
}

/** Keep OMP's cache warming running for models whose prices are unknown (all zero). */
export function isZeroPriceWarmingEnabled(): boolean {
  return runtimeOptimizerEnabled && featureEnabled("zeroPriceWarming", NO_ZERO_PRICE_WARMING_ENV, true);
}

/** Prompt 改写（session-overview churn strip）当前是否生效。 */
export function isPromptRewriteEnabled(): boolean {
  return runtimeOptimizerEnabled && featureEnabled("promptRewrite", PROMPT_REWRITE_ENV, false);
}

/**
 * Incremental footer refresh (tiered shard index). Unlike the optimizer
 * features it does not follow /cache-optimizer disable: it changes how stats
 * are read, not what is sent to providers.
 *
 * Kill switch: `/cache-optimizer config stats-incremental off` (persisted,
 * wins over the environment like every feature setting) or
 * OMP_CACHE_OPTIMIZER_STATS_INCREMENTAL=0.
 */
export function isStatsIncrementalEnabled(
  env: MutableEnv = process.env,
  config: PersistedCacheOptimizerConfigV3 = persistedCacheOptimizerConfig,
): boolean {
  return featureEnabled("statsIncremental", STATS_INCREMENTAL_ENV, true, env, config);
}

export const STATS_TIMING_LOG_PATH = join(STATE_DIR, "omp-cache-optimizer-stats-timing.jsonl");

/** Where the opt-in refresh timing log goes, or undefined when it is off. */
export function statsTimingLogPath(env: MutableEnv = process.env): string | undefined {
  const value = readEnv(env, STATS_TIMING_ENV)?.trim();
  if (!value || isDisabledEnv(value)) return undefined;
  if (isEnabledEnv(value)) return STATS_TIMING_LOG_PATH;
  return isAbsolute(value) ? value : undefined;
}

export function isToolOrderEnabled(env: MutableEnv = process.env): boolean {
  return runtimeOptimizerEnabled && featureEnabled("toolOrder", TOOL_ORDER_ENV, false);
}

export function parseFooterStatsMode(value: unknown): FooterStatsMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "session" || normalized === "total" || normalized === "process" ? normalized : undefined;
}

export function parsePersistedCacheOptimizerConfig(value: unknown): PersistedCacheOptimizerConfig | undefined {
  const record = asRecord(value);
  if (!record || (record.version !== 1 && record.version !== 2 && record.version !== 3)) return undefined;
  const allowedTopLevel = new Set(record.version === 1 ? ["version", "footerMode"] : record.version === 2 ? ["version", "footerMode", "promptCacheKey"] : ["version", "footerMode", "promptCacheKey", "features"]);
  if (Object.keys(record).some((key) => !allowedTopLevel.has(key))) return undefined;
  const footerMode = parseFooterStatsMode(record.footerMode);
  if (record.footerMode !== undefined && !footerMode) return undefined;
  if (record.version === 1) return { version: 1, ...(footerMode ? { footerMode } : {}) };

  const rawFeatures = record.version === 3 ? record.features : undefined;
  if (rawFeatures !== undefined && !asRecord(rawFeatures)) return undefined;
  const featuresRecord = asRecord(rawFeatures);
  const featureNames = new Set<PersistedCacheOptimizerFeature>(PERSISTED_CACHE_OPTIMIZER_FEATURES);
  if (featuresRecord && Object.keys(featuresRecord).some((key) => !featureNames.has(key as PersistedCacheOptimizerFeature) || typeof featuresRecord[key] !== "boolean")) return undefined;

  const rawPromptCacheKey = record.promptCacheKey;
  if (rawPromptCacheKey !== undefined && !asRecord(rawPromptCacheKey)) return undefined;
  const promptCacheKey = asRecord(rawPromptCacheKey);
  if (promptCacheKey && Object.keys(promptCacheKey).some((key) => key !== "omit")) return undefined;
  const omit = promptCacheKey?.omit;
  if (omit !== undefined && (!Array.isArray(omit) || omit.some((value): value is string => !isNonEmptyString(value)))) return undefined;
  const stringOmit = omit as string[] | undefined;
  const uniqueOmit = stringOmit ? [...new Set(stringOmit.map((value) => value.trim()))].sort() : undefined;
  return {
    version: record.version === 3 ? 3 : 2,
    ...(footerMode ? { footerMode } : {}),
    ...(uniqueOmit && uniqueOmit.length > 0 ? { promptCacheKey: { omit: uniqueOmit } } : {}),
    ...(featuresRecord ? { features: Object.fromEntries(Object.entries(featuresRecord)) as Partial<Record<PersistedCacheOptimizerFeature, boolean>> } : {}),
  } as PersistedCacheOptimizerConfigV3;
}

export function normalizePersistedCacheOptimizerConfig(value: PersistedCacheOptimizerConfig | undefined): PersistedCacheOptimizerConfigV3 {
  if (!value) return { version: 2 };
  const features = value.version === 3 ? value.features : undefined;
  return {
    version: features ? 3 : 2,
    ...(value.footerMode ? { footerMode: value.footerMode } : {}),
    ...(value.version !== 1 && value.promptCacheKey ? { promptCacheKey: value.promptCacheKey } : {}),
    ...(features ? { features } : {}),
  };
}

export function readPersistedCacheOptimizerConfig(configPath: string = CONFIG_FILE_PATH): PersistedCacheOptimizerConfigV3 {
  try {
    return normalizePersistedCacheOptimizerConfig(parsePersistedCacheOptimizerConfig(JSON.parse(readFileSync(configPath, "utf8"))));
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") console.warn(`${LOG_PREFIX}: failed to read optimizer config; using defaults`, error);
    return { version: 2 };
  }
}

export async function writePersistedCacheOptimizerConfigUnlocked(
  config: PersistedCacheOptimizerConfig | PersistedCacheOptimizerConfigV3,
  configPath: string,
  expectedTarget?: AtomicTargetGuard | null,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const payloadText = JSON.stringify(normalizePersistedCacheOptimizerConfig(config), null, 2) + "\n";
  let targetInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  let targetMode = 0o600;
  let targetHash: string | undefined;
  try {
    targetInfo = await lstat(configPath);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) throw new Error("optimizer config is not a regular file; no changes were made");
    const targetText = await readFile(configPath, "utf8");
    targetMode = targetInfo.mode & 0o7777;
    targetHash = hashText(targetText);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
  // Feature mutations bind the original read, not a newer snapshot taken by
  // this writer. The lease serializes extension writers; this guard also
  // rejects a manual edit/replacement between the read and atomic commit.
  if ((expectedTarget === null && targetInfo) || (expectedTarget && !targetInfo)) {
    throw new Error("optimizer config changed during the update; refusing to overwrite user changes");
  }
  if (targetInfo) {
    await atomicReplaceTextFilePreservingMode(configPath, payloadText, targetMode, "config", expectedTarget ?? {
      identity: targetInfo,
      hash: targetHash,
      mode: targetMode,
    });
    return;
  }

  await atomicCreateTextFileNoReplace(configPath, payloadText, targetMode, "config");
}

export async function writePersistedCacheOptimizerConfig(
  config: PersistedCacheOptimizerConfig | PersistedCacheOptimizerConfigV3,
  configPath: string = CONFIG_FILE_PATH,
): Promise<void> {
  await withModelsJsonTransactionLock(() => writePersistedCacheOptimizerConfigUnlocked(config, configPath));
}

export async function writePersistedFooterModeUnlocked(
  mode: FooterStatsMode,
  configPath: string,
): Promise<void> {
  let version: 1 | 2 | 3 = 1;
  let raw: PersistedCacheOptimizerConfig | undefined;
  let targetExists = false;
  try {
    raw = parsePersistedCacheOptimizerConfig(JSON.parse(readFileSync(configPath, "utf8")));
    targetExists = true;
    if (!raw) throw new Error("invalid footer config schema");
    version = raw.version === 3 ? 3 : raw.version === 2 ? 2 : 1;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw new Error("invalid footer config schema");
  }
  const current = normalizePersistedCacheOptimizerConfig(raw);
  if (version === 1 && !current.promptCacheKey) {
    await mkdir(dirname(configPath), { recursive: true });
    const targetInfo = targetExists ? await lstat(configPath) : undefined;
    if (targetInfo && (targetInfo.isSymbolicLink() || !targetInfo.isFile())) throw new Error("optimizer config is not a regular file; no changes were made");
    const targetText = targetInfo ? await readFile(configPath, "utf8") : undefined;
    const targetMode = targetInfo ? targetInfo.mode & 0o7777 : 0o600;
    const footerText = JSON.stringify({ version: 1, footerMode: mode }, null, 2) + "\n";
    if (targetInfo && targetText !== undefined) {
      await atomicReplaceTextFilePreservingMode(configPath, footerText, targetMode, "config-footer", {
        identity: targetInfo,
        hash: hashText(targetText),
        mode: targetMode,
      });
    } else {
      await atomicCreateTextFileNoReplace(configPath, footerText, targetMode, "config-footer");
    }
    return;
  }
  await writePersistedCacheOptimizerConfigUnlocked({ ...current, version: 3, footerMode: mode } as PersistedCacheOptimizerConfigV3, configPath);
}

export async function writePersistedFooterMode(
  mode: FooterStatsMode,
  configPath: string = CONFIG_FILE_PATH,
): Promise<void> {
  await withModelsJsonTransactionLock(() => writePersistedFooterModeUnlocked(mode, configPath));
}

async function updatePersistedFeatures(
  update: (features: Partial<Record<PersistedCacheOptimizerFeature, boolean>>) => PersistedCacheOptimizerConfigV3["features"],
  configPath: string,
): Promise<void> {
  await withModelsJsonTransactionLock(async () => {
    let targetInfo: Stats | undefined;
    try {
      targetInfo = await lstat(configPath);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") throw error;
    }
    let raw: PersistedCacheOptimizerConfig | undefined;
    let guard: AtomicTargetGuard | null = null;
    if (targetInfo) {
      if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
        throw new Error("optimizer config is not a regular file; no changes were made");
      }
      try {
        const text = await readFile(configPath, "utf8");
        raw = parsePersistedCacheOptimizerConfig(JSON.parse(text));
        if (!raw) throw new Error("invalid optimizer config schema");
        guard = { identity: targetInfo, hash: hashText(text), mode: targetInfo.mode & 0o7777 };
      } catch {
        throw new Error(`optimizer config ${configPath} is invalid or unreadable; refusing to overwrite user changes. Fix or remove it, then retry.`);
      }
    }
    const current = normalizePersistedCacheOptimizerConfig(raw);
    await writePersistedCacheOptimizerConfigUnlocked({
      ...current,
      version: 3,
      features: update(current.features ?? {}),
    }, configPath, guard);
  });
  if (configPath === CONFIG_FILE_PATH) setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
}

export async function writePersistedFeature(
  feature: PersistedCacheOptimizerFeature,
  enabled: boolean,
  configPath: string = CONFIG_FILE_PATH,
): Promise<void> {
  await updatePersistedFeatures((features) => ({ ...features, [feature]: enabled }), configPath);
}

export async function resetPersistedFeatures(configPath: string = CONFIG_FILE_PATH): Promise<void> {
  await updatePersistedFeatures(() => undefined, configPath);
}

export function resolveFooterStatsMode(
  configuredMode: FooterStatsMode | undefined,
  env: MutableEnv = process.env,
): { mode: FooterStatsMode; source: FooterStatsModeSource } {
  if (configuredMode) return { mode: configuredMode, source: "config" };
  const envMode = parseFooterStatsMode(readEnv(env, FOOTER_MODE_ENV));
  return envMode ? { mode: envMode, source: "env" } : { mode: "session", source: "default" };
}

export function footerStatsMode(
  env: MutableEnv = process.env,
  configuredMode: FooterStatsMode | undefined = persistedFooterStatsMode,
): FooterStatsMode {
  return resolveFooterStatsMode(configuredMode, env).mode;
}

export let persistedCacheOptimizerConfig = readPersistedCacheOptimizerConfig();

export let persistedFooterStatsMode = persistedCacheOptimizerConfig.footerMode;

export function isDisabledEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

export function shouldInjectOpenAIPromptCacheKey(): boolean {
  return runtimeOptimizerEnabled && featureEnabled("openAICacheKey", NO_OPENAI_CACHE_KEY_ENV, true);
}

export function setPersistedCacheOptimizerConfig(config: PersistedCacheOptimizerConfig | PersistedCacheOptimizerConfigV3): void {
  persistedCacheOptimizerConfig = normalizePersistedCacheOptimizerConfig(config);
  persistedFooterStatsMode = persistedCacheOptimizerConfig.footerMode;
}

export function setRuntimeOptimizerEnabled(enabled: boolean, env: MutableEnv = process.env): void {
  runtimeOptimizerEnabled = enabled;
  if (enabled) {
    requestLongCacheRetention(env);
  } else {
    restoreCacheRetentionEnv(STARTUP_CACHE_RETENTION_ENV, env);
  }
}

export function isRuntimeOptimizerEnabled(): boolean {
  return runtimeOptimizerEnabled;
}

export function readPersistedFooterMode(configPath: string = CONFIG_FILE_PATH): FooterStatsMode | undefined {
  return readPersistedCacheOptimizerConfig(configPath).footerMode;
}

export function getOptimizerRuntimeModeLines(): string[] {
  const state = runtimeOptimizerEnabled ? "已启用" : "已关闭";
  const lines: string[] = [];
  lines.push(`运行状态：${state}`);
  lines.push(`• Prompt 重写：${isPromptRewriteEnabled() ? "开启" : "关闭"}（默认关闭；只原地清理 <session-overview> 易变字段，不压缩、不重排）`);
  lines.push(`• 内置工具确定性排序：${isToolOrderEnabled() ? "开启（仅已验证的内置 payload，需显式开启）" : "关闭"}`);
  lines.push(`• OpenAI prompt_cache_key 兜底：${shouldInjectOpenAIPromptCacheKey() ? "开启" : "关闭"}`);
  lines.push(`• Footer 缓存统计：开启${runtimeOptimizerEnabled ? "" : "（对比模式）"}`);
  lines.push(`• Compat 提醒：${runtimeOptimizerEnabled ? "开启" : "关闭"}`);
  lines.push(`• ${OMP_CACHE_RETENTION_ENV}：${readCacheRetentionValue(process.env) ?? "（未设置）"}`);
  lines.push(`• 持久化特性覆盖：${Object.keys(persistedCacheOptimizerConfig.features ?? {}).length > 0 ? "已配置" : "无"}`);
  if (!runtimeOptimizerEnabled) {
    lines.push("这是当前进程开关。运行 /reload 或重启 OMP 可恢复启动时的行为。");
  } else if (!shouldInjectOpenAIPromptCacheKey()) {
    lines.push("部分特性被持久化配置或环境变量关闭。");
  }
  return lines;
}

export function formatPersistentFeatureConfig(): string {
  const features = persistedCacheOptimizerConfig.features ?? {};
  const lines = ["持久化特性配置："];
  const entries: Array<[string, PersistedCacheOptimizerFeature, string, boolean]> = [
    ["Prompt 重写", "promptRewrite", PROMPT_REWRITE_ENV, false],
    ["OpenAI cache key", "openAICacheKey", NO_OPENAI_CACHE_KEY_ENV, true],
    ["工具排序", "toolOrder", TOOL_ORDER_ENV, false],
    ["零价格模型缓存预热", "zeroPriceWarming", NO_ZERO_PRICE_WARMING_ENV, true],
    ["增量 footer 刷新", "statsIncremental", STATS_INCREMENTAL_ENV, true],
  ];
  for (const [label, feature, envName, defaultValue] of entries) {
    const envSet = hasEnv(process.env, envName) || (feature === "openAICacheKey" && hasEnv(process.env, OPENAI_CACHE_KEY_ENV));
    const source = features[feature] !== undefined ? "配置" : envSet ? "环境变量" : "默认";
    lines.push(`• ${label}：${featureEnabled(feature, envName, defaultValue) ? "开启" : "关闭"}（${source}）`);
  }
  return lines.join("\n");
}

export function formatOptimizerRuntimeMode(): string {
  return getOptimizerRuntimeModeLines().join("\n");
}

/**
 * OMP fork：显式开启 prompt 改写（session-overview churn strip）。
 * 旧的 OMP_/PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE 不再受支持：OMP 上默认就是关闭。
 */
export const PROMPT_REWRITE_ENV = "OMP_CACHE_OPTIMIZER_PROMPT_REWRITE";
