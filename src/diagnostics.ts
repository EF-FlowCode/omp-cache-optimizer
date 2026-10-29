import { type CacheProviderAdapter } from "./adapters.ts";
import { type PiModel, type UnknownRecord, asRecord, isNonEmptyString, lower } from "./common.ts";
import { type CompatAdvicePlacement, appendDeepSeekCompatAdviceLines, appendOpenAIProxyCompatAdviceLines, buildDeepSeekCompatSuggestion, buildSafeOpenAIProxyCompatSuggestion, describeMissingCacheCompatForModel, getModelsYmlDisplayPath, isAdaptiveThinkingCompatApplicable, isDeepSeekWireCompatApplicable } from "./compat-advice.ts";
import { type FixSuggestion } from "./fix-types.ts";
import { getCompat, getExplicitCompat, isKnownThirdPartyOpenAIEndpoint, isMistralConversationsApi, isOfficialOpenAIBaseUrl, isOpenAICompatibleApi, isOpenAICompatibleProxyApi, modelKey } from "./model-identity.ts";
import { type CacheUsageSample, type PromptDiagnosticSample, formatRecentTrendSummary } from "./stats-report.ts";
import { type CacheStats, emptyCacheStats } from "./stats-store.ts";
import { snapshotBaseUrlForDiagnostics, snapshotCompatForDiagnostics } from "./request-state.ts";

/** OMP divergence：OMP 自动处理 adaptive thinking，没有可建议的 compat（保留以对齐上游调用点）。 */
export function buildAdaptiveThinkingCompatSuggestion(_missing: string[]): Record<string, unknown> {
  return {};
}

/** OMP divergence：见 buildAdaptiveThinkingCompatSuggestion。 */
export function appendAdaptiveThinkingCompatAdviceLines(_lines: string[], _missing: string[], _placement: CompatAdvicePlacement = {}): void {}

/** 仅字面 `api: openai-responses` 的第三方 endpoint 可以声明 24h prompt_cache_retention。 */
export function isOpenAIResponsesLongRetentionApi(api: unknown): boolean {
  return lower(api) === "openai-responses";
}

/**
 * 可选（不会触发 ⚠️ 配置标记，也不会出现在修复片段里）：第三方 openai-responses
 * endpoint 的 supportsLongPromptCacheRetention。其他 API（含 openai-completions）一律不建议。
 */
export function describeOptionalOpenAICompatibleProxyCompat(model: PiModel): string[] {
  const optional: string[] = [];
  if (!isOpenAIResponsesLongRetentionApi(model.api)) return optional;
  if (!isKnownThirdPartyOpenAIEndpoint(model)) return optional;
  if (getCompat(model).supportsLongPromptCacheRetention !== true) {
    optional.push("supportsLongPromptCacheRetention");
  }
  return optional;
}

export function getPromptCacheRetentionUnsupportedHint(): string {
  return "如果第三方 openai-responses endpoint 返回 `400 Unsupported parameter: prompt_cache_retention`，请移除 `supportsLongPromptCacheRetention` 或改用支持该字段的 endpoint；本扩展观测到这个 400 后会在本进程内自动去掉该字段。";
}

export function isPromptCacheKeyUnsupportedApplicable(model: PiModel): boolean {
  return isOpenAICompatibleApi(model.api);
}

