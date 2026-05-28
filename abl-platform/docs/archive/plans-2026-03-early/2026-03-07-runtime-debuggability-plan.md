# Runtime Debuggability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make runtime test failures self-diagnosable by adding execution diagnostics, consolidating mocks, extracting DSL fixtures, creating a test index, and adding domain-aware assertions.

**Architecture:** Five independent helpers in `apps/runtime/src/__tests__/helpers/` plus a fixture library in `__tests__/fixtures/`. No production code changes. One test file (`reasoning-gather-handoff.test.ts`) is refactored to use the new infrastructure as proof.

**Tech Stack:** TypeScript, Vitest, Node.js fs (for fixture loading)

---

### Task 1: Create execution-diagnostics.ts helper

**Files:**

- Create: `apps/runtime/src/__tests__/helpers/execution-diagnostics.ts`

**Step 1: Create the diagnostics formatter**

```typescript
// apps/runtime/src/__tests__/helpers/execution-diagnostics.ts
import type { RuntimeSession, AgentThread } from '../../services/execution/types.js';

/**
 * Format a RuntimeSession's full state for debugging failed assertions.
 * Call this in catch blocks or custom assertions to dump execution context.
 */
export function formatSessionDiagnostics(
  session: RuntimeSession,
  mockClient?: { calls: Array<{ systemPrompt: string; messages: unknown[]; tools: unknown[] }> },
  traces?: Array<{ type: string; data: Record<string, unknown> }>,
): string {
  const lines: string[] = [];
  const hr = '─'.repeat(60);

  lines.push('');
  lines.push(`${hr}`);
  lines.push('SESSION DIAGNOSTICS');
  lines.push(`${hr}`);

  // 1. Session identity
  lines.push(`Session ID:      ${session.id}`);
  lines.push(`Agent Name:      ${session.agentName}`);
  lines.push(`Is Complete:     ${session.isComplete}`);
  lines.push(`Is Escalated:    ${session.isEscalated}`);
  lines.push(`Initialized:     ${session.initialized}`);
  lines.push(`Conv Phase:      ${session.state?.conversationPhase ?? 'n/a'}`);

  // 2. Compilation
  if (session.compilationOutput) {
    const co = session.compilationOutput;
    lines.push('');
    lines.push('COMPILATION:');
    lines.push(`  Success:       ${co.success !== false}`);
    if (co.errors && co.errors.length > 0) {
      lines.push(
        `  Errors:        ${co.errors.map((e: any) => e.message ?? String(e)).join('; ')}`,
      );
    }
    if (co.warnings && co.warnings.length > 0) {
      lines.push(
        `  Warnings:      ${co.warnings.map((w: any) => w.message ?? String(w)).join('; ')}`,
      );
    }
  } else if (!session.agentIR) {
    lines.push('');
    lines.push('COMPILATION:     No IR compiled (agentIR is null)');
  }

  // 3. Flow state
  lines.push('');
  lines.push('FLOW STATE:');
  lines.push(`  Current Step:  ${session.currentFlowStep ?? 'none'}`);
  lines.push(`  Waiting For:   ${session.waitingForInput?.join(', ') || 'nothing'}`);
  lines.push(
    `  Pending Resp:  ${session.pendingResponse ? session.pendingResponse.substring(0, 80) + '...' : 'none'}`,
  );

  // 4. Data values
  lines.push('');
  lines.push('DATA VALUES:');
  if (session.data?.values) {
    const entries = Object.entries(session.data.values);
    if (entries.length === 0) {
      lines.push('  (empty)');
    } else {
      for (const [k, v] of entries) {
        const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
        lines.push(`  ${k}: ${val.substring(0, 100)}`);
      }
    }
  }

  // 5. Gathered keys
  if (session.data?.gatheredKeys?.size > 0) {
    lines.push(`  Gathered Keys: [${[...session.data.gatheredKeys].join(', ')}]`);
  }

  // 6. Gather progress from state
  if (session.state?.gatherProgress) {
    lines.push('');
    lines.push('GATHER PROGRESS:');
    const gp = session.state.gatherProgress;
    for (const [field, info] of Object.entries(gp)) {
      lines.push(`  ${field}: ${JSON.stringify(info)}`);
    }
  }

  // 7. Thread stack
  lines.push('');
  lines.push(
    `THREADS: (${session.threads.length} total, active index: ${session.activeThreadIndex})`,
  );
  for (let i = 0; i < session.threads.length; i++) {
    const t = session.threads[i];
    const marker = i === session.activeThreadIndex ? ' [ACTIVE]' : '';
    lines.push(
      `  [${i}]${marker} agent=${t.agentName} status=${t.status} step=${t.currentFlowStep ?? 'none'} history=${t.conversationHistory.length}msgs`,
    );
    if (t.handoffFrom) {
      lines.push(`       handoffFrom=${t.handoffFrom} return=${t.returnExpected}`);
    }
    if (t.waitingForInput?.length) {
      lines.push(`       waitingFor=[${t.waitingForInput.join(', ')}]`);
    }
  }

  // 8. Handoff/delegate stacks
  if (session.handoffStack.length > 0) {
    lines.push(`\nHANDOFF STACK: [${session.handoffStack.join(' -> ')}]`);
  }
  if (session.delegateStack.length > 0) {
    lines.push(`DELEGATE STACK: [${session.delegateStack.join(' -> ')}]`);
  }

  // 9. Conversation history (last 6 messages)
  lines.push('');
  lines.push(
    `CONVERSATION HISTORY: (${session.conversationHistory.length} messages, showing last 6)`,
  );
  const lastMsgs = session.conversationHistory.slice(-6);
  for (const msg of lastMsgs) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    lines.push(`  ${msg.role}: ${content.substring(0, 120)}`);
  }

  // 10. LLM calls (from mock client)
  if (mockClient?.calls?.length) {
    lines.push('');
    lines.push(`LLM CALLS: (${mockClient.calls.length} total)`);
    for (let i = 0; i < mockClient.calls.length; i++) {
      const call = mockClient.calls[i];
      const toolNames = (call.tools as any[])?.map((t: any) => t.name).join(', ') || 'none';
      lines.push(`  [${i}] msgs=${call.messages.length} tools=[${toolNames}]`);
    }
  }

  // 11. Trace events (last 20)
  if (traces?.length) {
    lines.push('');
    lines.push(`TRACE EVENTS: (${traces.length} total, showing last 20)`);
    const lastTraces = traces.slice(-20);
    for (const t of lastTraces) {
      const summary = Object.entries(t.data)
        .filter(([k]) => !['sessionId', 'timestamp'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ')
        .substring(0, 100);
      lines.push(`  ${t.type}: ${summary}`);
    }
  }

  // 12. Agent IR summary
  if (session.agentIR) {
    lines.push('');
    lines.push('AGENT IR SUMMARY:');
    const ir = session.agentIR;
    lines.push(`  Name:          ${ir.name}`);
    lines.push(`  Mode:          ${ir.executionMode ?? 'unknown'}`);
    if (ir.gather?.fields?.length) {
      const fieldNames = ir.gather.fields.map((f: any) => `${f.name}${f.required ? '*' : ''}`);
      lines.push(`  Gather Fields: [${fieldNames.join(', ')}]`);
    }
    if (ir.handoff?.length) {
      lines.push(
        `  Handoffs:      [${ir.handoff.map((h: any) => `${h.to}(when: ${h.when ?? 'always'})`).join(', ')}]`,
      );
    }
    if (ir.flow?.steps) {
      const stepNames = Object.keys(ir.flow.steps);
      lines.push(`  Flow Steps:    [${stepNames.join(' -> ')}]`);
    }
  }

  lines.push(`${hr}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Wrap an assertion block so that on failure, session diagnostics are dumped.
 *
 * Usage:
 *   await withDiagnostics(session, mockClient, traces, () => {
 *     expect(session.agentName).toBe('Child_Agent');
 *   });
 */
