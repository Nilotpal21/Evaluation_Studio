# STI Phase -1: Platform Trace Readiness — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Establish per-turn trace ID generation, propagation through all channel entry points, persistence to ClickHouse, and client surfacing — so every interaction is individually addressable by a unique trace ID that customers and support can reference.

**Architecture:** Generate a `traceId` (UUID v4) at every channel entry point (WebSocket debug handler, SDK handler, REST chat, channel inbound worker). Store it in `AsyncLocalStorage` for concurrent safety. Thread it through `TraceEmitterConfig` → `TraceEventWithId` → EventStore `platform_events.trace_id`. Surface it back to clients in WebSocket `response_start` and REST response bodies / `X-Trace-ID` header.

**Tech Stack:** Node.js `AsyncLocalStorage`, `crypto.randomUUID()`, ClickHouse (column already exists), Vitest for tests.

**Note:** Phase -1 is not defined in the STI design doc — it addresses the implicit prerequisite that `trace_id` is populated in `platform_events`, which Phase 0a assumes (design doc line 1066: "engineers can query by trace_id").

**Key Discovery — Infrastructure Already Exists:**

- `PlatformEvent.trace_id` field: `packages/eventstore/src/schema/platform-event.ts:30`
- ClickHouse `platform_events.trace_id` column: `packages/database/src/clickhouse-schemas/init.ts:291`
- ClickHouse `idx_trace` bloom filter: `packages/database/src/clickhouse-schemas/init.ts:317`
- Row mapper read/write: `packages/eventstore/src/stores/clickhouse/clickhouse-row-mapper.ts:56,90`
- `TraceEventWithId.traceId` optional field: `apps/runtime/src/types/index.ts:444`
- Voice traces already generate per-turn traceId: `apps/runtime/src/observability/voice-trace.ts:163`

**What's Missing (the gap this plan fills):**

1. No `traceId` field in `TraceEmitterConfig` — the emitter never receives one
2. `emit()` never sets `traceId` on `TraceEventWithId` or passes `trace_id` to EventStore
3. No channel entry point generates a per-turn trace ID (except voice)
4. No `AsyncLocalStorage` for trace context (only `requestIdMiddleware` for REST, never connected to traces)
5. No client surfacing — `response_start`, `response_end`, REST bodies don't include trace ID

**Most impactful deferred gap:** SDK handler (`sdk-handler.ts`) writes trace events to in-memory TraceStore only, NOT EventStore/ClickHouse. SDK is likely the primary production integration channel. Adding EventStore writes to the SDK handler requires adding a TraceEmitter or equivalent write path and is deferred to Phase 0a.

---

### Task 1: Create Trace Context Module with AsyncLocalStorage

**Files:**

- Create: `apps/runtime/src/observability/trace-context.ts`
- Test: `apps/runtime/src/__tests__/trace-context.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/trace-context.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import {
  runTrace,
  getCurrentTraceId,
  VALID_TRACE_ID,
  type TraceContext,
} from '../observability/trace-context.js';

describe('trace-context', () => {
  describe('runTrace', () => {
    it('should make traceId available inside callback via getCurrentTraceId', async () => {
      let captured: string | undefined;
      await runTrace({ traceId: 'test-trace-123' }, async () => {
        captured = getCurrentTraceId();
      });
      expect(captured).toBe('test-trace-123');
    });

    it('should return undefined outside of trace context', () => {
      expect(getCurrentTraceId()).toBeUndefined();
    });

    it('should isolate concurrent trace contexts', async () => {
      const results: string[] = [];
      await Promise.all([
        runTrace({ traceId: 'trace-a' }, async () => {
          await new Promise((r) => setTimeout(r, 10));
          results.push(getCurrentTraceId()!);
        }),
        runTrace({ traceId: 'trace-b' }, async () => {
          results.push(getCurrentTraceId()!);
        }),
      ]);
      expect(results).toContain('trace-a');
      expect(results).toContain('trace-b');
    });

    it('should return the callback result', async () => {
      const result = await runTrace({ traceId: 'x' }, async () => 42);
      expect(result).toBe(42);
    });
  });

  describe('getFullTraceContext', () => {
    it('should return full context object', async () => {
      const { getFullTraceContext } = await import('../observability/trace-context.js');
      let ctx: TraceContext | undefined;
      await runTrace({ traceId: 'full-test', sessionId: 'sess-1' }, async () => {
        ctx = getFullTraceContext();
      });
      expect(ctx).toEqual({ traceId: 'full-test', sessionId: 'sess-1' });
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-context.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// apps/runtime/src/observability/trace-context.ts
/**
 * Trace Context — AsyncLocalStorage-based per-turn trace ID propagation.
 *
 * Every channel entry point calls runTrace() with a generated traceId.
 * Downstream code calls getCurrentTraceId() to read it without parameter threading.
 *
 * Uses AsyncLocalStorage.run() (not enterWith()) for concurrent safety —
 * overlapping turns on the same session get independent contexts.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface TraceContext {
  traceId: string;
  sessionId?: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Run a callback within a trace context. The traceId is available to all
 * downstream async code via getCurrentTraceId().
 */
export function runTrace<T>(ctx: TraceContext, fn: () => T | Promise<T>): T | Promise<T> {
  return traceStorage.run(ctx, fn);
}

/**
 * Get the current trace ID from AsyncLocalStorage.
 * Returns undefined when called outside a runTrace() callback.
 */
export function getCurrentTraceId(): string | undefined {
  return traceStorage.getStore()?.traceId;
}

/**
 * Get the full trace context from AsyncLocalStorage.
 * Returns undefined when called outside a runTrace() callback.
 */
export function getFullTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

/**
 * Shared validation regex for client-provided trace IDs.
 * Alphanumeric + hyphens, max 64 chars.
 * Exported so channel entry points don't duplicate this regex.
 */
export const VALID_TRACE_ID = /^[a-zA-Z0-9\-]{1,64}$/;
```

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-context.test.ts`
Expected: PASS (5 tests)

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/observability/trace-context.ts apps/runtime/src/__tests__/trace-context.test.ts
git add apps/runtime/src/observability/trace-context.ts apps/runtime/src/__tests__/trace-context.test.ts
git commit -m "feat(runtime): add trace context module with AsyncLocalStorage for per-turn trace ID"
```

---

### Task 2: Thread traceId Through TraceEmitterConfig and emit()

**Files:**

- Modify: `apps/runtime/src/services/trace-emitter.ts` (TraceEmitterConfig + emit)
- Test: `apps/runtime/src/__tests__/trace-emitter-traceid.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/trace-emitter-traceid.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock trace-store (module-scope, matching codebase pattern)
vi.mock('../services/trace-store.js', () => ({
  getTraceStore: () => ({
    addEvent: vi.fn(),
  }),
}));

// Mock eventstore-singleton (module-scope)
vi.mock('../services/eventstore-singleton.js', () => ({
  getEventStore: () => null,
}));

// Mock trace-event-types (required dependency)
vi.mock('../services/trace-event-types.js', () => ({
  TRACE_TO_PLATFORM_TYPE: {},
  inferCategory: () => 'runtime',
}));

import { createTraceEmitter } from '../services/trace-emitter.js';

describe('TraceEmitter traceId propagation', () => {
  const mockWs = {
    readyState: 1,
    OPEN: 1,
    CONNECTING: 0,
    CLOSING: 2,
    CLOSED: 3,
    send: vi.fn(),
  } as unknown as import('ws').WebSocket;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should include traceId on emitted TraceEventWithId when config has traceId', () => {
    const emitter = createTraceEmitter({
      sessionId: 'sess-1',
      ws: mockWs,
      traceId: 'trace-abc-123',
    });

    const result = emitter.emit({
      type: 'user_message',
      timestamp: new Date(),
      data: { contentLength: 10 },
    });

    expect(result).toBeDefined();
    expect(result!.traceId).toBe('trace-abc-123');
    expect(result!.sessionId).toBe('sess-1');
  });

  it('should NOT include traceId when config omits it', () => {
    const emitter = createTraceEmitter({
      sessionId: 'sess-2',
      ws: mockWs,
    });

    const result = emitter.emit({
      type: 'user_message',
      timestamp: new Date(),
      data: { contentLength: 5 },
    });

    expect(result).toBeDefined();
    expect(result!.traceId).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-emitter-traceid.test.ts`
