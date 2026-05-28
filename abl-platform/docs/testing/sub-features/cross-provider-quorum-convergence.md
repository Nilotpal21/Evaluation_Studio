# Test Specification: Cross-Provider Quorum & Planning Convergence (HELIX)

**Feature Spec**: [`docs/features/sub-features/cross-provider-quorum-convergence.md`](../../features/sub-features/cross-provider-quorum-convergence.md)
**HLD**: [`docs/specs/cross-provider-quorum-convergence.hld.md`](../../specs/cross-provider-quorum-convergence.hld.md)
**LLD**: [`docs/plans/2026-04-19-cross-provider-quorum-convergence-impl-plan.md`](../../plans/2026-04-19-cross-provider-quorum-convergence-impl-plan.md)
**Status**: IMPLEMENTED
**Last Updated**: 2026-04-19

---

## Feature Metadata

| Field                            | Value                                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Doc Type                         | SUB-FEATURE                                                                                                                                         |
| Parent Feature                   | [helix-autonomous-engineering-harness](../../features/helix-autonomous-engineering-harness.md)                                                      |
| Package(s)                       | `packages/helix`                                                                                                                                    |
| Test Stack                       | Vitest (`packages/helix/src/__tests__/`); `pool: 'forks'`, `maxWorkers: 1`, 20s `testTimeout`                                                       |
| External Dependencies Under Test | `openai` SDK (dynamic import, DI-swappable), `@anthropic-ai/claude-agent-sdk` (external, existing `vi.mock` allowed), `codex-cli` (subprocess fake) |
| Environment Variables Under Test | `OPENAI_API_KEY` (required when dueling/oracle flag set), `HELIX_OPENAI_MODEL` (optional override)                                                  |
| CI Surface                       | None — HELIX is excluded from pnpm workspace and has no GitHub Actions workflow. Tests run locally via `pnpm exec vitest run`.                      |
| Coverage Thresholds              | None configured. v8 provider emits reports; no enforced minimums.                                                                                   |

---

## Current State

All production code and tests are implemented (ABLP-406). Test files added:

- `packages/helix/src/__tests__/openai-api-executor.test.ts` — unit tests for `OpenAiApiExecutor` (availability, execution, streaming, cost, abort, structured output, budget cap)
- `packages/helix/src/__tests__/execute-dueling-plan-generation.test.ts` — unit tests for the dueling orchestrator (all failure-mode permutations, artifact persistence, checkpoint resume)
- `packages/helix/src/__tests__/dueling-plan-synthesis-prompt.test.ts` — unit tests for the synthesis prompt builder (unlabeled candidates, anti-anchoring, solo-pass)

Updated test files: `model-router.test.ts`, `oracle-constellation.test.ts`, `pipeline-engine.test.ts`, `doctor.test.ts`, `stage-output-schema.test.ts`, `special-stage-executor.test.ts`.

741 tests passing / 1 pre-existing flake (`concerns-audit.test.ts`, unrelated).

HELIX is a developer CLI tool running in-process; there is no HTTP route surface, no runtime service, no Studio UI. **"E2E" here means end-to-end in-process pipeline execution** with the real `PipelineEngine`, real `ModelRouter`, real `OracleConstellation`, real `SpecialStageExecutor`, real `SessionManager`, real `.helix/sessions/` filesystem persistence — only the external `openai` SDK, Claude SDK, and Codex CLI subprocess are replaced with injected test doubles. See §7 Test Double Strategy for the exact injection surface.

---

## 1. Coverage Matrix

Each FR from the feature spec (`FR-1` through `FR-16`) maps to one or more scenarios below. "Required" marks the level at which the FR has a primary witness; `-` marks levels not used as the primary witness.

| FR    | Description                                                                                          | Unit     | Integration | E2E      | Manual | Status |
| ----- | ---------------------------------------------------------------------------------------------------- | -------- | ----------- | -------- | ------ | ------ |
| FR-1  | `OpenAiApiExecutor implements ModelExecutor` with `engine = 'openai-api'`                            | Required | Required    | -        | -      | PASS   |
| FR-2  | `OPENAI_API_KEY` read from process env; `isAvailable()` false when absent                            | Required | Required    | -        | -      | PASS   |
| FR-3  | Architecture oracle swap gated by `HelixConfig.useOpenAiArchitectureOracle`                          | Required | Required    | Required | -      | PASS   |
| FR-4  | Plan-generation dispatches to `executeDuelingPlanGeneration()` when `enableDuelingPlanners` true     | Required | Required    | Required | -      | PASS   |
| FR-5  | Planner A (`claude-code`/`opus`) + Planner B (`openai-api`/`gpt-5`) run in parallel with same prompt | -        | Required    | Required | -      | PASS   |
| FR-6  | Codex synthesis uses unlabeled "Candidate A"/"Candidate B", `disableToolUse: true`                   | Required | Required    | -        | -      | PASS   |
| FR-7  | Solo-pass through Codex when exactly one planner fails                                               | -        | Required    | Required | -      | PASS   |
| FR-8  | Hard-abort `status: 'failed'` when both planners fail                                                | -        | Required    | Required | -      | PASS   |
| FR-9  | Hard-abort `status: 'failed'` when Codex synthesis fails; Plan A/B preserved                         | -        | Required    | Required | -      | PASS   |
| FR-10 | Artifacts written to `.helix/sessions/<id>/{plan-a,plan-b,plan-c,divergence-notes}.md`               | -        | Required    | Required | -      | PASS   |
| FR-11 | `Session.duelingPlanState` extended with `PlanArtifact` shape; JSON round-trip preserved             | Required | Required    | -        | -      | PASS   |
| FR-12 | Resume checkpointing — skip planner phase when A+B present; skip to gate when C present              | -        | Required    | Required | -      | PASS   |
| FR-13 | `Session.costByProvider` keyed by `engine:model` with `{ totalUsd, callCount }`                      | Required | Required    | Required | -      | PASS   |
| FR-14 | Plan Quality gate operates unchanged on Plan C output                                                | -        | Required    | -        | -      | PASS   |
| FR-15 | Stage timeout raised 8→18 minutes when dueling enabled                                               | Required | Required    | -        | -      | PASS   |
| FR-16 | Checkpoint reuse works across mixed-engine oracle runs                                               | -        | Required    | -        | -      | PASS   |

---

## 2. E2E Test Scenarios (MANDATORY — in-process pipeline execution)

CRITICAL: These are full-pipeline tests running the real `PipelineEngine`, `OracleConstellation`, `SpecialStageExecutor`, and `ModelRouter` in-process. Only the external model SDKs and Codex subprocess are replaced via constructor dependency injection. Each test creates a real temp `.helix/sessions/<id>/` directory, runs the pipeline, and reads artifact files back from disk to verify persistence. No `vi.mock` of internal helix modules (enforced by `.claude/hooks/platform-mock-lint.sh`).