export function withDiagnostics(
  session: RuntimeSession,
  mockClient?: { calls: Array<{ systemPrompt: string; messages: unknown[]; tools: unknown[] }> },
  traces?: Array<{ type: string; data: Record<string, unknown> }>,
  fn?: () => void,
): void {
  if (!fn) return;
  try {
    fn();
  } catch (e) {
    console.error(formatSessionDiagnostics(session, mockClient, traces));
    throw e;
  }
}

/**
 * Async version of withDiagnostics for assertions after await calls.
 */
export async function withDiagnosticsAsync(
  session: RuntimeSession,
  mockClient?: { calls: Array<{ systemPrompt: string; messages: unknown[]; tools: unknown[] }> },
  traces?: Array<{ type: string; data: Record<string, unknown> }>,
  fn?: () => Promise<void>,
): Promise<void> {
  if (!fn) return;
  try {
    await fn();
  } catch (e) {
    console.error(formatSessionDiagnostics(session, mockClient, traces));
    throw e;
  }
}
```

**Step 2: Verify it compiles**

Run: `cd apps/runtime && npx tsc --noEmit src/__tests__/helpers/execution-diagnostics.ts`
Expected: No errors (or check with `pnpm build` at root)

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/helpers/execution-diagnostics.ts
git commit -m "feat(runtime): add execution diagnostics helper for test failure debugging"
```

