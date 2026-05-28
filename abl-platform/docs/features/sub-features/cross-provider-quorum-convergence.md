# Feature: Cross-Provider Quorum & Planning Convergence (HELIX)

**Doc Type**: SUB-FEATURE
**Parent Feature**: [helix-autonomous-engineering-harness](../helix-autonomous-engineering-harness.md)
**Status**: ALPHA
**Feature Area(s)**: `developer-tooling`, `observability`
**Package(s)**: `packages/helix`
**Owner(s)**: HELIX maintainers
**Testing Guide**: [../../testing/sub-features/cross-provider-quorum-convergence.md](../../testing/sub-features/cross-provider-quorum-convergence.md)
**Last Updated**: 2026-04-19

---

## 1. Introduction / Overview

### Problem Statement

HELIX's oracle constellation and plan-generation both route exclusively through Claude (Opus/Sonnet via the Claude Code SDK, `packages/helix/src/models/claude-sdk-executor.ts`). Four of four oracles share the same provider, meaning any systematic blind spot in that provider's model would not be caught by a dissenting voice in the quorum — introducing a second provider adds structural redundancy at the consensus layer. Plan generation is single-model (Opus), so the resulting plan reflects one lab's reasoning priors. When that plan feeds slicing and implementation, the pipeline compounds on one provider's judgment throughout the session.

The `ModelEngine` union in `packages/helix/src/types.ts:269-273` already declares `'openai-api'` as a valid engine, but no executor exists for it (`packages/helix/src/models/model-router.ts:48-67` registers only `claude-code` and `codex-cli`). HELIX.md §Future Work item #1 ("API-based executors") names this as an open capability gap. The dueling-plans convergence pattern has never been attempted in HELIX.

### Goal Statement

Introduce genuine provider independence at HELIX's two highest-leverage decision points — oracle architectural review and plan generation — by (a) adding an OpenAI API executor that registers with the Model Router, (b) swapping the Architecture oracle's model from Claude Opus to GPT-5, and (c) replacing single-model plan generation with a dueling-plans convergence flow: two planners in parallel (Claude Opus + GPT-5, same prompt) followed by a Codex synthesizer that produces a comprehensive Plan C. Preserve CLI-based executors as the production default; preserve checkpoint reuse and resume semantics; preserve user autonomy (no human checkpoint in the convergence flow, just a rich paper trail).

### Summary

This sub-feature extends HELIX's model routing surface with three additive capabilities, all template-level opt-in:

1. **`OpenAiApiExecutor`** implementing `ModelExecutor` for `engine: 'openai-api'`, following the dynamic-import pattern of `ClaudeSdkExecutor`. Reads `OPENAI_API_KEY` from the process environment (same mechanism Codex CLI uses today). Supports streaming, structured output, cost extraction from usage response, abort/stall detection, and the `maxBudgetUsd` safety cap.
2. **Architecture oracle GPT-5 swap** in `packages/helix/src/oracles/oracle-constellation.ts:370-383`, gated by config. When the swap is active, the 4-oracle constellation runs three Claude voices (codebase/testing/domain) plus one GPT-5 voice (architecture) — genuine provider diversity in the quorum.
3. **Dueling-planners convergence** as a new special-stage dispatch in the pipeline engine. At `plan-generation` stage, run Planner A (Claude Opus) and Planner B (GPT-5) in parallel with the same prompt; pass both outputs plus original context to `codex-cli`, which synthesizes Plan C with tool use disabled. Plan C feeds the existing `Plan Quality` gate and slice generation unchanged. Plan A, Plan B, Plan C, and divergence notes persist under `.helix/sessions/<id>/` and are referenced from `docs/sdlc-logs/<feature>/helix/journal.md`.

This is explicitly **not** a cost-optimization feature. It trades additional token spend and wall-clock (≈1.5×) for structural accuracy: disagreements between independent providers surface during planning rather than after implementation.

---

## 2. Scope

### Goals

1. Ship `OpenAiApiExecutor` (`packages/helix/src/models/openai-api-executor.ts`) and register it in `ModelRouter` via `registerExecutor()`.
2. Swap the Architecture oracle model to `gpt-5` behind a config gate (`HelixConfig.useOpenAiArchitectureOracle`, default `false` until validated).
3. Add `executeDuelingPlanGeneration()` to the special-stage executor; dispatch from `pipeline-engine.ts` when stage type is `plan-generation` and dueling is enabled.
4. Persist Plan A / Plan B / Plan C / divergence notes under `.helix/sessions/<id>/`; write a summary entry to the session journal.
5. Add per-provider cost attribution (`costByProvider: Record<string, { totalUsd: number; callCount: number }>`) on the `Session` object, accumulated after every `modelRouter.execute()` call.
6. Checkpoint intermediate dueling state (`session.duelingPlanState`) so resume skips regeneration when Plan A/B are already captured.
7. Hard-abort on total planner failure or Codex synthesis failure — no silent fallback to single-model output.
8. Update the HELIX `change checklist` tests (`packages/helix/CLAUDE.md`): new `openai-api-executor.test.ts`; updates to `oracle-constellation`, `model-router`, `pipeline-engine` test files.

### Non-Goals (Out of Scope)

- Wiring `openai-api` into the Codebase, Testing, or Domain oracles. Only Architecture is swapped in this feature.
- Using `openai-api` for implementation, reproduction, regression, or any stage outside the two declared surfaces. Those stages remain on `codex-cli` / `claude-code`.
- Implementing the `claude-api` executor. That capability remains an open Future Work item and is tracked separately.
- Learned autonomy from dueling-plan outcomes (cross-session feedback loops). Deferred to HELIX roadmap Phase 6.
- Cost optimization or cheaper-model substitution. User directive: accuracy over cost.
- Studio or admin UI for inspecting plan artifacts or divergence. CLI + file-system only.
- New MCP control-plane tool (`get_plan_divergence`). Paper trail in session dir is sufficient for Phase 1.
- Parallel slice execution on worktrees. Unrelated roadmap item.
- Changes to `bug-fix`, `canary`, or `drift-audit` pipelines. Only `holistic-audit` gains dueling planners in this feature.

