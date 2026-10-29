# Repository Guidelines

## Project Overview

OMP Cache Optimizer (npm: `omp-cache-optimizer`) is a TypeScript OMP (Oh My Pi) extension that improves provider-side prompt/KV cache hit rates. It is a fork of [`pi-cache-optimizer`](https://github.com/jiangge/pi-cache-optimizer) adapted for OMP 18. The repository keeps upstream's git history and module layout: catching up means `git merge` of upstream `master`, then re-applying the OMP adaptation per module (see "Syncing with upstream").

## Architecture & Data Flow

```
OMP Runtime (host, Bun-based)
  │
  ├─ session_start          → (top-level only) install cache hints service; background stats restore → footer
  ├─ session_before_switch  → drain in-flight message_end, flush the outgoing session's shard
  ├─ session_switch/_branch → same extension instance, new session: retire shard, reset, background restore
  ├─ turn_start             → model-change detection (OMP has no model_select): compat warning + footer
  ├─ before_agent_start     → optional block-local <session-overview> churn strip (string[] blocks) + cache hint
  ├─ before_provider_request→ tool order (opt-in), Anthropic TTL repair, rewrite safety net,
  │                           prompt_cache_retention gate, prompt_cache_key (omit / inject / replace), prompt diagnostics
  ├─ after_provider_response→ 400/403 rejection evidence (header path)
  ├─ message_end            → error-message evidence, usage → sharded stats, background footer refresh
  ├─ tool_execution_end / agent_end → background footer refresh
  ├─ cache_warming_decision → keep OMP's cache warming for zero-price models
  └─ session_shutdown       → close refresh gate, drain, flush closed shard; top-level only restores process state
```

- **Entry**: `index.ts` — `export default function (pi: ExtensionAPI)` registers hooks and `/cache-optimizer`; `__internals_for_tests` re-exports helpers for the test suite.
- **Modules** (`src/`): `config` (features/env/persisted config), `retention` (OMP_/PI_CACHE_RETENTION truth table, retention gate), `routing` (routing registry, cache hints, prompt_cache_key identity), `request-payload` (payload mutations), `prompt-rewrite`, `compat-config` / `model-identity` / `model-detect` (OMP compat + model family), `compat-advice` / `diagnostics` (user-facing advice), `provider-errors`, `adapters` / `usage` (cache adapters), `stats-store` / `stats-archive` / `stats-refresh` / `stats-fs` / `stats-report` (sharded stats), `cache-warming`, `prompt-cache-key-config` (the only auto-write: extension config with receipt/rollback), `command` / `command-completion`, `tool-ordering`, `request-state`, `atomic-fs`, `paths`, `common`, `fix-types`.
- **Subagents**: OMP binds a separate extension instance to every subagent session (`ctx.agent.kind === "sub"`). Stats aggregate across instances through shards. Process-wide state (cache hints service, `__ompCacheOptimizerCacheKey__`, retention env restore) belongs to the top-level instance only.
- **Stats**: per-instance shards under `<agentDir>/omp-cache-optimizer-stats.d/` (agentDir = `PI_CODING_AGENT_DIR` or `~/.omp/agent`), past days folded into a versioned archive, incremental tiered refresh for the footer. Shard/archive `kind` strings keep upstream's `pi-cache-optimizer-*` format identifiers on purpose. Never persists prompts, payloads, keys or API keys.
- **Inter-extension protocol**: `Symbol.for("omp.routing.registry.v1")` (live routing) and `Symbol.for("omp.cache.hints.v1")` (pre-request hints).

## OMP adaptation rules (what differs from upstream Pi)

- **Host API**: import only types from `@oh-my-pi/pi-coding-agent` (devDependency for typecheck; optional peer). Never value-import the host.
- **Compat**: read `model.compat` (resolved, wins) merged over `model.compatConfig` (user intent) via `getCompat`; `getExplicitCompat` returns `compatConfig` alone. Never parse `models.yml`/`models.json` for compat. OMP names: `supportsLongPromptCacheRetention` (OpenAI Responses), `supportsLongCacheRetention` (Anthropic), `requiresReasoningContentForToolCalls`, `supportsPromptCacheKey` (resolved, Chat Completions). No `sendSessionAffinityHeaders` / `forceAdaptiveThinking`.
- **models.yml is never written.** `/cache-optimizer fix` prints YAML snippets (`buildManualFixLines`). The only automatic write is `fix prompt-cache-key` into the extension's own config (backup → receipt → rollback).
- **Prompt rewrite is off by default** (`OMP_CACHE_OPTIMIZER_PROMPT_REWRITE=1` or `config prompt-rewrite on`); it only strips `<session-overview>` churn block by block, keeping block order and skill text byte-for-byte. No skill compression (OMP has no `systemPromptOptions`).
- **prompt_cache_key**: header `providerPromptCacheKey` > project-stable key for Responses-family APIs > hashed session key for `openai-completions`. Only a missing or session-default key is replaced; custom keys are kept; long keys hash to `pc_` + 48 hex.
- **Environment**: primary prefix `OMP_CACHE_OPTIMIZER_*`, reads fall back to `PI_CACHE_OPTIMIZER_*` (`readEnv`). `OMP_CACHE_RETENTION` is mirrored to `PI_CACHE_RETENTION`, which the host reads.
- **User-facing text is Chinese** (footer, commands, diagnostics, notifications). Code comments may stay English where they come from upstream.
- **Removed upstream features** (no OMP host equivalent): Pi native virtual models, skill compression, session-affinity header bridge, models.json fix/rollback/lint, Kimi base URL fix, promptCache writer, adaptive-thinking compat checks.

## Syncing with upstream

```bash
git remote add pi https://github.com/jiangge/pi-cache-optimizer.git   # once
git fetch pi
git merge pi/master
```

Resolve by keeping the OMP rules above; drop upstream's `.trellis/`, `.pi/`, `.mainline/`, `benchmarks/`, `publish.yml`. Modules that follow upstream almost verbatim (`stats-*`, `atomic-fs`, `tool-ordering`, `usage`, most of `provider-errors`) usually merge cleanly; `index.ts`, `command.ts`, `diagnostics.ts`, `compat-advice.ts`, `config.ts`, `routing.ts` carry the OMP adaptation.

## Development Commands

| Command | Purpose |
|---|---|
| `npm install` | Dev dependencies (TypeScript, jiti, `@oh-my-pi/pi-coding-agent` types) |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm test` | `node --import jiti/register --test tests/*.test.ts` |
| `npm run check` | typecheck + tests + `git diff --check` + module graph + pack check |

No build step: OMP loads `index.ts` and `src/` as TypeScript.

## Testing

- Node's built-in test runner with jiti; tests import `#extension` (`index.ts`) and drive the default export with a fake `ExtensionAPI` that captures handlers.
- Tests isolate state with a temporary `PI_CODING_AGENT_DIR`.
- OMP-specific behavior (session switch on one instance, subagent ownership, prompt_cache_key strategy, retention truth table, block-local rewrite) is covered in `tests/omp-*.test.ts`.

## Forbidden

Logging secrets; writing `models.yml`; persisting prompts, payloads, headers or keys; adapter selection by provider/api alone; throwing from hook paths; value imports from the host package; process-wide side effects from a subagent instance.