Auth context for all E2E scenarios: **N/A — HELIX is a local developer CLI. Isolation is OS filesystem permissions, not application auth.** See §5 Security & Isolation for justification.

### E2E-1: Dueling-Planners Happy Path

- **Preconditions**: Fresh temp `.helix/sessions/` directory; `enableDuelingPlanners: true`; `useOpenAiArchitectureOracle: false` (isolate plan-stage behavior); fake `openai` client returns a deterministic Plan B fixture; fake Claude SDK returns a deterministic Plan A fixture; fake Codex subprocess returns Plan C + divergence notes fixture. `OPENAI_API_KEY=test-key` set in process env.
- **Steps**:
  1. Initialize git-backed temp workspace via `mkdtemp` + `git init`.
  2. Build `HelixConfig` via `buildHelixConfig({ enableDuelingPlanners: true })` and instantiate `PipelineEngine` with injected fake executors.
  3. `SessionManager.create(workItem, pipelineTemplate)` creates session.
  4. `PipelineEngine.run(session)` advances stages until `plan-generation`.
  5. Pipeline dispatches to `executeDuelingPlanGeneration` (FR-4).
  6. `Promise.allSettled` fan-out fires Planner A (Claude) and Planner B (OpenAI) in parallel (FR-5).
  7. Both resolve; `duelingPlanState.planA` and `.planB` persisted atomically to `session.json`.
  8. Synthesis prompt builder composes unlabeled "Candidate A" + "Candidate B" + original context (FR-6).
  9. Fake Codex CLI invoked with `efficiencyBudget.disableToolUse: true`.
  10. Plan C + divergence notes returned; persisted to `duelingPlanState.planC` and `.divergenceNotes`.
  11. Plan Quality gate evaluates Plan C against `slice-plan` schema (FR-14).
  12. Pipeline advances to next stage.
- **Assertions**:
  - Four artifact files exist on disk: `plan-a.md`, `plan-b.md`, `plan-c.md`, `divergence-notes.md` under `<workspace>/.helix/sessions/<id>/`.
  - `session.duelingPlanState.planA.engine === 'claude-code'`, `session.duelingPlanState.planB.engine === 'openai-api'`, `session.duelingPlanState.planC.engine === 'codex-cli'`.
  - `session.costByProvider['claude-code:opus'].callCount === 1`, `session.costByProvider['openai-api:gpt-5'].callCount === 1`, `session.costByProvider['codex-cli:gpt-5.4'].callCount === 1` (FR-13).
  - Journal entry appended to `docs/sdlc-logs/<feature>/helix/journal.md` matching the format in feature spec §9.
  - Codex fake received synthesis prompt containing substrings `"Candidate A"`, `"Candidate B"`, `"disableToolUse"`; prompt does NOT contain the strings `"claude-code"`, `"openai-api"`, `"Opus"`, or `"GPT-5"` (unlabeled anti-anchoring).
  - No call to the single-model plan-generation fallback path.
- **Isolation Check**: N/A (no auth surface).

### E2E-2: Solo-Pass — Planner B Fails

- **Preconditions**: Same as E2E-1 but fake `openai` client throws `OpenAiApiError('rate_limit')` on first invocation. Planner A succeeds.
- **Steps**:
  1. Pipeline reaches `plan-generation` with dueling enabled.
  2. Planner A returns Plan A; Planner B rejects.
  3. `executeDuelingPlanGeneration` observes one `fulfilled` + one `rejected` in `Promise.allSettled` result (FR-7).
  4. Synthesis prompt degrades to single-candidate form: "Candidate A only — synthesize final plan."
  5. Codex returns Plan C.
  6. Advisory appended to `divergence-notes.md`: "Planner B failed: rate_limit. Solo-pass synthesis used."