---

### Task 2: Create domain-assertions.ts helper

**Files:**

- Create: `apps/runtime/src/__tests__/helpers/domain-assertions.ts`

**Step 1: Create the domain assertions**

```typescript
// apps/runtime/src/__tests__/helpers/domain-assertions.ts
import { expect } from 'vitest';
import type { RuntimeSession } from '../../services/execution/types.js';

/**
 * Assert that a handoff from one agent to another completed successfully.
 * Produces a rich failure message with handoff stack, active agent, and data context.
 */
export function assertHandoffCompleted(
  session: RuntimeSession,
  opts: { from: string; to: string },
): void {
  const activeAgent = session.agentName;
  const threads = session.threads;
  const targetThread = threads.find((t) => t.agentName === opts.to);

  if (activeAgent !== opts.to || !targetThread) {
    const threadSummary = threads
      .map(
        (t, i) => `  [${i}] ${t.agentName} (status=${t.status}, from=${t.handoffFrom ?? 'root'})`,
      )
      .join('\n');

    const handoffIR = session.agentIR?.handoff ?? [];
    const handoffSummary = (handoffIR as any[])
      .map((h: any) => `  TO: ${h.to} WHEN: ${h.when ?? 'always'}`)
      .join('\n');

    const dataStr = Object.entries(session.data?.values ?? {})
      .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
      .join('\n');

    throw new Error(
      `Handoff from ${opts.from} to ${opts.to} did not complete.\n` +
        `  Active agent: ${activeAgent}\n` +
        `  Active thread index: ${session.activeThreadIndex}\n` +
        `  Flow step: ${session.currentFlowStep ?? 'none'}\n` +
        `\nThreads:\n${threadSummary}\n` +
        `\nHandoff rules (from IR):\n${handoffSummary || '  (none)'}\n` +
        `\ndata.values:\n${dataStr || '  (empty)'}`,
    );
  }

  // Also verify the thread's handoffFrom matches
  if (targetThread.handoffFrom && targetThread.handoffFrom !== opts.from) {
    throw new Error(
      `Handoff target thread exists but handoffFrom mismatch.\n` +
        `  Expected handoffFrom: ${opts.from}\n` +
        `  Actual handoffFrom: ${targetThread.handoffFrom}`,
    );
  }
}

/**
 * Assert gather progress: which fields are collected and which are pending.
 */
export function assertGatherProgress(
  session: RuntimeSession,
  opts: { collected?: string[]; pending?: string[] },
): void {
  const gatheredKeys = [...(session.data?.gatheredKeys ?? [])];
  const waitingFor = session.waitingForInput ?? [];

  const errors: string[] = [];

  if (opts.collected) {
    const missing = opts.collected.filter((k) => !gatheredKeys.includes(k));
    const extra = gatheredKeys.filter((k) => !opts.collected!.includes(k));
    if (missing.length > 0) {
      errors.push(`Expected collected but missing: [${missing.join(', ')}]`);
    }
    if (extra.length > 0) {
      errors.push(`Unexpectedly collected: [${extra.join(', ')}]`);
    }
  }

  if (opts.pending) {
    const missingPending = opts.pending.filter((k) => !waitingFor.includes(k));
    const extraPending = waitingFor.filter((k) => !opts.pending!.includes(k));
    if (missingPending.length > 0) {
      errors.push(`Expected pending but not waiting: [${missingPending.join(', ')}]`);
    }
    if (extraPending.length > 0) {
      errors.push(`Unexpectedly pending: [${extraPending.join(', ')}]`);
    }
  }

  if (errors.length > 0) {
    const gatherFields =
      session.agentIR?.gather?.fields?.map((f: any) => `${f.name}${f.required ? '*' : ''}`) ?? [];
    const dataStr = Object.entries(session.data?.values ?? {})
      .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
      .join('\n');

    throw new Error(
      `Gather progress mismatch.\n` +
        errors.map((e) => `  ${e}`).join('\n') +
        `\n\nActual state:\n` +
        `  Gathered keys: [${gatheredKeys.join(', ')}]\n` +
        `  Waiting for: [${waitingFor.join(', ')}]\n` +
        `  IR gather fields: [${gatherFields.join(', ')}]\n` +
        `\ndata.values:\n${dataStr || '  (empty)'}`,
    );
  }
}

/**
 * Assert the session's flow reached a specific step.
 */
export function assertFlowReached(session: RuntimeSession, stepName: string): void {
  const currentStep = session.currentFlowStep;
  if (currentStep === stepName) return;

  const flowSteps = session.agentIR?.flow?.steps ? Object.keys(session.agentIR.flow.steps) : [];

  throw new Error(
    `Flow did not reach '${stepName}'.\n` +
      `  Current step: ${currentStep ?? 'none'}\n` +
      `  Available steps: [${flowSteps.join(', ')}]\n` +
      `  Agent: ${session.agentName}\n` +
      `  Phase: ${session.state?.conversationPhase ?? 'unknown'}`,
  );
}

/**
 * Assert an agent completed execution.
 */
export function assertAgentComplete(session: RuntimeSession, agentName?: string): void {
  if (agentName && session.agentName !== agentName) {
    throw new Error(
      `Expected active agent '${agentName}' but got '${session.agentName}'.\n` +
        `  Threads: [${session.threads.map((t) => t.agentName).join(', ')}]`,
    );
  }

  if (!session.isComplete) {
    const pendingFields = session.waitingForInput ?? [];
    const gatherFields =
      session.agentIR?.gather?.fields?.map((f: any) => `${f.name}${f.required ? '*' : ''}`) ?? [];

    throw new Error(
      `Agent ${agentName ?? session.agentName} not complete.\n` +
        `  isComplete: ${session.isComplete}\n` +
        `  conversationPhase: ${session.state?.conversationPhase ?? 'unknown'}\n` +
        `  currentFlowStep: ${session.currentFlowStep ?? 'none'}\n` +
        `  Pending fields: [${pendingFields.join(', ')}]\n` +
        `  IR gather fields: [${gatherFields.join(', ')}]\n` +
        `  History: ${session.conversationHistory.length} messages`,
    );
  }
}

/**
 * Assert a specific data value was collected.
 */
export function assertDataValue(session: RuntimeSession, key: string, expected: unknown): void {
  const actual = session.data?.values?.[key];
  try {
    expect(actual).toEqual(expected);
  } catch {
    const allValues = Object.entries(session.data?.values ?? {})
      .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
      .join('\n');

    throw new Error(
      `Data value mismatch for '${key}'.\n` +
        `  Expected: ${JSON.stringify(expected)}\n` +
        `  Actual:   ${JSON.stringify(actual)}\n` +
        `\nAll data.values:\n${allValues || '  (empty)'}`,
    );
  }
}
```

