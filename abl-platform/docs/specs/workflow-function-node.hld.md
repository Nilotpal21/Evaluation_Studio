# HLD: Workflow Function Node with Context Injection

**Feature Spec**: `docs/features/sub-features/workflow-function-node.md`
**Test Spec**: `docs/testing/sub-features/workflow-function-node.md`
**Status**: APPROVED
**Author**: Runtime Team
**Date**: 2026-04-07

---

## 1. Problem Statement

The workflow engine's `function` canvas node maps to the `transform` executor (`canvas-to-steps.ts:L49`), which evaluates a single `{{path}}` expression and assigns the result to a context variable. Workflow authors who need to filter arrays, combine multi-step data, perform arithmetic, parse strings, or conditionally construct output must chain multiple transform and condition nodes -- or accept that the engine cannot express their logic.

This HLD designs a dedicated `function` executor that runs user-written JavaScript in an `isolated-vm` V8 sandbox with full workflow context access, replacing the `function -> transform` stub mapping with a real implementation.

---

## 2. Alternatives Considered

### Option A: Expression Extension (extend transform executor)

- **Description**: Add array/object methods to the expression resolver (e.g., `{{steps.API.output.body | filter('active')}}`, `{{steps.A.output | merge(steps.B.output)}}`). No sandbox.
- **Pros**: No new dependency. No native module compilation. Minimal code change.
- **Cons**: Invents a DSL that grows unboundedly. Cannot express arbitrary logic (loops, conditionals, intermediate variables). Every new operation requires a resolver change. No community familiarity.
- **Effort**: M (ongoing maintenance cost is high)

### Option B: isolated-vm V8 Sandbox (chosen)

- **Description**: Execute user-written JavaScript inside an `isolated-vm` V8 isolate. The isolate has no access to Node.js globals. Context injected as a frozen read-only object. Writes via controlled `setOutput`/`setVar` callbacks.
- **Pros**: Full JavaScript expressiveness. Battle-tested sandboxing (separate V8 heaps, no shared memory). Well-established npm package (~3M weekly downloads). No custom DSL to maintain. Timeout and memory limits built in.
- **Cons**: Native module (requires `node-gyp` compilation in Docker). ~5ms per-isolate overhead. Adds ~50MB to node_modules. Alpine/Debian Dockerfile mismatch must be resolved.
- **Effort**: M

### Option C: vm2/Node.js vm module

- **Description**: Use Node.js built-in `vm` module or the `vm2` wrapper for sandboxed execution.
- **Pros**: No native compilation. Built into Node.js.
- **Cons**: `vm` module is NOT a security boundary (Node.js docs explicitly state this). `vm2` is deprecated and has known sandbox escape CVEs (CVE-2023-29017, CVE-2023-37466). Cannot enforce memory limits. Cannot enforce timeouts reliably (no isolate-level termination).
- **Effort**: S (but fundamentally unsafe for multi-tenant execution)

### Recommendation: Option B (isolated-vm)

**Rationale**: Option A doesn't solve the problem (arbitrary logic). Option C is a security risk in multi-tenant environments. `isolated-vm` provides real V8-level isolation with built-in resource limits. The native module compilation concern (Docker) is solvable by switching the builder stage to Debian (matching the production image). The per-isolate overhead (~5ms) is negligible for workflow step execution.

---

## 3. Architecture

### System Context Diagram

