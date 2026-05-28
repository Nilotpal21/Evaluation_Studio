# LLD: Arch Generation Full-Compile Recovery, Runtime Eval Optimization, And Controlled Fallback

**Feature Spec**: Not yet created. This plan is a companion to `docs/plans/2026-05-16-arch-platform-agent-generation-runtime-gap-closure.lld.md` and is grounded in the `agents-dev.kore.ai` generation failure observed on 2026-05-18.
**HLD**: Not yet created.
**Test Spec**: Extend `docs/testing/arch-platform-agent-generation-runtime-gap-closure.md`.
**Status**: DRAFT
**Date**: 2026-05-18
**Trigger Incident**: Arch BUILD repeatedly failed to complete VoltMart-style multi-agent generation after scaffold construct validation fell back to legacy generation. The recovery loop kept patching compiler syntax errors instead of repairing the broader runtime construct plan, and the user had no intervention path.

---

## 1. Problem Summary

The current BUILD experience has three coupled failure modes:

1. **Recovery scope is too narrow.** A scaffold construct-plan failure can fall back to legacy free-form generation. Once in that path, the compile-fix loop sees only compiler errors such as `WITH: must be nested under CALL`, so it patches local syntax instead of stepping back to repair the runtime plan, tool branches, or generation strategy.
2. **Failure state is opaque and non-interactive.** The UI shows agents spinning or retrying, but the user cannot pause, accept compiled agents, edit a failed draft, retry only a failed agent, or create an incremental project and continue from there.
3. **Compile success is necessary but not sufficient.** A generated project can compile and still fail the user journey it was built for: wrong entry agent, weak handoff path, missing tool action, poor answer quality, or unrealistic source grounding.
4. **All-or-nothing project creation wastes value.** A BUILD may have 3 of 4 agents compiled, realistic files in session metadata, and useful diagnostics, but the user cannot enter a real project workspace and continue incrementally.

The target is not to fail faster. The best outcome is still a fully compilable project. But project creation should not be held hostage by a long Arch repair loop. Once Arch has enough useful structure to persist, it should create a real, visible Arch-generated project with a clear lifecycle badge. Inside that project, Arch can continue compile repair, runtime eval optimization, source-grounded validation, and user-guided fixes as normal project development steps. Product evals and Runtime execution remain project-scoped, so the same real project `projectId` hosts generated eval scenarios, runtime transcripts, traces, and optimization evidence. The target is a future-ready generation control plane that keeps trying with broader, better-informed repair strategies when that is likely to produce compilable and behaviorally valid agents, while also making every loop bounded, visible, interruptible, and promotable by the user.

## 2. Desired User Experience

The default happy path remains: **all agents compile and the project is created as active**.

When BUILD encounters failures before that outcome:

- The user sees which agents are `compiled`, `warning`, `repairing`, `failed`, or `needs input`.
- The user sees the failure class, not only the compiler line.
- The system first tries to reach full compilation through escalating repair strategies:
  - deterministic construct repair,
  - compile repair,
  - broader structural repair,
  - stronger/better-suited repair model when configured,
  - targeted per-agent retry without regenerating successful agents.
- Once Arch has enough useful structure, it creates a visible Arch-generated project with a lifecycle badge such as `Building`, `Needs Repair`, `Validating`, or `Validation Skipped`.
- Inside the project, the user can see and continue Arch steps:
  - compile/repair remaining agents,
  - review generated drafts and diagnostics,
  - run product-native validation,
  - inspect eval transcripts and optimization suggestions,
  - promote the project when they decide it is ready.
- Once all required runtime agents compile or compile with accepted warnings, Arch can run a product-native validation pass:
  - create eval personas, scenarios, evaluators, and an eval set under the real project,
  - execute the eval set through Runtime using the existing eval run workflow,
  - read the stored eval transcript, trace events, tool calls, trajectory scores, and judge results,
  - target optimization at the specific agent/tool/routing gaps shown by the transcript.
- The system stops only after bounded, explainable attempts that are no longer making progress.
- Compiled agents remain saved.
- Failed agents remain editable as drafts with diagnostics.
- The user can choose:
  - `Retry failed agent`
  - `Retry with broader repair`
  - `Try stronger repair model`
  - `Edit draft`
  - `Create project and continue`
  - `Cancel build`
  - `Restart build`
- Incremental Arch-generated projects are available to all users, visibly marked with their readiness state, and protected by publish/deploy gates until blocking issues are fixed or the user explicitly promotes.

### 2.1 Detailed UX Flow

#### 2.1.1 Happy Path: Build Completes Cleanly

1. User accepts the blueprint and starts BUILD.
2. The BUILD panel shows each generated agent as a row with:
   - agent name,
   - role label,
   - current stage,
   - elapsed time,
   - attempt count,
   - status icon,
   - warning count when applicable.
3. Completed agents move from `Building` to `Compiled` without changing row height or shifting layout.
4. When all required agents compile, Arch creates the project as `Active`.
5. The user lands in the project with:
   - a success banner,
   - generated agents visible in the project agent list,
   - generated tools/profiles available in their normal project surfaces,
   - an optional `Validate and optimize` action if runtime eval is configured but not required.

#### 2.1.2 Repairing Path: Arch Keeps Working But User Is Not Trapped

1. When an agent hits a repairable failure, its row changes to `Repairing` with a short cause such as `Repairing branch target` or `Fixing flow syntax`.
2. The row shows the current recovery step, for example `Attempt 2 of 4`, and a compact `View details` action.
3. `View details` opens a diagnostic drawer with:
   - failure class,
   - affected file/line when available,
   - normalized compiler or construct issue,
   - last action attempted,
   - next planned action,
   - safe user actions.
4. If the same failure repeats, the UI changes copy from `Fixing` to `Escalating repair`, so the user can tell the system is not spinning on the same narrow loop.
5. Once Arch has enough useful generated structure, the BUILD panel exposes `Create project and continue`.
6. Selecting `Create project and continue` creates a real project, navigates the user into it, and leaves Arch repair steps running or resumable inside the project.

#### 2.1.3 Incremental Project Path

1. The project appears in normal project lists with a lifecycle badge, never as a hidden clone.
2. The project detail header includes an Arch-generated status band with:
   - lifecycle badge,
   - current Arch step,
   - last update timestamp,
   - unresolved repair count,
   - validation state,
   - primary next action.
3. The project contains an `Arch Progress` panel that shows:
   - `Compile and repair`,
   - `Review drafts`,
   - `Validate and optimize`,
   - `Promotion readiness`.
4. Each step has a deterministic status: `Not started`, `Running`, `Needs attention`, `Passed`, `Skipped`, or `Promoted with warnings`.
5. Failed or incomplete agents appear in the agent list as disabled or draft entries with `Needs Repair`; compiled siblings stay enabled unless a cross-agent contract defect is detected.
6. Opening a failed draft shows the generated ABL content, diagnostics, and actions to save edits, retry that agent, retry with broader context, or exclude from readiness.

#### 2.1.4 Validate And Optimize Path

1. The `Validate and optimize` panel runs inside the real project because evals require project scope.
2. Before the run starts, the panel shows the generated eval assets:
   - personas,
   - scenarios,
   - evaluators,
   - eval set name,
   - expected agent path or milestones.
3. During the run, the panel shows:
   - eval run id,
   - current scenario,
   - completed/total count,
   - runtime errors,
   - score progress,
   - stop button.
4. After the run, the panel shows a case table with:
   - scenario name,
   - expected path,
   - actual agent path,
   - tool sequence,
   - score/pass state,
   - failure reason,
   - suggested repair target.
5. Opening a case shows transcript, trace events, tool calls, evaluator evidence, and the exact agent/tool/routing gap Arch intends to repair.
6. Applying an optimization updates only impacted agents and records a before/after diff when agent content changes.

#### 2.1.5 Promotion Path

1. The project always has a visible `Promote` action.
2. If all readiness gates pass, promotion changes the lifecycle badge to `Active` and archives the active Arch repair step.
3. If gates are unresolved, `Promote` opens a confirmation dialog listing:
   - failed or disabled agents,
   - skipped validation,
   - runtime eval failures,
   - unresolved repair checklist items,
   - publish/deploy implications.
4. User-confirmed promotion with unresolved gates records `promotedByUserOverride`, keeps a visible warning state, and writes an audit event.
5. `Validation Skipped` remains visible until validation later passes or the project owner explicitly clears it through a validated rerun.

