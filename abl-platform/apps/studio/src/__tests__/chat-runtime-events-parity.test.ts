import { describe, expect, it } from 'vitest';
import { RUNTIME_EVENT_TYPES } from '@agent-platform/shared-kernel';
import { EVENT_LABELS, EVENT_TO_STEP } from '../components/observatory/interactions/constants';
import {
  getObservatoryEventSummary,
  getObservatoryEventTypeLabel,
} from '../utils/observatory-event-presentation';
import type { ExtendedTraceEvent } from '../types';

const CHAT_AUDIT_RUNTIME_EVENTS = [
  'step_thought',
  'tool_thought',
  'status_update',
  'status_clear',
] as const;

const TRACE_SOURCE_OF_TRUTH_P0_EVENTS = [
  'deterministic_routing',
  'deterministic_handoff',
  'execution.queued',
  'execution.started',
  'execution.completed',
  'execution.failed',
  'execution.cancelled',
  'queue_backpressure',
] as const;

function makeEvent(
  type: (typeof CHAT_AUDIT_RUNTIME_EVENTS)[number],
  data: Record<string, unknown>,
): ExtendedTraceEvent {
  return {
    id: `event-${type}`,
    type,
    timestamp: new Date('2026-05-12T00:00:00.000Z'),
    traceId: 'trace-chat-audit',
    spanId: `span-${type}`,
    sessionId: 'session-chat-audit',
    agentName: 'AppointmentRouter',
    data,
  };
}

describe('chat runtime event parity', () => {
  it('keeps chat audit runtime events visible from registry to Studio presentation', () => {
    for (const type of CHAT_AUDIT_RUNTIME_EVENTS) {
      expect(RUNTIME_EVENT_TYPES).toContain(type);
      expect(EVENT_TO_STEP[type]).toBe('decision');
      expect(EVENT_LABELS[type]).toEqual(expect.any(String));
      expect(getObservatoryEventTypeLabel(type)).not.toBe(type);
    }
  });

  it('keeps source-of-truth P0 coordinator and deterministic routing events visible', () => {
    for (const type of TRACE_SOURCE_OF_TRUTH_P0_EVENTS) {
      expect(RUNTIME_EVENT_TYPES).toContain(type);
      expect(EVENT_TO_STEP[type]).toBeDefined();
      expect(EVENT_LABELS[type]).toEqual(expect.any(String));
    }

    expect(EVENT_TO_STEP['deterministic_routing']).toBe('decision');
    expect(EVENT_TO_STEP['deterministic_handoff']).toBe('decision');
    expect(EVENT_TO_STEP['queue_backpressure']).toBe('error');
    expect(EVENT_TO_STEP['execution.failed']).toBe('error');
  });

  it('renders summaries for thought and status events that developers debug in chat traces', () => {
    expect(
      getObservatoryEventSummary(
        makeEvent('step_thought', {
          stepName: 'collect_account',
          summary: 'Collecting account id',
        }),
      ),
    ).toBe('Collecting account id');
    expect(
      getObservatoryEventSummary(
        makeEvent('tool_thought', {
          toolName: 'lookup_account',
          reasoning: 'Need account data before answering',
        }),
      ),
    ).toBe('Need account data before answering');
    expect(
      getObservatoryEventSummary(
        makeEvent('status_update', {
          text: 'Checking account',
          operation: 'lookup_account',
        }),
      ),
    ).toBe('Checking account');
    expect(getObservatoryEventSummary(makeEvent('status_clear', {}))).toBe('cleared');
  });
});
