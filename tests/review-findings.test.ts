import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

import { __internals_for_tests as internals } from "#extension";

describe("footer status separation and command completion", () => {
  test("leaves footer status text unchanged (OMP adds its own separator)", () => {
    // OMP 状态栏自己加分隔点，prefixFooterStatus 是恒等函数。
    assert.equal(
      internals.prefixFooterStatus("OpenAI Cache | 缓存命中率：0%"),
      "OpenAI Cache | 缓存命中率：0%",
    );
    assert.equal(
      internals.prefixFooterStatus("缓存优化已关闭 · OpenAI Cache | 缓存命中率：0% ⚠️ 配置"),
      "缓存优化已关闭 · OpenAI Cache | 缓存命中率：0% ⚠️ 配置",
    );
    assert.equal(internals.prefixFooterStatus(undefined), undefined);
  });

  test("formats footer stats in the Chinese fork format", () => {
    assert.equal(
      internals.formatCacheStats(
        { label: "OpenAI Cache", showCacheWrite: false } as any,
        {
          day: "2026-08-08",
          totalRequests: 234,
          hitRequests: 224,
          cachedInputTokens: 52_200_000,
          cacheWriteInputTokens: 0,
          totalInputTokens: 56_100_000,
        },
      ),
      "OpenAI Cache | 缓存命中率：93% | 缓存请求命中次数：224/234 次 | 缓存token/总输入：52.2M/56.1M",
    );
  });

  test("publishes the footer status through setStatus", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-footer-status-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) {
          handlers.set(name, handler);
        },
        registerCommand() {},
      } as any);

      const statuses: Array<{ key: string; value: string | undefined }> = [];
      const model = {
        provider: "proxy",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        compat: {},
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      };
      const context = {
        model,
        sessionManager: { getSessionId: () => "footer-status-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          notify() {},
          setStatus(key: string, value: string | undefined) {
            statuses.push({ key, value });
          },
        },
      };

      const sessionStart = handlers.get("session_start");
      assert.ok(sessionStart);
      await sessionStart({ reason: "startup" }, context);
      await freshModule.__internals_for_tests.waitForStatsRestore();

      assert.equal(statuses.at(-1)?.key, "omp-cache-stats");
      assert.match(statuses.at(-1)?.value ?? "", /^OpenAI Cache \| 缓存命中率：/);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("completes top-level and nested cache-optimizer arguments by prefix", () => {
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions(""),
      ["enable", "disable", "doctor", "stats", "config", "compat", "reset", "fix", "rollback"].map((value) => ({ value, label: value })),
    );
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions(" c "),
      [{ value: "config", label: "config" }],
    );
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions("config "),
      ["footer-mode", "prompt-rewrite", "openai-cache-key", "tool-order", "zero-price-warming", "stats-incremental", "reset"].map((value) => ({ value: `config ${value}`, label: value })),
    );
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions("stats "),
      ["all", "contributors"].map((value) => ({ value: `stats ${value}`, label: value })),
    );
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions("stats a"),
      [{ value: "stats all", label: "all" }],
    );
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions("config footer-mode "),
      ["total", "session", "process"].map((value) => ({ value: `config footer-mode ${value}`, label: value })),
    );
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions("config footer-mode s"),
      [{ value: "config footer-mode session", label: "session" }],
    );
    assert.deepEqual(
      internals.getCacheOptimizerArgumentCompletions("fix p"),
      [{ value: "fix prompt-cache-key", label: "prompt-cache-key" }],
    );
    assert.equal(internals.getCacheOptimizerArgumentCompletions("unknown "), null);
    assert.equal(internals.getCacheOptimizerArgumentCompletions("config unknown "), null);
    assert.equal(internals.getCacheOptimizerArgumentCompletions("config footer-mode session extra"), null);
    assert.equal(internals.getCacheOptimizerArgumentCompletions(undefined as unknown as string), null);
  });
});

