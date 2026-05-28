# Runtime Test Index

Quick reference: which test files cover which execution paths.
Use this to find relevant tests when a specific runtime behavior breaks.

## Execution Path Index

Phase 3 note: execution, extraction, routing, sessions, and tools-deployment
families now live under their domain directories. Retained support buckets stay
under `e2e/`, `fixtures/`, `helpers/`, `integration/`, and `stress/`, and a few
cross-domain tests still live at the top level.

| File                                                | Execution Paths Covered                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| execution/reasoning-gather-handoff.test.ts          | gather, LLM extraction, handoff context, delegate, data sync, traces                             |
| execution/reasoning-executor-guards.test.ts         | reasoning executor guard rails, safety checks                                                    |
| execution/runtime-executor.test.ts                  | core runtime execution loop, turn processing                                                     |
| execution/runtime-executor-error-paths.test.ts      | executor error handling, recovery paths                                                          |
| execution/runtime-completion.test.ts                | completion detection, session termination                                                        |
| execution/executor-integration.test.ts              | executor integration with services                                                               |
| execution/execution-coordinator.test.ts             | execution orchestration, multi-step flows                                                        |
| execution/execution-events.test.ts                  | execution event emission                                                                         |
| execution/execution-dedup.test.ts                   | duplicate execution prevention                                                                   |
| execution/execution-trace-events.test.ts            | execution trace event emission and structure                                                     |
| execution/execution-model-integration.test.ts       | execution model integration, model selection                                                     |
| multi-agent-orchestration.e2e.test.ts               | absorbed `flow-handoff-threads` coverage: handoff threads, RETURN, PASS fields, target-not-found |
| execution/flow-call-with-as.test.ts                 | flow CALL step with AS alias                                                                     |
| execution/flow-constraint-minicollect.test.ts       | flow constraint mini-collect behavior                                                            |
| execution/flow-correction-chain.test.ts             | flow correction chaining                                                                         |
| execution/flow-detect-intent-constraints.test.ts    | flow intent detection with constraints                                                           |
| execution/flow-execution-coverage.test.ts           | flow execution path coverage                                                                     |
| execution/flow-gather-oninput.test.ts               | flow gather ON_INPUT handling                                                                    |
| execution/flow-intents-digressions.test.ts          | flow intent digressions, interrupts                                                              |
| execution/flow-on-result-branches.test.ts           | flow ON_RESULT branching logic                                                                   |
| execution/flow-on-result.test.ts                    | flow ON_RESULT step handling                                                                     |
| execution/flow-queued-intents.test.ts               | flow queued intent processing                                                                    |
| execution/flow-step-helpers.test.ts                 | flow step helper utilities                                                                       |
| execution/flow-templates-values.test.ts             | flow template value resolution                                                                   |
| execution/flow-transform-pipeline.test.ts           | flow transform pipeline processing                                                               |
| execution/flow-transform.test.ts                    | flow data transforms                                                                             |
| execution/scripted-mode-handoff-fix.unit.test.ts    | scripted mode handoff, mixed mode (supervisor -> scripted child)                                 |
| routing/routing-remote-handoff.test.ts              | remote agent handoff, cross-deployment routing                                                   |
| routing/routing-conditions.test.ts                  | routing condition evaluation                                                                     |
| routing/routing-delegate-failures.test.ts           | delegate routing failure handling                                                                |
| routing/routing-executor-helpers.test.ts            | routing executor helper functions                                                                |
| routing/routing-executor-multi-intent.test.ts       | routing executor multi-intent dispatch                                                           |
| routing/routing-executor-unit.test.ts               | routing executor unit-level logic                                                                |
| routing/routing-fanout-failures.test.ts             | fan-out routing failure modes                                                                    |
| execution/project-config-handoff.test.ts            | project-level handoff config, runtime config on handoff                                          |
| execution/guardrails/handoff-rails.test.ts          | handoff guardrails, pre/post handoff policy                                                      |
| agent-transfer-boot.test.ts                         | agent transfer bootstrap, external transfer                                                      |
| agent-transfer-bridge.test.ts                       | transfer bridge, cross-system handoff                                                            |
| agent-transfer-webhooks.test.ts                     | transfer webhooks, callback handling                                                             |
| transfer-tool-executor.test.ts                      | transfer tool execution                                                                          |
| extraction/constraint-checker.test.ts               | constraint evaluation, backtracking                                                              |
| extraction/constraint-control-flow-enhanced.test.ts | constraint-driven flow control, COLLECT actions                                                  |
| extraction/constraint-decision-traces.test.ts       | constraint decision trace events                                                                 |
| extraction/extraction-strategy.test.ts              | entity extraction strategy selection, fallback                                                   |
| extraction/extraction-tool-call.test.ts             | tool-call-based extraction                                                                       |
| extraction/extraction-decision-traces.test.ts       | extraction decision trace events                                                                 |
| extraction/extraction-pipeline.test.ts              | full extraction pipeline end-to-end                                                              |
| post-extraction-conversion.test.ts                  | post-extraction type conversion                                                                  |
| post-extraction-inference.test.ts                   | post-extraction inference logic                                                                  |
| post-extraction-lookup.test.ts                      | post-extraction lookup resolution                                                                |
| extraction/gather-decision-traces.test.ts           | gather field decision trace events                                                               |
| extraction/gather-lookup-integration.test.ts        | gather with lookup data sources                                                                  |
| extraction/field-inference.test.ts                  | field type inference for gather                                                                  |
| delegation-intent-isolation.test.ts                 | delegate intent isolation                                                                        |
| routing/delegate-safety.test.ts                     | delegate safety checks, recursive delegation guards                                              |
| routing/multi-intent-strategy.test.ts               | multi-intent detection and handling                                                              |
| routing/multi-intent-dispatch-wiring.test.ts        | multi-intent dispatch wiring                                                                     |
| routing/multi-intent-executor-integration.test.ts   | multi-intent executor integration                                                                |
| routing/multi-intent-integration.test.ts            | multi-intent end-to-end integration                                                              |
| on-input-multi-intent-invariant.test.ts             | ON_INPUT multi-intent invariant checks                                                           |
| clarification-count.test.ts                         | clarification loop detection                                                                     |
| correction-enhanced.test.ts                         | user correction handling                                                                         |
| correction-detection-config.test.ts                 | correction detection configuration                                                               |
| correction-field-validation.test.ts                 | correction field validation logic                                                                |
| correction-llm-fallback.test.ts                     | correction LLM fallback path                                                                     |
| coordinator-wiring.test.ts                          | coordinator service wiring                                                                       |
| execution/thread-resume.test.ts                     | thread resume after handoff return                                                               |
| execution/thread-resume-integration.test.ts         | thread resume integration with session                                                           |
| execution/thread-sync-functions.test.ts             | thread data synchronization functions                                                            |
| sessions/session-threading-context.test.ts          | session threading context propagation                                                            |
| fan-out.test.ts                                     | fan-out execution pattern                                                                        |
| routing/fan-out-parallel.test.ts                    | parallel fan-out execution                                                                       |
| routing/fan-out-bug-fixes.test.ts                   | fan-out edge case fixes                                                                          |
| routing/prompt-builder.test.ts                      | system prompt construction for execution                                                         |
| routing/prompt-builder-voice.test.ts                | voice prompt construction                                                                        |
| execution/value-resolution.test.ts                  | runtime value resolution in execution                                                            |
| execution/validation-retry.test.ts                  | validation retry logic during gather                                                             |
| llm-field-validation.test.ts                        | LLM-based field validation                                                                       |
| inference-confirmation-flow.test.ts                 | inference confirmation flow                                                                      |
| lookup-resolver.test.ts                             | lookup data resolution during gather                                                             |
| lookup-fuzzy-confirmation.test.ts                   | fuzzy lookup confirmation flow                                                                   |
| disambiguation-choice-handler.test.ts               | disambiguation choice handling                                                                   |
| disambiguation-context.test.ts                      | disambiguation context management                                                                |
| normalize-tool-result.test.ts                       | tool result normalization                                                                        |
| runtime-lifecycle.test.ts                           | runtime session lifecycle management                                                             |
| execution/rich-content-execution.test.ts            | rich content in execution responses                                                              |

