# Multi-Agent Orchestration — LLD + Implementation Plan

**Feature**: Multi-Agent Orchestration
**Date**: 2026-03-22
**Status**: STABLE (documenting existing implementation + planned E2E coverage expansion)
**Feature Spec**: [docs/features/multi-agent-orchestration.md](../features/multi-agent-orchestration.md)
**HLD**: [docs/specs/multi-agent-orchestration.hld.md](../specs/multi-agent-orchestration.hld.md)
**Test Spec**: [docs/testing/multi-agent-orchestration.md](../testing/multi-agent-orchestration.md)

---

## 1. Design Decisions

### Decision Log

| Decision                                         | Rationale                                                          | Alternatives Rejected                                          |
| ------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| In-process thread model for agent coordination   | Low latency, simple debugging, fits ABL compile-then-execute model | Saga pattern (too complex), Graph-based DAG (over-abstraction) |
| `RoutingExecutor` as monolithic coordinator      | Single file contains all coordination logic — simple to navigate   | Distributed across modules — harder to trace control flow      |
| `CountingSemaphore` for fan-out bounding         | Simple, effective, pod-local — matches deployment model            | Distributed semaphore (Redis SETNX — unnecessary complexity)   |
| Fail-open guardrail policy                       | Guardrail errors must NOT block legitimate handoffs                | Fail-closed (too risky for production coordination)            |
| `_activeFanOutSessions` Set for concurrent guard | Prevents overlapping fan-out from same session                     | Per-session mutex (heavier, not needed for set membership)     |
| Scripted flow agents for deterministic E2E tier  | No LLM dependency, fully deterministic, fast CI execution          | Real LLM only (slow, flaky, env-gated)                         |

### Key Interfaces & Types

```typescript
// packages/compiler/src/platform/ir/schema.ts
interface CoordinationConfig {
  delegates: DelegateConfig[];
  handoffs: HandoffConfig[];
  escalation?: EscalationConfig;
}

// apps/runtime/src/services/execution/types.ts
interface ExecutorContext {
  executeMessage: (sessionId: string, message: string, ...) => Promise<ExecutionResult>;
  agentRegistry: Record<string, AgentRegistryEntry>;
  config: RuntimeExecutorConfig;
}

interface AgentThread {
  agentName: string;
  status: 'active' | 'waiting' | 'completed' | 'escalated' | 'suspended' | 'human_agent';
  returnExpected: boolean;
  handoffContext?: Record<string, unknown>;
  // ... full definition in types.ts
}

// apps/runtime/src/services/execution/routing-executor.ts
class RoutingExecutor {
  handleHandoff(session, input, onChunk?, onTraceEvent?): Promise<{ success, response?, error? }>
  handleDelegate(session, delegateConfig, onChunk?, onTraceEvent?): Promise<SubTaskResult>
  handleFanOut(session, tasks, onChunk?, onTraceEvent?): Promise<FanOutResult>
  handleEscalation(session, input, onTraceEvent?): Promise<{ success, response?, error? }>
  handleComplete(session, input?, onTraceEvent?): Promise<{ success, response?, error? }>
  handleMultiIntent(session, intents, agentType, config): Promise<MultiIntentDispatchResult>
}

// apps/runtime/src/services/execution/multi-intent-strategy.ts
function resolveStrategy(
  declared: MultiIntentStrategy,
  agentType: AgentExecutionType,
  relationship: IntentRelationshipType,
): MultiIntentStrategy
```

### Module Boundaries

| Module                     | Responsibility                                                                    | Dependencies                                                             |
| -------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `routing-executor.ts`      | All coordination decisioning (handoff, delegate, fan-out, escalation, completion) | ExecutorContext, LLMWiringService, GuardrailPipeline, A2A, AgentTransfer |
| `execution-coordinator.ts` | Request-level concurrency control (serial/preemptive/parallel)                    | ExecutionQueue, ExecutionDedup, executor                                 |
| `multi-intent-strategy.ts` | Strategy resolution (pure function)                                               | None (pure)                                                              |
| `intent-queue.ts`          | Deferred intent storage and drain                                                 | None                                                                     |
| `trace-helpers.ts`         | Verbosity-aware trace event emission                                              | None                                                                     |
| `auth-profile-handoff.ts`  | Auth context forwarding for handoff                                               | SharedAuth types                                                         |
| `auth-profile-delegate.ts` | Auth context forwarding for delegate                                              | SharedAuth types                                                         |
| `auth-profile-fanout.ts`   | Auth context forwarding for fan-out                                               | SharedAuth types                                                         |
| `memory-integration.ts`    | Memory lifecycle hooks                                                            | MemoryExecutor, EventDetector, PreferenceDetector                        |
| `session-policy.ts`        | Session policy loading                                                            | Database                                                                 |
| `types.ts`                 | Shared types + thread helpers                                                     | Compiler types                                                           |

