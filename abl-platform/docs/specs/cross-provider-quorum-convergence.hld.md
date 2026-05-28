# HLD: Cross-Provider Quorum & Planning Convergence

**Feature Spec**: [`docs/features/sub-features/cross-provider-quorum-convergence.md`](../features/sub-features/cross-provider-quorum-convergence.md)
**Test Spec**: [`docs/testing/sub-features/cross-provider-quorum-convergence.md`](../testing/sub-features/cross-provider-quorum-convergence.md)
**HLD Log**: [`docs/sdlc-logs/cross-provider-quorum-convergence/hld.log.md`](../sdlc-logs/cross-provider-quorum-convergence/hld.log.md)
**Status**: DRAFT
**Author**: Prasanna Arikala
**Date**: 2026-04-19
**Ticket**: ABLP-406
**Scope**: `packages/helix/` only — no runtime, Studio, or platform service surface

---

## 1. Problem Statement

HELIX's oracle constellation and plan-generation both route exclusively through Claude (Opus/Sonnet via the Claude Code SDK). Four of four oracles share one provider, and plan generation is single-model. Any systematic blind spot in the provider's model goes uncontradicted — the consensus protocol has no structural path to dissent, and the implementation plan that feeds slicing reflects a single lab's reasoning priors throughout the session.

The `ModelEngine` union in `packages/helix/src/types.ts:269-273` already declares `'openai-api'` as a valid engine, but no executor exists (`packages/helix/src/models/model-router.ts:48-67` registers only `claude-code` and `codex-cli`). HELIX.md §Future Work #1 names this gap. The dueling-plans convergence pattern has not been attempted.

The feature introduces genuine provider independence at HELIX's two highest-leverage decision points (Architecture oracle + plan generation) while preserving CLI executors as the production default, checkpoint/resume semantics, and operator autonomy (paper trail, no human-in-the-loop checkpoint).

---

## 2. Alternatives Considered

### Option A (REJECTED): API executors for every stage (ambient cross-provider)

**Description**: Implement `openai-api` + `claude-api`, then let operators freely mix engines across every stage (implementation, reproduction, regression, slice synthesis).

**Pros**:

- Maximum flexibility.
- Closes both `Future Work` items at once.

**Cons**:

- Drops the CLI executors' killer feature: bundled Read/Grep/Glob/bash tools. Implementation and reproduction stages need code exploration; API-only executors would require us to reinvent the tool loop (badly).
- Combinatorial test surface (≈16 provider × stage combinations) vs. 2 surgical swaps.
- Conflicts with explicit user directive: "CLI executors remain the default production path."

**Effort**: L

### Option B (REJECTED): Dueling planners only, no oracle swap

**Description**: Add dueling planners at plan-generation but keep all 4 oracles on Claude.

**Pros**:

- Smaller surface — one executor, one dispatch site.
- Simpler test matrix.

**Cons**:

- Consensus protocol remains monoculture. The oracle constellation is HELIX's architectural safety net; leaving it single-provider misses half the cross-provider value.
- Sets a precedent that the oracle layer is the "harder" surface, when in fact it is a trivial config swap (one role definition, `openai-api` executor already built for planners).
- Wastes 80% of the infra investment (executor + router wiring + cost attribution) on a single dispatch site.

**Effort**: M

### Option C (CHOSEN): OpenAI executor + Architecture oracle swap + dueling planners

**Description**: Single bundled feature — `OpenAiApiExecutor` + Architecture oracle GPT-5 swap + dueling planners with Codex Plan-C synthesis. Gated by two independent config flags (`useOpenAiArchitectureOracle`, `enableDuelingPlanners`) so each capability can ship/rollback independently.

**Pros**:

- Amortizes executor + cost-attribution infra across two consumer sites.
- Matches user directive ("Option A bundled" from design conversation).
- Two-flag independent rollback lets us retreat from dueling without losing the oracle swap (or vice versa).
- Addresses both the highest-leverage decision points (architecture vote + plan output) in one shippable unit.

**Cons**:

- Bigger PR surface than Option B.
- Two config flags = four state combinations to test (all-off, dueling-only, oracle-only, both-on).

**Effort**: L (but correctly sized for the problem)

### Recommendation: **Option C**

**Rationale**: Matches the user's locked scope from the design conversation ("Option A bundled"). CLI executors remain default (per directive), OpenAI is additive/opt-in (per directive), rollback path is strictly additive-to-ignore (unset the flag). The extra surface versus Option B is trivial — Architecture oracle swap is one `resolveArchitectureOracle(config)` helper plus one branch in `oracle-constellation.ts:370-383` — and earns the other half of the cross-provider value.

---

## 3. Architecture

