import { LEGACY_EVENT_ALIASES } from './event-detector.js';

/**
 * Check if a RECALL instruction's event matches any of the detected events.
 * Supports:
 * - Direct match: 'session:start' matches ['session:start']
 * - Wildcard match: 'agent:*:before' matches ['agent:Billing_Agent:before']
 * - Legacy alias: 'session_start' normalizes to 'session:start'
 */
export function eventMatches(instructionEvent: string, detectedEvents: string[]): boolean {
  // Normalize legacy aliases
  const normalized = LEGACY_EVENT_ALIASES[instructionEvent] || instructionEvent;

  // Direct match
  if (detectedEvents.includes(normalized)) return true;

  // Wildcard match: agent:*:before matches agent:Billing_Agent:before
  if (normalized.includes('*')) {
    const regex = new RegExp('^' + normalized.replace(/\*/g, '[^:]+') + '$');
    return detectedEvents.some((e) => regex.test(e));
  }

  return false;
}