---

## 3. User Stories

1. As a HELIX CLI operator, I want a `helix audit` run to generate two independent implementation plans (Claude + GPT-5) and a Codex-synthesized convergent plan, so that the plan driving slice implementation reflects two providers' reasoning instead of one.
2. As a HELIX CLI operator, I want the Architecture oracle in the 4-oracle constellation to run on a non-Claude model when I enable `useOpenAiArchitectureOracle`, so that architectural dissent has a path to surface in the consensus protocol.
3. As a HELIX CLI operator, I want per-provider cost attribution in the session summary (`costByProvider.claude-code:opus`, `costByProvider.openai-api:gpt-5`, `costByProvider.codex-cli:gpt-5.4`), so that I can judge whether cross-provider voices are worth their spend.
4. As a HELIX CLI operator, I want Plan A, Plan B, Plan C, and divergence notes persisted as inspectable files in the session directory, so that I can review after the fact where the models disagreed and how Codex resolved it.
5. As a HELIX CLI operator, I want the pipeline to continue with a solo-pass through Codex when exactly one planner fails, so that a single transient failure does not block the entire plan stage.
6. As a HELIX CLI operator, I want the pipeline to hard-abort the plan stage (never silently fall back to a single-model plan) when both planners fail or Codex synthesis fails, so that I never ship code from a plan whose convergence was incomplete.
7. As a HELIX CLI operator, I want the dueling-plan intermediate state checkpointed, so that Ctrl+C after Plan A+B complete does not force me to pay for regeneration on resume.
8. As a pipeline template author, I want dueling planners and the GPT-5 Architecture oracle to be opt-in per template/config, so that my existing `bug-fix` and `drift-audit` templates keep their current single-model semantics.

---

## 4. Functional Requirements

1. **FR-1**: The system must expose `OpenAiApiExecutor` implementing `ModelExecutor` with `engine = 'openai-api'`, registered in `ModelRouter` via `registerExecutor(...)` at pipeline startup. The executor must produce an `ExecutorResult` with populated `output`, `model`, `engine`, `turnsUsed` (request count), `durationMs`, and `costUsd` fields.
2. **FR-2**: The system must resolve the OpenAI API key from `process.env.OPENAI_API_KEY`. If absent and a `ModelSpec` with `engine: 'openai-api'` is invoked, `ModelExecutor.isAvailable()` must return `false` and the router must return the standard "Engine is not available" error (`packages/helix/src/models/model-router.ts:214-223`).
3. **FR-3**: The Architecture oracle definition (`packages/helix/src/oracles/oracle-constellation.ts:370-383`) must switch to `engine: 'openai-api', model: 'gpt-5'` when `HelixConfig.useOpenAiArchitectureOracle` is `true`. When the config is `false` (default), the oracle retains its current `claude-code` / `opus` definition.
4. **FR-4**: At stage type `plan-generation`, when `HelixConfig.enableDuelingPlanners` is `true`, the pipeline engine must invoke `specialStageExecutor.executeDuelingPlanGeneration(...)` instead of falling through to the generic model-execution loop in `pipeline-engine.ts` (the `// Main stage execution loop` block, currently ~line 1870). When the flag is `false` (default), the existing generic dispatch runs unchanged.
5. **FR-5**: `executeDuelingPlanGeneration` must launch Planner A (`claude-code`/`opus`) and Planner B (`openai-api`/`gpt-5`) in parallel with the **same prompt**. Both planners use the existing `slice-plan` output schema.
6. **FR-6**: After Planner A and Planner B complete, the system must invoke `codex-cli` with a synthesis prompt that references the two candidate plans as unlabeled "Candidate A" and "Candidate B". The synthesizer must run with `efficiencyBudget.disableToolUse: true` so it reasons only over the candidate inputs + context, not fresh codebase exploration.
7. **FR-7**: When exactly one of Planner A / Planner B fails or times out, the system must pass the surviving plan through Codex for a solo-pass synthesis (still labeled "Candidate A"). The failure is recorded in the stage advisory.
8. **FR-8**: When **both** planners fail, the plan-generation stage must return `status: 'failed'` with a structured advisory. The pipeline must abort via the existing `handleBlockingStageResult` path (`pipeline-engine.ts:508-511`). No silent fallback.
9. **FR-9**: When Codex synthesis fails after one or both planners succeeded, the stage must return `status: 'failed'`. The completed planner artifacts must remain on disk for manual inspection. No silent fallback to a raw planner output.
10. **FR-10**: Plan A, Plan B, Plan C, and divergence notes must be written to `.helix/sessions/<id>/` as `plan-a.md`, `plan-b.md`, `plan-c.md`, `divergence-notes.md`. A one-line summary with relative paths must be appended to `docs/sdlc-logs/<feature>/helix/journal.md`.
11. **FR-11**: The `Session` type must gain a `duelingPlanState?: { planA?: PlanArtifact; planB?: PlanArtifact; planC?: PlanArtifact; divergenceNotes?: string }` field. The authoritative `PlanArtifact` shape is defined in Section 9 (Data Model). The field must survive JSON round-trip through `SessionManager.persist()` (`packages/helix/src/session/session-manager.ts:96`).
12. **FR-12**: On resume, when `duelingPlanState.planA` and `duelingPlanState.planB` are both present and `duelingPlanState.planC` is absent, `executeDuelingPlanGeneration` must skip the parallel planner phase and proceed directly to Codex synthesis. When `duelingPlanState.planC` is also present, the system must proceed directly to the quality gate evaluation.
13. **FR-13**: The `Session` type must gain a `costByProvider?: Record<string, { totalUsd: number; callCount: number }>` field keyed by `${engine}:${model ?? 'unknown'}`. Every `modelRouter.execute()` return with `costUsd` must increment the corresponding entry.
14. **FR-14**: The existing `Plan Quality` gate (`packages/helix/src/pipeline/templates/holistic-audit.ts:291-313`) must run on the synthesized Plan C unchanged. The gate's `plan-review` output schema must not be altered.
15. **FR-15**: Plan-stage timeout must accommodate the dueling flow: `PLAN_GENERATION_TIMEOUT_MS` must be raised from 8 minutes to at least 18 minutes in the holistic-audit template **only when dueling planners are enabled**. The 8-minute budget remains for non-dueling runs.
16. **FR-16**: Cross-provider checkpoint reuse (existing `getOracleCheckpoint` and plan review carry-forward) must operate correctly with a GPT-5-backed Architecture oracle. Oracle checkpoints keyed on `findingsHash` must round-trip the `ExecutorResult` regardless of engine.

