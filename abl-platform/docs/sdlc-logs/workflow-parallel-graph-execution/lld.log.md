# SDLC Log: Workflow Parallel Graph Execution — LLD Phase

**Feature**: workflow-parallel-graph-execution
**Phase**: LLD
**LLD**: `docs/plans/2026-04-28-workflow-parallel-graph-execution-impl-plan.md`
**Date Started**: 2026-04-28
**Date Completed**: 2026-04-28

---

## Oracle Decisions (Clarifying Questions)

All 15 questions resolved autonomously — zero escalations to user.

| Q#  | Topic                                     | Classification | Decision Summary                                                                               |
| --- | ----------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| Q1  | Implementation order                      | ANSWERED       | canvas-to-steps → dag-executor → workflow-handler integration → inDegreeMap threading → Studio |
| Q2  | executeDag callback vs restateCtx         | ANSWERED       | Pre-wrapped `executeStep` callback (closes over restateCtx in caller)                          |
| Q3  | inDegreeMap on ResolvedWorkflowDefinition | ANSWERED       | Both ResolvedWorkflowDefinition AND WorkflowExecutionInput gain inDegreeMap                    |
| Q4  | Loop replacement strategy                 | DECIDED        | Incremental: Phase 1 extract suspension helpers (refactor), Phase 2 swap loop                  |
| Q5  | dag-executor.ts location                  | ANSWERED       | `apps/workflow-engine/src/executors/dag-executor.ts`                                           |
| Q6  | WorkflowStep config field                 | INFERRED       | `requiredPredecessors` goes on `CanvasRoutingMeta` (same as onSuccessSteps)                    |
| Q7  | Reuse executeParallel()?                  | DECIDED        | No — different semantics; dag-executor implements its own Promise.all                          |
| Q8  | inDegreeMap on WorkflowExecutionPayload   | ANSWERED       | Yes, add as optional typed field; use conditional assignment like webhookMode                  |
| Q9  | computeExecutionEdges fix scope           | ANSWERED       | Minimal/zero change — existing for-loop already iterates all edges per handle                  |
| Q10 | MergerNodeConfig data access              | INFERRED       | ConfigPanel already subscribes to edges; pass incoming edges + nodes as props                  |
| Q11 | Staged cycle-detection files              | DECIDED        | Commit as separate commit before LLD Phase 1                                                   |
| Q12 | Feature flag needed?                      | ANSWERED       | No — optional inDegreeMap field IS the natural flag                                            |
| Q13 | Biggest risk                              | DECIDED        | Loop replacement (~1090 lines, 4 suspension types); mitigated by D-1 extract-then-swap         |
| Q14 | canvasRouted field shape                  | ANSWERED       | Optional bool on CanvasRoutingMeta; set true for all canvas-routed steps                       |
| Q15 | LLD covers PLANNED parts only             | DECIDED        | Yes — LLD plans only PLANNED work; includes verification for IMPLEMENTED parts                 |

---

## Audit Rounds

### Round 1 — Architecture Compliance

| Finding                                                                                       | Severity | Resolution                                                                         |
| --------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `config/ConfigPanel.tsx` path wrong — actual file is `panels/ConfigPanel.tsx`                 | CRITICAL | Fixed: Phase 5 and module boundaries updated to reference `panels/ConfigPanel.tsx` |
| `ExecutionDefinition` intermediate type not accounted for (3 private helpers, 5 return paths) | CRITICAL | Fixed: Phase 4 task 4.3 now describes all 3 helpers and 5 return paths explicitly  |
| `MergerNodeConfig` props pattern inconsistent with store-subscription pattern                 | HIGH     | Fixed: changed to `useWorkflowCanvasStore` direct subscription (D-10)              |

### Round 2 — Pattern Consistency

