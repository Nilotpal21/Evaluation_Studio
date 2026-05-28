# Phase 3 Implementation Plan: Thoughts & Reasoning Visibility

> **Spec:** `docs/plans/2026-03-12-agent-capabilities-gaps-design.md`
> **Status:** Draft (post-audit revision)
> **Last updated:** 2026-03-13

---

## Overview

Surface LLM reasoning (thoughts) to the Observatory trace panel and optionally to the chat UI. This involves:

1. Emitting `tool_thought` trace events from two locations in the ReasoningExecutor
2. Adding `tool_thought` to the TraceEventType union (already done)
3. Wiring the trace event to the Observatory panel
4. Wrapping tool execution with timing/trace envelope
5. Tracking active tool calls with bounded Map
6. Summarizing scripted flow steps as thought-like events
7. Surfacing thoughts in the chat UI (ThoughtItem)
8. Adding the `ALWAYS_EMIT_REASON_AS_THOUGHT` feature flag
9. Wiring voice executor thought callback
10. Adding `voice_thought` WebSocket message type
11. Adding SDK handler for `voice_thought`
12. Adding verbal filler for voice thought delivery
13. Adding thought-to-speech TTS bridge

---

## Dependency Graph

```
Task 1 (emit tool_thought) ─────┐
Task 3 (TraceEventType)  ────── ├──> Task 4 (tool execution trace envelope)
                                │           │
Task 2 (Observatory panel) <────┘           v
                                     Task 5 (activeToolCalls bounded Map)
                                            │
Task 6 (flow step summary) ────────────────>│
                                            v
Task 7 (chat UI ThoughtItem) <──── Task 4
Task 8 (feature flag) ─────────────────────>│
                                            v
Task 9 (voice callback wiring) ────> Task 10 (voice_thought WS message)
                                     Task 11 (SDK handler)
                                     Task 12 (verbal filler)
                                     Task 13 (thought-to-speech TTS)
```

**Hard prerequisites:**

- Task 3 MUST land before Task 4 (Task 4 references `tool_thought` as a TraceEventType — without Task 3, it would require an unsafe `as TraceEventType` cast)
- Task 1 MUST land before Task 2 (Observatory needs events to display)

---

## Task 1: Emit `tool_thought` from ReasoningExecutor (2 locations)

### Location 1: Action tool thought (~line 1784)

**File:** `apps/runtime/src/services/execution/reasoning-executor.ts`

The code at line ~1784 already emits `tool_thought` when `thought` is truthy:

```typescript
// BEFORE (current code — line ~1784):
if (reason || thought) {
  onTraceEvent?.({
    type: 'decision',
    data: {
      action: toolCall.name,
      reasoning: reason,
      thought,
    },
  });
  if (thought) {
    onTraceEvent?.({
      type: 'tool_thought',
      data: {
        toolName: toolCall.name,
        thought,
        reasoning: reason,
        agent: session.agentName,
      },
    });
  }
}
```

**Change:** Also emit when `reason` is present but `thought` is not (controlled by feature flag — see Task 8). The feature flag `ALWAYS_EMIT_REASON_AS_THOUGHT` causes `reason` to be surfaced as a thought when no explicit thought is provided.

```typescript
// AFTER:
if (reason || thought) {
  onTraceEvent?.({
    type: 'decision',
    data: {
      action: toolCall.name,
      reasoning: reason,
      thought,
    },
  });
  const shouldEmitThought = thought || (reason && config.alwaysEmitReasonAsThought);
  if (shouldEmitThought) {
    onTraceEvent?.({
      type: 'tool_thought',
      data: {
        toolName: toolCall.name,
        thought: thought || reason,
        reasoning: reason,
        agent: session.agentName,
      },
    });
  }
}
```

### Location 2: Regular tool thought (~line 2229)

**File:** `apps/runtime/src/services/execution/reasoning-executor.ts`

Note: At this location the destructured variable is `userToolThought` (not `thought`).

```typescript
// BEFORE (current code — line ~2229):
const { thought: userToolThought, reason: userToolReason, ...cleanInput } = toolCall.input;
if (userToolThought) {
  onTraceEvent?.({
    type: 'tool_thought',
    data: {
      toolName: toolCall.name,
      thought: userToolThought,
      reasoning: userToolReason,
      agent: session.agentName,
    },
  });
}
```

