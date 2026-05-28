import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { useSessionHealth } from '../hooks/useSessionHealth';
import { useObservatoryStore } from '../store/observatory-store';
import type { ExtendedTraceEvent } from '../types';

function makeEvent(overrides: Partial<ExtendedTraceEvent>): ExtendedTraceEvent {
  return {
    id: 'event-1',
    type: 'error',
    timestamp: new Date('2026-03-29T12:00:00.000Z'),
    traceId: 'trace-1',
    spanId: 'span-1',
    sessionId: 'session-1',
    agentName: 'TravelDesk_Supervisor',
    data: {},
    ...overrides,
  };
}

describe('useSessionHealth', () => {
  afterEach(() => {
    useObservatoryStore.getState().clearEvents();
  });

  test('surfaces session health events and banner-eligible configuration diagnostics in the banner summary', () => {
    const store = useObservatoryStore.getState();
    store.clearEvents();
    store.addEvent(
      makeEvent({
        id: 'session-health-error',
        type: 'error',
        data: {
          source: 'session_health',
          message: 'LLM wiring failed',
        },
      }),
    );
    store.addEvent(
      makeEvent({
        id: 'configuration-warning',
        type: 'agent_error_handled',
        data: {
          diagnostic: {
            category: 'llm',
            severity: 'warning',
            code: 'LLM_CREDENTIAL_MISSING',
            message: 'Missing provider credential',
            bannerEligible: true,
          },
        },
      }),
    );
    store.addEvent(
      makeEvent({
        id: 'generic-runtime-error',
        type: 'error',
        data: {
          source: 'trace_event',
          message: 'A generic runtime failure',
        },
      }),
    );

    const { result } = renderHook(() => useSessionHealth());

    expect(result.current).toEqual({
      errors: 1,
      warnings: 1,
      hasIssues: true,
      issues: [
        {
          severity: 'error',
          message: 'LLM wiring failed',
        },
        {
          severity: 'warning',
          message: 'Missing provider credential',
        },
      ],
    });
  });
});
