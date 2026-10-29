import { type PiModel, type UnknownRecord, asRecord } from "./common.ts";

/**
 * OMP compat 中本扩展读取的子集（字段名以 OMP 18 的 @oh-my-pi/pi-catalog 为准）。
 *
 * 与上游 Pi 字段的对应：
 * - Pi `supportsLongCacheRetention`（OpenAI 侧）→ OMP `supportsLongPromptCacheRetention`（仅 Responses API）
 * - Pi `supportsLongCacheRetention`（Anthropic 侧）→ OMP 同名 `supportsLongCacheRetention`
 * - Pi `requiresReasoningContentOnAssistantMessages` → OMP `requiresReasoningContentForToolCalls`
 * - Pi `sendSessionAffinityHeaders` / `sendSessionIdHeader` / `sessionAffinityFormat` → OMP 无（多凭据 + agent.db 会话亲和）
 * - Pi `forceAdaptiveThinking` → OMP 无（目录自动设置 disableAdaptiveThinking）
 */
export type CacheCompat = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsStrictMode?: boolean;
  /** openai-responses：是否接受 `prompt_cache_retention: "24h"`。 */
  supportsLongPromptCacheRetention?: boolean;
  /** anthropic-messages：是否接受 1h cache_control ttl。 */
  supportsLongCacheRetention?: boolean;
  /** openai-completions（解析后）：是否发送顶层 `prompt_cache_key`。 */
  supportsPromptCacheKey?: boolean;
  thinkingFormat?: string;
  requiresReasoningContentForToolCalls?: boolean;
  cacheControlFormat?: string;
  isOpenRouterHost?: boolean;
  officialEndpoint?: boolean;
  openRouterRouting?: UnknownRecord;
  vercelGatewayRouting?: UnknownRecord;
  extraBody?: UnknownRecord;
};

/** Nested compat records that merge key-by-key instead of being replaced. */
export const NESTED_COMPAT_KEYS = [
  "openRouterRouting",
  "vercelGatewayRouting",
  "extraBody",
] as const;

export function mergeCacheCompat(...sources: Array<UnknownRecord | undefined>): CacheCompat {
  const merged: CacheCompat = {};
  for (const source of sources) {
    if (!source) continue;
    const previousNested = Object.fromEntries(
      NESTED_COMPAT_KEYS.map((key) => [key, asRecord(merged[key])]),
    ) as Partial<Record<(typeof NESTED_COMPAT_KEYS)[number], UnknownRecord | undefined>>;
    Object.assign(merged, source);
    for (const key of NESTED_COMPAT_KEYS) {
      const baseValue = previousNested[key];
      const overrideValue = asRecord(source[key]);
      if (baseValue || overrideValue) {
        merged[key] = { ...baseValue, ...overrideValue };
      }
    }
  }
  return merged;
}

/**
 * OMP 的 Model 同时携带两层 compat：
 * - `compatConfig`：models.yml / modelOverrides / 运行时注册里用户写下的稀疏原文（用户意图）；
 * - `compat`：`buildModel` 物化后的完整解析结果（宿主实际使用的值）。
 * 上游 Pi 需要重读 models.json 才能区分"显式配置"和"默认值"，OMP 直接提供了这两层。
 */
export function getEffectiveCompatSources(model: PiModel): Array<{ source: "config" | "runtime"; compat: UnknownRecord }> {
  const record = model as PiModel & { compatConfig?: unknown };
  const configCompat = asRecord(record.compatConfig);
  const runtimeCompat = asRecord(model.compat);
  return [
    ...(configCompat ? [{ source: "config" as const, compat: configCompat }] : []),
    ...(runtimeCompat ? [{ source: "runtime" as const, compat: runtimeCompat }] : []),
  ];
}

/** 合并后的生效 compat：解析结果优先于用户原文（宿主实际以解析结果发请求）。 */
export function resolveEffectiveCompat(model: PiModel): CacheCompat {
  return mergeCacheCompat(...getEffectiveCompatSources(model).map(({ compat }) => compat));
}

/** 用户在 models.yml 等配置里显式写下的 compat（不含宿主自动探测的默认值）。 */
export function resolveExplicitCompat(model: PiModel): CacheCompat {
  const record = model as PiModel & { compatConfig?: unknown };
  return mergeCacheCompat(asRecord(record.compatConfig));
}