#### 2.1.6 Resume, Refresh, And Multi-Tab Behavior

1. Browser refresh restores the same BUILD/project state from durable session and project metadata.
2. Reconnecting to an in-flight build does not create duplicate projects; project creation is idempotent by build run and source session.
3. If the user opens the project in another tab, both tabs show the same lifecycle badge and active Arch step after polling/SSE reconnect.
4. If a background repair completes while the user is viewing the project, the affected agent row and Arch Progress panel update without replacing user-edited draft text.
5. If Arch needs user input, the project badge becomes `Needs Repair` and the Arch Progress panel highlights the exact question or decision required.

### 2.2 Screen-Level UX Requirements

| Surface                        | Required UX                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUILD progress card            | Per-agent rows, stage labels, attempt counts, elapsed time, warning/error chips, no layout shift, and clear `Create project and continue` action. |
| Diagnostic drawer              | Failure class, issue source, affected file/line, raw excerpt when safe, attempted repairs, next repair, and safe user actions.                    |
| Project list                   | Visible Arch lifecycle badge and secondary text such as `Generated by Arch - repair running`.                                                     |
| Project header                 | Status band with lifecycle, active Arch step, unresolved repair count, validation status, and primary next action.                                |
| Agent list                     | Compiled agents enabled; failed drafts visible but disabled for runtime until repaired or explicitly promoted with warnings.                      |
| Draft editor                   | Editable failed draft content, diagnostics beside the code, save/retry controls, and protection against stream overwrites while editing.          |
| Arch Progress panel            | Stepper for compile repair, draft review, validation, optimization, and promotion readiness.                                                      |
| Validate and optimize panel    | Eval asset preview, run progress, transcript/case drill-down, score evidence, optimization targets, stop/skip/promote controls.                   |
| Promotion dialog               | Gate summary, user override confirmation, audit note, and clear publish/deploy implications.                                                      |
| Project health/readiness panel | Repair checklist, validation state, skipped/failed gates, and links back to diagnostics/eval evidence.                                            |

### 2.3 Lifecycle Badges And User-Facing Meaning

| Badge                | Meaning                                                                 | Primary Action                         | Runtime/Publish Behavior                                                         |
| -------------------- | ----------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| `Building`           | Arch is still creating or repairing generated project artifacts.        | View Arch progress / create project    | Runtime limited to compiled enabled agents; publish blocked by default.          |
| `Needs Repair`       | One or more blocking agents, tools, or validation gates need attention. | Retry, edit draft, validate, promote   | Publish/deploy blocked unless policy allows explicit warning override.           |
| `Validating`         | Product eval execution or optimization is running.                      | View run / stop / inspect cases        | Project remains editable; publish waits unless user promotes with warnings.      |
| `Validation Skipped` | User skipped runtime eval validation or promoted before validation.     | Run validation / keep promoted warning | Badge remains until validation passes or policy-cleared audit action occurs.     |
| `Active`             | Compile and configured readiness gates passed, or user promoted.        | Continue normal project development    | Normal runtime/publish behavior, plus warning if promoted with unresolved gates. |

### 2.4 UX Copy And Controls

- Prefer action copy that tells the user what happens next: `Create project and continue`, `Retry this agent`, `Retry with broader context`, `Run validation`, `Promote with warnings`.
- Avoid spinner-only states. Every long-running state must show the active stage and either an attempt count or current eval scenario.
- Do not show raw provider/model internals in user-facing banners. Keep raw detail in diagnostic drawers, audit logs, or downloadable operator diagnostics.
- Use `Needs attention` when Arch requires a user decision; use `Failed` only for terminal system failures.
- Keep compiled siblings visibly locked during targeted repair so the user understands successful work is not being regenerated.
- Promotion with unresolved gates must use a confirmation dialog, not a silent one-click status flip.

### 2.5 UX Acceptance Criteria

- [ ] User can enter a generated project before all repair/eval loops complete.
- [ ] Project list and project header make generated project readiness visible without opening logs.
- [ ] User can distinguish `repairing`, `needs attention`, `validating`, `skipped`, and `active` states.
- [ ] No BUILD state is represented by an indefinite spinner without stage, attempt, or scenario context.
- [ ] Failed drafts are reviewable and editable without losing generated diagnostics.
- [ ] Product eval evidence is visible as transcripts, traces, tool calls, scores, and suggested repair targets.
- [ ] User can promote at any point, and unresolved gates remain visible and audited after promotion.
- [ ] Refresh/resume does not duplicate projects, erase drafts, or hide active Arch steps.

## 3. Design Decisions

| #    | Decision                                                                                                                | Rationale                                                                                                                                             | Alternatives Rejected                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| D-1  | Keep scaffold generation as the preferred path, but add structural repair before any legacy fallback.                   | The scaffold path is more deterministic and source-grounded; construct-plan failures should repair structure, not abandon structure.                  | Blind fallback to legacy generator on construct validation error.                                         |
| D-2  | Introduce a typed BUILD failure taxonomy.                                                                               | The recovery path for construct-plan errors, parser errors, semantic warnings, model timeouts, and persistence failures must differ.                  | Treating every failure as `compile_fix`.                                                                  |
| D-3  | Optimize for fully compilable agents, but do not block project access on long repair loops.                             | Users want a finished project, but projects are developed incrementally and should become useful before every Arch step finishes.                     | Holding the user in BUILD until every compile/eval/repair loop completes.                                 |
| D-4  | Bound recovery attempts per failure class and per agent, but escalate repair breadth before terminal failure.           | Infinite repeated loops create a bad experience, but a few broader, materially different loops are valuable.                                          | Unbounded retries; one global retry counter; stopping before broader repair.                              |
| D-5  | Persist partial artifacts as first-class session state.                                                                 | The system already writes files and statuses into `metadata.files` and `metadata.buildProgress`; this should become an explicit recoverable contract. | Keeping useful output only in transient SSE events.                                                       |
| D-6  | Make incremental Arch-generated project creation generally available with visible lifecycle badges and readiness gates. | Users should not lose value or stay trapped in Arch; incomplete projects can be useful as long as readiness, publish, and deploy states are explicit. | Tenant-limited partial project creation; hidden validation projects; all-or-nothing project creation.     |
| D-7  | Use the real Arch-generated project as the project-scoped validation and optimization container.                        | Product evals and Runtime agent execution require `projectId`; the same visible project should host eval assets, transcripts, repairs, and promotion. | Fake project ids, projectless evals, in-process Runtime shortcuts, or hidden validation clones.           |
| D-8  | Use the product eval system as Arch's runtime validation loop.                                                          | Existing eval models, routes, and `EvalRunWorkflow` already know how to run generated agents through Runtime and persist transcripts/scores.          | Building a parallel Arch-only eval harness; treating evals as nightly CI only; using only failure replay. |
| D-9  | Separate fast compile recovery from heavier runtime eval optimization.                                                  | Compile repair should keep running, but product eval execution starts only when the real project has enough compiled runtime surface to execute.      | Blocking every syntax repair on full eval execution.                                                      |
| D-10 | Make user intervention explicit in the UI and API.                                                                      | The user needs a safe way to stop the loop and steer repair without copying logs manually.                                                            | Relying on browser refresh, hidden cancel flags, or post-hoc log export only.                             |
| D-11 | Keep customer-facing errors sanitized, but expose operator-grade diagnostics in Arch.                                   | Build diagnostics are operator-facing and need actionable detail; generated customer runtime copy must remain sanitized.                              | Hiding all details or leaking raw provider internals to end users.                                        |

## 4. Key Interfaces And Types

### 4.1 BUILD Failure Taxonomy

```ts
export type ArchBuildFailureClass =
  | 'scaffold_construct'
  | 'scaffold_slot_validation'
  | 'parser'
  | 'compiler'
  | 'semantic_diagnostics'
  | 'model_timeout'
  | 'model_contract'
  | 'persistence'
  | 'canceled'
  | 'unknown';

export type ArchBuildRecoveryAction =
  | 'repair_construct_plan'
  | 'retry_scaffold'
  | 'retry_legacy'
  | 'retry_with_broader_context'
  | 'retry_with_stronger_model'
  | 'retry_single_agent'
  | 'request_user_input'
  | 'mark_failed_draft'
  | 'create_incremental_project'
  | 'abort';

export interface ArchBuildDiagnostic {
  id: string;
  agentName: string;
  failureClass: ArchBuildFailureClass;
  stage: string;
  severity: 'info' | 'warning' | 'error' | 'blocking';
  message: string;
  operatorHint: string;
  source?: 'scaffold' | 'construct_plan' | 'parser' | 'compiler' | 'diagnostics' | 'model';
  code?: string;
  path?: string;
  line?: number;
  rawExcerpt?: string;
  recoveryActions: ArchBuildRecoveryAction[];
  attempt: number;
  maxAttempts: number;
  retryable: boolean;
}
```

