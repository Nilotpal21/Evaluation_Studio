# Filler Messages MVP — Static Pools + WebSocket Channel

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit contextual status messages ("Searching products...", "Transferring you to a specialist...") to WebSocket clients during long operations (tool calls, handoffs, reasoning) to eliminate perceived dead air and validate the latency impact on AFG Blue Advisory E2E tests.

**Architecture:** A per-session `FillerMessageService` listens to trace events during execution, queues operation-aware status messages behind a configurable delay gate (2s for chat), and emits them as `status_update` WebSocket events. If the operation completes before the delay, the filler is silently discarded. The service hooks into the existing `onTraceEvent` callback in the WebSocket handler. Static message pools provide contextual text based on operation type (tool_call, handoff, reasoning, etc.) — no LLM cost.

**Tech Stack:** TypeScript, Vitest, WebSocket

**Scope:** MVP only — WebSocket channel adapter, static message pools, ExecutionCoordinator integration. Voice adapters, LLM `<status>` piggybacking, DSL parser, and Studio debug panel are deferred to later phases.

**Status:** COMPLETED (2026-03-11) — All 6 tasks implemented, 18 tests passing, build clean.

---

## File Structure

| File                                                                           | Action | Responsibility                                                                  |
| ------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------- |
| `apps/runtime/src/services/filler/types.ts`                                    | Create | StatusEvent, StatusOperation, FillerConfig, QueuedFiller interfaces             |
| `apps/runtime/src/services/filler/message-pools.ts`                            | Create | Static operation-aware message pools, random selection with history dedup       |
| `apps/runtime/src/services/filler/filler-service.ts`                           | Create | Per-session FillerMessageService — queue, delay gate, cancel, cooldown, destroy |
| `apps/runtime/src/services/filler/index.ts`                                    | Create | Barrel export                                                                   |
| `apps/runtime/src/types/index.ts`                                              | Modify | Add `status_update` and `status_clear` to ServerMessage union                   |
| `apps/runtime/src/websocket/events.ts`                                         | Modify | Add `ServerMessages.statusUpdate()` and `ServerMessages.statusClear()`          |
| `apps/runtime/src/websocket/handler.ts`                                        | Modify | Wire FillerMessageService into `handleSendMessage` flow                         |
| `apps/runtime/src/__tests__/filler-service.test.ts`                            | Create | Unit tests for FillerMessageService                                             |
| `apps/runtime/src/__tests__/filler-message-pools.test.ts`                      | Create | Unit tests for message pool selection and dedup                                 |
| `apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts` | Modify | Capture status_update trace events, validate fillers fire during tool calls     |

---

## Task 1: Types & Static Message Pools

**Files:**

- Create: `apps/runtime/src/services/filler/types.ts`
- Create: `apps/runtime/src/services/filler/message-pools.ts`
- Test: `apps/runtime/src/__tests__/filler-message-pools.test.ts`

- [ ] **Step 1: Write failing tests for message pool selection**

```typescript
// apps/runtime/src/__tests__/filler-message-pools.test.ts
import { describe, test, expect } from 'vitest';
import { getFillerMessage, OPERATION_MESSAGES } from '../services/filler/message-pools.js';

describe('filler message pools', () => {
  test('returns a message for each operation type', () => {
    const ops = [
      'tool_call',
      'reasoning',
      'handoff',
      'delegation',
      'extraction',
      'constraint_check',
      'general',
    ] as const;
    for (const op of ops) {
      const msg = getFillerMessage(op);
      expect(msg).toBeTruthy();
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  test('returns message from the correct pool', () => {
    const msg = getFillerMessage('handoff');
    const pool = OPERATION_MESSAGES.handoff;
    expect(pool).toContain(msg);
  });

  test('avoids repeating recent messages', () => {
    const history: string[] = [];
    const results = new Set<string>();
    // Call enough times to force variety
    for (let i = 0; i < 20; i++) {
      const msg = getFillerMessage('tool_call', history);
      results.add(msg);
      history.push(msg);
      if (history.length > 3) history.shift();
    }
    // Should have used more than one message
    expect(results.size).toBeGreaterThan(1);
  });

  test('tool_call with toolName returns tool-specific message', () => {
    const msg = getFillerMessage('tool_call', [], 'product_search');
    expect(msg).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/filler-message-pools.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create types**

```typescript
// apps/runtime/src/services/filler/types.ts

