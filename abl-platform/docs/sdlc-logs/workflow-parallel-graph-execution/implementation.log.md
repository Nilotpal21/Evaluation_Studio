# SDLC Log: Workflow Parallel Graph Execution — Implementation Phase

**Feature**: workflow-parallel-graph-execution
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-28-workflow-parallel-graph-execution-impl-plan.md`
**Date Started**: 2026-04-28
**Date Completed**: 2026-05-06

---

## Preflight

- [x] LLD file paths verified — all 10 modified files and 6 new files confirmed at exact paths
- [x] Function signatures current — CanvasConversionResult, CanvasRoutingMeta, WorkflowExecutionInput, ResolvedWorkflowDefinition all match LLD descriptions
- [x] No conflicting recent changes — working tree clean except .gitignore, ecosystem.config.js, next-env.d.ts (unrelated)
- Discrepancies: `canvasRouted: true` already set on condition steps inside `convertNodeToStep` (line 566); LLD task 1.5 sets it again in `convertCanvasToStepsInternal` — idempotent, no conflict. `executors/` directory already exists with other executors.

---

## Phase Execution

### Pre-Phase: Commit Staged Cycle-Detection Files

- **Status**: DONE (bundled with LLD commit a67a3860f — deviated from 2-commit split but all files committed)
- **Commit**: a67a3860f
- **Exit Criteria**: build check pending Phase 1 exit
- **Deviations**: Staged cycle-detection files committed together with LLD docs instead of as separate pre-phase commits. Code content is correct.

### LLD Phase 1: Extend canvas-to-steps.ts + step-dispatcher.ts

- **Status**: DONE
- **Commit**: a6de9995d (`[ABLP-155] feat(workflow-engine): parallel graph execution, loop executor, and DAG runner`)
- **Exit Criteria**: MET — `inDegreeMap` computed for all topologies; `requiredPredecessors` threaded from node config to step; cycle detection via Kahn's algorithm in `convertCanvasToStepsInternal`.
- **Files Changed**: `apps/workflow-engine/src/handlers/canvas-to-steps.ts`

### LLD Phase 2: Create dag-executor.ts

- **Status**: DONE
- **Commit**: a6de9995d
- **Exit Criteria**: MET — `executeDag()`, `signalSkipped()`, `notifyTerminal()`, barrier counting, SimpleMerge nonfatal branch failure, `REQUIRED_PREDECESSOR_NOT_COMPLETED` (enforced in executeStepWithSuspension, not dag-executor), `MAX_FAN_OUT_EXCEEDED` all implemented.
- **Files Changed**: `apps/workflow-engine/src/executors/dag-executor.ts` (new)

### LLD Phase 3a: Extract Suspension Helpers (Refactor)

- **Status**: DONE (bundled into a6de9995d)

### LLD Phase 3b: Integrate DAG Executor into workflow-handler.ts

- **Status**: DONE
- **Commit**: a6de9995d
- **Exit Criteria**: MET — `workflow-handler.ts` calls `executeDag()` when `input.inDegreeMap` is non-empty; sequential fallback preserved.

### LLD Phase 4: Thread inDegreeMap Through All Fire Paths

- **Status**: DONE — `inDegreeMap` threaded through `WorkflowExecutionInput`, all version-resolution tiers, trigger-engine, trigger-scheduler.

### LLD Phase 5: Studio Canvas Changes

- **Status**: DONE
- **Commit**: d212e304d (`[ABLP-155] feat(studio): loop nodes, parallel canvas, and Run/Stop button fixes`)
- **Exit Criteria**: MET — `onConnect` fan-out guard relaxed; `MAX_FAN_OUT = 10` cap enforced; `LoopNodeComponent` added; `MergerNodeConfig` added; loop iteration overlay state added to canvas store; `computeExecutionEdges.ts` updated for parallel edge classification.

### LLD Phase 6: Selective Barrier E2E + Documentation

- **Status**: DONE (integration tests); HTTP-API E2E still needed (GAP-06)
- **Test files**: `system-parallel-graph.test.ts` (11 scenarios), `dag-executor.test.ts` (9 cases), `canvas-to-steps-dag.test.ts` (9 cases), `canvas-fanout.test.tsx` (fan-out guard + MergerNodeConfig + loop overlay)

---

## Wiring Verification

- [x] All wiring checklist items verified (2026-05-06 post-impl-sync)

---

## Review Rounds

| Round | Verdict | Critical | High | Medium | Low |
| ----- | ------- | -------- | ---- | ------ | --- |
| 1     | PASS    | 0        | 0    | 2      | 1   |

---

## Acceptance Criteria

- [x] All LLD phases complete with exit criteria met
- [x] E2E-1 through E2E-10 covered by `system-parallel-graph.test.ts`
- [x] INT-1 through INT-9 passing in `dag-executor.test.ts`
- [x] UT-1 through UT-7 passing (canvas-fanout + canvas-to-steps-dag)
- [x] Feature spec status ALPHA (confirmed 2026-05-06)
- [ ] HTTP-API E2E tests needed for BETA (GAP-06)

---

## Learnings

- **DAG executor isolation pays off**: Extracting `dag-executor.ts` as a pure module made it trivially testable via `system-parallel-graph.test.ts` (in-process, no Restate) — 11 scenarios in one file with zero mocks.
- **`signalSkipped` vs `skipPropagate` distinction**: Non-activated successors from `notifyTerminal` must use `signalSkipped` (deferred decision), not `skipPropagate` (immediate cascade), to correctly handle OR-join semantics where another predecessor may still arrive.
- **Loop node parallel mode added post-spec**: The canvas UI gained `LoopNodeComponent` with parallel/sequential mode toggle and per-batch iteration overlay — not in the original spec. This shipped as part of d212e304d and should be formally specified (tracked as GAP-07).
- **`iterationEdgePathState` in canvas store**: Per-iteration edge path state from the engine (via `computeIterationPathState` in workflow-handler) is piped to the canvas store to enable per-batch edge highlighting during parallel loop execution.
- **`system-parallel-graph.test.ts` vs HTTP E2E**: In-process integration tests are fast and cover the full logic path but don't exercise Restate durable context or real HTTP middleware. GAP-06 tracks adding real HTTP-API E2E tests for BETA promotion.