> All FRs are testable. FR-1 through FR-3 have unit-test coverage; FR-4 through FR-12 have integration coverage via `pipeline-engine.test.ts`; FR-13 through FR-16 have both unit and integration coverage. See §17 and the testing guide for the scenario-level matrix.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                                                                                       |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project lifecycle          | NONE         | Sub-feature runs inside HELIX CLI; no platform project data model is touched.                                                                                               |
| Agent lifecycle            | NONE         | HELIX orchestrates developer workflows, not runtime agents.                                                                                                                 |
| Customer experience        | NONE         | Internal tooling, no end-user surface.                                                                                                                                      |
| Integrations / channels    | NONE         | No channel impact.                                                                                                                                                          |
| Observability / tracing    | SECONDARY    | New per-provider cost accumulator; new plan-artifact persistence; journal entries include dueling summary.                                                                  |
| Governance / controls      | NONE         | No policy layer.                                                                                                                                                            |
| Enterprise / compliance    | NONE         | OpenAI API key is ambient (same as Codex CLI today); no new secret store.                                                                                                   |
| Admin / operator workflows | PRIMARY      | HELIX CLI operators are the primary persona. New config flags (`useOpenAiArchitectureOracle`, `enableDuelingPlanners`) and new session artifact files are operator-visible. |

### Related Feature Integration Matrix

| Related Feature                                                                             | Relationship Type | Why It Matters                                                                                       | Key Touchpoints                                                                                                                                    | Current State                       |
| ------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| [helix-autonomous-engineering-harness](../helix-autonomous-engineering-harness.md)          | extends           | Parent feature. This sub-feature adds cross-provider capability to the existing ALPHA harness.       | `src/models/model-router.ts`, `src/oracles/oracle-constellation.ts`, `src/pipeline/pipeline-engine.ts`, `src/pipeline/templates/holistic-audit.ts` | ALPHA — will remain ALPHA post-land |
| [helix-autonomous-harness-roadmap LLD](../../plans/helix-autonomous-harness-roadmap.lld.md) | closes-partial    | Partially closes `Future Work #1` (API-based executors) for OpenAI. `claude-api` remains open.       | `HELIX.md:507`                                                                                                                                     | DRAFT roadmap                       |
| [configuration-management](../configuration-management.md)                                  | configured by     | New `HelixConfig` flags (`useOpenAiArchitectureOracle`, `enableDuelingPlanners`) need documentation. | `packages/helix/src/runtime-config.ts`                                                                                                             | STABLE                              |

---

## 6. Design Considerations

No UI component. All surfaces are CLI output, session directory files, and the journal markdown.

The divergence-notes.md format is emitted by the Codex synthesizer as part of the synthesis prompt instructions. Structure (free-form prose, synthesizer decides ordering):

```
# Planning Convergence — <feature slug>

## Areas of agreement
- ...

## Key divergences
- Candidate A proposed X; Candidate B proposed Y. Resolution: ... (rationale)
- ...

## Future-readiness annotations
- Extension points preserved for ...
- Migration-cost considerations for ...
```

The synthesizer prompt must instruct Codex to emit Plan C first (to the primary output channel consumed by the pipeline) and the divergence notes second (to a secondary file via a stage output parser). A dedicated `plan-c-with-divergence` output schema extends the existing `slice-plan` schema with an optional `divergenceNotes` field.

---

## 7. Technical Considerations

- **Dynamic import pattern**: `OpenAiApiExecutor` must dynamically import `openai` the same way `ClaudeSdkExecutor` dynamically imports `@anthropic-ai/claude-agent-sdk` (`packages/helix/src/models/claude-sdk-executor.ts:124`). This avoids loading the dep when the executor is not invoked.
- **Streaming normalization**: `StreamEvent` from OpenAI's SSE stream must map to the existing `{ type, timestamp, message, details }` shape. Token usage deltas become `progress` events; tool-call deltas become `tool-use` events; final usage becomes the `costUsd` on `ExecutorResult`.
- **Cost extraction**: OpenAI returns usage metadata (`prompt_tokens`, `completion_tokens`, plus reasoning tokens for reasoning models). The executor must convert to USD using a model-pricing map maintained in the executor module. Provide a `MODEL_PRICING_USD` table keyed by model ID.
- **Parallel fan-out**: `executeDuelingPlanGeneration` uses `Promise.allSettled` (not `Promise.all`) so one planner's failure does not short-circuit the other. Results map to `{ status: 'fulfilled' | 'rejected', value?, reason? }`, and the solo-pass branch activates when exactly one is `'fulfilled'`.
- **Codex tool disable**: The synthesizer invocation must pass `efficiencyBudget: { disableToolUse: true, explorationTurns: 0, targetTurns: 8, hardTurnCap: 12 }` to prevent re-exploration. Codex must reason strictly from Candidate A + Candidate B + original context.
- **Session dir creation**: The session manager already creates `.helix/sessions/<id>/` on session start. Plan artifact writes append to that directory using `fs.promises.writeFile`.
- **No backpressure concern**: Parallel planner fan-out is bounded at 2 concurrent calls — well within normal API rate limits. No new concurrency manager needed.
- **Reasoning-model specifics**: If `gpt-5` is a reasoning model, streaming may emit a `reasoning` delta type. The executor must handle this without crashing; treat it as progress unless it affects cost.

---

## 8. How to Consume

### Studio UI

N/A — HELIX has no Studio UI surface. Operators interact via the CLI.

### Surface Semantics Matrix

N/A — HELIX is CLI + file-system only; no design-time / runtime split and no import/reuse semantics apply.

### Design-Time vs Runtime Behavior

N/A — no control-plane / runtime split.

### API (Runtime)