---

## 2. File-Level Change Map

This is primarily a documentation and test expansion plan. The core orchestration implementation is STABLE. Changes are focused on E2E test coverage.

### New Files

| File                                                                     | Purpose                                                   | LOC Estimate |
| ------------------------------------------------------------------------ | --------------------------------------------------------- | ------------ |
| `apps/runtime/src/__tests__/orchestration-handoff-return.e2e.test.ts`    | E2E: Supervisor handoff with RETURN and context passing   | ~200         |
| `apps/runtime/src/__tests__/orchestration-delegate-failure.e2e.test.ts`  | E2E: Delegate execution with INPUT/RETURNS and ON_FAILURE | ~180         |
| `apps/runtime/src/__tests__/orchestration-fanout-bounded.e2e.test.ts`    | E2E: Fan-out with bounded concurrency                     | ~200         |
| `apps/runtime/src/__tests__/orchestration-cycle-detection.e2e.test.ts`   | E2E: Cycle detection and self-handoff rejection           | ~150         |
| `apps/runtime/src/__tests__/orchestration-multi-intent.e2e.test.ts`      | E2E: Multi-intent primary_queue strategy                  | ~200         |
| `apps/runtime/src/__tests__/orchestration-guardrail-handoff.e2e.test.ts` | E2E: Handoff guardrail blocks transfer                    | ~180         |
| `apps/runtime/src/__tests__/orchestration-completion-return.e2e.test.ts` | E2E: Completion condition + return-to-parent              | ~170         |
| `apps/runtime/src/__tests__/e2e/fixtures/orchestration/`                 | ABL agent fixtures for deterministic E2E tests            | ~400         |

### Modified Files

| File                                          | Change Description                                  | Risk |
| --------------------------------------------- | --------------------------------------------------- | ---- |
| `docs/features/multi-agent-orchestration.md`  | Updated feature spec (all 18 sections)              | Low  |
| `docs/testing/multi-agent-orchestration.md`   | Updated test spec (7 E2E + 7 integration scenarios) | Low  |
| `docs/specs/multi-agent-orchestration.hld.md` | New HLD                                             | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: E2E Test Infrastructure and Deterministic Fixtures

**Goal**: Create the ABL agent fixtures and test harness needed for deterministic E2E orchestration tests.

**Tasks**:
1.1. Create ABL agent fixtures directory at `apps/runtime/src/__tests__/e2e/fixtures/orchestration/`.
1.2. Write `supervisor.abl` — scripted flow agent with `HANDOFF TO: specialist RETURN: true CONTEXT: { PASS: [customer_id] }`.
1.3. Write `specialist.abl` — scripted flow agent with `GATHER: { customer_id }` + `COMPLETION: { CONDITIONS: [{ WHEN: customer_id != "", RESPOND: "Done" }] }`.
1.4. Write `lookup_agent.abl` — delegate target that accepts `INPUT: { id }` and returns `{ status: "active" }`.
1.5. Write `cycle_agents.abl` — three agents (A, B, C) configured to create a handoff cycle.
1.6. Verify fixtures compile with `pnpm build --filter=@abl/compiler` (no IR errors).

**Files Touched**:

- `apps/runtime/src/__tests__/e2e/fixtures/orchestration/supervisor.abl` — new
- `apps/runtime/src/__tests__/e2e/fixtures/orchestration/specialist.abl` — new
- `apps/runtime/src/__tests__/e2e/fixtures/orchestration/lookup_agent.abl` — new
- `apps/runtime/src/__tests__/e2e/fixtures/orchestration/cycle_agents.abl` — new