| Finding                                                                                                                        | Severity | Resolution                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `StepOutcome` missing rejection/workflow_terminated semantics                                                                  | CRITICAL | Fixed: added `workflow_terminated` variant (D-14); approval/human_task no-reject-path handling specified                            |
| Condition routing skip-propagation not specified for complement branches                                                       | CRITICAL | Fixed: item 5 in executeStepWithSuspension contract now specifies `getAllSuccessorIds(step).filter(!taken)`                         |
| `rootStepIds` sequential fallback broken — dispatching all steps simultaneously with empty inDegreeMap breaks sequential order | HIGH     | Fixed: Phase 3b.2 now has explicit fallback to first-step-only when inDegreeMap is empty; dag-executor internal fallback also added |
| `MergerNodeConfig` uses props instead of store subscription                                                                    | HIGH     | Fixed via D-10                                                                                                                      |

### Round 3 — Completeness

| Finding                                                                                                   | Severity | Resolution                                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `onFailureSteps` routing not in StepOutcome — failure-routed result must count as `completed` for barrier | HIGH     | Fixed: item 2 in executeStepWithSuspension now returns `{ status: 'completed', activatedSuccessors: step.onFailureSteps }` |
| Fan-out cap check misplaced — should be in evaluateAndDispatch, not evaluateAndDispatch entry             | MEDIUM   | Fixed: moved to evaluateAndDispatch step E                                                                                 |
| `EMPTY_RESULT.inDegreeMap` not mentioned in wiring checklist                                              | MEDIUM   | Fixed: added to wiring checklist item 3                                                                                    |

### Round 4 — Cross-Phase Consistency (phase-auditor)

| Finding                                                                                                       | Severity | Resolution                                                                                              |
| ------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| Test file naming convention violation: `e2e-parallel-graph.test.ts` should be `system-parallel-graph.test.ts` | HIGH     | Fixed: all references renamed to `system-parallel-graph.test.ts`                                        |
| FR-13 (fail-fast at barrier) not explicitly covered in Phase 2 test list                                      | MEDIUM   | Fixed: INT-4 in dag-executor.test.ts explicitly covers fail-fast                                        |
| `WorkflowTerminatedSignal` not defined anywhere                                                               | MEDIUM   | Logged as Open Question 2 — implementer should check for existing error type or define minimal sentinel |

### Round 5 — Final Sweep

| Finding                                                                                                                                           | Severity | Resolution                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1: inDegreeMap computation in Phase 1.3 misses condition step edges — used `step.onSuccessSteps ?? []` instead of all-successor traversal       | CRITICAL | Fixed: Phase 1.3 now defines `getAllStepSuccessorIds` helper and uses it; Phase 1.4 cycle detection also uses same helper                         |
| C-2: DAG executor `notifyTerminal`/`skipPropagate`/on-the-fly fallback all used `step.onSuccessSteps ?? []` instead of `getAllSuccessorIds(step)` | CRITICAL | Fixed: all three locations now use `getAllSuccessorIds(step)` with explicit CRITICAL notes                                                        |
| H-1: `ctx.steps` key lookup in `evaluateAndDispatch` used `ctx.steps[pred.name]` — will fail for steps where name differs from id                 | HIGH     | Fixed: Step E now uses `const predStep = stepIndex.get(predId); const predKey = predStep?.name ?? predId; ctx.steps[predKey]?.status`             |
| H-2: Reject routing exits `runWorkflow` directly — `executeStepWithSuspension` cannot `return` from the parent                                    | HIGH     | Fixed: `workflow_terminated` StepOutcome variant (D-14) added; handler signals termination via outcome instead of direct return                   |
| H-3: Canvas-routed guard was described as single guard; actually two separate guards at line 1118 and 1132                                        | HIGH     | Fixed: Phase 3a item 7 now documents Guard A (condition step, empty chosen branch) and Guard B (non-condition step, no onSuccessSteps) separately |
| M-1: `dispatchAndAwait` pattern not committed to — implementation approach left vague                                                             | MEDIUM   | Fixed: Phase 2 Step F now specifies concrete `dispatchAndAwait` recursive fan-out approach with entry point                                       |
| M-2: `skipPropagate` in Step D used `ctx.steps[stepId]` — should use `step.name ?? stepId` key                                                    | MEDIUM   | Fixed: Step D now uses `skippedStep?.name ?? stepId` for ctx.steps key                                                                            |

---

## Commit

`c44ee52ef` baseline. LLD committed with: `[ABLP-155] docs(workflow-engine): add workflow parallel graph execution LLD + implementation plan`
