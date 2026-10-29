import { createHash } from "node:crypto";
import { asRecord } from "./common.ts";

/** Non-reversible diagnostic fingerprint of a prompt (16 hex chars); never persist the prompt text. */
export function fingerprintPrompt(prompt: string | undefined): string | undefined {
  return typeof prompt === "string"
    ? createHash("sha256").update(prompt).digest("hex").slice(0, 16)
    : undefined;
}

/**
 * Strip per-turn churn from trellis `<session-overview>` block.
 *
 * Trellis injects a session-overview that includes `RECENT COMMITS`
 * (shifts on every git commit), `Working directory: Clean/N uncommitted`
 * (shifts on every edit/commit), and `Line count: N / 2000` (shifts on
 * every journal append). These fields are at the tail of the
 * session-overview and poison the prompt-prefix cache for everything
 * that follows.
 *
 * This function surgically removes those three churn fields from the
 * `<session-overview>...</session-overview>` block. The remaining
 * fields (DEVELOPER, GIT STATUS branch-only, CURRENT TASK, ACTIVE
 * TASKS, MY TASKS, JOURNAL FILE active-file-only, PACKAGES, PATHS)
 * are stable within a session and become cache-friendlier.
 *
 * No-op when the `<session-overview>` tag is not present (e.g.
 * trellis hook chose not to inject it, or a different extension
 * owns the prompt).
 */