**Step 2: Verify it compiles**

Run: `cd apps/runtime && npx tsc --noEmit src/__tests__/helpers/domain-assertions.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/helpers/domain-assertions.ts
git commit -m "feat(runtime): add domain-aware test assertions with rich failure messages"
```

---

### Task 3: Create DSL fixture library

**Files:**

- Create: `apps/runtime/src/__tests__/fixtures/reasoning-gather.abl`
- Create: `apps/runtime/src/__tests__/fixtures/reasoning-sales.abl`
- Create: `apps/runtime/src/__tests__/fixtures/supervisor-handoff.abl`
- Create: `apps/runtime/src/__tests__/fixtures/delegate-booking.abl`
- Create: `apps/runtime/src/__tests__/fixtures/parent-child-handoff.abl`
- Create: `apps/runtime/src/__tests__/fixtures/simple-flow.abl`
- Create: `apps/runtime/src/__tests__/fixtures/index.ts`

**Step 1: Extract DSL fixtures from reasoning-gather-handoff.test.ts**

Extract the 7 DSL constants (lines 173-357) into individual `.abl` files. Each file is the raw DSL string content (no backticks, no const).

`reasoning-gather.abl` = REASONING_AGENT_WITH_GATHER (Sales_Chat with destination, travel_date, num_passengers)
`reasoning-sales.abl` = REASONING_SALES_AGENT (Sales_Agent with destination, departure_date, budget)
`reasoning-welcome.abl` = Welcome_Agent (user_name)
`supervisor-handoff.abl` = SUPERVISOR_WITH_HANDOFFS (Travel_Supervisor routing to Sales_Agent and Welcome_Agent)
`delegate-booking.abl` = AGENT_WITH_DELEGATE (Booking_Manager delegating to Fee_Calculator)
`reasoning-fee-calculator.abl` = Fee_Calculator
`parent-child-handoff.abl` = From flow-handoff-threads.test.ts Parent_Agent + Child_Agent (kept as single file with `---` separator for loadFixturePair)
`simple-flow.abl` = Minimal scripted agent with entry -> complete