### 3.1 System Context Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           HELIX CLI process (developer workstation)              │
│                                                                                  │
│  ┌──────────┐   ┌────────────────┐     ┌──────────────────────────────────────┐ │
│  │ helix    │──▶│ PipelineEngine │────▶│         OracleConstellation          │ │
│  │ audit    │   │  (run loop)    │     │  Codebase │ Testing │ Domain │ Arch  │ │
│  └──────────┘   └────────┬───────┘     └────┬──────────┬─────────┬──────┬─────┘ │
│                          │                  │          │         │      │       │
│                          │              claude-code  claude   claude  openai-api│
│                          ▼                                          (flagged)   │
│                   executeStage(…)                                               │
│                          │                                                       │
│                          ├─▶ plan-generation (flagged) ──▶ SpecialStageExecutor  │
│                          │                                  .executeDuelingPlan…│
│                          │                                         │             │
│                          │                                         ▼             │
│                          │    ┌──────── Promise.allSettled ────────┐             │
│                          │    ▼                                    ▼             │
│                          │  ModelRouter.execute(              ModelRouter.execute│
│                          │    claude-code, opus)               (openai-api,      │
│                          │    → Plan A                          gpt-5) → Plan B  │
│                          │         │                                 │            │
│                          │         └─────────────┬───────────────────┘            │
│                          │                       ▼                                │
│                          │           ModelRouter.execute(codex-cli, gpt-5.4,      │
│                          │             efficiencyBudget.disableToolUse=true)     │
│                          │             → Plan C + divergence-notes                │
│                          │                                                        │
│                          └─▶ (all other stages) ──▶ generic model-execution loop  │
│                                                                                   │
└───────────────────────────────────┬───────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼─────────────────┐
                    ▼               ▼                 ▼
            ┌───────────────┐ ┌──────────────┐ ┌──────────────────────┐
            │ Claude Code    │ │ OpenAI API   │ │ Codex CLI subprocess │
            │ SDK (dyn-imp)  │ │ SDK (dyn-imp)│ │ (exec + stdio)       │
            └───────────────┘ └──────────────┘ └──────────────────────┘
                                    │
                        Anthropic API / OpenAI API
