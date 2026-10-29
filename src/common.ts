import { type ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export type PiModel = NonNullable<ExtensionContext["model"]>;

export type ModelIdentity = Pick<PiModel, "provider" | "id">;

export type UnknownRecord = Record<string, unknown>;

export const LOG_PREFIX = "omp-cache-optimizer";

export function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

export function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) === "EPERM";
  }
}

export function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function getNonNegativeNumber(record: UnknownRecord, key: string): number | undefined {
  const value = getNumber(record[key]);
  return value !== undefined && value >= 0 ? value : undefined;
}

export type MutableEnv = Record<string, string | undefined>;

/**
 * OMP 环境变量主前缀为 `OMP_`；读取时兼容同名的旧 `PI_` 前缀
 * （例如 OMP_CACHE_OPTIMIZER_FOOTER_MODE 未设置时回退读 PI_CACHE_OPTIMIZER_FOOTER_MODE）。
 */
export function legacyPiEnvName(name: string): string | undefined {
  return name.startsWith("OMP_") ? `PI_${name.slice("OMP_".length)}` : undefined;
}

/** 读取 OMP_ 环境变量；未设置时回退到同名 PI_ 变量。 */
export function readEnv(env: MutableEnv, name: string): string | undefined {
  const value = env[name];
  if (value !== undefined) return value;
  const legacy = legacyPiEnvName(name);
  return legacy ? env[legacy] : undefined;
}

/** OMP_ 或其 PI_ 兼容名是否被设置过。 */
export function hasEnv(env: MutableEnv, name: string): boolean {
  return readEnv(env, name) !== undefined;
}
