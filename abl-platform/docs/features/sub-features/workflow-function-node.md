# Feature: Workflow Function Node with Context Injection

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Workflows & Human Tasks](../workflows.md)
**Status**: ALPHA
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`
**Package(s)**: `apps/workflow-engine`, `apps/studio`, `packages/shared`
**Owner(s)**: Runtime Team
**Testing Guide**: `../../testing/sub-features/workflow-function-node.md`
**Last Updated**: 2026-04-07

---

## 1. Introduction / Overview

### Problem Statement

The workflow engine's `function` canvas node currently maps to the `transform` executor (`canvas-to-steps.ts:L49`), which can only evaluate a single `{{path}}` expression and assign the result to a context variable. Workflow authors who need to filter arrays, combine data from multiple steps, perform arithmetic, parse strings, or conditionally construct output must chain multiple transform nodes and condition nodes -- or accept that the workflow engine cannot express their logic.

Concrete scenarios where expression-only resolution fails:

- Filtering an API response array to items matching a criterion before passing to the next step.
- Restructuring a deeply nested API response into a flat object for a human task form.
- Computing a hash, checksum, or formatted string for an outbound webhook payload.
- Combining values from multiple upstream steps into a single output structure.
- Formatting dates, currency, or locale-specific strings for notification messages.
- Implementing custom validation logic on step outputs before branching.

### Goal Statement

Deliver a fully functional `function` workflow node that executes user-written JavaScript code in an `isolated-vm` sandbox with read access to the full workflow execution context. The script reads context data directly (no mandatory `inputVariables` mapping), produces an output value accessible by downstream nodes, and enforces resource limits (timeout, memory) for safe multi-tenant execution.

### Summary

The function node lets workflow authors write inline JavaScript that runs inside a V8 isolate (`isolated-vm`) during workflow execution. The script receives a frozen snapshot of the `WorkflowContextData` -- trigger payload, step outputs, mutable vars, workflow metadata, and tenant info -- as a `workflow` global object. It returns a value via `workflow.setOutput(value)` that becomes the step's output, accessible downstream as `{{steps.FunctionNodeName.output}}`. Optional `inputVariables` provide shorthand aliases with type coercion. Console output is captured for the debug panel. Resource limits (timeout 5-60s, memory 128MB, output 1MB) prevent runaway scripts. Python support and reusable custom scripts (server-stored) are deferred to Phase 2.

---

## 2. Scope

### Goals

- Execute user-written JavaScript code inside an `isolated-vm` V8 sandbox during workflow execution.
- Inject the full `WorkflowContextData` as a read-only `workflow` global object inside the sandbox.
- Provide `workflow.setOutput(value)` and `workflow.setVar(name, value)` write APIs inside the sandbox.
- Capture `console.log` / `console.warn` / `console.error` output for the debug panel.
- Enforce per-execution resource limits: timeout (5-60s, configurable), memory (128MB), output size (1MB).
- Support optional `inputVariables` with expression resolution and type coercion as convenience aliases.
- Surface script errors with `SCRIPT_ERROR` code, V8 line/column info, and stack trace in the debug panel.
- Replace the `function` -> `transform` mapping with a dedicated `function` step type and executor.

### Non-Goals (Out of Scope)

- **Python support**: Deferred to Phase 2. Schema already supports `language` field.
- **Custom script mode** (`custom_script`): Reusable scripts stored server-side with `scriptId`/`functionName`. Deferred to Phase 2 -- requires new MongoDB collection and CRUD API.
- **Network access**: No `fetch`, `http`, `XMLHttpRequest`, or socket APIs. The workflow engine has dedicated `http` and `connector_action` step types for I/O.
- **Filesystem access**: No `fs`, `path`, or file I/O. The sandbox is computation-only.
- **Module imports**: No `require()` or `import`. Scripts are self-contained.
- **Per-tenant concurrency quotas**: Workflow execution concurrency (100/tenant) already bounds script execution.
- **Monaco editor upgrade**: UI improvements to the code editor (syntax highlighting, autocomplete) are a separate enhancement. The existing `<Textarea>` is functional for Phase 1.
- **npm/pip package installation**: Users cannot install third-party packages.

---

## 3. User Stories

1. As a **workflow author**, I want to write inline JavaScript in a function node that filters, maps, and reshapes data from upstream step outputs, so that I can prepare data for downstream steps without chaining multiple transform/condition nodes.

2. As a **workflow author**, I want a mutable `context` object available in the script that I can read and write naturally (`context.x = "ABC"`, `const val = context.trigger.payload.orderId`), so that the scripting API feels like normal JavaScript -- no special methods like `setOutput`/`setVar`.

3. As a **workflow author**, I want values I set on `context` (e.g., `context.x = "ABC"`) to be readable in downstream node expressions as `{{context.x}}`, so that passing data between function nodes and other nodes is seamless.

4. As an **execution monitor**, I want to see function node `console.log` output, execution time, input context, and output value in the debug panel, so that I can diagnose script logic errors.

5. As a **workflow author**, I want clear error messages with line numbers when my script fails, so that I can quickly find and fix bugs in my code.

6. As a **platform operator**, I want function node execution to be sandboxed with timeout and memory limits, so that a poorly written script cannot degrade the workflow engine for other tenants.

7. As a **workflow author**, I want a full-scale JavaScript editor (not a tiny textarea) for writing function node code, so that I can comfortably write and review multi-line scripts.

---

## 4. Functional Requirements

1. **FR-1**: The system must execute user-written JavaScript code inside an `isolated-vm` V8 isolate when a `function` step is dispatched by the workflow engine.

2. **FR-2**: The system must inject a mutable `context` object into the isolate as a global, populated from `WorkflowContextData`:

   ```javascript
   context.trigger; // { type, payload, metadata }
   context.steps; // Record<string, { output, status, input, durationMs, error }>
   context.vars; // Record<string, unknown>
   context.workflow; // { id, name, executionId }
   context.tenant; // { tenantId, projectId }
   ```

   The `trigger`, `steps`, `workflow`, and `tenant` sub-trees are read-only (frozen). The user can set arbitrary top-level properties on `context` (e.g., `context.x = "ABC"`) which write to `ctx.vars` after successful execution.

3. **FR-3**: Any property set directly on `context` (e.g., `context.x = "ABC"`, `context.result = { filtered: [...] }`) must be captured and written to `ctx.vars` after successful script execution. These values are then readable in downstream node expressions as `{{context.x}}`. This replaces the previous `workflow.setOutput()`/`workflow.setVar()` API.

4. **FR-4**: The step output is derived from all user-set properties on `context`. Any key the user writes to `context` that is not a built-in key (`trigger`, `steps`, `vars`, `workflow`, `tenant`) becomes both the step's output AND a `ctx.vars` entry. This enables `{{context.x}}` in downstream expressions.

5. **FR-5**: The system must capture `console.log`, `console.warn`, and `console.error` calls inside the isolate and include them in the step execution result for display in the debug panel.

6. **FR-6**: The system must enforce the configured timeout (5-60 seconds, default 10s) by terminating the isolate if execution exceeds the limit, returning a `SCRIPT_ERROR` with message `"Script execution timed out after Ns"`.

7. **FR-7**: The system must enforce a memory limit of 128MB per isolate. If the script exceeds this limit, the isolate is terminated with a `SCRIPT_ERROR`.

8. **FR-8**: The system must enforce an output size limit of 1MB (JSON-serialized) on the collected context writes. If exceeded, a `SCRIPT_ERROR` is returned.

9. **FR-9**: _(Removed -- inputVariables are no longer needed. Users read values directly from `context.trigger.payload.x`, `context.steps.NodeName.output.y`, etc.)_

10. **FR-10**: Script errors (syntax errors, runtime exceptions, timeouts, memory violations) must surface as `StepError` with `code: 'SCRIPT_ERROR'`, `message` containing the error description and, when available, V8 line and column information embedded in the message string.

11. **FR-11**: The `canvas-to-steps.ts` converter must map the `function` canvas node type to a new `function` engine step type (not `transform`).

12. **FR-12**: The `step-dispatcher.ts` must handle the `function` step type by routing to the new `FunctionExecutor`, with the step included in the `WorkflowStep` discriminated union.

13. **FR-13**: The `resolveStepInput` function in `step-dispatcher.ts` must return meaningful pre-resolved input for `function` steps (code snippet) for the debug panel's "running" state display.

14. **FR-14**: _(Removed -- return value semantics replaced by direct `context` property writes.)_

15. **FR-15**: The function node config panel must NOT show the mode toggle (inline/custom_script). It must show only: a full-scale JavaScript code editor, a timeout setting, and a section header describing the `context` object API.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                              |
| -------------------------- | ------------ | ------------------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | Function nodes are part of workflow definitions scoped to projects |
| Agent lifecycle            | NONE         | Does not affect agent configuration or deployment                  |
| Customer experience        | PRIMARY      | Directly extends workflow authoring capability                     |
| Integrations / channels    | NONE         | No channel integration; I/O is via dedicated step types            |
| Observability / tracing    | SECONDARY    | Script execution emits step events; console.log captured           |
| Governance / controls      | SECONDARY    | Sandbox enforces resource limits; no new permissions needed        |
| Enterprise / compliance    | SECONDARY    | Isolated execution prevents cross-tenant impact; no PII handling   |
| Admin / operator workflows | NONE         | No admin-specific functionality                                    |

### Related Feature Integration Matrix

| Related Feature                                          | Relationship Type | Why It Matters                                                                                                                                                                                                                                   | Key Touchpoints                                                  | Current State                                                             |
| -------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [Workflows & Human Tasks](../workflows.md)               | extends           | Function node adds a 13th engine step type (`function`). The existing `transform` step type remains for expression-only use cases. The parent spec's FR-02 step type list (12 types) must be updated to include `function` after implementation. | `step-dispatcher.ts`, `canvas-to-steps.ts`, `WorkflowStep` union | ALPHA -- 12 step types; `function` canvas node maps to `transform` (stub) |
| [Workflow Canvas UX](workflow-canvas-ux-improvements.md) | shares data with  | Function node config panel is part of the canvas config system                                                                                                                                                                                   | `ConfigPanel.tsx`, `FunctionNodeConfig.tsx`                      | Existing UI stub                                                          |
| Expression Resolver                                      | depends on        | `inputVariables` use expression resolution; downstream nodes reference function output via `{{steps.X.output}}`                                                                                                                                  | `expression-resolver.ts`                                         | Stable -- used by all step types                                          |
| Debug Panel                                              | emits into        | Script output, console.log, and errors displayed in execution debug                                                                                                                                                                              | `StepLogItem.tsx`, `DebugFlowLog.tsx`                            | Stable -- supports all step types                                         |
| Loop Executor                                            | tested with       | Function nodes inside loop bodies execute per-iteration with iteration vars                                                                                                                                                                      | `loop-executor.ts`, `ctx.vars[itemVariable]`                     | Implemented                                                               |

---

## 6. Design Considerations

### Sandbox API Surface — `context` Object

The `context` object is the single API for reading and writing data in function scripts:

```javascript
// ── READ (frozen sub-trees, cannot be mutated) ──
context.trigger.payload.orderId         // Trigger data
context.steps.Function0001.output.x     // Step output by node name
context.steps.API0001.output.body       // Upstream API step output
context.vars.retryCount                 // Shared variables set by other nodes
context.workflow.executionId            // Execution metadata
context.tenant.tenantId                 // Tenant context

