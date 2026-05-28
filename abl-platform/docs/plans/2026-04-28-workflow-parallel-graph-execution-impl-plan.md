# LLD: Workflow Parallel Graph Execution (Fan-Out / Fan-In)

**Feature Spec**: `docs/features/sub-features/workflow-parallel-graph-execution.md`
**Parent HLD**: `docs/specs/workflows.hld.md`
**Test Spec**: `docs/testing/sub-features/workflow-parallel-graph-execution.md`
**Status**: DRAFT
**Date**: 2026-04-28
**Ticket**: ABLP-155

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                                                               | Rationale                                                                                                                                                                                                                                                  | Alternatives Rejected                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | `executeDag()` receives a pre-wrapped `executeStep` callback, not `restateCtx`                                                                         | Decouples DAG traversal from Restate; follows `parallel-executor.ts` BranchRunner pattern; entire step lifecycle (dispatch + suspension + routing) encapsulated in the callback                                                                            | Passing `restateCtx` directly — would bleed Restate concerns into a reusable DAG module                                                                           |
| D-2  | `requiredPredecessors` added to `CanvasRoutingMeta` (not node-type-specific config)                                                                    | It is canvas routing metadata, exactly like `onSuccessSteps`; all canvas-routed steps can carry it via the `BaseWorkflowStep & CanvasRoutingMeta` intersection                                                                                             | Add to a generic `config` field — WorkflowStep union doesn't have a common `config`; would require unsafe casts                                                   |
| D-3  | Loop replacement split: Phase 3a extracts suspension helpers (refactor), Phase 3b swaps loop for executeDag (feat)                                     | CLAUDE.md forbids rewriting >200 lines in one pass; strangler pattern limits blast radius; suspension helper is independently valuable                                                                                                                     | Single-phase loop replacement — too risky for a ~820-line loop with 4 suspension types and complex control flow                                                   |
| D-4  | `inDegreeMap` threaded as optional field (`?`) through all interfaces                                                                                  | Backward-compatible: absent = sequential fallback; acts as natural rollout flag; no explicit feature flag needed                                                                                                                                           | Mandatory field — would require all 14 call sites to change atomically                                                                                            |
| D-5  | `dag-executor.ts` implements its own `Promise.all`; does not reuse `executeParallel()`                                                                 | Different semantics (graph traversal with barrier counting vs. explicit named branches); `executeParallel`'s `BranchRunner`/`ParallelResult` shape doesn't fit DAG dispatch                                                                                | Reusing `executeParallel` — coupling two independent execution models                                                                                             |
| D-6  | `inDegreeMap` added to `ResolvedWorkflowDefinition` as well as `WorkflowExecutionInput`                                                                | Must flow through the full chain; same propagation pattern as `startInputVariables`                                                                                                                                                                        | Adding only to WorkflowExecutionInput — callers that go through `resolveWorkflowDefinition` would not have access                                                 |
| D-7  | LLD covers only PLANNED parts of FRs; includes verification tasks for IMPLEMENTED parts (FR-9 partial, FR-15)                                          | LLD is a plan for remaining work; IMPLEMENTED FRs are committed in Pre-phase                                                                                                                                                                               | Replanning IMPLEMENTED work creates confusion                                                                                                                     |
| D-8  | `executeStepWithSuspension` callback handles ALL routing (condition routing, onFailure, onReject, loopIteration, suspension) and returns `StepOutcome` | Keeps DAG executor routing-agnostic; all routing semantics stay in `runWorkflow` closure where `executeStepChain` and Restate context are available                                                                                                        | Having DAG executor call different callbacks per step type — over-complicates the executor interface                                                              |
| D-9  | `rootStepIds` computed from the step graph's in-degree, not from `inDegreeMap` alone                                                                   | When `inDegreeMap` is absent/empty, falling through to dispatch ALL steps simultaneously would break sequential workflows. Root nodes are those with `inDegreeMap[id] === 0` after computing `inDegreeMap` from `step.onSuccessSteps` at runtime if needed | Trusting `inDegreeMap` is always pre-computed — not safe; it may be absent for legacy callers                                                                     |
| D-10 | `MergerNodeConfig` subscribes to the store directly via `useWorkflowCanvasStore`                                                                       | All existing config panels that need graph data use this pattern (e.g., `ConnectionsTab`); props-only pattern would require ConfigPanel to pass graph-level data breaking the existing `NodeConfigProps` interface                                         | Adding `predecessorNodes` as a prop — breaks the standard `{ nodeId, config, onUpdate }` pattern                                                                  |
| D-11 | Pre-phase split into 2 commits (runtime cycle detection + Studio cycle detection)                                                                      | Commit scope guard allows max 3 packages per commit; splitting keeps each commit single-concern and under the package limit                                                                                                                                | Single pre-phase commit — at the limit (3 packages), harder to revert atomically                                                                                  |
| D-12 | `getAllSuccessorIds(step)` helper used throughout `dag-executor.ts` for successor lookup                                                               | Condition steps do NOT have `onSuccessSteps` — they store edges in `thenSteps`/`elseSteps`/`conditions[].targetSteps`. Using `step.onSuccessSteps ?? []` everywhere would miss all condition targets, causing barrier hangs and incorrect skip propagation | Treating conditions identically to other steps — would break workflows with any condition node                                                                    |
| D-13 | `DagExecutorParams` includes `ctx: WorkflowContextData`                                                                                                | The executor needs to mark skipped steps in `ctx.steps` (for `{{steps.X.output.*}}` resolution) and read predecessor status for selective barrier evaluation                                                                                               | Passing a `markSkipped` callback — requires more interface surface; `ctx` is already available in the `runWorkflow` closure and is the canonical step state store |
| D-14 | `StepOutcome` gains `workflow_terminated` variant for rejection paths that exit `runWorkflow`                                                          | Approval/human_task nodes with no reject routing call `deps.persistence.updateExecutionStatus` and return from `runWorkflow` directly — the helper cannot `return` from the parent function, so it must signal termination via an outcome                  | Throwing a custom error — could be conflated with step failures; a typed variant is cleaner                                                                       |

### Key Interfaces & Types

