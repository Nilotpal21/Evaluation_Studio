# Studio Layered Architecture — Phase 1: Infrastructure + Observatory Pilot

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MessageBus infrastructure and migrate Observatory as the first feature module, proving the pattern for all subsequent phases.

**Architecture:** Replace WebSocketContext's monolithic message handling with a typed MessageBus that dispatches to per-feature handlers. Observatory becomes the pilot feature module with contract tests, tap-point diagnostics, and a pure-state store. Old WebSocketContext runs alongside (dual-write) during transition.

**Tech Stack:** TypeScript, Zustand 4.4 (with `devtools` middleware), Zod 3.23, Vitest 4.0, happy-dom, @testing-library/react. Optional: emittery (event bus — see Task 2 decision note). Future phases: MSW v2 (WebSocket mocking), hey-api/orval (OpenAPI→Zod codegen).

**Spec:** `docs/plans/2026-03-12-studio-layered-architecture-design.md`

---

## Pre-Implementation Checklist

Before starting any task, the implementing agent MUST:

1. Run `npx prettier --write <files>` on ALL changed files before committing
2. BEFORE using any existing component/function/type, READ its source file to verify the actual signature
3. NEVER switch branches — stay on the current branch
4. NEVER add "Co-Authored-By" lines to commit messages
5. Commit messages: `[ABLP-2] type(scope): description`
6. Run `pnpm build --filter=studio` after creating/modifying files to catch type errors immediately
7. Use `@/` path alias for all imports within `apps/studio/src/`

## File Structure

All new files live under `apps/studio/src/`. Abbreviated as `src/` below.

### Infrastructure (new)

**NOTE: `WebSocketTransport` extraction is deferred to Phase 2.** Extracting the WebSocket connection lifecycle (connect/disconnect/reconnect with backoff) from `WebSocketContext.tsx` is high-risk alongside the dual-write integration. Phase 1 focuses on the MessageBus + handler pattern. The connection lifecycle stays in `WebSocketContext.tsx` until all message handlers are migrated off it (end of Phase 2), at which point the remaining ~150 LOC becomes `ws-transport.ts`.

```
src/infrastructure/
  message-bus.ts            ← Typed event emitter with middleware support
  message-bus.types.ts      ← ServerMessage type map, handler type, middleware type
  tap-middleware.ts          ← Ring buffer capture middleware for diagnostics
  tap-middleware.types.ts    ← TapBuffer, TapSnapshot types
  session-context.ts         ← Shared reactive session ID/agent for cross-feature reads
  index.ts                   ← Barrel exports

  (DEFERRED to Phase 2:)
  ws-transport.ts            ← WebSocket connect/disconnect/reconnect
  ws-transport.types.ts      ← Transport state, config types
```

### Observatory Feature Module (new)

```
src/features/observatory/
  observatory.contract.ts    ← Zod schemas for trace events, spans, metrics
  observatory.types.ts       ← TS types derived from contracts
  observatory.store.ts       ← Pure Zustand store (no side effects, no addEvent logic)
  observatory.handlers.ts    ← MessageBus handler for trace_event + agent_loaded + session_reset
  observatory.api.ts         ← API layer (trace subscriptions, session queries)
  event-normalizer.ts        ← normalizeEventType + event field mapping (pure function)
  span-lifecycle.ts          ← startSpan, endSpan, attachToSpan, sweepRunningSpans (pure functions)
  metric-aggregator.ts       ← aggregateTokens, aggregateToolCalls, aggregateConstraints (pure functions)
  flow-graph.ts              ← addFlowNode, addFlowEdge, updateExecutionState (pure functions)
  index.ts                   ← Barrel exports

  __tests__/
    observatory.contract.test.ts
    observatory.handlers.test.ts
    observatory.store.test.ts
    event-normalizer.test.ts
    span-lifecycle.test.ts
    metric-aggregator.test.ts
    flow-graph.test.ts

  __fixtures__/
    llm-call-event.json
    tool-call-event.json
    handoff-event.json
    agent-enter-exit.json
    flow-step-lifecycle.json
    constraint-check.json
    multi-agent-session.json
```

### Infrastructure Tests (new)

```
src/infrastructure/__tests__/
  message-bus.test.ts
  ws-transport.test.ts
  tap-middleware.test.ts
  session-context.test.ts
```

### Barrel Re-exports (modified)

```
src/store/observatory-store.ts  ← Becomes re-export from features/observatory
src/store/trace-store.ts        ← Deprecated, re-exports merged into observatory
```

### Diagnostic Script (new)

```
tools/studio-diagnose.ts         ← CLI: reads tap snapshot JSON, diffs layers, outputs report
```

---

## Chunk 1: Infrastructure

### Task 1: MessageBus Types

**Files:**

- Create: `src/infrastructure/message-bus.types.ts`

- [ ] **Step 1: Write the failing test**

Create `src/infrastructure/__tests__/message-bus.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MessageBus } from '../message-bus';
import type { ServerMessageMap, BusHandler } from '../message-bus.types';

describe('MessageBus', () => {
  it('should exist as a class', () => {
    expect(MessageBus).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/infrastructure/__tests__/message-bus.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Create message-bus.types.ts**

Read `src/types/index.ts` first to get the exact ServerMessage type definition (lines 499–525). Then create:

```typescript
// src/infrastructure/message-bus.types.ts

/**
 * Maps each ServerMessage.type string to its payload shape.
 * Derived from the ServerMessage union in src/types/index.ts.
 *
 * When Runtime adds a new message type, add it here — the type system
 * will flag every handler that needs updating.
 */
export interface ServerMessageMap {
  agent_loaded: { sessionId: string; agent: unknown }; // AgentDetails — import from types
  agent_load_error: { error: string };
  response_start: { sessionId: string; messageId: string };
  response_chunk: { sessionId: string; messageId: string; chunk: string };
  response_end: { sessionId: string; messageId: string; fullText: string };
  trace_event: { sessionId: string; event: unknown }; // TraceEvent — import from types
  state_update: { sessionId: string; state: unknown; updates?: unknown };
  action_taken: { sessionId: string; action: unknown };
  session_reset: { sessionId: string };
  session_resumed: {
    sessionId: string;
    state: unknown;
    conversationHistory: unknown[];
  };
  session_expired: { sessionId: string; reason: string };
  error: { message: string };
  info: { message: string; configured: boolean };
  context_injected: { sessionId: string; updatedValues: unknown };
  tool_mock_set: { sessionId: string; mockCount: number };
  context_injection_error: {
    sessionId: string;
    error: { code: string; message: string };
  };
}

export type ServerMessageType = keyof ServerMessageMap;

export type BusHandler<T extends ServerMessageType = ServerMessageType> = (
  payload: ServerMessageMap[T],
) => void;

export type BusMiddleware = (
  type: ServerMessageType,
  payload: ServerMessageMap[ServerMessageType],
  next: () => void,
) => void;
```

NOTE: Replace `unknown` types with actual imports from `src/types/index.ts` after reading the file. The exact types for `AgentDetails`, `TraceEvent`, `AgentState`, `ConstructAction` must match. READ the source before writing.

- [ ] **Step 4: Verify types compile**

Run: `cd apps/studio && npx tsc --noEmit --pretty src/infrastructure/message-bus.types.ts`

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/infrastructure/message-bus.types.ts
git add apps/studio/src/infrastructure/message-bus.types.ts
git commit -m "[ABLP-2] feat(studio): add MessageBus type definitions"
```

---

### Task 2: MessageBus Implementation

**Files:**

- Create: `src/infrastructure/message-bus.ts`
- Test: `src/infrastructure/__tests__/message-bus.test.ts`

**Library decision:** The spec recommends **emittery** (~1.3KB gzip) as the MessageBus core. It provides `onAny()` (ideal for tap-point middleware), async error handling, and `listenerCount()`. However, the implementation below uses a hand-rolled approach (~60 LOC) because: (a) emittery's `onAny()` doesn't support a middleware chain with `next()` blocking, (b) we need exact control over the typed facade, and (c) 60 LOC is trivial to maintain. If middleware requirements grow complex, swap the internals for emittery — the public API (`on`, `emit`, `use`, `removeAllHandlers`) is stable either way. To adopt emittery later: `pnpm add emittery --filter studio`, wrap `Emittery` in `MessageBus`, use `onAny()` for tap points and per-type listeners for handlers.

- [ ] **Step 1: Write failing tests**