// ── WRITE (set properties directly on context) ──
context.x = "ABC";                      // Sets ctx.vars.x AND step output
context.result = { filtered: [...] };   // Sets ctx.vars.result AND step output
context.score = 85;                     // Any JSON-serializable value

// ── LOGGING (captured for debug panel) ──
console.log('Processing', items.length, 'items')
console.warn('Missing optional field')
console.error('Unexpected format:', data)
```

### How `context` Writes Flow Downstream

```
┌─────────────────────────────────────────────────┐
│ Function Node Script                            │
│   context.x = "ABC";                            │
│   context.total = items.length;                  │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│ After successful execution:                     │
│   ctx.vars.x = "ABC"                            │
│   ctx.vars.total = items.length                  │
│   step.output = { x: "ABC", total: <N> }        │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│ Downstream nodes can reference:                 │
│   {{context.x}}             → "ABC"             │
│   {{context.total}}         → <N>               │
│   {{steps.Function0001.output.x}} → "ABC"       │
└─────────────────────────────────────────────────┘
```

### No Special Methods

Unlike the previous design, there is **no** `setOutput()`, `setVar()`, or `inputVariables` mechanism. The `context` object is the entire API. This matches how workflow authors think about data flow and how the expression resolver already works (`{{context.x}}` → `ctx.vars.x`).

---

## 7. Technical Considerations

### isolated-vm Integration

The `isolated-vm` package creates V8 isolates -- separate V8 contexts with their own heaps and no access to the host Node.js environment. Key properties:

- **Isolate creation**: ~5ms cold start. Isolates can be pooled for reuse (Phase 2 optimization).
- **Data transfer**: Use `isolate.compileScriptSync()` and `context.evalSync()` for script execution. Pass `WorkflowContextData` via `Reference` or `ExternalCopy` (deep copy into the isolate's heap).
- **Memory**: Each isolate has a configurable heap limit (128MB). V8 throws `RangeError` on OOM, which isolated-vm catches.
- **Timeout**: `script.runSync({ timeout: timeoutMs })` terminates execution if exceeded.
- **No globals**: The isolate has no `setTimeout`, `setInterval`, `fetch`, `require`, `process`, `Buffer`, etc. Only standard ECMAScript built-ins (Math, JSON, Date, Array, Object, String, RegExp, Map, Set, Promise, etc.).

### Executor Pattern

The function executor follows the established pattern in `apps/workflow-engine/src/executors/`:

```typescript
// function-executor.ts
export interface FunctionStep {
  id: string;
  type: 'function';
  config: {
    code: string;
    timeout?: number; // seconds, default 10
  };
}

