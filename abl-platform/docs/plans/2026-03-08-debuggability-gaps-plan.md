# Debuggability Gaps Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire decision log data from runtime to Studio via WebSocket, forward construct-layer trace events to the runtime TraceStore, and enhance the MCP `debug_explain_decision` tool to use the decision log.

**Architecture:** Three independent features: (1) Add `decisionLog` to the WebSocket `state_update` message and wire it through Studio's session store to the DecisionTreeView component. (2) Replace the no-op trace stub in `execution-context-bridge.ts` with a forwarding implementation that pipes construct-layer events into the runtime's TraceStore. (3) Enhance the existing `debug_explain_decision` MCP tool in `packages/mcp-debug` to query the decision log entries and build causal chain explanations.

**Tech Stack:** TypeScript, Vitest, React, Zustand, WebSocket, MCP SDK (zod)

---

## Part 1: WebSocket Decision Log Wiring

### Task 1: Add `decisionLog` to runtime AgentState type and state_update message

**Files:**

- Modify: `apps/runtime/src/types/index.ts:9-38` (AgentState interface)
- Modify: `apps/runtime/src/websocket/handler.ts:1524-1541` (stateUpdate emission after message processing)

**Step 1: Add `decisionLog` field to runtime AgentState**

In `apps/runtime/src/types/index.ts`, after the `activeAgent` field (~line 37), add:

```typescript
  /** Decision log entries — causal chain of runtime decisions (only populated when traceVerbosity >= verbose) */
  decisionLog?: Array<{
    turn: number;
    timestamp: number;
    type: string;
    outcome: string;
    condition?: string;
    matched: boolean;
    trigger?: Record<string, unknown>;
    candidates?: string[];
    selectedReason?: string;
    field?: string;
    violation?: string;
    oldValue?: unknown;
    newValue?: unknown;
    source?: string;
  }>;
```

**Step 2: Include `decisionLog` in state_update WebSocket message**

In `apps/runtime/src/websocket/handler.ts`, find the state_update construction at ~line 1524-1541. After the `activeAgent` block (line 1533), add:

```typescript
// Include decision log if present (verbose/debug sessions only)
const runtimeSession = getRuntimeExecutor().getSession(sessionId);
if (runtimeSession?.decisionLog?.length) {
  stateUpdate.decisionLog = runtimeSession.decisionLog;
}
```

**Step 3: Also include decisionLog in initial state_update on agent load**

In `apps/runtime/src/websocket/handler.ts`, find the initial state emission at ~line 976-988. After the `initialState` object:

```typescript
const initialState = {
  gatherProgress: runtimeSession.state.gatherProgress,
  context: runtimeSession.state.context,
  conversationPhase: runtimeSession.state.conversationPhase,
  decisionLog: runtimeSession.decisionLog,
};
```

**Step 4: Run type check**

Run: `cd apps/runtime && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/types/index.ts apps/runtime/src/websocket/handler.ts
git add apps/runtime/src/types/index.ts apps/runtime/src/websocket/handler.ts
git commit -m "[ABLP-2] feat(runtime): include decisionLog in WebSocket state_update messages"
```

---

### Task 2: Add `decisionLog` to Studio AgentState type and session store

**Files:**

- Modify: `apps/studio/src/types/index.ts:54-83` (AgentState interface)
- Modify: `apps/studio/src/store/session-store.ts:141-155` (updateState action)

**Step 1: Add `decisionLog` field to Studio AgentState**

In `apps/studio/src/types/index.ts`, after the `activeAgent` field (~line 82), add the same field:

```typescript
  /** Decision log entries from runtime (verbose/debug sessions) */
  decisionLog?: Array<{
    turn: number;
    timestamp: number;
    type: string;
    outcome: string;
    condition?: string;
    matched: boolean;
    trigger?: Record<string, unknown>;
    candidates?: string[];
    selectedReason?: string;
    field?: string;
    violation?: string;
    oldValue?: unknown;
    newValue?: unknown;
    source?: string;
  }>;
```

**Step 2: Ensure `updateState` merges `decisionLog`**

In `apps/studio/src/store/session-store.ts`, the `updateState` method at ~line 141 already does a spread: `{ ...currentState, ...updates }`. The `decisionLog` field will be merged automatically because it's a top-level field. No code change needed — the spread handles it.

Verify: read the `updateState` implementation to confirm the top-level spread.

**Step 3: Run type check**