```

### 3.2 Component Diagram (packages/helix/src/)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                           packages/helix/src/                                   │
│                                                                                 │
│  ┌────────────────┐                                                             │
│  │ cli.ts         │── buildHelixConfig() reads --enable-dueling-planners,       │
│  │                │   --use-openai-architecture-oracle, --openai-model          │
│  └────────┬───────┘                                                             │
│           │                                                                     │
│           ▼                                                                     │
│  ┌────────────────┐   ┌──────────────────────┐                                  │
│  │ runtime-config │   │ types.ts             │                                  │
│  │ (defaults)     │   │ HelixConfig          │    Session {                     │
│  │                │──▶│   .useOpenAiArch…    │      costByProvider?: …         │
│  │                │   │   .enableDueling…    │      duelingPlanState?: …       │
│  │                │   │   .openaiModel       │    }                            │
│  └────────────────┘   └──────────────────────┘                                  │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │ models/                                                                  │   │
│  │ ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────────┐   │   │
│  │ │ model-router │──│ claude-sdk-  │  │ openai-api-executor.ts  [NEW]  │   │   │
│  │ │   .execute() │  │ executor     │  │   • dynamic import('openai')   │   │   │
│  │ │   registers: │──│              │  │   • streaming → StreamEvent    │   │   │
│  │ │   claude-code│  │ codex-cli-   │  │   • costUsd from usage meta    │   │   │
│  │ │   codex-cli  │──│ executor     │  │   • abort / stall detection    │   │   │
│  │ │   openai-api │  │              │  │   • MODEL_PRICING_USD table    │   │   │
│  │ │   [NEW: reg] │  └──────────────┘  └────────────────────────────────┘   │   │
│  │ │   + cost     │                                                           │   │
│  │ │   hook [NEW] │                                                           │   │
│  │ └──────────────┘                                                           │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │ oracles/                                                                 │   │
│  │ ┌───────────────────────────────────────────────────────────────────┐    │   │
│  │ │ oracle-constellation.ts                                            │    │   │
│  │ │   resolveArchitectureOracle(config) [NEW helper]                   │    │   │
│  │ │     config.useOpenAiArchitectureOracle                             │    │   │
│  │ │       ? { engine: 'openai-api', model: config.openaiModel }        │    │   │
│  │ │       : { engine: 'claude-code', model: 'opus' }  [existing]       │    │   │
│  │ └───────────────────────────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │ pipeline/                                                                │   │
│  │ ┌───────────────────────────────────────────────────────────────────┐    │   │
│  │ │ pipeline-engine.ts                                                 │    │   │
│  │ │   executeStage(stage, session, …)  [line ~1870]                    │    │   │
│  │ │     if (stage.type === 'plan-generation' &&                        │    │   │
│  │ │         this.config.enableDuelingPlanners)                         │    │   │
│  │ │       return this.specialStage.executeDuelingPlanGeneration(…);    │    │   │
│  │ │     // existing dispatch unchanged                                 │    │   │
│  │ │   accumulateProviderCost(session, executorResult)  [NEW]           │    │   │
│  │ │     after every modelRouter.execute() return                       │    │   │
│  │ └───────────────┬───────────────────────────────────────────────────┘    │   │
│  │                 │                                                         │   │
│  │                 ▼                                                         │   │
│  │ ┌───────────────────────────────────────────────────────────────────┐    │   │
│  │ │ special-stage-executor.ts                                          │    │   │
│  │ │   executeDuelingPlanGeneration(                                    │    │   │
│  │ │     session, stage, startTime, stageDeadlineAt?                    │    │   │
│  │ │   ) → Promise<StageResult>                                         │    │   │
│  │ │   (class method on SpecialStageExecutor — accesses modelRouter,    │    │   │
│  │ │   sessionManager, journal, config, reporter via this.deps; matches │    │   │
│  │ │   the 7 existing methods' signature. Delegates orchestration to   │    │   │
│  │ │   the extracted engine/execute-dueling-plan-generation module.)   │    │   │
│  │ └───────────────┬───────────────────────────────────────────────────┘    │   │
│  │                 │                                                         │   │
│  │                 ▼                                                         │   │
│  │ ┌───────────────────────────────────────────────────────────────────┐    │   │
│  │ │ engine/execute-dueling-plan-generation.ts [NEW]                    │    │   │
│  │ │   1. If duelingPlanState.planA + planB checkpointed, skip to (3).  │    │   │
│  │ │   2. Promise.allSettled([planA, planB])                            │    │   │
│  │ │      • per-planner .then(() => persist(session)) eager write       │    │   │
│  │ │      • writeFile plan-a.md / plan-b.md as they land                │    │   │
│  │ │   3. Classify results:                                             │    │   │
│  │ │      • 0 fulfilled → status:'failed'                               │    │   │
│  │ │      • 1 fulfilled → solo-pass branch (soloPass=true)              │    │   │
│  │ │      • 2 fulfilled → dueling-pass branch                           │    │   │
│  │ │   4. Synthesize via Codex (disableToolUse=true)                    │    │   │
│  │ │      • parse with plan-c-with-divergence schema                    │    │   │
│  │ │      • writeFile plan-c.md + divergence-notes.md                   │    │   │
│  │ │      • persist planC into duelingPlanState                         │    │   │
│  │ │   5. Append one-line summary via deps.journal(…)                   │    │   │
│  │ │   6. Return status:'passed' with stageOutput = Plan C              │    │   │
│  │ └───────────────────────────────────────────────────────────────────┘    │   │
│  │ ┌───────────────────────────────────────────────────────────────────┐    │   │
│  │ │ engine/dueling-plan-synthesis-prompt.ts [NEW]                      │    │   │
│  │ │   buildSynthesisPrompt({ candidateA, candidateB?, context })       │    │   │
│  │ │     → string (unlabeled "Candidate A" / "Candidate B")             │    │   │
│  │ └───────────────────────────────────────────────────────────────────┘    │   │
│  │ ┌───────────────────────────────────────────────────────────────────┐    │   │
│  │ │ stage-output-schema.ts  +  stage-output-parsers.ts                 │    │   │
│  │ │   'plan-c-with-divergence' extends 'slice-plan' with               │    │   │
│  │ │   optional divergenceNotes string                                  │    │   │
│  │ └───────────────────────────────────────────────────────────────────┘    │   │
│  │ ┌───────────────────────────────────────────────────────────────────┐    │   │
│  │ │ templates/holistic-audit.ts (static const — unchanged)             │    │   │
│  │ │   PLAN_GENERATION_TIMEOUT_MS = 8 * MINUTE_MS  (preserved)          │    │   │
│  │ │   18-minute dueling timeout applied as runtime override at the     │    │   │
│  │ │   pipeline-engine.ts dispatch site (see §4 concern #9).            │    │   │
│  │ └───────────────────────────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │ session/                                                                 │   │
│  │   session-manager.ts                                                     │   │
│  │     persist(session)           line 96 — unchanged signature             │   │
│  │     addJournalEntry(…)         line 206 — public entry; eager writes go  │   │
│  │                                here (internally invokes private          │   │
│  │                                appendToJournalFile at line 233)          │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Data Flow — Dueling plan generation (happy path)

```
1. PipelineEngine.run() advances stage queue → stage.type === 'plan-generation'
2. PipelineEngine.executeStage() checks stage.type === 'plan-generation' &&
   this.config.enableDuelingPlanners → true
3. Overrides stage.timeoutMs → 18*MINUTE_MS (only when dueling enabled; default
   PLAN_GENERATION_TIMEOUT_MS=8min is preserved otherwise — see §9 Operational
   Concerns and HIGH-2 decision below).
4. Delegates to this.specialStageExecutor.executeDuelingPlanGeneration(
     session, stage, startTime, stageDeadlineAt
   )  — all dependencies resolved from this.deps on the class.
5. executeDuelingPlanGeneration() reads session.duelingPlanState?:
      {} → no prior state; launch both planners
      { planA, planB } → skip to step 8 (synthesis only)
      { planA, planB, planC } → return early with passed status
6. Launch in parallel via Promise.allSettled([
     this.deps.modelRouter.execute({engine:'claude-code', model:'opus',
                                    prompt: samePrompt, ...})
       .then(r => { session.duelingPlanState.planA = …;
                    await this.deps.sessionManager.persist(session);
                    await writeFile('plan-a.md'); return r; }),
     this.deps.modelRouter.execute({engine:'openai-api', model:'gpt-5',
                                    prompt: samePrompt, ...})
       .then(r => { session.duelingPlanState.planB = …;
                    await this.deps.sessionManager.persist(session);
                    await writeFile('plan-b.md'); return r; })
   ])