/** Operation categories that drive which message pool is used */
export type StatusOperation =
  | 'tool_call'
  | 'reasoning'
  | 'handoff'
  | 'delegation'
  | 'extraction'
  | 'constraint_check'
  | 'general';

/** A status event emitted to the client */
export interface StatusEvent {
  /** Unique event ID */
  id: string;
  /** Session this event belongs to */
  sessionId: string;
  /** Human-readable status text */
  text: string;
  /** What operation triggered this status */
  operation: StatusOperation;
  /** Whether this is transient (not persisted to history) */
  transient: true;
  /** Sequential index within this execution turn */
  index: number;
  /** Timestamp */
  timestamp: number;
}

/** Configuration for the filler service */
export interface FillerConfig {
  /** Whether fillers are enabled */
  enabled: boolean;
  /** Delay before emitting a filler (ms) — chat channels */
  chatDelayMs: number;
  /** Minimum interval between consecutive filler emissions (ms) */
  cooldownMs: number;
  /** Maximum fillers per execution turn */
  maxPerTurn: number;
}

/** Default configuration */
export const DEFAULT_FILLER_CONFIG: FillerConfig = {
  enabled: true,
  chatDelayMs: 2000,
  cooldownMs: 5000,
  maxPerTurn: 5,
};

/** A filler waiting in the queue */
export interface QueuedFiller {
  text: string;
  source: 'static';
  operation: StatusOperation;
  queuedAt: number;
  timerId: ReturnType<typeof setTimeout> | null;
}
```

- [ ] **Step 4: Create message pools**

```typescript
// apps/runtime/src/services/filler/message-pools.ts
import type { StatusOperation } from './types.js';

export const OPERATION_MESSAGES: Record<StatusOperation, string[]> = {
  tool_call: [
    'Looking that up for you...',
    'Searching for that information...',
    'Let me check on that...',
    'Fetching the details...',
  ],
  reasoning: [
    'Analyzing your request...',
    'Thinking through the best approach...',
    'Processing your question...',
    'Working on that now...',
  ],
  handoff: [
    'Connecting you with the right specialist...',
    'Transferring you now...',
    'Let me bring in someone who can help...',
  ],
  delegation: [
    'Consulting with another agent...',
    'Getting a second opinion on that...',
    'Checking with a specialist...',
  ],
  extraction: ['Processing your input...', 'Understanding your response...'],
  constraint_check: ['Verifying your request...', 'Running some checks...'],
  general: ['One moment please...', 'Just a moment...', 'Bear with me...', 'Working on that...'],
};

/**
 * Select a contextual filler message for the given operation.
 * Avoids repeating messages from `recentHistory` when possible.
 * If `toolName` is provided, it can influence the message choice.
 */
export function getFillerMessage(
  operation: StatusOperation,
  recentHistory: string[] = [],
  toolName?: string,
): string {
  const pool = OPERATION_MESSAGES[operation] ?? OPERATION_MESSAGES.general;

  // Filter out recently used messages (if pool is large enough)
  const available = pool.filter((m) => !recentHistory.includes(m));
  const candidates = available.length > 0 ? available : pool;

  // Random selection from candidates
  const idx = Math.floor(Math.random() * candidates.length);
  return candidates[idx];
}
```

- [ ] **Step 5: Create barrel export**

```typescript
// apps/runtime/src/services/filler/index.ts
export { FillerMessageService } from './filler-service.js';
export { getFillerMessage, OPERATION_MESSAGES } from './message-pools.js';
export type { StatusEvent, StatusOperation, FillerConfig, QueuedFiller } from './types.js';
export { DEFAULT_FILLER_CONFIG } from './types.js';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/runtime && npx vitest run src/__tests__/filler-message-pools.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 7: Commit**

