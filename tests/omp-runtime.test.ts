import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createJiti } from "jiti";

// OMP 专属行为（上游 Pi 测试没有覆盖）：prompt_cache_key 策略、prompt 改写开关、
// 同实例会话切换、子代理隔离、compat 合并与提示、message_end 过滤。
// 每个用例在独立的 PI_CODING_AGENT_DIR 下新加载一份扩展模块，互不污染。

const SESSION_ID = "session-omp-runtime";
const RETENTION_ENVS = ["OMP_CACHE_RETENTION", "PI_CACHE_RETENTION"];
const REWRITE_ENVS = ["OMP_CACHE_OPTIMIZER_PROMPT_REWRITE", "PI_CACHE_OPTIMIZER_PROMPT_REWRITE"];
const HINTS_SYMBOL = Symbol.for("omp.cache.hints.v1");

type Handler = (event: any, context: any) => any;
type Status = { key: string; value: string | undefined };

const globals = globalThis as Record<symbol, unknown>;
const envKeys = [...RETENTION_ENVS, ...REWRITE_ENVS, "OMP_CACHE_OPTIMIZER_FOOTER_MODE", "PI_CACHE_OPTIMIZER_FOOTER_MODE"];

// 缓存保留基线在首次加载模块时抓取：先清空，保证基线 = 未设置。
for (const name of envKeys) delete process.env[name];

let loadCounter = 0;

beforeEach(() => {
  for (const name of envKeys) delete process.env[name];
  delete globals[HINTS_SYMBOL];
});

afterEach(() => {
  for (const name of envKeys) delete process.env[name];
  delete globals[HINTS_SYMBOL];
});

type Ext = {
  I: any;
  dir: string;
  handlers: Map<string, Handler>;
  commands: Map<string, { handler: (args: string, ctx: any) => Promise<unknown> }>;
  on(name: string): Handler;
};

async function loadExtension(dir: string): Promise<Ext> {
  const jiti = createJiti(join(process.cwd(), "tests", `omp-runtime-${++loadCounter}.ts`), { interopDefault: false, moduleCache: false });
  const loaded: any = await jiti.import(join(process.cwd(), "index.ts"));
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, any>();
  loaded.default({
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
  });
  return {
    I: loaded.__internals_for_tests,
    dir,
    handlers,
    commands,
    on(name: string) {
      const handler = handlers.get(name);
      assert.ok(handler, `handler ${name} registered`);
      return handler;
    },
  };
}

async function withExtension(run: (ext: Ext) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "omp-runtime-"));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await run(await loadExtension(dir));
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

function makeModel(overrides: Record<string, unknown> = {}): any {
  return {
    provider: "proxy", id: "gpt-5.5", name: "GPT-5.5", api: "openai-completions",
    baseUrl: "https://proxy.example/v1", compat: {}, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192,
    ...overrides,
  };
}

type CtxOptions = {
  sessionId?: string;
  model?: any;
  header?: Record<string, unknown>;
  cwd?: string;
  agent?: { kind: "main" | "sub" };
  mode?: string;
  statuses?: Status[];
  notices?: string[];
};