```typescript
// src/infrastructure/__tests__/message-bus.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBus } from '../message-bus';
import type { BusMiddleware } from '../message-bus.types';

describe('MessageBus', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  it('delivers message to registered handler', () => {
    const handler = vi.fn();
    bus.on('error', handler);
    bus.emit('error', { message: 'test error' });
    expect(handler).toHaveBeenCalledWith({ message: 'test error' });
  });

  it('delivers message to multiple handlers for same type', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('trace_event', h1);
    bus.on('trace_event', h2);
    bus.emit('trace_event', { sessionId: 's1', event: {} });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('does not deliver to unregistered handler', () => {
    const handler = vi.fn();
    bus.on('error', handler);
    bus.emit('info', { message: 'ok', configured: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribes handler via returned function', () => {
    const handler = vi.fn();
    const unsub = bus.on('error', handler);
    unsub();
    bus.emit('error', { message: 'test' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs middleware in order before handlers', () => {
    const order: string[] = [];
    const mw1: BusMiddleware = (_type, _payload, next) => {
      order.push('mw1');
      next();
    };
    const mw2: BusMiddleware = (_type, _payload, next) => {
      order.push('mw2');
      next();
    };
    bus.use(mw1);
    bus.use(mw2);
    bus.on('error', () => order.push('handler'));
    bus.emit('error', { message: 'test' });
    expect(order).toEqual(['mw1', 'mw2', 'handler']);
  });

  it('middleware can block delivery by not calling next', () => {
    const handler = vi.fn();
    const blocker: BusMiddleware = () => {
      /* intentionally does not call next */
    };
    bus.use(blocker);
    bus.on('error', handler);
    bus.emit('error', { message: 'blocked' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('removeAllHandlers clears all registrations', () => {
    const handler = vi.fn();
    bus.on('error', handler);
    bus.on('info', handler);
    bus.removeAllHandlers();
    bus.emit('error', { message: 'test' });
    bus.emit('info', { message: 'test', configured: true });
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/studio && pnpm vitest run src/infrastructure/__tests__/message-bus.test.ts`
Expected: FAIL — MessageBus not found

- [ ] **Step 3: Implement MessageBus**

```typescript
// src/infrastructure/message-bus.ts
import type {
  ServerMessageType,
  ServerMessageMap,
  BusHandler,
  BusMiddleware,
} from './message-bus.types';

export class MessageBus {
  private handlers = new Map<ServerMessageType, Set<BusHandler<any>>>();
  private middlewares: BusMiddleware[] = [];

  on<T extends ServerMessageType>(type: T, handler: BusHandler<T>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  use(middleware: BusMiddleware): void {
    this.middlewares.push(middleware);
  }

  emit<T extends ServerMessageType>(type: T, payload: ServerMessageMap[T]): void {
    const deliver = () => {
      const handlers = this.handlers.get(type);
      if (handlers) {
        for (const handler of handlers) {
          handler(payload);
        }
      }
    };

    if (this.middlewares.length === 0) {
      deliver();
      return;
    }

    let index = 0;
    const next = () => {
      if (index < this.middlewares.length) {
        const mw = this.middlewares[index++];
        mw(type, payload, next);
      } else {
        deliver();
      }
    };
    next();
  }

  removeAllHandlers(): void {
    this.handlers.clear();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/studio && pnpm vitest run src/infrastructure/__tests__/message-bus.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/infrastructure/message-bus.ts apps/studio/src/infrastructure/__tests__/message-bus.test.ts
git add apps/studio/src/infrastructure/
git commit -m "[ABLP-2] feat(studio): implement MessageBus with typed dispatch and middleware"
```

---

### Task 3: Tap Point Middleware

**Files:**

- Create: `src/infrastructure/tap-middleware.ts`
- Create: `src/infrastructure/tap-middleware.types.ts`
- Test: `src/infrastructure/__tests__/tap-middleware.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/infrastructure/__tests__/tap-middleware.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTapMiddleware, TapBuffer } from '../tap-middleware';
import type { TapEntry } from '../tap-middleware.types';
import { MessageBus } from '../message-bus';

describe('TapBuffer', () => {
  const makeEntry = (type: string, seq: number): TapEntry => ({
    ts: new Date().toISOString(),
    layer: 'test',
    type,
    seq,
    payload: { value: seq },
  });

  it('stores events up to max capacity', () => {
    const buf = new TapBuffer(3);
    buf.push(makeEntry('a', 1));
    buf.push(makeEntry('b', 2));
    buf.push(makeEntry('c', 3));
    buf.push(makeEntry('d', 4));
    expect(buf.entries.length).toBe(3);
    expect(buf.totalReceived).toBe(4);
    expect(buf.evicted).toBe(1);
  });

  it('snapshot returns copy with metadata', () => {
    const buf = new TapBuffer(10);
    buf.push(makeEntry('a', 1));
    const snap = buf.snapshot();
    expect(snap.totalReceived).toBe(1);
    expect(snap.retained).toBe(1);
    expect(snap.evicted).toBe(0);
    expect(snap.entries).toHaveLength(1);
  });

  it('clear resets buffer but preserves totalReceived', () => {
    const buf = new TapBuffer(10);
    buf.push(makeEntry('a', 1));
    buf.clear();
    expect(buf.entries).toHaveLength(0);
    expect(buf.totalReceived).toBe(0);
  });
});

describe('createTapMiddleware', () => {
  it('captures events into named buffer and calls next', () => {
    const bus = new MessageBus();
    const { middleware, getBuffer } = createTapMiddleware('test-layer');

    bus.use(middleware);
    const handler = vi.fn();
    bus.on('error', handler);
    bus.emit('error', { message: 'hello' });

    expect(handler).toHaveBeenCalled();
    const snap = getBuffer().snapshot();
    expect(snap.totalReceived).toBe(1);
    expect(snap.entries[0].type).toBe('error');
  });

  it('can be enabled and disabled', () => {
    const { middleware, getBuffer, setEnabled } = createTapMiddleware('layer');
    const bus = new MessageBus();
    bus.use(middleware);
    bus.on('error', vi.fn());

    setEnabled(false);
    bus.emit('error', { message: 'ignored' });
    expect(getBuffer().snapshot().totalReceived).toBe(0);

    setEnabled(true);
    bus.emit('error', { message: 'captured' });
    expect(getBuffer().snapshot().totalReceived).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/studio && pnpm vitest run src/infrastructure/__tests__/tap-middleware.test.ts`

- [ ] **Step 3: Implement TapBuffer and createTapMiddleware**

```typescript
// src/infrastructure/tap-middleware.types.ts

/**
 * OTel-inspired tap entry for pipeline diagnostics.
 * Each entry maps to one line in the exported JSONL file.
 * The `seq` field enables cross-layer correlation (same seq = same event at different stages).
 */
export interface TapEntry {
  ts: string; // ISO timestamp
  layer: string; // tap point name (e.g., 'ws_transport', 'handler', 'store')
  type: string; // ServerMessage type
  subType?: string; // For trace_event: the event.type sub-field
  sessionId?: string; // Session ID if available
  seq: number; // Monotonic counter for cross-layer correlation
  storeAction?: string; // Which store method was called (store layer only)
  payload: unknown; // Raw message payload
}

export interface TapSnapshot {
  layer: string;
  totalReceived: number;
  retained: number;
  evicted: number;
  entries: TapEntry[];
}
```

```typescript
// src/infrastructure/tap-middleware.ts
import type { BusMiddleware } from './message-bus.types';
import type { TapEntry, TapSnapshot } from './tap-middleware.types';

const DEFAULT_MAX_ENTRIES = 1000;

export class TapBuffer {
  entries: TapEntry[] = [];
  totalReceived = 0;
  private maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get evicted(): number {
    return this.totalReceived - this.entries.length;
  }

  push(entry: TapEntry): void {
    this.totalReceived++;
    if (this.entries.length >= this.maxEntries) {
      this.entries.shift();
    }
    this.entries.push(entry);
  }

  snapshot(layer = ''): TapSnapshot {
    return {
      layer,
      totalReceived: this.totalReceived,
      retained: this.entries.length,
      evicted: this.evicted,
      entries: [...this.entries],
    };
  }

  clear(): void {
    this.entries = [];
    this.totalReceived = 0;
  }
}

let _globalSeq = 0;

export function createTapMiddleware(layerName: string, maxEntries?: number) {
  const buffer = new TapBuffer(maxEntries);
  let enabled = true;

  const middleware: BusMiddleware = (type, payload, next) => {
    if (enabled) {
      const entry: TapEntry = {
        ts: new Date().toISOString(),
        layer: layerName,
        type,
        seq: ++_globalSeq,
        payload,
      };
      // Extract sessionId and subType for trace_event correlation
      if (typeof payload === 'object' && payload !== null) {
        const p = payload as Record<string, unknown>;
        if (p.sessionId) entry.sessionId = String(p.sessionId);
        if (type === 'trace_event' && p.event && typeof p.event === 'object') {
          entry.subType = String((p.event as Record<string, unknown>).type ?? '');
        }
      }
      buffer.push(entry);
    }
    next();
  };

  return {
    middleware,
    getBuffer: () => buffer,
    setEnabled: (val: boolean) => {
      enabled = val;
    },
  };
}

export { type TapEntry, type TapSnapshot } from './tap-middleware.types';
```

- [ ] **Step 4: Run tests**

Run: `cd apps/studio && pnpm vitest run src/infrastructure/__tests__/tap-middleware.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/infrastructure/tap-middleware.ts apps/studio/src/infrastructure/tap-middleware.types.ts apps/studio/src/infrastructure/__tests__/tap-middleware.test.ts
git add apps/studio/src/infrastructure/
git commit -m "[ABLP-2] feat(studio): add tap-point middleware for pipeline diagnostics"
```

---

### Task 4: Session Context (shared reactive value)

**Files:**