describe("footer stats modes", () => {
  const sessionHash = "0123456789abcdef";
  const model = {
    provider: "proxy",
    id: "gpt-5.5",
    name: "GPT-5.5",
  };
  const sessionStats = {
    day: "2026-08-03",
    totalRequests: 2,
    hitRequests: 1,
    cachedInputTokens: 400,
    cacheWriteInputTokens: 100,
    totalInputTokens: 1000,
  };
  const totalStats = {
    day: "2026-08-03",
    totalRequests: 9,
    hitRequests: 7,
    cachedInputTokens: 4000,
    cacheWriteInputTokens: 500,
    totalInputTokens: 8000,
  };
  const statsByModel = {
    [internals.makeSessionModelKey(sessionHash, model.provider, model.id)]: sessionStats,
  };
  const totalsByModel = { [`${model.provider}/${model.id}`]: totalStats };

  test("defaults to session and accepts session, total, or process environment values", () => {
    assert.deepEqual(internals.resolveFooterStatsMode(undefined, {}), {
      mode: "session",
      source: "default",
    });
    assert.deepEqual(
      internals.resolveFooterStatsMode(undefined, { PI_CACHE_OPTIMIZER_FOOTER_MODE: " SeSsIoN " }),
      { mode: "session", source: "env" },
    );
    assert.deepEqual(
      internals.resolveFooterStatsMode(undefined, { PI_CACHE_OPTIMIZER_FOOTER_MODE: "TOTAL" }),
      { mode: "total", source: "env" },
    );
    assert.deepEqual(
      internals.resolveFooterStatsMode(undefined, { PI_CACHE_OPTIMIZER_FOOTER_MODE: "process" }),
      { mode: "process", source: "env" },
    );
    assert.deepEqual(
      internals.resolveFooterStatsMode(undefined, { PI_CACHE_OPTIMIZER_FOOTER_MODE: "daily" }),
      { mode: "session", source: "default" },
    );
    assert.equal(
      internals.parsePersistedCacheOptimizerConfig({ version: 1, footerMode: "daily" }),
      undefined,
    );
  });

  test("persistent configuration overrides the environment mode", () => {
    assert.deepEqual(
      internals.resolveFooterStatsMode("total", { PI_CACHE_OPTIMIZER_FOOTER_MODE: "session" }),
      { mode: "total", source: "config" },
    );
    assert.deepEqual(
      internals.resolveFooterStatsMode("session", { PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }),
      { mode: "session", source: "config" },
    );
  });

  test("selects direct model stats from the requested scope", () => {
    const processStats = { ...sessionStats, totalRequests: 3, hitRequests: 2 };
    const processByModel = { [`${model.provider}/${model.id}`]: processStats };
    assert.equal(
      internals.selectFooterStatsForModel("session", sessionHash, statsByModel, totalsByModel, model, processByModel),
      sessionStats,
    );
    assert.equal(
      internals.selectFooterStatsForModel("total", sessionHash, statsByModel, totalsByModel, model, processByModel),
      totalStats,
    );
    assert.equal(
      internals.selectFooterStatsForModel("process", sessionHash, statsByModel, totalsByModel, model, processByModel),
      processStats,
    );
    assert.equal(
      internals.selectFooterStatsForModel("session", "fresh-session", statsByModel, totalsByModel, model, processByModel),
      undefined,
    );
    assert.equal(
      internals.selectFooterStatsForModel("process", "fresh-session", statsByModel, totalsByModel, model),
      undefined,
    );
  });

  test("uses the requested scope for exact router restore", () => {
    const routed = { provider: model.provider, id: model.id, name: model.name };
    const sessionEntry = internals.buildExactRouterStatusEntry(
      sessionHash,
      statsByModel,
      routed,
      totalsByModel,
      "session",
    );
    const processEntry = internals.buildExactRouterStatusEntry(
      sessionHash,
      statsByModel,
      routed,
      totalsByModel,
      "process",
      { [`${model.provider}/${model.id}`]: sessionStats },
    );
    const totalEntry = internals.buildExactRouterStatusEntry(
      sessionHash,
      statsByModel,
      routed,
      totalsByModel,
      "total",
    );

    const freshSessionEntry = internals.buildExactRouterStatusEntry(
      "fresh-session",
      statsByModel,
      routed,
      totalsByModel,
      "session",
    );

    assert.equal(sessionEntry?.stats, sessionStats);
    assert.equal(processEntry?.stats, sessionStats);
    assert.equal(totalEntry?.stats, totalStats);
    assert.equal(freshSessionEntry?.stats.totalRequests, 0);
  });

  test("restores only the matching session bucket", () => {
    const persisted = {
      statsByModel: {
        ...statsByModel,
        [internals.makeSessionModelKey("other-session", model.provider, model.id)]: totalStats,
      },
      totalsByModel,
      legacyFamily: {},
    };

    assert.deepEqual(internals.filterRestorableStatsForSession(persisted, sessionHash), statsByModel);
    assert.deepEqual(internals.filterRestorableStatsForSession(persisted, "fresh-session"), {});
  });

  test("keeps router fallback inside the requested scope", () => {
    const otherTotal = {
      ...totalStats,
      totalRequests: 99,
      hitRequests: 90,
    };
    const otherSession = {
      ...sessionStats,
      totalRequests: 1,
      hitRequests: 1,
    };
    const routedSessionStats = {
      ...statsByModel,
      [internals.makeSessionModelKey(sessionHash, "anthropic", "claude-opus-5")]: otherSession,
    };
    const routedTotals = {
      ...totalsByModel,
      "anthropic/claude-opus-5": otherTotal,
    };

    const sessionEntry = internals.findBestRouterModelStats(
      "session",
      sessionHash,
      routedSessionStats,
      routedTotals,
    );
    const totalEntry = internals.findBestRouterModelStats(
      "total",
      sessionHash,
      routedSessionStats,
      routedTotals,
    );

    assert.equal(sessionEntry?.model.id, model.id);
    assert.equal(sessionEntry?.stats, sessionStats);
    assert.equal(totalEntry?.model.id, "claude-opus-5");
    assert.equal(totalEntry?.stats, otherTotal);
  });

  test("persists the command override atomically", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-footer-mode-test-"));
    const configPath = join(tempDir, "omp-cache-optimizer-config.json");

    try {
      await internals.writePersistedFooterMode("session", configPath);
      assert.equal(internals.readPersistedFooterMode(configPath), "session");
      assert.deepEqual(
        internals.parsePersistedCacheOptimizerConfig(JSON.parse(await readFile(configPath, "utf8"))),
        { version: 1, footerMode: "session" },
      );
      assert.deepEqual(await readdir(tempDir), ["omp-cache-optimizer-config.json"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("feature settings persist, override env values, and reset without losing unrelated config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-feature-command-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousPromptRewrite = process.env.OMP_CACHE_OPTIMIZER_PROMPT_REWRITE;
    try {
      process.env.PI_CODING_AGENT_DIR = tempDir;
      process.env.OMP_CACHE_OPTIMIZER_PROMPT_REWRITE = "0";
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), { interopDefault: false, moduleCache: false });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const commands = new Map<string, any>();
      freshModule.default({ on() {}, registerCommand(name: string, command: any) { commands.set(name, command); } } as any);
      const command = commands.get("cache-optimizer");
      const notifications: string[] = [];
      const context = { model: undefined, hasUI: false, sessionManager: { getSessionId: () => "feature-session" }, modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] }, ui: { notify: (message: string) => notifications.push(message), setStatus() {} } };
      const configPath = join(tempDir, "omp-cache-optimizer-config.json");

      assert.equal(freshModule.__internals_for_tests.featureEnabled("promptRewrite", "OMP_CACHE_OPTIMIZER_PROMPT_REWRITE", false), false);
      await command.handler("config prompt-rewrite on", context);
      assert.equal(freshModule.__internals_for_tests.featureEnabled("promptRewrite", "OMP_CACHE_OPTIMIZER_PROMPT_REWRITE", false), true);
      const persisted = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(persisted.version, 3);
      assert.equal(persisted.features.promptRewrite, true);
      assert.match(notifications.at(-1) ?? "", /prompt-rewrite 已设为 on/);

      await command.handler("config", context);
      assert.match(notifications.at(-1) ?? "", /持久化特性配置/);
      await command.handler("config reset", context);
      const reset = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(reset.features, undefined);
      assert.equal(freshModule.__internals_for_tests.featureEnabled("promptRewrite", "OMP_CACHE_OPTIMIZER_PROMPT_REWRITE", false), false);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousPromptRewrite === undefined) delete process.env.OMP_CACHE_OPTIMIZER_PROMPT_REWRITE; else process.env.OMP_CACHE_OPTIMIZER_PROMPT_REWRITE = previousPromptRewrite;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("config command overrides the environment mode", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-footer-command-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousFooterMode = process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE = "session";
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const commands = new Map<string, {
        handler: (args: string, context: any) => unknown;
        getArgumentCompletions?: (argumentPrefix: string) => unknown;
      }>();
      freshModule.default({
        on() {},
        registerCommand(name: string, command: {
          handler: (args: string, context: any) => unknown;
          getArgumentCompletions?: (argumentPrefix: string) => unknown;
        }) {
          commands.set(name, command);
        },
      } as any);

      const command = commands.get("cache-optimizer");
      assert.ok(command);
      assert.equal(typeof command.getArgumentCompletions, "function");
      assert.deepEqual(command.getArgumentCompletions?.("config footer-mode s"), [
        { value: "config footer-mode session", label: "session" },
      ]);
      const notifications: Array<{ message: string; level: string }> = [];
      const commandContext = {
        model: undefined,
        hasUI: false,
        sessionManager: { getSessionId: () => "footer-command-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          notify: (message: string, level: string) => notifications.push({ message, level }),
          setStatus() {},
        },
      };
      const configPath = join(tempAgentDir, "omp-cache-optimizer-config.json");

      await command.handler("config footer-mode total", commandContext);
      assert.equal(freshModule.__internals_for_tests.readPersistedFooterMode(configPath), "total");
      assert.equal(freshModule.__internals_for_tests.footerStatsMode(), "total");
      assert.match(notifications.at(-1)?.message ?? "", /Footer 模式已设为 total/);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousFooterMode === undefined) delete process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE;
      else process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE = previousFooterMode;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("interactive menu exposes and applies footer mode", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-footer-menu-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousFooterMode = process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      delete process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const commands = new Map<string, { handler: (args: string, context: any) => unknown }>();
      freshModule.default({
        on() {},
        registerCommand(name: string, command: { handler: (args: string, context: any) => unknown }) {
          commands.set(name, command);
        },
      } as any);

      const command = commands.get("cache-optimizer");
      assert.ok(command);
      const selectCalls: string[] = [];
      const notifications: string[] = [];
      const commandContext = {
        model: undefined,
        hasUI: true,
        sessionManager: { getSessionId: () => "footer-menu-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          notify: (message: string) => notifications.push(message),
          setStatus() {},
          select: async (title: string, options: string[]) => {
            selectCalls.push(title);
            if (title === "缓存优化器") return options.find((option) => option.startsWith("Footer 模式"));
            return options.find((option) => option.startsWith("process"));
          },
        },
      };
      const configPath = join(tempAgentDir, "omp-cache-optimizer-config.json");

      await command.handler("", commandContext);

      assert.deepEqual(selectCalls, ["缓存优化器", "Footer 缓存统计模式"]);
      assert.equal(freshModule.__internals_for_tests.readPersistedFooterMode(configPath), "process");
      assert.equal(freshModule.__internals_for_tests.footerStatsMode(), "process");
      assert.match(notifications.at(-1) ?? "", /Footer 模式已设为 process/);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousFooterMode === undefined) delete process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE;
      else process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE = previousFooterMode;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });
});

describe("explicit compat precedence", () => {
  const provider = "proxy";
  const modelId = "builtin-model";

  function openAIModel(extra: Record<string, unknown> = {}) {
    return {
      provider,
      id: modelId,
      name: "Built-in model through proxy",
      api: "openai-responses",
      baseUrl: "https://proxy.example/v1",
      compat: {},
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
      ...extra,
    } as any;
  }

  test("resolved compat wins over compatConfig and compatConfig remains the explicit layer", () => {
    const model = openAIModel({
      compatConfig: { supportsLongPromptCacheRetention: true, supportsDeveloperRole: false },
      compat: { supportsLongPromptCacheRetention: false },
    });

    assert.deepEqual(internals.getCompat(model), {
      supportsLongPromptCacheRetention: false,
      supportsDeveloperRole: false,
    });
    assert.deepEqual(internals.getExplicitCompat(model), {
      supportsLongPromptCacheRetention: true,
      supportsDeveloperRole: false,
    });
    assert.deepEqual(
      internals.getEffectiveCompatSources(model).map(({ source }) => source),
      ["config", "runtime"],
    );
  });

  test("compatConfig alone and missing compat layers resolve safely", () => {
    assert.deepEqual(
      internals.getCompat(openAIModel({ compatConfig: { supportsLongPromptCacheRetention: true }, compat: undefined })),
      { supportsLongPromptCacheRetention: true },
    );
    assert.deepEqual(internals.getCompat(openAIModel({ compat: undefined })), {});
    assert.deepEqual(internals.getCompat(undefined), {});
    assert.deepEqual(internals.getExplicitCompat(openAIModel({ compat: { supportsLongPromptCacheRetention: true } })), {});
  });

  test("nested compat records merge key by key across layers", () => {
    const model = openAIModel({
      compatConfig: { openRouterRouting: { allow_fallbacks: false, only: ["openai"] } },
      compat: { openRouterRouting: { order: ["openai", "anthropic"] } },
    });

    assert.deepEqual(
      internals.getCompat(model).openRouterRouting,
      { allow_fallbacks: false, only: ["openai"], order: ["openai", "anthropic"] },
    );
  });

  test("before_provider_request gates prompt_cache_retention by the model's compat, not models.json", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "omp-cache-review-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) {
          handlers.set(name, handler);
        },
        registerCommand() {},
      } as any);
      const hook = handlers.get("before_provider_request");
      assert.ok(hook);
      const contextFor = (model: unknown) => ({
        model,
        sessionManager: { getSessionId: () => "review-test-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: { notify() {}, setStatus() {} },
      });
      const run = (model: unknown) => {
        const payload: Record<string, unknown> = { prompt_cache_retention: "24h" };
        const result = (hook({ payload }, contextFor(model)) ?? payload) as Record<string, unknown>;
        assert.equal(payload.prompt_cache_retention, "24h", "the original payload is never mutated");
        return result;
      };

      // Pi's old models.json is not read any more: an opt-in written there is ignored.
      await writeFile(
        join(tempAgentDir, "models.json"),
        JSON.stringify({ providers: { [provider]: { compat: { supportsLongPromptCacheRetention: true } } } }),
      );
      assert.equal("prompt_cache_retention" in run(openAIModel()), false);

      assert.equal(
        run(openAIModel({ compat: { supportsLongPromptCacheRetention: true } })).prompt_cache_retention,
        "24h",
      );
      assert.equal(
        run(openAIModel({ compatConfig: { supportsLongPromptCacheRetention: true } })).prompt_cache_retention,
        "24h",
      );
      // The resolved compat layer outranks the user's raw compatConfig.
      assert.equal(
        "prompt_cache_retention" in run(openAIModel({
          compatConfig: { supportsLongPromptCacheRetention: true },
          compat: { supportsLongPromptCacheRetention: false },
        })),
        false,
      );
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });
});

