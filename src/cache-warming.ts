import { type PiModel, asRecord, isNonEmptyString } from "./common.ts";
import { STATE_DIR } from "./paths.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Diagnostics for OMP's native prompt-cache warming (`providers.cacheWarming`
 * setting, OMP 18). OMP re-sends the last request with a one-token output cap
 * at 90% of the cache lifetime, but only when:
 *   - the global `providers.cacheWarming` setting is not "off";
 *   - the model declares `promptCache.<tier>` for the retention tier in use;
 *   - the model's prices let OMP estimate the savings (cost.cacheRead/cacheWrite/input);
 *   - the request is replayable (Anthropic budget-based thinking is not).
 * Streaming warming stops 60 minutes after the real request and idle warming
 * after 30 minutes, so idle mode never refreshes a 1-hour cache entry (its
 * refresh would fire at 54 minutes).
 *
 * This module only reads state and explains it; it never changes settings or
 * models.yml. The extension does not run its own keepalive timer, because a
 * second warmer would double-bill refreshes and could not replay OMP's exact
 * request context.
 */

export type CacheWarmingMode = "off" | "streaming" | "idle";

/** OMP 18 的 `providers.cacheWarming` 默认值。 */
export const CACHE_WARMING_DEFAULT_MODE: CacheWarmingMode = "idle";
export const CACHE_WARMING_STREAMING_MAX_MS = 60 * 60_000;
export const CACHE_WARMING_IDLE_MAX_MS = 30 * 60_000;

