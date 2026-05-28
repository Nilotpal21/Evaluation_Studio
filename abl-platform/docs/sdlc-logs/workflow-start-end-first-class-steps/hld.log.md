# HLD Oracle Log: First-Class Start/End Steps

> Feature: `workflow-start-end-first-class-steps`
> Phase: HLD (Phase 3)
> Date: 2026-04-19
> Oracle: product-oracle

## Context Consulted

- `docs/features/workflows.md` (feature spec, BETA)
- `docs/specs/workflows.hld.md` (parent HLD)
- `docs/features/sub-features/workflow-versioning.md` (versioning sub-feature)
- `CLAUDE.md` (platform invariants, commit scope, test architecture)
- `docs/sdlc/pipeline.md` (decision classification protocol)
- `apps/workflow-engine/src/handlers/workflow-handler.ts` (lines 59-77, 214-252, 574-703, 1357-1493)
- `apps/workflow-engine/src/handlers/canvas-to-steps.ts` (lines 27-78, 158-358)
- `apps/workflow-engine/src/handlers/step-dispatcher.ts` (lines 59-160)
- `apps/workflow-engine/src/lib/execution-payload.ts` (full file, lines 1-97)
- `apps/workflow-engine/src/services/restate-endpoint.ts` (lines 1-160)
- `apps/workflow-engine/src/notifications/notification-dispatcher.ts` (lines 1-56)
- `apps/studio/src/api/workflows.ts` (lines 140-200)
- `apps/studio/src/components/workflows/canvas/panels/DebugFlowLog.tsx` (full file)
- `apps/studio/src/components/workflows/canvas/panels/RunDialog.tsx` (lines 1-120)
- `apps/studio/src/components/workflows/tabs/WorkflowMonitorTab.tsx` (lines 140-165)
- Grep: `startInputVariables` across codebase — consumed by zero execution-path callers
- Grep: `WorkflowExecutionPayload`/`BuildExecutionPayloadInput` — internal to workflow-engine only
- Grep: `ExecutionStepResult` — used in 7 Studio files
- Grep: feature flags in workflow-engine — none exist

---

## Answers

### A1: Step representation — first-class `WorkflowStep[]` entries vs. special-case records

**Classification**: DECIDED
**Answer**: Remain as special-case records persisted directly by the handler, NOT as `WorkflowStep[]` entries routed through `dispatchStep`.

**Rationale**:

1. The existing pattern at `workflow-handler.ts:666-703` already creates a synthetic Start step record via `stepRecords.unshift(...)` and `updateStepStatus(...)` without routing through `dispatchStep`. This is an established, working pattern.
2. `dispatchStep` (`step-dispatcher.ts:141-160`) uses a `switch` on `step.type` that routes to executor functions. Start/End have no executor logic to dispatch to -- Start validates+coerces input, End resolves output mappings. Both are workflow-handler-level concerns, not step-executor concerns.
3. Adding `'start'`/`'end'` cases to the `BaseWorkflowStep` union would require updating the union type, the `dispatchStep` switch, and every test that covers step dispatch exhaustiveness. For zero behavioral gain.
4. The `canvas-to-steps.ts:196-201` skip explicitly excludes `start`/`end` from the step array. Making them first-class would require changing this skip, which ripples into the topological sort and all downstream step ID filtering.

**Risk**: LOW -- matches the established pattern exactly.

---

### A2: Where start-node input validation happens

**Classification**: DECIDED
**Answer**: Validate inside the workflow handler at the Start step, creating an execution record with `status=failed` and a failed Start step record. Additionally, add a pre-validation at the execute route that returns 4xx for synchronous callers, but treat the handler-side validation as the canonical validation point.

**Rationale**:

1. Triggers (cron/webhook/poll/agent) bypass the synchronous route entirely -- they call `restateClient.startWorkflow()` directly from `trigger-engine.ts:560` and `trigger-scheduler.ts`. There is no single synchronous entry point.
2. The handler already has the pattern for early failure: `workflow-handler.ts:583-591` returns a failed result immediately if `!Array.isArray(input.steps)`. The Start validation should follow this same pattern -- validate before the step queue loop, record a failed Start step, and return a failed result.
3. For the synchronous execute route, a pre-flight validation is valuable for UX (immediate 400 with field-level errors instead of having to poll the execution status). But this is an optimization, not the canonical check.
4. Both checks use the same validation function (pure function: `startInputVariables` + `triggerPayload` -> `{valid, errors}`), so there is no duplication of logic.

