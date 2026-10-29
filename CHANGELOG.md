# 更新日志

本项目的所有版本变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。日期为 npm 发布日期（UTC）。

发版时 CI 从本文件中取出对应版本的小节作为 GitHub Release 说明。

## [Unreleased]

### 新增

- `CHANGELOG.md`：补齐此前全部版本的记录，并随 npm 包发布。

### 变更

- CI：`actions/checkout`、`actions/setup-node` 升级到 v7（Node 24 运行时）；发版任务不再使用依赖缓存。
- GitHub Release 说明改为从 `CHANGELOG.md` 对应版本小节生成。

## [2.1.0] - 2026-10-29

同步上游 pi-cache-optimizer 2.10.4，适配 OMP 18。首个通过 CI 发布（npm Trusted Publishing + provenance）的版本。2.0.0 只在 PR 中使用过，未发布到 npm。

### 新增

- 统计改为分片存储 + 归档 + 增量 footer 刷新；新增 footer 模式 `session` / `total` / `process`、`stats all`、`stats contributors`。
- `prompt_cache_retention` 决策门；可按模型关闭 `prompt_cache_key`（`fix prompt-cache-key`，带备份/回执/`rollback`）。
- 识别 provider 拒绝（含中文报错）：`prompt_cache_key` / `prompt_cache_retention` 不支持、reasoning 参数格式被拒、Anthropic 混合 TTL 顺序错误（自动回退 5 分钟）、OpenAI SDK header 被拦截（403）。
- 零价格模型继续缓存预热；`/cache-optimizer config` 持久化特性开关；命令参数补全；可选的内置工具确定性排序。

### 变更

- 同步上游 2.6.7 → 2.10.4，保留上游 git 历史，采用上游模块化结构（`index.ts` + `src/` 28 个模块）。
- 适配 OMP 18 事件模型：`turn_start` 模型变化检测、`agent_end`、同一扩展实例上的 `/new` `/resume` `/fork` 会话切换、子代理独立实例。
- compat 直接读取 OMP 模型对象的 `compat` / `compatConfig`，不再解析配置文件。
- `openai-completions` 的会话级 `prompt_cache_key` 改为原始 session id 的单向哈希，不再把原始 id 发给第三方。
- `@oh-my-pi/pi-coding-agent` 改为可选 peerDependency，安装插件时不再拉入整个宿主依赖树。
- 发版改为 CI：打 `vX.Y.Z` tag 后在 Linux、Windows 上跑完整检查，通过后发布到 npm 并创建 GitHub Release。

### 修复

- `message_end` 只统计 assistant 消息，不再把用户消息和工具结果记成"usage 缺失"。
- 会话切换前的后台刷新不会提前把计数切到新 session。
- Windows 上 `fix prompt-cache-key` 回执写入失败时的补偿校验。

### 升级须知

- 需要 OMP 18+。
- 1.x 的统计文件 `~/.omp/agent/omp-cache-optimizer-stats.json` 会在首次启动时删除（计数不迁移），新统计位于 `omp-cache-optimizer-stats.d/`。

## [1.2.3] - 2026-07-19

### 修复

- `openai-completions` 代理（尤其是 Grok）在没有宿主 `providerPromptCacheKey` 时使用项目级 `prompt_cache_key`，导致不同 session 共用同一缓存分桶。`openai-completions` 恢复使用 session 级 key；Responses 类 API 继续使用项目级稳定 key。
- `before_agent_start` 的 cache hint 与实际请求体使用同一 key 策略。

## [1.2.2] - 2026-07-19

### 变更

- 对齐 OMP 17.0.5 扩展生命周期和类型契约，新增 `session_before_switch` / `session_switch` 处理。
- `prompt_cache_key` 覆盖四种 OpenAI API：优先使用宿主稳定 header，否则生成项目级稳定 key；替换 session 级 key、保留自定义 key，超长 key 做 SHA-256 归一化。
- `prompt_cache_retention` 只在字面 `openai-responses` 且模型声明 `supportsLongPromptCacheRetention` 时保留。
- usage 统计：成功但缺失 usage 的全零响应计入请求数；`error` / `aborted` 的全零响应不计。

### 修复

- 会话切换时等待进行中的 `message_end`，先保存旧会话统计再恢复目标会话；宿主切换失败或回滚时按实际 sessionId 自愈。
- 同模型 session 回滚后 footer 不刷新；目标模型恢复前不再用旧模型发布 footer 或 compat 诊断。

## [1.2.1] - 2026-07-16

### 修复

