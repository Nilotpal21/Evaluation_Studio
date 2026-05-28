# Triage 2026-05-16 — Twelve-Ticket Audit

Per-ticket root cause analysis, executable reproduction tests, and future-ready
solution sketches for the active backlog assigned to (or recently routed
through) **Prasanna Arikala**. Tickets `ABLP-1060`, `ABLP-978`, `ABLP-976`,
`ABLP-998` were explicitly out of scope. `ABLP-1007` is already Done.

Every audit doc follows the same shape:

- **Symptom** — what the user/reporter sees
- **Root Cause** — code paths with `file:line` references
- **Reproduction Test** — path to an executable failing test
- **Future-Ready Solution** — architectural fix, not a patch

Each reproduction test is committed under the relevant package's `__tests__/`
directory with the `.repro.test.ts` (or `.repro.test.tsx`) suffix and a
top-of-file `// FAILS: reproduces ABLP-XXXX` marker. Tests assert the **expected**
post-fix behavior, so they fail on the current tree.

## Takeover update — 2026-05-17

Moved the triage bundle from `f-1` into the `f-2` worktree and fixed the four
review-blocking repro problems:

- `ABLP-1100` now asserts the target hidden-param contract and fails because
  `botId` / `language` still leak into the LLM schema.
- `ABLP-974` now serves the SDK's expected `/.well-known/agent-card.json`
  endpoint, so its remaining failures are the trace context / discovery taskId
  bugs rather than fake-server setup.
- `ABLP-1010` no longer mocks `@abl/compiler/platform`; it fails on the missing
  structured `diagnostics` result.
- `ABLP-986` now targets an extracted runtime gate helper and fails because the
  current gate returns `park_without_output` instead of
  `execute_reasoning_with_goal`.

Verification command:
`pnpm -s vitest run packages/compiler/src/platform/llm/__tests__/tool-schema-hidden-params.repro.test.ts packages/a2a/src/__tests__/a2a-turn-context.repro.test.ts packages/project-io/src/__tests__/module-publish-diagnostics.repro.test.ts packages/compiler/src/platform/constructs/executors/__tests__/reasoning-executor-auto-advance.repro.test.ts`

Expected result: 4 files fail for the intended product gaps (6 failing
assertions, 4 passing assertions), with no setup/import failures.

## Independent review — GPT-5.5 (high), 2026-05-17

Full review at [`codex-review.md`](codex-review.md). Verdict per ticket:

| Ticket    | Verdict               | Headline gap (see per-doc "Review update" block)                                                 |
| --------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| ABLP-900  | PASS                  | —                                                                                                |
| ABLP-1031 | PASS                  | —                                                                                                |
| ABLP-905  | CONCERN               | TS model type drift (`personaModel?: string` vs Mongoose `null`); cover file-level schema too    |
| ABLP-986  | CONCERN               | Unskipped test only re-asserts the boolean; skipped test is the real repro; missing PRESENT case |
| ABLP-1010 | CONCERN               | Repro mocks `@abl/compiler/platform` (rule violation); misses Studio API-client flattening layer |
| ABLP-1032 | CONCERN               | Test doesn't cover singletons; naive accumulation would break TOOLS                              |
| ABLP-1058 | CONCERN               | Compiler executor path + streaming path also need the fix; runtime-only fix incomplete           |
| ABLP-1059 | CONCERN               | Repro fails on missing-module import, not real bug; card must be fetched before async branch     |
| ABLP-1066 | CONCERN               | Test silently early-returns; resolver leaks tenant ID; needs structured status field             |
| ABLP-974  | **DISAGREE**          | Fake-server URL mismatch; drop "server-generated contextId" (conflicts with adapter contract)    |
| ABLP-1019 | **DISAGREE (caveat)** | Gating IS on `origin/develop`; local was behind. `git pull` then re-verify. Add runtime test.    |
| ABLP-1100 | **DISAGREE**          | Repro test **passes today instead of failing** — must be inverted. Filtering needed in 3 places  |

**Codex executed two tests during verification** (confirming the analysis is empirical, not just paper):

- `tool-schema-hidden-params.repro.test.ts` (ABLP-1100) **passed** — confirms test inversion bug.
- `a2a-turn-context.repro.test.ts` + `a2a-handoff-mode.repro.test.ts` (ABLP-974, 1059) failed for the **wrong reasons** (discovery URL / missing import) — not the bugs they claim to reproduce.

