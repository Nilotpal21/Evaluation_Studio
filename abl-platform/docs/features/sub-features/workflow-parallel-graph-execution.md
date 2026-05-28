# Feature: Workflow Parallel Graph Execution (Fan-Out / Fan-In)

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Workflows & Human Tasks](../workflows.md)
**Status**: ALPHA
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `customer experience`, `observability`
**Package(s)**: `apps/workflow-engine`, `apps/studio`, `packages/shared-kernel`, `packages/database`
**Owner(s)**: Runtime Team
**Testing Guide**: `../../testing/sub-features/workflow-parallel-graph-execution.md`
**Last Updated**: 2026-05-06

---

## 1. Introduction / Overview

### Problem Statement

The workflow execution engine processes nodes **sequentially** via a linear queue. When a node has multiple outgoing edges, its successors are queued one after another and executed in series — not in parallel. This means a workflow like the one shown below:

```
Start → Doc0001
Start → GenAI0001
Doc0001 → GithubIntegration0001
GenAI0001 → Delay0001
GithubIntegration0001 + Delay0001 → (join) → End0001
```

…would execute `Doc0001 → GithubIntegration0001 → GenAI0001 → Delay0001` in sequence even though the two branches are independent. This prevents workflow authors from exploiting natural parallelism in their business processes, adding unnecessary latency when branches have no data dependencies on each other.

Additionally, the Studio canvas currently **prevents** an author from drawing more than one outgoing edge from a single source handle (`onConnect` guard in `workflow-canvas-store.ts:312–318`), making it impossible to express fan-out topology at all.

### Goal Statement

Enable workflow authors to draw a canvas graph that fans out from any node to multiple independent downstream nodes, which the engine will execute in parallel. Downstream nodes that depend on multiple predecessors (fan-in / join / barrier) will automatically wait until all predecessors complete before executing. Existing 1-to-1 workflows are unchanged.

### Summary

This feature upgrades the workflow execution engine from a **linear queue** to a **DAG (Directed Acyclic Graph) executor**. Fan-out is implicit: any node with multiple outgoing `on_success` edges fires all successors in parallel. Fan-in is automatic: a node with multiple incoming edges waits for all predecessors before starting — no author configuration needed. The Studio canvas is updated to allow multiple outgoing edges from the same source handle (up to the existing `MAX_PARALLEL_BRANCHES = 10` limit). All 15 clarifying questions were answered autonomously from codebase context; no ambiguities were escalated to the user.

---

## 2. Scope

### Goals

- Allow any canvas node to have multiple outgoing `on_success` edges (fan-out), firing all successors in parallel.
- Implement a barrier/join semantic: a node with N incoming edges from parallel branches waits for all N predecessors to complete before it starts.
- Deliver all predecessor branch outputs into the context of the join node, accessible via existing `{{steps.<name>.output.*}}` expressions.
- Preserve exact backward compatibility: workflows with single `on_success` edges behave identically to today.
- Relax the Studio `onConnect` guard to permit fan-out while preventing duplicate edges to the same target.
- Add DAG cycle detection at conversion time (design-time validation) in addition to the existing runtime iteration cap.
- Reuse the existing `MAX_PARALLEL_BRANCHES = 10` constant as the per-node fan-out limit.

### Non-Goals (Out of Scope)

- Replacing or deprecating the existing explicit `parallel` step type (used by the step-editor authoring mode).
- Dynamic branching based on runtime data (e.g., fan-out to N nodes where N is computed at runtime) — fan-out targets are always statically defined in the canvas.
- Visual parallel-lane rendering in the Studio execution monitor (data is correct from day one; visual grouping of concurrent lanes is a follow-up).
- A user-configurable `barrierStrategy` per join node (`wait_all`, `ignore_errors`) — the default is fail-fast; strategy knobs are deferred to Phase 2.
- Cross-execution join (merging outputs from two separate workflow executions).
- `parallelGroupId` schema field on `INodeExecution` — deferred to Phase 2.
- Sub-workflow spawning for Restate durability (single Restate workflow with `Promise.all` is sufficient).

---

## 3. User Stories

1. As a **workflow author**, I want to draw edges from a single node to multiple downstream nodes so that independent tasks (e.g., document processing and AI generation) run concurrently and reduce total execution time.

2. As a **workflow author**, I want a downstream node to automatically wait for all its incoming branches to complete (e.g., a GitHub integration step that depends on both a Doc step and a GenAI step) without having to configure any explicit join or synchronization step.

3. As a **workflow author**, I want all branch outputs (from parallel predecessors) to be accessible in the join node's context via `{{steps.Doc0001.output.*}}` and `{{steps.GenAI0001.output.*}}`, so I can compose results without custom aggregation logic.

4. As an **operations engineer**, I want the execution monitor to show concurrent nodes as running simultaneously (with overlapping `startedAt`/`completedAt` timestamps visible in the execution record) so I can diagnose timing issues in parallel workflows.

5. As a **workflow author**, I want the Studio canvas to warn me (and reject the edge) if I try to create a cycle in the workflow graph, so that invalid topologies are caught at design time rather than failing at runtime.

6. As a **platform operator**, I want fan-out to be capped at `MAX_PARALLEL_BRANCHES = 10` outgoing edges per source node so that runaway parallelism does not exhaust Restate or MongoDB connection pools.

---

## 4. Functional Requirements

