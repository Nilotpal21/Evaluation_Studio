# LLD Oracle Log: First-Class Start/End Steps

> Feature: `workflow-start-end-first-class-steps`
> Phase: LLD (Phase 4)
> Date: 2026-04-19
> Oracle: product-oracle

## Context Consulted

- `docs/specs/workflow-start-end-first-class-steps.hld.md` (HLD, all 17 decisions locked)
- `docs/sdlc-logs/workflow-start-end-first-class-steps/hld.log.md` (D-1..D-17)
- `docs/features/workflows.md` (parent spec, BETA, Feature ID #48)
- `CLAUDE.md` (commit-scope-guard, deletion-ratio-guard, test architecture, incremental typecheck)
- `docs/sdlc/pipeline.md` (slice-by-slice, decision protocol, commit conventions)
- `apps/workflow-engine/src/handlers/workflow-handler.ts` (L59-77, L108-125, L214-252, L580, L666-708, L1357-1493, L1596-1650)
- `apps/workflow-engine/src/handlers/canvas-to-steps.ts` (L27-78, L121-156, L340-358)
- `apps/workflow-engine/src/lib/execution-payload.ts` (full file, L1-97)
- `apps/workflow-engine/src/lib/version-resolution.ts` (full file, L81-89, L98-273)
- `apps/workflow-engine/src/routes/workflow-executions.ts` (L130-136, L153-285, L387-534)
- `apps/workflow-engine/src/services/trigger-engine.ts` (L540-589)
- `apps/workflow-engine/src/services/trigger-scheduler.ts` (L250-308)
- `packages/database/src/models/workflow-execution.model.ts` (L55-87, L122-173)
- `apps/studio/src/api/workflows.ts` (L152-183)
- `apps/studio/src/components/workflows/canvas/panels/DebugFlowLog.tsx` (full file)
- `apps/studio/src/components/workflows/canvas/panels/WorkflowDebugPanel.tsx` (L9, L128-164, L345-361)
- `apps/studio/src/components/workflows/canvas/config/StartNodeConfig.tsx` (L14-19)
- `packages/shared-kernel/src/types/workflow-types.ts` (L1-30)
- `docs/plans/2026-04-14-workflow-versioning-impl-plan.md` (pattern reference)
- `docs/plans/2026-04-18-workflow-webhook-versioning-impl-plan.md` (pattern reference)
- Test files: `apps/workflow-engine/src/__tests__/` — all 63 test files grepped
- Grep: `steps.length`, `nodeExecutions.length`, `toHaveLength` across all test files
- Grep: `resolvedOutput.*null`, `mapping.*null` across all test files
- Grep: `_status`, `buildFailureOutput` in `workflow-output-status-convention.test.ts`
- Grep: `DebugFlowLog` callsites in Studio

---

## Answers

### IS1: Phase order and commit bundling

**Classification**: DECIDED
**Answer**: Implement in strict dependency order with 7-8 commits, NOT the HLD's suggested 4. The commit-scope-guard (<=40 files, <=3 packages) and deletion-ratio-guard (<30% for feat commits) demand finer slicing. Recommended commit sequence:

1. **Schema + types** (`refactor`): `INodeExecution.mappingErrors` + `NodeExecutionSchema.mappingErrors` in `packages/database`, `StartInputVariable` named export in `canvas-to-steps.ts`, `ExecutionPersistence.updateStepStatus` data-bag type update in `workflow-handler.ts`. 2 packages, ~6 files, additive.
2. **Payload wiring** (`feat`): `startInputVariables` propagation through `ResolvedWorkflowDefinition`, `ExecutionDefinition`, `BuildExecutionPayloadInput`, `WorkflowExecutionPayload`, `WorkflowExecutionInput`, all `build*ExecutionDefinition` functions, trigger-engine, trigger-scheduler call sites. 1 package (workflow-engine), ~6 files, additive.
3. **Validator** (`feat`): New `apps/workflow-engine/src/validation/start-input-validator.ts` + unit tests in the same commit (slice-by-slice per pipeline.md). 1 package, ~2 files, additive.
4. **Handler Start phase** (`feat`): Modify `runWorkflow()` to validate/coerce at Start, persist Start step with lifecycle events. Update `buildWorkflowContext` to accept coerced vars. + integration tests. 1 package, ~3-5 files, additive (existing synthetic Start is replaced but line-count delta is near-net-positive).
5. **Handler End phase** (`feat`): End step record in initial stepRecords, End phase evaluation with `mappingErrors`, lifecycle events. + integration tests. 1 package, ~3-5 files.
6. **Route preflight** (`feat`): Preflight 400 in `workflow-executions.ts:execute` handler. + route-level tests. 1 package, ~2-3 files.
7. **Studio cleanup** (`refactor`): Remove DebugFlowLog fabrications, remove `executionOutput`/`executionStatus` props, add `mappingErrors` to `ExecutionStepResult`. 1 package (studio), ~3 files. Use `refactor()` type because it has significant deletions.
8. **E2E tests** (`test`): E2E tests hitting real HTTP execute route. 1 package, ~1-2 files.

**Source**: CLAUDE.md commit-scope-guard (<=40 files, <=3 packages), deletion-ratio-guard (<30% for feat), pipeline.md slice-by-slice. Pattern: `docs/plans/2026-04-18-workflow-webhook-versioning-impl-plan.md` shipped as 6+ commits.
**Confidence**: HIGH

---

### IS2: TDD vs tests-after

**Classification**: DECIDED
**Answer**: For `validateAndCoerceInput` (pure function): **write function + tests in the same commit** (Phase 3 above). TDD is a methodology preference not mandated by CLAUDE.md; pipeline.md mandates "implement + test in same slice" which is satisfied either way. The pure function is simple enough that simultaneous authoring is natural.

For handler changes (Start/End phases): **write implementation + integration tests in the same commit per phase** (Phases 4, 5 above). Integration tests need real Mongo via `MongoMemoryServer` (pattern from `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts`). Pipeline.md: "One commit per implementation slice = code + tests."

**Source**: `docs/sdlc/pipeline.md` Slice-by-Slice Implementation: "Tests and code ship together: Never commit implementation without its tests."
**Confidence**: HIGH

---

### IS3: Existing tests asserting silent-null end-mapping behavior

**Classification**: ANSWERED
**Answer**: **Zero tests assert the current silent-null behavior.** Grep for `resolvedOutput.*null`, `mapping.*null`, `catch.*null`, and all end-mapping-related patterns in `apps/workflow-engine/src/__tests__/` returned zero matches. The `workflow-output-status-convention.test.ts` tests only check `_status: 0` on success and `_status: 1` on failure — they don't test individual mapping resolution failures. The current `catch { resolvedOutput[mapping.name] = null; }` at `workflow-handler.ts:1368-1370` has zero test coverage.

No lockstep test updates are needed for the silent-null inversion because no tests assert it today.

**Source**: Grep across all 63 test files in `apps/workflow-engine/src/__tests__/`.
**Confidence**: HIGH

---

### IS4: Existing tests asserting step count

**Classification**: ANSWERED
**Answer**: **One test asserts step count.** `canvas-to-steps.test.ts:1070` has `expect(result.steps).toHaveLength(1)`. This tests `CanvasConversionResult.steps` (the converted step array), NOT `execution.steps` (persisted nodeExecutions). The `CanvasConversionResult.steps` array explicitly excludes start/end nodes (`canvas-to-steps.ts:196-201` skip), and that behavior is NOT changing in this feature (HLD Option B keeps them out of the step array). So this test will NOT break.

No tests in the test suite assert `execution.steps.length === N` or `nodeExecutions.length`. The `workflow-handler.test.ts` and `workflow-output-status-convention.test.ts` tests check `result.output` and `result.status` but do not assert step record counts. Grep for `steps.length`, `nodeExecutions.length`, and `toHaveLength` across all tests returned only the one canvas-to-steps hit.

**Plan**: No prep commit needed. The End step record addition will not break existing tests.

**Source**: Grep across all 63 test files. `canvas-to-steps.test.ts:1070` is the only hit and it tests the wrong layer.
**Confidence**: HIGH

---

### IS5: Where should `StartInputVariable` live?

**Classification**: DECIDED
**Answer**: **Keep in `canvas-to-steps.ts` and promote to named export.** Per the HLD (Section 6, final paragraph): "Lives in `canvas-to-steps.ts` (currently inline) -- promote to named `export` so it's importable by `execution-payload.ts`, `workflow-handler.ts`, and the new validator."

Rationale for NOT moving to `packages/shared-kernel/src/types/workflow-types.ts`:

1. HLD I1 confirmed: all consumers (`WorkflowExecutionInput`, `BuildExecutionPayloadInput`, `WorkflowExecutionPayload`) are internal to `apps/workflow-engine`. No external package needs the type.
2. Moving to shared-kernel adds a cross-package type dependency for zero consumer benefit.
3. The Studio `StartNodeConfig.tsx:14-19` local interface stays local -- Studio never imports engine types directly. The type shapes are structurally compatible (both have `{name, type, required}`) but are not the same identity.
4. CLAUDE.md: "Prefer the simpler option -- less moving parts, fewer new abstractions."

**Source**: HLD Section 6, HLD oracle log I1.
**Confidence**: HIGH

---

### TD1: `validateAndCoerceInput` return shape and `FieldError` type

**Classification**: DECIDED
**Answer**: The function signature and `FieldError` type should be:

```typescript
// apps/workflow-engine/src/validation/start-input-validator.ts

export interface FieldError {
  name: string;
  reason: 'REQUIRED' | 'TYPE_MISMATCH' | 'JSON_PARSE_ERROR';
  expected?: string;
  got?: string;
}

export type ValidationResult =
  | { ok: true; coerced: Record<string, unknown> }
  | { ok: false; errors: FieldError[] };

export function validateAndCoerceInput(
  startInputVariables: StartInputVariable[],
  triggerPayload: Record<string, unknown>,
): ValidationResult;
```

`FieldError` lives co-located with the validator function in `start-input-validator.ts` and is exported. The route preflight (Phase 6) also uses it for the 400 response body. The handler also uses it for the Start step's `mappingErrors` persistence (reusing `FieldError` mapped to the `{name, expression?, error}` persistence shape by converting `reason` + `expected`/`got` into a human-readable `error` string at the persistence site).

The HLD Section 6 error response shows `fields: [{name, reason, expected?, got?}]` for the 400 shape, confirming this exact structure.

**Source**: HLD Section 6 error responses, HLD Section 10 test strategy.
**Confidence**: HIGH

---

### TD2: Mongoose schema -- `Schema.Types.Mixed` vs typed sub-schema

**Classification**: DECIDED
**Answer**: **Use `Schema.Types.Mixed` array**, exactly as the HLD specifies: `mappingErrors: { type: [Schema.Types.Mixed] }`.

Rationale:

1. The HLD explicitly says `Schema.Types.Mixed` (Section 5).
2. The `mappingErrors` field carries two different shapes: Start step uses `{name, reason, expected?, got?}` (no `expression`), End step uses `{name, expression, error}`. A typed sub-schema would need to accommodate both with optionals, adding Mongoose overhead for no query benefit (this field is never queried/indexed).
3. The `NodeExecutionSchema` already uses `Schema.Types.Mixed` for `consoleLogs`, `iterationResults`, `input`, `output`, `callbackPayload` (lines 159-170). This is the established pattern for unindexed nested data.
4. The `NodeExecutionErrorSchema` typed sub-schema pattern (`{code, message, httpStatus?, responseBody?}`) is used because `error` is a fixed shape used across ALL step types. `mappingErrors` is a variable-shape field used only by Start/End.

**Source**: HLD Section 5 (explicitly mandates Mixed), `packages/database/src/models/workflow-execution.model.ts:133-173` (existing Mixed patterns).
**Confidence**: HIGH

---

### TD3: `buildWorkflowContext` API -- new `coerced` parameter vs replace `triggerPayload`

**Classification**: DECIDED
**Answer**: **Add a new `coerced?: Record<string, unknown>` parameter to `buildWorkflowContext`.** When provided, use it for `vars` (instead of `triggerPayload`). This is cleaner than mutating `input.triggerPayload` before passing it.

Exact change:

```typescript
export function buildWorkflowContext(
  input: WorkflowExecutionInput,
  executionId: string,
  coerced?: Record<string, unknown>,
): WorkflowContextData {
  return {
    // ... existing fields ...
    steps: {
      start: {
        output: coerced ?? input.triggerPayload, // coerced when available
        status: 'completed',
        input: input.triggerPayload, // always raw for debug visibility
        completedAt: new Date().toISOString(),
      },
    },
    vars: { ...(coerced ?? input.triggerPayload ?? {}) },
  };
}
```

Backward compat: when `coerced` is undefined (all existing callers, tests), behavior is identical to today. The only caller that passes `coerced` is the new Start phase in `runWorkflow()`. HLD Section 3 data flow confirms: "ctx = buildWorkflowContext(input, executionId, coerced)."

The `start.input` stays as raw `triggerPayload` for debug visibility (operators see what came in); `start.output` and `vars` use the coerced payload (operators see what the engine validated+coerced).

**Source**: HLD Section 3 data flow, `workflow-handler.ts:214-252` (current signature), `workflow-handler.ts:580` (current call site).
**Confidence**: HIGH

---

### TD4: Preflight validation ordering in execute route

**Classification**: ANSWERED
**Answer**: Correct. The ordering is:

1. `requireTenantProject` (auth + scoping) -- already exists at `workflow-executions.ts:390-392`
2. `workflowModel.findOne` (verify workflow exists) -- already exists at `workflow-executions.ts:395-406`
3. `executeBodySchema.safeParse` (Zod validation of HTTP body) -- already exists at `workflow-executions.ts:408-417`
4. **Version resolution** via the existing precedence chain (`buildVersionExecutionDefinition` or `buildDefaultVersionExecutionDefinition` or `buildWorkingCopyExecutionDefinition`) -- already exists at `workflow-executions.ts:452-500`
5. **NEW: Preflight validation** -- call `validateAndCoerceInput(executionDefinition.startInputVariables, triggerPayload)` -- AFTER step 4 because we need the resolved definition to know which input variables are declared
6. If validation fails, return 400 with structured `INPUT_VALIDATION_FAILED` response -- BEFORE the `restateClient.startWorkflow()` call at line 503
7. `buildWorkflowExecutionPayload` + `restateClient.startWorkflow` -- existing code at lines 503-524

The key insight: we MUST resolve the definition first (step 4) because `startInputVariables` comes from the resolved workflow version, not from the HTTP body. Confirmed by HLD Section 6: "startInputVariables is injected server-side by convertCanvasToSteps from the workflow definition -- external callers never send it."

**Source**: `apps/workflow-engine/src/routes/workflow-executions.ts:387-534` (execute route handler), HLD Section 6 note on `WorkflowExecutionInputSchema`.
**Confidence**: HIGH

---

### TD5: Studio DebugFlowLog prop removal

**Classification**: ANSWERED
**Answer**: Confirmed. After removing fabrications:

1. `executionOutput` prop at `DebugFlowLog.tsx:17` -- used ONLY at lines 84 and 97-98 for the synthetic End step fabrication. Removing the End fabrication makes this prop unused. **Remove from `DebugFlowLogProps` interface (L12-19) and from the call site at `WorkflowDebugPanel.tsx:359`.**

2. `executionStatus` prop at `DebugFlowLog.tsx:19` -- used at lines 73-76 (terminal check for End fabrication) and 89-107 (End step status/output derivation). Removing the End fabrication makes this prop unused. **Remove from `DebugFlowLogProps` interface and from the call site at `WorkflowDebugPanel.tsx:360`.**

3. **No other callers.** Grep for `DebugFlowLog` found exactly one import and one callsite: `WorkflowDebugPanel.tsx:9` (import) and `WorkflowDebugPanel.tsx:351` (usage). No other file renders `<DebugFlowLog>`.

4. The `isRunning` prop (`DebugFlowLog.tsx:15`) is NOT used in the fabrication logic and remains needed (it's passed at `WorkflowDebugPanel.tsx:358`). Keep it.

5. The `inputValues` prop is used at lines 58-67 for the synthetic Start fallback. After this feature, the engine provides a real Start step record, so the `hasStartStep` check at line 54 will be true (the engine writes `stepId: 'start'` or `stepName: 'Start'`). The synthetic Start fabrication becomes dead code too. **Remove the Start fabrication block (lines 54-69) and the `inputValues` prop from the interface and call site.**

Actually, revisiting -- `inputValues` prop feeds the START fabrication, which is also being removed. The engine Start step now carries `output: coerced` (the validated payload). But `inputValues` is passed from `WorkflowDebugPanel.tsx:353-357` as `execution.input`. This IS the same data the engine persists as `start.input`. So post-removal, the Start step's `input` field (from engine) shows the raw trigger payload. The `inputValues` prop and its fabrication block become dead code. **Remove both.**

**Source**: `DebugFlowLog.tsx` full file, `WorkflowDebugPanel.tsx:345-361`, grep for `DebugFlowLog` (1 callsite).
**Confidence**: HIGH

---

### TD6: SSE event ordering for Start

**Classification**: DECIDED
**Answer**: The HLD oracle log D-3 (A4) already locked this. The natural execution order is:

```
step.started(start) → step.completed(start) → workflow.started → [step loop] → step.started(end) → step.completed(end) → workflow.completed
```

On Start validation failure:

```
step.started(start) → step.failed(start) → workflow.failed
```

No `workflow.started` fires on Start failure -- the workflow never entered the step loop. This is consistent with the existing pattern where `workflow.started` fires at line 705-708 AFTER the synthetic Start step is created. The new code moves validation between Start step creation and `workflow.started`, so a validation failure prevents `workflow.started` from ever firing.

There is no strict ordering guarantee at the SSE consumer level (Redis pub/sub is unordered), but Studio sorts by `startedAt` timestamp per D-3. The natural emission order provides the correct `startedAt` progression.

**Source**: HLD oracle log D-3 (A4), `workflow-handler.ts:705-708` (current workflow.started location).
**Confidence**: HIGH

---

### RD1: Pre-existing tests that will break

**Classification**: ANSWERED
**Answer**: **Zero existing tests will break** from the core behavior changes. Here's why:

1. **Step count assertions**: Grep found only `canvas-to-steps.test.ts:1070` asserting `steps.toHaveLength(1)`. This tests `CanvasConversionResult.steps` (the converted step array that EXCLUDES start/end), not `execution.nodeExecutions`. Unchanged.

2. **Silent-null end-mapping**: Zero tests assert this behavior. Grep returned no matches.

3. **Start step output**: Zero tests assert `start.output === triggerPayload` on the persisted step record. The `workflow-output-status-convention.test.ts` checks only workflow-level `output._status`, not individual step outputs.

4. **`_status: 0` convention**: The `workflow-output-status-convention.test.ts` tests (8 test cases) assert workflow-level `output._status`. These will still pass because the End phase produces the same `resolvedOutput = { _status: 0, ...mappings }` shape on success, and `buildFailureOutput = { _status: 1, _reason }` on failure. The failure path now has a new trigger (End mapping failure), but the output shape is identical.

5. **`createExecution` step array**: No tests assert the shape of `stepRecords` passed to `createExecution`. The mock `createExecution: vi.fn().mockResolvedValue(undefined)` in tests doesn't validate its arguments for step count.

**Risk of NEW test failures**: The only test modification needed is if any test calls `buildWorkflowContext` directly and relies on the 2-argument signature. Grep confirms 1 direct call at `workflow-handler.ts:580` (production code) and potential test usage. The optional `coerced` parameter preserves backward compat.

**Source**: Grep across all 63 test files in `apps/workflow-engine/src/__tests__/`.
**Confidence**: HIGH

---

### RD2: `packages/database` build order

**Classification**: ANSWERED
**Answer**: Confirmed. `apps/workflow-engine/package.json:23` declares `"@agent-platform/database": "workspace:*"`. Turbo's dependency graph ensures `packages/database` builds before `apps/workflow-engine`. The build command `pnpm build --filter=@agent-platform/database` will trigger first in any turbo-mediated build, and then `pnpm build --filter=@agent-platform/workflow-engine`.

In practice, Phase 1 (schema + types) commits the Mongoose schema change in `packages/database` alongside the TypeScript type updates in `apps/workflow-engine`. When running `pnpm build`, Turbo handles the order automatically. No manual sequencing needed beyond committing them together (which stays within 2 packages, under the 3-package limit).

**Source**: `apps/workflow-engine/package.json:23`, Turbo workspace dependency resolution.
**Confidence**: HIGH

---

### RD3: Studio Playwright tests and phased rollout risk

**Classification**: INFERRED
**Answer**: **Low risk.** Grep for `DebugFlowLog`, `debug.*flow`, `end-node`, `start-node` in `apps/studio/e2e/workflows/` found no Playwright tests that assert specific Start/End step presence in the Debug Flow Log panel. The `workflow-comprehensive.spec.ts` has a debug panel section but it tests panel open/close behavior and general step rendering, not the specific fabricated Start/End entries.

For phased rollout: The LLD commit order (Phase 7 = Studio cleanup) comes AFTER the engine changes (Phases 4, 5). This means:

- **Before Phase 7**: Engine provides real Start+End records, Studio ALSO fabricates them. Result: possible duplicate display (engine Start + fabricated Start). However, `DebugFlowLog.tsx:54-55` checks `hasStartStep = result.some(s => s.stepName.toLowerCase() === 'start' || s.stepId === 'start-node')`. The engine writes `stepId: 'start'` (not `'start-node'`), and `stepName: 'Start'`. The `toLowerCase() === 'start'` check WILL match the engine record, so the fabrication will be skipped. Similarly for End: `hasEndStep = result.some(s => s.nodeType === 'end' ...)` will match the engine's End record.
- **After Phase 7**: Clean -- only engine records.

The window between engine deploy and Studio deploy is safe because the fabrication code has guard conditions that detect engine-provided records.

**Source**: Grep of `apps/studio/e2e/workflows/`, `DebugFlowLog.tsx:54-55, 77-82`.
**Confidence**: HIGH

---

### RD4: Biggest implementation risk

**Classification**: DECIDED
**Answer**: **(a) Payload wiring dropping `startInputVariables` in one of the five handoff sites.** This is the highest risk because:

1. There are ~10 individual sites that must propagate the field: `convertVersionDocToSteps`/`convertWorkflowDocToSteps` (already return it), every tier of `resolveWorkflowDefinition` (pinned, deployment, semver-desc, draft, working-copy-steps, working-copy-canvas -- 6 tiers), `buildWorkingCopyExecutionDefinition` + `buildVersionExecutionDefinition` + `buildDefaultVersionExecutionDefinition` (3 route builders), `trigger-engine.ts` call site, `trigger-scheduler.ts` call site, and the execute route call site.

2. If ANY one of these sites omits `startInputVariables`, that fire path silently runs without validation -- the exact same class of bug as the current `startInputVariables` dead-wiring. The failure mode is silent, not loud.

3. This is the exact class of bug documented in GAP-14 (parent spec) and the 2026-04-16 data-flow audit: fields silently dropped because one handoff site didn't propagate them.

**Mitigation**: The LLD must include a wiring checklist (per HLD Section 6) that enumerates EVERY handoff site with a grep-verifiable assertion. The E2E tests must exercise at least 2 fire paths (execute route + webhook trigger) to catch dropped fields on different paths.

Risks (b), (c), (d) from the question are lower:

- (b) Mongoose schema landing ahead of write code: Mongoose `Schema.Types.Mixed` accepts anything -- the field just stays `undefined` until the writing code lands. No strip risk because Mixed doesn't strip.
- (c) Start phase ordering: the HLD data flow is explicit and the handler pattern (create execution first with all pending entries, then transition) is already established.
- (d) Nothing else identified.

**Source**: HLD Section 6 wiring trace, GAP-14 audit precedent, analysis of all handoff sites in version-resolution.ts, workflow-executions.ts, trigger-engine.ts, trigger-scheduler.ts.
**Confidence**: HIGH

---

### RD5: Restate replay risk

**Classification**: ANSWERED
**Answer**: Confirmed. Start-phase validation and End-phase mapping evaluation are NOT inside `ctx.run()`.

Evidence:

1. `dispatchWithRetry` (the function that wraps step execution in `ctx.run()`) is called at `workflow-handler.ts:1614` only for the step queue loop. Start-phase validation happens at `workflow-handler.ts:~580` (before the step loop at line 710+). End-phase mapping evaluation happens at `workflow-handler.ts:1357-1372` (after the step loop, outside the try/catch that wraps `dispatchWithRetry`).

2. Both phases use direct `deps.persistence.updateStepStatus()` calls -- these are direct MongoDB writes, not wrapped in Restate's `ctx.run()`. The HLD Section 4 #6 (Failure Modes) confirms: "all new persistence is OUTSIDE ctx.run() -- direct Mongo writes -- so the Restate journal is unaffected."

3. `deps.persistence.updateStepStatus` is idempotent by (`executionId`, `tenantId`, `projectId`, `stepId`) -- Restate replay invoking Start or End twice produces the same row (HLD Section 4 #7).

4. The `deps.publisher.publish` calls are also direct Redis publishes, not inside `ctx.run()`. Duplicate SSE events are handled by Studio's dedup (sort by timestamp + stepId uniqueness).

**Source**: `workflow-handler.ts:1596-1650` (dispatchWithRetry with ctx.run), `workflow-handler.ts:580` (buildWorkflowContext call, before step loop), `workflow-handler.ts:1357-1372` (end mapping evaluation, after step loop), HLD Section 4 #6 and #7.
**Confidence**: HIGH

---

### AS1: Test file naming for unit tests

**Classification**: DECIDED
**Answer**: **Co-located with the source module**: `apps/workflow-engine/src/validation/__tests__/start-input-validator.test.ts`.

However, the `validation/` directory does not exist yet (confirmed via `ls`). The existing pattern in workflow-engine is to place ALL tests flat in `apps/workflow-engine/src/__tests__/` (63 test files, zero subdirectories other than `helpers/`). No existing source module has co-located `__tests__/` directories.

**Revised answer**: Follow the existing flat convention: `apps/workflow-engine/src/__tests__/start-input-validator.test.ts`. The validator source goes in `apps/workflow-engine/src/validation/start-input-validator.ts` (new directory for source), but the test file stays flat in the existing `__tests__/` directory to match the 63-file pattern.

**Source**: `ls apps/workflow-engine/src/__tests__/` -- all 63 test files are flat, no co-located tests anywhere in the codebase.
**Confidence**: HIGH

---

### AS2: Integration test file -- new vs existing

**Classification**: DECIDED
**Answer**: **New file**: `apps/workflow-engine/src/__tests__/workflow-handler-start-end.test.ts`. Rationale:

1. The existing `workflow-handler.test.ts` exists but grep found zero hits for start step assertions, output mapping assertions, or step count assertions. It appears to be a general handler test file.
2. The new Start/End behavior is a well-scoped concern. A dedicated file is easier to locate, review, and revert independently.
3. The repo pattern shows domain-specific test files: `workflow-output-status-convention.test.ts`, `workflow-handler-suspension.test.ts`, `workflow-approvals.test.ts`, `workflow-callbacks.test.ts`. A `workflow-handler-start-end.test.ts` fits this naming convention.

**Source**: Test file listing in `apps/workflow-engine/src/__tests__/` -- domain-specific files are the established pattern.
**Confidence**: HIGH

---

### AS3: E2E test location

**Classification**: DECIDED
**Answer**: **Workflow-engine tests**: `apps/workflow-engine/src/__tests__/e2e-start-end-steps.test.ts`. Rationale:

1. The HLD Section 10 says E2E tests "hit the HTTP execute route directly." The execute route is on workflow-engine (port 9080), not Studio.
2. The existing pattern has `e2e-basic.test.ts`, `e2e-medium.test.ts`, `e2e-advanced.test.ts` in `apps/workflow-engine/src/__tests__/`. A new `e2e-start-end-steps.test.ts` follows this convention.
3. Studio Playwright tests (`apps/studio/e2e/workflows/*.spec.ts`) test UI behavior (canvas drag-and-drop, panel rendering). They do NOT test engine execution semantics. The E2E scenarios here (validate input via POST /execute, check step records via GET /executions/:id) are engine-domain concerns.
4. Studio E2E tests could be added LATER to verify Debug panel rendering of mappingErrors, but that is a UI concern separate from this feature's engine scope.

**Source**: Existing `e2e-basic.test.ts`, `e2e-medium.test.ts`, `e2e-advanced.test.ts` in workflow-engine **tests**.
**Confidence**: HIGH

---

### AS4: Doc updates in same commit as code

**Classification**: ANSWERED
**Answer**: Correct. CLAUDE.md: "One concern per commit. Never bundle feature code + test code + refactoring + docs in one commit." Doc updates (parent spec gap table, test-spec coverage matrix) should come in `/post-impl-sync` as a final commit with type `docs()`. This is Phase 6 per the SDLC pipeline.

The only exception: `agents.md` package learnings can be included in implementation commits per pipeline.md: "After completing any SDLC phase that touches a package, append learnings to its agents.md."

**Source**: CLAUDE.md "One concern per commit", `docs/sdlc/pipeline.md` Phase 6.
**Confidence**: HIGH

---

### AS5: Exit criteria format

**Classification**: DECIDED
**Answer**: **Both.** Each phase should list:

1. A high-level description of what must be true ("all validator unit tests pass, pnpm build succeeds for workflow-engine")
2. The exact command to verify it (`pnpm build --filter=@agent-platform/workflow-engine && pnpm test --filter=@agent-platform/workflow-engine -- src/__tests__/start-input-validator.test.ts`)

This follows the pattern in `docs/plans/2026-04-14-workflow-versioning-impl-plan.md` which lists both prose exit criteria and specific build/test commands.

**Source**: `docs/plans/2026-04-14-workflow-versioning-impl-plan.md` (pattern reference), `docs/sdlc/pipeline.md`: "Exit criteria are measurable."
**Confidence**: HIGH

---

## Decisions Made

| #    | Decision                                                                                   | Rationale                                                                             | Risk |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ---- |
| D-1  | 7-8 commit phases, strict dependency order (IS1)                                           | Commit-scope-guard (<=40 files, <=3 packages) + deletion-ratio-guard; each revertable | Low  |
| D-2  | Function + tests in same commit for all phases (IS2)                                       | Pipeline.md slice-by-slice mandate; no TDD requirement in CLAUDE.md                   | Low  |
| D-3  | `StartInputVariable` stays in canvas-to-steps.ts as named export (IS5)                     | All consumers are workflow-engine-internal; HLD explicitly says this location         | Low  |
| D-4  | `FieldError` co-located with validator in start-input-validator.ts (TD1)                   | Single-use type with one source module; follows existing co-location pattern          | Low  |
| D-5  | `Schema.Types.Mixed` for mappingErrors (TD2)                                               | HLD explicitly mandates; matches existing patterns for consoleLogs, iterationResults  | Low  |
| D-6  | New `coerced?` parameter on buildWorkflowContext (TD3)                                     | Backward-compat (optional param); keeps raw triggerPayload visible as start.input     | Low  |
| D-7  | Natural SSE order: step.started(start)->step.completed(start)->workflow.started (TD6)      | Matches existing emission pattern; Studio sorts by timestamp                          | Low  |
| D-8  | Payload wiring is highest risk, mitigated by wiring checklist + 2-path E2E (RD4)           | 10+ handoff sites with silent failure mode; same class as GAP-14                      | Med  |
| D-9  | Test files flat in `__tests__/`: validator, handler-start-end, e2e-start-end-steps (AS1-3) | Matches 63-file flat convention in workflow-engine                                    | Low  |
| D-10 | Both prose + exact commands for exit criteria (AS5)                                        | Measurable + human-readable per pipeline.md                                           | Low  |

## Escalations

None. All questions were ANSWERED, INFERRED, or DECIDED. Zero AMBIGUOUS items.
