import type { RuntimeSession } from '../services/runtime-executor.js';
import type { ServerMessage } from '../types/index.js';
import { ServerMessages } from './events.js';

type SessionDiagnostics = Pick<RuntimeSession, 'toolWarnings' | 'sessionHealth'>;

export function buildSessionDiagnosticMessages(
  sessionId: string,
  session: SessionDiagnostics,
): ServerMessage[] {
  const messages: ServerMessage[] = [];

  if (session.toolWarnings && session.toolWarnings.length > 0) {
    messages.push(ServerMessages.toolWarnings(sessionId, session.toolWarnings));
  }

  if (session.sessionHealth && session.sessionHealth.length > 0) {
    messages.push(
      ServerMessages.sessionHealth(
        sessionId,
        session.sessionHealth.map((entry) => ({
          category: entry.category,
          severity: entry.severity,
          code: entry.code,
          message: entry.message,
        })),
      ),
    );
  }

  return messages;
}