### 4.2 Agent Build Lifecycle

```ts
export type ArchAgentBuildStatus =
  | 'queued'
  | 'scaffolding'
  | 'filling'
  | 'construct_validating'
  | 'construct_repairing'
  | 'compiling'
  | 'compile_repairing'
  | 'compiled'
  | 'warning'
  | 'failed_draft'
  | 'needs_user_input'
  | 'canceled';

export interface ArchAgentBuildArtifact {
  agentName: string;
  status: ArchAgentBuildStatus;
  content?: string;
  lastValidContent?: string;
  diagnostics: ArchBuildDiagnostic[];
  warnings: string[];
  errors: string[];
  attempts: {
    scaffold: number;
    constructRepair: number;
    compileRepair: number;
    modelRetry: number;
  };
  canRetry: boolean;
  canRetryWithBroaderRepair: boolean;
  canRetryWithStrongerModel: boolean;
  canEdit: boolean;
  canIncludeInIncrementalProject: boolean;
}
```

### 4.3 Arch-Generated Project State

```ts
export type ArchProjectCreationMode =
  | 'complete'
  | 'incremental_arch_project'
  | 'partial_needs_repair';

export type ArchGeneratedProjectLifecycle =
  | 'building'
  | 'validating'
  | 'active'
  | 'needs_repair'
  | 'discarded';

export type ArchGeneratedProjectBadge =
  | 'building'
  | 'needs_repair'
  | 'validating'
  | 'validation_skipped'
  | 'active';

export interface ArchGeneratedProjectManifest {
  lifecycle: ArchGeneratedProjectLifecycle;
  buildRunId: string;
  sourceSessionId: string;
  projectId: string;
  createdAt: string;
  createdBy: string;
  promotedAt?: string;
  promotedBy?: string;
  promotedByUserOverride?: boolean;
  evalSetId?: string;
  evalRunId?: string;
  activeArchStep?:
    | 'compile_repair'
    | 'runtime_eval'
    | 'optimization'
    | 'manual_repair'
    | 'complete';
  optimizationRound: number;
  badge: ArchGeneratedProjectBadge;
  promotionState: 'not_ready' | 'ready' | 'promoted' | 'promoted_with_warnings';
}

export interface ArchProjectRepairManifest {
  creationMode: ArchProjectCreationMode;
  buildRunId: string;
  sourceSessionId: string;
  includedAgents: string[];
  failedAgents: string[];
  blockedCapabilities: string[];
  repairChecklist: Array<{
    agentName: string;
    diagnosticIds: string[];
    requiredBeforePublish: boolean;
  }>;
}
```

### 4.4 Runtime Eval Optimization State

This is grounded in existing product eval contracts:

- Mongo models: `EvalPersona`, `EvalScenario`, `EvalEvaluator`, `EvalSet`, and `EvalRun`.
- Studio APIs: `/api/projects/:id/evals/scenarios`, `/evals/personas`, `/evals/evaluators`, `/evals/sets`, `/evals/runs`, `/evals/runs/:runId/start`, and `/evals/runs/:runId/status`.
- Runtime execution: `EvalRunWorkflow` fans out `RunEvalConversation` and `JudgeConversation`; `RunEvalConversation` calls Runtime through `POST /api/internal/chat/agent`.
- Evidence storage: `eval_conversations` stores conversation turns, trace events, tool calls, actual agent path, milestones, errors, and cost; `eval_scores` stores evaluator score, pass/fail, evidence, reasoning, and trajectory components.

```ts
export type ArchRuntimeEvalOptimizationStatus =
  | 'not_requested'
  | 'materializing_eval_assets'
  | 'running'
  | 'reading_results'
  | 'optimizing'
  | 'passed'
  | 'needs_iteration'
  | 'failed'
  | 'canceled';

export interface ArchRuntimeEvalOptimizationState {
  status: ArchRuntimeEvalOptimizationStatus;
  projectId: string;
  evalSetId?: string;
  evalRunId?: string;
  knownSource: 'eval' | 'synthetic';
  generatedByArchSessionId: string;
  thresholds: {
    minAverageScore: number;
    requireNoRuntimeErrors: boolean;
    requireExpectedAgentPath: boolean;
    maxOptimizationRounds: number;
  };
  latestSummary?: {
    totalConversations: number;
    failedConversations: number;
    averageScore: number;
    lowestScore?: number;
    failingCases: number;
  };
  optimizationTargets: Array<{
    agentName: string;
    reason: 'runtime_error' | 'handoff_path' | 'tool_sequence' | 'quality_score' | 'milestone';
    caseId: string;
    transcriptExcerpt: string;
    traceEventTypes: string[];
    suggestedRepair: ArchBuildRecoveryAction;
  }>;
}
```

## 5. Module Boundaries

| Module                           | Responsibility                                                                                    | Depends On                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `build-failure-taxonomy`         | Classify scaffold, parser, compiler, diagnostic, timeout, and persistence failures.               | Existing worker errors and compile diagnostics.                                           |
| `construct-repair`               | Repair invalid scaffold construct plans before legacy fallback.                                   | `validateScaffoldConstructPlan`, `deriveScaffoldRuntimePlan`, construct-plan issue codes. |
| `build-lifecycle-service`        | Own bounded retry policy, per-agent status transitions, and partial artifact persistence.         | `runParallelGeneration`, Mongo session metadata.                                          |
| `arch-generated-project-service` | Create, badge, promote, keep-for-repair, or discard incremental Arch-generated projects.          | Existing project creation path, `Project`, `ProjectAgent`, tools, behavior profiles.      |
| `arch-eval-materializer`         | Create product eval personas, scenarios, evaluators, eval set, and eval run for generated agents. | Existing eval models/routes and `apps/studio/src/repos/eval-repo.ts`.                     |
| `arch-eval-runner`               | Trigger and poll product eval execution.                                                          | `EvalRunWorkflow` Restate ingress, eval run start/status route patterns.                  |
| `arch-eval-result-reader`        | Read product eval transcript, trace, score, and trajectory evidence.                              | ClickHouse `eval_conversations`, `eval_scores`, heatmap/cases query patterns.             |
| `arch-eval-optimizer`            | Convert runtime eval evidence into targeted agent repair prompts and retry decisions.             | Build recovery policy, generated ABL files, eval transcripts and scores.                  |
| `incremental-project-service`    | Preserve compatibility for explicit `needs_repair` project creation and readiness gates.          | Existing project creation path in `message-handler.ts`.                                   |
| `build-intervention-api`         | Cancel, retry failed agent, retry broader, create project, promote, and update draft.             | Existing session/cancel route patterns.                                                   |
| `build-progress-ui`              | Show actionable state, diagnostics, and intervention controls.                                    | `arch-ai-store`, SSE event dispatcher, `BuildProgressCard`.                               |
| `build-observability`            | Emit durable audit and timeline events for every recovery decision.                               | Arch audit logs and build log store.                                                      |

## 6. File-Level Change Map

### New Files