**Top-3 codex blockers before any of these land:**

1. **Fix the broken repros**: unskip 986, invert 1100, fix 974 agent-card URL, remove 1010's `@abl/*` mock.
2. **Define typed contracts before patching call sites**: `PublishDiagnostic`, `A2AModeResolver`, `A2ATurnContext`, hidden-param source allowlist, eval schema↔model alignment.
3. **Sanitize user-visible surfaces**: 1019 debug payloads, 1066 tenant-ID leak, 1010 raw diagnostic strings.

**Codex's revised merge order**: ABLP-905 → 1019 (after `git pull`) → 900 → 1032 → 1031 → 1058 → 986 → 1059 → 974 (split into 5 tickets) → 1066 → 1010 → 1100 (split by phase). Notes: 1059 lands before 974 mode-mismatch work; 1032 lands before 1031 to avoid mixing parser-dispatch changes in one branch.

**Systemic pattern codex identified**: "Boundary contracts are not centralized" — DSL parsing dispatch, A2A state, eval schemas vs Mongoose, publish diagnostics are all hand-rolled at each boundary and all drift. Same root architectural cause across half the bugs in this batch.

## Cluster summary

| Cluster                                | Tickets    | Audit docs                     | Repro tests                                                                                                                                                                                                                       |
| -------------------------------------- | ---------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reasoning step empty response          | 1058, 986  | `ABLP-1058.md`, `ABLP-986.md`  | `packages/compiler/.../executors/__tests__/reasoning-executor-set-context.repro.test.ts`<br>`packages/compiler/.../executors/__tests__/reasoning-executor-auto-advance.repro.test.ts` (now targets extracted runtime gate helper) |
| DSL parser                             | 1031, 1032 | `ABLP-1031.md`, `ABLP-1032.md` | `packages/core/src/__tests__/duplicate-sections.repro.test.ts`<br>`packages/core/src/__tests__/handoff-delegate-symmetry.repro.test.ts`                                                                                           |
| A2A protocol                           | 1059, 974  | `ABLP-1059.md`, `ABLP-974.md`  | `packages/a2a/src/__tests__/a2a-handoff-mode.repro.test.ts`<br>`packages/a2a/src/__tests__/a2a-turn-context.repro.test.ts`                                                                                                        |
| Supervisor return-to-parent            | 900        | `ABLP-900.md`                  | `apps/runtime/src/__tests__/execution/supervisor-tools.repro.test.ts`                                                                                                                                                             |
| Tool param pre-processor (new feature) | 1100       | `ABLP-1100.md`                 | `packages/compiler/src/platform/llm/__tests__/tool-schema-hidden-params.repro.test.ts`                                                                                                                                            |
| Evals                                  | 1066, 905  | `ABLP-1066.md`, `ABLP-905.md`  | `packages/pipeline-engine/src/__tests__/evals-pipeline-health.repro.test.ts`<br>`packages/project-io/src/__tests__/eval-artifact-roundtrip.repro.test.ts`                                                                         |
| Module publish errors                  | 1010       | `ABLP-1010.md`                 | `packages/project-io/src/__tests__/module-publish-diagnostics.repro.test.ts`                                                                                                                                                      |
| API channel residuals                  | 1019       | `ABLP-1019.md`                 | `apps/studio/src/__tests__/components/copy-as-curl-metadata.repro.test.tsx`<br>`apps/runtime/src/__tests__/sessions/chat-attachments.repro.test.ts` (`.skip` — separate ticket recommended)                                       |

## Per-ticket cheat sheet

### ABLP-1058 — REASONING empty response after `__set_context__`

- **Root cause:** `rawContent` (typed `TextContent | ToolUseContent`) drops reasoning/thinking blocks; assistant message in conversation history is missing the reasoning item, OpenAI Responses API rejects the next call with "function_call without reasoning item".
- **Solution:** typed LLM conversation builder that always preserves provider-specific items (reasoning_item, thinking blocks) across tool-call → next-turn boundary. Contract: same builder for all providers; provider-specific items round-trip through a sealed shape.

