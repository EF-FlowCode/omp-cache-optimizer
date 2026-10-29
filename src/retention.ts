import { type MutableEnv } from "./common.ts";

/**
 * OMP 启动时的缓存保留环境变量快照（用于 /cache-optimizer disable 精确恢复）。
 * 扩展侧主变量是 OMP_CACHE_RETENTION；宿主 `@oh-my-pi/pi-ai` 的
 * resolveCacheRetention 仍读 PI_CACHE_RETENTION，所以两者都要记录。
 */
export type CacheRetentionEnvSnapshot = {
  ompWasSet: boolean;
  ompValue?: string;
  piWasSet: boolean;
  piValue?: string;
};

/** 扩展侧主环境变量名（用户应使用 OMP_ 前缀）。 */
export const OMP_CACHE_RETENTION_ENV = "OMP_CACHE_RETENTION";

/** 宿主 @oh-my-pi/pi-ai 仍读取 PI_CACHE_RETENTION；写入时同步镜像。 */
export const PI_CACHE_RETENTION_ENV = "PI_CACHE_RETENTION";

export const LONG_CACHE_RETENTION_VALUE = "long";

export const VALID_CACHE_RETENTION_VALUES = new Set(["long", "short", "none"]);

export const PI_CACHE_RETENTION_BASELINE_SYMBOL = Symbol.for("omp.cache.optimizer.retention-baseline.v1");

export type CacheRetentionBaselineV1 = {
  version: 1;
  snapshot: CacheRetentionEnvSnapshot;
};

function normalizeCacheRetentionCandidate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isValidCacheRetentionValue(value: string | undefined): value is string {
  return typeof value === "string" && VALID_CACHE_RETENTION_VALUES.has(value);
}

/** 当前生效的缓存保留值：优先 OMP_，兼容旧 PI_。 */
export function readCacheRetentionValue(env: MutableEnv = process.env): string | undefined {
  return normalizeCacheRetentionCandidate(env[OMP_CACHE_RETENTION_ENV]) ??
    normalizeCacheRetentionCandidate(env[PI_CACHE_RETENTION_ENV]);
}

export function captureCacheRetentionEnv(env: MutableEnv = process.env): CacheRetentionEnvSnapshot {
  return {
    ompWasSet: Object.prototype.hasOwnProperty.call(env, OMP_CACHE_RETENTION_ENV),
    ompValue: env[OMP_CACHE_RETENTION_ENV],
    piWasSet: Object.prototype.hasOwnProperty.call(env, PI_CACHE_RETENTION_ENV),
    piValue: env[PI_CACHE_RETENTION_ENV],
  };
}

/**
 * 缓存保留环境变量真值表（模块加载与 /cache-optimizer enable 共用）：
 * ① OMP 合法 → 写入 OMP + 镜像 PI
 * ② OMP 空且 PI 合法 → 两者写 PI 规范值
 * ③ 两者都空 → 两者 long
 * ④ 第一个非空候选非法 → 两者原样不动
 * 用户显式设置的 short/none 会被保留，只有未设置时才默认 long。
 */
export function requestLongCacheRetention(env: MutableEnv = process.env): void {
  const ompCandidate = normalizeCacheRetentionCandidate(env[OMP_CACHE_RETENTION_ENV]);
  const piCandidate = normalizeCacheRetentionCandidate(env[PI_CACHE_RETENTION_ENV]);

  if (ompCandidate !== undefined) {
    if (!isValidCacheRetentionValue(ompCandidate)) return;
    env[OMP_CACHE_RETENTION_ENV] = ompCandidate;
    env[PI_CACHE_RETENTION_ENV] = ompCandidate;
    return;
  }

  if (piCandidate !== undefined) {
    if (!isValidCacheRetentionValue(piCandidate)) return;
    env[OMP_CACHE_RETENTION_ENV] = piCandidate;
    env[PI_CACHE_RETENTION_ENV] = piCandidate;
    return;
  }

  env[OMP_CACHE_RETENTION_ENV] = LONG_CACHE_RETENTION_VALUE;
  env[PI_CACHE_RETENTION_ENV] = LONG_CACHE_RETENTION_VALUE;
}

