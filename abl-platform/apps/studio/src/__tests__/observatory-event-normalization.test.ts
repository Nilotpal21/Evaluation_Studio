import { beforeEach, describe, expect, it } from 'vitest';
import { useObservatoryStore } from '../store/observatory-store';
import type { ExtendedTraceEvent } from '../types';

function makeEvent(overrides: Partial<ExtendedTraceEvent> = {}): ExtendedTraceEvent {
  return {
    id: 'evt-normalization',
    type: 'decision',
    timestamp: new Date('2025-01-01T00:00:00Z'),
    traceId: 'trace-1',
    spanId: 'span-1',
    sessionId: 'session-1',
    agentName: 'AgentA',
    data: {},
    ...overrides,
  };
}

describe('Observatory Store — immutable event normalization', () => {
  beforeEach(() => {
    const store = useObservatoryStore.getState();
    store.clearEvents();
    store.clearFlow();
    store.resetMetrics();
  });

  it('clones event.data before normalizing decision fields', () => {
    const store = useObservatoryStore.getState();
    const rawEvent = makeEvent({
      data: {
        kind: 'handoff',
        reason: 'delegate to booking specialist',
      },
    });

    store.addEvent(rawEvent);

    const storedEvent = useObservatoryStore.getState().events[0];

    expect(storedEvent).toBeDefined();
    expect(storedEvent.data).not.toBe(rawEvent.data);
    expect(storedEvent.data.decisionKind).toBe('handoff');
    expect(rawEvent.data.decisionKind).toBeUndefined();
    expect(rawEvent.data.kind).toBe('handoff');
  });
});