### ABLP-986 — REASONING empty response on auto-advance

- **Root cause:** `flow-step-executor.ts:8618` gates reasoning zone on `!currentMessage`; auto-advance from a scripted step consumes input, so `currentMessage` is empty and the reasoning step parks without output.
- **NOT shared root cause** with 1058. Independent defects in different layers.
- **Solution:** distinguish "user-driven entry" (needs `currentMessage`) from "auto-advance entry" (uses GOAL as initial prompt) in the reasoning zone's input contract.

### ABLP-1031 — HANDOFF / DELEGATE syntax asymmetry

- **Root cause:** `packages/core/src/parser/agent-based-parser.ts` uses different entry-key regexes (`- AGENT:` at line 4350 vs `- TO:` at line 4489) and completely different sub-key schemas.
- **Solution:** shared `AgentRoutingBase` with a `mode` discriminator; parser accepts `TO:`, `PASS:`, `SUMMARY:` for both, with legacy aliases (`AGENT:`, `INPUT:`, `CONTEXT.pass`, `PURPOSE:`) during a deprecation window.

### ABLP-1032 — Duplicate top-level DSL sections silently overwrite

- **Root cause:** `agent-based-parser.ts:417-462` uses direct assignment (`doc.delegate = ...`) for every section except TEMPLATES (which uses spread accumulation at 463-465).
- **Solution:** schema-driven section registry with `cardinality: 'singleton' | 'accumulator'` metadata. Singleton-with-duplicate raises `DuplicateSectionError`; accumulator silently concatenates. Single source of truth; new sections inherit the discipline automatically.

### ABLP-1059 — A2A handoff mode not capability-aware