export function restoreCacheRetentionEnv(snapshot: CacheRetentionEnvSnapshot, env: MutableEnv = process.env): void {
  if (snapshot.ompWasSet) {
    env[OMP_CACHE_RETENTION_ENV] = snapshot.ompValue;
  } else {
    delete env[OMP_CACHE_RETENTION_ENV];
  }
  if (snapshot.piWasSet) {
    env[PI_CACHE_RETENTION_ENV] = snapshot.piValue;
  } else {
    delete env[PI_CACHE_RETENTION_ENV];
  }
}

/**
 * Why `prompt_cache_retention` was kept on, or removed from, a provider payload.
 *
 * - `provider-rejected`: this model already answered with an explicit
 *   unsupported-parameter error in this process; never resend it.
 * - `official-openai`: api.openai.com documents the parameter.
 * - `explicit-opt-in`: the model's compat explicitly sets
 *   `supportsLongPromptCacheRetention: true` on `api: openai-responses`
 *   (OMP only auto-enables it for the official OpenAI endpoint, so `true`
 *   elsewhere is a deliberate models.yml choice).
 * - `user-requested-long`: the user started OMP with `OMP_CACHE_RETENTION=long`
 *   (or the legacy `PI_CACHE_RETENTION=long`) themselves, so the field is
 *   vanilla OMP behaviour, not an optimizer side effect.
 * - `unverified-endpoint`: the field exists only because this extension forced
 *   long retention; third-party endpoints are not known to accept it.
 */
export type PromptCacheRetentionGateReason =
  | "provider-rejected"
  | "official-openai"
  | "explicit-opt-in"
  | "user-requested-long"
  | "unverified-endpoint";

export type PromptCacheRetentionGateInput = {
  providerRejected: boolean;
  officialOpenAI: boolean;
  explicitOptIn: boolean;
  userRequestedLong: boolean;
};

export type PromptCacheRetentionGateDecision = {
  keep: boolean;
  reason: PromptCacheRetentionGateReason;
};

/**
 * Pure decision for the `prompt_cache_retention` gate. The optimizer only undoes
 * its own side effect: it never strips a field the user or the provider config
 * asked for, except after the provider has explicitly rejected it.
 */
export function decidePromptCacheRetention(input: PromptCacheRetentionGateInput): PromptCacheRetentionGateDecision {
  if (input.providerRejected) return { keep: false, reason: "provider-rejected" };
  if (input.officialOpenAI) return { keep: true, reason: "official-openai" };
  if (input.explicitOptIn) return { keep: true, reason: "explicit-opt-in" };
  if (input.userRequestedLong) return { keep: true, reason: "user-requested-long" };
  return { keep: false, reason: "unverified-endpoint" };
}

/** True when long retention (OMP_ or legacy PI_) was already requested before this extension loaded. */
export function userRequestedLongCacheRetention(snapshot: CacheRetentionEnvSnapshot = STARTUP_CACHE_RETENTION_ENV): boolean {
  const startupValue = normalizeCacheRetentionCandidate(snapshot.ompWasSet ? snapshot.ompValue : undefined) ??
    normalizeCacheRetentionCandidate(snapshot.piWasSet ? snapshot.piValue : undefined);
  return startupValue === LONG_CACHE_RETENTION_VALUE;
}

export type PromptCacheRetentionDecisionRecord = PromptCacheRetentionGateDecision & {
  modelKey?: string;
  at: number;
};

let lastPromptCacheRetentionDecision: PromptCacheRetentionDecisionRecord | undefined;

/** Remember the latest gate decision so `/cache-optimizer doctor` can explain it. */
export function recordPromptCacheRetentionDecision(modelKey: string | undefined, decision: PromptCacheRetentionGateDecision): void {
  lastPromptCacheRetentionDecision = { ...decision, modelKey, at: Date.now() };
}

