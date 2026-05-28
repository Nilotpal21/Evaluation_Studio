/**
 * Checkpoint service — create snapshots at phase gates for rollback.
 * Checkpoints are embedded in SessionMetadata (max 5, sliding window).
 */

import { randomUUID } from 'node:crypto';
import type { SessionMetadata, SessionCheckpoint } from '../types/session.js';

const MAX_CHECKPOINTS = 5;

/**
 * Create a checkpoint from the current session metadata.
 */
export function createCheckpoint(
  metadata: SessionMetadata,
  trigger: SessionCheckpoint['trigger'],
): SessionCheckpoint {
  return {
    checkpointId: randomUUID(),
    phase: metadata.phase ?? 'INTERVIEW',
    trigger,
    timestamp: new Date().toISOString(),
    messageCount: metadata.messages?.length ?? 0,
    stateSnapshot: {
      topology: metadata.topology,
      blueprintOutput: metadata.blueprintOutput,
      buildProgress: metadata.buildProgress,
      files: metadata.files,
      topologyApproved: metadata.topologyApproved,
      approvedAgents: metadata.approvedAgents,
      specification: metadata.specification,
    },
  };
}

/**
 * Add a checkpoint to the list, keeping only the last MAX_CHECKPOINTS.
 */
export function addCheckpoint(
  checkpoints: SessionCheckpoint[] | undefined,
  checkpoint: SessionCheckpoint,
): SessionCheckpoint[] {
  const existing = checkpoints ?? [];
  const updated = [...existing, checkpoint];
  return updated.slice(-MAX_CHECKPOINTS);
}

/**
 * Build the metadata patch to restore session state from a checkpoint.
 * Clears volatile state (pendingInteraction, pendingMutation, pendingPlan, activeSpecialist).
 */
export function rollbackFromCheckpoint(checkpoint: SessionCheckpoint): Partial<SessionMetadata> {
  return {
    phase: checkpoint.phase as SessionMetadata['phase'],
    topology: checkpoint.stateSnapshot.topology,
    blueprintOutput: checkpoint.stateSnapshot.blueprintOutput,
    buildProgress: checkpoint.stateSnapshot.buildProgress,
    files: checkpoint.stateSnapshot.files,
    topologyApproved: checkpoint.stateSnapshot.topologyApproved,
    approvedAgents: checkpoint.stateSnapshot.approvedAgents,
    // Clear volatile state
    pendingInteraction: null,
    pendingMutation: undefined,
    pendingPlan: undefined,
    activeSpecialist: undefined,
  };
}