```typescript
// canvas-to-steps.ts — add inDegreeMap to CanvasConversionResult
export interface CanvasConversionResult {
  steps: WorkflowStep[];
  nameToIdMap: Record<string, string>;
  outputMappings: OutputMapping[];
  startInputVariables: StartInputVariable[];
  /** NEW: count of incoming on_success edges per node ID (excluding loop-target edges) */
  inDegreeMap: Record<string, number>;
}

// step-dispatcher.ts — add requiredPredecessors to CanvasRoutingMeta
interface CanvasRoutingMeta {
  name?: string;
  onSuccessSteps?: string[];
  onFailureSteps?: string[];
  onRejectSteps?: string[];
  canvasRouted?: boolean;
  /** NEW: IDs of predecessor nodes whose completion is required for this barrier node.
   *  Empty/absent = all predecessors optional. Set by MergerNodeConfig checklist.
   *  Accessed as step.requiredPredecessors on WorkflowStep (via intersection). */
  requiredPredecessors?: string[];
}

// workflow-handler.ts — add inDegreeMap to WorkflowExecutionInput
export interface WorkflowExecutionInput {
  // ... existing fields unchanged ...
  /** NEW: pre-computed in-degree (on_success only). Absent = sequential fallback. */
  inDegreeMap?: Record<string, number>;
}

// version-resolution.ts — add inDegreeMap to ResolvedWorkflowDefinition
export interface ResolvedWorkflowDefinition {
  // ... existing fields unchanged ...
  /** NEW: forwarded from CanvasConversionResult.inDegreeMap.
   *  Always present; {} for working-copy-steps tier (pre-canvas legacy). */
  inDegreeMap: Record<string, number>;
}

// execution-payload.ts — add inDegreeMap to both types
export interface BuildExecutionPayloadInput {
  // ... existing ...
  inDegreeMap?: Record<string, number>;
}
export interface WorkflowExecutionPayload {
  [key: string]: unknown;
  // ... existing ...
  inDegreeMap?: Record<string, number>;
}

// dag-executor.ts — new module
// StepOutcome encapsulates ALL routing outcomes so the DAG executor stays routing-agnostic.
// executeStepWithSuspension translates the queue loop's control flow into this enum.
export type StepOutcome =
  | { status: 'completed'; activatedSuccessors: string[] }
  // activatedSuccessors: the actual next step IDs to dispatch.
  // For non-condition steps: step.onSuccessSteps (all successors in parallel).
  // For condition steps: result.nextSteps (only the chosen branch).
  // For failure-routed steps: step.onFailureSteps (recovery path, counts as terminal).
  // For reject-routed steps: step.onRejectSteps or step.onFailureSteps.
  // The DAG executor skip-propagates:
  //   skippedSuccessors = getAllSuccessorIds(step).filter(id => !activatedSuccessors.includes(id))
  | { status: 'terminal_no_successors' }
  // Step completed but has no outgoing edges (natural end of a branch, e.g., End node).
  | { status: 'failed' }
  // Step failed with no routing — propagates up to fail the workflow.
  | { status: 'workflow_terminated'; result: WorkflowExecutionResult };
// Approval/human_task nodes with no reject-path call persistence and return from runWorkflow.
// The helper signals this via this variant; the caller catches and terminates the workflow.

export interface DagExecutorParams {
  stepIndex: Map<string, WorkflowStep>;
  /**
   * Pre-computed in-degree map from CanvasConversionResult.inDegreeMap.
   * If empty, the executor computes it on-the-fly using getAllSuccessorIds() from step graph.
   * NOTE: must count edges from condition step branches (thenSteps/elseSteps/conditions[])
   * in addition to onSuccessSteps, using getAllSuccessorIds() helper.
   */
  inDegreeMap: Record<string, number>;
  /** Root step IDs: those with computed in-degree 0. */
  rootStepIds: string[];
  /**
   * Executes a single step including: dispatch → routing → suspension → completion marking.
   * Returns StepOutcome with the set of ACTIVATED successors (not all possible successors).
   * Handles: condition routing, onFailure/onReject routing, loopIteration body, suspension.
   * Does NOT call the DAG executor recursively — just returns the outcome.
   */
  executeStep: (step: WorkflowStep) => Promise<StepOutcome>;
  /**
   * Shared workflow context. Required so the executor can mark skipped steps in ctx.steps
   * (for {{steps.X.output.*}} resolution) and check predecessor status for selective barrier.
   */
  ctx: WorkflowContextData;
}

// Internal helper — must be defined in dag-executor.ts and used throughout:
// Returns ALL possible successor IDs for a step (handles condition step edge fields).
// function getAllSuccessorIds(step: WorkflowStep): string[] {
//   if (step.onSuccessSteps) return step.onSuccessSteps;
//   if (step.type === 'condition') {
//     const cs = step as { thenSteps?: string[]; elseSteps?: string[]; conditions?: Array<{ targetSteps: string[] }> };
//     const all = new Set<string>();
//     for (const t of cs.thenSteps ?? []) all.add(t);
//     for (const t of cs.elseSteps ?? []) all.add(t);
//     for (const branch of cs.conditions ?? []) branch.targetSteps.forEach(t => all.add(t));
//     return [...all];
//   }
//   return [];
// }
// Used in: notifyTerminal (skip propagation), skipPropagate, on-the-fly inDegreeMap fallback.

export async function executeDag(params: DagExecutorParams): Promise<void>;
```

### Module Boundaries

| Module                     | Responsibility                                                                                                                                                                                       | Depends On                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `canvas-to-steps.ts`       | Compute `inDegreeMap`; execution-time cycle detection; attach `requiredPredecessors` from node config                                                                                                | `step-dispatcher.ts` (WorkflowStep type)                 |
| `step-dispatcher.ts`       | Define `CanvasRoutingMeta` (add `requiredPredecessors`); define `WorkflowStep` union                                                                                                                 | Executor types                                           |
| `dag-executor.ts`          | DAG traversal, barrier counting, skip propagation, parallel dispatch, selective barrier. Does NOT handle routing logic — all routing is encapsulated in the `executeStep` callback                   | `step-dispatcher.ts`, `workflow-handler.ts` (types only) |
| `workflow-handler.ts`      | Extract `executeStepWithSuspension()` helper (handles ALL routing + suspension, returns `StepOutcome`); replace queue loop with `executeDag()`; compute `rootStepIds`; handle `inDegreeMap` fallback | `dag-executor.ts`                                        |
| `version-resolution.ts`    | Thread `inDegreeMap` through all 6 resolution tiers                                                                                                                                                  | `canvas-to-steps.ts`                                     |
| `execution-payload.ts`     | Add `inDegreeMap` to payload builder with `?? {}` default                                                                                                                                            | –                                                        |
| `workflow-executions.ts`   | Thread `inDegreeMap` through `ExecutionDefinition` type and 3 private resolution helpers                                                                                                             | `version-resolution.ts`, `execution-payload.ts`          |
| `trigger-engine.ts`        | Thread `inDegreeMap` through trigger fire path                                                                                                                                                       | `version-resolution.ts`, `execution-payload.ts`          |
| `trigger-scheduler.ts`     | Thread `inDegreeMap` through cron/polling fire path                                                                                                                                                  | `version-resolution.ts`, `execution-payload.ts`          |
| `workflow-canvas-store.ts` | Relax fan-out guard; enforce cap; cycle detection backstop remains                                                                                                                                   | `workflow-canvas-helpers.ts`                             |
| `MergerNodeConfig.tsx`     | Render "Required predecessors" checklist; subscribe to store directly for edges/nodes                                                                                                                | `workflow-canvas-store.ts` (Zustand)                     |
| `panels/ConfigPanel.tsx`   | Conditionally render `MergerNodeConfig` when selected node has ≥2 incoming on_success edges                                                                                                          | `MergerNodeConfig.tsx`                                   |

---

## 2. File-Level Change Map

### New Files

| File                                                                      | Purpose                                                                                                                          | LOC Estimate |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `apps/workflow-engine/src/executors/dag-executor.ts`                      | DAG traversal, barrier counting, skip propagation, selective barrier                                                             | 150–200      |
| `apps/workflow-engine/src/__tests__/dag-executor.test.ts`                 | Unit tests: barrier semantics, fail-fast, skip propagation, fan-out cap, selective barrier                                       | 350–450      |
| `apps/workflow-engine/src/__tests__/canvas-to-steps-dag.test.ts`          | Unit tests: inDegreeMap computation, cycle detection                                                                             | 150–200      |
| `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts`        | System tests (real MongoDB): diamond, backward compat, fail-fast, delay branch, context at join, cancellation, selective barrier | 500–600      |
| `apps/studio/src/components/workflows/canvas/config/MergerNodeConfig.tsx` | Required predecessors checklist for join/merger nodes; subscribes to store for edges/nodes                                       | 100–140      |
| `apps/studio/src/__tests__/canvas-fanout.test.ts`                         | Unit tests: onConnect fan-out allowed, duplicate rejected, cap enforced, cycle blocked, computeExecutionEdges, MergerNodeConfig  | 200–250      |

