import { beforeEach, describe, expect, it } from 'vitest';
import { useObservatoryStore } from '../store/observatory-store';
import type { ExtendedTraceEvent } from '../types';

function makeEvent(overrides: Partial<ExtendedTraceEvent>): ExtendedTraceEvent {
  return {
    id: 'evt-default',
    type: 'llm_call',
    timestamp: new Date('2025-01-01T00:00:00Z'),
    traceId: 'trace-1',
    spanId: 'span-default',
    sessionId: 'session-1',
    agentName: 'AgentA',
    data: {},
    ...overrides,
  };
}

describe('Observatory Store — deterministic span lifecycle', () => {
  beforeEach(() => {
    const store = useObservatoryStore.getState();
    store.clearEvents();
    store.clearFlow();
    store.resetMetrics();
  });

  it('flow_step_exit closes the matching step span for the same agent', () => {
    const store = useObservatoryStore.getState();

    store.addEvent(
      makeEvent({
        id: 'agent-a-enter',
        type: 'agent_enter',
        spanId: 'agent-a-span',
        agentName: 'AgentA',
      }),
    );
    store.addEvent(
      makeEvent({
        id: 'step-a-enter',
        type: 'flow_step_enter',
        spanId: 'step-a-span',
        agentName: 'AgentA',
        data: { stepName: 'confirm' },
      }),
    );
    store.addEvent(
      makeEvent({
        id: 'agent-b-enter',
        type: 'agent_enter',
        spanId: 'agent-b-span',
        agentName: 'AgentB',
        timestamp: new Date('2025-01-01T00:00:01Z'),
      }),
    );

    store.addEvent(
      makeEvent({
        id: 'step-a-exit',
        type: 'flow_step_exit',
        agentName: 'AgentA',
        timestamp: new Date('2025-01-01T00:00:02Z'),
        data: { stepName: 'confirm', result: 'completed' },
      }),
    );

    expect(useObservatoryStore.getState().spans.get('step-a-span')?.status).toBe('completed');
    expect(useObservatoryStore.getState().spans.get('agent-b-span')?.status).toBe('running');
  });

  it('flow_step_exit matches the exact step name rather than a substring', () => {
    const store = useObservatoryStore.getState();

    store.addEvent(
      makeEvent({
        id: 'agent-enter',
        type: 'agent_enter',
        spanId: 'agent-span',
        agentName: 'AgentA',
      }),
    );
    store.addEvent(
      makeEvent({
        id: 'step-confirm-order-enter',
        type: 'flow_step_enter',
        spanId: 'step-confirm-order-span',
        agentName: 'AgentA',
        data: { stepName: 'confirm_order' },
      }),
    );

    store.addEvent(
      makeEvent({
        id: 'step-confirm-exit',
        type: 'flow_step_exit',
        agentName: 'AgentA',
        timestamp: new Date('2025-01-01T00:00:01Z'),
        data: { stepName: 'confirm', result: 'completed' },
      }),
    );

    expect(useObservatoryStore.getState().spans.get('step-confirm-order-span')?.status).toBe(
      'running',
    );
  });

  it('replacing a span id updates the active step registry', () => {
    const store = useObservatoryStore.getState();

    store.startSpan(
      'shared-step-span',
      'Step: confirm',
      'trace-1',
      'session-1',
      'AgentA',
      'agent-span',
      new Date('2025-01-01T00:00:00Z'),
      { kind: 'step', stepName: 'confirm' },
    );

    store.startSpan(
      'shared-step-span',
      'Step: review',
      'trace-1',
      'session-1',
      'AgentA',
      'agent-span',
      new Date('2025-01-01T00:00:01Z'),
      { kind: 'step', stepName: 'review' },
    );

    store.addEvent(
      makeEvent({
        id: 'step-confirm-exit-after-replace',
        type: 'flow_step_exit',
        agentName: 'AgentA',
        timestamp: new Date('2025-01-01T00:00:02Z'),
        data: { stepName: 'confirm', result: 'completed' },
      }),
    );

    expect(useObservatoryStore.getState().spans.get('shared-step-span')?.status).toBe('running');

    store.addEvent(
      makeEvent({
        id: 'step-review-exit-after-replace',
        type: 'flow_step_exit',
        agentName: 'AgentA',
        timestamp: new Date('2025-01-01T00:00:03Z'),
        data: { stepName: 'review', result: 'completed' },
      }),
    );

    expect(useObservatoryStore.getState().spans.get('shared-step-span')?.status).toBe('completed');
  });
});