| File                                                                          | Purpose                                                                       | LOC Estimate |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------ |
| `apps/studio/src/lib/arch-ai/build/failure-taxonomy.ts`                       | Typed classification of all BUILD failures and recovery actions.              | 180          |
| `apps/studio/src/lib/arch-ai/build/recovery-policy.ts`                        | Bounded retry policy per failure class and agent.                             | 160          |
| `apps/studio/src/lib/arch-ai/build/partial-artifacts.ts`                      | Helpers for persisting and reading per-agent partial build artifacts.         | 220          |
| `apps/studio/src/lib/arch-ai/project/arch-generated-project-service.ts`       | Create/promote/repair/discard project-scoped Arch-generated projects.         | 280          |
| `apps/studio/src/lib/arch-ai/eval/arch-eval-materializer.ts`                  | Create product eval assets from Arch blueprint, topology, and fixtures.       | 260          |
| `apps/studio/src/lib/arch-ai/eval/arch-eval-runner.ts`                        | Start/poll product eval runs through existing Restate eval workflow.          | 180          |
| `apps/studio/src/lib/arch-ai/eval/arch-eval-result-reader.ts`                 | Read eval conversations, traces, tool calls, scores, and trajectory evidence. | 260          |
| `apps/studio/src/lib/arch-ai/eval/arch-eval-optimizer.ts`                     | Map eval evidence into targeted agent repair actions.                         | 260          |
| `apps/studio/src/lib/arch-ai/scaffold/construct-repair.ts`                    | Deterministic repair of scaffold construct-plan failures.                     | 260          |
| `apps/studio/src/app/api/arch-ai/sessions/[id]/build/retry-agent/route.ts`    | Retry one failed agent with chosen strategy.                                  | 140          |
| `apps/studio/src/app/api/arch-ai/sessions/[id]/build/runtime-eval/route.ts`   | Start or resume Arch-created product eval validation for a generated project. | 180          |
| `apps/studio/src/app/api/arch-ai/sessions/[id]/build/create-project/route.ts` | Create an incremental Arch-generated project from compiled/draft artifacts.   | 220          |
| `apps/studio/src/app/api/arch-ai/sessions/[id]/build/update-draft/route.ts`   | Save edited failed draft content back into session metadata.                  | 150          |
| `apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/cases/route.ts`     | Product eval case/transcript drill-down used by Arch optimization and MCP.    | 220          |
| `apps/studio/src/lib/arch-ai/components/arch/chat/BuildRecoveryPanel.tsx`     | UI actions for retry, edit, project creation, cancel, and restart.            | 260          |
| `apps/studio/src/__tests__/arch-ai/arch-eval-materializer.test.ts`            | Unit tests for Arch -> product eval asset creation.                           | 180          |
| `apps/studio/src/__tests__/arch-ai/arch-eval-optimizer.test.ts`               | Unit tests for transcript/score evidence -> repair target mapping.            | 180          |
| `apps/studio/src/__tests__/arch-ai/build-recovery-policy.test.ts`             | Unit tests for failure classification and retry policy.                       | 180          |
| `apps/studio/src/__tests__/arch-ai/scaffold-construct-repair.test.ts`         | Unit tests for construct-plan repair.                                         | 220          |
| `apps/studio/e2e/workflows/arch-build-recovery.spec.ts`                       | Browser-level recovery and incremental project workflow coverage.             | 260          |

### Modified Files

| File                                                                     | Change Description                                                                                     | Risk   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------ |
| `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`                      | Route failures through taxonomy/recovery policy; persist partial artifacts; stop blind fallback loops. | High   |
| `apps/studio/src/lib/arch-ai/scaffold/worker-runner.ts`                  | Return structured scaffold diagnostics and allow construct repair before compile.                      | High   |
| `apps/studio/src/lib/arch-ai/scaffold/runtime-flow.ts`                   | Continue hardening terminal branches, flow target integrity, and available-tools semantics.            | Medium |
| `apps/studio/src/lib/arch-ai/scaffold/construct-plan.ts`                 | Include repair metadata and issue-to-action mapping.                                                   | Medium |
| `apps/studio/src/lib/arch-ai/helpers/compile-and-fix.ts`                 | Stop after bounded class-specific attempts and escalate to broader repair when syntax fix repeats.     | High   |
| `apps/studio/src/lib/arch-ai/message-handler.ts`                         | Support incremental project creation, validation, promotion, repair, and session archive semantics.    | High   |
| `apps/studio/src/lib/arch-ai/build-completion.ts`                        | Represent partial completion and repair checklist in completion widget.                                | Medium |
| `packages/database/src/models/project.model.ts`                          | Add Arch-generated project lifecycle metadata for validation/active/needs-repair states.               | Medium |
| `apps/studio/src/services/project-service.ts`                            | Add Arch-generated project creation/promote helpers while preserving normal project creation.          | Medium |
| `apps/studio/src/repos/project-repo.ts`                                  | Query/update lifecycle metadata with tenant/project scoping.                                           | Medium |
| `apps/studio/src/app/api/projects/route.ts`                              | Show Arch-generated project lifecycle badges in project list and detail routes.                        | Medium |
| `apps/studio/src/repos/eval-repo.ts`                                     | Add internal helpers for Arch-created eval asset upsert, version snapshots, and run creation.          | Medium |
| `apps/studio/src/app/api/projects/[id]/evals/quick/route.ts`             | Reuse extracted eval materialization helpers instead of duplicating quick-eval asset creation logic.   | Medium |
| `apps/studio/src/lib/eval-heatmap-query.ts`                              | Keep aggregate scoring query reusable; add adjacent case-query builder for transcript drill-down.      | Low    |
| `apps/studio/src/lib/arch-ai/store/arch-ai-store.ts`                     | Add statuses, diagnostics, selected failed agent, and recovery action state.                           | Medium |
| `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts`                     | Handle new `build_recovery_*` SSE events.                                                              | Medium |
| `apps/studio/src/lib/arch-ai/components/arch/chat/BuildProgressCard.tsx` | Render failed drafts, blocked/partial counts, and intervention entry points.                           | Medium |
| `apps/studio/src/lib/arch-ai/components/arch/panels/IDEPanel.tsx`        | Make failed draft files editable and saveable during BUILD failure.                                    | Medium |
| `apps/studio/src/app/api/arch-ai/sessions/[id]/cancel/route.ts`          | Extend cancel semantics for background BUILD workers, not only turn-engine tool boundaries.            | Medium |
| `apps/studio/e2e/workflows/agents.md`                                    | Document new recovery test IDs and workflow coverage.                                                  | Low    |

## 7. Implementation Phases

Each phase must be independently deployable and must not make generation worse if later phases are delayed.

### Phase 1: Failure Taxonomy And Durable Diagnostics

**Goal**: Every BUILD failure has a class, retryability, operator hint, and user-visible action set.

**Tasks**:

1.1. Add `ArchBuildFailureClass`, `ArchBuildDiagnostic`, and `ArchBuildRecoveryAction`.
1.2. Classify known messages:

- `FLOW_THEN_UNKNOWN_STEP` -> `scaffold_construct`
- `WITH: must be nested under CALL` -> `compiler`
- repeated same compiler line after repair -> `model_contract`
- `CompileWorkerTimeoutError` -> `model_timeout` or compiler timeout subtype
- Mongo update failures -> `persistence`

  1.3. Emit `build_recovery_diagnostic` SSE events from `runParallelGeneration`.
  1.4. Persist diagnostics under `metadata.buildProgress.diagnosticsByAgent`.
  1.5. Add log export fields so downloaded logs include failure class and recovery action.

**Files Touched**:

- `apps/studio/src/lib/arch-ai/build/failure-taxonomy.ts`
- `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`
- `apps/studio/src/lib/arch-ai/store/arch-ai-store.ts`
- `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts`

**Exit Criteria**:

- [ ] A scaffold construct failure produces `failureClass=scaffold_construct`.
- [ ] Repeated compiler-fix failure produces `failureClass=model_contract` after the configured threshold.
- [ ] Build log export includes diagnostic id, failure class, retryability, and operator hint.
- [ ] Unit tests cover every failure class.

**Test Strategy**:

- Unit: taxonomy mapping and retryability.
- Integration: synthetic worker failures persist diagnostics to session metadata.

**Rollback**: Diagnostics can remain write-only; old UI ignores unknown SSE event types.

---

### Phase 2: Construct Repair Before Legacy Fallback

**Goal**: Repair scaffold construct-plan issues deterministically before using legacy generation.

**Tasks**:

2.1. Add `repairScaffoldConstructPlan` for known issue codes.
2.2. Repair `FLOW_THEN_UNKNOWN_STEP` by normalizing unreachable branch targets to an existing terminal step or `COMPLETE`.
2.3. Repair missing available-tools semantics for reasoning-dispatch flow by ensuring construct plan and assembled YAML agree.
2.4. For impossible repairs, return a structured `scaffold_construct` diagnostic and mark the agent `failed_draft`.
2.5. Remove blind `throw -> legacy generator` behavior for construct-plan errors.
2.6. Keep legacy fallback only for explicitly classified model/scaffold infrastructure failures, not deterministic construct errors.