### execution/pre-refactor/ (legacy execution tests)

| File                                                       | Execution Paths Covered                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| execution/pre-refactor/gather-validation.test.ts           | gather field validation rules                                  |
| execution/pre-refactor/gather-validation-extended.test.ts  | extended gather validation scenarios                           |
| execution/pre-refactor/gather-execution.test.ts            | gather execution flow                                          |
| execution/pre-refactor/gather-delegation.test.ts           | gather with delegation                                         |
| execution/pre-refactor/constraint-evaluation.test.ts       | constraint evaluation logic                                    |
| execution/pre-refactor/constraint-actions-extended.test.ts | extended constraint action handling                            |
| execution/pre-refactor/constraint-delegation.test.ts       | constraint-triggered delegation                                |
| execution/pre-refactor/constraint-guardrails.test.ts       | constraint guardrail enforcement                               |
| execution/pre-refactor/completion-conditions.test.ts       | completion condition evaluation                                |
| execution/pre-refactor/completion-delegation.test.ts       | completion with delegation                                     |
| execution/pre-refactor/completion-detection.test.ts        | completion detection heuristics                                |
| execution/pre-refactor/handoff-delegation.test.ts          | handoff delegation mechanics                                   |
| execution/pre-refactor/handoff-delegate-fanout.test.ts     | handoff delegate fan-out                                       |
| execution/pre-refactor/flow-step-transitions.test.ts       | flow step transition logic                                     |
| execution/pre-refactor/flow-delegation.test.ts             | flow-level delegation                                          |
| execution/pre-refactor/reasoning-delegation.test.ts        | reasoning mode delegation                                      |
| execution/pre-refactor/reasoning-tool-execution.test.ts    | reasoning mode tool execution                                  |
| execution/pre-refactor/thread-model.test.ts                | thread model creation and management                           |
| execution/pre-refactor/session-lifecycle.test.ts           | session lifecycle in legacy path                               |
| execution/pre-refactor/state-management.test.ts            | execution state management                                     |
| execution/pre-refactor/trace-emission.test.ts              | trace event emission                                           |
| execution/pre-refactor/error-handling.test.ts              | execution error handling                                       |
| execution/pre-refactor/execution-context-bridge.test.ts    | execution context bridge (RuntimeSession <-> ExecutionContext) |