**Risk**: LOW -- the handler-side check is the only one that covers all fire paths.

---

### A3: End-node per-mapping failure policy

**Classification**: RESOLVED BY USER (2026-04-19)
**User decision**: **Option A — Fail the workflow.** Any failed output-mapping expression sets End step `status=failed` and workflow `status=failed`. Per-mapping details recorded on `End.mappingErrors[]`; summary on `End.error`.

**Context provided by user**: Product is not in live / production, so the behavioral-break concern from the oracle analysis is moot.

**Resulting rules**:

1. End step evaluates all mappings (does NOT short-circuit on first error) so `mappingErrors[]` lists every failing mapping.
2. If `mappingErrors.length > 0`: End step `status=failed`, `error = { code: 'OUTPUT_MAPPING_FAILED', message: 'N of M output mappings failed' }`, workflow `status=failed`.
3. Workflow-level failure payload preserves `_status=1` + `_reason` convention (`workflow-handler.ts:495`).
4. Emits `step.failed` (End) + `workflow.failed` — notification rules pick these up via existing event types.
5. Callback delivery (for webhook async workflows with `callbackUrl`) carries the failure status rather than partial success.

---

### A4: Start/End SSE events alongside workflow events

**Classification**: DECIDED
**Answer**: Emit `step.started`/`step.completed` for Start and End IN ADDITION to the existing `workflow.started`/`workflow.completed` events. Both fire. No strict ordering guarantee is needed, but the natural execution order provides sufficient ordering.

**Rationale**:

1. The existing pattern at `workflow-handler.ts:305-313` (step.started) and `workflow-handler.ts:705-708` (workflow.started) shows that step events and workflow events are already independent publishes to the same Redis channel. Studio's `ExecutionDebugPanel` subscribes to the channel and dispatches on `type`.
2. Start step events fire during handler initialization (before the step queue loop). Workflow.started fires immediately after. Natural ordering: `step.started(start)` -> `step.completed(start)` -> `workflow.started` -> ... -> `step.started(end)` -> `step.completed(end)` -> `workflow.completed`.
3. Studio's debug panel (`DebugFlowLog.tsx`) sorts by `startedAt` timestamp, not by event arrival order. So even if events arrive out of order, the display is deterministic.
4. Notification rules (`notification-dispatcher.ts:17-28`) already support both `step.completed` and `workflow.completed` as separate trigger events. Start/End step events flow through the existing event matching naturally.

**Risk**: LOW -- additive. No existing consumer breaks.

---

### A5: Type coercion rule

**Classification**: DECIDED
**Answer**: Adopt the RunDialog client-side coercion rules as the canonical engine-side rules, with one tightening: `boolean` coercion should accept the full set `'true'|'1'|'yes'` (case-insensitive) as truthy (not just `rawVal === 'true'` as RunDialog currently does).

**Rationale**:

1. RunDialog (`RunDialog.tsx:52-79`) already defines the coercion map: `string -> number via Number()`, `string -> boolean via === 'true'`, `string -> json via JSON.parse`, default = string pass-through.
2. The engine must be strictly no less permissive than the client, because triggers send raw string payloads (webhook POST bodies, cron metadata) that were never coerced by RunDialog.
3. Coerce-then-validate (not reject-on-mismatch) is the correct choice because: (a) webhook trigger payloads are always JSON strings from HTTP bodies, (b) `Number("42")` is lossless, (c) rejecting on type mismatch would break every existing trigger-fired workflow that sends `{"amount": "100"}` for a `number` input variable.
4. Tighten boolean: RunDialog only accepts `=== 'true'`, but webhook payloads commonly send `"1"`, `"yes"`, `"true"`. Accept all three (case-insensitive).
5. For `json` type: coerce via `JSON.parse`. If it fails, that IS a validation error (not a coercion), and should be reported as such on the Start step.

**Risk**: LOW -- strictly more permissive than current client behavior, no existing workflow can break.

---

### I1: External/SDK consumers of `WorkflowExecutionInput`, `BuildExecutionPayloadInput`

**Classification**: ANSWERED
**Answer**: No external consumers. Both shapes are internal to `apps/workflow-engine` only.

**Source**:

- `WorkflowExecutionInput` is defined at `workflow-handler.ts:59-77` and imported by: `restate-endpoint.ts`, `workflow-handler.test.ts`, and various test files -- all within `apps/workflow-engine`.
- `BuildExecutionPayloadInput` is defined at `lib/execution-payload.ts:48-66` and imported by: `trigger-engine.ts`, `trigger-scheduler.ts`, `workflow-executions.ts` -- all within `apps/workflow-engine`.
- `WorkflowExecutionPayload` has the same scope.
- `packages/shared/src/types/workflow-schemas.ts:447` has a `WorkflowExecutionInputSchema` Zod schema, but it is a Zod validation schema, not the TypeScript interface, and is consumed only by workflow-engine route handlers.
- None of these types are re-exported via any public package barrel (`packages/shared/src/types/index.ts` exports the Zod schema but it is not consumed by Studio or other apps).

**Confidence**: HIGH

---

### I2: Remove both synthetic Start and End fabrications from DebugFlowLog

**Classification**: DECIDED
**Answer**: Remove BOTH client-side fabrications immediately. Accept that very old executions (pre-feature) display with fewer steps.

**Rationale**:

1. User directive in the scope: "No dead code. No feature-flag shims."
2. `CLAUDE.md`: "No backwards-compat shims for steady-state contract."
3. Workflows is BETA (`workflows.md` status). Data volume is small per the feature spec. BETA allows breaking changes with documentation.
4. The Start step record already exists in engine output (`workflow-handler.ts:674-703`) -- the fabrication at `DebugFlowLog.tsx:54-69` is already redundant for any execution created after the synthetic Start was added. Removing it is safe for all recent executions.
5. End step records will be new. For old executions without End step records, the debug panel simply shows the steps that exist -- no End step appears. This is correct behavior: those executions did not have first-class End tracking.

**Risk**: LOW -- BETA feature, small data volume. Old executions show fewer steps (accurate representation of what was tracked).

---

### I3: Tests/fixtures that assume absent `startInputVariables`

**Classification**: ANSWERED
**Answer**: Two test files reference `startInputVariables`, both in `canvas-to-steps.test.ts`. No test or fixture assumes the field is absent; they explicitly test that it is extracted correctly (line 1079) and that it defaults to `[]` when absent (line 1127). No execution-path consumer currently reads or introspects this field.

**Source**:

- Grep for `startInputVariables` found: `canvas-to-steps.ts` (definition + extraction), `canvas-to-steps.test.ts` (two test cases), `agents.md` (documentation), `docs/testing/workflow-as-tool.md` (test fixture helper mention), `docs/workflows/workflows-high-level-understanding.md` (documentation).
- Zero hits in: `trigger-engine.ts`, `trigger-scheduler.ts`, `workflow-executions.ts`, `execution-payload.ts`, `workflow-handler.ts`, or any Studio file.
- Confirmed: wiring it end-to-end will not break any existing consumer because no consumer currently reads it.

**Confidence**: HIGH

---

### I4: Monitor tab step count — include Start/End or filter them?

**Classification**: DECIDED
**Answer**: Include Start and End in the count by default. Show `N/N` where N includes Start and End.

**Rationale**:

1. `WorkflowMonitorTab.tsx:147-151` counts `steps.filter(s => s.status === 'completed').length` out of `steps.length`. This is a raw count of whatever is in `execution.steps[]`.
2. After this feature, Start and End are real step records in `execution.steps[]`. They will naturally be counted. No code change is needed -- the count reflects reality.
3. Filtering them out would require adding a special case (`nodeType !== 'start' && nodeType !== 'end'`), adding complexity for marginal UX benefit.
4. Users see the same steps in Debug panel, Raw JSON, and Monitor tab -- consistency is the priority. If Start and End appear in Debug panel, they should be counted in Monitor tab.

**Risk**: LOW -- the count goes from "2/2" to "4/4" for a 2-step workflow. The ratio stays the same. No user confusion expected.

---

### I5: Data migration for existing executions

**Classification**: DECIDED
**Answer**: No data migration. Accept that old executions display as-is (no Start input metadata, no End record). Old Start records that already exist (with `stepId: 'start'`) will render with whatever data they have.

**Rationale**:

1. Workflows is BETA with small data volume (per feature spec gap table and status).
2. The existing synthetic Start step record (`workflow-handler.ts:674-703`) already creates a `stepId: 'start'` entry in all executions since that code was added. Old executions have a Start step record but without validation metadata -- this is fine.
3. Old executions will not have an End step record. The Debug panel (after removing client fabrication) simply won't show End for those executions. This is accurate -- those executions genuinely lacked End step tracking.
4. A migration would need to: (a) find all executions, (b) retroactively compute what the End step would have been, (c) rewrite `steps[]`. This is complex, error-prone, and unnecessary for BETA.
5. `CLAUDE.md`: "No backwards-compat shims for steady-state contract."