- Create: `src/infrastructure/session-context.ts`
- Test: `src/infrastructure/__tests__/session-context.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/infrastructure/__tests__/session-context.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActiveSession, getActiveSession, subscribeActiveSession } from '../session-context';

describe('session-context', () => {
  beforeEach(() => {
    setActiveSession(null, null);
  });

  it('stores and retrieves session ID and agent name', () => {
    setActiveSession('session-1', 'agent-a');
    const ctx = getActiveSession();
    expect(ctx.sessionId).toBe('session-1');
    expect(ctx.agentName).toBe('agent-a');
  });

  it('notifies subscribers on change', () => {
    const cb = vi.fn();
    const unsub = subscribeActiveSession(cb);
    setActiveSession('s2', 'a2');
    expect(cb).toHaveBeenCalledWith({ sessionId: 's2', agentName: 'a2' });
    unsub();
  });

  it('does not notify after unsubscribe', () => {
    const cb = vi.fn();
    const unsub = subscribeActiveSession(cb);
    unsub();
    setActiveSession('s3', 'a3');
    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd apps/studio && pnpm vitest run src/infrastructure/__tests__/session-context.test.ts`

- [ ] **Step 3: Implement session-context.ts**

```typescript
// src/infrastructure/session-context.ts

/**
 * Lightweight shared reactive value for session ID and active agent.
 * Both Observatory and Sessions features read from this.
 * NOT a Zustand store — avoids adding another store to the stack.
 */

interface ActiveSession {
  sessionId: string | null;
  agentName: string | null;
}

type Listener = (session: ActiveSession) => void;

let current: ActiveSession = { sessionId: null, agentName: null };
const listeners = new Set<Listener>();

export function setActiveSession(sessionId: string | null, agentName: string | null): void {
  current = { sessionId, agentName };
  for (const listener of listeners) {
    listener(current);
  }
}

export function getActiveSession(): ActiveSession {
  return current;
}

export function subscribeActiveSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/studio && pnpm vitest run src/infrastructure/__tests__/session-context.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/infrastructure/session-context.ts apps/studio/src/infrastructure/__tests__/session-context.test.ts
git add apps/studio/src/infrastructure/
git commit -m "[ABLP-2] feat(studio): add session-context shared reactive value"
```

---

### Task 5: Infrastructure Barrel Export

**Files:**

- Create: `src/infrastructure/index.ts`

- [ ] **Step 1: Create barrel export**

```typescript
// src/infrastructure/index.ts
export { MessageBus } from './message-bus';
export type {
  ServerMessageMap,
  ServerMessageType,
  BusHandler,
  BusMiddleware,
} from './message-bus.types';
export { TapBuffer, createTapMiddleware } from './tap-middleware';
export type { TapEntry, TapSnapshot } from './tap-middleware.types';
export { setActiveSession, getActiveSession, subscribeActiveSession } from './session-context';
```

- [ ] **Step 2: Verify build**

Run: `cd apps/studio && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/infrastructure/index.ts
git add apps/studio/src/infrastructure/index.ts
git commit -m "[ABLP-2] feat(studio): add infrastructure barrel exports"
```

---

## Chunk 2: Observatory Feature Module — Pure Functions

### Task 6: Event Normalizer

**Files:**

- Create: `src/features/observatory/event-normalizer.ts`
- Test: `src/features/observatory/__tests__/event-normalizer.test.ts`

- [ ] **Step 1: Read the existing normalizer**

Read `src/lib/event-types.ts` to understand the current `normalizeEventType()` function signature and behavior.

- [ ] **Step 2: Write failing tests**

```typescript
// src/features/observatory/__tests__/event-normalizer.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeEventType, normalizeTraceEvent } from '../event-normalizer';

describe('normalizeEventType', () => {
  it('converts dotted ClickHouse types via lookup table', () => {
    // These use the DOTTED_TO_SIMPLE lookup from src/lib/event-types.ts
    expect(normalizeEventType('flow.step.entered')).toBe('flow_step_enter');
    expect(normalizeEventType('llm.call.completed')).toBe('llm_call');
    expect(normalizeEventType('agent.entered')).toBe('agent_enter');
    expect(normalizeEventType('agent.exited')).toBe('agent_exit');
    expect(normalizeEventType('agent.decision')).toBe('decision');
    expect(normalizeEventType('voice.session.started')).toBe('voice_session_start');
  });

  it('passes through already-normalized underscore types', () => {
    expect(normalizeEventType('llm_call')).toBe('llm_call');
    expect(normalizeEventType('tool_call')).toBe('tool_call');
    expect(normalizeEventType('agent_enter')).toBe('agent_enter');
  });

  it('passes through unknown types unchanged (fallback)', () => {
    expect(normalizeEventType('some_future_type')).toBe('some_future_type');
  });
});

describe('normalizeTraceEvent', () => {
  it('normalizes type and preserves all other fields', () => {
    const raw = {
      id: 'e1',
      type: 'flow.step.entered',
      timestamp: '2026-03-12T00:00:00Z',
      sessionId: 's1',
      agentName: 'greeter',
      traceId: 't1',
      spanId: 'sp1',
      data: { step: 'greet' },
    };
    const result = normalizeTraceEvent(raw);
    expect(result.type).toBe('flow_step_enter');
    expect(result.id).toBe('e1');
    expect(result.data).toEqual({ step: 'greet' });
  });

  it('coerces string timestamps to Date objects', () => {
    const raw = {
      id: 'e1',
      type: 'llm_call',
      timestamp: '2026-03-12T00:00:00.000Z',
      sessionId: 's1',
      agentName: 'a',
      traceId: 't1',
      spanId: 'sp1',
      data: {},
    };
    const result = normalizeTraceEvent(raw);
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it('passes through Date timestamps unchanged', () => {
    const now = new Date();
    const raw = {
      id: 'e1',
      type: 'llm_call',
      timestamp: now,
      sessionId: 's1',
      agentName: 'a',
      traceId: 't1',
      spanId: 'sp1',
      data: {},
    };
    const result = normalizeTraceEvent(raw);
    expect(result.timestamp).toBe(now);
  });
});
```

- [ ] **Step 3: Implement**

Read the existing `normalizeEventType()` from `src/lib/event-types.ts` and re-implement it as a pure function in the new location. Add `normalizeTraceEvent()` that wraps the full event normalization (type + timestamp coercion).

```typescript
// src/features/observatory/event-normalizer.ts
import type { ExtendedTraceEvent } from '@/types';

/**
 * Dotted → underscore lookup table.
 * Copied from src/lib/event-types.ts DOTTED_TO_SIMPLE.
 * ClickHouse uses dotted names; live WebSocket uses underscore names.
 * This normalizes at ingestion edge so all downstream code uses underscore.
 */
const DOTTED_TO_SIMPLE: Record<string, string> = {
  'agent.decision': 'decision',
  'llm.call.completed': 'llm_call',
  'llm.call.failed': 'llm_call',
  'tool.call.completed': 'tool_call',
  'tool.call.failed': 'tool_call',
  'agent.entered': 'agent_enter',
  'agent.exited': 'agent_exit',
  'agent.handoff': 'handoff',
  'agent.escalated': 'escalation',
  'agent.delegated': 'delegate_start',
  'agent.delegate.completed': 'delegate_complete',
  'agent.constraint.checked': 'constraint_check',
  'flow.step.entered': 'flow_step_enter',
  'flow.step.exited': 'flow_step_exit',
  'flow.transition': 'flow_transition',
  'session.started': 'session_created',
  'session.ended': 'session_ended',
  'session.updated': 'session_updated',
  'message.user.received': 'user_message',
  'message.agent.sent': 'agent_response',
  'system.error': 'error',
  'voice.session.started': 'voice_session_start',
  'voice.session.ended': 'voice_session_end',
  'voice.turn.completed': 'voice_turn',
  'voice.stt.completed': 'voice_stt',
  'voice.tts.completed': 'voice_tts',
  'voice.barge_in.detected': 'voice_barge_in',
  'voice.asr_quality.analyzed': 'voice_asr_quality',
  'voice.tts_quality.measured': 'voice_tts_quality',
  'voice.asr_cascade.detected': 'voice_asr_cascade',
};

/** Normalize event type — lookup table with passthrough fallback */
export function normalizeEventType(type: string): string {
  return DOTTED_TO_SIMPLE[type] ?? type;
}

/**
 * Normalizes a raw trace event from the WebSocket into a consistent shape.
 * - Converts dotted types to underscore via lookup table
 * - Coerces timestamps to Date objects (matching ExtendedTraceEvent.timestamp: Date)
 */
export function normalizeTraceEvent(raw: Record<string, unknown>): ExtendedTraceEvent {
  const type = normalizeEventType(String(raw.type ?? 'unknown'));
  const timestamp =
    raw.timestamp instanceof Date
      ? raw.timestamp
      : typeof raw.timestamp === 'string'
        ? new Date(raw.timestamp)
        : typeof raw.timestamp === 'number'
          ? new Date(raw.timestamp)
          : new Date();

  return {
    ...raw,
    type,
    timestamp,
  } as ExtendedTraceEvent;
}
```

NOTE: The `ExtendedTraceEvent` interface uses `timestamp: Date` (not number). All time fields in Observatory types (`Span.startTime`, `Span.endTime`, `AgentFlowNode.enteredAt`, `AgentFlowEdge.timestamp`) are `Date` objects. The pure functions in span-lifecycle.ts and flow-graph.ts must use `Date` accordingly.

