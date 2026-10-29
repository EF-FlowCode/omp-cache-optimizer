import { type ExtensionCommandContext, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { selectAdapterForModel } from "./adapters.ts";
import { FEATURE_COMMAND_MAP } from "./command-completion.ts";
import { type PiModel } from "./common.ts";
import { buildModelCompatOverride, buildProviderCompatOverride, describeMissingCacheCompatForModel, formatYamlSnippet, getModelsYmlDisplayPath, isAdaptiveThinkingCompatApplicable } from "./compat-advice.ts";
import { isZeroPriceWarmingEnabled, FOOTER_MODE_ENV, type FooterStatsMode, formatOptimizerRuntimeMode, formatPersistentFeatureConfig, persistedFooterStatsMode, readPersistedCacheOptimizerConfig, resetPersistedFeatures, resolveFooterStatsMode, setPersistedCacheOptimizerConfig, setRuntimeOptimizerEnabled, writePersistedFeature, writePersistedFooterMode } from "./config.ts";
import { buildCompatDiagnosis, buildDoctorDiagnosis, buildLowHitDiagnosis, getCompatCheckNotApplicableLines, isCompatCheckApplicable, isDeepSeekCompatCheckApplicable, isPromptCacheKeyUnsupportedApplicable } from "./diagnostics.ts";
import { getCompat, modelKey } from "./model-identity.ts";
import { applyPromptCacheKeyConfigFix, isActionablePromptCacheKeyConfigReceipt, readPromptCacheKeyConfigReceiptSnapshot, rollbackPromptCacheKeyConfig } from "./prompt-cache-key-config.ts";
import { describePromptRewriteOutcome } from "./prompt-rewrite.ts";
import { isPromptCacheKeyOmittedForModel } from "./request-payload.ts";
import { resolveRouteModel } from "./routing.ts";
import { type CacheUsageSample, type PromptDiagnosticSample, buildAllStatsOutput, buildContributorsStatsOutput, buildSessionStatsOutput, formatRecentPromptDiagnostics, formatRecentTrendSummary } from "./stats-report.ts";
import { type FixSuggestion } from "./fix-types.ts";
import { type ProviderRequestState } from "./request-state.ts";
import { type CacheStats, type ShardAggregate } from "./stats-store.ts";
import { describePromptCacheRetentionDecision, getLastPromptCacheRetentionDecision, LONG_CACHE_RETENTION_VALUE, readCacheRetentionValue } from "./retention.ts";
import { buildCacheWarmingDiagnosis, type CacheWarmingMode } from "./cache-warming.ts";

/**
 * Everything the command needs from the extension instance. The extension keeps this state in closures
 * (it is shared with the event hooks), so values that are reassigned there are exposed through getters.
 */
export type CommandRuntime = {
  syncSessionHash(ctx: Pick<ExtensionContext, "sessionManager">): void;
  resetCurrentSessionStats(): Promise<void>;
  resetStatsForModel(model: PiModel): Promise<void>;
  flushPersistCacheStats(ctx?: ExtensionContext, lifecycleState?: "active" | "closed"): Promise<void>;
  publishStatus(ctx: ExtensionContext, model?: PiModel): Promise<void>;
  refreshShardAggregate(): Promise<ShardAggregate>;
  sessionModelKey(model: { provider: string; id: string }): string;
  getRecentSamples(modelKeyStr: string): CacheUsageSample[];
  getRecentPromptDiagnostics(modelKeyStr: string): PromptDiagnosticSample[];
  promptCacheKeyFixApplies(model: PiModel): boolean;
  buildCommandFixSuggestion(model: PiModel): FixSuggestion | undefined;
  buildPromptCacheKeyConfigPreview(model: PiModel): string[];
  providerRequestStates: ProviderRequestState[];
  promptCacheRetention400Models: Set<string>;
  promptCacheKeyRejectedModels: Set<string>;
  anthropicTtlOrderErrorModels: Set<string>;
  openAISdkHeader403Models: Set<string>;
  getCacheStatsTotalsByModel(): Record<string, CacheStats>;
  getCurrentSessionHashSet(): boolean;
  getCurrentSessionHash(): string;
  getLastStatusText(): string | undefined;
  clearLastStatusText(): void;
  /** OMP `providers.cacheWarming` mode. */
  getCacheWarmingMode?(): CacheWarmingMode | "unsupported";
};

const NO_ACTIVE_MODEL_TEXT = "当前没有活动模型。请先用 /model 或 omp --model 选择模型。";

/** OMP 写长缓存的档位：Anthropic 只有 compat.supportsLongCacheRetention 时才是真 1h 条目。 */
function warmingTierForModel(model: PiModel): "short" | "long" {
  if (readCacheRetentionValue(process.env) !== LONG_CACHE_RETENTION_VALUE) return "short";
  if (model.api === "anthropic-messages") return getCompat(model).supportsLongCacheRetention === true ? "long" : "short";
  return "long";
}

/** models.yml 手动修复片段：观测到的运行时问题按模型生效，其余同时给 provider 级与模型级两种放法。 */
export function buildManualFixLines(suggestion: FixSuggestion): string[] {
  const lines = [
    `📝 ${getModelsYmlDisplayPath()} 的手动修复建议：`,
    "",
    `提供方：${suggestion.providerLabel}`,
    `模型：${suggestion.modelId}`,
    "",
  ];
  if (suggestion.forceModelLevel) {
    lines.push("只对当前模型生效（模型级覆盖）：");
    lines.push(formatYamlSnippet(buildModelCompatOverride(suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys)));
  } else {
    lines.push("Provider 级覆盖（影响该 provider 下所有模型）：");
    lines.push(formatYamlSnippet(buildProviderCompatOverride(suggestion.providerLabel, suggestion.compatKeys)));
    lines.push("");
    lines.push("或只对当前模型生效（模型级覆盖）：");
    lines.push(formatYamlSnippet(buildModelCompatOverride(suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys)));
  }
  lines.push("");
  lines.push("合并到已有的 providers 配置里（不要复制 credential、token 或 API key），保存后运行 /reload。");
  lines.push("OMP 会对未知 compat 键给出警告，可借此确认键名拼写。本扩展不会自动改写 models.yml。");
  return lines;
}

export function createCacheOptimizerCommandHandler(runtime: CommandRuntime) {
  const {
    anthropicTtlOrderErrorModels,
    buildCommandFixSuggestion,
    buildPromptCacheKeyConfigPreview,
    flushPersistCacheStats,
    getRecentPromptDiagnostics,
    getRecentSamples,
    openAISdkHeader403Models,
    promptCacheKeyFixApplies,
    promptCacheKeyRejectedModels,
    promptCacheRetention400Models,
    providerRequestStates,
    publishStatus,
    refreshShardAggregate,
    resetCurrentSessionStats,
    resetStatsForModel,
    sessionModelKey,
    syncSessionHash,
  } = runtime;
  const { getCacheStatsTotalsByModel, getCurrentSessionHashSet, getCurrentSessionHash, clearLastStatusText } = runtime;

  return async function handleCacheOptimizerCommand(
    args: string,
    cmdCtx: ExtensionCommandContext,
  ): Promise<void> {
    syncSessionHash(cmdCtx);
    const selectedModel = cmdCtx.model;
    const model = resolveRouteModel(selectedModel, cmdCtx) ?? selectedModel;
    const commandParts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const subcommand = commandParts[0] || "help";

      if (subcommand === "enable") {
        setRuntimeOptimizerEnabled(true);
        await resetCurrentSessionStats();
        await flushPersistCacheStats(cmdCtx);
        await publishStatus(cmdCtx, model);
        cmdCtx.ui.notify(`✅ 已为当前 OMP 进程开启缓存优化。已重置本地 footer 统计，方便做前后对比。\n${formatOptimizerRuntimeMode()}`, "info");
      } else if (subcommand === "disable") {
        setRuntimeOptimizerEnabled(false);
        providerRequestStates.length = 0;
        await resetCurrentSessionStats();
        await flushPersistCacheStats(cmdCtx);
        await publishStatus(cmdCtx, model);
        cmdCtx.ui.notify(`⏸️ 已为当前 OMP 进程关闭缓存优化。已重置本地 footer 统计，并会在关闭状态下继续采集用于对比。\n${formatOptimizerRuntimeMode()}`, "warning");
      } else if (subcommand === "doctor") {
        await refreshShardAggregate();
        if (!model) {
          cmdCtx.ui.notify(NO_ACTIVE_MODEL_TEXT, "warning");
          return;
        }
        const key = modelKey(model);
        const diagnosis = buildDoctorDiagnosis(model, {
          promptCacheRetention400: promptCacheRetention400Models.has(key),
          promptCacheKey400: promptCacheKeyRejectedModels.has(key),
          anthropicTtlOrderError: anthropicTtlOrderErrorModels.has(key),
          openAISdkHeader403: openAISdkHeader403Models.has(key),
        });
        const adapter = selectAdapterForModel(model);
        const sk = sessionModelKey(model);
        const statsState = getCacheStatsTotalsByModel()[key];
        const samples = getRecentSamples(sk);
        const lowHitLines = buildLowHitDiagnosis(model, adapter, statsState, samples, getRecentPromptDiagnostics(sk));
        const warmingLines = runtime.getCacheWarmingMode
          ? buildCacheWarmingDiagnosis(model, {
            mode: runtime.getCacheWarmingMode(),
            tier: warmingTierForModel(model),
            zeroPriceWarming: isZeroPriceWarmingEnabled(),
          }).lines
          : [];
        const fullDiagnosis = [
          diagnosis,
          "",
          describePromptRewriteOutcome(),
          describePromptCacheRetentionDecision(getLastPromptCacheRetentionDecision()),
          ...warmingLines,
          ...lowHitLines,
        ].filter((line) => line !== undefined).join("\n");
        cmdCtx.ui.notify(fullDiagnosis, "info");
      } else if (subcommand === "stats") {
        const aggregate = await refreshShardAggregate();
        const statsMode = commandParts[1];
        if (statsMode === "all") {
          cmdCtx.ui.notify(buildAllStatsOutput(aggregate), "info");
        } else if (statsMode === "contributors") {
          cmdCtx.ui.notify(buildContributorsStatsOutput(aggregate, model, getCurrentSessionHashSet() ? getCurrentSessionHash() : undefined), "info");
        } else if (statsMode) {
          cmdCtx.ui.notify("用法：/cache-optimizer stats [all|contributors]", "info");
        } else {
          const sessionModels = getCurrentSessionHashSet() ? aggregate.bySession[getCurrentSessionHash()] ?? {} : {};
          const lines = [buildSessionStatsOutput(sessionModels, model, aggregate.modelRefsByKey)];
          if (model && selectAdapterForModel(model)) {
            const sk = sessionModelKey(model);
            const samples = getRecentSamples(sk);
            const promptDiagnostics = formatRecentPromptDiagnostics(getRecentPromptDiagnostics(sk), 10);
            lines.push("", `── 当前模型近期趋势（${modelKey(model)}）──`, formatRecentTrendSummary(samples, 10), formatRecentTrendSummary(samples, 30));
            if (promptDiagnostics) lines.push(promptDiagnostics, "仅显示截断哈希和来源统计，不保存 prompt 或 cache key 原文。");
            if (samples.some((sample) => sample.missingUsageFields)) {
              lines.push("⚠️ 近期有响应缺少或返回了空的缓存 usage 字段，footer 命中率可能偏低。");
            }
          }
          cmdCtx.ui.notify(lines.join("\n"), "info");
        }
      } else if (subcommand === "config") {
        const configKey = commandParts[1];
        const requestedMode = commandParts[2];
        const feature = configKey ? FEATURE_COMMAND_MAP[configKey] : undefined;
        if (feature && (requestedMode === "on" || requestedMode === "off")) {
          try {
            await writePersistedFeature(feature, requestedMode === "on");
            clearLastStatusText();
            await publishStatus(cmdCtx, model);
            cmdCtx.ui.notify(`✅ ${configKey} 已设为 ${requestedMode}。持久化配置优先于对应环境变量。`, "info");
          } catch (error) {
            cmdCtx.ui.notify(`❌ 无法更新 ${configKey}：${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return;
        }
        if (configKey === "reset") {
          try {
            await resetPersistedFeatures();
            clearLastStatusText();
            await publishStatus(cmdCtx, model);
            cmdCtx.ui.notify("✅ 已重置特性配置，环境变量重新生效。", "info");
          } catch (error) {
            cmdCtx.ui.notify(`❌ 无法重置特性配置：${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return;
        }
        if (!configKey) {
          cmdCtx.ui.notify(formatPersistentFeatureConfig() + `\n• Footer 模式：${resolveFooterStatsMode(persistedFooterStatsMode).mode}` + "\n\n" +
            "用法：/cache-optimizer config <特性> on|off | footer-mode total|session|process | reset", "info");
          return;
        }
        if (configKey !== "footer-mode" || !requestedMode || !["session", "total", "process"].includes(requestedMode)) {
          const resolved = resolveFooterStatsMode(persistedFooterStatsMode);
          cmdCtx.ui.notify(
            `用法：/cache-optimizer config footer-mode total|session|process\n` +
            `      /cache-optimizer config prompt-rewrite|openai-cache-key|tool-order|zero-price-warming|stats-incremental on|off\n` +
            `      /cache-optimizer config reset\n` +
            `当前 footer 模式：${resolved.mode}（${resolved.source}）`,
            "info",
          );
          return;
        }

        const nextMode = requestedMode as FooterStatsMode;
        try {
          await writePersistedFooterMode(nextMode);
          setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
          clearLastStatusText();
          await publishStatus(cmdCtx, model);
          const resolved = resolveFooterStatsMode(persistedFooterStatsMode);
          cmdCtx.ui.notify(
            `✅ Footer 模式已设为 ${resolved.mode}。持久化配置优先于 ${FOOTER_MODE_ENV}。`,
            "info",
          );
        } catch (error) {
          cmdCtx.ui.notify(
            `❌ 无法更新 footer 模式配置：${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      } else if (subcommand === "compat") {
        if (!model) {
          cmdCtx.ui.notify(NO_ACTIVE_MODEL_TEXT, "warning");
          return;
        }
        const compatResult = buildCompatDiagnosis(model);
        if (compatResult) {
          cmdCtx.ui.notify(compatResult, "warning");
        } else {
          cmdCtx.ui.notify(
            isAdaptiveThinkingCompatApplicable(model) || isDeepSeekCompatCheckApplicable(model) || isCompatCheckApplicable(model)
              ? "✅ compat 配置完整。"
              : getCompatCheckNotApplicableLines(model).join("\n"),
            "info",
          );
        }
      } else if (subcommand === "rollback") {
        if (!model) {
          cmdCtx.ui.notify(NO_ACTIVE_MODEL_TEXT, "warning");
          return;
        }
        // OMP 版只会自动写本扩展自己的配置文件（prompt_cache_key 关闭），
        // models.yml 一律给手动片段，所以只有这一种回执可以回滚。
        const configReceiptSnapshot = await readPromptCacheKeyConfigReceiptSnapshot();
        const configReceipt = configReceiptSnapshot?.receipt;
        if (!configReceiptSnapshot || !isActionablePromptCacheKeyConfigReceipt(configReceipt)) {
          cmdCtx.ui.notify("ℹ️ 没有找到可回滚的 /cache-optimizer fix 回执。", "info");
          return;
        }
        if (configReceipt.provider !== model.provider || configReceipt.modelId !== model.id) {
          cmdCtx.ui.notify(
            `ℹ️ 最近的修复回执属于 ${configReceipt.provider}/${configReceipt.modelId}，不是当前模型 ${model.provider}/${model.id}。` +
            "请先切换到对应模型再回滚。未做任何修改。",
            "warning",
          );
          return;
        }
        if (!cmdCtx.hasUI) {
          cmdCtx.ui.notify("❌ 回滚需要交互确认，未做任何修改。\n请在 OMP 交互界面里运行 /cache-optimizer rollback 恢复 prompt_cache_key 设置。", "warning");
          return;
        }
        const confirmed = await cmdCtx.ui.confirm(
          "缓存优化器 — 回滚 prompt_cache_key 关闭",
          `模型：${modelKey(model)}\n操作：把本扩展的配置恢复到确认关闭之前。\nFooter 模式与其他无关配置会保留。\n完成后运行 /reload 或重启 OMP。\n\n确认回滚？`,
        );
        if (!confirmed) {
          cmdCtx.ui.notify("已取消回滚，未做任何修改。", "info");
          return;
        }
        try {
          await rollbackPromptCacheKeyConfig(configReceiptSnapshot);
          setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
          cmdCtx.ui.notify(`✅ 已恢复 ${modelKey(model)} 的 prompt_cache_key 行为。运行 /reload 或重启 OMP 后生效。`, "info");
        } catch (error) {
          cmdCtx.ui.notify(`❌ prompt_cache_key 回滚被拒绝：${error instanceof Error ? error.message : String(error)}。未做任何修改。`, "error");
        }
      } else if (subcommand === "reset") {
        if (!model) {
          cmdCtx.ui.notify(NO_ACTIVE_MODEL_TEXT, "warning");
          return;
        }
        const adapter = selectAdapterForModel(model);
        if (!adapter) {
          cmdCtx.ui.notify("ℹ️ 当前活动模型未匹配到缓存适配器，无需重置统计。", "info");
          return;
        }

        const displayKey = modelKey(model);

        // Reset local footer stats for the effective active model. If the
        // selected model is a virtual router and the protocol exposes a live
        // route, this clears the real upstream bucket, not the router shell.
        await resetStatsForModel(model);

        // Persist immediately.
        await flushPersistCacheStats(cmdCtx);

        // Update footer to show 0/0.
        await publishStatus(cmdCtx, model);

        cmdCtx.ui.notify(
          `✅ 已重置 "${displayKey}" 的本地 footer 缓存统计。` +
          "上游 provider 的 prompt cache 未被修改。" +
          "后续请求会为该 provider/model 开始新的本地统计桶。",
          "info",
        );
      } else if (subcommand === "fix") {
        if (!model) {
          cmdCtx.ui.notify(NO_ACTIVE_MODEL_TEXT, "warning");
          return;
        }

        const promptCacheKeyRequested = commandParts[1] === "prompt-cache-key";
        const promptCacheKeyFixRequested = promptCacheKeyRequested || promptCacheKeyFixApplies(model);
        if (promptCacheKeyRequested && !isPromptCacheKeyUnsupportedApplicable(model)) {
          cmdCtx.ui.notify("ℹ️ prompt_cache_key 关闭只适用于已知的 OpenAI 兼容 provider/model endpoint。未做任何修改。", "info");
          return;
        }

        if (promptCacheKeyFixRequested) {
          if (isPromptCacheKeyOmittedForModel(model)) {
            cmdCtx.ui.notify(`✅ "${modelKey(model)}" 已经关闭 prompt_cache_key。`, "info");
            return;
          }
          if (!cmdCtx.hasUI) {
            cmdCtx.ui.notify(
              "❌ 当前不是交互终端。关闭 prompt_cache_key 需要 UI 确认，未做任何修改。\n" +
              `请在 OMP 交互界面里对 ${modelKey(model)} 运行 /cache-optimizer fix prompt-cache-key。`,
              "warning",
            );
            return;
          }
          const preview = [
            "📝 扩展配置修改预览：",
            ...buildPromptCacheKeyConfigPreview(model),
            "",
            "⚠️ 风险提示：",
            "  1. 影响所有使用这个 provider/model 的 session。",
            "  2. 两种写法的 key 都会被去掉，provider 侧的 prompt 缓存复用可能下降。",
            "  3. 不会修改 OMP 的 models.yml、凭据、prompt、header 或其他模型。",
            "  4. 扩展配置会先备份，修改后需要 /reload 或重启 OMP。",
            "",
            "确认保存这个持久化关闭？",
          ].join("\n");
          const confirmed = await cmdCtx.ui.confirm("缓存优化器 — 关闭 prompt_cache_key", preview);
          if (!confirmed) {
            cmdCtx.ui.notify("已取消，未做任何修改。", "info");
            return;
          }
          try {
            const result = await applyPromptCacheKeyConfigFix(model);
            setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
            cmdCtx.ui.notify(
              `✅ 已为 ${modelKey(model)} 保存 prompt_cache_key 关闭。\n` +
              `配置备份：${result.backupPath}\n` +
              "运行 /reload 或重启 OMP 后生效。可用 /cache-optimizer rollback 恢复。",
              "info",
            );
          } catch (error) {
            cmdCtx.ui.notify(`❌ 无法保存 prompt_cache_key 关闭：${error instanceof Error ? error.message : String(error)}。未做任何修改。`, "error");
          }
          return;
        }

        const suggestion = buildCommandFixSuggestion(model);
        if (!suggestion) {
          cmdCtx.ui.notify(`✅ "${modelKey(model)}" 当前无需修复，compat 已配置完成。`, "info");
          return;
        }

        // OMP divergence: models.yml 没有安全的自动改写器（YAML 注释/锚点无法可靠保留），
        // 所以 fix 只给可复制的片段与编辑位置，从不写 models.yml。
        const lines = buildManualFixLines(suggestion);
        const key = modelKey(model);
        if (promptCacheRetention400Models.has(key)) {
          lines.push("", "💡 该模型对 prompt_cache_retention 返回过 HTTP 400；片段把 supportsLongPromptCacheRetention 设为 false。");
        }
        if (anthropicTtlOrderErrorModels.has(key)) {
          lines.push("", "💡 该模型返回过 Anthropic cache-control TTL 顺序错误；片段把 supportsLongCacheRetention 设为 false。");
        }
        const compatResult = buildCompatDiagnosis(model);
        if (compatResult) lines.push("", compatResult);
        cmdCtx.ui.notify(lines.join("\n"), "info");
      } else {
        // Try interactive selection menu when UI supports it
        if (cmdCtx.hasUI) {
          const menuOptions = [
            "启用 —— 打开运行时优化",
            "关闭 —— 关闭运行时优化",
            "诊断 —— 查看缓存配置与低命中原因",
            "统计 —— 查看当前 session 的模型统计",
            "兼容 —— 查看 compat 建议",
            "修复 —— 查看 models.yml 修复片段",
            "关闭 prompt_cache_key —— 对当前模型去掉该字段",
            "回滚 —— 撤销最近一次确认过的修复",
            "Footer 模式 —— 选择 total / session / process 统计",
            "重置 —— 重置本地 provider/model 统计",
            "取消",
          ];
          const choice = await cmdCtx.ui.select("缓存优化器", menuOptions);
          if (choice === menuOptions[0]) {
            await handleCacheOptimizerCommand("enable", cmdCtx);
          } else if (choice === menuOptions[1]) {
            await handleCacheOptimizerCommand("disable", cmdCtx);
          } else if (choice === menuOptions[2]) {
            await handleCacheOptimizerCommand("doctor", cmdCtx);
          } else if (choice === menuOptions[3]) {
            await handleCacheOptimizerCommand("stats", cmdCtx);
          } else if (choice === menuOptions[4]) {
            await handleCacheOptimizerCommand("compat", cmdCtx);
          } else if (choice === menuOptions[5]) {
            await handleCacheOptimizerCommand("fix", cmdCtx);
          } else if (choice === menuOptions[6]) {
            await handleCacheOptimizerCommand("fix prompt-cache-key", cmdCtx);
          } else if (choice === menuOptions[7]) {
            await handleCacheOptimizerCommand("rollback", cmdCtx);
          } else if (choice === menuOptions[8]) {
            const modeOptions = ["session —— 当前 OMP 会话（默认）", "total —— 今天本机所有 session", "process —— 仅当前扩展实例", "取消"];
            const modeChoice = await cmdCtx.ui.select("Footer 缓存统计模式", modeOptions);
            const nextMode = modeChoice === modeOptions[0]
              ? "session"
              : modeChoice === modeOptions[1]
                ? "total"
                : modeChoice === modeOptions[2]
                  ? "process"
                  : undefined;
            if (nextMode) await handleCacheOptimizerCommand(`config footer-mode ${nextMode}`, cmdCtx);
          } else if (choice === menuOptions[9]) {
            await handleCacheOptimizerCommand("reset", cmdCtx);
          }
          // choice === "取消" or undefined → no action
          return;
        }

        // Fallback: text help when no interactive UI
        const diagnosis: string[] = [];
        diagnosis.push("📋 /cache-optimizer 命令：");
        diagnosis.push("  enable  —— 为当前 OMP 进程开启 prompt/cache 优化");
        diagnosis.push("  disable —— 为当前 OMP 进程关闭 prompt/cache 优化");
        diagnosis.push("  doctor  —— 查看当前模型/provider/api/baseUrl/compat 与低命中诊断");
        diagnosis.push("  stats   —— 查看当前 session 每个模型的统计与当前模型近期趋势");
        diagnosis.push("  stats all —— 查看今天本机所有 session 的模型统计");
        diagnosis.push("  stats contributors —— 查看当前模型按 session 的贡献");
        diagnosis.push("  compat  —— 查看 compat 建议与编辑位置");
        diagnosis.push("  config prompt-rewrite|openai-cache-key|tool-order|zero-price-warming|stats-incremental on|off —— 持久化特性开关");
        diagnosis.push("  config footer-mode total|session|process —— 持久化 footer 统计模式");
        diagnosis.push("  config reset —— 清除持久化特性覆盖");
        diagnosis.push(`  fix     —— 查看 ${getModelsYmlDisplayPath()} 的 compat 修复片段（不会自动改写）`);
        diagnosis.push("  fix prompt-cache-key —— 对当前模型关闭 prompt_cache_key（写本扩展配置，需要 UI 确认）");
        diagnosis.push("  rollback —— 撤销最近一次确认过的 prompt_cache_key 关闭（需要 UI 确认）");
        diagnosis.push("  reset   —— 重置当前模型的本地 provider/model 统计（不影响上游）");
        diagnosis.push("");
        diagnosis.push(formatOptimizerRuntimeMode());
        const resolvedFooterMode = resolveFooterStatsMode(persistedFooterStatsMode);
        diagnosis.push(`Footer 统计模式：${resolvedFooterMode.mode}（${resolvedFooterMode.source}）`);
        diagnosis.push("");
        if (model) {
          const displayKey = modelKey(model);
          const missing = describeMissingCacheCompatForModel(model);
          if (missing.length > 0) {
            diagnosis.push(`⚠️ 当前模型 "${displayKey}" 缺少 compat：${missing.join(", ")}`);
            diagnosis.push('可运行 "/cache-optimizer compat" 查看编辑建议。');
          } else if (isAdaptiveThinkingCompatApplicable(model) || isDeepSeekCompatCheckApplicable(model) || isCompatCheckApplicable(model)) {
            diagnosis.push(`✅ 当前模型 "${displayKey}"：compat 配置完整。`);
          } else {
            diagnosis.push(`ℹ️ 当前模型 "${displayKey}"：不适用 compat 检查。`);
            const detailLines = getCompatCheckNotApplicableLines(model).slice(1);
            for (const line of detailLines) diagnosis.push(line);
          }
        } else {
          diagnosis.push("当前没有活动模型。");
        }
        cmdCtx.ui.notify(diagnosis.join("\n"), "info");
      }
  };
}