7. Classify results → { fulfilled: 2, rejected: 0 } | { fulfilled: 1, rejected: 1 } | …
8. Build synthesis prompt (unlabeled Candidate A / Candidate B) → Codex invocation:
     this.deps.modelRouter.execute({
       engine: 'codex-cli', model: 'gpt-5.4',
       prompt: synthesisPrompt,
       efficiencyBudget: { disableToolUse: true, explorationTurns: 0,
                           targetTurns: 8, hardTurnCap: 12 },
       outputSchema: 'plan-c-with-divergence'
     })
9. Parse Codex output → { planC: string, divergenceNotes: string }
10. Persist planC + divergenceNotes into session.duelingPlanState;
    writeFile plan-c.md + divergence-notes.md; persist(session)
11. this.deps.journal(session, oneLineSummaryEntry)
12. accumulateProviderCost fires for each of the 3 modelRouter.execute returns
13. Return StageResult { status:'passed', stageOutput: planC,
      advisoryEntries: [synthesisSummary] }
14. Pipeline continues into Plan Quality gate over Plan C (unchanged)
```

### 3.4 Sequence Diagram — Partial failure (Planner B fails)

```
PipelineEngine  SpecialStage  executeDueling  ModelRouter(A)  ModelRouter(B)  Codex  SessionMgr
     │             │              │              │               │            │        │
     │─executeStage┼──────────────┼──────────────┼───────────────┼────────────┼────────┤
     │             │─executeDueli─┼──────────────┼───────────────┼────────────┼────────┤
     │             │              │─allSettled───▶               │            │        │
     │             │              │              │──execute──────▶            │        │
     │             │              │              │               │──execute──▶         │
     │             │              │              │               │            │        │
     │             │              │              │◀──ok──────────│            │        │
     │             │              │◀─planA write plan-a.md ──────┼────persist─┼────────▶│
     │             │              │              │               │◀─err──     │        │
     │             │              │◀─settled { fulfilled:1, rej:1 } ──────────┼────────┤
     │             │              │              │               │            │        │
     │             │              │──build solo-pass synthesis prompt (Plan A only) ───┤
     │             │              │──execute(codex-cli, disableToolUse=true)──▶        │
     │             │              │              │               │            │        │
     │             │              │◀─plan C + divergence-notes ─────────────────        │
     │             │              │──write plan-c.md + divergence-notes.md──────────────▶
     │             │              │──persist duelingPlanState (planC added)─────────────▶
     │             │              │──journal( "...soloPass=A..." )──────────────────────▶
     │             │◀──StageResult{ passed, soloPassOn:'A', advisory:['planner-B-failed']}
     │◀────StageResult──────────────
     │
     │── continue to Plan Quality gate on Plan C ──────────────────────────────────────────▶
```

### 3.5 Sequence Diagram — Double failure (hard abort)

```
executeDueling  ModelRouter(A)  ModelRouter(B)  Codex  PipelineEngine
     │               │               │            │         │
     │─allSettled────▶               │            │         │
     │               │──execute──────▶            │         │
     │               │               │──execute──▶          │
     │               │◀─err──        │◀─err──     │         │
     │◀──settled { fulfilled:0, rejected:2 } ─────          │
     │                                                      │
     │──persist duelingPlanState (empty — no planA/B/C) ────▶
     │──return StageResult{ status:'failed',                │
     │          advisory:[                                  │
     │            {class:'planner-failure', detail:A},      │
     │            {class:'planner-failure', detail:B} ] } ──▶
     │                                                      │
     │                                         handleBlockingStageResult(→ abort)
     │                                                      │
     │                                         run() exits with failed session state
