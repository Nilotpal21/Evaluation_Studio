/**
 * Heuristic outcome classification for sessions.
 *
 * Derives a normalized `outcome` field from session status and escalation events.
 * Pure function — no I/O, used at write time when session ends.
 *
 * Outcome values:
 *   contained  — session completed without human escalation
 *   escalated  — session had an escalation event or status is 'escalated'
 *   abandoned  — session ended by timeout, user exit, or inactivity
 *   null       — session still active (not yet classifiable)
 */

export type SessionOutcome = 'contained' | 'escalated' | 'abandoned';

export interface OutcomeInput {
  status: string;
  hasEscalation: boolean;
}

export function classifyOutcome(input: OutcomeInput): SessionOutcome | null {
  const { status, hasEscalation } = input;

  // Active sessions are not yet classifiable
  if (status === 'active' || status === 'idle') return null;

  // Escalation takes priority
  if (hasEscalation || status === 'escalated') return 'escalated';

  // Abandoned = timeout, user left, or explicit abandoned status
  if (status === 'abandoned') return 'abandoned';

  // Completed/ended without escalation = contained
  if (status === 'completed' || status === 'ended' || status === 'archived') return 'contained';

  return null;
}