export function stripSessionOverviewChurn(prompt: string): string {
  const startTag = "<session-overview>";
  const endTag = "</session-overview>";

  const startIdx = prompt.indexOf(startTag);
  if (startIdx === -1) return prompt;

  const endIdx = prompt.indexOf(endTag, startIdx + startTag.length);
  if (endIdx === -1) return prompt;

  const before = prompt.slice(0, startIdx + startTag.length);
  const inner = prompt.slice(startIdx + startTag.length, endIdx);
  const after = prompt.slice(endIdx);

  let cleaned = inner
    // Drop the RECENT COMMITS section (from the heading through the
    // next heading or end of inner). The model sees commit history
    // via `git log`; carrying it in every system prompt is redundant.
    .replace(/\n## RECENT COMMITS\n[\s\S]*?(?=\n## |$)/, "")
    // Drop "Working directory: ..." (Git status tail churn).
    .replace(/\nWorking directory:[^\n]*/g, "")
    // Drop "Line count: N / NNNN" (Journal tail churn).
    .replace(/\nLine count:[^\n]*/g, "");

  return before + cleaned + after;
}

// ── OMP system prompt 块数组工具 ──────────────────────────────
// before_agent_start 给出 `systemPrompt: string[]`（有序块），返回 `{ systemPrompt: string[] }`
// 整段替换。块顺序与 skill 描述逐字保留；join 只用于 cache hint 展示，不用于再拆分。

/** 规范化 event.systemPrompt：OMP 为 string[]；兼容旧宿主的 string。 */
export function normalizeSystemPromptBlocks(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((block): block is string => typeof block === "string");
  return typeof value === "string" ? [value] : [];
}

export function joinSystemPromptBlocks(blocks: string[]): string {
  return blocks.filter((block) => typeof block === "string" && block.length > 0).join("\n\n");
}

export function mapSystemPromptBlocks(blocks: string[], mapFn: (block: string, index: number) => string): string[] {
  return blocks.map((block, index) => {
    if (typeof block !== "string") return block;
    const next = mapFn(block, index);
    // 防止整块被 map 成空串后误删。
    if (typeof next !== "string" || next.trim().length === 0) return block;
    return next;
  });
}

export function systemPromptBlocksEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * What happened to the prompt on the most recent `before_agent_start`. The
 * rewrite no-ops silently when there is nothing to strip, so
 * `/cache-optimizer doctor` shows this to make the state visible.
 */
export type PromptRewriteOutcome = {
  /** true: at least one block changed; false: prompt kept byte-for-byte. */
  applied: boolean;
  /** Why the prompt was kept unchanged (only when applied is false). */
  reason?: string;
  /** Number of system prompt blocks OMP handed to the extension. */
  blocks: number;
  at: number;
};

let lastPromptRewriteOutcome: PromptRewriteOutcome | undefined;

export function recordPromptRewriteOutcome(outcome: PromptRewriteOutcome): void {
  lastPromptRewriteOutcome = { ...outcome };
}

export function getLastPromptRewriteOutcome(): PromptRewriteOutcome | undefined {
  return lastPromptRewriteOutcome ? { ...lastPromptRewriteOutcome } : undefined;
}

export function describePromptRewriteOutcome(outcome: PromptRewriteOutcome | undefined = lastPromptRewriteOutcome): string {
  if (!outcome) return "Prompt 重写：本进程还没有构建过 prompt。";
  const when = new Date(outcome.at).toLocaleTimeString();
  if (outcome.applied) return `Prompt 重写：已清理 <session-overview> 易变字段（${outcome.blocks} 个块，${when}）。`;
  return `Prompt 重写：未改动（${outcome.reason ?? "没有可清理的内容"}；${outcome.blocks} 个块，${when}）。`;
}

// ── 系统 prompt 提取/写回（before_provider_request 安全网） ──
//
// 主重写在 before_agent_start（string[] 块）。extractSystemPrompt / withSystemPrompt
// 用于 payload 级 session-overview 兜底 strip 与请求级诊断指纹。payload 形态：
//   - openai-responses / codex / azure: payload.instructions（仅诊断指纹）
//   - openai-completions / openai-responses: payload.messages[] role=system/developer
//   - anthropic-messages: payload.system（字符串或块数组）
//   - google-generative-ai: payload.systemInstruction

export function extractSystemPrompt(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;

  // openai-responses / codex / azure-openai-responses: top-level instructions
  if (typeof record.instructions === "string" && record.instructions.trim().length > 0) {
    return record.instructions;
  }

  // anthropic-messages: payload.system (string or content blocks array)
  const systemField = record.system;
  if (typeof systemField === "string") return systemField;
  if (Array.isArray(systemField)) {
    return systemField
      .map((block) => {
        const r = asRecord(block);
        return typeof r?.text === "string" ? r.text : "";
      })
      .join("\n")
      .trim() || undefined;
  }

  // google-generative-ai: payload.systemInstruction
  const systemInstruction = asRecord(record.systemInstruction);
  if (systemInstruction && Array.isArray(systemInstruction.parts)) {
    const text = systemInstruction.parts
      .map((p) => {
        const r = asRecord(p);
        return typeof r?.text === "string" ? r.text : "";
      })
      .join("\n")
      .trim();
    if (text) return text;
  }

  // openai-completions / openai-responses: payload.messages[] first system message
  if (Array.isArray(record.messages)) {
    for (const msg of record.messages) {
      const r = asRecord(msg);
      if (!r || (r.role !== "system" && r.role !== "developer")) continue;
      if (typeof r.content === "string") return r.content;
      if (Array.isArray(r.content)) {
        const text = r.content
          .map((c) => {
            const cr = asRecord(c);
            return typeof cr?.text === "string" ? cr.text : "";
          })
          .join("\n")
          .trim();
        if (text) return text;
      }
    }
  }

  return undefined;
}

/**
 * Apply `mapText` to every text block of the payload's system prompt and
 * return a copy, or undefined when nothing changed. Unlike a whole-prompt
 * replacement this keeps block boundaries, non-text blocks and metadata
 * (cache_control and friends) exactly where the transport put them. The
 * caller's payload is never mutated.
 */
export function mapSystemPromptText(payload: unknown, mapText: (text: string) => string): unknown | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;

  const mapBlocks = (items: unknown[]): unknown[] | undefined => {
    let changed = false;
    const next = items.map((item) => {
      const block = asRecord(item);
      if (typeof block?.text !== "string") return item;
      const text = mapText(block.text);
      if (text === block.text) return item;
      changed = true;
      return { ...block, text };
    });
    return changed ? next : undefined;
  };

  if (typeof record.system === "string") {
    const text = mapText(record.system);
    return text === record.system ? undefined : { ...record, system: text };
  }
  if (Array.isArray(record.system)) {
    const system = mapBlocks(record.system);
    return system ? { ...record, system } : undefined;
  }

  const systemInstruction = asRecord(record.systemInstruction);
  if (systemInstruction && Array.isArray(systemInstruction.parts)) {
    const parts = mapBlocks(systemInstruction.parts);
    return parts ? { ...record, systemInstruction: { ...systemInstruction, parts } } : undefined;
  }

  if (Array.isArray(record.messages)) {
    let changed = false;
    const messages = record.messages.map((msg) => {
      const r = asRecord(msg);
      if (!r || (r.role !== "system" && r.role !== "developer")) return msg;
      if (typeof r.content === "string") {
        const content = mapText(r.content);
        if (content === r.content) return msg;
        changed = true;
        return { ...r, content };
      }
      if (Array.isArray(r.content)) {
        const content = mapBlocks(r.content);
        if (!content) return msg;
        changed = true;
        return { ...r, content };
      }
      return msg;
    });
    return changed ? { ...record, messages } : undefined;
  }

  return undefined;
}