**Risk**: LOW -- BETA feature, accurate representation of historical data.

---

### R1: Risk ranking

**Classification**: INFERRED
**Answer**: Ranked from highest to lowest risk:

**(b) Validation breaking trigger-fired workflows** -- HIGHEST RISK.
Every trigger path (cron, webhook, polling, agent) currently runs with whatever payload is provided, including missing required fields that silently become `undefined`. Adding validation at the Start step will cause these workflows to fail with clear errors. This affects 100% of trigger-fired workflows with declared required input variables.

**(a) Breaking Restate durable execution replay** -- MEDIUM RISK.
The Start step validation and End step persistence are new `deps.persistence.updateStepStatus()` calls added to `runWorkflow()`. For in-flight executions that were started BEFORE the code deploy and replayed AFTER, Restate will replay the journal up to the last completed `ctx.run()` call, then continue executing from that point. The new calls are NOT inside `ctx.run()` (they are direct MongoDB writes), so they don't affect the Restate journal. However, if the execution record shape changes mid-flight (e.g., End step record is expected but doesn't exist for an in-flight execution started before deploy), the persistence layer must tolerate missing records gracefully. This is manageable with defensive coding.

**(c) Notification rules firing for Start/End steps** -- LOWEST RISK.
Notification rules match on event type strings (`step.failed`, `step.completed`). Start/End step events will match existing rules that listen to `step.*`. However: (a) Start steps should virtually never fail (only on validation failure), (b) End step failures are a new concept that didn't exist before. Existing notification rules were never triggered by Start/End events, so adding them is additive, not breaking.

**Source**: Analysis of `workflow-handler.ts` execution flow, `restate-endpoint.ts:133-153` (Restate invocation), `notification-dispatcher.ts:17-28` (event types).

**Confidence**: HIGH

---

### R2: Feature flag vs. direct cutover

**Classification**: DECIDED
**Answer**: Direct cutover, no feature flag.

**Rationale**:

1. `CLAUDE.md`: "No backwards-compat shims for steady-state contract. Rollout compatibility may be narrow and explicit." Feature flags ARE backwards-compat shims.
2. Workflows is BETA. The feature spec explicitly allows breaking changes with documentation.
3. No feature flag infrastructure exists in workflow-engine (confirmed: grep found zero flag patterns).
4. The Start step validation is the only behavior change that affects existing workflows. Its blast radius is mitigated by: (a) only workflows with declared required `inputVariables` AND missing trigger payload fields will fail, (b) this is a bug fix -- those workflows were silently running with `undefined` values, which is incorrect behavior.

**Risk**: LOW -- BETA feature, no flag infra to build, behavioral change is a correctness improvement.

---

### R3: Trigger-fired validation failure policy

**Classification**: DECIDED
**Answer**: Fail the execution with a clear error. Emit `step.failed` on the Start step AND `workflow.failed` on the execution. Notification rules that listen to `step.failed` or `workflow.failed` will fire, so operators see it.

**Rationale**:

1. Today, trigger-fired workflows with missing required fields run with `vars.missingField = undefined`, leading to silent downstream failures (e.g., a template expression `{{vars.email}}` resolves to empty string, an HTTP step sends a request with missing body fields). This is worse than failing early.
2. The Start step `status=failed` with `error: { code: 'INPUT_VALIDATION_FAILED', message: 'Required field "email" is missing' }` gives operators a clear, actionable error.
3. Notification rules already support `step.failed` (`notification-dispatcher.ts:23`). No new notification event types needed.
4. For cron triggers that suddenly fail because their payload doesn't match required vars: this surfaces a real configuration problem that was previously hidden. The operator needs to update the trigger payload or remove the required constraint.

**Risk**: MEDIUM -- existing trigger-fired workflows with required input variables AND missing payload fields will start failing. This is intentional: surfacing a latent bug. The risk is mitigated by clear error messages.

---

### R4: Rollback / kill switch plan

**Classification**: DECIDED
**Answer**: Strictly revert-the-commit(s). No per-route env var, no global toggle.

**Rationale**:

1. `CLAUDE.md`: "No backwards-compat shims for steady-state contract."
2. The commit scope guard enforces max 40 files / max 3 packages per commit. This means the feature will be delivered as multiple small, focused commits (Start step validation, End step persistence, client cleanup). Each commit is independently revertable.
3. A per-route env var or global toggle IS a feature flag by another name, which conflicts with the platform invariant.
4. The phased implementation (LLD) should order commits so that the riskiest change (Start input validation) is its own commit, easily revertable without touching the rest.

**Risk**: LOW -- standard git revert workflow. Small focused commits are the mitigation.

---

### R5: Blast radius and canary strategy

**Classification**: INFERRED
**Answer**: No canary tenant or staging pattern exists in workflow-engine. Mitigate via: (a) strong pre-merge E2E coverage (minimum 5 scenarios per the SDLC pipeline), (b) phased commits where Start step persistence is a separate commit from Start input validation, (c) the existing test suite (700+ tests in workflow-engine).

**Source**:

- Grep for feature flags, canary, staging patterns in workflow-engine found zero matches.
- The deployment topology (`workflows.hld.md` section 7) shows a single `workflow-engine` Deployment -- no canary/staging split.
- `docs/sdlc/pipeline.md` mandates minimum 5 E2E scenarios as the quality gate.

**Risk**: MEDIUM -- 100% blast radius on a bug in Start step persistence is real. The mitigation is: (1) the Start step record pattern already works (it has been live since the synthetic Start was added), (2) the new validation is a pure function (easily unit-tested), (3) E2E tests exercise the full path.

**Confidence**: HIGH

---

### S1: End step `input` and `output` shape

**Classification**: DECIDED
**Answer**: End step `input` = the full mapping config (for debug visibility): `Array<{name, expression}>`. End step `output` = the resolved output map with `_status: 0` (matching the current `resolvedOutput` shape at `workflow-handler.ts:1359`).

**Rationale**:

1. For debug visibility, operators need to see WHAT expressions were configured (input) and WHAT they resolved to (output). This parallels HTTP steps where `input` = the request config and `output` = the response.
2. The `_status: 0` convention is already established in `workflow-handler.ts:1359` and documented in the codebase (`workflow-output-status-convention.test.ts`). Keeping it consistent is mandatory.
3. Including the full mapping config in `input` (not just expressions) enables the debug panel to show which mapping produced which output value side-by-side.

**Risk**: LOW -- additive, follows existing step input/output conventions.

---

### S2: Start step `output` shape

**Classification**: DECIDED
**Answer**: Start step `output` = the validated+coerced variable map (just `Record<string, unknown>`). Minimal shape, no metadata wrapper.

**Rationale**:

1. The current Start step sets `output: input.triggerPayload` (`workflow-handler.ts:702`). After validation, the output should be the coerced payload (post-validation, post-coercion).
2. A metadata wrapper (`{ declared: [...], coerced: {...}, extra: [...] }`) adds complexity for marginal debug benefit. The `input` already shows the raw trigger payload; the `output` shows the validated+coerced result. The delta between input and output IS the coercion/validation story.
3. `declared` (the input variable definitions) are available from the workflow definition itself and would be redundant on every execution.
4. `extra` (undeclared fields in the trigger payload) are pass-through -- they go into `ctx.vars` via the existing spread at `workflow-handler.ts:250`. Listing them separately adds noise.
5. If structured metadata is needed later, it can be added to a `metrics` field (see S4) without changing the output shape.

**Risk**: LOW -- simpler is better, can be extended later.

---

### S3: Per-mapping error persistence shape

**Classification**: DECIDED
**Answer**: Add an optional `mappingErrors?: Array<{name: string, expression: string, error: string}>` field to the End step's persistence data. Do NOT overload the existing `error: {code, message}` field with joined messages.

**Rationale**:

1. `ExecutionStepResult.error` (`workflows.ts:171-176`) is `{code, message, httpStatus?, responseBody?}`. Overloading `message` with joined per-mapping errors loses the structured debugging information.
2. A new `mappingErrors` field is minimally invasive: it is optional (old executions without it render fine), it carries structured data, and it can be displayed in the debug panel as a table.
3. The persistence layer (`updateStepStatus` at `workflow-handler.ts:108-125`) already accepts arbitrary `data` fields. Adding `mappingErrors` to the step record is a matter of persisting it alongside `output` and `error`.
4. If the End step's overall status is `failed` (pending A3 decision), the `error` field carries the summary (`{code: 'OUTPUT_MAPPING_FAILED', message: 'N of M output mappings failed'}`), and `mappingErrors` carries the details. If status is `completed` with warnings, `error` is absent and `mappingErrors` alone carries the detail.

