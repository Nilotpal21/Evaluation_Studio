# Testing Guide: Workflow Parallel Graph Execution (Fan-Out / Fan-In)

**Feature**: [Workflow Parallel Graph Execution](../../features/sub-features/workflow-parallel-graph-execution.md)
**Parent Feature**: [Workflows & Human Tasks](../../features/workflows.md)
**Status**: ALPHA
**Last Updated**: 2026-05-06

---

## Current State

Core engine implemented. Unit and in-process integration tests written. HTTP-API E2E tests pending (GAP-06). See feature spec for gap details.

Test files committed:

- `apps/workflow-engine/src/__tests__/dag-executor.test.ts` — INT-3 through INT-8
- `apps/workflow-engine/src/__tests__/canvas-to-steps-dag.test.ts` — INT-1, INT-2
- `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts` — E2E-1 through E2E-11 (system-level, excluded from default vitest run; requires Restate test double)
- `apps/workflow-engine/src/__tests__/ws-bridge.test.ts` — WsBridge unit tests including project-access gate
- `apps/workflow-engine/src/__tests__/ws-handler.test.ts` — WsHandler message routing
- `apps/workflow-engine/src/__tests__/ws-subscription-registry.test.ts` — WsSubscriptionRegistry lifecycle

---

## Coverage Matrix

| FR    | Requirement Summary                                                                                                                                                                                        | Unit                                                                  | Integration                                                                        | E2E | Status                                                       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --- | ------------------------------------------------------------ |
| FR-1  | Parallel execution of nodes with `onSuccessSteps.length > 1`                                                                                                                                               | —                                                                     | ✅ system-parallel-graph.test.ts (E2E-1)                                           | ❌  | PARTIAL                                                      |
| FR-2  | Barrier/join: terminal-state wait (completed/skipped/fail-routed); skip propagation prevents deadlock                                                                                                      | ✅ dag-executor.test.ts (INT-3,INT-6)                                 | ✅ system-parallel-graph.test.ts (E2E-3,E2E-7)                                     | ❌  | PARTIAL                                                      |
| FR-3  | `inDegreeMap` computed in `canvas-to-steps.ts`                                                                                                                                                             | ✅ canvas-to-steps-dag.test.ts (INT-1)                                | —                                                                                  | —   | TESTED                                                       |
| FR-4  | `dag-executor.ts` module extracted                                                                                                                                                                         | ✅ dag-executor.test.ts                                               | —                                                                                  | —   | TESTED                                                       |
| FR-5  | 1-to-1 workflows unchanged (backward compat)                                                                                                                                                               | ✅ dag-executor.test.ts (sequential fallback)                         | ❌ no explicit backward-compat integration                                         | —   | PARTIAL                                                      |
| FR-6  | Studio `onConnect` guard relaxed for fan-out                                                                                                                                                               | ✅ canvas-fanout.test.tsx                                             | —                                                                                  | —   | TESTED                                                       |
| FR-7  | Fan-out cap `MAX_PARALLEL_BRANCHES = 10` enforced                                                                                                                                                          | ✅ canvas-fanout.test.tsx; dag-executor.test.ts (INT-5)               | —                                                                                  | —   | TESTED                                                       |
| FR-8  | All predecessor outputs in context at join start                                                                                                                                                           | ✅ dag-executor.test.ts                                               | ✅ system-parallel-graph.test.ts (E2E-8)                                           | ❌  | PARTIAL                                                      |
| FR-9  | Cycle detection (all three layers: design-time DFS, save-time Kahn's, execution-time Kahn's); loop container nodes not exempt                                                                              | ✅ canvas-to-steps-dag.test.ts (INT-2); canvas-fanout.test.tsx (UT-4) | —                                                                                  | —   | PARTIAL (save-time loop-exemption fix needs regression test) |
| FR-10 | Suspension nodes on parallel branches work correctly                                                                                                                                                       | —                                                                     | ❌ not yet covered                                                                 | —   | NOT TESTED                                                   |
| FR-11 | Execution record shows overlapping timestamps                                                                                                                                                              | —                                                                     | ❌ not yet covered                                                                 | —   | NOT TESTED                                                   |
| FR-12 | Pub/Sub emits concurrent `step.started` events                                                                                                                                                             | —                                                                     | ❌ not yet covered                                                                 | —   | NOT TESTED                                                   |
| FR-13 | SimpleMerge: nonfatal branch failure; join fires if another branch arrived (in-degree ≥ 2); workflow completes if join succeeds                                                                            | ✅ dag-executor.test.ts (INT-4, INT-9)                                | ✅ system-parallel-graph.test.ts (E2E-2)                                           | ❌  | PARTIAL                                                      |
| FR-14 | `inDegreeMap` and `edgeMap` threaded through all fire paths                                                                                                                                                | —                                                                     | ✅ system-parallel-graph.test.ts (wires inDegreeMap through full handler)          | —   | TESTED                                                       |
| FR-15 | Studio blocks cyclic edges with toast                                                                                                                                                                      | ✅ canvas-fanout.test.tsx                                             | —                                                                                  | —   | TESTED                                                       |
| FR-16 | Merger config panel shows "Required predecessors" checklist                                                                                                                                                | ✅ canvas-fanout.test.tsx (MergerNodeConfig)                          | —                                                                                  | —   | TESTED                                                       |
| FR-17 | Wait-all-settled in dag-executor; `REQUIRED_PREDECESSOR_SKIPPED` / `REQUIRED_PREDECESSOR_FAILED` enforcement in `executeStepWithSuspension` (workflow-handler)                                             | ✅ dag-executor.test.ts (INT-7,INT-8)                                 | ✅ system-parallel-graph.test.ts (E2E-4,E2E-9)                                     | ❌  | PARTIAL                                                      |
| FR-18 | Loop parallel mode: `mode: 'parallel'`, `concurrencyLimit`, `bodyInDegreeMap` → nested `executeDag`; `persistLoopProgress`; `computeIterationPathState`; Studio `LoopNodeComponent` with iteration overlay | ✅ canvas-fanout.test.tsx (loop iteration overlay describe block)     | ✅ system-parallel-graph.test.ts (E2E-10, E2E-11 — loop on branch, loop as fan-in) | ❌  | PARTIAL                                                      |

