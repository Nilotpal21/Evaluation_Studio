import { describe, expect, test } from 'vitest';
import { buildSessionHealthEvents } from '../utils/session-health-events';

describe('buildSessionHealthEvents', () => {
  test('maps runtime session health payloads to observatory error/warning events', () => {
    const timestamp = new Date('2026-03-28T15:10:00.000Z');
    const events = buildSessionHealthEvents(
      {
        type: 'session_health',
        sessionId: 'sess-123',
        health: [
          {
            category: 'llm',
            severity: 'error',
            code: 'LLM_WIRING_FAILED',
            message: 'No credential found for provider openai',
          },
          {
            category: 'database',
            severity: 'warning',
            code: 'DB_RESOLUTION_UNAVAILABLE',
            message: 'Database not available',
          },
        ],
      },
      'TravelDesk_Supervisor',
      timestamp,
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      id: 'session-health-sess-123-LLM_WIRING_FAILED-0',
      type: 'error',
      timestamp,
      traceId: 'sess-123',
      spanId: 'session-health-sess-123',
      sessionId: 'sess-123',
      agentName: 'TravelDesk_Supervisor',
      data: {
        code: 'LLM_WIRING_FAILED',
        message: 'No credential found for provider openai',
        category: 'llm',
        source: 'session_health',
      },
      metadata: {
        severity: 'error',
        tags: ['session_health', 'llm'],
      },
    });
    expect(events[1]).toMatchObject({
      id: 'session-health-sess-123-DB_RESOLUTION_UNAVAILABLE-1',
      type: 'warning',
      agentName: 'TravelDesk_Supervisor',
      metadata: {
        severity: 'warn',
        tags: ['session_health', 'database'],
      },
    });
  });
});
