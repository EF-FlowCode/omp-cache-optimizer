import { LOG_PREFIX, type PiModel, asRecord, getNumber, isNonEmptyString, lower } from "./common.ts";
import { ROUTED_FALLBACK_MODEL_SYMBOL, isOpenAICompatibleApi, isOpenAICompatibleProxyApi } from "./model-identity.ts";
import { derivePromptCacheKey, normalizePromptCacheKeyForWire } from "./request-payload.ts";
import { type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { resolve } from "node:path";


export const PI_ROUTING_REGISTRY_SYMBOL = Symbol.for("omp.routing.registry.v1");

export const PI_CACHE_HINTS_SYMBOL = Symbol.for("omp.cache.hints.v1");

export type PiRouteSnapshot = {
  virtualProvider: string;
  virtualModelId: string;
  provider: string;
  modelId: string;
  api?: string;
  canonicalModelId?: string;
  routeLabel?: string;
  status?: "planned" | "trying" | "selected" | "success" | "failed";
  sessionIdHash?: string;
  requestId?: string;
  timestamp: number;
};

export type PiRouteResolveHint = {
  sessionIdHash?: string;
  requestId?: string;
};

export type PiRouterAdapterV1 = {
  virtualProvider: string;
  resolveActiveRoute(
    virtualModelId: string,
    hint?: PiRouteResolveHint,
  ): PiRouteSnapshot | undefined;
  resolveCandidateRoutes?(virtualModelId: string): PiRouteSnapshot[];
  subscribe?(listener: (event: PiRouteSnapshot) => void): () => void;
};

export type PiRoutingRegistryV1 = {
  version: 1;
  registerRouter(adapter: PiRouterAdapterV1): () => void;
  getRouter(virtualProvider: string): PiRouterAdapterV1 | undefined;
};

export type PiCacheHintsInput = {
  sessionIdHash?: string;
  virtualProvider?: string;
  virtualModelId?: string;
  upstreamProvider?: string;
  upstreamModelId?: string;
  api?: string;
};

export type PiCacheHintsOutput = {
  systemPrompt?: string;
  promptCacheKey?: string;
  cacheRetention?: "long";
};

export type PiCacheHintsV1 = {
  version: 1;
  getHints(input: PiCacheHintsInput): PiCacheHintsOutput | undefined;
};

export type ProtocolGlobal = typeof globalThis & Record<symbol, unknown> & {
  __ompCacheOptimizerRouter?: unknown;
  __ompCacheOptimizerCacheKey__?: unknown;
};

export type ModelRegistryLike = {
  find?(provider: string, modelId: string): PiModel | undefined;
  getAvailable?(): PiModel[];
  getAll?(): PiModel[];
};

export type ContextWithOptionalModelRegistry = Pick<ExtensionContext, "sessionManager"> & {
  modelRegistry?: ModelRegistryLike;
};

/**
 * Hash a session id for use as a non-reversible opaque scope key.
 * Returns a 16-character hex string (64 bits of SHA-256 digest prefix)
 * suitable for scoping stats buckets without exposing the raw session id.
 */
export function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

export function getProtocolGlobal(): ProtocolGlobal {
  return globalThis as ProtocolGlobal;
}

export function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return undefined;
}

export function sessionHashFromContext(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
  const sessionId = ctx.sessionManager.getSessionId();
  return sessionId ? hashSessionId(sessionId) : undefined;
}

export function isPiRouterAdapterV1(value: unknown): value is PiRouterAdapterV1 {
  const record = asRecord(value);
  return !!record && isNonEmptyString(record.virtualProvider) && typeof record.resolveActiveRoute === "function";
}

export function isRoutingRegistryV1(value: unknown): value is PiRoutingRegistryV1 {
  const record = asRecord(value);
  return !!record && record.version === 1 && typeof record.registerRouter === "function" && typeof record.getRouter === "function";
}

export function createRoutingRegistry(): PiRoutingRegistryV1 {
  const routers = new Map<string, PiRouterAdapterV1>();
  return {
    version: 1,
    registerRouter(adapter: PiRouterAdapterV1): () => void {
      if (!isPiRouterAdapterV1(adapter)) return () => undefined;
      const key = adapter.virtualProvider.trim();
      routers.set(key, adapter);
      return () => {
        if (routers.get(key) === adapter) routers.delete(key);
      };
    },
    getRouter(virtualProvider: string): PiRouterAdapterV1 | undefined {
      return routers.get(virtualProvider);
    },
  };
}