export interface FunctionResult {
  output: unknown;
  logs: Array<{ level: 'log' | 'warn' | 'error'; args: unknown[] }>;
  durationMs: number;
}
```

### Context Object Strategy

The `context` object is built from `WorkflowContextData`:

- **Read-only sub-trees**: `context.trigger`, `context.steps`, `context.workflow`, `context.tenant` are deep-frozen via `__deepFreeze` inside the isolate. Scripts cannot mutate upstream data.
- **Pre-populated vars**: `context.vars` is a shallow copy of `ctx.vars`, also frozen for consistency.
- **User writes via Proxy**: A `Proxy` on the `context` object intercepts `set` operations. Known keys (`trigger`, `steps`, `vars`, `workflow`, `tenant`) are rejected (read-only). All other keys (e.g., `context.x = "ABC"`) are captured in a host-side write buffer.
- **Atomic commit**: After successful execution, buffered writes are applied to `ctx.vars` and collected as the step output. If the script throws, no writes are applied.
- **No `setOutput`/`setVar`**: These methods are removed. The Proxy-based write capture replaces them entirely.

---

## 8. How to Consume

### Studio UI

- **Workflow canvas**: Drag a "Function" node from the Actions category in the assets sidebar.
- **Config panel** (right sidebar): Full-scale JavaScript editor, timeout setting. No mode toggle, no input variables section.
- **Execution debug**: After running, the debug panel shows:
  - Script output (JSON viewer) — all properties set on `context`.
  - Console.log output (collapsed log list).
  - Error with line/column (if failed).

### API (Runtime)

N/A -- Function nodes are internal workflow execution steps, not directly invocable via API.

### API (Studio)

No new endpoints for Phase 1. The existing workflow CRUD API stores function node configuration as part of the workflow definition's `nodes[].config`.

| Method | Path                                                     | Purpose                                               |
| ------ | -------------------------------------------------------- | ----------------------------------------------------- |
| `PUT`  | `/api/projects/:projectId/workflows/:workflowId`         | Save workflow with function node config (existing)    |
| `POST` | `/api/projects/:projectId/workflows/:workflowId/execute` | Execute workflow containing function nodes (existing) |

### Admin Portal

N/A -- No admin-specific functionality for function nodes.

### Channel / SDK / Voice / A2A / MCP Integration

N/A -- Function nodes are internal to workflow execution. Their outputs are consumed by downstream workflow steps, not directly by channels.

---

## 9. Data Model

### Collections / Tables

No new collections for Phase 1. Function node configuration is stored as part of the workflow definition's `nodes[].config` field, validated against `FunctionNodeConfigSchema`.

**Phase 2 addition** (custom_script mode):

```text
Collection: workflow_scripts
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - name: string (required, unique per project)
  - description: string (optional)
  - language: 'javascript' | 'python'
  - code: string (required)
  - exports: string[] (discovered function names)
  - version: number
  - createdBy: string (required)
  - updatedBy: string
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1 }
  - { tenantId: 1, projectId: 1, name: 1 } (unique)