describe("provider response recovery", () => {
  test("body-only prompt_cache_retention errors disable the field on the next request", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-retention-recovery-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;

      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) {
          handlers.set(name, handler);
        },
        registerCommand() {},
      } as any);

      const model = {
        provider: "proxy",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-completions",
        baseUrl: "https://proxy.example/v1",
        compat: { supportsLongPromptCacheRetention: true },
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      };
      const notifications: string[] = [];
      const context = {
        model,
        sessionManager: { getSessionId: () => "retention-recovery-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          notify(message: string) { notifications.push(message); },
          setStatus() {},
        },
      };
      const requestHook = handlers.get("before_provider_request");
      const messageEndHook = handlers.get("message_end");
      assert.ok(requestHook);
      assert.ok(messageEndHook);

      const firstPayload: Record<string, unknown> = { prompt_cache_retention: "24h" };
      const firstPayloadResult = (requestHook({ payload: firstPayload }, context) ?? firstPayload) as Record<string, unknown>;
      assert.equal(firstPayloadResult.prompt_cache_retention, "24h");

      await messageEndHook({
        message: {
          role: "assistant",
          provider: "proxy",
          model: "gpt-5.5",
          api: "openai-completions",
          stopReason: "error",
          errorMessage: "400 Bad request: prompt_cache_retention must be one of 24h or in-memory",
          usage: { input: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }, context);

      const valueErrorPayload: Record<string, unknown> = { prompt_cache_retention: "24h" };
      const valueErrorPayloadResult = (requestHook({ payload: valueErrorPayload }, context) ?? valueErrorPayload) as Record<string, unknown>;
      assert.equal(valueErrorPayloadResult.prompt_cache_retention, "24h");

      await messageEndHook({
        message: {
          role: "assistant",
          provider: "proxy",
          model: "gpt-5.5",
          api: "openai-completions",
          stopReason: "error",
          errorMessage: "400 Unsupported parameter: prompt_cache_retention",
          usage: { input: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }, context);

      const unsupportedPayload: Record<string, unknown> = { prompt_cache_retention: "24h" };
      const unsupportedPayloadResult = (requestHook({ payload: unsupportedPayload }, context) ?? unsupportedPayload) as Record<string, unknown>;
      assert.equal("prompt_cache_retention" in unsupportedPayloadResult, false);
      assert.equal(unsupportedPayload.prompt_cache_retention, "24h");
      assert.ok(notifications.some((message) => message.includes("prompt_cache_retention")));
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("routed body-only errors use assistant provider/model identity without a live registry", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-routed-retention-recovery-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;

      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) {
          handlers.set(name, handler);
        },
        registerCommand() {},
      } as any);

      const routerModel = {
        provider: "router",
        id: "auto",
        name: "Auto",
        api: "router-api",
        baseUrl: "",
        compat: {},
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      };
      const upstreamModel = {
        ...routerModel,
        provider: "proxy",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-completions",
        baseUrl: "https://proxy.example/v1",
        compat: { supportsLongPromptCacheRetention: true },
      };
      const baseContext = {
        sessionManager: { getSessionId: () => "routed-retention-recovery-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: { notify() {}, setStatus() {} },
      };
      const requestHook = handlers.get("before_provider_request");
      const messageEndHook = handlers.get("message_end");
      assert.ok(requestHook);
      assert.ok(messageEndHook);

      await messageEndHook({
        message: {
          role: "assistant",
          provider: "proxy",
          model: "gpt-5.5",
          api: "openai-completions",
          stopReason: "error",
          errorMessage: "400 Unsupported parameter: prompt_cache_retention",
          usage: { input: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }, { ...baseContext, model: routerModel });

      const nextPayload: Record<string, unknown> = { prompt_cache_retention: "24h" };
      const nextPayloadResult = (requestHook({ payload: nextPayload }, { ...baseContext, model: upstreamModel }) ?? nextPayload) as Record<string, unknown>;
      assert.equal("prompt_cache_retention" in nextPayloadResult, false);
      assert.equal(nextPayload.prompt_cache_retention, "24h");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });
});

describe("DeepSeek protocol-first compatibility", () => {
  const model = (compat: Record<string, unknown> = {}, overrides: Partial<Record<string, unknown>> = {}) => ({
    provider: "amd-radeon",
    id: "DeepSeek-V4-Flash",
    name: "DeepSeek V4 Flash",
    api: "openai-completions",
    baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
    compat,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    ...overrides,
  }) as any;

  test("checks DeepSeek reasoning replay only for reasoning models on openai-completions", () => {
    const current = model({ supportsReasoningEffort: true });
    assert.equal(internals.isDeepSeekWireCompatApplicable(current), true);
    assert.deepEqual(internals.describeMissingDeepSeekCompat(current), ["requiresReasoningContentForToolCalls"]);
    assert.deepEqual(internals.buildDeepSeekCompatSuggestion(["requiresReasoningContentForToolCalls"]), {
      requiresReasoningContentForToolCalls: true,
    });
    assert.deepEqual(
      internals.describeMissingDeepSeekCompat(model({ requiresReasoningContentForToolCalls: true })),
      [],
    );
    // Non-reasoning, non-completions and non-DeepSeek models are not applicable.
    assert.equal(internals.isDeepSeekWireCompatApplicable(model({}, { reasoning: false })), false);
    assert.equal(internals.isDeepSeekWireCompatApplicable(model({}, { api: "openai-responses" })), false);
    assert.equal(internals.isDeepSeekWireCompatApplicable(model({}, { id: "gpt-5.5", name: "GPT-5.5" })), false);
    assert.deepEqual(internals.describeMissingDeepSeekCompat(model({}, { reasoning: false })), []);
  });

  test("never lists or suggests thinkingFormat and has no generic proxy compat requirement", () => {
    for (const thinkingFormat of [undefined, "openai", "qwen", "openrouter", "together"]) {
      const current = model({ supportsReasoningEffort: true, ...(thinkingFormat ? { thinkingFormat } : {}) });
      assert.equal(internals.isDeepSeekWireCompatApplicable(current), true);
      assert.deepEqual(internals.describeMissingOpenAICompatibleProxyCompat(current), []);
      assert.deepEqual(internals.describeMissingCacheCompatForModel(current), ["requiresReasoningContentForToolCalls"]);
      const suggestion = internals.buildFixSuggestion(current);
      assert.deepEqual(suggestion?.compatKeys, { requiresReasoningContentForToolCalls: true });
      assert.doesNotMatch(JSON.stringify(suggestion), /thinkingFormat/);
    }
    assert.doesNotMatch(
      internals.buildOpenAIProxyCompatWarningText("amd-radeon/DeepSeek-V4-Flash", []),
      /thinkingFormat|requiresReasoningContent/,
    );
  });

  test("suggests nothing when the resolved compat already satisfies the replay check", () => {
    const satisfied = model({ requiresReasoningContentForToolCalls: true, supportsReasoningEffort: true });
    assert.deepEqual(internals.describeMissingCacheCompatForModel(satisfied), []);
    assert.equal(internals.buildFixSuggestion(satisfied), undefined);
    // compat (resolved) outranks compatConfig (user text): an explicit true that OMP resolved to false is still reported.
    const resolvedOff = model({ requiresReasoningContentForToolCalls: false }, {
      compatConfig: { requiresReasoningContentForToolCalls: true },
    });
    assert.deepEqual(internals.describeMissingDeepSeekCompat(resolvedOff), ["requiresReasoningContentForToolCalls"]);
  });

  test("requires explicit error evidence before proposing a model-scoped protocol repair", () => {
    const current = model({ supportsReasoningEffort: true });
    assert.equal(internals.buildReasoningProtocolFixSuggestion(current), undefined);
    assert.deepEqual(internals.buildReasoningProtocolFixSuggestion(current, true)?.compatKeys, {
      thinkingFormat: "openai",
    });
    assert.equal(internals.buildReasoningProtocolFixSuggestion(current, true)?.forceModelLevel, true);
    assert.deepEqual(internals.buildReasoningProtocolFixSuggestion(model(), true)?.compatKeys, {
      thinkingFormat: "openai",
      supportsReasoningEffort: true,
    });
    // Replay is switched off only when the user explicitly enabled it in models.yml (compatConfig).
    assert.deepEqual(internals.buildReasoningProtocolFixSuggestion(
      model(
        { supportsReasoningEffort: true, requiresReasoningContentForToolCalls: true },
        { compatConfig: { requiresReasoningContentForToolCalls: true } },
      ),
      true,
    )?.compatKeys, {
      thinkingFormat: "openai",
      requiresReasoningContentForToolCalls: false,
    });
    assert.deepEqual(internals.buildReasoningProtocolFixSuggestion(
      model({ supportsReasoningEffort: true, requiresReasoningContentForToolCalls: true }),
      true,
    )?.compatKeys, { thinkingFormat: "openai" });
    assert.equal(internals.hasReasoningProtocolRejectionText(
      '400 Unsupported parameter: thinking. Use reasoning_effort instead.',
    ), true);
    assert.equal(internals.hasReasoningProtocolRejectionText(
      '400 未知请求参数：thinking，请使用 reasoning_effort。',
    ), true);
    assert.equal(internals.hasReasoningProtocolRejectionText(
      '不支持 thinking 参数，请改用 reasoning_effort。',
    ), true);
    assert.equal(internals.hasReasoningProtocolRejectionText(
      '不支持参数 thinking，请使用 reasoning_effort。',
    ), true);
    assert.equal(internals.hasReasoningProtocolRejectionText(
      'thinking 参数不支持；请使用 reasoning_effort。',
    ), true);
    assert.equal(internals.hasReasoningProtocolRejectionText(
      '400 Unsupported parameter: reasoning_effort. Use thinking instead.',
    ), false);
    for (const message of [
      '400 Invalid parameter: thinking. Use reasoning_effort instead.',
      'thinking is not accepted; reasoning_effort is required.',
      'thinking is disallowed; please use reasoning_effort.',
      'thinking is not a valid field; set reasoning_effort.',
      'thinking is rejected; replace thinking with reasoning_effort.',
    ]) {
      assert.equal(internals.hasReasoningProtocolRejectionText(message), true, message);
    }
    for (const message of [
      '400 Invalid parameter: reasoning_effort. Use thinking instead.',
      'reasoning_effort is not accepted; use thinking instead.',
      'thinking is unsupported; reasoning_effort should not be used either.',
      'thinking is unsupported; reasoning_effort is supported but disabled for this account.',
      'thinking is unsupported; reasoning_effort must not be sent.',
      'thinking is unsupported; do not use reasoning_effort.',
      'thinking is unsupported; reasoning_effort is not required.',
      'thinking is unsupported! do not use reasoning_effort.',
      '不支持 thinking 参数，请不要使用 reasoning_effort。',
      'thinking 参数不支持；不建议使用 reasoning_effort。',
      'thinking 参数不支持；不能使用 reasoning_effort。',
      'thinking 参数不支持；reasoning_effort 不推荐使用。',
      '不支持 thinking 参数值，请使用 reasoning_effort。',
      'thinking 参数不支持流式请求，请使用 reasoning_effort。',
      '流式模式下不支持 thinking 参数，请使用 reasoning_effort。',
      '当 stream=true 时，不支持 thinking 参数，请使用 reasoning_effort。',
      '当 temperature=0.5 时，不支持 thinking 参数，请使用 reasoning_effort。',
      '不支持 thinking 参数，当 stream=true 时请使用 reasoning_effort。',
      'thinking 参数不支持；不建议使用参数 reasoning_effort。',
      '并非不支持 thinking 参数，请使用 reasoning_effort。',
      '未知请求参数：thinking；reasoning_effort 也不支持。',
      '未知请求参数：thinking；请不要传入 reasoning_effort。',
      '文档提到 thinking 和 reasoning_effort，但没有拒绝 thinking。',
      'The docs mention thinking and reasoning_effort, but no parameter was rejected.',
    ]) {
      assert.equal(internals.hasReasoningProtocolRejectionText(message), false, message);
    }
    assert.equal(internals.hasReasoningProtocolRejectionSignal({
      "x-provider-error": "thinking is unsupported",
      "x-provider-doc": "use reasoning_effort for a different endpoint",
    }), false);
    assert.equal(internals.hasReasoningProtocolRejectionSignal({
      "x-provider-error": "thinking is unsupported; use reasoning_effort instead",
    }), true);
    assert.equal(internals.hasReasoningProtocolRejectionSignal({
      "x-provider-error": "未知请求参数：thinking，请使用 reasoning_effort。",
    }), true);
    assert.equal(internals.hasReasoningProtocolRejectionSignal({
      "x-provider-error": "未知请求参数：thinking",
      "x-provider-doc": "请使用 reasoning_effort",
    }), false);

    const protocolFix = internals.buildReasoningProtocolFixSuggestion(current);
    assert.equal(protocolFix, undefined);
    for (const thinkingFormat of ["qwen", "openrouter", "together"]) {
      assert.equal(
        internals.buildReasoningProtocolFixSuggestion(model({ thinkingFormat }), true),
        undefined,
        thinkingFormat,
      );
    }
    assert.equal(internals.buildReasoningProtocolFixSuggestion(model({ thinkingFormat: "openai" }), true)?.compatKeys.thinkingFormat, undefined);
    assert.equal(internals.isReasoningProtocolRejectionSignalApplicable(current), true);
  });

  test("matches only the exact model identity for finalized assistant evidence", () => {
    const current = model();
    const matching = {
      role: "assistant",
      provider: current.provider,
      model: current.id,
      status: 400,
      stopReason: "error",
      errorMessage: 'Unsupported parameter: thinking; use reasoning_effort instead.',
    };
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage(matching), true);
    assert.equal(internals.isReasoningProtocolRejectionForModel(matching, current), true);
    const chineseMatching = {
      ...matching,
      status: undefined,
      errorMessage: '400: {"code":"UNKNOWN_FIELD","message":"未知请求参数：thinking，请使用 reasoning_effort。"}',
    };
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage(chineseMatching), true);
    assert.equal(internals.isReasoningProtocolRejectionForModel(chineseMatching, current), true);
    assert.equal(
      internals.hasReasoningProtocolRejectionErrorMessage({ ...matching, status: 422 }),
      false,
    );
    assert.equal(
      internals.hasReasoningProtocolRejectionErrorMessage({ ...matching, status: undefined }),
      false,
    );
    assert.equal(internals.isReasoningProtocolRejectionForModel({ ...matching, model: "DeepSeek-V4-Other" }, current), false);
    assert.equal(internals.isReasoningProtocolRejectionForModel({ ...matching, provider: "other" }, current), false);
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage({ ...matching, stopReason: "stop" }), false);
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage({
      ...matching,
      status: undefined,
      errorMessage: "400: Unsupported parameter: thinking. Use reasoning_effort instead.",
    }), true);
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage({
      ...matching,
      status: undefined,
      diagnostics: [{ details: { statusCode: 400 } }],
    }), true);
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage({
      ...matching,
      status: undefined,
      details: { error: { httpStatus: 400 } },
    }), true);
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage({
      ...matching,
      status: undefined,
      diagnostics: [{ details: { statusCode: 422 } }],
    }), false);
    assert.equal(internals.hasReasoningProtocolRejectionErrorMessage({
      ...matching,
      status: undefined,
      errorMessage: "DeepSeek model: 422 Unsupported parameter: thinking. Use reasoning_effort instead.",
    }), false);
    assert.equal(internals.hasReasoningProtocolRejectionText(
      "Unsupported parameter: thinking. reasoning_effort is unsupported.",
    ), false);
  });

  test("correlates response-header evidence with the request model, not a later selection", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-reasoning-correlation-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      const commands = new Map<string, { handler: (args: string, context: any) => Promise<void> }>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) {
          handlers.set(name, handler);
        },
        registerCommand(name: string, command: { handler: (args: string, context: any) => Promise<void> }) {
          commands.set(name, command);
        },
      } as any);

      const makeModel = (provider: string, id: string, name: string) => ({
        provider,
        id,
        name,
        api: "openai-completions",
        baseUrl: `https://${provider}.example/v1`,
        compat: {},
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      });
      const modelA = makeModel("proxy-a", "deepseek-a", "DeepSeek A");
      const modelB = makeModel("proxy-b", "deepseek-b", "DeepSeek B");
      const notifications: string[] = [];
      const baseContext = {
        sessionManager: { getSessionId: () => "reasoning-correlation-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          notify: (message: string) => notifications.push(message),
          setStatus() {},
          confirm: async () => false,
        },
      };
      const requestHook = handlers.get("before_provider_request");
      const responseHook = handlers.get("after_provider_response");
      const messageEndHook = handlers.get("message_end");
      const command = commands.get("cache-optimizer");
      assert.ok(requestHook);
      assert.ok(responseHook);
      assert.ok(messageEndHook);
      assert.ok(command);

      requestHook(
        { payload: {} },
        { ...baseContext, model: modelA },
      );
      await responseHook(
        {
          status: 400,
          headers: { "x-provider-error": "Unsupported parameter: thinking. Use reasoning_effort instead." },
        },
        { ...baseContext, model: modelB },
      );

      assert.ok(notifications.some((message) => message.includes("proxy-a/deepseek-a")));
      assert.equal(notifications.some((message) => message.includes("Unsupported parameter")), false);
      // Complete request A so its response record cannot be mistaken for a
      // later request that fails before after_provider_response.
      await messageEndHook(
        { message: { role: "assistant", stopReason: "error", errorMessage: "400: Unsupported parameter: thinking. Use reasoning_effort instead." } },
        { ...baseContext, model: modelB },
      );

      await command.handler("fix", {
        ...baseContext,
        model: modelA,
        hasUI: false,
        ui: { ...baseContext.ui, notify: (message: string) => notifications.push(message) },
      });
      const modelAFixGuidance = notifications.at(-1) ?? "";
      assert.match(modelAFixGuidance, /thinkingFormat/);

      await command.handler("fix", {
        ...baseContext,
        model: modelB,
        hasUI: false,
        ui: { ...baseContext.ui, notify: (message: string) => notifications.push(message) },
      });
      const modelBFixGuidance = notifications.at(-1) ?? "";
      assert.doesNotMatch(modelBFixGuidance, /thinkingFormat/);

      // A finalized assistant error may arrive without provider/model fields.
      // Keep its request-local identity even when the active model has changed.
      const modelC = makeModel("proxy-c", "deepseek-c", "DeepSeek C");
      const notificationCountBeforeMessage = notifications.length;
      requestHook(
        { payload: {} },
        { ...baseContext, model: modelC },
      );
      await messageEndHook(
        {
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "400: Unsupported parameter: thinking. Use reasoning_effort instead.",
          },
        },
        { ...baseContext, model: modelB },
      );
      const newNotifications = notifications.slice(notificationCountBeforeMessage);
      assert.ok(newNotifications.some((message) => message.includes("proxy-c/deepseek-c")));
      assert.equal(newNotifications.some((message) => message.includes("proxy-b/deepseek-b")), false);

      // A completed response must keep its own identity even if a later request
      // starts before its finalized assistant message is emitted.
      const modelD = makeModel("proxy-d", "deepseek-d", "DeepSeek D");
      const modelE = makeModel("proxy-e", "deepseek-e", "DeepSeek E");
      requestHook({ payload: {} }, { ...baseContext, model: modelD });
      await responseHook(
        { status: 400, headers: { "x-provider-error": "Unsupported parameter: thinking. Use reasoning_effort instead." } },
        { ...baseContext, model: modelD },
      );
      requestHook({ payload: {} }, { ...baseContext, model: modelE });
      const beforeInterleavedMessage = notifications.length;
      await messageEndHook(
        { message: { role: "assistant", stopReason: "error", errorMessage: "400: Unsupported parameter: thinking. Use reasoning_effort instead." } },
        { ...baseContext, model: modelE },
      );
      const interleavedNotifications = notifications.slice(beforeInterleavedMessage);
      assert.equal(interleavedNotifications.some((message) => message.includes("proxy-e/deepseek-e")), false);

      // Complete E explicitly so its request record cannot make the next message ambiguous.
      await messageEndHook(
        {
          message: {
            role: "assistant",
            provider: modelE.provider,
            model: modelE.id,
            api: modelE.api,
            stopReason: "stop",
            usage: { input: 100, cacheRead: 0, cacheWrite: 0 },
          },
        },
        { ...baseContext, model: modelE },
      );

      const keyModel = makeModel("proxy-key", "gpt-key", "GPT Key");
      requestHook({ payload: {} }, { ...baseContext, model: keyModel });
      await messageEndHook(
        {
          message: {
            role: "assistant",
            stopReason: "error",
            status: 400,
            errorMessage: "Unsupported parameter: prompt_cache_key",
          },
        },
        { ...baseContext, model: keyModel },
      );
      await command.handler("fix", {
        ...baseContext,
        model: keyModel,
        hasUI: false,
        ui: { ...baseContext.ui, notify: (message: string) => notifications.push(message) },
      });
      assert.match(notifications.at(-1) ?? "", /prompt(?:[_ ]?cache){1,2}[_ ]?key/i);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("concurrent cross-model responses do not turn ambiguous headers into model-scoped evidence", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-key-response-ambiguity-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), { interopDefault: false, moduleCache: false });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) { handlers.set(name, handler); },
        registerCommand() {},
      } as any);
      const makeModel = (provider: string, id: string) => ({
        provider,
        id,
        name: id,
        api: "openai-completions",
        baseUrl: `https://${provider}.example/v1`,
        compat: {},
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      });
      const modelA = makeModel("proxy-a", "gpt-a");
      const modelB = makeModel("proxy-b", "gpt-b");
      const notifications: string[] = [];
      const context = (model: any) => ({
        model,
        sessionManager: { getSessionId: () => "ambiguity-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: { notify: (message: string) => notifications.push(message), setStatus() {} },
      });
      const requestHook = handlers.get("before_provider_request");
      const responseHook = handlers.get("after_provider_response");
      const messageEndHook = handlers.get("message_end");
      assert.ok(requestHook && responseHook && messageEndHook);

      requestHook({ payload: {} }, context(modelA));
      requestHook({ payload: {} }, context(modelB));
      await responseHook(
        { status: 400, headers: { "x-error": "Unsupported parameter: prompt_cache_key" } },
        context(modelB),
      );
      assert.equal(notifications.some((message) => message.includes("拒绝了 prompt_cache_key")), false);

      await messageEndHook({
        message: {
          role: "assistant",
          provider: modelB.provider,
          model: modelB.id,
          api: modelB.api,
          stopReason: "error",
          status: 400,
          errorMessage: "Unsupported parameter: prompt_cache_key",
        },
      }, context(modelA));
      assert.equal(notifications.some((message) => message.includes("proxy-a/gpt-a 拒绝了 prompt_cache_key")), false);
      assert.equal(notifications.some((message) => message.includes("proxy-b/gpt-b 拒绝了 prompt_cache_key")), true);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("runtime disable retains request-local identity for always-on Anthropic TTL repair", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-ttl-disabled-correlation-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), { interopDefault: false, moduleCache: false });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) { handlers.set(name, handler); },
        registerCommand() {},
      } as any);
      const makeModel = (provider: string, id: string) => ({
        provider,
        id,
        name: id,
        api: "anthropic-messages",
        baseUrl: `https://${provider}.example`,
        compat: {},
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      });
      const requestModel = makeModel("anthropic-proxy-a", "claude-a");
      const activeModel = makeModel("anthropic-proxy-b", "claude-b");
      const notifications: string[] = [];
      const context = (model: any) => ({
        model,
        sessionManager: { getSessionId: () => "ttl-disabled-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: { notify: (message: string) => notifications.push(message), setStatus() {} },
      });
      freshModule.__internals_for_tests.setRuntimeOptimizerEnabled(false);
      handlers.get("before_provider_request")?.({ payload: {} }, context(requestModel));
      await handlers.get("message_end")?.({
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "cache_control ttl='1h' must not come after ttl='5m'",
        },
      }, context(activeModel));
      assert.equal(notifications.some((message) => message.includes("anthropic-proxy-a/claude-a")), true);
      assert.equal(notifications.some((message) => message.includes("anthropic-proxy-b/claude-b")), false);
      freshModule.__internals_for_tests.setRuntimeOptimizerEnabled(true);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("ordinary fix does not configure prompt_cache_key without evidence", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-key-no-evidence-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), { interopDefault: false, moduleCache: false });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const commands = new Map<string, { handler: (args: string, context: any) => Promise<void> }>();
      freshModule.default({ on() {}, registerCommand(name: string, command: any) { commands.set(name, command); } } as any);
      const notifications: string[] = [];
      let confirmations = 0;
      await commands.get("cache-optimizer")?.handler("fix", {
        model,
        hasUI: true,
        sessionManager: { getSessionId: () => "no-evidence-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          confirm: async () => { confirmations++; return true; },
          notify: (message: string) => notifications.push(message),
          setStatus() {},
        },
      });
      assert.equal(confirmations, 0);
      assert.equal(notifications.some((message) => /prompt.?cache.?key/i.test(message)), false);
      assert.equal((await readdir(tempAgentDir)).some((name) => name.includes("config")), false);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("evidence-driven command fix prints a model-level models.yml snippet and writes nothing", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "omp-cache-runtime-compat-fix-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      const commands = new Map<string, { handler: (args: string, context: any) => Promise<void> }>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) {
          handlers.set(name, handler);
        },
        registerCommand(name: string, command: { handler: (args: string, context: any) => Promise<void> }) {
          commands.set(name, command);
        },
      } as any);
      const modelWithExplicitReplay = {
        provider: "runtime-shadow-proxy",
        id: "deepseek-runtime-shadow",
        name: "DeepSeek Runtime Shadow",
        api: "openai-completions",
        baseUrl: "https://proxy.example/v1",
        compatConfig: { requiresReasoningContentForToolCalls: true },
        compat: { requiresReasoningContentForToolCalls: true, supportsReasoningEffort: false },
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      } as any;
      const notifications: string[] = [];
      let confirmations = 0;
      const context = {
        model: modelWithExplicitReplay,
        hasUI: true,
        sessionManager: { getSessionId: () => "runtime-shadow-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          confirm: async () => { confirmations++; return true; },
          notify: (message: string) => notifications.push(message),
          setStatus() {},
        },
      };
      handlers.get("before_provider_request")?.({ payload: {} }, context);
      await handlers.get("after_provider_response")?.({
        status: 400,
        headers: { "x-provider-error": "thinking is unsupported; use reasoning_effort instead" },
      }, context);
      await commands.get("cache-optimizer")?.handler("fix", context);

      const guidance = notifications.at(-1) ?? "";
      assert.match(guidance, /手动修复建议/);
      assert.match(guidance, /modelOverrides:/);
      assert.match(guidance, /deepseek-runtime-shadow:/);
      assert.match(guidance, /thinkingFormat: openai/);
      assert.match(guidance, /supportsReasoningEffort: true/);
      // The user's explicit replay opt-in is turned off only for this model.
      assert.match(guidance, /requiresReasoningContentForToolCalls: false/);
      assert.match(guidance, /本扩展不会自动改写 models\.yml/);
      assert.equal(confirmations, 0);
      assert.deepEqual(await readdir(tempAgentDir), []);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });
});