export function getRoutingRegistry(): PiRoutingRegistryV1 | undefined {
  const candidate = getProtocolGlobal()[PI_ROUTING_REGISTRY_SYMBOL];
  return isRoutingRegistryV1(candidate) ? candidate : undefined;
}

export function ensureRoutingRegistry(): PiRoutingRegistryV1 {
  const existing = getRoutingRegistry();
  if (existing) return existing;

  const created = createRoutingRegistry();
  getProtocolGlobal()[PI_ROUTING_REGISTRY_SYMBOL] = created;
  return created;
}

export function parseRouteStatus(value: unknown): PiRouteSnapshot["status"] | undefined {
  return value === "planned" || value === "trying" || value === "selected" || value === "success" || value === "failed"
    ? value
    : undefined;
}

export function parseRouteSnapshot(
  value: unknown,
  fallbackVirtualProvider?: string,
  fallbackVirtualModelId?: string,
): PiRouteSnapshot | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const virtualProvider = firstNonEmptyString(record.virtualProvider, fallbackVirtualProvider);
  const virtualModelId = firstNonEmptyString(record.virtualModelId, record.virtualModel, fallbackVirtualModelId);
  const provider = firstNonEmptyString(record.provider, record.upstreamProvider, record.targetProvider);
  const modelId = firstNonEmptyString(record.modelId, record.upstreamModelId, record.targetModelId, record.responseModel);
  if (!virtualProvider || !virtualModelId || !provider || !modelId) return undefined;

  const timestamp = getNumber(record.timestamp) ?? Date.now();
  return {
    virtualProvider,
    virtualModelId,
    provider,
    modelId,
    api: firstNonEmptyString(record.api),
    canonicalModelId: firstNonEmptyString(record.canonicalModelId),
    routeLabel: firstNonEmptyString(record.routeLabel, record.label),
    status: parseRouteStatus(record.status),
    sessionIdHash: firstNonEmptyString(record.sessionIdHash),
    requestId: firstNonEmptyString(record.requestId),
    timestamp,
  };
}

export function resolveActiveRouteSnapshot(
  model: PiModel | undefined,
  ctx?: Pick<ExtensionContext, "sessionManager">,
): PiRouteSnapshot | undefined {
  if (!model) return undefined;
  const hint: PiRouteResolveHint | undefined = ctx ? { sessionIdHash: sessionHashFromContext(ctx) } : undefined;

  const adapter = getRoutingRegistry()?.getRouter(model.provider);
  if (adapter) {
    try {
      const snapshot = parseRouteSnapshot(
        adapter.resolveActiveRoute(model.id, hint),
        model.provider,
        model.id,
      );
      if (snapshot) return snapshot;
    } catch (error) {
      console.warn(`${LOG_PREFIX}: routing registry adapter failed`, error);
    }
  }

  // Temporary migration shim for the prototype global used by early router PRs.
  // New integrations should use Symbol.for("omp.routing.registry.v1") instead.
  const legacy = getProtocolGlobal().__ompCacheOptimizerRouter;
  if (!legacy || !lower(model.provider).includes("router")) return undefined;
  try {
    if (typeof legacy === "function") {
      return parseRouteSnapshot(legacy(model.provider, model.id, hint), model.provider, model.id);
    }
    const legacyRecord = asRecord(legacy);
    const resolver = legacyRecord?.resolveActiveRoute;
    if (typeof resolver === "function") {
      return parseRouteSnapshot(resolver.call(legacy, model.id, hint), model.provider, model.id);
    }
    return parseRouteSnapshot(legacy, model.provider, model.id);
  } catch (error) {
    console.warn(`${LOG_PREFIX}: legacy routing global failed`, error);
    return undefined;
  }
}

export function routeSnapshotToPiModel(snapshot: PiRouteSnapshot, fallback?: PiModel): PiModel {
  const sameIdentity = fallback?.provider === snapshot.provider && fallback?.id === snapshot.modelId;
  return {
    ...(sameIdentity ? fallback ?? {} : {}),
    id: snapshot.modelId,
    name: snapshot.canonicalModelId ?? snapshot.modelId,
    provider: snapshot.provider,
    api: snapshot.api ?? (sameIdentity ? fallback?.api : undefined) ?? "",
    baseUrl: sameIdentity ? fallback?.baseUrl ?? "" : "",
    reasoning: sameIdentity ? fallback?.reasoning ?? false : false,
    input: sameIdentity ? fallback?.input ?? ["text"] : ["text"],
    cost: sameIdentity
      ? fallback?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: sameIdentity ? fallback?.contextWindow ?? 0 : 0,
    maxTokens: sameIdentity ? fallback?.maxTokens ?? 0 : 0,
    compat: sameIdentity ? fallback?.compat : undefined,
    [ROUTED_FALLBACK_MODEL_SYMBOL]: true,
  } as PiModel;
}

