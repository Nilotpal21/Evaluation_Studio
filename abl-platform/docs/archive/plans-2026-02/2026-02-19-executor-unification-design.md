# Executor Unification Design

**Date:** 2026-02-19
**Status:** Approved
**Scope:** packages/compiler, apps/runtime

## Problem

The codebase has two parallel implementations of flow execution and reasoning execution:

- **Compiler executors** (`packages/compiler/src/platform/constructs/executors/`): FlowExecutor, ReasoningExecutor, HandoffExecutor, DelegateExecutor, CompleteExecutor, EscalateExecutor, GatherExecutor — orchestrated by ConstructExecutor. Stateless, well-designed, but never used in production. ReasoningExecutor is a stub missing streaming, routing, threads, and conversation history.
- **Runtime executors** (`apps/runtime/src/services/execution/`): FlowStepExecutor, executeWithTools (embedded in RuntimeExecutor), RoutingExecutor. Mutable session state, some domain coupling, but these are the actual production code with full features: streaming, threads, A2A, fan-out, persistence, voice.

~70% of the flow execution logic is duplicated. Features diverge: the compiler has ON_RESULT, TRANSFORM, CALL WITH, grounding validation that the runtime lacks. The runtime has streaming, threads, field validation, persistence that the compiler lacks. Every new feature must be implemented in two places.

## Decision

**Consolidate all execution into the runtime. The compiler compiles — it does not execute.**

- Execution types (ExecutionContext, AgentState, ConstructAction, etc.) stay in `packages/compiler` as the shared type contracts
- Pure utility functions (checkGatherComplete, buildGatherPrompt, detectCorrection, evaluateOnInput) are extracted to `packages/compiler/src/platform/constructs/utils.ts`
- All executor implementations are deleted from the compiler
- The runtime's executors become the single canonical implementations, cleaned up with good patterns from the compiler
- Compiler e2e tests that test execution behavior move to the runtime test suite

## Changes by Layer

### 1. Delete from Compiler

| File                              | Reason                                                                    |
| --------------------------------- | ------------------------------------------------------------------------- |
| `executors/flow-executor.ts`      | Duplicated by runtime's FlowStepExecutor                                  |
| `executors/reasoning-executor.ts` | Stub — never used by runtime, missing streaming/routing/threads           |
| `executors/handoff-executor.ts`   | Returns data-only ConstructAction, runtime's RoutingExecutor is canonical |
| `executors/delegate-executor.ts`  | Same                                                                      |
| `executors/complete-executor.ts`  | Same                                                                      |
| `executors/escalate-executor.ts`  | Same                                                                      |
| `executors/gather-executor.ts`    | Runtime handles gather inline                                             |
| `executor.ts` (ConstructExecutor) | Pipeline orchestrator for the above                                       |

### 2. Keep in Compiler

- `types.ts` — ExecutionContext, AgentState, ConstructAction, ConstructResult (shared type contracts)
- `constants.ts` — System tool names, platform defaults
- `utils.ts` (new) — Pure functions extracted from deleted executors

### 3. Clean Up FlowStepExecutor (Runtime)

The runtime's `FlowStepExecutor` becomes the canonical flow executor.

**Remove domain coupling:**

- Delete hardcoded field name heuristics in `extractEntitiesWithLLM()` (`hotels`, `checkin`, `checkout`, `destination`)
- Delete `callResult.hotels` success check — use `success_when` from step definition or generic `{ success, error }` checking
- Field type inference from `GatherField.type` and `GatherField.extraction_hints` in IR, not hardcoded synonym tables

**Add missing features from compiler's FlowExecutor:**

- ON_RESULT multi-way branching after CALL
- TRANSFORM array pipeline (filter, map, sort_by, limit)
- Step-level standalone SET block
- CALL WITH explicit parameter block (`call_with`/`call_as`)
- Grounding validation after entity extraction

**Fix recursive execution:**

- Replace recursive `this.executeFlowStep(session, '', ...)` with iterative `while` loop
- Fixes stack overflow in loop detection (currently failing tests)

**Extract pure functions:**

- `checkGatherComplete`, `buildGatherPrompt`, `evaluateOnInput`, `detectCorrection` → exported from compiler's `utils.ts` so both runtime and compiler tests can use them

### 4. Extract ReasoningExecutor (Runtime)

Extract `executeWithTools` from `RuntimeExecutor` (currently lines 913-1177) into its own class: `apps/runtime/src/services/execution/reasoning-executor.ts`.

**Public interface:** `execute(session, userMessage, onChunk, onTraceEvent)`

**Fix hardcoded limits:**

- `maxIterations = 10` → read from `agentIR.execution.max_tool_iterations` or named constant
- Add consecutive-empty-response guard (compiler had this)
- Add exhaustion trace event