N/A — HELIX is not a runtime service; this feature adds no HTTP endpoints.

### API (Studio)

N/A.

### Admin Portal

N/A.

### Channel / SDK / Voice / A2A / MCP Integration

**MCP (helix-mcp)**: No new MCP tool in this feature (deferred). Existing tools continue to surface session state that now includes dueling-plan artifacts:

- `get_session` — returns session state including the new `costByProvider` and `duelingPlanState` fields.
- `list_gate_results` — returns plan-review gate results over the synthesized Plan C, unchanged in structure.
- `explain_blocker` — returns advisory for plan-stage failures, now including "planner-failure" and "codex-synthesis-failure" classes.
- `get_slice_packet` — unchanged; slices are derived from Plan C exactly as they are from the current single-model plan.

**CLI surfaces**:

- `helix audit <feature>` — when `enableDuelingPlanners` is on, plan stage emits additional progress lines: "Launching Planner A (claude-code/opus)…", "Launching Planner B (openai-api/gpt-5)…", "Synthesizing convergent plan (codex-cli/gpt-5.4)…", final "Plan C captured; divergence notes at .helix/sessions/<id>/divergence-notes.md".
- `helix logs <session-id>` — includes references to the new artifact files.
- `helix doctor` — validates `OPENAI_API_KEY` presence when `useOpenAiArchitectureOracle` or `enableDuelingPlanners` is enabled.

---

## 9. Data Model

### Collections / Tables

**Session JSON** (file at `.helix/sessions/<id>/session.json`, managed by `SessionManager`):

```text
Session (extended fields only; existing shape unchanged)
  costByProvider?: Record<string, {
    totalUsd: number;          // cumulative spend for this engine:model
    callCount: number;         // cumulative call count
  }>;
    // Keyed by `${engine}:${model ?? 'unknown'}`, e.g.
    //   "claude-code:claude-opus-4-7" → { totalUsd: 2.41, callCount: 3 }
    //   "openai-api:gpt-5"           → { totalUsd: 1.87, callCount: 1 }
    //   "codex-cli:gpt-5.4"          → { totalUsd: 0.52, callCount: 1 }

  duelingPlanState?: {
    planA?: PlanArtifact;
    planB?: PlanArtifact;
    planC?: PlanArtifact;
    divergenceNotes?: string;  // markdown
  };
```

```text
PlanArtifact
  output: string;              // full plan markdown (parse target for slice-plan schema)
  costUsd?: number;             // cost for this single planner call
  engine: ModelEngine;
  model: string;
  capturedAt: string;           // ISO timestamp
  durationMs: number;
  turnsUsed: number;
  soloPass?: boolean;           // true if this artifact survived as a solo-pass (sibling planner failed)
```

**Plan artifact files** (session directory, ephemeral):

```text
.helix/sessions/<id>/
  plan-a.md              # Candidate A (Claude Opus)
  plan-b.md              # Candidate B (GPT-5) — present unless solo-pass
  plan-c.md              # Convergent Plan C (Codex synthesis)
  divergence-notes.md    # Codex-authored convergence analysis
  session.json           # existing — now includes duelingPlanState + costByProvider
```

**Journal entry** (appended to `docs/sdlc-logs/<feature>/helix/journal.md`, one line per dueling run):

```text
- <ISO timestamp> — Dueling plans: Candidate A (claude-code/opus, $X.XX), Candidate B (openai-api/gpt-5, $X.XX), synthesized via codex-cli/gpt-5.4 ($X.XX). Divergences: <N summarized inline>.
```

### Key Relationships