```
                        ┌──────────────┐
                        │   Studio UI  │
                        │  (Playwright │
                        │   canvas)    │
                        └──────┬───────┘
                               │ save workflow (canvas JSON)
                               ▼
                        ┌──────────────┐
                        │   Runtime    │
                        │  (3112)      │
                        └──────┬───────┘
                               │ POST /execute
                               ▼
                        ┌──────────────┐
                        │   Restate    │
                        │  (8091)      │
                        └──────┬───────┘
                               │ invoke workflow handler
                               ▼
┌──────────────────────────────────────────────────────────┐
│                    Workflow Engine (9081)                  │
│                                                           │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────┐ │
│  │ canvas-to-  │───►│    step-     │───►│  function-   │ │
│  │  steps.ts   │    │ dispatcher   │    │  executor.ts │ │
│  │             │    │              │    │              │ │
│  │ function:   │    │ switch(type) │    │ ┌──────────┐ │ │
│  │  'function' │    │  'function'  │    │ │ V8       │ │ │
│  └─────────────┘    │   ──────►    │    │ │ Isolate  │ │ │
│                     └──────────────┘    │ │(isolated │ │ │
│  ┌─────────────┐                        │ │  -vm)    │ │ │
│  │ expression- │◄───────────────────────│ │          │ │ │
│  │  resolver   │  resolve inputVars     │ └──────────┘ │ │
│  └─────────────┘                        └──────────────┘ │
│                                                           │
│  ┌─────────────┐    ┌──────────────┐                     │
│  │ workflow-   │    │  persistence │──► MongoDB           │
│  │  handler    │    │  + publisher │──► Redis             │
│  └─────────────┘    └──────────────┘                     │
└──────────────────────────────────────────────────────────┘
```

### Component Diagram

```
function-executor.ts
├── createIsolate(memoryMB)          // V8 isolate with memory limit
├── buildContextSnapshot(ctx)         // Deep-copy + freeze WorkflowContextData
├── injectGlobals(isolate, snapshot)  // Set workflow global, console, setOutput, setVar
├── resolveInputVariables(step, ctx)  // Expression resolution + type coercion
├── executeScript(isolate, code, timeout)  // Run with timeout
├── collectResults(buffers)           // Output, vars, logs from host-side buffers
└── cleanup(isolate)                  // Dispose isolate
```

### Data Flow

**Happy path (function node execution):**

1. `workflow-handler.ts` dequeues function step from execution queue.
2. `dispatchWithRetry()` wraps execution in `restateCtx.run()` for durability.
3. `dispatchStep()` matches `step.type === 'function'`, calls `executeFunctionStep(step, ctx)`.
4. `function-executor.ts`:
   a. Creates a new `isolated-vm` Isolate with 128MB memory limit.
   b. Creates a Context within the isolate.
   c. Deep-copies `WorkflowContextData` via `ExternalCopy` into the isolate heap.
   d. Recursively freezes the copy and assigns it to `workflow` global.
   e. Registers `workflow.setOutput()`, `workflow.setVar()`, `console.log/warn/error` as host-side callbacks. Each callback buffers its arguments -- no immediate writes to `ctx`.
   f. If `inputVariables` are configured, resolves each via `resolveExpressionTyped()` and coerces to declared type. Injects as top-level variables.
   g. Compiles user code and runs synchronously with `timeout` limit.
   h. On success: applies buffered `setVar` writes to `ctx.vars`, reads buffered `setOutput` value as step output. Collects console logs.
   i. On failure: discards all buffers (atomic rollback). Wraps V8 error as `WorkflowStepError` with `SCRIPT_ERROR` code and line/column info.
   j. Disposes the isolate.
5. `dispatchStep()` wraps result into `StepDispatchResult { type: 'function', output, input }`.
6. `workflow-handler.ts` updates `ctx.steps[stepId]` and persists status.

**Error path:**

