import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { buildCacheWarmingDiagnosis, cacheWarmingRefreshDelayMs, decideZeroPriceWarming, isOpenRouterRouterModel, isZeroPriced, readCacheWarmingMode, suggestedPromptCacheLifetimes } from "../src/cache-warming.ts";

type PiModel = NonNullable<ExtensionContext["model"]>;

function model(overrides: Record<string, unknown> = {}): PiModel {
  return {
    provider: "proxy",
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    api: "anthropic-messages",
    baseUrl: "https://proxy.example.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 32_000,
    thinking: { mode: "anthropic-adaptive" },
    ...overrides,
  } as unknown as PiModel;
}

describe("cache warming diagnostics", () => {
  test("reads providers.cacheWarming from the OMP config and defaults to idle", () => {
    assert.equal(readCacheWarmingMode(() => { throw new Error("boom"); }), "idle");
    assert.equal(readCacheWarmingMode(() => undefined), "idle");
    assert.equal(readCacheWarmingMode(() => ({})), "idle");
    assert.equal(readCacheWarmingMode(() => ({ providers: { cacheWarming: "streaming" } })), "streaming");
    assert.equal(readCacheWarmingMode(() => ({ providers: { cacheWarming: "off" } })), "off");
    assert.equal(readCacheWarmingMode(() => ({ "providers.cacheWarming": "streaming" })), "streaming");
    assert.equal(readCacheWarmingMode(() => ({ providers: { cacheWarming: "bogus" } })), "idle");
  });

  test("matches OMP's refresh schedule", () => {
    assert.equal(cacheWarmingRefreshDelayMs(300_000), 270_000);
    assert.equal(cacheWarmingRefreshDelayMs(3_600_000), 3_240_000);
    assert.equal(cacheWarmingRefreshDelayMs(10_000), undefined);
  });

  test("flags a model without promptCache and suggests Anthropic lifetimes", () => {
    const result = buildCacheWarmingDiagnosis(model(), { mode: "streaming", tier: "long" });
    assert.equal(result.eligible, false);
    assert.deepEqual(result.issues, ["prompt_cache_missing"]);
    assert.ok(result.lines.some((line) => line.includes("promptCache: { short: 300, long: 3600 }")));
  });

  test("suggests only the short lifetime outside anthropic-messages", () => {
    assert.deepEqual(suggestedPromptCacheLifetimes(model({ api: "openai-completions" })), { short: 300 });
  });

  test("reports eligibility when lifetime, pricing and replayability are present", () => {
    const result = buildCacheWarmingDiagnosis(model({ promptCache: { short: 300, long: 3600 } }), { mode: "streaming", tier: "long" });
    assert.equal(result.eligible, true);
    assert.deepEqual(result.issues, []);
    assert.ok(result.lines.some((line) => line.includes("promptCache.long：1h")));
  });

  test("flags missing pricing and non-replayable budget thinking", () => {
    const result = buildCacheWarmingDiagnosis(
      model({ promptCache: { short: 300 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinking: undefined }),
      { mode: "streaming", tier: "short" },
    );
    assert.deepEqual(result.issues, ["pricing_missing", "not_replayable"]);
    assert.equal(result.eligible, false);
  });

  test("explains that idle mode cannot refresh a one-hour entry", () => {
    const result = buildCacheWarmingDiagnosis(model({ promptCache: { short: 300, long: 3600 } }), { mode: "idle", tier: "long" });
    assert.ok(result.lines.some((line) => line.includes("idle 预热在 30 分钟后停止") && line.includes("54 分钟")));
    const short = buildCacheWarmingDiagnosis(model({ promptCache: { short: 300, long: 3600 } }), { mode: "idle", tier: "short" });
    assert.ok(!short.lines.some((line) => line.includes("idle 预热在 30 分钟后停止")));
  });

  test("off mode and unsupported hosts are not eligible", () => {
    assert.equal(buildCacheWarmingDiagnosis(model({ promptCache: { long: 3600 } }), { mode: "off", tier: "long" }).eligible, false);
    assert.deepEqual(buildCacheWarmingDiagnosis(model(), { mode: "unsupported", tier: "long" }).issues, ["unsupported"]);
  });
});

describe("zero-price warming override", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  test("turns OMP's unpriced stop into warm for zero-price models", () => {
    assert.equal(decideZeroPriceWarming({ action: "stop", warmCost: 0, missCost: 0 }, model({ cost: zero })), "warm");
  });

  test("does not override when only the output price is set", () => {
    const outputOnly = { input: 0, output: 15, cacheRead: 0, cacheWrite: 0 };
    assert.equal(decideZeroPriceWarming({ action: "stop", warmCost: 0, missCost: 0 }, model({ cost: outputOnly })), undefined);
    const m = model({ promptCache: { short: 300, long: 3600 }, cost: outputOnly });
    assert.deepEqual(buildCacheWarmingDiagnosis(m, { mode: "streaming", tier: "long", zeroPriceWarming: true }).issues, ["pricing_missing"]);
  });

  test("respects OMP when the model has prices or OMP already warms", () => {
    assert.equal(decideZeroPriceWarming({ action: "stop", warmCost: 0, missCost: 0 }, model()), undefined);
    assert.equal(decideZeroPriceWarming({ action: "stop", warmCost: 0.01, missCost: 0.02 }, model({ cost: zero })), undefined);
    assert.equal(decideZeroPriceWarming({ action: "warm", warmCost: 0, missCost: 0 }, model({ cost: zero })), undefined);
    assert.equal(decideZeroPriceWarming({ action: "stop", warmCost: 0, missCost: 0 }, undefined), undefined);
  });

  test("doctor treats zero pricing as covered when the override is on", () => {
    const m = model({ promptCache: { short: 300, long: 3600 }, cost: zero });
    const on = buildCacheWarmingDiagnosis(m, { mode: "streaming", tier: "long", zeroPriceWarming: true });
    assert.equal(on.eligible, true);
    assert.ok(on.lines.some((line) => line.includes("本扩展会覆盖这一判断")));
    const off = buildCacheWarmingDiagnosis(m, { mode: "streaming", tier: "long", zeroPriceWarming: false });
    assert.deepEqual(off.issues, ["pricing_missing"]);
  });

  test("OpenRouter router models are not free just because OMP shows 0", () => {
    const router = model({ provider: "openrouter", id: "openrouter/auto", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", cost: zero, promptCache: { short: 300 } });
    assert.equal(isOpenRouterRouterModel(router), true);
    assert.equal(isZeroPriced(router), false);
    assert.equal(decideZeroPriceWarming({ action: "stop", warmCost: 0, missCost: 0 }, router), undefined);
    const diagnosis = buildCacheWarmingDiagnosis(router, { mode: "streaming", tier: "short", zeroPriceWarming: true });
    assert.deepEqual(diagnosis.issues, ["pricing_unknown"]);
    assert.ok(diagnosis.lines.some((line) => line.includes("OpenRouter 路由模型")));
    // A routed id reached through another provider entry is still a router.
    assert.equal(isZeroPriced(model({ provider: "proxy", id: "openrouter/free", cost: zero })), false);
    // Ordinary free OpenRouter models stay zero-priced.
    assert.equal(isZeroPriced(model({ provider: "openrouter", id: "meta-llama/llama-4:free", cost: zero })), true);
  });

  test("a positive price in any cost tier means the model is not zero-priced", () => {
    const tiered = { ...zero, tiers: [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 0 }, { input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5, inputTokensAbove: 200_000 }] };
    const m = model({ cost: tiered, promptCache: { short: 300, long: 3600 } });
    assert.equal(isZeroPriced(m), false);
    assert.equal(decideZeroPriceWarming({ action: "stop", warmCost: 0, missCost: 0 }, m), undefined);
    const diagnosis = buildCacheWarmingDiagnosis(m, { mode: "streaming", tier: "long", zeroPriceWarming: true });
    assert.deepEqual(diagnosis.issues, ["pricing_missing"]);
    assert.ok(diagnosis.lines.some((line) => line.includes("按 prompt 长度分档")));
    const allZeroTiers = model({ cost: { ...zero, tiers: [{ ...zero, inputTokensAbove: 200_000 }] } });
    assert.equal(isZeroPriced(allZeroTiers), true);
  });
});
