/**
 * Resume Snapshot — derives UI-resumable state from a session.
 *
 * Gate-free redesign: all gate derivation removed. Resume now derives
 * nextAction from phase + buildProgress + topology + files + pendingInteraction.
 * No pickNextGate, no gate builder functions, no GATE_PENDING handling.
 */

import type { TopologyOutput } from '../types/blueprint.js';
import {
  renderMissingMemoryWarning,
  renderMissingToolsWarning,
  renderSupervisorCatchAllHandoffWarning,
} from '../knowledge/construct-contract.js';
import { renderMissingGuardrailsWarning } from '../knowledge/guardrail-contract.js';
import type {
  ArchSession,
  BlueprintStage,
  BuildProgress,
  PendingWidgetInteraction,
  QualityIssue,
  ResumeCheckpoint,
  ResumeNextAction,
  ResumePendingState,
  ResumeSnapshot,
} from '../types/session.js';

interface AgentFileRecord {
  path: string;
  content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asTopologyOutput(value: unknown): TopologyOutput | null {
  if (!isRecord(value) || !Array.isArray(value.agents) || !Array.isArray(value.edges)) {
    return null;
  }

  const entryPoint = typeof value.entryPoint === 'string' ? value.entryPoint : '';
  if (!entryPoint) {
    return null;
  }

  return value as unknown as TopologyOutput;
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

function getDraftTopologyFromMetadata(metadata: ArchSession['metadata']): TopologyOutput | null {
  return (
    asTopologyOutput(metadata.draftTopology) ??
    (metadata.topologyApproved === true ? null : asTopologyOutput(metadata.topology))
  );
}

function getLockedTopologyFromMetadata(metadata: ArchSession['metadata']): TopologyOutput | null {
  return (
    asTopologyOutput(metadata.lockedTopology) ??
    (metadata.topologyApproved === true ? asTopologyOutput(metadata.topology) : null)
  );
}

function getEffectiveTopologyFromMetadata(
  metadata: ArchSession['metadata'],
): TopologyOutput | null {
  return (
    getLockedTopologyFromMetadata(metadata) ??
    getDraftTopologyFromMetadata(metadata) ??
    asTopologyOutput(metadata.topology)
  );
}

function normalizeFiles(value: unknown): Record<string, AgentFileRecord> {
  if (!isRecord(value)) {
    return {};
  }

  const files: Record<string, AgentFileRecord> = {};
  for (const [name, file] of Object.entries(value)) {
    if (isRecord(file) && typeof file.content === 'string') {
      files[name] = {
        path: typeof file.path === 'string' ? file.path : `agents/${name}.abl.yaml`,
        content: file.content,
      };
    }
  }
  return files;
}

function normalizeMockFilePaths(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    return [];
  }

  return value.files
    .filter(isRecord)
    .map((file) => (typeof file.path === 'string' ? file.path : null))
    .filter((path): path is string => path !== null);
}

function normalizeBuildProgress(value: unknown): BuildProgress | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawStage = value.stage;
  // 'tools' is the legacy stage value — normalise to 'agents_complete' for backwards compat
  const stage: BuildProgress['stage'] | undefined =
    rawStage === 'initialized' ||
    rawStage === 'generating' ||
    rawStage === 'agents_complete' ||
    rawStage === 'complete'
      ? rawStage
      : rawStage === 'tools'
        ? 'agents_complete'
        : undefined;

  if (!stage) {
    return null;
  }

  return {
    stage,
    agentStatuses: isRecord(value.agentStatuses)
      ? (value.agentStatuses as BuildProgress['agentStatuses'])
      : {},
    toolStatuses: isRecord(value.toolStatuses)
      ? (value.toolStatuses as BuildProgress['toolStatuses'])
      : {},
  };
}

// --- Quality floor evaluation (kept for pre-create check) ---

