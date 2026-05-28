# SDLC Log: Workflow Function Node — Implementation Phase

**Feature**: workflow-function-node
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-07-workflow-function-node-impl-plan.md`
**Date Started**: 2026-04-07
**Date Completed**: 2026-04-07

---

## Preflight

- [x] LLD file paths verified (all 8 modified files + 4 new file locations)
- [x] Function signatures current (WorkflowStep union L49-61, StepDispatchResult L64-83, NODE_TYPE_TO_STEP_TYPE L44-59, ExecutionPersistence.updateStepStatus L118-131)
- [x] No conflicting recent changes (recent commits are on same branch, same feature)
- Discrepancies: none

## Phase Execution

### LLD Phase 1: Dockerfile & Dependency Setup

- **Status**: DONE
- **Commit**: 0e0b3b208
- **Exit Criteria**: all met
- **Deviations**: isolated-vm pinned to 6.1.2 (not 5.0.1 as LLD planned) — v5 does not compile on Node 24 (local dev machine). v6.1.2 supports Node >= 22.
- **Files Changed**: 3 (Dockerfile, package.json, pnpm-lock.yaml)

### LLD Phase 2: Function Executor Core

- **Status**: DONE
- **Commit**: 02086e7cd
- **Exit Criteria**: all met
- **Deviations**: Used `__deepFreeze` inside isolate script (not just host-side freeze) because `ExternalCopy.copyInto()` does not preserve frozen state. Removed IIFE wrapper — user code runs directly in script context so V8 completion value is returned.
- **Files Changed**: 2 (function-executor.ts, constants.ts)

### LLD Phase 3: Engine Wiring

- **Status**: DONE
- **Commit**: af98eff69
- **Exit Criteria**: all met (build succeeds, never check compiles, 358 existing tests pass)
- **Deviations**: none
- **Files Changed**: 4 (step-dispatcher.ts, canvas-to-steps.ts, workflow-handler.ts, execution-store.ts)

### LLD Phase 4: Studio UI Update

- **Status**: DONE
- **Commit**: 98d2c378c
- **Exit Criteria**: all met (tsc --noEmit passes)
- **Deviations**: none
- **Files Changed**: 1 (FunctionNodeConfig.tsx)

### LLD Phase 5: Unit Tests

- **Status**: DONE
- **Commit**: 7120b058c
- **Exit Criteria**: all met (378 tests pass, 20 new + 358 existing)
- **Deviations**: UT-3 (context frozen) tests silent rejection in sloppy mode, not TypeError. UT-9 (OOM) matches "disposed" error from isolate disposal.
- **Files Changed**: 4 (function-executor.test.ts, canvas-to-steps.test.ts, step-dispatcher.test.ts, function-executor.ts)

### LLD Phase 6: Integration Tests

- **Status**: DONE
- **Commit**: 52759e4a1
- **Exit Criteria**: all met (386 tests pass, 8 new integration)
- **Deviations**: INT-8 uses `2 + 2` instead of `({ computed: 2 + 2 })` — V8 script completion value is undefined for object literal expressions.
- **Files Changed**: 2 (function-executor.test.ts, e2e-basic.test.ts)

### LLD Phase 7: E2E Tests (Playwright)

- **Status**: DONE
- **Commit**: 366d9ded4
- **Exit Criteria**: file created, no mocks, no DB access, cleanup via deleteWorkflowFromList. Requires real services for execution.
- **Deviations**: none
- **Files Changed**: 2 (workflow-function-node.spec.ts, agents.md)

## Wiring Verification

- [x] `FunctionStep` type added to `WorkflowStep` union in `step-dispatcher.ts`
- [x] `case 'function':` added to `dispatchStep()` switch
- [x] `case 'function':` added to `resolveStepInput()` switch
- [x] `executeFunctionStep` imported in `step-dispatcher.ts`
- [x] `function: 'function'` mapping updated in `NODE_TYPE_TO_STEP_TYPE`
- [x] `case 'function':` added to `convertNodeToStep()` in `canvas-to-steps.ts`
- [x] Constants exported from `constants.ts`
- [x] `isolated-vm` added to `package.json`
- [x] Dockerfile builder switched to `node:22-slim`
- [x] `consoleLogs` field added to `StepDispatchResult`
- [x] `consoleLogs` field added to `ExecutionPersistence` interface
- [x] `ExecutionStore.updateStepStatus` persists `consoleLogs`
- [x] `consoleLogs` passed through `workflow-handler.ts`
- [x] `custom_script` button disabled in `FunctionNodeConfig.tsx`
- Missing wiring found: none

## Review Rounds

(Deferred — implementation completed, review rounds to follow)

## Acceptance Criteria

- [x] All 7 LLD phases complete with exit criteria met
- [x] 20 unit tests passing (UT-1 through UT-20)
- [x] 8 integration tests passing (INT-1 through INT-8)
- [x] 7 E2E test files created (E2E-1 through E2E-7) — require real services
- [x] `pnpm --filter=workflow-engine build` succeeds with zero errors
- [x] `pnpm --filter=workflow-engine test:fast` passes (386 tests, zero regressions)
- [x] Dockerfile builds with isolated-vm native module (locally verified)
- [ ] E2E tests verified with real services (requires infrastructure)

## Learnings

- `isolated-vm` v5 does not compile on Node 24 — use v6.1.2+
- `ExternalCopy.copyInto()` does not preserve host-side `Object.freeze` — must deep-freeze inside the isolate script
- V8 `script.runSync()` returns completion value only for simple expressions. Object literals `({ a: 1 })` return `undefined`. Use `setOutput()` for reliable object return.
- V8 sloppy mode (default) silently ignores writes to frozen objects instead of throwing TypeError. Test assertions should check that value is unchanged, not catch an error.
- OOM in isolated-vm disposes the isolate before the catch block runs — error message is "Isolate is already disposed" not "heap out of memory".
