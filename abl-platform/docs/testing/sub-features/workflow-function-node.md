# Test Specification: Workflow Function Node with Context Injection

**Feature Spec**: `docs/features/sub-features/workflow-function-node.md`
**HLD**: `docs/specs/workflow-function-node.hld.md`
**LLD**: `docs/plans/2026-04-07-workflow-function-node-impl-plan.md`
**Status**: ALPHA
**Last Updated**: 2026-04-07

---

## 1. Coverage Matrix

| FR    | Description                                                                                           | Unit                   | Integration | E2E      | Status |
| ----- | ----------------------------------------------------------------------------------------------------- | ---------------------- | ----------- | -------- | ------ |
| FR-1  | Execute user-written JS inside isolated-vm V8 isolate                                                 | ✅ UT-1                | ✅ INT-1    | ✅ E2E-1 | TESTED |
| FR-2  | Inject frozen WorkflowContextData as `workflow` global                                                | ✅ UT-2, UT-3          | ✅ INT-4    | ✅ E2E-1 | TESTED |
| FR-3  | `workflow.setOutput(value)` sets step output (JSON-serializable, last-call-wins)                      | ✅ UT-4, UT-5          | ✅ INT-1    | ✅ E2E-1 | TESTED |
| FR-4  | `workflow.setVar(name, value)` writes to ctx.vars atomically after success                            | ✅ UT-6                | ✅ INT-3    | ✅ E2E-6 | TESTED |
| FR-5  | Capture console.log/warn/error in step result                                                         | ✅ UT-7                | --          | ✅ E2E-1 | TESTED |
| FR-6  | Enforce configured timeout (5-60s), return SCRIPT_ERROR on exceed                                     | ✅ UT-8                | ✅ INT-5    | ✅ E2E-3 | TESTED |
| FR-7  | Enforce 128MB memory limit, terminate isolate on OOM                                                  | ✅ UT-9                | ✅ INT-5    | -- (1)   | TESTED |
| FR-8  | Enforce 1MB output size limit                                                                         | ✅ UT-10               | --          | -- (1)   | TESTED |
| FR-9  | Resolve inputVariables with expression + type coercion; SCRIPT_ERROR on coercion failure              | ✅ UT-11, UT-12        | ✅ INT-6    | ✅ E2E-2 | TESTED |
| FR-10 | Surface errors as StepError with code SCRIPT_ERROR, line/column from V8                               | ✅ UT-13, UT-14        | ✅ INT-5    | ✅ E2E-4 | TESTED |
| FR-11 | canvas-to-steps maps `function` to `function` step type (not `transform`)                             | ✅ UT-15               | --          | --       | TESTED |
| FR-12 | step-dispatcher routes `function` to FunctionExecutor, WorkflowStep union updated                     | ✅ UT-16               | ✅ INT-1    | --       | TESTED |
| FR-13 | resolveStepInput returns code snippet + resolved inputs for debug panel                               | ✅ UT-17               | --          | ✅ E2E-5 | TESTED |
| FR-14 | Return value becomes output if setOutput not called; undefined if neither; setOutput takes precedence | ✅ UT-18, UT-19, UT-20 | ✅ INT-8    | --       | TESTED |
| FR-15 | custom_script mode toggle disabled with "Coming soon"                                                 | --                     | --          | ✅ E2E-7 | TESTED |

**(1)** OOM and output-size tests are unreliable in Playwright E2E due to timing and resource variability. Coverage at unit + integration tier with real `isolated-vm` is sufficient -- these limits are enforced by the executor, not by the HTTP layer.

---

## 2. E2E Test Scenarios (MANDATORY)

All E2E tests live in `apps/studio/e2e/workflows/workflow-function-node.spec.ts` and use Playwright. They follow the established pattern: `loginAndSetup` -> `navigateToWorkflows` -> `createWorkflowViaUI` -> `waitForCanvasReady` -> build flow -> `saveWorkflow` -> `runWorkflow` -> assert debug panel -> cleanup.

**Note on Zustand store usage**: Where UI forms are incomplete (e.g., code editor for function nodes has no Playwright-accessible input), `page.evaluate(() => useWorkflowStore.getState().updateNodeConfig(...))` is the accepted Playwright workaround -- this is NOT a mock, it drives the real store through the browser context. This pattern is established in `workflow-tool-node.spec.ts` and `workflow-comprehensive.spec.ts`.

