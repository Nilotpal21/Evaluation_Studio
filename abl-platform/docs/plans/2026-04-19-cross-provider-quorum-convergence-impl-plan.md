# LLD: Cross-Provider Quorum & Planning Convergence (HELIX)

**Feature Spec**: [`docs/features/sub-features/cross-provider-quorum-convergence.md`](../features/sub-features/cross-provider-quorum-convergence.md)
**HLD**: [`docs/specs/cross-provider-quorum-convergence.hld.md`](../specs/cross-provider-quorum-convergence.hld.md)
**Test Spec**: [`docs/testing/sub-features/cross-provider-quorum-convergence.md`](../testing/sub-features/cross-provider-quorum-convergence.md)
**LLD Log**: [`docs/sdlc-logs/cross-provider-quorum-convergence/lld.log.md`](../sdlc-logs/cross-provider-quorum-convergence/lld.log.md)
**Status**: DRAFT
**Date**: 2026-04-19
**Ticket**: ABLP-406
**Scope**: `packages/helix/` only

---

## 1. Design Decisions

### 1.1 Decision Log

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Alternatives Rejected                                                                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| D-1  | Phase 1 lands as **3 focused commits** (types+config+executor+router registration; oracle swap + cost accumulator; tests). Phase 2 lands as **3 focused commits** (types+schema+synthesis-prompt; dueling executor + pipeline dispatch + timeout override; integration/E2E tests). Phase 3 lands as **1 docs commit**. 7 commits in one PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Feature spec §13 scopes 3 phases. CLAUDE.md commit-scope guard caps commits at 40 non-doc files / 3 packages / <30% deletions for `feat()`. Each sub-commit stays well inside those limits. HELIX is a single package, so the 3-package cap never binds.                                                                                                                                                                                                                                                                                                                                                                                                                                                             | One mega-commit per phase (violates commit-scope guard). Pre-PR squash (loses bisectability for Phase 1 cost-accumulator regressions).                                                                                                                              |
| D-2  | `accumulateProviderCost(session, executorResult)` is a **pure synchronous function** exported from `packages/helix/src/pipeline/cost-accumulator.ts`, invoked at **each `modelRouter.execute(...)` call site** in the pipeline after the Promise resolves. No post-hook on `ModelRouter`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `ModelRouter.execute` has no `Session` reference (`model-router.ts:84-91` takes `ModelAssignment`, not session). Adding a session reference would require threading through every caller anyway, so the call-site wrapper is a strictly smaller change. Pure function is directly unit-testable (UT-8) without any pipeline harness.                                                                                                                                                                                                                                                                                                                                                                                 | Router post-hook via subclass or options bag (requires ModelRouter signature change; widens public surface). Event-emitter on router (adds a new lifecycle surface for a one-consumer need).                                                                        |
| D-3  | **Feature-spec errata fixed inside this PR's Phase 3 doc-sync commit**, not deferred to a separate `/post-impl-sync`. Corrections: (a) feature-spec §10 line 278 documents a fabricated signature `executeDuelingPlanGeneration(workDir, session, stage, deps)` — LLD uses the canonical `(session, stage, startTime, stageDeadlineAt?)` signature instead; (b) feature-spec §13 Phase 2 task 2.6 references a non-existent `planStageTimeoutMs(config)` helper — LLD implements the override at the dispatch site per HLD §9. Phase 3 commit updates feature spec §10 (file map) and §13 Phase 2 task 2.6 to match reality.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Both errata exist in the feature spec but are contradicted by the HLD (audited 3 rounds). `/post-impl-sync` is a separate ceremony; rolling the fix into the in-flight PR keeps SDLC artifacts internally consistent at merge time and avoids a trailing fix-up commit.                                                                                                                                                                                                                                                                                                                                                                                                                                              | Defer to `/post-impl-sync` (leaves docs temporarily inconsistent — SDLC artifacts on main would reference non-existent code until the next ceremony).                                                                                                               |
| D-4  | `OpenAiApiExecutor` uses the OpenAI SDK's **native structured-output surface** — `response_format: { type: 'json_schema', json_schema: { schema } }` — not the Claude approach of prompt-append + text parse.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Test spec INT-1 and UT-1/UT-2 assume native structured output. Claude's prompt-append pattern is a workaround for an SDK without native JSON Schema; OpenAI v4 supports it directly. Native structured output has lower failure modes (no malformed-JSON parse errors outside the schema itself) and matches the 3 existing workspace OpenAI consumers.                                                                                                                                                                                                                                                                                                                                                              | Prompt-append + text parse (matches Claude's pattern but discards an OpenAI-native capability; wider failure surface).                                                                                                                                              |
| D-5  | **Dynamic-import-per-call** of the `openai` SDK inside `OpenAiApiExecutor.execute()` — no module-level cache, no static import.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Matches `ClaudeSdkExecutor.execute()` at `claude-sdk-executor.ts:124` line-for-line. HELIX is excluded from the workspace; lazy-loading the SDK avoids eager load when running tests that never invoke the OpenAI path. `ModuleCache` behavior in Node makes repeat imports O(1).                                                                                                                                                                                                                                                                                                                                                                                                                                    | Static top-of-module `import` (loads SDK at any `import`-chain reference — measurable cold-start cost for CLI when feature is disabled). Module-level cached dynamic import (premature optimization; no measurement).                                               |
| D-6  | **Timeout override at dispatch site** in `PipelineEngine.executeStage()`: when `stage.type === 'plan-generation' && this.config.enableDuelingPlanners`, override `stage.timeoutMs` (or its computed `stageDeadlineAt`) to `18 * MINUTE_MS` before dispatching to `executeDuelingPlanGeneration`. `holisticAuditPipeline` const remains immutable with `PLAN_GENERATION_TIMEOUT_MS = 8 * MINUTE_MS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `templates/holistic-audit.ts:123` exports a top-level `const` — cannot read runtime config. Converting to `buildHolisticAuditPipeline(config)` ripples through every template consumer (rejected in HLD §4 concern #9). The override is a single `if` at the dispatch site, verified by INT-6.                                                                                                                                                                                                                                                                                                                                                                                                                       | Refactor template to builder (correct long-term; out of scope). Separate dueling-specific template (forces test matrix to diverge from existing templates).                                                                                                         |
| D-7  | Artifact files (`plan-a.md` / `plan-b.md` / `plan-c.md` / `divergence-notes.md`) are written via `fs.promises.writeFile` to `path.join(config.sessionDir, session.id, <filename>)`. The directory is pre-existing (created by `SessionManager.create`). No new helper on `SessionManager` — consumers compute the session directory inline, matching the existing pattern at `pipeline-engine.ts:424-425` and `cli.ts:521`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `SessionManager.sessionPath()` is PRIVATE (line 310). Exposing it just for this feature widens the `SessionManager` surface for zero other consumers. `config.sessionDir` is a public `string` field on `HelixConfig` (types.ts:1216) used widely for ad-hoc artifact paths.                                                                                                                                                                                                                                                                                                                                                                                                                                         | Expose `sessionPath` as public method (widens SessionManager surface for a one-feature need). New helper in session-manager (same widening).                                                                                                                        |
| D-8  | `StageOutputSchemaId` union gains literal `'plan-c-with-divergence'`. Schema is registered in the static `schemaById` record at `stage-output-schema.ts:428-437`. Parser is added at the call site in `execute-dueling-plan-generation.ts` — it wraps `parseSlicePlanOutput` + extracts `divergenceNotes`. No registry-driven parser lookup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Parsers in this codebase are call-site-selected, not registry-driven. Adding registry-driven dispatch for one new schema is premature generalization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Parser registry pattern (premature). Extend existing `parseSlicePlanOutput` with divergence awareness (contaminates the slice-plan parser with plan-C-specific concerns).                                                                                           |
| D-9  | Structured named error classes: `OpenAiApiError`, `StructuredOutputParseError`, `BudgetExceededError`, `StallDetectedError`, `CodexCliError`, `ClaudeSdkError`. All extend `Error` with a typed `{ statusCode?, code?, message }` discriminator. Live in a new `packages/helix/src/models/executor-errors.ts` module. **Usage scope (error-as-data contract preservation):** these classes are instantiated and raised **only inside `execute-dueling-plan-generation.ts`** (and its tests) — they are **not** thrown from inside `claude-sdk-executor.ts` / `codex-cli-executor.ts` / `openai-api-executor.ts`. The three executors continue to honor HELIX's existing "error-as-data" contract (`ExecutorResult.error` as a string field — `ModelRouter.executeSpec` at `model-router.ts:202-227` does not throw; it populates `error`). The dueling orchestrator **inspects `result.error`** on each planner's `ExecutorResult` and wraps non-empty errors into the appropriate typed class (`OpenAiApiError` / `ClaudeSdkError` / `CodexCliError`) before classifying via `isErrorOfClass()` helpers. **Exception:** `BudgetExceededError` may be raised in-place by `OpenAiApiExecutor.execute()` inside its own budget accumulator (never visible to `ModelRouter` — it is caught inside `execute()` and converted to `ExecutorResult.error = 'BudgetExceededError: …'`). | Test spec INT-11 requires these names for error-path assertions. HELIX's executors today honor an error-as-data contract — `ModelRouter.executeSpec` at `model-router.ts:202-227` returns `ExecutorResult` with `error` string field and never throws. Changing executor call sites to throw these new classes would break every existing caller that branches on `result.error` (9 `modelRouter.execute` sites in `pipeline-engine.ts`, oracle-constellation, etc.). Scoping the classes to the dueling orchestrator's **wrapper layer** preserves the existing contract while giving the orchestrator the typed discriminator it needs for `planner-failure` vs `codex-synthesis-failure` advisory classification. | Throw from executor call sites (breaks error-as-data contract; requires cascading updates to 9+ callers; regresses unrelated paths). Ad-hoc `Error` instances with `.cause` (weaker typing). Separate error module per executor (scatters advisory classification). |
| D-10 | CLI flags `--enable-dueling-planners`, `--use-openai-architecture-oracle`, and `--openai-model <model>` land in `buildHelixConfig()` at `cli.ts:1268-1321` using the existing `commander.js` option-definition style. Env vars `HELIX_ENABLE_DUELING_PLANNERS`, `HELIX_USE_OPENAI_ARCHITECTURE_ORACLE`, `HELIX_OPENAI_MODEL` follow the existing env-precedence pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Feature spec §11 specifies all 3 flags and their env-var equivalents. `workspace-context.ts` (lines 9-55) already threads env-driven `HELIX_*` config overrides; reusing the same mechanism keeps the config surface uniform. (Corrected round-4 — round-3 established that `runtime-config.ts` contains no env reads.)                                                                                                                                                                                                                                                                                                                                                                                              | JSON config-file-only (loses CLI ergonomics). Env-only (loses per-invocation override).                                                                                                                                                                             |
| D-11 | `helix doctor` gains **one additional check**: when `config.useOpenAiArchitectureOracle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | config.enableDuelingPlanners`is true, assert`process.env.OPENAI_API_KEY` is a non-empty string. Failure mode is an exit-nonzero with a clear message (no stack trace). Check runs alongside existing doctor checks; no new doctor subcommand.                       | Feature spec §8 and §12 require startup validation. Existing doctor already validates `ANTHROPIC_API_KEY`, Codex CLI presence, etc. — this is a straight addition. | Runtime-lazy validation (fails deeper in stage execution — worse UX). Separate `helix preflight` subcommand (redundant). |
| D-12 | **No retries at executor level**. `OpenAiApiExecutor` surfaces all errors to the caller; retry decisions are made at pipeline-stage level (solo-pass on single failure vs. hard-abort on double failure). `codex-cli-executor.ts` follows the same discipline today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Retry policy is a stage concern (Solo-Pass Codex with surviving plan, hard-abort on double-failure per FR-7/FR-8). Baking retries into the executor would make `Promise.allSettled` classification ambiguous (is a `rejected` result a true planner failure or a retry-exhaustion failure?).                                                                                                                                                                                                                                                                                                                                                                                                                         | SDK-level retry in executor (mud-dies `Promise.allSettled` semantics). Retry in ModelRouter (adds cross-cutting retry state that oracle-constellation, etc., would bypass).                                                                                         |
| D-13 | `PlanArtifact.output` stores the **full plan markdown string** (parse target for `slice-plan` schema). The `Session.duelingPlanState` keeps everything needed to resume; the on-disk `plan-a.md` / `plan-b.md` files are **redundant with** `duelingPlanState.planX.output` (deliberate — files for human inspection, JSON for machine reuse). Both are written atomically in the eager `.then()` branch of each planner's Promise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Test spec E2E-1 asserts both: filesystem artifacts (human-inspectable) and `duelingPlanState` (resume checkpoint). Writing only one creates a gap in either UX (missing files) or resume correctness (need to re-read markdown to re-hydrate `duelingPlanState` on resume).                                                                                                                                                                                                                                                                                                                                                                                                                                          | Files only (breaks resume without re-parse). JSON only (breaks human inspection).                                                                                                                                                                                   |
| D-14 | Solo-pass artifact policy: when Planner B fails, Plan A is still labeled **"Candidate A"** in the synthesis prompt (unlabeled), and `plan-b.md` is **NOT written** to disk (absence is the signal). `session.duelingPlanState.planB === undefined` after solo-pass. Plan A's `PlanArtifact.soloPass === true` marks the surviving planner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Test spec E2E-2 asserts `plan-b.md` absent + `session.duelingPlanState.planB === undefined` + `duelingPlanState.planA.soloPass === true`. Writing an empty or error-placeholder `plan-b.md` forces callers to distinguish "present but empty" from "present with content" — a needless state.                                                                                                                                                                                                                                                                                                                                                                                                                        | Write placeholder `plan-b.md` with failure content (adds a fourth ambiguous state to checkpoint-reuse logic).                                                                                                                                                       |
| D-15 | **Oracle synthesis-retry fallback model is engine-aware.** `buildOracleSynthesisModelSpec` selects `'claude-sonnet-4-6'` when the oracle engine is `claude-code`, and `'gpt-4o-mini'` when the engine is `openai-api`. Codex retry path is not exercised today (no Codex oracles). Threaded via `config` on `OracleConstellation` so operators have an escape hatch via a future `openaiSynthesisRetryModel` config knob (not in initial release — open-question tracks).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Round-2 finding identified that hardcoding `'claude-sonnet-4-6'` regardless of engine sends an unrecognized model to the OpenAI API, crashing the retry. `gpt-4o-mini` is the correct analogue of sonnet-4-6's "summarize what you already know" role — cheaper than the primary Architecture oracle model.                                                                                                                                                                                                                                                                                                                                                                                                          | Hardcode `'gpt-4o-mini'` without engine check (silently drops Claude-Sonnet-4-6 parity for Claude oracles). Reuse the Architecture oracle's primary model (`gpt-5`) for retries (expensive).                                                                        |
| D-16 | **`inferOracleConfidence` Claude+GPT parity table.** Confidence tiers: `opus` → 0.82 (existing), `sonnet` → 0.72 (existing), `gpt-5` → 0.82 (parity with opus), `gpt-4o` → 0.75 (above default, below sonnet), default → 0.68 (existing). Applied at oracle-consensus weighting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Round-2 finding: without this mapping, GPT-5 verdicts systematically receive the lowest tier (0.68) and the cross-provider-convergence feature's core value proposition silently degrades. Parity values derived from published reasoning-budget benchmarks for these models as of 2026-04.                                                                                                                                                                                                                                                                                                                                                                                                                          | Leave default 0.68 for GPT-5 (silent feature regression). Hardcode all weights to 1.0 and remove the tiering (loses Claude tier differentiation).                                                                                                                   |

### 1.2 Key Interfaces & Types

All new and modified types live in `packages/helix/src/types.ts`.

```ts
// NEW — executor error discrimination (implements: packages/helix/src/models/executor-errors.ts)
export class OpenAiApiError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  constructor(code: string, statusCode?: number, message?: string) {
    super(message ?? code);
    this.name = 'OpenAiApiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class StructuredOutputParseError extends Error {
  readonly schemaId: string;
  readonly parseDetail?: unknown;
  constructor(schemaId: string, message: string, parseDetail?: unknown) {
    super(message);
    this.name = 'StructuredOutputParseError';
    this.schemaId = schemaId;
    this.parseDetail = parseDetail;
  }
}

export class BudgetExceededError extends Error {
  readonly budgetUsd: number;
  readonly actualUsd: number;
  constructor(budgetUsd: number, actualUsd: number) {
    super(`Budget exceeded: $${actualUsd.toFixed(2)} > $${budgetUsd.toFixed(2)}`);
    this.name = 'BudgetExceededError';
    this.budgetUsd = budgetUsd;
    this.actualUsd = actualUsd;
  }
}

export class StallDetectedError extends Error {
  readonly stallMs: number;
  constructor(stallMs: number, message?: string) {
    super(message ?? `Stream stalled for ${stallMs}ms`);
    this.name = 'StallDetectedError';
    this.stallMs = stallMs;
  }
}

export class CodexCliError extends Error {
  readonly exitCode?: number;
  readonly code: string;
  constructor(code: string, exitCode?: number, message?: string) {
    super(message ?? code);
    this.name = 'CodexCliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class ClaudeSdkError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'ClaudeSdkError';
    this.code = code;
  }
}
```

```ts
// NEW — plan artifact shape (types.ts)
export interface PlanArtifact {
  output: string; // full plan markdown, parse target for slice-plan schema
  costUsd?: number; // cost for this single call
  engine: ModelEngine; // 'claude-code' | 'openai-api' | 'codex-cli'
  model: string; // model ID as reported by the executor
  capturedAt: string; // ISO timestamp
  durationMs: number;
  turnsUsed: number;
  soloPass?: boolean; // true iff sibling planner failed and this artifact flowed through Codex alone
}

// EXTENDED — Session (additive, optional)
export interface Session {
  // … existing fields unchanged …
  costByProvider?: Record<string, { totalUsd: number; callCount: number }>;
  duelingPlanState?: {
    planA?: PlanArtifact;
    planB?: PlanArtifact;
    planC?: PlanArtifact;
    divergenceNotes?: string;
  };
}

// EXTENDED — HelixConfig (additive, optional)
export interface HelixConfig {
  // … existing fields unchanged …
  useOpenAiArchitectureOracle?: boolean; // default false
  enableDuelingPlanners?: boolean; // default false
  openaiModel?: string; // default 'gpt-5'
}

// EXTENDED in Phase 2 / Commit 2.A (NOT Phase 1) — must ship atomically
// with the matching `schemaById` entry because `Record<StageOutputSchemaId,
// JsonSchemaDocument>` requires every union member as a key.
export type StageOutputSchemaId =
  // … existing literals …
  'plan-c-with-divergence';
```

Executor-level API (unchanged external surface, new instance):

```ts
// packages/helix/src/models/openai-api-executor.ts (NEW)
export class OpenAiApiExecutor implements ModelExecutor {
  readonly engine: ModelEngine = 'openai-api';
  constructor(
    private readonly workDir: string,
    private readonly clientFactory: OpenAiClientFactory = defaultOpenAiClientFactory,
  ) {}
  async isAvailable(): Promise<boolean>;
  setWorkspaceContext?(ctx?: WorkspaceExecutionContext): void;
  async execute(
    prompt: string,
    spec: ModelSpec,
    tools?: string[],
    onStream?: (event: StreamEvent) => void,
    outputSchema?: StageOutputSchemaConfig,
    timeoutMs?: number,
    abortSignal?: AbortSignal,
  ): Promise<ExecutorResult>;
}

// NEW — injectable factory for testing (OpenAiClientFactory is a zero-arg function returning
// an object that exposes the subset of the OpenAI SDK we use: chat.completions.create
// streaming + non-streaming). Defaults to new OpenAI() wrapped by dynamic import per call.
export type OpenAiClientFactory = () => Promise<OpenAiClientLike>;
```

Pipeline-level API (one new public method, one new pipeline dispatch case):

```ts
// packages/helix/src/pipeline/special-stage-executor.ts (UPDATE)
export class SpecialStageExecutor {
  // … existing 7 public methods unchanged …
  async executeDuelingPlanGeneration(
    session: Session,
    stage: StageDefinition,
    startTime: number,
    stageDeadlineAt?: number,
  ): Promise<StageResult>;
}

// packages/helix/src/pipeline/engine/execute-dueling-plan-generation.ts (NEW)
export async function executeDuelingPlanGeneration(
  session: Session,
  stage: StageDefinition,
  startTime: number,
  stageDeadlineAt: number | undefined,
  deps: DuelingPlanGenerationDeps,
): Promise<StageResult>;

export interface DuelingPlanGenerationDeps {
  config: HelixConfig;
  modelRouter: ModelRouter;
  sessionManager: SessionManager;
  journal: (session: Session, entry: JournalEntry) => Promise<void>;
  emitProgress: (event: ProgressEvent) => void;
  reporter: ProgressReporter;
}

// packages/helix/src/pipeline/engine/dueling-plan-synthesis-prompt.ts (NEW)
export function buildDuelingSynthesisPrompt(args: {
  candidateA: PlanArtifact;
  candidateB?: PlanArtifact;
  featureContext: string;
}): string;

// packages/helix/src/pipeline/cost-accumulator.ts (NEW)
export function accumulateProviderCost(session: Session, result: ExecutorResult): void;
```

Oracle helper (extracted from inline definition):

```ts
// packages/helix/src/oracles/oracle-constellation.ts (UPDATE)
export function resolveArchitectureOracle(config: HelixConfig): OracleDefinition;
```

### 1.3 Module Boundaries

| Module                                               | Responsibility                                                                                                                                                 | Depends On                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `models/openai-api-executor.ts`                      | Implements `ModelExecutor` for `engine: 'openai-api'`. Streaming, cost extraction, structured output, abort/stall.                                             | `openai` SDK (dynamic import), `executor-errors.ts`, `types.ts`.                                                   |
| `models/executor-errors.ts`                          | Typed error classes for all executors: `OpenAiApiError`, `StructuredOutputParseError`, etc.                                                                    | `types.ts` only.                                                                                                   |
| `models/model-router.ts` (UPDATE)                    | Registers `OpenAiApiExecutor` alongside existing executors. Surface unchanged — executor added to constructor map at lines 48-67.                              | `openai-api-executor.ts`.                                                                                          |
| `oracles/oracle-constellation.ts` (UPDATE)           | `resolveArchitectureOracle(config)` helper replaces the inline literal at lines 370-383. Pure switch on `config` flag.                                         | `types.ts`.                                                                                                        |
| `pipeline/cost-accumulator.ts`                       | Pure function. Mutates `session.costByProvider` given an `ExecutorResult`. No async, no I/O.                                                                   | `types.ts` only.                                                                                                   |
| `pipeline/engine/execute-dueling-plan-generation.ts` | Orchestrates the dueling flow — parallel fan-out, checkpoint, solo-pass, Codex synthesis, artifact writes.                                                     | `models/model-router.ts`, `session/session-manager.ts`, `pipeline/cost-accumulator.ts`, `types.ts`, `fs.promises`. |
| `pipeline/engine/dueling-plan-synthesis-prompt.ts`   | Pure function. Builds unlabeled "Candidate A / Candidate B" synthesis prompt.                                                                                  | `types.ts` only.                                                                                                   |
| `pipeline/special-stage-executor.ts` (UPDATE)        | Adds `executeDuelingPlanGeneration` method that delegates to the engine module via `this.deps`.                                                                | `pipeline/engine/execute-dueling-plan-generation.ts`.                                                              |
| `pipeline/pipeline-engine.ts` (UPDATE)               | Dispatch case `stage.type === 'plan-generation' && config.enableDuelingPlanners`. Timeout override (D-6). `accumulateProviderCost` call-site insertions (D-2). | `pipeline/special-stage-executor.ts`, `pipeline/cost-accumulator.ts`.                                              |
| `pipeline/templates/holistic-audit.ts`               | **Unchanged** — template stays a `const`. Plan-generation timeout override happens at dispatch site.                                                           | —                                                                                                                  |
| `pipeline/stage-output-schema.ts` (UPDATE)           | Adds `plan-c-with-divergence` schema entry to `schemaById` static record.                                                                                      | `types.ts`.                                                                                                        |
| `cli.ts` (UPDATE)                                    | `buildHelixConfig()` gains 3 flags (lines 1268-1321); threads them into `runHelixDoctor` options.                                                              | `types.ts`, `runtime-config.ts`, `readiness/doctor.ts`.                                                            |
| `runtime-config.ts` (UPDATE)                         | Defaults only for the 3 new fields. Env parsing lives in `workspace-context.ts` (round-3 correction).                                                          | `types.ts`.                                                                                                        |
| `workspace-context.ts` (UPDATE)                      | Adds `HELIX_USE_OPENAI_ARCHITECTURE_ORACLE`, `HELIX_ENABLE_DUELING_PLANNERS`, `HELIX_OPENAI_MODEL` to the existing `HELIX_*` env-read set (lines 9-55).        | `types.ts`.                                                                                                        |
| `readiness/doctor.ts` (UPDATE)                       | New `OPENAI_API_KEY` readiness check; fires when either flag is on.                                                                                            | `runtime-config.ts`.                                                                                               |
| `types.ts` (UPDATE)                                  | Type extensions: `Session`, `HelixConfig`, `StageOutputSchemaId`, new `PlanArtifact` interface.                                                                | —                                                                                                                  |

---

## 2. File-Level Change Map

### 2.1 New Files

| File                                                                    | Purpose                                                                                                                                               | LOC Estimate |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `packages/helix/src/models/openai-api-executor.ts`                      | `OpenAiApiExecutor implements ModelExecutor`. Streaming, cost, structured output, abort, stall, `MODEL_PRICING_USD`.                                  | ~450         |
| `packages/helix/src/models/executor-errors.ts`                          | Named error classes (`OpenAiApiError`, `StructuredOutputParseError`, `BudgetExceededError`, `StallDetectedError`, `CodexCliError`, `ClaudeSdkError`). | ~100         |
| `packages/helix/src/pipeline/cost-accumulator.ts`                       | Pure `accumulateProviderCost(session, result)`.                                                                                                       | ~40          |
| `packages/helix/src/pipeline/engine/execute-dueling-plan-generation.ts` | Orchestrates dueling fan-out, checkpoint, solo-pass, Codex synthesis, artifacts, journal.                                                             | ~350         |
| `packages/helix/src/pipeline/engine/dueling-plan-synthesis-prompt.ts`   | Unlabeled synthesis prompt builder.                                                                                                                   | ~120         |
| `packages/helix/src/__tests__/openai-api-executor.test.ts`              | FR-1/2, INT-1/11, UT-1/2/3/10, SEC-1/2/3, PERF-2. Uses injected fake OpenAI client.                                                                   | ~600         |
| `packages/helix/src/__tests__/execute-dueling-plan-generation.test.ts`  | INT-4, INT-10. All matrix cells (happy / one-fail / both-fail / Codex-fail / resume-A+B / resume-C).                                                  | ~500         |
| `packages/helix/src/__tests__/test-helpers/plan-fixtures.ts`            | Shared fixtures: `PLAN_A_FIXTURE`, `PLAN_B_FIXTURE`, `PLAN_C_FIXTURE`, `makeFakeOpenAiClient`, `makeFakeClaudeSdk`, `makeFakeCodexSpawner`.           | ~300         |

### 2.2 Modified Files

| File                                                              | Change Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Risk |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------- | --- |
| `packages/helix/src/types.ts`                                     | **Phase 1:** Add `PlanArtifact` interface; extend `Session` (optional fields); extend `HelixConfig` (3 optional flags). **Phase 2:** Add literal `'plan-c-with-divergence'` to `StageOutputSchemaId` union (must ship atomically with the `schemaById` registration in Task 2.A.1 — `Record<K,V>` requires every union member as key).                                                                                                                                                   | Low  |
| `packages/helix/src/models/model-router.ts`                       | Constructor (lines 48-67) registers `new OpenAiApiExecutor(workDir)` alongside existing `claude-code` and `codex-cli` executors.                                                                                                                                                                                                                                                                                                                                                         | Low  |
| ~~`packages/helix/src/models/claude-sdk-executor.ts`~~            | **NOT MODIFIED** per D-9 round-1 fix. Executor continues to honor the error-as-data contract (populate `ExecutorResult.error`, never throw). Typed `ClaudeSdkError` is wrapped around the returned `error` string by the dueling orchestrator only. No changes to this file in this feature.                                                                                                                                                                                             | None |
| ~~`packages/helix/src/models/codex-cli-executor.ts`~~             | **NOT MODIFIED** per D-9 round-1 fix. Same rationale as above — `CodexCliError` is wrapped by the dueling orchestrator only. No changes to this file in this feature.                                                                                                                                                                                                                                                                                                                    | None |
| `packages/helix/src/oracles/oracle-constellation.ts`              | Add `resolveArchitectureOracle(config)` helper. `defaultOracles` becomes `buildDefaultOracles(config)` OR the Architecture entry is injected at constellation-construction via the helper. Preserve all 4 oracle order, fields, focusAreas, tools, promptFile.                                                                                                                                                                                                                           | Med  |
| `packages/helix/src/pipeline/special-stage-executor.ts`           | Add `executeDuelingPlanGeneration` method following `executeVerificationBootstrap` pattern (lines 113-166). Delegates to `engine/execute-dueling-plan-generation.ts` with `this.deps`.                                                                                                                                                                                                                                                                                                   | Low  |
| `packages/helix/src/pipeline/pipeline-engine.ts`                  | (a) New dispatch case for `stage.type === 'plan-generation' && this.config.enableDuelingPlanners` in `executeStage` (insert between existing bootstrap and oracle-analysis cases). (b) Timeout override (D-6). (c) `accumulateProviderCost` invocations at each `modelRouter.execute()` return site within this file.                                                                                                                                                                    | Med  |
| `packages/helix/src/pipeline/stage-output-schema.ts`              | Add `'plan-c-with-divergence'` entry to `schemaById` static record. Schema is a **raw `JsonSchemaDocument`** (per the existing AJV + JSON-Schema pattern at `stage-output-schema.ts:1-22,111-147`) — `planCWithDivergenceSchema` clones the existing `slicePlanSchema`'s top-level structure and adds `divergenceNotes: { type: 'string' }` to its `properties`. **No Zod.** No `.extend()`. No `.safeParse()` — validation flows through the existing `validateStageOutputData()` path. | Low  |
| `packages/helix/src/pipeline/stage-output-parsers.ts`             | Add `parsePlanCWithDivergenceOutput` helper exported for call-site use.                                                                                                                                                                                                                                                                                                                                                                                                                  | Low  |
| `packages/helix/src/pipeline/templates/holistic-audit.ts`         | **No code change.** LLD preserves the `const` template. See D-6.                                                                                                                                                                                                                                                                                                                                                                                                                         | None |
| `packages/helix/src/session/session-manager.ts`                   | No signature changes. JSON round-trip of new optional fields is automatic via the existing `writeFileAtomic` path.                                                                                                                                                                                                                                                                                                                                                                       | None |
| `packages/helix/src/runtime-config.ts`                            | Default values only for `useOpenAiArchitectureOracle: false`, `enableDuelingPlanners: false`, `openaiModel: 'gpt-5'`. **No env-var parsing here** (this file has no env reads today — round-3 correction).                                                                                                                                                                                                                                                                               | Low  |
| `packages/helix/src/workspace-context.ts`                         | Extend existing `HELIX_*` env-read pattern at lines 9-55 to capture `HELIX_USE_OPENAI_ARCHITECTURE_ORACLE`, `HELIX_ENABLE_DUELING_PLANNERS`, `HELIX_OPENAI_MODEL`, and thread into `HelixConfig`.                                                                                                                                                                                                                                                                                        | Low  |
| `packages/helix/src/cli.ts`                                       | `buildHelixConfig()` (~lines 1268-1321) gains 3 `commander.js` flags. Threads new fields into `runHelixDoctor` options. **No readiness check lives here** — dispatches only (see `readiness/doctor.ts` row).                                                                                                                                                                                                                                                                             | Low  |
| `packages/helix/src/readiness/doctor.ts`                          | Add `OPENAI_API_KEY` readiness check that fires when `config.useOpenAiArchitectureOracle                                                                                                                                                                                                                                                                                                                                                                                                 |      | config.enableDuelingPlanners`. Uses existing `runHelixDoctor`/`formatReadinessSummary` machinery. | Low |
| `packages/helix/package.json`                                     | Add `"openai": "^4.77.0"` to `dependencies`. No devDependency changes.                                                                                                                                                                                                                                                                                                                                                                                                                   | Low  |
| `packages/helix/agents.md`                                        | Append learning journal entry for the feature (dueling-plan pattern, solo-pass, cost-accumulator call-site wrapper). See Phase 2 task 2.9.                                                                                                                                                                                                                                                                                                                                               | None |
| `packages/helix/src/__tests__/model-router.test.ts`               | INT-2: register `openai-api` executor, assert dispatch, assert unavailable-engine branch returns `ExecutorResult` with `error` (no throw).                                                                                                                                                                                                                                                                                                                                               | Low  |
| `packages/helix/src/__tests__/oracle-constellation.test.ts`       | FR-3, FR-16, INT-3, UT-5, E2E-6: `resolveArchitectureOracle` unit test; mixed-engine consensus; checkpoint reuse with swapped oracle.                                                                                                                                                                                                                                                                                                                                                    | Low  |
| `packages/helix/src/__tests__/pipeline-engine.test.ts`            | E2E-1…E2E-5, E2E-7, E2E-8, INT-5, INT-7, INT-8, INT-9, PERF-1, PERF-3. Includes resume scenarios and cost accumulator assertions.                                                                                                                                                                                                                                                                                                                                                        | Med  |
| `packages/helix/src/__tests__/special-stage-executor.test.ts`     | INT-8: dispatch wiring spy; preserves existing `executeVerificationBootstrap` tests.                                                                                                                                                                                                                                                                                                                                                                                                     | Low  |
| `packages/helix/src/__tests__/session-manager.test.ts`            | UT-7: `PlanArtifact` JSON round-trip test.                                                                                                                                                                                                                                                                                                                                                                                                                                               | Low  |
| `packages/helix/src/__tests__/runtime-config.test.ts`             | UT-9: defaults for 3 new fields; env-var parsing.                                                                                                                                                                                                                                                                                                                                                                                                                                        | Low  |
| `packages/helix/src/__tests__/pipeline-templates.test.ts`         | UT-6: assert dispatch-site timeout override — pipeline test verifies `stageDeadlineAt` for `plan-generation` is 18min when flag on, 8min when off. If no existing pipeline-templates test file, add to `pipeline-engine.test.ts`.                                                                                                                                                                                                                                                        | Low  |
| `packages/helix/src/__tests__/doctor.test.ts`                     | FR-2 CLI: error when flag set but `OPENAI_API_KEY` missing.                                                                                                                                                                                                                                                                                                                                                                                                                              | Low  |
| `packages/helix/src/__tests__/stage-output-parsers.test.ts`       | `plan-c-with-divergence` parser — valid schema, missing `divergenceNotes` defaults OK, malformed JSON throws `StructuredOutputParseError`.                                                                                                                                                                                                                                                                                                                                               | Low  |
| `packages/helix/src/__tests__/stage-output-schema.test.ts`        | Structural validation of the new schema ID.                                                                                                                                                                                                                                                                                                                                                                                                                                              | Low  |
| `docs/features/sub-features/cross-provider-quorum-convergence.md` | Phase 3 doc-sync only (D-3). Fix §10 line 278 signature and §13 Phase 2 task 2.6 timeout-helper reference.                                                                                                                                                                                                                                                                                                                                                                               | None |
| `packages/helix/HELIX.md`                                         | Phase 3 doc-sync only. Update §Future Work #1 to note `openai-api` implemented. Update architecture table / model strategy sections.                                                                                                                                                                                                                                                                                                                                                     | None |

### 2.3 Deleted Files

None. This feature is strictly additive per HLD §4 concern #10 and CLAUDE.md's deletion-ratio guard for `feat()` commits.

---

## 3. Implementation Phases

Each phase is independently deployable and testable. Each phase leaves the pipeline in a working state — defaults preserve existing behavior byte-for-byte. Phase boundaries track commit boundaries per D-1.

### Phase 1: Executor + Oracle Swap + Cost Attribution

**Goal**: Land `OpenAiApiExecutor`, register it in `ModelRouter`, swap the Architecture oracle to GPT-5 behind a config flag, and accumulate per-provider cost across the session.

**Commit 1.A — Types, config, executor, router registration**

Tasks:

1.A.1. Add `"openai": "^4.77.0"` to `packages/helix/package.json` dependencies. Run `pnpm install` at repo root (HELIX uses the root lockfile per `pnpm-workspace.yaml:3 !packages/helix`).
1.A.2. Extend `types.ts`:

- Add `PlanArtifact` interface.
- Extend `Session` with optional `costByProvider` and `duelingPlanState`.
- Extend `HelixConfig` with optional `useOpenAiArchitectureOracle`, `enableDuelingPlanners`, `openaiModel`.
- **Do NOT add `'plan-c-with-divergence'` to the `StageOutputSchemaId` union in this commit** (round-5 fix). `schemaById` at `stage-output-schema.ts:428-437` is typed `Record<StageOutputSchemaId, JsonSchemaDocument>`; `Record<K, V>` requires every union member as a key. Adding the literal without a matching `schemaById` entry causes `tsc --noEmit` to fail (`Property 'plan-c-with-divergence' is missing`), violating Phase 1 exit criteria. Both the union extension AND the `schemaById` entry ship together atomically in Task 2.A.1 (Phase 2 Commit 2.A). Phase 1 only needs `Session`, `HelixConfig`, and `PlanArtifact`.
  1.A.3. Create `models/executor-errors.ts` with the 6 error classes from §1.2.
  1.A.4. Create `models/openai-api-executor.ts`:
- Class skeleton implementing `ModelExecutor`.
- `isAvailable()` checks `process.env.OPENAI_API_KEY` is a non-empty string.
- `execute()`: dynamic import of `openai`; builds messages array; streaming branch vs. non-streaming; structured output via native `response_format: { type: 'json_schema', json_schema }` when `outputSchema?.schemaId` is set; cost extraction via `computeCostUsd(usage, model, MODEL_PRICING_USD)`.
- `MODEL_PRICING_USD` table exported at module scope as a **plain `Record<string, { inputUsdPer1M: number; outputUsdPer1M: number; reasoningUsdPer1M?: number }>`** — **not a `Map`**. HELIX's unbounded-collections hook (documented in `packages/helix/agents.md` 2026-04-03) blocks `new Map()` / `new Set()` in helix source files; a static lookup record is the correct shape here anyway. Entries for `gpt-5`, `gpt-5.4` (Codex model), and a reasonable fallback for unknowns that logs (via `process.stderr.write`) a warning and returns `costUsd = undefined`.
- Stream event mapper `mapSseDeltaToStreamEvent` (pure internal helper) — maps OpenAI SSE chunks (`content.delta`, `reasoning.delta`, `usage`, `error`) to HELIX `StreamEvent` shape.
- Stall detection mirrors the existing pattern in `codex-cli-executor.ts` (check time-since-last-event vs. threshold — reuse the same threshold constant if exported, else copy with a named constant here).
- Abort: listen to the passed `abortSignal`; when fired, abort the SDK stream via the client's native abort hook.
- Budget cap: accumulate `costUsd` across invocations; throw `BudgetExceededError` before next request if `spec.maxBudgetUsd` is set and exceeded.
- Secret redaction: `StreamEvent.message` strings built via a redaction helper that uses the pattern from `ui/progress-reporter.ts` — no raw request/response body interpolation.
  1.A.5. **(removed — superseded by D-9 clarification)** Do NOT modify `claude-sdk-executor.ts` or `codex-cli-executor.ts` to throw the new error classes. Per D-9, the executors continue to honor the error-as-data contract (`ExecutorResult.error` as a string). The new typed classes (`ClaudeSdkError`, `CodexCliError`, `OpenAiApiError`) are instantiated inside the dueling orchestrator as wrappers around `result.error` strings (see Phase 2, Commit 2.B Task 2.B.1 Step 3.5 — "Wrap ExecutorResult.error into typed class").
  1.A.6. Update `models/model-router.ts` constructor (lines 48-67) to include `new OpenAiApiExecutor(workDir)` as a third entry in the executor `Map` — production path uses `defaultOpenAiClientFactory`. **Test DI override:** test harnesses that need a fake OpenAI client call `modelRouter.registerExecutor(new OpenAiApiExecutor(workDir, makeFakeOpenAiClient()))` (the public registration method at `model-router.ts:245-248` overwrites the constructor-registered instance for the `openai-api` engine key).
  1.A.7. **Logging convention:** all new modules created in 1.A (`openai-api-executor.ts`, `executor-errors.ts`, `cost-accumulator.ts`, `execute-dueling-plan-generation.ts`, `dueling-plan-synthesis-prompt.ts`) write diagnostic output **only** via `process.stderr.write(...)` — the HELIX convention documented in `packages/helix/agents.md` (2026-04-03 entry). No `console.log/warn/error/info`. No `createLogger` (that helper is runtime-only). Streaming `StreamEvent` flows through `onStream` callback — never written directly to stderr.

Files Touched (Commit 1.A):

- `packages/helix/package.json` — new dep.
- `packages/helix/src/types.ts` — type extensions (§1.2).
- `packages/helix/src/models/executor-errors.ts` — NEW.
- `packages/helix/src/models/openai-api-executor.ts` — NEW.
- `packages/helix/src/models/model-router.ts` — register executor at line 48-67.

(Intentionally NOT touched in this commit per D-9 and Task 1.A.5: `models/claude-sdk-executor.ts`, `models/codex-cli-executor.ts`.)

**Commit 1.B — Oracle swap + cost accumulator + CLI flags + doctor**

Tasks:

1.B.1. Create `pipeline/cost-accumulator.ts`:

- Export `accumulateProviderCost(session, result): void`.
- Key format: `${result.engine}:${result.model ?? 'unknown'}`.
- If entry absent, initialize `{ totalUsd: 0, callCount: 0 }`.
- Increment `callCount` by 1 always. Increment `totalUsd` by `result.costUsd ?? 0`.
  1.B.2. Update `oracles/oracle-constellation.ts`:
- **Export `resolveArchitectureOracle(config: HelixConfig): OracleDefinition`** — returns the GPT-5 Architecture entry (engine `openai-api`, model `config.openaiModel ?? 'gpt-5'`, same `id/focusAreas/tools/promptFile` as the Opus variant; `maxBudgetUsd: 10` preserved; `maxTurns` preserved) when `config.useOpenAiArchitectureOracle` is true, else the existing Opus variant at lines 370-383.
- **Convert `defaultOracles` (const at line 355) to `function buildDefaultOracles(config?: HelixConfig): OracleDefinition[]`** that returns the existing 4-entry array with the Architecture entry replaced by `resolveArchitectureOracle(config)` when `config?.useOpenAiArchitectureOracle === true`. Keep `buildDefaultOracles` module-private — no exports widened.
- **Constructor**: add an optional `config?: HelixConfig` as the **5th constructor parameter** (`constructor(modelRouter, reporter, customOracles?, maxConcurrentOracles?, config?)`). Update line 66 to `this.oracles = customOracles ?? buildDefaultOracles(config)`. Thread `config` through from the caller at `special-stage-executor.ts:196-201` — the existing `SpecialStageExecutor` already holds `this.deps.config`, so `new OracleConstellation(this.deps.modelRouter, this.deps.reporter, customOracles, undefined, this.deps.config)`.
- **`buildOracleSynthesisModelSpec` at line 777-800 must NOT hardcode `'claude-sonnet-4-6'` for openai-api engines.** Today it does: any `OracleDefinition` spec goes in, and the returned object overrides `model` to `'claude-sonnet-4-6'`. If the Architecture oracle is `engine: 'openai-api'`, the synthesis retry path sends `model: 'claude-sonnet-4-6'` to the OpenAI API — unrecognized, crash. Fix: parameterize the fallback model by engine. When `model.engine === 'openai-api'`, use `config?.openaiModel ?? 'gpt-5'` (or the lighter `'gpt-4o-mini'` if preferred for synthesis-retry — D-15 below locks this). Thread `config` into `buildOracleSynthesisModelSpec` via the `OracleConstellation` instance (`this.config`) and its caller (the oracle-result synthesis retry path at lines 141-165). If threading is too invasive, fall back to an engine-aware default inside the function: `model.engine === 'openai-api' ? 'gpt-4o-mini' : 'claude-sonnet-4-6'`.
- **`inferOracleConfidence` at lines 1220-1229 must recognize GPT-5/GPT-4o model names.** Today it returns `0.68` for anything that doesn't contain `'opus'` or `'sonnet'`. Update: add `if (modelName.includes('gpt-5')) return 0.82;` (matches opus-tier reasoning budget) and `if (modelName.includes('gpt-4o')) return 0.75;` (above default, below sonnet). Rationale: this function's output is used as the consensus-weighting factor; without this change, GPT-5 verdicts systematically receive the lowest confidence (0.68) and the cross-provider-convergence feature's core value proposition silently degrades.
- **`tuneOracleModelSpec`**: verify no hardcoded `claude-code` in tuning logic. If present, parameterize by engine. (Per earlier HLD audit this function is engine-agnostic; re-verify during Phase 1 implementation.)
  1.B.3. Update `pipeline/pipeline-engine.ts`:
- Add `accumulateProviderCost(session, result)` call immediately after every `modelRouter.execute(...)` Promise resolves in this file. Verified call sites (as of 2026-04-19): **9 sites** at lines `1982, 2935, 4035, 4197, 4251, 4705, 5185, 5328, 5384`. Each site must be inspected to pass the correct `session` reference (most sites have `session` in scope already; the `return this.modelRouter.execute(...)` form at line 5384 requires converting to `const result = await ...; accumulateProviderCost(session, result); return result;`).
- **Coverage guard (UT-8b):** add a test that asserts `costByProvider` is populated after a pipeline run that exercises each of the 9 call paths the above lines belong to (slice execution, stage-main loop, substages, user-checkpoint, oracle-analysis, manifest-compilation, bulk-review, doc-sync, deterministic-replay). A missing call site shows up as a missing `engine:model` key. See Phase 1, Commit 1.C Task 1.C.5 for the implementation.
  1.B.4. Update `runtime-config.ts` and add env-var reads to `workspace-context.ts` (corrected after round-3 finding — `runtime-config.ts` does NOT contain env-var parsing today):
- **In `runtime-config.ts`**: add defaults only — `useOpenAiArchitectureOracle: false`, `enableDuelingPlanners: false`, `openaiModel: 'gpt-5'`. No env reads in this file.
- **In `workspace-context.ts`** (round-5 correction — this module exports standalone per-group resolver functions like `resolveCliWorkspaceContext`, `resolveInitialLiveContext`, `resolveReplayContext`, NOT a single workspace-context record): add a new sibling function `resolveHelixFeatureFlags(env: NodeJS.ProcessEnv = process.env): { useOpenAiArchitectureOracle?: boolean; enableDuelingPlanners?: boolean; openaiModel?: string }` following the same per-group function pattern. It reads `env.HELIX_USE_OPENAI_ARCHITECTURE_ORACLE === 'true'`, `env.HELIX_ENABLE_DUELING_PLANNERS === 'true'`, and `env.HELIX_OPENAI_MODEL?.trim() || undefined`. Undefined return for any field means "no env override — preserve caller's default". Export it from the `workspace-context.ts` module alongside the existing resolvers.
- **Call site**: `cli.ts` `buildHelixConfig()` (the same place the other `HELIX_*` resolvers are called) invokes `resolveHelixFeatureFlags()` and merges its output into the `HelixConfig` object with CLI-flag > env-var > default precedence (flag set on the `commander` command overrides env, env overrides the `runtime-config.ts` defaults).
- **Rejected alternative**: reading env inline in `buildHelixConfig` without the helper — rejected because the existing pattern is "one resolver function per env-var group in `workspace-context.ts`"; inlining would fork the convention.
  1.B.5. Update `cli.ts` and `readiness/doctor.ts`:
- **In `cli.ts`**: add 3 CLI options to `buildHelixConfig()` at lines ~1268-1321 using the existing `commander.js` style — `--enable-dueling-planners`, `--use-openai-architecture-oracle`, `--openai-model <model>`. Precedence: CLI flag > env var > default.
- **In `readiness/doctor.ts`** (NOT `cli.ts`): `runHelixDoctor` is the authoritative readiness-check entry point; `cli.ts` only dispatches to it (see `cli.ts:58` import, `cli.ts:164/400/1218` call sites). Add a new readiness check to the `doctor.ts` check set that runs when `config.useOpenAiArchitectureOracle || config.enableDuelingPlanners` is true. Assertion: `process.env.OPENAI_API_KEY` is a non-empty string. On failure, the check reports a `failed` severity with message `"OPENAI_API_KEY is required when --enable-dueling-planners or --use-openai-architecture-oracle is set."` The existing `formatReadinessSummary` rendering surfaces it to the CLI. No stack trace. `cli.ts` continues to exit nonzero on any `failed` check per existing behavior — no change to `cli.ts` dispatch logic required beyond wiring the new CLI flags through into the `runHelixDoctor` options bag so the check can read `config.useOpenAiArchitectureOracle` / `config.enableDuelingPlanners`.
  1.B.6. Accumulator call sites outside `pipeline-engine.ts`:
- `special-stage-executor.ts`: grep for `modelRouter.execute` first; insert `accumulateProviderCost(session, result)` after every Promise resolution. Expected: 0-2 sites (most oracle/stage execution flows through `OracleConstellation` which has its own call site).
- `oracle-constellation.ts`: canonical call site is the `modelRouter.execute(...)` at **line 282 inside `executeOracleReview`** (method at line 262, NOT `runOracleDefinition`). **`session` is NOT in scope inside `executeOracleReview`** — it only receives `(oracle, stageName, prompt, primary, tools, timeoutMs?)`. Two fixes are acceptable: (a) thread `session` as an additional parameter to `executeOracleReview` and accumulate inline after the execute resolves; (b) have `executeOracleReview` return the raw `ExecutorResult` alongside its current return shape, and accumulate one level up in `analyzeFindings` (line 71 has `session` in scope) as part of the result-collection loop. Option (a) is simpler and localizes the change; option (b) preserves the method's current return type. Implementer picks — document in the commit message.

Files Touched (Commit 1.B):

- `packages/helix/src/pipeline/cost-accumulator.ts` — NEW.
- `packages/helix/src/oracles/oracle-constellation.ts` — `buildDefaultOracles(config)` factory, engine-aware `buildOracleSynthesisModelSpec`, `inferOracleConfidence` GPT parity, `OracleConstellation` constructor 5th `config?` param, `executeOracleReview` session-threading for cost accumulation.
- `packages/helix/src/pipeline/pipeline-engine.ts` — `accumulateProviderCost` calls at the 9 sites (lines 1982, 2935, 4035, 4197, 4251, 4705, 5185, 5328, 5384).
- `packages/helix/src/pipeline/special-stage-executor.ts` — accumulator call sites (if any in scope after grep).
- `packages/helix/src/runtime-config.ts` — defaults only (no env parsing; see 1.B.4).
- `packages/helix/src/workspace-context.ts` — env reads for `HELIX_USE_OPENAI_ARCHITECTURE_ORACLE`, `HELIX_ENABLE_DUELING_PLANNERS`, `HELIX_OPENAI_MODEL` (extends existing `HELIX_*` pattern at lines 9-55).
- `packages/helix/src/cli.ts` — 3 new `commander.js` flags in `buildHelixConfig()`; threads new fields into `runHelixDoctor` options.
- `packages/helix/src/readiness/doctor.ts` — new readiness check asserting `process.env.OPENAI_API_KEY` when either config flag is on.

**Commit 1.C — Phase 1 tests**

Tasks:

1.C.1. Create `src/__tests__/test-helpers/plan-fixtures.ts` (Phase 1 subset):

- **New infrastructure**: this file is the **first entry** under `src/__tests__/test-helpers/` — the directory does not exist today. `mkdir -p packages/helix/src/__tests__/test-helpers` before writing. The shared-fixture pattern is endorsed for fixtures used across 3+ test files (plan-fixtures is used by `openai-api-executor.test.ts`, `execute-dueling-plan-generation.test.ts`, and `pipeline-engine.test.ts`). Document in `packages/helix/agents.md` per Phase 3.
- Export `makeFakeOpenAiClient(opts)` factory returning a stub that records calls and returns configurable responses. Mirrors OpenAI SDK v4 `chat.completions.create` surface (streaming + non-streaming).
- Export `COST_ATTRIBUTION_FIXTURE` sample map. Consumers: `pipeline-engine.test.ts` (INT-5 cost-accumulator assertions, UT-8b 9-call-site coverage guard) and `oracle-constellation.test.ts` (INT-3 mixed-engine cost attribution).
- (Plan fixtures for Phase 2 added in Task 2.C.1.)
  1.C.2. Create `src/__tests__/openai-api-executor.test.ts`:
- UT-1: `MODEL_PRICING_USD` lookups. Known IDs return populated rates; unknown returns fallback behavior.
- UT-2: Stream event mapper fixtures for each SSE delta type.
- UT-3: `computeCostUsd` with edge cases (zero tokens, missing usage, unknown model).
- UT-10: `isAvailable()` true with key, false without.
- INT-1: Round-trip with fake client — `ExecutorResult` populated, streaming events emitted via `onEvent`, abort propagation, structured output via `response_format`, budget cap throws `BudgetExceededError`.
- INT-11: Error-path matrix — 429, 500, stall, malformed SSE, budget-exceeded mid-stream, partial JSON in structured output.
- SEC-1: API key non-persistence — marker key `'sk-test-MARKER-abc'` is never in any emitted event or persisted JSON.
- SEC-2: Stream event redaction — request/response bodies not interpolated into `StreamEvent.message`.
- SEC-3: Unavailable → `ModelRouter.execute` returns `ExecutorResult` with non-empty `error`, no stack trace, no env-var key echo.
- PERF-2: 1000 SSE chunks with bounded heap delta; `onEvent` called exactly 1000 times.
  1.C.3. Update `src/__tests__/model-router.test.ts`:
- INT-2: `OpenAiApiExecutor` registered in constructor; `router.execute({primary: { engine: 'openai-api', ... }})` dispatches correctly; unavailable branch returns `ExecutorResult` with non-empty `error` (no throw) — verify branch at `model-router.ts:214-223`; fallback: primary `openai-api` fails → `fallback: claude-code` invoked and `result.engine === 'claude-code'`.
  1.C.4. Update `src/__tests__/oracle-constellation.test.ts`:
- UT-5: `resolveArchitectureOracle({ useOpenAiArchitectureOracle: true })` returns `{ engine: 'openai-api', model: 'gpt-5' | config.openaiModel override, ... }`. False returns the Opus default.
- FR-3/INT-3: Full oracle constellation run with the swap — 3 Claude oracles + 1 OpenAI Architecture oracle. Consensus protocol runs; mixed-engine verdicts accepted; `tuneOracleModelSpec` does not revert to `claude-code`.
- FR-16: Oracle checkpoint reuse across engines.
- E2E-6: Full pipeline `oracle-analysis` stage with swap — 4 verdicts → consensus result → checkpoint persist; second run skips all 4 oracles via checkpoint.
  1.C.5. Update `src/__tests__/pipeline-engine.test.ts`:
- INT-5: `costByProvider` accumulator across oracle-analysis with mixed engines. `callCount` increments; `totalUsd` sums. Undefined `costUsd` increments `callCount` only.
- **UT-8 (pure-function tests for `accumulateProviderCost`, per test spec §4):** four sub-scenarios asserted directly against the pure function exported from `pipeline/cost-accumulator.ts`: (a) first call with new `engine:model` creates entry `{ totalUsd: costUsd, callCount: 1 }`; (b) subsequent call with same key increments `totalUsd` and `callCount`; (c) call with `costUsd === undefined` increments `callCount` only and leaves `totalUsd` unchanged; (d) call with `model === undefined` uses `'unknown'` as the model segment of the composite key. Prefer co-locating these in `pipeline-engine.test.ts` (no new file), since `cost-accumulator.ts` is a sibling module of pipeline-engine and is already in the update-set; create a dedicated `accumulate-provider-cost.test.ts` only if co-location inflates `pipeline-engine.test.ts` over the package's existing file-size ceiling.
- **UT-8b (coverage guard for 9 call sites per D-2 / Task 1.B.3):** exercise each call-site path with a stubbed `ModelRouter` that returns distinct `engine:model` tags per path (slice execution, stage-main loop, substages, user-checkpoint, oracle-analysis, manifest-compilation, bulk-review, doc-sync, deterministic-replay). Assert `session.costByProvider` contains a key for every stubbed path — a missing key indicates a missing `accumulateProviderCost` insertion at one of the 9 sites (lines 1982, 2935, 4035, 4197, 4251, 4705, 5185, 5328, 5384 as of 2026-04-19).
  1.C.6. Update `src/__tests__/runtime-config.test.ts`:
- UT-9: Defaults for new 3 fields. Env-var parsing for `HELIX_*` variants.
  1.C.7. Update `src/__tests__/doctor.test.ts`:
- FR-2: flag-set-but-key-missing → nonzero exit with expected message; flag-unset → no change from baseline.
  1.C.8. Update `src/__tests__/session-manager.test.ts`:
- UT-7: `PlanArtifact` JSON round-trip via persist/load (writes a `Session` with populated `duelingPlanState.planA` — even though Phase 2 writes it live, this unit test exercises the type shape today).

Files Touched (Commit 1.C):

- `packages/helix/src/__tests__/test-helpers/plan-fixtures.ts` — NEW (Phase 1 subset).
- `packages/helix/src/__tests__/openai-api-executor.test.ts` — NEW.
- `packages/helix/src/__tests__/model-router.test.ts` — UPDATE.
- `packages/helix/src/__tests__/oracle-constellation.test.ts` — UPDATE.
- `packages/helix/src/__tests__/pipeline-engine.test.ts` — UPDATE (INT-5 only at this stage).
- `packages/helix/src/__tests__/runtime-config.test.ts` — UPDATE.
- `packages/helix/src/__tests__/doctor.test.ts` — UPDATE.
- `packages/helix/src/__tests__/session-manager.test.ts` — UPDATE.

**Phase 1 Exit Criteria**:

- [ ] `pnpm --filter=helix... exec tsc --noEmit` passes (HELIX excluded from workspace; run from `packages/helix/`).
- [ ] `cd packages/helix && pnpm exec vitest run --filter openai-api-executor` — all `openai-api-executor.test.ts` scenarios pass.
- [ ] `cd packages/helix && pnpm exec vitest run` — full suite passes; no regressions in existing tests.
- [ ] `OPENAI_API_KEY` unset + `helix doctor` run with `--use-openai-architecture-oracle` exits nonzero with the expected message.
- [ ] `helix audit <fixture-work-item>` with both flags unset produces a session whose `costByProvider` is populated for every invoked `engine:model` pair. Sessions with the flags set and `OPENAI_API_KEY` present generate an architecture-oracle verdict with `engine === 'openai-api'`.
- [ ] ModelRouter registers 3 engines (`claude-code`, `codex-cli`, `openai-api`) confirmed via `router.getAvailableEngines()`.

**Phase 1 Test Strategy**:

- Unit: UT-1, UT-2, UT-3, UT-5, UT-8, UT-9, UT-10, SEC-1, SEC-2, SEC-3, PERF-2 — pure-function + injected-client scope.
- Integration: INT-1, INT-2, INT-3, INT-5, INT-11 — real `ModelRouter`, real `OracleConstellation`, injected fake OpenAI/Claude clients.
- E2E (in-process pipeline): E2E-6 (Architecture-oracle swap round-trip).

**Phase 1 Rollback**: Revert the 3 commits (1.A + 1.B + 1.C). Any downstream call site that started invoking `accumulateProviderCost` reverts with 1.B. Config flags default false; no persisted config file references the new fields until users explicitly opt in.

---

### Phase 2: Dueling-Planners Convergence

**Goal**: Dispatch to dueling planners when `enableDuelingPlanners` is on; synthesize Plan C via Codex with `disableToolUse`; persist artifacts and checkpoint state; support resume at all three checkpoint boundaries.

**Commit 2.A — Types, schema, synthesis prompt**

Tasks:

2.A.1. Update `types.ts` + `pipeline/stage-output-schema.ts` **atomically in this commit** (round-5 fix):

- **In `types.ts`**: add literal `'plan-c-with-divergence'` to the `StageOutputSchemaId` union. Deferred from Task 1.A.2 because `schemaById: Record<StageOutputSchemaId, JsonSchemaDocument>` requires every union member to have a key; shipping the literal without the `schemaById` entry breaks `tsc --noEmit`.
- **Schema format**: raw `JsonSchemaDocument` (a plain JS object with `$schema`, `$id`, `type`, `properties`, `required`, etc.), NOT Zod. `stage-output-schema.ts` uses AJV 8 with JSON-Schema draft 2020-12 (see imports at lines 1-4 and `const ajv = new Ajv({...})` at line 21). Every existing entry in `schemaById` (`analysisReportSchema`, `slicePlanSchema`, …) is a `JsonSchemaDocument`, not a Zod type.
- Define `planCWithDivergenceSchema: JsonSchemaDocument` by **cloning** `slicePlanSchema`'s top-level shape and adding `divergenceNotes` to its `properties`:
  ```ts
  const planCWithDivergenceSchema: JsonSchemaDocument = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'helix.plan-c-with-divergence',
    title: 'HELIX Plan C With Divergence',
    type: 'object',
    additionalProperties: false,
    required: [...(slicePlanSchema.required as string[])], // unchanged — divergenceNotes is optional
    properties: {
      ...(slicePlanSchema.properties as Record<string, unknown>),
      divergenceNotes: { type: 'string', minLength: 0 },
    },
  };
  ```
- Register `'plan-c-with-divergence': planCWithDivergenceSchema` in the `schemaById` static record (the record is at lines 428-437; exact line offset shifts by +1 after this addition).
- The AJV `validatorCache` at line 22 automatically handles the new schema — no further registration required.
  2.A.2. Update `pipeline/stage-output-parsers.ts`:
- Add `parsePlanCWithDivergenceOutput(rawOutput: string, strict?: boolean): { plan: string; divergenceNotes?: string }`.
- Implementation follows the existing AJV-based pattern (study `parseStructuredStageOutput()` or equivalent in `stage-output-parsers.ts` for canonical structure): (1) parse raw output as JSON; (2) call `validateStageOutputData({ id: 'plan-c-with-divergence', strict: strict ?? true }, parsedJson)` exported from `stage-output-schema.ts`; (3) on validation failure, throw `new StructuredOutputParseError('plan-c-with-divergence', 'AJV validation failed', validateStageOutputData's returned errors)`; (4) on success, return `{ plan: /* stringified or structured plan body */, divergenceNotes: parsed.divergenceNotes }`.
- **Do NOT use Zod `.safeParse()` or `.extend()` anywhere in this feature** — those APIs do not exist on HELIX schemas.
  2.A.3. Create `pipeline/engine/dueling-plan-synthesis-prompt.ts`:
- `buildDuelingSynthesisPrompt({ candidateA, candidateB, featureContext }): string`.
- When both candidates present, emit unlabeled "Candidate A" / "Candidate B" sections + original context + explicit instructions: "You are synthesizing a convergent plan from two candidate plans. Identify areas of agreement and key divergences. Produce Plan C that supersedes both, plus a divergence-notes section with the format specified below. Tool use is disabled — reason strictly over the provided material."
- When `candidateB === undefined` (solo-pass), emit only Candidate A + advisory that Planner B failed. Still instruct divergence-notes format (will be mostly agreement).
- MUST NOT include the literals `"claude-code"`, `"openai-api"`, `"Opus"`, or `"GPT-5"` anywhere in the generated prompt string (UT-4 anti-anchor assertion).

Files Touched (Commit 2.A):

- `packages/helix/src/types.ts` — add `'plan-c-with-divergence'` to `StageOutputSchemaId` union (deferred from 1.A.2 per round-5 fix — must ship atomically with `schemaById` entry).
- `packages/helix/src/pipeline/stage-output-schema.ts` — add schema entry.
- `packages/helix/src/pipeline/stage-output-parsers.ts` — add parser.
- `packages/helix/src/pipeline/engine/dueling-plan-synthesis-prompt.ts` — NEW.

**Commit 2.B — Dueling executor + pipeline dispatch + timeout override**

Tasks:

2.B.1. Create `pipeline/engine/execute-dueling-plan-generation.ts`:

- `executeDuelingPlanGeneration(session, stage, startTime, stageDeadlineAt, deps): Promise<StageResult>` with `deps: DuelingPlanGenerationDeps` (see §1.2).
- Step 1: Timeout guard via `getRemainingTimeoutMs(stageDeadlineAt)`. If ≤ 0, fail the stage. **Exact call** (round-5 correction — `failStageDueToTimeout` takes 9 params, not 3): `return failStageDueToTimeout(session, stage, '', [], [], startTime, 1, {}, deps);` — arg 1 `session`, arg 2 `stage`, arg 3 output string (empty — stage did not produce output), arg 4 `findings[]` (empty), arg 5 `decisions[]` (empty), arg 6 `startTime`, arg 7 `iterations` (1 — timeout before any iteration completed), arg 8 `options` (empty object — defaults are fine), arg 9 `sideEffects`. **`DuelingPlanGenerationDeps.journal` and `.emitProgress` are structurally compatible with `StageTimeoutSideEffects` (`pipeline/engine/fail-stage-due-to-timeout.ts:35-38`)** — TypeScript structural typing lets `deps` be passed directly as the 9th-arg side-effects bag without an adapter.
- Step 2: Read `session.duelingPlanState ?? {}`. Checkpoint branches:
  - Has `planA && planB && planC` → return `makeResult(stage, 'passed', planC.output, [], [], startTime, planC.turnsUsed)`.
  - Has `planA && planB && !planC` → skip to Step 5 (synthesis).
  - Has `planA && !planB` → skip Planner A in fan-out; launch **only** Planner B. Preserves existing `planA.output` on disk and in `duelingPlanState` (E2E-8 resume-after-mid-fanout guarantee). Proceed to Step 3 with a modified fan-out descriptor: `{ launchA: false, launchB: true }`.
  - Has `planB && !planA` → symmetric: launch only Planner A. `{ launchA: true, launchB: false }`.
  - Otherwise (neither present) → Step 3 with `{ launchA: true, launchB: true }`.
- Step 3: Parallel fan-out driven by the fan-out descriptor from Step 2. When both flags are true, race both planners via `Promise.allSettled([plannerA, plannerB])`; when only one flag is true, still wrap the single call in `Promise.allSettled([plannerX])` so Step 4 classification logic is uniform. Each branch:
  - (a) Call `deps.modelRouter.execute(plannerPrompt, plannerAssignment, undefined, onStream, undefined, plannerTimeoutMs)` — note the six-parameter signature verified at `model-router.ts:84-91`. There is **no** `abortSignal` parameter on `ModelRouter.execute`; pipeline-level abort uses `deps.modelRouter.abortActiveExecutions()` at `model-router.ts:175`.
  - (b) **Wrap** the returned `ExecutorResult` at once: if `result.error` is a non-empty string, **throw** the corresponding typed class (`new ClaudeSdkError(result.error)` for Planner A, `new OpenAiApiError('planner-error', undefined, result.error)` for Planner B) so that `Promise.allSettled` classifies the branch as `rejected`. If `result.error` is empty, proceed.
  - (c) Construct `PlanArtifact` from the successful `ExecutorResult`.
  - (d) Merge into `session.duelingPlanState` (in-memory mutation).
  - (e) `await deps.sessionManager.persist(session)` — the public persist queue at `session-manager.ts:96-105` serializes disk writes via its internal queue.
  - (f) `await fs.promises.writeFile(path.join(deps.config.sessionDir, session.id, 'plan-a.md'|'plan-b.md'), artifact.output)`.
  - **Concurrent-persist guarantee (INT-10 correctness):** both `.then()` branches mutate **the same in-memory `session` object**, and `SessionManager`'s persist queue serializes the two disk writes so the later one sees both mutations. Await-ing in each branch does NOT serialize the branches with each other (the two `.then()` callbacks run in parallel); correctness rests on (i) shared in-memory object + (ii) persist queue ordering. INT-10 must assert both `planA` and `planB` are present on the reloaded `session.json` even when resolutions are near-simultaneous.
- Step 4: Classify `Promise.allSettled` result — at this point rejections come from (i) thrown typed-error wrappers in Step 3(b), (ii) any unexpected `throw` inside the `.then()` branch (persist failure, filesystem failure).
  - 0 fulfilled → return `makeResult(stage, 'failed', ...)` with advisory entries for both rejection reasons (each carries a `class` derived from the thrown class's `.name`); skip Codex entirely (FR-8).
  - 1 fulfilled → Solo-pass. Mark surviving artifact `soloPass: true`. Capture the rejected branch's reason into an advisory with `class: 'planner-failure'`. Proceed to Step 5 with `candidateB === undefined` (or swap A/B as appropriate). (If Step 2 entered this step with only one planner launched — resume case — the "rejected" count can be zero; treat `0 rejected + 1 fulfilled` as Solo-pass too when the fan-out descriptor indicated single-planner launch.)
  - 2 fulfilled → dueling. Proceed to Step 5 with both.
- Step 5: Build synthesis prompt via `buildDuelingSynthesisPrompt({ candidateA, candidateB, featureContext })`. `featureContext` comes from the stage prompt (use `buildStagePrompt(stage, session, …)` from `stage-runner.ts` the same way existing special stages do, or extract the feature slug from `session.workItem.featureSlug` if present).
- Step 6: Invoke Codex via `deps.modelRouter.execute(synthesisPrompt, { primary: { engine: 'codex-cli', model: 'gpt-5.4', maxTurns: 12, maxBudgetUsd: (reuse from stage config or a new constant), efficiencyBudget: { disableToolUse: true, explorationTurns: 0, targetTurns: 8, hardTurnCap: 12 } } }, undefined, onStream, { id: 'plan-c-with-divergence' }, synthesisTimeoutMs)` — six-parameter signature, `outputSchema` passed as `StageOutputSchemaConfig` with `{ id, strict? }` shape per `types.ts:231-233`, and **no** `abortSignal`. On failure: if `result.error` is non-empty, wrap into `new CodexCliError('codex-synthesis-failure', undefined, result.error)` and return `makeResult(stage, 'failed', ...)` with advisory `{ class: 'codex-synthesis-failure' }` (FR-9). Plan A/B artifacts remain on disk.
- Step 7: Parse Codex output via `parsePlanCWithDivergenceOutput(result.output)`. On parse failure → return `failed` with `{ class: 'structured-output-parse-error' }`.
- Step 8: Construct `PlanArtifact` for Plan C. Persist to `session.duelingPlanState.planC` + `.divergenceNotes`. `await deps.sessionManager.persist(session)`.
- Step 9: Write `plan-c.md` (content = `planC.output`) and `divergence-notes.md` (content = `planC.divergenceNotes`) via `fs.promises.writeFile`. If solo-pass, `divergence-notes.md` content includes the advisory about failed planner (Codex is instructed to include this per synthesis-prompt).
- Step 10: Journal entry via `deps.journal(session, { timestamp: now(), type: 'stage-complete', stage: stage.name, message: "Dueling plans: Candidate A (<engine>/<model>, $<cost>), Candidate B (<engine>/<model>, $<cost>), synthesized via codex-cli/gpt-5.4 ($<cost>). Divergences: <count-from-plan-c>." })`. On solo-pass, message variants: "Dueling plans: Candidate A only (<engine>/<model>, $<cost>), Planner B failed: <reason>, synthesized via codex-cli/gpt-5.4 ($<cost>)."
- Step 11: Return `makeResult(stage, 'passed', planC.output, [], advisoryEntries, startTime, totalTurnsUsed)` where `advisoryEntries` contains a one-line dueling summary plus any solo-pass markers.
- Error classes: all caught errors classified via `isErrorOfClass()` helpers; `Error` without a named class surfaces as an advisory class `'unknown-error'`.
- All `modelRouter.execute` calls are followed by `accumulateProviderCost(session, result)` per D-2.
  2.B.2. Update `pipeline/special-stage-executor.ts`:
- Add `executeDuelingPlanGeneration(session, stage, startTime, stageDeadlineAt?): Promise<StageResult>`. Follows `executeVerificationBootstrap` shape (lines 113-166): timeout guard, delegate to engine module, return result. Wraps the engine call with a preflight `deps: DuelingPlanGenerationDeps` built from `this.deps`.
  2.B.3. Update `pipeline/pipeline-engine.ts`:
- **IMPLEMENTER NOTE — feature-spec errata.** Feature-spec §13 Phase 2 task 2.6 instructs the implementer to "Raise `PLAN_GENERATION_TIMEOUT_MS` to 18 minutes in `holistic-audit.ts` conditional on config" and references a non-existent `planStageTimeoutMs(config)` helper. This is errata (see D-3 and D-6). The correct implementation is the dispatch-site override described below. **Do NOT modify `packages/helix/src/pipeline/templates/holistic-audit.ts`** — it remains a top-level `const` (see §2.2 Modified Files row). The errata correction ships in Phase 3 Task 3.1.
- In `executeStage()`, add a dispatch case BEFORE the existing `stage.type === 'oracle-analysis'` block (between the `bootstrap` case at 1806-1813 and the `implementation` case at 1816-1818 is natural — the order of sibling type-based dispatches doesn't matter semantically as long as each stage-type is exclusive):
  ```ts
  if (stage.type === 'plan-generation' && this.config.enableDuelingPlanners) {
    return this.specialStageExecutor.executeDuelingPlanGeneration(
      session,
      stage,
      startTime,
      stageDeadlineAt,
    );
  }
  ```
- Timeout override (D-6): BEFORE the dispatch decision, when `stage.type === 'plan-generation' && this.config.enableDuelingPlanners`, override the effective stage deadline:
  `ts
const effectiveStageDeadlineAt =
  stage.type === 'plan-generation' && this.config.enableDuelingPlanners
    ? (startTime + 18 * 60_000)
    : stageDeadlineAt;
`
  Pass `effectiveStageDeadlineAt` into the dispatch. (Exact placement depends on how `stageDeadlineAt` is currently computed — hunt the existing source in `pipeline-engine.ts`; the override goes after that computation.)
  2.B.4. Re-confirm `accumulateProviderCost` wiring is already in place from Phase 1 (1.B.3). No additional insertions here — the dueling flow's 3 `modelRouter.execute` calls live inside `engine/execute-dueling-plan-generation.ts` and each is followed by `accumulateProviderCost`.

Files Touched (Commit 2.B):

- `packages/helix/src/pipeline/engine/execute-dueling-plan-generation.ts` — NEW.
- `packages/helix/src/pipeline/special-stage-executor.ts` — add public method.
- `packages/helix/src/pipeline/pipeline-engine.ts` — dispatch case + timeout override.

**Commit 2.C — Phase 2 tests + fixtures**

Tasks:

2.C.1. Update `src/__tests__/test-helpers/plan-fixtures.ts` (Phase 2 additions):

- `PLAN_A_FIXTURE`, `PLAN_B_FIXTURE`, `PLAN_C_FIXTURE`, `DIVERGENCE_NOTES_FIXTURE`.
- `makeFakeClaudeSdk(opts)` — factory returning a fake Claude SDK client mirroring `@anthropic-ai/claude-agent-sdk`'s `query()` surface (the test spec clarifies `vi.mock` of the external SDK is allowed per existing HELIX pattern; to keep the DI approach consistent here, provide both — `makeFakeClaudeSdk` for injected DI tests and the `vi.mock` pattern is acceptable for tests that predate DI).
- `makeFakeCodexSpawner(opts)` — emits pre-canned stdout events to simulate Codex CLI subprocess.
  2.C.2. Create `src/__tests__/execute-dueling-plan-generation.test.ts`:
- INT-4 matrix cells:
  - **Happy path**: both planners succeed, Codex synthesizes, 4 artifact files on disk, `duelingPlanState.{planA, planB, planC, divergenceNotes}` populated.
  - **Planner A fails only**: Solo-pass, `duelingPlanState.planA === undefined`, `planB.soloPass === true`, `plan-a.md` NOT on disk, `plan-b.md` on disk, `plan-c.md` on disk.
  - **Planner B fails only**: symmetric.
  - **Both planners fail**: `status: 'failed'`, Codex NOT invoked, no artifact files, advisory lists both failure reasons with `class: 'planner-failure'`.
  - **Codex fails after planner success**: `status: 'failed'`, `plan-a.md` + `plan-b.md` present, `plan-c.md` absent, `duelingPlanState.planC === undefined`, advisory `class: 'codex-synthesis-failure'`.
  - **Resume after A+B checkpoint**: re-invoke executor with pre-populated `duelingPlanState.planA + planB`. Fake Claude SDK call count 0; fake OpenAI client call count 0; Codex invoked exactly once.
  - **Resume after C checkpoint**: `status: 'passed'` immediately, no planner or Codex invocations.
  - **Resume after Planner A only (mid-fanout interrupt, E2E-8 aligned)**: re-invoke executor with `duelingPlanState.planA` populated and `duelingPlanState.planB === undefined`. Assert Claude SDK call count 0 (A not re-invoked); fake OpenAI client call count 1 (only B re-invoked); plan-a.md unchanged on disk; Codex invoked once after B completes.
  - **Resume after Planner B only (symmetric)**: `duelingPlanState.planB` populated and `planA` undefined. Claude SDK invoked once; OpenAI client invoked zero times.
  - **Synthesis prompt builder error**: mock throws, returns `status: 'failed', reason: 'prompt-builder-error'`, Codex not invoked.
- INT-10: concurrent persist — Planner A and B resolve within 1ms; `session.json` after both persists contains both artifacts; re-read returns a valid complete `duelingPlanState` (no lost writes).
  2.C.3. Create tests for the synthesis prompt builder (can live in `execute-dueling-plan-generation.test.ts` or a dedicated `dueling-plan-synthesis-prompt.test.ts` — prefer a dedicated file for UT-4):
- UT-4: both candidates → contains "Candidate A" + "Candidate B"; does NOT contain `claude-code|openai-api|Opus|GPT-5`.
- Solo-pass branch: contains advisory about failed planner; still instructs divergence-notes format.
  2.C.4. Add tests for the stage-output schema + parser:
- Update `src/__tests__/stage-output-schema.test.ts`: assert `schemaById['plan-c-with-divergence']` exists and is a `JsonSchemaDocument` (plain JS object with `$schema`, `$id`, `type`, `properties`, `required`). Confirm its `properties` contain everything from `slicePlanSchema.properties` plus `divergenceNotes: { type: 'string' }`. Confirm `validateStageOutputData({ id: 'plan-c-with-divergence', strict: true }, sampleObject)` returns a valid result for a well-formed sample and surfaces AJV errors for a malformed sample. **No Zod anywhere.**
- Update `src/__tests__/stage-output-parsers.test.ts`: `parsePlanCWithDivergenceOutput` valid JSON → returns plan + divergenceNotes; missing `divergenceNotes` → OK (optional); malformed JSON → throws `StructuredOutputParseError` carrying AJV error details. Empty plan body (fails `slicePlanSchema`'s `NON_EMPTY_STRING_SCHEMA` on `summary`) → throws `StructuredOutputParseError`.
  2.C.5. Update `src/__tests__/pipeline-engine.test.ts`:
- **E2E-1**: full pipeline dueling happy path; 4 artifact files; `costByProvider` across 3 keys.
- **E2E-2**: full pipeline Planner B fails; solo-pass; `plan-b.md` absent; `planA.soloPass === true`.
- **E2E-3**: full pipeline both planners fail; hard-abort via `handleBlockingStageResult`; no artifact files.
- **E2E-4**: full pipeline Codex fails; planner artifacts preserved; stage failed; resume re-attempts Codex.
- **E2E-5**: resume between planner completion and Codex synthesis; second run does not re-invoke planners; cost shows no double-billing.
- **E2E-7**: both flags on simultaneously; oracle-analysis + plan-generation both diverse; cost keys for all 5 engine:model combos.
- **E2E-8**: abort mid-planner-fanout; `planA` survived; `planB === undefined`; resume re-invokes only Planner B.
- **INT-7**: journal entry format assertions (ISO timestamp + "Dueling plans:" + costs + divergence count).
- **INT-8**: dispatch-wiring spy asserts `executeDuelingPlanGeneration` invoked exactly once on `plan-generation` when flag on; NOT invoked when flag off (pipeline falls through to generic loop at ~line 1870).
- **INT-9**: Plan Quality gate flow-through — gate evaluates Plan C against `slice-plan` schema unchanged; `divergenceNotes` ignored by the gate.
- **PERF-1**: wall-clock < 500ms with fake executors (proves parallel fan-out).
- **PERF-3**: resume-efficiency — resume-run `costByProvider` for `claude-code:opus` and `openai-api:gpt-5` is unchanged from pre-interrupt state.
- **UT-6** (if no `pipeline-templates.test.ts` exists, add here): assert `stageDeadlineAt` for `plan-generation` is 18min when flag on, 8min when off.
- **INT-6 (integration-level timeout dispatch):** (a) pipeline reads the timeout value at stage-entry time, not at config-load time — toggling `config.enableDuelingPlanners` between two stages within the same session takes effect on the next stage; (b) when a plan-generation stage times out, `executeStage` returns `{ status: 'timeout' }` via `handleStageTimeout` and the pipeline proceeds down the existing timeout-path unchanged; (c) malformed config (`enableDuelingPlanners` passed as a non-boolean through a misconfigured env var) falls back to the 8-minute default and emits a single `process.stderr.write` warning. UT-6 covers the pure-function cases; INT-6 exercises the dispatch seam against a real `PipelineEngine` instance.
  2.C.6. Update `src/__tests__/special-stage-executor.test.ts`:
- INT-8 unit-level: spy on `SpecialStageExecutor.executeDuelingPlanGeneration`; verify it's called with the correct args when pipeline dispatches.
  2.C.7. Update `src/__tests__/session-manager.test.ts`:
- UT-7 Phase 2 addition: full `duelingPlanState` round-trip — populate `{ planA, planB, planC, divergenceNotes }`, persist, reload; deep-equal.

Files Touched (Commit 2.C):

- `packages/helix/src/__tests__/test-helpers/plan-fixtures.ts` — UPDATE (Phase 2 fixtures).
- `packages/helix/src/__tests__/execute-dueling-plan-generation.test.ts` — NEW.
- `packages/helix/src/__tests__/dueling-plan-synthesis-prompt.test.ts` — NEW (OR merged into execute-dueling-plan-generation.test.ts).
- `packages/helix/src/__tests__/stage-output-schema.test.ts` — UPDATE.
- `packages/helix/src/__tests__/stage-output-parsers.test.ts` — UPDATE.
- `packages/helix/src/__tests__/pipeline-engine.test.ts` — UPDATE (E2E-1..E2E-5, E2E-7, E2E-8, INT-7, INT-8, INT-9, PERF-1, PERF-3, UT-6).
- `packages/helix/src/__tests__/special-stage-executor.test.ts` — UPDATE.
- `packages/helix/src/__tests__/session-manager.test.ts` — UPDATE.

**Phase 2 Exit Criteria**:

- [ ] `pnpm exec tsc --noEmit` passes from `packages/helix/`.
- [ ] `pnpm exec vitest run` passes all new + updated tests.
- [ ] E2E-1 (happy path) dry-runs `helix audit <fixture-work-item>` with both flags on and produces `plan-a.md` + `plan-b.md` + `plan-c.md` + `divergence-notes.md` in the session dir.
- [ ] E2E-3 (both fail) dry-run shows pipeline state `blocked` with both-planner-failure advisory; no silent Plan A or Plan B substitution.
- [ ] E2E-5 resume-test passes — re-running after Plan A+B persists invokes Codex only (no planner re-invocations).
- [ ] `helix status <session-id>` surfaces `costByProvider` summary for all 3 engine:model keys in a dueling run.
- [ ] ALPHA promotion criteria per feature spec §17 met (UT-1..UT-10, INT-1, INT-2, at least 3 of E2E-1..E2E-8).

**Phase 2 Test Strategy**:

- Unit: UT-4, UT-6, UT-7 — pure-function + round-trip.
- Integration: INT-4 (all matrix cells), INT-6, INT-7, INT-8, INT-9, INT-10.
- E2E (in-process pipeline): E2E-1, E2E-2, E2E-3, E2E-4, E2E-5, E2E-7, E2E-8.
- Performance: PERF-1, PERF-3.

**Phase 2 Rollback**: Revert the 3 commits (2.A + 2.B + 2.C). Dispatch case and timeout override remove cleanly. `duelingPlanState` / `costByProvider` fields persist on any sessions created during the interim — harmless (JSON round-trip preserves unknown fields).

---

### Phase 3: Documentation & Feature Status

**Goal**: Sync SDLC docs to implementation reality. Promote feature status. Fix feature-spec errata (D-3).

**Commit 3 — Docs + status promotion**

Tasks:

3.1. Update `docs/features/sub-features/cross-provider-quorum-convergence.md`:

- §1 front-matter: `Status: PLANNED` → `Status: ALPHA` (BETA promotion deferred until scenarios 1-23 all pass in sustained local runs).
- §10 line 278 (Key Implementation Files) — replace the fabricated signature `executeDuelingPlanGeneration(workDir, session, stage, deps)` with the canonical `executeDuelingPlanGeneration(session, stage, startTime, stageDeadlineAt?)` and note that the engine module is called via `SpecialStageExecutor.executeDuelingPlanGeneration` which resolves deps from `this.deps`.
- §13 Phase 2 task 2.6 — replace `planStageTimeoutMs(config)` reference with the dispatch-site-override description per LLD D-6. Link to LLD §3 Phase 2 commit 2.B task 2.B.3.
- §17 coverage matrix — update status column for each FR to `PASS` (or `PARTIAL` if any scenarios are still flaky).
  3.2. Update `docs/testing/sub-features/cross-provider-quorum-convergence.md`:
- §10 Status `PLANNED` → `IMPLEMENTED` (or `PARTIAL` if fewer than the 23 scenarios pass).
- §1 Coverage Matrix — update each FR's Status column.
  3.3. Update `docs/testing/sub-features/README.md` — add entry for the new test spec (or update existing entry).
  3.4. Update `docs/features/sub-features/README.md` — table entry for this feature (ALPHA status).
  3.5. Update `packages/helix/HELIX.md`:
- §Future Work #1 "API-based executors" — add note: OpenAI executor implemented (2026-04-19, ABLP-406), Claude API remains open.
- Architecture table / Model Strategy section — document dueling-planners mode and Architecture-oracle swap as named capabilities.
  3.5a. Correct HLD Zod references (round-3 finding — HLD uses the wrong term):
- `docs/specs/cross-provider-quorum-convergence.hld.md` line 360 (Concern #4) — replace "Zod-based `stage-output-parsers.ts`" with "AJV 8 + JSON Schema draft 2020-12 (`stage-output-schema.ts` + `stage-output-parsers.ts`)".
- Same file line 524 — replace "Zod schemas in `stage-output-schema.ts`" with "`JsonSchemaDocument` entries registered in `schemaById` (`stage-output-schema.ts`), validated via AJV 8 + `validateStageOutputData`".
- This is a documentation-only correction; no implementation impact. Include in the Phase 3 commit alongside the other doc syncs.
  3.6. Update `packages/helix/agents.md` — append learning-journal entry for the feature:
- Dueling-plan pattern (parallel fan-out with per-planner eager persist; Codex synthesis with `disableToolUse`).
- Cost-accumulator call-site wrapper (no router post-hook).
- Solo-pass vs. both-fail classification via `Promise.allSettled` result shape.
- Timeout override at dispatch site (template static-const preservation).
  3.7. Update `packages/helix/CLAUDE.md` Change Checklist:
- Add `openai-api-executor.test.ts` under "Prompt or slice-packet changes" is NOT applicable; add under a new "OpenAI executor changes" bullet: `src/__tests__/openai-api-executor.test.ts`, `src/__tests__/model-router.test.ts`.
- Add "Dueling-plan changes → `src/__tests__/execute-dueling-plan-generation.test.ts`, `src/__tests__/pipeline-engine.test.ts`".
  3.8. Run `/post-impl-sync cross-provider-quorum-convergence` as a final consistency pass (validates every referenced file path, updates coverage tables, etc.).

Files Touched (Commit 3):

- `docs/features/sub-features/cross-provider-quorum-convergence.md` — UPDATE (status, errata, coverage).
- `docs/testing/sub-features/cross-provider-quorum-convergence.md` — UPDATE (status, coverage).
- `docs/testing/sub-features/README.md` — UPDATE.
- `docs/features/sub-features/README.md` — UPDATE.
- `docs/specs/cross-provider-quorum-convergence.hld.md` — UPDATE (Zod→AJV corrections at lines 360 and 524).
- `packages/helix/HELIX.md` — UPDATE.
- `packages/helix/agents.md` — UPDATE (append).
- `packages/helix/CLAUDE.md` — UPDATE (change-checklist).

**Phase 3 Exit Criteria**:

- [ ] All coverage-matrix rows in feature spec §17 and test spec §1 show current status (PASS/PARTIAL/FAIL) matching actual test results.
- [ ] `tools/design-lint.sh docs/specs/cross-provider-quorum-convergence.hld.md` still passes.
- [ ] Feature spec errata (D-3) resolved — §10 line 278 and §13 Phase 2 task 2.6 match LLD.
- [ ] `packages/helix/agents.md` has the new learning-journal entry appended.
- [ ] `packages/helix/HELIX.md` §Future Work #1 updated.

**Phase 3 Test Strategy**: No new tests. This phase is documentation-only. Run `pnpm exec vitest run` once before commit to confirm Phase 1 + Phase 2 tests remain green.

**Phase 3 Rollback**: `git revert` the single docs commit. Reverts cleanly — no code changes.

---

## 4. Wiring Checklist

**CRITICAL**: Every new component must be wired into its callers. This checklist prevents the #1 agent failure mode (dead code).

- [ ] **`OpenAiApiExecutor` registered in `ModelRouter`**: `packages/helix/src/models/model-router.ts` constructor map at lines 48-67 includes a third entry: `['openai-api', new OpenAiApiExecutor(workDir)]`. Verified by INT-2 and `router.getAvailableEngines()` returning 3 engines.
- [ ] **`ModelEngine` union unchanged** — `'openai-api'` already exists at `types.ts:269-273`. Confirm no accidental modification.
- [ ] **`resolveArchitectureOracle` used at constellation-construction**: `oracle-constellation.ts` either (a) builds the `defaultOracles` array via the helper when `HelixConfig` is present, or (b) injects the Architecture entry at constructor time. Verified by UT-5 and E2E-6.
- [ ] **`OracleConstellation` receives `HelixConfig`**: check constructor signature thread-through from the call site in `special-stage-executor.ts:196-200`. If `config` param added, update every caller.
- [ ] **`executeDuelingPlanGeneration` exposed on `SpecialStageExecutor`**: public method following `executeVerificationBootstrap` shape at lines 113-166. Delegates to engine module via `this.deps`.
- [ ] **`plan-generation` dispatch case in `pipeline-engine.ts`**: new `if` block in `executeStage` with the correct guard `stage.type === 'plan-generation' && this.config.enableDuelingPlanners`. Dispatch to `this.specialStageExecutor.executeDuelingPlanGeneration(...)`. Verified by INT-8.
- [ ] **Timeout override at dispatch site**: computed `effectiveStageDeadlineAt` is 18min when dueling on, 8min otherwise. Verified by UT-6 / INT-6.
- [ ] **`accumulateProviderCost` invoked after every `modelRouter.execute()` return in pipeline code**: grep `rg "modelRouter\.execute\("` in `pipeline-engine.ts`, `special-stage-executor.ts`, `oracle-constellation.ts`, and the new `execute-dueling-plan-generation.ts` — each should have a sibling `accumulateProviderCost(session, result)` line. Verified by INT-5 assertions.
- [ ] **Schema registered in `schemaById` static record**: `'plan-c-with-divergence'` appears in `stage-output-schema.ts:428-437`. Verified by `stage-output-schema.test.ts`.
- [ ] **Parser imported and used at call site**: `parsePlanCWithDivergenceOutput` imported in `execute-dueling-plan-generation.ts` and called on the Codex synthesis output. Verified by INT-11 malformed-JSON scenario.
- [ ] **Synthesis prompt builder imported and used**: `buildDuelingSynthesisPrompt` imported in `execute-dueling-plan-generation.ts` and called in Step 5 of the executor. Verified by UT-4 assertions in integration test.
- [ ] **CLI flags wired into `HelixConfig` via `buildHelixConfig()`**: 3 flags added to `cli.ts:1268-1321`. Env-var fallbacks live in `workspace-context.ts` (extends existing `HELIX_*` pattern at lines 9-55, NOT `runtime-config.ts`). Verified by UT-9 and a manual `helix audit --enable-dueling-planners --help` run.
- [ ] **`helix doctor` validates `OPENAI_API_KEY`**: new check added to `readiness/doctor.ts` (NOT `cli.ts` — `cli.ts` only dispatches via `runHelixDoctor`). Fires when either flag is set. Verified by `doctor.test.ts` FR-2 scenarios.
- [ ] **Journal entry written per dueling run**: `deps.journal(session, entry)` called in Step 10 of `execute-dueling-plan-generation.ts`. Entry matches format from feature spec §9. Verified by INT-7.
- [ ] **Artifact files written to session directory**: `path.join(config.sessionDir, session.id, 'plan-a.md' | 'plan-b.md' | 'plan-c.md' | 'divergence-notes.md')`. Verified by E2E-1 filesystem assertions.
- [ ] **`Session` type extension survives JSON round-trip**: Confirm `SessionManager.persist()` writes unknown fields losslessly (existing behavior — no code changes required). Verified by UT-7.
- [ ] **`HelixConfig` defaults preserve existing behavior**: `useOpenAiArchitectureOracle: false`, `enableDuelingPlanners: false`, `openaiModel: 'gpt-5'`. Verified by UT-9 (defaults) + INT-8 (dispatch falls through to generic loop when both flags off), which together cover feature-spec §17 row 23 ("config defaults leave existing behavior unchanged").
- [ ] **`openai` dep resolves at repo root**: after `pnpm install`, `node -e "require('openai')"` from `packages/helix/` works; no duplicate version in `node_modules`.
- [ ] **Change-checklist updated in `packages/helix/CLAUDE.md`**: entries for the new test files present.
- [ ] **Status promoted in feature spec, test spec, README indexes**: Phase 3 commit updates all three.
- [ ] **Feature-spec errata resolved (D-3)**: §10 line 278 and §13 Phase 2 task 2.6 match LLD reality.

---

## 5. Cross-Phase Concerns

### 5.1 Database Migrations

N/A. HELIX has no database. Session state is JSON files on the developer's local filesystem. Two new optional fields (`Session.costByProvider`, `Session.duelingPlanState`) land via `SessionManager.persist()` which preserves unknown JSON fields. Sessions persisted before this feature forward-compatibly initialize with `?? {}` at read sites (HLD §5.5). No migration code, no schema-version bump.

### 5.2 Feature Flags

- `HelixConfig.useOpenAiArchitectureOracle` (boolean, default false)
- `HelixConfig.enableDuelingPlanners` (boolean, default false)
- `HelixConfig.openaiModel` (string, default `'gpt-5'`)

All three flags independent. No staged rollout scheme beyond opt-in CLI flags / env vars. Operators toggle per invocation. HELIX has no feature-flag service — flags live in `HelixConfig` only.

Rollout plan: Phase 1 + Phase 2 land with both flags default false. Phase 3 doc-sync promotes feature to ALPHA. Operators enable flags manually. BETA promotion happens after sustained local-run validation (feature spec §17 "STABLE when scenario failure rates < 0.5% across 10 consecutive local runs").

### 5.3 Configuration Changes

Env vars (documented in feature spec §11 + HLD §6):

- `OPENAI_API_KEY` (pre-existing — Codex CLI already consumes)
- `HELIX_OPENAI_MODEL` (default `'gpt-5'`)
- `HELIX_USE_OPENAI_ARCHITECTURE_ORACLE` (default `false`)
- `HELIX_ENABLE_DUELING_PLANNERS` (default `false`)

CLI flags (documented in feature spec §11 + HLD §6):

- `--enable-dueling-planners`
- `--use-openai-architecture-oracle`
- `--openai-model <model>`

Precedence: CLI flag > env var > default (matches existing HELIX config precedence).

### 5.4 Dependency Changes

- **Add**: `"openai": "^4.77.0"` in `packages/helix/package.json` dependencies.
- HELIX is excluded from the pnpm workspace (`pnpm-workspace.yaml:3 !packages/helix`). Lockfile resolution happens at repo root; since `openai@^4.77.0` is already a resolved dependency in 3 other workspace packages (`search-ai-internal`, `mcp-openai-reviewer`, `codetool-sandbox/runtime_js`), no new version entries are expected in `pnpm-lock.yaml`. Verify via `pnpm install` diff after the dep is added.
- No dev-dependency changes. Test fixtures use the `openai` SDK's types but never its network-capable client (DI via `makeFakeOpenAiClient`).

### 5.5 Secret Management

`OPENAI_API_KEY` read from `process.env` at executor-invocation time. Never persisted, never logged, never interpolated into `StreamEvent.message`. SEC-1 test asserts this using a marker key value. SEC-3 test asserts error messages don't echo env-var values.

### 5.6 Performance Budget

- Plan-stage wall-clock: 8 min single-model → 18 min with dueling (2.25× headroom for 2 planners parallel + 1 synthesis serial).
- Plan-stage token cost: ≈2.5× single-model (two full plans + lighter synthesis).
- No concurrency limit changes — 2 parallel planner calls per session is well within any provider rate-limit.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 3 phases complete with exit criteria met (§3).
- [ ] All 8 E2E scenarios from test spec §2 pass.
- [ ] All 11 integration scenarios from test spec §3 pass.
- [ ] All 10 unit scenarios from test spec §4 pass.
- [ ] All 3 security/isolation scenarios from test spec §5 pass (SEC-1, SEC-2, SEC-3).
- [ ] All 3 performance scenarios from test spec §6 pass (PERF-1, PERF-2, PERF-3).
- [ ] Every functional requirement (FR-1..FR-16) from feature spec §4 has at least one passing test mapped in the coverage matrix.
- [ ] Every row in the feature-spec §17 coverage matrix (23 scenarios) has status `PASS` (or documented `PARTIAL` with justification).
- [ ] No regressions in existing HELIX tests (`cd packages/helix && pnpm exec vitest run` all green).
- [ ] `pnpm exec tsc --noEmit` passes from `packages/helix/`.
- [ ] `helix audit` with both flags unset produces byte-identical behavior to pre-feature baseline on a fixture run (feature-spec §17 row 23 regression check, covered by UT-9 + INT-8).
- [ ] `helix audit --enable-dueling-planners --use-openai-architecture-oracle <fixture>` completes end-to-end and produces all artifact files + journal entry + `costByProvider` map across 5 distinct engine:model keys.
- [ ] Feature spec updated: status `PLANNED` → `ALPHA`. Testing matrix reflects actual coverage. Errata (D-3) resolved.
- [ ] Test spec updated: status `PLANNED` → `IMPLEMENTED`.
- [ ] `packages/helix/HELIX.md` §Future Work #1 updated.
- [ ] `packages/helix/agents.md` learning-journal entry appended.
- [ ] `packages/helix/CLAUDE.md` change-checklist updated with the new test files.
- [ ] `tools/design-lint.sh docs/specs/cross-provider-quorum-convergence.hld.md` passes (sanity — no HLD regressions).
- [ ] Commit discipline: 7 commits total (1.A, 1.B, 1.C, 2.A, 2.B, 2.C, 3). Each ≤ 40 non-doc files, each ≤ 3 packages, all `feat()` commits < 30% deletion ratio (per CLAUDE.md commit-scope-guard).
- [ ] `pnpm jira:update -- ABLP-406 --comment "LLD landed: <PR link>"` to map work back to Jira (per CLAUDE.md JIRA workflow).

---

## 7. Open Questions

1. **Exact `gpt-5` identifier at implementation time** — if OpenAI releases GA under a different model ID string (e.g., `gpt-5-turbo`, `gpt-5-reasoning`), Phase 1 commit 1.A.4's `MODEL_PRICING_USD` entries need that ID. Action: verify at implementation start; adjust table values and UT-1 fixture.
2. **Reasoning-token pricing surface** — `gpt-5` as a reasoning model may emit `reasoning_tokens` separately from `completion_tokens`. `MODEL_PRICING_USD` entry needs `reasoningUsdPer1M`. UT-3 covers this branch; confirm pricing ratio vs. completion rate at implementation start.
3. **`codex-cli/gpt-5.4` as synthesizer** — assumes Codex CLI supports the gpt-5.4 model flag. If not, fallback to the default Codex model and document in journal.
4. **Journal format stability** — one-line prose format may bias future downstream parsing. Not changing in this feature (§9 feature-spec open question #4); revisit if a JSON consumer materializes.
5. **Budget cap during solo-pass** — solo-pass still invokes Codex; global `budgetLimitUsd` continues to apply uniformly. No dueling-specific cap in this feature (per feature-spec §15 open question #3).
6. **Partial divergence-notes on Codex mid-stream crash** — per feature-spec §15 open question #2, policy is "discard, no partial". Implementation in Step 9 of §3 Phase 2 commit 2.B: if `parsePlanCWithDivergenceOutput` throws, nothing is written to disk for plan-c/divergence-notes.
7. **Test-spec open question #1 (plan-b.md absence on solo-pass)** — LLD D-14 locks the decision: `plan-b.md` is NOT written, `duelingPlanState.planB === undefined`, surviving `planA.soloPass === true`. Closes feature-spec + test-spec open question.

---

## 8. References

### Project artifacts

- [Feature spec](../features/sub-features/cross-provider-quorum-convergence.md)
- [HLD](../specs/cross-provider-quorum-convergence.hld.md)
- [Test spec](../testing/sub-features/cross-provider-quorum-convergence.md)
- [Feature-spec log](../sdlc-logs/cross-provider-quorum-convergence/feature-spec.log.md)
- [Test-spec log](../sdlc-logs/cross-provider-quorum-convergence/test-spec.log.md)
- [HLD log](../sdlc-logs/cross-provider-quorum-convergence/hld.log.md)
- [LLD log](../sdlc-logs/cross-provider-quorum-convergence/lld.log.md)

### Code references (line numbers verified during Phase 1 of LLD skill)

- Types & engine union: `packages/helix/src/types.ts` (ModelEngine at 269-273, ExecutorEfficiencyBudget at 281-298, HelixConfig at 1210-1233, sessionDir at 1216)
- Model router: `packages/helix/src/models/model-router.ts` (constructor map at 48-67, `executeSpec` at 202-227, `registerExecutor` at 245-248)
- Claude SDK executor (reference pattern): `packages/helix/src/models/claude-sdk-executor.ts` (dynamic-import-per-call at line 124)
- Oracle constellation: `packages/helix/src/oracles/oracle-constellation.ts` (defaultOracles at 355-412, Architecture at 370-383)
- Pipeline engine: `packages/helix/src/pipeline/pipeline-engine.ts` (executeStage dispatch tower at 1800-1868, handleBlockingStageResult at 511-515, `this.config.sessionDir` usage at 424-425)
- Special-stage executor: `packages/helix/src/pipeline/special-stage-executor.ts` (SpecialStageExecutorDeps at 42-49, constructor at 52, executeVerificationBootstrap pattern at 113-166, executeOracleAnalysis pattern at 168-200+)
- Session manager: `packages/helix/src/session/session-manager.ts` (persist at 96, addJournalEntry at 206, appendToJournalFile private at 233, sessionPath private at 310-312)
- Holistic-audit template: `packages/helix/src/pipeline/templates/holistic-audit.ts` (PLAN_GENERATION_TIMEOUT_MS at 19, template const at 123)
- CLI entry: `packages/helix/src/cli.ts` (buildHelixConfig at ~1268-1321, sessionDir usage at 431, 521, 1452)
- Runtime config: `packages/helix/src/runtime-config.ts` (defaults only); env-driven overrides for `HELIX_*` live in `packages/helix/src/workspace-context.ts` (lines 9-55)
- Stage-output: `packages/helix/src/pipeline/stage-output-schema.ts` (schemaById static record at 428-437), `stage-output-parsers.ts` (call-site-selected parsers)

### HELIX domain rules

- `packages/helix/HELIX.md` — vision, architecture table, future work
- `packages/helix/CLAUDE.md` — operational rules, change-checklist
- `packages/helix/agents.md` — learning journal