```

### Key Relationships

- `WorkflowDefinition.nodes[].config` -- Contains function node code and settings.
- `NodeExecution.output` -- Stores the script's output after execution.
- `NodeExecution.error` -- Stores `SCRIPT_ERROR` details on failure.
- `WorkflowContextData.steps[nodeId]` -- Script output accessible by downstream nodes.
- `WorkflowContextData.vars` -- Modified by `workflow.setVar()` calls.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                      | Purpose                                                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/executors/function-executor.ts` | **NEW** -- isolated-vm sandbox execution, context injection, console capture                                               |
| `apps/workflow-engine/src/handlers/step-dispatcher.ts`    | **MODIFY** -- Add `FunctionStep` to `WorkflowStep` union, add `function` case to `dispatchStep()` and `resolveStepInput()` |
| `apps/workflow-engine/src/handlers/canvas-to-steps.ts`    | **MODIFY** -- Change `function` mapping from `transform` to `function`                                                     |
| `apps/workflow-engine/src/errors/step-errors.ts`          | No change -- `SCRIPT_ERROR` already defined at L16                                                                         |
| `apps/workflow-engine/src/context/expression-resolver.ts` | No change -- Used for `inputVariables` resolution                                                                          |

### Routes / Handlers

| File                                                    | Purpose                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `apps/workflow-engine/src/handlers/workflow-handler.ts` | **MODIFY** -- Pass `consoleLogs` from `StepDispatchResult` through to `updateStepStatus` persistence extras (FR-5) |