**Exit Criteria**:

- [ ] All 4 fixture files exist and compile without errors
- [ ] `pnpm build --filter=@abl/compiler` succeeds with 0 errors
- [ ] Fixtures produce valid `CoordinationConfig` in their IR output

**Test Strategy**:

- Unit: Fixture compilation verified via compiler
- Integration: N/A (test infrastructure phase)

**Rollback**: Delete fixture directory.

---

### Phase 2: Core E2E Tests — Handoff, Delegate, Cycle Detection

**Goal**: Implement the three highest-priority deterministic E2E tests covering handoff with return, delegate with failure, and cycle detection.

**Tasks**:
2.1. Implement `orchestration-handoff-return.e2e.test.ts` (E2E-1 from test spec): Supervisor handoff with RETURN, PASS field propagation, thread resume, isolation check.
2.2. Implement `orchestration-delegate-failure.e2e.test.ts` (E2E-2): Delegate with INPUT/RETURNS mapping, ON_FAILURE: continue on timeout.
2.3. Implement `orchestration-cycle-detection.e2e.test.ts` (E2E-4): Cycle detection (A -> B -> C -> A), self-handoff rejection.
2.4. Follow the E2E harness pattern from `traveldesk-supervisor-ws-flow.e2e.test.ts` — use `RuntimeExecutor` directly with real compilation but no LLM (scripted flow agents).

**Files Touched**:

- `apps/runtime/src/__tests__/orchestration-handoff-return.e2e.test.ts` — new
- `apps/runtime/src/__tests__/orchestration-delegate-failure.e2e.test.ts` — new
- `apps/runtime/src/__tests__/orchestration-cycle-detection.e2e.test.ts` — new

**Exit Criteria**:

- [ ] `orchestration-handoff-return.e2e.test.ts` passes: 2+ threads created, PASS fields propagated, parent resumes after child completes
- [ ] `orchestration-delegate-failure.e2e.test.ts` passes: delegate result mapped to parent, timeout triggers ON_FAILURE: continue
- [ ] `orchestration-cycle-detection.e2e.test.ts` passes: cycle detection error returned, self-handoff error returned
- [ ] All existing runtime tests still pass: `pnpm test --filter=apps/runtime`
- [ ] Cross-tenant isolation check returns 404 in handoff E2E

**Test Strategy**:

- E2E: 3 deterministic tests (no LLM dependency)
- Integration: Existing tests remain green

**Rollback**: Delete the 3 new test files.

---

### Phase 3: Fan-Out, Multi-Intent, and Guardrail E2E Tests

**Goal**: Implement the remaining E2E tests covering fan-out concurrency, multi-intent dispatch, guardrail blocking, and completion-return.

**Tasks**:
3.1. Implement `orchestration-fanout-bounded.e2e.test.ts` (E2E-3): Fan-out with bounded concurrency, trace event verification.
3.2. Implement `orchestration-multi-intent.e2e.test.ts` (E2E-5): Multi-intent primary_queue strategy, intent queue drain.
3.3. Implement `orchestration-guardrail-handoff.e2e.test.ts` (E2E-6): Handoff guardrail blocks transfer, clean context passes.
3.4. Implement `orchestration-completion-return.e2e.test.ts` (E2E-7): Completion condition triggers, return-to-parent, trace events.

**Files Touched**:

- `apps/runtime/src/__tests__/orchestration-fanout-bounded.e2e.test.ts` — new
- `apps/runtime/src/__tests__/orchestration-multi-intent.e2e.test.ts` — new
- `apps/runtime/src/__tests__/orchestration-guardrail-handoff.e2e.test.ts` — new
- `apps/runtime/src/__tests__/orchestration-completion-return.e2e.test.ts` — new

**Exit Criteria**:

- [ ] `orchestration-fanout-bounded.e2e.test.ts` passes: all branches complete, semaphore respected, `fan_out_start`/`fan_out_complete` events emitted
- [ ] `orchestration-multi-intent.e2e.test.ts` passes: primary intent routed, alternative queued, queue drained after completion
- [ ] `orchestration-guardrail-handoff.e2e.test.ts` passes: blocked handoff returns violation message, clean handoff succeeds
- [ ] `orchestration-completion-return.e2e.test.ts` passes: completion condition fires, child returns, parent resumes, trace events emitted
- [ ] All existing runtime tests still pass
- [ ] Total orchestration E2E count: 7 (all new) + 1 existing (traveldesk) = 8