**Change:** Same feature-flag logic:

```typescript
// AFTER:
const { thought: userToolThought, reason: userToolReason, ...cleanInput } = toolCall.input;
const shouldEmitThought = userToolThought || (userToolReason && config.alwaysEmitReasonAsThought);
if (shouldEmitThought) {
  onTraceEvent?.({
    type: 'tool_thought',
    data: {
      toolName: toolCall.name,
      thought: userToolThought || userToolReason,
      reasoning: userToolReason,
      agent: session.agentName,
    },
  });
}
```

### Test: `apps/runtime/src/__tests__/tool-thought-emission.test.ts`

```typescript
import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock structured logger before any imports that use it
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock metrics
vi.mock('../../observability/metrics.js', () => ({
  recordToolCall: vi.fn(),
  recordLlmCall: vi.fn(),
}));

// Mock memory integration
vi.mock('../services/execution/memory-integration.js', () => ({
  evaluateRememberAfterStateChange: vi.fn().mockResolvedValue(undefined),
  executeRecallAfterToolCall: vi.fn().mockResolvedValue(undefined),
  executeRecallAfterExtraction: vi.fn().mockResolvedValue(undefined),
  detectAndStorePreferences: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/execution/prompt-builder.js', () => ({
  isVoiceChannel: () => false,
  buildSystemPrompt: vi.fn().mockReturnValue('system prompt'),
}));

vi.mock('../services/execution/constraint-checker.js', () => ({
  checkConstraints: vi.fn().mockReturnValue(null),
  handleConstraintViolation: vi.fn(),
}));

vi.mock('../services/channel/channel-adapter.js', () => ({
  stripForVoice: (s: string) => s,
}));

vi.mock('../services/execution/error-handler-router.js', () => ({
  resolveErrorHandler: () => null,
  executeWithRetry: vi.fn(),
}));

// Import the production code under test AFTER vi.mock declarations
import { ReasoningExecutor } from '../services/execution/reasoning-executor.js';

describe('ReasoningExecutor — tool_thought emission', () => {
  let onTraceEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onTraceEvent = vi.fn();
  });

  test('emits tool_thought when thought is present on action tool call', async () => {
    // Setup: create a minimal session + executor that will process a tool call
    // with thought field, then verify onTraceEvent was called with type: 'tool_thought'
    const events = onTraceEvent.mock.calls
      .map((c) => c[0])
      .filter((e: { type: string }) => e.type === 'tool_thought');
    // Actual assertion depends on wiring — this is the pattern
    expect(onTraceEvent).toBeDefined();
  });

  test('emits tool_thought for userToolThought on regular tool call', async () => {
    // Setup: session.toolExecutor exists, tool call input has { thought: '...' }
    // Verify onTraceEvent called with type: 'tool_thought', data.thought matching
    expect(onTraceEvent).toBeDefined();
  });

  test('does NOT emit tool_thought when neither thought nor reason is present', async () => {
    // Setup: tool call input has no thought/reason fields
    // Verify onTraceEvent NOT called with type: 'tool_thought'
    expect(onTraceEvent).not.toHaveBeenCalled();
  });

  test('emits tool_thought for reason-only when ALWAYS_EMIT_REASON_AS_THOUGHT is enabled', async () => {
    // Setup: config.alwaysEmitReasonAsThought = true, tool call has reason but no thought
    // Verify onTraceEvent called with type: 'tool_thought', data.thought === reason
    expect(onTraceEvent).toBeDefined();
  });
});
```

> **NOTE:** The test scaffolding above shows the mock pattern and assertion shape. The actual `ReasoningExecutor` instantiation requires a `RuntimeSession`, `AgentIR`, and `onTraceEvent` callback. The implementer must wire these using the same session-builder pattern found in existing tests like `apps/runtime/src/__tests__/post-tool-mapping.test.ts`. Each test MUST call actual production code (the executor), not just test boolean coercion.

---

## Task 2: Observatory Panel — display tool_thought events

**File:** `apps/studio/src/components/observatory/DebugTabs.tsx` (trace display component; see also `SpanTree.tsx` for span-level rendering)

Add a renderer for `tool_thought` events that shows:

- Tool name
- Thought text (collapsible if long)
- Agent name
- Reasoning (secondary, dimmed)

No new types needed — `TraceEventWithId` already carries `data: Record<string, unknown>`.

### Security note

When displaying `parentLlmCallSpanId` links (for trace correlation), the Observatory must enforce tenant + project scoping on any linked trace lookups. A `parentLlmCallSpanId` from one tenant must never resolve traces belonging to another tenant. Use the existing `findOne({ _id, tenantId, projectId })` pattern (never `findById`).

---

## Task 3: Add `tool_thought` to TraceEventType (ALREADY DONE)

**File:** `apps/runtime/src/types/index.ts`

`tool_thought` already exists in the `TraceEventType` union at line 95. No action needed.

This task is listed as a hard prerequisite for Task 4 because Task 4 emits events with `type: 'tool_thought'`. Without this union member, the only way to compile would be an unsafe `as TraceEventType` cast, which we must avoid.

---

## Task 4: Tool Execution Trace Envelope

Wrap every tool execution (both action-tool and regular-tool paths) with a timing + trace envelope that:

1. Records `startTime` before execution
2. Computes `durationMs` after execution (including error paths)
3. Emits a `tool_call` trace event with `durationMs`, `toolName`, `success`, and `error` if applicable
4. Re-throws errors after recording (never swallows)

### Test: `apps/runtime/src/__tests__/tool-execution-envelope.test.ts`

```typescript
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../observability/metrics.js', () => ({
  recordToolCall: vi.fn(),
  recordLlmCall: vi.fn(),
}));

vi.mock('../services/execution/memory-integration.js', () => ({
  evaluateRememberAfterStateChange: vi.fn().mockResolvedValue(undefined),
  executeRecallAfterToolCall: vi.fn().mockResolvedValue(undefined),
  executeRecallAfterExtraction: vi.fn().mockResolvedValue(undefined),
  detectAndStorePreferences: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/execution/prompt-builder.js', () => ({
  isVoiceChannel: () => false,
  buildSystemPrompt: vi.fn().mockReturnValue('system prompt'),
}));

vi.mock('../services/execution/constraint-checker.js', () => ({
  checkConstraints: vi.fn().mockReturnValue(null),
  handleConstraintViolation: vi.fn(),
}));

vi.mock('../services/channel/channel-adapter.js', () => ({
  stripForVoice: (s: string) => s,
}));

vi.mock('../services/execution/error-handler-router.js', () => ({
  resolveErrorHandler: () => null,
  executeWithRetry: vi.fn(),
}));

// Import production code AFTER mocks
import { ReasoningExecutor } from '../services/execution/reasoning-executor.js';

describe('Tool execution trace envelope', () => {
  let onTraceEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onTraceEvent = vi.fn();
  });

  test('emits tool_call event with durationMs on successful execution', async () => {
    // Wire ReasoningExecutor with a mock toolExecutor that resolves
    // Execute a tool call, then check onTraceEvent for tool_call with durationMs >= 0
    const toolCallEvents = onTraceEvent.mock.calls
      .map((c) => c[0])
      .filter((e: { type: string }) => e.type === 'tool_call');
    // Assert: toolCallEvents[0].data.durationMs >= 0
    // Assert: toolCallEvents[0].data.success === true
    expect(onTraceEvent).toBeDefined();
  });

  test('emits tool_call event with error info and still re-throws on failure', async () => {
    // Wire ReasoningExecutor with a mock toolExecutor that rejects
    // Execute and expect the error to propagate
    // Check onTraceEvent for tool_call with success: false, error message present
    // Assert: durationMs >= 0 even on error
    expect(onTraceEvent).toBeDefined();
  });

  test('onTraceEvent throwing does not break tool execution', async () => {
    // Wire onTraceEvent to throw on first call
    // Execute a tool call — should complete without the trace error propagating
    onTraceEvent.mockImplementationOnce(() => {
      throw new Error('trace handler exploded');
    });
    // Execute tool — should not throw the trace error
    expect(onTraceEvent).toBeDefined();
  });
});
```

---

## Task 5: Bounded `activeToolCalls` Map

**CLAUDE.md invariant:** "Every in-memory Map needs max size, TTL, and eviction."

The `activeToolCalls` Map tracks in-flight tool executions for cancellation support. It MUST be bounded.

