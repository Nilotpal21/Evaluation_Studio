# LLD: First-Class Start/End Steps — Implementation Plan

**Feature Spec**: `docs/features/workflows.md`
**HLD**: `docs/specs/workflow-start-end-first-class-steps.hld.md`
**Test Spec**: `docs/testing/workflows.md` (parent; will be updated via `/post-impl-sync`)
**Status**: DONE (implemented 2026-04-20; all 8 phase commits landed + 1 round-1 fix + 1 docs-sync commit)
**Date**: 2026-04-19
**Completed**: 2026-04-20
**JIRA**: ABLP-2
**Oracle log**: `docs/sdlc-logs/workflow-start-end-first-class-steps/lld.log.md`
**Implementation log**: `docs/sdlc-logs/workflow-start-end-first-class-steps/implementation.log.md`

---

## 0. Problem Statement & Motivation

The HLD (`docs/specs/workflow-start-end-first-class-steps.hld.md`) documents three runtime defects in `apps/workflow-engine`:

1. `startInputVariables` declared on the canvas `start` node are extracted (`canvas-to-steps.ts:351-358`) but dropped at every downstream handoff site — the engine performs **zero** input validation or type coercion. Every non-Studio trigger path (cron, webhook, polling, agent) runs with unvalidated trigger payloads; missing required fields silently become `undefined`.
2. The `end` node's output-mapping expression evaluation (`workflow-handler.ts:1357-1372`) silently swallows per-mapping failures with `catch { resolvedOutput[name] = null; }` — no log, no trace, no step status, no operator visibility.
3. The Start step record on `execution.steps[]` lies (raw payload as both `input` and `output`), and no End step record exists at all — Studio `DebugFlowLog.tsx:54-111` fabricates both client-side, producing a three-way inconsistency across Debug panel (4 steps), Raw JSON panel (3), and Monitor tab count (3).

This LLD delivers the HLD's Option B (special-case handler-managed boundary step records) across 8 commits, wires `startInputVariables` through all ~10 handoff sites, promotes End to a first-class step record with per-mapping `mappingErrors[]`, fails the workflow on any mapping error (D-17), and removes the client-side fabrications. The work is entirely defect repair against existing FR-20 (execution status tracking) and FR-04 (expression resolution); no new feature surface.