**Step 2: Create the fixture loader**

```typescript
// apps/runtime/src/__tests__/fixtures/index.ts
import { readFileSync } from 'fs';
import { join } from 'path';

const fixtureDir = new URL('.', import.meta.url).pathname;

const cache = new Map<string, string>();

/**
 * Load a DSL fixture by name (without extension).
 * Caches results for the duration of the test run.
 */
export function loadFixture(name: string): string {
  if (cache.has(name)) return cache.get(name)!;
  const content = readFileSync(join(fixtureDir, `${name}.abl`), 'utf-8');
  cache.set(name, content);
  return content;
}

/**
 * Load a fixture file that contains two DSL definitions separated by `---`.
 * Returns [first, second] as a tuple.
 */
export function loadFixturePair(name: string): [string, string] {
  const content = loadFixture(name);
  const parts = content.split(/\n---\n/);
  if (parts.length !== 2) {
    throw new Error(
      `Fixture '${name}' expected 2 DSL blocks separated by ---, found ${parts.length}`,
    );
  }
  return [parts[0].trim(), parts[1].trim()];
}
```

**Step 3: Create the .abl fixture files**

Each file is extracted from the test constants. See source file `reasoning-gather-handoff.test.ts` lines 173-357 and `flow-handoff-threads.test.ts` lines 29-72.

**Step 4: Commit**

```bash
git add apps/runtime/src/__tests__/fixtures/
git commit -m "feat(runtime): extract DSL test fixtures into reusable .abl files"
```

---

### Task 4: Consolidate MockAnthropicClient in reasoning-gather-handoff.test.ts

**Files:**

- Modify: `apps/runtime/src/__tests__/reasoning-gather-handoff.test.ts:17-167` (remove inline mock, import shared one)

**Step 1: Replace inline mock with shared import**

In `reasoning-gather-handoff.test.ts`:

- Remove lines 26-167 (inline MockAnthropicClient class, injectMockClient function, CapturedTrace interface, createTraceCollector, filterTraces)
- Add imports from shared helpers:

```typescript
import {
  ValidatingMockAnthropicClient,
  injectValidatingMockClient,
  createTraceCollector,
  filterTraces,
  type CapturedTrace,
} from './helpers/history-validation';
```

- In `beforeEach`, replace `mockClient = injectMockClient(executor)` with `mockClient = injectValidatingMockClient(executor)`
- Update the type annotation from `MockAnthropicClient` to `ValidatingMockAnthropicClient`

**Step 2: Fix any API differences**

The ValidatingMockAnthropicClient has the same API surface (`setResponseHandler`, `setEntityExtractionResponse`, `calls`) but adds `operationType` parameter. The existing test's `setEntityExtractionResponse` uses tool-based detection (`_extract_entities` tool) while the shared one uses `operationType === 'extraction'`. Check which pattern the RuntimeExecutor actually uses and align.

If the executor passes `operationType`, use the shared mock as-is.
If not, add the tool-name-based detection from the inline mock to the shared ValidatingMockAnthropicClient.

**Step 3: Run the tests**

Run: `cd apps/runtime && pnpm test -- --run reasoning-gather-handoff`
Expected: All 60 tests pass

**Step 4: Commit**

```bash
git add apps/runtime/src/__tests__/reasoning-gather-handoff.test.ts
git add apps/runtime/src/__tests__/helpers/history-validation.ts  # if modified
git commit -m "refactor(runtime): consolidate MockAnthropicClient to shared ValidatingMockAnthropicClient"
```