### E2E-1: Function node transforms data in a Start -> Function -> End pipeline

- **Preconditions**: Studio, Runtime, Workflow Engine, Restate, MongoDB, Redis running. Dev-login available.
- **Auth Context**: `loginAndSetup(page)` -> dev-login as `workflow-canvas@e2e-smoke.test`, tenant T1, project P1.
- **Steps**:
  1. `loginAndSetup(page)` to obtain `projectId` and `token`.
  2. `navigateToWorkflows(page)` -> `createWorkflowViaUI(page, 'FnE2E_Transform_${Date.now()}')`.
  3. `waitForCanvasReady(page)`.
  4. Add a Function node after Start via `addNodeViaHandleMenu(page, 'function', ...)` or Zustand store.
  5. Configure Start node with an input variable: `items` (type: json, default: `[{"name":"a","active":true},{"name":"b","active":false}]`).
  6. Configure Function node code via Zustand store:

  ```javascript
  const items = workflow.trigger.payload.items;
  const active = items.filter((i) => i.active);
  console.log('Filtered', active.length, 'items');
  workflow.setOutput({ filtered: active, count: active.length });
  ```

  7. Connect Function -> End node (if not auto-connected).
  8. `saveWorkflow(page)`.
  9. `runWorkflow(page, { items: [{"name":"a","active":true},{"name":"b","active":false}] })`.
  10. `waitForDebugPanel(page)`.
  11. Assert: Function step shows status `completed` in debug panel.
  12. Assert: Function step output contains `{ filtered: [{"name":"a","active":true}], count: 1 }`.
  13. Assert: Console log section shows `Filtered 1 items`.

- **Expected Result**: Workflow completes. Function node output is `{ filtered: [{name:"a",active:true}], count: 1 }`. Console log captured. Downstream End node receives the output.
- **Isolation Check**: Only T1/P1 data visible. No cross-tenant leakage (verified by single-tenant test context).

### E2E-2: Function node with inputVariables resolved from trigger payload

- **Preconditions**: Same as E2E-1.
- **Auth Context**: Tenant T1, project P1 via `loginAndSetup`.
- **Steps**:
  1. Login, create workflow, wait for canvas.
  2. Build flow: Start -> Function -> End.
  3. Configure Start with input: `orderId` (type: string, default: `"ORD-123"`).
  4. Configure Function node:
  - `inputVariables`: `[{ name: "id", type: "string", value: "{{trigger.payload.orderId}}" }]`
  - `code`: `workflow.setOutput({ processedId: id.toUpperCase() });`
  5. Save, run with `{ orderId: "ord-789" }`, wait for debug panel.
  6. Assert: Function output is `{ processedId: "ORD-789" }` (uses runtime value, not default; uppercase confirms transform ran).
  7. Assert: `id` variable was correctly resolved from expression.
- **Expected Result**: inputVariables resolve expressions against WorkflowContextData. The aliased `id` variable contains the trigger payload value.

### E2E-3: Function node timeout produces SCRIPT_ERROR

- **Preconditions**: Same as E2E-1.
- **Auth Context**: Tenant T1, project P1 via `loginAndSetup`.
- **Steps**:
  1. Login, create workflow, wait for canvas.
  2. Build flow: Start -> Function -> End.
  3. Configure Function node:
  - `code`: `while(true) { /* infinite loop */ }`
  - `timeout`: `5` (seconds)
  4. Save, run, wait for debug panel.
  5. Assert: Function step shows status `failed`.
  6. Assert: Error message contains `"timed out"` or `"timeout"`.
  7. Assert: Error code is `SCRIPT_ERROR`.
  8. Assert: Workflow execution status is `failed` (no downstream steps execute).
- **Expected Result**: The isolate is terminated after 5 seconds. SCRIPT_ERROR with timeout message. Workflow fails.

### E2E-4: Function node syntax error produces SCRIPT_ERROR with line info

- **Preconditions**: Same as E2E-1.
- **Auth Context**: Tenant T1, project P1 via `loginAndSetup`.
- **Steps**:
  1. Login, create workflow, wait for canvas.
  2. Build flow: Start -> Function -> End.
  3. Configure Function node code: `const x = {` (syntax error -- unclosed brace).
  4. Save, run, wait for debug panel.
  5. Assert: Function step shows status `failed`.
  6. Assert: Error code is `SCRIPT_ERROR`.
  7. Assert: Error message contains `"SyntaxError"` or `"Unexpected"`.
  8. Assert: Error includes line number information.
