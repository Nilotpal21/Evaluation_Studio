/**
 * Resume Summary — generates progress descriptions for the Resume dialog.
 * Contract: S1-F06 req 3-4
 *
 * The dialog shows: phase name, last activity timestamp, progress summary.
 * Progress summary is phase-specific.
 */

import type { ArchSession } from '../types/session.js';
import type { ArchPhase, BlueprintStage } from '../types/session.js';

export interface ResumeSummary {
  phase: ArchPhase;
  phaseLabel: string;
  lastActivity: string;
  progressDescription: string;
  hasPendingInteraction: boolean;
}

const PHASE_LABELS: Record<ArchPhase, string> = {
  INTERVIEW: 'Interview',
  BLUEPRINT: 'Blueprint',
  BUILD: 'Build',
  CREATE: 'Create',
};

const INTERVIEW_FIELDS = ['projectName', 'description', 'channels', 'language'] as const;

function getInterviewProgress(session: ArchSession): string {
  const spec = session.metadata.specification;
  let filled = 0;
  const total = INTERVIEW_FIELDS.length;

  if (spec.projectName.trim().length > 0) filled++;
  if (spec.description && spec.description.trim().length > 0) filled++;
  if (spec.channels.length > 0) filled++;
  if (spec.language !== 'English') filled++;

  const noteCount = spec.conversationNotes.length;
  const notesSuffix =
    noteCount > 0 ? `, ${noteCount} note${noteCount > 1 ? 's' : ''} captured` : '';

  return `${filled} of ${total} specification fields captured${notesSuffix}`;
}

function asBlueprintStage(value: unknown): BlueprintStage | null {
  switch (value) {
    case 'concept_ready':
    case 'draft_generating':
    case 'draft_ready':
    case 'revising':
    case 'topology_locked':
      return value;
    default:
      return null;
  }
}

function getBlueprintProgress(session: ArchSession): string {
  const meta = session.metadata as unknown as Record<string, unknown>;
  const topology =
    (meta.lockedTopology as Record<string, unknown> | undefined) ??
    (meta.draftTopology as Record<string, unknown> | undefined) ??
    (meta.topology as Record<string, unknown> | undefined);
  const lockedTopology = meta.lockedTopology as Record<string, unknown> | undefined;
  const topologyApproved = meta.topologyApproved as boolean | undefined;
  const blueprintStage = asBlueprintStage(meta.blueprintStage);

  if (!topology) return 'Designing agent topology...';

  const agents = (topology.agents as unknown[]) ?? [];
  const agentCount = agents.length;

  if (lockedTopology || topologyApproved) {
    return `Topology approved: ${agentCount} agents designed, ready to build`;
  }

  if (blueprintStage === 'revising') {
    return `Draft topology under revision: ${agentCount} agents in the current draft`;
  }

  return `Topology designed with ${agentCount} agents, pending approval`;
}

function getBuildProgress(session: ArchSession): string {
  const meta = session.metadata as unknown as Record<string, unknown>;
  const files = (meta.files ?? {}) as Record<string, unknown>;
  const topology =
    (meta.lockedTopology as Record<string, unknown> | undefined) ??
    (meta.topology as Record<string, unknown> | undefined);
  const buildProgress = meta.buildProgress as { stage?: string } | undefined;
  const generatedCount = Object.keys(files).length;
  const totalAgents = ((topology?.agents ?? []) as unknown[]).length;

  // 'tools' is a legacy alias for 'agents_complete'
  if (buildProgress?.stage === 'agents_complete' || buildProgress?.stage === 'tools') {
    return 'All agents built, project creation pending';
  }

  if (buildProgress?.stage === 'initialized') {
    return `Ready to build ${totalAgents} agent${totalAgents === 1 ? '' : 's'}`;
  }

  if (generatedCount === 0) return 'Generating agent ABL code...';
  if (generatedCount >= totalAgents) return `All ${generatedCount} agents generated and compiled`;
  return `${generatedCount} of ${totalAgents} agents generated`;
}

function getCreateProgress(session: ArchSession): string {
  const meta = session.metadata as unknown as Record<string, unknown>;
  const files = (meta.files ?? {}) as Record<string, unknown>;
  const agentCount = Object.keys(files).length;
  return `${agentCount} agents ready for project creation`;
}

export function buildResumeSummary(session: ArchSession): ResumeSummary {
  const phase = session.metadata.phase;

  let progressDescription: string;
  switch (phase) {
    case 'INTERVIEW':
      progressDescription = getInterviewProgress(session);
      break;
    case 'BLUEPRINT':
      progressDescription = getBlueprintProgress(session);
      break;
    case 'BUILD':
      progressDescription = getBuildProgress(session);
      break;
    case 'CREATE':
      progressDescription = getCreateProgress(session);
      break;
  }

  return {
    phase,
    phaseLabel: PHASE_LABELS[phase],
    lastActivity: session.updatedAt,
    progressDescription,
    hasPendingInteraction: session.metadata.pendingInteraction !== null,
  };
}