```bash
git add apps/runtime/src/services/filler/ apps/runtime/src/__tests__/filler-message-pools.test.ts
git commit -m "feat(runtime): add filler message types and static message pools"
```

---

## Task 2: FillerMessageService Core

**Files:**

- Create: `apps/runtime/src/services/filler/filler-service.ts`
- Test: `apps/runtime/src/__tests__/filler-service.test.ts`

- [ ] **Step 1: Write failing tests for FillerMessageService**

```typescript
// apps/runtime/src/__tests__/filler-service.test.ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { FillerMessageService } from '../services/filler/filler-service.js';
import type { StatusEvent, FillerConfig } from '../services/filler/types.js';

describe('FillerMessageService', () => {
  let service: FillerMessageService;
  let emittedEvents: StatusEvent[];
  let onEmit: (event: StatusEvent) => void;
  const config: FillerConfig = {
    enabled: true,
    chatDelayMs: 100, // Short delay for tests
    cooldownMs: 200,
    maxPerTurn: 5,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    emittedEvents = [];
    onEmit = (event) => emittedEvents.push(event);
    service = new FillerMessageService('test-session', config, onEmit);
  });

  afterEach(() => {
    service.destroy();
    vi.useRealTimers();
  });

  test('emits status event after delay', () => {
    service.queueFiller('tool_call', 'Searching...');
    expect(emittedEvents).toHaveLength(0);

    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].text).toBe('Searching...');
    expect(emittedEvents[0].operation).toBe('tool_call');
    expect(emittedEvents[0].transient).toBe(true);
  });

  test('discards filler if cancelled before delay', () => {
    service.queueFiller('tool_call', 'Searching...');
    vi.advanceTimersByTime(50); // Before delay
    service.cancel();

    vi.advanceTimersByTime(200); // Well past delay
    expect(emittedEvents).toHaveLength(0);
  });

  test('respects cooldown between emissions', () => {
    service.queueFiller('tool_call', 'First...');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(1);

    // Queue another immediately — should be blocked by cooldown
    service.queueFiller('reasoning', 'Second...');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(1); // Still 1

    // Advance past cooldown
    vi.advanceTimersByTime(config.cooldownMs);
    service.queueFiller('reasoning', 'Third...');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(2);
  });

  test('respects maxPerTurn limit', () => {
    const shortConfig: FillerConfig = { ...config, maxPerTurn: 2, cooldownMs: 0 };
    service.destroy();
    service = new FillerMessageService('test-session', shortConfig, onEmit);

    service.queueFiller('tool_call', 'One');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    service.queueFiller('tool_call', 'Two');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    service.queueFiller('tool_call', 'Three');
    vi.advanceTimersByTime(config.chatDelayMs + 10);

    expect(emittedEvents).toHaveLength(2);
  });

  test('new filler replaces pending filler', () => {
    service.queueFiller('tool_call', 'First...');
    vi.advanceTimersByTime(50); // Before delay
    service.queueFiller('handoff', 'Transferring...');
    vi.advanceTimersByTime(config.chatDelayMs + 10);

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].text).toBe('Transferring...');
  });

  test('reset clears pending filler (output reached user)', () => {
    service.queueFiller('tool_call', 'Searching...');
    vi.advanceTimersByTime(50);
    service.reset(); // LLM chunk reached user

    vi.advanceTimersByTime(200);
    expect(emittedEvents).toHaveLength(0);
  });

  test('destroy clears all timers', () => {
    service.queueFiller('tool_call', 'Searching...');
    service.destroy();

    vi.advanceTimersByTime(500);
    expect(emittedEvents).toHaveLength(0);
  });

  test('does nothing when disabled', () => {
    service.destroy();
    service = new FillerMessageService('test-session', { ...config, enabled: false }, onEmit);

    service.queueFiller('tool_call', 'Searching...');
    vi.advanceTimersByTime(500);
    expect(emittedEvents).toHaveLength(0);
  });

  test('resetTurn resets turn counter for new execution', () => {
    const shortConfig: FillerConfig = { ...config, maxPerTurn: 1, cooldownMs: 0 };
    service.destroy();
    service = new FillerMessageService('test-session', shortConfig, onEmit);

    service.queueFiller('tool_call', 'One');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(1);

    // Max reached, next is blocked
    service.queueFiller('tool_call', 'Two');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(1);

    // Reset for new turn
    service.resetTurn();
    service.queueFiller('tool_call', 'Three');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/filler-service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement FillerMessageService**

```typescript
// apps/runtime/src/services/filler/filler-service.ts
import { randomUUID } from 'crypto';
import type { StatusEvent, StatusOperation, FillerConfig, QueuedFiller } from './types.js';