- 长 `providerPromptCacheKey`：扩展间 cache hint 保留完整 host key，避免前缀相同的不同长 key 被错误归并；请求体中的 `prompt_cache_key` 仍截断到 64 字符以避免 OpenAI 400。

## [1.2.0] - 2026-07-16

### 新增

- prompt 稳定性诊断：`/cache-optimizer stats` 显示最近请求的改写模式、system prompt 指纹组数、cache key 来源和 hint/payload 不一致计数；`doctor` 在低命中时提示前缀分裂或 hint 发布后 payload 被修改。诊断只保存截断指纹，不保存 prompt、payload、header、key 原文。

### 变更

- prompt 改写默认关闭，只有设置 `OMP_CACHE_OPTIMIZER_PROMPT_REWRITE=1` 时才清理 `<session-overview>` 的易变字段。

### 移除

- `OMP_CACHE_OPTIMIZER_NO_PROMPT_REWRITE` / `PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE` 不再生效。

## [1.1.0] - 2026-07-16

收敛 OMP 17 下的 prompt 改写，只保留安全的 `<session-overview>` 易变字段清理。

### 变更

- OMP 17 的 `systemPrompt: string[]` 块逐字保留（含 skill 描述），块顺序不变。
- peerDependency `@oh-my-pi/pi-coding-agent` 限定为 `>=17.0.0 <18.0.0`。

### 移除

- skill 列表压缩（只留名称会破坏模型选择 skill）及 `OMP_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION`。
- 启发式块重排。
- 向请求体注入 `prompt_cache_key` 及 `OMP_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY`（改由 OMP 17 宿主负责）。
- prompt 结构完整性告警。

## [1.0.8] - 2026-06-23

### 修复

- `prompt_cache_key` 只注入到 OpenAI 兼容代理 API。
- 模型没有显式声明 `supportsLongPromptCacheRetention`，或本进程内该模型出现过 400 时，从请求中移除 `prompt_cache_retention`。

## [1.0.7] - 2026-06-22

### 修复

- 缓存 payload 改写：`prompt_cache_key` 就地写入请求体。

### 变更

- `/cache-optimizer fix` 只输出 `models.yml` 的 YAML 片段供手动编辑，移除继承自上游的 JSONC 自动写入代码。

## [1.0.6] - 2026-06-22

### 修复

- prompt 改写时保留结构化 payload 数组中的非文本块与元数据。

### 文档

- 安装/卸载命令改为 `omp plugin install` / `omp plugin uninstall`。

## [1.0.5] - 2026-06-22

### 修复

- `package.json` 仓库地址指向 `EF-FlowCode/omp-cache-optimizer`，新增 `homepage`、`bugs`。

### 文档

- README footer 示例与中文文案一致，新增 footer 各部分含义说明。

## [1.0.4] - 2026-06-22

### 变更

- 运行状态、compat 提示、统计面板、路由诊断全部中文化。
- 简化 `setSystemPrompt`（Anthropic 数组块、Google parts、OpenAI content 直接赋值）。

## 1.0.1 ~ 1.0.3 - 2026-06-21 ~ 2026-06-22

- 文案调整：去掉源码注释与提示中的 Pi 专属表述。这几个版本没有单独的发布记录。

## [1.0.0] - 2026-06-21

- 基于 pi-cache-optimizer 2.6.7 分叉，适配 OMP 运行时：`@oh-my-pi/pi-coding-agent` 包名、`models.yml` 配置、`before_agent_start` 改写 prompt、compat 字段改为 OMP 名称。

[Unreleased]: https://github.com/EF-FlowCode/omp-cache-optimizer/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/EF-FlowCode/omp-cache-optimizer/releases/tag/v2.1.0
[1.2.3]: https://github.com/EF-FlowCode/omp-cache-optimizer/releases/tag/v1.2.3
[1.2.2]: https://github.com/EF-FlowCode/omp-cache-optimizer/releases/tag/v1.2.2
[1.2.1]: https://github.com/EF-FlowCode/omp-cache-optimizer/releases/tag/v1.2.1
[1.2.0]: https://github.com/EF-FlowCode/omp-cache-optimizer/releases/tag/v1.2.0
[1.1.0]: https://github.com/EF-FlowCode/omp-cache-optimizer/releases/tag/v1.1.0
[1.0.7]: https://github.com/EF-FlowCode/omp-cache-optimizer/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/EF-FlowCode/omp-cache-optimizer/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/EF-FlowCode/omp-cache-optimizer/releases/tag/v1.0.5
[1.0.4]: https://github.com/EF-FlowCode/omp-cache-optimizer/releases/tag/v1.0.4
