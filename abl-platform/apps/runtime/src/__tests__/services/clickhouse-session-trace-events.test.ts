import { describe, expect, it } from 'vitest';
import {
  buildClickHouseSessionEventDedupKey,
  dedupeClickHouseSessionEventRows,
  dedupeTraceEventsBySemanticResponse,
  mapClickHouseSessionEventRowsToTraceEvents,
  type ClickHouseSessionEventRow,
} from '../../services/trace/clickhouse-session-trace-events.js';
import type { TraceEvent } from '../../services/trace-store.js';
import {
  RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
  RUNTIME_TRACE_TYPE_DATA_KEY,
} from '../../services/trace-event-types.js';

const TYPE_MAP = {
  'session.started': 'session_created',
  'message.user.received': 'user_message',
  'message.agent.sent': 'agent_response',
  'llm.call.completed': 'llm_call',
} as const;

function makeRow(overrides: Partial<ClickHouseSessionEventRow> = {}): ClickHouseSessionEventRow {
  return {
    event_id: '',
    event_type: 'session.started',
    category: 'session',
    span_id: '',
    parent_span_id: '',
    agent_name: 'booking-agent',
    timestamp: '2026-03-22 10:00:00',
    duration_ms: 0,
    has_error: 0,
    data: JSON.stringify({ phase: 'start' }),
    _enc: '',
    ...overrides,
  };
}

function parseClickHouseTimestamp(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

function makeTraceEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: 'trace-event-1',
    sessionId: 'sess-1',
    type: 'agent_response',
    timestamp: new Date('2026-03-22T10:00:02.000Z'),
    data: {
      content: 'I can check that. Please provide your booking reference.',
    },
    agentName: 'SkymateRouter',
    ...overrides,
  };
}