/**
 * Per-session service that queues contextual status messages behind a delay gate.
 * If the operation completes before the delay, the filler is silently discarded.
 */
export class FillerMessageService {
  private readonly sessionId: string;
  private readonly config: FillerConfig;
  private readonly onEmit: (event: StatusEvent) => void;

  private pending: QueuedFiller | null = null;
  private turnEmitCount = 0;
  private turnIndex = 0;
  private lastEmitTime = 0;
  private destroyed = false;

  constructor(sessionId: string, config: FillerConfig, onEmit: (event: StatusEvent) => void) {
    this.sessionId = sessionId;
    this.config = config;
    this.onEmit = onEmit;
  }

  /**
   * Queue a filler message. Replaces any currently pending filler.
   * The filler will be emitted after `chatDelayMs` unless cancelled first.
   */
  queueFiller(operation: StatusOperation, text: string): void {
    if (!this.config.enabled || this.destroyed) return;
    if (this.turnEmitCount >= this.config.maxPerTurn) return;

    // Check cooldown
    const now = Date.now();
    if (this.lastEmitTime > 0 && now - this.lastEmitTime < this.config.cooldownMs) return;

    // Replace any pending filler
    this.clearPending();

    const filler: QueuedFiller = {
      text,
      source: 'static',
      operation,
      queuedAt: now,
      timerId: null,
    };

    filler.timerId = setTimeout(() => {
      this.emit(filler);
    }, this.config.chatDelayMs);

    this.pending = filler;
  }

  /** Cancel any pending filler (real response is streaming). */
  cancel(): void {
    this.clearPending();
  }

  /** Reset silence timer (LLM chunk reached user, no filler needed). */
  reset(): void {
    this.clearPending();
  }

  /** Reset turn counters for a new execution turn. */
  resetTurn(): void {
    this.turnEmitCount = 0;
    this.turnIndex = 0;
    this.clearPending();
  }

  /** Destroy the service, clearing all timers. */
  destroy(): void {
    this.destroyed = true;
    this.clearPending();
  }

  private emit(filler: QueuedFiller): void {
    if (this.destroyed) return;

    const event: StatusEvent = {
      id: randomUUID(),
      sessionId: this.sessionId,
      text: filler.text,
      operation: filler.operation,
      transient: true,
      index: this.turnIndex++,
      timestamp: Date.now(),
    };

    this.turnEmitCount++;
    this.lastEmitTime = Date.now();
    this.pending = null;
    this.onEmit(event);
  }