| ID    | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Priority | Status      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| FR-1  | The engine must execute all successors of a node in parallel when `onSuccessSteps.length > 1`, using `Promise.all` within the Restate workflow context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | P0       | IMPLEMENTED |
| FR-2  | The engine must implement a barrier/join: a node with N incoming `on_success` edges must not start until all N predecessor nodes have reached a terminal state (completed, skipped, or fail-routed). Only nodes that completed successfully write their output to `ctx.steps`; skipped or fail-routed predecessors satisfy the barrier without writing output. This prevents deadlock when conditional branching leaves some predecessors unreachable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | P0       | IMPLEMENTED |
| FR-3  | The `canvas-to-steps.ts` converter must compute and include an `inDegreeMap: Record<string, number>` in `CanvasConversionResult`, counting only `on_success` incoming edges per node.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | P0       | IMPLEMENTED |
| FR-4  | The engine must support DAG traversal with barrier completion counting and parallel dispatch, implemented as logic that is cleanly separated from the existing sequential handler so it can be tested in isolation without mocking the full workflow lifecycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | P0       | IMPLEMENTED |
| FR-5  | Existing workflows with single `on_success` edges (in-degree ≤ 1, out-degree ≤ 1 per handle) must execute with identical behavior and no performance regression.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | P0       | IMPLEMENTED |
| FR-6  | The Studio canvas `onConnect` guard must be updated to allow multiple outgoing edges from the same `on_success` source handle, while still preventing duplicate edges to the same target and enforcing the fan-out cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | P0       | IMPLEMENTED |
| FR-7  | Fan-out must be capped at `MAX_PARALLEL_BRANCHES` (currently 10) per source handle. Attempting to draw an 11th outgoing edge from one handle must be rejected in Studio with a user-facing error message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | P0       | IMPLEMENTED |
| FR-8  | When a fan-in barrier node starts executing, all predecessor outputs must already be written to the shared `WorkflowContextData.steps` map, so they are resolvable via `resolveExpressionTyped` without any special logic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | P0       | IMPLEMENTED |
| FR-9  | Cycle detection must be enforced at three layers: (1) design-time in Studio via DFS in `workflow-canvas-helpers.ts` + ReactFlow `isValidConnection` visual feedback — **IMPLEMENTED**; (2) save-time in runtime via Kahn's algorithm in `workflow-helpers.ts` wired into CREATE/UPDATE routes — **IMPLEMENTED**; (3) execution-time in `canvas-to-steps.ts` as defense-in-depth — **IMPLEMENTED**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | P1       | IMPLEMENTED |
| FR-10 | Suspension-type nodes (delay, approval, human_task, async_webhook) must function correctly when placed on parallel branches. Each branch's durable promise is keyed by unique `step.id` and resolves independently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | P0       | IMPLEMENTED |
| FR-11 | The execution record (`workflow_executions.nodeExecutions[]`) must correctly reflect concurrent execution — nodes on parallel branches will have overlapping `startedAt`/`completedAt` timestamps. No schema changes needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | P0       | PARTIAL     |
| FR-12 | Redis Pub/Sub must emit `step.started` and `step.completed` events for each parallel branch node independently, allowing the Studio monitor to show all branches as running simultaneously.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | P0       | IMPLEMENTED |
| FR-13 | When any branch in a fan-out fails, the default behavior is fail-fast: the barrier join node fails, triggering its `on_failure` edge (if present) or failing the workflow. No partial join is performed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | P0       | IMPLEMENTED |
| FR-14 | The `WorkflowExecutionInput` type must be extended to carry the `inDegreeMap` from `CanvasConversionResult` through all existing canvas conversion call sites: 6 resolution tiers in `lib/version-resolution.ts`, 5 call sites in `routes/workflow-executions.ts`, and 1 each in `services/trigger-engine.ts` and `services/trigger-scheduler.ts` (≈14 total).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | P1       | IMPLEMENTED |
| FR-15 | A Studio canvas validation must warn when an author connects an edge that would create a cycle; the edge addition must be blocked before the canvas state is updated. Visual feedback (red connector line) runs via `isValidConnection` prop on ReactFlow in `WorkflowCanvas.tsx`; a throttled toast fires on rejection. Programmatic backstop is in `onConnect` in the store. — **IMPLEMENTED**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | P1       | IMPLEMENTED |
| FR-16 | When a join/merger node has N incoming `on_success` edges, the Studio node config panel must display a **"Required predecessors" checklist** listing each incoming predecessor node by name. Checked = required: the merger will not start until that predecessor completes; if a required predecessor's path was never reached (skipped), the merger node **fails** (required input missing). Unchecked = optional: if the predecessor's path was skipped the barrier treats it as satisfied (no output available, no block); if it completed its output is still available in context. **Default: all predecessors unchecked (all optional)** — the merger proceeds once all branches have settled (completed or skipped), and no skipped branch causes a failure. The author explicitly checks the predecessors whose outputs are required. The checklist selection is stored as `requiredPredecessors: string[]` (node IDs of checked items only; empty/absent = all optional). | P0       | IMPLEMENTED |
| FR-17 | At runtime the DAG executor must apply the **wait-all-settled** contract for join nodes: (a) always wait for every predecessor (required and optional) to reach terminal state before evaluating the merger — no early release; (b) once all predecessors have settled, check each predecessor in `requiredPredecessors`: if any has status `skipped`, mark the merger `failed` with `REQUIRED_PREDECESSOR_SKIPPED`; (c) if `requiredPredecessors` is absent or empty (default), start the merger regardless of how many predecessors were skipped; (d) outputs of completed predecessors (required or optional) are all available in `ctx.steps` when the merger starts.                                                                                                                                                                                                                                                                                                           | P0       | IMPLEMENTED |

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                 |
| -------------------------- | ------------ | --------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Workflow definitions scoped to project; no lifecycle model changes    |
| Agent lifecycle            | SECONDARY    | Agent invocation nodes can be on parallel branches                    |
| Customer experience        | PRIMARY      | Reduces end-to-end workflow latency for users triggering workflows    |
| Integrations / channels    | SECONDARY    | Connector action nodes work on parallel branches                      |
| Observability / tracing    | PRIMARY      | Concurrent step records and Pub/Sub events change monitoring behavior |
| Governance / controls      | SECONDARY    | Fan-out cap and cycle rejection protect platform stability            |
| Enterprise / compliance    | NONE         | No auth, encryption, or PII changes                                   |
| Admin / operator workflows | NONE         | No admin-facing surface changes                                       |