### Modified Files

| File                                                                 | Change Description                                                                                                                                                                        | Risk   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `apps/workflow-engine/src/handlers/step-dispatcher.ts`               | Add `requiredPredecessors?: string[]` to `CanvasRoutingMeta`                                                                                                                              | Low    |
| `apps/workflow-engine/src/handlers/canvas-to-steps.ts`               | Add `inDegreeMap` to `CanvasConversionResult`; compute in `convertCanvasToStepsInternal`; execution-time cycle detection; attach `requiredPredecessors`; update `EMPTY_RESULT`            | Low    |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`              | Add `inDegreeMap?` to `WorkflowExecutionInput`; extract `executeStepWithSuspension()` (refactor); compute effective `inDegreeMap` + `rootStepIds`; replace queue loop with `executeDag()` | High   |
| `apps/workflow-engine/src/lib/version-resolution.ts`                 | Add `inDegreeMap` to `ResolvedWorkflowDefinition`; thread through 6 return statements                                                                                                     | Low    |
| `apps/workflow-engine/src/lib/execution-payload.ts`                  | Add `inDegreeMap?` to `BuildExecutionPayloadInput` and `WorkflowExecutionPayload`; always include with `?? {}` default                                                                    | Low    |
| `apps/workflow-engine/src/routes/workflow-executions.ts`             | Add `inDegreeMap?` to `ExecutionDefinition` type; thread through 3 private resolution helpers (5 return paths total); pass to `buildWorkflowExecutionPayload`                             | Low    |
| `apps/workflow-engine/src/services/trigger-engine.ts`                | Add `inDegreeMap: resolved.inDegreeMap` at the `buildWorkflowExecutionPayload` call (~line 555)                                                                                           | Low    |
| `apps/workflow-engine/src/services/trigger-scheduler.ts`             | Add `inDegreeMap: resolved.inDegreeMap` at the `buildWorkflowExecutionPayload` call (~line 293)                                                                                           | Low    |
| `apps/studio/src/store/workflow-canvas-store.ts`                     | Relax fan-out guard (line 316–319); add fan-out cap check                                                                                                                                 | Medium |
| `apps/studio/src/components/workflows/canvas/panels/ConfigPanel.tsx` | Add conditional `MergerNodeConfig` section when selected node has ≥2 incoming on_success edges                                                                                            | Low    |

### Pre-Phase Files (Already Staged — Commit First)

| File                                                             | Status          | Description                                                                                      |
| ---------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `apps/runtime/src/routes/workflow-helpers.ts`                    | Staged NEW      | `validateWorkflowDag()` (Kahn's), `WorkflowValidationError` — FR-9 layer 2                       |
| `apps/runtime/src/routes/workflows.ts`                           | Staged MODIFIED | Wired `validateWorkflowDag` into CREATE/UPDATE routes — FR-9 layer 2                             |
| `apps/studio/src/store/workflow-canvas-helpers.ts`               | Staged NEW      | `wouldCreateCycle` (DFS), `isValidWorkflowConnection` — FR-9 layer 1 / FR-15                     |
| `apps/studio/src/store/workflow-canvas-store.ts`                 | Staged MODIFIED | Cycle backstop in `onConnect` — FR-15 (cycle detection part only; fan-out guard NOT yet changed) |
| `apps/studio/src/components/workflows/canvas/WorkflowCanvas.tsx` | Staged MODIFIED | `isValidConnection` prop with throttled toast — FR-15                                            |

---

## 3. Implementation Phases

### Pre-Phase: Commit Staged Cycle-Detection Files

**Goal**: Establish clean baseline from the stash-applied cycle detection code before DAG executor work begins.

**Tasks**:

P.1 Format all 5 staged files: `npx prettier --write <files>`

P.2 Commit runtime files as **commit 1**: `[ABLP-155] feat(runtime): add save-time cycle detection for workflow DAG validation`

- `apps/runtime/src/routes/workflow-helpers.ts`
- `apps/runtime/src/routes/workflows.ts`

P.3 Commit Studio files as **commit 2**: `[ABLP-155] feat(studio): add canvas cycle detection with DFS + ReactFlow isValidConnection`

- `apps/studio/src/store/workflow-canvas-helpers.ts`
- `apps/studio/src/store/workflow-canvas-store.ts`
- `apps/studio/src/components/workflows/canvas/WorkflowCanvas.tsx`

P.4 Verify `pnpm build --filter=@abl/workflow-engine --filter=@abl/runtime --filter=@abl/studio` passes with 0 errors.

**Exit Criteria**:

- [ ] 5 staged files committed in 2 focused commits (runtime and studio separately)
- [ ] `pnpm build --filter=@abl/workflow-engine` passes
- [ ] `pnpm build --filter=@abl/studio` passes
- [ ] `pnpm build --filter=@abl/runtime` passes

**Rollback**: `git revert <commit-hash>` for each commit independently.

---

### Phase 1: Extend `canvas-to-steps.ts` + `step-dispatcher.ts`

**Goal**: Add `inDegreeMap` to the conversion output, add execution-time cycle detection, and thread `requiredPredecessors` from canvas node config into the step IR.

**Tasks**:

1.1 **`step-dispatcher.ts`**: Add `requiredPredecessors?: string[]` to `CanvasRoutingMeta` (line ~63). This is additive — the intersection type makes it available on all `WorkflowStep` instances as `step.requiredPredecessors`.

1.2 **`canvas-to-steps.ts`**: Add `inDegreeMap: Record<string, number>` to `CanvasConversionResult` interface (line ~86).

1.3 **`canvas-to-steps.ts`** — compute `inDegreeMap` in `convertCanvasToStepsInternal` after the topological walk (before the return statement at line ~369).

CRITICAL: condition steps do not have `onSuccessSteps` — they store outgoing edges in `conditions[].targetSteps` (and legacy `thenSteps`/`elseSteps`). Must collect successors from ALL fields. Define a local helper `getAllStepSuccessorIds`:

```typescript
function getAllStepSuccessorIds(step: WorkflowStep): string[] {
  if (step.onSuccessSteps?.length) return step.onSuccessSteps;
  // condition steps: collect all branch targets
  const cs = step as {
    thenSteps?: string[];
    elseSteps?: string[];
    conditions?: Array<{ targetSteps?: string[] }>;
  };
  const all = new Set<string>();
  for (const t of cs.thenSteps ?? []) all.add(t);
  for (const t of cs.elseSteps ?? []) all.add(t);
  for (const branch of cs.conditions ?? []) {
    for (const t of branch.targetSteps ?? []) all.add(t);
  }
  return [...all];
}

