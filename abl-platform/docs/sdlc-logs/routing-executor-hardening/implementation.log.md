# SDLC Log: Routing Executor Hardening and Multi-Intent Integration — Implementation Phase

**Feature**: routing-executor-hardening
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-03-31-routing-executor-hardening-plan.md`
**Date Started**: 2026-03-31

---

## Preflight

- [x] LLD target files verified against the current runtime/execution tree
- [x] Phase 1 signatures verified fresh from disk (`handleHandoff`, `checkHandoffConditions`, `buildTools`, `createChildSession`)
- [x] Recent changes on Phase 1 files reviewed for conflicts
- Discrepancies:
  - The LLD references the session-management companion docs without the dated implementation-plan filename. Equivalent companion docs do exist (`docs/features/multi-agent-session-management.md`, `docs/specs/multi-agent-session-management.hld.md`, `docs/plans/2026-03-23-multi-agent-session-management-impl-plan.md`) and were used as supporting context where needed.

## Phase Execution

### LLD Phase 1: Remove Stale Routing Authority And Sanitize Child Sessions

- **Status**: DONE
- **Commit**: `d5bd6f13f`
- **Exit Criteria**: all met — active IR is the only handoff authority source, prompt builder is read-only, child-session factories are sanitized and purpose-built, HTTP-level child-routing-authority E2E passes, runtime/execution builds are clean, focused Phase 1 suites pass
- **Deviations**:
  - The HTTP E2E initially used deprecated `MODE:` syntax and omitted explicit `WHEN:` clauses, which triggered a supervisor fixture compile mismatch. The fixture was corrected to current ABL syntax before final verification.
  - The mock OpenAI-compatible request path did not expose routing tools through `request.tools`, so the E2E was kept focused on the HTTP-observable contract: denial trace + no unauthorized child thread.
- **Files Changed**: 13

#### Phase 1 Verification

- `pnpm --filter @agent-platform/execution build`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/execution test -- --run src/__tests__/child-session.test.ts`
- `pnpm --filter @agent-platform/runtime test -- --run src/__tests__/routing/routing-capabilities.test.ts src/__tests__/routing/prompt-builder.test.ts src/__tests__/routing/routing-conditions.test.ts src/__tests__/routing/routing-remote-handoff.test.ts src/__tests__/agent-switch-event.test.ts src/__tests__/e2e/child-routing-authority.e2e.test.ts`

### LLD Phase 2: Centralize Agent Activation, Tool Wiring, And Auth Propagation

- **Status**: DONE
- **Commit**: `fa42dfae6`
- **Exit Criteria**: all met — shared activation helper is in place, runtime auth-profile helpers now use activation-scoped auth context, local handoff/delegate/fan-out flows route through the shared activation seam, tool executor rewiring happens on both child activation and parent restoration, activation auth context survives nested delegate and `RETURN: true` handoff round-trips, runtime/execution builds are clean, focused Phase 2 suites pass
- **Deviations**:
  - Focused verification exposed a real integration bug: local handoff and delegate were mutating `activeThreadIndex` before `activateAgentExecutionContext()` ran, which bypassed parent-thread auth-context capture. The fix was to let the activation helper own the thread switch.
  - The new `RETURN: true` handoff regression initially tried to drive return behavior through the mocked validator, but the runtime derives `returnExpected` from active IR routing capabilities. The test was corrected to set `coordination.handoffs[].return = true` so it exercises the real contract.
- **Files Changed**: 15

#### Phase 2 Verification

- `pnpm --filter @agent-platform/execution build`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/execution test -- --run src/__tests__/child-session.test.ts`
- `pnpm --filter @agent-platform/runtime test -- --run src/__tests__/execution/agent-activation-context.test.ts src/__tests__/auth/auth-profile-propagation.test.ts src/__tests__/llm-wiring.test.ts src/__tests__/routing/delegate-safety.test.ts src/__tests__/agent-switch-event.test.ts src/__tests__/fan-out.test.ts`

### LLD Phase 3a: Additive Async Fan-Out State And Continuation Contract

- **Status**: DONE
- **Commit**: `01485b222`
- **Exit Criteria**: all met — new fan-out continuation variants exist additively beside the legacy type, branch records expose explicit terminal status transitions, barrier completion semantics are captured as executable idempotent contract helpers, runtime/execution builds are clean, focused Phase 3a suites pass
- **Deviations**:
  - This phase intentionally stops at contract/scaffolding level. The Redis barrier implementation and `ResumptionService` dispatch path are not behaviorally rewired yet; that remains Phase 3b so rollback stays trivial.
  - The additive barrier contract is enforced in pure helper tests (`classifyBranchCompletionAttempt`) rather than the Redis store itself in this slice. That keeps Phase 3a storage-compatible while making the idempotent rules explicit and testable before the Redis/Lua rewrite.
- **Files Changed**: 13

#### Phase 3a Verification

- `pnpm --filter @agent-platform/execution build`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/execution test -- --run src/__tests__/suspension-types.test.ts src/__tests__/fan-out-barrier-contract.test.ts`
- `pnpm --filter @agent-platform/runtime test -- --run src/__tests__/routing/async-fanout-coordinator.test.ts src/__tests__/routing/async-fanout-resumption.test.ts`

### LLD Phase 3b: Wire Async Fan-Out Execution, Barrier Completion, And Parent Resumption