### Implementation

```typescript
const ACTIVE_TOOL_CALLS_MAX_SIZE = 50;
const ACTIVE_TOOL_CALLS_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface ActiveToolCall {
  toolName: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const activeToolCalls = new Map<string, ActiveToolCall>();

function trackToolCall(callId: string, toolName: string): void {
  // Evict oldest if at capacity
  if (activeToolCalls.size >= ACTIVE_TOOL_CALLS_MAX_SIZE) {
    const oldestKey = activeToolCalls.keys().next().value;
    if (oldestKey) {
      clearTimeout(activeToolCalls.get(oldestKey)!.timer);
      activeToolCalls.delete(oldestKey);
      log.warn('activeToolCalls at capacity, evicted oldest entry', {
        evictedCallId: oldestKey,
        toolName,
      });
    }
  }

  const timer = setTimeout(() => {
    activeToolCalls.delete(callId);
    log.warn('activeToolCall expired via TTL', { callId, toolName });
  }, ACTIVE_TOOL_CALLS_TTL_MS);

  activeToolCalls.set(callId, { toolName, startedAt: Date.now(), timer });
}

function untrackToolCall(callId: string): void {
  const entry = activeToolCalls.get(callId);
  if (entry) {
    clearTimeout(entry.timer);
    activeToolCalls.delete(callId);
  }
}
```

### Test: `apps/runtime/src/__tests__/active-tool-calls-bounds.test.ts`

```typescript
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import production module that exports trackToolCall / untrackToolCall
// import { trackToolCall, untrackToolCall, activeToolCalls } from '../services/execution/reasoning-executor.js';

describe('activeToolCalls bounded Map', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('evicts oldest entry when Map reaches max size (50)', () => {
    // Add 50 entries, then add 51st
    // Assert: size is still 50, first entry was evicted
    expect(true).toBe(true); // placeholder — wire to production code
  });

  test('auto-evicts entry after TTL (5 minutes)', () => {
    // Add entry, advance timers by 5 minutes
    // Assert: entry no longer in Map
    expect(true).toBe(true); // placeholder — wire to production code
  });

  test('untrackToolCall clears timer and removes entry', () => {
    // Add entry, immediately untrack
    // Assert: entry removed, no timer fires
    expect(true).toBe(true); // placeholder — wire to production code
  });
});
```

> **NOTE:** These are scaffolds. The implementer must export `trackToolCall`, `untrackToolCall`, and the Map (or a `size` getter) from the reasoning-executor module, then wire real assertions.

---

## Task 6: Scripted Flow Step Summaries as Thought Events

**File:** `apps/runtime/src/services/execution/flow-step-executor.ts`

When a scripted flow step completes, emit a `tool_thought`-style event summarizing what the step did. This gives Observatory visibility into scripted flows.

### `buildStepSummary` function

Generates a human-readable summary from the FlowStep definition. The `FlowStep` type is defined in `packages/core/src/types/agent-based.ts` (NOT in the compiler). Verified property paths:

| Step property  | FlowStep field   | Summary template                    |
| -------------- | ---------------- | ----------------------------------- |
| GATHER step    | `step.gather`    | "Collecting: {field names}"         |
| CALL step      | `step.call`      | "Calling tool: {step.call}"         |
| SET step       | `step.set`       | "Setting: {variable names}"         |
| RESPOND step   | `step.respond`   | "Responding to user"                |
| CHECK step     | `step.check`     | "Running constraint check: {phase}" |
| TRANSFORM step | `step.transform` | "Transforming data"                 |
| CLEAR step     | `step.clear`     | "Clearing: {variable names}"        |

**FlowStep field reference (from `packages/core/src/types/agent-based.ts` line 240):**

- `step.gather` — `FlowGatherConfig` object (has `.fields` array of `FlowGatherField`)
- `step.call` — `string` (tool name)
- `step.set` — `SetAssignment[]` (each has `.variable` and `.expression`)
- `step.respond` — `string` (response template)
- `step.check` — `string` (inline boolean guard expression)
- `step.transform` — `TransformConfig` object
- `step.clear` — `string[]` (variable paths)

### Test: `apps/runtime/src/__tests__/flow-step-summary.test.ts`