export function getLastPromptCacheRetentionDecision(): PromptCacheRetentionDecisionRecord | undefined {
  return lastPromptCacheRetentionDecision ? { ...lastPromptCacheRetentionDecision } : undefined;
}

const PROMPT_CACHE_RETENTION_REASON_TEXT: Record<PromptCacheRetentionGateReason, string> = {
  "provider-rejected": "已移除：该模型在本进程里已经明确拒绝过这个参数",
  "official-openai": "已保留：OpenAI 官方 endpoint",
  "explicit-opt-in": "已保留：compat 显式设置了 supportsLongPromptCacheRetention: true",
  "user-requested-long": "已保留：OMP 启动前已设置 OMP_CACHE_RETENTION=long（或 PI_CACHE_RETENTION=long）",
  "unverified-endpoint": "已移除：该字段只因本扩展请求长缓存而出现，且该 endpoint 未确认支持（如确认支持，可在 api: openai-responses 的 compat 里设置 supportsLongPromptCacheRetention: true）",
};

export function describePromptCacheRetentionDecision(record: PromptCacheRetentionDecisionRecord | undefined): string | undefined {
  if (!record) return undefined;
  return `prompt_cache_retention ${PROMPT_CACHE_RETENTION_REASON_TEXT[record.reason]}${record.modelKey ? `（${record.modelKey}）` : ""}`;
}

export function isCacheRetentionBaselineV1(value: unknown): value is CacheRetentionBaselineV1 {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { version?: unknown; snapshot?: unknown };
  if (record.version !== 1 || typeof record.snapshot !== "object" || record.snapshot === null) return false;
  const snapshot = record.snapshot as { ompWasSet?: unknown; ompValue?: unknown; piWasSet?: unknown; piValue?: unknown };
  return typeof snapshot.ompWasSet === "boolean" &&
    (snapshot.ompValue === undefined || typeof snapshot.ompValue === "string") &&
    typeof snapshot.piWasSet === "boolean" &&
    (snapshot.piValue === undefined || typeof snapshot.piValue === "string");
}

export function getOrCaptureCacheRetentionBaseline(
  env: MutableEnv = process.env,
  globals: Record<symbol, unknown> = globalThis as Record<symbol, unknown>,
): CacheRetentionEnvSnapshot {
  const existing = globals[PI_CACHE_RETENTION_BASELINE_SYMBOL];
  if (isCacheRetentionBaselineV1(existing)) return { ...existing.snapshot };

  const snapshot = captureCacheRetentionEnv(env);
  globals[PI_CACHE_RETENTION_BASELINE_SYMBOL] = { version: 1, snapshot: { ...snapshot } };
  return snapshot;
}

export const STARTUP_CACHE_RETENTION_ENV = getOrCaptureCacheRetentionBaseline();

/**
 * OMP Cache Optimizer（pi-cache-optimizer 的 oh-my-pi 适配 fork）
 *
 * 功能：
 * 1. 可选（默认关闭）清理 OMP system prompt 中的易变内容，提高前缀稳定性。
 * 2. 加载时设置 OMP_CACHE_RETENTION=long（并镜像 PI_CACHE_RETENTION 供宿主读取）。
 * 3. 在信号保守的前提下，对 provider/model 缓存 compat 缺口做一次性提醒。
 * 4. 在 OMP footer 显示按 provider/model 区分的轻量持久化缓存统计。
 * 5. 提供默认关闭的内置工具确定性排序（需显式开启）。
 *
 * Provider 侧 prompt/KV 缓存为 best-effort。本扩展提高命中概率，
 * 尤其经代理时无法保证命中。
 */

// ============================================================
// 在 OMP 支持时自动请求长 prompt-cache 保留。
// /cache-optimizer disable 会恢复本 OMP 进程启动时的值。
// ============================================================
requestLongCacheRetention();
