import { describe, it, expect, beforeEach } from 'vitest';
import { useObservatoryStore } from '../observatory-store';
import type { ExtendedTraceEvent } from '../../types';

function makeEvent(
  overrides: Partial<ExtendedTraceEvent> &
    Pick<ExtendedTraceEvent, 'type' | 'spanId' | 'agentName'>,
): ExtendedTraceEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date(),
    traceId: 'trace-1',
    sessionId: 'session-1',
    durationMs: undefined,
    parentSpanId: undefined,
    data: {},
    ...overrides,
  };
}

describe('Observatory span lifecycle', () => {
  beforeEach(() => {
    const s = useObservatoryStore.getState();
    s.clearEvents();
    s.clearFlow();
    s.resetMetrics();
    s.clearLogs();
  });

  it('agent_enter creates a running span', () => {
    const store = useObservatoryStore.getState();

    store.addEvent(
      makeEvent({
        type: 'agent_enter',
        spanId: 'span-enter-1',
        agentName: 'billing-agent',
      }),
    );

    const span = useObservatoryStore.getState().spans.get('span-enter-1');
    expect(span).toBeDefined();
    expect(span!.status).toBe('running');
    expect(span!.agentName).toBe('billing-agent');
  });

  it('agent_exit ends span by direct spanId match', () => {
    const store = useObservatoryStore.getState();

    store.addEvent(
      makeEvent({
        type: 'agent_enter',
        spanId: 'span-a',
        agentName: 'billing-agent',
      }),
    );

    store.addEvent(
      makeEvent({
        type: 'agent_exit',
        spanId: 'span-a',
        agentName: 'billing-agent',
        data: { result: 'success' },
      }),
    );

    const span = useObservatoryStore.getState().spans.get('span-a');
    expect(span).toBeDefined();
    expect(span!.status).toBe('completed');
    expect(span!.durationMs).toBeDefined();
  });

  it('agent_exit with DIFFERENT spanId ends span by agent name (LIFO fallback)', () => {
    const store = useObservatoryStore.getState();

    // agent_enter with one spanId
    store.addEvent(
      makeEvent({
        type: 'agent_enter',
        spanId: 'span-enter-original',
        agentName: 'support-agent',
      }),
    );

    // agent_exit arrives with a completely different spanId (replay scenario)
    store.addEvent(
      makeEvent({
        type: 'agent_exit',
        spanId: 'span-exit-different',
        agentName: 'support-agent',
        data: { result: 'success' },
      }),
    );

    // The original span should be ended via agentName LIFO fallback
    const originalSpan = useObservatoryStore.getState().spans.get('span-enter-original');
    expect(originalSpan).toBeDefined();
    expect(originalSpan!.status).toBe('completed');
    expect(originalSpan!.durationMs).toBeDefined();
  });

  it('agent_exit with error result sets span status to error', () => {
    const store = useObservatoryStore.getState();

    store.addEvent(
      makeEvent({
        type: 'agent_enter',
        spanId: 'span-err',
        agentName: 'faulting-agent',
      }),
    );

    store.addEvent(
      makeEvent({
        type: 'agent_exit',
        spanId: 'span-err',
        agentName: 'faulting-agent',
        data: { result: 'error' },
      }),
    );

    const span = useObservatoryStore.getState().spans.get('span-err');
    expect(span!.status).toBe('error');
  });

  it('session_ended sweeps all remaining running spans', () => {
    const store = useObservatoryStore.getState();

    store.addEvent(makeEvent({ type: 'agent_enter', spanId: 'span-1', agentName: 'agent-a' }));
    store.addEvent(makeEvent({ type: 'agent_enter', spanId: 'span-2', agentName: 'agent-b' }));

    // Both spans should be running
    const state1 = useObservatoryStore.getState();
    expect(state1.spans.get('span-1')!.status).toBe('running');
    expect(state1.spans.get('span-2')!.status).toBe('running');

    // session_ended should close them all
    store.addEvent(
      makeEvent({ type: 'session_ended', spanId: 'span-session', agentName: 'system' }),
    );

    const state2 = useObservatoryStore.getState();
    expect(state2.spans.get('span-1')!.status).toBe('completed');
    expect(state2.spans.get('span-2')!.status).toBe('completed');
  });

  it('LIFO fallback picks the last matching running span for re-entrant agents', () => {
    const store = useObservatoryStore.getState();

    // Two enters for the same agent (re-entrant)
    store.addEvent(makeEvent({ type: 'agent_enter', spanId: 'span-first', agentName: 'router' }));
    store.addEvent(makeEvent({ type: 'agent_enter', spanId: 'span-second', agentName: 'router' }));

    // Exit with a mismatched spanId — LIFO should pick 'span-second' (last inserted)
    store.addEvent(
      makeEvent({
        type: 'agent_exit',
        spanId: 'span-unrelated',
        agentName: 'router',
        data: { result: 'success' },
      }),
    );

    const state = useObservatoryStore.getState();
    // span-second (last match) should be completed
    expect(state.spans.get('span-second')!.status).toBe('completed');
    // span-first should still be running
    expect(state.spans.get('span-first')!.status).toBe('running');
  });
});
