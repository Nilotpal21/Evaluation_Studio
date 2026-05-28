import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../types';
import { normalizeSessionTrace, type RawSessionTrace } from '../hooks/useSessionTraces';
import { normalizeTraceEventRecord, toExtendedTraceEvent } from '../utils/trace-event-adapter';
import { buildTraceCausalitySummary, getTraceCausalFields } from '../utils/trace-causality';

const FULL_CAUSAL_FIELDS = {
  turnId: 'turn-1',
  executionId: 'exec-1',
  parentExecutionId: 'exec-parent',
  agentRunId: 'session-1:agent:1',
  decisionId: 'evt-decision',
  parentDecisionId: 'evt-parent-decision',
  causeEventId: 'evt-enter',
  phase: 'decision',
  reasonCode: 'completion_check',
};

describe('trace causality parity', () => {
  it('round-trips fully populated causal fields through live and historical Studio trace boundaries', () => {
    const liveTrace: TraceEvent = {
      id: 'evt-decision',
      type: 'completion_check',
      timestamp: new Date('2026-05-12T00:00:00.000Z'),
      sessionId: 'session-1',
      traceId: 'trace-1',
      agentName: 'Agent',
      spanId: 'evt-decision',
      parentSpanId: 'evt-enter',
      data: {
        phase: 'event-domain-phase',
        causal: FULL_CAUSAL_FIELDS,
      },
      ...FULL_CAUSAL_FIELDS,
    };

    const extended = toExtendedTraceEvent(liveTrace);
    expect(extended).toEqual(expect.objectContaining(FULL_CAUSAL_FIELDS));
    expect(extended.data).toEqual(
      expect.objectContaining({
        phase: 'event-domain-phase',
        causal: expect.objectContaining(FULL_CAUSAL_FIELDS),
      }),
    );

    const historicalTrace: RawSessionTrace = {
      id: 'evt-decision',
      event_type: 'completion_check',
      timestamp: '2026-05-12T00:00:00.000Z',
      agent_name: 'Agent',
      span_id: 'evt-decision',
      parent_span_id: 'evt-enter',
      data: {
        phase: 'event-domain-phase',
        causal: FULL_CAUSAL_FIELDS,
      },
      ...FULL_CAUSAL_FIELDS,
    };

    const normalized = normalizeSessionTrace(historicalTrace);
    expect(normalized).toEqual(expect.objectContaining(FULL_CAUSAL_FIELDS));
    expect(getTraceCausalFields(normalized)).toEqual(FULL_CAUSAL_FIELDS);

    const summary = buildTraceCausalitySummary([normalized]);
    expect(summary.causalRows).toHaveLength(1);
    expect(summary.phaseCounts).toEqual([{ phase: 'decision', count: 1 }]);
    expect(summary.agentRunCount).toBe(1);
    expect(summary.decisionCount).toBe(1);
  });

  it('normalizes historical snake_case trace records before observatory replay', () => {
    const historicalTrace = {
      id: 'evt-agent-enter',
      event_type: 'agent_enter',
      timestamp: '2026-05-12T00:00:00.000Z',
      session_id: 'session-1',
      trace_id: 'trace-1',
      agent_name: 'Router',
      span_id: 'span-enter',
      parent_span_id: 'span-session',
      duration_ms: 12,
      data: {
        causal: {
          agent_run_id: 'session-1:Router:1',
          cause_event_id: 'evt-user',
          phase: 'agent_lifecycle',
          reason_code: 'agent_enter_user_message',
        },
      },
    };

    const normalized = normalizeTraceEventRecord(historicalTrace);

    expect(normalized).toEqual(
      expect.objectContaining({
        id: 'evt-agent-enter',
        type: 'agent_enter',
        sessionId: 'session-1',
        traceId: 'trace-1',
        agentName: 'Router',
        spanId: 'span-enter',
        parentSpanId: 'span-session',
        durationMs: 12,
        agentRunId: 'session-1:Router:1',
        causeEventId: 'evt-user',
        phase: 'agent_lifecycle',
        reasonCode: 'agent_enter_user_message',
      }),
    );
    expect(normalized.data.causal).toEqual(
      expect.objectContaining({
        agentRunId: 'session-1:Router:1',
        causeEventId: 'evt-user',
        reasonCode: 'agent_enter_user_message',
      }),
    );
  });
});