- `duelingPlanState.planC.output` feeds the existing manifest-compilation stage as the authoritative plan. The slice manifest compiler does not distinguish between a single-model plan and a synthesized Plan C.
- `costByProvider` is independent of `duelingPlanState` — it accumulates across **every** model call in the session, not just the planning stage.
- Plan artifact files are session-scoped ephemeral state. They persist only until the session directory is cleaned up (existing HELIX convention). The journal summary in `docs/sdlc-logs/` is the durable record.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                    | Purpose                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/helix/src/models/openai-api-executor.ts`                      | **NEW** — `OpenAiApiExecutor implements ModelExecutor`; dynamic import of `openai` SDK; cost calculation; streaming; abort/stall handling.                                                                                                                                                                             |
| `packages/helix/src/models/model-router.ts`                             | UPDATE — register `OpenAiApiExecutor` at construction time (alongside `ClaudeSdkExecutor` and `CodexCliExecutor`); lines 48-67.                                                                                                                                                                                        |
| `packages/helix/src/oracles/oracle-constellation.ts`                    | UPDATE — Architecture oracle definition (lines 370-383) toggles to `engine: 'openai-api', model: 'gpt-5'` when `HelixConfig.useOpenAiArchitectureOracle` is true. Introduce a helper `resolveArchitectureOracle(config)` to compute the live definition.                                                               |
| `packages/helix/src/pipeline/engine/execute-dueling-plan-generation.ts` | **NEW** — `executeDuelingPlanGeneration(session, stage, startTime, stageDeadlineAt?)` special-stage executor; invoked via `SpecialStageExecutor.executeDuelingPlanGeneration` which resolves deps from `this.deps`. Runs parallel planners, synthesizes via Codex, persists artifacts, checkpoints intermediate state. |
| `packages/helix/src/pipeline/special-stage-executor.ts`                 | UPDATE — add `executeDuelingPlanGeneration` as a public method that delegates to the extracted module. Mirrors existing `executeOracleAnalysis` pattern.                                                                                                                                                               |
| `packages/helix/src/pipeline/pipeline-engine.ts`                        | UPDATE — add `'plan-generation'` dispatch case in `executeStage` (~line 1870) guarded by `this.config.enableDuelingPlanners`. Accumulate `costByProvider` in the post-execute hook that runs after every `modelRouter.execute()`.                                                                                      |
| `packages/helix/src/pipeline/engine/dueling-plan-synthesis-prompt.ts`   | **NEW** — builds the unlabeled synthesis prompt for Codex from Candidate A + Candidate B + feature context.                                                                                                                                                                                                            |
| `packages/helix/src/pipeline/templates/holistic-audit.ts`               | UPDATE — plan stage timeout is raised to 18 minutes when `enableDuelingPlanners` is on (compile-time check via helper `planStageTimeoutMs(config)`).                                                                                                                                                                   |
| `packages/helix/src/types.ts`                                           | UPDATE — extend `Session` with `costByProvider` and `duelingPlanState` fields; add `PlanArtifact` interface; extend `HelixConfig` with `useOpenAiArchitectureOracle` and `enableDuelingPlanners` booleans.                                                                                                             |
| `packages/helix/src/runtime-config.ts` + `packages/helix/src/cli.ts`    | UPDATE — `buildHelixConfig()` (in `cli.ts`, ~lines 1268-1321) gains two new CLI flags `--use-openai-architecture-oracle` and `--enable-dueling-planners`, both defaulting to `false`. The corresponding `HelixConfig` interface extension lives in `types.ts`.                                                         |
| `packages/helix/src/pipeline/stage-output-schema.ts`                    | UPDATE — add `plan-c-with-divergence` schema variant extending `slice-plan` with an optional `divergenceNotes` string field.                                                                                                                                                                                           |

### Routes / Handlers

N/A — no HTTP routes.

### UI Components

N/A — no UI.

### Jobs / Workers / Background Processes

N/A — HELIX runs in-process during the CLI command's lifetime.

### Tests

| File                                                                   | Type               | Coverage Focus                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/helix/src/__tests__/openai-api-executor.test.ts`             | unit               | **NEW** — executor availability, execution, streaming, cost extraction, abort, stall, structured output, error mapping                                                                                                                      |
| `packages/helix/src/__tests__/oracle-constellation.test.ts`            | unit + integration | UPDATE — Architecture-oracle swap with `openai-api`/`gpt-5`; consensus protocol with mixed engines; checkpoint reuse across engines                                                                                                         |
| `packages/helix/src/__tests__/model-router.test.ts`                    | unit               | UPDATE — `registerExecutor` with `openai-api`; engine availability; error when key missing                                                                                                                                                  |
| `packages/helix/src/__tests__/pipeline-engine.test.ts`                 | integration        | UPDATE — dueling dispatch under `enableDuelingPlanners`; solo-pass on single-planner failure; abort on double-planner failure; abort on Codex failure; resume between planner completion and Codex synthesis; `costByProvider` accumulation |
| `packages/helix/src/__tests__/execute-dueling-plan-generation.test.ts` | unit               | **NEW** — exhaustive tests of the extracted special-stage executor across success / partial-failure / full-failure matrices without the full pipeline                                                                                       |
| `packages/helix/src/__tests__/stage-runner.test.ts`                    | unit               | UPDATE — if the synthesis prompt introduces new slice-packet variables                                                                                                                                                                      |

---

## 11. Configuration

### Environment Variables

