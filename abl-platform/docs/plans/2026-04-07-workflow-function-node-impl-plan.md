# LLD: Workflow Function Node with Context Injection

**Feature Spec**: `docs/features/sub-features/workflow-function-node.md`
**HLD**: `docs/specs/workflow-function-node.hld.md`
**Test Spec**: `docs/testing/sub-features/workflow-function-node.md`
**Status**: DONE
**Date**: 2026-04-07

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                   | Rationale                                                                                                                                                                                                                                                                    | Alternatives Rejected                                                          |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| D-1 | Async executor function (`Promise<FunctionResult>`)                                        | `isolated-vm` APIs can be async; follows http-executor pattern                                                                                                                                                                                                               | Sync executor (would block event loop during isolate operations)               |
| D-2 | Host-side write buffering for setOutput/setVar                                             | Enables atomic rollback on script failure; writes only applied after successful completion                                                                                                                                                                                   | Direct context mutation (would corrupt state on failure)                       |
| D-3 | Deep-copy via `ExternalCopy` + recursive freeze                                            | Prevents scripts from mutating upstream step results or shared state                                                                                                                                                                                                         | Shallow freeze (would leave nested objects mutable)                            |
| D-4 | Separate Dockerfile commit before isolated-vm addition                                     | Alpine builder + Debian production = native module crash; must fix first                                                                                                                                                                                                     | Bundling both changes (harder to rollback independently)                       |
| D-5 | Backward compat guard: empty `config.code` falls back to transform behavior                | Existing function nodes may have transform-style config                                                                                                                                                                                                                      | No guard (would break existing workflows on upgrade)                           |
| D-6 | Constants in `constants.ts`, not env vars for Phase 1                                      | Simpler; env var overrides can be added in Phase 2. Note: feature spec Section 11 lists these as env vars; Phase 1 uses constants per this decision.                                                                                                                         | Env-var-first (over-engineering for Phase 1)                                   |
| D-7 | Line/column info embedded in SCRIPT_ERROR message string, not as separate StepError fields | `WorkflowStepError` interface is shared across all step types; extending it with `line`/`column` couples it to script errors. The debug panel displays `error.message` as-is, so line/column info is visible. Format: `"SyntaxError: Unexpected token at line 3, column 12"` | Extending StepError interface (adds script-specific fields to a generic class) |
| D-8 | Pin `isolated-vm` to exact version (not semver range)                                      | Native modules can break across minor versions due to V8 ABI changes. Pin to latest stable at implementation time.                                                                                                                                                           | `^5.0.0` semver range (risky for native modules)                               |

### Key Interfaces & Types

```typescript
// NEW: apps/workflow-engine/src/executors/function-executor.ts

export interface FunctionStep {
  id: string;
  type: 'function';
  config: {
    code: string;
    inputVariables?: Array<{
      name: string;
      type: 'string' | 'number' | 'boolean' | 'json';
      value: string; // expression template e.g. "{{trigger.payload.items}}"
    }>;
    timeout?: number; // seconds, 5-60, default 10
  };
}

export interface FunctionResult {
  output: unknown;
  logs: Array<{ level: 'log' | 'warn' | 'error'; args: unknown[] }>;
  durationMs: number;
}

export async function executeFunctionStep(
  step: FunctionStep,
  ctx: WorkflowContextData,
): Promise<FunctionResult>;
```

### Module Boundaries

| Module                   | Responsibility                                                                               | Depends On                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `function-executor.ts`   | Create V8 isolate, inject context, run script, collect results                               | `isolated-vm`, `expression-resolver.ts`, `step-errors.ts`, `constants.ts` |
| `step-dispatcher.ts`     | Route `type: 'function'` to `executeFunctionStep`, wrap result                               | `function-executor.ts`                                                    |
| `canvas-to-steps.ts`     | Map canvas `function` node to engine `FunctionStep`                                          | `FunctionStep` type                                                       |
| `constants.ts`           | Export `FUNCTION_NODE_MEMORY_MB`, `FUNCTION_NODE_MAX_OUTPUT_BYTES`, `FUNCTION_NODE_MAX_LOGS` | None                                                                      |
| `FunctionNodeConfig.tsx` | Disable custom_script toggle with "Coming soon"                                              | None                                                                      |

---

## 2. File-Level Change Map

### New Files