- **Status**: DONE
- **Commit**: `19116dc44`
- **Exit Criteria**: all met — mixed local/remote async fan-out now creates real child sessions for local branches, remote branches suspend on dedicated continuation types, the Redis barrier is idempotent and parent-resume-aware, timed-out branches enqueue the parent resume exactly once, parent aggregation writes the canonical `_last_fan_out` snapshot, runtime/execution builds are clean, focused Phase 3b suites pass
- **Deviations**:
  - The first Phase 3b cut added a dedicated session-store adapter to `ResumptionService`, but that duplicated runtime hydration/persistence logic. The final implementation instead uses the executor-owned `rehydrateSession()` and `saveSessionSnapshot()` seam so async resumption stays aligned with the rest of runtime execution.
  - Focused runtime verification for the new routing tests is materially faster and more deterministic with `vitest --pool forks --maxWorkers=1 --no-file-parallelism`, because these files have a heavy import/transform footprint in the default pool. The assertions are unchanged; only worker scheduling is constrained for the focused regression pass.
  - Regression testing exposed a real deferred-resume control-flow bug: the remote-branch path returned from inside the locked `try` block before the post-lock parent enqueue/completion logic ran. The fix was to keep the function in the common exit path and dispatch the deferred resume after releasing the lock.
- **Files Changed**: 12

#### Phase 3b Verification

- `pnpm --filter @agent-platform/execution build`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/execution test -- --run src/__tests__/suspension-types.test.ts src/__tests__/fan-out-barrier-contract.test.ts src/__tests__/redis-fan-out-barrier.test.ts`
- `pnpm --filter @agent-platform/runtime test -- --run src/__tests__/routing/async-fanout-coordinator.test.ts src/__tests__/routing/async-fanout-execution.test.ts src/__tests__/routing/async-fanout-resumption.test.ts --pool forks --maxWorkers=1 --no-file-parallelism`

### LLD Phase 4: Canonicalize Multi-Intent Planning And Execution

- **Status**: DONE
- **Commit**: `9b4dd1bcd`
- **Exit Criteria**: all met — `parallel` plans preserve executable targets, guided reasoning multi-intent now resolves and executes the same target-aware plan model as the pipeline short-circuit path, flow ON_INPUT multi-intent adapts into the shared planner without replacing its detector, queue/sequential/disambiguate now persist target-aware entries plus structured disambiguation choices, supervisor routing-call batching can build a shared parallel plan behind the new rollout flag, runtime build is clean, focused multi-intent suites pass
- **Deviations**:
  - `RoutingExecutor.handleMultiIntent()` now delegates to the shared planner, but it intentionally keeps the legacy raw-label behavior by synthesizing pseudo agent targets for historical `MultiIntentResult` inputs. That preserves the existing routing test matrix while the reasoning and flow paths migrate to real execution targets.
  - The new rollout flag only gates supervisor parallel routing-call admission (`disableParallelToolUse`) for the first release. The existing parallel-call-to-`__fan_out__` normalization path remains in place as a compatibility safety net when providers still emit multiple routing calls.
  - The target-aware queue/disambiguation structures are additive. Flow now consumes `_disambiguation_choices` when present and falls back to legacy `_disambiguation_intents`, which keeps older sessions and tests compatible during rollout.
- **Files Changed**: 10

#### Phase 4 Verification

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime test -- --run src/__tests__/routing/multi-intent-router.test.ts src/__tests__/routing/multi-intent-integration.test.ts src/__tests__/routing/multi-intent-executor-integration.test.ts src/__tests__/routing/routing-executor-multi-intent.test.ts src/__tests__/execution/reasoning-pipeline-bridge.test.ts --pool forks --maxWorkers=1 --no-file-parallelism`

### LLD Phase 5: Regression Closure, Trace Contract, And Documentation Alignment

- **Status**: DONE
- **Commit**: pending
- **Exit Criteria**: all met — targeted public-HTTP regressions now exist for `RETURN: true` handoff round-trip, guided multi-intent execution, and mixed local/remote async fan-out callback-resume; the runtime test harness has an in-memory async infra path for deterministic callback delivery; orchestration/NLU testing guides no longer describe these critical paths as planned-only; architecture/reference docs now match the per-target routing tool surface and current remote-agent DSL/runtime schema; focused runtime/execution builds and regression suites are clean
- **Deviations**:
  - Building the black-box E2Es exposed two real runtime defects that had to be fixed before the phase could close: `resolveProjectRuntimeConfig()` was dropping the persisted `pipeline` block on the way into IR, and `/a2a/callbacks/:callbackId` was mounted after `/a2a/:connectionId`, causing valid callback deliveries to 404 as `"Connection not found"`.
  - Deterministic classifier/merge coverage required extending the mock OpenAI-compatible server so prompt-driven `generateText()` requests can match against the full message corpus instead of only the final user turn.
  - The deterministic E2E harness uses in-memory async infra and callback registry wiring. Production Redis/callback transports remain the default outside the test harness; the new path exists only to make the public API regression suite reliable and architecture-faithful.
- **Files Changed**: 20

#### Phase 5 Verification

- `pnpm --filter @agent-platform/execution build`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/execution test -- --run src/__tests__/in-memory-callback-registry.test.ts src/__tests__/in-memory-fan-out-barrier.test.ts`
- `pnpm --filter @agent-platform/runtime test -- --run src/__tests__/project-runtime-config-resolver.test.ts src/__tests__/e2e/routing-phase5.e2e.test.ts --pool forks --maxWorkers=1 --no-file-parallelism`