- [ ] **Step 4: Run tests**

Run: `cd apps/studio && pnpm vitest run src/features/observatory/__tests__/event-normalizer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/features/observatory/event-normalizer.ts apps/studio/src/features/observatory/__tests__/event-normalizer.test.ts
git add apps/studio/src/features/observatory/
git commit -m "[ABLP-2] feat(studio): add observatory event-normalizer pure functions"
```

---

### Task 7: Span Lifecycle

**Files:**

- Create: `src/features/observatory/span-lifecycle.ts`
- Test: `src/features/observatory/__tests__/span-lifecycle.test.ts`

- [ ] **Step 1: Read existing span logic**

Read `src/store/observatory-store.ts` lines 365–401 (agent_enter/agent_exit handling) and lines 478–581 (flow_step_enter/exit). Also read the `Span` type from `src/types/index.ts`.

- [ ] **Step 2: Write failing tests**

```typescript
// src/features/observatory/__tests__/span-lifecycle.test.ts
import { describe, it, expect } from 'vitest';
import { startSpan, endSpan, attachEventToSpan, sweepRunningSpans } from '../span-lifecycle';

// NOTE: All time fields use Date objects (matching Span interface in src/types/index.ts)

describe('startSpan', () => {
  it('creates a new span with given id and name', () => {
    const spans = new Map();
    const stack: string[] = [];
    const t = new Date(1000);
    startSpan(spans, stack, {
      spanId: 'span-1',
      name: 'agent-a',
      timestamp: t,
      parentSpanId: undefined,
      agentName: 'agent-a',
      sessionId: 's1',
      traceId: 't1',
    });
    expect(spans.has('span-1')).toBe(true);
    expect(spans.get('span-1').name).toBe('agent-a');
    expect(spans.get('span-1').startTime).toEqual(t);
    expect(spans.get('span-1').status).toBe('running');
    expect(stack).toContain('span-1');
  });

  it('respects max span limit', () => {
    const spans = new Map();
    const stack: string[] = [];
    for (let i = 0; i < 1001; i++) {
      startSpan(spans, stack, {
        spanId: `s-${i}`,
        name: `a-${i}`,
        timestamp: new Date(i),
        agentName: `a-${i}`,
        sessionId: 's1',
        traceId: 't1',
      });
    }
    expect(spans.size).toBeLessThanOrEqual(1000);
  });
});

describe('endSpan', () => {
  it('sets endTime and duration on existing span', () => {
    const spans = new Map();
    const stack: string[] = [];
    startSpan(spans, stack, {
      spanId: 'span-1',
      name: 'agent-a',
      timestamp: new Date(1000),
      agentName: 'agent-a',
      sessionId: 's1',
      traceId: 't1',
    });
    endSpan(spans, stack, { spanId: 'span-1', timestamp: new Date(2000) });
    const span = spans.get('span-1');
    expect(span.endTime).toEqual(new Date(2000));
    expect(span.durationMs).toBe(1000);
    expect(span.status).toBe('completed');
  });

  it('removes span from active stack', () => {
    const spans = new Map();
    const stack: string[] = [];
    startSpan(spans, stack, {
      spanId: 's1',
      name: 'a',
      timestamp: new Date(100),
      agentName: 'a',
      sessionId: 's1',
      traceId: 't1',
    });
    expect(stack).toContain('s1');
    endSpan(spans, stack, { spanId: 's1', timestamp: new Date(200) });
    expect(stack).not.toContain('s1');
  });

  it('falls back to LIFO when spanId not in stack (re-entrant agents)', () => {
    const spans = new Map();
    const stack: string[] = [];
    startSpan(spans, stack, {
      spanId: 's1',
      name: 'a',
      timestamp: new Date(100),
      agentName: 'a',
      sessionId: 's1',
      traceId: 't1',
    });
    startSpan(spans, stack, {
      spanId: 's2',
      name: 'a',
      timestamp: new Date(200),
      agentName: 'a',
      sessionId: 's1',
      traceId: 't1',
    });
    // End with unknown spanId — should close s2 (LIFO)
    endSpan(spans, stack, {
      spanId: 'unknown',
      timestamp: new Date(300),
      agentName: 'a',
    });
    expect(spans.get('s2').endTime).toEqual(new Date(300));
  });
});

describe('sweepRunningSpans', () => {
  it('ends all spans that have no endTime', () => {
    const spans = new Map();
    const stack: string[] = [];
    startSpan(spans, stack, {
      spanId: 's1',
      name: 'a',
      timestamp: new Date(100),
      agentName: 'a',
      sessionId: 's1',
      traceId: 't1',
    });
    startSpan(spans, stack, {
      spanId: 's2',
      name: 'b',
      timestamp: new Date(200),
      agentName: 'b',
      sessionId: 's1',
      traceId: 't1',
    });
    sweepRunningSpans(spans, stack, new Date(500));
    expect(spans.get('s1').endTime).toEqual(new Date(500));
    expect(spans.get('s2').endTime).toEqual(new Date(500));
    expect(stack).toHaveLength(0);
  });
});
```

NOTE: The `Span` interface uses `startTime: Date`, `endTime?: Date`, `status: 'running' | 'completed' | 'error'`, `agentName: string`, `sessionId: string`, `events: ExtendedTraceEvent[]`, `attributes: Record<string, unknown>`. The pure functions must create Span objects matching this interface exactly. READ `src/types/index.ts` lines 196-209 before implementing.

- [ ] **Step 3: Implement span-lifecycle.ts**

Extract the span logic from observatory-store.ts `addEvent()` into pure functions that operate on `Map<string, Span>` and `string[]` (active stack) parameters. READ the actual Span type first.

The key functions:

- `startSpan(spans, stack, opts)` — creates Span, pushes to stack, respects MAX_SPANS
- `endSpan(spans, stack, opts)` — finds span by ID or LIFO fallback, sets endTime
- `attachEventToSpan(spans, stack, event)` — finds the running span for an event's agentName
- `sweepRunningSpans(spans, stack, timestamp)` — ends all open spans

- [ ] **Step 4: Run tests**

Run: `cd apps/studio && pnpm vitest run src/features/observatory/__tests__/span-lifecycle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/features/observatory/span-lifecycle.ts apps/studio/src/features/observatory/__tests__/span-lifecycle.test.ts
git add apps/studio/src/features/observatory/
git commit -m "[ABLP-2] feat(studio): extract span lifecycle as pure functions"
```

---

### Task 8: Metric Aggregator

**Files:**

- Create: `src/features/observatory/metric-aggregator.ts`
- Test: `src/features/observatory/__tests__/metric-aggregator.test.ts`

- [ ] **Step 1: Read existing metric logic**

Read `src/store/observatory-store.ts` lines 317–346 (llm_call metrics, tool_call metrics, constraint tracking). Also read the `StepMetrics` and `ConstraintCheckResult` interfaces.

- [ ] **Step 2: Write failing tests**

```typescript
// src/features/observatory/__tests__/metric-aggregator.test.ts
import { describe, it, expect } from 'vitest';
import {
  aggregateLLMCall,
  aggregateToolCall,
  aggregateConstraintCheck,
  createEmptyMetrics,
} from '../metric-aggregator';

describe('aggregateLLMCall', () => {
  it('increments LLM call count and token totals', () => {
    const metrics = createEmptyMetrics();
    const event = {
      type: 'llm_call',
      data: { inputTokens: 100, outputTokens: 50 },
    };
    const result = aggregateLLMCall(metrics, event);
    expect(result.totalLLMCalls).toBe(1);
    expect(result.totalTokensIn).toBe(100);
    expect(result.totalTokensOut).toBe(50);
  });

  it('accumulates across multiple calls', () => {
    let metrics = createEmptyMetrics();
    metrics = aggregateLLMCall(metrics, {
      type: 'llm_call',
      data: { inputTokens: 100, outputTokens: 50 },
    });
    metrics = aggregateLLMCall(metrics, {
      type: 'llm_call',
      data: { inputTokens: 200, outputTokens: 100 },
    });
    expect(metrics.totalLLMCalls).toBe(2);
    expect(metrics.totalTokensIn).toBe(300);
    expect(metrics.totalTokensOut).toBe(150);
  });
});

describe('aggregateToolCall', () => {
  it('increments tool call count', () => {
    const metrics = createEmptyMetrics();
    const result = aggregateToolCall(metrics);
    expect(result.totalToolCalls).toBe(1);
  });
});

describe('aggregateConstraintCheck', () => {
  it('adds constraint check result to history', () => {
    const history: unknown[] = [];
    const event = {
      type: 'constraint_check',
      data: {
        constraintName: 'pii-check',
        passed: false,
        action: 'redact',
      },
      timestamp: 1000,
    };
    const result = aggregateConstraintCheck(history, event);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('pii-check');
    expect(result[0].passed).toBe(false);
  });

  it('respects max history size', () => {
    let history: unknown[] = [];
    for (let i = 0; i < 501; i++) {
      history = aggregateConstraintCheck(history, {
        type: 'constraint_check',
        data: { constraintName: `c-${i}`, passed: true },
        timestamp: i,
      });
    }
    expect(history.length).toBeLessThanOrEqual(500);
  });
});
```