### Related Feature Integration Matrix

| Related Feature                                              | Relationship Type | Why It Matters                                                              | Key Touchpoints                                                        | Current State |
| ------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------- |
| [Workflows & Human Tasks](../workflows.md)                   | extends           | This is a direct execution-model upgrade within the workflow engine         | `workflow-handler.ts`, `canvas-to-steps.ts`, `WorkflowExecution` model | BETA          |
| Parallel Step (explicit, step-editor)                        | coexists with     | Both fan-out and explicit `parallel` steps will be valid authoring patterns | `parallel-executor.ts`, `step-dispatcher.ts`                           | Implemented   |
| [Workflow Integration Node](../workflow-integration-node.md) | shares data with  | Connector action nodes may appear on parallel branches                      | `connector-action-executor.ts`                                         | ALPHA         |
| Studio Canvas Builder                                        | extends           | Fan-out requires `onConnect` guard change and cycle detection UI            | `workflow-canvas-store.ts`, `computeExecutionEdges.ts`                 | Implemented   |
| Execution Monitor / Debug Panel                              | extends           | Concurrent step records need correct edge classification                    | `computeExecutionEdges.ts`, SSE channel                                | Implemented   |
| Restate Durable Execution                                    | depends on        | `Promise.all` of `ctx.run()` within a single Restate workflow               | `restate-endpoint.ts`, `restate-client.ts`                             | Implemented   |

---

## 6. Design Considerations

The image provided by the user shows the target canvas topology:

```
Start ──► Doc0001 ─────────────► GithubIntegration0001 ──► Human0001 ──┐
      │                        ↑                                         ├──► End0001
      └──► GenAI0001 ──► Delay0001 ──────────────────────────────────────┘
```