**Files Touched**:

- `apps/studio/src/lib/arch-ai/scaffold/construct-repair.ts`
- `apps/studio/src/lib/arch-ai/scaffold/worker-runner.ts`
- `apps/studio/src/lib/arch-ai/scaffold/runtime-flow.ts`
- `apps/studio/src/lib/arch-ai/scaffold/construct-plan.ts`
- `apps/studio/src/__tests__/arch-ai/scaffold-construct-repair.test.ts`

**Exit Criteria**:

- [ ] The observed failure path no longer falls to legacy generation for `FLOW_THEN_UNKNOWN_STEP`.
- [ ] Construct repair either returns a valid construct plan or a failed draft diagnostic.
- [ ] No generated YAML reaches compile-fix if construct validation has blocking errors.
- [ ] Regression test uses the VoltMart pattern: `PolicyAdvisor`, `FulfillmentSpecialist`, `HumanEscalationDesk`.

**Test Strategy**:

- Unit: construct repair for unknown final step, unknown next tool step, missing terminal step.
- Integration: `runScaffoldWorker` returns `compileStatus !== error` after deterministic repair, or `failed_draft` without legacy fallback.

**Rollback**: Feature flag `ARCH_AI_BUILD_CONSTRUCT_REPAIR=false` can restore prior fallback behavior temporarily.

---

### Phase 3: Progressive Recovery Policy

**Goal**: Replace narrow repeated loops with class-specific budgets that escalate toward full compilation before terminal failure.

**Tasks**:

3.1. Define default budgets and escalation ladders:

| Failure Class              | Full-Compile Recovery Ladder                                                                  | Terminal Escalation                               |
| -------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `scaffold_construct`       | deterministic construct repair -> broader scaffold retry -> stronger repair model             | failed draft only after all repair forms fail     |
| `scaffold_slot_validation` | existing slot retries -> slot-specific broader prompt -> fallback slot if safe                | failed draft if fallback would break contract     |
| `parser`                   | compile-fix -> broader syntax repair with full YAML context -> stronger repair model          | failed draft                                      |
| `compiler`                 | compile-fix -> same-signature detection -> broader structural repair -> stronger repair model | failed draft                                      |
| `semantic_diagnostics`     | semantic repair -> stronger repair model if blocking                                          | warning if non-blocking; failed draft if blocking |
| `model_timeout`            | retry same model once -> stronger/faster configured repair model                              | failed draft                                      |
| `model_contract`           | broader repair prompt with explicit contract -> stronger model                                | failed draft / ask user                           |
| `persistence`              | DB retry with idempotency -> fresh session reconcile                                          | blocking failure                                  |

3.2. Add loop signature detection: same failure class + same normalized message + same line/path.
3.3. If the same compiler error repeats, stop local compile-fix and escalate to broader repair.
3.4. Persist attempt counters in `metadata.buildProgress.agentArtifacts`.
3.5. Emit `build_agent_failed_draft` instead of repeatedly restarting the same agent.
3.6. Keep successful agents locked by default during targeted retries so full project completion does not regress already compiled output.
3.7. Expose `Create project and continue` once Arch has enough useful structure to persist, while keeping full-compile recovery running or resumable inside the project.

**Files Touched**:

- `apps/studio/src/lib/arch-ai/build/recovery-policy.ts`
- `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`
- `apps/studio/src/lib/arch-ai/helpers/compile-and-fix.ts`
- `apps/studio/src/lib/arch-ai/build-worker-tools.ts`

**Exit Criteria**:

- [ ] No agent can loop indefinitely on the same failure signature.
- [ ] Before failed-draft terminal state, the worker has attempted at least one broader repair path when the failure is structurally repairable.
- [ ] Successful agents are not regenerated during targeted failed-agent retry unless the user asks for full rebuild.
- [ ] User sees a terminal failed-draft state only after configured full-compile recovery is exhausted.
- [ ] Retry counts are visible in build logs and persisted state.
- [ ] Existing successful builds still complete without user prompts.

**Test Strategy**:

- Unit: recovery policy budgets and repeated signature detection.
- Integration: compile-fix mock returning same error twice transitions to `failed_draft`.

**Rollback**: Set budgets high while keeping diagnostics if initial rollout is too strict.

---

### Phase 4: Partial Artifact Persistence

**Goal**: Preserve compiled, warning, and failed draft agents as durable session artifacts.

**Tasks**:

4.1. Add `ArchAgentBuildArtifact` metadata shape.
4.2. Persist:

- `content` for every generated draft.
- `lastValidContent` when compile succeeds before later enrichment/repair fails.
- diagnostics and attempt counters.
- inclusion eligibility for incremental project creation.

  4.3. Reconcile worker result, fresh Mongo read, and artifact status without downgrading successes.
  4.4. Make build completion summary compute `compiled`, `warning`, `failedDraft`, `blocking`, and `partialEligible`.
  4.5. Add a session resume path that restores failed drafts in the IDE panel after refresh.

**Files Touched**:

- `apps/studio/src/lib/arch-ai/build/partial-artifacts.ts`
- `apps/studio/src/lib/arch-ai/build-result-reconciliation.ts`
- `apps/studio/src/lib/arch-ai/build-completion.ts`
- `apps/studio/src/lib/arch-ai/ui/build-state.ts`
- `apps/studio/src/app/api/arch-ai/sessions/[id]/route.ts`

**Exit Criteria**:

- [ ] Browser refresh after failed BUILD still shows compiled agents and failed drafts.
- [ ] Reconciliation cannot mark a compiled worker as failed because of a stale Mongo read.
- [ ] Failed drafts include diagnostics and can be selected in the IDE panel.
- [ ] Completion widget can represent partial completion.

**Test Strategy**:

- Unit: artifact merge/reconciliation.
- Integration: simulated stale session read does not lose successful artifacts.

**Rollback**: Existing `metadata.files` remains source of file content; new artifact shape can be ignored by old UI.

---

### Phase 5: User Intervention UI And APIs

**Goal**: Give the user explicit controls during and after build recovery.

**Tasks**:

5.1. Add `BuildRecoveryPanel` below or inside `BuildProgressCard`.
5.2. Add row-level actions for failed agents:

- Retry failed agent
- Retry with broader repair
- Edit draft
- Exclude from initial project

  5.3. Add global actions:

- Cancel build
- Create project and continue
- Restart build
- Download diagnostics

  5.4. Wire APIs:

- `POST /api/arch-ai/sessions/:id/build/retry-agent`
- `POST /api/arch-ai/sessions/:id/build/update-draft`
- `POST /api/arch-ai/sessions/:id/build/create-project`
- extend existing `POST /api/arch-ai/sessions/:id/cancel`

  5.5. Add stable test IDs and update `apps/studio/e2e/workflows/agents.md`.
  5.6. Ensure actions are disabled while an agent is actively writing content unless the action is cancel.

**Files Touched**:

- `apps/studio/src/lib/arch-ai/components/arch/chat/BuildRecoveryPanel.tsx`
- `apps/studio/src/lib/arch-ai/components/arch/chat/BuildProgressCard.tsx`
- `apps/studio/src/lib/arch-ai/components/arch/panels/IDEPanel.tsx`
- `apps/studio/src/lib/arch-ai/store/arch-ai-store.ts`
- `apps/studio/src/app/api/arch-ai/sessions/[id]/build/*`
- `apps/studio/e2e/workflows/agents.md`

**Exit Criteria**:

- [ ] User can cancel an active BUILD and receives a visible canceled state.
- [ ] User can retry only a failed agent without restarting compiled agents.
- [ ] User can edit and save a failed draft from the IDE panel.
- [ ] User can create an incremental Arch-generated project when at least one agent is compiled/warning or Arch has a useful generated draft topology to preserve.
- [ ] Buttons have deterministic disabled/loading states.

**Test Strategy**:

- Component: recovery panel action rendering by status.
- API: auth/project/session ownership checks.
- E2E: failed build -> edit draft -> retry agent -> create project and continue.

**Rollback**: Keep APIs disabled behind `ARCH_AI_BUILD_RECOVERY_ACTIONS=false` while diagnostics remain visible.

---

### Phase 6: Incremental Project Creation And Publish Gates

**Goal**: Allow users to keep useful generated work without pretending the project is production-ready.

**Tasks**:

