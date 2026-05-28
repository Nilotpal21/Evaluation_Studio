# Conversation Testing Integration — Design

**Date:** 2026-04-19
**Status:** Implemented (see §15 for post-design updates)
**Author:** Rakshak Kundarapu
**Related source project:** `/home/Rakshak.Kundarapu/Documents/Projects/abl-conversation-testing` (reference-only)

---

## 1. Problem & Context

`scripts/generate-insights-data.ts` (307 lines) replays **10 hardcoded conversations** against a deployed agent, ends each session, and lets the insights pipelines (sentiment, intent, quality, friction, hallucination, etc.) process them. The output populates dashboards during local dev.

Problems with the current shape:

- **Stale variety.** Same 10 scripted conversations every run → insights pipelines see the same patterns → dashboards look flat.
- **Domain-locked.** Conversations are hardcoded for an Apple-support-style bot. Running against any other bot produces off-topic data.
- **No intent coverage guarantee.** Scripts cluster on a few intents; sentiment/quality/friction pipelines under-exercise.

The standalone project at `abl-conversation-testing` solves scenario generation via LLM-driven personas and turn-by-turn user simulation. We want that capability **inside `abl-platform`**, scoped to dev-only use, so insights seeding produces diverse realistic data with minimal input.

## 2. Goals

**In scope:**

1. Rewrite `scripts/generate-insights-data.ts` so it runs **N LLM-driven conversations** against a single bot per invocation.
2. Extract reusable logic into a new workspace package `scripts/conversation-testing/` (one future-proof library, one current caller).
3. Drive everything from env vars — no YAML, no `commander`-style CLI flags.
4. Distribute scenarios across the bot's inferred intents for richer pipeline coverage.
5. Support three LLM providers (Anthropic default, OpenAI, OpenAI-compatible custom).
6. Run conversations in parallel with bounded concurrency.

**Out of scope (dropped from the source project):**

- Web dashboard (Express + React).
- Server-Sent-Event run-manager.
- Per-conversation summarizer (platform pipelines already classify).
- YAML config parser.
- `commander`-based CLI wrapper.
- Multi-bot batch mode in one invocation (caller can shell-loop).
- LLM-driven probe discovery of bot capabilities (deferred — see §12).

## 3. Key Decisions

| #   | Decision                                                                                                                                                                           | Rationale                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Placement: **workspace package at `scripts/conversation-testing/`**                                                                                                                | `scripts/` precedent is flat operational scripts; a multi-file sub-project becomes a workspace package to scope its deps. Same pattern as `tools/helix-replay/`.                                                                    |
| D2  | Reuse depth: **pragmatic middle** — reuse `@agent-platform/shared/websocket-auth` for WS subprotocol and `@abl/compiler/platform` for logger. Keep hand-rolled LLM + chat clients. | Matches `scripts/generate-insights-data.ts` precedent today (same single platform import). Avoids pulling Vercel AI SDK + `@abl/compiler` stack for a dev script. `@agent-platform/web-sdk` is browser-shaped and not fit for Node. |
| D3  | Domain discovery: **welcome-message only** (no probe). Optional `DOMAIN_HINT` env var when welcome is too generic.                                                                 | User preference. Simpler flow, one WS session per conversation. Trades some auto-detection quality for simplicity; `DOMAIN_HINT` escape hatch covers bland-welcome bots.                                                            |
| D4  | Presets: fixed catalog of **5 domain-agnostic behavioral profiles** — `balanced` (default), `stress-negative`, `short-simple`, `long-complex`, `abandonment`.                      | Domain-specific presets impossible without knowing bot upfront. Behavioral profiles describe conversation _shape_ (mood, length, outcome) independent of topic.                                                                     |
| D5  | Instruction stacking: user's free-text `INSTRUCTIONS` **stacks on top of** domain + preset, does not replace them.                                                                 | Orthogonal knobs: domain = what bot can do; preset = how user behaves; instructions = what to focus on. All three feed the scenario prompt.                                                                                         |
| D6  | Concurrency: **bounded parallel (`CONCURRENCY=5` default, min 1)**.                                                                                                                | Share-token exchange is rate-limited to 30/min/IP; LLM providers rate-limit ~50 RPM tier-1. `CONCURRENCY=5` stays inside all limits for typical `RUNS=10-30`. `CONCURRENCY=1` reproduces sequential behavior for debugging.         |
| D7  | One bot per invocation.                                                                                                                                                            | User confirmed single-bot flow. Shell loop handles multi-bot if needed later.                                                                                                                                                       |