/** Same schedule OMP uses: 90% of the TTL, keeping at least ten seconds of margin. */
export function cacheWarmingRefreshDelayMs(ttlMs: number): number | undefined {
  if (ttlMs <= 10_000) return undefined;
  return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/** Reads the parsed global OMP config (config.yml); undefined when unavailable. */
export type CacheWarmingSettingsReader = () => unknown;

export const OMP_CONFIG_YML_PATH = join(STATE_DIR, "config.yml");

/**
 * Parse `~/.omp/agent/config.yml` with the Bun runtime's YAML parser (OMP runs
 * extensions on Bun). Returns undefined outside Bun or when the file is
 * missing/unreadable, so callers fall back to the default mode.
 */
export function readOmpGlobalConfig(path: string = OMP_CONFIG_YML_PATH): unknown {
  const yaml = (globalThis as { Bun?: { YAML?: { parse?: (text: string) => unknown } } }).Bun?.YAML;
  if (typeof yaml?.parse !== "function") return undefined;
  try {
    return yaml.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Read the `providers.cacheWarming` mode from OMP's global config. A missing
 * or unrecognized value means OMP's default. Project-level `.omp/config.yml`
 * overrides are not consulted; doctor says so.
 */
export function readCacheWarmingMode(readConfig: CacheWarmingSettingsReader = readOmpGlobalConfig): CacheWarmingMode {
  let config: unknown;
  try {
    config = readConfig();
  } catch {
    return CACHE_WARMING_DEFAULT_MODE;
  }
  const root = asRecord(config);
  const providers = asRecord(root?.providers);
  const value = providers?.cacheWarming ?? root?.["providers.cacheWarming"];
  if (value === "off" || value === "streaming" || value === "idle") return value;
  return CACHE_WARMING_DEFAULT_MODE;
}

export function suggestedPromptCacheLifetimes(model: PiModel): { short: number; long?: number } {
  // Anthropic documents a 5-minute default and an optional 1-hour TTL. For
  // other APIs only the conservative short lifetime is suggested; extended
  // retention differs per provider and deployment.
  if (model.api === "anthropic-messages") return { short: 300, long: 3600 };
  // Elsewhere only the short tier has a value the extension can stand behind.
  return { short: 300 };
}

function readPromptCacheTier(model: PiModel, tier: "short" | "long"): number | undefined {
  const promptCache = asRecord((model as unknown as Record<string, unknown>).promptCache);
  const value = promptCache?.[tier];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function hasPricing(model: PiModel): boolean {
  const cost = asRecord((model as unknown as Record<string, unknown>).cost);
  if (!cost) return false;
  return ["input", "cacheRead", "cacheWrite"].some((key) => typeof cost[key] === "number" && (cost[key] as number) > 0);
}

const PRICE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function hasPositivePrice(record: Record<string, unknown> | undefined): boolean {
  if (!record) return false;
  return PRICE_KEYS.some((key) => typeof record[key] === "number" && (record[key] as number) > 0);
}

/**
 * OpenRouter router models (`openrouter/auto`, `openrouter/free`-style ids)
 * forward to whichever model the router picks. OpenRouter lists them with a
 * placeholder price, so a zero cost block means "unknown", not "free".
 * Matched on the id prefix so the same router reached through another
 * provider entry is covered too.
 */
export function isOpenRouterRouterModel(model: PiModel): boolean {
  return typeof model.id === "string" && model.id.toLowerCase().startsWith("openrouter/");
}

function costTiers(cost: Record<string, unknown>): unknown[] {
  return Array.isArray(cost.tiers) ? cost.tiers : [];
}

/** Prompt-length tiers carry prices but the base cost block does not. */
function hasOnlyTierPrices(model: PiModel): boolean {
  const cost = asRecord((model as unknown as Record<string, unknown>).cost);
  if (!cost || hasPositivePrice(cost)) return false;
  return costTiers(cost).some((tier) => hasPositivePrice(asRecord(tier)));
}

/**
 * Every price OMP uses for warming economics is zero or missing, including
 * prompt-length cost tiers, and the zero is not a placeholder for an unknown
 * router price.
 */
export function isZeroPriced(model: PiModel): boolean {
  if (isOpenRouterRouterModel(model)) return false;
  const cost = asRecord((model as unknown as Record<string, unknown>).cost);
  if (!cost) return true;
  if (hasPositivePrice(cost)) return false;
  return !costTiers(cost).some((tier) => hasPositivePrice(asRecord(tier)));
}

/** Mirrors OMP's isReplayable: Anthropic budget-based reasoning cannot be replayed with a one-token cap. */
function isReplayableForWarming(model: PiModel): boolean {
  if (!model.reasoning || model.api !== "anthropic-messages") return true;
  const thinking = asRecord((model as unknown as Record<string, unknown>).thinking);
  return isNonEmptyString(thinking?.mode) && thinking.mode === "anthropic-adaptive";
}

export type CacheWarmingDiagnosisInput = {
  mode: CacheWarmingMode | "unsupported";
  /** Retention tier OMP uses for this request ("long" when OMP_CACHE_RETENTION=long and the model supports it). */
  tier: "short" | "long";
  /** Whether the extension keeps warming running for zero-price models. */
  zeroPriceWarming?: boolean;
};

export type CacheWarmingDiagnosis = {
  eligible: boolean;
  issues: string[];
  lines: string[];
};

function formatSeconds(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function buildCacheWarmingDiagnosis(model: PiModel, input: CacheWarmingDiagnosisInput): CacheWarmingDiagnosis {
  const lines: string[] = ["", "🔥 Prompt 缓存预热（OMP providers.cacheWarming）："];
  const issues: string[] = [];

  if (input.mode === "unsupported") {
    lines.push("- 当前 OMP 宿主没有暴露缓存预热设置，无需检查。");
    return { eligible: false, issues: ["unsupported"], lines };
  }

  lines.push(`- 模式：${input.mode}${input.mode === CACHE_WARMING_DEFAULT_MODE ? "（默认）" : ""} —— 全局设置，可用 /settings 或 ~/.omp/agent/config.yml 的 providers.cacheWarming 修改（项目级覆盖不在此显示）`);
  lines.push(`- 当前使用的保留档位：${input.tier}`);

  if (input.mode === "off") {
    issues.push("mode_off");
    lines.push("- 预热已关闭：长时间的工具调用可能让缓存条目过期，下一次请求会重新写入缓存。");
  }

  const ttl = readPromptCacheTier(model, input.tier);
  if (ttl === undefined) {
    issues.push("prompt_cache_missing");
    const suggested = suggestedPromptCacheLifetimes(model);
    const snippet = suggested.long !== undefined
      ? `{ short: ${suggested.short}, long: ${suggested.long} }`
      : `{ short: ${suggested.short} }`;
    lines.push(`- ⚠️ 该模型没有声明 promptCache.${input.tier} 生存期，OMP 不会为它预热缓存。`);
    lines.push(`  在 models.yml 的自定义模型条目，或 providers.<provider>.modelOverrides.${JSON.stringify(model.id)}（内置模型）下添加：`);
    lines.push(`  promptCache: ${snippet}`);
    if (input.tier === "long" && suggested.long === undefined) {
      lines.push("  只填写 provider 文档明确给出的长缓存生存期；有范围时取保守值。");
    }
  } else {
    lines.push(`- promptCache.${input.tier}：${formatSeconds(ttl)}`);
  }

  if (!hasPricing(model)) {
    if (input.zeroPriceWarming && isZeroPriced(model)) {
      lines.push("- 该模型没有输入/缓存价格。OMP 本会跳过预热；本扩展会覆盖这一判断（config zero-price-warming 开启）。");
    } else if (isOpenRouterRouterModel(model)) {
      issues.push("pricing_unknown");
      lines.push("- ⚠️ OpenRouter 路由模型的价格是占位值，实际按被路由到的模型计费。OMP 无法估算节省，会跳过预热；零价格预热不适用。");
    } else if (hasOnlyTierPrices(model)) {
      issues.push("pricing_missing");
      lines.push("- ⚠️ 该模型只有按 prompt 长度分档的价格，没有基础输入/缓存价格，OMP 无法估算节省，会跳过预热。请在 cost 中补充基础价格。");
    } else {
      issues.push("pricing_missing");
      lines.push("- ⚠️ 该模型没有输入/缓存价格，OMP 无法估算节省，会跳过预热。请补充 cost，或开启 /cache-optimizer config zero-price-warming。");
    }
  }

  if (!isReplayableForWarming(model)) {
    issues.push("not_replayable");
    lines.push("- ⚠️ Anthropic 按预算的 thinking 无法用一个 token 的上限重放，OMP 会跳过预热（adaptive thinking 模型不受影响）。");
  }

  if (ttl !== undefined && input.mode === "idle") {
    const delay = cacheWarmingRefreshDelayMs(ttl * 1000);
    if (delay !== undefined && delay > CACHE_WARMING_IDLE_MAX_MS) {
      lines.push(`- 提示：idle 预热在 30 分钟后停止，而 ${formatSeconds(ttl)} 的条目会在 ${Math.round(delay / 60_000)} 分钟时才刷新，所以 idle 模式对这个档位没有作用；${formatSeconds(ttl)} 的生存期本身已覆盖较短的停顿。`);
    }
  }

  const eligible = input.mode !== "off" && issues.length === 0;
  if (eligible) {
    lines.push(`- ✓ 符合条件：当预期节省至少 $0.05 时，OMP 会${input.mode === "idle" ? "在运行期间以及运行之间的短暂空闲里" : "在 agent 运行期间"}保持该缓存预热。`);
  }
  return { eligible, issues, lines };
}

export type CacheWarmingDecisionLike = {
  action?: unknown;
  warmCost?: unknown;
  missCost?: unknown;
};

/**
 * `cache_warming_decision` policy: OMP stops warming when it cannot price the
 * refresh ("cache economics unavailable"), which is every model whose cost
 * block is all zero, the common case for custom proxy channels. A refresh is a
 * cache read of the prompt plus one output token, far cheaper than rewriting
 * the cache, so keep warming for those models. OMP's own decision stands
 * whenever the model has real prices, and OMP's mode, lifetime, replayability
 * and 60m/30m safety limits still apply.
 */
export function decideZeroPriceWarming(event: CacheWarmingDecisionLike, model: PiModel | undefined): "warm" | undefined {
  if (!model || event.action !== "stop") return undefined;
  if (event.warmCost !== 0 || event.missCost !== 0) return undefined;
  if (!isZeroPriced(model)) return undefined;
  return "warm";
}