6.1. Extend project creation input with `creationMode: 'complete' | 'incremental_arch_project' | 'partial_needs_repair'`.
6.2. Create `ArchGeneratedProjectManifest` and `ArchProjectRepairManifest`, then persist them in project metadata or a dedicated settings document.
6.3. Save compiled/warning agents as normal `ProjectAgent` records.
6.4. Save failed agents as draft files or disabled `ProjectAgent` records with `status: needs_repair`.
6.5. Disable publish/deploy/export by default while blocking repair items exist, but allow explicit user promotion with warnings, audit logging, and a visible badge.
6.6. Add project health findings that point back to the failed Arch diagnostics.
6.7. Add repair checklist and active Arch step timeline to the project summary and/or health panel.

**Files Touched**:

- `apps/studio/src/lib/arch-ai/message-handler.ts`
- `apps/studio/src/lib/arch-ai/build-completion.ts`
- `apps/studio/src/lib/arch-ai/project-health/*`
- `apps/studio/src/app/api/projects/[id]/agents/*`
- `apps/studio/src/app/api/projects/[id]/export/*`
- `packages/database/src/models/project.model.ts` if project-level metadata needs schema support.

**Exit Criteria**:

- [ ] Incremental project can be created with compiled agents, failed draft manifest, and visible lifecycle badge.
- [ ] Publish/deploy routes fail closed with a repair-required diagnostic unless the user explicitly promotes with warnings.
- [ ] User can open the project and see repair checklist plus active Arch steps immediately.
- [ ] Complete builds continue creating active projects with no repair badge.

**Test Strategy**:

- Integration: incremental project creation via API.
- Route tests: publish/deploy blocked for unresolved `needs_repair` lifecycle unless explicitly promoted with warnings.
- E2E: create project and continue, then verify repair checklist and Arch steps are visible inside the project.

**Rollback**: Incremental creation route can be disabled; normal complete creation path remains unchanged.

---

### Phase 7: Broader Model-Aware Repair

**Goal**: When deterministic repair cannot fix the failure, the model receives the broader structural context needed to choose a new plan.

**Tasks**:

7.1. Add a repair prompt builder that includes construct plan issue list, scaffold skeleton, assembled YAML excerpt, compiler diagnostics, topology role, available tools, and allowed recovery strategies.
7.2. Ask the model for a structured repair plan, not raw YAML first.
7.3. Validate repair plan with `validateScaffoldConstructPlan`.
7.4. Only then assemble or patch YAML.
7.5. Escalate from selected model to configured stronger repair model if available.
7.6. Record repair plan and model usage in build logs.

**Files Touched**:

- `apps/studio/src/lib/arch-ai/scaffold/construct-repair.ts`
- `apps/studio/src/lib/arch-ai/helpers/build-llm-messages.ts`
- `apps/studio/src/lib/arch-ai/model-policy-defaults.ts`
- `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`

**Exit Criteria**:

- [ ] Repeated same compiler error triggers broader repair, not another local syntax patch.
- [ ] Broader repair output is structured and validated before YAML generation.
- [ ] Stronger repair model selection is logged and budget-aware.
- [ ] Failed broader repair produces a failed draft with useful diagnostic, not an endless spinner.

**Test Strategy**:

- Unit: repair prompt builder includes required context and excludes secrets.
- Integration: mocked repair model returns corrected construct plan; worker completes.

**Rollback**: Disable model-aware repair while retaining deterministic repair and incremental project creation.

---

### Phase 7B: Full-Compile Orchestrated Retry

**Goal**: Maximize the chance of producing a fully compilable project after one or more agent-level failures, without regressing agents that already compiled.

**Tasks**:

7B.1. Add a `completeProjectRecovery` orchestration pass after initial workers settle and before Arch recommends promotion.
7B.2. Lock compiled/warning agents as stable inputs by default.
7B.3. For failed agents, build a cross-agent repair context that includes:

- topology and build order,
- compiled sibling agent contracts,
- handoff/delegate expectations,
- shared memory variables,
- source tool contracts and fixtures,
- failed agent diagnostics and prior attempts.

7B.4. Retry only failed agents with this broader project context.
7B.5. Re-run project-level compile/reconciliation after targeted retries.
7B.6. If all agents compile before project creation, create the project as `active`.
7B.7. If some still fail, create or keep the project as `needs_repair` with continued Arch steps and a user-controlled promotion path.

**Files Touched**:

- `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`
- `apps/studio/src/lib/arch-ai/build-result-reconciliation.ts`
- `apps/studio/src/lib/arch-ai/build/recovery-policy.ts`
- `apps/studio/src/lib/arch-ai/helpers/build-llm-messages.ts`
- `apps/studio/src/lib/arch-ai/build-completion.ts`

**Exit Criteria**:

- [ ] A 3-pass scenario can recover from one failed specialist without regenerating compiled siblings.
- [ ] Project-level compile is executed after targeted retries.
- [ ] Active project creation is chosen automatically if targeted retries reach all-compiled/all-warning before project creation.
- [ ] Incremental project creation remains available without waiting for recovery exhaustion.

**Test Strategy**:

- Integration: initial build has one failed agent, targeted retry succeeds, final summary is complete.
- Integration: targeted retry fails, final summary is actionable incremental/repair state.

**Rollback**: Disable orchestrated retry while retaining per-agent failed draft state.

---

### Phase 7C: Product Eval Execution And Runtime Optimization

**Goal**: Use the real visible Arch-generated project as the product eval and Runtime optimization container, collect real transcripts/traces/scores, and continue improving agents inside the project before or after user promotion.

This phase is not a nightly CI plan and is not limited to Arch failures. It is a product-native validation and optimization stage in the Arch flow.

**Code-Grounded Starting Point**:

- Product evals are project-scoped: `EvalScenario`, `EvalSet`, and `EvalRun` all require `projectId`, Studio eval routes call `requireProjectAccess`, and Runtime eval requests send a real `projectId` into `POST /api/internal/chat/agent`.
- The current Arch create path in `apps/studio/src/lib/arch-ai/message-handler.ts` already knows how to persist Project, ProjectAgents, tools, behavior profiles, entry agent, journal/spec links, and rollback on create failure.
- Eval definitions already exist as Mongo models: `EvalPersona`, `EvalScenario`, `EvalEvaluator`, `EvalSet`, and `EvalRun` in `packages/database/src/models`.
- Studio already creates/list eval assets through `apps/studio/src/app/api/projects/[id]/evals/*` and shared helpers in `apps/studio/src/repos/eval-repo.ts`.
- Quick Eval already materializes personas/scenarios/evaluators/sets and starts a run in `apps/studio/src/app/api/projects/[id]/evals/quick/route.ts`; Arch should extract/reuse that materialization shape instead of duplicating it.
- Eval execution already runs through `packages/pipeline-engine/src/pipeline/handlers/eval-run.workflow.ts`, which fans out `RunEvalConversation` and `JudgeConversation`.
- `RunEvalConversation` already calls Runtime via `POST /api/internal/chat/agent` and writes `conversation`, `trace_events`, `tool_calls`, `actual_agent_path`, milestones, and errors into ClickHouse `eval_conversations`.
- `JudgeConversation` already writes score, pass/fail, reasoning, evidence, and trajectory score components into `eval_scores`.
- Heatmap currently exposes aggregate scores; a case/transcript drill-down route is needed for Arch optimization to read the specific evidence behind a bad run cell.

**Tasks**:

7C.1. Add `arch-generated-project-service` by extracting the reusable persistence spine from the existing Arch project create path.
7C.2. Create or reuse the visible Arch-generated project as soon as Arch has enough useful structure to persist.
7C.3. Persist generated ProjectAgents, tools, behavior profiles, entry-agent selection, failed drafts, repair checklist, active Arch step, and Arch provenance into the project.
7C.4. Mark the project with a visible lifecycle badge (`building`, `needs_repair`, `validating`, `validation_skipped`, or `active`) in project lists and project detail surfaces.
7C.5. Store the real `projectId` in `ArchRuntimeEvalOptimizationState.projectId`; all product eval assets and Runtime calls use this real project scope.
7C.6. Split reusable eval materialization helpers out of `apps/studio/src/app/api/projects/[id]/evals/quick/route.ts`.
7C.7. Add `arch-eval-materializer` that derives product eval assets from Arch state:

- personas from target users, channels, tone constraints, and source behavior profiles,
- scenarios from blueprint goals, topology edges, source-grounded fixtures, and expected milestones,
- trajectory evaluators for handoff path, milestone completion, and tool sequence,
- LLM judge evaluators for response quality, policy adherence, source grounding, and customer-facing clarity,
- one eval set named from the Arch session/build run and tagged as Arch-generated.

7C.8. Create the eval run with `knownSource: 'synthetic'` by default for generated validation conversations, unless product policy chooses `eval`.
7C.9. Trigger the existing Restate eval workflow using the same contract as `/api/projects/:id/evals/runs/:runId/start`.
7C.10. Add `arch-eval-result-reader`:

- poll `EvalRun.status` and `/evals/runs/:runId/status` semantics,
- read aggregate scores through existing heatmap query logic,
- read case-level transcripts from `eval_conversations`,
- read judge evidence from `eval_scores`,
- decompress stored payloads using the same eval compression helpers,
- dedupe replayed rows with `argMax(..., created_at)` as the heatmap route already does.

7C.11. Add or depend on `GET /api/projects/:projectId/evals/runs/:runId/cases` for product eval case drill-down. This should be a product eval endpoint, not an Arch-only transcript store.
7C.12. Add `arch-eval-optimizer` that maps failing eval cases to targeted repair:

- runtime error -> failed agent/tool repair,
- unexpected `actual_agent_path` -> topology/handoff repair,
- milestone miss -> flow step or tool call repair,
- tool overuse or wrong tool order -> tool-selection prompt/available-tools repair,
- low judge score with useful evidence -> targeted prompt/persona/response repair.

7C.13. Retry only the impacted generated agents, then update the project's `ProjectAgent.dslContent` and rerun only impacted scenarios when possible.
7C.14. Keep compiled siblings locked unless eval evidence proves a cross-agent contract defect.
7C.15. If eval optimization passes, update the project badge to `active` or `ready` and archive the Arch session when no active Arch step remains.
7C.16. If eval optimization fails or the user stops, keep the project accessible as `needs_repair` and offer retry, edit, discard, or promote with warnings.
7C.17. Allow the user to promote at any point; promotion with unresolved gates records `promotedByUserOverride`, keeps visible warning state, and writes audit evidence.
7C.18. Present the stage as `Validate and optimize` inside the project and Arch flow, with visible project id, run id, current scenario, transcript drill-down, promote, skip, and stop controls.
7C.19. Do not archive the Arch session until the eval optimization gate passes, the user promotes/stops with warnings, or the project is discarded.

**Files Touched**:

- `apps/studio/src/lib/arch-ai/eval/arch-eval-materializer.ts`
- `apps/studio/src/lib/arch-ai/eval/arch-eval-runner.ts`
- `apps/studio/src/lib/arch-ai/eval/arch-eval-result-reader.ts`
- `apps/studio/src/lib/arch-ai/eval/arch-eval-optimizer.ts`
- `apps/studio/src/lib/arch-ai/project/arch-generated-project-service.ts`
- `apps/studio/src/app/api/arch-ai/sessions/[id]/build/runtime-eval/route.ts`
- `apps/studio/src/app/api/projects/[id]/evals/quick/route.ts`
- `apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/cases/route.ts`
- `apps/studio/src/repos/eval-repo.ts`
- `packages/database/src/models/project.model.ts`
- `apps/studio/src/services/project-service.ts`
- `apps/studio/src/repos/project-repo.ts`
- `apps/studio/src/lib/arch-ai/message-handler.ts`
- `apps/studio/src/lib/arch-ai/build-completion.ts`
- `apps/studio/src/lib/arch-ai/components/arch/chat/BuildProgressCard.tsx`

**Exit Criteria**:

- [ ] From an Arch BUILD with useful generated structure, the system creates a real visible project with persisted agents/tools/profiles/drafts and an Arch lifecycle badge.
- [ ] Arch-generated projects are clearly badged before promotion and show current Arch steps inside the project.
- [ ] Arch creates product eval personas, scenarios, evaluators, an eval set, and an eval run under the real project `projectId` without manual Eval page setup.
- [ ] The eval run executes against Runtime through existing `EvalRunWorkflow` and `POST /api/internal/chat/agent` using the real project `projectId`; Arch does not use an in-process runtime shortcut.
- [ ] Arch can display at least one eval transcript with trace/tool evidence for the generated project.
- [ ] Low-score or failed eval cases are mapped to targeted optimization actions with impacted agent names.
- [ ] A targeted optimization rerun updates only impacted `ProjectAgent` records and does not regenerate unrelated compiled agents.
- [ ] If eval optimization passes thresholds, the project badge becomes active/ready and the Arch session is archived when no active step remains.
- [ ] If eval optimization fails after bounded rounds, the user can inspect transcripts and choose retry, edit, discard, or promote with warnings.

**Test Strategy**:

- Unit: materializer converts blueprint/topology/source fixtures into valid `EvalScenario`, `EvalPersona`, `EvalEvaluator`, and `EvalSet` payloads.
- Unit: optimizer maps synthetic transcript/score evidence to targeted repair actions.
- Integration: Arch-created eval run starts through the same Restate trigger contract used by eval run start route.
- Integration: result reader handles completed, failed, canceled, and stuck eval runs.
- Route: eval case drill-down enforces `{ tenantId, projectId, runId }` scoping and bounded pagination.
- E2E: Arch BUILD creates project -> show Arch steps in project -> create eval assets -> run Runtime eval -> show transcript -> optimize impacted agent -> rerun -> promote.

**Rollback**: Disable Arch runtime eval optimization behind `ARCH_AI_RUNTIME_EVAL_OPTIMIZATION=false`. Product eval pages, runs, and manually created evals continue to work unchanged.

---

### Phase 8: Observability, Audit, And Operations

**Goal**: Make BUILD failures diagnosable from logs, audit trails, and user-exported artifacts.

**Tasks**:

8.1. Add build-run lifecycle events for `build_run_started`, `build_agent_attempt_started`, `build_recovery_diagnostic`, `build_recovery_action_selected`, `build_agent_failed_draft`, and `build_incremental_project_created`.
8.2. Add runtime-eval lifecycle events for `arch_eval_assets_created`, `arch_eval_run_started`, `arch_eval_transcript_ready`, `arch_eval_optimization_selected`, and `arch_eval_gate_passed`.
8.3. Add metrics for failed-draft rate, average attempts by failure class, incremental project creation rate, runtime-eval pass rate, optimization rounds per build, user intervention action rate, user override promotion rate, and time-to-terminal-state.
8.4. Add audit-log filters for `buildRunId`, `failureClass`, `agentName`, `evalRunId`, and `optimizationRound`.
8.5. Add generated report to downloadable build log with links to product eval run/case evidence.
8.6. Add deployment monitor for `agents-dev.kore.ai` Arch BUILD error signatures and runtime-eval execution failures.

**Files Touched**:

- `apps/studio/src/lib/arch-ai/audit/*`
- `apps/studio/src/app/api/arch-ai/audit-logs/*`
- `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`
- `apps/studio/src/lib/arch-ai/eval/*`
- `apps/studio/src/lib/arch-ai/components/arch/chat/BuildProgressCard.tsx`

**Exit Criteria**:

- [ ] A support engineer can identify top BUILD failure classes from audit logs.
- [ ] Downloaded build log includes all diagnostics and selected recovery actions.
- [ ] Downloaded build log links the Arch build run to product eval set/run/case evidence when runtime optimization ran.
- [ ] Dev deployment can be monitored for recurrence of the observed loop signature and eval execution failures.

**Test Strategy**:

- Unit: event payload redaction and schema.
- Integration: audit-log query returns build diagnostics by buildRunId.

**Rollback**: Audit events are additive.

## 8. Wiring Checklist