describe("/cache-optimizer fix command", () => {
  test("rejects real target swaps at the final atomic rename boundary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-final-rename-race-test-"));
    const targetPath = join(tempDir, "models.json");
    const backupPath = join(tempDir, "models.json.backup-cache-optimizer-race");
    const original = '{"providers":{"a":{}}}\n';
    const replacement = '{"providers":{"b":{}}}\n';
    const external = '{"providers":{"external":{}}}\n';
    try {
      await writeFile(targetPath, original, { encoding: "utf8", mode: 0o600 });
      await writeFile(backupPath, original, { encoding: "utf8", mode: 0o600 });
      // Windows does not honor POSIX modes; guard with the mode the file actually has.
      const fileMode = (await stat(targetPath)).mode & 0o7777;
      await assert.rejects(
        internals.atomicReplaceTextFilePreservingMode(
          targetPath,
          replacement,
          fileMode,
          "fix-race-test",
          { hash: internals.hashText(original), mode: fileMode },
          async () => {
            await writeFile(targetPath, external, { encoding: "utf8", mode: 0o600 });
          },
        ),
        /target content changed during atomic replacement/,
      );
      assert.equal(await readFile(targetPath, "utf8"), external);

      await writeFile(targetPath, replacement, { encoding: "utf8", mode: 0o600 });
      await assert.rejects(
        internals.atomicRestoreFileFromBackup(
          backupPath,
          targetPath,
          fileMode,
          { hash: internals.hashText(replacement), mode: fileMode, backupHash: internals.hashText(original) },
          async () => {
            await writeFile(targetPath, external, { encoding: "utf8", mode: 0o600 });
          },
        ),
        /target content changed during atomic replacement/,
      );
      assert.equal(await readFile(targetPath, "utf8"), external);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("direct and menu paths print a models.yml snippet without writing any file", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "omp-cache-fix-command-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), {
        interopDefault: false,
        moduleCache: false,
      });
      const freshModule = await jiti.import<typeof import("../index.ts")>(
        join(process.cwd(), "index.ts"),
      );
      const commands = new Map<string, { handler: (args: string, context: any) => unknown }>();
      freshModule.default({
        on() {},
        registerCommand(name: string, command: { handler: (args: string, context: any) => unknown }) {
          commands.set(name, command);
        },
      } as any);

      const command = commands.get("cache-optimizer");
      assert.ok(command);
      const confirmations: Array<{ title: string; message: string }> = [];
      const notifications: Array<{ message: string; level: string }> = [];
      const menuPrompts: Array<{ title: string; options: string[] }> = [];
      let menuPrefix = "";
      const model = {
        provider: "proxy",
        id: "deepseek-v4",
        name: "DeepSeek V4",
        api: "openai-completions",
        baseUrl: "https://proxy.example/v1",
        compat: {},
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      };
      const commandContext = {
        model,
        hasUI: true,
        sessionManager: { getSessionId: () => "fix-command-test-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          confirm: async (title: string, message: string) => {
            confirmations.push({ title, message });
            return true;
          },
          notify: (message: string, level: string) => notifications.push({ message, level }),
          setStatus() {},
          select: async (title: string, options: string[]) => {
            menuPrompts.push({ title, options });
            return options.find((option) => option.startsWith(menuPrefix));
          },
        },
      };

      const assertSnippet = (message: string) => {
        assert.match(message, /手动修复建议/);
        assert.match(message, /提供方：proxy/);
        assert.match(message, /模型：deepseek-v4/);
        // Not an observed runtime problem, so both placements are offered.
        assert.match(message, /Provider 级覆盖/);
        assert.match(message, /模型级覆盖/);
        assert.match(message, /modelOverrides:/);
        assert.match(message, /requiresReasoningContentForToolCalls: true/);
        assert.match(message, /本扩展不会自动改写 models\.yml/);
      };

      await command.handler("fix", commandContext);
      assert.equal(menuPrompts.length, 0);
      assertSnippet(notifications.at(-1)?.message ?? "");

      notifications.length = 0;
      menuPrefix = "修复";
      await command.handler("", commandContext);
      assert.equal(menuPrompts.length, 1);
      assert.equal(menuPrompts[0].title, "缓存优化器");
      assert.ok(menuPrompts[0].options.some((option) => option.startsWith("修复")));
      assert.ok(menuPrompts[0].options.some((option) => option.startsWith("回滚")));
      assertSnippet(notifications.at(-1)?.message ?? "");

      // Neither path asks for confirmation or touches the agent directory.
      assert.equal(confirmations.length, 0);
      assert.deepEqual(await readdir(tempAgentDir), []);

      // Without UI the help text still lists rollback and its UI requirement.
      const helpMessages: string[] = [];
      await command.handler("", {
        ...commandContext,
        hasUI: false,
        ui: { ...commandContext.ui, notify: (message: string) => helpMessages.push(message) },
      });
      assert.match(helpMessages.at(-1) ?? "", /rollback.*需要 UI 确认/);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("backup names remain unique within the same millisecond", () => {
    const now = new Date("2026-08-17T12:34:56.789Z");
    const first = internals.backupTimestamp(now);
    const second = internals.backupTimestamp(now);
    assert.notEqual(first, second);
  });
});

