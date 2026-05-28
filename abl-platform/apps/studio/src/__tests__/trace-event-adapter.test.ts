import { beforeEach, describe, expect, it } from 'vitest';
import { replayTraceEventsIntoObservatory } from '../utils/replay-trace-events';
import { useObservatoryStore } from '../store/observatory-store';
import { toExtendedTraceEvent } from '../utils/trace-event-adapter';
import type { TraceEvent } from '../types';

function makeTraceEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: 'evt-1',
    type: 'llm_call',
    timestamp: new Date('2026-03-22T00:00:00.000Z'),
    sessionId: 'session-1',
    traceId: 'trace-1',
    agentName: 'agent-1',
    spanId: 'span-1',
    data: {},
    ...overrides,
  };
}

describe('trace-event-adapter', () => {
  beforeEach(() => {
    const store = useObservatoryStore.getState();
    store.clearEvents();
    store.clearFlow();
    store.resetMetrics();
    store.clearLogs();
    store.clearExecutionState();
    store.clearAppExecutionState();
  });

  it('prefers canonical top-level fields over mirrored payload fields', () => {
    const adapted = toExtendedTraceEvent(
      makeTraceEvent({
        traceId: 'trace-top-level',
        agentName: 'agent-top-level',
        spanId: 'span-top-level',
        parentSpanId: 'parent-top-level',
        data: {
          traceId: 'trace-from-data',
          agentName: 'agent-from-data',
          spanId: 'span-from-data',
          parentSpanId: 'parent-from-data',
        },
      }),
    );

    expect(adapted.traceId).toBe('trace-top-level');
    expect(adapted.agentName).toBe('agent-top-level');
    expect(adapted.spanId).toBe('span-top-level');
    expect(adapted.parentSpanId).toBe('parent-top-level');
  });

  it('falls back to mirrored payload and raw snake_case fields when canonical fields are absent', () => {
    const snakeCaseEvent = {
      ...makeTraceEvent({
        traceId: undefined,
        agentName: undefined,
        spanId: undefined,
        parentSpanId: undefined,
        data: {
          trace_id: 'trace-from-data',
          agentName: 'agent-from-data',
          span_id: 'span-from-data',
          parent_span_id: 'parent-from-data',
        },
      }),
      agent_name: 'agent-from-raw-event',
    } as TraceEvent;

    const adapted = toExtendedTraceEvent(snakeCaseEvent);

    expect(adapted.traceId).toBe('trace-from-data');
    expect(adapted.agentName).toBe('agent-from-raw-event');
    expect(adapted.spanId).toBe('span-from-data');
    expect(adapted.parentSpanId).toBe('parent-from-data');
  });

  it('promotes mirrored duration fields for Observatory timing', () => {
    const adapted = toExtendedTraceEvent(
      makeTraceEvent({
        durationMs: undefined,
        data: {
          durationMs: 320,
        },
      }),
    );

    expect(adapted.durationMs).toBe(320);
  });

  it('prefers canonical top-level duration over mirrored payload duration', () => {
    const adapted = toExtendedTraceEvent(
      makeTraceEvent({
        durationMs: 750,
        data: {
          durationMs: 320,
          latencyMs: 1000,
        },
      }),
    );

    expect(adapted.durationMs).toBe(750);
  });

  it('preserves causal envelope fields for Observatory views', () => {
    const adapted = toExtendedTraceEvent(
      makeTraceEvent({
        type: 'completion_check',
        agentRunId: 'session-1:agent:1',
        decisionId: 'evt-1',
        causeEventId: 'evt-enter',
        phase: 'decision',
        reasonCode: 'completion_check',
      }),
    );

    expect(adapted).toEqual(
      expect.objectContaining({
        agentRunId: 'session-1:agent:1',
        decisionId: 'evt-1',
        causeEventId: 'evt-enter',
        phase: 'decision',
        reasonCode: 'completion_check',
      }),
    );
    expect(adapted.data.causal).toEqual(
      expect.objectContaining({
        agentRunId: 'session-1:agent:1',
        decisionId: 'evt-1',
        causeEventId: 'evt-enter',
        phase: 'decision',
        reasonCode: 'completion_check',
      }),
    );
  });

  it('uses mirrored flow step duration when replaying stage timing', () => {
    replayTraceEventsIntoObservatory(
      [
        makeTraceEvent({
          id: 'step-enter',
          type: 'flow_step_enter',
          timestamp: new Date('2026-03-22T00:00:00.000Z'),
          agentName: 'ScriptedAgent',
          spanId: 'step-span',
          data: { stepName: 'collect_phone' },
        }),
        makeTraceEvent({
          id: 'step-exit',
          type: 'flow_step_exit',
          timestamp: new Date('2026-03-22T00:00:00.010Z'),
          agentName: 'ScriptedAgent',
          spanId: 'step-span',
          durationMs: undefined,
          data: {
            stepName: 'collect_phone',
            result: 'collect',
            durationMs: 420,
          },
        }),
      ],
      'session-1',
    );

    const metrics = useObservatoryStore.getState().stepMetrics.get('collect_phone');
    expect(metrics?.totalTimeMs).toBe(420);
  });

  it('preserves parent-child spans during replay when hierarchy only exists on canonical top-level fields', () => {
    const traceEvents: TraceEvent[] = [
      makeTraceEvent({
        id: 'evt-parent-enter',
        type: 'agent_enter',
        timestamp: new Date('2026-03-22T00:00:00.000Z'),
        traceId: 'trace-canonical',
        sessionId: 'session-canonical',
        agentName: 'ParentAgent',
        spanId: 'span-parent',
        data: {},
      }),
      makeTraceEvent({
        id: 'evt-child-enter',
        type: 'agent_enter',
        timestamp: new Date('2026-03-22T00:00:01.000Z'),
        traceId: 'trace-canonical',
        sessionId: 'session-canonical',
        agentName: 'ChildAgent',
        spanId: 'span-child',
        parentSpanId: 'span-parent',
        data: {},
      }),
      makeTraceEvent({
        id: 'evt-child-exit',
        type: 'agent_exit',
        timestamp: new Date('2026-03-22T00:00:02.000Z'),
        traceId: 'trace-canonical',
        sessionId: 'session-canonical',
        agentName: 'ChildAgent',
        spanId: 'span-child',
        parentSpanId: 'span-parent',
        data: {},
      }),
      makeTraceEvent({
        id: 'evt-parent-exit',
        type: 'agent_exit',
        timestamp: new Date('2026-03-22T00:00:03.000Z'),
        traceId: 'trace-canonical',
        sessionId: 'session-canonical',
        agentName: 'ParentAgent',
        spanId: 'span-parent',
        data: {},
      }),
    ];

    replayTraceEventsIntoObservatory(traceEvents, 'session-canonical');

    const tree = useObservatoryStore.getState().getSpanTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].span.spanId).toBe('span-parent');
    expect(tree[0].span.traceId).toBe('trace-canonical');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].span.spanId).toBe('span-child');
    expect(tree[0].children[0].span.parentSpanId).toBe('span-parent');
  });

  it('reconstructs session and voice spans so historical voice counts stay aligned', () => {
    const traceEvents: TraceEvent[] = [
      makeTraceEvent({
        id: 'session-created',
        type: 'session_created',
        sessionId: 'voice-session',
        agentName: undefined,
        spanId: undefined,
        timestamp: new Date('2026-03-25T11:00:00.000Z'),
        data: {},
      }),
      makeTraceEvent({
        id: 'voice-session-start',
        type: 'voice_session_start',
        sessionId: 'voice-session',
        agentName: 'LastMinute_Supervisor',
        spanId: undefined,
        timestamp: new Date('2026-03-25T11:00:01.000Z'),
        data: { callSid: 'CA123' },
      }),
      makeTraceEvent({
        id: 'voice-stt',
        type: 'voice_stt',
        sessionId: 'voice-session',
        agentName: 'LastMinute_Supervisor',
        spanId: undefined,
        durationMs: 250,
        timestamp: new Date('2026-03-25T11:00:05.000Z'),
        data: { turn: 1, provider: 'openai' },
      }),
      makeTraceEvent({
        id: 'voice-tts',
        type: 'voice_tts',
        sessionId: 'voice-session',
        agentName: 'LastMinute_Supervisor',
        spanId: undefined,
        durationMs: 180,
        timestamp: new Date('2026-03-25T11:00:06.000Z'),
        data: { turn: 1, provider: 'openai' },
      }),
      makeTraceEvent({
        id: 'voice-tool-call',
        type: 'voice_realtime_tool_call',
        sessionId: 'voice-session',
        agentName: 'LastMinute_Supervisor',
        spanId: undefined,
        durationMs: 90,
        timestamp: new Date('2026-03-25T11:00:06.500Z'),
        data: { turn: 1, toolName: 'search_flights', provider: 's2s:openai' },
      }),
      makeTraceEvent({
        id: 'voice-turn',
        type: 'voice_turn',
        sessionId: 'voice-session',
        agentName: 'LastMinute_Supervisor',
        spanId: undefined,
        durationMs: 1100,
        timestamp: new Date('2026-03-25T11:00:07.000Z'),
        data: { turn: 1 },
      }),
      makeTraceEvent({
        id: 'voice-session-end',
        type: 'voice_session_end',
        sessionId: 'voice-session',
        agentName: 'LastMinute_Supervisor',
        spanId: undefined,
        durationMs: 60_000,
        timestamp: new Date('2026-03-25T11:01:01.000Z'),
        data: {},
      }),
    ];

    replayTraceEventsIntoObservatory(traceEvents, 'voice-session');

    const spans = useObservatoryStore.getState().spans;
    const attachedEventCount = Array.from(spans.values()).reduce(
      (total, span) => total + span.events.length,
      0,
    );

    expect(attachedEventCount).toBe(traceEvents.length);
    expect(spans.get('session:voice-session')?.events).toHaveLength(1);
    expect(spans.get('voice-session:voice-session')?.events?.length).toBeGreaterThanOrEqual(2);
    expect(spans.get('voice-turn:voice-session:1')?.events).toHaveLength(1);
    expect(spans.get('voice_stt:voice-session:1')?.events).toHaveLength(1);
    expect(spans.get('voice_tts:voice-session:1')?.events).toHaveLength(1);
    expect(spans.get('voice_realtime_tool_call:voice-session:1')?.events).toHaveLength(1);
  });
});
