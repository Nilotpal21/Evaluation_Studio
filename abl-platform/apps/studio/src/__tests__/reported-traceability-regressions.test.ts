import { beforeEach, describe, expect, it } from 'vitest';
import { replayTraceEventsIntoObservatory } from '../utils/replay-trace-events';
import { useObservatoryStore } from '../store/observatory-store';
import { useSessionStore } from '../store/session-store';
import {
  ingestLiveTraceEvent,
  type LiveTraceEventMessage,
} from '../utils/live-trace-event-ingestion';
import type { TraceEvent } from '../types';

function makeTraceEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: 'evt-default',
    type: 'llm_call',
    timestamp: new Date('2026-03-16T15:00:00.000Z'),
    sessionId: 'session-traceability',
    traceId: 'trace-traceability',
    agentName: 'Rental_Inquiry_Agent',
    data: {},
    ...overrides,
  };
}

function makeMessage(overrides: Partial<LiveTraceEventMessage> = {}): LiveTraceEventMessage {
  return {
    type: 'trace_event',
    sessionId: 'session-traceability',
    event: makeTraceEvent(),
    ...overrides,
  };
}

describe('Reported Studio traceability regressions', () => {
  beforeEach(() => {
    useSessionStore.getState().clearSession();
    const store = useObservatoryStore.getState();
    store.clearEvents();
    store.clearFlow();
    store.resetMetrics();
    store.clearLogs();
    store.clearExecutionState();
    store.clearAppExecutionState();
  });

  it('historical replay synthesizes an agent span, attaches tool calls, and closes loading spans', () => {
    const traceEvents: TraceEvent[] = [
      makeTraceEvent({
        id: 'user-message',
        type: 'user_message',
        timestamp: new Date('2026-03-16T15:00:00.000Z'),
      }),
      makeTraceEvent({
        id: 'llm-call',
        type: 'llm_call',
        timestamp: new Date('2026-03-16T15:00:01.000Z'),
        data: { model: 'gpt-4o' },
      }),
      makeTraceEvent({
        id: 'tool-call',
        type: 'tool_call',
        timestamp: new Date('2026-03-16T15:00:02.000Z'),
        data: {
          toolName: 'list_available_cities',
          tool: 'list_available_cities',
          success: true,
        },
      }),
      makeTraceEvent({
        id: 'assistant-message',
        type: 'assistant_message',
        timestamp: new Date('2026-03-16T15:00:03.000Z'),
      }),
    ];

    replayTraceEventsIntoObservatory(traceEvents, 'session-traceability');

    const { spans, getSpanTree } = useObservatoryStore.getState();
    const synthesizedTurnSpan = spans.get('synth-span-turn-1');

    expect(synthesizedTurnSpan).toBeDefined();
    expect(synthesizedTurnSpan?.status).toBe('completed');
    expect(synthesizedTurnSpan?.events.some((event) => event.type === 'tool_call')).toBe(true);
    expect(Array.from(spans.values()).every((span) => span.status !== 'running')).toBe(true);

    const tree = getSpanTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].span.spanId).toBe('synth-span-turn-1');
  });

  it('historical replay replaces live running state for the same session and closes the trace cleanly', () => {
    useSessionStore.setState({ sessionId: 'session-live-replay' });

    ingestLiveTraceEvent(
      makeMessage({
        sessionId: 'session-live-replay',
        event: makeTraceEvent({
          id: 'live-enter',
          type: 'agent_enter',
          sessionId: 'session-live-replay',
          traceId: 'trace-live-replay',
          agentName: 'Research_Specialist',
          spanId: 'span-live-replay',
          timestamp: new Date('2026-03-16T15:10:00.000Z'),
        }),
      }),
    );

    let store = useObservatoryStore.getState();
    expect(store.spans.get('span-live-replay')?.status).toBe('running');

    const replayEvents: TraceEvent[] = [
      makeTraceEvent({
        id: 'hist-enter',
        type: 'agent_enter',
        sessionId: 'session-live-replay',
        traceId: 'trace-live-replay',
        agentName: 'Research_Specialist',
        spanId: 'span-live-replay',
        timestamp: new Date('2026-03-16T15:10:00.000Z'),
      }),
      makeTraceEvent({
        id: 'hist-tool',
        type: 'tool_call',
        sessionId: 'session-live-replay',
        traceId: 'trace-live-replay',
        agentName: 'Research_Specialist',
        spanId: 'span-live-replay',
        timestamp: new Date('2026-03-16T15:10:01.000Z'),
        data: {
          toolName: 'search',
          tool: 'search',
          success: true,
        },
      }),
      makeTraceEvent({
        id: 'hist-exit',
        type: 'agent_exit',
        sessionId: 'session-live-replay',
        traceId: 'trace-live-replay',
        agentName: 'Research_Specialist',
        spanId: 'span-live-replay',
        timestamp: new Date('2026-03-16T15:10:02.000Z'),
      }),
    ];

    replayTraceEventsIntoObservatory(replayEvents, 'session-live-replay');

    store = useObservatoryStore.getState();
    const replayedSpan = store.spans.get('span-live-replay');

    expect(store.events.map((event) => event.id)).toEqual(['hist-enter', 'hist-tool', 'hist-exit']);
    expect(store.spans.size).toBe(1);
    expect(replayedSpan?.status).toBe('completed');
    expect(replayedSpan?.events.filter((event) => event.type === 'tool_call')).toHaveLength(1);
    expect(Array.from(store.spans.values()).every((span) => span.status !== 'running')).toBe(true);
  });

  it('historical replay preserves configuration diagnostics without duplicating the trace timeline', () => {
    replayTraceEventsIntoObservatory(
      [
        makeTraceEvent({
          id: 'config-error',
          type: 'agent_error_handled',
          data: {
            message: 'An error occurred. Please try again.',
            diagnostic: {
              category: 'llm',
              severity: 'error',
              code: 'LLM_CREDENTIAL_MISSING',
              message: 'No credential found for provider openai',
              bannerEligible: true,
            },
          },
        }),
      ],
      'session-traceability',
    );

    const store = useObservatoryStore.getState();
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      id: 'config-error',
      type: 'agent_error_handled',
      data: {
        diagnostic: {
          code: 'LLM_CREDENTIAL_MISSING',
          bannerEligible: true,
        },
      },
    });
  });
});