**Test Strategy**:

- E2E: 4 deterministic tests
- Integration: Existing tests remain green

**Rollback**: Delete the 4 new test files.

---

### Phase 4: Documentation Finalization and Gap Closure

**Goal**: Update all SDLC artifacts to reflect the actual E2E coverage state after implementation.

**Tasks**:
4.1. Update `docs/features/multi-agent-orchestration.md` §17 (Testing) with actual E2E test file paths and PASS/FAIL status.
4.2. Update `docs/testing/multi-agent-orchestration.md` test file inventory and coverage matrix with actual results.
4.3. Update `docs/testing/README.md` with multi-agent-orchestration entry.
4.4. Close GAP-001 (multi-intent E2E), GAP-002 (fan-out E2E) if Phase 3 succeeds.
4.5. Update `apps/runtime/agents.md` with learnings from E2E implementation.

**Files Touched**:

- `docs/features/multi-agent-orchestration.md` — update §17
- `docs/testing/multi-agent-orchestration.md` — update inventory
- `docs/testing/README.md` — add entry
- `apps/runtime/agents.md` — append learnings (create if missing)

**Exit Criteria**:

- [ ] Feature spec §17 reflects actual test results
- [ ] Test spec inventory includes all 7 new E2E test files with PASS status
- [ ] Coverage matrix updated from NOT TESTED to PASS for FR-1 through FR-6 E2E column
- [ ] Testing README includes multi-agent-orchestration entry
- [ ] GAP-001 and GAP-002 status changed from Open to Resolved (if tests pass)

**Test Strategy**:

- N/A (documentation phase)

**Rollback**: Revert documentation changes.

---

## 4. Wiring Checklist

- [ ] New E2E test files use existing test infrastructure (RuntimeExecutor, compileToResolvedAgent, SessionLLMClient patterns from traveldesk E2E)
- [ ] ABL fixtures compile correctly — verified by compiler build
- [ ] Test files import from correct relative paths (vitest, runtime services, compiler)
- [ ] Test files are picked up by vitest configuration (match `*.e2e.test.ts` or `*.test.ts` patterns)
- [ ] No new production code — all changes are test files and documentation
- [ ] No new routes, models, middleware, or workers to register
- [ ] No new types to export from package indexes
- [ ] No new UI components to wire

---

## 5. Cross-Phase Concerns

### Database Migrations

None — orchestration operates on in-memory session state. No schema changes.

### Feature Flags

None needed — orchestration is STABLE and fully shipped.

### Configuration Changes

None — no new environment variables or config keys.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases complete with exit criteria met
- [ ] 7 new deterministic E2E tests passing
- [ ] 1 existing env-gated E2E test still passing
- [ ] All existing unit/integration tests green (0 regressions)
- [ ] Feature spec updated with actual test results
- [ ] Test spec inventory reflects actual file paths
- [ ] Testing README includes feature entry
- [ ] HLD and LLD committed and accessible
- [ ] SDLC logs complete for all 4 pipeline phases

---

## 7. Open Questions

1. Should the deterministic E2E harness start a full Express server (HTTP boundary) or use RuntimeExecutor directly (in-process)? The existing traveldesk E2E uses RuntimeExecutor directly. The E2E test spec describes HTTP-based interaction. **Decision**: Start with RuntimeExecutor-direct (matches existing pattern), then optionally add HTTP-boundary tests in a follow-up.
2. Should fan-out E2E tests control semaphore capacity via constructor injection or config override? **Decision**: Constructor injection — cleaner for testing, already supported by `RoutingExecutor(ctx, llmWiring)` where `ctx.config.maxConcurrentFanOutCalls` is configurable.
3. How to seed multi-intent detection without a real NLU/LLM call? **Decision**: Use scripted agents with explicit `_pinnedIntent` or mock the NLU sidecar at the boundary. Do NOT mock `RoutingExecutor` or `resolveStrategy` — those are the code under test.