```
V8 Error (syntax/runtime/timeout/OOM)
  └─► function-executor catches
       └─► WorkflowStepError { code: SCRIPT_ERROR, message, line?, column? }
            └─► dispatchStep returns { type: 'function', output: null, error }
                 └─► workflow-handler marks step 'failed'
                      └─► existing error-edge routing in workflow-handler.ts (if failure edges exist) or workflow fails
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Each function execution creates a new `isolated-vm` Isolate with its own V8 heap. No shared memory between isolates. `WorkflowContextData` is deep-copied per execution, scoped to `tenantId`/`projectId` by the engine's existing context construction. Concurrent executions across tenants use separate isolates -- no module-level shared state in the executor.                                                                                                                                                                                                                    |
| 2   | **Data Access Pattern** | No database access. The function executor is a pure computation layer: input is `(FunctionStep, WorkflowContextData)`, output is `FunctionResult`. Context is constructed by `workflow-handler.ts` from the execution state already in memory. No repository layer, no caching.                                                                                                                                                                                                                                                                                                         |
| 3   | **API Contract**        | No new HTTP endpoints. The function executor is internal to the workflow engine. The contract is the executor function signature: `executeFunctionStep(step: FunctionStep, ctx: WorkflowContextData): Promise<FunctionResult>`. The `FunctionResult` shape: `{ output: unknown; logs: Array<{ level, args }>; durationMs: number }`. `FunctionResult` is the success shape only. On error, the executor throws `WorkflowStepError` (see concern #6) -- the result type is not used.                                                                                                     |
| 4   | **Security Surface**    | **Sandbox**: V8 isolate has no Node.js globals (`require`, `process`, `fs`, `Buffer`, `setTimeout`, `fetch`). Only ECMAScript built-ins. **No I/O**: Scripts cannot make network requests, read files, or access the host. **Read-only context**: `WorkflowContextData` is deep-frozen before injection. **Write control**: `setOutput`/`setVar` are host-side callbacks that buffer writes. **Resource limits**: Memory (128MB), timeout (5-60s), output size (1MB), log count (100). **No eval escalation**: `eval()` inside the isolate is contained -- no dangerous APIs to expose. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | All script errors surface as `WorkflowStepError` with `code: 'SCRIPT_ERROR'`. Subtypes: `SyntaxError` (compilation), `RuntimeError` (execution), `TimeoutError` (exceeded limit), `OOMError` (memory exceeded), `OutputSizeError` (>1MB), `CoercionError` (input variable type mismatch). Each includes `message` and, where available, `line`/`column` from V8 stack. Debug panel displays error details.                                                                                                                                                                                                                   |
| 6   | **Failure Modes** | (1) Script syntax error: caught at compile time, step fails immediately. (2) Script runtime error: caught by isolate, step fails with stack trace. (3) Timeout: isolate terminated by `isolated-vm`, step fails with timeout message. (4) OOM: isolate terminated by V8, step fails with memory message. (5) `isolated-vm` native crash: caught by Restate durable execution, workflow replayed on new instance. (6) Output too large: caught before context write, step fails. (7) Non-serializable output: caught at JSON.stringify, step fails. In all cases, buffered `setVar` writes are NOT applied (atomic rollback). |
| 7   | **Idempotency**   | Function execution is wrapped in `restateCtx.run()`, which journals the result. On replay, Restate uses the journaled output without re-executing the script. Scripts using `Date.now()` or `Math.random()` produce different values on re-execution, but this is safe because Restate journals the first execution's result.                                                                                                                                                                                                                                                                                                |
| 8   | **Observability** | (1) Step events: `step.started`, `step.completed`, `step.failed` via Redis Pub/Sub (existing). (2) `NodeExecution` record: includes `input` (code snippet + resolved inputVars), `output` (script result), `error` (SCRIPT_ERROR details), `durationMs`. (3) Console capture: `console.log/warn/error` stored in step result, displayed in debug panel. (4) Phase 2: execution duration histogram, error rate by type.                                                                                                                                                                                                       |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Isolate creation: ~5ms. Typical data transform: <100ms. p99 target: <500ms. Memory per isolate: ~5MB base + script heap (128MB max). Max concurrent isolates per tenant: 100 (existing workflow concurrency limit). No isolate pooling in Phase 1 (create/destroy per execution). **Pod-level memory**: 100 concurrent isolates x 128MB max = 12.8GB theoretical max per tenant. In practice, most isolates use <10MB. Pod-level memory is bounded by OS/container limits. Phase 2 should add pod-level memory tracking across all active isolates to prevent OOM under multi-tenant load.                                                                                                                           |
| 10  | **Migration Path**     | No data migration. The `NODE_TYPE_TO_STEP_TYPE` mapping change (`function: 'transform'` -> `function: 'function'`) applies at execution time, not at save time. All existing workflows with function nodes automatically use the new executor on next execution. **Backward compatibility**: if `config.code` is undefined/empty (legacy function node with only transform-style config), the executor falls back to transform behavior -- resolves `inputExpression` and writes to `outputVariable`.                                                                                                                                                                                                                |
| 11  | **Rollback Plan**      | Revert the one-line mapping in `canvas-to-steps.ts` back to `function: 'transform'`. Immediately routes all function nodes to the transform executor. No data rollback needed. Remove `isolated-vm` from `package.json` to eliminate native dependency. Remove the `function` case from `dispatchStep()` switch and `FunctionStep` from the `WorkflowStep` union -- the exhaustive `never` check ensures compile-time safety, and any remaining `function` steps would fail at the dispatch level with a clear error rather than silently.                                                                                                                                                                           |
| 12  | **Test Strategy**      | **Unit** (20 scenarios): Pure function tests of the executor with real `isolated-vm`. Context injection, setOutput/setVar, console capture, timeouts, memory limits, error handling, return value semantics. **Integration** (8 scenarios): Full dispatch chain (`runWorkflow` -> `dispatchStep` -> executor) with injected persistence/publisher. Sandbox isolation, atomic rollback, concurrent tenant isolation, error propagation. **E2E** (7 scenarios): Playwright browser tests via Studio UI. Full workflow execution with function nodes, loops, conditions, error cases. Real services (Studio, Runtime, Engine, Restate, MongoDB, Redis). No mocking of codebase components -- only external deps via DI. |

---

## 5. Data Model

### New Collections/Tables

**No new collections for Phase 1.** Function node code is stored as part of the workflow definition's `nodes[].config` field, validated against `FunctionNodeConfigSchema` (already defined at `workflow-schemas.ts:L122-L138`).

### Modified Collections/Tables

**No schema changes.** The existing `NodeExecution` collection stores function step results in its existing `output`, `error`, and `input` fields.

### Key Relationships

- `WorkflowDefinition.nodes[].config` -> Contains function node code, timeout, inputVariables.
- `NodeExecution.output` -> Stores `setOutput` value after execution.
- `NodeExecution.error` -> Stores `SCRIPT_ERROR` details on failure.
- `NodeExecution.input` -> Stores resolved input (code snippet + resolved inputVars) for debug panel.
- `WorkflowContextData.steps[nodeId].output` -> Function output accessible downstream via `{{steps.FN.output}}`.
- `WorkflowContextData.vars` -> Modified by `setVar()` calls (applied atomically on success).

---

## 6. API Design

### New Endpoints

**None.** Function nodes are internal to workflow execution. No new HTTP API.

### Modified Endpoints

**None.** Existing workflow CRUD and execute endpoints handle function node config transparently.

### Error Responses

Function node errors are embedded in the workflow execution result, not returned as HTTP error responses:

```json
{
  "steps": {
    "FN0001": {
      "status": "failed",
      "error": {
        "code": "SCRIPT_ERROR",
        "message": "ReferenceError: undefinedVar is not defined at line 3, column 12"
      }
    }
  }
}
```

**Note**: Line/column info is embedded in the `message` string (per LLD D-7), not as separate fields. The `StepError` interface is shared across all step types and is not extended with script-specific fields.

Error subtypes (all use `code: 'SCRIPT_ERROR'`, differentiated by message):

| Error       | Message Pattern                                   | Cause                       |
| ----------- | ------------------------------------------------- | --------------------------- |
| Syntax      | `SyntaxError: Unexpected token...` at line:col    | Invalid JavaScript          |
| Runtime     | `TypeError/ReferenceError: ...` at line:col       | Script execution error      |
| Timeout     | `Script execution timed out after Ns`             | Exceeded configured timeout |
| OOM         | `Script exceeded memory limit (128MB)`            | Exceeded isolate heap limit |
| Output size | `Script output exceeds maximum size (1MB)`        | `setOutput` value too large |
| Coercion    | `Input variable 'name' cannot be coerced to type` | inputVariable type mismatch |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Script execution events (start, complete, fail) are recorded in `NodeExecution` documents via the existing step event system. No additional audit logging needed.
- **Rate Limiting**: Bounded by existing workflow execution concurrency limit (100/tenant). No per-function-node rate limiting.
- **Caching**: No caching. Each execution creates a fresh isolate with fresh context. Phase 2 isolate pooling is an optimization, not a cache.
- **Encryption**: Function node code is stored in the workflow definition, which follows existing encryption-at-rest policies. Script execution results in `NodeExecution` follow existing retention and encryption policies. No new encryption requirements.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                | Type                    | Risk                                                                                                                                                                                                                                    |
| ------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isolated-vm` (npm)       | New native dependency   | **HIGH**: Native module requires `node-gyp` compilation. Docker builder stage must match production stage base (both Debian or both Alpine). Current Alpine builder + Debian production = runtime crash. Must switch builder to Debian. |
| `expression-resolver.ts`  | Existing internal       | LOW: Stable, used by all executors. Used for `inputVariables` resolution.                                                                                                                                                               |
| `step-errors.ts`          | Existing internal       | LOW: `SCRIPT_ERROR` already defined at L16.                                                                                                                                                                                             |
| `step-dispatcher.ts`      | Existing internal       | LOW: Requires adding `function` case to switch. Exhaustive `never` check guarantees compile-time safety.                                                                                                                                |
| `canvas-to-steps.ts`      | Existing internal       | LOW: One-line mapping change.                                                                                                                                                                                                           |
| Restate durable execution | Existing infrastructure | LOW: Function execution wrapped in `ctx.run()` like all other executors.                                                                                                                                                                |