---

### Task 5: Create TEST_INDEX.md

**Files:**

- Create: `apps/runtime/src/__tests__/TEST_INDEX.md`

**Step 1: Generate the index**

Scan all handoff/gather/flow/delegate test files and map them to execution paths. The index should cover at minimum the core execution test files (not authz, routes, or infrastructure tests).

```markdown
# Runtime Test Index

Quick reference: which test files cover which execution paths.
Use this to find relevant tests when a specific runtime behavior breaks.

## Execution Path Index

| File                                     | Execution Paths Covered                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| reasoning-gather-handoff.test.ts         | gather, LLM extraction, handoff context, delegate, data sync, traces       |
| flow-handoff-threads.test.ts             | handoff threads, RETURN, PASS fields, handoff conditions, target-not-found |
| scripted-mode-handoff-fix.unit.test.ts   | scripted mode handoff, mixed mode (supervisor -> scripted child)           |
| routing-remote-handoff.test.ts           | remote agent handoff, cross-deployment routing                             |
| project-config-handoff.test.ts           | project-level handoff config, runtime config on handoff                    |
| guardrails/handoff-rails.test.ts         | handoff guardrails, pre/post handoff policy                                |
| handoff-guardrail-llmeval.test.ts        | LLM-evaluated handoff guardrails                                           |
| agent-transfer-boot.test.ts              | agent transfer bootstrap, external transfer                                |
| agent-transfer-bridge.test.ts            | transfer bridge, cross-system handoff                                      |
| agent-transfer-webhooks.test.ts          | transfer webhooks, callback handling                                       |
| transfer-tool-executor.test.ts           | transfer tool execution                                                    |
| constraint-checker.test.ts               | constraint evaluation, backtracking                                        |
| constraint-control-flow-enhanced.test.ts | constraint-driven flow control, COLLECT actions                            |
| constraint-decision-traces.test.ts       | constraint decision trace events                                           |
| extraction-strategy.test.ts              | entity extraction strategy selection, fallback                             |
| extraction-tool-call.test.ts             | tool-call-based extraction                                                 |
| extraction-decision-traces.test.ts       | extraction decision trace events                                           |
| gather-decision-traces.test.ts           | gather field decision trace events                                         |
| gather-lookup-integration.test.ts        | gather with lookup data sources                                            |
| execution-coordinator.test.ts            | execution orchestration, multi-step flows                                  |
| execution-events.test.ts                 | execution event emission                                                   |
| execution-dedup.test.ts                  | duplicate execution prevention                                             |
| delegation-intent-isolation.test.ts      | delegate intent isolation                                                  |
| multi-intent-strategy.test.ts            | multi-intent detection and handling                                        |
| clarification-count.test.ts              | clarification loop detection                                               |
| correction-enhanced.test.ts              | user correction handling                                                   |
| coordinator-wiring.test.ts               | coordinator service wiring                                                 |

## By Feature

**Handoff broken?** Check:

1. flow-handoff-threads.test.ts
2. reasoning-gather-handoff.test.ts (handoff/delegate sections)
3. scripted-mode-handoff-fix.unit.test.ts
4. routing-remote-handoff.test.ts

**Gather broken?** Check:

1. reasoning-gather-handoff.test.ts (gather sections)
2. extraction-strategy.test.ts
3. gather-decision-traces.test.ts
4. gather-lookup-integration.test.ts

**Constraints broken?** Check:

1. constraint-checker.test.ts
2. constraint-control-flow-enhanced.test.ts
3. constraint-decision-traces.test.ts

**Delegation broken?** Check:

1. reasoning-gather-handoff.test.ts (delegate sections)
2. delegation-intent-isolation.test.ts
3. pre-refactor/constraint-delegation.test.ts

**Flow/transitions broken?** Check:

1. flow-handoff-threads.test.ts
2. execution-coordinator.test.ts
3. pre-refactor/thread-model.test.ts
```

**Step 2: Commit**

```bash
git add apps/runtime/src/__tests__/TEST_INDEX.md
git commit -m "docs(runtime): add TEST_INDEX.md mapping test files to execution paths"
```

---

### Task 6: Write tests for the new helpers

**Files:**

- Create: `apps/runtime/src/__tests__/helpers/__tests__/execution-diagnostics.test.ts`

