# OMP Cache Optimizer

[![npm version](https://img.shields.io/npm/v/omp-cache-optimizer.svg)](https://www.npmjs.com/package/omp-cache-optimizer)
[![npm downloads](https://img.shields.io/npm/dm/omp-cache-optimizer.svg)](https://www.npmjs.com/package/omp-cache-optimizer)
[![license](https://img.shields.io/npm/l/omp-cache-optimizer.svg)](./LICENSE)

> 本项目是基于 [pi-cache-optimizer](https://github.com/jiangge/pi-cache-optimizer) 的二次开发（fork），适配 OMP（Oh My Pi）运行时。原项目由 [freescheme](https://github.com/jiangge) 开发，在此致谢。
>
> 2.0.0 已同步到上游 pi-cache-optimizer **2.10.4**（保留上游 git 历史，模块化结构与上游一致），并适配 OMP **18**。

用于提升 OMP 中 provider 侧 KV Cache / Prompt Cache 命中率的扩展：为 OpenAI 兼容 API 提供稳定的 `prompt_cache_key`，处理长缓存保留与常见的代理拒绝，可选地清理 session-overview 中的易变字段以稳定 prompt 前缀，并在底部显示持久化的缓存统计。

## 与原项目的关键差异

- **状态目录**：`~/.pi/agent/` → `~/.omp/agent/`（`PI_CODING_AGENT_DIR` 覆盖时跟随宿主）
- **模型配置**：`models.json`（JSONC）→ `models.yml`（YAML）。本扩展**从不改写 `models.yml`**，`/cache-optimizer fix` 只给可复制的 YAML 片段
- **compat 来源**：直接读取 OMP 模型对象上解析后的 `compat` 与用户原文 `compatConfig`，不再自己解析配置文件
- **compat 字段**：
  - `supportsLongCacheRetention`（OpenAI 侧）→ `supportsLongPromptCacheRetention`（仅 `api: openai-responses`）；Anthropic 1h TTL 仍是 `supportsLongCacheRetention`
  - `requiresReasoningContentOnAssistantMessages` → `requiresReasoningContentForToolCalls`
  - `sendSessionAffinityHeaders` / `sendSessionIdHeader` / `forceAdaptiveThinking` → 移除（OMP 用多凭据 auth + `agent.db` 做会话亲和；adaptive thinking 由目录自动处理）
- **事件**：`model_select` → `turn_start` 模型变化检测；`agent_settled` → `agent_end`；`/new`、`/resume`、`/fork` 在 OMP 里复用同一扩展实例（`session_switch`），统计会先落盘旧 session 再切换
- **子代理**：OMP 为每个子代理会话创建独立扩展实例，统计按分片汇总；只有顶层会话管理进程级状态（缓存 hints 服务、保留环境变量）
- **Prompt 改写默认关闭**；开启后只逐块清理 `<session-overview>` 易变字段，不压缩 skills（OMP 没有 Pi 的 `systemPromptOptions`）、不重排块
- **`prompt_cache_key`**：Responses 族用项目级稳定 key，Chat Completions 用会话级哈希 key（详见下文）
- **协议符号**：`Symbol.for("omp.routing.registry.v1")` / `Symbol.for("omp.cache.hints.v1")`
- **未移植的上游功能**：Pi 原生虚拟模型、skill 列表压缩、会话亲和 header 桥接、`models.json` 自动修复 / 回滚 / 拼写检查、Kimi Code base URL 修复、`promptCache` 写入修复——它们依赖 Pi 专属宿主能力或 `models.json`

## 功能

- **稳定的 `prompt_cache_key`**（OpenAI 兼容 API：`openai-completions` / `openai-responses` / `openrouter` / `openai-codex-responses` / `azure-openai-responses`）：
  - 会话头里的 `providerPromptCacheKey`（`--provider-prompt-cache-key` 或完整 fork 继承）一律优先；
  - Responses 族：用"项目路径 + API + provider + 模型 + endpoint"派生的项目级稳定 key 替换 OMP 默认的每会话 key，让同一项目的不同会话共享缓存路由；
  - 第三方 Chat Completions：缺 key 时补会话级 key（原始 session id 的单向哈希，不会发给第三方）；
  - 只替换会话级默认 key，用户自定义 key 一律保留；超长 key 用 `pc_` + 48 位哈希归一化。
- **长缓存保留**：加载时设置 `OMP_CACHE_RETENTION=long`（同时镜像宿主读取的 `PI_CACHE_RETENTION`）；用户显式设置的 `short` / `none` 会被尊重。
- **`prompt_cache_retention` 安全门**：只在 OMP 自己判定支持（官方 OpenAI 或 `supportsLongPromptCacheRetention: true`）时保留；provider 明确拒绝后本进程内自动去掉。
- **Provider 拒绝识别**（含中文报错）：`prompt_cache_key` / `prompt_cache_retention` 不支持、DeepSeek reasoning 参数格式被拒、Anthropic 混合 TTL 顺序错误（自动回退 5 分钟 TTL）、OpenAI SDK header 被 CDN/WAF 拦截（403）。只提醒、给片段，从不自动改配置。
- **零价格模型缓存预热**：OMP 的缓存预热在模型没有价格时会停止；本扩展让价格全为 0 的自定义渠道继续预热（可关闭）。
- **可选 prompt 改写**：清理 `<session-overview>` 中的 RECENT COMMITS、Working directory、Line count。
- **可选内置工具确定性排序**（默认关闭）。
- **Footer 统计**：分片持久化，按 session / 当日全部 session / 当前进程三种模式显示；`/cache-optimizer stats all` 汇总本机所有 session。
- **诊断**：`doctor` 显示 compat、路由/代理风险、prompt 改写结果、`prompt_cache_retention` 决策、缓存预热条件与低命中原因。
- **Router 扩展集成**：通过版本化全局协议支持虚拟路由 provider，不需要导入本包。

缓存是 provider 侧的 best-effort 行为。第三方代理和 router extension 仍可能隐藏缓存 usage、拒绝不支持的参数，或把请求路由到多个上游。

## 安装

```bash
omp plugin install omp-cache-optimizer
```

如果之前安装过原版本：

```bash
omp plugin uninstall pi-cache-optimizer && omp plugin install omp-cache-optimizer
```

安装、更新或移除后，在 OMP 中运行 `/reload`，让 extension hooks 刷新。要求 OMP 18 及以上。

## 命令

| 命令 | 作用 |
|---|---|
| `/cache-optimizer` | UI 支持时打开交互菜单；否则打印帮助和当前状态。 |
| `/cache-optimizer enable` / `disable` | 当前 OMP 进程内开启 / 关闭运行时优化，并重置本地统计便于前后对比。`/reload` 或重启后恢复启动时行为。 |
| `/cache-optimizer doctor` | 当前模型 / provider / API / base URL / compat、路由诊断、prompt 改写结果、retention 决策、缓存预热条件与低命中诊断。 |
| `/cache-optimizer compat` | 当前模型的 compat 建议与编辑位置。 |
| `/cache-optimizer stats` | 当前 session 每个模型的统计，以及当前模型的近期趋势和 prompt 诊断。 |
| `/cache-optimizer stats all` | 今天本机所有 session 的模型统计。 |
| `/cache-optimizer stats contributors` | 当前模型按 session 的贡献。 |
| `/cache-optimizer config` | 查看持久化特性配置。 |
| `/cache-optimizer config <特性> on\|off` | 持久化特性开关：`prompt-rewrite`、`openai-cache-key`、`tool-order`、`zero-price-warming`、`stats-incremental`。优先于环境变量。 |
| `/cache-optimizer config footer-mode session\|total\|process` | 持久化 footer 统计模式。 |
| `/cache-optimizer config reset` | 清除持久化特性覆盖。 |
| `/cache-optimizer fix` | 显示 `models.yml` 的 compat 修复片段（provider 级 / 模型级），不自动改写。 |
| `/cache-optimizer fix prompt-cache-key` | 对当前模型关闭 `prompt_cache_key`（写本扩展自己的配置文件，带备份与回执，需 UI 确认）。 |
| `/cache-optimizer rollback` | 撤销最近一次确认过的 `prompt_cache_key` 关闭（需 UI 确认）。 |
| `/cache-optimizer reset` | 重置当前模型的本地统计；不影响上游 provider 缓存。 |

## 环境变量

主前缀为 `OMP_`；未设置时回退读取同名 `PI_` 前缀（兼容从原项目迁移的配置）。持久化配置（`/cache-optimizer config`）优先于环境变量。

| 环境变量 | 作用 |
|---|---|
| `OMP_CACHE_RETENTION` | `long`（默认）/ `short` / `none`。扩展同步镜像到宿主读取的 `PI_CACHE_RETENTION`。 |
| `OMP_CACHE_OPTIMIZER_PROMPT_REWRITE=1` | 开启 prompt 改写（默认关闭）。 |
| `OMP_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` | 关闭 `prompt_cache_key` 处理（也可 `OMP_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0`）。 |
| `OMP_CACHE_OPTIMIZER_TOOL_ORDER=1` | 开启内置工具确定性排序。 |
| `OMP_CACHE_OPTIMIZER_NO_ZERO_PRICE_WARMING=1` | 关闭零价格模型的缓存预热覆盖。 |
| `OMP_CACHE_OPTIMIZER_FOOTER_MODE` | `session`（默认）/ `total` / `process`。 |
| `OMP_CACHE_OPTIMIZER_STATS_INCREMENTAL=0` | 关闭增量 footer 刷新（每次全量扫描分片）。 |
| `OMP_CACHE_OPTIMIZER_STATS_VERIFY=1` | 检查文件系统是否隐藏了分片变化（排障用）。 |
| `OMP_CACHE_OPTIMIZER_STATS_TIMING=1` | 把 footer 刷新耗时写到 `omp-cache-optimizer-stats-timing.jsonl`（也可给绝对路径）。 |

## OpenAI 兼容代理配置

LiteLLM / OneAPI / NewAPI / 类 OpenRouter 渠道等第三方代理，常会把同一个 session 分散到多个上游后端，导致 provider 侧 prompt cache 被拆散。`/cache-optimizer doctor` 会识别常见渠道类型并给出路由建议。

`models.yml` 示例：

```yaml
providers:
  your-provider-id:
    api: openai-responses
    baseUrl: https://example.com/v1
    apiKey: YOUR_API_KEY
    compat:
      supportsLongPromptCacheRetention: true
    models:
      - id: gpt-5.5
        name: GPT-5.5
```

- `supportsLongPromptCacheRetention: true` 是可选项，只对 `api: openai-responses` 有意义；只有 endpoint 明确支持 OpenAI long prompt cache retention 时才添加。
- 出现 `400 Unsupported parameter: prompt_cache_retention` 时，本扩展会在当前进程内自动去掉该字段；运行 `/cache-optimizer fix` 获取持久关闭的片段。
- 代理拒绝 `prompt_cache_key` 时，运行 `/cache-optimizer fix prompt-cache-key` 只对该模型关闭。
- OMP 会对 `compat` 里的未知键给出警告，可借此发现拼写错误。

## 使用 `/cache-optimizer fix`

`fix` 汇总当前模型的可安全修复项（以及运行时观测到的拒绝），显示可直接合并进 `models.yml` 的片段：

```yaml
providers:
  your-provider-id:
    modelOverrides:
      deepseek-reasoner:
        compat:
          requiresReasoningContentForToolCalls: true
```

运行时观测到的问题（例如某个模型拒绝了 `prompt_cache_retention` 或 Anthropic 1h TTL）只给模型级片段，不会扩大到整个 provider。合并片段时保留现有认证方式，不要复制 credential、token 或 API key；保存后运行 `/reload`。

YAML 的注释、锚点和格式无法被可靠地外科式改写，所以本扩展不自动写 `models.yml`。唯一的自动写入是 `fix prompt-cache-key`：它只改本扩展自己的 `~/.omp/agent/omp-cache-optimizer-config.json`，写前备份、写后记录回执，可用 `/cache-optimizer rollback` 撤销。

## Footer 统计

统计按"实例分片"保存在 `~/.omp/agent/omp-cache-optimizer-stats.d/`：每个 OMP 进程 / 子代理会话写自己的分片，过去的日期折叠进归档，footer 增量读取。文件只包含日期、模型标识和数字计数，不包含 API key、prompt、payload、headers、响应或模型输出。1.x 的单文件统计 `omp-cache-optimizer-stats.json` 会在首次启动时删除（计数不迁移）。

示例 footer：

```text
OpenAI Cache | 缓存命中率：40% | 最近2次token命中率：80% | 缓存请求命中次数：3/10 次 | 缓存token/总输入：3.00k/7.50k ⚠️ 配置
```

| 部分 | 示例 | 说明 |
|---|---|---|
| 适配器标签 | `OpenAI Cache` | 识别到的模型家族 |
| **缓存命中率** | `40%` | 主指标（按 token）：缓存 input tokens ÷ 总 input tokens |
| 最近N次token命中率 | `最近2次token命中率：80%` | 本 session 最近最多 10 次有效请求的按 token 命中率（`total` 模式不显示） |
| 缓存请求命中次数 | `3/10 次` | `cacheRead > 0` 的请求数 / 总请求数；没有 usage 的失败 / 中止请求不计 |
| 缓存token/总输入 | `3.00k/7.50k` | k/M 缩写 |
| 写入token | `写入token：1.20k` | 新写入 prompt cache 的 tokens（Claude） |
| `⚠️ 配置` | 末尾 | 当前模型缺少可安全修复的 compat，运行 `/cache-optimizer fix` |
| `缓存优化已关闭 ·` | 前缀 | `/cache-optimizer disable` 后的对比模式 |

Footer 模式：`session`（默认，当前 OMP 会话）、`total`（今天本机所有 session）、`process`（当前扩展实例）。

### Prompt 稳定性诊断

`/cache-optimizer stats` 与 `doctor` 会显示最近 10 次 provider 请求的 prompt 诊断：是否启用 prompt 改写、观测到的 system prompt 指纹组数、`prompt_cache_key` 来自 header / 项目稳定 / 会话 / 自定义 / 未注入的次数。只记录 SHA-256 的 16 位截断指纹和来源类别，只保存在当前进程内存里，绝不保存 prompt、payload、session ID、cache key 或 API key 原文。

支持的 footer label 包括：DS、Claude、OpenAI、Gemini、Kimi、Qwen、GLM、MiniMax、Mimo、Hunyuan、Mistral、Grok、Llama、Nemotron、Cohere、Yi、Doubao、ERNIE、Baichuan、StepFun、Spark、InternLM、Gemma、Phi、Jamba、Solar、Sonar、Nova、Reka、Falcon、DBRX、MPT、StableLM、Aquila、EXAONE、HyperCLOVA、Luminous、Hermes、Granite、Arctic、Pangu、SenseNova、Zhinao、MiniCPM、XVERSE、Orion、OpenChat、Vicuna、Wizard、Zephyr、Dolphin、OpenOrca、Starling、BLOOM、RWKV、Aya。适配器选择只看模型 id/name（以及 assistant message 的 model/name），不看 API 形状。

## Router / Virtual-channel 扩展作者指南

如果你的 OMP 扩展提供虚拟 routing provider（例如 `router/auto`），本扩展可以把缓存统计记到真实上游 provider/model 上，而不是虚拟外壳。集成是可选、版本化的，**不需要导入本包**。

### 最小集成：最终 assistant message metadata

在完成的 assistant message 上透传真实上游身份：

```ts
{
  role: "assistant",
  provider: "anthropic",              // 真实上游 provider
  responseModel: "claude-opus-4-8",   // 或 OMP 的 upstreamModel / model
  api: "anthropic-messages",
  usage: { input: 1200, cacheRead: 8000, cacheWrite: 500 },
}
```

### 可选：实时路由注册表

要让首次响应前的 footer、`doctor`、`compat`、`reset` 和 cache hint 也指向真实上游，请在 `Symbol.for("omp.routing.registry.v1")` 下注册 route adapter：

```ts
type OmpRouteSnapshot = {
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

const ROUTING = Symbol.for("omp.routing.registry.v1");
const registry = (globalThis as Record<symbol, unknown>)[ROUTING] as
  | { version: 1; registerRouter(adapter: { virtualProvider: string; resolveActiveRoute(id: string, hint?: { sessionIdHash?: string }): OmpRouteSnapshot | undefined }): () => void }
  | undefined;

registry?.registerRouter({
  virtualProvider: "router",
  resolveActiveRoute(virtualModelId) {
    return { virtualProvider: "router", virtualModelId, provider: "anthropic", modelId: "claude-opus-4-8", api: "anthropic-messages", timestamp: Date.now() };
  },
});
```

cache hints 协议（`Symbol.for("omp.cache.hints.v1")`）提供 `getHints(input)`，返回当前 session 的 system prompt、`prompt_cache_key` 与 cache retention hint。

## 开发

```bash
npm install
npm run check      # typecheck + 测试 + diff 检查 + 模块图 + 打包检查
npm test           # node --test（jiti 加载 TypeScript）
```

`@oh-my-pi/pi-coding-agent` 只作为 devDependency 提供类型；扩展运行时只从宿主 `import type`，peer dependency 标为可选。

本仓库保留上游 [pi-cache-optimizer](https://github.com/jiangge/pi-cache-optimizer) 的 git 历史，追新时 `git merge` 上游 master 后再做 OMP 适配。

## 卸载

```bash
omp plugin uninstall omp-cache-optimizer
```

卸载后运行 `/reload`。本地统计目录 `~/.omp/agent/omp-cache-optimizer-stats.d/` 与配置文件 `omp-cache-optimizer-config.json` 不会自动删除，可手动清理。

## 致谢

本项目基于 [pi-cache-optimizer](https://github.com/jiangge/pi-cache-optimizer) 二次开发，感谢原作者 [freescheme](https://github.com/jiangge) 的工作。

## License

[MIT](./LICENSE)
