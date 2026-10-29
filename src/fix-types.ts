import { isNonEmptyString } from "./common.ts";

export interface FixSuggestion {
  providerLabel: string;
  modelId: string;
  compatKeys: Record<string, unknown>;
  /** Runtime-observed failures must never broaden a model-specific fix. */
  forceModelLevel?: boolean;
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

export function isSafeReceiptText(value: unknown): value is string {
  return isNonEmptyString(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isReceiptTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