Expected: FAIL — `traceId` not on config type / not propagated

**Step 3: Modify TraceEmitterConfig and emit()**

In `apps/runtime/src/services/trace-emitter.ts`:

1. Add `traceId?: string` to `TraceEmitterConfig` (after `sessionId` at line 33):

   ```typescript
   export interface TraceEmitterConfig {
     sessionId: string;
     traceId?: string;  // <-- ADD THIS
     ws: WebSocket;
     // ... rest unchanged
   ```

2. In `createTraceEmitter()`, extract `traceId` as a **mutable** `let` binding (NOT in the const destructure, because `updateTraceId()` in Task 3 will mutate it):

   ```typescript
   // After the existing const destructure block (lines 60-69):
   let traceId = config.traceId;
   ```

   Do NOT add `traceId` to the `const { sessionId, ws, ... }` destructure.

3. In `emit()` function (line 100), add `traceId` to `storedEvent`:

   ```typescript
   const storedEvent: TraceEventWithId = {
     ...event,
     id: crypto.randomUUID(),
     sessionId,
     ...(traceId && { traceId }),  // <-- ADD THIS
     ...(deploymentId && { deploymentId }),
     // ... rest unchanged
   ```

4. In the EventStore write path (~line 151), add `trace_id`:
   ```typescript
   eventStore.emitter.emit({
     event_id: storedEvent.id,
     event_type: platformType,
     category: inferCategory(platformType),
     tenant_id: tenantId,
     project_id: projectId ?? '',
     session_id: sessionId,
     trace_id: traceId,  // <-- ADD THIS
     agent_name: storedEvent.agentName,
     // ... rest unchanged
   ```

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-emitter-traceid.test.ts`
Expected: PASS

**Step 5: Run existing trace-emitter tests to verify no regression**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-emitter`
Expected: All existing tests PASS

**Step 6: Commit**

```bash
npx prettier --write apps/runtime/src/services/trace-emitter.ts apps/runtime/src/__tests__/trace-emitter-traceid.test.ts
git add apps/runtime/src/services/trace-emitter.ts apps/runtime/src/__tests__/trace-emitter-traceid.test.ts
git commit -m "feat(runtime): thread traceId through TraceEmitterConfig to TraceEventWithId and EventStore"
```

---

### Task 3: Generate traceId at WebSocket Debug Handler Entry Point

**Files:**

- Modify: `apps/runtime/src/websocket/handler.ts` (send_message handler)
- Test: `apps/runtime/src/__tests__/trace-context-ws.test.ts`

**Context:** The WebSocket debug handler processes `send_message` client messages. Each message is a new "turn". The trace emitter is created once per session at `load_agent` time, but we need a per-turn `traceId`. Two approaches:

1. Create a new emitter per turn (wasteful — config, scrub, dimensions setup)
2. Add an `updateTraceId(id)` method to the emitter and call it at turn start

Approach 2 is simpler. Add `updateTraceId` to the trace emitter, then call it from the `send_message` handler before execution.

**Note on dual propagation:** This task sets up TWO trace ID propagation mechanisms: (1) `updateTraceId()` on the emitter — used immediately in Phase -1 for EventStore writes and client surfacing, and (2) `runTrace()` ALS context — NOT consumed in Phase -1 but is forward-looking infrastructure for Phase 0a's `tracePath()` wrapper which will call `getCurrentTraceId()` to read the trace context. Both are needed.

**Important:** `turnTraceId` is generated and set on the emitter here, but NOT yet surfaced to clients — that happens in Task 7. Do not modify `ServerMessages.responseStart`/`responseEnd` calls in this task.

**Concurrency note:** The emitter uses a mutable `let traceId` closure variable, which means overlapping turns on the same session could overwrite each other's traceId. This is safe because the runtime's execution queue serializes turns per session (one `executeMessage` at a time per session). If this invariant changes in the future, `emit()` should read from ALS (`getCurrentTraceId()`) instead of the closure variable.

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/trace-context-ws.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTraceEmitter } from '../services/trace-emitter.js';

vi.mock('../services/trace-store.js', () => ({
  getTraceStore: () => ({
    addEvent: vi.fn(),
  }),
}));

vi.mock('../services/eventstore-singleton.js', () => ({
  getEventStore: () => null,
}));

vi.mock('../services/trace-event-types.js', () => ({
  inferCategory: () => 'runtime',
  TRACE_TO_PLATFORM_TYPE: {},
}));