---

## E2E Test Scenarios

All E2E tests must:

- Start a real workflow-engine server on a random port (`{ port: 0 }`)
- Use a real MongoDB instance (not mocks)
- Interact exclusively via HTTP API (no direct Mongoose imports)
- Use a real Restate instance or a Restate test double that honors `ctx.run` semantics
- No `vi.mock` of internal packages

### E2E-1: Diamond Pattern — Full Parallel Execution

**Topology**: `Start → A, B; A → Join; B → Join; Join → End`

**Setup**:

1. Create workflow with nodes: Start, NodeA (HTTP), NodeB (HTTP), Join (HTTP), End
2. Draw edges: `Start on_success → NodeA`, `Start on_success → NodeB`, `NodeA on_success → Join`, `NodeB on_success → Join`
3. Mock HTTP target server at a random port to return `{ result: 'ok' }`

**Steps**:

```
POST /api/v1/projects/:projectId/workflows/:wfId/executions/execute
  body: { triggerPayload: {} }
```

**Expected**:

- Execution status eventually `completed`
- `nodeExecutions` contains entries for NodeA, NodeB, Join — all `completed`
- NodeA and NodeB `startedAt` timestamps are within the same 500ms window (concurrent)
- Join `startedAt` is after both NodeA and NodeB `completedAt`
- `{{steps.NodeA.output.*}}` and `{{steps.NodeB.output.*}}` both present in execution context

---

### E2E-2: Branch Failure — Sibling Path Continues to Merge

**File**: `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts`

**Topology**: `Start → A, B; A → Join; B → Join; Join → End`

**Setup**: Branch A (no failure routing) returns `{ status: 'failed' }`.

**Expected** (SimpleMerge — nonfatal):

- DAG treats failure as nonfatal; calls `notifyTerminal(A, [])` — A's path settles with no successors. No error recorded.
- Branch B completes normally → join's barrier reaches in-degree 2 → join is dispatched.
- Execution `completed` (branch failure is nonfatal; workflow outcome depends on join success).

---

### E2E-3: Skip Propagation — Conditional Skip Satisfies Join Barrier

**File**: `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts`

**Topology**: `Start → A; Start → Condition; Condition on_success → B; A → Join; B → Join; Join → End`

**Setup**: Condition takes the `else` path, so B is never dispatched and the DAG skip-cascades B.

**Expected**:

- B status `skipped`; A `completed`
- Join barrier reaches in-degree 2 (A arrived + B signalled-skip) → join dispatched
- Execution `completed`; no deadlock

---

### E2E-4: Selective Barrier — Required Predecessor Skipped Fails Join

**File**: `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts`

**Setup**: Same conditional-skip topology. Join `requiredPredecessors: [B.id]`. B is skipped.

**Expected**:

- Join is dispatched by dag-executor (barrier count reached)
- `executeStepWithSuspension` detects B is required but skipped → fails join with `REQUIRED_PREDECESSOR_SKIPPED`
- Execution `failed`

---

### E2E-5: Fan-Out Cap — Too Many Successors Fails the Execution

**File**: `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts`

**Setup**: Root step has 11 successors (`onSuccessSteps.length > MAX_PARALLEL_BRANCHES = 10`).

**Expected**:

- `evaluateAndDispatch` records `MAX_FAN_OUT_EXCEEDED` in `firstError`; step is not dispatched
- DAG drains and throws; execution `failed`

---

### E2E-6: Cancellation Mid-Parallel — Execution Returns Cancelled

**File**: `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts`

**Topology**: `Start → A, B; A → Join; B → Join; Join → End`

**Steps**:

1. Start execution
2. After branch A completes, fire `sys:cancel` signal
3. Branch B is in-flight

**Expected**:

- Execution status `cancelled`
- Join never starts

---

### E2E-7: All-Optional Predecessors — Skipped Branch Still Satisfies Barrier

**File**: `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts`

**Setup**: Conditional-skip topology. Join `requiredPredecessors: []` (explicitly empty — all optional).

**Expected**:

- Join dispatched after A completes and B is skip-cascaded
- Execution `completed`

---

### E2E-8: Optional Predecessor Skipped — Required Predecessor Completes; Join Runs

**File**: `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts`

**Setup**: Conditional-skip topology. Join `requiredPredecessors: [A.id]` (A required, B optional). B is skipped.

**Expected**:

- Join dispatched; A is required and completed → `REQUIRED_PREDECESSOR_NOT_COMPLETED` is NOT triggered
- Execution `completed`

---

### E2E-9: Both Predecessors Required; One Skipped → Join Fails

**File**: `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts`

**Setup**: Conditional-skip topology. Join `requiredPredecessors: [A.id, B.id]`. B is skipped.

**Expected**:

- Join dispatched by dag-executor (barrier count reached)
- `executeStepWithSuspension` detects B is required but skipped → `REQUIRED_PREDECESSOR_NOT_COMPLETED`
- Execution `failed`

---

### E2E-10: Loop Node on Parallel Branch — Join Waits for Loop Completion

**File**: `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts`

**Topology**: `Start → Loop, Transform; Loop → Join; Transform → Join; Join → End`

**Expected**:

- Loop executes all iterations (body steps via `bodyInDegreeMap`-driven `executeDag`)
- Transform completes concurrently
- Join fires only after both Loop and Transform are terminal
- Execution `completed`

---

### E2E-11: Loop Node as Fan-In Target

**File**: `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts`

**Topology**: `Start → A, B; A → Loop; B → Loop; Loop → End` (Loop has in-degree 2)

**Expected**:

- Loop node's barrier waits for both A and B to complete before dispatching Loop
- Execution `completed`

---

## Integration Test Scenarios

### INT-1: `inDegreeMap` Computation — Diamond Topology

**File**: `apps/workflow-engine/src/__tests__/canvas-to-steps-dag.test.ts`

```typescript
const nodes = [start, nodeA, nodeB, join, end];
const edges = [
  { source: start.id, sourceHandle: 'on_success', target: nodeA.id },
  { source: start.id, sourceHandle: 'on_success', target: nodeB.id },
  { source: nodeA.id, sourceHandle: 'on_success', target: join.id },
  { source: nodeB.id, sourceHandle: 'on_success', target: join.id },
];
const result = convertCanvasToSteps(nodes, edges, { full: true });
// inDegreeMap[join.id] === 2
// inDegreeMap[nodeA.id] === 0 or 1 (from start)
```

---

### INT-2: Cycle Detection

**File**: `apps/workflow-engine/src/__tests__/canvas-to-steps-dag.test.ts`

Draw a back-edge from NodeB → Start. Assert `convertCanvasToStepsInternal` throws or returns an error result with a message containing "cycle".

---

### INT-3: DAG Executor — Barrier Semantics

**File**: `apps/workflow-engine/src/__tests__/dag-executor.test.ts`

Provide a mock `executeStep` that resolves after a configurable delay. Assert:

- Join node's `executeStep` is called only after both predecessors resolve
- Parallel branches call `executeStep` concurrently (execution order overlap)

---

### INT-4: DAG Executor — Failed Branch Skip-Cascades to Sole Successor

When A fails (in-degree 1 join — A is the only predecessor), DAG calls `notifyTerminal(A, [])` → `signalSkipped(join)` → all-skip cascade → join NOT dispatched. `executeDag` resolves without throwing (nonfatal). Join has in-degree 1, so skip-cascade fires immediately and no branch arrives to unblock it.

---

### INT-5: Fan-Out Cap Enforcement

Assert that when `onSuccessSteps.length > MAX_PARALLEL_BRANCHES`, the DAG executor throws `MAX_FAN_OUT_EXCEEDED` before dispatching any branch.

---

### INT-6: DAG Executor — Skip Propagation at Barrier

**File**: `apps/workflow-engine/src/__tests__/dag-executor.test.ts`