### UI Components

| File                                                                        | Purpose                                                                                 |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/studio/src/components/workflows/canvas/config/FunctionNodeConfig.tsx` | **MODIFY** -- Disable custom_script toggle with "Coming soon", no other Phase 1 changes |

### Jobs / Workers / Background Processes

N/A -- Function execution is synchronous within the Restate workflow handler.

### Persistence

| File                                                      | Purpose                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/workflow-engine/src/persistence/execution-store.ts` | **MODIFY** -- Persist `consoleLogs` field in `updateStepStatus` MongoDB update |

### Constants

| File                                    | Purpose                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/constants.ts` | **MODIFY** -- Added `FUNCTION_NODE_MEMORY_MB`, `FUNCTION_NODE_MAX_OUTPUT_BYTES`, `FUNCTION_NODE_MAX_LOGS` |

### Infrastructure

| File                                | Purpose                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/workflow-engine/Dockerfile`   | **MODIFY** -- Switched builder from Alpine to `node:22-slim` for native module compat |
| `apps/workflow-engine/package.json` | **MODIFY** -- Added `isolated-vm@6.1.2` dependency                                    |

### Tests

| File                                                           | Type               | Coverage Focus                                                                                           |
| -------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/__tests__/function-executor.test.ts` | unit + integration | Sandbox execution, context injection, timeout, memory limits, console capture, error handling, isolation |
| `apps/workflow-engine/src/__tests__/canvas-to-steps.test.ts`   | unit               | Function node mapping to `function` step type                                                            |
| `apps/workflow-engine/src/__tests__/step-dispatcher.test.ts`   | unit               | Function step dispatch routing, resolveStepInput                                                         |
| `apps/workflow-engine/src/__tests__/e2e-basic.test.ts`         | integration        | Full dispatch cycle, timeout propagation, return value flow                                              |
| `apps/studio/e2e/workflows/workflow-function-node.spec.ts`     | e2e (Playwright)   | Full workflow execution with function node via Studio UI (7 scenarios)                                   |

---

## 11. Configuration

### Constants (not environment variables)

Per design decision D-6, these are compile-time constants in `apps/workflow-engine/src/constants.ts`, not environment variables. This avoids runtime config complexity for values that rarely change.

| Constant                         | Value     | Description                                        |
| -------------------------------- | --------- | -------------------------------------------------- |
| `FUNCTION_NODE_MEMORY_MB`        | `128`     | Maximum memory (MB) per isolated-vm isolate        |
| `FUNCTION_NODE_MAX_OUTPUT_BYTES` | `1048576` | Maximum JSON-serialized output size (1MB)          |
| `FUNCTION_NODE_MAX_LOGS`         | `100`     | Maximum console.log entries captured per execution |

### Runtime Configuration

- **Per-node timeout**: Configured in the node's config panel (5-60 seconds, default 10s). Stored in `FunctionNodeConfigSchema.timeout`.
- **No feature flag**: The function node type already exists in the UI and schema. The executor change is a bug fix (completing the stub), not a new feature toggle.

### DSL / Agent IR / Schema

The existing `FunctionNodeConfigSchema` in `packages/shared/src/types/workflow-schemas.ts:L122-L138` is sufficient for Phase 1:

```typescript
FunctionNodeConfigSchema = z.object({
  language: z.literal('javascript').default('javascript'),
  mode: z.enum(['inline', 'custom_script']).default('inline'),
  code: z.string().optional(),
  scriptId: z.string().min(1).optional(),
  functionName: z.string().min(1).optional(),
  inputVariables: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.enum(['string', 'number', 'json', 'boolean']),
        value: z.string(),
      }),
    )
    .default([]),
  timeout: z.number().int().min(5).max(60).default(10),
});
```

**Phase 2 schema change**: Add `'python'` to the `language` field: `z.enum(['javascript', 'python'])`.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Function nodes execute within a workflow scoped to a project. The injected `WorkflowContextData` only contains data from the same execution. No cross-project data access.                                        |
| Tenant isolation  | Each isolated-vm isolate has its own V8 heap. No shared memory between isolates. Tenant data cannot leak across concurrent executions. Workflow execution concurrency (100/tenant) bounds total isolate count.    |
| User isolation    | N/A for function nodes -- they execute as part of a workflow, not as a user-facing resource. The workflow author's code runs in the context of the workflow execution, not in the context of the triggering user. |

### Security & Compliance

- **Sandboxed execution**: `isolated-vm` creates a V8 isolate with no access to Node.js globals (`process`, `require`, `Buffer`, `fs`, `net`, `child_process`, `crypto`). Only ECMAScript built-ins are available.
- **No I/O**: No network, filesystem, or timer APIs. Scripts cannot exfiltrate data or perform SSRF.
- **Read-only context**: `WorkflowContextData` is deep-copied and frozen. Scripts cannot mutate upstream step results or shared state (except through the controlled `setVar`/`setOutput` callbacks).
- **Resource limits**: Memory (128MB), timeout (5-60s), output size (1MB), log count (100). Prevents resource exhaustion.
- **No `eval()`-in-eval**: The user's code runs inside the isolate. It can use `eval()` within the isolate (standard JS), but this is contained -- the isolate has no dangerous APIs to expose.
- **Audit logging**: Script execution events (start, complete, fail) are recorded in `NodeExecution` records, following the existing step event pattern.

### Performance & Scalability

- **Isolate creation latency**: ~5ms per isolate (V8 isolate overhead).
- **Typical script execution**: <100ms for data transformation scripts (array filtering, object reshaping).
- **Memory overhead**: ~5MB base per isolate + script heap usage. With 128MB limit and 100 concurrent executions, theoretical max is ~12.8GB. In practice, most scripts use <10MB.
- **No isolate pooling in Phase 1**: Create + destroy per execution. Phase 2 can add pooling if latency is a concern.
- **No warm-up**: Scripts are compiled and executed synchronously. No JIT compilation warm-up needed for short-lived scripts.

### Reliability & Failure Modes

| Failure Mode                            | Behavior                                                | Recovery                                         |
| --------------------------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| Script syntax error                     | `SCRIPT_ERROR` with V8 error message and line/column    | User fixes code                                  |
| Script runtime error                    | `SCRIPT_ERROR` with stack trace, line/column            | User fixes code                                  |
| Timeout exceeded                        | Isolate terminated, `SCRIPT_ERROR` with timeout message | User increases timeout or optimizes script       |
| Memory exceeded                         | Isolate terminated, `SCRIPT_ERROR` with OOM message     | User reduces data size or optimizes memory usage |
| Output too large                        | `SCRIPT_ERROR` before context write                     | User reduces output size                         |
| `setOutput` with non-serializable value | `SCRIPT_ERROR` with serialization error                 | User ensures JSON-serializable output            |
| isolated-vm crash                       | Caught by Restate durable execution, step marked failed | Restate retry policy applies                     |

### Observability

- **Step events**: `step.started`, `step.completed`, `step.failed` events via Redis Pub/Sub (existing workflow event system).
- **Execution record**: `NodeExecution` document with `input` (code snippet, resolved vars), `output` (script result), `error` (SCRIPT_ERROR details), `durationMs`.
- **Console capture**: `console.log/warn/error` output stored in step result, displayed in debug panel.
- **Metrics** (Phase 2): Execution duration histogram, error rate by error type, memory usage distribution.

### Data Lifecycle

- **No new persistent data**: Function node code is part of the workflow definition (existing lifecycle).
- **Execution records**: Follow existing NodeExecution TTL and retention policies.
- **Console logs**: Stored inline in the execution record output, subject to the same retention.
- **Isolate lifecycle**: Created per-execution, destroyed after script completes. No persistent state.

---

## 13. Delivery Plan / Work Breakdown

1. **Sandbox infrastructure**
   1.1 Add `isolated-vm` dependency to `apps/workflow-engine/package.json`
   1.2 Create `function-executor.ts` with isolate creation, context injection, console capture, and resource limit enforcement
   1.3 Implement `workflow` global object with `setOutput`, `setVar`, `console.log/warn/error`
   1.4 Implement input variable resolution with type coercion
   1.5 Implement error handling with V8 line/column extraction

2. **Engine integration**
   2.1 Add `FunctionStep` type to `WorkflowStep` union in `step-dispatcher.ts`
   2.2 Add `function` case to `dispatchStep()` in `step-dispatcher.ts`
   2.3 Add `function` case to `resolveStepInput()` in `step-dispatcher.ts`
   2.4 Update `canvas-to-steps.ts` to map `function` -> `function` (not `transform`)
   2.5 Update `convertNodeToStep` to build `FunctionStep` from canvas config
   2.6 Add function-specific constants to `constants.ts` (memory limit, max output, max logs)

3. **Studio UI updates**
   3.1 Disable `custom_script` mode toggle with "Coming soon" indicator in `FunctionNodeConfig.tsx`
   3.2 Add `FunctionStepDetail` component for debug panel (show code, console logs, resolved inputs) -- _Deferred to Phase 2_

4. **Unit tests**
   4.1 Unit tests for `function-executor.ts`: context injection, setOutput, setVar, console capture, timeout, memory limit, output size limit, syntax errors, runtime errors, input variable coercion
   4.2 Update `canvas-to-steps` tests for new `function` mapping
   4.3 Update `step-dispatcher` tests for `function` dispatch

5. **E2E & integration tests**
   5.1 E2E test: workflow with function node that reads upstream step output and produces downstream output (auth: tenant T1, project P1)
   5.2 E2E test: function node inside loop body with iteration variable access
   5.3 E2E test: function node timeout enforcement
   5.4 E2E test: function node error handling (syntax error, runtime error)
   5.5 Integration test: cross-tenant isolation — concurrent executions verify no context leakage

6. **Documentation & cleanup**
   6.1 Update `docs/features/workflows.md` step type table to include `function` as 13th step type
   6.2 Update `docs/features/sub-features/workflow-function-node.md` status to ALPHA after implementation

---

## 14. Success Metrics

| Metric                                  | Baseline              | Target                   | How Measured                                                                                |
| --------------------------------------- | --------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| Function node execution success rate    | N/A (not implemented) | >95%                     | `NodeExecution` records with `status: 'completed'` vs `status: 'failed'` for function steps |
| p99 execution latency (data transforms) | N/A                   | <500ms                   | `NodeExecution.durationMs` for function steps                                               |
| Timeout rate                            | N/A                   | <2%                      | `SCRIPT_ERROR` with timeout message / total function executions                             |
| Memory limit hit rate                   | N/A                   | <0.5%                    | `SCRIPT_ERROR` with OOM message / total function executions                                 |
| Workflows using function nodes          | 0                     | >20% of active workflows | Query workflow definitions for `nodeType: 'function'`                                       |

---

## 15. Open Questions

1. **Async/await support**: Should scripts support `async` functions and `await`? `isolated-vm` supports async execution but it adds complexity to timeout enforcement and error handling.

2. **Isolate pooling**: Should Phase 1 include isolate pooling (reuse isolates across executions) or is create-per-execution acceptable for initial launch?

3. **Console.log depth**: How deep should `console.log` arguments be serialized? Deep nested objects could produce large log entries.

4. **Dockerfile impact**: Does `isolated-vm` (which compiles V8 from source) require changes to the workflow-engine Dockerfile build step?

5. **`function` vs `transform` coexistence**: After implementation, does the `transform` step type remain for expression-only use cases, or is it fully superseded by `function`? The parent spec (workflows.md) lists 12 step types including `transform` but not `function`. See HIGH finding from audit.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                               | Severity | Status                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| GAP-001 | No Python support -- only JavaScript in Phase 1                                                           | Medium   | Open -- deferred to Phase 2                                                                                       |
| GAP-002 | No custom_script mode -- only inline code in Phase 1                                                      | Low      | Open -- deferred to Phase 2                                                                                       |
| GAP-003 | No Monaco editor -- plain textarea for code editing (no syntax highlighting, no autocomplete)             | Low      | Open -- separate UI enhancement                                                                                   |
| GAP-004 | No isolate pooling -- create/destroy per execution may add ~5ms overhead                                  | Low      | Open -- measure before optimizing                                                                                 |
| GAP-005 | No context-aware autocomplete in the code editor (e.g., suggesting `workflow.steps.API0001.output.field`) | Low      | Open -- requires Monaco + schema introspection                                                                    |
| GAP-006 | `isolated-vm` is a native module -- requires compilation during Docker build                              | Medium   | Mitigated -- Dockerfile switched to `node:22-slim` (Debian) for native module compat; v6.1.2 compiles on Node 22+ |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                 | Coverage Type | Status    | Test File / Note                       |
| --- | -------------------------------------------------------------------------------------------------------- | ------------- | --------- | -------------------------------------- |
| 1   | Execute inline JS that reads context and produces output                                                 | unit          | ✅ TESTED | `function-executor.test.ts` UT-1       |
| 2   | `workflow.setOutput()` stores value as step output                                                       | unit          | ✅ TESTED | `function-executor.test.ts` UT-4       |
| 3   | `workflow.setVar()` writes to ctx.vars atomically                                                        | unit          | ✅ TESTED | `function-executor.test.ts` UT-6       |
| 4   | Console.log/warn/error captured in result                                                                | unit          | ✅ TESTED | `function-executor.test.ts` UT-7       |
| 5   | Timeout enforcement terminates long-running script                                                       | unit          | ✅ TESTED | `function-executor.test.ts` UT-8       |
| 6   | Memory limit enforcement terminates memory-hungry script                                                 | unit          | ✅ TESTED | `function-executor.test.ts` UT-9       |
| 7   | Output size limit rejects oversized output                                                               | unit          | ✅ TESTED | `function-executor.test.ts` UT-10      |
| 8   | Syntax error returns SCRIPT_ERROR with line/column                                                       | unit          | ✅ TESTED | `function-executor.test.ts` UT-13      |
| 9   | Runtime error returns SCRIPT_ERROR with stack trace                                                      | unit          | ✅ TESTED | `function-executor.test.ts` UT-14      |
| 10  | Input variables resolved and coerced correctly                                                           | unit          | ✅ TESTED | `function-executor.test.ts` UT-11      |
| 11  | Canvas `function` node maps to `function` step type                                                      | unit          | ✅ TESTED | `canvas-to-steps.test.ts` UT-15        |
| 12  | Step dispatcher routes `function` to FunctionExecutor                                                    | unit          | ✅ TESTED | `step-dispatcher.test.ts` UT-16        |
| 13  | Full workflow: Start -> Function -> End with data transform via Studio UI                                | e2e           | ✅ TESTED | `workflow-function-node.spec.ts` E2E-1 |
| 14  | Function node inside loop body with iteration vars                                                       | e2e           | ✅ TESTED | `workflow-function-node.spec.ts` E2E-6 |
| 15  | Function node timeout produces step failure                                                              | e2e           | ✅ TESTED | `workflow-function-node.spec.ts` E2E-3 |
| 16  | Function node syntax error produces step failure                                                         | e2e           | ✅ TESTED | `workflow-function-node.spec.ts` E2E-4 |
| 17  | Function node output referenced by downstream condition                                                  | e2e           | ✅ TESTED | `workflow-function-node.spec.ts` E2E-5 |
| 18  | Script cannot access Node.js globals (require, process, fs)                                              | integration   | ✅ TESTED | `function-executor.test.ts` INT-2      |
| 19  | Script cannot mutate frozen workflow context                                                             | integration   | ✅ TESTED | `function-executor.test.ts` INT-4      |
| 20  | Failed script does not apply setVar writes (atomic rollback)                                             | integration   | ✅ TESTED | `function-executor.test.ts` INT-3      |
| 21  | Concurrent function executions across tenants T1 and T2 -- verify T1 context not visible in T2 execution | integration   | ✅ TESTED | `function-executor.test.ts` INT-7      |

### Testing Notes

All 28 tests implemented and passing (20 unit + 8 integration). 7 Playwright E2E test files created (require real services for execution). Tests use real `isolated-vm` -- no mocking of the sandbox.

> Full testing details: `../../testing/sub-features/workflow-function-node.md`

---

## 18. References

- Parent feature spec: [`docs/features/workflows.md`](../workflows.md)
- Existing schema: [`packages/shared/src/types/workflow-schemas.ts:L122-L138`](../../packages/shared/src/types/workflow-schemas.ts)
- Existing UI: [`apps/studio/src/components/workflows/canvas/config/FunctionNodeConfig.tsx`](../../apps/studio/src/components/workflows/canvas/config/FunctionNodeConfig.tsx)
- Transform executor (current stub): [`apps/workflow-engine/src/executors/transform-executor.ts`](../../apps/workflow-engine/src/executors/transform-executor.ts)
- Step dispatcher: [`apps/workflow-engine/src/handlers/step-dispatcher.ts`](../../apps/workflow-engine/src/handlers/step-dispatcher.ts)
- Canvas-to-steps mapping: [`apps/workflow-engine/src/handlers/canvas-to-steps.ts:L49`](../../apps/workflow-engine/src/handlers/canvas-to-steps.ts)
- Step error codes: [`apps/workflow-engine/src/errors/step-errors.ts:L16`](../../apps/workflow-engine/src/errors/step-errors.ts)
- Expression resolver: [`apps/workflow-engine/src/context/expression-resolver.ts`](../../apps/workflow-engine/src/context/expression-resolver.ts)
- isolated-vm: https://github.com/nicolo-ribaudo/isolated-vm
