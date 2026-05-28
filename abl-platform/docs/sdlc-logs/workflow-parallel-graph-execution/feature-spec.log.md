# SDLC Log: Workflow Parallel Graph Execution — Feature Spec Phase

**Date**: 2026-04-23
**Phase**: Feature Spec (Phase 1)
**Author**: Claude Code (claude-sonnet-4-6)

---

## Oracle Decisions (all ANSWERED / INFERRED / DECIDED — zero AMBIGUOUS)

| #   | Question                                                              | Classification | Decision                                                                                           |
| --- | --------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| A1  | Coexist with explicit `parallel` step or replace?                     | DECIDED        | Coexist — different authoring models (step-editor vs canvas). `parallel` step kept.                |
| A2  | Engine-only or also Studio changes?                                   | ANSWERED       | Both. Studio `onConnect` guard at `workflow-canvas-store.ts:260–263` currently blocks fan-out.     |
| A3  | All node types or restricted?                                         | DECIDED        | All node types including suspensions. Restate promises are keyed by unique `step.id`.              |
| A4  | Backward compat contract?                                             | INFERRED       | Zero migration. 1-element `onSuccessSteps` → identical sequential behavior.                        |
| A5  | Cycle detection required?                                             | ANSWERED       | Yes. Runtime iteration cap exists but no design-time detection. Both needed.                       |
| B1  | Branch output context accessibility?                                  | DECIDED        | `ctx.steps` shared map. All predecessor outputs present before barrier node starts.                |
| B2  | Failure semantics at barrier?                                         | DECIDED        | Fail-fast default. Barrier node's own `on_failure` edge provides escape hatch.                     |
| B3  | Max fan-out limit?                                                    | DECIDED        | Reuse `MAX_PARALLEL_BRANCHES = 10` (constants.ts:12).                                              |
| B4  | UI execution monitor concurrency?                                     | DECIDED        | Data correct from day one. Visual lane rendering is Phase 2.                                       |
| B5  | Execution record schema changes?                                      | DECIDED        | None for Phase 1. Overlapping timestamps acceptable.                                               |
| C1  | DAG executor placement?                                               | DECIDED        | New `dag-executor.ts` module in `executors/`. `workflow-handler.ts` is already 1987 lines.         |
| C2  | `canvas-to-steps.ts` graph output vs adjacency from `onSuccessSteps`? | DECIDED        | Add `inDegreeMap` to `CanvasConversionResult`. Use existing `onSuccessSteps` as forward adjacency. |
| C3  | Restate durability for parallel branches?                             | DECIDED        | `Promise.all` of `ctx.run()` within single Restate workflow. No sub-workflows.                     |
| C4  | Barrier join: pre-computed or dynamic?                                | DECIDED        | Pre-computed `inDegreeMap` + in-memory completion counter. Reconstructed on Restate replay.        |
| C5  | `WorkflowExecution` schema changes?                                   | DECIDED        | None. Concurrent writes to distinct `nodeExecutions` subdocuments are MongoDB-safe.                |

## Files Created

- `docs/features/sub-features/workflow-parallel-graph-execution.md`
- `docs/testing/sub-features/workflow-parallel-graph-execution.md`
- `docs/features/sub-features/README.md` (updated)
- `docs/testing/sub-features/README.md` (updated)

## Key Code Evidence

- `apps/studio/src/store/workflow-canvas-store.ts:257–263` — `onConnect` guard (primary UI blocker)
- `apps/workflow-engine/src/handlers/workflow-handler.ts:843–1487` — sequential queue loop to be replaced
- `apps/workflow-engine/src/executors/parallel-executor.ts` — existing `Promise.all` pattern
- `apps/workflow-engine/src/constants.ts:12` — `MAX_PARALLEL_BRANCHES = 10`
- `apps/workflow-engine/src/handlers/canvas-to-steps.ts:86–94` — `CanvasConversionResult` to be extended
- `packages/database/src/models/workflow-execution.model.ts:55–93` — no schema changes needed

## Audit Rounds

- Round 1: PENDING
- Round 2: PENDING