const inDegreeMap: Record<string, number> = {};
for (const step of orderedSteps) {
  if (!(step.id in inDegreeMap)) inDegreeMap[step.id] = 0;
  for (const targetId of getAllStepSuccessorIds(step)) {
    // Loop-node carve-out: edges to loop nodes are intentional back-edges;
    // their in-degree is not counted for barrier purposes.
    const targetNode = nodeMap.get(targetId);
    if (targetNode?.nodeType === 'loop') continue;
    inDegreeMap[targetId] = (inDegreeMap[targetId] ?? 0) + 1;
  }
}
```

This is consistent with the `wouldCreateCycle` loop-node carve-out in `workflow-canvas-helpers.ts:42`. The same `getAllStepSuccessorIds` helper must also be used in the cycle detection below (Phase 1.4).

1.4 **`canvas-to-steps.ts`** — add execution-time cycle detection (defense-in-depth, FR-9 layer 3) using Kahn's algorithm. After constructing `inDegreeMap`, perform a topological sort using the same `getAllStepSuccessorIds` helper defined in Phase 1.3 for the adjacency list (loop-node carve-out applies). If not all steps are reachable, a cycle exists. Throw `WorkflowStepError(StepErrorCode.STEP_FAILED, 'Workflow graph contains a cycle')` on detection. Pattern: same as `validateWorkflowDag()` in `apps/runtime/src/routes/workflow-helpers.ts`.

1.5 **`canvas-to-steps.ts`** — attach `requiredPredecessors` at the step attachment point after `convertNodeToStep` (around line 231):

```typescript
if (Array.isArray(node.config?.requiredPredecessors)) {
  step.requiredPredecessors = node.config.requiredPredecessors as string[];
}
step.canvasRouted = true;
```

1.6 **`canvas-to-steps.ts`** — update `EMPTY_RESULT` to include `inDegreeMap: {}` (required since `inDegreeMap` is now non-optional on `CanvasConversionResult`). This preserves backward compat for callers that get an empty result (no canvas, null doc).

1.7 **`canvas-to-steps.ts`** — update the return statement (line ~369): `return { steps: orderedSteps, nameToIdMap, outputMappings, startInputVariables, inDegreeMap };`

1.8 Write unit tests in `apps/workflow-engine/src/__tests__/canvas-to-steps-dag.test.ts`:

- INT-1: `inDegreeMap` for diamond topology (`inDegreeMap[join.id] === 2`)
- INT-2: Cycle detection throws with "cycle" in message for a back-edge
- Linear topology: all in-degrees ≤ 1, no error
- `EMPTY_RESULT` backward compat: `inDegreeMap` is `{}`
- `requiredPredecessors` attached from node config

**Files Touched**:

- `apps/workflow-engine/src/handlers/step-dispatcher.ts`
- `apps/workflow-engine/src/handlers/canvas-to-steps.ts`
- `apps/workflow-engine/src/__tests__/canvas-to-steps-dag.test.ts` (NEW)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/workflow-engine` passes with 0 TypeScript errors
- [ ] All 5 unit test scenarios in `canvas-to-steps-dag.test.ts` pass
- [ ] Diamond topology: `inDegreeMap[join.id] === 2`, others ≤ 1
- [ ] Cycle detection throws "cycle"
- [ ] `EMPTY_RESULT.inDegreeMap === {}`

**Rollback**: Revert Phase 1 commit. `WorkflowExecutionInput.inDegreeMap` is optional — absent = sequential fallback.

---

### Phase 2: Create `dag-executor.ts`

**Goal**: Implement the DAG traversal engine. The executor is intentionally routing-agnostic — it only manages barrier counting, skip propagation, and parallel dispatch.

**Tasks**:

2.1 Create `apps/workflow-engine/src/executors/dag-executor.ts`. Add logger: `const log = createLogger('workflow-engine:dag-executor')`.

2.2 Define the `StepOutcome` type and `DagExecutorParams` interface as shown in Section 1 Key Interfaces.

2.3 Implement `executeDag(params: DagExecutorParams): Promise<void>`:

**Step A — compute effective in-degree map**: If `params.inDegreeMap` is empty (`Object.keys(inDegreeMap).length === 0`), compute on-the-fly from `stepIndex`. CRITICAL: must use `getAllSuccessorIds(step)` (not `step.onSuccessSteps`) to count condition step branches:

```typescript
const effectiveInDegreeMap: Record<string, number> = { ...inDegreeMap };
if (Object.keys(effectiveInDegreeMap).length === 0) {
  for (const [, step] of stepIndex) {
    if (!(step.id in effectiveInDegreeMap)) effectiveInDegreeMap[step.id] = 0;
    for (const sucId of getAllSuccessorIds(step)) {
      effectiveInDegreeMap[sucId] = (effectiveInDegreeMap[sucId] ?? 0) + 1;
    }
  }
}
```

This ensures sequential workflows (where `inDegreeMap` was absent or `{}`) execute in the correct sequential order.