- **Expected Result**: V8 compilation fails. SCRIPT_ERROR with syntax error details and line number.

### E2E-5: Function node output referenced by downstream condition node

- **Preconditions**: Same as E2E-1.
- **Auth Context**: Tenant T1, project P1 via `loginAndSetup`.
- **Steps**:
  1. Login, create workflow, wait for canvas.
  2. Build flow: Start -> Function -> Condition -> End (true branch) / End (false branch).
  3. Configure Function code: `workflow.setOutput({ approved: true, score: 85 });`
  4. Configure Condition: expression `{{steps.<functionNodeId>.output.approved}}` equals `true` (extract the actual node ID from the canvas state after adding the Function node, as IDs are auto-generated).
  5. Save, run, wait for debug panel.
  6. Assert: Function step completed with output `{ approved: true, score: 85 }`.
  7. Assert: Condition step evaluated to `true` branch.
  8. Assert: Workflow completed successfully via the true branch.
- **Expected Result**: Function output is accessible via `{{steps.FN0001.output.approved}}`. Condition correctly evaluates the expression and branches.

### E2E-6: Function node inside loop body with iteration variable access

- **Preconditions**: Same as E2E-1.
- **Auth Context**: Tenant T1, project P1 via `loginAndSetup`.
- **Steps**:
  1. Login, create workflow, wait for canvas.
  2. Build flow: Start -> Loop -> (Function inside loop body) -> End.
  3. Configure Start with input: `items` (json, default: `[1, 2, 3]`).
  4. Configure Loop: collection `{{trigger.payload.items}}`, item variable `item`.
  5. Configure Function inside loop:

  ```javascript
  const doubled = workflow.vars.item * 2;
  workflow.setOutput({ doubled });
  ```

  6. Save, run with `{ items: [1, 2, 3] }`, wait for debug panel.
  7. Assert: Loop completed 3 iterations.
  8. Assert: Function executed per iteration with correct `item` value.

- **Expected Result**: Function node correctly accesses loop iteration variable via `workflow.vars.item`. Each iteration produces the correct doubled value.

### E2E-7: Custom_script mode toggle shows "Coming soon" indicator

- **Preconditions**: Same as E2E-1.
- **Auth Context**: Tenant T1, project P1 via `loginAndSetup`.
- **Steps**:
  1. Login, create workflow, wait for canvas.
  2. Add a Function node.
  3. Select the Function node to open the config panel.
  4. Assert: The mode toggle or custom_script option is visible but disabled.
  5. Assert: A "Coming soon" label/tooltip is displayed near the custom_script option.
- **Expected Result**: custom_script mode is visible but not selectable. "Coming soon" indicator is present.

---

## 3. Integration Test Scenarios (MANDATORY)

Integration tests use real `isolated-vm` -- no mocking of the sandbox. Executor-level tests in `apps/workflow-engine/src/__tests__/function-executor.test.ts`. Engine-level tests in `apps/workflow-engine/src/__tests__/e2e-basic.test.ts`.

### INT-1: Full dispatch cycle -- step-dispatcher routes `function` to FunctionExecutor

- **Boundary**: `step-dispatcher.ts` -> `function-executor.ts` -> `isolated-vm`
- **Setup**: Build `WorkflowExecutionInput` with a `FunctionStep` containing code: `workflow.setOutput({ sum: 1 + 2 })`. Inject `makePersistence()` and `makePublisher()`.
- **Steps**:
  1. Call `runWorkflow(input, 'exec-fn-01', deps)` with the function step.
  2. Assert `result.status === 'completed'`.
  3. Assert `result.context.steps['fn-node'].output === { sum: 3 }`.
  4. Assert `persistence.updateStepStatus` was called with `'completed'` for the function step.
- **Expected Result**: The dispatcher routes `type: 'function'` to `FunctionExecutor`. The executor runs the code in a real V8 isolate and returns the output.
- **Failure Mode**: If `function` case missing in `dispatchStep()`, the step fails with `unknown step type`.

### INT-2: Sandbox isolation -- Node.js globals are undefined

