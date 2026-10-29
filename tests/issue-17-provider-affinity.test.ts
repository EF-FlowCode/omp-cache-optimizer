import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

let agentDir: string;
let previousAgentDir: string | undefined;
let extension: typeof import("../index.ts");

before(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "omp-cache-issue-17-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const jiti = createJiti(join(process.cwd(), "tests", "issue-17-provider-affinity.test.ts"), {
    interopDefault: false,
    moduleCache: false,
  });
  extension = await jiti.import<typeof import("../index.ts")>(join(process.cwd(), "index.ts"));
});

const model = (id: string, provider = "proxy", compat: Record<string, unknown> = {}, reasoning = false) => ({
  provider,
  id,
  name: id,
  api: "openai-completions",
  baseUrl: "https://proxy.example/v1",
  compat,
  reasoning,
  input: ["text"] as Array<"text" | "image">,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
});

function setup() {
  const hooks = new Map<string, (event: any, ctx: any) => unknown>();
  extension.default({
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      hooks.set(name, handler);
    },
    registerCommand() {},
  } as any);
  const notifications: string[] = [];
  const context = (current: ReturnType<typeof model>) => ({
    model: current,
    hasUI: true,
    sessionManager: { getSessionId: () => "issue-17-session" },
    modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus() {},
    },
  });
  return { hooks, context, notifications };
}

const deepseek = (id: string, compat: Record<string, unknown> = {}, reasoning = true) =>
  model(id, "proxy", compat, reasoning);

const compatWarnings = (notifications: string[]) =>
  notifications.filter((text) => text.includes("requiresReasoningContentForToolCalls"));

test("model-specific diagnostics remain separate within one provider", async () => {
  const { hooks, context, notifications } = setup();
  for (const id of ["deepseek-a", "deepseek-b"]) {
    const current = deepseek(id);
    await hooks.get("turn_start")?.({}, context(current));
  }
  const warnings = compatWarnings(notifications);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((text) => text.includes("proxy/deepseek-a")));
  assert.ok(warnings.some((text) => text.includes("proxy/deepseek-b")));
});

test("the same model is warned once even when the model changes away and back", async () => {
  const { hooks, context, notifications } = setup();
  const a = deepseek("deepseek-dedupe");
  const other = model("plain-model");
  await hooks.get("turn_start")?.({}, context(a));
  await hooks.get("turn_start")?.({}, context(a));
  await hooks.get("turn_start")?.({}, context(other));
  await hooks.get("turn_start")?.({}, context(a));
  const warnings = compatWarnings(notifications);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("proxy/deepseek-dedupe"));
});

test("compat set via model.compat or compatConfig, and non-reasoning or non-DeepSeek models, stay silent", async () => {
  const { hooks, context, notifications } = setup();
  const silent = [
    deepseek("deepseek-runtime-ok", { requiresReasoningContentForToolCalls: true }),
    { ...deepseek("deepseek-config-ok"), compatConfig: { requiresReasoningContentForToolCalls: true } },
    deepseek("deepseek-no-reasoning", {}, false),
    model("mimo-a", "proxy", {}, true),
    model("qwen-b"),
  ];
  for (const current of silent) {
    await hooks.get("turn_start")?.({}, context(current as any));
  }
  assert.equal(notifications.length, 0);
});

test("unrelated provider compat does not invent DeepSeek wire protocol warnings", async () => {
  const { hooks, context, notifications } = setup();
  const current = model("DeepSeek-V4-Flash", "proxy", { supportsReasoningEffort: true, requiresReasoningContentForToolCalls: true }, true);
  await hooks.get("turn_start")?.({}, context(current));
  assert.equal(notifications.length, 0);
});

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});