export function findModelInRegistry(registry: ModelRegistryLike | undefined, provider: string, id: string): PiModel | undefined {
  try {
    const found = registry?.find?.(provider, id);
    if (found) return found;

    const available = registry?.getAvailable?.() ?? [];
    const availableMatch = available.find((candidate) => candidate.provider === provider && candidate.id === id);
    if (availableMatch) return availableMatch;

    const all = registry?.getAll?.() ?? [];
    return all.find((candidate) => candidate.provider === provider && candidate.id === id);
  } catch {
    // Registry extensions are optional input; a malformed/throwing registry
    // must not turn a provider error hook into an OMP session failure.
    return undefined;
  }
}

export function resolveRouteModel(
  model: PiModel | undefined,
  ctx?: ContextWithOptionalModelRegistry,
): PiModel | undefined {
  const snapshot = resolveActiveRouteSnapshot(model, ctx);
  if (!snapshot) return undefined;

  return findModelInRegistry(ctx?.modelRegistry, snapshot.provider, snapshot.modelId)
    ?? routeSnapshotToPiModel(snapshot, model);
}

export function installCacheHintsService(
  service: PiCacheHintsV1,
  options: { discardPrevious?: (value: unknown) => boolean } = {},
): () => void {
  const globals = getProtocolGlobal();
  const previous = globals[PI_CACHE_HINTS_SYMBOL];
  globals[PI_CACHE_HINTS_SYMBOL] = service;
  return () => {
    if (globals[PI_CACHE_HINTS_SYMBOL] !== service) return;
    if (previous !== undefined && !options.discardPrevious?.(previous)) {
      globals[PI_CACHE_HINTS_SYMBOL] = previous;
    } else {
      delete globals[PI_CACHE_HINTS_SYMBOL];
    }
  };
}

// ── Non-GPT OpenAI-compatible model detection ──────────────────────

export function isRouterModel(model: PiModel | undefined): boolean {
  return lower(model?.provider) === "router";
}

export const PI_CACHE_HINTS_OWNER_SYMBOL = Symbol.for("omp.cache.optimizer.hints-owner.v1");

export type PiCacheHintSnapshot = PiCacheHintsInput & PiCacheHintsOutput & {
  timestamp: number;
};

// ── OMP prompt_cache_key 身份解析（fork 逻辑） ─────────────────────
//
// OMP 核心对 Responses 族默认发送 `providerPromptCacheKey ?? sessionId`，
// Chat Completions 只在 compat.supportsPromptCacheKey 时发送。本扩展：
// - 会话头里用户/fork 固定的 providerPromptCacheKey 一律优先；
// - Responses 族（含 openrouter）用"项目级稳定 key"替换每会话默认 key，让同一项目的
//   不同会话共享缓存路由；
// - 第三方 Chat Completions 没有 header key 时按会话隔离（单向哈希的会话 key，原始
//   sessionId 不离开本进程），避免不同会话互相覆盖同一缓存分桶。

export type PromptCacheKeySource = "header" | "project" | "session";

export type ResolvedPromptCacheKey = {
  key: string;
  source: PromptCacheKeySource;
};