**Keep production features:** streaming, routing-aware tool dispatch, conversation history, pre-loop GATHER extraction, constraint checking.

**RuntimeExecutor becomes thinner:**

1. Session lookup/rehydration
2. Guards (complete, escalated, empty input)
3. Ensure LLM client, lazy ON_START
4. Branch: `currentFlowStep` → FlowStepExecutor / else → ReasoningExecutor
5. Post-turn persistence

### 5. Migrate Compiler E2E Tests

Tests that test compilation output (parser, IR generation, graph-extractor) stay in compiler.

Tests that test execution behavior move to runtime:

- `construct-pipeline.test.ts` → `apps/runtime/src/__tests__/`
- `banknexus-pipeline.test.ts` → `apps/runtime/src/__tests__/`

Replace `ConstructExecutor` usage with `FlowStepExecutor` / `ReasoningExecutor` + test harness.

## Architecture After Unification

```
packages/compiler/
  src/platform/constructs/
    types.ts          ← Shared types (ExecutionContext, AgentState, ConstructAction)
    constants.ts      ← System tool names, platform defaults
    utils.ts          ← Pure functions (checkGatherComplete, buildGatherPrompt, etc.)
    executors/        ← DELETED

apps/runtime/
  src/services/
    runtime-executor.ts           ← Session management shell
    execution/
      flow-step-executor.ts       ← Canonical flow executor
      reasoning-executor.ts       ← Extracted from RuntimeExecutor
      routing-executor.ts         ← Canonical routing (unchanged)
      types.ts                    ← RuntimeSession, ExecutionResult
```

**Dependency direction:** `packages/compiler` exports types + pure utilities → `apps/runtime` imports and implements execution. No circular dependencies.

## What This Does NOT Change

- RoutingExecutor — already canonical, no changes
- Thread model — stays in runtime (infrastructure concern)
- Session persistence (debouncedPersist) — stays in runtime
- Voice stripping — stays in runtime
- A2A remote handoffs — stays in runtime
- IR types, schema, compilation — unchanged
- Parser, AST types — unchanged

## Risk

Medium. The runtime executors are production code being cleaned up, not rewritten. The compiler executors being deleted are not used in production. The main risks are:

- Test migration may uncover implicit dependencies on ConstructExecutor's pipeline ordering
- Adding missing features (ON_RESULT, TRANSFORM) to FlowStepExecutor introduces new code paths
- Recursive → iterative conversion in FlowStepExecutor needs careful equivalence testing

## Implementation Plan

**Goal:** Eliminate duplicate execution code — consolidate all execution into the runtime, make the compiler a pure DSL→IR transformer.

**Architecture:** Delete 8 executor files from the compiler package. Clean up the runtime's FlowStepExecutor (recursive→iterative, remove domain coupling, add missing features from compiler). Extract ReasoningExecutor from RuntimeExecutor. Move compiler e2e tests to runtime. Pure utility functions go to compiler's `utils.ts` for sharing.

**Tech Stack:** TypeScript, Vitest, ABL DSL

---

### Task 1: Extract Pure Functions to Compiler Utils

**Files:**

- Create: `packages/compiler/src/platform/constructs/utils.ts`
- Modify: `packages/compiler/src/platform/constructs/index.ts`
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`

These 6 standalone functions in `flow-step-executor.ts` (lines 47-383) have zero runtime dependencies — they're pure logic operating on plain objects. Move them to the compiler package so both runtime and compiler tests can import them.

**Step 1: Create utils.ts with the pure functions**

Copy these functions from `flow-step-executor.ts` to the new `utils.ts`:

- `detectIntent` (lines 47-90) — keyword-based intent matching against a list of intents
- `detectCorrection` (lines 95-136) — regex-based correction detection on collected fields
- `checkGatherComplete` (lines 141-178) — checks if all required GATHER fields are collected
- `buildGatherPrompt` (lines 183-212) — builds prompt string from missing fields
- `validateField` (lines 218-260) — validates a value against a `ValidationRule` (pattern, range, enum, custom)
- `evaluateOnInput` (lines 266-383) — evaluates ON_INPUT branch conditions against user message

Also copy the necessary imports these functions depend on:

- `evaluateConditionWithInput`, `evaluateConditionDetailed`, `compilerEvaluateCondition` from `@abl/compiler` (they already live in the compiler)
- `DEFAULT_CORRECTION_PATTERNS` from `@abl/compiler`
- `interpolateTemplate` from `../execution/value-resolution.js` → inline or duplicate the subset needed (it's only used in `buildGatherPrompt`)

For `interpolateTemplate`: since it's defined in the runtime's `value-resolution.ts`, and we want `utils.ts` to be self-contained in the compiler, implement a minimal `interpolateTemplate` in `utils.ts` that handles `{{variable}}` substitution (the only feature `buildGatherPrompt` uses).

Keep the type imports minimal — use inline types or import from the compiler's own IR types.

**Step 2: Export from constructs/index.ts**

Add to `packages/compiler/src/platform/constructs/index.ts`:

```typescript
export {
  detectIntent,
  detectCorrection,
  checkGatherComplete,
  buildGatherPrompt,
  validateField,
  evaluateOnInput,
} from './utils.js';
```

**Step 3: Update flow-step-executor.ts to import from compiler**

Replace the 6 function definitions in `flow-step-executor.ts` with imports:

```typescript
import {
  detectIntent,
  detectCorrection,
  checkGatherComplete,
  buildGatherPrompt,
  validateField,
  evaluateOnInput,
} from '@abl/compiler/platform/constructs/utils.js';
```

Delete the function bodies (lines 47-383). Keep any runtime-specific imports that other parts of the file use.

**Step 4: Verify**

Run:

```bash
cd packages/compiler && npx tsc --noEmit
cd apps/runtime && npx tsc --noEmit
cd packages/core && npx vitest run --reporter=verbose
cd apps/runtime && npx vitest run --reporter=verbose
```

Expected: All compile, all tests pass (behavior unchanged — same functions, different location).

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/constructs/utils.ts packages/compiler/src/platform/constructs/index.ts apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "[ABLP-2] refactor(compiler): extract pure flow utility functions to shared utils module"
```