- `Start → Doc0001` and `Start → GenAI0001` are two outgoing `on_success` edges from Start — **fan-out**.
- `Doc0001 → GithubIntegration0001` and `GenAI0001 → Delay0001` are independent chains running in parallel.
- `Human0001` feeds into `End0001` from its `on_approve` handle — this is still a linear edge (fan-in at End from Human0001 and from the Delay branch via End's single incoming edge is possible).
- The `End0001` node in the image appears to receive two edges (`Human0001 → End0001` and `Delay0001 → End0001`) — if both are `on_success`, End is a **fan-in barrier**.

The canvas UI must continue to use ReactFlow's edge-connection model. The `onConnect` guard change must:

1. Allow multiple edges from the same `source + sourceHandle` combination.
2. Reject edges where `source + sourceHandle + target` already exists (prevent duplicates).
3. Enforce the `MAX_PARALLEL_BRANCHES` cap per `source + sourceHandle`.

---

## 7. Technical Considerations

### DAG Executor Architecture

The new `dag-executor.ts` module replaces the **main top-level execution queue loop** in `runWorkflow` (line 1031, `while (queue.length > 0)`). There is a second loop at line 785 (`executeStepChain`) which must **not** be replaced — it is a sequential sub-chain executor used by the explicit `parallel` step's `BranchRunner` callback (line 830) and loop body iteration (line ~1102). The DAG executor only replaces the top-level dispatch; `executeStepChain` remains as the sequential executor for loop bodies and explicit parallel-step branches (which may themselves contain fan-out nodes in a future phase). It exposes a single function:

```typescript
executeDag(
  stepIndex: Map<string, WorkflowStep>,
  inDegreeMap: Record<string, number>,
  rootStepIds: string[],
  executeStep: (step: WorkflowStep) => Promise<StepDispatchResult>,
  ctx: WorkflowContextData,
  deps: WorkflowHandlerDeps,
): Promise<void>
```

Internally, the DAG executor:

1. Initializes a `terminalCount: Map<string, number>` tracking how many predecessors have reached terminal state per node.
2. Starts all `rootStepIds` in parallel (nodes with in-degree 0 among the reachable set).
3. When a node reaches a terminal state (completed, skipped, or fail-routed), iterates its `onSuccessSteps` and increments `terminalCount` for each successor.
4. When `terminalCount[nodeId] === inDegreeMap[nodeId]`, the node is "ready" and is launched (or skipped if all its predecessors were skipped, depending on context).
5. **Skip propagation**: when a node is not reachable because it sits on an untraversed conditional branch, it must be marked `skipped`. All its `onSuccessSteps` that are not reachable via any other path are also marked `skipped`, and their `terminalCount` is incremented accordingly. This prevents barrier joins from waiting indefinitely for predecessors that will never execute.
6. Failure propagation follows the existing `onFailureSteps` routing; a fail-routed predecessor satisfies the barrier (its `terminalCount` contribution is counted), and the recovery path within the branch continues. If a branch fails with no failure routing, `Promise.all` rejects and the workflow fails.

### Restate Durability

`Promise.all` of `restateCtx.run()` calls is valid Restate SDK usage. Each `ctx.run(name, fn)` gets a separate journal entry. On replay, completed runs return the journaled result immediately; incomplete runs re-execute. The journal name is `step:{stepId}:attempt:{n}` — unchanged from today.

### Context Shared Mutable State

`WorkflowContextData.steps` is a shared object written by all parallel branches. JavaScript's single-threaded event loop ensures that individual property assignments (per-step writes via `setStepContext`) are atomic — no concurrent mutation hazard. However, barrier nodes must not start until `Promise.all` resolves, which guarantees all branch outputs are present before the join node reads them.

### Cycle Detection — Loop-Node Carve-Out

All three cycle-detection layers (studio DFS, runtime Kahn's, execution-time topological sort) share a deliberate carve-out: **edges whose target is a `loop` node are exempt from cycle detection**. The existing canvas allows loop body steps to connect back to the loop node — this is the intended loop execution pattern and must not be flagged as a cycle. The exemption is implemented by skipping any edge where `nodeTypeOf(target) === 'loop'` when building the adjacency/in-degree structures.

### Migration

Zero migration needed. Existing workflow documents use `onSuccessSteps: ['singleTargetId']` (array with one element). The DAG executor treats this as in-degree 1 → no parallel launch, no barrier wait — identical to today's sequential execution.

### Selective Barrier — `requiredPredecessors` Logic

The join contract is **wait-all-settled**: the DAG executor always waits for every predecessor to reach a terminal state (completed, skipped, or fail-routed) before evaluating the merger. The `requiredPredecessors` field controls only what happens _after_ all have settled — it never triggers early release.

```
// Phase 1 — wait: identical for required and optional predecessors
wait until every predecessor P of join node J is in terminal state

// Phase 2 — evaluate (runs once, after all predecessors have settled)
for each P in requiredPredecessors:
  if P.status === 'skipped' → fail J with REQUIRED_PREDECESSOR_SKIPPED

if no required predecessor was skipped:
  → start J (outputs of completed predecessors are in ctx.steps;
             skipped predecessors contribute no output)
```

**Default behavior (field absent or empty):** `requiredPredecessors` is `[]` or omitted → all predecessors are optional → after all have settled, Phase 2 always passes. The merger starts regardless of how many predecessors were skipped. Authors get a working merge without configuration even when conditional branches are unreachable.

**Optional predecessor (unchecked):** waits to settle like any other predecessor (no early release). If it completed, its `{{steps.NodeX.output.*}}` is available in context. If it was skipped, no output is available but the merger still starts — same as processai's partial merge pattern.

**Required predecessor skipped:** The author explicitly said "I need this output". If the path was never reached, the merger fails rather than silently starting without required data.

### `inDegreeMap` Propagation

The `inDegreeMap` must flow through all canvas conversion call sites (≈14 total):

- `lib/version-resolution.ts` — 6 call sites (the 6 resolution tiers)
- `routes/workflow-executions.ts` — 5 call sites feeding one `buildWorkflowExecutionPayload` call
- `services/trigger-engine.ts` — 1 call site (webhook/cron/polling/connector fires)
- `services/trigger-scheduler.ts` — 1 call site (cron/polling scheduled fires)
- `lib/execution-payload.ts` (builder function) + `workflow-handler.ts` (input type)

All callers that today call `convertCanvasToSteps(..., { full: true })` already receive `CanvasConversionResult`. Adding `inDegreeMap` to this result and threading it into `WorkflowExecutionInput` is the only plumbing change.

---

## 8. How to Consume

### Studio UI

**Authoring fan-out**: Authors draw additional edges from a node's `on_success` handle to multiple targets. The canvas allows up to `MAX_PARALLEL_BRANCHES` (10) edges per handle. A visual indicator (edge count badge or tooltip) may be added in Phase 2.

**Cycle prevention**: If drawing an edge would create a cycle, the `onConnect` handler in `workflow-canvas-store.ts` must detect it via topological sort and display a toast notification: "This connection would create a cycle. Cycles are not supported." The edge is not added.

**Execution monitor**: Concurrent branch nodes appear with overlapping running indicators in the debug panel. The `computeExecutionEdges.ts` edge classifier is updated to mark all outgoing edges of a fan-out node as "taken" simultaneously.

**Merger node config panel**: When a node has N incoming `on_success` edges (N ≥ 2), its config panel automatically renders a "Required predecessors" section with a checkbox list — one row per predecessor, showing the predecessor node's display name. All boxes are **unchecked by default** (all optional). The author checks the predecessors whose outputs are strictly required; unchecked predecessors are optional and a skipped path will not block or fail the merge. The selection is saved as `config.requiredPredecessors: string[]` (node IDs of checked items only; omitted/empty = all optional). The panel updates live as edges are added or removed from the canvas.

### Surface Semantics Matrix

| Asset / Entity Type        | Source of Truth / Ownership     | Design-Time Surface(s)                         | Editable or Read-Only? | Consumer Reference / Binding Model                 | Runtime Materialization                                     | Notes                                          |
| -------------------------- | ------------------------------- | ---------------------------------------------- | ---------------------- | -------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| Fan-out edges              | Canvas (Studio)                 | Canvas edge drawer, `workflow-canvas-store.ts` | Editable               | ReactFlow edges with `sourceHandle = 'on_success'` | `onSuccessSteps: string[]` on step                          | Multiple edges per handle now allowed          |
| `inDegreeMap`              | `canvas-to-steps.ts` conversion | N/A (computed, not authored)                   | Read-only              | `CanvasConversionResult.inDegreeMap`               | Passed through `WorkflowExecutionInput` → `dag-executor.ts` | Pre-computed from edges at conversion time     |
| Barrier completion counter | DAG executor (in-memory)        | N/A                                            | Read-only              | Internal to `dag-executor.ts`                      | `Map<string, number>` inside `executeDag()`                 | Not persisted; reconstructed on Restate replay |

### Design-Time vs Runtime Behavior

- **Design-time**: Authors draw edges freely (up to the fan-out cap). The canvas validates against cycles in real time.
- **Runtime**: The engine computes `inDegreeMap` when the workflow fires (at conversion time, before `runWorkflow`). The DAG executor manages parallelism and barriers transparently — no author configuration needed.

### API (Runtime)

No new API endpoints. The existing `POST /api/projects/:projectId/workflows/:wfId/executions/execute` is unchanged. The engine internally dispatches parallel branches.

### API (Studio)

No new API routes. The canvas `onConnect` mutation in `workflow-canvas-store.ts` is the only Studio API-surface change.

### Admin Portal

N/A — no admin-facing surface changes.

### Channel / SDK / Voice / A2A / MCP Integration

Channel-agnostic. Workflows triggered via webhook, cron, A2A, or SDK all flow through the same execution path. Parallel execution is transparent to callers.

---

## 9. Data Model

### Collections / Tables

**No new collections.** The existing `workflow_executions` collection accommodates parallel execution without schema changes.

```text
Collection: workflow_executions (existing)
New behavior (no new fields):
  - nodeExecutions[].startedAt may now overlap across parallel branch nodes
  - nodeExecutions[].completedAt may now overlap across parallel branch nodes
  - All other fields unchanged

Optional future field (deferred to Phase 2):
  - nodeExecutions[].parallelGroupId?: string  -- groups nodes that started together
```

```text
Collection: workflows / workflow_versions (existing)
New field on join/merger nodes:
  - nodes[].config.requiredPredecessors?: string[]
      Array of predecessor node IDs whose outputs are required to start this node.
      Omitted or empty → all predecessors optional (default); merger proceeds once all have settled.
      Set by the Studio "Required predecessors" checklist.
```

### Key Relationships

- `WorkflowExecution.nodeExecutions[]` — one entry per node, including concurrent nodes. Concurrent nodes have overlapping time ranges; `nodeId` uniqueness is preserved.
- `CanvasConversionResult.inDegreeMap` — derived at fire time from `workflow.edges`; not stored separately.
- `WorkflowExecutionInput.inDegreeMap` — threaded from conversion to handler; not persisted.
- `WorkflowStep.config.requiredPredecessors?: string[]` — authored in Studio, persisted in `workflow.nodes[].config`, read by the DAG executor's selective barrier logic at runtime.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                    | Purpose                                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/executors/dag-executor.ts`    | **NEW**: DAG traversal, barrier counting, parallel dispatch via `Promise.all`                                   |
| `apps/workflow-engine/src/handlers/canvas-to-steps.ts`  | Extend `CanvasConversionResult` with `inDegreeMap`; add cycle detection in `convertCanvasToStepsInternal`       |
| `apps/workflow-engine/src/handlers/workflow-handler.ts` | Replace main sequential queue loop with `executeDag()` call; extend `WorkflowExecutionInput` with `inDegreeMap` |
| `apps/workflow-engine/src/handlers/step-dispatcher.ts`  | Minor: `WorkflowStep` already has `onSuccessSteps?: string[]`; verify no changes needed                         |

### Routes / Handlers

| File                                                     | Purpose                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/routes/workflow-executions.ts` | Thread `inDegreeMap` from `CanvasConversionResult` into execution payload (5 call sites) |
| `apps/workflow-engine/src/services/trigger-engine.ts`    | Thread `inDegreeMap` through trigger fire paths                                          |
| `apps/workflow-engine/src/services/trigger-scheduler.ts` | Thread `inDegreeMap` through cron/polling fire paths                                     |
| `apps/workflow-engine/src/lib/execution-payload.ts`      | Add `inDegreeMap` to `buildWorkflowExecutionPayload` return type                         |

### Routes / Handlers (Runtime)

| File                                          | Purpose                                                                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/workflow-helpers.ts` | **IMPLEMENTED**: `validateWorkflowDag()` (Kahn's algorithm), `WorkflowValidationError` — server-side cycle/self-loop rejection at save time          |
| `apps/runtime/src/routes/workflows.ts`        | **IMPLEMENTED**: `validateWorkflowDag` wired into CREATE and UPDATE routes; returns `400` with `CYCLE_DETECTED` / `SELF_LOOP` / `INVALID_EDGE` codes |

### UI Components

| File                                                                            | Purpose                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/store/workflow-canvas-helpers.ts`                              | **NEW / IMPLEMENTED**: Pure `wouldCreateCycle` (DFS) and `isValidWorkflowConnection` — loop-node carve-out, unit-testable without Zustand                                              |
| `apps/studio/src/store/workflow-canvas-store.ts`                                | **IMPLEMENTED**: `onConnect` — cycle backstop, fan-out guard relaxation, and cap enforcement (MAX_FAN_OUT=10) all implemented                                                          |
| `apps/studio/src/components/workflows/canvas/WorkflowCanvas.tsx`                | **IMPLEMENTED**: `isValidConnection` prop on ReactFlow (real-time visual feedback); throttled toast ("Self-connections / Infinite loop not allowed")                                   |
| `apps/studio/src/components/workflows/canvas/edges/computeExecutionEdges.ts`    | **IMPLEMENTED**: classifies all outgoing edges of fan-out/merge nodes using backend pathState; parallel edge highlighting supported                                                    |
| `apps/studio/src/components/workflows/canvas/nodes/config/MergerNodeConfig.tsx` | **NEW**: Config panel section for join/merger nodes — renders "Required predecessors" checklist; populated from live canvas edge state; persists to `node.config.requiredPredecessors` |

### Jobs / Workers / Background Processes

| File                                                    | Purpose                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/workflow-engine/src/services/restate-endpoint.ts` | Verify `Promise.all` of `ctx.run()` within a single Restate workflow works correctly |

### Tests

| File                                                             | Type        | Coverage Focus                                                                      |
| ---------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/__tests__/dag-executor.test.ts`        | unit        | DAG traversal, barrier semantics, fail-fast, fan-out cap                            |
| `apps/workflow-engine/src/__tests__/canvas-to-steps-dag.test.ts` | unit        | `inDegreeMap` computation, cycle detection                                          |
| `apps/workflow-engine/src/__tests__/e2e-parallel-graph.test.ts`  | integration | Full graph execution via HTTP API — real server, real MongoDB                       |
| `apps/studio/src/__tests__/canvas-fanout.test.ts`                | unit        | `onConnect` guard: fan-out allowed, duplicate rejected, cap enforced, cycle blocked |

---

## 11. Configuration

### Environment Variables

None new. Existing `MAX_PARALLEL_BRANCHES` in `apps/workflow-engine/src/constants.ts` governs the fan-out limit.

### Runtime Configuration

| Setting                 | Default | Description                                                                       |
| ----------------------- | ------- | --------------------------------------------------------------------------------- |
| `MAX_PARALLEL_BRANCHES` | `10`    | Max outgoing `on_success` edges per source handle; enforced at canvas and runtime |
| `MAX_WORKFLOW_STEPS`    | `50`    | Total node cap per workflow; unchanged                                            |

### DSL / Agent IR / Schema

`CanvasConversionResult` (in `canvas-to-steps.ts`) gains a new field:

```typescript
export interface CanvasConversionResult {
  steps: WorkflowStep[];
  nameToIdMap: Record<string, string>;
  outputMappings: OutputMapping[];
  startInputVariables: StartInputVariable[];
  /** NEW: count of incoming on_success edges per node ID */
  inDegreeMap: Record<string, number>;
}
```

`WorkflowExecutionInput` (in `workflow-handler.ts`) gains:

```typescript
export interface WorkflowExecutionInput {
  // ... existing fields ...
  /** NEW: pre-computed in-degree (on_success only) for barrier join semantics */
  inDegreeMap?: Record<string, number>;
}
```

The `?` makes it optional for backward compatibility with callers that haven't been updated yet (they fall back to single-predecessor semantics for all nodes).

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | All parallel branch steps execute within the same execution record, which is already scoped to `tenantId + projectId`. `updateStepStatus` includes both for every write. No cross-project access is possible. |
| Tenant isolation  | `ctx.tenant.tenantId` is propagated to all branch executions via shared context. All persistence calls include `tenantId`. Pub/Sub channels are keyed `workflow:{tenantId}:execution:{executionId}:status`.   |
| User isolation    | No user-owned resources are introduced. Workflow executions are project-scoped, not user-scoped.                                                                                                              |

### Security & Compliance

- No new auth surfaces. Fan-out is an engine-internal execution model change.
- Parallel branches share the same `WorkflowContextData.steps` object. Since JavaScript is single-threaded and branches write to distinct keys (`ctx.steps[stepName]`), there is no race condition or data corruption risk.
- Cycle detection prevents infinite execution loops that could exhaust Restate resources.
- Fan-out cap prevents resource exhaustion from runaway parallelism.

### Performance & Scalability

- **Expected latency improvement**: For workflows with N independent branches each taking T seconds, total time reduces from N×T to T (plus overhead for `Promise.all` coordination).
- **Restate journal overhead**: Each parallel branch node creates a separate `ctx.run` journal entry. A 10-branch fan-out creates 10 journal entries instead of 10 sequential entries. No additional journal size beyond current behavior.
- **MongoDB concurrent writes**: Parallel `updateStepStatus` calls target distinct `nodeExecutions` subdocuments matched by `nodeId`. MongoDB document-level write serialization handles concurrent updates without additional locking.
- **In-memory barrier counter**: `Map<string, number>` holds at most one entry per node. For a 50-node workflow, this is negligible.
- **Backward compatibility**: Single-edge workflows have `inDegreeMap` with all values = 1, and the DAG executor falls through to linear execution — identical to the current queue loop.

### Reliability & Failure Modes

| Failure Mode                                | Behavior                                                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch node fails (no `on_failure` edge)    | `Promise.all` rejects → barrier join fails → workflow fails with `WORKFLOW_FAILED`                                                                                |
| Branch node fails (has `on_failure` edge)   | Failure routing proceeds within the branch; join waits for the on_failure chain to complete (treated as a completed predecessor for barrier purposes)             |
| Required predecessor skipped                | Merger node fails with `REQUIRED_PREDECESSOR_SKIPPED`; its `on_failure` edge fires if present                                                                     |
| Optional predecessor skipped                | Barrier satisfied for that predecessor; merger starts without that output; `{{steps.NodeX.output.*}}` resolves to undefined                                       |
| Restate replay during parallel execution    | Each `ctx.run` replays independently from journal; barrier counter is reconstructed by re-running all branches (completed ones return journal values immediately) |
| Cycle in canvas (design-time)               | `onConnect` in Studio rejects the edge with a user-facing error                                                                                                   |
| Cycle in canvas (runtime, defense-in-depth) | `convertCanvasToStepsInternal` detects the cycle and returns an error result; workflow fails at start                                                             |
| Fan-out cap exceeded                        | Studio blocks the 11th edge; runtime throws `MAX_FAN_OUT_EXCEEDED` if somehow bypassed                                                                            |

### Observability

- Existing `step.started`, `step.completed`, `step.failed` Pub/Sub events are emitted per node. For parallel branches, multiple `step.started` events fire at roughly the same time (within the same event-loop tick when `Promise.all` is called).
- The execution record (`nodeExecutions[]`) naturally captures concurrent execution via overlapping timestamps.
- `createLogger('workflow-engine:dag-executor')` must be used for all new log output.
- TraceEvents via `TraceStore` should be emitted for DAG execution milestones (fan-out start, barrier satisfied, join start) in Phase 2.

### Data Lifecycle

- No new collections, no new TTLs.
- `inDegreeMap` is computed at fire time and is not persisted — it is derived deterministically from the workflow definition on every execution.
- Right-to-erasure cascades are unchanged (covered by the parent Workflows feature, GAP-12).

---

## 13. Delivery Plan / Work Breakdown

1. **Extend `canvas-to-steps.ts`**
   1.1 Add `inDegreeMap: Record<string, number>` to `CanvasConversionResult` interface
   1.2 Compute `inDegreeMap` in `convertCanvasToStepsInternal` by iterating all steps' `onSuccessSteps`
   1.3 Add execution-time cycle detection (defense-in-depth): if topological sort detects a cycle, throw `WorkflowStepError(STEP_FAILED, 'Workflow graph contains a cycle: ...')`. Note: design-time detection (`workflow-canvas-helpers.ts`) and save-time detection (`workflow-helpers.ts`) are already implemented.
   1.4 Verify `EMPTY_RESULT` still returns `inDegreeMap: {}` (backward compat)
   1.5 Unit tests: basic fan-out topology, join topology, cycle detection, single-edge backward compat

2. **Extract `dag-executor.ts`**
   2.1 Define `DagExecutorParams` interface with `stepIndex`, `inDegreeMap`, `rootStepIds`, and callback types
   2.2 Implement `executeDag()`: initialize completion counter, dispatch root nodes in parallel, chain successors when barriers are satisfied; read `step.config.requiredPredecessors` per join node and apply selective barrier (FR-17)
   2.3 Implement fail-fast: if any branch `Promise.all` rejects, propagate error
   2.4 Handle `onFailureSteps` routing within branches: branch failure routes to failure path; barrier treats a "completed-via-failure-path" predecessor as satisfied
   2.5 Add fan-out cap check: if `onSuccessSteps.length > MAX_PARALLEL_BRANCHES`, throw `MAX_FAN_OUT_EXCEEDED`
   2.6 Comprehensive unit tests: linear (1-to-1), fan-out, fan-in, diamond pattern, suspension nodes on branches

3. **Integrate DAG executor into `workflow-handler.ts`**
   3.1 Extend `WorkflowExecutionInput` with optional `inDegreeMap?: Record<string, number>`
   3.2 Replace the main sequential `while (queue.length > 0)` loop (lines 1031–~2121) with a call to `executeDag()`
   3.3 Preserve all suspension handling (delay, approval, human_task, async_webhook) — move to `executeStepWithSuspension()` helper called from DAG executor callback
   3.4 Preserve cancellation check between steps
   3.5 Verify loop iteration (`loopIteration` result) still works within branch chains
   3.6 Integration tests via HTTP API (real server + real MongoDB): diamond pattern, linear backward compat, suspension on branch, cancellation during parallel execution

4. **Thread `inDegreeMap` through all fire paths**
   4.1 Update `buildWorkflowExecutionPayload` in `execution-payload.ts` to accept and forward `inDegreeMap`
   4.2 Update execute route (`routes/workflow-executions.ts`) to pass `inDegreeMap` from `CanvasConversionResult` through the 3 private resolution helpers and into `buildWorkflowExecutionPayload`; update the local `ExecutionDefinition` intermediate type to carry `inDegreeMap`
   4.3 Update `trigger-engine.ts` fire paths (webhook, cron, polling, connector-backed)
   4.4 Update `trigger-scheduler.ts` cron/polling fire paths
   4.5 Add `inDegreeMap` to `ResolvedWorkflowDefinition` in `lib/version-resolution.ts`; thread it from `conversion.inDegreeMap` in all 6 return statements (5 cascade tiers + working-copy canvas fallback)
   4.6 Update `workflow-handler.ts` `WorkflowExecutionInput` usage in tests

5. **Studio canvas changes**
   5.1 Relax `onConnect` guard in `workflow-canvas-store.ts`: allow multiple edges from same `source + sourceHandle`, still reject `source + sourceHandle + target` duplicates
   5.2 Add fan-out cap: if `edges.filter(e => e.source === source && e.sourceHandle === sourceHandle).length >= MAX_PARALLEL_BRANCHES`, show toast and reject
   5.3 ~~Add cycle detection in `onConnect`~~ — **IMPLEMENTED**: `wouldCreateCycle` from `workflow-canvas-helpers.ts` already called in `onConnect` as backstop; ReactFlow `isValidConnection` in `WorkflowCanvas.tsx` gives live visual feedback + throttled toast
   5.4 Update `computeExecutionEdges.ts`: when a node has multiple `onSuccessSteps`, classify all outgoing edges as "taken" when node status is `completed`
   5.5 Unit tests for all `onConnect` paths: fan-out allowed, duplicate rejected, cap enforced, cycle blocked
   5.6 Implement `MergerNodeConfig.tsx`: when a node has ≥ 2 incoming `on_success` edges, render "Required predecessors" checklist in the config panel; **default all unchecked (all optional)**; persist to `node.config.requiredPredecessors` (only checked IDs stored; empty/absent = all optional); update when edges are added/removed from canvas
   5.7 Unit tests: checklist renders correct predecessor names; toggle updates config; removing an edge drops predecessor from list; **adding edge adds it unchecked by default** (optional)

6. **Documentation & observability**
   6.1 Update `docs/features/workflows.md` to add FR-45 through FR-59 for parallel graph execution
   6.2 Update this sub-feature spec status to ALPHA after implementation
   6.3 Add `dag-executor.ts` to the architecture components table in `docs/features/workflows.md`
   6.4 Update `apps/workflow-engine/agents.md` with lessons learned about DAG execution and Restate `Promise.all` behavior

---

## 14. Success Metrics

| Metric                                | Baseline               | Target                                          | How Measured                                       |
| ------------------------------------- | ---------------------- | ----------------------------------------------- | -------------------------------------------------- |
| Fan-out workflow total execution time | N×T (sequential)       | ~T (parallel, overhead <100ms)                  | k6 benchmark: 3-branch diamond workflow            |
| 1-to-1 workflow latency regression    | Current p99            | <2% regression                                  | k6 regression benchmark vs. main branch            |
| DAG executor unit test coverage       | INT-3 through INT-8    | ≥90% branch coverage                            | `pnpm test --filter=workflow-engine`               |
| Canvas fan-out blocked by `onConnect` | N/A (not possible)     | Feature enabled, zero duplicate-edge escapes    | E2E: draw 2+ edges from same handle, run execution |
| Cycle detection at design time        | 0 (no cycle detection) | 100% of cyclic graphs rejected before execution | Unit tests + Studio E2E                            |

---

## 15. Open Questions

1. **Restate `Promise.all(ctx.run())` behavior on replay**: The Restate SDK docs specify that `ctx.run()` returns the journaled value on replay. `Promise.all` of multiple `ctx.run()` calls should work but should be validated against SDK v1.10.4 behavior in a targeted test before full implementation.

2. ~~**Failure path predecessor counting**~~ **RESOLVED**: When a branch node fails and follows an `on_failure` edge to a recovery node, the fail-routed branch satisfies the barrier — it contributes to `terminalCount` once it reaches any terminal state. This is consistent with the skip propagation model: the barrier counts all predecessors in terminal state (completed, skipped, or fail-routed), not just those that took the `on_success` path. The recovery sub-chain within the branch continues independently; the join node starts once all static predecessors are terminal. Derived from processai `SynchronizationGateway` retry model.

3. **`loop` node on parallel branches**: The loop step dispatches via `executeStepChain` which iterates body steps. When a loop node is on a parallel branch, its body steps run sequentially within the branch — this is correct behavior but should be explicitly tested and documented.

4. **Human task / approval on parallel branches**: Two parallel branches each containing an approval node create two inbox tasks that both need resolution. Authors may not expect this. A design-time warning (e.g., canvas tooltip "This node requires human input and will pause this branch") may be needed.

---

## 16. Gaps, Known Issues & Limitations

| ID     | Description                                                                                                                                                                                                                                                                            | Severity | Status |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-01 | Studio `onConnect` guard at `workflow-canvas-store.ts:316–319` still blocks all fan-out (`alreadyConnected` checks `source+sourceHandle` without regard to target) — **primary UI blocker** for fan-out                                                                                | High     | Open   |
| GAP-02 | ~~No design-time cycle detection~~ — **CLOSED**: Studio `workflow-canvas-helpers.ts` (DFS) + `WorkflowCanvas.tsx` + runtime `workflow-helpers.ts` (Kahn's) all enforce cycle rejection. Execution-time detection in `canvas-to-steps.ts` (Kahn's algorithm) added as defense-in-depth. | Medium   | Closed |
| GAP-03 | `computeExecutionEdges.ts` edge classifier walks nodes sequentially and may not correctly highlight all parallel branches as "taken" simultaneously                                                                                                                                    | Medium   | Open   |
| GAP-04 | `MAX_PARALLEL_BRANCHES = 10` cap is not enforced at the Studio canvas level today — nothing prevents drawing 11+ edges via the API                                                                                                                                                     | Low      | Open   |
| GAP-05 | No explicit test coverage for `Promise.all` of `ctx.run()` inside Restate — needs targeted validation                                                                                                                                                                                  | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                              | Coverage Type | Status     | Test File / Note              |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------- | ---------- | ----------------------------- |
| 1   | Diamond workflow: Start→A,B; A,B→Join; Join→End — all nodes execute and join waits for both                           | integration   | NOT TESTED | `e2e-parallel-graph.test.ts`  |
| 2   | Linear workflow (1-to-1): identical behavior post-refactor                                                            | integration   | NOT TESTED | `e2e-parallel-graph.test.ts`  |
| 3   | Fan-out fail-fast: branch B fails; join never starts; workflow fails                                                  | integration   | NOT TESTED | `e2e-parallel-graph.test.ts`  |
| 4   | Fan-out with delay node on one branch: branch A completes instantly; branch B waits for delay; join starts after both | integration   | NOT TESTED | `e2e-parallel-graph.test.ts`  |
| 5   | Context access at join: `{{steps.BranchA.output.x}}` and `{{steps.BranchB.output.y}}` both resolve                    | integration   | NOT TESTED | `e2e-parallel-graph.test.ts`  |
| 6   | Cycle detection: `convertCanvasToStepsInternal` returns error for cyclic graph                                        | unit          | NOT TESTED | `canvas-to-steps-dag.test.ts` |
| 7   | `inDegreeMap` computation: correct in-degree for diamond, linear, tree topologies                                     | unit          | NOT TESTED | `canvas-to-steps-dag.test.ts` |
| 8   | DAG executor: barrier waits for N predecessors before launching join node                                             | unit          | NOT TESTED | `dag-executor.test.ts`        |
| 9   | Canvas `onConnect`: 2nd edge from same handle allowed; 11th edge blocked                                              | unit          | NOT TESTED | `canvas-fanout.test.ts`       |
| 10  | Canvas `onConnect`: cyclic edge rejected with toast message                                                           | unit          | NOT TESTED | `canvas-fanout.test.ts`       |
| 11  | Cancellation during parallel execution: both branches receive cancel signal                                           | integration   | NOT TESTED | `e2e-parallel-graph.test.ts`  |

### Testing Notes

All tests must use the real HTTP API (no mocks of codebase components per CLAUDE.md E2E standards). The integration tests start a real workflow-engine server on a random port with a real MongoDB connection. No `vi.mock` of `@abl/*` or `@agent-platform/*` packages is permitted.

> Full testing details: `../../testing/sub-features/workflow-parallel-graph-execution.md`

---

## 18. References

- Parent feature: `docs/features/workflows.md`
- HLD: `docs/specs/workflows.hld.md`
- LLD: `docs/plans/workflows.lld.md`
- Engine constants: `apps/workflow-engine/src/constants.ts`
- Canvas store: `apps/studio/src/store/workflow-canvas-store.ts:310–318` (onConnect guard)
- DAG executor pattern: `apps/workflow-engine/src/executors/parallel-executor.ts`
- Existing workflow handler: `apps/workflow-engine/src/handlers/workflow-handler.ts`
- Canvas-to-steps converter: `apps/workflow-engine/src/handlers/canvas-to-steps.ts`
- Feature matrix: `docs/feature-matrix.md`