export function normalizePromptCacheEndpoint(baseUrl: unknown): string {
  const raw = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    return `${url.protocol}//${url.host}${pathname === "/" ? "" : pathname}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

/** 优先 sessionManager.getCwd()，空则回退 ctx.cwd（兼容旧宿主）。 */
export function resolveProjectCwd(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string | undefined {
  const manager = ctx.sessionManager as { getCwd?: () => string };
  const sessionCwd = firstNonEmptyString(typeof manager.getCwd === "function" ? manager.getCwd() : undefined);
  if (sessionCwd) return sessionCwd;
  return firstNonEmptyString(ctx.cwd);
}

export function buildProjectPromptCacheKey(cwd: string | undefined, model: PiModel | undefined): string | undefined {
  if (!model || !isOpenAICompatibleApi(model.api)) return undefined;
  const provider = lower(model.provider).trim();
  const modelId = typeof model.id === "string" ? model.id.trim() : "";
  if (!provider || !modelId) return undefined;
  const projectPath = resolve(firstNonEmptyString(cwd, process.cwd())!);
  const api = lower(model.api);
  const endpoint = normalizePromptCacheEndpoint(model.baseUrl);
  const input = JSON.stringify([1, projectPath, api, provider, modelId, endpoint]);
  return `omp-cache-v1-${createHash("sha256").update(input).digest("hex").slice(0, 48)}`;
}

/** 会话头里由用户（--provider-prompt-cache-key）或完整 fork 固定的 key。 */
export function getHeaderPromptCacheKey(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
  try {
    const header = asRecord((ctx.sessionManager as { getHeader?: () => unknown }).getHeader?.());
    return firstNonEmptyString(header?.providerPromptCacheKey);
  } catch {
    return undefined;
  }
}

/**
 * 解析本扩展要使用的 prompt_cache_key 身份：header key 一律优先；
 * 否则按 API 族选择项目级稳定 key（Responses 族）或会话级哈希 key（Chat Completions）。
 */
export function resolvePromptCacheKey(
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
  model: PiModel | undefined,
  options: { allowProjectKey: boolean; allowSessionFallback: boolean },
): ResolvedPromptCacheKey | undefined {
  const headerKey = getHeaderPromptCacheKey(ctx);
  if (headerKey) return { key: headerKey, source: "header" };
  if (options.allowProjectKey) {
    const projectKey = buildProjectPromptCacheKey(resolveProjectCwd(ctx), model);
    if (projectKey) return { key: projectKey, source: "project" };
  }
  if (options.allowSessionFallback) {
    const sessionKey = derivePromptCacheKey(ctx.sessionManager.getSessionId());
    if (sessionKey) return { key: sessionKey, source: "session" };
  }
  return undefined;
}

/** 该 API 用哪种 key：Chat Completions 按会话隔离，其余 OpenAI 兼容 API 用项目级 key。 */
export function promptCacheKeyOptionsForApi(api: unknown): { allowProjectKey: boolean; allowSessionFallback: boolean } {
  const completions = isOpenAICompatibleProxyApi(api);
  return { allowProjectKey: !completions, allowSessionFallback: completions };
}

/**
 * 只把"会话级默认 key"视为可替换：OMP 核心发出的原始 sessionId（含其 pc_ 归一化形式），
 * 以及本扩展自己派生的会话哈希 key。用户自定义 key 一律保留。
 */
export function isSessionScopedPromptCacheKey(key: string | undefined, sessionId: string | undefined): boolean {
  const normalizedKey = key?.trim();
  const normalizedSessionId = sessionId?.trim();
  if (!normalizedKey || !normalizedSessionId) return false;
  return normalizedKey === normalizedSessionId
    || normalizedKey === normalizePromptCacheKeyForWire(normalizedSessionId)
    || normalizedKey === derivePromptCacheKey(normalizedSessionId);
}

/** cache hint 与旧全局里发布的会话 key（不做 wire 归一化，保留完整 host key）。 */
export function getSessionPromptCacheKey(
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
  model?: PiModel,
): string | undefined {
  return resolvePromptCacheKey(ctx, model, model ? promptCacheKeyOptionsForApi(model.api) : { allowProjectKey: false, allowSessionFallback: true })?.key;
}

export function isCacheHintsServiceV1(value: unknown): value is PiCacheHintsV1 {
  const record = asRecord(value);
  return !!record && record.version === 1 && typeof record.getHints === "function";
}

export function getCacheHintsService(): PiCacheHintsV1 | undefined {
  const candidate = getProtocolGlobal()[PI_CACHE_HINTS_SYMBOL];
  return isCacheHintsServiceV1(candidate) ? candidate : undefined;
}

export function markOptimizerOwnedCacheHintsService(service: PiCacheHintsV1): PiCacheHintsV1 {
  (service as PiCacheHintsV1 & Record<symbol, unknown>)[PI_CACHE_HINTS_OWNER_SYMBOL] = true;
  return service;
}

export function isOptimizerOwnedCacheHintsService(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as Record<symbol, unknown>)[PI_CACHE_HINTS_OWNER_SYMBOL] === true;
}