export function getOptionalAssistantHttpStatus(record: UnknownRecord): number | undefined {
  const readStatus = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
      const parsed = Number(value.trim());
      return parsed >= 100 && parsed <= 599 ? parsed : undefined;
    }
    return undefined;
  };

  // OMP 的 AssistantMessage 在 provider 失败时带结构化的 `errorStatus`。
  for (const key of ["errorStatus", "status", "statusCode", "httpStatus", "httpStatusCode"]) {
    const status = readStatus(record[key]);
    if (status !== undefined) return status;
  }

  // Foreign/provider adapters sometimes put the HTTP status under a
  // diagnostic `details`, `error`, or `cause` object rather than exposing it
  // on the finalized assistant message itself. Traverse only these known
  // diagnostic wrappers, with a small depth bound; never inspect arbitrary
  // payload/message fields for a number that happens to look like a status.
  const scanDiagnosticStatus = (value: unknown, depth: number): number | undefined => {
    if (depth > 2) return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const status = scanDiagnosticStatus(item, depth + 1);
        if (status !== undefined) return status;
      }
      return undefined;
    }
    const source = asRecord(value);
    if (!source) return undefined;
    for (const key of ["status", "statusCode", "httpStatus", "httpStatusCode", "code"]) {
      const status = readStatus(source[key]);
      if (status !== undefined) return status;
    }
    for (const key of ["details", "error", "cause", "diagnostics"]) {
      const status = scanDiagnosticStatus(source[key], depth + 1);
      if (status !== undefined) return status;
    }
    return undefined;
  };
  for (const key of ["diagnostics", "diagnostic", "details", "error", "cause"]) {
    const status = scanDiagnosticStatus(record[key], 0);
    if (status !== undefined) return status;
  }

  // Built-in OpenAI-compatible adapters normally prefix a provider error
  // body with the HTTP status (for example `400: {...}` or
  // `OpenAI API error (400): ...`). Only parse status-shaped prefixes; never
  // search arbitrary body text where a model id or payload number could be
  // mistaken for a response status.
  if (typeof record.errorMessage === "string") {
    const errorText = record.errorMessage;
    const matches = [
      /^\s*([1-5]\d{2})\b/,
      /^\s*(?:http(?:\s+status)?|status(?:\s+code)?)\s*[:(]?\s*([1-5]\d{2})\b/i,
      /^\s*[^():\n]{1,100}\(\s*([1-5]\d{2})\b/,
      /^\s*(?:error|api\s+error|provider\s+error|request\s+failed|http\s+error)\s*[:(]\s*([1-5]\d{2})\b/i,
    ];
    for (const pattern of matches) {
      const match = pattern.exec(errorText);
      if (match) return Number(match[1]);
    }
  }
  return undefined;
}

export function appendOptionalOpenAIProxyCompatAdviceLines(lines: string[], optional: string[]): void {
  if (!optional.includes("supportsLongPromptCacheRetention")) return;
  lines.push("");
  lines.push("可选项（非必需，不会自动修复，仅 api: openai-responses）：");
  lines.push("- supportsLongPromptCacheRetention：仅当第三方 openai-responses endpoint 明确支持 OpenAI long prompt cache retention 时再开启。");
  lines.push(`- ${getPromptCacheRetentionUnsupportedHint()}`);
}

/**
 * DeepSeek reasoning 回放 compat 检查只针对 OMP 没有识别出来的 DeepSeek 推理模型
 * （见 isDeepSeekWireCompatApplicable）。
 */
export function isDeepSeekCompatCheckApplicable(model: PiModel): boolean {
  return isDeepSeekWireCompatApplicable(model);
}

export function isCompatCheckApplicable(model: PiModel): boolean {
  return isOpenAICompatibleProxyApi(model.api) && isKnownThirdPartyOpenAIEndpoint(model);
}

export function isPromptCacheRetention400Applicable(model: PiModel): boolean {
  return isOpenAICompatibleApi(model.api) &&
    isKnownThirdPartyOpenAIEndpoint(model) &&
    getCompat(model).supportsLongPromptCacheRetention === true;
}

/**
 * OMP divergence: Pi 的 openai-completions 会在 `sendSessionAffinityHeaders` 打开时
 * 发自定义会话亲和 header，某些 CDN/WAF 会因此返回 403。OMP 没有这个 compat 字段，
 * 该诊断恒不适用；保留函数以对齐上游调用点。
 */
export function isSessionAffinity403Applicable(_model: PiModel): boolean {
  return false;
}

/**
 * Whether an OpenAI SDK header/User-Agent 403 diagnostic applies.
 *
 * Some third-party OpenAI-compatible proxies/CDNs/WAFs allow a plain curl
 * request but block the OpenAI JS SDK's default request fingerprint, especially
 * its `User-Agent: OpenAI/JS ...` and `X-Stainless-*` headers.
 */
export function isOpenAISdkHeader403Applicable(model: PiModel): boolean {
  return isOpenAICompatibleProxyApi(model.api) && isKnownThirdPartyOpenAIEndpoint(model);
}

/**
 * Detect router / channel profiles from a PiModel and return diagnostic notes.
 *
 * This function is advisory only — it does NOT participate in adapter selection,
 * prompt_cache_key injection, or footer stats. It inspects provider, api, baseUrl,
 * and compat to identify common proxy/router patterns where cache performance may
 * be degraded due to multi-backend routing.
 *
 * Known profiles (checked in order):
 *   1. OpenRouter — baseUrl or provider id matching openrouter.ai / openrouter
 *   2. Vercel AI Gateway — baseUrl matching ai-gateway.vercel.sh, or provider
 *      matching vercel / vercel-ai-gateway
 *   3. LiteLLM / OneAPI / NewAPI / VoAPI — baseUrl or provider matching litellm,
 *      oneapi, one-api, newapi, new-api, voapi, vo-api (self-hosted aggregation)
 *   4. Generic third-party OpenAI-compatible proxy — any openai-completions model
 *      with a non-official base URL that does not match a higher-profile above.
 *
 * Official OpenAI (api.openai.com) and custom transports (anthropic-messages,
 * bedrock-converse-stream, ...) do NOT produce notes.
 */
export function describeRouterChannelDiagnostics(model: PiModel): string[] {
  const notes: string[] = [];
  const api = lower(model.api);
  const baseUrl = lower(model.baseUrl || "");
  const provider = lower(model.provider);

  // Router/channel diagnostics only apply to OpenAI-compatible proxy APIs.
  if (api === "azure-openai-responses" || isMistralConversationsApi(api) || !isOpenAICompatibleApi(api)) {
    return notes;
  }

  // Unknown/default endpoints and official OpenAI are not diagnosable as
  // third-party router channels.
  if (!isKnownThirdPartyOpenAIEndpoint(model)) {
    return notes;
  }

  // ── 1. OpenRouter ────────────────────────────────────────────────
  if (
    baseUrl.includes("openrouter.ai") ||
    baseUrl.includes("openrouter") ||
    provider.includes("openrouter")
  ) {
    const compat = getCompat(model);
    const routing = asRecord(compat.openRouterRouting);
    const hasOnly = !!routing?.only;
    const hasOrder = !!routing?.order;

    notes.push("🔀 路由/渠道：检测到 OpenRouter。OpenRouter 是多上游路由器；如果每一轮落到不同上游，缓存命中率偏低很常见。");

    if (!hasOnly && !hasOrder) {
      notes.push(`   建议：添加 openRouterRouting，把上游固定住。位置：${getModelsYmlDisplayPath()} -> providers["<providerId>"] -> compat：`);
      notes.push("   compat:\n     openRouterRouting:\n       only: [<provider-slug>]");
      notes.push('   把 <provider-slug> 替换成真实的 OpenRouter provider slug（如 openai、anthropic）。');
      notes.push("   也可以用 openRouterRouting.order: [<provider-slug>, ...] 作为回退顺序。");
    }

    return notes;
  }

  // ── 2. Vercel AI Gateway ─────────────────────────────────────────
  if (
    baseUrl.includes("ai-gateway.vercel.sh") ||
    provider.includes("vercel") ||
    provider.includes("vercel-ai-gateway")
  ) {
    const compat = getCompat(model);
    const routing = asRecord(compat.vercelGatewayRouting);
    const hasOnly = !!routing?.only;
    const hasOrder = !!routing?.order;

    notes.push("🔀 路由/渠道：检测到 Vercel AI Gateway。这个网关可能把不同请求分发到不同 provider endpoint，降低缓存局部性。");

    if (!hasOnly && !hasOrder) {
      notes.push(`   建议：添加 vercelGatewayRouting，把上游固定住。位置：${getModelsYmlDisplayPath()} -> providers["<providerId>"] -> compat：`);
      notes.push("   compat:\n     vercelGatewayRouting:\n       only: [<provider-id>]");
      notes.push("   把 <provider-id> 替换成真实的 Vercel provider ID（如 openai）。");
    }

    return notes;
  }

  // ── 3. LiteLLM / OneAPI / NewAPI / VoAPI (self-hosted aggregation) ──
  const aggregationPatterns = ["litellm", "oneapi", "one-api", "newapi", "new-api", "voapi", "vo-api"];
  if (
    aggregationPatterns.some((p) => baseUrl.includes(p)) ||
    aggregationPatterns.some((p) => provider.includes(p))
  ) {
    notes.push("🔀 路由/渠道：检测到自建聚合代理（LiteLLM / OneAPI / NewAPI / VoAPI）。这类代理常把请求分到多个上游账号或实例，导致缓存被拆散。");
    notes.push("   建议：");
    notes.push("   • 确保代理能按 session 固定到单一上游（session_id affinity）。");
    notes.push("   • 向上游透传 prompt_cache_key 与会话亲和性相关 header。");
    notes.push("   • 在响应里返回缓存 usage 字段（如 prompt_cache_hit_tokens）。");

    return notes;
  }

  // ── 4. Generic third-party OpenAI-compatible proxy ─────────────────
  if (api === "openai-completions" && baseUrl) {
    const missing = describeMissingCacheCompatForModel(model);
    notes.push("🔀 路由/渠道：第三方 OpenAI 兼容代理。如果缓存命中率偏低：");
    notes.push("   • 确认代理会把同一 session 路由到同一个上游账号/实例。");
    notes.push("   • 确认代理会透传 prompt_cache_key，并发送会话亲和性相关 header。");
    notes.push("   • 确认代理会返回缓存 usage 字段（如 prompt_cache_hit_tokens）。");
    if (missing.length > 0) {
      notes.push(`   • 上面这些 compat 字段（${missing.join(", ")}）有助于提升缓存稳定性。`);
    }

    return notes;
  }

  return notes;
}

export function getCompatCheckNotApplicableLines(model: PiModel): string[] {
  const api = lower(model.api);

  if (isMistralConversationsApi(api)) {
    return [
      "ℹ️ 当前模型不适用 compat 检查。",
      "   原生 Mistral `mistral-conversations` 使用 provider 原生传输；OpenAI 兼容代理 compat 不适用。",
    ];
  }

  if (api === "azure-openai-responses") {
    return [
      "ℹ️ 当前模型不适用 compat 检查。",
      "   原生 Azure OpenAI Responses 使用 Responses 传输；OpenAI 兼容代理 compat 不适用。",
    ];
  }

  if (api === "openai-codex-responses" || (api === "openai-responses" && isOfficialOpenAIBaseUrl(model))) {
    return [
      "ℹ️ 当前模型不适用 compat 检查。",
      "   原生 Responses 传输已经使用 OMP 核心请求链路；OpenAI 兼容代理 compat 不适用。",
    ];
  }

  if (isOpenAICompatibleApi(api) && !isNonEmptyString(model.baseUrl)) {
    return [
      "ℹ️ 当前模型不适用 compat 检查。",
      "   上游 endpoint 元数据不可用，无法判断是否为第三方代理。",
    ];
  }

  return ["ℹ️ 当前模型不适用 compat 检查。"];
}

export function buildDoctorDiagnosis(model: PiModel, options: { promptCacheRetention400?: boolean; promptCacheKey400?: boolean; anthropicTtlOrderError?: boolean; sessionAffinity403?: boolean; openAISdkHeader403?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`提供方：  ${model.provider}`);
  lines.push(`模型：    ${model.id}`);
  if (model.name && model.name !== model.id) lines.push(`名称：    ${model.name}`);
  lines.push(`API：     ${model.api}`);
  const endpoint = snapshotBaseUrlForDiagnostics(model.baseUrl);
  lines.push(`Base URL：${endpoint || (isNonEmptyString(model.baseUrl) ? "（不可用）" : "（默认）")}`);

  // OMP's resolved compat has dozens of transport fields; show only the
  // cache-relevant ones, plus what models.yml sets explicitly.
  lines.push(`Compat（缓存相关，OMP 解析后）：${JSON.stringify(snapshotCompatForDiagnostics(model))}`);
  const explicitCompat = getExplicitCompat(model);
  lines.push(`Compat（models.yml 中显式设置）：${Object.keys(explicitCompat).length > 0 ? JSON.stringify(explicitCompat) : "（无）"}`);

  const adaptiveThinkingApplicable = isAdaptiveThinkingCompatApplicable(model);
  const deepSeekCompatApplicable = isDeepSeekCompatCheckApplicable(model);
  const missing = describeMissingCacheCompatForModel(model);
  const optionalOpenAIProxyCompat = describeOptionalOpenAICompatibleProxyCompat(model);
  const fixSug = buildFixSuggestion(model);
  const safeFixableMissing = fixSug ? Object.keys(fixSug.compatKeys) : [];
  const advisoryMissing = missing.filter(m => !safeFixableMissing.includes(m));

  if (safeFixableMissing.length > 0) {
    lines.push(`⚠️ 缺少 compat 字段：${safeFixableMissing.join(", ")}`);
  }
  if (advisoryMissing.length > 0) {
    lines.push(`ℹ️ 可选项：${advisoryMissing.join(", ")}（仅在确认支持时启用）`);
  }

  if (missing.length > 0) {
    const key = modelKey(model);
    const slashIdx = key.indexOf("/");
    const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
    lines.push(`编辑 ${getModelsYmlDisplayPath()} -> providers["${providerLabel}"] -> compat（与 baseUrl/api/apiKey/models 同级）。`);
    if (deepSeekCompatApplicable) {
      appendDeepSeekCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    } else {
      appendOpenAIProxyCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    }
  } else if (adaptiveThinkingApplicable || deepSeekCompatApplicable || isCompatCheckApplicable(model)) {
    lines.push("✅ compat 配置完整。");
    appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
  } else {
    lines.push(...getCompatCheckNotApplicableLines(model));
    appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
  }

  if (options.promptCacheKey400 && isPromptCacheKeyUnsupportedApplicable(model)) {
    lines.push("");
    lines.push("⚠️ 该模型之前明确以 HTTP 400 拒绝过 prompt_cache_key。");
    lines.push("   /cache-optimizer fix 会提供只对该模型生效的关闭方案（写入本扩展自己的配置文件）。");
    lines.push("   关闭后最终请求体会同时去掉 prompt_cache_key 和 promptCacheKey。");
  }

  if (isPromptCacheRetention400Applicable(model)) {
    lines.push("");
    if (options.promptCacheRetention400) {
      lines.push("⚠️ 在 supportsLongPromptCacheRetention 开启时观测到了 400 响应。");
      lines.push(`   ${getPromptCacheRetentionUnsupportedHint()}`);
    } else {
      lines.push(`ℹ️ 已启用 openai-responses 长缓存保留。${getPromptCacheRetentionUnsupportedHint()}`);
    }
  }

  if (options.anthropicTtlOrderError) {
    lines.push("");
    lines.push("⚠️ 该模型出现过 Anthropic cache-control TTL 顺序错误。");
    lines.push("   本进程后续请求已从 1h 回退到默认 5 分钟缓存 TTL。");
    lines.push(`   如需持久生效，运行 /cache-optimizer fix 查看在 ${getModelsYmlDisplayPath()} 设置模型级 supportsLongCacheRetention: false 的片段。`);
  }

  // ── OpenAI SDK header 403 diagnostics ──
  if (isOpenAISdkHeader403Applicable(model) && options.openAISdkHeader403) {
    lines.push("");
    lines.push("⚠️ 该模型观测到 HTTP 403。代理/CDN 可能在拦截 OpenAI JS SDK 的请求指纹");
    lines.push("   （例如 User-Agent: OpenAI/JS ... 或 X-Stainless-* header）。这和具体 provider/WAF 有关，");
    lines.push("   /cache-optimizer fix 不会自动写 header。");
    lines.push(`   手动方案：先对受影响的 provider 测试可用值，再在 ${getModelsYmlDisplayPath()} 里添加 provider 级 headers.User-Agent 覆盖。`);
  }

  // ── Router/channel diagnostics ──
  const routerNotes = describeRouterChannelDiagnostics(model);
  if (routerNotes.length > 0) {
    lines.push("");
    for (const note of routerNotes) {
      lines.push(note);
    }
  }

  return lines.join("\n");
}

/**
 * Build a "缓存诊断" section for low-hit causes, appended to doctor output.
 * This is a separate function because it depends on per-session state (recent samples,
 * per-model stats) that is not available at the module level.
 */
export function buildLowHitDiagnosis(
  model: PiModel,
  adapter: CacheProviderAdapter | undefined,
  stats: CacheStats | undefined,
  samples: CacheUsageSample[],
  promptSamples: PromptDiagnosticSample[] = [],
): string[] {
  void adapter;
  const lines: string[] = [];

  // 1. Missing compat flags (adapter-aware: DeepSeek has extra reasoning compat)
  const fixSugLHD = buildFixSuggestion(model);
  const safeFixableMissingLHD = fixSugLHD ? Object.keys(fixSugLHD.compatKeys) : [];

  // 2. Router/channel risk (reuse existing check)
  const routerNotes = describeRouterChannelDiagnostics(model);

  // 3. Recent samples missing usage fields
  const missingUsageSamples = samples.filter((s) => s.missingUsageFields).length;

  // 4. Recent trend analysis
  const recent10 = samples.slice(-10);
  const recent10Hits = recent10.filter((s) => s.hit).length;
  const recent10Total = recent10.length;

  // 5. Today's overall trend from persisted stats
  const todayStats = stats ?? emptyCacheStats();

  // 6. Prompt fingerprint drift across recent provider requests
  const recentPrompt = promptSamples.slice(-10);
  const promptFingerprints = new Set(recentPrompt.flatMap((sample) => (sample.systemPromptFingerprint ? [sample.systemPromptFingerprint] : [])));

  const hasMissingCompat = safeFixableMissingLHD.length > 0;
  const hasRouterRisk = routerNotes.length > 0;
  const hasUsageMissing = missingUsageSamples > 0;

  // Today's cached-token ratio is used both inside and outside the recent-sample
  // branch. Keep it block-external so doctor/stats never throw for low-hit
  // models that have persisted counters but no recent in-memory samples.
  const todayHitRatio = todayStats.totalInputTokens > 0
    ? Math.round((todayStats.cachedInputTokens / todayStats.totalInputTokens) * 100)
    : 0;

  // Determine if there are actual issues worth flagging
  const hasActualIssues = hasMissingCompat || hasUsageMissing ||
    // Low hit trend (today total > 3 and hit ratio < 30%)
    (todayStats.totalRequests > 3 && todayStats.totalInputTokens > 0 &&
     (todayStats.cachedInputTokens / todayStats.totalInputTokens) < 0.3) ||
    // Low hit rate in recent samples (recent10Total >= 3 and all misses)
    (recent10Total >= 3 && recent10Hits === 0);

  // Skip section if no issues
  if (!hasActualIssues && !(hasRouterRisk && (hasMissingCompat || hasUsageMissing))) {
    return lines;
  }

  lines.push("");
  lines.push("── 缓存诊断 ──");
  if (promptFingerprints.size > 1) {
    lines.push(`ℹ️ 最近 ${recentPrompt.length} 条 provider 请求观测到 ${promptFingerprints.size} 组 system prompt 指纹。`);
    lines.push("   若低命中持续，请避免在同一实验窗口混用不同 prompt 模式或动态 system 内容。");
  }

  // Priority 1: missing compat flags
  if (hasMissingCompat) {
    lines.push(`⚠️ 缺少 compat 字段：${safeFixableMissingLHD.join(", ")}`);
    lines.push("   这些字段有助于稳定 prompt 缓存与上游路由粘性。");
    lines.push("   可运行 /cache-optimizer compat 查看编辑建议。");
  }

  // Priority 2: router/channel risk (only flag when there are other issues)
  if (hasRouterRisk && (hasMissingCompat || hasUsageMissing || hasActualIssues)) {
    lines.push("🔀 检测到路由/代理风险 —— 详见上方路由诊断。");
  }

  // Priority 3: usage fields missing
  if (hasUsageMissing) {
    lines.push(`⚠️ 最近 ${samples.length} 条样本里有 ${missingUsageSamples} 条缺少或返回了空的 usage 字段。`);
    lines.push("   Footer 命中率可能会被低估。");
    lines.push("   请确认代理会返回 prompt 级 usage（如 prompt_tokens、input_tokens_details）。");
  }

  // Priority 4: recent trend low
  if (recent10Total > 0) {
    if (recent10Hits === 0 && todayStats.totalRequests > 3 && todayHitRatio < 30) {
      lines.push(`📉 今日缓存命中率偏低：${todayHitRatio}%（最近 ${recent10Total} 条样本）。`);
      lines.push("   常见原因：代理把请求路由到不同后端，或 prompt 前缀在各轮之间变化。");
      lines.push("   请检查上游路由粘性与长缓存保留设置。");
    } else if (todayHitRatio < 30 && todayStats.totalRequests > 3) {
      lines.push(`📉 今日缓存命中率偏低：${todayHitRatio}%（共 ${todayStats.totalRequests} 次请求）。`);
      lines.push("   请检查 compat 配置与代理上游路由。");
    }

    // Show brief trend summary if there are enough samples
    if (recent10Total >= 3) {
      lines.push(`📊 ${formatRecentTrendSummary(samples, 10)}`);
    }
  }

  // For fully configured but low hit models, emphasize sticky routing
  if (!hasMissingCompat && !hasRouterRisk && todayStats.totalRequests > 3 && todayHitRatio < 30) {
    lines.push("💡 compat 已配置完整，但缓存命中率仍然偏低。");
    lines.push("   可能原因：");
    lines.push("   • 代理仍把请求分发到多个后端 —— 请检查代理侧的会话粘性。");
    lines.push("   • prompt 前缀每轮都在变化 —— 请检查 system prompt 中的动态上下文。");
    lines.push("   • provider 没有返回缓存 usage 字段 —— footer 无法准确测量命中。");
  }

  return lines;
}

export function buildCompatDiagnosis(model: PiModel): string | undefined {
  const missing = describeMissingCacheCompatForModel(model);
  const fixSugC = buildFixSuggestion(model);
  const safeFixableMissingC = fixSugC ? Object.keys(fixSugC.compatKeys) : [];
  const advisoryMissingC = missing.filter(m => !safeFixableMissingC.includes(m));
  const adaptiveThinkingApplicable = isAdaptiveThinkingCompatApplicable(model);
  const deepSeekCompatApplicable = isDeepSeekCompatCheckApplicable(model);
  const optionalOpenAIProxyCompat = describeOptionalOpenAICompatibleProxyCompat(model);
  const routerNotes = describeRouterChannelDiagnostics(model);

  if (missing.length === 0 && routerNotes.length === 0 && optionalOpenAIProxyCompat.length === 0) return undefined;

  const key = modelKey(model);
  const lines: string[] = [];

  if (missing.length > 0) {
    const slashIdx = key.indexOf("/");
    const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
    lines.push(`当前模型：${key}`);
    if (safeFixableMissingC.length > 0) {
      lines.push(`可安全修复：${safeFixableMissingC.join(", ")}`);
    }
    if (advisoryMissingC.length > 0) {
      lines.push(`可选项：${advisoryMissingC.join(", ")}（仅在确认支持时启用）`);
    }
    lines.push("");
    lines.push(`编辑 ${getModelsYmlDisplayPath()} -> providers["${providerLabel}"] -> compat`);
    lines.push("（与 baseUrl/api/apiKey/models 同级）。");
    if (deepSeekCompatApplicable) {
      appendDeepSeekCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    } else {
      appendOpenAIProxyCompatAdviceLines(lines, missing, { providerLabel, modelId: model.id });
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    }
  }

  // When compat is fully configured but router/optional notes exist, prefix the status.
  if ((routerNotes.length > 0 || optionalOpenAIProxyCompat.length > 0) && missing.length === 0) {
    if (adaptiveThinkingApplicable || deepSeekCompatApplicable || isCompatCheckApplicable(model)) {
      lines.push("✅ compat 配置完整。");
      if (isPromptCacheRetention400Applicable(model)) {
        lines.push(getPromptCacheRetentionUnsupportedHint());
      }
      if (isOpenAISdkHeader403Applicable(model)) {
        lines.push(
          "ℹ️ 如果出现 403 \"blocked\"，代理/CDN 可能在拦截 OpenAI JS SDK 的 User-Agent / X-Stainless-* header。",
          "   请先手动测试 provider 级 headers.User-Agent 覆盖；/fix 不会自动写入。",
        );
      }
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    } else {
      lines.push(...getCompatCheckNotApplicableLines(model));
      appendOptionalOpenAIProxyCompatAdviceLines(lines, optionalOpenAIProxyCompat);
    }
    lines.push("");
  }

  if (routerNotes.length > 0) {
    if (missing.length > 0) lines.push("");
    for (const note of routerNotes) {
      lines.push(note);
    }
  }

  return lines.join("\n");
}

// ============================================================
// Manual models.yml compat suggestions for /cache-optimizer fix
// ============================================================

/**
 * Build the fix suggestion for the current active model.
 * Returns undefined if there is nothing to fix.
 */
export function buildFixSuggestion(model: PiModel): FixSuggestion | undefined {
  const missing = describeMissingCacheCompatForModel(model);
  if (missing.length === 0) return undefined;

  const compatKeys = isDeepSeekCompatCheckApplicable(model)
    ? buildDeepSeekCompatSuggestion(missing)
    : buildSafeOpenAIProxyCompatSuggestion(missing);

  if (Object.keys(compatKeys).length === 0) return undefined;

  const key = modelKey(model);
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;

  return {
    providerLabel,
    modelId: model.id,
    compatKeys,
  };
}
