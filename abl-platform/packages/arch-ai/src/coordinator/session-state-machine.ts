/**
 * Session State Machine — manages session lifecycle states.
 *
 * Gate-free redesign: GATE_PENDING removed from the state machine.
 * Sessions alternate between IDLE and ACTIVE only. Widgets keep session
 * ACTIVE with a persisted pendingInteraction (not GATE_PENDING).
 *
 * GATE_PENDING removed from RESUMABLE_STATES. GATE_PENDING→ARCHIVED
 * transition retained for legacy session cleanup.
 */

import type { SessionState } from '../types/session.js';
import { InvalidTransitionError } from '../types/errors.js';

/**
 * Valid session state transitions.
 * GATE_PENDING transitions removed — gates no longer exist in onboarding.
 */
const VALID_STATE_TRANSITIONS: Record<string, true> = {
  'IDLE->ACTIVE': true,
  'ACTIVE->IDLE': true,
  'ACTIVE->COMPLETE': true,
  'COMPLETE->ARCHIVED': true,
  'IDLE->ARCHIVED': true,
  'ACTIVE->ARCHIVED': true,
  // Legacy cleanup: GATE_PENDING sessions from the pre-gate-free era
  // can be directly archived. GATE_PENDING is no longer a valid state
  // for new sessions but old DB records may still have it.
  'GATE_PENDING->ARCHIVED': true,
};

/**
 * Validate a session state transition.
 * Throws InvalidTransitionError if the transition is not allowed.
 * Returns the target state on success.
 */
export function validateStateTransition(from: SessionState, to: SessionState): SessionState {
  if (from === to) return from;

  const key = `${from}->${to}`;
  if (!VALID_STATE_TRANSITIONS[key]) {
    throw new InvalidTransitionError(from, to);
  }

  return to;
}

/**
 * States that are considered "active" — session is in use.
 * Used by getOrCreate to find resumable sessions.
 *
 * GATE_PENDING included for backward compat (D-5): old sessions stuck
 * in GATE_PENDING are found by getCurrent() and cleaned up on load.
 * Remove 'GATE_PENDING' after one release cycle.
 */
export const RESUMABLE_STATES: readonly string[] = ['IDLE', 'ACTIVE'];

/**
 * States visible in user session list.
 * ARCHIVED sessions are never shown.
 * GATE_PENDING excluded — legacy sessions should not appear in lists.
 */
export const LISTABLE_STATES: readonly string[] = ['IDLE', 'ACTIVE', 'COMPLETE'];

/**
 * States eligible for archival.
 * COMPLETE: auto-archive. IDLE/ACTIVE: manual "Start Fresh".
 * GATE_PENDING: old sessions cleaned up on load (D-5).
 */
export const ARCHIVABLE_STATES: readonly string[] = ['IDLE', 'ACTIVE', 'GATE_PENDING', 'COMPLETE'];