Motivation (why now): the user surfaced the three-way step-count inconsistency directly, which exposed the dead-wiring + silent-swallow pattern. Closing these gaps before the feature exits BETA prevents a large class of silent-failure production incidents (missing webhook payload fields, misspelled output mapping expressions) that are otherwise invisible until a downstream consumer notices `null`.

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                                                                                                                                                                                            | Rationale                                                                                                                                                                                                                                                                                                                                                                                                               | Alternatives Rejected                                                                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | 8 commits in strict dependency order (see Phases 1–8)                                                                                                                                                                                                                               | commit-scope-guard (≤40 files, ≤3 pkgs); deletion-ratio-guard (<30% on feat)                                                                                                                                                                                                                                                                                                                                            | HLD's 4-commit sketch — too coarse; one oversized commit fails scope guard                                                                                                                                                                               |
| D-2  | Function + tests in the same commit (slice-by-slice per pipeline.md)                                                                                                                                                                                                                | Pipeline mandate; matches webhook-versioning LLD precedent                                                                                                                                                                                                                                                                                                                                                              | TDD-first — not required; test-after — violates slice invariant                                                                                                                                                                                          |
| D-3  | `StartInputVariable` exported from `canvas-to-steps.ts`; Studio keeps its own local copy                                                                                                                                                                                            | All consumers are workflow-engine-internal; no cross-package import benefit                                                                                                                                                                                                                                                                                                                                             | Move to `packages/shared-kernel` — adds dep for zero gain                                                                                                                                                                                                |
| D-4  | `FieldError` co-located in `start-input-validator.ts`                                                                                                                                                                                                                               | Single-use type; reused by route preflight + handler via import                                                                                                                                                                                                                                                                                                                                                         | Separate types module — premature                                                                                                                                                                                                                        |
| D-5  | `Schema.Types.Mixed` for `mappingErrors` Mongoose field                                                                                                                                                                                                                             | HLD mandate; matches 5 existing Mixed fields on same schema (input/output/consoleLogs/etc.)                                                                                                                                                                                                                                                                                                                             | Typed sub-schema — no query/index benefit; two shapes (field vs mapping errors)                                                                                                                                                                          |
| D-6  | `buildWorkflowContext` gains optional `coerced?: Record<string,unknown>` 3rd param                                                                                                                                                                                                  | Backward-compat in tests; separates raw (input) from coerced (output) visibility                                                                                                                                                                                                                                                                                                                                        | Mutate in-place — breaks pure-builder contract                                                                                                                                                                                                           |
| D-7  | Natural SSE event order; no strict guarantee                                                                                                                                                                                                                                        | Studio sorts by `startedAt`; HLD oracle D-3 locks this                                                                                                                                                                                                                                                                                                                                                                  | Strict ordering — adds complexity without consumer benefit                                                                                                                                                                                               |
| D-8  | Payload wiring is highest risk; mitigate with wiring checklist + 2-path E2E                                                                                                                                                                                                         | ~10 handoff sites; GAP-14-class silent-drop failure mode                                                                                                                                                                                                                                                                                                                                                                | Rely on handler-side validation alone — misses cron/webhook/agent paths                                                                                                                                                                                  |
| D-9  | Test files flat in `__tests__/` (matches existing 40+ file convention)                                                                                                                                                                                                              | Codebase precedent; no subdirectory nesting in workflow-engine tests                                                                                                                                                                                                                                                                                                                                                    | Co-located `src/validation/__tests__/` — breaks repo convention                                                                                                                                                                                          |
| D-10 | Exit criteria include BOTH prose and exact verification commands                                                                                                                                                                                                                    | Measurable + readable per pipeline.md; matches 2026-04-14 workflow-versioning LLD                                                                                                                                                                                                                                                                                                                                       | Prose-only — not verifiable; commands-only — less readable                                                                                                                                                                                               |
| D-11 | `INPUT_VALIDATION_FAILED` / `OUTPUT_MAPPING_FAILED` live as persistence-bag error codes (strings), NOT as `StepErrorCode` enum members                                                                                                                                              | Matches existing pattern for workflow-level codes (`WORKFLOW_FAILED`, `WORKFLOW_CANCELLED` at `workflow-handler.ts:1429`) which are untyped strings; `StepErrorCode` is reserved for `throw new WorkflowStepError(...)` paths. Start/End failures DO throw `WorkflowStepError(StepErrorCode.STEP_FAILED, …)` but the persisted `error.code` in the step's `mappingErrors`/`error` fields is the domain-specific string. | Add to enum — pollutes the throw-path taxonomy; reuse generic `VALIDATION_ERROR`/`EXPRESSION_ERROR` — loses specificity at the UI layer where these codes surface.                                                                                       |
| D-12 | `StartInputVariable` is the **engine-consumed projection** `{name, type, required}` — a SUBSET of the canonical canvas shape in `StartNodeConfigSchema` (`packages/shared/src/types/workflow-schemas.ts:41-53`) which includes `defaultValue?: unknown` and `description?: string`. | The engine needs only name+type+required for validation/coercion. `description` is purely Studio/UI metadata. `defaultValue` is design-time metadata today — **not applied at engine start** (see D-13). Narrowing the engine type keeps the engine's surface minimal and matches current behavior exactly.                                                                                                             | Include full canvas shape — adds surface area for zero engine benefit; use the full Zod schema type — couples the engine to Studio-only UI fields (`description`).                                                                                       |
| D-13 | Engine does **NOT** apply `defaultValue` from `StartNodeConfig.inputVariables` at workflow start. A declared variable with `required:true` + `defaultValue:"10"` + missing-from-payload still produces a `REQUIRED` error.                                                          | Preserves current behavior exactly — today `ctx.vars` is seeded via `...triggerPayload` spread (`workflow-handler.ts:250`); no default-filling logic exists. Applying defaults would silently succeed where callers previously failed (a broader behavior change than this LLD's scope).                                                                                                                                | Apply defaults for missing required + TYPE_MISMATCH recoveries — expanded scope, different user contract; do nothing + no regression test — could drift silently later. We add a regression test to PIN the "no default application" behavior (Phase 3). |

### Key Interfaces & Types

```typescript
// apps/workflow-engine/src/handlers/canvas-to-steps.ts
// Promote existing inline shape to a named export.
//
// NOTE: This is the ENGINE-CONSUMED PROJECTION of the canvas `StartNodeConfig.inputVariables`
// shape. The canonical canvas shape (Zod `StartNodeConfigSchema` at
// packages/shared/src/types/workflow-schemas.ts:41-53) additionally carries
// `defaultValue?: unknown` and `description?: string` — both are Studio/UI metadata
// and are intentionally NOT projected into the engine's type.
// See D-12 and D-13 in the Decision Log for rationale.
export interface StartInputVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  required: boolean;
}

// apps/workflow-engine/src/validation/start-input-validator.ts — NEW
export type FieldErrorReason = 'REQUIRED' | 'TYPE_MISMATCH' | 'JSON_PARSE_ERROR';

export interface FieldError {
  name: string;
  reason: FieldErrorReason;
  expected?: string;
  got?: string;
}

export type ValidationResult =
  | { ok: true; coerced: Record<string, unknown> }
  | { ok: false; errors: FieldError[] };

/** Pure function. Coerce known types per RunDialog convention + broadened booleans. */
export function validateAndCoerceInput(
  startInputVariables: StartInputVariable[] | undefined,
  triggerPayload: Record<string, unknown> | undefined,
): ValidationResult;

// apps/workflow-engine/src/handlers/workflow-handler.ts
// Extend the persistence data-bag type with mappingErrors.
export interface ExecutionPersistence {
  updateStepStatus(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepId: string,
    status: string,
    data?: {
      output?: unknown;
      durationMs?: number;
      error?: unknown;
      input?: unknown;
      metrics?: { responseTimeMs?: number; processingTimeMs?: number };
      consoleLogs?: Array<{ level: string; args: unknown[] }>;
      context?: WorkflowContextData;
      callbackSecret?: string;
      // NEW:
      mappingErrors?: Array<{ name: string; expression?: string; error: string }>;
    },
  ): Promise<void>;
  // …rest unchanged
}

// apps/workflow-engine/src/handlers/workflow-handler.ts
export interface WorkflowExecutionInput {
  // …existing fields…
  startInputVariables?: StartInputVariable[]; // NEW
}

// apps/workflow-engine/src/lib/execution-payload.ts
export interface WorkflowExecutionPayload {
  // …existing fields…
  startInputVariables: StartInputVariable[]; // NEW — always present
}
export interface BuildExecutionPayloadInput {
  // …existing fields…
  startInputVariables?: StartInputVariable[]; // NEW — defaults to [] in builder
}

// apps/workflow-engine/src/lib/version-resolution.ts
export interface ResolvedWorkflowDefinition {
  steps: unknown[];
  nameToIdMap: Record<string, string>;
  outputMappings: OutputMapping[];
  startInputVariables: StartInputVariable[]; // NEW
  workflowVersion: string | null;
  workflowVersionId: string | null;
  deploymentId: string | null;
  tier: VersionResolutionTier;
}

// apps/workflow-engine/src/routes/workflow-executions.ts
type ExecutionDefinition = {
  steps: unknown[];
  nameToIdMap: Record<string, string>;
  outputMappings: OutputMapping[];
  startInputVariables: StartInputVariable[]; // NEW
  workflowVersionId?: string;
  workflowVersion?: string;
};

// packages/database/src/models/workflow-execution.model.ts
export interface INodeExecution {
  // …existing fields…
  mappingErrors?: Array<{ name: string; expression?: string; error: string }>; // NEW
}

// apps/studio/src/api/workflows.ts
export interface ExecutionStepResult {
  // …existing fields…
  mappingErrors?: Array<{ name: string; expression?: string; error: string }>; // NEW
}
```

### Module Boundaries

| Module                                                                    | Responsibility                                                                                  | Depends On                         |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------- |
| `packages/database/src/models/workflow-execution.model.ts`                | Mongoose schema + TypeScript interface for `nodeExecutions[]` (adds `mappingErrors`)            | mongoose                           |
| `apps/workflow-engine/src/handlers/canvas-to-steps.ts`                    | Exports `StartInputVariable` named type                                                         | —                                  |
| `apps/workflow-engine/src/validation/start-input-validator.ts` (NEW)      | Pure validation + coercion for `startInputVariables` against a trigger payload                  | `StartInputVariable`, `FieldError` |
| `apps/workflow-engine/src/lib/version-resolution.ts`                      | Forward `startInputVariables` in all 6 resolution tiers                                         | `canvas-to-steps.ts`               |
| `apps/workflow-engine/src/lib/execution-payload.ts`                       | Default `startInputVariables` to `[]` when absent                                               | `canvas-to-steps.ts`               |
| `apps/workflow-engine/src/routes/workflow-executions.ts`                  | Resolve definition → preflight validate → 400 or forward                                        | validator, payload builder         |
| `apps/workflow-engine/src/services/{trigger-engine,trigger-scheduler}.ts` | Forward `startInputVariables` in cron/webhook/agent/poll payloads                               | payload builder                    |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`                   | Start-phase validate+persist+event; End-phase evaluate-all+persist+event; fail on mapping error | validator, persistence, publisher  |
| `apps/studio/src/components/workflows/canvas/panels/DebugFlowLog.tsx`     | Render engine-authoritative `execution.steps[]` only (fabrications removed)                     | `ExecutionStepResult`              |
| `apps/studio/src/api/workflows.ts`                                        | Expose `mappingErrors` on `ExecutionStepResult` for Studio display                              | —                                  |

---

## 2. File-Level Change Map

### New Files

| File                                                                    | Purpose                                                                                                                                         | LOC  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `apps/workflow-engine/src/validation/start-input-validator.ts`          | Pure `validateAndCoerceInput` + `FieldError` type + coercion helpers                                                                            | ~110 |
| `apps/workflow-engine/src/__tests__/start-input-validator.test.ts`      | Unit tests — all coercion branches + error classifications (20+ cases)                                                                          | ~180 |
| `apps/workflow-engine/src/__tests__/workflow-handler-start-end.test.ts` | Integration: Start+End step record creation, validation failure, mapping failure, SSE order                                                     | ~260 |
| `apps/workflow-engine/src/__tests__/system-start-end-steps.test.ts`     | E2E-1..E2E-5 from HLD (real Mongo via `setup-mongo.ts`, real publisher, DI-stubbed external HTTP — matches `system-handler.test.ts` convention) | ~350 |

### Modified Files

| File                                                                        | Change                                                                                                                                                                                                                            | Risk |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/database/src/models/workflow-execution.model.ts`                  | Add `mappingErrors: { type: [Schema.Types.Mixed] }` to `NodeExecutionSchema`; add to `INodeExecution`                                                                                                                             | Low  |
| `apps/workflow-engine/src/handlers/canvas-to-steps.ts`                      | Promote inline `{name,type,required}` shape to exported `StartInputVariable` named type                                                                                                                                           | Low  |
| `apps/workflow-engine/src/lib/version-resolution.ts`                        | Add `startInputVariables` to `ResolvedWorkflowDefinition`; propagate in all 6 tiers (pinned/deployment/semver-desc/draft/working-copy-steps/working-copy-canvas)                                                                  | Med  |
| `apps/workflow-engine/src/lib/execution-payload.ts`                         | Add to `BuildExecutionPayloadInput` + `WorkflowExecutionPayload`; default to `[]` in `buildWorkflowExecutionPayload`                                                                                                              | Low  |
| `apps/workflow-engine/src/routes/workflow-executions.ts`                    | Add `startInputVariables` to `ExecutionDefinition` + 3 builder fns; preflight validation before `startWorkflow`; forward field into payload builder                                                                               | Med  |
| `apps/workflow-engine/src/services/trigger-engine.ts`                       | Forward `startInputVariables` into `buildWorkflowExecutionPayload` at line 555                                                                                                                                                    | Low  |
| `apps/workflow-engine/src/services/trigger-scheduler.ts`                    | Forward `startInputVariables` into `buildWorkflowExecutionPayload` at line 263                                                                                                                                                    | Low  |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`                     | Start phase (validate/coerce/persist/event) + End phase (evaluate-all/persist/event/fail) + extend `updateStepStatus` data-bag type + `buildWorkflowContext` `coerced?` param + initial `stepRecords` includes both Start and End | High |
| `apps/workflow-engine/src/__tests__/execution-payload.test.ts`              | Add tests for `startInputVariables` pass-through + `[]` default                                                                                                                                                                   | Low  |
| `apps/workflow-engine/src/__tests__/version-resolution.test.ts`             | Assert all 6 tiers return `startInputVariables` (regression guard)                                                                                                                                                                | Low  |
| `apps/workflow-engine/src/__tests__/canvas-to-steps.test.ts`                | Update existing `startInputVariables` extraction tests to import the named type                                                                                                                                                   | Low  |
| `apps/studio/src/api/workflows.ts`                                          | Add `mappingErrors?` to `ExecutionStepResult`                                                                                                                                                                                     | Low  |
| `apps/studio/src/components/workflows/canvas/panels/DebugFlowLog.tsx`       | Remove synthetic Start fabrication (L54-69), synthetic End fabrication (L72-111), remove unused `executionOutput`/`executionStatus`/`inputValues` props (L11-19) — keep `isRunning`                                               | Med  |
| `apps/studio/src/components/workflows/canvas/panels/WorkflowDebugPanel.tsx` | Remove `executionOutput`, `executionStatus`, `inputValues` props from `<DebugFlowLog />` call (L351-361)                                                                                                                          | Low  |

### Deleted Files

None.

### Parallel consumers of `start.config.inputVariables` — VERIFIED UNAFFECTED

These files consume `start.config.inputVariables` from the canvas/workflow document at layers OUTSIDE the engine execution path. They are **independent of the engine wiring** in this LLD and require **zero changes**:

| Consumer                                           | File                                                                                     | What it does                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Tool IR loader (workflow-as-tool binding)          | `apps/runtime/src/tools/load-project-tools-as-ir.ts:229-271`                             | Maps `start.config.inputVariables` → `tool.parameters` + `tool.derivedParameterSchema` |
| LLM wiring (reverse-map)                           | `apps/runtime/src/services/execution/llm-wiring.ts:1103-1116`                            | `tool.parameters` → `inputVariables` for `WorkflowToolExecutor.registerBinding()`      |
| Compiler IR `derivedParameterSchema`               | `packages/compiler/src/platform/ir/schema.ts:854-859`                                    | JSON Schema projection of `start.inputVariables` on `ToolDefinition`                   |
| `Workflow.inputSchema` / `outputSchema` derivation | `apps/studio/src/lib/variables-to-json-schema.ts:30-78,169` + `useWorkflowSave.ts:45-55` | Derives JSON Schema from canvas at Studio save time; stored on Workflow/Version docs   |
| Studio `WorkflowConfigForm`                        | `apps/studio/src/components/tools/WorkflowConfigForm.tsx:259-274`                        | Reads for tool-creation dialog parameter list                                          |
| Studio `IntegrationNodeConfig`                     | `apps/studio/src/components/workflows/canvas/config/IntegrationNodeConfig.tsx:75`        | Reads for Context Explorer suggestions                                                 |
| `WorkflowToolExecutor.WorkflowMeta`                | `apps/runtime/src/services/workflow/workflow-tool-executor.ts:22-31`                     | Caches `inputVariables` with `description?` for tool execution routing                 |
| Project import/export                              | `packages/project-io/src/{import,export}/layer-{dis,}assemblers/workflows-*.ts`          | Handles derived `inputSchema`/`outputSchema` (not raw `inputVariables`)                |

**Why unaffected:** All of these consumers read the canonical canvas shape from the workflow/version document (`start.config.inputVariables`), not the engine's `WorkflowExecutionInput.startInputVariables`. The canvas document is unchanged by this LLD. The only shared contract is the `type` enum (`'string' | 'number' | 'boolean' | 'json'`), which is identical across the canvas Zod `StartNodeConfigSchema` and the new engine `StartInputVariable` type.

**Known follow-up (out of scope — log as follow-up ticket):**

1. **Schema-vs-validator consistency invariant.** `Workflow.inputSchema` (JSON Schema derived by `variables-to-json-schema.ts`) and the engine's `validateAndCoerceInput` are parallel implementations. They could drift. No external API consumer publishes `inputSchema` today (verified: workflow-engine has no per-workflow schema endpoint), so the drift is internal-only. A separate ticket should add a cross-test asserting equivalence — input that passes the JSON Schema must coerce-and-validate in the engine, and vice versa.
2. **`defaultValue` application.** The canvas `StartNodeConfigSchema` carries `defaultValue?: unknown` per declared variable. The engine does NOT apply defaults today (ctx.vars is seeded via spread only) — this LLD preserves that behavior (D-13). A separate ticket could add optional default-filling, but it is a broader behavioral change not covered here.

---

## 3. Implementation Phases

CRITICAL: Each phase is independently deployable, independently revertable, and leaves the system in a working state. No phase contains a TODO stub or a half-wired component.

### Phase 1 — Data Layer & Shared Types

**Commit type**: `refactor` (includes schema change + type promotion — no user-facing behavior change yet)
**Commit scope**: 2 packages (`packages/database`, `apps/workflow-engine`), ~5 files

**Goal**: Prepare the schema and type surface that every subsequent phase depends on.

**Tasks:**

Task 1.1 — Add `mappingErrors: { type: [Schema.Types.Mixed] }` to `NodeExecutionSchema` in `packages/database/src/models/workflow-execution.model.ts:133-173`. Add matching optional field to `INodeExecution` interface.

Task 1.2 — In `apps/workflow-engine/src/handlers/canvas-to-steps.ts`, promote the inline `Array<{ name: string; type: string; required: boolean }>` to an exported `StartInputVariable` named interface. Update `CanvasConversionResult.startInputVariables` to use the named type. Tighten `type` to `'string' | 'number' | 'boolean' | 'json'`.

Task 1.3 — In `apps/workflow-engine/src/handlers/workflow-handler.ts:108-125`, extend the `ExecutionPersistence.updateStepStatus` `data?` parameter TypeScript type with `mappingErrors?: Array<{ name: string; expression?: string; error: string }>`. No call-site changes yet.

Task 1.4 — In `apps/workflow-engine/src/__tests__/canvas-to-steps.test.ts`, update existing `startInputVariables` tests (lines 1041-1079, 1114-1127) to import the named `StartInputVariable` type.

**Files Touched**:

- `packages/database/src/models/workflow-execution.model.ts`
- `apps/workflow-engine/src/handlers/canvas-to-steps.ts`
- `apps/workflow-engine/src/handlers/workflow-handler.ts`
- `apps/workflow-engine/src/__tests__/canvas-to-steps.test.ts`

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/database --filter=@abl/workflow-engine` succeeds with 0 errors
- [ ] `pnpm test --filter=@abl/workflow-engine -- canvas-to-steps` passes (all existing tests + updated tests)
- [ ] `git grep 'StartInputVariable' apps/workflow-engine/src` shows exports and imports resolve (no stray inline types)
- [ ] `tsc --noEmit` on both packages shows 0 errors

**Test Strategy**:

- Unit: `canvas-to-steps.test.ts` continues to assert `startInputVariables` extraction (unchanged behavior).
- Integration: None this phase (no runtime behavior change).

**Rollback**: `git revert <sha>` — schema field addition is non-destructive (Mongoose tolerates existing docs without it).

---

### Phase 2 — Payload Wiring (`startInputVariables` end-to-end)

**Commit type**: `feat` (additive wiring, no user-visible behavior change yet — validation lands in Phase 4)
**Commit scope**: 1 package (`apps/workflow-engine`), 8 files (6 src + 2 test)

**Goal**: Wire `startInputVariables` from canvas extraction through all 10 handoff sites into `WorkflowExecutionInput`. No validation yet — just the plumbing.

**Tasks:**

Task 2.1 — In `apps/workflow-engine/src/lib/execution-payload.ts`:

- Add `startInputVariables?: StartInputVariable[]` to `BuildExecutionPayloadInput` (default `[]` in builder).
- Add `startInputVariables: StartInputVariable[]` to `WorkflowExecutionPayload` (always present).
- In `buildWorkflowExecutionPayload`, set `payload.startInputVariables = input.startInputVariables ?? []`.

Task 2.2 — In `apps/workflow-engine/src/lib/version-resolution.ts:81-89`, add `startInputVariables: StartInputVariable[]` to `ResolvedWorkflowDefinition`. Propagate `conversion.startInputVariables` in ALL 6 `return` sites in `resolveWorkflowDefinition` (file `version-resolution.ts`). The 6 tiers (per `VersionResolutionTier` union at lines 34-40) are: `pinned` (line 115-123), `deployment` (line 162-170), `semver-desc` (line 205-213), `draft` (line 234-242), `working-copy-steps` (line 252-260 — reads `canvasConversion.startInputVariables`), `working-copy-canvas` (line 264-272 — reads `canvasConversion.startInputVariables`). NOTE: `EMPTY_RESULT` in `canvas-to-steps.ts:151-156` already includes `startInputVariables: []` — no change needed there. No `EMPTY_RESULT` constant exists in `version-resolution.ts`.

Task 2.3 — In `apps/workflow-engine/src/routes/workflow-executions.ts:130-136`, add `startInputVariables` to `ExecutionDefinition` and each of `buildWorkingCopyExecutionDefinition`, `buildVersionExecutionDefinition`, `buildDefaultVersionExecutionDefinition` return values.

Task 2.4 — In `apps/workflow-engine/src/routes/workflow-executions.ts:505-523`, `apps/workflow-engine/src/services/trigger-engine.ts:555`, `apps/workflow-engine/src/services/trigger-scheduler.ts:263` — forward `executionDefinition.startInputVariables` / `resolved.startInputVariables` into `buildWorkflowExecutionPayload`.

Task 2.5 — In `apps/workflow-engine/src/handlers/workflow-handler.ts:59-77`, add `startInputVariables?: StartInputVariable[]` to `WorkflowExecutionInput`. Handler doesn't USE the field yet — placeholder for Phase 4.

Task 2.6 — Update `apps/workflow-engine/src/__tests__/execution-payload.test.ts` — add tests:

- `startInputVariables` pass-through preserves array reference
- default `[]` when absent
- Does NOT omit like optional fields (always present on payload)

Task 2.7 — Update `apps/workflow-engine/src/__tests__/version-resolution.test.ts` — add a regression test that asserts all 6 tiers (`pinned`, `deployment`, `semver-desc`, `draft`, `working-copy-steps`, `working-copy-canvas`) surface `startInputVariables` (values passed through from `conversion.startInputVariables`).

**Files Touched**:

- `apps/workflow-engine/src/lib/execution-payload.ts`
- `apps/workflow-engine/src/lib/version-resolution.ts`
- `apps/workflow-engine/src/routes/workflow-executions.ts`
- `apps/workflow-engine/src/services/trigger-engine.ts`
- `apps/workflow-engine/src/services/trigger-scheduler.ts`
- `apps/workflow-engine/src/handlers/workflow-handler.ts`
- `apps/workflow-engine/src/__tests__/execution-payload.test.ts`
- `apps/workflow-engine/src/__tests__/version-resolution.test.ts`

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/workflow-engine` — 0 errors
- [ ] `pnpm test --filter=@abl/workflow-engine -- execution-payload version-resolution` — all pass
- [ ] `git grep -n 'startInputVariables' apps/workflow-engine/src` shows wiring at ALL sites: canvas-to-steps extraction, version-resolution 6 tiers, 3 route builders, 3 payload-builder call sites, WorkflowExecutionInput, WorkflowExecutionPayload, BuildExecutionPayloadInput. Must show ≥13 non-test hits.
- [ ] No test regressions: `pnpm test --filter=@abl/workflow-engine` — baseline unchanged (700+ passing)

**Test Strategy**:

- Unit: `execution-payload.test.ts` covers pass-through + default.
- Integration: `version-resolution.test.ts` covers 5-tier propagation.
- E2E: Deferred to Phase 8 (field is wired but unused until Phase 4).

**Rollback**: `git revert <sha>` — purely additive, no behavior change.

---

### Phase 3 — Pure Validator + Unit Tests

**Commit type**: `feat`
**Commit scope**: 1 package (`apps/workflow-engine`), 2 files

**Goal**: Ship the pure `validateAndCoerceInput` function with exhaustive unit coverage. Handler still doesn't call it — Phase 4 wires it in.

**Tasks:**

Task 3.1 — Create `apps/workflow-engine/src/validation/start-input-validator.ts`:

- Export `FieldErrorReason`, `FieldError`, `ValidationResult`.
- Implement `validateAndCoerceInput(startInputVariables, triggerPayload)`:
  - Empty/undefined `startInputVariables` → `{ ok: true, coerced: triggerPayload ?? {} }` (pass-through).
  - For each declared var:
    - If `required` and value is `null`/`undefined` → append `{ name, reason: 'REQUIRED' }`.
    - If value present: coerce per declared type:
      - `string`: pass-through if string; if non-string → `TYPE_MISMATCH { expected:'string', got: typeof val }`.
      - `number`: if number → use; if string → `Number(val)`; reject `NaN` as `TYPE_MISMATCH`.
      - `boolean`: if boolean → use; if string matching `/^(true|1|yes)$/i` → `true`; matching `/^(false|0|no)$/i` → `false`; else `TYPE_MISMATCH`.
      - `json`: if string → `JSON.parse` (catch → `JSON_PARSE_ERROR`); if object/array → pass-through.
  - Extra payload fields (not declared) → preserve in `coerced` unchanged.
  - Return `{ ok: false, errors }` if any errors; else `{ ok: true, coerced }`.

Task 3.2 — Create `apps/workflow-engine/src/__tests__/start-input-validator.test.ts` with:

- Empty `startInputVariables` → pass-through.
- Required missing → `REQUIRED`.
- Number coercion — `"42"→42`, `42→42`, `"abc"→TYPE_MISMATCH`.
- Boolean coercion — `"true"/"1"/"YES"/"Yes"→true`, `"false"/"0"/"no"→false`, `"maybe"→TYPE_MISMATCH`, actual `true`/`false` pass-through.
- JSON coercion — `'{"a":1}'→{a:1}`, `'[1,2]'→[1,2]`, `{a:1}` object pass-through, `'not json'→JSON_PARSE_ERROR`.
- String coercion — strings pass-through; number-in-payload flagged `TYPE_MISMATCH`.
- Multiple errors accumulated (not short-circuit).
- Extra payload keys preserved in `coerced`.
- `required:false` + missing → no error, field absent in `coerced`.
- **Default-value regression guard (D-13)**: Given `[{name:'x', type:'number', required:true}]` + payload `{}`, assert result is `{ok:false, errors:[{name:'x', reason:'REQUIRED'}]}`. The `StartInputVariable` type (D-12) has no `defaultValue` field, but even if a future caller passed the canvas-shape object with a `defaultValue` property, the validator MUST ignore it. Include one explicit test passing `[{name:'x', type:'number', required:true, defaultValue:10} as unknown as StartInputVariable]` + empty payload to prove the REQUIRED check still fires (pins the "no default application" behavior).

**Files Touched**:

- `apps/workflow-engine/src/validation/start-input-validator.ts` (new)
- `apps/workflow-engine/src/__tests__/start-input-validator.test.ts` (new)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/workflow-engine` — 0 errors
- [ ] `pnpm test --filter=@abl/workflow-engine -- start-input-validator` — ≥20 cases passing
- [ ] No external package imports in `start-input-validator.ts` (pure function invariant — verify via `grep -n '^import' start-input-validator.ts`; only relative import is `./` or nothing)
- [ ] Validator has zero side effects — asserted by test that runs the function with a frozen input and confirms it returns without mutating

**Test Strategy**:

- Unit: The entire test file is the strategy. No mocks of anything.
- Integration / E2E: N/A this phase.

**Rollback**: `git revert <sha>` — new files only, no existing consumers.

---

### Phase 4 — Handler Start Phase (validate + persist + events)

**Commit type**: `feat`
**Commit scope**: 1 package (`apps/workflow-engine`), ~5 files (including tests)

**Goal**: Wire the validator into `runWorkflow`. Start step becomes a first-class record with validation-aware lifecycle. Validation failures fail the workflow cleanly.

**Tasks:**

**Behavioral delta** — The existing code at `workflow-handler.ts:674-678` creates Start with `status:'completed'` directly on the `stepRecords` entry AND then immediately calls `updateStepStatus('start', 'completed', …)` (line 696-703). After Phase 4, Start is created as `status:'pending'` and transitions `pending → running → completed|failed` via `updateStepStatus`, matching every other step's lifecycle. Any existing test that asserts the legacy immediate-completed pattern must be updated in the same commit. Recommended grep before implementation: `git grep -n "stepId.*start.*completed\|stepRecords.*unshift" apps/workflow-engine/src/__tests__` — update any match to expect the new lifecycle. Per oracle RD1 (no tests currently assert this), expected breakage is zero, but the grep is cheap insurance.

Task 4.1 — In `apps/workflow-engine/src/handlers/workflow-handler.ts`, around line 665-703 (existing synthetic-Start region):

- Compute `startValidation = validateAndCoerceInput(input.startInputVariables, input.triggerPayload)` before creating the execution record.
- Construct initial `stepRecords` including BOTH Start and End entries:
  ```typescript
  const stepRecords = [
    { stepId: 'start', name: 'Start', type: 'start', status: 'pending' },
    ...input.steps.map((s) => ({
      stepId: s.id,
      name: s.name || s.type,
      type: s.type,
      status: 'pending',
    })),
    { stepId: 'end', name: 'End', type: 'end', status: 'pending' },
  ];
  ```
- Call `persistence.createExecution(...)` with this `stepRecords`.
- Emit `publisher.publish(step.started, { stepId:'start', stepType:'start' })`.
- Branch on `startValidation.ok`:
  - **`ok:true`**: `persistence.updateStepStatus('start', 'completed', { input: triggerPayload, output: coerced, durationMs, metrics:{ processingTimeMs } })`; emit `step.completed(start)`; continue to `workflow.started` + step loop.
  - **`ok:false`**: map `FieldError[]` → `mappingErrors: Array<{name, error}>` (no `expression`); `persistence.updateStepStatus('start', 'failed', { input: triggerPayload, error: { code:'INPUT_VALIDATION_FAILED', message: '<N> input fields failed validation' }, mappingErrors, durationMs })`; emit `step.failed(start)`; `persistence.updateExecutionStatus('failed', { error:{code:'WORKFLOW_FAILED', message}, output: buildFailureOutput(...), completedAt })`; emit `workflow.failed`; return `{ status:'failed', context, error, output, startTime, endTime }` WITHOUT running step loop or `buildWorkflowContext` beyond the minimum needed for the return.

Task 4.2 — In `buildWorkflowContext` at line 214-252, add optional 3rd param `coerced?: Record<string, unknown>`:

```typescript
export function buildWorkflowContext(
  input: WorkflowExecutionInput,
  executionId: string,
  coerced?: Record<string, unknown>,
): WorkflowContextData {
  const vars = coerced ?? { ...(input.triggerPayload ?? {}) };
  return {
    /* ... */
    steps: {
      start: {
        output: coerced ?? input.triggerPayload,
        status: 'completed',
        input: input.triggerPayload,
        completedAt: new Date().toISOString(),
      },
    },
    vars,
  };
}
```

Backward-compat: existing tests pass no 3rd arg → behavior identical.

Task 4.3 — In `runWorkflow`, after `ok:true` Start persistence: `ctx = buildWorkflowContext(input, executionId, startValidation.coerced)`.

Task 4.4 — Create `apps/workflow-engine/src/__tests__/workflow-handler-start-end.test.ts` (Start-phase half only this commit):

- Test: valid input → execution has Start step with `input=raw payload`, `output=coerced`, `status=completed`, `durationMs>0`, `metrics.processingTimeMs>=0`, `mappingErrors` absent. Mongo-backed integration using `setup-mongo.ts` helper.
- Test: missing required field → execution `status=failed`, Start step `status=failed`, `mappingErrors` array includes `{ name:'email', reason:'REQUIRED' }`, no other steps run, workflow-level `output._status===1`.
- Test: SSE sequence — capture publisher calls; assert order: `step.started(start)` → `step.completed(start)` → `workflow.started` on happy path; `step.started(start)` → `step.failed(start)` → `workflow.failed` on validation failure (no `workflow.started`).
- Test: coerced vars available in ctx.vars — a downstream step expression `{{vars.amount}}` with declared `amount: number` + payload `"100"` resolves to `100` (number).

**Files Touched**:

- `apps/workflow-engine/src/handlers/workflow-handler.ts`
- `apps/workflow-engine/src/__tests__/workflow-handler-start-end.test.ts` (new, Start half)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/workflow-engine` — 0 errors
- [ ] `pnpm test --filter=@abl/workflow-engine -- workflow-handler-start-end` — all Start-phase cases pass
- [ ] `pnpm test --filter=@abl/workflow-engine` — FULL suite; no pre-existing test regressions
- [ ] Manual grep: `publisher.publish(.*step\.(started|completed|failed).*stepId.*['"]start['"])` must appear in handler
- [ ] Validation-failure path does NOT execute the step queue loop (verified by integration test: no HTTP step dispatch when Start fails)

**Test Strategy**:

- Integration: `workflow-handler-start-end.test.ts` with real Mongo (via `MongoMemoryServer`) + in-memory publisher fake + in-memory persistence fake OR real `ExecutionStore` wired to test Mongo — match existing `workflow-handler.test.ts` pattern.
- No mocks of `@agent-platform/*`, `@abl/*`, or relative modules.

**Rollback**: `git revert <sha>` — Start phase is self-contained; End still uses the old catch-and-nullify path from Phase 5, which lands next. In this commit, End is still the old silent-null behavior — that's the well-defined intermediate state.

---

### Phase 5 — Handler End Phase (evaluate-all + persist + fail on mapping error per HLD D-17)

**Commit type**: `feat`
**Commit scope**: 1 package (`apps/workflow-engine`), ~3 files

**Goal**: Replace the silent-null mapping failure at `workflow-handler.ts:1357-1372` with first-class End step persistence and fail-on-any-mapping-error semantics.

**Tasks:**

Task 5.1 — In `apps/workflow-engine/src/handlers/workflow-handler.ts:1357-1372`, rewrite:

- Before mapping evaluation: `endStartedAt = Date.now()`; `updateStepStatus('end', 'running', { input: input.outputMappings ?? [] })`; emit `step.started(end)`.
- Evaluate all mappings (NO short-circuit):
  ```typescript
  const resolvedOutput: Record<string, unknown> = { _status: 0 };
  const mappingErrors: Array<{ name: string; expression: string; error: string }> = [];
  for (const m of input.outputMappings ?? []) {
    if (!m.expression) {
      resolvedOutput[m.name] = null;
      continue;
    }
    try {
      resolvedOutput[m.name] = resolveExpressionTyped(m.expression, ctx);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      mappingErrors.push({ name: m.name, expression: m.expression, error: errMsg });
      resolvedOutput[m.name] = null;
    }
  }
  const endDurationMs = Date.now() - endStartedAt;
  ```
- Branch:
  - `mappingErrors.length === 0` → `updateStepStatus('end', 'completed', { input: input.outputMappings ?? [], output: resolvedOutput, durationMs: endDurationMs, metrics:{ processingTimeMs: endDurationMs } })`; emit `step.completed(end)`; continue to existing `updateExecutionStatus('completed', { output: resolvedOutput, ... })` + callback.
  - `mappingErrors.length > 0` → `endError = { code:'OUTPUT_MAPPING_FAILED', message: <N> of <M> output mappings failed }`; `updateStepStatus('end', 'failed', { input: input.outputMappings ?? [], output: resolvedOutput, error: endError, mappingErrors, durationMs: endDurationMs, metrics:{ processingTimeMs: endDurationMs } })`; emit `step.failed(end)` with `errorCode` + `error`; `throw new WorkflowStepError(StepErrorCode.STEP_FAILED, endError.message)`.
- Existing top-level catch (line 1427) handles the throw: sets workflow `status=failed`, `output=buildFailureOutput`, emits `workflow.failed`, enqueues failed callback. No changes needed there.

Task 5.2 — In `workflow-handler-start-end.test.ts`, add End-phase cases:

- Happy path: End step is `completed`, `input===outputMappings`, `output===resolvedOutput` with `_status:0`, `mappingErrors` absent, `durationMs>=0`, SSE emits `step.started(end)` → `step.completed(end)` → `workflow.completed`.
- Bad expression: single mapping `{total: '{{steps.nonexistent.output.foo}}'}` → End `status=failed`, `mappingErrors.length===1`, `mappingErrors[0].name==='total'`, workflow `status=failed`, workflow-level `output={_status:1, _reason:<msg>}`, callback payload carries the failure.
- Partial failures aggregated: 3 mappings, one fails → `mappingErrors.length===1`, `output` retains the 2 valid values + `null` for the failed name. Workflow `status=failed` (strict per HLD D-17).
- Empty `outputMappings`: End `status=completed`, `output: {_status: 0}`, `mappingErrors` absent.

Task 5.3 — (Optional regression test) Grep for any integration test that still asserts the silent-null behavior — none expected per oracle RD1/IS3, but verify.

**Files Touched**:

- `apps/workflow-engine/src/handlers/workflow-handler.ts`
- `apps/workflow-engine/src/__tests__/workflow-handler-start-end.test.ts` (expand)
- (Optional) `apps/workflow-engine/src/__tests__/workflow-output-status-convention.test.ts` — only if an existing case now asserts different behavior; otherwise untouched.

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/workflow-engine` — 0 errors
- [ ] `pnpm test --filter=@abl/workflow-engine -- workflow-handler-start-end workflow-output-status-convention` — all pass
- [ ] `pnpm test --filter=@abl/workflow-engine` — full suite; confirm no regressions
- [ ] `git grep 'resolvedOutput\[.*\] = null' apps/workflow-engine/src/handlers/workflow-handler.ts` — should now appear only in the `mappingErrors`-collecting branch (per-mapping null for failed mappings), NOT as the silent-swallow catch

**Test Strategy**:

- Integration: expanded `workflow-handler-start-end.test.ts` — same Mongo/publisher approach as Phase 4.

**Rollback**: `git revert <sha>` — End-phase rewrite is isolated; reverting restores silent-null behavior (known prior state).

---

### Phase 6 — Execute Route Preflight Validation

**Commit type**: `feat`
**Commit scope**: 1 package (`apps/workflow-engine`), ~3 files

**Goal**: Ship the execute-route preflight 4xx for synchronous UX. Handler-side remains canonical.

**Tasks:**

Task 6.1 — In `apps/workflow-engine/src/routes/workflow-executions.ts` inside the `POST /execute` handler, AFTER version resolution (line 500) and BEFORE `buildWorkflowExecutionPayload` (line 505):

```typescript
const validation = validateAndCoerceInput(executionDefinition.startInputVariables, triggerPayload);
if (!validation.ok) {
  return res.status(400).json({
    success: false,
    error: {
      code: 'INPUT_VALIDATION_FAILED',
      message: `${validation.errors.length} input field(s) failed validation`,
      fields: validation.errors,
    },
  });
}
```

Note: we pass the RAW payload to the handler (not coerced) — handler re-runs validation as the canonical check, and the output-vars get coerced there. This keeps validation logic in one place.

Task 6.2 — Create `apps/workflow-engine/src/__tests__/execute-route-preflight.test.ts` OR append to `route-integration.test.ts` (match existing convention):

- Valid input → 202 Accepted, execution started.
- Missing required field → 400 with `INPUT_VALIDATION_FAILED`, `fields[0].name` correct, `fields[0].reason='REQUIRED'`, NO Restate `startWorkflow` call made (verify via DI-injected fake restate client).
- Type mismatch → 400 with `fields[0].reason='TYPE_MISMATCH'`, `expected`/`got` populated.
- Empty `startInputVariables` → 202 (pass-through).

Task 6.3 — Sanity grep to confirm no other execute-route callers bypass this (cancel route, etc. — they don't have a payload to validate; should not be affected).

**Files Touched**:

- `apps/workflow-engine/src/routes/workflow-executions.ts`
- `apps/workflow-engine/src/__tests__/execute-route-preflight.test.ts` (new) OR extend `route-integration.test.ts`

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/workflow-engine` — 0 errors
- [ ] New route tests pass
- [ ] Full suite passes
- [ ] `git grep -n 'INPUT_VALIDATION_FAILED' apps/workflow-engine/src` shows both the route (preflight) and the handler (canonical) — both return the same error code

**Test Strategy**:

- Integration: Express route tests via `supertest` with a real router instance; DI fakes for `restateClient` (third-party, allowed via DI per CLAUDE.md) + in-memory `workflowModel` + `workflowVersionModel`.

**Rollback**: `git revert <sha>` — route change is additive; removing it falls back to handler-side validation (still correct, just slower UX).

---

### Phase 7 — Studio Cleanup (remove fabrications)

**Commit type**: `refactor` (significant deletions — ~50 LOC removed; cannot be `feat` per deletion-ratio guard)
**Commit scope**: 1 package (`apps/studio`), ~3 files

**Goal**: Make Studio surfaces render engine-authoritative data only. Remove the two client-side fabrications and their unused props.

**Tasks:**

Task 7.1 — In `apps/studio/src/api/workflows.ts`, add `mappingErrors?: Array<{ name: string; expression?: string; error: string }>` to the existing `ExecutionStepResult` interface.

Task 7.2 — In `apps/studio/src/components/workflows/canvas/panels/DebugFlowLog.tsx`:

- Remove the `executionOutput`, `executionStatus`, and `inputValues` props from `DebugFlowLogProps` (lines 11-19).
- Remove the synthetic-Start fabrication (lines 53-69, including the `hasStartStep` branch).
- Remove the synthetic-End fabrication (lines 71-111, including `isTerminal` computation and `pendingEndStep` lookup).
- Retain the `isRunning` prop and the `result.filter((s) => s.status !== 'pending')` + sort-by-`startedAt` logic.
- Keep Start-first sort (by `nodeType==='start'`) — still useful for engine-authoritative data since Start's timestamp is often identical to the next step.

Task 7.3 — In `apps/studio/src/components/workflows/canvas/panels/WorkflowDebugPanel.tsx:351-361`, remove `inputValues`, `executionOutput`, `executionStatus` props from the `<DebugFlowLog />` call site.

Task 7.4 — Confirm via grep that no other file passes these props to `DebugFlowLog`:

```sh
grep -rn 'DebugFlowLog' apps/studio/src
```

Task 7.5 — Run Studio lint + type-check: `pnpm --filter=@abl/studio tsc --noEmit && pnpm --filter=@abl/studio lint`.

**Files Touched**:

- `apps/studio/src/api/workflows.ts`
- `apps/studio/src/components/workflows/canvas/panels/DebugFlowLog.tsx`
- `apps/studio/src/components/workflows/canvas/panels/WorkflowDebugPanel.tsx`

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/studio` — 0 errors
- [ ] `pnpm --filter=@abl/studio tsc --noEmit` — 0 errors
- [ ] `git grep -n 'executionOutput\|executionStatus' apps/studio/src/components/workflows/canvas/panels/DebugFlowLog.tsx` — 0 matches (fully removed)
- [ ] `git grep -n 'DebugFlowLog' apps/studio/src` — exactly 2 hits (the component export + the single call site)
- [ ] Visual smoke: start dev server, run a workflow with input vars + output mapping, verify Debug panel shows Start step with coerced output and End step with resolved mapping output; no duplicate Start/End entries

**Test Strategy**:

- Typecheck + lint.
- Visual smoke (manual, logged in testing doc).

**Rollback**: `git revert <sha>` — rollback restores client fabrications. During brief window where only Studio is reverted, Debug panel will show engine-authoritative Start/End from Phase 4/5 with the client fabrication's guard preventing duplicates.

---

### Phase 8 — System (E2E) Test Suite

**Commit type**: `test`
**Commit scope**: 1 package (`apps/workflow-engine`), 1 file

**Goal**: Lock in the full feature behavior across multiple fire paths with real persistence.

**Naming convention note**: This repo's `system-*.test.ts` files (see `system-handler.test.ts`, `system-persistence.test.ts`) use REAL MongoDB via `helpers/setup-mongo.ts` — these are the true E2E tests. The `e2e-*.test.ts` files (`e2e-basic.test.ts`, `e2e-medium.test.ts`, `e2e-advanced.test.ts`) despite the name use DI fakes for persistence and are really integration tests. New tests for this feature use the `system-*` pattern because they require real Mongo to verify Start/End step records land on `execution.nodeExecutions[]` with `mappingErrors` and correct lifecycle.

**Tasks:**

Task 8.1 — Create `apps/workflow-engine/src/__tests__/system-start-end-steps.test.ts` implementing HLD Section 10 scenarios E2E-1..E2E-5:

- **E2E-1 Happy path with coercion**: Canvas with `email: string required`, `amount: number required`, 1 HTTP + 1 function user step, 1 output mapping `{total: '{{vars.amount}}'}`. POST `/execute` with `{email:"a@b", amount:"100"}`. Assert `GET /executions/:id` returns 4-step array (start, http, function, end) with `start.output.amount === 100` (number) and `end.output.total === 100`.
- **E2E-2 Missing required via execute route**: Same canvas, POST with `{amount:"100"}`. Assert 400 with `INPUT_VALIDATION_FAILED`, `fields` contains `{name:'email', reason:'REQUIRED'}`, no execution record created (via `GET /executions`).
- **E2E-3 Missing required via webhook trigger**: Register webhook trigger; POST webhook URL with `{amount:"100"}`. Assert execution created with `status:failed`, Start step `status:failed`, `workflow.failed` SSE event captured.
- **E2E-4 Bad output mapping expression**: Canvas with `{total: '{{steps.nonexistent.output.foo}}'}`. POST execute with valid input. Assert execution `failed`, End step `failed` with `mappingErrors[0].name==='total'`, workflow-level `output._status===1`.
- **E2E-5 Multi-mapping partial failure**: Canvas with 3 mappings, one referencing missing path. Assert `mappingErrors.length===1`, `output` contains 2 valid values + 1 null, workflow `status===failed`.

Task 8.2 — Follow `system-handler.test.ts` / `system-persistence.test.ts` conventions: real `ExecutionStore` backed by `MongoMemoryServer` (via `helpers/setup-mongo.ts`); real `publisher` that captures events into an in-memory array for assertion; HTTP and third-party calls stubbed via `vi.stubGlobal('fetch', vi.fn())` per the existing pattern. Do NOT use `vi.mock` of `@agent-platform/*` or `@abl/*` packages. Restate is invoked via direct `runWorkflow()` calls (the standard system-test entry point).

Task 8.3 — Test-file-level assertion: import `validateAndCoerceInput` directly and run a sanity check on the coercion logic to anchor the E2E tests to the unit tests (shared behavior contract).

**Files Touched**:

- `apps/workflow-engine/src/__tests__/system-start-end-steps.test.ts` (new)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/workflow-engine` — 0 errors
- [ ] `pnpm test --filter=@abl/workflow-engine -- system-start-end-steps` — all 5 scenarios pass
- [ ] Full `pnpm test --filter=@abl/workflow-engine` suite passes with no regressions
- [ ] Each scenario reads back via real `ExecutionStore.getExecution` (or equivalent) to assert step-record shape actually lands on Mongo (not just handler return value)
- [ ] `git grep "vi.mock.*@agent-platform\|vi.mock.*@abl\|vi.mock.*['\"]\\.\\." apps/workflow-engine/src/__tests__/system-start-end-steps.test.ts` returns zero hits

**Test Strategy**:

- System-level: real Mongo (MongoMemoryServer via `setup-mongo.ts`), real `ExecutionStore`, in-memory captured publisher, DI fakes only for external HTTP (`globalThis.fetch`) and third-party services — matches `system-handler.test.ts` pattern exactly.
- No `vi.mock` of internal `@agent-platform/*`, `@abl/*`, or relative imports.

**Rollback**: `git revert <sha>` — test-only, no production impact.

---

## 4. Wiring Checklist

CRITICAL: Every new/modified artifact must be reachable from its callers. This table enumerates every handoff site (RD4 flagged this as the highest-risk surface).

### `startInputVariables` propagation (16 sites)

- [ ] `canvas-to-steps.ts:358` — extracts into `CanvasConversionResult.startInputVariables` (already present; Phase 1 promotes to named type)
- [ ] `canvas-to-steps.ts:151-156` `EMPTY_RESULT` — already includes `startInputVariables: []` (no change needed; verify)
- [ ] `version-resolution.ts` tier `pinned` (line 115-123) — propagate `conversion.startInputVariables` — Phase 2
- [ ] `version-resolution.ts` tier `deployment` (line 162-170) — Phase 2
- [ ] `version-resolution.ts` tier `semver-desc` (line 205-213) — Phase 2
- [ ] `version-resolution.ts` tier `draft` (line 234-242) — Phase 2
- [ ] `version-resolution.ts` tier `working-copy-steps` (line 252-260) — reads `canvasConversion.startInputVariables` — Phase 2
- [ ] `version-resolution.ts` tier `working-copy-canvas` (line 264-272) — reads `canvasConversion.startInputVariables` — Phase 2
- [ ] `workflow-executions.ts` `buildWorkingCopyExecutionDefinition` — Phase 2
- [ ] `workflow-executions.ts` `buildVersionExecutionDefinition` — Phase 2
- [ ] `workflow-executions.ts` `buildDefaultVersionExecutionDefinition` — Phase 2
- [ ] `workflow-executions.ts:505-523` — execute route passes `executionDefinition.startInputVariables` into `buildWorkflowExecutionPayload` — Phase 2
- [ ] `trigger-engine.ts:555` — trigger fires pass resolved `startInputVariables` — Phase 2
- [ ] `trigger-scheduler.ts:263` — cron/poll jobs pass resolved `startInputVariables` — Phase 2
- [ ] `execution-payload.ts:75-96` — builder defaults to `[]`, preserves passthrough — Phase 2
- [ ] `workflow-handler.ts:59-77` — `WorkflowExecutionInput` field defined — Phase 2
- [ ] `workflow-handler.ts` runWorkflow — actually consumes via `validateAndCoerceInput` — Phase 4

### `mappingErrors` persistence (end-to-end)

- [ ] `packages/database/src/models/workflow-execution.model.ts` — Mongoose schema field added — Phase 1
- [ ] `packages/database/src/models/workflow-execution.model.ts` — `INodeExecution` interface — Phase 1
- [ ] `workflow-handler.ts:114-124` — `ExecutionPersistence.updateStepStatus` data-bag type — Phase 1
- [ ] `workflow-handler.ts` Start-failure path writes `mappingErrors` — Phase 4
- [ ] `workflow-handler.ts` End-failure path writes `mappingErrors` — Phase 5
- [ ] `apps/studio/src/api/workflows.ts` — `ExecutionStepResult.mappingErrors?` — Phase 7
- [ ] Studio `ExecutionStepResult` exposes `mappingErrors` so Raw JSON panel renders per-mapping detail; `StepLogItem` shows the End step's `error.code`/`error.message` summary (no dedicated `mappingErrors` UI in this phase — inspection via Raw JSON is sufficient per HLD) — Phase 7

### SSE events on `workflow:<t>:execution:<e>:status` channel

- [ ] `step.started` with `stepId:'start', stepType:'start'` — Phase 4
- [ ] `step.completed` or `step.failed` with `stepId:'start'` — Phase 4
- [ ] `step.started` with `stepId:'end', stepType:'end'` — Phase 5
- [ ] `step.completed` or `step.failed` with `stepId:'end'` — Phase 5
- [ ] Existing `workflow.started` / `workflow.completed` / `workflow.failed` events unchanged — verified

### Initial `stepRecords` array

- [ ] `workflow-handler.ts:666-679` — includes `{stepId:'start'}` entry (already present; Phase 4 retains) and NEW `{stepId:'end'}` entry — Phase 4

### New module exports

- [ ] `StartInputVariable` exported from `canvas-to-steps.ts` — Phase 1
- [ ] `FieldError`, `FieldErrorReason`, `ValidationResult`, `validateAndCoerceInput` exported from `validation/start-input-validator.ts` — Phase 3

### Studio prop cleanup

- [ ] `DebugFlowLogProps` no longer declares `executionOutput`, `executionStatus`, `inputValues` — Phase 7
- [ ] `WorkflowDebugPanel.tsx:351-361` no longer passes those props — Phase 7

### Test file registration

- [ ] New `start-input-validator.test.ts` picked up by Vitest config (auto-discover via `__tests__/*.test.ts` glob — no config change required; verify via `pnpm test --filter=@abl/workflow-engine -- --listFiles 2>/dev/null || pnpm test --filter=@abl/workflow-engine --reporter=verbose | head -20`)
- [ ] `workflow-handler-start-end.test.ts` auto-discovered
- [ ] `system-start-end-steps.test.ts` auto-discovered

---

## 5. Cross-Phase Concerns

### Database Migrations

**None required.** The Mongoose schema change (adding `mappingErrors: { type: [Schema.Types.Mixed] }`) is backward-compatible — existing documents without the field simply read as `undefined`. No backfill, no index change. Since the schema defaults to `strict: true`, the field must be declared before any code writes to it (landing in Phase 1, ahead of Phase 4/5 writes).

### Feature Flags

**None.** Per HLD oracle D-9 (direct cutover) and CLAUDE.md "no backwards-compat shims."

### Configuration Changes

None. No new env vars, no config keys.

### Build order

Turbo handles ordering. `apps/workflow-engine/package.json` declares a workspace dep on `@agent-platform/database`, so `pnpm build --filter=@abl/workflow-engine` rebuilds the database package first when Phase 1 lands. No manual orchestration needed.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 8 phases committed with exit criteria met
- [ ] E2E scenarios 1-5 from HLD Section 10 implemented and passing
- [ ] Integration tests in `workflow-handler-start-end.test.ts` passing
- [ ] Unit tests in `start-input-validator.test.ts` cover all coercion branches + all error classifications (≥20 cases)
- [ ] Full `pnpm build && pnpm test` passes (no regressions in the 700+ pre-existing workflow-engine tests or in Studio)
- [ ] `git grep 'vi.mock' apps/workflow-engine/src/__tests__/workflow-handler-start-end.test.ts apps/workflow-engine/src/__tests__/system-start-end-steps.test.ts apps/workflow-engine/src/__tests__/start-input-validator.test.ts` returns zero hits (no mocks of platform components)
- [ ] `git grep '// removed\|// was here\|// deprecated' apps/workflow-engine/src apps/studio/src/components/workflows` returns zero hits (no tombstone comments)
- [ ] Studio `DebugFlowLog.tsx` shows ENGINE-authoritative Start + End records for a new execution (manual smoke)
- [ ] Raw JSON panel (`WorkflowDebugPanel`) and Monitor tab step count both show Start + End consistent with Debug panel (the original user-reported bug is verified fixed)
- [ ] `/post-impl-sync workflow-start-end-first-class-steps` runs to completion and updates parent `docs/features/workflows.md` + `docs/testing/workflows.md` coverage matrix
- [ ] **Tool-binding regression guard (D-12, D-13)**: workflow-as-tool path is unchanged. Manual check: create a workflow with declared `inputVariables` and register it as an agent tool; confirm the agent sees the same parameter list before and after this feature lands. Grep guard — `git grep 'start.config.inputVariables\|inputVariables.*start.config' apps/runtime/src apps/studio/src` should show the same call sites (±0) as pre-change; removal of any existing call site is a regression.

---

## 7. Open Questions

1. **Preflight ordering confirmed** (was HLD OQ-1). Oracle TD4 confirmed: auth → workflow lookup → Zod parse → version resolution → preflight validate. Resolved.

(No remaining open questions — all 25 LLD clarifying questions resolved by oracle.)

---

## 8. References

- Parent feature spec: `docs/features/workflows.md`
- Parent HLD: `docs/specs/workflows.hld.md`
- Feature HLD: `docs/specs/workflow-start-end-first-class-steps.hld.md`
- HLD oracle log: `docs/sdlc-logs/workflow-start-end-first-class-steps/hld.log.md`
- LLD oracle log: `docs/sdlc-logs/workflow-start-end-first-class-steps/lld.log.md`
- Related LLDs for pattern reference:
  - `docs/plans/2026-04-14-workflow-versioning-impl-plan.md`
  - `docs/plans/2026-04-18-workflow-webhook-versioning-impl-plan.md`
- Platform invariants: `CLAUDE.md`
- SDLC pipeline: `docs/sdlc/pipeline.md`