Run: `cd apps/studio && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

**Step 4: Commit**

```bash
npx prettier --write apps/studio/src/types/index.ts
git add apps/studio/src/types/index.ts
git commit -m "[ABLP-2] feat(studio): add decisionLog field to AgentState type"
```

---

### Task 3: Wire DecisionsTab to real store data

**Files:**

- Modify: `apps/studio/src/components/observatory/DebugTabs.tsx:315-326` (DecisionsTab function)

**Step 1: Replace `entries={[]}` with real store selector**

In `apps/studio/src/components/observatory/DebugTabs.tsx`, replace the `DecisionsTab` function:

```typescript
function DecisionsTab() {
  const state = useSessionStore((s) => s.state);
  const messages = useSessionStore((s) => s.messages);

  const entries = useMemo(
    () => (state?.decisionLog ?? []) as import('./DecisionTreeView').DecisionEntryDisplay[],
    [state?.decisionLog],
  );

  const messageData = useMemo(
    () => messages.map((m) => ({ role: m.role, content: m.content })),
    [messages],
  );

  return <DecisionTreeView entries={entries} messages={messageData} />;
}
```

Remove the old TODO comment above the function.

**Step 2: Check the DecisionTreeView props type**

Read `apps/studio/src/components/observatory/DecisionTreeView.tsx` to confirm the `entries` prop type matches the `decisionLog` array shape. Export the entry type if needed.

**Step 3: Run type check**

Run: `cd apps/studio && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

**Step 4: Commit**

```bash
npx prettier --write apps/studio/src/components/observatory/DebugTabs.tsx
git add apps/studio/src/components/observatory/DebugTabs.tsx
git commit -m "[ABLP-2] feat(studio): wire DecisionsTab to real decisionLog from session state"
```

---

### Task 4: Test WebSocket decision log wiring

**Files:**

- Create: `apps/runtime/src/__tests__/decision-log-websocket.test.ts`

**Step 1: Write integration test**

```typescript
import { describe, test, expect } from 'vitest';
import type { RuntimeSession } from '../services/execution/types';
import { appendDecision, shouldLogDecisions } from '../services/execution/decision-log';

describe('Decision Log WebSocket Wiring', () => {
  test('decisionLog is included in session state when verbosity is verbose', () => {
    // Simulate what the WebSocket handler does: read decisionLog from session
    const session = {
      traceVerbosity: 'verbose' as const,
      conversationHistory: [{ role: 'user', content: 'hello' }],
      decisionLog: undefined,
    } as unknown as RuntimeSession;

    appendDecision(session, {
      type: 'handoff',
      outcome: 'Billing_Agent',
      matched: true,
      condition: "intent == 'billing'",
      candidates: ['Billing_Agent', 'Support_Agent'],
    });

    // Simulate stateUpdate construction (same as handler.ts ~line 1525)
    const stateUpdate: Record<string, unknown> = {
      gatherProgress: {},
      context: {},
      conversationPhase: 'active',
    };
    if (session.decisionLog?.length) {
      stateUpdate.decisionLog = session.decisionLog;
    }

    expect(stateUpdate.decisionLog).toBeDefined();
    expect((stateUpdate.decisionLog as any[]).length).toBe(1);
    expect((stateUpdate.decisionLog as any[])[0].type).toBe('handoff');
    expect((stateUpdate.decisionLog as any[])[0].outcome).toBe('Billing_Agent');
  });

  test('decisionLog is NOT included when verbosity is standard', () => {
    const session = {
      traceVerbosity: 'standard' as const,
      conversationHistory: [],
      decisionLog: undefined,
    } as unknown as RuntimeSession;

    appendDecision(session, {
      type: 'handoff',
      outcome: 'Billing_Agent',
      matched: true,
    });

    const stateUpdate: Record<string, unknown> = {
      gatherProgress: {},
      context: {},
      conversationPhase: 'active',
    };
    if (session.decisionLog?.length) {
      stateUpdate.decisionLog = session.decisionLog;
    }

    expect(stateUpdate.decisionLog).toBeUndefined();
  });

  test('decisionLog accumulates across multiple turns', () => {
    const session = {
      traceVerbosity: 'debug' as const,
      conversationHistory: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      decisionLog: undefined,
    } as unknown as RuntimeSession;

    appendDecision(session, {
      type: 'gather_extraction',
      outcome: 'destination extracted',
      matched: true,
    });
    appendDecision(session, {
      type: 'field_validation',
      outcome: 'pass',
      matched: true,
      field: 'destination',
    });
    appendDecision(session, {
      type: 'completion',
      outcome: 'not_complete',
      matched: false,
    });

    const stateUpdate: Record<string, unknown> = {};
    if (session.decisionLog?.length) {
      stateUpdate.decisionLog = session.decisionLog;
    }

    expect((stateUpdate.decisionLog as any[]).length).toBe(3);
    // Verify JSON serialization round-trip (WebSocket sends JSON)
    const serialized = JSON.stringify(stateUpdate);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.decisionLog.length).toBe(3);
    expect(deserialized.decisionLog[0].type).toBe('gather_extraction');
  });
});
```

**Step 2: Run test**