- **Boundary**: `function-executor.ts` -> `isolated-vm` V8 isolate
- **Setup**: Build a `FunctionStep` with code that tests for Node.js globals.
- **Steps**:
  1. Execute with code:

  ```javascript
  workflow.setOutput({
    hasRequire: typeof require !== 'undefined',
    hasProcess: typeof process !== 'undefined',
    hasFs: typeof fs !== 'undefined',
    hasBuffer: typeof Buffer !== 'undefined',
    hasSetTimeout: typeof setTimeout !== 'undefined',
    hasFetch: typeof fetch !== 'undefined',
  });
  ```

  2. Assert output: all values are `false`.
  3. Execute with code: `require('fs')` and verify SCRIPT_ERROR.
  4. Execute with code: `process.exit(1)` and verify SCRIPT_ERROR.

- **Expected Result**: All Node.js globals are undefined inside the isolate. Attempting to use them produces `ReferenceError`.
- **Failure Mode**: If the isolate accidentally inherits host globals, scripts could perform I/O or crash the process.

### INT-3: Atomic rollback -- failed script does not apply setVar writes

- **Boundary**: `function-executor.ts` -> host-side write buffer -> `WorkflowContextData.vars`
- **Setup**: Build `WorkflowContextData` with `vars: { counter: 0 }`. Code calls `setVar('counter', 99)` then throws.
- **Steps**:
  1. Execute with code:

  ```javascript
  workflow.setVar('counter', 99);
  throw new Error('intentional failure');
  ```

  2. Assert: The executor returns a SCRIPT_ERROR result.
  3. Assert: `ctx.vars.counter` is still `0` (not `99`).
  4. Assert: No output was set.

- **Expected Result**: Write buffer is discarded on script failure. Context vars remain unchanged.
- **Failure Mode**: If writes are applied before script completion, partial state corrupts downstream steps.

### INT-4: Frozen context -- script cannot mutate workflow.steps or workflow.trigger

- **Boundary**: `function-executor.ts` -> frozen `WorkflowContextData` inside isolate
- **Setup**: Build context with `steps: { API0001: { output: { items: [1,2,3] }, status: 'completed' } }`.
- **Steps**:
  1. Execute with code:

  ```javascript
  try {
    workflow.steps.API0001.output.items.push(4);
  } catch (e) {
    console.error('mutate failed:', e.message);
  }
  try {
    workflow.trigger.payload.key = 'hacked';
  } catch (e) {
    console.error('trigger mutate failed:', e.message);
  }
  workflow.setOutput({ stepsLength: workflow.steps.API0001.output.items.length });
  ```

  2. Assert: Output is `{ stepsLength: 3 }` (not 4 -- mutation was rejected).
  3. Assert: Console error captured with "mutate failed" messages.
  4. Verify original context is unchanged after execution.

- **Expected Result**: Deep-frozen snapshot rejects all mutations. Original context is untouched.
- **Failure Mode**: If context is not properly frozen, scripts can corrupt shared state.

### INT-5: Error propagation through dispatch -- SCRIPT_ERROR reaches persistence and publisher

- **Boundary**: `function-executor.ts` -> `step-dispatcher.ts` -> `ExecutionPersistence` + `StatusPublisher`
- **Setup**: Build `WorkflowExecutionInput` with a function step that times out (code: `while(true){}`, timeout: 1s).
- **Steps**:
  1. Call `runWorkflow(input, 'exec-fn-err', deps)`.
  2. Assert `result.status === 'failed'`.
  3. Assert `result.context.steps['fn-node'].error.code === 'SCRIPT_ERROR'`.
  4. Assert `result.context.steps['fn-node'].error.message` contains `'timeout'` or `'timed out'`.
  5. Assert `persistence.updateStepStatus` was called with `'failed'` and the error.
  6. Assert `publisher.publish` was called with a `step.failed` event.
- **Expected Result**: Timeout error propagates correctly through the full dispatch chain. Persistence and publisher receive the error.
- **Failure Mode**: If error propagation is broken, steps appear stuck in `running` state.

### INT-6: Input variable coercion failure produces SCRIPT_ERROR with variable name

