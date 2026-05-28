# TODO: Runtime Engine Consolidation

**Status:** Planning
**Created:** 2026-02-15
**Priority:** High
**Prerequisite:** Comprehensive pre-refactor test suite (see Phase 0)

---

## Problem Statement

The codebase has **two overlapping execution engines** with significant duplication:

| Engine              | Location                                                | Size                                   | Role                                                                                                      |
| ------------------- | ------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `RuntimeExecutor`   | `apps/runtime/src/services/runtime-executor.ts`         | ~2,626 lines (was ~5,881 pre-refactor) | Monolithic engine handling everything: flow, gather, handoffs, constraints, LLM, tools, threads, sessions |
| `ConstructExecutor` | `packages/compiler/src/platform/constructs/executor.ts` | Modular (~10 sub-executors)            | Clean pipeline engine designed for all runtimes (Digital/Voice/Workflow)                                  |

`RuntimeExecutor` has a header that says: _"UNIFICATION NOTE: This runtime is being unified with ConstructExecutor"_ — this TODO tracks that work.

### Why Consolidate

1. **Duplicated logic** — Flow stepping, gather collection, constraint checking, completion detection, handoff routing all exist in both engines
2. **Debugging pain** — Finding a one-line bug in 2,626 lines (previously 5,881) took hours (see [OBSERVABILITY_AND_TRACING.md](./OBSERVABILITY_AND_TRACING.md), Section 5)
3. **Feature drift** — Fixes/features added to one engine aren't reflected in the other
4. **Channel lock-in** — `RuntimeExecutor` is tightly coupled to the digital WebSocket channel; Voice and Workflow runtimes can't reuse it
5. **Testing burden** — Two engines means two sets of tests for the same behaviors

### Target State

```
RuntimeExecutor (thin orchestration shell ~1,500 lines)
├── Session lifecycle (create, load, persist, destroy)
├── Thread management (create, switch, return)
├── WebSocket/HTTP integration (message routing)
├── LLM client wiring (SessionLLMClient)
├── Tool executor wiring (ToolBindingExecutor + adapters)
└── Calls ConstructExecutor.execute(context) for ALL agent logic
        │
        ├── FlowExecutor (scripted stepping)
        ├── ReasoningExecutor (tool-use loops)
        ├── GatherExecutor (field collection)
        ├── HandoffExecutor (agent routing)
        ├── DelegateExecutor (sub-agent calls)
        ├── ConstraintExecutor (guardrails)
        ├── CompleteExecutor (completion conditions)
        ├── EscalateExecutor (human transfer)
        ├── MemoryExecutor (recall/remember)
        └── ErrorExecutor (error recovery)
```

---

## Phase 0: Pre-Refactor Test Suite (CURRENT)

**Goal:** Establish behavioral contracts before touching any code.

- [ ] Comprehensive test suite covering all `RuntimeExecutor` code paths
- [ ] Tests assert **observable behavior** (responses, state mutations, trace events, session state) not implementation details
- [ ] All existing tests pass as baseline
- [ ] Test coverage report generated

**Key test areas:**

- Session lifecycle (create, initialize, ON_START hooks)
- Flow execution (step transitions, THEN/GOTO, auto-advance, loops)
- Gather (field collection, validation, ON_INPUT, entity extraction, corrections)
- Constraints (evaluation, auto-guard, violation handling, ON_FAIL)
- Completion (conditions, callsite contexts, premature completion prevention)
- Handoffs (routing rules, PASS context, thread creation, return/no-return)
- Delegates (sub-agent invocation, result mapping)
- Reasoning mode (tool-use loop, max turns, system tools)
- Tool execution (binding, middleware, mock, resilience)
- Trace emission (all event types, callsite context, decision events)
- Thread model (create, switch, stack, return mapping, state isolation)
- Error handling (LLM errors, tool errors, constraint violations, timeouts)
- State management (SessionDataStore, gatherProgress, context, SET variables)
- Fan-out (parallel sub-tasks)
- Digressions (intent-based escapes, resume)
- Session persistence bridge (detach, snapshot, rehydration)

**Deliverable:** `apps/runtime/src/__tests__/pre-refactor/` directory with test files

---

## Phase 1: State Mapping Layer

**Goal:** Create bidirectional mapping between `RuntimeSession`/`RuntimeState` and `ExecutionContext`/`AgentState`.

- [ ] Define `buildExecutionContext(session: RuntimeSession): ExecutionContext`
- [ ] Define `applyExecutionResult(session: RuntimeSession, result: ExecutionResult): void`
- [ ] Map `SessionDataStore.values` ↔ `AgentState.context` + `AgentState.collectedFields`
- [ ] Map `RuntimeState.gatherProgress` ↔ `AgentState.gatherProgress`
- [ ] Map thread conversation history ↔ `ExecutionContext.messages`
- [ ] Map `RuntimeSession.currentFlowStep` ↔ `FlowState.currentStep`
- [ ] Unit test all mappings with round-trip assertions

