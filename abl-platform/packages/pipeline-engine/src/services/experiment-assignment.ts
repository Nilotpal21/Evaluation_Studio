/**
 * Experiment Assignment — Pure Functions
 *
 * Deterministic assignment of sessions to experiment groups using FNV-1a hashing.
 * No side effects, no database calls — suitable for unit testing without mocks.
 */

import type { ISession } from '@agent-platform/database/models';

// ─── FNV-1a Constants ───────────────────────────────────────────────────

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

// ─── Hash Function ──────────────────────────────────────────────────────

function fnv1aHash(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

// ─── Assignment Key ─────────────────────────────────────────────────────

/**
 * Derive the stable assignment key for a session.
 * Uses contactId when available (same user across sessions gets same group),
 * falls back to session _id for anonymous users.
 */
export function getAssignmentKey(session: Pick<ISession, 'contactId' | '_id'>): string {
  return session.contactId ?? session._id;
}

// ─── Group Assignment ───────────────────────────────────────────────────

/**
 * Deterministically assign an experiment group based on the experiment ID
 * and session assignment key. Uses FNV-1a hash bucketed into 10,000 slots
 * for fine-grained traffic splitting.
 *
 * @param experimentId - Unique experiment identifier
 * @param assignmentKey - Stable key derived from getAssignmentKey()
 * @param trafficSplit - Fraction of traffic to route to experiment (0.0–1.0)
 * @returns 'experiment' if in the experiment group, 'control' otherwise
 */
export function assignExperimentGroup(
  experimentId: string,
  assignmentKey: string,
  trafficSplit: number,
): 'control' | 'experiment' {
  const hash = fnv1aHash(experimentId + ':' + assignmentKey);
  const bucket = hash % 10000;
  return bucket < trafficSplit * 10000 ? 'experiment' : 'control';
}

// ─── Session Eligibility ────────────────────────────────────────────────

export type SessionEligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: 'studio_session' | 'a2a_child' | 'channel_excluded' };

export interface CachedExperiment {
  experimentId: string;
  assignmentMode: 'version' | 'deployment';
  // version-mode (legacy)
  controlVersion?: string;
  experimentVersion?: string;
  // deployment-mode (new)
  controlDeploymentId?: string;
  experimentDeploymentId?: string;
  trafficSplit: number;
  channels: string[];
}

/**
 * Check whether a session is eligible for experiment assignment.
 *
 * Ineligible sessions:
 * - Studio debug sessions (source.type === 'studio')
 * - A2A child sessions (parentId is set)
 * - Sessions on a channel not in the experiment's allow-list
 *   (empty channels array means all channels are eligible)
 */
export function checkSessionEligibility(
  session: Pick<ISession, 'source' | 'parentId' | 'channel'>,
  experiment: CachedExperiment,
): SessionEligibilityResult {
  if (session.source?.type === 'studio') {
    return { eligible: false, reason: 'studio_session' };
  }
  if (session.parentId) {
    return { eligible: false, reason: 'a2a_child' };
  }
  if (experiment.channels.length > 0 && !experiment.channels.includes(session.channel)) {
    return { eligible: false, reason: 'channel_excluded' };
  }
  return { eligible: true };
}