Topology: `Start → A, B; A → Join; B → Join; Join → End`.
Inject NodeB as `skipped` (never dispatched, `terminalCount` incremented by skip propagation).

Assert:

- Join node's `executeStep` is called after NodeA completes and NodeB is propagated as skipped
- Join does not deadlock waiting for a NodeB completion that will never arrive
- DAG resolves successfully with Join and End executing

---

### INT-7: DAG Executor — Selective Barrier, Optional Predecessor Skipped

**File**: `apps/workflow-engine/src/__tests__/dag-executor.test.ts`

Join node config: `requiredPredecessors: [NodeA.id]` (NodeB optional). NodeB injected as skipped.

Assert:

- DAG executor waits for **both** NodeA (completed) and NodeB (skipped) to settle — no early release
- `terminalCount` for Join reaches `inDegreeMap[Join]` only after both predecessors are terminal
- `executeStep` IS called for Join (DAG executor does not enforce `requiredPredecessors`)
- `requiredPredecessors` enforcement happens inside the `executeStep` callback, not here

---

### INT-8: DAG Executor — Dispatches Join Regardless of `requiredPredecessors`

**File**: `apps/workflow-engine/src/__tests__/dag-executor.test.ts`

Join node config: `requiredPredecessors: [NodeA.id, NodeB.id]`. NodeB injected as skipped.

Assert:

- DAG executor DOES call `executeStep` for Join (barrier count reached; DAG does not enforce requiredPredecessors)
- The `executeStep` callback (`executeStepWithSuspension` in production) is responsible for enforcing `requiredPredecessors` and failing the step if needed

---

### INT-9: Failed Branch — Join Dispatched When Sibling Arrives (SimpleMerge)

**File**: `apps/workflow-engine/src/__tests__/dag-executor.test.ts`

Topology: `A → Join ← B` (join in-degree 2). A returns `{ status: 'failed' }`, B completes.

Assert:

- `executeDag` calls `notifyTerminal(A, [])` → `signalSkipped(join)` (skippedCount=1)
- B completes → `incrementBarrier(join)` → terminalCount=2=inDeg → join dispatched
- `dispatched` list contains `'join'`
- `executeDag` resolves without throwing (nonfatal branch failure)

---

## Unit Test Scenarios

### UT-1: `onConnect` — Fan-Out Allowed

`workflow-canvas-store.ts` `onConnect` handler adds a second edge from the same `source + sourceHandle` to a different target. Edge is added to state.

### UT-2: `onConnect` — Duplicate Rejected

Same `source + sourceHandle + target` combination. Second `onConnect` call does not add a duplicate edge.

### UT-3: `onConnect` — Cap Enforced

Already 10 edges from same `source + sourceHandle`. 11th call returns state unchanged silently (no toast — cap exceeded is a silent drop in `onConnect`; runtime enforces `MAX_FAN_OUT_EXCEEDED`).

### UT-4: `onConnect` — Cycle Blocked

Drawing an edge that creates `A → B → A` cycle returns state unchanged and triggers user notification.

### UT-5: `computeExecutionEdges` — All Fan-Out Edges Marked Taken

When node status is `completed` and it has 3 outgoing `on_success` edges, all 3 edges are classified as "taken".

### UT-6: `MergerNodeConfig` — Checklist Renders All Incoming Predecessors

When a node has 2 incoming `on_success` edges (NodeA and NodeB), `MergerNodeConfig` renders exactly 2 checkboxes labelled with the predecessor display names. Both are **unchecked by default** (all optional).

### UT-7: `MergerNodeConfig` — Toggle Updates `requiredPredecessors`

Unchecking NodeB's checkbox updates `node.config.requiredPredecessors` to `[NodeA.id]`. Re-checking NodeB adds it back. Removing NodeB's edge from the canvas removes its checkbox and drops NodeB from `requiredPredecessors` if present.

---

## Manual Validation Checklist

- [ ] Draw 2 outgoing edges from Start → NodeA and Start → NodeB in Studio
- [ ] Verify execution runs NodeA and NodeB concurrently (both show "running" in monitor)
- [ ] Verify Join node starts only after both predecessors complete
- [ ] Open Join node config panel — verify "Required predecessors" checklist appears with NodeA and NodeB both **unchecked** (default all optional)
- [ ] Uncheck NodeB in the checklist — re-run with NodeB path skipped — verify Join starts after only NodeA and execution completes
- [ ] Check both NodeA and NodeB as required — run with NodeB path skipped — verify Join fails with `REQUIRED_PREDECESSOR_NOT_COMPLETED`
- [ ] Draw 11 outgoing edges from a single node — verify edge is silently dropped (no toast for cap; canvas `isValidConnection` blocks the drag visually)
- [ ] Draw a cycle — verify Studio blocks the edge with error message
- [ ] Run an existing linear workflow — verify no behavior change