- **Boundary**: `function-executor.ts` -> expression resolver -> type coercion
- **Setup**: Build a `FunctionStep` with `inputVariables: [{ name: "count", type: "number", value: "{{trigger.payload.text}}" }]`. Context: `trigger.payload.text = "not-a-number"`.
- **Steps**:
  1. Execute the function step.
  2. Assert: Result is a SCRIPT_ERROR.
  3. Assert: Error message contains `"count"` (the variable name).
  4. Assert: Error message contains `"number"` (the expected type).
- **Expected Result**: Coercion failure is caught before script execution. Error message identifies which variable failed and the expected type.
- **Failure Mode**: If coercion silently produces NaN, the script runs with wrong data.

### INT-7: Concurrent executions -- no context leakage between tenants

- **Boundary**: `function-executor.ts` -> V8 isolate per execution
- **Setup**: Two `WorkflowExecutionInput` objects: tenant T1 with `trigger.payload.secret = "t1-secret"` and tenant T2 with `trigger.payload.secret = "t2-secret"`. Both use code: `workflow.setOutput({ secret: workflow.trigger.payload.secret, tenantId: workflow.tenant.tenantId })`.
- **Steps**:
  1. Run both workflows concurrently via `Promise.all([runWorkflow(inputT1, ...), runWorkflow(inputT2, ...)])`.
  2. Assert T1 result: `output.secret === 't1-secret'`, `output.tenantId === 'tenant-1'`.
  3. Assert T2 result: `output.secret === 't2-secret'`, `output.tenantId === 'tenant-2'`.
  4. Verify no cross-contamination of context data.
- **Expected Result**: Each execution operates in its own V8 isolate with its own context. No shared state between concurrent executions.
- **Failure Mode**: If write buffers or context references are shared (e.g., module-level state), T1 data leaks to T2.

### INT-8: Full dispatch with return value (no setOutput) -- verify step output is the return value

- **Boundary**: `step-dispatcher.ts` -> `function-executor.ts` -> `isolated-vm`
- **Setup**: Build `WorkflowExecutionInput` with a `FunctionStep` containing code: `return { computed: 42 };` (no `setOutput` call). Inject standard deps.
- **Steps**:
  1. Call `runWorkflow(input, 'exec-fn-return', deps)` with the function step.
  2. Assert `result.status === 'completed'`.
  3. Assert `result.context.steps['fn-node'].output === { computed: 42 }`.
- **Expected Result**: The return value flows through the dispatch chain and becomes the step output. This verifies that the dispatcher correctly extracts the return value from the executor result when `setOutput` was not called.
- **Failure Mode**: If the dispatcher only looks for `setOutput`-produced output and ignores the return value, the step output would be `undefined` despite the script returning a value.

---

## 4. Unit Test Scenarios

All unit tests live in `apps/workflow-engine/src/__tests__/function-executor.test.ts` unless otherwise noted. They use real `isolated-vm` (no mocking).

### UT-1: Basic script execution -- read context, produce output

- **Module**: `function-executor.ts` -> `executeFunctionStep(step, ctx)`
- **Input**: Code: `workflow.setOutput({ msg: 'hello' })`. Context: minimal valid `WorkflowContextData`.
- **Expected Output**: `{ output: { msg: 'hello' }, logs: [], durationMs: <number> }`

### UT-2: Context injection -- all fields accessible

- **Module**: `function-executor.ts`
- **Input**: Code that reads all context fields:
  ```javascript
  workflow.setOutput({
    triggerType: workflow.trigger.type,
    stepOutput: workflow.steps.API0001.output.value,
    varVal: workflow.vars.counter,
    wfId: workflow.workflow.id,
    tenantId: workflow.tenant.tenantId,
  });
  ```
  Context: `trigger: { type: 'manual', payload: {} }`, `steps: { API0001: { output: { value: 42 }, status: 'completed' } }`, `vars: { counter: 7 }`, `workflow: { id: 'wf-1', name: 'test', executionId: 'ex-1' }`, `tenant: { tenantId: 't1', projectId: 'p1' }`.
- **Expected Output**: `{ triggerType: 'manual', stepOutput: 42, varVal: 7, wfId: 'wf-1', tenantId: 't1' }`.

### UT-3: Context is frozen -- mutations throw TypeError

- **Module**: `function-executor.ts`
- **Input**: Code: `workflow.trigger.payload.x = 1; workflow.setOutput({ ok: true });`
- **Expected Output**: SCRIPT_ERROR with TypeError (Cannot add property to frozen object), or mutation silently fails and the frozen object retains its original state.