```

Note: Codex is never invoked when both planners fail. No silent fallback. See §4 row #6 and FR-8.

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | **N/A** — HELIX is a local developer CLI. Sessions live under `.helix/sessions/` on the developer's workstation. No `tenantId` scoping applies. `packages/helix/CLAUDE.md` does not impose tenant rules, consistent with this framing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | **Data Access Pattern** | All session state is JSON files managed by `SessionManager`. Persistence is per-stage via `SessionManager.persist()` (line 96), with a mid-stage precedent for oracle checkpoints (line 360) and slice diff-hash (2026-04-05). `duelingPlanState` follows the same pattern — eager `.then()` persist per planner, not batched at end of `allSettled`. No database layer, no repository pattern.                                                                                                                                                                                                                                                                                                                                                                              |
| 3   | **API Contract**        | **N/A** — no HTTP surface. `OpenAiApiExecutor` consumes the OpenAI REST API (version pinned by `openai@^4.77.0`). `ModelRouter.execute` / `registerExecutor` signatures remain unchanged (registerExecutor at line 245, accepts any `ModelExecutor`). `SpecialStageExecutor` public surface gains one method `executeDuelingPlanGeneration(session, stage, startTime, stageDeadlineAt?): Promise<StageResult>` matching the existing 7 methods' signature (e.g. `executeOracleAnalysis`, `executeBulkReview`, `executeManifestCompilation`). All dependencies are resolved from the constructor-injected `this.deps: SpecialStageExecutorDeps` (modelRouter, sessionManager, journal, config, reporter, emitProgress). Result is built via the shared `makeResult()` helper. |
| 4   | **Security Surface**    | `OPENAI_API_KEY` read only from `process.env` at executor-invocation time — never persisted, never logged, never interpolated into `StreamEvent.message`. `StreamEvent` secret redaction follows the pattern in `packages/helix/src/ui/progress-reporter.ts`. Structured output validation via AJV 8 + JSON Schema draft 2020-12 (`stage-output-schema.ts` + `stage-output-parsers.ts`). No new attack surface — OpenAI SDK runs in-process on the developer's machine, same trust boundary as Codex.                                                                                                                                                                                                                                                                        |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Introduce named error classes: `OpenAiApiError` (wraps OpenAI SDK errors with `{ statusCode, code, message }`), `StructuredOutputParseError` (parser failures). Reuse existing `StallDetectedError` / `BudgetExceededError`. ModelRouter returns `ExecutorResult` with populated `error` field when `isAvailable()` is false (line 214-223) — does NOT throw. `executeDuelingPlanGeneration` translates planner-level rejections into structured `AdvisoryEntry[]` with class tags `planner-failure` / `codex-synthesis-failure`. `StageResult.status === 'failed'` triggers `handleBlockingStageResult` at `pipeline-engine.ts:511-515`.                                                                                                                                                                                                                                                                                    |
| 6   | **Failure Modes** | (a) **Planner-B fails**: solo-pass through Codex with Plan A labeled "Candidate A" only. `soloPass=true` on the surviving `PlanArtifact`. (b) **Planner-A fails**: symmetric — solo-pass with Plan B. (c) **Both planners fail**: no Codex call, return `status:'failed'`, hard-abort via pipeline's blocking-stage handler. (d) **Codex fails after planners succeed**: return `status:'failed'`, Plan A + Plan B files preserved on disk for inspection. (e) **Ctrl+C between planner-A fulfillment and `allSettled` return**: eager `.then()` persist ensures Plan A survives. Resume reads `duelingPlanState.planA`, re-launches only Planner B. (f) **Resume with A+B checkpointed**: skip parallel phase, proceed to synthesis. (g) **Resume with A+B+C checkpointed**: skip entire stage, proceed to Plan Quality gate. (h) **OPENAI_API_KEY missing**: `helix doctor` blocks at startup when either flag is enabled. |
| 7   | **Idempotency**   | `executeDuelingPlanGeneration` is idempotent via `duelingPlanState` checkpoint reuse (FR-12). Replay of the same stage with Plan A+B persisted skips planner invocation. Abort does NOT clean mid-stage state (matches oracle-checkpoint precedent at `oracle-constellation.ts:85-98`). Stale-partial risk — a Plan A persisted from a prior prompt would be reused under a changed prompt — is managed by the existing HELIX checkpoint-reuse principle: session identity binds checkpoint identity. If the feature spec changes, session ID changes (new session dir), so checkpoint reuse is scoped correctly.                                                                                                                                                                                                                                                                                                            |
| 8   | **Observability** | (a) Progress events: "Launching Planner A", "Launching Planner B", "Planner A complete ($X.XX)", "Synthesizing via Codex", "Plan C captured". (b) Session JSON: `costByProvider[engine:model] = { totalUsd, callCount }` accumulated after every `modelRouter.execute()` return. Key format `${engine}:${model ?? 'unknown'}`. (c) Artifact files in session dir: `plan-a.md`, `plan-b.md`, `plan-c.md`, `divergence-notes.md`. (d) Journal line appended to `docs/sdlc-logs/<feature>/helix/journal.md`per dueling run. (e) MCP`get_session` returns the extended Session (older clients ignore unknown fields). No new MCP tools in this feature.                                                                                                                                                                                                                                                                          |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Plan stage timeout: 18 minutes when `enableDuelingPlanners` is on, 8 minutes otherwise. Wall-clock: ≈1.5× single-planner (parallel fan-out bounded by slower planner + Codex synthesis). Token cost: ≈2.5× (two full plans + lighter synthesis). Parallel concurrency: 2 planner calls per session — well within API rate limits. No new concurrency manager. **Timeout implementation strategy**: `holisticAuditPipeline` is a static `const` object at `templates/holistic-audit.ts:123` and has no access to runtime config at construction time. The chosen strategy is a **runtime override at dispatch time**: `PipelineEngine.executeStage()` inspects `stage.type === 'plan-generation' && this.config.enableDuelingPlanners` and substitutes `stage.timeoutMs = 18 * MINUTE_MS` before invoking the special-stage executor. This avoids refactoring the template from `const` to a `buildHolisticAuditPipeline(config)` builder function (which would ripple through every existing template consumer). Alternative (rejected): converting the template to a builder — correct long-term, out of scope for this feature. |
| 10  | **Migration Path**     | Purely additive. No data migration. Default config (`enableDuelingPlanners: false`, `useOpenAiArchitectureOracle: false`) preserves existing behavior byte-for-byte. Sessions written before the feature ships have no `duelingPlanState` or `costByProvider` fields; both are optional and JSON round-trip preserves absent fields (per `SessionManager.persist` / `load` behavior). Read sites initialize from `session.costByProvider ?? {}` and `session.duelingPlanState ?? {}` — no migration code, no version bump.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 11  | **Rollback Plan**      | **Primary**: unset `--enable-dueling-planners` and/or `--use-openai-architecture-oracle` (or corresponding env vars). Instant revert on the next `helix audit` invocation. **Secondary**: operator can `rm -rf .helix/sessions/<id>/` to wipe any half-written dueling state. **Nuclear**: git revert the feature commits. No production service to drain, no database rollback, no feature-flag service dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 12  | **Test Strategy**      | 8 E2E (in-process pipeline runs through `PipelineEngine.run()`), 11 integration, 10 unit, 3 security, 3 performance. Real `ModelRouter`, real `SessionManager`, real filesystem mkdtemp roots. OpenAI SDK mocked via dependency injection (constructor-injected factory), never via `vi.mock`. Claude SDK mocked via `vi.mock('@anthropic-ai/claude-agent-sdk', …)` (existing pattern in HELIX tests — see `packages/helix/agents.md` 2026-04-19 entry). Codex via fake subprocess helper. No mocking of internal packages (`@agent-platform/*`, `@abl/*`, relative imports). HELIX excluded from workspace-wide pnpm / vitest — runs via `packages/helix/` scripts.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

---

## 5. Data Model

### 5.1 New fields (additive, optional)

`packages/helix/src/types.ts` extensions to `Session`:

```ts
interface Session {
  // … existing fields unchanged …

  /** Cumulative model spend keyed by `${engine}:${model ?? 'unknown'}` */
  costByProvider?: Record<
    string,
    {
      totalUsd: number;
      callCount: number;
    }
  >;

  /** Dueling-planner stage state; present only when enableDuelingPlanners is on */
  duelingPlanState?: {
    planA?: PlanArtifact;
    planB?: PlanArtifact;
    planC?: PlanArtifact;
    divergenceNotes?: string;
  };
}