---

### Task 2: Convert FlowStepExecutor from Recursive to Iterative

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`

The `executeFlowStep()` method (lines 908-1878) calls itself recursively at 8 points. This causes stack overflows on loop-back flows (currently a failing test). Convert to a `while` loop.

**Step 1: Refactor executeFlowStep to use a while loop**

The core pattern: replace every `return this.executeFlowStep(session, '', onChunk, onTraceEvent)` with setting the next iteration state and `continue`-ing the loop.

Current structure (recursive):

```typescript
async executeFlowStep(session, userMessage, onChunk, onTraceEvent): Promise<ExecutionResult> {
  // ... process step ...
  // At 8 points: return this.executeFlowStep(session, '', onChunk, onTraceEvent);
}
```

New structure (iterative):

```typescript
async executeFlowStep(session, userMessage, onChunk, onTraceEvent): Promise<ExecutionResult> {
  let currentMessage = userMessage;
  const visited = new Set<string>();
  const MAX_CHAIN_ITERATIONS = 100;
  let iterations = 0;

  while (iterations < MAX_CHAIN_ITERATIONS) {
    iterations++;
    const stepName = session.currentFlowStep;
    if (!stepName) break;

    // Loop detection
    if (!currentMessage && visited.has(stepName)) {
      // Already visited this step with no new input — break to prevent infinite loop
      onTraceEvent?.({ type: 'error', data: { message: `Loop detected at step: ${stepName}`, step: stepName } });
      break;
    }
    if (!currentMessage) visited.add(stepName);

    // ... existing step processing logic (everything currently inside executeFlowStep) ...

    // At each former recursion point, instead of:
    //   return this.executeFlowStep(session, '', onChunk, onTraceEvent);
    // Do:
    //   currentMessage = '';
    //   continue;

    // When the step needs user input (waitingForInput set) or is complete:
    //   break;
  }

  // Return final result
  return { response: lastResponse, ... };
}
```

**Key conversion points** (each `return this.executeFlowStep(...)` becomes `currentMessage = ''; continue;`):

1. Line 1002 — CHECK failure with on_fail: `session.currentFlowStep = step.on_fail; currentMessage = ''; continue;`
2. Line 1061 — Digression goto: `session.currentFlowStep = digression.goto; currentMessage = ''; continue;`
3. Line 1072 — Digression resume: `currentMessage = ''; continue;`
4. Line 1132 — Sub-intent: `currentMessage = ''; continue;`
5. Line 1176 — Correction: `currentMessage = ''; continue;`
6. Line 1297 — ON_INPUT navigation: `session.currentFlowStep = branch.then; currentMessage = ''; continue;`
7. Line 1450 — ON_INPUT branch: `session.currentFlowStep = branch.then; currentMessage = ''; continue;`
8. Line 1838 — THEN auto-advance: `session.currentFlowStep = nextStep; currentMessage = ''; continue;`

**Step 2: Remove chainVisited parameter**

The current recursion passes `chainVisited?: Set<string>` as a parameter to track visited steps. The new `visited` Set in the while loop replaces this. Remove the parameter from the method signature and all call sites.

**Step 3: Verify**

Run:

```bash
cd apps/runtime && npx vitest run --reporter=verbose
```

Expected: All existing tests pass. The loop detection test (`loop-back with gather does not infinite loop`) that was previously failing with stack overflow should now pass.

**Step 4: Commit**

```bash
git add apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "[ABLP-2] refactor(runtime): convert FlowStepExecutor from recursive to iterative execution"
```

---

### Task 3: Remove Domain Coupling from FlowStepExecutor

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`