```typescript
import { describe, test, expect } from 'vitest';

// Import the buildStepSummary function from flow-step-executor
// import { buildStepSummary } from '../services/execution/flow-step-executor.js';

// Placeholder — replace with actual import after implementation
function buildStepSummary(step: Record<string, unknown>): string {
  // This will be replaced by the real import
  throw new Error('Wire to production code');
}

describe('buildStepSummary', () => {
  test('GATHER step lists field names', () => {
    const step = {
      name: 'collect_info',
      gather: {
        fields: [
          { name: 'email', type: 'string' },
          { name: 'phone', type: 'string' },
        ],
      },
    };
    const summary = buildStepSummary(step);
    expect(summary).toContain('email');
    expect(summary).toContain('phone');
  });

  test('CALL step shows tool name', () => {
    const step = { name: 'lookup', call: 'search_database' };
    const summary = buildStepSummary(step);
    expect(summary).toContain('search_database');
  });

  test('SET step shows variable names', () => {
    const step = {
      name: 'compute',
      set: [
        { variable: 'total', expression: 'a + b' },
        { variable: 'status', expression: '"done"' },
      ],
    };
    const summary = buildStepSummary(step);
    expect(summary).toContain('total');
    expect(summary).toContain('status');
  });

  test('RESPOND step returns generic summary', () => {
    const step = { name: 'greet', respond: 'Hello {{name}}!' };
    const summary = buildStepSummary(step);
    expect(summary).toContain('Responding');
  });

  test('CHECK step shows inline guard', () => {
    const step = { name: 'validate', check: 'user.authenticated == true' };
    const summary = buildStepSummary(step);
    expect(summary).toContain('user.authenticated == true');
  });

  test('TRANSFORM step returns generic summary', () => {
    const step = { name: 'filter', transform: { pipeline: [] } };
    const summary = buildStepSummary(step);
    expect(summary).toContain('Transforming');
  });

  test('CLEAR step lists variable names', () => {
    const step = { name: 'cleanup', clear: ['temp_a', 'temp_b'] };
    const summary = buildStepSummary(step);
    expect(summary).toContain('temp_a');
    expect(summary).toContain('temp_b');
  });
});
```

> **NOTE:** The placeholder `buildStepSummary` must be replaced with the real import once implemented. The tests verify actual return values, not boolean coercion.

---

## Task 7: Chat UI ThoughtItem

**File:** `apps/studio/src/components/chat/MessageList.tsx`

The `ThoughtItem` component already exists at line ~184. It renders when `message.role === 'thought'`. Verify it handles:

- Long thought text (truncation + expand)
- Missing reasoning field
- Agent name display

If these are already handled, no changes needed. If not, extend the component.

---

## Task 8: Feature Flag `ALWAYS_EMIT_REASON_AS_THOUGHT`

**Spec requirement (Migration section):** Add a feature flag so operators can control whether `reason` fields (without an explicit `thought`) are surfaced as thought events.

### Implementation

**File:** `apps/runtime/src/config/index.ts` (or equivalent config loader)

```typescript
/** When true, emit tool_thought events for reason-only tool calls (no explicit thought field) */
alwaysEmitReasonAsThought: process.env.ALWAYS_EMIT_REASON_AS_THOUGHT === 'true',
```

**File:** `apps/runtime/src/services/execution/reasoning-executor.ts`

Read `config.alwaysEmitReasonAsThought` and use in Task 1 logic (both locations).

Default: `false` (backward compatible — only explicit thoughts are emitted).

---

## Task 9: Voice Executor Thought Callback Wiring

**File:** `apps/runtime/src/services/voice/realtime-voice-executor.ts`

The `RealtimeVoiceExecutorConfig` interface (line ~51) needs an `onThought` callback:

```typescript
export interface RealtimeVoiceExecutorConfig {
  // ... existing fields ...
  onThought?: (thought: { toolName: string; thought: string; agent: string }) => void;
}
```

Wire this callback to fire whenever the tool executor produces a thought during voice execution.

### Test: `apps/runtime/src/__tests__/voice-thought-callback.test.ts`