interface PlanArtifact {
  output: string; // full plan markdown (parse target for slice-plan schema)
  costUsd?: number; // cost for this single call, from ExecutorResult.costUsd
  engine: ModelEngine; // 'claude-code' | 'openai-api' | 'codex-cli'
  model: string; // model ID as reported by the executor
  capturedAt: string; // ISO timestamp
  durationMs: number;
  turnsUsed: number;
  soloPass?: boolean; // true only when the sibling planner failed and this artifact flowed through Codex alone
}
```

`HelixConfig` extensions (same file):

```ts
interface HelixConfig {
  // … existing fields …
  useOpenAiArchitectureOracle?: boolean; // default false
  enableDuelingPlanners?: boolean; // default false
  openaiModel?: string; // default 'gpt-5'; overridable via HELIX_OPENAI_MODEL env
}
```

### 5.2 New files (session-scoped, ephemeral)

```
.helix/sessions/<session-id>/
  plan-a.md              ← Candidate A (claude-code/opus)
  plan-b.md              ← Candidate B (openai-api/gpt-5); absent on solo-pass where A survived
  plan-c.md              ← Convergent Plan C (codex-cli/gpt-5.4 synthesis)
  divergence-notes.md    ← Codex-authored convergence analysis
  session.json           ← existing; now includes duelingPlanState + costByProvider
```

### 5.3 New journal line (durable)

Appended to `docs/sdlc-logs/<feature>/helix/journal.md`:

```
- 2026-04-19T14:32:11.903Z — Dueling plans: Candidate A (claude-code/opus, $0.42),
  Candidate B (openai-api/gpt-5, $0.38), synthesized via codex-cli/gpt-5.4 ($0.19).
  Divergences: 3 resolved (retry strategy, error classification, telemetry shape).