| File                                                           | Purpose                                                                   | LOC Estimate |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------ |
| `apps/workflow-engine/src/executors/function-executor.ts`      | V8 sandbox execution, context injection, console capture, resource limits | ~200         |
| `apps/workflow-engine/src/__tests__/function-executor.test.ts` | Unit + integration tests (UT-1 to UT-20, INT-2 to INT-4, INT-6, INT-7)    | ~400         |
| `apps/workflow-engine/src/__tests__/canvas-to-steps.test.ts`   | Unit test for canvas-to-steps function mapping (UT-15)                    | ~50          |
| `apps/studio/e2e/workflows/workflow-function-node.spec.ts`     | E2E Playwright tests (E2E-1 to E2E-7)                                     | ~300         |

### Modified Files

| File                                                                        | Change Description                                                                                                                                                                                | Risk                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `apps/workflow-engine/Dockerfile`                                           | Switch builder from `node:24-alpine` to `node:22-slim`; change `apk add` to `apt-get install`                                                                                                     | Med (affects all workflow-engine builds) |
| `apps/workflow-engine/package.json`                                         | Add `isolated-vm` to dependencies                                                                                                                                                                 | Low                                      |
| `apps/workflow-engine/src/constants.ts`                                     | Add 3 function node constants                                                                                                                                                                     | Low                                      |
| `apps/workflow-engine/src/handlers/step-dispatcher.ts`                      | Add `FunctionStep` to `WorkflowStep` union (L49-61), add `case 'function':` to `dispatchStep` (L105-242) and `resolveStepInput` (L251-355), add `consoleLogs` to `StepDispatchResult`, add import | Med                                      |
| `apps/workflow-engine/src/handlers/canvas-to-steps.ts`                      | Change `function: 'transform'` to `function: 'function'` at L49, add `case 'function':` to `convertNodeToStep` (L267-393)                                                                         | Low                                      |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`                     | Extend `updateStepStatus` data parameter type to include `consoleLogs`, pass from `StepDispatchResult` to persistence                                                                             | Low                                      |
| `apps/workflow-engine/src/persistence/execution-store.ts`                   | Persist `consoleLogs` to `NodeExecution` document in `updateStepStatus` implementation                                                                                                            | Low                                      |
| `apps/workflow-engine/src/__tests__/step-dispatcher.test.ts`                | Add test for `function` dispatch routing (UT-16, UT-17)                                                                                                                                           | Low                                      |
| `apps/workflow-engine/src/__tests__/e2e-basic.test.ts`                      | Add function step to engine-level E2E tests (INT-1, INT-5, INT-8)                                                                                                                                 | Low                                      |
| `apps/studio/src/components/workflows/canvas/config/FunctionNodeConfig.tsx` | Disable custom_script button (L89), add "Coming soon" badge                                                                                                                                       | Low                                      |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Dockerfile & Dependency Setup

**Goal**: Switch the workflow-engine Dockerfile builder to Debian and add `isolated-vm` as a dependency.

**Tasks**:

1.1. In `apps/workflow-engine/Dockerfile`, change builder base from `node:24-alpine` to `node:22-slim` (L1) to match the production image (`gcr.io/distroless/nodejs22-debian12`). Native modules must be compiled against the same Node.js major version used at runtime. Change `apk add --no-cache python3 make g++` (L7) to `apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*`.

1.2. In `apps/workflow-engine/package.json`, add `"isolated-vm": "5.0.1"` (exact pin, per D-8) to `dependencies` (L17-41). Use the latest stable version at implementation time.

1.3. Run `pnpm install` to update the lockfile.

1.4. Run `pnpm build --filter=workflow-engine` to verify the build succeeds with the new dependency.

**Files Touched**:

- `apps/workflow-engine/Dockerfile` -- builder base image and package manager commands
- `apps/workflow-engine/package.json` -- add isolated-vm dependency
- `pnpm-lock.yaml` -- auto-updated by pnpm install

**Exit Criteria**:

- [ ] `pnpm build --filter=workflow-engine` succeeds with zero errors (note: builder is downgraded from Node 24 to Node 22 -- verify no Node 24-specific syntax in build scripts)
- [ ] `pnpm install` completes without errors (lockfile updated)
- [ ] `node -e "require('isolated-vm')"` succeeds in the workflow-engine directory (native module compiled)

**Test Strategy**:

- No new tests. This phase is infrastructure only.

**Rollback**: Revert Dockerfile and package.json changes. Run `pnpm install` to restore lockfile.

---

### Phase 2: Function Executor Core

**Goal**: Implement the function-executor.ts with V8 sandbox execution, context injection, write buffering, console capture, and resource limits.

**Tasks**:

2.1. Create `apps/workflow-engine/src/executors/function-executor.ts` with the `FunctionStep`, `FunctionResult` interfaces and `executeFunctionStep` function.

2.2. Implement isolate creation: `new ivm.Isolate({ memoryLimit: FUNCTION_NODE_MEMORY_MB })`.

2.3. Implement context injection: deep-copy `WorkflowContextData` via `ExternalCopy`, recursively freeze, assign to `workflow` global in isolate context.

2.4. Implement `workflow.setOutput(value)` as a host-side callback that buffers the value. Last-call-wins semantics. Validate JSON-serializability and output size limit (`FUNCTION_NODE_MAX_OUTPUT_BYTES`).

2.5. Implement `workflow.setVar(name, value)` as a host-side callback that buffers writes. Applied atomically after successful script completion.

2.6. Implement `console.log/warn/error` capture as host-side callbacks. Buffer log entries up to `FUNCTION_NODE_MAX_LOGS`.

2.7. Implement input variable resolution: for each `inputVariable`, call `resolveExpressionTyped(variable.value, ctx)`, coerce to declared type (`string`, `number`, `boolean`, `json`). Throw `WorkflowStepError(SCRIPT_ERROR)` on coercion failure with variable name and expected type in message. Inject as top-level variables in isolate scope.

2.8. Implement script execution: compile code with `isolate.compileScriptSync()`, run with `script.runSync({ timeout: step.config.timeout * 1000 })`. If no `setOutput` was called, use the script's return value as output. If neither, output is `undefined`.

2.9. Implement error handling: catch V8 errors, extract line/column from stack trace, throw `WorkflowStepError(SCRIPT_ERROR, message)` with line/column details. On error, discard all buffered writes (atomic rollback).

2.10. Implement cleanup: dispose isolate in a `finally` block.

2.11. Implement backward compatibility guard: if `step.config.code` is undefined/empty AND `step.config.inputExpression` exists, delegate to `executeTransform()` for backward compat with legacy function nodes.

2.12. Add constants to `apps/workflow-engine/src/constants.ts`:

```typescript
export const FUNCTION_NODE_MEMORY_MB = 128;
export const FUNCTION_NODE_MAX_OUTPUT_BYTES = 1_048_576;
export const FUNCTION_NODE_MAX_LOGS = 100;
```

**Files Touched**:

- `apps/workflow-engine/src/executors/function-executor.ts` -- NEW (~200 LOC)
- `apps/workflow-engine/src/constants.ts` -- add 3 constants

**Exit Criteria**:

- [ ] `pnpm build --filter=workflow-engine` succeeds with zero TypeScript errors
- [ ] `FunctionStep` and `FunctionResult` types are exported
- [ ] `executeFunctionStep` function is exported and compiles
- [ ] The executor does NOT import any codebase component to mock -- it uses real `isolated-vm`
- [ ] Constants `FUNCTION_NODE_MEMORY_MB`, `FUNCTION_NODE_MAX_OUTPUT_BYTES`, `FUNCTION_NODE_MAX_LOGS` are exported from `constants.ts`

**Test Strategy**:

- No tests in this phase. Tests are in Phase 5. The executor is verified by build success and type checking.

**Rollback**: Delete `function-executor.ts`, remove constants from `constants.ts`.

---

### Phase 3: Engine Wiring (Dispatcher + Canvas-to-Steps)

**Goal**: Wire the function executor into the step dispatcher and update the canvas-to-steps mapping.

**Tasks**:

3.1. In `apps/workflow-engine/src/handlers/step-dispatcher.ts`:

- Add import: `import { executeFunctionStep, type FunctionStep } from '../executors/function-executor.js';`
- Add `FunctionStep` to the `WorkflowStep` union at L49-61.
- Add `case 'function':` to `dispatchStep()` switch at ~L236, after the `transform` case and before the `default: never` check at L237. Note: construct `input` inline (consistent with all other cases -- do NOT call `resolveStepInput` from within `dispatchStep`):
  ```typescript
  case 'function': {
    const result = await executeFunctionStep(step, ctx);
    return {
      type: 'function',
      output: result.output,
      input: { code: step.config.code?.substring(0, 200) ?? '(no code)' },
      consoleLogs: result.logs,      // FR-5: pass logs to persistence
      responseTimeMs: result.durationMs,
    };
  }
  ```
- Add `consoleLogs?: Array<{ level: string; args: unknown[] }>` to the `StepDispatchResult` interface (L64-83). This is a new optional field used only by function steps.
- Add `case 'function':` to `resolveStepInput()` switch:

  ```typescript
  case 'function': {
    const codeSnippet = step.config.code?.substring(0, 200) ?? '(no code)';
    const resolvedVars: Record<string, unknown> = {};
    for (const v of step.config.inputVariables ?? []) {
      try { resolvedVars[v.name] = resolveExpressionTyped(v.value, ctx); } catch { resolvedVars[v.name] = `<error resolving ${v.value}>`; }
    }
    return { code: codeSnippet, inputVariables: resolvedVars };
  }
  ```

  3.2. In `apps/workflow-engine/src/handlers/canvas-to-steps.ts` (**MUST be in the same commit as 3.2a and 3.2b** -- if the mapping changes without the case, `convertNodeToStep` falls through to `default: return null`, silently dropping all function nodes):

- 3.2a. Change L49 from `function: 'transform'` to `function: 'function'`.
- 3.2b. Add `case 'function':` to `convertNodeToStep()` (after the existing `transform` case). This follows the established `as unknown as WorkflowStep` cast pattern used by `loop` and `transform` cases:

  ```typescript
  case 'function':
    return {
      id: node.id,
      type: 'function',
      config: {
        code: config.code ?? '',
        inputVariables: config.inputVariables ?? [],
        timeout: config.timeout ?? 10,
      },
    } as unknown as WorkflowStep;
  ```

  3.3. **Console logs persistence path** (FR-5): The full flow is `executor -> StepDispatchResult.consoleLogs -> workflow-handler -> persistence -> NodeExecution -> debug panel`. Implementation:

- In `apps/workflow-engine/src/handlers/workflow-handler.ts`, extend the `data` parameter type of the `updateStepStatus` completed call (~L361-368) to include `consoleLogs?: Array<{ level: string; args: unknown[] }>`. Pass `consoleLogs: dispatchResult.consoleLogs` in the extras object.
- In the `ExecutionStore` (which implements `ExecutionPersistence`), persist `consoleLogs` to the `NodeExecution` document's extras/output field.
- The Studio debug panel (`StepLogItem.tsx`) already displays arbitrary step result data. Console logs will be accessible in the step's execution record. If a dedicated console log section is needed in the debug panel, add it to `StepLogItem.tsx` (check if it already renders a logs section for other step types).

**Note on FunctionStepDetail component**: The feature spec delivery plan (3.2) lists a `FunctionStepDetail` component for the debug panel. For Phase 1, the existing debug panel output viewer can display function output and console logs from the NodeExecution record. A dedicated `FunctionStepDetail` component (with code display, formatted console output) is a UI enhancement that can be added as a follow-up if the existing viewer is insufficient. The LLD does not block on this.

**Files Touched**:

- `apps/workflow-engine/src/handlers/step-dispatcher.ts` -- add import, union member, 2 switch cases, add `consoleLogs` to `StepDispatchResult`
- `apps/workflow-engine/src/handlers/canvas-to-steps.ts` -- change mapping, add convertNodeToStep case
- `apps/workflow-engine/src/handlers/workflow-handler.ts` -- extend `updateStepStatus` data type, pass `consoleLogs` through to persistence

**Exit Criteria**:

- [ ] `pnpm build --filter=workflow-engine` succeeds with zero TypeScript errors
- [ ] The exhaustive `never` check in `dispatchStep()` (L237-239) compiles (proves `function` case is handled)
- [ ] The `resolveStepInput()` function has a `case 'function':` block (note: `resolveStepInput` has `default: return null`, not a `never` check, so there is no compile-time safety -- manually verify the case is present. Automated verification deferred to UT-17 in Phase 5.)
- [ ] `FunctionStep` is a member of the exported `WorkflowStep` union

**Test Strategy**:

- No new tests in this phase. Existing tests must still pass: `pnpm test --filter=workflow-engine`.

**Note**: After the mapping change, the `case 'transform':` in `convertNodeToStep` (L336-341) becomes dead code for canvas-originated workflows (no canvas nodeType maps to `'transform'`). Leave it for backward compat with API-created workflows that might specify `type: 'transform'` directly. Flag for cleanup in a future refactor.

**Rollback**: Revert step-dispatcher.ts, canvas-to-steps.ts, and workflow-handler.ts changes. The function executor file remains but becomes dead code.

---

### Phase 4: Studio UI Update

**Goal**: Disable the custom_script mode toggle with a "Coming soon" indicator in the Function node config panel.

**Tasks**:

4.1. In `apps/studio/src/components/workflows/canvas/config/FunctionNodeConfig.tsx`:

- At the "Custom Script" button (~L89), add `disabled` attribute and `opacity-50 cursor-not-allowed` classes.
- Add a "Coming soon" text suffix or a small badge next to the button text. Note: the existing FunctionNodeConfig.tsx uses no i18n (all strings are hardcoded English). For consistency with the existing component, use a hardcoded string for Phase 1. Converting all strings to i18n keys is out of scope but documented as tech debt.
- Remove or guard the `onClick` handler so clicking the disabled button does nothing.

**Files Touched**:

- `apps/studio/src/components/workflows/canvas/config/FunctionNodeConfig.tsx` -- disable button, add badge

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with zero errors
- [ ] Visually verified: custom_script button is disabled with "Coming soon" indicator (manual check or E2E-7)

**Test Strategy**:

- E2E-7 covers this in Phase 7. No unit test needed for a UI disable.

**Rollback**: Revert the FunctionNodeConfig.tsx change.

---

### Phase 5: Unit Tests

**Goal**: Implement all 20 unit test scenarios for the function executor, canvas-to-steps, and step-dispatcher.

**Tasks**:

5.1. Create `apps/workflow-engine/src/__tests__/function-executor.test.ts` with test scenarios UT-1 through UT-14 and UT-18 through UT-20:

- UT-1: Basic execution (setOutput produces output)
- UT-2: Context injection (all fields accessible)
- UT-3: Context frozen (mutations throw TypeError)
- UT-4: setOutput with structured data
- UT-5: setOutput last-call-wins
- UT-6: setVar atomic writes
- UT-7: Console capture (log, warn, error with levels)
- UT-8: Timeout enforcement (while(true) terminated after 1s)
- UT-9: Memory limit enforcement (OOM with reduced 8MB limit for test speed)
- UT-10: Output size limit (2MB string rejected)
- UT-11: Input variables resolved and type-coerced
- UT-12: Input variable coercion failure (SCRIPT_ERROR with variable name)
- UT-13: Syntax error (SCRIPT_ERROR with line/column)
- UT-14: Runtime error (SCRIPT_ERROR with stack trace)
- UT-18: Return value becomes output when setOutput not called
- UT-19: Output defaults to undefined when neither used
- UT-20: setOutput takes precedence over return value

  5.2. Create `apps/workflow-engine/src/__tests__/canvas-to-steps.test.ts` with UT-15:

- UT-15: Canvas `function` node maps to `function` step type (not `transform`)

  5.3. Update `apps/workflow-engine/src/__tests__/step-dispatcher.test.ts` with UT-16 and UT-17:

- UT-16: step-dispatcher routes `function` to FunctionExecutor
- UT-17: resolveStepInput returns code snippet and resolved inputs

**Files Touched**:

- `apps/workflow-engine/src/__tests__/function-executor.test.ts` -- NEW (~350 LOC)
- `apps/workflow-engine/src/__tests__/canvas-to-steps.test.ts` -- NEW (~50 LOC)
- `apps/workflow-engine/src/__tests__/step-dispatcher.test.ts` -- add 2 test cases (~40 LOC)

**Exit Criteria**:

- [ ] All 20 unit tests pass: `pnpm test --filter=workflow-engine -- --grep "function"`
- [ ] Tests use real `isolated-vm` (no vi.mock of isolated-vm or internal packages)
- [ ] UT-8 (timeout) completes in <5s (not hanging)
- [ ] No existing tests regressed: `pnpm test --filter=workflow-engine`

**Test Strategy**:

- Pure function tests following `transform-executor.test.ts` pattern: build `WorkflowContextData` inline, call executor, assert result.
- Use `makeCtx()` helper pattern from existing tests.
- For UT-9 (OOM), reduce memory limit to 8MB to avoid slow/flaky tests.

**Rollback**: Delete new test files, revert step-dispatcher.test.ts changes.

---

### Phase 6: Integration Tests (Engine-Level E2E)

**Goal**: Implement integration tests that exercise the full dispatch chain through `runWorkflow`.

**Tasks**:

6.1. In `apps/workflow-engine/src/__tests__/function-executor.test.ts`, add integration test scenarios INT-2 through INT-4, INT-6, INT-7:

- INT-2: Sandbox isolation (Node.js globals undefined)
- INT-3: Atomic rollback (failed script, setVar writes discarded)
- INT-4: Frozen context (mutations rejected)
- INT-6: Input variable coercion failure propagation
- INT-7: Concurrent cross-tenant isolation (Promise.all)

  6.2. In `apps/workflow-engine/src/__tests__/e2e-basic.test.ts`, add engine-level integration tests INT-1, INT-5, INT-8:

- INT-1: Full dispatch cycle (`runWorkflow` with function step, verify output)
- INT-5: Error propagation (timeout through dispatch to persistence/publisher)
- INT-8: Return value through dispatch (no setOutput)

**Files Touched**:

- `apps/workflow-engine/src/__tests__/function-executor.test.ts` -- add integration describe block (~150 LOC)
- `apps/workflow-engine/src/__tests__/e2e-basic.test.ts` -- add 3 test cases (~100 LOC)

**Exit Criteria**:

- [ ] All 8 integration tests pass
- [ ] INT-7 (concurrent tenant isolation) passes with `Promise.all` (no context leakage)
- [ ] INT-5 verifies `persistence.updateStepStatus` called with `'failed'` and SCRIPT_ERROR
- [ ] No existing tests regressed

**Test Strategy**:

- INT-2 through INT-7: Direct executor calls with real `isolated-vm`.
- INT-1, INT-5, INT-8: Use `runWorkflow()` with `makePersistence()` / `makePublisher()` / `makeDeps()` pattern from existing e2e-basic.test.ts.

**Rollback**: Remove added test cases.

---

### Phase 7: E2E Tests (Playwright)

**Goal**: Implement browser E2E tests for the function node via Studio UI.

**Tasks**:

7.1. Create `apps/studio/e2e/workflows/workflow-function-node.spec.ts` with Playwright tests:

- E2E-1: Start -> Function -> End with data transform (filter array, check output + console)
- E2E-2: Function with inputVariables from trigger payload
- E2E-3: Function timeout (while(true), 5s timeout, verify SCRIPT_ERROR)
- E2E-4: Function syntax error (unclosed brace, verify SCRIPT_ERROR with line info)
- E2E-5: Function output referenced by downstream condition
- E2E-6: Function inside loop body with iteration variable
- E2E-7: Custom_script toggle disabled with "Coming soon"

  7.2. Follow established patterns from `helpers.ts`: `loginAndSetup`, `navigateToWorkflows`, `createWorkflowViaUI`, `waitForCanvasReady`, `addNodeViaHandleMenu`, `saveWorkflow`, `runWorkflow`, `waitForDebugPanel`.

  7.3. Use Zustand store via `page.evaluate()` for node configuration (accepted Playwright pattern per test spec).

**Files Touched**:

- `apps/studio/e2e/workflows/workflow-function-node.spec.ts` -- NEW (~300 LOC)

**Exit Criteria**:

- [ ] All 7 E2E tests pass with real services (Studio, Runtime, Workflow Engine, Restate, MongoDB, Redis)
- [ ] No vi.mock or jest.mock in the test file
- [ ] No direct DB access (Mongoose models) in the test file
- [ ] Tests clean up created workflows via `deleteWorkflowFromList`
- [ ] E2E-1 verifies structured output (object with arrays), not just plain strings

**Test Strategy**:

- Full browser E2E via Playwright against real running services.
- Auth via dev-login (`loginAndSetup`).
- Workflow creation via UI, node config via Zustand store, execution via Run dialog.
- Assertions via debug panel DOM content.

**Rollback**: Delete the spec file.

---

## 4. Wiring Checklist

- [ ] `FunctionStep` type added to `WorkflowStep` union in `step-dispatcher.ts` (Phase 3)
- [ ] `case 'function':` added to `dispatchStep()` switch in `step-dispatcher.ts` (Phase 3)
- [ ] `case 'function':` added to `resolveStepInput()` switch in `step-dispatcher.ts` (Phase 3)
- [ ] `executeFunctionStep` imported in `step-dispatcher.ts` from `../executors/function-executor.js` (Phase 3)
- [ ] `function: 'function'` mapping updated in `NODE_TYPE_TO_STEP_TYPE` in `canvas-to-steps.ts` (Phase 3)
- [ ] `case 'function':` added to `convertNodeToStep()` in `canvas-to-steps.ts` (Phase 3)
- [ ] `FUNCTION_NODE_MEMORY_MB`, `FUNCTION_NODE_MAX_OUTPUT_BYTES`, `FUNCTION_NODE_MAX_LOGS` exported from `constants.ts` (Phase 2)
- [ ] `isolated-vm` added to `apps/workflow-engine/package.json` dependencies (Phase 1)
- [ ] Dockerfile builder switched to Debian-based image (Phase 1)
- [ ] `consoleLogs` field added to `StepDispatchResult` interface (Phase 3)
- [ ] `consoleLogs` field added to `updateStepStatus` data parameter type in `ExecutionPersistence` interface (Phase 3)
- [ ] `ExecutionStore.updateStepStatus` persists `consoleLogs` to `NodeExecution` document (Phase 3)
- [ ] `consoleLogs` passed through `workflow-handler.ts` to `updateStepStatus` extras (Phase 3)
- [ ] `custom_script` button disabled with "Coming soon" in `FunctionNodeConfig.tsx` (Phase 4)
- [ ] No new routes needed (internal executor)
- [ ] No new models needed (uses existing NodeExecution)
- [ ] No new middleware needed
- [ ] No new workers needed (synchronous in Restate handler)
- [ ] No OpenAPI changes needed (no new endpoints)

---

## 5. Cross-Phase Concerns

### Database Migrations

None. No new collections or schema changes.

### Feature Flags

None. Per HLD Section 4 concern #10: "No feature flag -- seamless upgrade."

### Configuration Changes

New constants in `apps/workflow-engine/src/constants.ts` (Phase 2):

| Constant                         | Value       | Purpose                           |
| -------------------------------- | ----------- | --------------------------------- |
| `FUNCTION_NODE_MEMORY_MB`        | `128`       | V8 isolate heap limit             |
| `FUNCTION_NODE_MAX_OUTPUT_BYTES` | `1_048_576` | Max JSON-serialized output size   |
| `FUNCTION_NODE_MAX_LOGS`         | `100`       | Max console entries per execution |

No new environment variables for Phase 1.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 15 FRs from feature spec implemented
- [ ] All 20 unit tests passing (UT-1 through UT-20)
- [ ] All 8 integration tests passing (INT-1 through INT-8)
- [ ] All 7 E2E tests passing (E2E-1 through E2E-7)
- [ ] `pnpm build --filter=workflow-engine` succeeds with zero errors
- [ ] `pnpm build --filter=studio` succeeds with zero errors
- [ ] `pnpm test --filter=workflow-engine` passes with no regressions
- [ ] Feature spec status updated from PLANNED to ALPHA
- [ ] Parent `docs/features/workflows.md` updated to include `function` as 13th step type
- [ ] `apps/studio/e2e/workflows/agents.md` updated with function node coverage
- [ ] Dockerfile builds successfully with `isolated-vm` native module
- [ ] **Deviation**: Feature spec delivery plan task 3.2 (`FunctionStepDetail` debug panel component) deferred to follow-up. FR-5 (console capture) is satisfied by storing logs in `NodeExecution` and displaying via existing debug panel output viewer.

---

## 7. Open Questions

1. **~~Node.js version mismatch~~**: RESOLVED. Builder changed to `node:22-slim` to match production `nodejs22-debian12`. Both stages now use Node 22.

2. **Async/await in user scripts**: The current design uses `runSync`. If async support is added later, the executor would need `runAsync` with a different timeout mechanism. Phase 1 defers this.

3. **Backward compatibility testing**: The D-5 guard (empty `config.code` falls back to transform) needs manual verification with any existing workflows that use function nodes. No automated test for this exists.

4. **~~`isolated-vm` version pinning~~**: RESOLVED per D-8. Pin to exact version at implementation time.
