import { type ModelIdentity, type PiModel, type UnknownRecord, asRecord, isNonEmptyString, lower } from "./common.ts";
import { type CacheCompat, resolveEffectiveCompat, resolveExplicitCompat } from "./compat-config.ts";
import { getAssistantMessageModelTokenValues, getModelIdNameTokenValues, hasAnyTokenContaining, modelOrAssistantMessageHas } from "./model-detect.ts";

export const ROUTED_FALLBACK_MODEL_SYMBOL = Symbol("omp-cache-optimizer.routed-fallback-model");

export const OPENAI_REASONING_MODEL_PATTERN = /(^|[/\s:_-])o[1345]($|[-_.:/\s])/;

export const XAI_MODEL_PATTERN = /(^|[/\s:_-])xai($|[-_.:/\s])/;

export const MIMO_MODEL_PATTERN = /(^|[/\s:_-])mi-?mo($|[-_.:/\s])/i;

export const PPLX_MODEL_PATTERN = /(^|[/\s:_-])pplx($|[-_.:/\s])/i;

export const NOVA_MODEL_PATTERN = /(^|[/\s:_-])nova($|[-_.:/\s])/i;

export const MPT_MODEL_PATTERN = /(^|[/\s:_-])mpt($|[-_.:/\s])/i;

export const ALEPH_MODEL_PATTERN = /(^|[/\s:_-])aleph($|[-_.:/\s])/i;

// Safe-boundary patterns for models with short or ambiguous tokens
export const ARCTIC_MODEL_PATTERN = /(^|[\/\s:_-])arctic($|[\-_.:\/\s])/i;

export const AYA_MODEL_PATTERN = /(^|[\/\s:_-])aya($|[\-_.:\/\s])/i;

export const ORION_MODEL_PATTERN = /(^|[\/\s:_-])orion($|[\-_.:\/\s])/i;

export function isRoutedFallbackModel(model: PiModel | undefined): boolean {
  return !!model && (model as PiModel & Record<symbol, unknown>)[ROUTED_FALLBACK_MODEL_SYMBOL] === true;
}

/** OMP 宿主解析后的生效 compat（`compatConfig` 原文 + `compat` 解析结果，后者优先）。 */
export function getCompat(model: PiModel | undefined): CacheCompat {
  if (!model) return {} as CacheCompat;
  return resolveEffectiveCompat(model);
}

/** 用户显式配置的 compat（models.yml / modelOverrides 原文），不含宿主自动探测的默认值。 */
export function getExplicitCompat(model: PiModel | undefined): CacheCompat {
  if (!model) return {} as CacheCompat;
  return resolveExplicitCompat(model);
}

export function isAssistantMessage(message: unknown): boolean {
  return asRecord(message)?.role === "assistant";
}

export function getAssistantRecord(message: unknown): UnknownRecord | undefined {
  const record = asRecord(message);
  return record?.role === "assistant" ? record : undefined;
}

export function isDeepSeekLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["deepseek"]);
}

export function isDeepSeekLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["deepseek"]);
}

/**
 * OMP 的 OpenAI 兼容 API 族：除 completions/responses 外，还包括会在 OMP 内部分派到
 * Responses 或 Completions 的 `openrouter`，以及 Codex / Azure Responses。
 */
export function isOpenAICompatibleApi(api: unknown): boolean {
  const value = lower(api);
  return value === "openai-completions"
    || value === "openai-responses"
    || value === "openrouter"
    || value === "openai-codex-responses"
    || value === "azure-openai-responses";
}

export function isAnthropicMessagesApi(api: unknown): boolean {
  return lower(api) === "anthropic-messages";
}

export function isOpenAICompatibleProxyApi(api: unknown): boolean {
  return lower(api) === "openai-completions";
}

export function isResponsesPromptRewriteBypassApi(api: unknown): boolean {
  const value = lower(api);
  return value === "openai-codex-responses" || value === "openai-responses" || value === "azure-openai-responses";
}

export function isMistralConversationsApi(api: unknown): boolean {
  return lower(api) === "mistral-conversations";
}

export function isOpenAIFamilyToken(token: string): boolean {
  return token.includes("gpt-") || token.includes("chatgpt") || OPENAI_REASONING_MODEL_PATTERN.test(token);
}

export function isOpenAIFamilyModel(model: PiModel | undefined): boolean {
  return getModelIdNameTokenValues(model).some(isOpenAIFamilyToken);
}

export function isOpenAIFamilyAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return [...getModelIdNameTokenValues(model), ...getAssistantMessageModelTokenValues(message)].some(isOpenAIFamilyToken);
}

export function isClaudeLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["anthropic", "claude"]);
}

export function isClaudeLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["anthropic", "claude"]);
}

export function isGeminiLikeModel(model: PiModel | undefined): boolean {
  return hasAnyTokenContaining(getModelIdNameTokenValues(model), ["gemini", "vertex"]);
}

export function isGeminiLikeAssistantMessage(message: unknown, model: PiModel | undefined): boolean {
  return modelOrAssistantMessageHas(message, model, ["gemini", "vertex"]);
}

// ── Additional OpenAI-compatible model detection ──────────────────

export const YI_MODEL_PATTERN = /(^|[\/\s:_-])yi($|[\-_.:\/\s])/;

// ── More OpenAI-compatible model detection (batch 2) ───────────────

export const DOUBAO_SEED_PATTERN = /(^|[\/\s:_-])seed($|[\-_.:\/\s])/i;

export const PHI_MODEL_PATTERN = /(^|[\/\s:_-])phi($|[\-_.:\/\s])/i;

// ── New OpenAI-compatible model detection (batch 3, 12 families) ──────

// ── More OpenAI-compatible model detection (batch 4, 18 families) ──

// ── Model key ──────────────────────────────────────────────────────

export function modelKey(model: ModelIdentity): string {
  return `${model.provider}/${model.id}`;
}

export function isOfficialOpenAIBaseUrl(model: PiModel): boolean {
  const value = lower(model.baseUrl).trim();
  if (!value) {
    return lower(model.provider) === "openai";
  }

  try {
    return new URL(value).hostname === "api.openai.com";
  } catch {
    return value === "api.openai.com" || value.startsWith("api.openai.com/");
  }
}

export function isKnownThirdPartyOpenAIEndpoint(model: PiModel): boolean {
  return isNonEmptyString(model.baseUrl) && !isOfficialOpenAIBaseUrl(model);
}