### UT-4: setOutput -- stores JSON-serializable structured value

- **Module**: `function-executor.ts`
- **Input**: Code: `workflow.setOutput({ items: [1, 2, 3], nested: { a: { b: 'c' } } });`
- **Expected Output**: Output is `{ items: [1, 2, 3], nested: { a: { b: 'c' } } }`.

### UT-5: setOutput -- last-call-wins semantics

- **Module**: `function-executor.ts`
- **Input**: Code: `workflow.setOutput({ first: true }); workflow.setOutput({ second: true });`
- **Expected Output**: Output is `{ second: true }` (last call wins).

### UT-6: setVar -- writes buffered and applied atomically

- **Module**: `function-executor.ts`
- **Input**: Code: `workflow.setVar('x', 10); workflow.setVar('y', 20); workflow.setOutput({ done: true });`. Context: `vars: {}`.
- **Expected Output**: After execution, `ctx.vars.x === 10`, `ctx.vars.y === 20`. Output: `{ done: true }`.

### UT-7: Console capture -- log, warn, error all captured with levels

- **Module**: `function-executor.ts`
- **Input**: Code:
  ```javascript
  console.log('info message', 123);
  console.warn('warning');
  console.error('error', { detail: 'bad' });
  workflow.setOutput({});
  ```
- **Expected Output**: `logs` array contains 3 entries:
  - `{ level: 'log', args: ['info message', 123] }`
  - `{ level: 'warn', args: ['warning'] }`
  - `{ level: 'error', args: ['error', { detail: 'bad' }] }`

### UT-8: Timeout enforcement -- long-running script terminated

- **Module**: `function-executor.ts`
- **Input**: Code: `while(true) {}`. Step config: `timeout: 1` (1 second).
- **Expected Output**: SCRIPT_ERROR with message containing `"timed out"`. Execution completes in ~1s (not indefinitely).

### UT-9: Memory limit enforcement -- OOM terminates isolate

- **Module**: `function-executor.ts`
- **Input**: Code: `const arr = []; while(true) { arr.push(new Array(1000000).fill('x')); }`. Memory limit: 128MB (or reduced to 8MB for test speed).
- **Expected Output**: SCRIPT_ERROR with message indicating memory exceeded or OOM.

### UT-10: Output size limit -- oversized output rejected

- **Module**: `function-executor.ts`
- **Input**: Code: `workflow.setOutput({ big: 'x'.repeat(2 * 1024 * 1024) });` (2MB string). Max output: 1MB.
- **Expected Output**: SCRIPT_ERROR with message containing `"output"` and `"size"` or `"limit"`.

### UT-11: Input variables -- expression resolved and type-coerced

- **Module**: `function-executor.ts`
- **Input**: Step with `inputVariables: [{ name: "count", type: "number", value: "{{trigger.payload.count}}" }, { name: "flag", type: "boolean", value: "{{trigger.payload.flag}}" }]`. Context: `trigger.payload: { count: "42", flag: "true" }`. Code: `workflow.setOutput({ count: count + 1, flag: !flag });`
- **Expected Output**: Output: `{ count: 43, flag: false }`. The string `"42"` was coerced to number `42`, `"true"` to boolean `true`.

### UT-12: Input variable coercion failure -- SCRIPT_ERROR with variable name

- **Module**: `function-executor.ts`
- **Input**: Step with `inputVariables: [{ name: "amount", type: "number", value: "{{trigger.payload.text}}" }]`. Context: `trigger.payload.text = "abc"`.
- **Expected Output**: SCRIPT_ERROR with message containing `"amount"` and `"number"`.

### UT-13: Syntax error -- SCRIPT_ERROR with line/column

- **Module**: `function-executor.ts`
- **Input**: Code: `const x = {` (unclosed brace).
- **Expected Output**: SCRIPT_ERROR with `code: 'SCRIPT_ERROR'`, message containing `"SyntaxError"`, and `line` field.

### UT-14: Runtime error -- SCRIPT_ERROR with stack trace

- **Module**: `function-executor.ts`
- **Input**: Code: `const obj = null; obj.property;` (TypeError).
- **Expected Output**: SCRIPT_ERROR with message containing `"TypeError"` or `"Cannot read"` and line/column info.