**Risk**: LOW -- additive field on an existing shape. Studio rendering needs a small update to show the field, but it is optional.

---

### S4: Start/End `metrics` entry

**Classification**: DECIDED
**Answer**: Yes, add per-step `metrics` for both Start and End. Start: `{ processingTimeMs }` for validation+coercion time. End: `{ processingTimeMs }` for expression evaluation time. Parallel to the HTTP step pattern.

**Rationale**:

1. The `ExecutionStepResult.metrics` shape (`workflows.ts:178-181`) already supports `{ responseTimeMs?, processingTimeMs? }`. Start and End have no "response time" (no external call), but `processingTimeMs` is directly applicable.
2. The existing step lifecycle at `workflow-handler.ts:344-360` already computes `durationMs` and `metrics` for non-suspension steps. Start and End should follow the same pattern.
3. For Start: validation+coercion is a pure CPU operation, so `processingTimeMs` will be near-zero for most workflows. But for workflows with many input variables or complex JSON coercion, it could be meaningful.
4. For End: expression evaluation against the workflow context is the primary work. If a mapping expression traverses a large context object, `processingTimeMs` helps diagnose slow completions.

**Risk**: LOW -- additive, follows existing pattern exactly.

---

## Decisions Made

| #    | Decision                                                                              | Rationale                                                                     | Risk |
| ---- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---- |
| D-1  | Start/End remain special-case handler records, not dispatchStep entries (A1)          | Matches existing pattern; avoids touching dispatcher union, executor tests    | Low  |
| D-2  | Validate at handler (canonical) + route (UX optimization) (A2)                        | Only handler covers all fire paths (trigger, cron, agent)                     | Low  |
| D-3  | Emit step events AND workflow events (A4)                                             | Additive, consistent, Studio sorts by timestamp                               | Low  |
| D-4  | Adopt RunDialog coercion rules with broadened boolean set (A5)                        | No less permissive than client; webhook payloads send '1','yes','true'        | Low  |
| D-5  | Remove BOTH client fabrications immediately (I2)                                      | User directive: no dead code. BETA allows breaking changes.                   | Low  |
| D-6  | Include Start/End in Monitor tab step count (I4)                                      | Natural behavior; no code change needed; consistency with Debug panel         | Low  |
| D-7  | No data migration for old executions (I5)                                             | BETA, small volume, accurate historical representation                        | Low  |
| D-8  | Risk ranking: validation > replay > notifications (R1)                                | Validation affects 100% of trigger-fired workflows with required vars         | Med  |
| D-9  | Direct cutover, no feature flag (R2)                                                  | Platform invariant; BETA allows; no flag infra exists                         | Low  |
| D-10 | Fail execution on trigger validation failure, emit step.failed + workflow.failed (R3) | Surfaces latent bugs; clear error messages; uses existing notification events | Med  |
| D-11 | Revert-the-commit is the kill switch (R4)                                             | Small focused commits; no flag infra; platform invariant                      | Low  |
| D-12 | E2E coverage + phased commits for blast radius mitigation (R5)                        | No canary infra exists; SDLC mandates 5+ E2E scenarios                        | Med  |
| D-13 | End input = mapping config, output = resolved map with \_status:0 (S1)                | Debug visibility; follows HTTP step pattern; preserves \_status convention    | Low  |
| D-14 | Start output = coerced variable map, minimal shape (S2)                               | Simple, delta between input/output tells the story                            | Low  |
| D-15 | New `mappingErrors` field, not overloaded `error.message` (S3)                        | Structured debugging; optional field; minimally invasive                      | Low  |
| D-16 | Add `processingTimeMs` metrics for both Start and End (S4)                            | Follows existing step metrics pattern exactly                                 | Low  |

## Escalations (resolved)

| #   | Question                                                          | Status                                   | Resolution                                                                                                 |
| --- | ----------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A-1 | Should failed output mapping expressions fail the whole workflow? | RESOLVED BY USER (2026-04-19) — Option A | Fail the workflow. Evaluate all mappings; populate `mappingErrors[]`; End + workflow both `status=failed`. |

## Final Locked Decisions

All 17 decisions (D-1 through D-17) are locked as of 2026-04-19:

- D-1..D-16: per table above.
- D-17 (was A3): Fail the workflow on any failed output mapping. Evaluate all mappings before failing so `mappingErrors[]` is complete.