```

### 5.4 New stage-output schema

`packages/helix/src/pipeline/stage-output-schema.ts` gains `plan-c-with-divergence`:

```ts
// Extends 'slice-plan' (existing) with an optional divergenceNotes field.
const planCWithDivergenceSchema = slicePlanSchema.extend({
  divergenceNotes: z.string().optional(),
});
```

Paired parser in `stage-output-parsers.ts` wraps the existing `parseSlicePlanOutput` and extracts `divergenceNotes` via composition (no registry lookup — parsers are call-site-selected in this codebase).

### 5.5 Backward compatibility

Sessions persisted before this feature ships have no `duelingPlanState` and no `costByProvider`. Both fields are optional. JSON round-trip through `SessionManager.persist()` / `load()` preserves absent fields (no schema-validating write path in the manager). Every read site initializes with `?? {}`:

```ts
const costByProvider = session.costByProvider ?? {};
const dueling = session.duelingPlanState ?? {};
```

No migration code, no version bump.

### 5.6 Key relationships

- `duelingPlanState.planC.output` is the authoritative plan. It feeds the Plan Quality gate (`holistic-audit.ts:291-313`) and slice-manifest compilation exactly where the single-model plan does today. Slice compilation does not distinguish between Plan C and a non-dueling plan.
- `costByProvider` is independent of `duelingPlanState` — it accumulates across every model call in the session (oracles, gates, planners, synthesis).
- Plan artifact files are session-scoped ephemeral state. The journal line is the durable record.

---

## 6. API Design

**N/A — HELIX is a CLI tool with no HTTP surface.** This feature adds no endpoints.

Affected surfaces, all internal:

- `ModelRouter.execute()` and `ModelRouter.registerExecutor()` signatures unchanged — a new `OpenAiApiExecutor` (implementing `ModelExecutor`) is registered in the constructor at lines 48-67.
- `SpecialStageExecutor` gains one public method `executeDuelingPlanGeneration(session, stage, startTime, stageDeadlineAt?): Promise<StageResult>` matching the existing 7 methods' signature (see `executeOracleAnalysis` at line 54 onward as the reference pattern). All dependencies resolved via `this.deps: SpecialStageExecutorDeps` (constructor-injected).
- `HelixConfig` gains three optional fields (additive): `useOpenAiArchitectureOracle`, `enableDuelingPlanners`, `openaiModel`.
- `Session` gains two optional fields (additive): `costByProvider`, `duelingPlanState`.
- MCP tools (`get_session`, `list_gate_results`, `explain_blocker`) continue to surface the extended Session shape; no tool signatures change. Older MCP clients ignore the unknown fields — verified pattern in the existing `get_session` surface.

CLI flags added (additive, opt-in, default false):

| Flag                               | Maps to                                |
| ---------------------------------- | -------------------------------------- |
| `--enable-dueling-planners`        | `config.enableDuelingPlanners`         |
| `--use-openai-architecture-oracle` | `config.useOpenAiArchitectureOracle`   |
| `--openai-model <model>`           | `config.openaiModel` (default `gpt-5`) |

Env vars (same precedence as existing HELIX config):

| Env var                                                  |
| -------------------------------------------------------- |
| `OPENAI_API_KEY` (pre-existing — Codex already consumes) |
| `HELIX_OPENAI_MODEL` (default `gpt-5`)                   |
| `HELIX_USE_OPENAI_ARCHITECTURE_ORACLE`                   |
| `HELIX_ENABLE_DUELING_PLANNERS`                          |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Session JSON is the audit source. Every `modelRouter.execute()` return with `costUsd` increments `costByProvider`. Journal entry per dueling run captures the providers involved and the per-provider cost. No separate audit sink.
- **Rate Limiting**: Bounded at 2 concurrent planner calls per session — well below any provider rate limit. No application-level rate limiter.
- **Caching**: No new cache. Existing oracle-checkpoint cache (`oracle-constellation.ts`) and slice diff-hash caches are unaffected — they key on prompt/findings hash, not engine.
- **Encryption**: At rest — session JSON files inherit filesystem permissions; no new sensitive data (API key never persisted). In transit — OpenAI SDK uses HTTPS; same trust boundary as Codex CLI today.
- **Secret Handling**: `OPENAI_API_KEY` read from `process.env` at executor-invocation time. `StreamEvent.message` emitted by `OpenAiApiExecutor` uses the same redaction pattern as `progress-reporter.ts` — no raw request/response bodies interpolated.
- **Structured Output Validation**: `JsonSchemaDocument` entries registered in `schemaById` (`stage-output-schema.ts`), validated via AJV 8 + `validateStageOutputData`; parser failures become `StructuredOutputParseError` and are surfaced as `AdvisoryEntry` with class tag.
- **Progress Reporting**: Existing `progress-reporter.ts` pattern — dueling stage emits five new event types ("Launching Planner A", "Planner A complete", etc.) via the existing `StreamEvent` pipeline. Redaction applies uniformly.

---

## 8. Dependencies

### 8.1 Upstream (this feature depends on)

| Dependency                                   | Type              | Version   | Risk                                                                                                                                                                        |
| -------------------------------------------- | ----------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai`                                     | new workspace dep | `^4.77.0` | Low — 3 existing workspace consumers on v4.x (`search-ai-internal`, `mcp-openai-reviewer`, `codetool-sandbox/runtime_js`). No lockfile churn expected. v5 not yet released. |
| `@anthropic-ai/claude-agent-sdk`             | existing dep      | (pinned)  | None — unchanged. Planner A path.                                                                                                                                           |
| Codex CLI subprocess                         | existing dep      | (ambient) | None — unchanged. Synthesizer path.                                                                                                                                         |
| `SessionManager.persist` + `addJournalEntry` | internal module   | N/A       | Low — stable public API (lines 96, 206). `addJournalEntry` internally invokes the private `appendToJournalFile` at line 233.                                                |
| `ModelRouter.execute` + `registerExecutor`   | internal module   | N/A       | Low — stable public API (lines 48-67, 214-223).                                                                                                                             |
| `SpecialStageExecutor.makeResult` helper     | internal module   | N/A       | Low — stable pattern across 7 existing methods.                                                                                                                             |
| `ExecutorEfficiencyBudget.disableToolUse`    | internal type     | N/A       | None — already declared at `types.ts:290`; zero surface change.                                                                                                             |
| OpenAI API availability                      | external          | GPT-5     | Medium — GPT-5 GA status tracked in Open Question §9 and GAP-005. If unavailable at implementation time, fall back to next-best reasoning model.                            |

### 8.2 Downstream (depends on this feature)