function makeContext(options: CtxOptions = {}): any {
  const sessionId = options.sessionId ?? SESSION_ID;
  const statuses = options.statuses ?? [];
  const notices = options.notices ?? [];
  const mode = options.mode ?? "json";
  return {
    model: options.model ?? makeModel(),
    cwd: options.cwd ?? "C:/work/project-a",
    mode, hasUI: mode === "tui",
    ...(options.agent ? { agent: options.agent } : {}),
    sessionManager: {
      getSessionId: () => sessionId,
      getHeader: () => options.header,
      getCwd: () => options.cwd ?? "C:/work/project-a",
    },
    modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
    ui: {
      notify(message: string) { notices.push(message); },
      setStatus(key: string, value: string | undefined) { statuses.push({ key, value }); },
      async confirm() { return false; },
      async select() { return undefined; },
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** 调用 before_provider_request：payload 深冻结（原地修改会直接抛错），返回钩子的结果。 */
function request(ext: Ext, payload: Record<string, unknown>, ctx: any): any {
  const snapshot = JSON.stringify(payload);
  const result = ext.on("before_provider_request")({ payload: deepFreeze(payload) }, ctx);
  assert.equal(JSON.stringify(payload), snapshot, "event.payload is never mutated");
  return result;
}

/** 钩子最终生效的 payload：返回 undefined 表示保持原样。 */
function effective(result: any, original: Record<string, unknown>): any {
  return result === undefined ? original : result;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assistantMessage(overrides: Record<string, unknown> = {}): any {
  return {
    role: "assistant", provider: "proxy", model: "gpt-5.5", api: "openai-completions", stopReason: "stop",
    usage: { input: 100, cacheRead: 50, cacheWrite: 0 },
    ...overrides,
  };
}

async function startSession(ext: Ext, ctx: any): Promise<void> {
  await ext.on("session_start")({}, ctx);
  await ext.I.waitForStatsRestore();
}

async function endMessage(ext: Ext, message: unknown, ctx: any): Promise<void> {
  await ext.on("message_end")({ message }, ctx);
  await ext.I.statsRefreshSettled();
}

function requestsOf(shard: any): number {
  return Object.values(shard.models).reduce((sum: number, entry: any) => sum + entry.stats.totalRequests, 0);
}

async function totalRequestsOnDisk(ext: Ext): Promise<number> {
  const shards = await ext.I.readValidStatsShardsV7();
  return shards.reduce((sum: number, shard: any) => sum + requestsOf(shard), 0);
}

// ─────────────────────────────────────────────────────────────
// 1. prompt_cache_key 策略
// ─────────────────────────────────────────────────────────────

describe("prompt_cache_key policy (before_provider_request)", () => {
  const responsesModel = () => makeModel({ api: "openai-responses" });
  const PROJECT_KEY = /^omp-cache-v1-[0-9a-f]{48}$/;

  test("openai-responses without a key gets the stable project-level key", async () => {
    await withExtension(async (ext) => {
      const ctx = makeContext({ model: responsesModel() });
      const original = { input: "hi" };
      const result = request(ext, original, ctx);
      assert.match(result.prompt_cache_key, PROJECT_KEY);
      assert.equal(result.input, "hi");
      assert.ok(!("prompt_cache_key" in original), "the host's payload object is untouched");
      // 同项目、同模型、不同会话共享同一个 key。
      const other = request(ext, { input: "hi" }, makeContext({ model: responsesModel(), sessionId: "another-session" }));
      assert.equal(other.prompt_cache_key, result.prompt_cache_key);
      // 不同项目目录得到不同 key。
      const otherProject = request(ext, { input: "hi" }, makeContext({ model: responsesModel(), cwd: "C:/work/project-b" }));
      assert.notEqual(otherProject.prompt_cache_key, result.prompt_cache_key);
    });
  });

  test("a key equal to the raw sessionId is replaced", async () => {
    await withExtension(async (ext) => {
      const ctx = makeContext({ model: responsesModel() });
      const result = request(ext, { input: "hi", prompt_cache_key: SESSION_ID }, ctx);
      assert.match(result.prompt_cache_key, PROJECT_KEY);
    });
  });

  test("a key equal to the pc_-normalized (hashed) overlong sessionId is replaced", async () => {
    await withExtension(async (ext) => {
      const longSession = "s".repeat(90);
      const normalized = `pc_${sha256Hex(longSession).slice(0, 48)}`;
      const ctx = makeContext({ model: responsesModel(), sessionId: longSession });
      for (const key of [longSession, normalized]) {
        const result = request(ext, { input: "hi", prompt_cache_key: key }, ctx);
        assert.match(result.prompt_cache_key, PROJECT_KEY, `replaced: ${key.slice(0, 8)}`);
      }
    });
  });

  test("a key equal to our own hashed session key is replaced on Responses", async () => {
    await withExtension(async (ext) => {
      const ctx = makeContext({ model: responsesModel() });
      const result = request(ext, { input: "hi", prompt_cache_key: ext.I.derivePromptCacheKey(SESSION_ID) }, ctx);
      assert.match(result.prompt_cache_key, PROJECT_KEY);
    });
  });

  test("a custom key is preserved, in either spelling", async () => {
    await withExtension(async (ext) => {
      for (const model of [responsesModel(), makeModel()]) {
        const ctx = makeContext({ model });
        const snake = { input: "x", prompt_cache_key: "my-own-key" };
        assert.equal(effective(request(ext, snake, ctx), snake).prompt_cache_key, "my-own-key");
        const camel = { input: "x", promptCacheKey: "my-own-key" };
        const out = effective(request(ext, camel, ctx), camel);
        assert.equal(out.promptCacheKey, "my-own-key");
        assert.ok(!("prompt_cache_key" in out), "no second field is added next to a camelCase key");
      }
    });
  });

  test("conflicting snake_case and camelCase keys are both left alone", async () => {
    await withExtension(async (ext) => {
      const ctx = makeContext({ model: responsesModel() });
      const payload = { input: "x", prompt_cache_key: SESSION_ID, promptCacheKey: "different" };
      const out = effective(request(ext, payload, ctx), payload);
      assert.equal(out.prompt_cache_key, SESSION_ID);
      assert.equal(out.promptCacheKey, "different");
    });
  });

  test("the session header's providerPromptCacheKey wins over project and session keys", async () => {
    await withExtension(async (ext) => {
      const header = { providerPromptCacheKey: "pinned-by-user" };
      for (const model of [responsesModel(), makeModel()]) {
        const ctx = makeContext({ model, header });
        assert.equal(request(ext, { input: "x" }, ctx).prompt_cache_key, "pinned-by-user");
        // 原始 sessionId 形式的默认 key 也被换成 header key。
        assert.equal(request(ext, { input: "x", prompt_cache_key: SESSION_ID }, ctx).prompt_cache_key, "pinned-by-user");
      }
    });
  });

  test("openai-completions without a key gets omp-<32hex>; the raw sessionId never appears", async () => {
    await withExtension(async (ext) => {
      const ctx = makeContext();
      const result = request(ext, { messages: [{ role: "user", content: "hi" }] }, ctx);
      assert.match(result.prompt_cache_key, /^omp-[0-9a-f]{32}$/);
      assert.equal(result.prompt_cache_key, `omp-${sha256Hex(SESSION_ID).slice(0, 32)}`);
      assert.ok(!JSON.stringify(result).includes(SESSION_ID));
      // 不同会话不同 key（按会话隔离）。
      const other = request(ext, { messages: [] }, makeContext({ sessionId: "second" }));
      assert.notEqual(other.prompt_cache_key, result.prompt_cache_key);
      // 原始 sessionId 形式的 key 被换成哈希 key。
      const replaced = request(ext, { messages: [], prompt_cache_key: SESSION_ID }, ctx);
      assert.equal(replaced.prompt_cache_key, result.prompt_cache_key);
    });
  });

  test("an overlong key is hashed to pc_ + 48 hex instead of being cut", async () => {
    await withExtension(async (ext) => {
      const longKey = "k".repeat(100);
      const ctx = makeContext({ header: { providerPromptCacheKey: longKey } });
      const result = request(ext, { messages: [] }, ctx);
      assert.equal(result.prompt_cache_key, `pc_${sha256Hex(longKey).slice(0, 48)}`);
      assert.equal(result.prompt_cache_key.length, 51);
      // 只差尾部的两个长 key 不会碰撞。
      const sibling = request(ext, { messages: [] }, makeContext({ header: { providerPromptCacheKey: `${longKey}x` } }));
      assert.notEqual(sibling.prompt_cache_key, result.prompt_cache_key);
    });
  });

  test("per-model omit removes both spellings and wins over injection", async () => {
    await withExtension(async (ext) => {
      ext.I.setPersistedCacheOptimizerConfig({ version: 3, promptCacheKey: { omit: ["proxy/gpt-5.5"] } });
      for (const model of [makeModel(), responsesModel()]) {
        const ctx = makeContext({ model });
        const both = { input: "x", prompt_cache_key: "a", promptCacheKey: "b", keep: 1 };
        const out = effective(request(ext, both, ctx), both);
        assert.ok(!("prompt_cache_key" in out) && !("promptCacheKey" in out));
        assert.equal(out.keep, 1);
        const none = { input: "x" };
        const untouched = effective(request(ext, none, ctx), none);
        assert.ok(!("prompt_cache_key" in untouched), "no key is injected for an omitted model");
      }
      // 其他模型不受影响。
      const other = request(ext, { input: "x" }, makeContext({ model: makeModel({ id: "gpt-5.4" }) }));
      assert.match(other.prompt_cache_key, /^omp-[0-9a-f]{32}$/);
    });
  });

  test("a disabled optimizer injects nothing", async () => {
    await withExtension(async (ext) => {
      ext.I.setRuntimeOptimizerEnabled(false);
      for (const model of [makeModel(), responsesModel()]) {
        const payload = { input: "x" };
        const out = effective(request(ext, payload, makeContext({ model })), payload);
        assert.ok(!("prompt_cache_key" in out));
      }
    });
  });

  test("non OpenAI-compatible APIs are not given a key", async () => {
    await withExtension(async (ext) => {
      const payload = { messages: [] };
      const out = effective(request(ext, payload, makeContext({ model: makeModel({ api: "anthropic-messages" }) })), payload);
      assert.ok(!("prompt_cache_key" in out));
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 3. prompt 改写
// ─────────────────────────────────────────────────────────────

describe("prompt rewrite (default off, <session-overview> only)", () => {
  const OVERVIEW =
    "<session-overview>\n## PATHS\nroot\n## RECENT COMMITS\nabc123 fix\ndef456 feat\n\n## NEXT\nstable\nWorking directory: 3 uncommitted\nLine count: 12 / 2000\n</session-overview>";
  const blocks = () => [
    "You are a coding agent.\n\n  keep   spacing\texactly ",
    `Context follows:\n${OVERVIEW}\ntail`,
    "<skills>\n- a: does a\n- b: does b\n</skills>",
  ];

  test("off by default: before_agent_start returns {} and the event is untouched", async () => {
    await withExtension(async (ext) => {
      const event = { systemPrompt: deepFreeze(blocks()) };
      const result = await ext.on("before_agent_start")(event, makeContext());
      assert.deepEqual(result, {});
      assert.deepEqual(event.systemPrompt, blocks());
    });
  });

  for (const name of ["OMP_CACHE_OPTIMIZER_PROMPT_REWRITE", "PI_CACHE_OPTIMIZER_PROMPT_REWRITE"]) {
    test(`${name}=1 strips only the <session-overview> block, keeping the other blocks verbatim`, async () => {
      await withExtension(async (ext) => {
        process.env[name] = "1";
        const original = blocks();
        const event = { systemPrompt: deepFreeze(blocks()) };
        const result = await ext.on("before_agent_start")(event, makeContext());
        assert.ok(Array.isArray(result.systemPrompt), "returns { systemPrompt: string[] }");
        assert.equal(result.systemPrompt.length, original.length, "block count is preserved");
        assert.equal(result.systemPrompt[0], original[0], "unrelated block is byte-identical");
        assert.equal(result.systemPrompt[2], original[2], "skills block is byte-identical");
        const rewritten = result.systemPrompt[1] as string;
        assert.notEqual(rewritten, original[1]);
        assert.ok(rewritten.startsWith("Context follows:\n<session-overview>") && rewritten.endsWith("</session-overview>\ntail"));
        assert.ok(!rewritten.includes("RECENT COMMITS") && !rewritten.includes("Working directory:") && !rewritten.includes("Line count:"));
        assert.ok(rewritten.includes("## PATHS\nroot") && rewritten.includes("## NEXT\nstable"), "stable fields survive");
        // 输入没有被原地修改。
        assert.deepEqual(event.systemPrompt, original);
      });
    });
  }

  test("enabled but nothing to strip: returns {}", async () => {
    await withExtension(async (ext) => {
      process.env.OMP_CACHE_OPTIMIZER_PROMPT_REWRITE = "1";
      const result = await ext.on("before_agent_start")({ systemPrompt: ["plain", "blocks"] }, makeContext());
      assert.deepEqual(result, {});
    });
  });

  test("the rewrite also applies to Responses models", async () => {
    await withExtension(async (ext) => {
      process.env.OMP_CACHE_OPTIMIZER_PROMPT_REWRITE = "1";
      const result = await ext.on("before_agent_start")({ systemPrompt: blocks() }, makeContext({ model: makeModel({ api: "openai-responses" }) }));
      assert.ok(!result.systemPrompt[1].includes("RECENT COMMITS"));
    });
  });

  test("a disabled optimizer never rewrites, even with the env flag", async () => {
    await withExtension(async (ext) => {
      process.env.OMP_CACHE_OPTIMIZER_PROMPT_REWRITE = "1";
      ext.I.setRuntimeOptimizerEnabled(false);
      const result = await ext.on("before_agent_start")({ systemPrompt: blocks() }, makeContext());
      assert.deepEqual(result, {});
    });
  });

  test("before_provider_request fallback keeps the Anthropic system block array and cache_control", async () => {
    await withExtension(async (ext) => {
      process.env.OMP_CACHE_OPTIMIZER_PROMPT_REWRITE = "1";
      const ctx = makeContext({ model: makeModel({ api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-5-5" }) });
      const payload = {
        model: "claude-sonnet-5-5",
        system: [
          { type: "text", text: "static block" },
          { type: "text", text: `ctx\n${OVERVIEW}`, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: "hi" }],
      };
      const result = request(ext, payload, ctx);
      assert.ok(Array.isArray(result.system) && result.system.length === 2);
      assert.deepEqual(result.system[0], { type: "text", text: "static block" });
      assert.deepEqual(result.system[1].cache_control, { type: "ephemeral" });
      assert.ok(!result.system[1].text.includes("RECENT COMMITS"));
      assert.ok(result.system[1].text.startsWith("ctx\n<session-overview>"));
      assert.deepEqual(result.messages, payload.messages);
    });
  });

  test("before_provider_request fallback is inert while the rewrite is off", async () => {
    await withExtension(async (ext) => {
      const ctx = makeContext({ model: makeModel({ api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-5-5" }) });
      const payload = { system: [{ type: "text", text: OVERVIEW }], messages: [] };
      assert.equal(request(ext, payload, ctx), undefined);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 4. 会话生命周期
// ─────────────────────────────────────────────────────────────

describe("session lifecycle on one reused extension instance", () => {
  test("session_switch records usage under the new session; the old session keeps its own count", async () => {
    await withExtension(async (ext) => {
      const statuses: Status[] = [];
      const one = makeContext({ sessionId: "session-one", statuses });
      const two = makeContext({ sessionId: "session-two", statuses });
      await startSession(ext, one);
      await endMessage(ext, assistantMessage(), one);
      await endMessage(ext, assistantMessage(), one);
      await ext.on("session_before_switch")({ reason: "new" }, one);
      await ext.on("session_switch")({ reason: "new" }, two);
      await ext.I.waitForStatsRestore();
      await endMessage(ext, assistantMessage(), two);

      const last = statuses.filter((s) => s.key === "omp-cache-stats").at(-1)?.value ?? "";
      assert.match(last, /缓存请求命中次数：1\/1 次/, "session footer counts only the new session");

      await ext.on("session_shutdown")({}, two);
      const shards = await ext.I.readValidStatsShardsV7();
      const byHash = new Map<string, number>(shards.map((shard: any) => [shard.sessionHash, requestsOf(shard)] as [string, number]));
      assert.equal(byHash.get(ext.I.hashSessionId("session-one")), 2);
      assert.equal(byHash.get(ext.I.hashSessionId("session-two")), 1);
    });
  });

  test("a message_end still in flight at switch time is recorded under the old session", async () => {
    await withExtension(async (ext) => {
      const one = makeContext({ sessionId: "session-one" });
      const two = makeContext({ sessionId: "session-two" });
      await startSession(ext, one);
      await endMessage(ext, assistantMessage(), one);
      // 宿主不等待 message_end：处理还没结束就切会话（没有 session_before_switch）。
      const inFlight = ext.on("message_end")({ message: assistantMessage() }, one);
      await ext.on("session_switch")({ reason: "resume" }, two);
      await inFlight;
      await ext.I.waitForStatsRestore();
      await endMessage(ext, assistantMessage(), two);

      await ext.on("session_shutdown")({}, two);
      const shards = await ext.I.readValidStatsShardsV7();
      const byHash = new Map<string, number>(shards.map((shard: any) => [shard.sessionHash, requestsOf(shard)] as [string, number]));
      assert.equal(byHash.get(ext.I.hashSessionId("session-one")), 2, "the in-flight request belongs to session one");
      assert.equal(byHash.get(ext.I.hashSessionId("session-two")), 1);
    });
  });

  test("a message_end whose ctx already reports a new session id does not switch the counters; turn_start does", async () => {
    await withExtension(async (ext) => {
      const one = makeContext({ sessionId: "session-one" });
      const two = makeContext({ sessionId: "session-two" });
      await startSession(ext, one);
      await endMessage(ext, assistantMessage(), one);
      // 没有显式切换事件：ctx 已换成新 session，但计数仍留在旧 session。
      await endMessage(ext, assistantMessage(), two);
      // 下一个 turn_start 兜底切换（先 retire 旧分片）。
      await ext.on("turn_start")({}, two);
      await ext.I.waitForStatsRestore();
      await endMessage(ext, assistantMessage(), two);
      await ext.on("session_shutdown")({}, two);
      const shards = await ext.I.readValidStatsShardsV7();
      const byHash = new Map<string, number>(shards.map((shard: any) => [shard.sessionHash, requestsOf(shard)] as [string, number]));
      assert.equal(byHash.get(ext.I.hashSessionId("session-one")), 2, "the early message stays with the old session");
      assert.equal(byHash.get(ext.I.hashSessionId("session-two")), 1);
    });
  });

  test("turn_start publishes the footer only when the model changes", async () => {
    await withExtension(async (ext) => {
      const statuses: Status[] = [];
      const modelA = makeModel();
      const modelB = makeModel({ id: "gpt-5.4", name: "GPT-5.4" });
      const ctxA = makeContext({ statuses, model: modelA });
      await startSession(ext, ctxA);
      await endMessage(ext, assistantMessage({ usage: { input: 1200, cacheRead: 800, cacheWrite: 0 } }), ctxA);
      await endMessage(ext, assistantMessage({ usage: { input: 3000, cacheRead: 0, cacheWrite: 0 } }), ctxA);
      await ext.on("turn_start")({}, ctxA);
      const published = statuses.filter((s) => s.key === "omp-cache-stats");
      assert.ok(published.length > 0);
      assert.ok(statuses.every((s) => s.key === "omp-cache-stats"), "only the omp-cache-stats key is used");

      // 800 / (2000 + 3000) = 16%，一次命中 / 两次请求，缓存 800 / 总输入 5.00k。
      const text = published.at(-1)!.value!;
      assert.match(text, /^OpenAI Cache \| 缓存命中率：16% \|/);
      assert.match(text, /最近2次token命中率：16%/);
      assert.match(text, /缓存请求命中次数：1\/2 次/);
      assert.match(text, /缓存token\/总输入：800\/5\.00k$/);

      // 让下一次发布与当前文案不同，才能观察"是否发布"。
      ext.I.setRuntimeOptimizerEnabled(false);
      const before = statuses.length;
      await ext.on("turn_start")({}, ctxA);
      assert.equal(statuses.length, before, "same model: no republish");

      await ext.on("turn_start")({}, makeContext({ statuses, model: modelB }));
      assert.ok(statuses.length > before, "model changed: footer republished");
      const after = statuses.at(-1)!;
      assert.equal(after.key, "omp-cache-stats");
      assert.ok(after.value!.startsWith("缓存优化已关闭 · OpenAI Cache | "), after.value);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 5. 子代理
// ─────────────────────────────────────────────────────────────

describe("subagent instances", () => {
  test("a subagent neither installs nor removes the top-level cache hints service or retention env", async () => {
    await withExtension(async (main) => {
      const mainCtx = makeContext({ agent: { kind: "main" } });
      assert.equal(globals[HINTS_SYMBOL], undefined, "no service before the top-level session starts");
      await startSession(main, mainCtx);
      const service = globals[HINTS_SYMBOL] as any;
      assert.ok(service && typeof service.getHints === "function", "top-level session_start installs the service");
      assert.equal(service.version, 1);
      assert.equal(process.env.OMP_CACHE_RETENTION, "long");
      assert.equal(process.env.PI_CACHE_RETENTION, "long");

      const sub = await loadExtension(main.dir);
      const subCtx = makeContext({ sessionId: "sub-session", agent: { kind: "sub" } });
      await startSession(sub, subCtx);
      assert.equal(globals[HINTS_SYMBOL], service, "a subagent does not replace the service");

      process.env.OMP_CACHE_RETENTION = "none";
      process.env.PI_CACHE_RETENTION = "none";
      await sub.on("session_shutdown")({}, subCtx);
      assert.equal(globals[HINTS_SYMBOL], service, "a subagent shutdown keeps the service");
      assert.equal(process.env.OMP_CACHE_RETENTION, "none", "OMP_CACHE_RETENTION is not restored by a subagent");
      assert.equal(process.env.PI_CACHE_RETENTION, "none", "PI_CACHE_RETENTION is not restored by a subagent");

      await main.on("session_shutdown")({}, mainCtx);
      assert.equal(globals[HINTS_SYMBOL], undefined, "the top-level shutdown removes its service");
      assert.equal(process.env.OMP_CACHE_RETENTION, undefined, "and restores the startup snapshot");
      assert.equal(process.env.PI_CACHE_RETENTION, undefined);
    });
  });

  test("a subagent alone never installs the hints service", async () => {
    await withExtension(async (ext) => {
      const ctx = makeContext({ agent: { kind: "sub" } });
      await startSession(ext, ctx);
      assert.equal(globals[HINTS_SYMBOL], undefined);
      await ext.on("session_shutdown")({}, ctx);
    });
  });

  test("an instance without ctx.agent is the top-level one", async () => {
    await withExtension(async (ext) => {
      const ctx = makeContext();
      await startSession(ext, ctx);
      assert.ok(globals[HINTS_SYMBOL]);
      await ext.on("session_shutdown")({}, ctx);
      assert.equal(globals[HINTS_SYMBOL], undefined);
    });
  });

  test("a subagent gets no compat reminder on turn_start", async () => {
    await withExtension(async (ext) => {
      const deepseek = makeModel({ provider: "ds", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true });
      const subNotices: string[] = [];
      const subCtx = makeContext({ model: deepseek, agent: { kind: "sub" }, notices: subNotices });
      await startSession(ext, subCtx);
      await ext.on("turn_start")({}, subCtx);
      assert.deepEqual(subNotices, []);

      await withExtension(async (top) => {
        const notices: string[] = [];
        const ctx = makeContext({ model: deepseek, notices });
        await startSession(top, ctx);
        await top.on("turn_start")({}, ctx);
        assert.equal(notices.length, 1, "the top-level instance does warn");
        assert.match(notices[0], /requiresReasoningContentForToolCalls/);
        await top.on("turn_start")({}, ctx);
        assert.equal(notices.length, 1, "and only once per model");
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 6. compat
// ─────────────────────────────────────────────────────────────

describe("compat resolution and hints", () => {
  const deepseek = (compat: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    makeModel({ provider: "ds", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, compat, ...extra });

  test("getCompat merges compatConfig and compat, compat winning; getExplicitCompat is compatConfig only", async () => {
    await withExtension(async (ext) => {
      const model = makeModel({
        compatConfig: { supportsLongPromptCacheRetention: true, supportsStore: true, extraBody: { a: 1, shared: "config" } },
        compat: { supportsLongPromptCacheRetention: false, supportsDeveloperRole: true, extraBody: { b: 2, shared: "compat" } },
      });
      const merged = ext.I.getCompat(model);
      assert.equal(merged.supportsLongPromptCacheRetention, false, "compat overrides compatConfig");
      assert.equal(merged.supportsStore, true, "config-only keys survive");
      assert.equal(merged.supportsDeveloperRole, true, "compat-only keys survive");
      assert.deepEqual(merged.extraBody, { a: 1, b: 2, shared: "compat" });
      assert.deepEqual(ext.I.getExplicitCompat(model), model.compatConfig);
      assert.deepEqual(ext.I.getCompat(undefined), {});
      assert.deepEqual(ext.I.getCompat(makeModel({ compat: undefined })), {});
    });
  });

  test("a DeepSeek reasoning model without requiresReasoningContentForToolCalls gets a fix suggestion", async () => {
    await withExtension(async (ext) => {
      const suggestion = ext.I.buildFixSuggestion(deepseek());
      assert.ok(suggestion);
      assert.equal(suggestion.providerLabel, "ds");
      assert.equal(suggestion.modelId, "deepseek-v4-pro");
      assert.equal(suggestion.compatKeys.requiresReasoningContentForToolCalls, true);
      for (const key of ["sendSessionAffinityHeaders", "sessionAffinityFormat", "forceAdaptiveThinking", "maxTokensField"]) {
        assert.ok(!(key in suggestion.compatKeys), `${key} does not exist on OMP`);
      }
      // compat 已配置（任一层）则不再提示。
      assert.equal(ext.I.buildFixSuggestion(deepseek({ requiresReasoningContentForToolCalls: true })), undefined);
      assert.equal(ext.I.buildFixSuggestion(deepseek({}, { compatConfig: { requiresReasoningContentForToolCalls: true } })), undefined);
      // 非推理模型或非 completions API 不适用。
      assert.equal(ext.I.buildFixSuggestion(deepseek({}, { reasoning: false })), undefined);
      assert.equal(ext.I.buildFixSuggestion(deepseek({}, { api: "openai-responses" })), undefined);
    });
  });

  test("the footer carries ' ⚠️ 配置' while a safe compat gap exists, and loses it once fixed", async () => {
    await withExtension(async (ext) => {
      const statuses: Status[] = [];
      const gap = makeContext({ statuses, model: deepseek() });
      await startSession(ext, gap);
      await endMessage(ext, assistantMessage({ provider: "ds", model: "deepseek-v4-pro" }), gap);
      assert.ok(statuses.at(-1)!.value!.endsWith(" ⚠️ 配置"), statuses.at(-1)!.value);

      await withExtension(async (clean) => {
        const cleanStatuses: Status[] = [];
        const ctx = makeContext({ statuses: cleanStatuses, model: deepseek({ requiresReasoningContentForToolCalls: true }) });
        await startSession(clean, ctx);
        await endMessage(clean, assistantMessage({ provider: "ds", model: "deepseek-v4-pro" }), ctx);
        assert.ok(!cleanStatuses.at(-1)!.value!.includes("⚠️ 配置"), cleanStatuses.at(-1)!.value);
      });
    });
  });

  async function listFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.map((entry) => join(entry.parentPath ?? dir, entry.name)).sort();
  }

  test("/cache-optimizer fix prints a YAML snippet and writes no file", async () => {
    await withExtension(async (ext) => {
      const before = await listFiles(ext.dir);
      const notices: string[] = [];
      const ctx = makeContext({ model: deepseek(), notices });
      const command = ext.commands.get("cache-optimizer");
      assert.ok(command);
      await command.handler("fix", ctx);
      const text = notices.join("\n");
      assert.match(text, /requiresReasoningContentForToolCalls: true/);
      assert.match(text, /compat:/);
      assert.match(text, /提供方：ds/);
      assert.match(text, /不会自动改写 models\.yml/);
      assert.deepEqual(await listFiles(ext.dir), before, "nothing was written under the agent dir");
    });
  });

  test("/cache-optimizer fix reports nothing to fix when compat is complete", async () => {
    await withExtension(async (ext) => {
      const notices: string[] = [];
      await ext.commands.get("cache-optimizer")!.handler("fix", makeContext({ model: deepseek({ requiresReasoningContentForToolCalls: true }), notices }));
      assert.match(notices.join("\n"), /无需修复/);
    });
  });

  describe("prompt_cache_retention gate", () => {
    const thirdParty = (compat: Record<string, unknown>) =>
      makeModel({ api: "openai-responses", baseUrl: "https://relay.example/v1", compat });
    const withRetention = () => ({ input: "x", prompt_cache_retention: "24h" });

    test("kept on a third-party Responses endpoint when compat.supportsLongPromptCacheRetention is true", async () => {
      await withExtension(async (ext) => {
        const ctx = makeContext({ model: thirdParty({ supportsLongPromptCacheRetention: true }) });
        const payload = withRetention();
        assert.equal(effective(request(ext, payload, ctx), payload).prompt_cache_retention, "24h");
      });
    });

    test("compatConfig opt-in counts, and compat can override it away", async () => {
      await withExtension(async (ext) => {
        const viaConfig = makeContext({ model: makeModel({ api: "openai-responses", baseUrl: "https://relay.example/v1", compatConfig: { supportsLongPromptCacheRetention: true } }) });
        const payload = withRetention();
        assert.equal(effective(request(ext, payload, viaConfig), payload).prompt_cache_retention, "24h");

        const overridden = makeContext({ model: makeModel({ api: "openai-responses", baseUrl: "https://relay.example/v1", compatConfig: { supportsLongPromptCacheRetention: true }, compat: { supportsLongPromptCacheRetention: false } }) });
        assert.ok(!("prompt_cache_retention" in request(ext, withRetention(), overridden)));
      });
    });

    test("removed on an unverified third-party endpoint without opt-in", async () => {
      await withExtension(async (ext) => {
        const out = request(ext, withRetention(), makeContext({ model: thirdParty({}) }));
        assert.ok(!("prompt_cache_retention" in out));
        assert.equal(out.input, "x");
      });
    });

    test("kept on the official OpenAI endpoint", async () => {
      await withExtension(async (ext) => {
        const ctx = makeContext({ model: makeModel({ api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1" }) });
        const payload = withRetention();
        assert.equal(effective(request(ext, payload, ctx), payload).prompt_cache_retention, "24h");
      });
    });

    test("stripped for the model after a 400 rejection is observed", async () => {
      await withExtension(async (ext) => {
        const model = thirdParty({ supportsLongPromptCacheRetention: true });
        const notices: string[] = [];
        const ctx = makeContext({ model, notices });
        const first = withRetention();
        assert.equal(effective(request(ext, first, ctx), first).prompt_cache_retention, "24h", "kept before any rejection");

        await ext.on("after_provider_response")({ status: 400, headers: { "x-error": "Unsupported parameter: prompt_cache_retention" } }, ctx);
        assert.ok(notices.some((message) => message.includes("prompt_cache_retention")), "the rejection is announced once");
        const second = request(ext, withRetention(), ctx);
        assert.ok(!("prompt_cache_retention" in second), "removed after the rejection");
        // 其他模型不受影响。
        const other = makeContext({ model: makeModel({ id: "other", api: "openai-responses", baseUrl: "https://relay.example/v1", compat: { supportsLongPromptCacheRetention: true } }) });
        const otherPayload = withRetention();
        assert.equal(effective(request(ext, otherPayload, other), otherPayload).prompt_cache_retention, "24h");
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 7. message_end
// ─────────────────────────────────────────────────────────────

describe("message_end counting", () => {
  async function counted(messages: unknown[]): Promise<number> {
    let total = -1;
    await withExtension(async (ext) => {
      const ctx = makeContext();
      await startSession(ext, ctx);
      for (const message of messages) await endMessage(ext, message, ctx);
      await ext.on("session_shutdown")({}, ctx);
      total = await totalRequestsOnDisk(ext);
    });
    return total;
  }

  test("error and aborted messages without usage are not counted", async () => {
    assert.equal(await counted([
      assistantMessage({ stopReason: "error", errorMessage: "network down", usage: undefined }),
      assistantMessage({ stopReason: "aborted", usage: undefined }),
      assistantMessage({ stopReason: "error", errorMessage: "boom", usage: { input: 0, cacheRead: 0, cacheWrite: 0 } }),
      assistantMessage({ stopReason: "aborted", usage: { input: 0, cacheRead: 0, cacheWrite: 0 } }),
    ]), 0);
  });

  test("an aborted message that carries usage is counted", async () => {
    assert.equal(await counted([
      assistantMessage({ stopReason: "aborted", usage: { input: 100, cacheRead: 50, cacheWrite: 0 } }),
    ]), 1);
  });

  test("a normal message is counted, alongside ignored failed attempts", async () => {
    assert.equal(await counted([
      assistantMessage({ stopReason: "error", errorMessage: "retry me", usage: undefined }),
      assistantMessage(),
      assistantMessage(),
    ]), 2);
  });

  test("user and tool-result messages are neither counted nor sampled as missing usage", async () => {
    await withExtension(async (ext) => {
      const notices: string[] = [];
      const ctx = makeContext({ notices });
      await startSession(ext, ctx);
      // OMP 对用户消息和工具结果也发 message_end；它们没有 provider usage。
      await endMessage(ext, { role: "user", content: [{ type: "text", text: "hi" }] }, ctx);
      await endMessage(ext, assistantMessage(), ctx);
      await endMessage(ext, { role: "toolResult", toolCallId: "t1", toolName: "read", content: [], isError: false }, ctx);
      await ext.I.statsRefreshSettled();
      await ext.commands.get("cache-optimizer")!.handler("stats", ctx);
      const stats = notices.at(-1) ?? "";
      assert.match(stats, /最近 1\/10 次：1\/1 次命中/, stats);
      assert.doesNotMatch(stats, /usage 缺失/, stats);
      await ext.on("session_shutdown")({}, ctx);
      assert.equal(await totalRequestsOnDisk(ext), 1);
    });
  });

  test("modelFromAssistantMessage recognizes OMP's upstreamModel", async () => {
    await withExtension(async (ext) => {
      const fallback = makeModel({ id: "router-alias" });
      const only = ext.I.modelFromAssistantMessage({ role: "assistant", provider: "proxy", api: "openai-completions", upstreamModel: "deepseek-v4" }, fallback);
      assert.equal(only.id, "deepseek-v4", "upstreamModel names the model that actually served");
      // 非目录归属模式：upstreamModel 先于 model；responseModel 先于 upstreamModel。
      const both = { role: "assistant", provider: "proxy", api: "openai-completions", model: "alias", upstreamModel: "real" };
      assert.equal(ext.I.modelFromAssistantMessage(both, fallback).id, "real");
      assert.equal(ext.I.modelFromAssistantMessage({ ...both, responseModel: "response" }, fallback).id, "response");
      // 目录归属模式：dispatched model 优先，upstreamModel 只补缺。
      assert.equal(ext.I.modelFromAssistantMessage(both, fallback, true).id, "alias");
      assert.equal(ext.I.modelFromAssistantMessage({ ...both, model: undefined }, fallback, true).id, "real");
    });
  });

  test("usage is attributed to the upstreamModel when the message has no model of its own", async () => {
    await withExtension(async (ext) => {
      const ctx = makeContext({ model: makeModel({ provider: "router", id: "auto", name: "Auto" }) });
      await startSession(ext, ctx);
      await endMessage(ext, assistantMessage({ provider: "router", model: undefined, upstreamModel: "gpt-5.4" }), ctx);
      await ext.on("session_shutdown")({}, ctx);
      const shards = await ext.I.readValidStatsShardsV7();
      const keys = shards.flatMap((shard: any) => Object.keys(shard.models));
      assert.ok(keys.some((key: string) => key.includes("gpt-5.4")), `models: ${keys.join(", ")}`);
    });
  });
});