export function evaluateQualityFloorIssues(files: Record<string, AgentFileRecord>): QualityIssue[] {
  const agentNames = Object.keys(files);
  const supervisorAgentName = agentNames.find((name) => {
    const content = files[name]?.content ?? '';
    return /^\s*SUPERVISOR\s*:/m.test(content);
  });

  const issues: QualityIssue[] = [];
  for (const agentName of agentNames) {
    const dsl = files[agentName]?.content ?? '';
    const isSupervisor = /^\s*SUPERVISOR\s*:/m.test(dsl);

    if (!supervisorAgentName && agentName === agentNames[0] && !isSupervisor) {
      issues.push({
        agent: agentName,
        issue: 'Entry agent should use SUPERVISOR: keyword for routing',
      });
    }

    if (!/GUARDRAILS:/m.test(dsl)) {
      issues.push({ agent: agentName, issue: renderMissingGuardrailsWarning() });
    }
    if (!isSupervisor && !/TOOLS:/m.test(dsl)) {
      issues.push({ agent: agentName, issue: renderMissingToolsWarning() });
    }
    if (!/MEMORY:/m.test(dsl)) {
      issues.push({ agent: agentName, issue: renderMissingMemoryWarning() });
    }
    if (isSupervisor && !/WHEN:\s*(?:true|["']true["'])/m.test(dsl)) {
      issues.push({
        agent: agentName,
        issue: renderSupervisorCatchAllHandoffWarning(),
      });
    }
  }

  return issues;
}

// --- Resume derivation ---

function normalizePendingInteraction(session: ArchSession): ResumePendingState | null {
  const interaction = session.metadata.pendingInteraction;
  if (!interaction) {
    return null;
  }

  if (interaction.kind === 'widget') {
    return { kind: 'widget', interaction: interaction as PendingWidgetInteraction };
  }

  // Any other kind (old gate data in DB) is treated as stale
  return null;
}

function getLastDurableCheckpoint(
  session: ArchSession,
  pending: ResumePendingState | null,
): ResumeCheckpoint {
  if (
    pending?.kind === 'widget' ||
    session.metadata.messages.length > 0 ||
    session.metadata.pendingMutation ||
    session.metadata.pendingPlan
  ) {
    return 'message_appended';
  }

  if (
    Object.keys(normalizeFiles(session.metadata.files)).length > 0 ||
    normalizeMockFilePaths(session.metadata.mockServer).length > 0
  ) {
    return 'artifact_persisted';
  }

  if (
    session.metadata.phase !== 'INTERVIEW' ||
    session.metadata.topologyApproved === true ||
    getLockedTopologyFromMetadata(session.metadata) !== null
  ) {
    return 'phase_transition';
  }

  return 'unknown';
}

function getContinueAction(session: ArchSession): ResumeNextAction {
  const metadata = session.metadata;
  const draftTopology = getDraftTopologyFromMetadata(metadata);
  const lockedTopology = getLockedTopologyFromMetadata(metadata);
  const topology = lockedTopology ?? draftTopology;
  const files = normalizeFiles(metadata.files);
  const buildProgress = normalizeBuildProgress(metadata.buildProgress);
  const blueprintStage = asBlueprintStage(metadata.blueprintStage);

  if (metadata.pendingMutation) {
    const reviewStatus = metadata.pendingMutation.reviewStatus ?? 'pending';
    return {
      type: 'review_mutation',
      target: metadata.pendingMutation.target,
      reviewStatus,
    };
  }

  if (metadata.pendingPlan && ['proposed', 'refining'].includes(metadata.pendingPlan.status)) {
    return {
      type: 'review_plan',
      planId: metadata.pendingPlan.id,
      status: metadata.pendingPlan.status,
    };
  }

  if (metadata.activeIntegrationDraftId) {
    return {
      type: 'send_message',
      reason: 'Resume the unfinished integration draft.',
    };
  }

  if (metadata.phase === 'BUILD') {
    if (!buildProgress || buildProgress.stage === 'initialized') {
      const topologyAgents = topology?.agents ?? [];
      const pendingAgents = topologyAgents.map((a) => a.name).filter((name) => !(name in files));

      return {
        type: 'continue_phase',
        phase: 'BUILD',
        reason: 'Build is ready to start. Choose the next build step.',
        pendingAgents: pendingAgents.length > 0 ? pendingAgents : undefined,
      };
    }

    if (buildProgress.stage === 'generating') {
      const topologyAgents = topology?.agents ?? [];
      const pendingAgents = topologyAgents.map((a) => a.name).filter((name) => !(name in files));

      return {
        type: 'continue_phase',
        phase: 'BUILD',
        reason:
          pendingAgents.length > 0
            ? 'Continue generating the remaining agent files.'
            : 'Continue agent generation.',
        pendingAgents: pendingAgents.length > 0 ? pendingAgents : undefined,
      };
    }

    if (buildProgress.stage === 'agents_complete') {
      // All agents compiled; completion card is pending — surface create_project.
      // Any pending widget interaction is handled at the outer snapshot level
      // in buildResumeSnapshot before getContinueAction is called.
      return {
        type: 'create_project',
        reason: 'All agents built, project creation pending.',
      };
    }

    return {
      type: 'create_project',
      reason: 'All agents and tools generated. Create the project.',
    };
  }

  if (metadata.phase === 'BLUEPRINT' && lockedTopology) {
    return {
      type: 'continue_phase',
      phase: 'BLUEPRINT',
      reason: 'The topology is locked and ready for Build.',
    };
  }

  if (metadata.phase === 'BLUEPRINT' && draftTopology) {
    return {
      type: 'continue_phase',
      phase: 'BLUEPRINT',
      reason:
        blueprintStage === 'revising'
          ? 'Review the revised draft topology and decide whether to accept or change it.'
          : 'Review the draft topology and decide whether to accept or change it.',
    };
  }

  if (metadata.phase === 'BLUEPRINT') {
    return {
      type: 'continue_phase',
      phase: 'BLUEPRINT',
      reason: 'Blueprint concept is ready for refinement or draft generation.',
    };
  }

  if (metadata.phase === 'CREATE') {
    return {
      type: 'create_project',
      reason: 'Create the project from the generated agents.',
    };
  }

  if (session.state === 'ACTIVE') {
    return {
      type: 'send_message',
      reason: 'The last turn was interrupted. Send a new message to continue.',
    };
  }

  return {
    type: 'send_message',
    reason: 'Send the next message to continue.',
  };
}

export function buildResumeSnapshot(session: ArchSession): ResumeSnapshot {
  const metadata = session.metadata;
  const topology = getEffectiveTopologyFromMetadata(metadata);
  const lockedTopology = getLockedTopologyFromMetadata(metadata);
  const blueprintStage = asBlueprintStage(metadata.blueprintStage) ?? undefined;
  const files = normalizeFiles(metadata.files);
  const buildProgress = normalizeBuildProgress(metadata.buildProgress);
  const mockFilePaths = normalizeMockFilePaths(metadata.mockServer);

  const pending: ResumePendingState | null =
    normalizePendingInteraction(session) ??
    (metadata.pendingMutation
      ? { kind: 'mutation', mutation: metadata.pendingMutation }
      : metadata.pendingPlan && ['proposed', 'refining'].includes(metadata.pendingPlan.status)
        ? { kind: 'plan', plan: metadata.pendingPlan }
        : null);

  let nextAction: ResumeNextAction;
  if (pending?.kind === 'widget') {
    nextAction = { type: 'answer_widget', interaction: pending.interaction };
  } else if (pending?.kind === 'mutation') {
    nextAction = {
      type: 'review_mutation',
      target: pending.mutation.target,
      reviewStatus: pending.mutation.reviewStatus ?? 'pending',
    };
  } else if (pending?.kind === 'plan') {
    nextAction = {
      type: 'review_plan',
      planId: pending.plan.id,
      status: pending.plan.status,
    };
  } else {
    nextAction = getContinueAction(session);
  }

  const wasInterrupted =
    session.state === 'ACTIVE' &&
    metadata.pendingInteraction === null &&
    metadata.pendingMutation == null &&
    (metadata.pendingPlan == null ||
      !['proposed', 'refining'].includes(metadata.pendingPlan.status));
  const canSendMessage = session.state !== 'ARCHIVED' && session.state !== 'COMPLETE';

  return {
    phase: metadata.phase,
    state: session.state,
    canSendMessage,
    pending,
    nextAction,
    interruption: {
      wasInterrupted,
      lastDurableCheckpoint: getLastDurableCheckpoint(session, pending),
      canContinueByMessage: canSendMessage,
    },
    artifacts: {
      topology: {
        exists: topology !== null,
        approved: lockedTopology !== null || metadata.topologyApproved === true,
        stage: blueprintStage,
        locked: lockedTopology !== null,
        agentCount: topology?.agents.length ?? 0,
        edgeCount: topology?.edges.length ?? 0,
        entryPoint: topology?.entryPoint,
      },
      files: {
        count: Object.keys(files).length,
        names: Object.keys(files),
        mockFileCount: mockFilePaths.length,
        mockFilePaths,
      },
      buildProgress,
      pendingMutation: metadata.pendingMutation
        ? {
            target: metadata.pendingMutation.target,
            reviewStatus: metadata.pendingMutation.reviewStatus ?? 'pending',
            isNew: metadata.pendingMutation.isNew ?? false,
          }
        : null,
      pendingPlan: metadata.pendingPlan
        ? {
            id: metadata.pendingPlan.id,
            title: metadata.pendingPlan.title,
            status: metadata.pendingPlan.status,
            affectedAgents: metadata.pendingPlan.affectedAgents,
            plannedMutations: metadata.pendingPlan.plannedMutations,
          }
        : null,
      integrationDraft: metadata.activeIntegrationDraftId
        ? { id: metadata.activeIntegrationDraftId }
        : null,
    },
  };
}
