import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * OMP 的 agent 目录：与宿主 `@oh-my-pi/pi-utils` 的 getAgentDir() 一致，
 * `PI_CODING_AGENT_DIR` 覆盖（宿主切换 profile 时也会写它），否则为 `~/.omp/agent`。
 * 扩展只从宿主 import type，不在运行时依赖宿主包，所以这里自行解析。
 */
export function resolveAgentDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  return override ? resolve(override) : join(homedir(), ".omp", "agent");
}

export const STATE_DIR = resolveAgentDir();

/** 串行化本扩展配置文件（omp-cache-optimizer-config.json）写入的锁。 */
export const MODELS_TRANSACTION_LOCK_PATH = join(STATE_DIR, "omp-cache-optimizer-config-transaction.lock");

export const MODELS_TRANSACTION_LOCK_STALE_MS = 60_000;

export const MODELS_TRANSACTION_LOCK_WAIT_MS = 5_000;