**Step B — initialize**: `terminalCount = new Map<string, number>()` (bounded by `MAX_WORKFLOW_STEPS ≤ 50` entries; lives only for this `executeDag()` call; GC'd on return — no TTL/eviction needed). Log fan-out start.

**Step C — `notifyTerminal(stepId, activatedSuccessors)`** (internal function):

CRITICAL: must use `getAllSuccessorIds(step)` (not `step.onSuccessSteps`) to get ALL possible successors, including condition branch targets.

```
function notifyTerminal(stepId, activatedSuccessors):
  if settled.has(stepId): return  // idempotent guard
  settled.add(stepId)
  log.info('dag-executor: step terminal', { stepId, activatedSuccessors })

  const step = stepIndex.get(stepId)
  const allSuccessors = step ? getAllSuccessorIds(step) : []

  // Skip-propagate unchosen successors (condition branches not taken, onSuccess not taken)
  const skippedSuccessors = allSuccessors.filter(id => !activatedSuccessors.includes(id))
  for (const skippedId of skippedSuccessors):
    skipPropagate(skippedId)

  // Increment barrier counter for activated successors
  for (const sucId of activatedSuccessors):
    incrementBarrier(sucId)
```

**Step D — `skipPropagate(stepId)` and `incrementBarrier(sucId)`** (internal functions):

CRITICAL: `skipPropagate` must use `getAllSuccessorIds(step)` to propagate to condition branch targets.

```
function skipPropagate(stepId):
  if settled.has(stepId): return  // prevent double-counting
  settled.add(stepId)
  log.info('dag-executor: skip propagating', { stepId })
  // Mark in ctx.steps as skipped (so {{steps.X.output.*}} resolves absent gracefully)
  // ctx.steps is keyed by step.name ?? step.id — must use the canonical key
  const skippedStep = stepIndex.get(stepId)
  const stepKey = skippedStep?.name ?? stepId
  ctx.steps[stepKey] = { status: 'skipped' }

  const step = stepIndex.get(stepId)
  const allSuccessors = step ? getAllSuccessorIds(step) : []
  for (const sucId of allSuccessors):
    incrementBarrier(sucId)

function incrementBarrier(sucId):
  const count = (terminalCount.get(sucId) ?? 0) + 1
  terminalCount.set(sucId, count)
  if count === (effectiveInDegreeMap[sucId] ?? 1):
    evaluateAndDispatch(sucId)
```

**Step E — `evaluateAndDispatch(stepId)`**:

CRITICAL: `requiredPredecessors` stores node IDs, but `ctx.steps` is keyed by `step.name ?? step.id`. Must look up the canonical key via `stepIndex`:

```
function evaluateAndDispatch(stepId):
  const step = stepIndex.get(stepId)
  if (!step): return  // unknown step → branch terminates naturally

  // Selective barrier evaluation
  const requiredPreds = step.requiredPredecessors ?? []
  for (const predId of requiredPreds):
    const predStep = stepIndex.get(predId)
    const predKey = predStep?.name ?? predId      // match ctx.steps key convention
    if (ctx.steps[predKey]?.status === 'skipped'):
      // Required predecessor was skipped → fail this join node
      log.warn('dag-executor: required predecessor skipped', { stepId, predId })
      dispatchedPromises.push(Promise.reject(
        new WorkflowStepError(StepErrorCode.STEP_FAILED, 'REQUIRED_PREDECESSOR_SKIPPED')
      ))
      return

  // Fan-out cap check (from this step's outgoing edges)
  const allSuccessors = getAllSuccessorIds(step)
  if (allSuccessors.length > MAX_PARALLEL_BRANCHES):
    dispatchedPromises.push(Promise.reject(
      new WorkflowStepError(StepErrorCode.STEP_FAILED, 'MAX_FAN_OUT_EXCEEDED')
    ))
    return

  log.info('dag-executor: dispatching', { stepId })
  // Dispatch using the recursive async fan-out model (see Step F)
  dispatchedPromises.push(dispatchAndAwait(stepId))
```

**Step F — recursive async fan-out via `dispatchAndAwait`**:

Use recursive async fan-out. Each `dispatchAndAwait(stepId)` returns a `Promise<void>` that resolves when that step AND all its transitively reachable downstream work completes. This avoids dynamic `Promise.all` accumulation issues.

```
async function dispatchAndAwait(stepId: string): Promise<void>:
  const step = stepIndex.get(stepId)!

  const outcome = await executeStep(step)

  switch (outcome.status):
    case 'completed':
      notifyTerminal(stepId, outcome.activatedSuccessors)
      // notifyTerminal increments barriers for activated successors and skip-propagates others.
      // When a successor's barrier is fully satisfied, evaluateAndDispatch() is called,
      // which pushes into dispatchedPromises. Drain those after returning.
      break
    case 'terminal_no_successors':
      settled.add(stepId)  // natural branch end
      break
    case 'failed':
      throw new WorkflowStepError(StepErrorCode.STEP_FAILED, 'Step failed with no failure routing')
    case 'workflow_terminated':
      // Rejection/termination path — bubble up to executeDag caller
      terminationResult = outcome.result
      throw new WorkflowTerminatedSignal()  // caught at top level to return early
```

Entry point:

```typescript
const dispatchedPromises: Promise<void>[] = [];
// Evaluate and dispatch root nodes
for (const rootId of params.rootStepIds) {
  evaluateAndDispatch(rootId);
}
// Wait for all dispatched work. Note: evaluateAndDispatch() and notifyTerminal() push
// into dispatchedPromises synchronously within the same microtask tick before barriers
// fire. Drain with Promise.all; each step's dispatchAndAwait handles its own successors.
await Promise.all(dispatchedPromises);
```

Note on parallel branch failure: when one `dispatchAndAwait` throws, `Promise.all` rejects fast. Other in-flight `executeStep` calls continue until they naturally complete (their `ctx.steps` writes are idempotent). Document this behavior in `dag-executor.ts` comments.

2.4 Write comprehensive unit tests in `dag-executor.test.ts`:

- INT-3: barrier waits for N predecessors (mock executeStep with configurable delay)
- INT-4: fail-fast — branch A rejects, join never starts
- INT-5: fan-out cap — `onSuccessSteps.length > MAX_PARALLEL_BRANCHES` throws
- INT-6: skip propagation — NodeB skipped, join receives both, starts
- INT-7: selective barrier, optional predecessor skipped → join starts
- INT-8: selective barrier, required predecessor skipped → join fails with `REQUIRED_PREDECESSOR_SKIPPED`
- Linear (1-to-1) with empty inDegreeMap: sequential execution

**Files Touched**:

- `apps/workflow-engine/src/executors/dag-executor.ts` (NEW)
- `apps/workflow-engine/src/__tests__/dag-executor.test.ts` (NEW)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/workflow-engine` passes with 0 TypeScript errors
- [ ] All 7 INT scenarios pass
- [ ] Fan-out cap throws `MAX_FAN_OUT_EXCEEDED`
- [ ] INT-7 (optional skipped) → join dispatched
- [ ] INT-8 (required skipped) → join fails with `REQUIRED_PREDECESSOR_SKIPPED`
- [ ] Sequential fallback test: with empty inDegreeMap, linear A→B→C executes in order

**Rollback**: Delete `dag-executor.ts` commit. Not yet integrated into handler — zero production impact.

---

### Phase 3a: Extract Suspension Helpers (Refactor)

**Goal**: Extract ALL routing logic + suspension handling from the main queue loop into `executeStepWithSuspension()`. Zero behavior change — pure refactoring. Commit type: `refactor()`.

**`executeStepWithSuspension` contract**:

```typescript
async function executeStepWithSuspension(
  step: WorkflowStep,
  ctx: WorkflowContextData,
  executionDeps: WorkflowHandlerDeps,
  executionId: string,
  restateCtx?: RestateWorkflowCtx,
): Promise<StepOutcome>;
```

It handles (in order):

1. **Step execution**: calls `executeWorkflowStep(step, ctx, executionDeps, executionId, restateCtx)`
2. **Failure routing**: if execution throws and `step.onFailureSteps` is non-empty, routes to the failure path. Returns `{ status: 'completed', activatedSuccessors: step.onFailureSteps }` (failure path counts as terminal, satisfies barrier).
3. **Unrouted failure**: if execution throws with no failure routing, returns `{ status: 'failed' }` (propagates through `Promise.all`).
4. **Reject routing**: if `result.rejection` is set (approval/human_task nodes), routes to `step.onRejectSteps ?? step.onFailureSteps`. Returns `{ status: 'completed', activatedSuccessors: rejectPath }`.
5. **Condition routing**: if `result.nextSteps` is set (condition step), returns `{ status: 'completed', activatedSuccessors: result.nextSteps }`. The DAG executor then skip-propagates `getAllSuccessorIds(step).filter(id => !result.nextSteps.includes(id))` via `notifyTerminal` — covering branches in `thenSteps`/`elseSteps`/`conditions[].targetSteps` that were NOT taken.
6. **Loop iteration**: if `result.loopIteration` is set, calls `executeStepChain(body)` for each item (using the existing `executeStepChain` closure in `runWorkflow`). After all iterations complete, calls `markStepCompleted`. Returns `{ status: 'completed', activatedSuccessors: step.onSuccessSteps ?? [] }`.
7. **Canvas-routed leaf guards** — there are TWO separate guards at different lines in the queue loop, both must be preserved in `executeStepWithSuspension`:
   - **Guard A** (~line 1118, condition step): After condition routing resolves, if the chosen `result.nextSteps` is empty AND `step.canvasRouted === true`, throw `WorkflowStepError(STEP_FAILED, "Condition node has no outgoing path for this branch")`. This fires when a condition node's taken branch has no outgoing edge on canvas.
   - **Guard B** (~line 1132, non-condition step): For non-condition, non-loop steps where `step.canvasRouted === true` and `(step.onSuccessSteps?.length ?? 0) === 0`, throw `WorkflowStepError(STEP_FAILED, "Node has no outgoing path defined")`. This fires when an HTTP/approval/etc. node has no `on_success` edge drawn.
8. **Suspension handling** (delay, approval, human_task, async_webhook): inline code at lines 1140–1839. All suspension states are managed inside this helper. Cancellation check included.
9. **Success routing**: returns `{ status: 'completed', activatedSuccessors: step.onSuccessSteps ?? [] }`. If `onSuccessSteps` is undefined (non-canvas step), returns `{ status: 'terminal_no_successors' }`.

**Note**: `executeStepChain` is NOT modified or replaced. It remains as the sequential executor for loop bodies and explicit parallel step branches. It is called by `executeStepWithSuspension` for `loopIteration` results.

**Tasks**:

3a.1 Define `executeStepWithSuspension` function body inside `runWorkflow` closure (it needs access to `executionDeps`, `stepIndex`, `ctx` — all available via closure).

3a.2 Translate the `while (queue)` loop's inline code into the helper:

- Lines 1052–1092 (execution + failure routing) → items 1-3 above
- Lines 1095–1105 (loop iteration) → item 6 above
- Lines 1108–1138 (condition routing, success routing, both canvas-routed guards) → items 5, 7A, 7B, 9 above
- Lines 1140–1839 (suspension handling) → item 8 above
- All `continue` statements become early returns

3a.3 Replace the inline code in the main queue loop with a call to `executeStepWithSuspension`. The loop's outer logic (queue management) stays intact. Verify the loop body shrinks to ~50 lines.

3a.4 Run full regression: `pnpm build --filter=@abl/workflow-engine && pnpm test --filter=@abl/workflow-engine`. All existing tests must pass. **Do not proceed to Phase 3b if any test fails.**

**Files Touched**:

- `apps/workflow-engine/src/handlers/workflow-handler.ts` (only)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/workflow-engine` passes with 0 TypeScript errors
- [ ] All existing `workflow-engine` tests pass (zero regressions)
- [ ] The main queue loop body is ≤80 lines after extraction
- [ ] Commit type is `refactor(workflow-engine)` — zero behavior change

**Rollback**: Revert Phase 3a commit. Restores inline code with no behavior change.

---

### Phase 3b: Integrate DAG Executor into `workflow-handler.ts`

**Goal**: Replace the main sequential `while (queue.length > 0)` loop with `executeDag()`. The End phase and surrounding `runWorkflow` structure stay unchanged.

**Tasks**:

3b.1 Add `inDegreeMap?: Record<string, number>` to `WorkflowExecutionInput` interface (line ~62).

3b.2 After `buildStepIndex` call (line ~763), compute `effectiveInDegreeMap` and `rootStepIds`:

```typescript
// Use pre-computed inDegreeMap or derive from step graph for backward compat.
// When inDegreeMap is absent/empty, the DAG executor computes it internally
// (see dag-executor.ts), ensuring sequential workflows execute correctly.
const effectiveInDegreeMap = input.inDegreeMap ?? {};

// Root steps: those with in-degree 0 in the effective map.
// When effectiveInDegreeMap is empty, the DAG executor's internal fallback handles this.
const rootStepIds: string[] = [];
if (Object.keys(effectiveInDegreeMap).length > 0) {
  for (const step of input.steps) {
    if ((effectiveInDegreeMap[step.id] ?? 0) === 0 && stepIndex.has(step.id)) {
      rootStepIds.push(step.id);
    }
  }
} else {
  // Sequential fallback: first step only (DAG executor handles the rest)
  const first = input.steps.find((s) => stepIndex.has(s.id));
  if (first) rootStepIds.push(first.id);
}
```

3b.3 Replace the `while (queue.length > 0)` block (lines 1031–~1849) with:

```typescript
await executeDag({
  stepIndex,
  inDegreeMap: effectiveInDegreeMap,
  rootStepIds,
  executeStep: (step) =>
    executeStepWithSuspension(step, ctx, executionDeps, executionId, restateCtx),
  ctx,
});
```

3b.4 Preserve the End phase (lines ~1851–2120) — it runs after `executeDag()` resolves.

3b.5 Preserve `executeStepChain` — it is NOT modified. It is called by `executeStepWithSuspension` for `loopIteration` results only.

3b.6 Add import: `import { executeDag } from '../executors/dag-executor.js';`

3b.7 Write system tests in `system-parallel-graph.test.ts` (naming per `agents.md`: `system-*` prefix = real MongoDB; real server, HTTP API only):

- E2E-1: Diamond pattern — all nodes complete, NodeA/NodeB timestamps overlap
- E2E-2: Linear backward compat — sequential, no regression
- E2E-3: Fail-fast — NodeB fails → Join never starts → execution `failed`
- E2E-4: Delay on branch — Join starts after delay resolves
- E2E-5: Context at join — both branch outputs accessible

**Files Touched**:

- `apps/workflow-engine/src/handlers/workflow-handler.ts`
- `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts` (NEW)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/workflow-engine` passes with 0 TypeScript errors
- [ ] All existing workflow-engine tests pass (zero regressions)
- [ ] E2E-1: Diamond execution `completed`, NodeA/NodeB `startedAt` within 500ms
- [ ] E2E-2: Linear workflow behavior identical
- [ ] E2E-3: Execution `failed`, Join node `pending` or `skipped`
- [ ] E2E-4: Total time ≥ delay duration
- [ ] E2E-5: Both `{{steps.NodeA.output.*}}` and `{{steps.NodeB.output.*}}` in context

**Rollback**: Revert Phase 3b. `inDegreeMap` is optional — existing callers fall back to sequential. Phase 3a's extraction must also be reverted to restore the inline queue loop.

---

### Phase 4: Thread `inDegreeMap` Through All Fire Paths

**Goal**: Propagate `inDegreeMap` from `CanvasConversionResult` through all 14 call sites so triggered executions also use the DAG executor.

**Tasks**:

4.1 **`version-resolution.ts`**: Add `inDegreeMap: Record<string, number>` to `ResolvedWorkflowDefinition` (after `startInputVariables`). In all 6 return statements, add `inDegreeMap: conversion.inDegreeMap`. **Exception**: Tier 5 working-copy-steps (line ~270) uses `workflow.steps` directly and not the canvas conversion's steps — use `inDegreeMap: {}` intentionally (legacy pre-canvas workflows have no fan-out; do NOT use `canvasConversion.inDegreeMap` here since it's derived from canvas nodes that may not match `workflow.steps`).

4.2 **`execution-payload.ts`**: Add `inDegreeMap?: Record<string, number>` to `BuildExecutionPayloadInput` and `WorkflowExecutionPayload`. In `buildWorkflowExecutionPayload`, add: `payload.inDegreeMap = input.inDegreeMap ?? {};` — always include with `{}` default, consistent with the `nameToIdMap`/`startInputVariables` collection-default pattern.

4.3 **`workflow-executions.ts`** — thread through the `ExecutionDefinition` intermediate type:

- Step 1: Add `inDegreeMap?: Record<string, number>` to the `ExecutionDefinition` type at line ~161.
- Step 2: Update `buildWorkingCopyExecutionDefinition()` (~line 185) — it has 3 return paths (draft doc via `convertVersionDocToSteps`, `workflow.steps` fallback via `convertWorkflowDocToSteps`, canvas fallback). Add `inDegreeMap: conversion.inDegreeMap` to each path that calls a conversion function; use `inDegreeMap: {}` for the raw-steps path.
- Step 3: Update `buildVersionExecutionDefinition()` (~line 230) — 1 return path. Add `inDegreeMap: conversion.inDegreeMap`.
- Step 4: Update `buildDefaultVersionExecutionDefinition()` (~line 278) — 1 return path. Add `inDegreeMap: conversion.inDegreeMap`.
- Step 5: Pass `inDegreeMap: executionDefinition.inDegreeMap` to the single `buildWorkflowExecutionPayload` call at line ~672.

  4.4 **`trigger-engine.ts`**: Add `inDegreeMap: resolved.inDegreeMap` at the `buildWorkflowExecutionPayload` call (~line 555).

  4.5 **`trigger-scheduler.ts`**: Add `inDegreeMap: resolved.inDegreeMap` at the `buildWorkflowExecutionPayload` call (~line 293).

  4.6 After each file: run `pnpm build --filter=@abl/workflow-engine` — fix type errors immediately (per CLAUDE.md PostToolUse typecheck hook).

**Files Touched**:

- `apps/workflow-engine/src/lib/version-resolution.ts`
- `apps/workflow-engine/src/lib/execution-payload.ts`
- `apps/workflow-engine/src/routes/workflow-executions.ts`
- `apps/workflow-engine/src/services/trigger-engine.ts`
- `apps/workflow-engine/src/services/trigger-scheduler.ts`

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/workflow-engine` passes with 0 errors after each file change
- [ ] All existing trigger-engine and trigger-scheduler tests pass
- [ ] `ResolvedWorkflowDefinition.inDegreeMap` is always present (all 6 tiers)
- [ ] `WorkflowExecutionPayload.inDegreeMap` is always present (with `{}` default)
- [ ] E2E-1 (diamond) still passes end-to-end after threading

**Rollback**: The `inDegreeMap` field is optional on `WorkflowExecutionInput`. Reverting this phase means trigger fire paths don't send `inDegreeMap` — those executions fall back to sequential. Phase 3b Studio execute path still sends it.

---

### Phase 5: Studio Canvas Changes

**Goal**: Relax the fan-out guard, enforce the fan-out cap, verify `computeExecutionEdges` works for fan-out, and implement `MergerNodeConfig.tsx`.

**Tasks**:

5.1 **`workflow-canvas-store.ts`** — relax fan-out guard (lines 316–319):

Change from:

```typescript
const alreadyConnected = state.edges.some(
  (e) => e.source === connection.source && e.sourceHandle === connection.sourceHandle,
);
```

To:

```typescript
const alreadyConnected = state.edges.some(
  (e) =>
    e.source === connection.source &&
    e.sourceHandle === connection.sourceHandle &&
    e.target === connection.target,
);
```

This allows multiple outgoing edges from the same handle to different targets, while still preventing exact duplicates.

5.2 **`workflow-canvas-store.ts`** — add fan-out cap after `alreadyConnected` check:

```typescript
const fanOutCount = state.edges.filter(
  (e) => e.source === connection.source && e.sourceHandle === connection.sourceHandle,
).length;
if (fanOutCount >= MAX_FAN_OUT) {
  // Note: MAX_PARALLEL_BRANCHES is in apps/workflow-engine/src/constants.ts.
  // Studio cannot import from that package directly. Define locally:
  // /** Keep in sync with @abl/workflow-engine/constants MAX_PARALLEL_BRANCHES */
  // const MAX_FAN_OUT = 10;
  // Use the same throttled toast approach as WorkflowCanvas.tsx isValidConnection.
  return state; // Toast fired from caller if needed
}
```

Define `const MAX_FAN_OUT = 10` at the top of the store file with a comment linking to the engine constant.

5.3 **`computeExecutionEdges.ts`** — verify fan-out classification: The existing `classifyOutgoingEdges` function (lines ~148–173) already iterates ALL edges matching `sourceHandle` via a `for` loop. No code change needed. Write unit test UT-5 to confirm 3 outgoing `on_success` edges of a completed node are all classified as `traversed`.

5.4 **`MergerNodeConfig.tsx`** — create new config panel component at `apps/studio/src/components/workflows/canvas/config/MergerNodeConfig.tsx`:

Props: `{ nodeId: string, config: Record<string, unknown>, onUpdate: (config: Record<string, unknown>) => void }` — matches standard `NodeConfigProps` pattern.

Internally subscribes to store: `const edges = useWorkflowCanvasStore((s) => s.edges); const nodes = useWorkflowCanvasStore((s) => s.nodes)`. Computes:

```typescript
const predecessorNodes = edges
  .filter((e) => e.target === nodeId && e.sourceHandle === 'on_success')
  .map((e) => ({
    id: e.source,
    label: nodes.find((n) => n.id === e.source)?.data?.label ?? e.source,
  }));
```

Renders a labeled checklist section "Required predecessors" with one checkbox per predecessor. Default: all unchecked. On toggle: update `config.requiredPredecessors` (add/remove node ID). Use `data-testid="merger-predecessor-{nodeId}"` on each checkbox. Handles edge removal from canvas gracefully (predecessor disappears from list; dropped from `requiredPredecessors` if present).

5.5 **`panels/ConfigPanel.tsx`** — wire in `MergerNodeConfig`:
Read the actual `panels/ConfigPanel.tsx` file first (at `apps/studio/src/components/workflows/canvas/panels/ConfigPanel.tsx`). Subscribe to `edges` and `nodes` (or confirm they are already subscribed). After the existing `renderConfig(...)` call, add a conditional section:

```typescript
const incomingOnSuccessEdges = edges.filter(
  e => e.target === selectedNodeId && e.sourceHandle === 'on_success'
);
if (incomingOnSuccessEdges.length >= 2) {
  // Render MergerNodeConfig as additional section below main config
  <MergerNodeConfig nodeId={selectedNodeId} config={selectedNode.config} onUpdate={handleConfigUpdate} />
}
```

5.6 Write unit tests in `apps/studio/src/__tests__/canvas-fanout.test.ts`:

- UT-1: Fan-out allowed (second edge from same handle to different target accepted)
- UT-2: Duplicate rejected (`source+sourceHandle+target` already exists)
- UT-3: Cap enforced (11th edge rejected)
- UT-4: Cycle blocked (back-edge returns state unchanged)
- UT-5: `computeExecutionEdges` — all 3 `on_success` edges of completed node classified `traversed`
- UT-6: `MergerNodeConfig` renders correct predecessor names (2 checkboxes, both unchecked)
- UT-7: Toggle updates `requiredPredecessors`; removing edge drops predecessor

**Files Touched**:

- `apps/studio/src/store/workflow-canvas-store.ts`
- `apps/studio/src/components/workflows/canvas/config/MergerNodeConfig.tsx` (NEW)
- `apps/studio/src/components/workflows/canvas/panels/ConfigPanel.tsx`
- `apps/studio/src/__tests__/canvas-fanout.test.ts` (NEW)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/studio` passes with 0 TypeScript errors
- [ ] UT-1 through UT-7 all pass
- [ ] Fan-out guard allows 2nd edge from same handle to different target
- [ ] Duplicate edge rejected
- [ ] 11th edge rejected
- [ ] `MergerNodeConfig` renders with correct predecessor names, all unchecked by default
- [ ] Toggle updates `config.requiredPredecessors` correctly

**Rollback**: Revert Phase 5 commit. Studio reverts to blocking all fan-out; no engine changes affected.

---

### Phase 6: Selective Barrier E2E + Documentation

**Goal**: Add integration test coverage for selective barrier scenarios and update documentation.

**Tasks**:

6.1 Add to `system-parallel-graph.test.ts` (depends on Phase 3b creating the file):

- E2E-6: Cancellation during parallel execution — Branch B in `waiting_delay`; cancel; execution `cancelled`, Join never starts
- E2E-7: Conditional skip — Gateway-failure topology (Gateway returns 500 → NodeB skipped); `requiredPredecessors: []` (all optional); execution `completed`
- E2E-8: Optional predecessor skipped — `requiredPredecessors: [NodeA.id]` (NodeB optional); NodeB skipped; Join starts; execution `completed`
- E2E-9: Required predecessor skipped — `requiredPredecessors: [NodeA.id, NodeB.id]`; NodeB skipped; Join fails with `REQUIRED_PREDECESSOR_SKIPPED`; execution `failed`
- E2E-10: Loop node on parallel branch — Loop body executes sequentially within branch; Join waits for loop completion (validates Open Question 3)

  6.2 Update `docs/features/sub-features/workflow-parallel-graph-execution.md`:

- Set all FR statuses to IMPLEMENTED
- Close GAP-01, GAP-02, GAP-03, GAP-04 in Section 16
- Update feature status to ALPHA

  6.3 Update `apps/workflow-engine/agents.md` with learnings:

- `executeDag()` callback contract (StepOutcome type, activatedSuccessors semantics)
- `CanvasRoutingMeta.requiredPredecessors` pattern
- `executeStepWithSuspension` extraction approach (how routing maps to StepOutcome)
- Restate `Promise.all(ctx.run())` behavior findings (document if validated in E2E-1)

**Exit Criteria**:

- [ ] E2E-6 through E2E-10 all pass
- [ ] Feature spec status updated to ALPHA
- [ ] Testing matrix updated with actual coverage
- [ ] `agents.md` updated

**Rollback**: N/A — documentation and additional tests are non-breaking.

---

## 4. Wiring Checklist

- [ ] `dag-executor.ts` imported in `workflow-handler.ts`: `import { executeDag } from '../executors/dag-executor.js'`
- [ ] `CanvasConversionResult.inDegreeMap` exported and consumed by all callers (version-resolution.ts 6 tiers, workflow-executions.ts 3 helpers)
- [ ] `EMPTY_RESULT.inDegreeMap = {}` — ensures callers on empty canvas don't get undefined
- [ ] `ResolvedWorkflowDefinition.inDegreeMap` propagated through `buildWorkflowExecutionPayload` via `BuildExecutionPayloadInput`
- [ ] `WorkflowExecutionPayload.inDegreeMap` always present (with `{}` default via `?? {}`)
- [ ] `WorkflowExecutionInput.inDegreeMap` passed to `executeDag()` in `runWorkflow`
- [ ] `CanvasRoutingMeta.requiredPredecessors` attached by `convertCanvasToStepsInternal` from `node.config.requiredPredecessors`
- [ ] `requiredPredecessors` read by `dag-executor.ts` `evaluateAndDispatch()` via `step.requiredPredecessors` (not `step.config.requiredPredecessors`)
- [ ] All 6 tiers in `version-resolution.ts` return `inDegreeMap` (Tier 5 working-copy-steps returns `{}` intentionally)
- [ ] `ExecutionDefinition` type in `workflow-executions.ts` has `inDegreeMap?`
- [ ] All 3 private resolution helpers in `workflow-executions.ts` set `inDegreeMap` on their return objects (5 return paths total + 1 `buildWorkflowExecutionPayload` call)
- [ ] `trigger-engine.ts` (~line 555) passes `inDegreeMap: resolved.inDegreeMap`
- [ ] `trigger-scheduler.ts` (~line 293) passes `inDegreeMap: resolved.inDegreeMap`
- [ ] `MergerNodeConfig.tsx` rendered in `panels/ConfigPanel.tsx` when `incomingOnSuccessEdges.length >= 2`
- [ ] `onConnect` guard changed from `source+sourceHandle` to `source+sourceHandle+target` duplicate check
- [ ] Fan-out cap `MAX_FAN_OUT = 10` defined in Studio store with comment linking to engine constant
- [ ] `executeStepChain` NOT modified — remains as sequential executor for loop bodies
- [ ] `createLogger('workflow-engine:dag-executor')` used in `dag-executor.ts` for fan-out start, barrier satisfied, skip propagation events

---

## 5. Cross-Phase Concerns

### Database Migrations

None. `node.config.requiredPredecessors` is an optional field on existing workflow node documents. Absent = all optional.

### Feature Flags

None. `inDegreeMap?: Record<string, number>` is the natural rollout flag. Absent/empty → sequential fallback. Callers updated incrementally.

### Configuration Changes

None new. `MAX_PARALLEL_BRANCHES = 10` already in `apps/workflow-engine/src/constants.ts`. Studio uses a local copy `MAX_FAN_OUT = 10` with a comment.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All phases complete with their exit criteria met
- [ ] E2E-1 through E2E-10 passing (real server, real MongoDB, HTTP API only, no vi.mock of internal packages)
- [ ] INT-1 through INT-8 passing
- [ ] UT-1 through UT-7 passing
- [ ] `pnpm build && pnpm test --filter=@abl/workflow-engine --filter=@abl/studio --filter=@abl/runtime` all pass
- [ ] FR-1 through FR-17 all IMPLEMENTED
- [ ] Feature spec status updated to ALPHA
- [ ] Testing matrix updated

---

## 7. Open Questions

1. **`MAX_PARALLEL_BRANCHES` in Studio**: Studio cannot import from `@abl/workflow-engine`. Using a local `const MAX_FAN_OUT = 10` with a comment `/* Keep in sync with @abl/workflow-engine/constants MAX_PARALLEL_BRANCHES */`. If the constant is later added to `packages/shared-kernel`, the local copy can be removed.

2. **Restate `Promise.all(ctx.run())` replay behavior**: Must be validated in E2E-1 before Phase 3b proceeds to full implementation. If `Promise.all` of `ctx.run()` calls doesn't replay correctly in Restate v1.10.4, `ctx.promise()` anchors may be needed. Document findings in `agents.md` (Phase 6 task 6.3).

3. **`loop` node on parallel branches**: When a loop node sits on a parallel branch, its body steps run via `executeStepChain` (sequential within the branch). This is correct behavior. Validated by E2E-10 in Phase 6.

4. **`Promise.all` dynamic accumulation**: The DAG executor dispatches steps dynamically as barriers satisfy. A static `Promise.all(array)` won't track newly-added promises. Implementation must use a recursive async fan-out or a promise-draining loop. Document the chosen approach in `dag-executor.ts`.

5. **Parallel branch failure and in-flight branches**: When one branch fails (no failure routing), `Promise.all` rejects via fail-fast. Other in-flight `executeStep` calls continue until they naturally complete — they're not cancelled. This is acceptable: their `ctx.steps` writes are idempotent and the workflow failure is recorded after all outstanding steps settle. Specify this behavior explicitly in `dag-executor.ts` comments.