Run: `cd apps/runtime && npx vitest run --reporter=verbose decision-log-websocket 2>&1 | tail -20`
Expected: All 3 tests pass

**Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/__tests__/decision-log-websocket.test.ts
git add apps/runtime/src/__tests__/decision-log-websocket.test.ts
git commit -m "[ABLP-2] test(runtime): add decision log WebSocket wiring tests"
```

---

## Part 2: Construct-Layer Trace Forwarding

### Task 5: Create a forwarding TraceContextManager wrapper

**Files:**

- Create: `apps/runtime/src/services/execution/trace-forwarder.ts`
- Test: `apps/runtime/src/__tests__/trace-forwarder.test.ts`

**Context:** The execution-context-bridge (`apps/runtime/src/services/execution/execution-context-bridge.ts:117-125`) currently creates a no-op trace stub when `deps.trace` is not provided. The construct layer (e.g., `packages/compiler/src/platform/constructs/executors/constraint-executor.ts`) calls `trace.logConstraintCheck()`, `trace.logDecision()`, etc. but these go to the no-op stub. We need a forwarding wrapper that pipes these events into the runtime's `TraceStore`.

The `TraceContextManager` class (in `packages/compiler/src/platform/stores/trace-store.ts:99`) has these methods used by constructs:

- `logLLMCall(params)` — LLM call trace
- `logToolCall(params)` — Tool call trace
- `logDecision(params)` — Decision trace
- `logConstraintCheck(constraint, passed, context)` — Constraint check trace
- `logHandoff(toAgent, reason, context)` — Handoff trace
- `startSpan(name)` → `{ end() }` — Span management
- `getCurrentSpan()` — Current span
- `addEvent(event)` — Generic event

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/trace-forwarder.test.ts
import { describe, test, expect, vi } from 'vitest';
import { createTraceForwarder } from '../services/execution/trace-forwarder';

describe('TraceForwarder', () => {
  function createMockTraceStore() {
    return {
      addEvent: vi.fn(),
    };
  }

  test('forwards logConstraintCheck to TraceStore.addEvent', () => {
    const store = createMockTraceStore();
    const forwarder = createTraceForwarder('session-1', store as any);

    forwarder.logConstraintCheck('age >= 18', true, { age: 21 });

    expect(store.addEvent).toHaveBeenCalledOnce();
    const [sessionId, event] = store.addEvent.mock.calls[0];
    expect(sessionId).toBe('session-1');
    expect(event.type).toBe('constraint_check');
    expect(event.data.constraint).toBe('age >= 18');
    expect(event.data.passed).toBe(true);
    expect(event.source).toBe('construct-layer');
  });

  test('forwards logDecision to TraceStore.addEvent', () => {
    const store = createMockTraceStore();
    const forwarder = createTraceForwarder('session-2', store as any);

    forwarder.logDecision({
      decisionType: 'routing',
      decision: 'handoff to Billing',
      reasoning: 'intent matches billing',
    });

    expect(store.addEvent).toHaveBeenCalledOnce();
    const [sessionId, event] = store.addEvent.mock.calls[0];
    expect(sessionId).toBe('session-2');
    expect(event.type).toBe('decision');
    expect(event.data.decision).toBe('handoff to Billing');
    expect(event.source).toBe('construct-layer');
  });

  test('forwards logHandoff to TraceStore.addEvent', () => {
    const store = createMockTraceStore();
    const forwarder = createTraceForwarder('session-3', store as any);

    forwarder.logHandoff('Sales_Agent', 'intent match', { intent: 'sales' });

    expect(store.addEvent).toHaveBeenCalledOnce();
    const [, event] = store.addEvent.mock.calls[0];
    expect(event.type).toBe('handoff');
    expect(event.data.toAgent).toBe('Sales_Agent');
    expect(event.source).toBe('construct-layer');
  });

  test('startSpan returns a span with end()', () => {
    const store = createMockTraceStore();
    const forwarder = createTraceForwarder('session-4', store as any);

    const span = forwarder.startSpan('test-span');
    expect(span).toBeDefined();
    expect(typeof span.end).toBe('function');
    // Should not throw
    span.end();
  });

  test('addEvent forwards generic events', () => {
    const store = createMockTraceStore();
    const forwarder = createTraceForwarder('session-5', store as any);

    forwarder.addEvent({
      type: 'custom' as any,
      timestamp: new Date(),
      data: { foo: 'bar' },
    });

    expect(store.addEvent).toHaveBeenCalledOnce();
    const [, event] = store.addEvent.mock.calls[0];
    expect(event.data.foo).toBe('bar');
    expect(event.source).toBe('construct-layer');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run --reporter=verbose trace-forwarder 2>&1 | tail -20`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// apps/runtime/src/services/execution/trace-forwarder.ts