### UT-15: canvas-to-steps maps `function` to `function` step type

- **Module**: `canvas-to-steps.ts` (in `apps/workflow-engine/src/__tests__/canvas-to-steps.test.ts`)
- **Input**: Canvas node with `type: 'function'`, config: `{ code: 'workflow.setOutput(1)', timeout: 10 }`.
- **Expected Output**: Produced step has `type: 'function'` (not `'transform'`), with `config.code` and `config.timeout` preserved.

### UT-16: step-dispatcher routes `function` to FunctionExecutor

- **Module**: `step-dispatcher.ts` (in `apps/workflow-engine/src/__tests__/step-dispatcher.test.ts`)
- **Input**: `WorkflowStep` with `type: 'function'`, code: `workflow.setOutput({ ok: true })`.
- **Expected Output**: `dispatchStep()` returns a completed result with the function's output.

### UT-17: resolveStepInput returns code snippet and resolved inputs for function step

- **Module**: `step-dispatcher.ts`
- **Input**: `FunctionStep` with code (100+ chars), inputVariables with 2 entries.
- **Expected Output**: `resolveStepInput()` returns an object containing the code (or truncated snippet) and the resolved input variable values.

### UT-18: Return value becomes output when setOutput not called

- **Module**: `function-executor.ts`
- **Input**: Code: `return { computed: 42 };` (no `setOutput` call).
- **Expected Output**: Output is `{ computed: 42 }`.

### UT-19: Output defaults to undefined when neither setOutput nor return used

- **Module**: `function-executor.ts`
- **Input**: Code: `console.log('side effect only');` (no return, no setOutput).
- **Expected Output**: Output is `undefined`. No error.

### UT-20: setOutput takes precedence over return value

- **Module**: `function-executor.ts`
- **Input**: Code: `workflow.setOutput({ via: 'setOutput' }); return { via: 'return' };`
- **Expected Output**: Output is `{ via: 'setOutput' }` (setOutput wins).

---

## 5. Security & Isolation Tests

These are covered by the integration and unit tests above but summarized as a checklist:

- [INT-2] Script cannot access `require` -- ReferenceError
- [INT-2] Script cannot access `process` -- ReferenceError
- [INT-2] Script cannot access `fs` -- ReferenceError
- [INT-2] Script cannot access `Buffer` -- ReferenceError
- [INT-2] Script cannot access `setTimeout`/`setInterval` -- ReferenceError
- [INT-2] Script cannot access `fetch` -- ReferenceError
- [INT-4] Script cannot mutate `workflow.steps` (frozen)
- [INT-4] Script cannot mutate `workflow.trigger` (frozen)
- [INT-4] Script cannot mutate `workflow.tenant` (frozen)
- [INT-3] Failed script does not apply `setVar` writes (atomic rollback)
- [INT-7] Concurrent executions across tenants do not share context
- [UT-8] Timeout enforced -- runaway script terminated
- [UT-9] Memory limit enforced -- OOM terminates isolate
- [UT-10] Output size limit enforced -- oversized output rejected
- [E2E-1] Function node executes within tenant/project scope (dev-login auth)
- N/A: Cross-tenant HTTP returns 404 -- not applicable (function nodes have no HTTP API; isolation is at V8 isolate level). Workflow-level E2E isolation is covered by the existing `POST /execute` endpoint auth, which requires tenant-scoped authentication.
- N/A: Cross-project HTTP returns 404 -- not applicable (same reason)
- N/A: Cross-user access -- per feature spec, function nodes are not user-owned resources
- N/A: Missing auth returns 401 -- workflow execution API already covers this (no new endpoints)
- N/A: Insufficient permissions returns 403 -- no new permissions for function nodes

---

## 6. Performance & Load Tests

Not in Phase 1 scope. Performance baselines from feature spec:

| Metric                   | Target                           | How to Verify                   |
| ------------------------ | -------------------------------- | ------------------------------- |
| Isolate creation latency | ~5ms                             | UT-1 durationMs measurement     |
| Data transform p99       | <500ms                           | UT-1/INT-1 durationMs assertion |
| Timeout accuracy         | within 500ms of configured limit | UT-8 timing assertion           |

Phase 2 should add:

- Isolate pooling benchmarks (create-per-execution vs pooled).
- Concurrent execution load test (50 parallel function steps).
- Memory profiling under sustained load.