**Step 1: Fix extractEntitiesWithLLM field description builder**

Replace the domain-specific heuristics (lines 675-698) with IR-driven field descriptions.

Before (hardcoded):

```typescript
if (fieldLower.includes('destination') || fieldLower.includes('city')) {
  desc = `"${field}": destination city or location`;
} else if (fieldLower.includes('checkin')) {
  desc = `"${field}": Check-in date in YYYY-MM-DD format`;
}
```

After (IR-driven):

```typescript
// Build description from GATHER field metadata
const gatherField = gatherFields?.find((f) => f.name === field);
if (gatherField) {
  const parts = [`"${field}"`];
  if (gatherField.type && gatherField.type !== 'string') parts.push(`(${gatherField.type})`);
  if (gatherField.prompt) parts.push(`- ${gatherField.prompt}`);
  else if (gatherField.extraction_hints) parts.push(`- ${gatherField.extraction_hints}`);
  else parts.push(`- the ${field.replace(/_/g, ' ')}`);
  desc = parts.join(' ');
} else {
  desc = `"${field}": the ${field.replace(/_/g, ' ')}`;
}
```

Pass `step.gather?.fields` into the method so field metadata is available.

**Step 2: Remove hardcoded context filter**

At line 647, remove `key !== 'hotels' && key !== 'total'`. Replace with a generic filter:

```typescript
.filter(([key]) => !key.startsWith('_') && !key.startsWith('last_'))
```

**Step 3: Fix call success detection**

At line 1626, replace:

```typescript
} else if (callResult.hotels !== undefined && (callResult.hotels as unknown[]).length === 0) {
  callSuccess = false;
```