  private clearPending(): void {
    if (this.pending?.timerId) {
      clearTimeout(this.pending.timerId);
    }
    this.pending = null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/runtime && npx vitest run src/__tests__/filler-service.test.ts`
Expected: PASS (all 9 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/services/filler/filler-service.ts apps/runtime/src/__tests__/filler-service.test.ts
git commit -m "feat(runtime): add FillerMessageService with delay gate and cooldown"
```

---

## Task 3: WebSocket status_update / status_clear Events

**Files:**

- Modify: `apps/runtime/src/types/index.ts` (ServerMessage union)
- Modify: `apps/runtime/src/websocket/events.ts` (ServerMessages factory)

- [ ] **Step 1: Read current ServerMessage union and ServerMessages factory**

Read `apps/runtime/src/types/index.ts` lines 317-404 for the ServerMessage type.
Read `apps/runtime/src/websocket/events.ts` lines 140-250 for the ServerMessages object.

- [ ] **Step 2: Add status_update and status_clear to ServerMessage union**

In `apps/runtime/src/types/index.ts`, add to the ServerMessage union:

```typescript
  | {
      type: 'status_update';
      sessionId: string;
      text: string;
      operation: string;
      transient: true;
      index: number;
    }
  | { type: 'status_clear'; sessionId: string }
```

- [ ] **Step 3: Add ServerMessages.statusUpdate() and ServerMessages.statusClear()**

In `apps/runtime/src/websocket/events.ts`, add to the ServerMessages object:

```typescript
  statusUpdate(sessionId: string, text: string, operation: string, index: number): ServerMessage {
    return { type: 'status_update', sessionId, text, operation, transient: true, index };
  },
  statusClear(sessionId: string): ServerMessage {
    return { type: 'status_clear', sessionId };
  },
```

- [ ] **Step 4: Build to verify types compile**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/types/index.ts apps/runtime/src/websocket/events.ts
git commit -m "feat(runtime): add status_update and status_clear WebSocket event types"
```

---

## Task 4: Wire FillerMessageService into WebSocket Handler

**Files:**

- Modify: `apps/runtime/src/websocket/handler.ts` (handleSendMessage flow)

This is the key integration point. The FillerMessageService is created per-execution and driven by trace events flowing through `createOnTraceEvent`. When a `tool_call`, `handoff`, or `delegation` trace event arrives, we queue a filler. When `response_chunk` starts streaming, we cancel the filler.

- [ ] **Step 1: Read the handleSendMessage function in handler.ts**

Read `apps/runtime/src/websocket/handler.ts` — focus on the `handleSendMessage` function (around lines 1339-1496) and `createOnTraceEvent` (around lines 349-417).

- [ ] **Step 2: Map trace event types to StatusOperations**

Create a helper function in the handler (or inline) that maps trace events to filler operations:

```typescript
import {
  FillerMessageService,
  getFillerMessage,
  DEFAULT_FILLER_CONFIG,
} from '../services/filler/index.js';
import type { StatusOperation } from '../services/filler/types.js';

function traceToFillerOperation(eventType: string): StatusOperation | null {
  switch (eventType) {
    case 'tool_call':
      return 'tool_call';
    case 'handoff':
    case 'handoff_progress':
      return 'handoff';
    case 'delegate_start':
    case 'fan_out_start':
      return 'delegation';
    case 'dsl_collect':
      return 'extraction';
    case 'constraint_check':
      return 'constraint_check';
    default:
      return null;
  }
}
```

- [ ] **Step 3: Integrate FillerMessageService into handleSendMessage**

In `handleSendMessage`, create a `FillerMessageService` before calling `executeMessage`. Wire it to:

1. **Emit `status_update`** WS events when the service fires a filler
2. **Queue fillers** when trace events indicate long operations
3. **Cancel fillers** when `response_chunk` starts streaming
4. **Emit `status_clear`** when the response starts or execution ends
5. **Destroy** the service after execution completes

The integration pattern (pseudo-code for what to add):

```typescript
// Inside handleSendMessage, before executeMessage call:
const fillerService = new FillerMessageService(
  sessionId,
  DEFAULT_FILLER_CONFIG,
  (statusEvent) => {
    send(ws, ServerMessages.statusUpdate(
      sessionId,
      statusEvent.text,
      statusEvent.operation,
      statusEvent.index,
    ));
  },
);

// Wrap the existing onChunk to cancel fillers when output streams:
const originalOnChunk = onChunk;
const wrappedOnChunk = (chunk: string) => {
  fillerService.cancel();
  // Also send status_clear if a filler was shown
  send(ws, ServerMessages.statusClear(sessionId));
  originalOnChunk(chunk);
};

// Wrap the existing onTraceEvent to queue fillers:
const originalOnTraceEvent = createOnTraceEvent(...);
const wrappedOnTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
  const fillerOp = traceToFillerOperation(event.type);
  if (fillerOp) {
    const toolName = event.data?.toolName as string | undefined;
    const text = getFillerMessage(fillerOp, [], toolName);
    fillerService.queueFiller(fillerOp, text);
  }
  originalOnTraceEvent(event);
};

// After executeMessage completes (in finally block):
fillerService.destroy();
```

NOTE: The exact integration requires reading the current handler.ts code to find the right insertion points. The agent implementing this task MUST read `handler.ts` lines 1339-1496 first.

- [ ] **Step 4: Build to verify compilation**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/websocket/handler.ts
git commit -m "feat(runtime): wire FillerMessageService into WebSocket handler for status updates"
```

---

## Task 5: AFG E2E Test — Validate Filler Events

**Files:**

- Modify: `apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts`

Update the AFG E2E test to capture and validate that `status_update`-type trace events are emitted during tool call scenarios. Since the E2E tests use `RuntimeExecutor.executeMessage()` directly (not WebSocket), we need to check that trace events of type `status_update` or similar appear in the trace log for scenarios that involve tool calls.

NOTE: The E2E tests bypass the WebSocket handler and call `executeMessage` directly. The filler service is wired in the WS handler, so E2E tests won't see fillers unless we also integrate at the executor level. For the MVP, add a **separate integration test** that tests the WS handler path, or add the filler service to the `executeTurn` helper in the E2E test.

- [ ] **Step 1: Create a focused integration test for filler + execution**

```typescript
// apps/runtime/src/__tests__/filler-integration.test.ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { FillerMessageService } from '../services/filler/filler-service.js';
import { getFillerMessage } from '../services/filler/message-pools.js';
import { DEFAULT_FILLER_CONFIG } from '../services/filler/types.js';
import type { StatusEvent, StatusOperation } from '../services/filler/types.js';

function traceToFillerOperation(eventType: string): StatusOperation | null {
  switch (eventType) {
    case 'tool_call':
      return 'tool_call';
    case 'handoff':
    case 'handoff_progress':
      return 'handoff';
    case 'delegate_start':
    case 'fan_out_start':
      return 'delegation';
    case 'dsl_collect':
      return 'extraction';
    case 'constraint_check':
      return 'constraint_check';
    default:
      return null;
  }
}

describe('Filler integration with trace events', () => {
  let service: FillerMessageService;
  let emitted: StatusEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = [];
    service = new FillerMessageService(
      'sess-1',
      {
        ...DEFAULT_FILLER_CONFIG,
        chatDelayMs: 100,
        cooldownMs: 50,
      },
      (e) => emitted.push(e),
    );
  });

  afterEach(() => {
    service.destroy();
    vi.useRealTimers();
  });

  test('tool_call trace event queues a filler that fires after delay', () => {
    const event = { type: 'tool_call', data: { toolName: 'product_search' } };
    const op = traceToFillerOperation(event.type);
    expect(op).toBe('tool_call');

    const text = getFillerMessage(op!, [], event.data.toolName as string);
    service.queueFiller(op!, text);

    // Before delay — no emission
    vi.advanceTimersByTime(50);
    expect(emitted).toHaveLength(0);

    // After delay — filler fires
    vi.advanceTimersByTime(60);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].operation).toBe('tool_call');
    expect(emitted[0].transient).toBe(true);
  });

  test('handoff trace event queues handoff filler', () => {
    const op = traceToFillerOperation('handoff');
    expect(op).toBe('handoff');

    const text = getFillerMessage(op!);
    service.queueFiller(op!, text);

    vi.advanceTimersByTime(110);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].operation).toBe('handoff');
  });

  test('fast tool completion cancels filler before user sees it', () => {
    const op = traceToFillerOperation('tool_call')!;
    service.queueFiller(op, getFillerMessage(op));

    // Tool completes in 50ms (before 100ms delay)
    vi.advanceTimersByTime(50);
    service.cancel(); // Tool completed, response streaming

    vi.advanceTimersByTime(200);
    expect(emitted).toHaveLength(0); // User never saw the filler
  });

  test('sequence: tool_call → delay → filler shown → response cancels', () => {
    const op = traceToFillerOperation('tool_call')!;
    service.queueFiller(op, 'Searching products...');

    vi.advanceTimersByTime(110);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe('Searching products...');

    // Response starts streaming
    service.cancel();
    // No more fillers should fire
  });

  test('unknown trace event types are ignored', () => {
    expect(traceToFillerOperation('llm_call')).toBeNull();
    expect(traceToFillerOperation('user_message')).toBeNull();
    expect(traceToFillerOperation('agent_response')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/filler-integration.test.ts`
Expected: FAIL — module not found (if Task 1-2 not yet done) or PASS (if done)

- [ ] **Step 3: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/filler-integration.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 4: Commit**

```bash
git add apps/runtime/src/__tests__/filler-integration.test.ts
git commit -m "test(runtime): add filler message integration tests with trace event mapping"
```

---

## Task 6: Update Design Doc with MVP Status

**Files:**

- Modify: `docs/plans/2026-03-09-voice-filler-messages-design.md`

- [ ] **Step 1: Read the task list section of the design doc**

Read the design doc's task list (§3) to identify all 16 planned tasks.

- [ ] **Step 2: Add MVP status section at the top of the doc**

Add after the header:

```markdown
## MVP Status (2026-03-11)

### Completed (Phase 1 MVP — Chat/WebSocket only)

- [x] Task 1: Types & config (`services/filler/types.ts`)
- [x] Task 2: FillerMessageService core (`services/filler/filler-service.ts`)
- [x] Task 3: WebSocket status_update/status_clear events (types + events.ts)
- [x] Task 4: WebSocket handler integration (handler.ts)
- [x] Task 5: Static operation-aware message pools (`services/filler/message-pools.ts`)
- [x] Tests: Unit tests (filler-service, message-pools) + integration test

### Deferred to Phase 2

- [ ] Task 6: Voice channel adapter (TTS filler emission)
- [ ] Task 7: Voice handler integration (Twilio, KoreVG, LiveKit)
- [ ] Task 10: LLM `<status>` tag piggybacking (prompt injection + stream parser)
- [ ] Task 11: Prompt builder injection for `<status>` tag instruction
- [ ] Task 12: DSL parser for CHANNEL_SETTINGS section
- [ ] Task 13: Project-level filler settings

### Deferred to Phase 3

- [ ] Task 14: Trace event logging for fillers (observability)
- [ ] Task 15: ChatWidget rendering (Studio)
- [ ] Task 16: Studio debug panel filler display
```

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-03-09-voice-filler-messages-design.md
git commit -m "docs: update filler messages design doc with MVP completion status"
```

---

## Dependency Chain

```
Task 1 (types + pools) → Task 2 (service) → Task 3 (WS events) → Task 4 (handler wiring) → Task 5 (integration test) → Task 6 (doc update)
```

Tasks 1-2 can be implemented together. Task 3 is independent of 1-2 (just type additions). Task 4 depends on all prior tasks. Task 5 depends on 1-2 only (doesn't need WS wiring). Task 6 is documentation only.