## 4. Architecture — Package Layout

```
abl-platform/
├── scripts/
│   ├── conversation-testing/              ← NEW workspace package
│   │   ├── package.json                   # name: "@abl/conversation-testing", private: true
│   │   ├── tsconfig.json
│   │   ├── README.md                      # quickstart + env var table + presets + troubleshooting
│   │   ├── agents.md                      # per CLAUDE.md package-learnings convention
│   │   └── src/
│   │       ├── index.ts                   # barrel export
│   │       ├── types.ts                   # Scenario, Transcript, LLMConfig, RunConfig
│   │       ├── llm/
│   │       │   ├── index.ts               # pickLLMFromEnv() factory
│   │       │   ├── anthropic.ts           # ~35 lines
│   │       │   ├── openai.ts              # ~35 lines
│   │       │   └── custom.ts              # ~15 lines (OpenAI-compat custom base URL)
│   │       ├── presets.ts                 # PRESETS constant (5 profiles)
│   │       ├── prompt-builder.ts          # buildScenarioPrompt(), buildPersonaPrompt()
│   │       ├── scenario-generator.ts      # generateScenarios(llm, cfg) → Scenario[]
│   │       ├── conversation-runner.ts     # runConversation(sdkToken, scenario, llm) → Transcript
│   │       └── concurrency.ts             # tiny semaphore helper
│   └── generate-insights-data.ts          ← REWRITTEN (~80 lines, thin entry)
│
├── pnpm-workspace.yaml                    ← add 'scripts/conversation-testing'
└── apps/runtime/src/__tests__/runtime-ws-client-guard.test.ts
                                           ← stays green (we keep using buildSdkWSProtocols)
```

### Package responsibilities (one-liner each)

| File                     | Responsibility                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `types.ts`               | Shared types: `Scenario`, `TranscriptMessage`, `Transcript`, `LLMConfig`, `RunConfig`, `PresetName`                 |
| `llm/anthropic.ts`       | `chat(messages, system) → Promise<string>` over `@anthropic-ai/sdk`                                                 |
| `llm/openai.ts`          | Same shape over `openai` SDK                                                                                        |
| `llm/custom.ts`          | Same shape, uses `openai` SDK with custom `baseUrl`                                                                 |
| `llm/index.ts`           | `pickLLMFromEnv()` — reads env vars, returns configured `LLMClient`                                                 |
| `presets.ts`             | Exports `PRESETS: Record<PresetName, string>` and `DEFAULT_PRESET`                                                  |
| `prompt-builder.ts`      | Pure functions: `buildScenarioPrompt()`, `buildPersonaPrompt()`, `formatHistory()`                                  |
| `scenario-generator.ts`  | `generateScenarios(llm, runCfg) → Scenario[]` — one LLM call, JSON reply, zod-validated                             |
| `conversation-runner.ts` | `runConversation(sdkToken, scenario, llm, opts) → Transcript` — opens WS, drives persona turns, sends `end_session` |
| `concurrency.ts`         | `makeLimit(n)` — hand-rolled semaphore, avoids `p-limit` dep for ~15 lines                                          |
| `index.ts`               | Barrel re-exports `{ generateScenarios, runConversation, pickLLMFromEnv, PRESETS }`                                 |

### Entry-point shape (`generate-insights-data.ts`, rewritten, ~80 lines)

```ts
import { WebSocket } from 'ws';
import { buildSdkWSProtocols } from '@agent-platform/shared/websocket-auth';
import { createLogger } from '@abl/compiler/platform';
import {
  generateScenarios,
  runConversation,
  pickLLMFromEnv,
  makeLimit,
} from '@abl/conversation-testing';

const log = createLogger('generate-insights-data');

// ...env parsing + preflight validation...

async function main() {
  const llm = pickLLMFromEnv();
  const { sdkToken, projectName, welcomeMessage } = await exchangeShareToken(SHARE_TOKEN);

  const scenarios = await generateScenarios(llm, {
    runs: RUNS,
    preset: PRESET,
    instructions: INSTRUCTIONS,
    domain: { projectName, welcomeMessage, hint: DOMAIN_HINT },
  });

  const limit = makeLimit(CONCURRENCY);
  const results = await Promise.all(
    scenarios.map((s, i) =>
      limit(async () => {
        const fresh = await exchangeShareToken(SHARE_TOKEN);
        return runConversation(fresh.sdkToken, s, llm, { scenarioIndex: i });
      }),
    ),
  );

  // ...summary print, optional transcript save...
}
```