### Downstream (depends on this feature)

| Consumer                               | Impact                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Debug panel (`StepLogItem.tsx`)        | Must display function output, console logs, and error details. Existing UI handles arbitrary step output -- no changes needed for Phase 1.      |
| Expression resolver (downstream steps) | Function output accessible via `{{steps.FN.output}}`. Works automatically -- expression resolver traverses `ctx.steps`.                         |
| Loop executor                          | Function nodes inside loop bodies work automatically -- the loop sets `ctx.vars[itemVariable]`, which is in the `WorkflowContextData` snapshot. |

---

## 9. Open Questions & Decisions Needed

1. **Docker builder base image**: The Alpine builder (L1) compiles native modules with musl libc, but the production image (L18) is Debian (glibc). `isolated-vm` binaries compiled on Alpine WILL crash on Debian. Decision needed: switch builder to `node:22-slim` (Debian) or use multi-stage with matching bases. This is the **blocking prerequisite** before implementation.

2. **Async/await in scripts**: Should `isolated-vm` be configured with async execution support? This affects timeout enforcement (async timeouts are more complex) and the executor's return type. Feature spec Open Question #1.

3. **`function` vs `transform` coexistence**: After implementation, the `transform` canvas node type doesn't exist in `NODE_TYPE_TO_STEP_TYPE` (no canvas node maps to it). The `transform` step type remains in the `WorkflowStep` union but is only reachable if workflows are created via API (not canvas). Should the `transform` type be deprecated?

4. **Backward compatibility guard**: Should the function executor check for empty `config.code` and fall back to transform behavior? This handles legacy function nodes that may have transform-style config (`inputExpression`/`outputVariable`). Oracle Decision D-3 recommends yes.

---

## 10. References

- Feature spec: `docs/features/sub-features/workflow-function-node.md`
- Test spec: `docs/testing/sub-features/workflow-function-node.md`
- Parent feature: `docs/features/workflows.md`
- Transform executor (current stub): `apps/workflow-engine/src/executors/transform-executor.ts`
- Step dispatcher: `apps/workflow-engine/src/handlers/step-dispatcher.ts`
- Canvas-to-steps: `apps/workflow-engine/src/handlers/canvas-to-steps.ts`
- Workflow handler: `apps/workflow-engine/src/handlers/workflow-handler.ts`
- Expression resolver: `apps/workflow-engine/src/context/expression-resolver.ts`
- Step errors: `apps/workflow-engine/src/errors/step-errors.ts`
- FunctionNodeConfigSchema: `packages/shared/src/types/workflow-schemas.ts:L122-L138`
- isolated-vm: https://www.npmjs.com/package/isolated-vm
