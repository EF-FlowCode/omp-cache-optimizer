import { type PiModel } from "./common.ts";
import { getCompat, isDeepSeekLikeModel, isOpenAICompatibleProxyApi } from "./model-identity.ts";
import { STATE_DIR } from "./paths.ts";
import { homedir } from "node:os";

/** Join display-only path fragments without resolving them for I/O. */
export function joinDisplayPath(base: string, child: string, platform: string = process.platform): string {
  const sep = platform.startsWith("win") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${child}`;
}

/**
 * 返回平台友好的 OMP agent 目录展示路径（仅用于文案，不用于 I/O）。
 * 位于家目录下时 Windows 用 `%USERPROFILE%`、其它平台用 `~`；自定义目录原样展示。
 */
export function getAgentDirDisplayPath(
  platform: string = process.platform,
  agentDir: string = STATE_DIR,
  homeDir: string = homedir(),
): string {
  const sep = platform.startsWith("win") ? "\\" : "/";
  const normalizedAgentDir = agentDir.replace(/[\\/]+/g, sep);
  const normalizedHomeDir = homeDir.replace(/[\\/]+/g, sep).replace(/[\\/]+$/, "");
  const homePrefix = `${normalizedHomeDir}${sep}`;

  if (normalizedAgentDir === normalizedHomeDir || normalizedAgentDir.startsWith(homePrefix)) {
    const relative = normalizedAgentDir.slice(normalizedHomeDir.length).replace(/^[\\/]+/, "");
    const homeLabel = platform.startsWith("win") ? "%USERPROFILE%" : "~";
    return relative ? `${homeLabel}${sep}${relative}` : homeLabel;
  }

  return normalizedAgentDir;
}

/**
 * 返回平台友好的 `models.yml` 展示路径（仅用于文案）。
 * Windows：`%USERPROFILE%\.omp\agent\models.yml`；其它平台：`~/.omp/agent/models.yml`。
 */
export function getModelsYmlDisplayPath(
  platform: string = process.platform,
  agentDir: string = STATE_DIR,
  homeDir: string = homedir(),
): string {
  return joinDisplayPath(getAgentDirDisplayPath(platform, agentDir, homeDir), "models.yml", platform);
}

/**
 * OMP divergence: OMP 的模型目录会自动处理 Anthropic adaptive thinking
 * （`disableAdaptiveThinking` 等由目录规则设置），没有 Pi 的 `forceAdaptiveThinking`
 * 需要用户手动补，所以这一组检查在 OMP 上恒为不适用。保留函数以对齐上游调用点。
 */
export function isAdaptiveThinkingCompatApplicable(_model: PiModel): boolean {
  return false;
}

export function describeMissingAdaptiveThinkingCompat(_model: PiModel): string[] {
  return [];
}

/**
 * OMP divergence: Pi 的 `sendSessionAffinityHeaders` 在 OMP 上没有对应 compat 键。
 * OMP 通过多凭据认证 + agent.db 的会话亲和保证上游粘性，因此 OpenAI 兼容代理在 OMP 上
 * 没有"必需"的缓存 compat 键，这里恒返回空。可选的长缓存保留只对 openai-responses 有意义，
 * 由 doctor/compat 作为可选建议单独说明。
 */
export function describeMissingOpenAICompatibleProxyCompat(_model: PiModel): string[] {
  return [];
}

export function buildSafeOpenAIProxyCompatSuggestion(_missing: string[]): Record<string, boolean> {
  // OMP 上没有可安全自动建议的代理 compat 键；supportsLongPromptCacheRetention 只适用于
  // openai-responses 且可能导致 400，需用户确认上游支持后手动添加。
  return {};
}

export type CompatAdvicePlacement = {
  providerLabel?: string;
  modelId?: string;
};

export function buildProviderCompatOverride(providerLabel: string, compat: Record<string, unknown>): Record<string, unknown> {
  return {
    providers: {
      [providerLabel]: {
        compat,
      },
    },
  };
}

export function buildModelCompatOverride(providerLabel: string, modelId: string, compat: Record<string, unknown>): Record<string, unknown> {
  return {
    providers: {
      [providerLabel]: {
        modelOverrides: {
          [modelId]: {
            compat,
          },
        },
      },
    },
  };
}

function formatYamlKey(key: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(key) ? key : JSON.stringify(key);
}

function formatYamlScalar(value: unknown): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) && !/^(true|false|null|yes|no|on|off|~)$/i.test(value) ? value : JSON.stringify(value);
  return JSON.stringify(value);
}

/**
 * 把简单嵌套对象（叶子为布尔/数字/字符串）格式化为 models.yml 可直接粘贴的块样式 YAML。
 * 键名或取值含特殊字符时使用 JSON 双引号字符串（也是合法的 YAML 标量）。
 */
export function formatYamlSnippet(value: Record<string, unknown>, indent = 0): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      lines.push(`${pad}${formatYamlKey(key)}:`);
      lines.push(formatYamlSnippet(child as Record<string, unknown>, indent + 2));
    } else {
      lines.push(`${pad}${formatYamlKey(key)}: ${formatYamlScalar(child)}`);
    }
  }
  return lines.join("\n");
}

export function appendCredentialSafeProviderGuidance(lines: string[], placement: CompatAdvicePlacement, compatSuggestion: Record<string, unknown>): void {
  const providerLabel = placement.providerLabel;
  if (!providerLabel) return;

  lines.push("");
  lines.push("如果这个渠道在 models.yml 里还没有 provider 配置：");
  lines.push("- 保留现有认证方式；不要复制 credential、token 或 API key。");
  lines.push(`- 只在 ${getModelsYmlDisplayPath()} 里添加缓存/路由 compat 覆盖。`);

  if (Object.keys(compatSuggestion).length === 0) {
    lines.push("- 上面这些缺失项目前没有安全可复制的覆盖片段。");
    return;
  }

  lines.push("Provider 级最小覆盖：");
  lines.push(formatYamlSnippet(buildProviderCompatOverride(providerLabel, compatSuggestion)));

  if (placement.modelId) {
    lines.push("单模型覆盖（只想影响当前模型时使用）：");
    lines.push(formatYamlSnippet(buildModelCompatOverride(providerLabel, placement.modelId, compatSuggestion)));
  }
}

export function appendOpenAIProxyCompatAdviceLines(lines: string[], missing: string[], options: { includeJsonIntro?: boolean } & CompatAdvicePlacement = {}): void {
  const suggestion = buildSafeOpenAIProxyCompatSuggestion(missing);
  const hasSafeSuggestion = Object.keys(suggestion).length > 0;

  if (hasSafeSuggestion) {
    if (options.includeJsonIntro !== false) {
      lines.push("安全默认建议：");
    }
    lines.push(formatYamlSnippet({ compat: suggestion }));
  }

  appendCredentialSafeProviderGuidance(lines, options, suggestion);
}

/**
 * Build the warning text displayed to users when an OpenAI-compatible
 * third-party proxy is missing one or more cache compat flags.
 *
 * OMP 上 describeMissingOpenAICompatibleProxyCompat 恒为空，所以这段文案只在
 * 将来 OMP 引入新的代理缓存 compat 键时才会出现；保留以对齐上游适配器接口。
 */
export function buildOpenAIProxyCompatWarningText(key: string, missing: string[]): string {
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
  const modelId = slashIdx > 0 ? key.slice(slashIdx + 1) : undefined;

  const lines: string[] = [
    `💡 omp-cache-optimizer：${key} 是第三方 OpenAI 兼容代理，但合并后的 compat 缺少 ${missing.join(" 和 ")}。`,
    `运行 /cache-optimizer fix 查看修复片段，或手动编辑 ${getModelsYmlDisplayPath()} -> providers["${providerLabel}"] -> compat。`,
    "",
  ];

  appendOpenAIProxyCompatAdviceLines(lines, missing, { providerLabel, modelId });

  return lines.join("\n");
}

/**
 * DeepSeek 家族名只用于选择缓存适配器；是否需要 reasoning 回放 compat 由 OMP
 * 解析后的 compat 决定。OMP 的目录规则会为可推理的 DeepSeek 家族自动设置
 * `requiresReasoningContentForToolCalls: true`，所以只有名字像 DeepSeek、声明了
 * `reasoning: true`、走 openai-completions，但 OMP 没有识别出来（解析结果仍为 false）时才提醒。
 */
export function isDeepSeekWireCompatApplicable(model: PiModel): boolean {
  return isDeepSeekLikeModel(model)
    && isOpenAICompatibleProxyApi(model.api)
    && model.reasoning === true;
}

export function describeMissingDeepSeekCompat(model: PiModel): string[] {
  if (!isDeepSeekWireCompatApplicable(model)) return [];

  const compat = getCompat(model);
  const missing: string[] = [];
  if (compat.requiresReasoningContentForToolCalls !== true) {
    missing.push("requiresReasoningContentForToolCalls");
  }
  return missing;
}

export function describeMissingCacheCompatForModel(model: PiModel): string[] {
  if (isAdaptiveThinkingCompatApplicable(model)) {
    return describeMissingAdaptiveThinkingCompat(model);
  }

  const missing = describeMissingOpenAICompatibleProxyCompat(model);
  if (isDeepSeekWireCompatApplicable(model)) {
    missing.push(...describeMissingDeepSeekCompat(model));
  }
  return missing;
}

export function buildDeepSeekCompatSuggestion(missing: string[]): Record<string, unknown> {
  const suggestion: Record<string, unknown> = {
    ...buildSafeOpenAIProxyCompatSuggestion(missing),
  };
  if (missing.includes("requiresReasoningContentForToolCalls")) {
    suggestion.requiresReasoningContentForToolCalls = true;
  }
  return suggestion;
}

export function appendDeepSeekCompatAdviceLines(lines: string[], missing: string[], placement: CompatAdvicePlacement = {}): void {
  const suggestion = buildDeepSeekCompatSuggestion(missing);
  if (Object.keys(suggestion).length > 0) {
    lines.push("推荐的 DeepSeek reasoning 回放 compat 片段：");
    lines.push(formatYamlSnippet({ compat: suggestion }));
  }

  if (missing.includes("requiresReasoningContentForToolCalls")) {
    lines.push("- requiresReasoningContentForToolCalls：DeepSeek 思考模式下的工具调用需要 assistant 消息回传 reasoning 内容。");
  }

  appendCredentialSafeProviderGuidance(lines, placement, suggestion);
}

export function buildDeepSeekCompatWarningText(key: string, missing: string[]): string {
  const slashIdx = key.indexOf("/");
  const providerLabel = slashIdx > 0 ? key.slice(0, slashIdx) : key;
  const modelId = slashIdx > 0 ? key.slice(slashIdx + 1) : undefined;
  const lines: string[] = [
    `💡 omp-cache-optimizer：${key} 看起来是 DeepSeek 系推理模型，但 OMP 解析后的 compat 缺少 ${missing.join(" 和 ")}。`,
    `代理可能降低或隐藏缓存命中。编辑 ${getModelsYmlDisplayPath()} -> providers["${providerLabel}"] -> compat（与 baseUrl/api/apiKey/models 同级）。`,
    "",
  ];

  appendDeepSeekCompatAdviceLines(lines, missing, { providerLabel, modelId });

  return lines.join("\n");
}

/** OMP divergence：见 describeMissingOpenAICompatibleProxyCompat。 */
export function describeMissingOpenAIFamilyProxyCompat(_model: PiModel): string[] {
  return [];
}