## 5. Data Flow

```
[env vars] → preflight → exchange share token → generate scenarios (1 LLM call)
                                              → for each scenario (bounded parallel):
                                                  fresh share-token exchange
                                                  open WS /ws/sdk
                                                  loop: LLM(persona, history) → user turn
                                                        or [END_CONVERSATION] → break
                                                        ws.send chat_message
                                                        await response_end
                                                  ws.send end_session
                                                  await session_ended → close
                                              → pipelines fire on runtime (unchanged)
                                              → print summary
```

### Invariants

- **One fresh SDK token per conversation.** Current behavior, preserved — each session triggers one pipeline fire.
- **Conversation end is LLM-driven.** Persona outputs `[END_CONVERSATION]` when `scenario.endCondition` is met. Hard cap `MAX_TURNS=15` as safety.
- **Scenario generation is serial.** One LLM call produces all N scenarios at once, ensuring intent-diversity across the batch. Per-scenario generation would break that guarantee.
- **Per-conversation execution is parallel with `CONCURRENCY`-bounded pool.**
- **WS contract unchanged.** Same envelope (`session_start`, `chat_message`, `response_start/chunk/end`, `end_session`, `session_ended`) as current script. `buildSdkWSProtocols` is preserved, so `runtime-ws-client-guard.test.ts` stays green.

### Log tagging for parallel runs

Each parallel conversation prefixes its log lines with `[s01]`, `[s02]`, ... so `LOG_LEVEL=debug` output can be filtered per scenario.

## 6. Presets & Prompt Building

### Two prompts, two purposes

**Prompt A — Scenario Generation** (one call per run): given `projectName`, `welcomeMessage`/`DOMAIN_HINT`, `PRESET`, optional `INSTRUCTIONS`, and `RUNS`, produce a JSON array of `{ intent, persona, goal, behavior, endCondition }` objects. LLM is asked to spread scenarios across inferred intents; no intent may claim more than `ceil(RUNS * 0.4)` unless `INSTRUCTIONS` narrows scope.

**Prompt B — Persona User Turn** (called per turn, per conversation): given `scenario` + conversation history, produce the next user utterance **or** `[END_CONVERSATION]`.

### Preset catalog (final)

- **`balanced`** (default) — mixed moods, mixed lengths, mixed outcomes, realistic variety.
- **`stress-negative`** — ~80% frustrated/angry personas; short sentences, urgency, escalation requests; outcomes skew partial-resolution and abandonment.
- **`short-simple`** — 2-3 user turns max, single-intent concrete queries, task-oriented personas.
- **`long-complex`** — 6-10 user turns, multi-step or multi-intent requests, personas reveal context gradually.
- **`abandonment`** — personas lose patience / change their mind; ~70% end early without resolving.

Preset text lives in `presets.ts` as prose prompt fragments (not structured config) — they inject directly into the scenario-generation prompt.

### Sentinel detection

`[END_CONVERSATION]` matched case-insensitively: `/\[end[ _]?conversation\]/i`. When detected, skip the send-to-bot step and go straight to `end_session`.

## 7. Config — Env Var Contract

### Required

| Var                                                                                                                  | Purpose                                      |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `SHARE_TOKEN`                                                                                                        | Studio share token                           |
| One of: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / (`CUSTOM_LLM_BASE_URL` + `CUSTOM_LLM_API_KEY` + `CUSTOM_LLM_MODEL`) | LLM provider credentials matching `PROVIDER` |

### Optional (defaults shown)