| Variable             | Default  | Description                                                                                                                        |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`     | _(none)_ | Required when `useOpenAiArchitectureOracle` or `enableDuelingPlanners` is enabled. Same key already consumed by `codex-cli` today. |
| `HELIX_OPENAI_MODEL` | `gpt-5`  | Optional override for Planner B and the Architecture oracle model ID.                                                              |

### Runtime Configuration

Extended `HelixConfig` (configured in `packages/helix/src/runtime-config.ts`):

| Field                         | Default   | Meaning                                                                                                           |
| ----------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `useOpenAiArchitectureOracle` | `false`   | When `true`, oracle constellation swaps the Architecture oracle to `openai-api/gpt-5`. Requires `OPENAI_API_KEY`. |
| `enableDuelingPlanners`       | `false`   | When `true`, plan-generation dispatches to dueling-planners + Codex synthesis. Requires `OPENAI_API_KEY`.         |
| `openaiModel`                 | `"gpt-5"` | Model ID for both the Architecture oracle and Planner B. Overridable per-spec.                                    |

Operators enable via `helix --use-openai-architecture-oracle --enable-dueling-planners audit <feature>`, or by setting the flags in a config file, or by environment variables (`HELIX_USE_OPENAI_ARCHITECTURE_ORACLE=1`, `HELIX_ENABLE_DUELING_PLANNERS=1`).

### DSL / Agent IR / Schema

No DSL or IR surface — HELIX is a CLI tool, not a runtime compiler target. The `slice-plan` stage output schema in `packages/helix/src/pipeline/stage-output-schema.ts` gains a `plan-c-with-divergence` variant; the parent schema is unchanged.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | N/A — HELIX is a local developer tool. It does not store data in shared databases; no `projectId` scoping applies.                                      |
| Tenant isolation  | N/A — HELIX runs per-developer; no `tenantId` scoping applies.                                                                                          |
| User isolation    | N/A — HELIX sessions live on the developer's local filesystem under `.helix/sessions/`. Multi-user isolation is OS file permissions, not feature logic. |

**Justification for N/A**: The TEMPLATE.md Isolation & Multitenancy section is designed for runtime/Studio services handling multi-tenant production data. HELIX is a developer CLI tool that orchestrates AI calls on the developer's workstation; none of its state is tenant- or project-scoped. The `packages/helix/CLAUDE.md` does not apply tenant rules, consistent with this framing.

### Security & Compliance

- **API keys**: `OPENAI_API_KEY` must be read only from `process.env` at executor-invocation time. The executor must **never** log or persist the key. The session JSON must not contain the key value under any circumstance.
- **Audit trail**: All model calls emit cost, duration, and turn metadata to the session JSON. This is sufficient for post-hoc audit; no new audit-log sink is introduced.
- **Secret redaction**: `StreamEvent.message` emitted by `OpenAiApiExecutor` must not interpolate request bodies or response bodies that could contain prompt content. Use existing HELIX redaction helpers (see `packages/helix/src/ui/progress-reporter.ts` for the pattern).
- **Data minimization**: Plan artifacts (`.helix/sessions/<id>/*.md`) contain reasoning about the developer's codebase and are treated the same as existing session journal files. No new data categories are introduced.

### Performance & Scalability

- **Wall-clock**: Dueling-plan flow adds ≈1.5× wall-clock to the plan stage in the worst case. Plan A and Plan B run in parallel (≤8 minutes each, wall-clock bounded by the slower of the two). Synthesis adds ≈3-6 minutes. Stage timeout raises from 8 → 18 minutes when dueling is enabled.
- **Token cost**: Approximately 2.5× the single-planner cost — two full plan generations plus a lighter synthesis pass.
- **Concurrency**: Parallel fan-out is bounded at 2 planners per session. Within API rate limits for all supported tiers.
- **Checkpoint reuse**: When Plan A and Plan B are already in `duelingPlanState`, resume skips directly to synthesis — no regeneration cost on interruption.

### Reliability & Failure Modes

- **Single planner failure**: Solo-pass through Codex. Pipeline continues. Advisory notes which planner failed and why.
- **Both planners fail**: Plan stage returns `status: 'failed'`. Pipeline aborts via `handleBlockingStageResult`. Operator must diagnose (API key, model availability, network) and resume.
- **Codex synthesis fails**: Plan stage returns `status: 'failed'`. Planner A and B artifacts are preserved on disk. Operator can read them, diagnose, and resume (which will re-attempt synthesis from the persisted Plan A / Plan B).
- **Resume idempotency**: `duelingPlanState` is persisted atomically after each successful planner completion and before Codex synthesis begins. Re-entering the stage after interrupt reads the checkpoint and skips completed sub-steps.
- **Clock skew / retry**: The existing `efficiencyBudget` stall detection applies to all three model calls. No new retry semantics are introduced.
- **No silent fallback**: Explicit user directive. The executor does not degrade to single-model on synthesis failure. Failure is surfaced, not swallowed.

### Observability

- **Progress events**: New event messages during plan stage: "Launching Planner A", "Launching Planner B", "Planner A complete ($X.XX)", "Planner B complete ($X.XX)", "Synthesizing via Codex", "Plan C captured".
- **Session cost summary**: `costByProvider` is dumped to the CLI at session end via existing `helix status <session-id>` output (update the formatter to include the new field).
- **Journal entries**: One line per dueling run in `docs/sdlc-logs/<feature>/helix/journal.md` as specified in §9.
- **Artifact files**: `plan-a.md`, `plan-b.md`, `plan-c.md`, `divergence-notes.md` in the session directory — operator-inspectable at any time.
- **MCP tool surface**: No new tools. Existing `get_session` returns the extended `Session` shape (forward-compatible — older MCP clients will ignore unknown fields).

### Data Lifecycle

- **Plan artifact TTL**: Tied to session directory TTL (existing HELIX convention — sessions persist indefinitely unless the developer deletes them).
- **Journal entries**: Durable in `docs/sdlc-logs/` unless the file is manually truncated. No automated retention.
- **Cost accumulators**: Persist in session JSON for the life of the session.
- **API key**: Never persisted. Environment-only.

---

## 13. Delivery Plan / Work Breakdown

1. **Phase 1 — `openai-api` executor + Architecture oracle swap**
   1.1 Add `openai` to `packages/helix/package.json` dependencies; run `pnpm install`; verify no lockfile churn elsewhere.
   1.2 Implement `OpenAiApiExecutor` in `packages/helix/src/models/openai-api-executor.ts` following the `ClaudeSdkExecutor` pattern (dynamic import, streaming, cost extraction, abort, stall detection, structured output).
   1.3 Register the executor in `ModelRouter` constructor (`packages/helix/src/models/model-router.ts` lines 48-67).
   1.4 Extend `HelixConfig` with `useOpenAiArchitectureOracle`, `enableDuelingPlanners`, `openaiModel`; wire defaults in `runtime-config.ts`.
   1.5 Extract `resolveArchitectureOracle(config)` helper in `oracle-constellation.ts`; swap to `engine: 'openai-api', model: 'gpt-5'` when config flag is set.
   1.6 Extend `Session` with `costByProvider`; accumulate in `pipeline-engine.ts` after every `modelRouter.execute()` return.
   1.7 Add `helix doctor` validation: when either flag is set, `OPENAI_API_KEY` must be present.
   1.8 Unit tests: `openai-api-executor.test.ts` (new); updates to `model-router.test.ts` and `oracle-constellation.test.ts`.
   1.9 Integration test: end-to-end oracle-analysis stage with swapped Architecture oracle, verifying consensus still operates and cost is attributed per provider.

2. **Phase 2 — Dueling-planners convergence**
   2.1 Extend `Session` with `duelingPlanState` and `PlanArtifact`; extend `stage-output-schema.ts` with `plan-c-with-divergence`.
   2.2 Implement `executeDuelingPlanGeneration` in a new `packages/helix/src/pipeline/engine/execute-dueling-plan-generation.ts` module (parallel fan-out via `Promise.allSettled`, partial-failure handling, checkpoint persistence, Codex invocation with tool use disabled, artifact file writes).
   2.3 Add `dueling-plan-synthesis-prompt.ts` with the unlabeled synthesis prompt builder.
   2.4 Expose `executeDuelingPlanGeneration` through `special-stage-executor.ts`.
   2.5 Dispatch from `pipeline-engine.ts` when stage type is `'plan-generation'` and `enableDuelingPlanners` is true.
   2.6 Raise plan-generation timeout to 18 minutes when `enableDuelingPlanners` is on via a runtime override at the dispatch site in `PipelineEngine.executeStage()` — the template is a static `const` and cannot access runtime config at construction time. See [LLD §3 Phase 2 Commit 2.B Task 2.B.3](../../plans/2026-04-19-cross-provider-quorum-convergence-impl-plan.md) for details.
   2.7 Unit tests: `execute-dueling-plan-generation.test.ts` (new); covers all failure-mode permutations.
   2.8 Integration tests: update `pipeline-engine.test.ts` with full plan-stage dueling flow, resume scenarios, cost attribution across providers.
   2.9 Update `packages/helix/agents.md` with a learning journal entry describing the dueling-plan pattern and the artifact persistence convention.

3. **Phase 3 — Documentation + rollout**
   3.1 Update `docs/features/helix-autonomous-engineering-harness.md` §Future Work #1 to note that `openai-api` is now implemented.
   3.2 Update `packages/helix/HELIX.md` architecture table and model strategy sections.
   3.3 Add operator-facing usage notes to the HELIX README covering the two new flags.
   3.4 Post-impl sync (run `/post-impl-sync cross-provider-quorum-convergence` after Phase 2 completes) to update the testing README and feature status → ALPHA.

### Delivery Status

| Phase | Commit | SHA         | Description                                                                                       |
| ----- | ------ | ----------- | ------------------------------------------------------------------------------------------------- |
| 1     | 1.A    | `65776e961` | Scaffolding: types, config, executor, router registration                                         |
| 1     | 1.B    | `83d561063` | Oracle swap + cost accumulator + CLI + doctor                                                     |
| 1     | 1.C    | `b4569cd26` | Phase 1 unit/integration/E2E tests                                                                |
| 2     | 2.A    | `41a85b7dc` | plan-c-with-divergence schema + dueling synthesis prompt                                          |
| 2     | 2.B    | `d6d7253fb` | Dueling-plan orchestrator + pipeline dispatch                                                     |
| 2     | 2.C    | `f5ca6d2ed` | Phase 2 tests                                                                                     |
| 3     | 3      | `7de9cbdd0` | Doc sync + status promotion to ALPHA                                                              |
| 3     | R4-fix | `8417ffe13` | Audit round-4 follow-up: codex binary check in `helix doctor` when `enableDuelingPlanners` is set |

---

## 14. Success Metrics

| Metric                                 | Baseline                  | Target                                                                                 | How Measured                                                                   |
| -------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Plan-stage provider diversity          | 1 provider (Claude only)  | 2 providers (Claude + OpenAI) when `enableDuelingPlanners` is on                       | Presence of both engines in `duelingPlanState.planA.engine` and `planB.engine` |
| Architecture-oracle provider diversity | 1 provider                | 2 providers across the 4-oracle constellation when `useOpenAiArchitectureOracle` is on | Architecture oracle `executorResult.engine === 'openai-api'`                   |
| Convergence paper-trail availability   | 0% (no artifacts)         | 100% of dueling runs produce plan-a.md + plan-b.md + plan-c.md + divergence-notes.md   | File existence check at session end                                            |
| Solo-pass resilience                   | N/A                       | Pipeline continues when exactly one planner fails                                      | Integration-test scenario (`one-planner-fails.test.ts`) passes                 |
| Hard-abort discipline                  | N/A                       | 0 instances of silent fallback to single-model plan when both planners or Codex fails  | Assertion in integration tests; code review gate                               |
| Resume efficiency                      | N/A                       | Resume after Plan A + Plan B completion costs $0 to re-reach synthesis                 | `costByProvider` before/after resume comparison; Plan A+B not re-invoked       |
| Cost transparency                      | No per-provider breakdown | `costByProvider` present on every session after any model call                         | Session JSON inspection                                                        |

All metrics are binary/inspectable; no telemetry pipeline or dashboard is introduced.

---

## 15. Open Questions

1. **GPT-5 availability and pricing at implementation time** — The DECIDED model (`gpt-5`) assumes OpenAI's flagship reasoning model is available to the developer running HELIX. If `gpt-5` is not yet GA or is rate-limited, the default should fall back to the next-best reasoning model with a documented rationale. Tracked for /lld phase.
2. **Divergence-notes persistence when synthesis fails mid-stream** — If Codex emits partial divergence notes before crashing, should the partial output be preserved or discarded? Leaning discard (no partial artifacts — only full-run persistence), but open for implementation discussion.
3. **Cost cap interaction with dueling** — Today `budgetLimitUsd` (HELIX global) applies per-session. Two planners + a synthesis pass consumes roughly 2.5× the prior plan-stage spend. Should there be a dueling-specific cap, or does the global cap suffice? Leaning global-cap-suffices (dueling is opt-in, operators know the cost).
4. **Journal summary format stability** — The one-line journal entry format in §9 is informal. If downstream tooling ever parses the journal, a more structured format (JSON line) may be preferable. Defer until such a consumer exists.
5. **Timeout tuning** — 18-minute stage timeout is an estimate. If production runs show it's too tight (planner 8min + synthesis 6min + overhead 2min = 16min), may need to raise to 20-25. Revisit after first production run.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                                       | Severity | Status                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------ |
| GAP-001 | `claude-api` executor remains unimplemented — only `openai-api` is added in this feature. The `'claude-api'` ModelEngine value in `types.ts:272` is still orphaned.                                                                                               | Medium   | Open — tracked as separate future feature              |
| GAP-002 | Other oracle roles (Codebase, Testing, Domain) remain Claude-only. Cross-provider dissent is limited to the Architecture role for Phase 1.                                                                                                                        | Medium   | Open — intentional scope boundary                      |
| GAP-003 | No MCP tool for programmatic divergence inspection. Operators must read `divergence-notes.md` from the session directory.                                                                                                                                         | Low      | Open — deferred by design                              |
| GAP-004 | No automated cost-vs-accuracy evaluation. There is no mechanism to label "did dueling catch a real issue that single-model missed?" beyond manual review.                                                                                                         | Medium   | Open — requires learned-autonomy Future Work           |
| GAP-005 | GPT-5 availability is assumed; if unavailable at deploy time, the `openaiModel` default must be revisited manually.                                                                                                                                               | Low      | Open — revisit during /lld                             |
| GAP-006 | No telemetry or observability surface beyond local session files. A platform engineer cannot aggregate cross-session dueling performance without running a local script.                                                                                          | Low      | Open — deferred to observability-dashboard Future Work |
| GAP-007 | Codex synthesis quality is unvalidated. The assumption is that Codex (GPT-5.4) will produce a superior convergent plan compared to either input alone. If validation shows otherwise, a different synthesizer (Claude Opus, a separate model) may be substituted. | Medium   | Open — first-run observation needed                    |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                                 | Coverage Type | Status | Test File / Note                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------- | ------ | -------------------------------------------------------------------- |
| 1   | `OpenAiApiExecutor.isAvailable()` returns true when key present, false otherwise                                         | unit          | PASS   | `openai-api-executor.test.ts`                                        |
| 2   | `OpenAiApiExecutor.execute()` produces populated `ExecutorResult` for a happy-path call                                  | unit          | PASS   | `openai-api-executor.test.ts`                                        |
| 3   | Streaming events map correctly to `StreamEvent` shape                                                                    | unit          | PASS   | `openai-api-executor.test.ts`                                        |
| 4   | `costUsd` extracted from usage metadata                                                                                  | unit          | PASS   | `openai-api-executor.test.ts`                                        |
| 5   | Abort signal propagates to the SDK and cancels in-flight call                                                            | unit          | PASS   | `openai-api-executor.test.ts`                                        |
| 6   | Structured output via `response_format: { type: 'json_schema' }` round-trips                                             | unit          | PASS   | `openai-api-executor.test.ts`                                        |
| 7   | `maxBudgetUsd` halts request when cumulative cost exceeds cap                                                            | unit          | PASS   | `openai-api-executor.test.ts`                                        |
| 8   | `ModelRouter` routes `'openai-api'` to the registered executor                                                           | unit          | PASS   | `model-router.test.ts`                                               |
| 9   | Oracle constellation with Architecture on `openai-api` runs consensus across 4 oracles                                   | integration   | PASS   | `oracle-constellation.test.ts`                                       |
| 10  | Oracle checkpoint reuse works when the Architecture oracle engine is `openai-api`                                        | unit          | PASS   | `oracle-constellation.test.ts`                                       |
| 11  | Plan-generation dispatches to dueling when flag is on; generic loop when off                                             | integration   | PASS   | `pipeline-engine.test.ts`                                            |
| 12  | Dueling happy path — Plan A + Plan B in parallel, Plan C synthesized, artifacts written                                  | integration   | PASS   | `pipeline-engine.test.ts`, `execute-dueling-plan-generation.test.ts` |
| 13  | Solo-pass — Planner B fails, Plan A flows through Codex, Plan C produced                                                 | integration   | PASS   | `execute-dueling-plan-generation.test.ts`                            |
| 14  | Solo-pass — Planner A fails, Plan B flows through Codex, Plan C produced                                                 | integration   | PASS   | `execute-dueling-plan-generation.test.ts`                            |
| 15  | Both planners fail → stage returns `status: 'failed'`, no silent fallback                                                | integration   | PASS   | `execute-dueling-plan-generation.test.ts`                            |
| 16  | Codex synthesis fails → stage returns `status: 'failed'`, Plan A + B artifacts preserved                                 | integration   | PASS   | `execute-dueling-plan-generation.test.ts`                            |
| 17  | Resume between Plan A+B completion and Codex synthesis skips planner regeneration                                        | integration   | PASS   | `pipeline-engine.test.ts`                                            |
| 18  | Resume after Plan C completion skips directly to quality-gate evaluation                                                 | integration   | PASS   | `pipeline-engine.test.ts`                                            |
| 19  | `costByProvider` accumulator increments correctly across mixed-provider runs                                             | unit          | PASS   | `pipeline-engine.test.ts`                                            |
| 20  | `helix doctor` errors when `useOpenAiArchitectureOracle` is set but `OPENAI_API_KEY` is missing                          | unit          | PASS   | `doctor.test.ts`                                                     |
| 21  | Plan artifact files are written with expected content and ordering                                                       | integration   | PASS   | `execute-dueling-plan-generation.test.ts`                            |
| 22  | Journal entry is appended with correct format and cost summary                                                           | integration   | PASS   | `pipeline-engine.test.ts`                                            |
| 23  | Config defaults (`useOpenAiArchitectureOracle: false`, `enableDuelingPlanners: false`) leave existing behavior unchanged | integration   | PASS   | `pipeline-engine.test.ts`                                            |

### Testing Notes

All 23 scenarios are in `PASS` state (741 tests passing, 0 feature-related failures; 1 pre-existing flake in `concerns-audit.test.ts` unrelated to this feature). Feature promoted to ALPHA. BETA promotion deferred until scenarios 1-23 all pass in sustained local runs per §14 success metrics.

The testing guide covers the same 16 functional requirements across a different scenario decomposition: 8 E2E scenarios (in-process pipeline runs), 11 integration scenarios, 10 unit scenarios, 3 security/isolation scenarios, and 3 performance scenarios. Scenario numbering across the two documents differs but coverage is equivalent — the testing guide's E2E-1…E2E-8 exercise feature-spec matrix rows 11-18 and 21-23; INT-1…INT-11 cover rows 1-10, 19-20, plus dispatch-wiring/quality-gate flow-through/concurrent-persist/error-path matrix added by the test-spec oracle; UT-1…UT-10 cover pure-function helpers extracted from rows 1-7 and 19.

The feature does not need a Studio E2E test (no UI). HTTP-level E2E is N/A (no runtime routes). Integration tests exercise HELIX in-process as the realistic deployment shape.

> Full testing details: [../../testing/sub-features/cross-provider-quorum-convergence.md](../../testing/sub-features/cross-provider-quorum-convergence.md)

---

## 18. References

- Parent feature spec: [helix-autonomous-engineering-harness](../helix-autonomous-engineering-harness.md)
- HELIX vision: `packages/helix/HELIX.md`
- HELIX operational rules: `packages/helix/CLAUDE.md`
- HELIX learning journal: `packages/helix/agents.md`
- Roadmap LLD: [../../plans/helix-autonomous-harness-roadmap.lld.md](../../plans/helix-autonomous-harness-roadmap.lld.md)
- Model Router: `packages/helix/src/models/model-router.ts`
- Oracle Constellation: `packages/helix/src/oracles/oracle-constellation.ts`
- Pipeline Engine: `packages/helix/src/pipeline/pipeline-engine.ts`
- Holistic Audit template: `packages/helix/src/pipeline/templates/holistic-audit.ts`
- Types: `packages/helix/src/types.ts` (ModelEngine union at line 269-273)
- Feature spec log: [../../sdlc-logs/cross-provider-quorum-convergence/feature-spec.log.md](../../sdlc-logs/cross-provider-quorum-convergence/feature-spec.log.md)