**Step 1: Write tests for formatSessionDiagnostics**

```typescript
import { describe, test, expect } from 'vitest';
import { formatSessionDiagnostics, withDiagnostics } from '../execution-diagnostics';
import { createBaseSession } from '../../pre-refactor/helpers/test-session-factory';

describe('formatSessionDiagnostics', () => {
  test('includes session identity fields', () => {
    const session = createBaseSession({ agentName: 'TestAgent', isComplete: false });
    const output = formatSessionDiagnostics(session);

    expect(output).toContain('TestAgent');
    expect(output).toContain('Is Complete:     false');
  });

  test('includes data values', () => {
    const session = createBaseSession({
      data: { values: { city: 'Paris', count: 3 }, gatheredKeys: new Set(['city']) },
    });
    const output = formatSessionDiagnostics(session);

    expect(output).toContain('city: Paris');
    expect(output).toContain('count: 3');
    expect(output).toContain('Gathered Keys: [city]');
  });

  test('includes thread information', () => {
    const session = createBaseSession({
      threads: [
        {
          agentName: 'Parent',
          status: 'waiting',
          conversationHistory: [],
          state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
          data: { values: {}, gatheredKeys: new Set() },
          startedAt: Date.now(),
          returnExpected: false,
        },
        {
          agentName: 'Child',
          status: 'active',
          handoffFrom: 'Parent',
          conversationHistory: [],
          state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
          data: { values: {}, gatheredKeys: new Set() },
          startedAt: Date.now(),
          returnExpected: true,
        },
      ],
      activeThreadIndex: 1,
    });
    const output = formatSessionDiagnostics(session);

    expect(output).toContain('[0]');
    expect(output).toContain('Parent');
    expect(output).toContain('[1]');
    expect(output).toContain('[ACTIVE]');
    expect(output).toContain('Child');
    expect(output).toContain('handoffFrom=Parent');
  });

  test('includes mock LLM call info', () => {
    const session = createBaseSession();
    const mockClient = {
      calls: [
        {
          systemPrompt: 'sys',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [{ name: 'search' }],
        },
      ],
    };
    const output = formatSessionDiagnostics(session, mockClient);

    expect(output).toContain('LLM CALLS: (1 total)');
    expect(output).toContain('tools=[search]');
  });

  test('includes trace events', () => {
    const session = createBaseSession();
    const traces = [
      { type: 'handoff', data: { toAgent: 'Billing' } },
      { type: 'decision', data: { choice: 'route' } },
    ];
    const output = formatSessionDiagnostics(session, undefined, traces);

    expect(output).toContain('TRACE EVENTS: (2 total');
    expect(output).toContain('handoff:');
    expect(output).toContain('toAgent=Billing');
  });
});

describe('withDiagnostics', () => {
  test('does not interfere with passing assertions', () => {
    const session = createBaseSession({ agentName: 'Test' });
    withDiagnostics(session, undefined, undefined, () => {
      expect(session.agentName).toBe('Test');
    });
  });

  test('dumps diagnostics on assertion failure', () => {
    const session = createBaseSession({ agentName: 'Wrong' });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      withDiagnostics(session, undefined, undefined, () => {
        expect(session.agentName).toBe('Expected');
      });
    }).toThrow();

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0];
    expect(output).toContain('Wrong');
    expect(output).toContain('SESSION DIAGNOSTICS');

    consoleSpy.mockRestore();
  });
});
```

**Step 2: Run the test**

Run: `cd apps/runtime && pnpm test -- --run helpers/__tests__/execution-diagnostics`
Expected: All tests pass

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/helpers/__tests__/execution-diagnostics.test.ts
git commit -m "test(runtime): add tests for execution diagnostics helper"
```

---

### Task 7: Verify full test suite still passes

**Step 1: Build**

Run: `pnpm build`
Expected: Clean build

**Step 2: Run the affected test files**

Run: `cd apps/runtime && pnpm test -- --run reasoning-gather-handoff`
Expected: All 60 tests pass

Run: `cd apps/runtime && pnpm test -- --run flow-handoff-threads`
Expected: All 7 tests pass

Run: `cd apps/runtime && pnpm test -- --run helpers/__tests__/execution-diagnostics`
Expected: All tests pass

**Step 3: Final commit (if any fixups needed)**

```bash
git commit -m "fix(runtime): test suite alignment after debuggability refactor"
```