```typescript
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../observability/voice-trace.js', () => ({
  startRealtimeVoiceTurn: vi.fn(),
  recordRealtimeFirstAudioOut: vi.fn(),
  recordRealtimeToolCall: vi.fn(),
  completeRealtimeVoiceTurn: vi.fn(),
  failRealtimeVoiceTurn: vi.fn(),
}));

vi.mock('../../observability/voice-metrics.js', () => ({
  recordRealtimeTurnComplete: vi.fn(),
  recordRealtimeSessionStart: vi.fn(),
  recordRealtimeSessionEnd: vi.fn(),
  recordRealtimeInterruption: vi.fn(),
}));

// Import production code AFTER mocks
// import { RealtimeVoiceExecutor } from '../services/voice/realtime-voice-executor.js';

describe('Voice executor thought callback', () => {
  let onThought: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onThought = vi.fn();
  });

  test('onThought is called when tool execution emits a thought', async () => {
    // Create executor with onThought callback
    // Execute a tool that produces a thought
    // Assert: onThought called with { toolName, thought, agent }
    expect(onThought).toBeDefined();
  });

  test('onThought not called when no thought is emitted', async () => {
    // Execute a tool without thought
    // Assert: onThought not called
    expect(onThought).not.toHaveBeenCalled();
  });
});
```

---

## Task 10: `voice_thought` WebSocket Message Type

**File:** `apps/runtime/src/types/index.ts`

Add to `ServerMessage` union:

```typescript
| {
    type: 'voice_thought';
    sessionId: string;
    thought: string;
    toolName: string;
    agent: string;
  }
```

**File:** `apps/runtime/src/websocket/events.ts`

Add to `ServerMessages`:

```typescript
voiceThought(sessionId: string, thought: string, toolName: string, agent: string): ServerMessage {
  return { type: 'voice_thought', sessionId, thought, toolName, agent };
},
```

### Test: `apps/runtime/src/__tests__/voice-thought-ws-message.test.ts`

```typescript
import { describe, test, expect } from 'vitest';
import { ServerMessages } from '../websocket/events.js';

describe('voice_thought WebSocket message', () => {
  test('ServerMessages.voiceThought creates correct message shape', () => {
    const msg = ServerMessages.voiceThought('sess-1', 'thinking...', 'search', 'agent-a');
    expect(msg).toEqual({
      type: 'voice_thought',
      sessionId: 'sess-1',
      thought: 'thinking...',
      toolName: 'search',
      agent: 'agent-a',
    });
  });
});
```

---

## Task 11: SDK Handler for `voice_thought`

**File:** `packages/web-sdk/src/` (or relevant SDK package)

Add a handler that listens for `voice_thought` messages and surfaces them to the SDK consumer via a callback or event.

### Test: `packages/web-sdk/src/__tests__/voice-thought-handler.test.ts`

```typescript
import { describe, test, expect, vi } from 'vitest';

// Import the SDK client and wire a mock WebSocket
// Verify that receiving a voice_thought message triggers the registered callback

describe('SDK voice_thought handler', () => {
  test('fires onVoiceThought callback when voice_thought message received', () => {
    // Setup: create SDK client with onVoiceThought callback
    // Simulate incoming WS message: { type: 'voice_thought', ... }
    // Assert: callback was called with correct data
    expect(true).toBe(true); // placeholder — wire to production SDK
  });
});
```

---

## Task 12: Verbal Filler for Voice Thought Delivery

When a thought is emitted during voice mode, optionally insert a brief verbal filler (e.g., "Let me think about that...") to reduce perceived latency while the LLM reasons.

### Implementation

```typescript
const VERBAL_FILLER_PHRASES = [
  'Let me think about that...',
  'One moment while I check...',
  'Looking into that now...',
] as const;

function selectVerbalFiller(toolName: string): string {
  // Deterministic selection based on tool name hash for consistency
  const hash = toolName.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return VERBAL_FILLER_PHRASES[hash % VERBAL_FILLER_PHRASES.length];
}
```

### Test: `apps/runtime/src/__tests__/verbal-filler.test.ts`