- **Root cause:** Mode selection at `routing-executor.ts:2009-2057` is three scattered `if` blocks that never consult the agent card's capabilities alongside the DSL flag in a single resolver. `ASYNC:true` is silently ignored when `asyncInfra` is absent; `pushNotifications` capability is never validated.
- **Solution:** typed `A2AModeResolver(dslAsync, agentCard) -> Mode | Error` chokepoint. Single function, single test surface, exhaustive truth table. Fail fast on mismatch (don't silently fall back to sync). Emit chosen mode + reason into the trace.

### ABLP-974 — A2A functional observations (7 issues)

- Covered by tests: issue 2 (taskId carryover), issue 3 (discovery URL leak as taskId), issue 6 (contextId missing from traces).
- Documented only (test deferred): issue 1 (server-generated contextId), 4 (custom metadata config), 5 (task state in traces), 7 (protocol version support).
- **Solution:** session-bound `A2ATurnContext { contextId, taskId, customMetadata }` carried through the routing executor. Issues 1, 2, 4, 6 solved by construction; 3, 5 trivially observable via instrumented context.

### ABLP-900 — Root supervisor calls `__return_to_parent__`

- **Root cause:** `apps/runtime/src/services/execution/prompt-builder.ts:1268-1269` guard only checks `activeThread.returnExpected && activeThread.handoffFrom`, never validates that a parent frame exists on `threadStack`. Amplified by `realtime-tool-definitions.ts:34-57` spreading `...activeThread` (child's thread with `returnExpected:true`) into temp sessions for _all_ agents in Google realtime path. Grok further widens the window via deferred `session.update`.
- **Solution:** add `&& session.threadStack.length > 0` to the guard. Override `returnExpected:false` in the temp thread when building tool definitions for agents that are not the current active child. Plus compile-time validation: `__return_to_parent__` cannot be statically referenced on a known-root agent.

### ABLP-1100 — Tool parameter pre-processing (new feature)

- **Verified:** Vishnu's line refs are mostly accurate, except `packages/compiler/src/platform/llm/types.ts:146-154` is just the `ToolDefinition` type — the actual LLM schema construction is at `apps/runtime/src/services/execution/prompt-builder.ts:1099` (`buildTools()`) and `:111` (`ablTypeToJsonSchema()`). Phase 1 must wire hidden-param filtering there.
- **Top security risk:** `defaultSource: 'session.X'` breaks the existing 3-key `TOOL_SESSION_CONTEXT_PARAM_MAP` allowlist. Requires an explicit resolvable-path allowlist before going generic.

### ABLP-1066 — Evals pipeline health: LLM credentials

- **Root cause:** 7+ silent null-return failure modes in `resolvePipelineLLM()` collapse into one generic "No LLM model available for tenant" error. Distinguishing "no provider configured" vs "key invalid" vs "provider/key mismatch" vs "inference disabled" is impossible from the UI message alone.
- **Solution:** typed `LlmCredentialResolver` chain (project > tenant > platform-default) with explicit error codes per failure mode. Pre-flight check on Pipeline Health surfaces the specific code; UI maps it to actionable copy.

### ABLP-905 — Eval artifact import schema mismatches

- **Root cause:** 5 Zod-vs-Mongoose type mismatches in `entity-schemas.ts`: `eval_sets.personaModel` (null vs string), `eval_scenarios.expectedMilestones[i]` (string vs object), `eval_scenarios.version` (number vs string), `eval_personas.goals` and `.constraints` (string vs array). Exporter does not coerce; importer's strict Zod rejects.
- **Solution:** round-trip property test that runs `export(seed) -> import` for every artifact type and asserts schema validity in CI. Systemic fix: every Mongoose model with custom audit/version fields registers its `DEFAULT_INTERNAL_KEYS` extensions in one place so the exporter can't drift from the model.

### ABLP-1010 — Module publish errors UX

- **Root cause:** 3-layer collapse of structured diagnostics into flat strings:
  1. `packages/project-io/src/module-release/build-module-release.ts:269` flattens `PublishSafetyIssue[]` to `[CODE] tool:X: message` strings.
  2. `apps/studio/src/app/api/projects/[id]/module/releases/route.ts:449-455` wraps the flat string as generic `{ msg, code: 'BUILD_ERROR' }`, losing the original diagnostic code and tool identity.
  3. `apps/studio/src/components/modules/PublishModuleDialog.tsx:153` `sanitizeError` truncates multi-tool strings at 200 chars or replaces them with a generic fallback.
- **Solution:** typed `PublishDiagnostic { severity, code, toolId?, fieldPath?, userMessage, supportMessage?, actionLink? }`. Backend always returns `diagnostics: PublishDiagnostic[]` (never collapsed). UI renders structured list with expandable "Details". Single component used by publish modal + deployment toast + module-build surfaces. Error-code catalog file is the single source of truth for code→userMessage mapping.

### ABLP-1019 — API channel heavy payload (In Review)

- **Shipped slice verified:** commits `16432bcfd6` + `2ed174e6f7` add `buildInlineDebugPayload` that gates `state`/`traceEvents`/`traceContext` behind `debug:true` body field or `?debug=1`/`?verbose=1` query flags.
- **Residual same-ticket:** curl-copy in `apps/studio/src/components/deployments/channels/tabs/OverviewTab.tsx` `sdkChatExample` payload omits `metadata` and `interactionContext` fields. Helper extracted to `sdk-chat-curl.ts` to enable the failing test.
- **Recommended separate ticket:** attachments/multipart upload — schema accepts `attachmentIds` but no upload endpoint exists.

## Suggested next moves

1. **Land independently and in this order** (highest user impact / lowest risk):
   - ABLP-905 eval-import schema (one-line model alignments + roundtrip test)
   - ABLP-1019 curl-copy fix (small, ticket already in review)
   - ABLP-1032 duplicate-section detection (parser change + test)
   - ABLP-900 root-supervisor guard (one-line guard + temp-thread override)
   - ABLP-1058 reasoning thinking-block preservation
   - ABLP-986 reasoning auto-advance gating
   - ABLP-1059 A2A mode resolver
   - ABLP-1066 LLM credential resolver error codes
   - ABLP-1010 publish-diagnostics contract (multi-package)
   - ABLP-1031 HANDOFF/DELEGATE alignment (multi-package + DSL migration)
   - ABLP-974 A2A turn-context (architecture-level)
   - ABLP-1100 tool-param pre-processor (Phase 1 first; Phases 2-3 follow)

2. **Confirm ownership before scheduling work:** ABLP-900 reassigned to Bhanu; ABLP-1010 reassigned to Sai Teja. Triage docs are written to hand off context cleanly.

3. **Run the repro tests** in a CI branch to capture baseline failures, then attach the failure transcript to each Jira ticket so progress against the fix is measurable.