| Var                | Default                      | Purpose                                                       |
| ------------------ | ---------------------------- | ------------------------------------------------------------- |
| `RUNS`             | `10`                         | Number of conversations                                       |
| `CONCURRENCY`      | `5`                          | Parallel conversations (min 1)                                |
| `PRESET`           | `balanced`                   | One of the 5 preset names                                     |
| `INSTRUCTIONS`     | _(empty)_                    | Free text appended to scenario prompt                         |
| `DOMAIN_HINT`      | _(empty)_                    | Overrides welcome message as domain source                    |
| `PROVIDER`         | `anthropic`                  | `anthropic` \| `openai` \| `custom`                           |
| `MODEL`            | provider default             | `claude-sonnet-4-5` / `gpt-4o-mini` / (required for `custom`) |
| `STUDIO_URL`       | `http://localhost:5173`      | Studio base URL                                               |
| `RUNTIME_WS_URL`   | `ws://localhost:3112/ws/sdk` | Runtime WS endpoint                                           |
| `MAX_TURNS`        | `15`                         | Hard ceiling per conversation                                 |
| `TIMEOUT_MS`       | `120000`                     | Per-conversation timeout                                      |
| `SAVE_TRANSCRIPTS` | `0`                          | When `1`, write JSON transcripts + scenarios to disk          |
| `DEBUG_PROMPTS`    | `0`                          | When `1`, log full LLM prompts (for debugging)                |

### Minimum invocation

```bash
ANTHROPIC_API_KEY=sk-ant-... SHARE_TOKEN=eyJ... tsx scripts/generate-insights-data.ts
```

### Preflight validation

Before any external call:

- `SHARE_TOKEN` present and non-empty.
- Credentials present for selected `PROVIDER`.
- `RUNS` in `[1, 100]`, `CONCURRENCY >= 1`.
- `PRESET` in the 5-name set.

Any failure → print specific error → `process.exit(1)`. No partial progress.

### Secret handling

- Script reads from `process.env` only. **Does not** auto-load `.env` (CLAUDE.md prohibits sourcing repo `.env`).
- Never logs `SHARE_TOKEN` or any `*_API_KEY`.
- `run-config.json` (optional transcript output) redacts secret fields.

### Transcript output layout (when `SAVE_TRANSCRIPTS=1`)

```
scripts/conversation-testing/outputs/2026-04-19T12-30-00Z/
├── run-config.json       # env vars at run start, secrets redacted
├── scenarios.json        # the N generated scenarios
└── transcripts/
    ├── s01.json          # { scenario, messages, startedAt, endedAt, outcome }
    ├── s02.json
    └── ...
```

`outputs/` gitignored (existing pattern).

## 8. Error Handling

| Stage            | Failure                     | Behavior                                                                      |
| ---------------- | --------------------------- | ----------------------------------------------------------------------------- |
| Preflight        | Missing/invalid env var     | Specific error, `exit(1)`                                                     |
| Token exchange   | 401/404                     | Fail run — no valid token means no pipeline signal                            |
| Token exchange   | 429 (rate limit)            | Retry 3× with exponential backoff, then fail                                  |
| Token exchange   | Network error               | Retry 3× then fail                                                            |
| Scenario gen     | LLM network error           | Retry 2× with backoff, then fail                                              |
| Scenario gen     | Malformed JSON / zod fail   | Log bad output, retry 1× with stricter instruction, then fail                 |
| Scenario gen     | Count mismatch              | Warn, proceed with fewer                                                      |
| Per-conversation | WS connection error         | Log, mark failed, continue pool                                               |
| Per-conversation | Conversation timeout        | Log, mark failed, continue pool                                               |
| Per-conversation | LLM fail mid-conv           | Log, mark failed, continue pool                                               |
| Per-conversation | Hit `MAX_TURNS`             | Force `end_session`, count as success                                         |
| Per-conversation | `session_ended` never acked | Close WS after 30s, count as best-effort success                              |
| End of run       | Any failures                | Print `Success: X/N, Failed: Y`. Exit `0` if any succeeded, `1` if all failed |

**Principle:** one bad persona does not abort the whole run. Insights seeding is best-effort batch.

## 9. Testing Strategy

Proportionate to a dev-only script:

| Level                      | Scope                                                                                                                                            | Gate                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **Unit** (pure functions)  | `buildScenarioPrompt`, `buildPersonaPrompt`, `parseScenariosJson`, `detectEndSentinel`, `formatHistory`, `makeLimit`                             | Runs in default CI                                         |
| **Integration** (real LLM) | One test: `generateScenarios` against configured LLM, asserts schema and minimum diversity (≥ 3 distinct intents for `RUNS=10, PRESET=balanced`) | Gated behind `RUN_LIVE_LLM_TESTS=1`; skipped in default CI |
| **E2E**                    | _Not written._ The script itself is an E2E harness for the platform.                                                                             | N/A                                                        |

Existing guard test `apps/runtime/src/__tests__/runtime-ws-client-guard.test.ts` stays green — we keep using `buildSdkWSProtocols`.

Per CLAUDE.md "Test Architecture — Fix the Code, Not the Test": no `vi.mock()` of platform components. All unit tests target pure functions with no I/O.

## 10. Done Criteria

**Functional:**

1. `ANTHROPIC_API_KEY=... SHARE_TOKEN=... tsx scripts/generate-insights-data.ts` completes end-to-end with no other env vars; ≥ 8 of 10 default conversations succeed.
2. `RUNS=20 PRESET=stress-negative INSTRUCTIONS="refunds"` produces visibly frustrated, refund-focused scenarios.
3. `CONCURRENCY=1` vs `CONCURRENCY=5` both work; latter is noticeably faster.
4. `DOMAIN_HINT="..."` overrides welcome-message domain source.
5. Insights dashboard (ClickHouse) shows new rows across sentiment/intent/quality pipelines within ~2 min of a successful run.

**Non-functional:**