| Consumer                                            | Impact                                                                                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Plan Quality` gate (`holistic-audit.ts:291-313`)   | None — gate consumes stage output by schema ID; Plan C conforms to `slice-plan` plus an optional `divergenceNotes` field that the gate ignores.                                                      |
| Slice manifest compiler                             | None — consumes `plan-generation` stage output identically whether single-model or Plan C.                                                                                                           |
| MCP `get_session` consumers                         | Low — older clients ignore unknown fields (`costByProvider`, `duelingPlanState`). No field rename or removal.                                                                                        |
| `helix status <session-id>` formatter               | Low — needs a small update to print `costByProvider` summary. Non-breaking.                                                                                                                          |
| `helix doctor`                                      | Low — new validation when either flag is set: require `OPENAI_API_KEY`.                                                                                                                              |
| Other pipeline templates (`bug-fix`, `drift-audit`) | None — dueling dispatch is gated by `config.enableDuelingPlanners`; templates that don't set the flag retain single-model semantics. Generic-dispatch regression covered by integration test row 23. |

---

## 9. Open Questions & Decisions Needed

1. **GPT-5 availability at implementation time** — feature spec assumes GPT-5 is GA. If rate-limited or preview-only at LLD time, default `openaiModel` falls back to the next-best reasoning model (candidates: `o3`, `o1`, `gpt-4o`). Defer the decision to `/lld` phase; make the default trivially overridable via `HELIX_OPENAI_MODEL`. Tracked as GAP-005.
2. **Labeled vs unlabeled synthesis prompt** — user leans unlabeled ("Candidate A / Candidate B") to reduce anchor bias. Locked in §3.3 and FR-6. Revisit if synthesis quality is poor after first production runs (would require an A/B experiment, out of scope for this feature).
3. **Partial divergence-notes on Codex mid-stream failure** — if Codex crashes after emitting partial output, discard rather than persist. Rationale: either Plan C is complete or the stage failed — there is no "partial success" state in the gate. Locked; document in implementation.
4. **Timeout tuning** — 18-minute stage timeout is an estimate (planner 8min + synthesis 6min + overhead 2min = 16min). Revisit after first production run; may need 20-25 minutes.
5. **Cost cap interaction** — dueling consumes ≈2.5× prior plan-stage spend. Existing global `budgetLimitUsd` applies per-session. Lean "global-cap-suffices — dueling is opt-in, operators know the cost." No dueling-specific cap in this feature.
6. **Journal format stability** — one-line prose format is informal. If downstream tooling ever parses the journal, a structured JSON-line format would be preferable. Defer until such a consumer exists.
7. **Validation of Codex synthesis quality** — assumption is that Codex (gpt-5.4) produces a superior convergent plan vs. either input alone. No automated cost-vs-accuracy eval in this feature (GAP-004). First-run observation will inform whether to substitute a different synthesizer.

---

## 10. References

### Project artifacts

- Feature spec: [`docs/features/sub-features/cross-provider-quorum-convergence.md`](../features/sub-features/cross-provider-quorum-convergence.md)
- Test spec: [`docs/testing/sub-features/cross-provider-quorum-convergence.md`](../testing/sub-features/cross-provider-quorum-convergence.md)
- Feature-spec log: [`docs/sdlc-logs/cross-provider-quorum-convergence/feature-spec.log.md`](../sdlc-logs/cross-provider-quorum-convergence/feature-spec.log.md)
- Test-spec log: [`docs/sdlc-logs/cross-provider-quorum-convergence/test-spec.log.md`](../sdlc-logs/cross-provider-quorum-convergence/test-spec.log.md)
- HLD log: [`docs/sdlc-logs/cross-provider-quorum-convergence/hld.log.md`](../sdlc-logs/cross-provider-quorum-convergence/hld.log.md)
- Parent feature: [`docs/features/helix-autonomous-engineering-harness.md`](../features/helix-autonomous-engineering-harness.md)
- Roadmap LLD: [`docs/plans/helix-autonomous-harness-roadmap.lld.md`](../plans/helix-autonomous-harness-roadmap.lld.md)

### Code references (authoritative per-phase)

- HELIX vision: `packages/helix/HELIX.md`
- HELIX operational rules: `packages/helix/CLAUDE.md`
- HELIX learning journal: `packages/helix/agents.md`
- Types & engine union: `packages/helix/src/types.ts`
- Model router: `packages/helix/src/models/model-router.ts`
- Claude SDK executor (reference pattern): `packages/helix/src/models/claude-sdk-executor.ts`
- Codex CLI executor (reference pattern): `packages/helix/src/models/codex-cli-executor.ts`
- Oracle constellation: `packages/helix/src/oracles/oracle-constellation.ts`
- Pipeline engine: `packages/helix/src/pipeline/pipeline-engine.ts`
- Special-stage executor: `packages/helix/src/pipeline/special-stage-executor.ts`
- Stage-output schemas / parsers: `packages/helix/src/pipeline/stage-output-{schema,parsers}.ts`
- Session manager: `packages/helix/src/session/session-manager.ts`
- Holistic-audit template: `packages/helix/src/pipeline/templates/holistic-audit.ts`
- CLI entry: `packages/helix/src/cli.ts`
- Runtime config: `packages/helix/src/runtime-config.ts`

### Design-quality-gate reference

- 12 architectural concerns skill: addressed inline in §4 above; Tenant/Project/User isolation marked **N/A** with justification per the skill's explicit allowance for developer-CLI-only features.