**Files:**

- New: `apps/runtime/src/services/execution-context-bridge.ts`
- New: `apps/runtime/src/__tests__/execution-context-bridge.test.ts`

---

## Phase 2: Adapter Completion

**Goal:** Ensure all adapters (`LLMClient`, `ToolExecutor`, `ConstructAgentRegistry`) fully implement the `ConstructExecutor` interfaces.

- [ ] `SessionLLMClient` implements `ConstructLLMClient` interface
- [ ] `ToolBindingExecutor` (already done) wired as `ConstructToolExecutor`
- [ ] `AgentRegistry` implements `ConstructAgentRegistry` for handoff/delegate resolution
- [ ] `TraceManager` adapter bridges `onTraceEvent` to `TraceContextManager`
- [ ] Verify all adapters with integration tests

**Files:**

- Existing: `apps/runtime/src/services/adapters/tool-executor-adapter.ts`
- Existing: `apps/runtime/src/services/adapters/index.ts`
- Update: `apps/runtime/src/services/llm/session-llm-client.ts`

---

## Phase 3: Incremental Delegation

**Goal:** Replace `RuntimeExecutor` logic one phase at a time, running old and new in parallel with result comparison.

### 3a: Gather → GatherExecutor

- [ ] Delegate gather field collection to `GatherExecutor`
- [ ] Remove inline gather logic from `executeFlowStep()`
- [ ] Verify with gather-specific tests

### 3b: Constraints → ConstraintExecutor

- [ ] Delegate constraint checking to `ConstraintExecutor`
- [ ] Remove inline `checkConstraintsCore()` calls
- [ ] Verify with constraint-specific tests

### 3c: Completion → CompleteExecutor

- [ ] Delegate completion condition evaluation to `CompleteExecutor`
- [ ] Remove inline `checkCompletionConditions()`
- [ ] Verify with completion-specific tests

### 3d: Handoffs → HandoffExecutor

- [ ] Delegate handoff routing to `HandoffExecutor`
- [ ] Keep thread management in `RuntimeExecutor`
- [ ] Verify with handoff/thread tests

### 3e: Flow → FlowExecutor

- [ ] Delegate flow step transitions to `FlowExecutor`
- [ ] Remove inline step execution from `executeMessage()`
- [ ] Verify with flow execution tests

### 3f: Reasoning → ReasoningExecutor

- [ ] Delegate tool-use loops to `ReasoningExecutor`
- [ ] Remove inline `executeWithTools()`
- [ ] Verify with reasoning mode tests

### 3g: Full Pipeline

- [ ] Replace `executeMessage()` core with single `ConstructExecutor.execute()` call
- [ ] Run full test suite — all pre-refactor tests must pass
- [ ] Run E2E tests (hotel-booking, supervisor flows)

---

## Phase 4: Cleanup

**Goal:** Remove dead code, reduce `runtime-executor.ts` to ~1,500 lines.

- [ ] Remove all inline execution logic replaced by ConstructExecutor
- [ ] Remove unused helper methods
- [ ] Extract session lifecycle into `SessionManager` if beneficial
- [ ] Update imports across codebase
- [ ] Verify no regressions with full test suite
- [ ] Update `RUNTIME_ARCHITECTURE.md` documentation

---

## Phase 5: Multi-Runtime Enablement

**Goal:** Verify Voice and Workflow runtimes can use the same `ConstructExecutor` pipeline.

- [ ] `VoiceRuntime` → `ConstructExecutor` integration test
- [ ] `WorkflowRuntime` → `ConstructExecutor` integration test
- [ ] Verify channel-specific adapters (LLM streaming, tool execution) work correctly
- [ ] Document the unified runtime API

---

## Risk Register

| Risk                                           | Mitigation                                      |
| ---------------------------------------------- | ----------------------------------------------- |
| Behavioral regression during delegation        | Pre-refactor test suite as safety net           |
| State mapping bugs between session types       | Round-trip unit tests for every mapping         |
| Performance degradation from extra abstraction | Benchmark critical paths before/after           |
| Thread model complexity in ConstructExecutor   | Keep thread management in RuntimeExecutor shell |
| Trace event format changes                     | Assert trace event shapes in pre-refactor tests |
| Concurrent session bugs                        | Session isolation tests in pre-refactor suite   |

---

## Success Criteria

1. All pre-refactor tests pass after consolidation
2. `runtime-executor.ts` reduced from ~5,881 to ~1,500 lines
3. No new `// HACK` or `// FIXME` comments introduced
4. Voice/Workflow runtimes can execute agents via same ConstructExecutor
5. Trace output identical (same event types, same data shapes)
6. No performance regression on benchmarked paths