With generic success detection (matching the compiler's `determineCallSuccess` pattern):

```typescript
// Check success_when from step definition first
if (step.success_when) {
  callSuccess = evaluateCondition(step.success_when, {
    ...session.data.values,
    _result: callResult,
  });
} else {
  // Generic detection: check for error indicators
  callSuccess =
    !callResult._error && callResult.error === undefined && callResult.success !== false;
}
```

**Step 4: Remove remaining domain-specific comments and examples**

- Line 736: Remove "3 nights when asking for destination" from extraction prompt. Use generic example: `"Do not infer values that the user did not explicitly state."`
- Line 809: Remove "nights" / "destination" comment.
- Lines 824-828: Remove `includes('checkin')` / `includes('checkout')` / `includes('destination')` mapping. Use `gatherField.type` metadata instead.

**Step 5: Verify**

Run:

```bash
cd apps/runtime && npx vitest run --reporter=verbose
```

Expected: Tests pass. Some test assertions about extraction prompts may need updating if they asserted on the old domain-specific text.

**Step 6: Commit**

```bash
git add apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "[ABLP-2] refactor(runtime): remove domain-specific coupling from FlowStepExecutor"
```

---

### Task 4: Add ON_RESULT Multi-Way Branching

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`
- Create: `apps/runtime/src/__tests__/flow-on-result.test.ts`

ON_RESULT allows branching on tool call results with multiple condition/action paths. The compiler has this (flow-executor.ts lines 765-796) but the runtime doesn't.

**Step 1: Write the test**

```typescript
test('ON_RESULT branches based on call result', async () => {
  const dsl = `
AGENT: Test_Agent
VERSION: "1.0"
GOAL: Test ON_RESULT
MODE: scripted

TOOLS:
  search_hotels:
    description: "Search hotels"
    parameters:
      destination: { type: string }

FLOW:
  entry_point: search

  search:
    GATHER:
      - destination: required
    CALL: search_hotels
    AS: search_results
    ON_RESULT:
      - condition: "search_results.count > 0"
        RESPOND: "Found {{search_results.count}} hotels"
        THEN: select_hotel
      - condition: "search_results.count == 0"
        RESPOND: "No hotels found"
        THEN: search
    THEN: select_hotel

  select_hotel:
    RESPOND: "Please select a hotel"
`;
  // ... setup session, mock tool returning { count: 3 }, verify "Found 3 hotels" response and transition to select_hotel
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/flow-on-result.test.ts --reporter=verbose`
Expected: FAIL (ON_RESULT not implemented in FlowStepExecutor)

**Step 3: Implement ON_RESULT**

In `executeFlowStep()`, after the CALL execution block and before ON_SUCCESS/ON_FAILURE handling, add:

```typescript
// ON_RESULT: multi-way branching on call result
if (step.call && step.on_result && step.on_result.length > 0 && callResult) {
  const resultContext = {
    ...session.data.values,
    ...(step.call_as ? { [step.call_as]: callResult } : callResult),
  };
  const matchedBranch = evaluateOnInput(step.on_result, '', resultContext);

  if (matchedBranch) {
    // Apply SET assignments
    if (matchedBranch.set) {
      for (const [key, val] of Object.entries(matchedBranch.set)) {
        session.data.values[key] = interpolateTemplate(String(val), resultContext);
      }
    }
    // Emit response
    if (matchedBranch.respond) {
      const msg = interpolateTemplate(matchedBranch.respond, resultContext);
      onChunk?.(msg);
      session.conversationHistory.push({ role: 'assistant', content: msg });
    }
    // Transition
    if (matchedBranch.then) {
      session.currentFlowStep = matchedBranch.then;
      currentMessage = '';
      continue; // iterative loop from Task 2
    }
  }
}
```

**Step 4: Verify**

Run: `cd apps/runtime && npx vitest run src/__tests__/flow-on-result.test.ts --reporter=verbose`
Expected: PASS

Run: `cd apps/runtime && npx vitest run --reporter=verbose`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add apps/runtime/src/services/execution/flow-step-executor.ts apps/runtime/src/__tests__/flow-on-result.test.ts
git commit -m "[ABLP-2] feat(runtime): add ON_RESULT multi-way branching to FlowStepExecutor"
```

---

### Task 5: Add TRANSFORM Array Pipeline

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`
- Create: `apps/runtime/src/__tests__/flow-transform.test.ts`

TRANSFORM applies filter→map→sort_by→limit to an array in session data. The compiler has this (flow-executor.ts lines 487-557) but the runtime doesn't.

**Step 1: Write the test**

```typescript
test('TRANSFORM filters and sorts array data', async () => {
  const dsl = `
AGENT: Test_Agent
VERSION: "1.0"
GOAL: Test TRANSFORM
MODE: scripted

TOOLS:
  search_hotels:
    description: "Search hotels"
    parameters:
      destination: { type: string }

FLOW:
  entry_point: search

  search:
    GATHER:
      - destination: required
    CALL: search_hotels
    AS: raw_results
    TRANSFORM:
      source: raw_results
      item_var: hotel
      target: filtered_results
      filter: "hotel.rating >= 4"
      sort_by:
        field: price
        order: asc
      limit: 5
    RESPOND: "Found {{filtered_results.length}} matching hotels"
    THEN: done

  done:
    RESPOND: "Done"
`;
  // ... setup session, mock tool returning array of hotels with varying ratings/prices
  // Verify filtered_results contains only rating>=4, sorted by price asc, max 5
});
```

**Step 2: Run test to verify it fails**

Expected: FAIL (TRANSFORM not implemented)

**Step 3: Implement TRANSFORM**

In `executeFlowStep()`, after CALL execution and result binding (but before ON_RESULT), add:

```typescript
// TRANSFORM: array pipeline
if (step.transform) {
  const { source, item_var: itemVar, target, filter, map, sort_by: sortBy, limit } = step.transform;
  const sourceArray = session.data.values[source];

  if (Array.isArray(sourceArray)) {
    let transformed = [...sourceArray];

    if (filter) {
      transformed = transformed.filter((item) => {
        const ctx = { ...session.data.values, [itemVar]: item };
        return evaluateCondition(filter, ctx);
      });
    }

    if (map) {
      const mapEntries = Object.entries(map);
      transformed = transformed.map((item) => {
        const ctx = { ...session.data.values, [itemVar]: item };
        const mapped: Record<string, unknown> = {};
        for (const [key, expr] of mapEntries) {
          mapped[key] = resolveValue(expr, ctx);
        }
        return mapped;
      });
    }

    if (sortBy) {
      transformed.sort((a: unknown, b: unknown) => {
        const va = (a as Record<string, unknown>)?.[sortBy.field];
        const vb = (b as Record<string, unknown>)?.[sortBy.field];
        const cmp =
          va == null && vb == null
            ? 0
            : va == null
              ? -1
              : vb == null
                ? 1
                : va < vb
                  ? -1
                  : va > vb
                    ? 1
                    : 0;
        return sortBy.order === 'desc' ? -cmp : cmp;
      });
    }

    if (limit != null && limit > 0) {
      transformed = transformed.slice(0, limit);
    }

    session.data.values[target] = transformed;
  }
}
```

Import `evaluateCondition` and `resolveValue` from compiler utilities if not already imported.

**Step 4: Verify**

Run: `cd apps/runtime && npx vitest run src/__tests__/flow-transform.test.ts --reporter=verbose`
Expected: PASS

Run: `cd apps/runtime && npx vitest run --reporter=verbose`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add apps/runtime/src/services/execution/flow-step-executor.ts apps/runtime/src/__tests__/flow-transform.test.ts
git commit -m "[ABLP-2] feat(runtime): add TRANSFORM array pipeline to FlowStepExecutor"
```

---

### Task 6: Add CALL WITH/AS Parameter Resolution

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`
- Create: `apps/runtime/src/__tests__/flow-call-with.test.ts`

CALL WITH lets steps pass explicit parameters to tool calls (resolved from context). CALL AS binds the result to a named variable. The compiler has this (flow-executor.ts lines 711-739) but the runtime only resolves params from `session.data.values`.

**Step 1: Write the test**

```typescript
test('CALL WITH passes explicit parameters, AS binds result', async () => {
  const dsl = `
AGENT: Test_Agent
VERSION: "1.0"
GOAL: Test CALL WITH/AS
MODE: scripted

TOOLS:
  transfer_funds:
    description: "Transfer money"
    parameters:
      from_account: { type: string }
      to_account: { type: string }
      amount: { type: number }

FLOW:
  entry_point: collect_info

  collect_info:
    GATHER:
      - source_account: required
      - dest_account: required
      - transfer_amount: required
        type: number
    CALL: transfer_funds
    WITH:
      from_account: source_account
      to_account: dest_account
      amount: transfer_amount
    AS: transfer_result
    RESPOND: "Transfer {{transfer_result.status}}"
    THEN: done

  done:
    RESPOND: "Done"
`;
  // ... verify transfer_funds is called with mapped params, result stored as transfer_result
});
```

**Step 2: Run test to verify it fails**

Expected: FAIL (CALL WITH not implemented)

**Step 3: Implement CALL WITH/AS**

In the CALL execution block of `executeFlowStep()`, modify the tool call to check for `call_with`:

```typescript
if (step.call) {
  let callResult: Record<string, unknown>;

  if (step.call_with && Object.keys(step.call_with).length > 0) {
    // WITH block: resolve explicit params from context
    const params: Record<string, unknown> = {};
    for (const [key, expr] of Object.entries(step.call_with)) {
      params[key] = resolveValue(String(expr), session.data.values);
    }
    callResult = await session.toolExecutor!.execute(step.call, params, 30000);
  } else {
    // No WITH — pass all collected data as params (existing behavior)
    callResult = await session.toolExecutor!.execute(step.call, { ...session.data.values }, 30000);
  }

  // AS binding: store result under explicit key
  if (step.call_as) {
    session.data.values[step.call_as] = callResult;
  } else {
    // Spread result into context (existing behavior)
    Object.assign(session.data.values, callResult);
  }
}
```

Import `resolveValue` from compiler utilities. `resolveValue` resolves `$path` references, literals, and built-in functions against a context object.

**Step 4: Verify**

Run: `cd apps/runtime && npx vitest run src/__tests__/flow-call-with.test.ts --reporter=verbose`
Expected: PASS

Run: `cd apps/runtime && npx vitest run --reporter=verbose`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add apps/runtime/src/services/execution/flow-step-executor.ts apps/runtime/src/__tests__/flow-call-with.test.ts
git commit -m "[ABLP-2] feat(runtime): add CALL WITH/AS parameter resolution to FlowStepExecutor"
```

---

### Task 7: Extract ReasoningExecutor from RuntimeExecutor

**Files:**

- Create: `apps/runtime/src/services/execution/reasoning-executor.ts`
- Modify: `apps/runtime/src/services/runtime-executor.ts`
- Modify: `apps/runtime/src/services/execution/index.ts`

`executeWithTools()` (lines 913-1177) and `executeToolCall()` (lines 1182-1312) are currently private methods on RuntimeExecutor. Extract them into a dedicated `ReasoningExecutor` class alongside `FlowStepExecutor` and `RoutingExecutor`.

**Step 1: Create reasoning-executor.ts**

```typescript
import type { RuntimeSession, ExecutionResult } from './types.js';
import type { RoutingExecutor } from './routing-executor.js';

interface ReasoningExecutorContext {
  routing: RoutingExecutor;
  debouncedPersist: (session: RuntimeSession) => void;
  buildSystemPrompt: (session: RuntimeSession) => string;
  buildTools: (session: RuntimeSession) => any[];
  checkConstraints: (
    session: RuntimeSession,
    message: string,
  ) => Promise<{ passed: boolean; violation?: string }>;
}

export class ReasoningExecutor {
  constructor(private ctx: ReasoningExecutorContext) {}

  async execute(
    session: RuntimeSession,
    userMessage: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<ExecutionResult> {
    // Move executeWithTools body here
    // ...
  }

  private async executeToolCall(
    session: RuntimeSession,
    toolCall: { name: string; input: Record<string, unknown>; id?: string },
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<{ toolResult: unknown; action?: string; breakLoop: boolean }> {
    // Move executeToolCall body here
    // ...
  }
}
```

Move the method bodies from `runtime-executor.ts` into the new class. Replace references to `this.routing` with `this.ctx.routing`, `this.buildSystemPrompt(...)` with `this.ctx.buildSystemPrompt(...)`, etc.

**Step 2: Fix configurable limits**

In the extracted `execute()` method:

- Replace `const maxIterations = 10;` with:
  ```typescript
  const maxIterations = session.agentIR?.execution?.max_tool_iterations ?? 10;
  ```
- Add consecutive-empty-response guard:
  ```typescript
  let consecutiveEmpty = 0;
  // In the loop, when no tool calls and no text:
  consecutiveEmpty++;
  if (consecutiveEmpty >= 2) {
    onTraceEvent?.({
      type: 'error',
      data: { message: 'Reasoning loop: consecutive empty responses' },
    });
    break;
  }
  ```
- Add exhaustion trace event:
  ```typescript
  if (iterations >= maxIterations) {
    onTraceEvent?.({
      type: 'error',
      data: { message: `Reasoning loop exhausted after ${maxIterations} iterations` },
    });
  }
  ```

**Step 3: Update RuntimeExecutor to use ReasoningExecutor**

In `runtime-executor.ts`:

- Add import: `import { ReasoningExecutor } from './execution/reasoning-executor.js';`
- Add field: `private reasoning: ReasoningExecutor;`
- In constructor (around line 230): `this.reasoning = new ReasoningExecutor({ routing: this.routing, debouncedPersist: ..., buildSystemPrompt: ..., buildTools: ..., checkConstraints: ... });`
- In `executeMessage()`, replace the reasoning branch (currently lines ~830-900 that call `this.executeWithTools(...)`) with: `return this.reasoning.execute(session, userMessage, onChunk, onTraceEvent);`
- Delete `executeWithTools()` and `executeToolCall()` from RuntimeExecutor

**Step 4: Export from execution/index.ts**

Add to `apps/runtime/src/services/execution/index.ts`:

```typescript
export { ReasoningExecutor } from './reasoning-executor.js';
```

**Step 5: Verify**

Run:

```bash
cd apps/runtime && npx tsc --noEmit
cd apps/runtime && npx vitest run --reporter=verbose
```

Expected: All compile, all tests pass (behavior unchanged — same code, different class).

**Step 6: Commit**

```bash
git add apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/services/runtime-executor.ts apps/runtime/src/services/execution/index.ts
git commit -m "[ABLP-2] refactor(runtime): extract ReasoningExecutor from RuntimeExecutor"
```

---

### Task 8: Delete Compiler Executor Implementations

**Files:**

- Delete: `packages/compiler/src/platform/constructs/executors/flow-executor.ts`
- Delete: `packages/compiler/src/platform/constructs/executors/reasoning-executor.ts`
- Delete: `packages/compiler/src/platform/constructs/executors/handoff-executor.ts`
- Delete: `packages/compiler/src/platform/constructs/executors/delegate-executor.ts`
- Delete: `packages/compiler/src/platform/constructs/executors/complete-executor.ts`
- Delete: `packages/compiler/src/platform/constructs/executors/escalate-executor.ts`
- Delete: `packages/compiler/src/platform/constructs/executors/gather-executor.ts`
- Delete: `packages/compiler/src/platform/constructs/executors/error-executor.ts` (if exists)
- Delete: `packages/compiler/src/platform/constructs/executors/memory-executor.ts` (if exists)
- Delete: `packages/compiler/src/platform/constructs/executor.ts` (ConstructExecutor)
- Modify: `packages/compiler/src/platform/constructs/index.ts`
- Modify: `packages/compiler/src/index.ts`

**Step 1: Delete executor files**

Delete all files in `packages/compiler/src/platform/constructs/executors/` and the `executor.ts` (ConstructExecutor) file.

**Step 2: Update constructs/index.ts**

Remove all executor exports:

- `ConstructExecutor`, `createConstructExecutor`, `getConstructExecutor`
- `FlowExecutor`, `GatherExecutor`, `ReasoningExecutor`
- Any other executor-related exports

Keep:

- Type exports (`ExecutionContext`, `AgentState`, `ConstructAction`, `ConstructResult`, etc.)
- Utility exports (`checkConstraintsCore`, `evaluateCondition`, `interpolateMessage`, etc.)
- The new `utils.ts` exports from Task 1

**Step 3: Update compiler's main index.ts**

Remove re-exports of deleted executors from `packages/compiler/src/index.ts`.

**Step 4: Fix any other files in the compiler that import from deleted modules**

Search for imports of the deleted executors across the compiler package. Common references:

- `packages/compiler/src/platform/constructs/executors/index.ts` (barrel file — delete)
- Any test utilities that reference `ConstructExecutor`

**Step 5: Verify compiler compiles**

Run:

```bash
cd packages/compiler && npx tsc --noEmit
```

Expected: Type errors from deleted imports in test files (fixed in Task 9).

**Step 6: Commit**

```bash
git add -A packages/compiler/src/platform/constructs/
git add packages/compiler/src/index.ts
git commit -m "[ABLP-2] refactor(compiler): delete executor implementations, keep shared types and utils"
```

---

### Task 9: Migrate Compiler E2E Tests to Runtime

**Files:**

- Move: `packages/compiler/src/__tests__/e2e/construct-pipeline.test.ts` → `apps/runtime/src/__tests__/construct-pipeline.test.ts`
- Move: `packages/compiler/src/__tests__/e2e/banknexus-pipeline.test.ts` → `apps/runtime/src/__tests__/banknexus-pipeline.test.ts`
- Modify both to use runtime's executor infrastructure

**Step 1: Assess test dependencies**

Both test files currently:

1. Load `.abl` files from `examples/`
2. Compile them with the compiler (parse → compile → IR)
3. Create a `ConstructExecutor` with mock LLM + mock tools
4. Run multi-turn conversations through `executor.execute(context, options)`
5. Assert on responses, state, and trace events

After migration, they need to:

1. Load `.abl` files (unchanged)
2. Compile them (unchanged — compiler's compilation is unchanged)
3. Create a `RuntimeSession` with mock LLM + mock tools
4. Run conversations through `FlowStepExecutor.executeFlowStep()` or `ReasoningExecutor.execute()`
5. Assert on responses, state, and trace events

**Step 2: Create a test harness**

Create `apps/runtime/src/__tests__/helpers/test-harness.ts` that provides:

- `createTestSession(agentIR, options)` — creates a RuntimeSession with mock LLM and mock tool executor
- `createMockLLM(responses)` — mock LLM client matching SessionLLMClient interface
- `executeTurn(session, message, flowStepExecutor)` — runs a single turn, captures chunks and trace events

This test infrastructure already partially exists in the runtime's existing test files — extract and reuse.

**Step 3: Migrate construct-pipeline.test.ts**

Rewrite each test case to:

1. Compile the DSL (same as before)
2. Create a test session with the compiled IR
3. Use FlowStepExecutor to process each turn
4. Assert on session state and collected responses

The test scenarios themselves (GATHER, digressions, corrections, etc.) are the same — only the execution API changes.

**Step 4: Migrate banknexus-pipeline.test.ts**

Same pattern. The BankNexus tests exercise multi-agent flows with SET, TRANSFORM, ON_RESULT, CALL WITH/AS — which we added in Tasks 4-6.

**Step 5: Delete the original files from compiler**

```bash
rm packages/compiler/src/__tests__/e2e/construct-pipeline.test.ts
rm packages/compiler/src/__tests__/e2e/banknexus-pipeline.test.ts
```

**Step 6: Verify**

Run:

```bash
cd packages/compiler && npx vitest run --reporter=verbose
cd apps/runtime && npx vitest run --reporter=verbose
```

Expected: Compiler tests pass (fewer tests, nothing broken). Runtime tests pass (migrated tests working).

**Step 7: Commit**

```bash
git add -A packages/compiler/src/__tests__/e2e/ apps/runtime/src/__tests__/
git commit -m "[ABLP-2] test(runtime): migrate compiler e2e execution tests to runtime"
```

---

### Task 10: Full Build and Test Verification

**Step 1: Build the entire monorepo**

Run: `pnpm build`
Expected: Clean build, no errors.

**Step 2: Run all tests**

Run: `pnpm test`
Expected: All tests pass.

**Step 3: Search for dangling references to deleted code**

Search for:

- `ConstructExecutor` in TypeScript files (should only appear in type references, not instantiation)
- `FlowExecutor` imported from compiler (should be zero — only exists in utils.ts now)
- `ReasoningExecutor` imported from compiler (should be zero)
- `from.*constructs/executor` in import statements (should be zero)
- `from.*constructs/executors/` in import statements (should be zero)

Fix any stragglers found.

**Step 4: Verify no circular dependencies**

Run:

```bash
cd packages/compiler && npx tsc --noEmit
cd apps/runtime && npx tsc --noEmit
```

Expected: Clean compilation in both.

**Step 5: Commit if any fixes were needed**

```bash
git commit -m "[ABLP-2] refactor(abl): clean up remaining executor references after unification"
```

---

### Task Order and Dependencies

```
Task 1 (Extract pure functions to utils.ts)
  → Task 2 (Recursive → iterative FlowStepExecutor)
    → Task 3 (Remove domain coupling)
      → Task 4 (Add ON_RESULT)
      → Task 5 (Add TRANSFORM)
      → Task 6 (Add CALL WITH/AS)
        → Task 7 (Extract ReasoningExecutor)
          → Task 8 (Delete compiler executors)
            → Task 9 (Migrate e2e tests)
              → Task 10 (Full verification)
```

Tasks 4, 5, 6 can run in parallel after Task 3.
Task 7 can run in parallel with Tasks 4-6.
Tasks 8-10 must be sequential.