describe('TraceEmitter.updateTraceId', () => {
  const mockWs = {
    readyState: 1,
    OPEN: 1,
    send: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should update traceId for subsequent emits', () => {
    const emitter = createTraceEmitter({
      sessionId: 'sess-1',
      ws: mockWs,
    });

    // Initially no traceId
    const event1 = emitter.emit({
      type: 'user_message',
      timestamp: new Date(),
      data: { contentLength: 5 },
    });
    expect(event1!.traceId).toBeUndefined();

    // Update traceId for new turn
    emitter.updateTraceId('turn-trace-xyz');

    const event2 = emitter.emit({
      type: 'user_message',
      timestamp: new Date(),
      data: { contentLength: 10 },
    });
    expect(event2!.traceId).toBe('turn-trace-xyz');
  });

  it('should allow clearing traceId', () => {
    const emitter = createTraceEmitter({
      sessionId: 'sess-1',
      ws: mockWs,
      traceId: 'initial',
    });

    emitter.updateTraceId(undefined);

    const event = emitter.emit({
      type: 'user_message',
      timestamp: new Date(),
      data: {},
    });
    expect(event!.traceId).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-context-ws.test.ts`
Expected: FAIL — `updateTraceId` not a function

**Step 3: Add updateTraceId to trace emitter**

In `apps/runtime/src/services/trace-emitter.ts`:

1. Change `const { ... traceId ... }` destructure to a `let`:
   - The `traceId` variable must be mutable. Since it's destructured alongside many `const` bindings, extract it separately:

   ```typescript
   let traceId = config.traceId;
   ```

   (Add this after the existing destructure block, removing `traceId` from the destructure)

2. Add `updateTraceId` function before the return statement:

   ```typescript
   function updateTraceId(newTraceId: string | undefined) {
     traceId = newTraceId;
   }
   ```

3. Add `updateTraceId` to the return object:
   ```typescript
   return {
     emit,
     // ... existing methods ...
     updateTraceId,
   };
   ```

**Step 4: Modify WebSocket handler to generate per-turn traceId**

In `apps/runtime/src/websocket/handler.ts`:

1. Add import at top of file (alongside existing `import crypto from 'crypto'` at line 11):

   ```typescript
   import { runTrace } from '../observability/trace-context.js';
   ```

   Note: `crypto` is already imported at line 11.

2. In `handleSendMessage()` (starts at line 1358), after `const traceEmitter = clientState?.traceEmitter` (line 1366), generate and set the trace ID:

   ```typescript
   const turnTraceId = crypto.randomUUID();
   if (traceEmitter) {
     traceEmitter.updateTraceId(turnTraceId);
   }
   ```

3. Wrap the execution block in `runTrace` for ALS propagation:

   ```typescript
   await runTrace({ traceId: turnTraceId, sessionId }, async () => {
     // ... existing executeMessage call and response handling
   });
   ```

4. **Also handle session rehydration path**: Lines 1390-1401 create a second traceEmitter during rehydration. After that creation, also call `updateTraceId(turnTraceId)` on the rehydrated emitter.

**Codebase-verified locations:**

- `case 'send_message'` switch at line 702 dispatches to `handleSendMessage()` at line 1358
- `traceEmitter` retrieved from `clientState?.traceEmitter` at line 1366
- `crypto` already imported at line 11
- `ServerMessages.responseStart` called at line 1416 (update to pass `turnTraceId` in Task 7)

**Step 5: Run test to verify it passes**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-context-ws.test.ts`
Expected: PASS

**Step 6: Run full existing test suite to verify no regression**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-emitter`
Expected: All PASS

**Step 7: Commit**

```bash
npx prettier --write apps/runtime/src/services/trace-emitter.ts apps/runtime/src/websocket/handler.ts apps/runtime/src/__tests__/trace-context-ws.test.ts
git add apps/runtime/src/services/trace-emitter.ts apps/runtime/src/websocket/handler.ts apps/runtime/src/__tests__/trace-context-ws.test.ts
git commit -m "feat(runtime): generate per-turn traceId at WebSocket debug handler entry point"
```

---

### Task 4: Generate traceId at SDK WebSocket Handler Entry Point

**Files:**

- Modify: `apps/runtime/src/websocket/sdk-handler.ts`
- Test: `apps/runtime/src/__tests__/trace-context-sdk.test.ts`

**Context:** The SDK handler processes messages from embedded SDK widgets. Unlike the debug handler, the SDK handler does NOT use `ServerMessages` helpers — it builds raw `{ type: 'response_start', ... }` objects inline. The traceId must be added to these raw objects.

**Key difference from debug handler:** The SDK handler has NO TraceEmitter instance. It constructs `TraceEventWithId` objects manually (see line 913-921) and adds them to TraceStore directly (via `getTraceStore().addEvent()`). TraceId injection happens on these raw objects.

**Known gap — SDK EventStore writes:** The SDK handler writes trace events to the in-memory TraceStore only, NOT to EventStore/ClickHouse. This means SDK trace events will have `traceId` in memory but NOT in `platform_events.trace_id` in ClickHouse. Adding EventStore writes to the SDK handler is OUT OF SCOPE for Phase -1 (it would require adding a TraceEmitter or equivalent write path). This gap is documented in the coverage map (Task 10).

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/trace-context-sdk.test.ts
import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';

describe('SDK handler traceId generation', () => {
  it('should generate a valid UUID v4 traceId per turn', () => {
    const traceId = crypto.randomUUID();
    expect(traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('should include traceId on raw response_start objects', () => {
    const turnTraceId = crypto.randomUUID();
    const msg = {
      type: 'response_start' as const,
      messageId: 'msg-1',
      sessionId: 'sess-1',
      ...(turnTraceId && { traceId: turnTraceId }),
    };
    expect(msg.traceId).toBe(turnTraceId);
  });
});
```

**Step 2: Run test to verify it passes (baseline)**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-context-sdk.test.ts`
Expected: PASS

**Step 3: Modify SDK handler**

In `apps/runtime/src/websocket/sdk-handler.ts`:

1. `crypto` is already imported at line 10. Add trace context import:

   ```typescript
   import { runTrace } from '../observability/trace-context.js';
   ```

2. **In the message execution function** (find the function that handles incoming user messages — it calls `executor.executeMessage()` at lines ~1577/~1753 and `executor.initializeSession()` at line ~883), generate traceId at the top:

   ```typescript
   const turnTraceId = crypto.randomUUID();
   ```

3. **Add traceId to raw response_start objects** (lines 887-891, 1475):

   ```typescript
   send(ws, {
     type: 'response_start',
     messageId: responseMessageId,
     sessionId: state.sessionId,
     traceId: turnTraceId, // <-- ADD
   });
   ```

4. **Add traceId to raw response_end objects** (lines 927-934, 1494-1499, and other response_end sites):

   ```typescript
   send(ws, {
     type: 'response_end',
     messageId: responseMessageId,
     sessionId: state.sessionId,
     fullText: fullResponse,
     traceId: turnTraceId, // <-- ADD
     richContent: result?.richContent || undefined,
     actions: result?.actions || undefined,
   });
   ```

5. **Add traceId to ALL manually constructed TraceEventWithId sites:**
   - **Line 913-921** (initializeSession onTraceEvent callback):
     ```typescript
     const traceEvent: TraceEventWithId = {
       id: crypto.randomUUID(),
       sessionId: state.sessionId,
       traceId: turnTraceId, // <-- ADD
       type: event.type as TraceEventType,
       // ... rest unchanged
     };
     ```
   - **Line 995** (session_resolution event) — add `traceId: turnTraceId` to the object.
   - **Line 1532** (executeMessage onTraceEvent callback) — add `traceId: turnTraceId` to the object.
   - **Line 1932** (voice realtime turn) — NO CHANGE NEEDED, already has `traceId` from `metrics.traceId`.

6. Wrap the execution in `runTrace`:
   ```typescript
   await runTrace({ traceId: turnTraceId, sessionId: state.sessionId }, async () => {
     // ... existing execution
   });
   ```

**Codebase-verified call sites requiring traceId injection (raw objects, NOT ServerMessages):**

- Line 887-891: `response_start` during initializeSession
- Line 927-934: `response_end` after initializeSession
- Line 1475: `response_start` before message execution
- Line 1494-1499: `response_end` fallback (demo mode)
- Line ~1587: `response_end` after executeMessage
- Line ~1671: `response_end` error path
- Line 1728: `response_start` secondary path (action_submit)
- Line ~1735: `response_end` error fallback (action_submit)
- Line ~1758: `response_end` success path (action_submit) — **added I3**

**Step 4: Run existing SDK handler tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/ws-sdk-handler.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/websocket/sdk-handler.ts apps/runtime/src/__tests__/trace-context-sdk.test.ts
git add apps/runtime/src/websocket/sdk-handler.ts apps/runtime/src/__tests__/trace-context-sdk.test.ts
git commit -m "feat(runtime): generate per-turn traceId at SDK WebSocket handler entry point"
```

---

### Task 5: Generate traceId at Channel Inbound Worker Entry Point

**Files:**

- Modify: `apps/runtime/src/services/queues/inbound-worker.ts`
- Modify: `apps/runtime/src/channels/types.ts` (add `traceId?: string` to `InboundJobPayload`)
- Test: `apps/runtime/src/__tests__/trace-context-inbound.test.ts`

**Context:** The inbound worker processes BullMQ jobs from external channels (Genesys, Teams, webhook, etc.). Each job represents one inbound message = one turn.

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/trace-context-inbound.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('Inbound worker traceId generation', () => {
  it('should accept X-Trace-ID from inbound payload when present', () => {
    // Validate that the InboundJobPayload type supports an optional traceId
    const payload = {
      tenantId: 't1',
      connectionId: 'c1',
      subscriptionId: 's1',
      idempotencyKey: 'idem-1',
      channelType: 'webhook',
      message: {
        text: 'hello',
        externalMessageId: 'ext-1',
      },
      traceId: 'client-provided-trace-id',
    };
    expect(payload.traceId).toBe('client-provided-trace-id');
  });

  it('should generate traceId when payload has no traceId', () => {
    const crypto = require('crypto');
    const generated = crypto.randomUUID();
    expect(generated).toBeTruthy();
    expect(typeof generated).toBe('string');
  });
});
```

**Step 2: Run test to verify it passes (baseline)**

**Step 3: Modify inbound worker**

In `apps/runtime/src/services/queues/inbound-worker.ts`, inside the BullMQ worker callback:

1. Add imports at top of file:

   ```typescript
   import crypto from 'crypto';
   import { runTrace, VALID_TRACE_ID } from '../../observability/trace-context.js';
   ```

   Note: `crypto` is NOT currently imported in this file (unlike handler.ts/sdk-handler.ts).

2. **CRITICAL nesting**: The worker callback is already wrapped in `runWithTenantContext()` (line 50). The `runTrace()` must nest INSIDE `runWithTenantContext()`, not wrap it. Place trace generation after the dedup check (line ~84) but inside the tenant context:

   ```typescript
   await runWithTenantContext({ tenantId: payload.tenantId, ... }, async () => {
     // ... existing dedup check (lines 68-84) ...

     // After dedup passes, before execution:
     const turnTraceId = (payload.traceId && VALID_TRACE_ID.test(payload.traceId))
       ? payload.traceId
       : crypto.randomUUID();

     await runTrace({ traceId: turnTraceId }, async () => {
       // ... existing execution and delivery logic
     });
   });
   ```

3. Add `traceId?: string` to `InboundJobPayload` in `apps/runtime/src/channels/types.ts` now (Task 9 adds the webhook extraction logic that populates it, but the type field is needed here for `payload.traceId` to compile).

**Codebase-verified nesting order:**

- BullMQ worker callback at line 47
- `runWithTenantContext()` at line 50 (OUTER — must remain outer)
- Dedup check at lines 68-84
- `runTrace()` goes AFTER dedup, INSIDE tenant context (INNER)

**Step 4: Run existing inbound worker tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/inbound`
Expected: All PASS

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/services/queues/inbound-worker.ts apps/runtime/src/channels/types.ts apps/runtime/src/__tests__/trace-context-inbound.test.ts
git add apps/runtime/src/services/queues/inbound-worker.ts apps/runtime/src/channels/types.ts apps/runtime/src/__tests__/trace-context-inbound.test.ts
git commit -m "feat(runtime): generate per-turn traceId at channel inbound worker entry point"
```

---

### Task 6: Generate traceId at REST Chat Endpoint

**Files:**

- Modify: `apps/runtime/src/routes/chat.ts` (SSE streaming chat endpoint at `/api/v1/chat`)
- Test: `apps/runtime/src/__tests__/trace-context-rest.test.ts`

**Context:** `routes/chat.ts` contains TWO distinct route handlers:

- **`/stream`** (line 236): SSE streaming LLM proxy — uses `writeSSE()` events, sets `Content-Type: text/event-stream` at line 303.
- **`/agent`** (line 717): Agent-backed JSON endpoint — calls `executor.executeMessage()` at line 1089, returns `res.json()` at line 1176.

Both need traceId. The `/agent` handler is the primary runtime entry point. `crypto` is already imported at line 8.

**Codebase-verified:** `sessions.ts` has only `POST /` (create), `POST /bulk-close`, `POST /cleanup-orphans`, `POST /:id/close`, `POST /:id/reset` — no chat/message endpoint.

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/trace-context-rest.test.ts
import { describe, it, expect } from 'vitest';
import { VALID_TRACE_ID } from '../observability/trace-context.js';

describe('REST chat traceId', () => {
  it('should set X-Trace-ID response header (integration pattern)', () => {
    const traceId = 'abc-123-def';
    const headers: Record<string, string> = {};
    headers['X-Trace-ID'] = traceId;
    expect(headers['X-Trace-ID']).toBe(traceId);
  });

  it('should accept client-provided X-Trace-ID with validation', () => {
    expect(VALID_TRACE_ID.test('client-trace-123')).toBe(true);
    expect(VALID_TRACE_ID.test('a'.repeat(65))).toBe(false);
  });
});
```

**Step 2: Run test (baseline)**

**Step 3: Modify REST chat routes**

In `apps/runtime/src/routes/chat.ts`:

1. Import (`crypto` already imported at line 8):

   ```typescript
   import { runTrace, VALID_TRACE_ID } from '../observability/trace-context.js';
   ```

2. **`/agent` handler (line 717)** — this is the primary runtime entry point. Inside the handler callback, before `executor.executeMessage()` at line 1089:

   ```typescript
   const clientTraceId = req.headers['x-trace-id'] as string | undefined;
   const turnTraceId =
     clientTraceId && VALID_TRACE_ID.test(clientTraceId) ? clientTraceId : crypto.randomUUID();
   res.setHeader('X-Trace-ID', turnTraceId);
   ```

3. **Wrap executor call** at line 1089 in `runTrace`:

   ```typescript
   execResult = await runTrace({ traceId: turnTraceId, sessionId: runtimeSessionId }, async () => {
     return executor.executeMessage(runtimeSessionId, message, onChunk, onTraceEvent);
   });
   ```

   Note: The variable is `runtimeSessionId` (line 1090), not `sessionId`.

4. **Include `traceId` in JSON response** at line 1176:

   ```typescript
   res.json({
     sessionId: runtimeSessionId,
     response: execResult.response,
     traceId: turnTraceId, // <-- ADD
     action: execResult.action,
     // ... rest unchanged
   });
   ```

5. **`/stream` handler (line 236)** — SSE path. Insert `X-Trace-ID` header BEFORE the existing SSE headers at line 303 (headers must be set before `res.write()`):

   ```typescript
   const clientTraceId = req.headers['x-trace-id'] as string | undefined;
   const turnTraceId =
     clientTraceId && VALID_TRACE_ID.test(clientTraceId) ? clientTraceId : crypto.randomUUID();
   res.setHeader('X-Trace-ID', turnTraceId);
   // ... existing SSE headers at line 303+
   ```

6. **Include `traceId` in SSE `metadata` event** at line 331:
   ```typescript
   writeSSE(res, 'metadata', {
     ...existingMetadata,
     traceId: turnTraceId,
   });
   ```

**Step 4: Run existing chat route tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/chat`
Expected: All PASS

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/routes/chat.ts apps/runtime/src/__tests__/trace-context-rest.test.ts
git add apps/runtime/src/routes/chat.ts apps/runtime/src/__tests__/trace-context-rest.test.ts
git commit -m "feat(runtime): generate per-turn traceId at REST chat endpoint with X-Trace-ID header"
```

---

### Task 7: Surface traceId in WebSocket response_start Message

**Files:**

- Modify: `apps/runtime/src/types/index.ts` (ServerMessage type)
- Modify: `apps/runtime/src/websocket/events.ts` (ServerMessages.responseStart, responseEnd refactored to options object)
- Modify: `apps/runtime/src/websocket/handler.ts` (all 11 caller sites)
- Modify: `apps/runtime/src/__tests__/rich-content-execution.test.ts` (6 callers → opts pattern)
- Modify: `apps/runtime/src/__tests__/websocket-events.test.ts` (line 502 → opts pattern)
- Test: `apps/runtime/src/__tests__/trace-surface-ws.test.ts`

**Context:** The `response_start` WebSocket message is the first message clients see for each turn. Adding `traceId` here lets UI components display it immediately. The `response_end` message is refactored from 6 positional params to `(sessionId, messageId, fullText, opts?)` to avoid callers needing 3 explicit `undefined`s to reach `traceId`.

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/trace-surface-ws.test.ts
import { describe, it, expect } from 'vitest';
import { ServerMessages } from '../websocket/events.js';

describe('WebSocket traceId surfacing', () => {
  it('response_start should include traceId when provided', () => {
    const msg = ServerMessages.responseStart('sess-1', 'msg-1', 'trace-abc');
    expect(msg).toMatchObject({
      type: 'response_start',
      sessionId: 'sess-1',
      messageId: 'msg-1',
      traceId: 'trace-abc',
    });
  });

  it('response_start should omit traceId when not provided', () => {
    const msg = ServerMessages.responseStart('sess-1', 'msg-1');
    expect(msg).toMatchObject({
      type: 'response_start',
      sessionId: 'sess-1',
      messageId: 'msg-1',
    });
    expect((msg as any).traceId).toBeUndefined();
  });

  it('response_end should include traceId when provided', () => {
    const msg = ServerMessages.responseEnd('sess-1', 'msg-1', 'Hello', {
      traceId: 'trace-xyz',
    });
    expect((msg as any).traceId).toBe('trace-xyz');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-surface-ws.test.ts`
Expected: FAIL — `traceId` not in response_start

**Step 3: Modify ServerMessage types and creators**

In `apps/runtime/src/types/index.ts`, modify the `response_start` and `response_end` variants:

```typescript
// response_start — add optional traceId
| { type: 'response_start'; sessionId: string; messageId: string; traceId?: string }

// response_end — add optional traceId
| {
    type: 'response_end';
    sessionId: string;
    messageId: string;
    fullText: string;
    traceId?: string;
    voiceConfig?: import('@abl/compiler').VoiceConfigIR;
    richContent?: import('@abl/compiler').RichContentIR;
    actions?: import('@abl/compiler').ActionSetIR;
  }
```

In `apps/runtime/src/websocket/events.ts`, update `ServerMessages`:

```typescript
responseStart(sessionId: string, messageId: string, traceId?: string): ServerMessage {
  return {
    type: 'response_start',
    sessionId,
    messageId,
    ...(traceId && { traceId }),
  };
},

responseEnd(
  sessionId: string,
  messageId: string,
  fullText: string,
  opts?: {
    voiceConfig?: import('@abl/compiler').VoiceConfigIR;
    richContent?: import('@abl/compiler').RichContentIR;
    actions?: import('@abl/compiler').ActionSetIR;
    traceId?: string;
  },
): ServerMessage {
  return {
    type: 'response_end',
    sessionId,
    messageId,
    fullText,
    ...(opts?.traceId && { traceId: opts.traceId }),
    voiceConfig: opts?.voiceConfig,
    richContent: opts?.richContent,
    actions: opts?.actions,
  };
},
```

**Step 4: Update ALL callers of responseStart and responseEnd**

**Codebase-verified call sites in `handler.ts` (uses ServerMessages helpers):**

| Line | Function                           | Call                                                                              | Action                                                        |
| ---- | ---------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1244 | `handleLoadAgent`                  | `ServerMessages.responseStart(sessionId, responseMessageId)`                      | No traceId — agent-load is not a user turn. Leave as-is.      |
| 1302 | `handleLoadAgent`                  | `ServerMessages.responseEnd(sessionId, ...)`                                      | Refactor to options object. No traceId (agent-load).          |
| 1342 | `handleLoadAgent` error fallback   | `ServerMessages.responseStart(sessionId, responseMessageId)`                      | No traceId (error during agent-load). Leave as-is.            |
| 1346 | `handleLoadAgent` error fallback   | `ServerMessages.responseEnd(sessionId, ...)`                                      | Refactor to options object. No traceId.                       |
| 1416 | `handleSendMessage` main execution | `ServerMessages.responseStart(sessionId, responseMessageId)`                      | Add `turnTraceId` as 3rd arg                                  |
| 1509 | main response                      | `ServerMessages.responseEnd(sessionId, ...)`                                      | Refactor to options object, add `traceId: turnTraceId`        |
| 1747 | handoff response                   | `ServerMessages.responseEnd(...)`                                                 | Refactor to options object, add `traceId: turnTraceId`        |
| 1765 | handoff fallback                   | `ServerMessages.responseEnd(...)`                                                 | Refactor to options object, add `traceId: turnTraceId`        |
| 1813 | fallback response                  | `ServerMessages.responseEnd(sessionId, responseMessageId, fallbackResponse.text)` | Refactor to options object, add `traceId: turnTraceId`        |
| 2244 | cross-pod replay                   | `ServerMessages.responseStart(effectiveSessionId, msgId)`                         | No traceId (not available in cross-pod context). Leave as-is. |
| 2249 | cross-pod replay                   | `ServerMessages.responseEnd(effectiveSessionId, msgId, ...)`                      | Refactor to options object. No traceId.                       |

**IMPORTANT — `responseEnd` breaking change:** ALL existing callers of `ServerMessages.responseEnd` must be refactored from positional args to the new options object pattern. Callers passing `voiceConfig`, `richContent`, or `actions` as positional args 4-6 must move them into the `opts` parameter. Search for `ServerMessages.responseEnd(` across the entire codebase to find all callers.

**SDK handler (`sdk-handler.ts`) uses RAW objects — already updated in Task 4.** No `ServerMessages` calls exist in sdk-handler.ts.

**Test files — MUST migrate to options-object pattern (BREAKING CHANGE):**

`websocket-events.test.ts`:

- Lines 445, 486: `responseEnd(sessionId, messageId, fullText)` → no change needed (3 args still valid)
- Line 471: `responseStart` — not affected by `responseEnd` refactor
- Line 502: `responseEnd(sessionId, messageId, fullText, voiceConfig, richContent, actions)` → `responseEnd(sessionId, messageId, fullText, { voiceConfig, richContent, actions })`

`rich-content-execution.test.ts` — ALL 6 callers must migrate positional args 4-6 to opts:

- `ServerMessages.responseEnd('s', 'm', 'text', undefined, richContent)` → `ServerMessages.responseEnd('s', 'm', 'text', { richContent })`
- `ServerMessages.responseEnd('s', 'm', 'text', voiceConfig, richContent, actions)` → `ServerMessages.responseEnd('s', 'm', 'text', { voiceConfig, richContent, actions })`
- Pattern: move args 4-6 into `{ voiceConfig?, richContent?, actions? }` object, omitting `undefined` values.

**Production callers in handler.ts — concrete refactored code:**

- Line 1302 (`handleLoadAgent`): `ServerMessages.responseEnd(sessionId, responseMessageId, fullResponse, result?.voiceConfig, result?.richContent, result?.actions)` → `ServerMessages.responseEnd(sessionId, responseMessageId, fullResponse, { voiceConfig: result?.voiceConfig, richContent: result?.richContent, actions: result?.actions })`
- Line 1509 (`handleSendMessage`): same pattern, ADD `traceId: turnTraceId` to opts.
- Line 1747/1765/1813: `ServerMessages.responseEnd(sessionId, msgId, text)` → `ServerMessages.responseEnd(sessionId, msgId, text, { traceId: turnTraceId })` (no voiceConfig/richContent/actions at these sites)
- Line 2249 (cross-pod): `ServerMessages.responseEnd(effectiveSessionId, msgId, fullText, voiceConfig, richContent, actions)` → `ServerMessages.responseEnd(effectiveSessionId, msgId, fullText, { voiceConfig, richContent, actions })`

**Cross-pod delivery note:** Lines 2244 and 2249 replay messages from Redis pub/sub where `traceId` is not available. Pass `undefined` — the traceId was already written to EventStore during the original emission on the source pod.

**Step 5: Run test to verify it passes**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-surface-ws.test.ts`
Expected: PASS

**Step 6: Build to verify type safety**

Run: `cd apps/runtime && pnpm build`
Expected: No type errors

**Step 7: Commit**

```bash
npx prettier --write apps/runtime/src/types/index.ts apps/runtime/src/websocket/events.ts apps/runtime/src/websocket/handler.ts apps/runtime/src/__tests__/trace-surface-ws.test.ts apps/runtime/src/__tests__/rich-content-execution.test.ts apps/runtime/src/__tests__/websocket-events.test.ts
git add apps/runtime/src/types/index.ts apps/runtime/src/websocket/events.ts apps/runtime/src/websocket/handler.ts apps/runtime/src/__tests__/trace-surface-ws.test.ts apps/runtime/src/__tests__/rich-content-execution.test.ts apps/runtime/src/__tests__/websocket-events.test.ts
git commit -m "feat(runtime): surface traceId in WebSocket response_start and response_end messages"
```

---

### Task 8: Verify EventStore trace_id Write Path End-to-End

**Files:**

- Test: `apps/runtime/src/__tests__/trace-emitter-eventstore.test.ts`

**Context:** The EventStore `PlatformEvent.trace_id` field, ClickHouse column, and row mapper all exist. Task 2 added `trace_id` to the EventStore emit call. This task verifies the full path with a focused integration test.

**Step 1: Write the test**

```typescript
// apps/runtime/src/__tests__/trace-emitter-eventstore.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTraceEmitter } from '../services/trace-emitter.js';

const mockEmit = vi.fn();

// Mock trace-store
vi.mock('../services/trace-store.js', () => ({
  getTraceStore: () => ({
    addEvent: vi.fn(),
  }),
}));

// Mock eventstore-singleton at module scope (matching codebase convention — NOT vi.doMock)
vi.mock('../services/eventstore-singleton.js', () => ({
  getEventStore: () => ({
    emitter: { emit: mockEmit },
  }),
}));

vi.mock('../services/trace-event-types.js', () => ({
  TRACE_TO_PLATFORM_TYPE: {},
  inferCategory: () => 'runtime',
}));

describe('TraceEmitter EventStore trace_id write', () => {
  const mockWs = { readyState: 1, OPEN: 1, send: vi.fn() } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should pass trace_id to EventStore when traceId is in config', async () => {
    const emitter = createTraceEmitter({
      sessionId: 'sess-es',
      ws: mockWs,
      traceId: 'trace-es-test',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });

    emitter.emit({
      type: 'user_message',
      timestamp: new Date(),
      data: { contentLength: 5 },
    });

    // Verify EventStore received trace_id
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-1',
        session_id: 'sess-es',
        trace_id: 'trace-es-test',
      }),
    );
  });
});
```

**Step 2: Run test**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-emitter-eventstore.test.ts`
Expected: PASS (if Task 2 was done correctly)

**Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/__tests__/trace-emitter-eventstore.test.ts
git add apps/runtime/src/__tests__/trace-emitter-eventstore.test.ts
git commit -m "test(runtime): verify EventStore trace_id write path end-to-end"
```

---

### Task 9: Accept Client-Provided X-Trace-ID in Channel Payloads

**Files:**

- Modify: `apps/runtime/src/channels/types.ts` (InboundJobPayload)
- Test: `apps/runtime/src/__tests__/trace-context-client-provided.test.ts`

**Context:** External channel integrations (webhook, Genesys, etc.) may want to correlate their trace IDs with ours. If the inbound payload includes a `traceId` or the HTTP request includes `X-Trace-ID`, we use it. Otherwise we generate one.

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/trace-context-client-provided.test.ts
import { describe, it, expect } from 'vitest';
import { VALID_TRACE_ID } from '../observability/trace-context.js';

describe('Client-provided trace ID validation', () => {
  it('should accept valid client trace ID', () => {
    expect(VALID_TRACE_ID.test('abc-123-def')).toBe(true);
    expect(VALID_TRACE_ID.test('a'.repeat(64))).toBe(true);
  });

  it('should reject invalid client trace IDs', () => {
    expect(VALID_TRACE_ID.test('')).toBe(false);
    expect(VALID_TRACE_ID.test('a'.repeat(65))).toBe(false);
    expect(VALID_TRACE_ID.test('has spaces')).toBe(false);
    expect(VALID_TRACE_ID.test('has;semicolons')).toBe(false);
  });
});
```

**Step 2: Run test (baseline)**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-context-client-provided.test.ts`
Expected: PASS

**Step 3: Update channel webhook routes to extract X-Trace-ID**

Note: `InboundJobPayload.traceId` was already added in Task 5. This task adds the webhook extraction that populates it.

**Step 4: Update channel webhook routes to extract X-Trace-ID**

In `apps/runtime/src/routes/channel-webhooks.ts` (and other channel routes), when constructing the `InboundJobPayload`:

```typescript
import { VALID_TRACE_ID } from '../observability/trace-context.js';

const clientTraceId = req.headers['x-trace-id'] as string | undefined;
const traceId = clientTraceId && VALID_TRACE_ID.test(clientTraceId) ? clientTraceId : undefined;
// Include in payload:
{ ...existingPayload, traceId }
```

Note: `VALID_TRACE_ID` is imported from the shared trace-context module (Task 1) — NOT duplicated inline.

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/channels/types.ts apps/runtime/src/routes/channel-webhooks.ts apps/runtime/src/__tests__/trace-context-client-provided.test.ts
git add apps/runtime/src/channels/types.ts apps/runtime/src/routes/channel-webhooks.ts apps/runtime/src/__tests__/trace-context-client-provided.test.ts
git commit -m "feat(runtime): accept client-provided X-Trace-ID in channel inbound payloads"
```

---

### Task 10: Create Instrumentation Coverage Map Document

**Files:**

- Create: `docs/plans/2026-03-11-trace-instrumentation-coverage.md`

**Context:** Document every code path from channel entry to exit, which ones now have trace IDs, and any remaining gaps. This is the "coverage map" from the Phase -1 design.

**Step 1: Create the document**

```markdown
# Trace Instrumentation Coverage Map

**Date**: 2026-03-11
**Status**: Phase -1 Complete

## Channel Entry Points

| Entry Point              | File                                | traceId Generated | ALS Propagation | EventStore trace_id                       | Client Surfaced               |
| ------------------------ | ----------------------------------- | ----------------- | --------------- | ----------------------------------------- | ----------------------------- |
| WebSocket Debug          | `websocket/handler.ts`              | YES (per turn)    | YES (runTrace)  | YES                                       | YES (response_start)          |
| WebSocket SDK            | `websocket/sdk-handler.ts`          | YES (per turn)    | YES (runTrace)  | NO (TraceStore only, no EventStore write) | YES (response_start)          |
| REST Chat                | `routes/chat.ts`                    | YES (per turn)    | YES (runTrace)  | YES                                       | YES (X-Trace-ID header + SSE) |
| Channel Inbound (BullMQ) | `services/queues/inbound-worker.ts` | YES (per job)     | YES (runTrace)  | YES                                       | YES (via webhook delivery)    |
| Voice (KoreVG)           | `observability/voice-trace.ts`      | YES (existing)    | Separate system | YES (voice events)                        | YES (via voice trace)         |

## Trace ID Lifecycle

1. **Generation**: `crypto.randomUUID()` at channel entry, or accepted from client `X-Trace-ID` header (validated: alphanumeric+hyphens, max 64 chars)
2. **ALS Storage**: `runTrace({ traceId })` stores in AsyncLocalStorage
3. **Emitter Threading**: `traceEmitter.updateTraceId(id)` sets per-turn ID
4. **TraceEventWithId**: `storedEvent.traceId` populated on every emit
5. **EventStore**: `platform_events.trace_id` column populated via emitter
6. **Client Surface**: `response_start.traceId`, `X-Trace-ID` header

**ClickHouse query note:** The `idx_trace` bloom filter only supports equality queries. Always use `WHERE trace_id = 'xxx'` — never `WHERE trace_id != ''` (bloom filters cannot optimize inequality).

## Remaining Gaps (Future Phases)

| Gap                                                                                     | Severity | Phase     |
| --------------------------------------------------------------------------------------- | -------- | --------- |
| SDK handler EventStore writes (TraceStore only, no ClickHouse `trace_id`)               | Medium   | Phase 0a  |
| Studio/web-sdk TypeScript types for `response_start.traceId` and `response_end.traceId` | Low      | Phase 0a  |
| Cross-service trace_id HTTP header propagation (Runtime → SearchAI requests)            | Medium   | Phase 0a+ |
| BullMQ job-to-job trace linking (inbound → delivery)                                    | Low      | Phase 0a+ |
| Admin API endpoints (no trace context)                                                  | Low      | Phase 1   |
| Email SMTP inbound                                                                      | Low      | Phase 1   |
```

**Step 2: Commit**

```bash
npx prettier --write docs/plans/2026-03-11-trace-instrumentation-coverage.md
git add docs/plans/2026-03-11-trace-instrumentation-coverage.md
git commit -m "docs: add trace instrumentation coverage map for Phase -1"
```

---

### Task 11: Full Build and Test Suite Verification

**Files:** None (verification only)

**Step 1: Build all affected packages**

Run: `pnpm build --filter=@abl/runtime`
Expected: Clean build, no type errors

**Step 2: Run full runtime test suite**

Run: `cd apps/runtime && pnpm vitest run`
Expected: All tests pass, no regressions

**Step 3: Run eventstore tests**

Run: `cd packages/eventstore && pnpm vitest run`
Expected: All tests pass

**Step 4: If any failures, fix and recommit**

**Step 5: Final commit (if any fixups)**

```bash
git commit -m "fix(runtime): address Phase -1 test/build issues"
```

---

## Summary

| Task | What                                             | Key Files                                                       |
| ---- | ------------------------------------------------ | --------------------------------------------------------------- |
| 1    | Trace context ALS module                         | `observability/trace-context.ts`                                |
| 2    | Thread traceId through TraceEmitter → EventStore | `services/trace-emitter.ts`                                     |
| 3    | Generate traceId at WS debug handler             | `websocket/handler.ts`                                          |
| 4    | Generate traceId at SDK handler                  | `websocket/sdk-handler.ts`                                      |
| 5    | Generate traceId at channel inbound worker       | `services/queues/inbound-worker.ts`                             |
| 6    | Generate traceId at REST chat                    | `routes/chat.ts`                                                |
| 7    | Surface traceId in WS response messages          | `types/index.ts`, `websocket/events.ts`, `websocket/handler.ts` |
| 8    | Verify EventStore trace_id e2e                   | Test only                                                       |
| 9    | Accept client X-Trace-ID                         | `channels/types.ts`, webhook routes                             |
| 10   | Coverage map document                            | `docs/plans/`                                                   |
| 11   | Full build + test verification                   | Verification only                                               |

**No ClickHouse DDL migration needed** — the `trace_id` column, bloom filter index, and EventStore row mapper already exist. The only gap was the write path (TraceEmitter never populated it) and the generation/propagation layer.

---

## Review Amendments

### Iteration 1 (3 reviewers: file path accuracy, code pattern correctness, design doc coverage)

| ID   | Severity | Task | Finding                                                                                                       | Fix Applied                                                                            |
| ---- | -------- | ---- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| I1-1 | CRITICAL | 6    | `POST /:id/chat` doesn't exist in `sessions.ts`. REST chat endpoint is `routes/chat.ts` at `/api/v1/chat`     | Rewrote Task 6 to target `routes/chat.ts` with SSE streaming context                   |
| I1-2 | CRITICAL | 5    | `runTrace()` must nest INSIDE `runWithTenantContext()`, not wrap it                                           | Rewrote Task 5 Step 3 with correct nesting order and codebase-verified line references |
| I1-3 | HIGH     | 7    | All callers of `responseStart`/`responseEnd` not enumerated — 11 call sites in handler.ts + test files        | Added explicit table of all 11 call sites with line numbers and actions                |
| I1-4 | HIGH     | 4,7  | SDK handler builds raw `{ type: 'response_start' }` objects, NOT ServerMessages helpers — 8+ raw object sites | Rewrote Task 4 with all 8 raw object sites requiring traceId injection                 |
| I1-5 | MEDIUM   | 5    | `crypto` not imported in inbound-worker.ts                                                                    | Added explicit `import crypto from 'crypto'` to Task 5 Step 3                          |
| I1-6 | MEDIUM   | 3    | handler.ts line 1390-1401 creates second traceEmitter during session rehydration                              | Added Step 4 to Task 3 for rehydration path                                            |
| I1-7 | LOW      | 2    | Line number references off (plan said "line 62", actual destructure at 60-69)                                 | Updated all line references in Task 2                                                  |
| I1-8 | LOW      | 2    | Test used `vi.doMock()` inside test body; codebase uses `vi.mock()` at module scope                           | Rewrote Task 2 test with module-scope `vi.mock()` pattern matching existing tests      |

### Iteration 2 (3 reviewers: scope/variable analysis, SDK handler completeness, SSE integration accuracy)

| ID   | Severity | Task   | Finding                                                                                                                                    | Fix Applied                                                                                               |
| ---- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| I2-1 | CRITICAL | 7      | Lines 1244, 1302, 1342, 1346 are in `handleLoadAgent()`, NOT `handleSendMessage()` — `turnTraceId` variable not in scope                   | Updated caller table: these 4 sites pass `undefined` (agent-load is not a user turn)                      |
| I2-2 | HIGH     | 4, 10  | SDK handler writes to TraceStore only (in-memory), NOT EventStore/ClickHouse — SDK trace events won't have `trace_id` in `platform_events` | Documented as known gap in Task 4 context and coverage map (Task 10). Out of scope for Phase -1.          |
| I2-3 | MEDIUM   | 6      | Task 6 didn't specify WHERE in `chat.ts` to inject traceId relative to `res.write()` and SSE calls                                         | Added specific line references: header before line 302, wrap at line 1089, metadata SSE event at line 331 |
| I2-4 | LOW      | 8      | Task 8 test used `vi.doMock()` inconsistently with Task 2 fix (I1-8)                                                                       | Rewrote Task 8 test with module-scope `vi.mock()` and direct import                                       |
| I2-5 | LOW      | Header | Architecture paragraph said "REST sessions" — should be "REST chat"                                                                        | Fixed header text                                                                                         |

### Iteration 3 (3 reviewers: file path/scope verification, code snippet accuracy, design doc coverage)

| ID    | Severity | Task    | Finding                                                                                                                                                                                                   | Fix Applied                                                                                                                |
| ----- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| I3-1  | CRITICAL | 6       | `chat.ts` has TWO route handlers: `/stream` (SSE, line 236) and `/agent` (JSON, line 717). Plan conflated them — line 302 (SSE headers) is in `/stream` but `executeMessage` at line 1089 is in `/agent`. | Rewrote Task 6 to explicitly handle both handlers with correct line refs per handler.                                      |
| I3-2  | HIGH     | 4       | `executeMessage` "line ~1089" is from `chat.ts`, not `sdk-handler.ts`. Actual SDK handler sites: lines ~1577 and ~1753.                                                                                   | Fixed line reference in Task 4 Step 3.                                                                                     |
| I3-3  | HIGH     | 4       | Missing `response_end` at sdk-handler.ts line ~1758 (action_submit success path).                                                                                                                         | Added to Task 4 call-site list.                                                                                            |
| I3-4  | HIGH     | 4       | Only 1 of 4 `TraceEventWithId` construction sites listed. Missing: line 995 (session_resolution), line 1532 (executeMessage callback). Line 1932 (voice) already has traceId.                             | Added all 4 sites to Task 4 with per-site instructions.                                                                    |
| I3-5  | HIGH     | 3       | Task 3 test missing `vi.mock('../services/trace-event-types.js')` — import would fail.                                                                                                                    | Added mock to Task 3 test.                                                                                                 |
| I3-6  | HIGH     | 5, 9    | Task 5 references `payload.traceId` but `InboundJobPayload.traceId` is added in Task 9 (after Task 5). Type error until Task 9.                                                                           | Task 5 now adds the type field to `InboundJobPayload` directly. Task 9 adds webhook extraction.                            |
| I3-7  | HIGH     | 3       | Dual propagation (ALS `runTrace` + emitter `updateTraceId`) unexplained. ALS is not consumed in Phase -1.                                                                                                 | Added note: ALS is forward-looking for Phase 0a's `tracePath()` which calls `getCurrentTraceId()`.                         |
| I3-8  | MEDIUM   | 7       | `responseEnd` 7th positional param forces callers to pass 3 explicit `undefined`s. Fragile API.                                                                                                           | Refactored `responseEnd` to use options object: `responseEnd(sessionId, messageId, fullText, opts?)`. All callers updated. |
| I3-9  | MEDIUM   | 1, 6, 9 | `VALID_TRACE_ID` regex duplicated in 3 files.                                                                                                                                                             | Extracted to trace-context module (Task 1) as `export const VALID_TRACE_ID`. Tasks 6 and 9 import it.                      |
| I3-10 | MEDIUM   | Summary | Summary table missing `handler.ts` for Task 7.                                                                                                                                                            | Added `websocket/handler.ts` to Task 7 row.                                                                                |
| I3-11 | MEDIUM   | 10      | Coverage map gap "Cross-service propagation" ambiguous — could mean STI instrumentation or HTTP header propagation.                                                                                       | Reworded to "Cross-service trace_id HTTP header propagation (Runtime → SearchAI requests)".                                |
| I3-12 | MEDIUM   | Header  | Plan doesn't note that Phase -1 is an implicit design doc prerequisite, not a defined phase.                                                                                                              | Added note: "Phase -1 is not defined in the STI design doc — it addresses the implicit prerequisite."                      |
| I3-13 | MEDIUM   | 2       | Mock `inferCategory: () => 'runtime'` — need to verify against `EventCategory` type.                                                                                                                      | Verified: `inferCategory` returns `string` (not a strict enum). `'runtime'` is valid. No fix needed.                       |
| I3-14 | MEDIUM   | Header  | SDK EventStore gap should be highlighted as most impactful deferred item.                                                                                                                                 | Added callout in header "What's Missing" section.                                                                          |

### Iteration 4 (3 reviewers: regression/consistency, implementability, edge cases/security)

| ID    | Severity | Task | Finding                                                                                                                                                                   | Fix Applied                                                                                             |
| ----- | -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| I4-1  | CRITICAL | 7    | `responseEnd` options-object refactor breaks 6 callers in `rich-content-execution.test.ts` and 1 in `websocket-events.test.ts`. Plan said "Signatures unchanged" — WRONG. | Added concrete migration instructions for all test callers + production callers with before/after code. |
| I4-2  | HIGH     | 7    | Production callers in handler.ts (1302, 1509, 1747, etc.) need concrete refactored code, not just "refactor to options object".                                           | Added specific replacement code for each handler.ts caller site.                                        |
| I4-3  | HIGH     | 3    | `updateTraceId()` mutable closure creates race if overlapping turns on same session. Turns ARE serialized by execution queue but this invariant is undocumented.          | Added concurrency note documenting the serialization invariant and future-proofing guidance.            |
| I4-4  | HIGH     | 5, 9 | Task 5 modifies `channels/types.ts` but omits it from Files section and commit. Task 9 redundantly re-adds the same type field.                                           | Added `channels/types.ts` to Task 5 Files + commit. Task 9 no longer re-adds the field.                 |
| I4-5  | MEDIUM   | 5    | `payload.traceId` accepted without `VALID_TRACE_ID` validation in inbound worker. BullMQ payloads bypass HTTP header extraction.                                          | Added `VALID_TRACE_ID` import and validation to Task 5 trace generation.                                |
| I4-6  | MEDIUM   | 9    | Task 9 test inlines `VALID_TRACE_ID` regex instead of importing from trace-context module (contradicts I3-9 fix).                                                         | Updated Task 9 test to import `VALID_TRACE_ID` from shared module.                                      |
| I4-7  | MEDIUM   | 7    | Task 7 Files section and commit missing `rich-content-execution.test.ts` and `websocket-events.test.ts`.                                                                  | Added both test files to Files section and commit command.                                              |
| I4-8  | MEDIUM   | 3    | Between Task 3 and Task 7, `turnTraceId` exists but isn't surfaced to clients. Engineer might try to surface early.                                                       | Added note: "Do not modify responseStart/responseEnd calls in this task — that happens in Task 7."      |
| I4-9  | MEDIUM   | 10   | Studio/web-sdk TypeScript types don't include `traceId` on `response_start`/`response_end`. Client surfacing is only half-met.                                            | Added to coverage map as Phase 0a gap.                                                                  |
| I4-10 | MEDIUM   | 10   | ClickHouse bloom filter only supports equality queries on `trace_id`.                                                                                                     | Added query guidance note to coverage map.                                                              |
| I4-11 | LOW      | 1    | Step 4 says "Expected: PASS (3 tests)" but file has 5 `it()` blocks.                                                                                                      | Fixed count to 5.                                                                                       |

### Iteration 5 — Final Review (3 reviewers: regression sweep, completeness, codebase verification)

| ID   | Severity | Task | Finding                                                                                                                              | Fix Applied                                                |
| ---- | -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| I5-1 | HIGH     | 8    | Task 8 test missing `vi.mock('../services/trace-event-types.js')` — trace-emitter imports this module and test would fail on import. | Added mock matching Tasks 2 and 3 pattern.                 |
| I5-2 | LOW      | 7    | websocket-events.test.ts line 471 is `responseStart`, not `responseEnd`. Listed incorrectly in migration table.                      | Fixed: line 471 now noted as responseStart (not affected). |

**All 3 reviewers signed off. Plan is ready for implementation.**