describe('clickhouse-session-trace-events', () => {
  it('keeps distinct blank-id rows and generates deterministic fallback ids', () => {
    const rows = [
      makeRow(),
      makeRow({
        event_type: 'llm.call.completed',
        category: 'llm',
        span_id: 'span-1',
        timestamp: '2026-03-22 10:00:01',
        duration_ms: 123,
        data: JSON.stringify({ model: 'gpt-4.1' }),
      }),
    ];

    const events = mapClickHouseSessionEventRowsToTraceEvents({
      rows,
      sessionId: 'sess-1',
      parseClickHouseTimestamp,
      typeMap: TYPE_MAP,
    });

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('session_created');
    expect(events[1]?.type).toBe('llm_call');
    expect(events[0]?.id).toMatch(/^ch-/);
    expect(events[1]?.id).toMatch(/^ch-/);
    expect(events[0]?.id).not.toBe(events[1]?.id);
  });

  it('deduplicates exact duplicate blank-id rows but keeps distinct blank-id rows', () => {
    const duplicateRow = makeRow({
      event_type: 'message.user.received',
      category: 'message',
      data: JSON.stringify({ text: 'hi' }),
    });

    const deduped = dedupeClickHouseSessionEventRows([
      duplicateRow,
      duplicateRow,
      makeRow({
        event_type: 'message.user.received',
        category: 'message',
        timestamp: '2026-03-22 10:00:02',
        data: JSON.stringify({ text: 'hello again' }),
      }),
    ]);

    expect(deduped).toHaveLength(2);
  });

  it('keeps blank-id rows distinct when dedicated causal columns differ', () => {
    const baseRow = makeRow({
      event_type: RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
      category: 'system',
      span_id: 'span-shared',
      timestamp: '2026-03-22 10:00:03',
      data: JSON.stringify({
        [RUNTIME_TRACE_TYPE_DATA_KEY]: 'tool_call',
        toolName: 'lookupPolicy',
      }),
    });

    const deduped = dedupeClickHouseSessionEventRows([
      makeRow({
        ...baseRow,
        execution_id: 'exec-1',
        decision_id: 'decision-1',
      }),
      makeRow({
        ...baseRow,
        execution_id: 'exec-2',
        decision_id: 'decision-2',
      }),
    ]);

    expect(deduped).toHaveLength(2);
  });

  it('deduplicates rows by event_id when ClickHouse already has canonical ids', () => {
    const deduped = dedupeClickHouseSessionEventRows([
      makeRow({
        event_id: 'evt-1',
        event_type: 'session.started',
        data: JSON.stringify({ phase: 'start' }),
      }),
      makeRow({
        event_id: 'evt-1',
        event_type: 'session.ended',
        data: JSON.stringify({ phase: 'end' }),
      }),
    ]);

    expect(deduped).toHaveLength(1);
    expect(buildClickHouseSessionEventDedupKey(deduped[0]!)).toBe('event:evt-1');
  });

  it('restores the original runtime type from generic durable runtime trace rows', () => {
    const events = mapClickHouseSessionEventRowsToTraceEvents({
      rows: [
        makeRow({
          event_id: 'evt-runtime-1',
          event_type: RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
          category: 'system',
          data: JSON.stringify({
            [RUNTIME_TRACE_TYPE_DATA_KEY]: 'completion_check',
            result: 'complete',
          }),
        }),
      ],
      sessionId: 'sess-1',
      parseClickHouseTimestamp,
      typeMap: TYPE_MAP,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('completion_check');
    expect(events[0]?.data).toEqual(
      expect.objectContaining({
        [RUNTIME_TRACE_TYPE_DATA_KEY]: 'completion_check',
        result: 'complete',
      }),
    );
  });

  it('rehydrates causal fields from historical ClickHouse trace data', () => {
    const events = mapClickHouseSessionEventRowsToTraceEvents({
      rows: [
        makeRow({
          event_id: 'evt-decision',
          event_type: RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
          category: 'system',
          span_id: 'evt-decision',
          parent_span_id: 'evt-agent-enter',
          data: JSON.stringify({
            [RUNTIME_TRACE_TYPE_DATA_KEY]: 'completion_check',
            result: 'complete',
            phase: 'legacy-domain-phase',
            causal: {
              agentRunId: 'session-1:agent:1',
              decisionId: 'evt-decision',
              causeEventId: 'evt-agent-enter',
              phase: 'decision',
              reasonCode: 'completion_check',
            },
          }),
        }),
      ],
      sessionId: 'sess-1',
      parseClickHouseTimestamp,
      typeMap: TYPE_MAP,
    });

    expect(events[0]).toEqual(
      expect.objectContaining({
        type: 'completion_check',
        spanId: 'evt-decision',
        parentSpanId: 'evt-agent-enter',
        agentRunId: 'session-1:agent:1',
        decisionId: 'evt-decision',
        causeEventId: 'evt-agent-enter',
        phase: 'decision',
        reasonCode: 'completion_check',
      }),
    );
  });

  it('prefers dedicated causal columns over legacy JSON data', () => {
    const events = mapClickHouseSessionEventRowsToTraceEvents({
      rows: [
        makeRow({
          event_id: 'evt-decision',
          event_type: RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
          category: 'system',
          turn_id: 'turn-column',
          execution_id: 'exec-column',
          parent_execution_id: 'parent-exec-column',
          agent_run_id: 'agent-run-column',
          decision_id: 'decision-column',
          parent_decision_id: 'parent-decision-column',
          cause_event_id: 'cause-column',
          phase: 'decision',
          reason_code: 'completion_check',
          data: JSON.stringify({
            [RUNTIME_TRACE_TYPE_DATA_KEY]: 'completion_check',
            causal: {
              turnId: 'turn-json',
              executionId: 'exec-json',
              agentRunId: 'agent-run-json',
              phase: 'runtime',
            },
          }),
        }),
      ],
      sessionId: 'sess-1',
      parseClickHouseTimestamp,
      typeMap: TYPE_MAP,
    });

    expect(events[0]).toEqual(
      expect.objectContaining({
        turnId: 'turn-column',
        executionId: 'exec-column',
        parentExecutionId: 'parent-exec-column',
        agentRunId: 'agent-run-column',
        decisionId: 'decision-column',
        parentDecisionId: 'parent-decision-column',
        causeEventId: 'cause-column',
        phase: 'decision',
        reasonCode: 'completion_check',
      }),
    );
  });

  it('deduplicates equivalent durable agent responses from separate producers', () => {
    const events = mapClickHouseSessionEventRowsToTraceEvents({
      rows: [
        makeRow({
          event_id: 'evt-pipeline-response',
          event_type: 'message.agent.sent',
          category: 'message',
          agent_name: 'SkymateRouter',
          timestamp: '2026-03-22 10:00:02',
          data: JSON.stringify({
            payload: {
              content: 'I can check that. Please provide your booking reference.',
            },
          }),
        }),
        makeRow({
          event_id: 'evt-trace-response',
          event_type: 'message.agent.sent',
          category: 'message',
          agent_name: 'SkymateRouter',
          timestamp: '2026-03-22 10:00:02',
          data: JSON.stringify({
            content: 'I can check that. Please provide your booking reference.',
            response: 'I can check that. Please provide your booking reference.',
            source: 'finalizeExecutionResult',
            causal: {
              turnId: 'turn-1',
            },
          }),
        }),
      ],
      sessionId: 'sess-1',
      parseClickHouseTimestamp,
      typeMap: TYPE_MAP,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        id: 'evt-trace-response',
        type: 'agent_response',
        agentName: 'SkymateRouter',
        turnId: 'turn-1',
      }),
    );
  });

  it('keeps repeated agent responses when they are separated in time', () => {
    const events = mapClickHouseSessionEventRowsToTraceEvents({
      rows: [
        makeRow({
          event_id: 'evt-response-1',
          event_type: 'message.agent.sent',
          category: 'message',
          agent_name: 'SkymateRouter',
          timestamp: '2026-03-22 10:00:02',
          data: JSON.stringify({
            content: 'Still checking.',
          }),
        }),
        makeRow({
          event_id: 'evt-response-2',
          event_type: 'message.agent.sent',
          category: 'message',
          agent_name: 'SkymateRouter',
          timestamp: '2026-03-22 10:00:08',
          data: JSON.stringify({
            content: 'Still checking.',
          }),
        }),
      ],
      sessionId: 'sess-1',
      parseClickHouseTimestamp,
      typeMap: TYPE_MAP,
    });

    expect(events).toHaveLength(2);
  });

  it('deduplicates equivalent live and durable agent responses after source merge', () => {
    const events = dedupeTraceEventsBySemanticResponse([
      makeTraceEvent({
        id: 'durable-response',
        timestamp: new Date('2026-03-22T10:00:02.000Z'),
        data: {
          content: 'I can check that. Please provide your booking reference.',
          source: 'finalizeExecutionResult',
        },
      }),
      makeTraceEvent({
        id: 'live-response',
        timestamp: new Date('2026-03-22T10:00:02.018Z'),
        data: {
          response: 'I can check that. Please provide your booking reference.',
        },
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('durable-response');
  });
});
