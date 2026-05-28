import { beforeEach, describe, expect, it } from 'vitest';
import { useObservatoryStore } from '../store/observatory-store';
import { useSessionStore } from '../store/session-store';
import type { TraceEvent } from '../types';
import {
  ingestLiveTraceEvent,
  type LiveTraceEventMessage,
} from '../utils/live-trace-event-ingestion';

function resetStores(): void {
  useSessionStore.getState().clearSession();

  const observatory = useObservatoryStore.getState();
  observatory.clearEvents();
  observatory.clearFlow();
  observatory.resetMetrics();
  observatory.clearLogs();
  observatory.clearExecutionState();
  observatory.clearAppExecutionState();
}

function makeTraceEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: 'evt-parent',
    type: 'agent_enter',
    timestamp: new Date('2026-03-22T10:30:00.000Z'),
    sessionId: 'event-session',
    traceId: 'trace-top-level',
    agentName: 'ParentAgent',
    spanId: 'span-parent',
    data: {},
    ...overrides,
  };
}

function makeMessage(overrides: Partial<LiveTraceEventMessage> = {}): LiveTraceEventMessage {
  return {
    type: 'trace_event',
    sessionId: 'envelope-session',
    event: makeTraceEvent(),
    ...overrides,
  };
}

describe('ingestLiveTraceEvent', () => {
  beforeEach(() => {
    resetStores();
  });

  it('preserves canonical top-level IDs over payload mirrors and fallback session sources', () => {
    useSessionStore.setState({ sessionId: 'current-session' });

    const { accepted, traceEvent } = ingestLiveTraceEvent(
      makeMessage({
        event: makeTraceEvent({
          data: {
            agentName: 'agent-from-data',
            spanId: 'span-from-data',
            traceId: 'trace-from-data',
          },
        }),
      }),
    );

    expect(accepted).toBe(true);

    const observatoryState = useObservatoryStore.getState();
    const span = observatoryState.spans.get('span-parent');
    const event = observatoryState.events[0];

    expect(traceEvent.timestamp).toBeInstanceOf(Date);

    expect(span?.traceId).toBe('trace-top-level');
    expect(span?.sessionId).toBe('event-session');
    expect(span?.agentName).toBe('ParentAgent');
    expect(observatoryState.spans.has('span-from-data')).toBe(false);

    expect(event?.traceId).toBe('trace-top-level');
    expect(event?.spanId).toBe('span-parent');
    expect(event?.agentName).toBe('ParentAgent');
  });

  it('builds a parent-child span tree from canonical top-level hierarchy fields', () => {
    ingestLiveTraceEvent(
      makeMessage({
        event: makeTraceEvent({
          id: 'evt-parent',
          sessionId: 'live-session',
          traceId: 'trace-live',
          agentName: 'ParentAgent',
          spanId: 'span-parent',
          data: {
            spanId: 'span-parent-from-data',
          },
        }),
      }),
    );

    ingestLiveTraceEvent(
      makeMessage({
        event: makeTraceEvent({
          id: 'evt-child',
          timestamp: new Date('2026-03-22T10:30:01.000Z'),
          sessionId: 'live-session',
          traceId: 'trace-live',
          agentName: 'ChildAgent',
          spanId: 'span-child',
          parentSpanId: 'span-parent',
          data: {
            parentSpanId: 'wrong-parent-from-data',
            spanId: 'span-child-from-data',
          },
        }),
      }),
    );

    const tree = useObservatoryStore.getState().getSpanTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].span.spanId).toBe('span-parent');
    expect(tree[0].span.traceId).toBe('trace-live');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].span.spanId).toBe('span-child');
    expect(tree[0].children[0].span.parentSpanId).toBe('span-parent');
    expect(useObservatoryStore.getState().spans.has('span-child-from-data')).toBe(false);
  });

  it('keeps banner-eligible configuration diagnostics on the original observatory event only', () => {
    ingestLiveTraceEvent(
      makeMessage({
        event: makeTraceEvent({
          id: 'evt-config',
          type: 'agent_error_handled',
          traceId: 'trace-config',
          spanId: 'span-config',
          data: {
            diagnostic: {
              category: 'llm',
              severity: 'error',
              code: 'LLM_CREDENTIAL_MISSING',
              message: 'No credential found for provider openai',
              bannerEligible: true,
            },
          },
        }),
      }),
    );

    const observatoryState = useObservatoryStore.getState();
    expect(observatoryState.events).toHaveLength(1);
    expect(observatoryState.events[0]?.type).toBe('agent_error_handled');
    expect(observatoryState.events[0]).toMatchObject({
      id: 'evt-config',
      type: 'agent_error_handled',
      data: {
        diagnostic: {
          code: 'LLM_CREDENTIAL_MISSING',
          bannerEligible: true,
        },
      },
    });
  });

  it('reports duplicate trace events as not accepted', () => {
    const message = makeMessage({
      event: makeTraceEvent({
        id: 'evt-duplicate',
        type: 'llm_call',
        data: { model: 'sonnet', agentName: 'Agent' },
      }),
    });

    expect(ingestLiveTraceEvent(message).accepted).toBe(true);
    expect(ingestLiveTraceEvent(message).accepted).toBe(false);
    expect(useObservatoryStore.getState().events).toHaveLength(1);
  });
});
