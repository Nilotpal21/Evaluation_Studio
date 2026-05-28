# HLD: First-Class Start/End Steps with Input Validation and Output-Mapping Observability

> **Parent Feature Spec**: `docs/features/workflows.md` (BETA, Feature ID #48)
> **Parent HLD**: `docs/specs/workflows.hld.md`
> **Related HLDs**: `docs/specs/workflow-versioning.hld.md`, `docs/specs/workflow-triggers.hld.md`
> **Status**: DONE (implemented 2026-04-20)
> **Author**: Pattabhi
> **Date**: 2026-04-19
> **Completed**: 2026-04-20
> **Implementation commits**: `7f2546dc5f..fcb051e09c` on `feat/workflow-version` (11 commits)
> **Implementation log**: `docs/sdlc-logs/workflow-start-end-first-class-steps/implementation.log.md`
> **JIRA**: ABLP-2

---

## 1. Problem Statement

The workflow canvas has two boundary nodes — `start` and `end` — that perform real runtime work but are NOT recorded as first-class execution steps. This creates three concrete defects plus one dead-code trail:

1. **Dead `startInputVariables` wiring.** The canvas `start` node declares `inputVariables: Array<{ name, type, required }>`. `apps/workflow-engine/src/handlers/canvas-to-steps.ts:351-358` extracts them into `CanvasConversionResult.startInputVariables` — but no downstream caller reads them. They are never forwarded into `WorkflowExecutionInput`, `BuildExecutionPayloadInput`, or `WorkflowExecutionPayload`. The engine performs **zero** validation, coercion, or required-field enforcement at workflow start. Client-side validation in Studio `RunDialog.tsx:52-100` is the only check, and every non-Studio trigger (cron, webhook, polling, agent) bypasses it. Missing required fields silently become `undefined` in `vars.*`, producing cascading downstream confusion.

2. **Silent end-node output-mapping failures.** `apps/workflow-engine/src/handlers/workflow-handler.ts:1357-1372` evaluates each declared output mapping (`{{...}}` expressions via `resolveExpressionTyped`). Failures are caught and replaced with `null` — no log, no trace, no error event, no step status, no operator visibility. A misspelled expression like `{{steps.frobnicate.output.bar}}` resolves to `null` indistinguishable from an intentional null.

3. **Start step lies; End step is invisible.** `workflow-handler.ts:674-703` creates a synthetic Start step record with `input = output = raw triggerPayload` (same object reference). No validation/coercion story is recorded. No End step record exists at all. Studio `DebugFlowLog.tsx:53-69, 71-111` **fabricates both** client-side as a workaround, which caused the user-reported three-way inconsistency:

| Surface                | Source                       | Shows Start | Shows End |
| ---------------------- | ---------------------------- | ----------- | --------- |
| Debug Flow Log panel   | Client-fabricated            | ✅ (fake)   | ✅ (fake) |
| Raw JSON panel         | `execution.steps[]` (engine) | ✅ (real)   | ❌        |
| Monitor tab step count | `execution.steps[]` (engine) | ✅ (real)   | ❌        |

4. **Dead code.** The two client-side fabrications in `DebugFlowLog.tsx` exist only because engine truth is incomplete. The `startInputVariables` extraction is dead metadata. Both must be removed once the engine becomes authoritative — the CLAUDE.md invariant is explicit: no backwards-compat shims for steady-state contracts.

**Outcome sought:** `start` and `end` become first-class execution step records with full lifecycle (`step.started`/`step.completed`/`step.failed` events, `durationMs`, `input`, `output`, `error`, `metrics`), engine-side input validation and type coercion, and per-mapping error visibility on the End step. All three UI surfaces (Debug panel, Raw JSON, Monitor) agree because they read the same engine truth. Client fabrications and dead extraction paths are removed.

---

## 2. Alternatives Considered

### Option A: Promote start/end to `WorkflowStep[]` entries dispatched through `dispatchStep`

- **Description.** Add `'start'` and `'end'` to the `BaseWorkflowStep` union. Remove the skip at `canvas-to-steps.ts:196-201`. Write `StartStepExecutor` and `EndStepExecutor` in `apps/workflow-engine/src/executors/`. Route them through the standard step queue.
- **Pros.** Uniform — every node type is a step. Shared lifecycle code (timing, events, persistence) applies automatically.
- **Cons.** Large blast radius: touches the dispatcher switch, union exhaustiveness tests, topological-walk invariants, every test that asserts "start/end are skipped", and `onSuccessSteps/onFailureSteps` filter logic that currently relies on end-node IDs being non-executable. Invents executors for nodes that have no executor concern — validation and mapping-resolution are workflow-handler-level concerns, not per-step-executor work.
- **Effort.** L.

### Option B: Special-case start/end as handler-managed step records (chosen)

- **Description.** Keep start/end out of `WorkflowStep[]` (no dispatcher changes). The workflow handler creates Start and End step records directly — mirroring the existing synthetic Start pattern at `workflow-handler.ts:674-703` and extending it. Both records use the existing `ExecutionStepResult` shape and the existing `updateStepStatus` / publisher.publish contracts. `startInputVariables` flows through `CanvasConversionResult → BuildExecutionPayloadInput → WorkflowExecutionPayload → WorkflowExecutionInput` so the handler has what it needs. The handler's Start-phase validates and coerces; the handler's End-phase evaluates all mappings, collects per-mapping errors into a new optional `mappingErrors[]` field, and fails the workflow when any mapping fails.
- **Pros.** Minimal structural change. Follows the existing synthetic-Start precedent. No dispatcher union or executor churn. Each change is independently testable and independently revertable.
- **Cons.** Two step records that don't flow through `dispatchStep` — a mild conceptual asymmetry. Mitigated by: `dispatchStep` is a lower-layer concern ("given a runnable step, dispatch it"); Start/End are not runnable in that sense.
- **Effort.** M.

### Option C: Client-side only — improve the fabrication in `DebugFlowLog.tsx`

- **Description.** Leave engine as-is. Expand the client-side Start fabrication to surface declared input variables. Add richer client-side End fabrication to call a new "dry-run" endpoint that evaluates mappings and reports errors.
- **Pros.** No engine changes. Fast to ship.
- **Cons.** **Does not fix the actual bugs.** Input validation still bypasses every non-Studio trigger path. Mapping errors still silent at the engine. Raw JSON panel still missing End. Monitor count still wrong. Cements the lie — Studio and Monitor disagree forever. Violates CLAUDE.md "fix the code, not the symptom" and "no backwards-compat shims."
- **Effort.** S.

### Recommendation: Option B

**Rationale.** Option B addresses the root cause (engine truth) with minimal architectural change. The existing synthetic Start pattern proves the approach works end-to-end. Option A buys conceptual purity at the cost of touching the dispatcher core — risk not justified by any observable benefit (users see the same Debug panel either way). Option C is a shim that doesn't fix the trigger-fired validation gap or the silent-null mapping failures. Option B also delivers the code cleanup (remove `DebugFlowLog.tsx` fabrications, remove the dead `startInputVariables` extraction dead-end by actually wiring it) without feature flags or tombstone comments.

---

## 3. Architecture

### System Context Diagram

```
Studio Canvas ──(POST /executions/execute)──► Runtime ──(proxy)──► Workflow Engine
   │                                                                      │
   │                                                            ┌─────────┴──────────┐
   │                                                            │  HTTP execute route │──► preflight validate (optional 4xx for UX)
   │                                                            │  Restate service    │
   │                                                            │  Workflow Handler   │
   │                                                            │   ├─ Start phase    │◄── canonical validation + coercion
   │                                                            │   │   persist step  │      (runs for EVERY fire path: studio,
   │                                                            │   │   emit events   │       webhook, cron, agent, polling)
   │                                                            │   ├─ Step loop      │
   │                                                            │   └─ End phase      │◄── evaluate ALL mappings, collect errors
   │                                                            │       persist step  │    fail workflow if any mapping fails
   │                                                            │       emit events   │
   │                                                            └─────────┬──────────┘
   ▼                                                                      │
execution.steps[] (MongoDB) ◄────────────────────────────────────────────┘
   │
   └── Read by: Debug Flow Log panel, Raw JSON panel, Monitor tab
       (all three render identical engine truth — fabrications removed)
```

### Component Diagram — Changes only

```
apps/workflow-engine/src/
├── handlers/
│   ├── canvas-to-steps.ts            // startInputVariables already extracted; unchanged
│   └── workflow-handler.ts           // MODIFIED
│       ├── WorkflowExecutionInput    //   + startInputVariables?: StartInputVariable[]
│       ├── runWorkflow()             //   + Start phase: validate+coerce+persist+events
│       │                             //   + End phase: evaluate-all+persist+events
│       └── buildWorkflowContext()    //   uses coerced vars map (not raw payload)
├── lib/
│   └── execution-payload.ts          // MODIFIED
│       ├── WorkflowExecutionPayload  //   + startInputVariables: StartInputVariable[]
│       ├── BuildExecutionPayloadInput //  + startInputVariables?
│       └── buildWorkflowExecutionPayload // defaults to []
├── validation/
│   └── start-input-validator.ts      // NEW: pure function validateAndCoerceInput()
└── routes/
    └── workflow-executions.ts        // MODIFIED: preflight validation (UX 4xx)

apps/workflow-engine/src/services/
├── trigger-engine.ts                 // MODIFIED: forward startInputVariables in payload
└── trigger-scheduler.ts              // MODIFIED: forward startInputVariables in payload

apps/studio/src/
├── components/workflows/canvas/panels/
│   └── DebugFlowLog.tsx              // MODIFIED: remove synthetic Start + End fabrications
└── api/workflows.ts                  // MODIFIED: ExecutionStepResult adds mappingErrors?
```

### Data Flow — Start phase

```
1. Handler receives WorkflowExecutionInput (steps, startInputVariables, triggerPayload, …)
2. Handler invokes validateAndCoerceInput(startInputVariables, triggerPayload):
     → returns { ok: true, coerced } OR { ok: false, errors: FieldError[] }
3a. On ok: false:
     ─ persist Start step { status: 'failed', input: triggerPayload, error: {code:'INPUT_VALIDATION_FAILED', …}, mappingErrors:[fieldErrors]? }
     ─ publisher.publish(step.failed, step.id='start')
     ─ execution status = failed, emit workflow.failed
     ─ return early with WorkflowExecutionResult{status:'failed', …}
3b. On ok: true:
     ─ ctx = buildWorkflowContext(input, executionId, coerced)   // vars is coerced (was raw)
     ─ persist Start step { status: 'completed', input: triggerPayload, output: coerced, metrics:{processingTimeMs}, durationMs }
     ─ publisher.publish(step.started, then step.completed for 'start')
     ─ continue to step loop
```

### Data Flow — End phase

```
1. Step loop finishes naturally (no further steps in queue, no cancellation, no upstream failure)
2. Handler begins End phase:
     ─ startTime = Date.now()
     ─ persist End-start transition:
        updateStepStatus('end', 'running', { input: input.outputMappings })
        publisher.publish(step.started, stepId='end')
     ─ (prerequisite: 'end' step record was included in initial stepRecords at handler init)
3. Evaluate ALL mappings (do NOT short-circuit):
     resolvedOutput = { _status: 0 }
     mappingErrors  = []
     for (m of input.outputMappings || []):
       try: resolvedOutput[m.name] = resolveExpressionTyped(m.expression, ctx)
       catch (e): mappingErrors.push({ name: m.name, expression: m.expression, error: e.message })
                  resolvedOutput[m.name] = null
4. Branch on errors:
   4a. mappingErrors.length === 0:
        ─ persist End step { status:'completed', output: resolvedOutput, durationMs, metrics }
        ─ publisher.publish(step.completed, stepId='end')
        ─ updateExecutionStatus('completed', { output: resolvedOutput, ... })   // unchanged
        ─ enqueue callback delivery with payload.output = resolvedOutput         // unchanged
   4b. mappingErrors.length > 0:
        ─ error = { code: 'OUTPUT_MAPPING_FAILED', message: `${mappingErrors.length} of N output mappings failed` }
        ─ persist End step { status:'failed', output: resolvedOutput /* with nulls for failed mappings */, error, mappingErrors, durationMs }
        ─ publisher.publish(step.failed, stepId='end', errorCode, error.message)
        ─ throw new WorkflowStepError(OUTPUT_MAPPING_FAILED, error.message)
        ─ Caught by existing top-level catch block (workflow-handler.ts:1427-1492):
          ├─ finalStatus = 'failed'
          ├─ workflow-level output = buildFailureOutput(errorMessage) = { _status: 1, _reason: errorMessage }
          │   (the partially-resolved `resolvedOutput` lives on the End step record; workflow-level
          │    output intentionally carries only failure summary to match existing failure contract
          │    and so downstream callback consumers see a consistent `{_status:1,_reason}` shape.)
          ├─ updateExecutionStatus('failed', { output: failOutput, error: {code:'WORKFLOW_FAILED', message} })
          ├─ publisher.publish(workflow.failed)
          └─ callback delivery: payload.status='failed', payload.output=failOutput — the per-mapping
             detail is recoverable via GET /executions/:id → steps[end].mappingErrors, which is the
             canonical source for debugging.
```

**Rationale for workflow-level `output = buildFailureOutput(...)` on mapping failure:** preserves the `{_status:1, _reason:string}` contract already used for all other workflow failures (consistent callback schema). Per-mapping debug detail is NOT lost — it is persisted on `steps[end].mappingErrors` and visible in the debug panel, Raw JSON panel, and via `GET /executions/:id`.

### Sequence Diagram — Validation failure path (trigger-fired, cron)

```
Cron Scheduler ─► trigger-scheduler.buildPayload (now includes startInputVariables)
              ─► restateClient.startWorkflow(payload)
                   │
                   ▼
Restate ─► workflow-handler.runWorkflow(input)
             │
             ├─ validateAndCoerceInput → { ok:false, errors:[{name:'email', reason:'REQUIRED'}] }
             │
             ├─ persistence.createExecution({status:'running', steps:[{id:'start',status:'pending'}, …]})
             ├─ persistence.updateStepStatus('start', 'failed', {input:triggerPayload, error:{…}, mappingErrors:errors})
             ├─ publisher.publish(step.failed, step.id='start')
             ├─ persistence.updateExecutionStatus('failed', {error, output:buildFailureOutput, …})
             ├─ publisher.publish(workflow.failed)
             │
             └─► returns WorkflowExecutionResult{ status:'failed', … }
                  │
                  ▼
Notification Dispatcher matches step.failed + workflow.failed rules → email / slack / webhook
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern              | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation** | No new collections. All persistence goes through existing `ExecutionStore.updateStepStatus(executionId, tenantId, projectId, stepId, …)`, which already scopes every write by `tenantId + projectId`. Start/End are just additional step IDs (`'start'`, `'end'`) inside existing `workflow_executions.nodeExecutions[]`. No query changes.                                                                                                                   |
| 2   | **Data Access**      | All reads/writes flow through `ExecutionStore` (unchanged). No new repositories. `updateStepStatus` signature already accepts an optional `data` bag that includes `input`, `output`, `error`, `durationMs`, `metrics`, `consoleLogs`, `context` (`workflow-handler.ts:108-125`). We add one optional key — `mappingErrors?` — to that bag.                                                                                                                   |
| 3   | **API Contract**     | `WorkflowExecutionInput`, `BuildExecutionPayloadInput`, and `WorkflowExecutionPayload` gain an optional `startInputVariables: Array<{name,type,required}>`. All three types are internal to `apps/workflow-engine` (grep-verified — no external SDK consumes them). No public API shape changes. Studio `ExecutionStepResult` gains an optional `mappingErrors?: Array<{name,expression,error}>`. Additive only.                                              |
| 4   | **Security Surface** | `validateAndCoerceInput` is a pure function over the trigger payload; it coerces known types (number via `Number()`, boolean via `/^(true\|1\|yes)$/i`, json via `JSON.parse`, string pass-through). JSON parsing is already used at workflow boundaries; the risk is bounded to the caller's own payload. No new auth surface. The preflight 4xx at the execute route lives after `requireAuth` + `requireProjectPermission` so tenancy is already enforced. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Start validation failures → `StepError { code: 'INPUT_VALIDATION_FAILED', message }` on the Start record + structured `mappingErrors[]` carrying per-field reasons (`REQUIRED`, `TYPE_MISMATCH`, `JSON_PARSE_ERROR`). End mapping failures → `StepError { code: 'OUTPUT_MAPPING_FAILED', message: 'N of M output mappings failed' }` + structured `mappingErrors[]` per expression. Workflow-level `{ code: 'WORKFLOW_FAILED', message }` is set by the existing catch block — unchanged.                |
| 6   | **Failure Modes** | Start validation: pure CPU, cannot throw unexpectedly. End expression evaluation: `resolveExpressionTyped` can throw for malformed templates or runtime type errors — caught per-mapping. Persistence failures: `updateStepStatus` failures propagate as errors (existing behavior). Publisher failures are non-fatal (existing behavior). Restate replay: all new persistence is OUTSIDE `ctx.run()` — direct Mongo writes — so the Restate journal is unaffected; idempotent upserts keep replay safe. |
| 7   | **Idempotency**   | `ExecutionStore.updateStepStatus` is idempotent by (`executionId`, `tenantId`, `projectId`, `stepId`) — Restate replay invoking Start or End twice produces the same row. No duplicate rows, no duplicate SSE events that observers can't handle (Studio sorts by `startedAt` — duplicate events collapse on ID).                                                                                                                                                                                        |
| 8   | **Observability** | Start and End emit `step.started` / `step.completed` or `step.failed` on the existing `workflow:${tenantId}:execution:${executionId}:status` Redis channel. Both carry `stepId` (`'start'`/`'end'`), `stepType`, `durationMs`, `error`. Studio's debug panel already renders these from `execution.steps[]`. No new channels, no new logs beyond `log.warn`/`log.info` for validation failures (operator debugging).                                                                                     |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Start validation: O(`                                                                                                                                                                                                                                                                                                                                                                                                                                     | inputVariables | `) — typically < 20 fields, < 1 ms. End mapping evaluation: O(` | outputMappings | `) expression resolutions — already performed today; no change to evaluation cost. Added MongoDB writes: 2 per workflow (Start+End step records, `updateStepStatus` × 2). At NFR-01 (< 5s p99 step latency), 2 × ~5 ms Mongo upserts is negligible. Added Redis publishes: 4 per workflow (2 started + 2 completed/failed), dwarfed by existing workflow traffic. |
| 10  | **Migration Path**     | **No data migration.** Pre-feature executions already carry a Start step record (synthetic Start has been live since the code at `workflow-handler.ts:674-703`); they simply won't carry the new `mappingErrors` or validation metadata. Pre-feature executions do NOT have an End step — post-feature UI shows no End for those, which is accurate. Workflows is BETA with small data volume. CLAUDE.md: "no backwards-compat shims."                    |
| 11  | **Rollback Plan**      | **Revert-the-commit.** The implementation is delivered as multiple small commits scoped per the commit-scope-guard (≤40 files, ≤3 packages each). Recommended commit order: (a) wire `startInputVariables` through payload + schemas [low risk, additive], (b) Start step validation+persistence [the risky one — isolate], (c) End step persistence + mapping error collection, (d) remove Studio fabrications. Each commit is independently revertable. |
| 12  | **Test Strategy**      | See Section 10 below. Summary: unit tests on pure `validateAndCoerceInput`; integration tests on handler Start/End phases against real MongoDB + real Redis; E2E tests (min 5) via the real HTTP execute route + Restate → assert `execution.steps[]` contains Start+End with expected shapes, SSE events received in order. **No mocking of platform components.**                                                                                       |

---

## 5. Data Model

### Modified Collections

**`workflow_executions.nodeExecutions[]`** — step record additions for IDs `'start'` and `'end'`, plus a NEW schema field `mappingErrors`.

```typescript
// Existing shape (packages/database/src/models/workflow-execution.model.ts:133-173)
{
  nodeId: 'start' | 'end' | <uuid>,
  nodeName: 'Start' | 'End' | <user-name>,
  nodeType: 'start' | 'end' | <step-type>,
  status: 'pending' | 'running' | 'completed' | 'failed' | ...,
  startedAt, completedAt,
  input, output,
  error: { code, message, httpStatus?, responseBody? },
  durationMs,
  metrics: { responseTimeMs?, processingTimeMs? },
  consoleLogs, iteration, iterationResults,
  approvalDecision, approvalDecidedBy, approvalDecidedAt, approvalReason,
  callbackSecret, callbackReceivedAt, callbackPayload,
  // NEW field — optional, used on Start (validation errors) or End (mapping errors):
  mappingErrors?: Array<{ name: string; expression?: string; error: string }>
}
```

**Required Mongoose schema change (CRITICAL).** `NodeExecutionSchema` at `packages/database/src/models/workflow-execution.model.ts:133-173` uses Mongoose default `strict: true`, which silently strips any field not declared on the schema during `$set` updates. Before this HLD can be implemented, the schema MUST add:

```typescript
// in NodeExecutionSchema (workflow-execution.model.ts:133-173)
mappingErrors: { type: [Schema.Types.Mixed] },
```

And the matching `INodeExecution` interface must declare `mappingErrors?: Array<{ name: string; expression?: string; error: string }>`. This is the identical class of bug documented in GAP-14 (parent spec) and the `2026-04-16 Data-Flow Audit` entry in `apps/workflow-engine/agents.md` — where `cancelledAt`, `approvalDecision`, `webhookMode` were all silently dropped because the schema wasn't updated in lockstep with the data bag.

Start step record stores field-level validation errors in `mappingErrors` (`expression` is absent — it's a declared-field name, not an expression). End step record stores per-mapping expression errors.

### Initial `stepRecords` array must include End (CRITICAL).

Today `workflow-handler.ts:666-679` creates `stepRecords` with the synthetic Start entry prepended. `ExecutionStore.updateStepStatus` uses `findOneAndUpdate({ 'nodeExecutions.nodeId': stepId }, ...)` — if no matching entry exists, the update silently matches zero documents.

After this HLD, the initial `stepRecords` array MUST include BOTH boundary entries:

```typescript
// at handler init, before createExecution(...)
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

Start and End statuses transition `pending → running → completed|failed` via `updateStepStatus` calls in the handler, matching every other step's lifecycle.

### No new collections. No new indexes.

### Key Relationships

Unchanged. Start and End are additional `nodeExecutions[]` entries on the same execution record.

---

## 6. API Design

### No new endpoints. No endpoint URL changes.

### Modified internal type shapes

| Type                                                            | Location                                                               | Change                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CanvasConversionResult`                                        | `apps/workflow-engine/src/handlers/canvas-to-steps.ts`                 | No change (already has `startInputVariables`).                                                                                                                                                                                        |
| `ResolvedWorkflowDefinition`                                    | `apps/workflow-engine/src/lib/version-resolution.ts:81-89`             | `+ startInputVariables: StartInputVariable[]` (ALL tiers of `resolveWorkflowDefinition` must propagate `conversion.startInputVariables`).                                                                                             |
| `ExecutionDefinition` (route-internal)                          | `apps/workflow-engine/src/routes/workflow-executions.ts:130-136`       | `+ startInputVariables: StartInputVariable[]` (plus all three `build*ExecutionDefinition` functions that return it).                                                                                                                  |
| `BuildExecutionPayloadInput`                                    | `apps/workflow-engine/src/lib/execution-payload.ts`                    | `+ startInputVariables?: StartInputVariable[]` (defaults to `[]`).                                                                                                                                                                    |
| `WorkflowExecutionPayload`                                      | `apps/workflow-engine/src/lib/execution-payload.ts`                    | `+ startInputVariables: StartInputVariable[]` (always present).                                                                                                                                                                       |
| `WorkflowExecutionInput`                                        | `apps/workflow-engine/src/handlers/workflow-handler.ts`                | `+ startInputVariables?: StartInputVariable[]`.                                                                                                                                                                                       |
| `ExecutionPersistence.updateStepStatus` **TypeScript data bag** | `apps/workflow-engine/src/handlers/workflow-handler.ts:108-125`        | `+ mappingErrors?: Array<{ name: string; expression?: string; error: string }>` on the `data?` parameter type. Without this, TypeScript rejects passing `mappingErrors` at the call site — even after the Mongoose schema accepts it. |
| `NodeExecutionSchema` (Mongoose)                                | `packages/database/src/models/workflow-execution.model.ts:133-173`     | `+ mappingErrors: { type: [Schema.Types.Mixed] }` (required — Mongoose strict:true silently strips undeclared fields).                                                                                                                |
| `INodeExecution` (TypeScript)                                   | `packages/database/src/models/workflow-execution.model.ts` (interface) | `+ mappingErrors?: Array<{ name: string; expression?: string; error: string }>`.                                                                                                                                                      |
| `ExecutionStepResult` (Studio)                                  | `apps/studio/src/api/workflows.ts`                                     | `+ mappingErrors?: Array<{ name: string; expression?: string; error: string }>`.                                                                                                                                                      |

**Note on `WorkflowExecutionInputSchema` (Zod, `packages/shared/src/types/workflow-schemas.ts`)**: NO change. That Zod schema validates the HTTP execute-route body sent by external callers. `startInputVariables` is injected server-side by `convertCanvasToSteps` from the workflow definition — external callers never send it. Adding it to the public schema would invite callers to inject arbitrary validation rules.

**Wiring trace (every `startInputVariables` handoff site)**: `canvas-to-steps.ts` extracts → `convertVersionDocToSteps` / `convertWorkflowDocToSteps` return it in `CanvasConversionResult` (unchanged) → every tier of `resolveWorkflowDefinition` (pinned, active, deployment, draft, legacy) MUST propagate `conversion.startInputVariables` into `ResolvedWorkflowDefinition` → the three route builder functions (`buildWorkingCopyExecutionDefinition`, `buildVersionExecutionDefinition`, `buildDefaultVersionExecutionDefinition`) MUST propagate into `ExecutionDefinition` → call sites at `trigger-engine.ts:555-575`, `trigger-scheduler.ts:263-287`, `workflow-executions.ts:505-523` MUST forward into `buildWorkflowExecutionPayload` → handler receives via `WorkflowExecutionInput.startInputVariables`. LLD must enumerate each site and verify in the wiring checklist.

`StartInputVariable` is a new shared type:

```typescript
export interface StartInputVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  required: boolean;
}
```

Lives in `canvas-to-steps.ts` (currently inline) — promote to named `export` so it's importable by `execution-payload.ts`, `workflow-handler.ts`, and the new validator.

### Error Responses

- Execute-route preflight validation failure → `400` with body:
  ```json
  {
    "success": false,
    "error": {
      "code": "INPUT_VALIDATION_FAILED",
      "message": "2 input fields failed validation",
      "fields": [
        { "name": "email", "reason": "REQUIRED" },
        { "name": "amount", "reason": "TYPE_MISMATCH", "expected": "number", "got": "string" }
      ]
    }
  }
  ```
- Trigger-fired validation failure → no 4xx (trigger is async). Execution is created with `status=failed`, Start step `status=failed`, `workflow.failed` event emitted, notification rules fire.
- End mapping failure → Execution `status=failed`, End step `status=failed` with `mappingErrors[]`, `workflow.failed` event.

---

## 7. Cross-Cutting Concerns

- **Audit Logging.** Workflow-engine lacks audit logging today (GAP-10 in parent spec). Out of scope here; deferred to the separate GAP-10 remediation.
- **Rate Limiting.** No change — pre-existing rate limiting on execute route already applies.
- **Caching.** No new caches. Pure functions.
- **Encryption.** No new sensitive data. Validation errors on `input` payloads may surface in logs; same handling as existing step errors.
- **Tracing.** Existing OTel instrumentation on the workflow-engine (per parent HLD) continues to cover Start/End via the same span boundaries as other steps.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                              | Type     | Risk                                                                    |
| --------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `ExecutionStore.updateStepStatus`       | Internal | Low — existing, stable API. Adding one optional data-bag key.           |
| `StatusPublisher.publish`               | Internal | Low — same channel, same shape, new `stepId` values.                    |
| `resolveExpressionTyped`                | Internal | Low — already used by current End-phase code.                           |
| `StartNodeConfig.inputVariables` schema | Studio   | Low — already present in `StartNodeConfig.tsx:14-19`; schema is stable. |
| Restate durable execution               | External | Low — new persistence is outside `ctx.run()`, no journal impact.        |

### Downstream (consumers of this feature)

| Consumer                                   | Impact                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Studio `DebugFlowLog.tsx`                  | Remove fabrications; render engine-authoritative steps only.                                                                                            |
| Studio `WorkflowMonitorTab.tsx`            | No code change. Step count naturally includes Start + End (both now present in `execution.steps[]`).                                                    |
| Studio `WorkflowDebugPanel.tsx` (Raw JSON) | No code change. JSON viewer renders full `execution` including new Start/End step records.                                                              |
| Notification rules                         | `step.failed` on Start (validation) or End (mapping) now fires; existing rules for `step.failed`/`workflow.failed` pick them up without config changes. |
| Triggers (cron/webhook/poll/agent)         | Must include `startInputVariables` in payload; existing code paths through `buildWorkflowExecutionPayload` handle this once payload builder is updated. |

---

## 9. Open Questions & Decisions Needed

All product decisions are locked (see `docs/sdlc-logs/workflow-start-end-first-class-steps/hld.log.md`, D-1..D-17). One implementation-level open question remains for the LLD phase:

1. **Preflight 4xx vs 200-with-failed-execution at the execute route.** The HLD commits to a preflight 4xx for the sync studio path (fast UX) AND handler-side validation (canonical, covers all fire paths). LLD should pin the exact route handler — `apps/workflow-engine/src/routes/workflow-executions.ts` — and confirm no external SDK/clients assume the current behavior (they shouldn't — validation doesn't exist today — but document the assumption).

---

## 10. Test Strategy (concern #12 expanded)

### Unit tests (no mocks)

- `validateAndCoerceInput` pure function:
  - Required field missing → `{ok:false, errors:[{name, reason:'REQUIRED'}]}`.
  - Number coercion: `"42"` → `42`; `"abc"` → `TYPE_MISMATCH`; `true` (already number-ish) → coerced.
  - Boolean coercion: `"true"/"1"/"yes"` (case-insensitive) → `true`; `"false"/"0"/"no"` → `false`; `"maybe"` → `TYPE_MISMATCH`.
  - JSON coercion: `'{"a":1}'` → `{a:1}`; `'not json'` → `JSON_PARSE_ERROR`.
  - String pass-through: `"anything"` → `"anything"`.
  - Empty `startInputVariables` + any payload → `{ok:true, coerced: rawPayload}` (no declared vars = no coercion).
  - Extra payload fields (not declared) → pass-through preserved in `coerced`.

### Integration tests (real MongoDB, real Redis, no mocks of platform components)

- Handler with valid input → execution record has Start (completed) + End (completed) step records with expected `input`, `output`, `durationMs`, `metrics.processingTimeMs`.
- Handler with invalid input → execution status `failed`, Start step `failed` with `mappingErrors[]` field errors, no steps executed.
- Handler with failing end-mapping → all mappings evaluated, End step `failed` with `mappingErrors[]`, workflow `failed`.
- Handler with empty `outputMappings` → End step `completed` with `output: {_status: 0}`, no `mappingErrors`.
- SSE publisher receives `step.started(start)` → `step.completed(start)` → `workflow.started` → … → `step.started(end)` → `step.completed(end)` → `workflow.completed`.

### E2E tests (real HTTP execute route, real Restate, real MongoDB, no mocks) — **minimum 5**

1. **E2E-1: Happy path with declared inputs.** Canvas with 2 input variables (`email: string required`, `amount: number required`), 2 user steps (an `http` and a `function`), and 1 output mapping; POST `/executions/execute` with `{email:"a@b", amount:"100"}`; assert `GET /executions/:id` shows 4 step records (start, http, function, end), `start.output.amount === 100` (number after coercion), `end.output.total === 100`, `status: completed`.
2. **E2E-2: Missing required input via execute route.** Same canvas, POST with `{amount:"100"}` (no email); assert `400` with `INPUT_VALIDATION_FAILED` + `fields[0].name === 'email'`; no execution record created.
3. **E2E-3: Missing required input via webhook trigger.** Register a webhook trigger for same workflow, POST webhook URL with `{amount:"100"}`; assert execution created with `status:failed`, Start step `status:failed`, `workflow.failed` event received via SSE subscription.
4. **E2E-4: Bad output mapping expression.** Canvas with output mapping `{total: "{{steps.nonexistent.output.foo}}"}`; POST execute; assert execution `failed`, End step `failed` with `mappingErrors[0].name === 'total'`, Raw JSON panel source (`GET /executions/:id`) contains `steps[].error` on end.
5. **E2E-5: Multiple mappings, one fails, all errors collected.** Canvas with 3 output mappings, one referencing a missing path; assert `mappingErrors.length === 1` but `output` still contains the 2 valid values (with the failing one as `null`), workflow `failed`.

### Cross-phase consistency

After implementation, `/post-impl-sync workflow-start-end-first-class-steps` updates: the parent `workflows.md` gap table (close GAP implicit in this work), coverage matrix in `docs/testing/workflows.md`, and LLD status.

---

## 11. Dead Code Cleanup Inventory

Per user directive: no dead code, no tombstone comments. This implementation removes:

| Dead code                                                                                  | Location                                                        | Replaced by                                                                   |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Unconsumed `startInputVariables` extraction flowing to nothing                             | `canvas-to-steps.ts:351-358` (remains; now consumed)            | Wired through payload → handler → validator.                                  |
| Client-side synthetic Start fabrication                                                    | `DebugFlowLog.tsx:54-69`                                        | Engine-persisted Start step.                                                  |
| Client-side synthetic End fabrication                                                      | `DebugFlowLog.tsx:72-111`                                       | Engine-persisted End step.                                                    |
| `executionOutput`, `executionStatus` props on `DebugFlowLog` (used only for fabrication)   | `DebugFlowLog.tsx:11-19` and caller in `WorkflowDebugPanel.tsx` | Removed — engine-persisted End carries this data directly on its step record. |
| Silent `catch { resolvedOutput[mapping.name] = null; }` at `workflow-handler.ts:1368-1370` | `workflow-handler.ts:1368-1370`                                 | New per-mapping error collection populating `mappingErrors[]`.                |

No `// removed` comments, no compatibility shims, no feature flags, no renamed-to-`_` unused variables.

---

## 12. References

- Parent feature spec: `docs/features/workflows.md`
- Parent HLD: `docs/specs/workflows.hld.md`
- Oracle decision log: `docs/sdlc-logs/workflow-start-end-first-class-steps/hld.log.md`
- Related: `docs/specs/workflow-versioning.hld.md`, `docs/specs/workflow-triggers.hld.md`
- Source files cited: `apps/workflow-engine/src/handlers/{canvas-to-steps,workflow-handler}.ts`, `apps/workflow-engine/src/lib/execution-payload.ts`, `apps/studio/src/components/workflows/canvas/panels/{DebugFlowLog,RunDialog,WorkflowDebugPanel}.tsx`, `apps/studio/src/components/workflows/tabs/WorkflowMonitorTab.tsx`, `apps/studio/src/api/workflows.ts`.
- Platform invariants: `CLAUDE.md` (no backwards-compat shims; no dead code; no feature flags for steady-state; commit scope guard; test architecture — no mocking platform components).
- SDLC pipeline: `docs/sdlc/pipeline.md`.