## By Feature

Phase 3 note: use the current domain-prefixed paths below. The former
`flow-handoff-threads.test.ts` coverage now lives in
`multi-agent-orchestration.e2e.test.ts`, while `pre-refactor/` remains grouped
under `execution/pre-refactor/`.

**Handoff broken?** Check:

1. multi-agent-orchestration.e2e.test.ts (absorbed former `flow-handoff-threads` coverage)
2. execution/reasoning-gather-handoff.test.ts (handoff/delegate sections)
3. execution/scripted-mode-handoff-fix.unit.test.ts
4. routing/routing-remote-handoff.test.ts
5. execution/project-config-handoff.test.ts
6. execution/thread-resume.test.ts / execution/thread-resume-integration.test.ts
7. execution/pre-refactor/handoff-delegation.test.ts
8. execution/pre-refactor/handoff-delegate-fanout.test.ts

**Gather broken?** Check:

1. execution/reasoning-gather-handoff.test.ts (gather sections)
2. extraction/extraction-strategy.test.ts
3. extraction/extraction-pipeline.test.ts
4. extraction/gather-decision-traces.test.ts
5. extraction/gather-lookup-integration.test.ts
6. extraction/field-inference.test.ts
7. execution/validation-retry.test.ts
8. execution/flow-gather-oninput.test.ts
9. execution/pre-refactor/gather-validation.test.ts / gather-execution.test.ts / gather-delegation.test.ts

**Constraints broken?** Check:

1. extraction/constraint-checker.test.ts
2. extraction/constraint-control-flow-enhanced.test.ts
3. extraction/constraint-decision-traces.test.ts
4. execution/flow-constraint-minicollect.test.ts
5. execution/flow-detect-intent-constraints.test.ts
6. execution/pre-refactor/constraint-evaluation.test.ts / constraint-actions-extended.test.ts / constraint-delegation.test.ts

**Delegation broken?** Check:

1. execution/reasoning-gather-handoff.test.ts (delegate sections)
2. delegation-intent-isolation.test.ts
3. routing/delegate-safety.test.ts
4. routing/routing-delegate-failures.test.ts
5. execution/pre-refactor/constraint-delegation.test.ts
6. execution/pre-refactor/gather-delegation.test.ts
7. execution/pre-refactor/flow-delegation.test.ts
8. execution/pre-refactor/reasoning-delegation.test.ts

**Flow/transitions broken?** Check:

1. multi-agent-orchestration.e2e.test.ts (handoff-thread coverage)
2. execution/execution-coordinator.test.ts
3. execution/flow-execution-coverage.test.ts
4. execution/flow-step-helpers.test.ts
5. execution/flow-on-result.test.ts / execution/flow-on-result-branches.test.ts
6. execution/flow-queued-intents.test.ts
7. execution/flow-intents-digressions.test.ts
8. execution/pre-refactor/flow-step-transitions.test.ts
9. execution/pre-refactor/thread-model.test.ts

**Completion broken?** Check:

1. execution/runtime-completion.test.ts
2. execution/pre-refactor/completion-conditions.test.ts
3. execution/pre-refactor/completion-delegation.test.ts
4. execution/pre-refactor/completion-detection.test.ts

**Extraction broken?** Check:

1. extraction/extraction-strategy.test.ts
2. extraction/extraction-tool-call.test.ts
3. extraction/extraction-pipeline.test.ts
4. extraction/extraction-decision-traces.test.ts
5. post-extraction-conversion.test.ts
6. post-extraction-inference.test.ts
7. post-extraction-lookup.test.ts

**Multi-intent broken?** Check:

1. routing/multi-intent-strategy.test.ts
2. routing/multi-intent-dispatch-wiring.test.ts
3. routing/multi-intent-executor-integration.test.ts
4. routing/multi-intent-integration.test.ts
5. routing/routing-executor-multi-intent.test.ts
6. on-input-multi-intent-invariant.test.ts

**Correction broken?** Check:

1. correction-enhanced.test.ts
2. correction-detection-config.test.ts
3. correction-field-validation.test.ts
4. correction-llm-fallback.test.ts
5. execution/flow-correction-chain.test.ts

**Fan-out broken?** Check:

1. fan-out.test.ts
2. routing/fan-out-parallel.test.ts
3. routing/fan-out-bug-fixes.test.ts
4. routing/routing-fanout-failures.test.ts

**Thread management broken?** Check:

1. execution/thread-resume.test.ts
2. execution/thread-resume-integration.test.ts
3. execution/thread-sync-functions.test.ts
4. sessions/session-threading-context.test.ts
5. execution/pre-refactor/thread-model.test.ts
