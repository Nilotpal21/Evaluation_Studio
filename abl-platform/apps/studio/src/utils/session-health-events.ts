import type { ExtendedTraceEvent, ServerMessage } from '../types';

type SessionHealthMessage = Extract<ServerMessage, { type: 'session_health' }>;

/**
 * Convert runtime session_health payloads into Observatory events so the
 * existing banner/errors UI can render them like normal trace-backed issues.
 */
export function buildSessionHealthEvents(
  message: SessionHealthMessage,
  agentName: string,
  timestamp: Date = new Date(),
): ExtendedTraceEvent[] {
  return message.health.map((entry, index) => ({
    id: `session-health-${message.sessionId}-${entry.code}-${index}`,
    type: entry.severity === 'error' ? 'error' : 'warning',
    timestamp,
    traceId: message.sessionId,
    spanId: `session-health-${message.sessionId}`,
    sessionId: message.sessionId,
    agentName,
    data: {
      code: entry.code,
      message: entry.message,
      category: entry.category,
      source: 'session_health',
    },
    metadata: {
      severity: entry.severity === 'error' ? 'error' : 'warn',
      tags: ['session_health', entry.category],
    },
  }));
}