---

## 7. Test Infrastructure

### Required Services (E2E only)

| Service         | URL                                               | How to Start                              |
| --------------- | ------------------------------------------------- | ----------------------------------------- |
| Studio          | localhost:5173                                    | `pnpm --filter studio dev`                |
| Runtime         | localhost:3112                                    | `pnpm --filter runtime dev`               |
| Workflow Engine | localhost:9081                                    | See `apps/studio/e2e/workflows/agents.md` |
| Restate         | localhost:8091 (ingress) / localhost:9070 (admin) | Docker                                    |
| MongoDB         | localhost:27018                                   | Docker                                    |
| Redis           | localhost:6380 (password: localdev)               | Docker                                    |

JWT_SECRET must match across all services: `dev-jwt-secret-that-is-at-least-32chars`.

### Dependencies (all tests)

- `isolated-vm` npm package (native module, requires `node-gyp` build tools).
- Feature spec GAP-006: Verify `isolated-vm` compiles in the workflow-engine Dockerfile.

### Unit/Integration Test Setup

- No external services needed. Run via `pnpm test --filter=workflow-engine`.
- `isolated-vm` must be installed as a dependency of `apps/workflow-engine`.
- Use real `isolated-vm` -- do NOT mock it.
- Use the existing patterns: `makeCtx()` from `transform-executor.test.ts`; `makeInput()` / `makePersistence()` / `makePublisher()` / `makeDeps()` from `e2e-basic.test.ts`.

### Data Seeding

- **Unit tests**: Build `WorkflowContextData` inline (pure data, no DB).
- **Integration tests**: Build `WorkflowExecutionInput` with step definitions inline.
- **E2E tests**: Create workflows via UI, configure via Zustand store, run via Run dialog. No DB seeding needed.

### Environment Variables

| Variable                         | Value for Tests     | Purpose                  |
| -------------------------------- | ------------------- | ------------------------ |
| `FUNCTION_NODE_MEMORY_MB`        | `128` (default)     | Memory limit per isolate |
| `FUNCTION_NODE_MAX_OUTPUT_BYTES` | `1048576` (default) | Output size limit        |
| `FUNCTION_NODE_MAX_LOGS`         | `100` (default)     | Max console entries      |

---

## 8. Test File Mapping

| Test File                                                      | Type                   | Covers                                                                       |
| -------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `apps/workflow-engine/src/__tests__/function-executor.test.ts` | unit + integration     | FR-1 to FR-10, FR-14 (UT-1 to UT-14, UT-18-20, INT-2 to INT-4, INT-6, INT-7) |
| `apps/workflow-engine/src/__tests__/canvas-to-steps.test.ts`   | unit (new file)        | FR-11 (UT-15)                                                                |
| `apps/workflow-engine/src/__tests__/step-dispatcher.test.ts`   | unit (update existing) | FR-12, FR-13 (UT-16, UT-17)                                                  |
| `apps/workflow-engine/src/__tests__/e2e-basic.test.ts`         | integration (add test) | FR-1, FR-3, FR-12, FR-14 (INT-1, INT-5, INT-8)                               |
| `apps/studio/e2e/workflows/workflow-function-node.spec.ts`     | e2e (new file)         | FR-1 to FR-6, FR-9, FR-10, FR-13, FR-15 (E2E-1 to E2E-7)                     |

---

## 9. Open Testing Questions

1. **Async script testing**: If Open Question #1 from feature spec (async/await support) is decided for Phase 1, additional tests needed for `async` functions with `await` inside isolates.
2. **Memory limit test reliability**: UT-9 (OOM) allocates large arrays to exhaust 128MB. This may be slow or flaky in CI. Consider reducing isolate memory limit to 8MB for the test.
3. **Console.log serialization depth**: UT-7 tests basic serialization. Deep nested objects (100+ levels) may need a separate test if a depth limit is configured (Open Question #3 from feature spec).
4. **Dockerfile validation**: GAP-006 (isolated-vm Dockerfile compatibility) should be verified as a CI pipeline prerequisite, not as a test scenario.
5. **Loop + Function E2E complexity**: E2E-6 requires building a Loop(Function) pattern in the canvas, which may need Zustand store API for nested node placement. If unavailable, may need the Runtime API approach from `workflow-create-execute.spec.ts`.
