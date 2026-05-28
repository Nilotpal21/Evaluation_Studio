/**
 * @vitest-environment happy-dom
 */

/**
 * Session Message Synthesis Tests (T3.1–T3.8)
 *
 * Tests the `augmentedMessages` useMemo logic in useSessionDetail.
 * Uses renderHook with mocked SWR to exercise the real dedup + synthesis algorithm.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { SessionMessage, TraceEvent } from '../types';
import type { SessionDetailData } from '../hooks/useSessionDetail';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock SWR — return controlled session data
let mockSwrReturn: {
  data: SessionDetailData | null;
  error: undefined | Error;
  isLoading: boolean;
  mutate: ReturnType<typeof vi.fn>;
};
const mockMutate = vi.fn();

vi.mock('swr', () => ({
  default: vi.fn(() => mockSwrReturn),
}));

// Mock api-client to prevent real fetch calls
vi.mock('../lib/api-client', () => ({
  apiFetch: vi.fn().mockRejectedValue(new Error('apiFetch should not be called in tests')),
}));

// Mock replay-trace-events side effects, but keep the real augmentation helper
vi.mock('../utils/replay-trace-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/replay-trace-events')>();
  return {
    ...actual,
    replayTraceEventsIntoObservatory: vi.fn(),
    hydrateSessionStoreFromDetail: vi.fn(),
  };
});

// Mock buildAgentTree to avoid tree computation
vi.mock('../lib/buildAgentTree', () => ({
  buildAgentTree: vi.fn(() => []),
}));

// Mock observatory store
vi.mock('../store/observatory-store', () => {
  const store = {
    debugPanelTab: 'overview' as string,
    clearEvents: vi.fn(),
    clearFlow: vi.fn(),
    resetMetrics: vi.fn(),
    clearLogs: vi.fn(),
    clearExecutionState: vi.fn(),
    clearSelection: vi.fn(),
  };
  const useObservatoryStore = Object.assign(
    (selector: (s: typeof store) => unknown) => selector(store),
    { getState: () => store },
  );
  return { useObservatoryStore };
});

// Mock session store
vi.mock('../store/session-store', () => {
  const store = {
    agent: null as Record<string, unknown> | null,
    clearSession: vi.fn(),
    setState: vi.fn(),
  };
  const useSessionStore = Object.assign(
    (selector: (s: typeof store) => unknown) => selector(store),
    { getState: () => store, setState: vi.fn() },
  );
  return { useSessionStore };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSessionMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: 'Hello',
    timestamp: new Date('2025-01-01T12:00:00Z'),
    traceIds: [],
    ...overrides,
  };
}

function makeTraceEvent(overrides: Partial<TraceEvent> & { type: string }): TraceEvent {
  return {
    id: `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'session-1',
    timestamp: new Date('2025-01-01T12:00:00Z'),
    data: {},
    ...overrides,
  } as TraceEvent;
}

function makeSession(overrides: Partial<SessionDetailData> = {}): SessionDetailData {
  return {
    id: 'session-1',
    agentName: 'test-agent',
    messages: [],
    traceEvents: [],
    ...overrides,
  };
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe('Session Message Synthesis (augmentedMessages)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSwrReturn = {
      data: null,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    };
  });

  // Helper to render the hook and get augmented messages
  async function getAugmentedMessages(session: SessionDetailData) {
    mockSwrReturn = {
      data: session,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    };

    // Dynamic import to ensure mocks are applied before module loads
    const { useSessionDetail } = await import('../hooks/useSessionDetail');

    const { result } = renderHook(() => useSessionDetail('session-1', 'project-1'));

    await waitFor(() => {
      expect(result.current.session).not.toBeNull();
    });

    return result.current.session!.messages;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // T3.1: Missing assistant synthesized from llm_call.data.response
  // ─────────────────────────────────────────────────────────────────────────
  test('T3.1: synthesizes assistant message from llm_call.data.response when no matching message exists', async () => {
    const session = makeSession({
      messages: [
        makeSessionMessage({
          id: 'msg-user-1',
          role: 'user',
          content: 'What is the weather?',
          timestamp: new Date('2025-01-01T12:00:00Z'),
        }),
      ],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-llm-1',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:01Z'),
          data: {
            response: 'The weather is sunny and warm today.',
          },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    // Should have the original user message plus a synthetic assistant message
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('The weather is sunny and warm today.');
    expect(messages[1].id).toBe('trace-resp-trace-llm-1');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T3.2: Missing assistant synthesized from dsl_respond.data.rendered
  // ─────────────────────────────────────────────────────────────────────────
  test('T3.2: synthesizes assistant message from dsl_respond.data.rendered when no matching message exists', async () => {
    const session = makeSession({
      messages: [],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-dsl-1',
          type: 'dsl_respond',
          timestamp: new Date('2025-01-01T12:00:02Z'),
          data: {
            rendered: 'Welcome! How can I help you today?',
          },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toBe('Welcome! How can I help you today?');
    expect(messages[0].id).toBe('trace-resp-trace-dsl-1');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T3.3: Truncated response (2000 chars) marked as truncated
  // ─────────────────────────────────────────────────────────────────────────
  test('T3.3: marks llm_call response of exactly 2000 chars as truncated', async () => {
    const longResponse = 'A'.repeat(2000);
    const session = makeSession({
      messages: [],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-llm-truncated',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:01Z'),
          data: {
            response: longResponse,
          },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    expect(messages).toHaveLength(1);
    expect(messages[0].metadata?.truncated).toBe(true);
    expect(messages[0].metadata?.synthetic).toBe(true);
    expect(messages[0].content).toBe(longResponse);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T3.3 extra: Non-2000-char response is NOT marked as truncated
  // ─────────────────────────────────────────────────────────────────────────
  test('T3.3 extra: does not mark response shorter than 2000 chars as truncated', async () => {
    const normalResponse = 'A'.repeat(1999);
    const session = makeSession({
      messages: [],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-llm-normal',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:01Z'),
          data: {
            response: normalResponse,
          },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    expect(messages).toHaveLength(1);
    expect(messages[0].metadata?.truncated).toBeUndefined();
    expect(messages[0].metadata?.synthetic).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T3.4: Existing assistant NOT duplicated when trace matches
  // ─────────────────────────────────────────────────────────────────────────
  test('T3.4: does not duplicate existing assistant message when trace content matches within 5s window', async () => {
    const content = 'Here is your answer about the weather.';
    const session = makeSession({
      messages: [
        makeSessionMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content,
          timestamp: new Date('2025-01-01T12:00:01Z'),
        }),
      ],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-llm-match',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:02Z'), // 1s after message — within 5s window
          data: {
            response: content,
          },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    // Should only have the original message, no synthetic duplicate
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-assistant-1');
  });

  test('does not synthesize extra turns when a hydrated transcript already has a full turn', async () => {
    const session = makeSession({
      messages: [
        makeSessionMessage({
          id: 'msg-assistant-greeting',
          role: 'assistant',
          content: 'Thank you for calling Spectrum. How can I assist you today?',
          timestamp: new Date('2025-01-01T12:00:00Z'),
        }),
        makeSessionMessage({
          id: 'msg-user-1',
          role: 'user',
          content: 'hi',
          timestamp: new Date('2025-01-01T12:00:10Z'),
        }),
        makeSessionMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Hello! How can I help you today?',
          timestamp: new Date('2025-01-01T12:00:11Z'),
        }),
      ],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-user-1',
          type: 'user_message',
          timestamp: new Date('2025-01-01T12:00:10Z'),
          data: { message: 'hi' },
        }),
        makeTraceEvent({
          id: 'trace-dsl-greeting',
          type: 'dsl_respond',
          timestamp: new Date('2025-01-01T12:00:00Z'),
          data: { rendered: 'Thank you for calling Spectrum. How can I assist you today?' },
        }),
        makeTraceEvent({
          id: 'trace-llm-variant',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:12Z'),
          data: {
            response: 'Hello! How can I help you today? If you need any assistance, let me know.',
          },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    expect(messages).toHaveLength(3);
    expect(messages.map((message) => message.id)).toEqual([
      'msg-assistant-greeting',
      'msg-user-1',
      'msg-assistant-1',
    ]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T3.5: Identical content >5s apart treated as distinct
  // ─────────────────────────────────────────────────────────────────────────
  test('T3.5: treats identical content more than 5s apart as distinct messages', async () => {
    const session = makeSession({
      messages: [],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-llm-first',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:00Z'),
          data: { response: 'yes' },
        }),
        makeTraceEvent({
          id: 'trace-llm-second',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:10Z'), // 10s later
          data: { response: 'yes' },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    // Both should appear since they are >5s apart and no base messages exist
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('yes');
    expect(messages[1].content).toBe('yes');
    expect(messages[0].id).not.toBe(messages[1].id);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T3.6: Identical content <5s apart deduped
  // ─────────────────────────────────────────────────────────────────────────
  test('T3.6: deduplicates identical content within 5s window (real message + trace)', async () => {
    const session = makeSession({
      messages: [
        makeSessionMessage({
          id: 'msg-real-yes',
          role: 'assistant',
          content: 'yes',
          timestamp: new Date('2025-01-01T12:00:00Z'),
        }),
      ],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-yes-dup',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:02Z'), // 2s later — within 5s window
          data: { response: 'yes' },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    // Should only have the original message
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-real-yes');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T3.7: Synthetic messages sorted chronologically
  // ─────────────────────────────────────────────────────────────────────────
  test('T3.7: merges and sorts synthetic messages chronologically with base messages', async () => {
    const session = makeSession({
      messages: [
        makeSessionMessage({
          id: 'msg-user-1',
          role: 'user',
          content: 'First question',
          timestamp: new Date('2025-01-01T12:00:00Z'),
        }),
        makeSessionMessage({
          id: 'msg-user-3',
          role: 'user',
          content: 'Third question',
          timestamp: new Date('2025-01-01T12:00:20Z'),
        }),
      ],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-llm-mid',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:10Z'), // Between the two user messages
          data: { response: 'Second — synthetic assistant response' },
        }),
        makeTraceEvent({
          id: 'trace-llm-last',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:30Z'), // After both user messages
          data: { response: 'Fourth — final response' },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    expect(messages).toHaveLength(4);

    // Verify chronological order
    expect(messages[0].content).toBe('First question');
    expect(messages[0].timestamp).toEqual(new Date('2025-01-01T12:00:00Z'));

    expect(messages[1].content).toBe('Second — synthetic assistant response');
    expect(messages[1].timestamp).toEqual(new Date('2025-01-01T12:00:10Z'));

    expect(messages[2].content).toBe('Third question');
    expect(messages[2].timestamp).toEqual(new Date('2025-01-01T12:00:20Z'));

    expect(messages[3].content).toBe('Fourth — final response');
    expect(messages[3].timestamp).toEqual(new Date('2025-01-01T12:00:30Z'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T3.8: Synthetic messages have metadata.synthetic = true
  // ─────────────────────────────────────────────────────────────────────────
  test('T3.8: all synthetic messages have metadata.synthetic === true', async () => {
    const session = makeSession({
      messages: [
        makeSessionMessage({
          id: 'msg-user-1',
          role: 'user',
          content: 'Hello',
          timestamp: new Date('2025-01-01T12:00:00Z'),
        }),
      ],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-user-synth',
          type: 'user_message',
          timestamp: new Date('2025-01-01T12:00:10Z'), // >5s from user msg to avoid dedup
          data: { message: 'Synthetic user message' },
        }),
        makeTraceEvent({
          id: 'trace-llm-synth',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:11Z'),
          data: { response: 'Synthetic assistant from llm_call' },
        }),
        makeTraceEvent({
          id: 'trace-dsl-synth',
          type: 'dsl_respond',
          timestamp: new Date('2025-01-01T12:00:12Z'),
          data: { rendered: 'Synthetic assistant from dsl_respond' },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    // Original user message should not have synthetic flag
    const original = messages.find((m) => m.id === 'msg-user-1');
    expect(original).toBeDefined();
    expect(original!.metadata?.synthetic).toBeUndefined();

    // All synthetic messages should have metadata.synthetic === true
    const synthetics = messages.filter((m) => m.id.startsWith('trace-'));
    expect(synthetics).toHaveLength(3);
    for (const msg of synthetics) {
      expect(msg.metadata?.synthetic).toBe(true);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Additional edge cases
  // ─────────────────────────────────────────────────────────────────────────

  test('returns base messages unchanged when no trace events exist', async () => {
    const baseMessages = [
      makeSessionMessage({
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: new Date('2025-01-01T12:00:00Z'),
      }),
      makeSessionMessage({
        id: 'msg-2',
        role: 'assistant',
        content: 'Hi there!',
        timestamp: new Date('2025-01-01T12:00:01Z'),
      }),
    ];
    const session = makeSession({
      messages: baseMessages,
      traceEvents: [],
    });

    const messages = await getAugmentedMessages(session);

    expect(messages).toHaveLength(2);
    expect(messages).toBe(baseMessages); // exact reference — no augmentation
  });

  test('preserves stored thought messages when trace augmentation runs', async () => {
    const thoughtMessage = makeSessionMessage({
      id: 'msg-thought-1',
      role: 'thought',
      content: 'Checking whether the policy applies',
      timestamp: new Date('2025-01-01T12:00:01Z'),
      traceIds: ['trace-thought-1'],
      metadata: {
        toolName: 'policy-check',
        llmCallId: 'llm-thought-1',
        isStepThought: true,
      },
    });

    const session = makeSession({
      messages: [thoughtMessage],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-llm-after-thought',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:02Z'),
          data: {
            response: 'The policy does apply here.',
          },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('thought');
    expect(messages[0].id).toBe(thoughtMessage.id);
    expect(messages[0].content).toBe(thoughtMessage.content);
    expect(messages[0].traceIds).toEqual(['trace-thought-1']);
    expect(messages[0].metadata).toEqual({
      toolName: 'policy-check',
      llmCallId: 'llm-thought-1',
      isStepThought: true,
    });
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('The policy does apply here.');
  });

  test('ignores trace events with empty content', async () => {
    const session = makeSession({
      messages: [],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-empty-llm',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:01Z'),
          data: { response: '' },
        }),
        makeTraceEvent({
          id: 'trace-whitespace-dsl',
          type: 'dsl_respond',
          timestamp: new Date('2025-01-01T12:00:02Z'),
          data: { rendered: '   ' },
        }),
        makeTraceEvent({
          id: 'trace-empty-user',
          type: 'user_message',
          timestamp: new Date('2025-01-01T12:00:03Z'),
          data: { message: '' },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    // All events have empty/whitespace content — none should be synthesized
    expect(messages).toHaveLength(0);
  });

  test('dedup uses 100-char prefix match for long content', async () => {
    // Create content that is identical in the first 100 chars but differs after
    const prefix = 'A'.repeat(100);
    const longMessage = prefix + ' extended content that differs';
    const traceResponse = prefix + ' different extended content from trace';

    const session = makeSession({
      messages: [
        makeSessionMessage({
          id: 'msg-long',
          role: 'assistant',
          content: longMessage,
          timestamp: new Date('2025-01-01T12:00:00Z'),
        }),
      ],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-llm-long',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:01Z'), // within 5s window
          data: { response: traceResponse },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    // Should be deduped because first 100 chars match and timestamp within 5s
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-long');
  });

  test('handles dotted event types via normalizeEventType', async () => {
    const session = makeSession({
      messages: [],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-dotted-llm',
          // The normalizer converts 'llm.call.completed' → 'llm_call'
          type: 'llm.call.completed' as TraceEvent['type'],
          timestamp: new Date('2025-01-01T12:00:01Z'),
          data: { response: 'Response from dotted event type' },
        }),
        makeTraceEvent({
          id: 'trace-dotted-user',
          // The normalizer converts 'message.user.received' → 'user_message'
          type: 'message.user.received' as TraceEvent['type'],
          timestamp: new Date('2025-01-01T12:00:00Z'),
          data: { message: 'User input via dotted type' },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    expect(messages).toHaveLength(2);

    // Sorted chronologically: user message first (12:00:00), then assistant (12:00:01)
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('User input via dotted type');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('Response from dotted event type');
  });

  test('synthetic user messages use user_message trace data.message field', async () => {
    const session = makeSession({
      messages: [],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-user-msg',
          type: 'user_message',
          timestamp: new Date('2025-01-01T12:00:00Z'),
          data: { message: 'Hello from trace' },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello from trace');
    expect(messages[0].id).toBe('trace-msg-trace-user-msg');
    expect(messages[0].metadata?.synthetic).toBe(true);
    expect(messages[0].traceIds).toEqual(['trace-user-msg']);
  });

  test('synthetic assistant messages include traceIds', async () => {
    const session = makeSession({
      messages: [],
      traceEvents: [
        makeTraceEvent({
          id: 'trace-llm-with-id',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T12:00:01Z'),
          data: { response: 'Tracked response' },
        }),
      ],
    });

    const messages = await getAugmentedMessages(session);

    expect(messages).toHaveLength(1);
    expect(messages[0].traceIds).toEqual(['trace-llm-with-id']);
  });
});