- [ ] **Step 3: Implement metric-aggregator.ts**

Extract from observatory-store.ts. Pure functions that take current metrics + event, return new metrics. READ the actual data shapes from the store first.

- [ ] **Step 4: Run tests**

Run: `cd apps/studio && pnpm vitest run src/features/observatory/__tests__/metric-aggregator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/features/observatory/metric-aggregator.ts apps/studio/src/features/observatory/__tests__/metric-aggregator.test.ts
git add apps/studio/src/features/observatory/
git commit -m "[ABLP-2] feat(studio): extract metric aggregator as pure functions"
```

---

### Task 9: Flow Graph

**Files:**

- Create: `src/features/observatory/flow-graph.ts`
- Test: `src/features/observatory/__tests__/flow-graph.test.ts`

- [ ] **Step 1: Read existing flow graph logic**

Read `src/store/observatory-store.ts` lines 348–363 (auto-create flow node), lines 403–476 (handoff + delegate edges), lines 583–610 (flow transitions). Also read `AgentFlowNode`, `AgentFlowEdge` types from `src/types/index.ts`.

- [ ] **Step 2: Write failing tests**

Test the pure functions: `addAgentFlowNode`, `addFlowEdge`, `addHandoffEdge`, `addDelegateEdge`, `addFlowTransitionEdge`, `updateExecutionState`, `updateStepMetrics`.

NOTE: Step metrics tracking (currently in `addEvent()` lines 500-514 for `flow_step_enter` and 544-557 for `flow_step_exit`) belongs in this module, not metric-aggregator. Step metrics are flow-graph-scoped (tied to step nodes), while metric-aggregator handles global totals (LLM/tool counts).

Each function takes current state (nodes array, edges array, execution state map) and returns new state. Test:

- Adding a node that doesn't exist yet
- Not duplicating an existing node
- Creating edges between nodes
- Respecting MAX_FLOW_NODES (500) and MAX_FLOW_EDGES (1000)
- Updating execution state (active → visited transitions)

- [ ] **Step 3: Implement flow-graph.ts**

- [ ] **Step 4: Run tests**

Run: `cd apps/studio && pnpm vitest run src/features/observatory/__tests__/flow-graph.test.ts`

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/features/observatory/flow-graph.ts apps/studio/src/features/observatory/__tests__/flow-graph.test.ts
git add apps/studio/src/features/observatory/
git commit -m "[ABLP-2] feat(studio): extract flow graph operations as pure functions"
```

---

### Task 10: Observatory Contract Schemas

**Files:**

- Create: `src/features/observatory/observatory.contract.ts`
- Test: `src/features/observatory/__tests__/observatory.contract.test.ts`
- Create: `src/features/observatory/__fixtures__/llm-call-event.json`
- Create: `src/features/observatory/__fixtures__/tool-call-event.json`
- Create: `src/features/observatory/__fixtures__/handoff-event.json`
- Create: `src/features/observatory/__fixtures__/agent-enter-exit.json`

- [ ] **Step 1: Read existing types**

Read `src/types/index.ts` for `TraceEvent`, `ExtendedTraceEvent`, `Span`, `AgentFlowNode`, `AgentFlowEdge` type definitions. These become the basis for Zod schemas.

- [ ] **Step 2: Write fixture files**

Create JSON fixtures representing real trace events. Base these on the actual data shapes from the types, not guesses. Each fixture should be a valid trace event that could come from Runtime.

```json
// __fixtures__/llm-call-event.json
{
  "id": "evt-llm-1",
  "type": "llm_call",
  "timestamp": 1710201600000,
  "durationMs": 1500,
  "traceId": "trace-1",
  "spanId": "span-llm-1",
  "parentSpanId": "span-agent-1",
  "sessionId": "session-1",
  "agentName": "greeter",
  "data": {
    "model": "claude-sonnet-4-6",
    "provider": "anthropic",
    "inputTokens": 150,
    "outputTokens": 75,
    "messages": [],
    "response": "Hello!"
  }
}
```

Create similar fixtures for tool_call, handoff, agent_enter, agent_exit, flow_step_enter, flow_step_exit, constraint_check.

- [ ] **Step 3: Write contract test**

```typescript
// src/features/observatory/__tests__/observatory.contract.test.ts
import { describe, it, expect } from 'vitest';
import {
  TraceEventSchema,
  LLMCallDataSchema,
  ToolCallDataSchema,
  HandoffDataSchema,
  SpanSchema,
} from '../observatory.contract';

import llmCallFixture from '../__fixtures__/llm-call-event.json';
import toolCallFixture from '../__fixtures__/tool-call-event.json';
import handoffFixture from '../__fixtures__/handoff-event.json';
import agentFixture from '../__fixtures__/agent-enter-exit.json';