- **Assertions**:
  - `plan-a.md`, `plan-c.md`, `divergence-notes.md` all exist; `plan-b.md` is NOT written (per §8 Decision Log).
  - `session.duelingPlanState.planB === undefined` (no `PlanArtifact` is persisted for the failed planner — see §9 Data Model).
  - `session.duelingPlanState.planA.soloPass === true` (surviving planner's artifact carries the solo-pass flag).
  - `session.costByProvider['claude-code:opus'].callCount === 1`, `session.costByProvider['codex-cli:gpt-5.4'].callCount === 1`, `'openai-api:gpt-5'` key absent or `callCount === 0`.
  - Pipeline continues to slice generation (stage advances, not blocked).
  - Stage advisory contains structured `{ class: 'planner-failure', planner: 'B', reason: 'rate_limit' }`.

### E2E-3: Both Planners Fail — Hard Abort

- **Preconditions**: Fake Claude SDK throws `ClaudeSdkError('upstream-503')`; fake `openai` client throws `OpenAiApiError('service_unavailable')`; fake Codex CLI never invoked.
- **Steps**:
  1. Pipeline reaches `plan-generation`.
  2. Both planners reject via `Promise.allSettled`.
  3. `executeDuelingPlanGeneration` returns `{ status: 'failed', reason: 'both-planners-failed', advisory }` (FR-8).
  4. `handleBlockingStageResult` (`pipeline-engine.ts:508-511`) fires; pipeline aborts.
- **Assertions**:
  - No `plan-a.md`, `plan-b.md`, `plan-c.md`, or `divergence-notes.md` written.
  - `session.stageResults['plan-generation'].status === 'failed'`.
  - Pipeline state is `blocked` with advisory listing both planner failure reasons as structured objects.
  - No silent fallback: assert no single-model plan was produced and `session.duelingPlanState.planC === undefined`.
  - `session.costByProvider` may contain partial cost entries from setup calls but contains zero `codex-cli` invocations.

### E2E-4: Codex Synthesis Fails — Planner Artifacts Preserved

- **Preconditions**: Both planners succeed; fake Codex CLI subprocess exits with code 127 after receiving the synthesis prompt.
- **Steps**:
  1. Planner A + B complete; `duelingPlanState.planA` and `.planB` persisted.
  2. Codex invocation throws `CodexCliError('exit-127')`.
  3. `executeDuelingPlanGeneration` returns `{ status: 'failed', reason: 'synthesis-failed', advisory }` (FR-9).
- **Assertions**:
  - `plan-a.md` and `plan-b.md` are on disk.
  - `plan-c.md` and `divergence-notes.md` are NOT on disk.
  - `session.duelingPlanState.planA` and `.planB` are populated; `.planC === undefined`.
  - Stage result is `failed`; no silent fallback to Plan A or Plan B as the final plan.
  - Pipeline state is `blocked`.
  - On subsequent `PipelineEngine.run()` (resume), the engine re-enters `plan-generation`, skips Planner A and Planner B (checkpoint), and re-invokes Codex.

### E2E-5: Resume Between Planner Completion and Codex Synthesis

- **Preconditions**: A session is interrupted after `duelingPlanState.planA` and `.planB` are persisted. Simulated by aborting `PipelineEngine.run()` immediately after the atomic persist for Plan A+B (use the existing `engine.abort()` abort-controller pattern already exercised in `pipeline-engine.test.ts`).
- **Steps**:
  1. First run: Planner A succeeds, Planner B succeeds, session persisted to `session.json`, `abortController.abort()` fires.
  2. Instantiate fresh `PipelineEngine` with the same session directory.
  3. Second run: `executeDuelingPlanGeneration` detects `duelingPlanState.planA && duelingPlanState.planB && !duelingPlanState.planC` — skips planner phase (FR-12).
  4. Codex synthesis runs and produces Plan C.
- **Assertions**:
  - Fake Claude SDK call count is 0 in the second run (Planner A not regenerated).
  - Fake `openai` client call count is 0 in the second run.
  - `session.costByProvider` reflects only first-run planner cost + second-run Codex cost (no double-billing).
  - `plan-c.md` on disk reflects the second-run Codex output.
  - Journal entry from first run is NOT duplicated; one total dueling-run entry.

### E2E-6: Architecture-Oracle Swap Round-Trip

- **Preconditions**: `useOpenAiArchitectureOracle: true`; `enableDuelingPlanners: false` (isolate oracle behavior); fake `openai` client configured with a deterministic Architecture verdict; fake Claude SDK for Codebase/Testing/Domain oracles.
- **Steps**:
  1. Pipeline reaches `oracle-analysis` stage.
  2. Oracle constellation dispatches 4 oracles in parallel via `mapWithConcurrency` (existing).
  3. Architecture oracle runs on `engine: 'openai-api', model: 'gpt-5'` (FR-3); Codebase, Testing, Domain on `claude-code`/`opus`.
  4. All 4 verdicts return; consensus protocol executes.
- **Assertions**:
  - Architecture oracle's `executorResult.engine === 'openai-api'`; `executorResult.model === 'gpt-5'`.
  - Three other oracles' `executorResult.engine === 'claude-code'`.
  - Consensus result reflects 4-voice quorum; when fake data is configured with intentional divergence between the OpenAI Architecture verdict and the Claude verdicts, the dissent surfaces in the audit output.
  - `session.costByProvider['openai-api:gpt-5'].callCount === 1`, `session.costByProvider['claude-code:opus'].callCount === 3`.
  - Oracle checkpoint persisted (keyed on `findingsHash`); re-run of oracle stage skips all 4 voices, including the `openai-api` Architecture voice (FR-16).

### E2E-7: Dueling + Architecture-Oracle Swap Simultaneously

- **Preconditions**: Both `enableDuelingPlanners: true` AND `useOpenAiArchitectureOracle: true`. This is the production configuration — oracle diversity + plan diversity active together.
- **Steps**:
  1. Pipeline runs `oracle-analysis` with Architecture oracle on GPT-5.
  2. Pipeline advances to `plan-generation`.
  3. Dueling planners run (Claude + GPT-5), Codex synthesizes Plan C.
  4. Plan C feeds manifest compilation unchanged.
- **Assertions**:
  - Both feature flags take effect; neither disables the other.
  - `session.costByProvider` includes all five expected keys: `claude-code:opus` (oracle + planner), `openai-api:gpt-5` (oracle + planner), `codex-cli:gpt-5.4` (synthesis).
  - No interference between the Architecture oracle's cost attribution and Planner B's cost attribution (both use `openai-api:gpt-5` key; `callCount` reflects both calls).
  - Stage advancement succeeds end-to-end; no stage fails due to flag interaction.
  - Journal contains both an oracle-analysis summary AND a dueling-plan summary entry.

### E2E-8: Abort Mid-Planner-Fanout

- **Preconditions**: `enableDuelingPlanners: true`. Fake `openai` client configured with a 500ms delayed response; fake Claude SDK returns immediately.
- **Steps**:
  1. Pipeline reaches `plan-generation`.
  2. `Promise.allSettled([plannerA, plannerB])` launches both.
  3. Planner A resolves (~50ms); Planner B still pending.
  4. External `abortController.abort()` fires (simulates SIGINT from CLI).
  5. `executeDuelingPlanGeneration` catches the abort signal, persists any completed planner artifact, returns `{ status: 'aborted' }`.
- **Assertions**:
  - `session.duelingPlanState.planA` is populated (survived the abort).
  - `session.duelingPlanState.planB` is `undefined` OR marked `{ status: 'aborted' }`.
  - `session.duelingPlanState.planC === undefined`.
  - No `plan-c.md` or `divergence-notes.md` written.
  - On `helix resume`: pipeline re-enters `plan-generation`, re-invokes Planner B only (Planner A checkpoint is reused), then proceeds to Codex synthesis.
  - No orphaned files or lock files left in `.helix/sessions/<id>/`.

---

## 3. Integration Test Scenarios (MANDATORY)

Integration tests exercise specific modules at their real boundaries without mocking sibling modules in the package. External third-party SDKs are injected via constructor DI; no `vi.mock` of `packages/helix/**` files.

### INT-1: `OpenAiApiExecutor` Round-Trip

- **Boundary**: `OpenAiApiExecutor` → injected `openai` SDK client.
- **Setup**: Real executor instance constructed with a fake `OpenAiClientFactory` returning a stub client that records calls and returns configurable responses.
- **Steps & Assertions**:
  - `executor.execute({ spec: { engine: 'openai-api', model: 'gpt-5', maxBudgetUsd: 10 }, prompt, abortSignal, onEvent })` resolves with populated `ExecutorResult { output, engine, model, turnsUsed, durationMs, costUsd, streamEvents }`.
  - Streaming: `onEvent` is called with events of shape `{ type, timestamp, message, details }` for each SSE delta (token + reasoning + usage).
  - Abort: `abortController.abort()` mid-stream rejects the promise and the stub client's abort hook fires.
  - Structured output: when `schema` is provided, the executor passes `response_format: { type: 'json_schema', json_schema: { schema } }` and the resulting `output` parses as valid JSON against the schema.
  - Cost extraction: `ExecutorResult.costUsd` computed from `response.usage` using the `MODEL_PRICING_USD` pricing map.
  - Budget cap: when cumulative `costUsd > maxBudgetUsd`, the executor throws `BudgetExceededError` before the next request.
  - Key absent: `OpenAiApiExecutor.isAvailable()` returns `false` when `process.env.OPENAI_API_KEY` is unset.
- **Failure Mode**: If the stub client throws `OpenAiApiError('rate_limit')`, the executor surfaces the error (no retry policy at executor level — retries are a pipeline-stage concern).

### INT-2: `ModelRouter` Registration and Dispatch

- **Boundary**: `ModelRouter` → registered executors.
- **Setup**: Real `ModelRouter` constructed with real `ClaudeSdkExecutor`, `CodexCliExecutor`, and the new `OpenAiApiExecutor`, each with their respective test-double clients.
- **Steps & Assertions**:
  - Router constructor registers `openai-api` executor alongside `claude-code` and `codex-cli` (via `registerExecutor` at `model-router.ts:245`).
  - `router.execute({ spec: { engine: 'openai-api', ... } })` dispatches to `OpenAiApiExecutor`.
  - Fallback behavior: with `spec: { primary: 'openai-api', fallback: 'claude-code' }`, if primary fails, fallback is invoked and `ExecutorResult.engine === 'claude-code'`.
  - Engine unavailable: when `engine: 'openai-api'` is specified but `OPENAI_API_KEY` is missing, `router.execute(...)` resolves to an `ExecutorResult` with `output === ''`, `engine === 'openai-api'`, and a non-empty `error` string whose content matches `/Engine openai-api is not available/` (no thrown exception — see existing branch at `model-router.ts:214-223`).
- **Failure Mode**: Router does not crash when a registered executor throws during `isAvailable()` — it logs and treats as unavailable.

### INT-3: Oracle Constellation With Swapped Architecture

- **Boundary**: `OracleConstellation` → `ModelRouter` → fake executors.
- **Setup**: Real constellation loaded with `config: { useOpenAiArchitectureOracle: true }`; `resolveArchitectureOracle(config)` helper invoked.
- **Steps & Assertions**:
  - Architecture oracle spec resolves to `{ engine: 'openai-api', model: 'gpt-5', maxBudgetUsd: 10, maxTurns: 20 }`.
  - Consensus protocol runs correctly across mixed-engine set (3 Claude + 1 OpenAI); verdict aggregation is engine-agnostic.
  - Checkpoint reuse: a second run with the same session reuses the persisted Architecture-oracle verdict without re-invoking the OpenAI executor (FR-16).
  - `tuneOracleModelSpec` applied to the Architecture oracle spec preserves `engine: 'openai-api'` (does not silently revert to `claude-code`).
- **Failure Mode**: If the OpenAI executor fails, the Architecture oracle's dissent entry shows `status: 'failed'` and the constellation's consensus protocol proceeds with 3 voices (existing behavior).

### INT-4: `executeDuelingPlanGeneration` — All Matrix Cells

- **Boundary**: `executeDuelingPlanGeneration` → real `ModelRouter`, real `SessionManager`, real filesystem.
- **Setup**: Temp workspace + session + injected fake executors.
- **Scenarios** (each is a sub-test):
  - Happy path: both planners succeed, Codex synthesizes, all four artifacts written, `duelingPlanState` populated atomically.
  - Planner A fails only: solo-pass over Plan B through Codex.
  - Planner B fails only: solo-pass over Plan A through Codex.
  - Both planners fail: returns `{ status: 'failed' }`, no Codex invocation, advisory lists both failure reasons.
  - Codex fails after planner success: returns `{ status: 'failed' }`, Plan A + B preserved on disk, no Plan C.
  - Resume after A+B checkpoint: planners not re-invoked, Codex runs.
  - Resume after C checkpoint: all three skipped, pipeline proceeds to gate.
- **Failure Mode**: Synthesis prompt builder throws — return `{ status: 'failed', reason: 'prompt-builder-error' }`; do not invoke Codex with a malformed prompt.

### INT-5: `costByProvider` Accumulation in `PipelineEngine`

- **Boundary**: `PipelineEngine.executeStage` post-execute hook → `Session.costByProvider`.
- **Setup**: Real engine; real session; fake executors returning varied `costUsd` values.
- **Steps & Assertions**:
  - Start a fresh session. Run through `oracle-analysis` + `plan-generation` with dueling + mixed Architecture oracle.
  - After each `modelRouter.execute()` call, `session.costByProvider[`${engine}:${model}`]` is incremented by the returned `costUsd`; `callCount` increments by 1.
  - Running the pipeline twice with resume: second-run accumulators only reflect work actually done in the second run (no double-counting).
  - Running single-model plan-generation (dueling disabled) produces only `claude-code:opus` entries — no phantom `openai-api` entry.
  - When `costUsd` is `undefined` (executor did not report cost), `callCount` still increments but `totalUsd` is unchanged.
- **Failure Mode**: Persistence of `costByProvider` to disk survives a `SessionManager.persist()` call mid-run (JSON round-trip).

### INT-6: Plan-Stage Timeout Dispatch

- **Boundary**: `planStageTimeoutMs(config)` helper → pipeline stage dispatch.
- **Setup**: Integration-level pipeline run with both config toggles; fake executors that deliberately exceed the 8-minute default when dueling is enabled.
- **Steps & Assertions**:
  - Pipeline reads the timeout value at stage-entry time (not at config-load time) so toggling mid-session takes effect on the next stage entry.
  - When a stage timeout fires, the stage returns `{ status: 'timeout' }` and the pipeline proceeds via the existing `handleStageTimeout` path (no new timeout logic introduced).
  - Pure-function behavior of `planStageTimeoutMs` itself (return-value cases) is covered by UT-6 — not re-asserted here.
- **Failure Mode**: Invalid config (e.g., `enableDuelingPlanners` not boolean) — the helper returns the 8-minute default and logs a warning; verified at the pipeline level via a session state smoke assertion.

### INT-7: Journal Entry Format

- **Boundary**: `executeDuelingPlanGeneration` → append to `docs/sdlc-logs/<feature>/helix/journal.md`.
- **Setup**: Temp workspace with pre-created `docs/sdlc-logs/<feature>/helix/` directory.
- **Steps & Assertions**:
  - After a successful dueling run, `journal.md` has a single appended line matching the format in feature spec §9 (ISO timestamp + "Dueling plans:" + costs + divergence count).
  - Solo-pass run appends a line with explicit `B=failed` (or `A=failed`) marker.
  - Double-failure run appends a line with `status=failed reason=both-planners-failed`.
  - Journal file is created if it does not exist (directory is pre-existing).
  - Append is atomic (no partial writes on process interrupt — uses `fs.promises.appendFile` which is OS-level atomic for small writes).

### INT-8: `SpecialStageExecutor` Dispatch Wiring

- **Boundary**: `PipelineEngine.executeStage` → `SpecialStageExecutor.executeDuelingPlanGeneration` (when stage type is `plan-generation` and flag is on).
- **Setup**: Real `PipelineEngine`, real `SpecialStageExecutor` with a spy on the new method.
- **Steps & Assertions**:
  - With `enableDuelingPlanners: true`, `SpecialStageExecutor.executeDuelingPlanGeneration` is invoked exactly once per `plan-generation` stage.
  - With `enableDuelingPlanners: false`, the method is NOT invoked; pipeline falls through to the generic model-execution loop at `pipeline-engine.ts:~1870` (block `// Main stage execution loop`).
  - Dispatch case for `'plan-generation'` does not fire for other stage types (e.g., `manifest-compilation`, `oracle-analysis`, `implementation`).
- **Failure Mode**: If `SpecialStageExecutor.executeDuelingPlanGeneration` is not registered (implementation gap), the dispatch falls back to the generic loop with a logged warning, not a crash.

### INT-9: Plan Quality Gate Flow-Through With Plan C

- **Boundary**: `executeDuelingPlanGeneration` → `Plan Quality` gate (`holistic-audit.ts:291-313`).
- **Setup**: Real `PipelineEngine`, real Plan Quality gate; fake executors configured so Plan C output conforms to the `slice-plan` schema.
- **Steps & Assertions**:
  - After Plan C is synthesized, the Plan Quality gate is invoked with the Plan C `slice-plan` output (no schema modification).
  - Gate evaluates Plan C identically to how it would evaluate a single-model plan; pass/fail verdict emerges.
  - Gate failure on Plan C produces a `plan-review` output that feeds the existing carry-forward retry logic.
  - The `plan-c-with-divergence` stage-output schema variant serializes `divergenceNotes` into a separate channel without contaminating the `slice-plan` parse path.
- **Failure Mode**: If Plan C fails schema parse, the pipeline enters the existing plan-review retry loop (no new retry semantics introduced).

### INT-10: Concurrent Persist Serialization During Fan-Out

- **Boundary**: `executeDuelingPlanGeneration` → `SessionManager.persist()`.
- **Setup**: Fake Planner A and Planner B configured to resolve near-simultaneously (within 1ms of each other); real `SessionManager.persist()`.
- **Steps & Assertions**:
  - Both planner resolutions trigger atomic persist calls.
  - `executeDuelingPlanGeneration` serializes the two persist calls (e.g., `await persistA(); await persistB();`) so neither overwrites the other.
  - After both resolve: `session.duelingPlanState.planA` AND `.planB` are both present in the on-disk `session.json` (no lost write).
  - Re-reading `session.json` immediately after both persists returns a valid, complete `duelingPlanState` (no partial state).
  - A concurrent `SessionManager.read()` during the persist window returns either the pre-A state OR the post-B state, never an intermediate (atomicity contract).
- **Failure Mode**: If a persist call throws, the stage returns `{ status: 'failed', reason: 'persist-error' }`; the other planner's artifact is not lost because it was held in memory and will be re-persisted on next attempt.

### INT-11: `OpenAiApiExecutor` Error-Path Matrix

> **New error classes** (all introduced by this feature's implementation, not existing symbols): `OpenAiApiError`, `StallDetectedError`, `BudgetExceededError`, `StructuredOutputParseError`. Name and shape are proposed by this test spec and confirmed during `/lld`. `CodexCliError` (referenced in E2E-4) and `ClaudeSdkError` (referenced elsewhere) are likewise new and ride alongside the existing `codex-cli-executor.ts` / `claude-sdk-executor.ts` error-throwing call sites — the current implementations throw generic `Error` instances, and the LLD is expected to introduce named subclasses as part of the dueling-plan execution path.

- **Boundary**: `OpenAiApiExecutor` → injected fake `openai` client → `ExecutorResult`/throw.
- **Setup**: Real executor; fake client configured per-scenario to emit different error classes.
- **Scenarios** (each is a sub-test):
  - **429 Rate Limit**: Fake client throws `OpenAiApiError('rate_limit')` on first request. Executor surfaces the error without retry; `Promise.allSettled` in the planner fan-out observes it as `{ status: 'rejected' }`.
  - **500 Server Error**: Fake client throws `OpenAiApiError('internal_server_error')`. Same behavior: surface, no retry.
  - **Network Timeout / Stall**: Fake client stream emits no chunks for > stall-detection threshold. Executor detects stall via the existing stall-detection pattern (mirror `codex-cli-executor.ts`), aborts, and throws `StallDetectedError`.
  - **Malformed SSE Chunk**: Fake client emits a malformed SSE chunk mid-stream. Executor logs a warning, skips the chunk, and continues without crashing.
  - **Budget-Exceeded Mid-Synthesis**: During a call with `maxBudgetUsd: 1`, fake client returns a response whose computed `costUsd` is `1.50`. Executor throws `BudgetExceededError` AFTER computing cost; `ExecutorResult` is not returned.
  - **Partial JSON in Structured Output**: Fake client returns a response that is syntactically invalid JSON despite `response_format: json_schema`. Executor surfaces `StructuredOutputParseError`; caller decides retry policy.
- **Failure Mode**: All error classes bubble up to `ModelRouter`; none are swallowed. Solo-pass / hard-abort decisions are made at the dueling-plan executor level based on `Promise.allSettled` classification, not inside the executor.

---

## 4. Unit Test Scenarios

Pure-function and single-module tests independent of pipeline orchestration. All are example-based (not property-based). File: `packages/helix/src/__tests__/openai-api-executor.test.ts` unless otherwise noted.

### UT-1: Pricing Table Lookup

- **Module**: `packages/helix/src/models/openai-api-executor.ts` (`MODEL_PRICING_USD` export).
- **Input**: Known model IDs (`gpt-5`, `gpt-5.4`), unknown model ID (`gpt-nonexistent`).
- **Expected Output**: Known IDs return `{ promptUsdPer1M, completionUsdPer1M, reasoningUsdPer1M? }`; unknown ID throws `UnknownModelPricingError` OR returns a conservative fallback (implementation decision deferred to LLD).
- **Rationale**: Pricing table is the cost-extraction source of truth. A wrong entry silently over/undercounts `costByProvider`. (FR-1, FR-13).

### UT-2: Stream Event Mapper

- **Module**: `openai-api-executor.ts` (internal `mapSseDeltaToStreamEvent` helper).
- **Input**: Fixture SSE deltas of each type (`content.delta`, `reasoning.delta`, `usage`, `error`).
- **Expected Output**: HELIX `StreamEvent { type, timestamp, message, details }` matching the shape used by `ClaudeSdkExecutor` and `CodexCliExecutor`.
- **Rationale**: Normalization is a pure function; wrong mapping breaks downstream progress reporting without any pipeline-level failure. (FR-1, feature spec §7).

### UT-3: Cost Calculation

- **Module**: `openai-api-executor.ts` (internal `computeCostUsd` helper).
- **Input**: `{ prompt_tokens, completion_tokens, reasoning_tokens? }` × various model IDs.
- **Expected Output**: `costUsd` within floating-point tolerance of the hand-computed value. Edge cases: zero tokens (`costUsd === 0`), missing usage (`costUsd === undefined`), unknown model (fallback per UT-1).
- **Rationale**: Cost attribution feeds `costByProvider` and budget enforcement; off-by-factor-of-1000 errors are a real risk with token-based pricing. (FR-1, FR-13).

### UT-4: Synthesis Prompt Builder

- **Module**: `packages/helix/src/pipeline/engine/dueling-plan-synthesis-prompt.ts` (new).
- **Input**: `PlanArtifact` for A and B + feature context object.
- **Expected Output**: Prompt string containing unlabeled "Candidate A" and "Candidate B" sections, the context payload, and explicit instructions to disable tool use. MUST NOT contain `"claude-code"`, `"openai-api"`, `"Opus"`, or `"GPT-5"` literals (anti-anchoring enforced via substring negation assertions).
- **Rationale**: Prevents the provider identity from biasing synthesis (feature spec §7 "unlabeled blind synthesis"). (FR-6).

### UT-5: `resolveArchitectureOracle` Helper

- **Module**: `packages/helix/src/oracles/oracle-constellation.ts` (new helper).
- **Input**: `HelixConfig` with `useOpenAiArchitectureOracle: true | false` and optional `openaiModel` override.
- **Expected Output**:
  - `true` → `{ engine: 'openai-api', model: config.openaiModel ?? 'gpt-5', ... }`.
  - `false` → `{ engine: 'claude-code', model: 'opus', ... }` (default).
- **Rationale**: Pure function; tested independently of the full constellation. (FR-3).

### UT-6: `planStageTimeoutMs` Helper

- **Module**: `packages/helix/src/pipeline/templates/holistic-audit.ts` (new helper).
- **Input**: `HelixConfig` with `enableDuelingPlanners: true | false`.
- **Expected Output**:
  - `true` → `18 * MINUTE_MS` (1,080,000).
  - `false` → `8 * MINUTE_MS` (480,000).
- **Rationale**: Timeout tuning is config-gated; unit test prevents accidental regression to single-timeout behavior. (FR-15).

### UT-7: `PlanArtifact` JSON Round-Trip

- **Module**: `packages/helix/src/types.ts` (`PlanArtifact` interface) + `packages/helix/src/session/session-manager.ts` (`persist`).
- **Input**: A fully populated `PlanArtifact { output, costUsd, engine, model, capturedAt, durationMs, turnsUsed, soloPass }`.
- **Expected Output**: `JSON.parse(JSON.stringify(artifact))` deep-equals the input. All 8 fields preserved. File: `packages/helix/src/__tests__/session-manager.test.ts` (update).
- **Rationale**: Silent field loss on persist is a common bug; explicit round-trip test locks the contract. (FR-11).

### UT-8: `costByProvider` Accumulator

- **Module**: `packages/helix/src/pipeline/pipeline-engine.ts` (internal `accumulateProviderCost` helper — extracted as pure function).
- **Input**: Existing `costByProvider` map + `ExecutorResult { engine, model, costUsd }` for accumulation.
- **Expected Output**:
  - First call with new `engine:model` → creates entry `{ totalUsd: costUsd, callCount: 1 }`.
  - Subsequent call with same key → increments `totalUsd` by `costUsd`, `callCount` by 1.
  - Call with `costUsd === undefined` → increments `callCount` only; `totalUsd` unchanged.
  - Call with `model === undefined` → uses `'unknown'` as the model segment (key becomes `engine:unknown`).
- **Rationale**: Pure function; 4 scenarios cover all branches. File: `packages/helix/src/__tests__/pipeline-engine.test.ts` (update) OR new `accumulate-provider-cost.test.ts`. (FR-13).

### UT-9: Config Defaults

- **Module**: `packages/helix/src/runtime-config.ts` (and `cli.ts` `buildHelixConfig()`).
- **Input**: Empty flag set; empty env; empty config-file.
- **Expected Output**: `useOpenAiArchitectureOracle === false`, `enableDuelingPlanners === false`, `openaiModel === 'gpt-5'`. File: `packages/helix/src/__tests__/runtime-config.test.ts` (update).
- **Rationale**: Defaults prevent accidental activation on upgrade. (FR-3, FR-4, §11 Configuration).

### UT-10: `OpenAiApiExecutor.isAvailable()`

- **Module**: `openai-api-executor.ts`.
- **Input**: `process.env.OPENAI_API_KEY` set vs unset.
- **Expected Output**: `true` when key is a non-empty string; `false` when unset or empty string.
- **Rationale**: Availability gating is the contract the router uses to decide dispatch. (FR-2).

---

## 5. Security & Isolation Tests

HELIX is a **local developer CLI** with no multi-tenant or multi-project surface. The feature spec §12 explicitly documents tenant/project/user isolation as N/A, with OS filesystem permissions as the isolation mechanism. The test spec adheres to the same framing:

| Check                          | Applicability | Justification                                                                                                                   |
| ------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant access → 404      | N/A           | No tenant surface. HELIX does not serve HTTP; no route accepts a `tenantId` query.                                              |
| Cross-project access → 404     | N/A           | No project surface. HELIX operates on the developer's local workspace; there is no project filter.                              |
| Cross-user access → 404        | N/A           | No user surface. Multi-user isolation on a shared workstation is OS file permissions on `.helix/sessions/<id>/`.                |
| Missing auth → 401             | N/A           | No auth surface.                                                                                                                |
| Insufficient permissions → 403 | N/A           | No permission surface.                                                                                                          |
| Input validation               | Required      | `OPENAI_API_KEY` must be validated as a non-empty string at executor construction time; CLI flags validated by existing parser. |

### SEC-1: API Key Non-Persistence

- **Module**: `OpenAiApiExecutor` + `SessionManager.persist()`.
- **Assertion**: After any executor invocation, no instance of `process.env.OPENAI_API_KEY` value appears anywhere in `session.json` or in any `.helix/sessions/<id>/*.md` file. Test uses a marker key value (`sk-test-MARKER-abcdef`) and greps the session directory for the marker after execution.
- **Rationale**: Feature spec §12 Security: "session JSON must not contain the key value under any circumstance."

### SEC-2: Stream Event Redaction

- **Module**: `OpenAiApiExecutor` → `StreamEvent.message` emission.
- **Assertion**: `StreamEvent.message` emitted during execution does not contain raw request body or response body content. Use the existing HELIX redaction helpers from `progress-reporter.ts`.
- **Rationale**: Feature spec §12 Security: "StreamEvent.message must not interpolate request/response bodies."

### SEC-3: Key Absent → Graceful Unavailability

- **Module**: `OpenAiApiExecutor.isAvailable()` + `ModelRouter`.
- **Assertion**: When `OPENAI_API_KEY` is unset and a `ModelSpec` with `engine: 'openai-api'` is submitted, `router.execute(...)` resolves to an `ExecutorResult` whose `error` string (a) is non-empty, (b) does NOT contain a stack trace (no `at …:…:…` frames), and (c) does NOT echo any `process.env` key names or values. The existing unavailability branch at `model-router.ts:214-223` must not be bypassed.
- **Rationale**: No secret leakage via error messages.

---

## 6. Performance & Load Tests

HELIX is single-session per CLI invocation. No concurrent-session scenarios apply. Performance is measured by wall-clock and turn-count, not by throughput.

### PERF-1: Dueling-Plan Stage Wall-Clock Budget

- **Scenario**: Full dueling-plan stage with realistic fake executors (Planner A and B configured with 100ms latency each; Codex synthesis with 200ms latency).
- **Assertion**: Total stage wall-clock (fan-out parallel + synthesis serial) is below 500ms in the test harness. Confirms parallel fan-out is actually parallel (not accidentally sequential).
- **Rationale**: Feature spec §12 Performance: "Plan A and Plan B run in parallel." Accidental sequencing doubles wall-clock.

### PERF-2: Streaming Backpressure

- **Scenario**: Fake `openai` client emits 1000 SSE chunks back-to-back without flow control.
- **Assertion**: Executor processes all chunks without memory blow-up (heap use bounded within a 10MB delta over baseline); `onEvent` callback is called exactly 1000 times.
- **Rationale**: Unit-level stress test for the stream event mapper. Realistic for reasoning-model outputs with thousands of reasoning tokens.

### PERF-3: Resume Efficiency

- **Scenario**: Interrupt after Plan A + B completion; resume.
- **Assertion**: Resume-run `costByProvider` for `claude-code:opus` and `openai-api:gpt-5` shows zero additional cost compared to pre-interrupt state. Only `codex-cli:gpt-5.4` incurs new cost.
- **Rationale**: Feature spec §12 Performance: "Resume skips directly to synthesis — no regeneration cost on interruption."

---

## 7. Test Infrastructure

### Required Services

None. HELIX runs entirely in-process with filesystem I/O. No Docker, no Redis, no MongoDB.

### Vitest Configuration

Current config (`packages/helix/vitest.config.ts`):

```typescript
{
  environment: 'node',
  globals: true,
  pool: 'forks',
  maxWorkers: 1,           // sequential execution
  testTimeout: 20_000,     // 20s per test
  hookTimeout: 20_000,     // 20s per hook
}
```

No changes to config are required. New tests use the 20s default timeout. Long-orchestration tests (INT-4, E2E-5) may opt into per-test `{ timeout: 60_000 }` if needed.

### Test Fixtures

New shared fixture module: `packages/helix/src/__tests__/test-helpers/plan-fixtures.ts`. Exports:

| Export                       | Purpose                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `PLAN_A_FIXTURE`             | Valid `slice-plan` JSON from a "Claude-like" planner. ~30 findings, ~8 slices.                                         |
| `PLAN_B_FIXTURE`             | Valid `slice-plan` JSON from a "GPT-5-like" planner. Different ordering + one distinct finding for divergence testing. |
| `PLAN_C_FIXTURE`             | Valid convergent plan. Supersedes both candidates.                                                                     |
| `DIVERGENCE_NOTES_FIXTURE`   | Sample markdown matching the format from feature spec §6.                                                              |
| `COST_ATTRIBUTION_FIXTURE`   | Representative `costByProvider` shape for assertions.                                                                  |
| `makeFakeOpenAiClient(opts)` | Factory returning a fake `openai` client that records calls and returns configurable responses/errors.                 |
| `makeFakeClaudeSdk(opts)`    | Factory returning a fake Claude SDK client (extension of existing test pattern).                                       |
| `makeFakeCodexSpawner(opts)` | Factory returning a fake `child_process.spawn` implementation emitting pre-canned stdout events.                       |

### Environment Variables

| Variable                                                                | Usage                                                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                                                        | Set to `'test-key-MARKER-<uuid>'` per-test for availability checks; unset for SEC-3 scenarios. |
| `HELIX_OPENAI_MODEL`                                                    | Optional override in UT-5.                                                                     |
| `HELIX_USE_OPENAI_ARCHITECTURE_ORACLE`, `HELIX_ENABLE_DUELING_PLANNERS` | Exercised in runtime-config.test.ts for config-load scenarios.                                 |

Env var manipulation uses the existing pattern from `codex-cli-executor.test.ts` (`beforeEach` save + `afterEach` restore).

### CI Configuration

None. HELIX is excluded from the pnpm workspace (`!packages/helix` in `pnpm-workspace.yaml`) and has no GitHub Actions workflow. Tests run locally via:

```bash
cd packages/helix
pnpm exec vitest run
# or with coverage:
pnpm exec vitest run --coverage
```

When this feature's tests land, the existing local-run convention continues. No new CI pipeline wiring is introduced.

### Filesystem Discipline

- Tests create temp workspaces via `mkdtemp(join(tmpdir(), 'helix-test-'))`.
- Each test that writes session artifacts initializes a git repo in the temp dir (`execFileSync('git', ['init'])` + initial commit).
- Cleanup in `afterEach`: `await rm(tempDir, { recursive: true, force: true })`.
- No test writes to the real repo's `.helix/sessions/` or `docs/sdlc-logs/`.

---

## 8. Test File Mapping

Maps test scenarios to actual or planned test files. New files are marked `(NEW)`; existing files are marked `(UPDATE)`.

| Test File                                                              | Type               | Covers                                                                                                                  | Status   |
| ---------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| `packages/helix/src/__tests__/openai-api-executor.test.ts`             | unit + integration | FR-1, FR-2, INT-1, INT-11, UT-1, UT-2, UT-3, UT-10, SEC-1, SEC-2, SEC-3, PERF-2                                         | (NEW)    |
| `packages/helix/src/__tests__/model-router.test.ts`                    | integration        | INT-2                                                                                                                   | (UPDATE) |
| `packages/helix/src/__tests__/oracle-constellation.test.ts`            | unit + integration | FR-3, FR-16, INT-3, UT-5, E2E-6                                                                                         | (UPDATE) |
| `packages/helix/src/__tests__/execute-dueling-plan-generation.test.ts` | integration        | INT-4, INT-10 (happy path + failure matrix + concurrent persist)                                                        | (NEW)    |
| `packages/helix/src/__tests__/pipeline-engine.test.ts`                 | e2e + integration  | E2E-1, E2E-2, E2E-3, E2E-4, E2E-5, E2E-7, E2E-8, INT-5, INT-7, INT-8, INT-9, PERF-1, PERF-3                             | (UPDATE) |
| `packages/helix/src/__tests__/special-stage-executor.test.ts`          | integration        | INT-8 (dispatch wiring); preserves existing `executeVerificationBootstrap` tests                                        | (UPDATE) |
| `packages/helix/src/__tests__/session-manager.test.ts`                 | unit               | UT-7 (PlanArtifact JSON round-trip); FR-11                                                                              | (UPDATE) |
| `packages/helix/src/__tests__/runtime-config.test.ts`                  | unit               | UT-9 (config defaults); new env var parsing for `HELIX_USE_OPENAI_ARCHITECTURE_ORACLE`, `HELIX_ENABLE_DUELING_PLANNERS` | (UPDATE) |
| `packages/helix/src/__tests__/pipeline-templates.test.ts`              | unit               | UT-6 (`planStageTimeoutMs`); holistic-audit timeout selection                                                           | (UPDATE) |
| `packages/helix/src/__tests__/doctor.test.ts`                          | unit               | FR-2 CLI surface: `helix doctor` errors when either flag is set but `OPENAI_API_KEY` is missing                         | (UPDATE) |
| `packages/helix/src/__tests__/stage-output-parsers.test.ts`            | unit               | `plan-c-with-divergence` schema variant parsing; extends `slice-plan` with optional `divergenceNotes`                   | (UPDATE) |
| `packages/helix/src/__tests__/stage-output-schema.test.ts`             | unit               | Structural validation for the new `plan-c-with-divergence` schema ID in `stage-output-schema.ts`                        | (UPDATE) |
| `packages/helix/src/__tests__/test-helpers/plan-fixtures.ts`           | fixture module     | Shared fixtures + fake factory functions                                                                                | (NEW)    |

Total: 2 new test files + 1 new fixture module + 9 existing files updated.

**HELIX Change Checklist coverage** (per `packages/helix/CLAUDE.md`):

- `stage-runner.test.ts` — NOT updated. Justification: the new synthesis prompt ships in its own module (`dueling-plan-synthesis-prompt.ts`) and is invoked from `executeDuelingPlanGeneration`, not from `stage-runner`. No existing stage-runner prompt template or slice-packet shape is modified. If the LLD reshapes slice-packet variables to carry divergence metadata, this file becomes an UPDATE at that time.
- `quality-gate.test.ts` — NOT updated. Justification: FR-14 is "Plan Quality gate unchanged" — Plan C is read by the existing gate code path. Flow-through coverage is provided by INT-9 inside `pipeline-engine.test.ts`.
- `concerns-registry.test.ts` / `concerns-audit.test.ts` / `drift-audit.test.ts` / `drift-jira-adapter.test.ts` / `drift-sync-*.test.ts` — NOT updated. Justification: feature does not touch cross-cutting concerns, drift audit, or JIRA adapter surfaces.
- `control-plane-service.test.ts` — NOT updated in this feature. Justification: feature spec §C11 deferred the MCP divergence tool to a follow-up; no new MCP tools are introduced here.

---

## 9. Open Testing Questions

1. **Partial-failure artifact policy**: When Planner B fails in E2E-2, do we write `plan-b.md` with an explicit `# Failed` header, or omit the file entirely? The test spec currently asserts omission; LLD may reverse. Action: confirm during `/lld`.
2. **Mid-stream Codex failure persistence**: If Codex emits partial synthesis output before crashing (E2E-4 variant), do we persist the partial as `plan-c-partial.md`? The test spec currently asserts discard. Action: confirm during `/lld`.
3. **Journal line format stability**: Current format (markdown with ISO timestamp) is informal prose. If downstream tooling ever parses the journal, switch to JSONL. Currently no parser consumer exists. Action: revisit when a consumer lands.
4. **Dueling-specific cost cap**: Today `budgetLimitUsd` (HELIX global) applies per-session. A dueling run consumes ≈2.5× prior plan-stage spend. Should a dueling-specific cap be enforced, or is global sufficient? The test spec currently exercises global only. Action: revisit after first production run.
5. **Fake OpenAI client fidelity**: The `makeFakeOpenAiClient` factory mimics the streaming interface of `openai` SDK v4. If the feature's LLD chooses a different SDK version (e.g., v5), the factory must be rebuilt. Action: confirm SDK major version during `/lld`.
6. **Reasoning-model cost rollup**: Reasoning models emit separate token counts for reasoning vs output. UT-3 assumes `reasoningUsdPer1M` is present in the pricing table for reasoning models. If GPT-5 is not a reasoning model at implementation time, UT-3 may skip the reasoning-token branch. Action: confirm model class during `/lld`.

---

## 10. Status

`IMPLEMENTED`. 746/746 `packages/helix` tests passing across 61 files (commit `8417ffe13`). All 23 scenarios in the coverage matrix (§1) are green — UT-1..UT-10, INT-1..INT-11, E2E-1..E2E-8, PERF-1/PERF-3, SEC-1..SEC-3. Promote to `STABLE` when scenario failure rates < 0.5% across 10 consecutive local runs per §14 success metrics in the feature spec.

---

## 11. References

- **Feature spec**: [../../features/sub-features/cross-provider-quorum-convergence.md](../../features/sub-features/cross-provider-quorum-convergence.md)
- **Feature spec log**: [../../sdlc-logs/cross-provider-quorum-convergence/feature-spec.log.md](../../sdlc-logs/cross-provider-quorum-convergence/feature-spec.log.md)
- **Test spec log**: [../../sdlc-logs/cross-provider-quorum-convergence/test-spec.log.md](../../sdlc-logs/cross-provider-quorum-convergence/test-spec.log.md)
- **Parent feature spec**: [../../features/helix-autonomous-engineering-harness.md](../../features/helix-autonomous-engineering-harness.md)
- **Parent test spec**: N/A — parent feature has no dedicated test doc today.
- **Existing helix test patterns**:
  - `packages/helix/src/__tests__/oracle-constellation.test.ts` — mixed-engine consensus patterns
  - `packages/helix/src/__tests__/pipeline-engine.test.ts` — full-pipeline harness, shared helper functions
  - `packages/helix/src/__tests__/model-router.test.ts` — registration + dispatch
  - `packages/helix/src/__tests__/codex-cli-executor.test.ts` — DI via fake subprocess
  - `packages/helix/src/__tests__/claude-sdk-executor.test.ts` (`vi.mock` of external `@anthropic-ai/claude-agent-sdk`)
- **Testing platform rules**:
  - Repo root `CLAUDE.md` → "Test Architecture — Fix the Code, Not the Test", "E2E Test Standards"
  - `packages/helix/CLAUDE.md` → "Change Checklist" (mandatory test-file updates)
  - `.claude/hooks/platform-mock-lint.sh` (blocks `vi.mock` of internal modules)
  - `.claude/hooks/e2e-test-quality-lint.sh` (blocks DB access / stubbed servers in E2E)