- [ ] New recovery services are imported only server-side where needed.
- [ ] New session build routes use existing auth/session ownership helpers.
- [ ] New SSE event types are handled in `event-dispatcher.ts`.
- [ ] Store state survives session resume and browser refresh.
- [ ] `BuildProgressCard` renders new statuses without layout shift.
- [ ] `IDEPanel` allows edit/save only for failed drafts and pauses auto-stream overwrites.
- [ ] Arch-created eval assets are real product eval records (`EvalPersona`, `EvalScenario`, `EvalEvaluator`, `EvalSet`, `EvalRun`) scoped by tenant/project.
- [ ] Runtime eval execution uses `EvalRunWorkflow`; no Arch-only in-process shortcut is introduced.
- [ ] Runtime eval execution always uses the real Arch-generated project id; no fake/session-derived `projectId` is introduced.
- [ ] Arch-generated projects are visible with lifecycle badges, and publish/export/deploy gates respect lifecycle plus explicit user promotion state.
- [ ] Eval transcript/case drill-down reads existing `eval_conversations` and `eval_scores` rows with bounded pagination.
- [ ] Arch session metadata links build run, generated project, eval set, eval run, and optimization round.
- [ ] Arch-generated project manifest is included in project health and export readiness checks.
- [ ] Publish/deploy gates check unresolved Arch repair lifecycle before running.
- [ ] E2E test IDs are documented in `apps/studio/e2e/workflows/agents.md`.
- [ ] Docs/testing matrix updated after implementation.

## 9. Test Matrix

| Scenario                                                    | Current Coverage                                                               | Target Coverage                                                            | Type                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------- |
| Scaffold construct plan has unknown branch target           | Partial unit coverage in `runtime-flow.test.ts`                                | Construct repair test plus worker integration                              | Unit + Integration  |
| Legacy fallback emits invalid `WITH` placement repeatedly   | Not covered as UX failure                                                      | Escalates to broader/stronger repair before failed draft                   | Unit + Integration  |
| 3 of 4 agents compile, 1 fails                              | Not covered                                                                    | Targeted retry repairs failed agent while compiled siblings remain locked  | Integration + E2E   |
| User cancels active BUILD                                   | Existing cancel API for turn engine only                                       | BUILD worker cancel with UI state                                          | API + E2E           |
| User edits failed draft and retries one agent               | Not covered                                                                    | Draft update route and targeted retry without regenerating siblings        | API + E2E           |
| Generated project enters runtime eval                       | Product evals require project scope; Arch currently creates ready project only | Arch creates visible badged project before eval assets/run                 | Integration + E2E   |
| All agents compile but runtime eval finds bad handoff       | Product eval can score handoff trajectories, not wired to Arch                 | Arch-created eval transcript drives targeted handoff repair                | Integration + E2E   |
| Arch-created eval run completes with low judge score        | Product eval run/score storage exists                                          | Arch reads case evidence and optimizes impacted agent prompt/tool usage    | Integration         |
| Eval case transcript drill-down                             | Heatmap aggregate exists; case route not wired                                 | Product eval cases endpoint returns transcript, traces, tool calls, scores | Route + Integration |
| User skips runtime eval optimization                        | Not covered                                                                    | Project remains/promotes with `validation_skipped` badge and audit record  | API + E2E           |
| Browser refresh after failed BUILD                          | Partial store resume coverage                                                  | Failed drafts and diagnostics restored                                     | Integration + E2E   |
| Publish blocked or warning-promoted for incremental project | Not covered                                                                    | Route-level lifecycle checks and explicit override audit                   | Route tests         |
| Audit logs classify failure class                           | Not covered                                                                    | Queryable by buildRunId/failureClass                                       | Integration         |

## 10. Rollout Plan

1. **Shadow diagnostics**: emit taxonomy and recovery suggestions without changing retry behavior.
2. **Deterministic repair**: enable construct repair for known scaffold issue codes.
3. **Bounded loops**: enforce retry budgets and failed-draft terminal state.
4. **UI controls**: expose retry/cancel/edit/download diagnostics.
5. **Full-compile orchestrated retry**: retry only failed agents with broader project context while preserving compiled siblings.
6. **Incremental project lifecycle**: create visible badged Arch-generated projects from useful generated output and continue Arch steps inside the project.
7. **Eval materialization beta**: create product eval scenarios, personas, evaluators, sets, and runs under Arch-generated projects.
8. **Runtime eval optimization**: execute Arch-created evals through Runtime, read transcripts/scores, and repair impacted agents before or after user promotion.
9. **Promotion controls**: allow user promotion at any point with visible warning state and audit evidence when gates are unresolved.
10. **Publish gates**: enforce repair-required checks before deploy/publish unless explicitly overridden where product policy allows.
11. **Default-on**: enable for all Arch BUILD sessions after dev stability metrics are clean.

## 11. Acceptance Criteria

- [ ] The observed `FLOW_THEN_UNKNOWN_STEP -> legacy fallback -> WITH placement loop` cannot repeat indefinitely.
- [ ] BUILD first attempts realistic full-compile recovery using deterministic repair, broader repair, stronger model retry when configured, and targeted failed-agent retry.
- [ ] BUILD reaches full compilation when a targeted/broader retry can repair the failed agent without changing compiled siblings.
- [ ] Arch can create a real visible Arch-generated project before all repair/eval loops finish.
- [ ] Arch can create product eval assets and execute the generated project through Runtime using the existing eval pipeline and real project scope.
- [ ] Runtime eval transcript, trace, tool, score, and trajectory evidence can drive targeted agent optimization.
- [ ] A generated project can become active automatically after passing configured compile/runtime-eval gates, or by explicit user promotion with warnings/audit if gates are unresolved.
- [ ] BUILD recovery loops reach a user-actionable state within bounded attempts, while project access remains available once useful structure exists.
- [ ] User can intervene without refreshing or copying logs.
- [ ] User can create and enter an incremental project without waiting for Arch recovery exhaustion.
- [ ] Incremental projects are visibly marked with `Building`, `Needs Repair`, `Validating`, `Validation Skipped`, or `Active`.
- [ ] Publish/deploy/export readiness gates block by default until repair checklist is clear, unless explicit promotion policy allows a warning override.
- [ ] Build diagnostics are durable, exportable, and queryable.
- [ ] Complete happy-path builds remain one-click and do not show unnecessary recovery UI.

## 12. Open Questions

Resolved in this revision:

- Product eval execution requires real project scope, so Arch uses the real Arch-generated project before materializing eval assets or starting `EvalRunWorkflow`.
- Incremental project creation is generally available, not limited to internal/dev tenants.
- Arch-generated projects are visible with lifecycle badges, not hidden.
- Arch steps continue inside the project so the user is not trapped in the Arch BUILD loop.
- The user can promote at any point; unresolved gates remain visible and audited.

1. Should failed agents be saved as disabled `ProjectAgent` records, draft files only, or both?
2. What is the default stronger repair model for broader repair: current project model, platform repair model, or tenant policy default?
3. Should user-edited failed drafts compile inside Arch before project creation, or can they remain non-blocking draft artifacts?
4. Should Arch runtime eval optimization be default-on after project creation, user-triggered via `Validate and optimize`, or policy-driven per tenant/project?
5. Should Arch-generated validation runs use `knownSource: 'synthetic'` for shorter retention by default, or `knownSource: 'eval'` so they behave like manually authored product evals?
6. Should optimized eval scenarios remain in the product Eval page as editable assets by default, or be hidden unless the user promotes them?
7. If eval optimization mutates persisted `ProjectAgent.dslContent`, should Arch keep a separate before/after diff artifact for review before promotion?
8. What cleanup policy should remove discarded Arch-generated projects, eval assets, and ClickHouse evidence if the user abandons the flow?

## 13. Recommended First Slice

Start with **Phase 1 + Phase 2 + the minimal UI label from Phase 5**:

1. Classify construct-plan failures.
2. Repair scaffold construct-plan branch targets before fallback.
3. Stop blind legacy fallback for deterministic construct errors.
4. Add repeated-error detection that escalates from local compile-fix to broader repair.
5. Retry only failed agents with compiled siblings locked as context.
6. Mark an agent `failed_draft` only after broader repair fails.
7. Show `Still repairing`, `Needs repair`, and diagnostic download in the build progress card.

This gives immediate relief for `agents-dev.kore.ai` while preserving the best outcome: fully compilable agents after a few meaningful repair loops.

The next slice after that should be **Phase 7C's incremental project + materializer/result-reader spine**:

1. Extract incremental Arch-generated project creation from the existing Arch create path.
2. Create one visible badged project from useful generated Arch output.
3. Extract product eval materialization from Quick Eval into reusable helpers.
4. Add Arch-created eval assets under that project.
5. Start the existing `EvalRunWorkflow` and persist `projectId`/`evalRunId` in Arch session metadata.
6. Add/read the product eval cases endpoint so Arch can access transcripts, traces, tool calls, and scores.
7. Map one failing case to a targeted optimization recommendation without yet auto-editing agents.