/**
 * Trace Forwarder
 *
 * Creates a TraceContextManager-compatible object that forwards
 * construct-layer trace events into the runtime's TraceStore.
 * This bridges the compiler's construct executors (which emit trace events
 * via TraceContextManager methods) with the runtime's TraceStore (which
 * feeds the Observatory UI, MCP debug tools, and ClickHouse).
 */

import type { TraceContextManager } from '@abl/compiler/platform/stores/trace-store.js';
import type { TraceStoreInterface } from '../trace-store.js';

/**
 * Create a TraceContextManager-compatible forwarder that pipes events
 * into the runtime's TraceStore for a given session.
 */
export function createTraceForwarder(
  sessionId: string,
  traceStore: TraceStoreInterface,
): TraceContextManager {
  const traceId = `trace-construct-${sessionId}`;
  const spanId = `span-construct-${sessionId}`;
  let spanCounter = 0;

  function makeEvent(type: string, data: Record<string, unknown>) {
    return {
      type,
      timestamp: new Date(),
      data,
      source: 'construct-layer',
      spanId,
      traceId,
      sessionId,
    };
  }

  return {
    get traceId() {
      return traceId;
    },
    get spanId() {
      return spanId;
    },

    async logLLMCall(params) {
      traceStore.addEvent(
        sessionId,
        makeEvent('llm_call', {
          model: params.model,
          tokensIn: params.tokensIn,
          tokensOut: params.tokensOut,
          latencyMs: params.latencyMs,
        }) as any,
      );
    },

    async logToolCall(params) {
      traceStore.addEvent(
        sessionId,
        makeEvent('tool_call', {
          toolName: params.toolName,
          input: params.input,
          output: params.output,
          success: params.success,
          latencyMs: params.latencyMs,
          error: params.error,
        }) as any,
      );
    },

    async logDecision(params) {
      traceStore.addEvent(
        sessionId,
        makeEvent('decision', {
          decisionType: params.decisionType,
          decision: params.decision,
          reasoning: params.reasoning,
          contextSnapshot: params.contextSnapshot,
        }) as any,
      );
    },

    async logConstraintCheck(
      constraint: string,
      passed: boolean,
      context: Record<string, unknown>,
    ) {
      traceStore.addEvent(
        sessionId,
        makeEvent('constraint_check', {
          constraint,
          passed,
          context,
        }) as any,
      );
    },

    async logHandoff(toAgent: string, reason: string, context: Record<string, unknown>) {
      traceStore.addEvent(
        sessionId,
        makeEvent('handoff', {
          toAgent,
          reason,
          context,
        }) as any,
      );
    },

    startSpan(name: string) {
      const localSpanId = `span-construct-${++spanCounter}-${name}`;
      return {
        spanId: localSpanId,
        end: () => {
          // No-op — construct-layer spans are lightweight
        },
      };
    },

    getCurrentSpan() {
      return undefined;
    },

    addEvent(event) {
      traceStore.addEvent(sessionId, {
        ...event,
        source: 'construct-layer',
        spanId,
        traceId,
        sessionId,
      } as any);
    },
  } as unknown as TraceContextManager;
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run --reporter=verbose trace-forwarder 2>&1 | tail -20`
Expected: All 5 tests pass

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/trace-forwarder.ts apps/runtime/src/__tests__/trace-forwarder.test.ts
git add apps/runtime/src/services/execution/trace-forwarder.ts apps/runtime/src/__tests__/trace-forwarder.test.ts
git commit -m "[ABLP-2] feat(runtime): add construct-layer trace forwarder"
```

---

### Task 6: Wire trace forwarder into execution-context-bridge

**Files:**

- Modify: `apps/runtime/src/services/execution/execution-context-bridge.ts:117-125`
- Modify: `apps/runtime/src/services/execution/execution-context-bridge.ts:36-43` (BridgeDeps)

**Step 1: Add traceStore to BridgeDeps**

In `apps/runtime/src/services/execution/execution-context-bridge.ts`, add to the `BridgeDeps` interface:

```typescript
export interface BridgeDeps {
  toolExecutor?: ToolExecutor;
  llmClient?: LLMClient;
  /** Trace context manager — when provided, wired into the execution context */
  trace?: TraceContextManager;
  /** Store instances — when provided, wired into the execution context (partial allowed) */
  stores?: Partial<StoreContext>;
  /** Runtime trace store — used to create a forwarding TraceContextManager when deps.trace is not provided */
  traceStore?: import('../trace-store.js').TraceStoreInterface;
}
```

**Step 2: Replace the no-op trace stub with the forwarder**

Replace the trace wiring at ~line 117-125:

```typescript
// Wire trace from deps or fall back to a forwarding implementation
// that pipes construct-layer events into the runtime TraceStore
const trace: ExecutionContext['trace'] = deps.trace
  ? deps.trace
  : deps.traceStore
    ? (createTraceForwarder(session.id, deps.traceStore) as unknown as ExecutionContext['trace'])
    : ({
        startSpan: () => ({ end: () => {} }),
        getCurrentSpan: () => undefined,
        addEvent: () => {},
        logConstraintCheck: () => {},
      } as unknown as ExecutionContext['trace']);
```

Add the import at the top:

```typescript
import { createTraceForwarder } from './trace-forwarder.js';
```

**Step 3: Wire traceStore in callers of buildExecutionContext**

Search for all call sites of `buildExecutionContext` to add `traceStore`:

Run: `grep -rn "buildExecutionContext" apps/runtime/src/ --include="*.ts" | grep -v test | grep -v ".d.ts"`

For each caller, add `traceStore: getTraceStore()` to the deps object. The main callers are:

- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`

In each file, find the `buildExecutionContext(session, { ... })` call and add `traceStore: getTraceStore()` to the deps object. Import `getTraceStore` from `'../trace-store.js'` if not already imported.

**Step 4: Run type check and existing tests**

Run: `cd apps/runtime && npx tsc --noEmit 2>&1 | head -20`
Run: `cd apps/runtime && npx vitest run --reporter=verbose execution-context-bridge 2>&1 | tail -20`
Expected: No new errors, all existing tests pass

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/execution-context-bridge.ts apps/runtime/src/services/execution/routing-executor.ts apps/runtime/src/services/execution/flow-step-executor.ts
git add apps/runtime/src/services/execution/execution-context-bridge.ts apps/runtime/src/services/execution/routing-executor.ts apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "[ABLP-2] feat(runtime): wire construct-layer trace forwarding via execution-context-bridge"
```

---

### Task 7: Test construct-layer trace forwarding end-to-end

**Files:**

- Create: `apps/runtime/src/__tests__/trace-forwarder-integration.test.ts`

**Step 1: Write integration test**

```typescript
import { describe, test, expect } from 'vitest';
import { buildExecutionContext } from '../services/execution/execution-context-bridge';
import { createBaseSession } from './pre-refactor/helpers/test-session-factory';

describe('Construct-Layer Trace Forwarding Integration', () => {
  test('buildExecutionContext with traceStore creates a forwarding trace', () => {
    const session = createBaseSession({ traceVerbosity: 'debug' });
    // Minimal agentIR to satisfy buildExecutionContext
    session.agentIR = { name: 'Test', execution: { mode: 'reasoning' } } as any;

    const events: any[] = [];
    const mockTraceStore = {
      addEvent: (sessionId: string, event: any) => {
        events.push({ sessionId, event });
      },
    };

    const ctx = buildExecutionContext(session, {
      traceStore: mockTraceStore as any,
    });

    // The trace should be a forwarder, not a no-op
    expect(ctx.trace).toBeDefined();

    // logConstraintCheck should forward to our mock store
    ctx.trace.logConstraintCheck('age >= 18', true, { age: 21 });

    expect(events.length).toBe(1);
    expect(events[0].sessionId).toBe(session.id);
    expect(events[0].event.type).toBe('constraint_check');
    expect(events[0].event.source).toBe('construct-layer');
  });

  test('buildExecutionContext without traceStore uses no-op stub', () => {
    const session = createBaseSession();
    session.agentIR = { name: 'Test', execution: { mode: 'reasoning' } } as any;

    const ctx = buildExecutionContext(session, {});

    // Should not throw
    expect(() => {
      ctx.trace.logConstraintCheck('test', true, {});
    }).not.toThrow();
  });

  test('buildExecutionContext with explicit trace dep takes precedence', () => {
    const session = createBaseSession();
    session.agentIR = { name: 'Test', execution: { mode: 'reasoning' } } as any;

    const customTrace = {
      logConstraintCheck: () => {},
      startSpan: () => ({ end: () => {} }),
      getCurrentSpan: () => undefined,
      addEvent: () => {},
    };

    const mockTraceStore = { addEvent: () => {} };

    const ctx = buildExecutionContext(session, {
      trace: customTrace as any,
      traceStore: mockTraceStore as any,
    });

    // Should use the explicit trace, not the forwarder
    expect(ctx.trace).toBe(customTrace);
  });
});
```

**Step 2: Run test**

Run: `cd apps/runtime && npx vitest run --reporter=verbose trace-forwarder-integration 2>&1 | tail -20`
Expected: All 3 tests pass

**Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/__tests__/trace-forwarder-integration.test.ts
git add apps/runtime/src/__tests__/trace-forwarder-integration.test.ts
git commit -m "[ABLP-2] test(runtime): add construct-layer trace forwarding integration tests"
```

---

## Part 3: Enhance MCP debug_explain_decision

### Task 8: Enhance `debug_explain_decision` to use decision log

**Files:**

- Modify: `packages/mcp-debug/src/tools/decisions.ts`
- Modify: `packages/mcp-debug/src/store/session-store.ts`
- Modify: `packages/mcp-debug/src/types.ts`

**Context:** The existing `debug_explain_decision` tool in `packages/mcp-debug/src/tools/decisions.ts` queries trace events (`ctx.traceStore.getBySession(...)`) and explains them. But now we have a richer `decisionLog` on the session state. The enhancement: when the session has a `decisionLog`, use it to build causal chain explanations grouped by turn. Fall back to the existing trace event approach when `decisionLog` is not available.

**Step 1: Add decisionLog to MCP debug types**

In `packages/mcp-debug/src/types.ts`, add after the `AgentState` interface:

```typescript
export interface DecisionLogEntry {
  turn: number;
  timestamp: number;
  type: string;
  outcome: string;
  condition?: string;
  matched: boolean;
  trigger?: Record<string, unknown>;
  candidates?: string[];
  selectedReason?: string;
  field?: string;
  violation?: string;
  oldValue?: unknown;
  newValue?: unknown;
  source?: string;
}
```

And add to `AgentState`:

```typescript
  decisionLog?: DecisionLogEntry[];
```

**Step 2: Add `decisionLog` accessor to SessionStore**

In `packages/mcp-debug/src/store/session-store.ts`, add a method:

```typescript
  /**
   * Get decision log for a session (from state)
   */
  getDecisionLog(sessionId: string): DecisionLogEntry[] {
    const session = this.sessions.get(sessionId);
    return (session?.state as any)?.decisionLog ?? [];
  }
```

Import `DecisionLogEntry` from `../types.js`.

**Step 3: Enhance `explainDecision` to use decision log**

In `packages/mcp-debug/src/tools/decisions.ts`, modify the `explainDecision` function. After the sessionId resolution (line 23), add a decision log path:

```typescript
// Prefer decision log if available (richer causal chain data)
const decisionLog = sessionId ? ctx.sessionStore.getDecisionLog(sessionId) : [];

if (decisionLog.length > 0) {
  if (eventId) {
    // Find by timestamp match (eventId is not applicable to decision log entries)
    return JSON.stringify({
      success: true,
      source: 'decision_log',
      note: 'eventId is not applicable to decision log entries. Showing recent entries.',
      count: Math.min(lastN, decisionLog.length),
      entries: decisionLog.slice(-lastN).map(formatDecisionEntry),
    });
  }

  // Group by turn and return the last N entries
  const recentEntries = decisionLog.slice(-lastN);
  const grouped = groupByTurn(recentEntries);

  return JSON.stringify({
    success: true,
    source: 'decision_log',
    sessionId,
    turnCount: Object.keys(grouped).length,
    entryCount: recentEntries.length,
    turns: grouped,
  });
}

// Fall back to trace event approach (existing behavior)
```

Add these helper functions at the bottom of the file:

```typescript
function formatDecisionEntry(entry: DecisionLogEntry): Record<string, unknown> {
  const result: Record<string, unknown> = {
    turn: entry.turn,
    type: entry.type,
    outcome: entry.outcome,
    matched: entry.matched,
  };
  if (entry.condition) result.condition = entry.condition;
  if (entry.candidates) result.candidates = entry.candidates;
  if (entry.selectedReason) result.selectedReason = entry.selectedReason;
  if (entry.field) result.field = entry.field;
  if (entry.violation) result.violation = entry.violation;
  if (entry.source) result.source = entry.source;
  if (entry.trigger && Object.keys(entry.trigger).length > 0) result.trigger = entry.trigger;
  return result;
}

function groupByTurn(entries: DecisionLogEntry[]): Record<number, Record<string, unknown>[]> {
  const groups: Record<number, Record<string, unknown>[]> = {};
  for (const entry of entries) {
    groups[entry.turn] ??= [];
    groups[entry.turn].push(formatDecisionEntry(entry));
  }
  return groups;
}
```

Import `DecisionLogEntry` from `../types.js`.

**Step 4: Run type check**

Run: `cd packages/mcp-debug && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

**Step 5: Commit**

```bash
npx prettier --write packages/mcp-debug/src/tools/decisions.ts packages/mcp-debug/src/store/session-store.ts packages/mcp-debug/src/types.ts
git add packages/mcp-debug/src/tools/decisions.ts packages/mcp-debug/src/store/session-store.ts packages/mcp-debug/src/types.ts
git commit -m "[ABLP-2] feat(mcp-debug): enhance debug_explain_decision to use decision log"
```

---

### Task 9: Add `lastN` schema expansion and causal chain builder

**Files:**

- Modify: `packages/mcp-debug/src/tools/decisions.ts`

**Step 1: Update schema to support turn-based queries**

Update `explainDecisionSchema`:

```typescript
export const explainDecisionSchema = z.object({
  eventId: z.string().optional().describe('Specific event ID to explain'),
  sessionId: z.string().optional().describe('Session ID (uses active session if not specified)'),
  lastN: z.number().optional().default(5).describe('Number of recent decision entries to return'),
  turn: z.number().optional().describe('Get all decisions for a specific conversation turn'),
  type: z
    .string()
    .optional()
    .describe('Filter by decision type (handoff, completion, gather_extraction, etc.)'),
});
```

**Step 2: Add turn and type filtering**

In the decision log branch of `explainDecision`, after groupByTurn:

```typescript
// Filter by turn if specified
if (args.turn !== undefined) {
  const turnEntries = decisionLog.filter((e) => e.turn === args.turn);
  return JSON.stringify({
    success: true,
    source: 'decision_log',
    sessionId,
    turn: args.turn,
    entryCount: turnEntries.length,
    entries: turnEntries.map(formatDecisionEntry),
    causalChain: buildCausalChain(turnEntries),
  });
}

// Filter by type if specified
if (args.type) {
  const filtered = decisionLog.filter((e) => e.type === args.type);
  return JSON.stringify({
    success: true,
    source: 'decision_log',
    sessionId,
    type: args.type,
    entryCount: filtered.length,
    entries: filtered.slice(-lastN).map(formatDecisionEntry),
  });
}
```

Add the causal chain builder:

```typescript
/**
 * Build a human-readable causal chain from a set of decision entries.
 * Groups related decisions (e.g., extraction → validation → completion).
 */
function buildCausalChain(entries: DecisionLogEntry[]): string[] {
  const chain: string[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case 'gather_extraction':
        chain.push(`Extracted: ${entry.outcome}${entry.matched ? '' : ' (no match)'}`);
        break;
      case 'field_validation':
        chain.push(
          `Validated ${entry.field}: ${entry.matched ? 'passed' : `FAILED — ${entry.violation}`}`,
        );
        break;
      case 'constraint_check':
        chain.push(
          `Constraint ${entry.condition}: ${entry.matched ? 'passed' : `FAILED — ${entry.violation}`}`,
        );
        break;
      case 'completion':
        chain.push(
          `Completion check: ${entry.outcome}${entry.condition ? ` (${entry.condition})` : ''}`,
        );
        break;
      case 'handoff':
        chain.push(
          `Handoff → ${entry.outcome}${entry.condition ? ` when ${entry.condition}` : ''} [${entry.selectedReason ?? 'first_match'}]`,
        );
        break;
      case 'flow_transition':
        chain.push(`Flow: → ${entry.outcome}${entry.condition ? ` when ${entry.condition}` : ''}`);
        break;
      case 'delegation':
        chain.push(
          `Delegate → ${entry.outcome}${entry.condition ? ` when ${entry.condition}` : ''}`,
        );
        break;
      case 'escalation':
        chain.push(`Escalated: ${entry.outcome}`);
        break;
      case 'data_mutation':
        chain.push(`Data: ${entry.field} updated (source: ${entry.source})`);
        break;
      case 'correction':
        chain.push(`Correction: ${entry.field} corrected`);
        break;
      case 'guardrail_check':
        chain.push(`Guardrail: ${entry.outcome}${entry.matched ? '' : ' BLOCKED'}`);
        break;
      default:
        chain.push(`${entry.type}: ${entry.outcome}`);
    }
  }

  return chain;
}
```

**Step 3: Run type check**

Run: `cd packages/mcp-debug && npx tsc --noEmit 2>&1 | head -20`

**Step 4: Commit**

```bash
npx prettier --write packages/mcp-debug/src/tools/decisions.ts
git add packages/mcp-debug/src/tools/decisions.ts
git commit -m "[ABLP-2] feat(mcp-debug): add turn/type filtering and causal chain builder to explain_decision"
```

---

### Task 10: Test MCP debug_explain_decision enhancement

**Files:**

- Create: `packages/mcp-debug/src/__tests__/decisions.test.ts`

**Step 1: Write tests**

```typescript
import { describe, test, expect } from 'vitest';
import { explainDecision } from '../tools/decisions';
import { SessionStore } from '../store/session-store';
import type { DebugContext } from '../tools/index';
import type { DecisionLogEntry } from '../types';

function createMockContext(decisionLog?: DecisionLogEntry[]): DebugContext {
  const sessionStore = new SessionStore();
  const session = sessionStore.createSession('test-session', 'test-agent');
  if (decisionLog) {
    sessionStore.updateState('test-session', {
      context: {},
      conversationPhase: 'active',
      gatherProgress: {},
      constraintResults: {},
      lastToolResults: {},
      memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
      decisionLog,
    } as any);
  }

  return {
    sessionStore,
    traceStore: {
      getBySession: () => [],
      getById: () => undefined,
      getBySpan: () => [],
    },
    wsClient: { isConnected: () => false },
  } as any;
}

describe('explainDecision with decision log', () => {
  const sampleLog: DecisionLogEntry[] = [
    {
      turn: 1,
      timestamp: 1000,
      type: 'gather_extraction',
      outcome: 'destination=Paris',
      matched: true,
    },
    {
      turn: 1,
      timestamp: 1001,
      type: 'field_validation',
      outcome: 'pass',
      matched: true,
      field: 'destination',
    },
    {
      turn: 1,
      timestamp: 1002,
      type: 'completion',
      outcome: 'not_complete',
      matched: false,
      condition: 'all_fields',
    },
    {
      turn: 2,
      timestamp: 2000,
      type: 'gather_extraction',
      outcome: 'date=2026-03-15',
      matched: true,
    },
    {
      turn: 2,
      timestamp: 2001,
      type: 'completion',
      outcome: 'complete',
      matched: true,
      condition: 'all_fields',
    },
    {
      turn: 2,
      timestamp: 2002,
      type: 'handoff',
      outcome: 'Booking_Agent',
      matched: true,
      condition: "intent == 'booking'",
      candidates: ['Booking_Agent', 'Support_Agent'],
      selectedReason: 'first_match',
    },
  ];

  test('returns decision log entries grouped by turn', async () => {
    const ctx = createMockContext(sampleLog);
    const result = JSON.parse(await explainDecision({ lastN: 10 }, ctx));

    expect(result.success).toBe(true);
    expect(result.source).toBe('decision_log');
    expect(result.entryCount).toBe(6);
    expect(Object.keys(result.turns)).toHaveLength(2);
  });

  test('filters by turn number', async () => {
    const ctx = createMockContext(sampleLog);
    const result = JSON.parse(await explainDecision({ turn: 2 }, ctx));

    expect(result.success).toBe(true);
    expect(result.turn).toBe(2);
    expect(result.entryCount).toBe(3);
    expect(result.causalChain).toBeDefined();
    expect(result.causalChain.length).toBe(3);
  });

  test('filters by type', async () => {
    const ctx = createMockContext(sampleLog);
    const result = JSON.parse(await explainDecision({ type: 'completion' }, ctx));

    expect(result.success).toBe(true);
    expect(result.type).toBe('completion');
    expect(result.entryCount).toBe(2);
  });

  test('falls back to trace events when no decision log', async () => {
    const ctx = createMockContext(); // no decision log
    const result = JSON.parse(await explainDecision({ lastN: 5 }, ctx));

    expect(result.success).toBe(true);
    // Should use trace event fallback
    expect(result.explanations).toBeDefined();
    expect(result.message).toContain('No decision events found');
  });

  test('builds causal chain for a turn', async () => {
    const ctx = createMockContext(sampleLog);
    const result = JSON.parse(await explainDecision({ turn: 1 }, ctx));

    expect(result.causalChain).toEqual([
      'Extracted: destination=Paris',
      'Validated destination: passed',
      'Completion check: not_complete (all_fields)',
    ]);
  });

  test('respects lastN parameter', async () => {
    const ctx = createMockContext(sampleLog);
    const result = JSON.parse(await explainDecision({ lastN: 2 }, ctx));

    expect(result.entryCount).toBe(2);
  });
});
```

**Step 2: Run tests**

Run: `cd packages/mcp-debug && npx vitest run --reporter=verbose decisions 2>&1 | tail -20`
Expected: All 6 tests pass

**Step 3: Commit**

```bash
npx prettier --write packages/mcp-debug/src/__tests__/decisions.test.ts
git add packages/mcp-debug/src/__tests__/decisions.test.ts
git commit -m "[ABLP-2] test(mcp-debug): add debug_explain_decision enhancement tests"
```

---

## Part 4: Final Verification

### Task 11: Build and full test run

**Step 1: Build everything**

Run: `pnpm build 2>&1 | tail -30`
Expected: Clean build

**Step 2: Run all decision log tests**

Run: `cd apps/runtime && npx vitest run --reporter=verbose decision-log trace-forwarder 2>&1 | tail -30`
Expected: All tests pass

**Step 3: Run MCP debug tests**

Run: `cd packages/mcp-debug && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All tests pass

**Step 4: Run existing runtime tests (regression check)**

Run: `cd apps/runtime && npx vitest run --reporter=verbose reasoning-gather-handoff flow-handoff-threads 2>&1 | tail -10`
Expected: All existing tests pass (no regressions)

**Step 5: Type-check Studio**

Run: `cd apps/studio && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

**Step 6: Commit any fixups if needed**

```bash
git commit -m "[ABLP-2] fix: alignment fixes after debuggability gaps implementation"
```