describe("prompt_cache_key model opt-out", () => {
  const model = {
    provider: "proxy",
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-completions",
    baseUrl: "https://proxy.example/v1",
    compat: {},
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  } as any;

  test("Chinese 400 rejection records exact-model evidence and applies omit only after confirmation", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-key-chinese-evidence-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;
    const configPath = join(tempAgentDir, "omp-cache-optimizer-config.json");
    const originalConfig = JSON.stringify({ version: 2, footerMode: "session" }, null, 2) + "\n";
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(configPath, originalConfig, "utf8");
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), { interopDefault: false, moduleCache: false });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      const commands = new Map<string, { handler: (args: string, context: any) => unknown }>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) { handlers.set(name, handler); },
        registerCommand(name: string, command: { handler: (args: string, context: any) => unknown }) { commands.set(name, command); },
      } as any);
      const targetModel = {
        provider: "jiyuanlvdong",
        id: "glm-5.3-flash",
        name: "GLM 5.3 Flash",
        api: "openai-completions",
        baseUrl: "https://tokenrhythm.studio/v1",
        compat: {},
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 32_768,
      };
      const notifications: string[] = [];
      const confirmationMessages: string[] = [];
      let confirm = false;
      const context = {
        model: targetModel,
        hasUI: true,
        sessionManager: { getSessionId: () => "chinese-rejection-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          confirm: async (_title: string, message: string) => { confirmationMessages.push(message); return confirm; },
          notify: (message: string) => notifications.push(message),
          setStatus() {},
        },
      };
      const requestHook = handlers.get("before_provider_request");
      const messageEndHook = handlers.get("message_end");
      const fixCommand = commands.get("cache-optimizer");
      assert.ok(requestHook && messageEndHook && fixCommand);

      await fixCommand.handler("fix", context);
      assert.equal(confirmationMessages.some((message) => /prompt.?cache.?key|omit/i.test(message)), false);
      assert.equal(await readFile(configPath, "utf8"), originalConfig);
      confirmationMessages.length = 0;

      requestHook({ payload: {} }, context);
      await messageEndHook({
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: '400: {"code":"UNKNOWN_FIELD","message":"未知请求字段：prompt_cache_key","data":{"field":"prompt_cache_key"},"traceId":"trace_130aafe7-2e7b-4220-b137-27bf2b98ce22"}',
        },
      }, context);
      assert.equal(notifications.some((message) => message.includes("jiyuanlvdong/glm-5.3-flash 拒绝了 prompt_cache_key")), true);
      assert.equal(notifications.some((message) => message.includes("trace_130aafe7")), false);

      await fixCommand.handler("fix", { ...context, model: { ...targetModel, id: "glm-other" } });
      assert.equal(confirmationMessages.some((message) => /prompt.?cache.?key|omit/i.test(message)), false);
      confirmationMessages.length = 0;

      await fixCommand.handler("fix", context);
      assert.match(confirmationMessages.at(-1) ?? "", /jiyuanlvdong\/glm-5\.3-flash/);
      assert.match(confirmationMessages.at(-1) ?? "", /prompt.?cache.?key|omit/i);
      assert.deepEqual(freshModule.__internals_for_tests.readPersistedCacheOptimizerConfig(), { version: 2, footerMode: "session" });
      assert.equal(await readFile(configPath, "utf8"), originalConfig);

      confirm = true;
      await fixCommand.handler("fix", context);
      assert.deepEqual(freshModule.__internals_for_tests.readPersistedCacheOptimizerConfig(), {
        version: 2,
        footerMode: "session",
        promptCacheKey: { omit: ["jiyuanlvdong/glm-5.3-flash"] },
      });
      const payload = { prompt_cache_key: "pi-generated", promptCacheKey: "caller", keep: true };
      assert.deepEqual(requestHook({ payload }, context), { keep: true });
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });

  test("parses v1 and v2 config without accepting malformed or private data", () => {
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "Unsupported parameter: prompt_cache_key" }), true);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "Unknown field promptCacheKey" }), true);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "prompt_cache_key is not supported" }), true);
    const observedChineseError = '400: {"code":"UNKNOWN_FIELD","message":"未知请求字段：prompt_cache_key","data":{"field":"prompt_cache_key"},"traceId":"trace_130aafe7-2e7b-4220-b137-27bf2b98ce22"}';
    assert.equal(internals.hasPromptCacheKeyUnsupportedText(observedChineseError), true);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": observedChineseError }), true);
    assert.equal(internals.hasPromptCacheKeyUnsupportedErrorMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: observedChineseError,
    }), true);
    for (const message of [
      "未识别请求参数: promptCacheKey",
      "不支持字段：prompt_cache_key",
      "不允许请求参数：prompt_cache_key",
    ]) assert.equal(internals.hasPromptCacheKeyUnsupportedText(message), true, message);
    for (const message of [
      "流式模式下不允许请求字段：prompt_cache_key",
      "当 stream=true 时，不允许请求字段：prompt_cache_key",
      "当 temperature=0.5 时，不允许请求字段：prompt_cache_key",
      "不允许请求字段：prompt_cache_key，仅在流式模式下",
      "并非不支持字段：prompt_cache_key",
    ]) assert.equal(internals.hasPromptCacheKeyUnsupportedText(message), false, message);
    assert.equal(internals.hasPromptCacheKeyUnsupportedText("不支持参数值：prompt_cache_key"), false);
    assert.equal(internals.hasPromptCacheKeyUnsupportedText("温度非零时不允许 prompt_cache_key"), false);
    assert.equal(internals.hasPromptCacheKeyUnsupportedText("未知请求字段：temperature，prompt_cache_key"), false);
    assert.equal(internals.hasPromptCacheKeyUnsupportedText(JSON.stringify({
      code: "UNKNOWN_FIELD",
      message: "未知请求字段：temperature",
      data: { field: "prompt_cache_key" },
    })), false);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "Invalid parameter value for prompt_cache_key" }), false);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "Unsupported parameter value for prompt_cache_key" }), false);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "The prompt_cache_key value is not supported" }), false);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "prompt_cache_key must be omitted when temperature is set" }), false);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "prompt_cache_key is not allowed when temperature is set" }), false);
    assert.equal(internals.hasPromptCacheKeyUnsupportedSignal({ "x-error": "promptCacheKey is not permitted with stream=true" }), false);
    assert.deepEqual(internals.parsePersistedCacheOptimizerConfig({ version: 1, footerMode: "total" }), { version: 1, footerMode: "total" });
    assert.deepEqual(
      internals.parsePersistedCacheOptimizerConfig({ version: 2, footerMode: "session", promptCacheKey: { omit: ["z/model", "a/model", "a/model"] } }),
      { version: 2, footerMode: "session", promptCacheKey: { omit: ["a/model", "z/model"] } },
    );
    assert.equal(internals.parsePersistedCacheOptimizerConfig({ version: 2, promptCacheKey: { omit: ["proxy/model", 4] } }), undefined);
    assert.equal(internals.parsePersistedCacheOptimizerConfig({ version: 2, promptCacheKey: { omit: ["proxy/model"], prompt: "secret" } }), undefined);
  });

  test("omits both key spellings only for the exact configured model", () => {
    internals.setRuntimeOptimizerEnabled(true);
    const config = { version: 2 as const, footerMode: "total" as const, promptCacheKey: { omit: ["proxy/gpt-5.5"] } };
    assert.equal(internals.isPromptCacheKeyOmittedForModel(model, config), true);
    assert.equal(internals.isPromptCacheKeyOmittedForModel({ ...model, id: "gpt-5.6" }, config), false);
    assert.equal(internals.isPromptCacheKeyOmittedForModel({ ...model, provider: "other" }, config), false);
    assert.deepEqual(
      internals.omitOpenAIPromptCacheKeys({ prompt_cache_key: "pi", promptCacheKey: "caller", keep: 1 }),
      { keep: 1 },
    );
    assert.equal(internals.omitOpenAIPromptCacheKeys({ keep: 1 }), undefined);
  });

  test("migrates v1 footer config, applies exact omit, and rolls it back", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-key-config-test-"));
    const configPath = join(tempDir, "omp-cache-optimizer-config.json");
    const receiptPath = join(tempDir, "omp-cache-optimizer-config-receipt.json");
    const original = JSON.stringify({ version: 1, footerMode: "total" }, null, 2) + "\n";
    try {
      await writeFile(configPath, original, { encoding: "utf8", mode: 0o640 });
      // Windows ignores POSIX modes; compare against the mode the file actually has.
      const configMode = (await stat(configPath)).mode & 0o7777;
      const applied = await internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath);
      const parsed = internals.readPersistedCacheOptimizerConfig(configPath);
      assert.deepEqual(parsed, { version: 2, footerMode: "total", promptCacheKey: { omit: ["proxy/gpt-5.5"] } });
      assert.equal((await stat(configPath)).mode & 0o7777, configMode);
      assert.equal(await readFile(applied.backupPath, "utf8"), original);
      assert.equal((await stat(applied.backupPath)).mode & 0o7777, configMode);
      const receiptSnapshot = await internals.readPromptCacheKeyConfigReceiptSnapshot(receiptPath);
      assert.ok(receiptSnapshot);
      const receipt = receiptSnapshot.receipt;
      assert.equal(receipt.addedModelKey, "proxy/gpt-5.5");
      assert.equal(receipt.targetHadModelKey, false);
      assert.equal(JSON.stringify(receipt).includes("prompt_cache_key"), false);
      await internals.rollbackPromptCacheKeyConfig(receiptSnapshot, configPath, receiptPath);
      assert.equal(await readFile(configPath, "utf8"), original);
      assert.deepEqual(internals.readPersistedCacheOptimizerConfig(configPath), { version: 2, footerMode: "total" });
      assert.equal((await internals.readPromptCacheKeyConfigReceipt(receiptPath))?.status, "rolled_back");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fix and rollback keep v3 feature settings intact", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-key-config-v3-test-"));
    const configPath = join(tempDir, "omp-cache-optimizer-config.json");
    const receiptPath = join(tempDir, "omp-cache-optimizer-config-receipt.json");
    const original = JSON.stringify({ version: 3, footerMode: "total", features: { promptRewrite: false, toolOrder: true } }, null, 2) + "\n";
    try {
      await writeFile(configPath, original, { encoding: "utf8", mode: 0o600 });
      await internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath);
      // The fixed file must still parse: every persisted setting survives next to the new opt-out.
      assert.deepEqual(internals.readPersistedCacheOptimizerConfig(configPath), {
        version: 3,
        footerMode: "total",
        promptCacheKey: { omit: ["proxy/gpt-5.5"] },
        features: { promptRewrite: false, toolOrder: true },
      });
      const snapshot = await internals.readPromptCacheKeyConfigReceiptSnapshot(receiptPath);
      assert.ok(snapshot);
      await internals.rollbackPromptCacheKeyConfig(snapshot, configPath, receiptPath);
      assert.equal(await readFile(configPath, "utf8"), original);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("feature toggles refuse to overwrite an unreadable config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-feature-config-test-"));
    const configPath = join(tempDir, "omp-cache-optimizer-config.json");
    const unreadable = "{\"version\": 9, \"footerMode\": \"total\", \"promptCacheKey\": {\"omit\": [\"proxy/gpt-5.5\"]}}\n";
    try {
      await writeFile(configPath, unreadable, "utf8");
      await assert.rejects(internals.writePersistedFeature("toolOrder", true, configPath), /invalid|refus/i);
      assert.equal(await readFile(configPath, "utf8"), unreadable, "user config left untouched");
      await writeFile(configPath, "{ not json", "utf8");
      await assert.rejects(internals.writePersistedFeature("toolOrder", true, configPath), /invalid|refus/i);
      assert.equal(await readFile(configPath, "utf8"), "{ not json");
      // A valid config is updated in place, keeping unrelated settings.
      await writeFile(configPath, JSON.stringify({ version: 2, footerMode: "total", promptCacheKey: { omit: ["proxy/gpt-5.5"] } }), "utf8");
      await internals.writePersistedFeature("toolOrder", true, configPath);
      assert.deepEqual(internals.readPersistedCacheOptimizerConfig(configPath), {
        version: 3, footerMode: "total", promptCacheKey: { omit: ["proxy/gpt-5.5"] }, features: { toolOrder: true },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fix receipt failure restores both existing and absent config targets", async () => {
    for (const targetExists of [true, false]) {
      const tempDir = await mkdtemp(join(tmpdir(), `pi-cache-key-config-fix-receipt-failure-${targetExists}-`));
      const configPath = join(tempDir, "omp-cache-optimizer-config.json");
      const receiptPath = join(tempDir, "omp-cache-optimizer-config-receipt.json");
      const original = JSON.stringify({ version: 1, footerMode: "total" }, null, 2) + "\n";
      try {
        if (targetExists) await writeFile(configPath, original, { encoding: "utf8", mode: 0o640 });
        // Windows ignores POSIX modes; compare against the mode the file actually has.
        const configMode = targetExists ? (await stat(configPath)).mode & 0o7777 : 0;
        await mkdir(receiptPath);
        await assert.rejects(
          internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath),
          /invalid prompt-cache-key receipt path/,
        );
        if (targetExists) {
          assert.equal(await readFile(configPath, "utf8"), original);
          assert.equal((await stat(configPath)).mode & 0o7777, configMode);
        } else {
          await assert.rejects(readFile(configPath, "utf8"), (error: any) => error?.code === "ENOENT");
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  test("receipt replacement after preview aborts config rollback and restores the post-fix config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-key-config-receipt-race-test-"));
    const configPath = join(tempDir, "omp-cache-optimizer-config.json");
    const receiptPath = join(tempDir, "omp-cache-optimizer-config-receipt.json");
    const original = JSON.stringify({ version: 1, footerMode: "total" }, null, 2) + "\n";
    try {
      await writeFile(configPath, original, { encoding: "utf8", mode: 0o640 });
      await internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath);
      const fixed = await readFile(configPath, "utf8");
      const snapshot = await internals.readPromptCacheKeyConfigReceiptSnapshot(receiptPath);
      assert.ok(snapshot);
      const replacement = { ...snapshot.receipt, transactionId: "replacement-transaction" };

      await assert.rejects(
        internals.rollbackPromptCacheKeyConfig(snapshot, configPath, receiptPath, {
          beforeReceiptRename: async () => {
            await writeFile(receiptPath, JSON.stringify(replacement, null, 2) + "\n", "utf8");
          },
        }),
        /prompt-cache-key receipt changed/,
      );
      assert.equal(await readFile(configPath, "utf8"), fixed);
      assert.equal((await internals.readPromptCacheKeyConfigReceipt(receiptPath))?.transactionId, "replacement-transaction");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("atomic config creation never overwrites a file that appears at the final boundary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-key-config-create-race-test-"));
    const configPath = join(tempDir, "omp-cache-optimizer-config.json");
    try {
      await assert.rejects(
        internals.atomicCreateTextFileNoReplace(
          configPath,
          "extension-content\n",
          0o600,
          "config-test",
          async () => writeFile(configPath, "user-content\n", "utf8"),
        ),
        (error: any) => error?.code === "EEXIST",
      );
      assert.equal(await readFile(configPath, "utf8"), "user-content\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("receipt update failure recreates a newly-created post-fix config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-key-new-config-receipt-failure-test-"));
    const configPath = join(tempDir, "omp-cache-optimizer-config.json");
    const receiptPath = join(tempDir, "omp-cache-optimizer-config-receipt.json");
    try {
      await internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath);
      const fixed = await readFile(configPath, "utf8");
      const snapshot = await internals.readPromptCacheKeyConfigReceiptSnapshot(receiptPath);
      assert.ok(snapshot);
      const replacement = { ...snapshot.receipt, transactionId: "replacement-new-config" };

      await assert.rejects(
        internals.rollbackPromptCacheKeyConfig(snapshot, configPath, receiptPath, {
          beforeReceiptRename: async () => {
            await writeFile(receiptPath, JSON.stringify(replacement, null, 2) + "\n", "utf8");
          },
        }),
        /prompt-cache-key receipt changed/,
      );
      assert.equal(await readFile(configPath, "utf8"), fixed);
      assert.equal((await internals.readPromptCacheKeyConfigReceipt(receiptPath))?.transactionId, "replacement-new-config");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("direct repeated fixes reject without changing config or receipt", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-key-repeat-config-test-"));
    const configPath = join(tempDir, "omp-cache-optimizer-config.json");
    const receiptPath = join(tempDir, "omp-cache-optimizer-config-receipt.json");
    try {
      await internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath);
      const configBefore = await readFile(configPath, "utf8");
      const receiptBefore = await readFile(receiptPath, "utf8");
      await assert.rejects(
        internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath),
        /already configured; no changes were made/,
      );
      assert.equal(await readFile(configPath, "utf8"), configBefore);
      assert.equal(await readFile(receiptPath, "utf8"), receiptBefore);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("multiple model fixes preserve earlier opt-outs and rollback only the latest change", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-cache-key-multi-config-test-"));
    const configPath = join(tempDir, "omp-cache-optimizer-config.json");
    const receiptPath = join(tempDir, "omp-cache-optimizer-config-receipt.json");
    const otherModel = { ...model, id: "gpt-5.6", name: "GPT-5.6" };
    try {
      await writeFile(configPath, JSON.stringify({ version: 2, footerMode: "process", promptCacheKey: { omit: ["proxy/existing"] } }, null, 2) + "\n", { mode: 0o640 });
      await internals.applyPromptCacheKeyConfigFix(model, configPath, receiptPath);
      await internals.applyPromptCacheKeyConfigFix(otherModel, configPath, receiptPath);
      assert.deepEqual(internals.readPersistedCacheOptimizerConfig(configPath).promptCacheKey?.omit, ["proxy/existing", "proxy/gpt-5.5", "proxy/gpt-5.6"]);
      const receiptSnapshot = await internals.readPromptCacheKeyConfigReceiptSnapshot(receiptPath);
      assert.ok(receiptSnapshot);
      await internals.rollbackPromptCacheKeyConfig(receiptSnapshot, configPath, receiptPath);
      assert.deepEqual(internals.readPersistedCacheOptimizerConfig(configPath), {
        version: 2,
        footerMode: "process",
        promptCacheKey: { omit: ["proxy/existing", "proxy/gpt-5.5"] },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("active fix requires confirmation and removes an OMP-provided key after reload", async () => {
    const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-cache-key-command-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousRetention = process.env.PI_CACHE_RETENTION;
    try {
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      await writeFile(join(tempAgentDir, "omp-cache-optimizer-config.json"), JSON.stringify({ version: 1, footerMode: "process" }) + "\n");
      const jiti = createJiti(join(process.cwd(), "tests", "review-findings.test.ts"), { interopDefault: false, moduleCache: false });
      const freshModule = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
      const handlers = new Map<string, (event: any, context: any) => unknown>();
      const commands = new Map<string, { handler: (args: string, context: any) => unknown }>();
      freshModule.default({
        on(name: string, handler: (event: any, context: any) => unknown) { handlers.set(name, handler); },
        registerCommand(name: string, command: { handler: (args: string, context: any) => unknown }) { commands.set(name, command); },
      } as any);
      const notifications: string[] = [];
      let confirm = false;
      const confirmationMessages: string[] = [];
      const context = {
        model,
        hasUI: true,
        sessionManager: { getSessionId: () => "fixture-session" },
        modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
        ui: {
          confirm: async (_title: string, message: string) => { confirmationMessages.push(message); return confirm; },
          notify: (message: string) => notifications.push(message),
          setStatus() {},
        },
      };
      await commands.get("cache-optimizer")?.handler("fix prompt-cache-key", context);
      assert.match(confirmationMessages.at(-1) ?? "", /prompt_cache_key.*promptCacheKey/s);
      assert.deepEqual(freshModule.__internals_for_tests.readPersistedCacheOptimizerConfig(), { version: 2, footerMode: "process" });
      confirm = true;
      await commands.get("cache-optimizer")?.handler("fix prompt-cache-key", context);
      assert.deepEqual(freshModule.__internals_for_tests.readPersistedCacheOptimizerConfig(), { version: 2, footerMode: "process", promptCacheKey: { omit: ["proxy/gpt-5.5"] } });
      const payload = { prompt_cache_key: "pi-generated", promptCacheKey: "caller", keep: true };
      const result = handlers.get("before_provider_request")?.({ payload }, context) as any;
      assert.deepEqual(result, { keep: true });
      await commands.get("cache-optimizer")?.handler("fix prompt-cache-key", context);
      assert.match(notifications.at(-1) ?? "", /已经关闭 prompt_cache_key/);
      await commands.get("cache-optimizer")?.handler("rollback", context);
      assert.deepEqual(freshModule.__internals_for_tests.readPersistedCacheOptimizerConfig(), { version: 2, footerMode: "process" });
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await rm(tempAgentDir, { recursive: true, force: true });
    }
  });
});