6. `runtime-ws-client-guard.test.ts` stays green.
7. No imports of `@agent-platform/web-sdk` (it's browser-shaped).
8. `pnpm build --filter=@abl/conversation-testing` passes.
9. Unit tests pass in default CI; integration test passes with `RUN_LIVE_LLM_TESTS=1`.
10. No secrets logged (verified against sample run output).

**Documentation:**

11. `scripts/conversation-testing/README.md` with quickstart, env var table, preset catalog, troubleshooting.
12. `scripts/conversation-testing/agents.md` per package-learnings convention.

## 11. What Does Not Break

Verified by grep:

- `generate-insights-data.ts` is referenced by exactly one external file: `apps/runtime/src/__tests__/runtime-ws-client-guard.test.ts`. Guard passes because we keep `buildSdkWSProtocols`.
- No Harness CI pipeline references the script.
- No docs reference the script.
- No other scripts chain into it.
- Hardcoded conversation names (`"Battery Drain Issue"`, etc.) are not referenced anywhere else in the repo.

Breakage risk: **zero for existing flows**. Net behavior change: hardcoded conversations → LLM-generated conversations. New requirement: an LLM API key.

## 12. Out of Scope / Future Work

- **Web dashboard** (Express + React) — dropped for phase 1.
- **Multi-bot batch mode** — shell loop suffices today; add if routine need emerges.
- **LLM-driven probe discovery (Tier B)** — deferred. Revisit if bland welcome messages become a recurring pain point.
- **Persisting runs in MongoDB / run-history API** — not needed for dev seeding.
- **Scheduled runs / CI regression harness** — dev tool only for phase 1.
- **Custom preset plug-ins** — preset catalog is closed at 5 for phase 1.
- **Per-scenario summarizer** — intentionally dropped; platform pipelines already classify.

## 13. Dependencies

### New third-party npm deps (scoped to `@abl/conversation-testing`)

- `@anthropic-ai/sdk`
- `openai`
- `ws` (already used elsewhere in the monorepo)
- `zod` (already used elsewhere in the monorepo)
- `uuid` (already used elsewhere in the monorepo)

### Workspace imports

- `@agent-platform/shared/websocket-auth` — for `buildSdkWSProtocols`.
- `@abl/compiler/platform` — for `createLogger`.

### Dockerfiles

**No changes required.** The script is dev-only, not deployed to any `apps/` Dockerfile.

## 14. Python Correlations (reader reference)

Selected TS-to-Python mental mappings used in this design, for ease of reading:

- **pnpm workspace package** ≈ Python editable install in a monorepo (`pip install -e ./packages/foo`); `package.json` ≈ `pyproject.toml`; `pnpm-workspace.yaml` ≈ `[tool.uv.workspace]` member list.
- **`tsx scripts/foo.ts`** ≈ `python scripts/foo.py` — run TS directly, no separate compile step.
- **`createLogger('conv-test')`** ≈ `logging.getLogger('conv_test')` — named logger, platform-configured handlers.
- **`zod.parse`** ≈ Pydantic `.model_validate()`.
- **Hand-rolled semaphore via `makeLimit(n)`** ≈ `asyncio.Semaphore(n)` + `async with sem:` wrapper.
- **LLM provider factory** ≈ single `chat()` function shape across `anthropic`, `openai`, and an OpenAI-compatible custom client — same interface, three backends.
- **`[END_CONVERSATION]` sentinel** ≈ the same pattern as `StopIteration` or a `None` return to break a generation loop.
- **"No mocking platform components"** ≈ Python guidance to prefer dependency injection + pure-function tests over `unittest.mock.patch` of your own modules.

---

## Appendix A — Sample Invocations

```bash
# Minimum — defaults (RUNS=10, PRESET=balanced, CONCURRENCY=5, anthropic)
ANTHROPIC_API_KEY=sk-ant-... SHARE_TOKEN=eyJ... tsx scripts/generate-insights-data.ts

# Tuned for sentiment / friction pipeline coverage
ANTHROPIC_API_KEY=sk-ant-... SHARE_TOKEN=eyJ... RUNS=30 PRESET=stress-negative \
  tsx scripts/generate-insights-data.ts

# Narrowed focus via custom instructions
ANTHROPIC_API_KEY=sk-ant-... SHARE_TOKEN=eyJ... RUNS=20 INSTRUCTIONS="Focus on iPhone 16 pre-orders" \
  tsx scripts/generate-insights-data.ts

# Bland welcome message → provide domain hint
ANTHROPIC_API_KEY=sk-ant-... SHARE_TOKEN=eyJ... DOMAIN_HINT="Apple customer support for iPhone and Mac" \
  tsx scripts/generate-insights-data.ts

# OpenAI provider + debug transcripts
OPENAI_API_KEY=sk-... SHARE_TOKEN=eyJ... PROVIDER=openai MODEL=gpt-4o-mini SAVE_TRANSCRIPTS=1 \
  tsx scripts/generate-insights-data.ts

# Self-hosted Qwen or other OpenAI-compatible
CUSTOM_LLM_BASE_URL=https://my-qwen/v1 CUSTOM_LLM_API_KEY=... CUSTOM_LLM_MODEL=qwen-2.5-72b \
  SHARE_TOKEN=eyJ... PROVIDER=custom tsx scripts/generate-insights-data.ts

# Debugging a single weird persona — sequential, save transcripts
ANTHROPIC_API_KEY=sk-ant-... SHARE_TOKEN=eyJ... RUNS=3 CONCURRENCY=1 SAVE_TRANSCRIPTS=1 \
  LOG_LEVEL=debug tsx scripts/generate-insights-data.ts

# Multi-bot via shell loop
for t in "$TOKEN_APPLE" "$TOKEN_BANKING" "$TOKEN_HR"; do
  ANTHROPIC_API_KEY=sk-ant-... SHARE_TOKEN=$t RUNS=10 \
    tsx scripts/generate-insights-data.ts
done
```

---

## 15. Post-implementation updates (2026-04-20)

Kept as an addendum so the original design above stays readable. Everything below ships on branch `ABLP-425/conversation-testing-integration` and supersedes the corresponding section of the original design.

### 15.1 Dev auto-login (supersedes §7 "Required")

`SHARE_TOKEN` is no longer the only auth path. In dev (where `ENABLE_DEV_LOGIN=true` is set on Studio), the script can fetch its own share token per run:

```
STUDIO_EMAIL=dev@kore.ai + PROJECT_ID=proj-xxx
  → POST /api/auth/dev-login  → accessToken
  → POST /api/sdk/share       → fresh share token
  → POST /api/sdk/share/exchange → SDK token
```

Preflight accepts either `SHARE_TOKEN` **or** (`STUDIO_EMAIL` + `PROJECT_ID`). The dev-login flow eliminates the 7-day manual token refresh.

### 15.2 All-agents mode (new — not anticipated in the original design)

`--all` flag (or `ALL_AGENTS=1`) discovers the bot's agent topology via `/api/projects/:id/topology` and generates scenarios that target each agent. Requires dev-login (topology API needs tenant auth, share tokens don't satisfy it). In this mode:

- `CONCURRENCY` is forced to `5`, `MAX_TURNS` to `10` (overriding env).
- Total sessions = `agents.length × RUNS_PER_AGENT` (default `RUNS_PER_AGENT=3`), OR the explicit `RUNS` value when the caller sets it (distributed round-robin across agents).
- Each `Scenario` carries a new `targetAgent: string` field. Per-scenario prompts list each slot's target so the LLM emits in the enforced order.

### 15.3 `auto` preset + per-slot random assignment (supersedes §6)

`PRESET=auto` (new **default**, replacing `balanced`) randomly assigns one of the five original profiles per scenario slot. Scenarios now also carry `assignedPreset: PresetName` metadata, zipped in after the LLM call. A single agent's runs can mix balanced/stress-negative/short-simple/long-complex/abandonment for broadest pipeline coverage. The prompt enumerates per-slot `(targetAgent, preset)` pairs when either is set.

Preset count is now **6** (the 5 original profiles + `auto`).

### 15.4 `run.sh` shell wrapper (new, replaces direct `tsx` invocation convention)

`scripts/conversation-testing/run.sh` loads `scripts/conversation-testing/.env.local` (gitignored) with one important property: **caller-provided env vars win over the file**, so `RUNS=10 bash run.sh` is honored even if the file has `RUNS=1`. Implemented by per-key lookup + `[[ -n "${!key+x}" ]]` guard instead of bulk `set -a; source`.

Recommended invocation style is now:

```bash
bash scripts/conversation-testing/run.sh [--all]
# Or inline-override:
RUNS=20 PRESET=stress-negative bash scripts/conversation-testing/run.sh
```

### 15.5 CSRF Origin header (supersedes §5 WS contract — clarification)

`/api/sdk/share/exchange` runs behind Studio's Next.js middleware which enforces an Origin/Referer check (CSRF). The script now sends `Origin: ${STUDIO_URL}` on exchange/fetch calls so the CSRF gate passes. The new `/api/sdk/share` fetch also sends `Origin` even though `Authorization: Bearer ...` exempts it from CSRF — harmless and explicit.

### 15.6 Session-correlation logging (supersedes §5 log-tagging)

The runner attaches `sessionId` (captured from `session_start` frame), `targetAgent`, and `assignedPreset` to every subsequent log line on a given conversation. Combined with the `[sNN]` scenario tag in the logger name, a session's lifecycle is trivially `grep`-able in the unified runtime log.

### 15.7 Logger import substitution

`@abl/compiler/platform` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` under `tsx`'s ESM resolver for this package (chevrotain transitive). Switched to `@agent-platform/shared-observability/logger` — same `createLogger(name)` API, different import path, works under both `tsx` and compiled output. Recorded in `scripts/conversation-testing/agents.md`.

### 15.8 Prerequisites clarification (missing from original)

The insights flow requires **three** services running locally: Studio (5173), Runtime (3112), **and Pipeline-Engine** (Restate service on 9082). The root `pnpm dev` starts only the first two — pipeline-engine must be started separately:

```bash
pnpm --filter @agent-platform/pipeline-engine dev
```

Without it, conversations still complete but `abl.session.ended` events have no consumer, and no insights rows are produced. Documented in `scripts/conversation-testing/README.md` under "Prerequisites".

### 15.9 Vitest alignment

Our `package.json` was originally pinned to `vitest ^3.1.3`, which forced pnpm to resolve a full parallel vitest 3 tree in the lockfile alongside the monorepo-wide `4.1.4`. Bumped to `^4.1.4` (all 43 tests still pass) — dropped ~15 `@vitest/*@3.2.4` entries from `pnpm-lock.yaml`. Fix committed as `[ABLP-425] chore(pipeline-engine): align vitest to monorepo-wide 4.1.4`.

### 15.10 Commits delivering the updates above

```
8800cbca8  feat:  add auto-login, all-agents mode, and auto preset to generate-insights-data
1bccd6316  chore: align vitest to monorepo-wide 4.1.4
319d743f9  fix:   use lighter logger import for tsx compatibility
```

All on `ABLP-425/conversation-testing-integration`. Jira ticket: [ABLP-425](https://koreteam.atlassian.net/browse/ABLP-425).