describe('observatory contracts', () => {
  it('validates llm_call event fixture', () => {
    const result = TraceEventSchema.safeParse(llmCallFixture);
    expect(result.success).toBe(true);
  });

  it('validates tool_call event fixture', () => {
    const result = TraceEventSchema.safeParse(toolCallFixture);
    expect(result.success).toBe(true);
  });

  it('validates handoff event fixture', () => {
    const result = TraceEventSchema.safeParse(handoffFixture);
    expect(result.success).toBe(true);
  });

  it('rejects event with missing required fields', () => {
    const result = TraceEventSchema.safeParse({ type: 'llm_call' });
    expect(result.success).toBe(false);
  });

  it('validates LLM call data shape', () => {
    const result = LLMCallDataSchema.safeParse(llmCallFixture.data);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 4: Implement observatory.contract.ts**

```typescript
// src/features/observatory/observatory.contract.ts
import { z } from 'zod';

/**
 * Zod schemas defining the Runtime ↔ Studio contract for trace events.
 * When Runtime changes a trace event shape, tests using these schemas fail.
 */

export const TraceEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  timestamp: z
    .union([z.date(), z.string(), z.number()])
    .transform((v) => (v instanceof Date ? v : new Date(v))),
  durationMs: z.number().optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional().nullable(),
  sessionId: z.string(),
  agentName: z.string().optional(),
  stepName: z.string().optional(),
  data: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const LLMCallDataSchema = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  messages: z.array(z.unknown()).optional(),
  response: z.unknown().optional(),
});

export const ToolCallDataSchema = z.object({
  toolName: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  durationMs: z.number().optional(),
});

export const HandoffDataSchema = z.object({
  targetAgent: z.string().optional(),
  reason: z.string().optional(),
});

export const SpanSchema = z.object({
  id: z.string(),
  name: z.string(),
  startTime: z.number(),
  endTime: z.number().optional(),
  durationMs: z.number().optional(),
  parentId: z.string().optional().nullable(),
  children: z.array(z.string()).optional(),
  events: z.array(z.string()).optional(),
});

export type ValidatedTraceEvent = z.infer<typeof TraceEventSchema>;
export type ValidatedSpan = z.infer<typeof SpanSchema>;
```

NOTE: Read the actual `TraceEvent` and `ExtendedTraceEvent` interfaces from `src/types/index.ts` before writing these schemas. The Zod schemas must match the real shapes, not guesses.

- [ ] **Step 5: Run tests**

Run: `cd apps/studio && pnpm vitest run src/features/observatory/__tests__/observatory.contract.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/studio/src/features/observatory/observatory.contract.ts apps/studio/src/features/observatory/__tests__/observatory.contract.test.ts apps/studio/src/features/observatory/__fixtures__/*.json
git add apps/studio/src/features/observatory/
git commit -m "[ABLP-2] feat(studio): add observatory Zod contract schemas and fixtures"
```

---

### Task 11: Observatory Store (Pure State)

**Files:**

- Create: `src/features/observatory/observatory.store.ts`
- Test: `src/features/observatory/__tests__/observatory.store.test.ts`

- [ ] **Step 1: Read existing store**

Read `src/store/observatory-store.ts` completely. Identify ALL state fields and ALL actions. The new store keeps all state fields and UI actions but removes the 348-line `addEvent()` — that moves to the handler.

Also read `src/store/trace-store.ts` to identify state that needs to be merged in (event filtering, search, selection).

- [ ] **Step 2: Write failing tests**

Test the pure state operations:

- `clearEvents()` resets events, spans, metrics, flow
- `selectSpan(id)` sets selectedSpanId
- `toggleDebugPanel()` toggles showObservatory
- UI state changes (debugPanelTab, canvasViewMode, etc.)
- Merged trace-store functionality: `setSelectedTypes`, `toggleType`, `setSearchQuery`, `getFilteredEvents`

- [ ] **Step 3: Implement observatory.store.ts**

The new store has:

- All state fields from current observatory-store.ts
- All UI actions (selectSpan, toggleDebugPanel, setDebugPanelTab, etc.)
- Merged trace-store state (selectedTypes, searchQuery, expandedEventIds)
- Merged trace-store actions (setSelectedTypes, toggleType, setSearchQuery, getFilteredEvents)
- `setEvents(events)` — bulk setter (called by handler after processing)
- `setSpans(spans)` — bulk setter
- `setMetrics(metrics)` — bulk setter
- `setFlowGraph(nodes, edges)` — bulk setter

NO `addEvent()`. The handler calls the pure functions and then calls the bulk setters.

**Zustand devtools:** Wrap the store with `devtools()` middleware for time-travel debugging during development:

```typescript
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export const useObservatoryStore = create<ObservatoryState>()(
  devtools(
    (set, get) => ({
      // ... state and actions
    }),
    { name: 'observatory', enabled: process.env.NODE_ENV === 'development' },
  ),
);
```

This enables Redux DevTools inspection (state diffs, action replay, time-travel) with zero production overhead. Apply this pattern to all new feature stores.

- [ ] **Step 4: Run tests**

Run: `cd apps/studio && pnpm vitest run src/features/observatory/__tests__/observatory.store.test.ts`

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/features/observatory/observatory.store.ts apps/studio/src/features/observatory/__tests__/observatory.store.test.ts
git add apps/studio/src/features/observatory/
git commit -m "[ABLP-2] feat(studio): create pure observatory store (no addEvent logic)"
```

---

### Task 12: Observatory Handler

**Files:**

- Create: `src/features/observatory/observatory.handlers.ts`
- Test: `src/features/observatory/__tests__/observatory.handlers.test.ts`

- [ ] **Step 1: Write failing tests**

This is the key integration test — the handler receives MessageBus events and orchestrates the pure functions to update the store.

```typescript
// src/features/observatory/__tests__/observatory.handlers.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { MessageBus } from '@/infrastructure/message-bus';
import { registerObservatoryHandlers } from '../observatory.handlers';
import { useObservatoryStore } from '../observatory.store';

// Import fixtures
import llmCallFixture from '../__fixtures__/llm-call-event.json';
import agentFixture from '../__fixtures__/agent-enter-exit.json';

describe('observatory handlers', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
    useObservatoryStore.getState().clearEvents();
    registerObservatoryHandlers(bus);
  });

  it('processes llm_call trace event into store', () => {
    bus.emit('trace_event', {
      sessionId: 'session-1',
      event: llmCallFixture,
    });

    const state = useObservatoryStore.getState();
    expect(state.events.length).toBe(1);
    expect(state.totalLLMCalls).toBe(1);
    expect(state.totalTokensIn).toBeGreaterThan(0);
  });

  it('processes agent_enter into span', () => {
    bus.emit('trace_event', {
      sessionId: 'session-1',
      event: {
        id: 'evt-1',
        type: 'agent_enter',
        timestamp: 1000,
        sessionId: 'session-1',
        agentName: 'greeter',
        spanId: 'span-1',
        data: {},
      },
    });

    const state = useObservatoryStore.getState();
    expect(state.spans.has('span-1')).toBe(true);
  });

  it('clears state on session_reset', () => {
    // Add some data first
    bus.emit('trace_event', {
      sessionId: 'session-1',
      event: llmCallFixture,
    });
    expect(useObservatoryStore.getState().events.length).toBe(1);

    // Reset
    bus.emit('session_reset', { sessionId: 'session-1' });
    expect(useObservatoryStore.getState().events.length).toBe(0);
  });

  it('sets static graph on agent_loaded', () => {
    bus.emit('agent_loaded', {
      sessionId: 'session-1',
      agent: {
        name: 'greeter',
        staticGraph: { nodes: [], edges: [] },
      },
    });

    const state = useObservatoryStore.getState();
    expect(state.debugState).toBe('running');
  });
});
```

- [ ] **Step 2: Implement observatory.handlers.ts**

```typescript
// src/features/observatory/observatory.handlers.ts
import type { MessageBus } from '@/infrastructure/message-bus';
import { useObservatoryStore } from './observatory.store';
import { normalizeTraceEvent } from './event-normalizer';
import { startSpan, endSpan, sweepRunningSpans } from './span-lifecycle';
import { aggregateLLMCall, aggregateToolCall, aggregateConstraintCheck } from './metric-aggregator';
import {
  addAgentFlowNode,
  addHandoffEdge,
  addDelegateEdge,
  addFlowTransitionEdge,
  updateExecutionState,
} from './flow-graph';

/**
 * Registers observatory handlers on the MessageBus.
 * Handles: trace_event (observatory concerns), agent_loaded, session_reset
 *
 * Returns unsubscribe function to tear down all handlers.
 */
export function registerObservatoryHandlers(bus: MessageBus): () => void {
  const unsubs: (() => void)[] = [];

  unsubs.push(
    bus.on('trace_event', (payload) => {
      const store = useObservatoryStore.getState();
      const event = normalizeTraceEvent(payload.event as Record<string, unknown>);

      // Process through pure functions based on event type
      // Each function returns new state; batch-update store at the end
      // READ observatory-store.ts addEvent() lines 292-639 for the full logic
      // to replicate here using the extracted pure functions.

      // Example structure:
      // 1. Normalize event
      // 2. Aggregate metrics (if llm_call/tool_call/constraint_check)
      // 3. Update span lifecycle (if agent_enter/exit, flow_step_enter/exit, session_ended)
      // 4. Update flow graph (if handoff, delegate_start, flow_transition)
      // 5. Update execution state
      // 6. Attach event to span
      // 7. Batch-update store
    }),
  );

  unsubs.push(
    bus.on('agent_loaded', (payload) => {
      const store = useObservatoryStore.getState();
      store.clearEvents();
      store.setDebugState('running');
      // Extract and set static graph from agent details
    }),
  );

  unsubs.push(
    bus.on('session_reset', () => {
      const store = useObservatoryStore.getState();
      store.clearEvents();
    }),
  );

  return () => {
    for (const unsub of unsubs) unsub();
  };
}
```

NOTE: The actual implementation must replicate ALL the logic from `addEvent()` (lines 292–639 of observatory-store.ts) using the pure functions from Tasks 6-9. READ the existing code line by line. The handler is the glue — it calls pure functions and writes results to the store.

**This is the most complex task in the plan.** It requires understanding 348 lines of imperative logic and decomposing it into calls to the pure functions. Expect 15-30 minutes and multiple iterations, not 2-5 minutes. The integration test (Task 20) is the validation gate — don't move on until it passes.

- [ ] **Step 3: Run tests**

Run: `cd apps/studio && pnpm vitest run src/features/observatory/__tests__/observatory.handlers.test.ts`

- [ ] **Step 4: Iterate until all tests pass**

The handler is the most complex piece. Expect to iterate.

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/features/observatory/observatory.handlers.ts apps/studio/src/features/observatory/__tests__/observatory.handlers.test.ts
git add apps/studio/src/features/observatory/
git commit -m "[ABLP-2] feat(studio): implement observatory MessageBus handler"
```

---

### Task 13: Observatory API Layer

**Files:**

- Create: `src/features/observatory/observatory.api.ts`

- [ ] **Step 1: Read existing API usage**

Search for how observatory-related data is fetched. Read:

- `src/hooks/useLLMCalls.ts` — how it derives LLM calls from events
- `src/hooks/useSessionDetail.ts` — how it fetches session detail
- `src/utils/replay-trace-events.ts` — how trace replay works
- `src/components/observatory/DebugTabs.tsx` — what data it reads from stores

- [ ] **Step 2: Create observatory.api.ts**

```typescript
// src/features/observatory/observatory.api.ts

/**
 * Observatory API Layer
 *
 * Data sources:
 *   Live trace events  → WS trace_event (via MessageBus → observatory.handlers.ts)
 *   Session detail     → REST GET /api/runtime/sessions/:id (Studio API route, reads MongoDB)
 *   Session traces     → REST GET /api/projects/:pid/sessions/:sid/traces (proxy to Runtime)
 *   LLM calls          → Derived from events in observatory store (client-side filter)
 *
 * This file is the ONLY place observatory fetches external data.
 */

import { apiFetch, handleResponse } from '@/lib/api-client';

export async function fetchSessionDetail(sessionId: string) {
  // handleResponse throws AppError on non-2xx — callers must handle
  const res = await apiFetch(`/api/runtime/sessions/${sessionId}`);
  return handleResponse<unknown>(res);
  // TODO: Validate with observatory.contract.ts schema once contracts mature
}

export async function fetchSessionTraces(projectId: string, sessionId: string) {
  // handleResponse throws AppError on non-2xx — callers must handle
  const res = await apiFetch(`/api/projects/${projectId}/sessions/${sessionId}/traces`);
  return handleResponse<unknown[]>(res);
}

// NOTE: All API functions in this file throw on error (via handleResponse).
// The observatory handler/component that calls these must wrap in try/catch
// and surface errors via the store or a toast, NOT swallow them.

/**
 * Derives LLM call summaries from the current event stream.
 * Pure function — operates on store snapshot, not network call.
 */
export function deriveLLMCalls(events: Array<{ type: string; data?: Record<string, unknown> }>) {
  return events.filter((e) => e.type === 'llm_call');
}
```

- [ ] **Step 3: Verify build**

Run: `cd apps/studio && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/features/observatory/observatory.api.ts
git add apps/studio/src/features/observatory/observatory.api.ts
git commit -m "[ABLP-2] feat(studio): add observatory API layer with data source documentation"
```

---

### Task 14: Observatory Feature Module Barrel + Types

**Files:**

- Create: `src/features/observatory/observatory.types.ts`
- Create: `src/features/observatory/index.ts`

- [ ] **Step 1: Create types file**

Derive TypeScript types from the Zod contracts, plus re-export existing types needed by components:

```typescript
// src/features/observatory/observatory.types.ts
import type { z } from 'zod';
import type { TraceEventSchema, SpanSchema, LLMCallDataSchema } from './observatory.contract';

// Contract-derived types
export type ValidatedTraceEvent = z.infer<typeof TraceEventSchema>;
export type ValidatedSpan = z.infer<typeof SpanSchema>;
export type ValidatedLLMCallData = z.infer<typeof LLMCallDataSchema>;

// Re-export types that components need (from existing type definitions)
export type {
  ExtendedTraceEvent,
  Span,
  SpanTreeNode,
  AgentFlowNode,
  AgentFlowEdge,
  Breakpoint,
  DebugState,
  StaticGraph,
  NodeExecutionState,
} from '@/types';
```

- [ ] **Step 2: Create barrel export**

```typescript
// src/features/observatory/index.ts
export { useObservatoryStore } from './observatory.store';
export { registerObservatoryHandlers } from './observatory.handlers';
export * from './observatory.api';
export * from './observatory.contract';
export * from './observatory.types';
export { normalizeEventType, normalizeTraceEvent } from './event-normalizer';
```

- [ ] **Step 3: Verify build**

Run: `cd apps/studio && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/features/observatory/observatory.types.ts apps/studio/src/features/observatory/index.ts
git add apps/studio/src/features/observatory/
git commit -m "[ABLP-2] feat(studio): add observatory types and barrel exports"
```

---

## Chunk 3: Integration (Dual-Write + Barrel Re-exports + Diagnostics)

### Task 15: Barrel Re-exports for Backward Compatibility

**Files:**

- Modify: `src/store/observatory-store.ts`
- Modify: `src/store/trace-store.ts`

- [ ] **Step 1: Read current consumers**

Run grep to confirm all imports of `useObservatoryStore` and `useTraceStore`:

```bash
cd apps/studio && grep -r "from.*store/observatory-store" src/ --include="*.ts" --include="*.tsx" -l
cd apps/studio && grep -r "from.*store/trace-store" src/ --include="*.ts" --include="*.tsx" -l
```

- [ ] **Step 2: Convert observatory-store.ts to re-export**

Keep the OLD file content intact but ADD a re-export at the top. During the dual-write phase, both the old store and the new feature module store exist. Components can import from either path.

At the TOP of `src/store/observatory-store.ts`, add:

```typescript
// MIGRATION: This file is being replaced by src/features/observatory/observatory.store.ts
// New code should import from '@/features/observatory' instead.
// This re-export ensures existing imports continue to work.
//
// TODO: After all consumers are migrated, delete this file.
```

Do NOT change the actual store yet — the dual-write integration (Task 16) will wire the new handler alongside the old addEvent.

- [ ] **Step 3: Add deprecation comment to trace-store.ts**

```typescript
// MIGRATION: trace-store.ts is being merged into features/observatory/observatory.store.ts
// The observatory store now owns event filtering, search, and selection.
// New code should import from '@/features/observatory' instead.
//
// DUAL-WRITE NOTE: During the transition, WebSocketContext.tsx still calls
// useTraceStore.addEvent() and useTraceStore.clearEvents() (lines 100-101).
// These calls remain as-is until WebSocketContext's trace_event handling is
// fully replaced by the MessageBus handler. At that point, trace-store.ts
// calls in WebSocketContext are removed and this file is deleted.
//
// During dual-write, both trace-store and observatory.store receive events.
// The observatory.store (via MessageBus handler) is the AUTHORITATIVE source.
// trace-store is kept alive only for components not yet migrated to read
// from observatory.store.
//
// TODO: After all consumers are migrated, delete this file.
```

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/store/observatory-store.ts apps/studio/src/store/trace-store.ts
git add apps/studio/src/store/observatory-store.ts apps/studio/src/store/trace-store.ts
git commit -m "[ABLP-2] refactor(studio): add migration comments to observatory and trace stores"
```

---

### Task 16: Dual-Write Integration

**Files:**

- Modify: `src/contexts/WebSocketContext.tsx`

This is the critical integration step. The WebSocketContext continues to work as before, but ALSO emits messages to the MessageBus. Observatory handlers on the bus process events in parallel with the old inline code.

- [ ] **Step 1: Read WebSocketContext.tsx fully**

Read the entire file. Understand every import, the handleMessage callback, and the WebSocket lifecycle.

- [ ] **Step 2: Add MessageBus integration**

First, verify that `WebSocketContext.tsx` has `'use client'` directive at the top (it should, since it uses React hooks). If not, add it — this prevents SSR execution.

Inside the `WebSocketProvider` component (NOT at module level — avoids SSR issues), add lazy initialization:

```typescript
import { MessageBus } from '@/infrastructure/message-bus';
import type { ServerMessageType } from '@/infrastructure/message-bus.types';
import { createTapMiddleware } from '@/infrastructure/tap-middleware';
import { registerObservatoryHandlers } from '@/features/observatory';

// Lazy singleton — initialized on first WebSocketProvider mount (client-side only)
let bus: MessageBus | null = null;
let transportTap: ReturnType<typeof createTapMiddleware> | null = null;
let handlerTap: ReturnType<typeof createTapMiddleware> | null = null;

function getOrCreateBus(): MessageBus {
  if (bus) return bus;
  bus = new MessageBus();
  transportTap = createTapMiddleware('ws-transport');
  handlerTap = createTapMiddleware('handler');
  bus.use(transportTap.middleware);
  bus.use(handlerTap.middleware);

  // Check if capture is enabled
  const captureEnabled =
    localStorage.getItem('STUDIO_DEBUG_CAPTURE') === 'true' ||
    new URLSearchParams(window.location.search).has('debug');
  transportTap.setEnabled(captureEnabled);
  handlerTap.setEnabled(captureEnabled);

  // Register observatory handlers
  registerObservatoryHandlers(bus);

  return bus;
}
```

Then in the `WebSocketProvider`'s `useEffect` or initialization, call `getOrCreateBus()`.

Inside the `handleMessage` callback, at the very beginning (before the switch statement), add:

```typescript
// Dual-write: emit to MessageBus alongside old inline handling
try {
  const b = getOrCreateBus();
  // Type-safe emit: ServerMessage.type is a string literal union matching ServerMessageType
  b.emit(message.type as ServerMessageType, message as any);
} catch (err) {
  // Bus handlers must not break the old code path
  if (process.env.NODE_ENV !== 'production') {
    console.error('[MessageBus] handler error:', err);
  }
}
```

NOTE: The `as any` on the payload is acceptable here because the ServerMessage union structure doesn't perfectly align with ServerMessageMap (ServerMessage includes `type` as a field while ServerMessageMap values exclude it). A proper typed adapter can be added later. The important thing is that `message.type` is typed as `ServerMessageType`, not `any`.

- [ ] **Step 3: Verify the app still works**

Run: `cd apps/studio && pnpm build`
Expected: Build succeeds

Run: `cd apps/studio && pnpm test`
Expected: Existing tests pass (the dual-write adds bus emission but doesn't change old behavior)

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/contexts/WebSocketContext.tsx
git add apps/studio/src/contexts/WebSocketContext.tsx
git commit -m "[ABLP-2] feat(studio): integrate MessageBus dual-write into WebSocketContext"
```

---

### Task 17: Expose Tap Data for Diagnostics

**Files:**

- Create: `src/app/api/debug/tap-data/route.ts`

- [ ] **Step 1: Create the debug API route**

This Next.js API route serves the tap buffer data to the diagnostic CLI. Only available in development.

```typescript
// src/app/api/debug/tap-data/route.ts
import { NextResponse } from 'next/server';

/**
 * GET /api/debug/tap-data
 *
 * Returns the current tap buffer snapshots for diagnostics.
 * Only available in development mode.
 */
export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'NOT_AVAILABLE',
          message: 'Debug endpoints are not available in production',
        },
      },
      { status: 404 },
    );
  }

  // The tap buffers live in the browser, not the server.
  // This route returns instructions for the CLI.
  return NextResponse.json({
    success: true,
    data: {
      message:
        'Tap data lives in the browser. Use the "Download Diagnostics" button in Studio or run: localStorage.getItem("STUDIO_TAP_SNAPSHOT")',
      instructions: [
        '1. Enable capture: localStorage.setItem("STUDIO_DEBUG_CAPTURE", "true")',
        '2. Reproduce the bug',
        '3. Click "Download Diagnostics" in the Observatory debug panel',
        '4. Run: pnpm studio:diagnose <path-to-downloaded-file>',
      ],
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
npx prettier --write apps/studio/src/app/api/debug/tap-data/route.ts
git add apps/studio/src/app/api/debug/tap-data/route.ts
git commit -m "[ABLP-2] feat(studio): add debug tap-data API route for diagnostics"
```

---

### Task 18: Diagnostic CLI Script

**Files:**

- Create: `tools/studio-diagnose.ts`

- [ ] **Step 1: Write the diagnostic script**

```typescript
// tools/studio-diagnose.ts
/**
 * Studio Pipeline Diagnostic Tool
 *
 * Reads a tap snapshot JSON file (exported from Studio UI) and produces
 * a layer-by-layer diff report identifying where data was lost/corrupted.
 *
 * Usage: npx tsx tools/studio-diagnose.ts <snapshot-file.json>
 *
 * Output: Structured JSON report to stdout, human-readable summary to stderr.
 */

import { readFileSync } from 'fs';

interface TapSnapshot {
  layer: string;
  totalReceived: number;
  retained: number;
  evicted: number;
  entries: Array<{ type: string; payload: unknown; timestamp: number }>;
}

interface DiagnosisReport {
  file: string;
  layers: Record<
    string,
    {
      event_count: number;
      total_received: number;
      evicted: number;
      diff_from_previous: string;
    }
  >;
  diagnosis: string;
  files_to_inspect: string[];
}

function diagnose(snapshots: TapSnapshot[]): DiagnosisReport {
  const report: DiagnosisReport = {
    file: '',
    layers: {},
    diagnosis: '',
    files_to_inspect: [],
  };

  let previousCount = -1;
  const issues: string[] = [];

  for (const snap of snapshots) {
    const layerReport = {
      event_count: snap.retained,
      total_received: snap.totalReceived,
      evicted: snap.evicted,
      diff_from_previous:
        previousCount === -1
          ? 'first layer'
          : snap.retained === previousCount
            ? 'none'
            : `${previousCount - snap.retained} events lost`,
    };

    report.layers[snap.layer] = layerReport;

    if (previousCount !== -1 && snap.retained < previousCount) {
      const lost = previousCount - snap.retained;
      issues.push(`${snap.layer}: ${lost} events lost (${snap.evicted} evicted by buffer)`);

      // Map layer to file
      const fileMap: Record<string, string> = {
        'ws-transport': 'src/infrastructure/ws-transport.ts',
        handler: 'src/features/observatory/observatory.handlers.ts',
        store: 'src/features/observatory/observatory.store.ts',
      };
      if (fileMap[snap.layer]) {
        report.files_to_inspect.push(fileMap[snap.layer]);
      }
    }

    previousCount = snap.retained;
  }

  report.diagnosis =
    issues.length === 0 ? 'No data loss detected across layers.' : issues.join('; ');

  return report;
}

// CLI entry point
const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: npx tsx tools/studio-diagnose.ts <snapshot-file.json>');
  process.exit(1);
}

try {
  const raw = readFileSync(filePath, 'utf-8');
  const snapshots: TapSnapshot[] = JSON.parse(raw);
  const report = diagnose(snapshots);
  report.file = filePath;

  // Machine-readable output to stdout
  console.log(JSON.stringify(report, null, 2));

  // Human-readable summary to stderr
  console.error('\n--- Studio Pipeline Diagnosis ---');
  for (const [layer, info] of Object.entries(report.layers)) {
    console.error(`  ${layer}: ${info.event_count} events (${info.diff_from_previous})`);
  }
  console.error(`\nDiagnosis: ${report.diagnosis}`);
  if (report.files_to_inspect.length > 0) {
    console.error(`Files to inspect: ${report.files_to_inspect.join(', ')}`);
  }
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
```

- [ ] **Step 2: Add script to root package.json**

Add to the root `package.json` scripts section:

```json
"studio:diagnose": "npx tsx tools/studio-diagnose.ts"
```

- [ ] **Step 3: Commit**

```bash
npx prettier --write tools/studio-diagnose.ts
git add tools/studio-diagnose.ts package.json
git commit -m "[ABLP-2] feat(tools): add studio pipeline diagnostic CLI"
```

---

### Task 19: Download Diagnostics Button in Observatory UI

**Files:**

- Modify: `src/components/observatory/FloatingDebugPanel.tsx`

- [ ] **Step 1: Read FloatingDebugPanel.tsx**

Read the full file to understand the current button layout (minimize + close buttons in the title bar).

- [ ] **Step 2: Add a "Download Diagnostics" button**

Add a button next to the minimize/close buttons that:

1. Checks if `STUDIO_DEBUG_CAPTURE` is enabled in localStorage
2. If not, enables it and shows a message "Capture enabled — reproduce the bug, then click again"
3. If enabled, collects tap buffer snapshots and triggers a JSON file download

Read the actual button component/icon patterns used in FloatingDebugPanel before implementing. Use the same icon library (lucide-react) and styling patterns.

- [ ] **Step 3: Test manually**

This is a UI integration — verify the button renders and doesn't break the panel layout.

Run: `cd apps/studio && pnpm build`

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/components/observatory/FloatingDebugPanel.tsx
git add apps/studio/src/components/observatory/FloatingDebugPanel.tsx
git commit -m "[ABLP-2] feat(studio): add Download Diagnostics button to observatory panel"
```

---

### Task 20: Full Integration Test

**Files:**

- Create: `src/features/observatory/__tests__/observatory.integration.test.ts`

- [ ] **Step 1: Write integration test**

Tests the full pipeline: MessageBus → tap middleware → observatory handler → store → verify state.

```typescript
// src/features/observatory/__tests__/observatory.integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { MessageBus } from '@/infrastructure/message-bus';
import { createTapMiddleware } from '@/infrastructure/tap-middleware';
import { registerObservatoryHandlers } from '../observatory.handlers';
import { useObservatoryStore } from '../observatory.store';

describe('observatory full pipeline', () => {
  let bus: MessageBus;
  let transportTap: ReturnType<typeof createTapMiddleware>;
  let handlerTap: ReturnType<typeof createTapMiddleware>;

  beforeEach(() => {
    bus = new MessageBus();
    transportTap = createTapMiddleware('ws-transport');
    handlerTap = createTapMiddleware('handler');
    bus.use(transportTap.middleware);
    bus.use(handlerTap.middleware);
    registerObservatoryHandlers(bus);
    useObservatoryStore.getState().clearEvents();
  });

  it('processes a multi-event agent session end-to-end', () => {
    // Agent enters
    bus.emit('trace_event', {
      sessionId: 's1',
      event: {
        id: 'e1',
        type: 'agent_enter',
        timestamp: 1000,
        sessionId: 's1',
        agentName: 'greeter',
        spanId: 'span-1',
        data: {},
      },
    });

    // LLM call
    bus.emit('trace_event', {
      sessionId: 's1',
      event: {
        id: 'e2',
        type: 'llm_call',
        timestamp: 1100,
        durationMs: 500,
        sessionId: 's1',
        agentName: 'greeter',
        spanId: 'span-llm-1',
        data: { inputTokens: 100, outputTokens: 50 },
      },
    });

    // Tool call
    bus.emit('trace_event', {
      sessionId: 's1',
      event: {
        id: 'e3',
        type: 'tool_call',
        timestamp: 1200,
        durationMs: 200,
        sessionId: 's1',
        agentName: 'greeter',
        spanId: 'span-tool-1',
        data: { toolName: 'search' },
      },
    });

    // Agent exits
    bus.emit('trace_event', {
      sessionId: 's1',
      event: {
        id: 'e4',
        type: 'agent_exit',
        timestamp: 2000,
        sessionId: 's1',
        agentName: 'greeter',
        spanId: 'span-1',
        data: {},
      },
    });

    const state = useObservatoryStore.getState();

    // Verify events captured
    expect(state.events.length).toBe(4);

    // Verify metrics
    expect(state.totalLLMCalls).toBe(1);
    expect(state.totalTokensIn).toBe(100);
    expect(state.totalTokensOut).toBe(50);
    expect(state.totalToolCalls).toBe(1);

    // Verify span lifecycle
    expect(state.spans.has('span-1')).toBe(true);
    const span = state.spans.get('span-1')!;
    expect(span.endTime).toBe(2000);
    expect(span.durationMs).toBe(1000);

    // Verify tap buffers captured everything
    const transportSnap = transportTap.getBuffer().snapshot('ws-transport');
    const handlerSnap = handlerTap.getBuffer().snapshot('handler');
    expect(transportSnap.totalReceived).toBe(4);
    expect(handlerSnap.totalReceived).toBe(4);
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `cd apps/studio && pnpm vitest run src/features/observatory/__tests__/observatory.integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `cd apps/studio && pnpm test`
Expected: All existing tests still pass + new tests pass

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/features/observatory/__tests__/observatory.integration.test.ts
git add apps/studio/src/features/observatory/__tests__/observatory.integration.test.ts
git commit -m "[ABLP-2] test(studio): add observatory full pipeline integration test"
```

---

### Task 21: Build Verification + Final Commit

- [ ] **Step 1: Run full build**

Run: `cd apps/studio && pnpm build`
Expected: Build succeeds with no errors

- [ ] **Step 2: Run full test suite**

Run: `cd apps/studio && pnpm test`
Expected: All tests pass

- [ ] **Step 3: Run type check**

Run: `cd apps/studio && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Verify no regressions in broader monorepo**

Run: `pnpm build --filter=studio`
Expected: Succeeds

- [ ] **Step 5: Final format check**

Run: `npx prettier --check apps/studio/src/infrastructure/ apps/studio/src/features/`
Expected: All files formatted