```typescript
import { describe, test, expect } from 'vitest';

// Import selectVerbalFiller from production code
// import { selectVerbalFiller, VERBAL_FILLER_PHRASES } from '../services/voice/verbal-filler.js';

describe('Verbal filler selection', () => {
  test('returns a valid filler phrase for any tool name', () => {
    // const phrase = selectVerbalFiller('search_database');
    // expect(VERBAL_FILLER_PHRASES).toContain(phrase);
    expect(true).toBe(true); // placeholder
  });

  test('returns consistent result for same tool name', () => {
    // const a = selectVerbalFiller('lookup');
    // const b = selectVerbalFiller('lookup');
    // expect(a).toBe(b);
    expect(true).toBe(true); // placeholder
  });

  test('handles empty phrases array gracefully', () => {
    // Edge case — if VERBAL_FILLER_PHRASES is empty, should not throw
    expect(true).toBe(true); // placeholder
  });
});
```

---

## Task 13: Thought-to-Speech TTS Bridge

Bridge thought events to the TTS pipeline for voice channels. When a thought is emitted, optionally synthesize it as speech.

### Error Handling

**CLAUDE.md invariant:** "Never `.catch(() => {})` — log or propagate every error."

```typescript
// CORRECT:
try {
  await synthesizeThought(thought, voiceConfig);
} catch (err) {
  log.warn('thought-to-speech synthesis failed', {
    thought: thought.substring(0, 100),
    error: err instanceof Error ? err.message : String(err),
  });
  // Continue execution — TTS failure is non-fatal for thought delivery
}
```

### Tests: `apps/runtime/src/__tests__/thought-to-speech.test.ts`

```typescript
import { describe, test, expect, vi } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('Thought-to-speech bridge', () => {
  test('synthesizes thought text via TTS pipeline', async () => {
    // Wire mock TTS, call synthesizeThought, verify TTS was called
    expect(true).toBe(true); // placeholder
  });

  test('logs warning on TTS failure instead of swallowing', async () => {
    // Wire mock TTS that rejects, verify log.warn was called
    // Verify error does NOT propagate (non-fatal)
    expect(true).toBe(true); // placeholder
  });

  test('handles WS send failure gracefully', async () => {
    // Wire mock WS that throws on send
    // Verify log.warn, not silent swallow
    expect(true).toBe(true); // placeholder
  });
});
```

---

## Task 14 (NEW): Integration Test — Thought Emission to UI Pipeline

End-to-end test verifying that a thought emitted from the ReasoningExecutor reaches the WebSocket client as a `trace_event` with `type: 'tool_thought'`.

### Test: `apps/runtime/src/__tests__/thought-to-ui-integration.test.ts`

```typescript
import { describe, test, expect, vi } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('Thought emission to UI pipeline (integration)', () => {
  test('tool_thought event flows from executor through WS to client', async () => {
    // 1. Create a ReasoningExecutor with an onTraceEvent that pushes to a mock WS sender
    // 2. Execute a tool call with thought field
    // 3. Verify the mock WS sender received a serialized message with type: 'trace_event'
    //    containing event.type === 'tool_thought'
    expect(true).toBe(true); // placeholder — wire to production code
  });
});
```

---

## Parser Location Correction

The ABL DSL parser is located at:

- **`packages/core/src/parser/agent-based-parser.ts`** — Parses ABL syntax into `AgentBasedDocument` AST
- **`packages/compiler/src/platform/ir/compiler.ts`** — Compiles AST into IR

The path `packages/compiler/src/dsl/parser.ts` does NOT exist. Any references to it in earlier drafts were incorrect.

---

## Checklist

- [ ] Task 1: Emit `tool_thought` from both ReasoningExecutor locations
- [ ] Task 2: Observatory panel renderer for `tool_thought`
- [ ] Task 3: Verify `tool_thought` in TraceEventType (already done)
- [ ] Task 4: Tool execution trace envelope with timing + error paths
- [ ] Task 5: Bounded `activeToolCalls` Map (max 50, TTL 5min, eviction)
- [ ] Task 6: `buildStepSummary` for scripted flow steps (7 cases)
- [ ] Task 7: Chat UI ThoughtItem verification
- [ ] Task 8: `ALWAYS_EMIT_REASON_AS_THOUGHT` feature flag
- [ ] Task 9: Voice executor `onThought` callback
- [ ] Task 10: `voice_thought` WebSocket message type
- [ ] Task 11: SDK handler for `voice_thought`
- [ ] Task 12: Verbal filler for voice thought delivery
- [ ] Task 13: Thought-to-speech TTS bridge (with `log.warn` on failure)
- [ ] Task 14: Integration test — thought to UI pipeline
