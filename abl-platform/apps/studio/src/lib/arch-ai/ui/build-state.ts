import type { ArchSession } from '@agent-platform/arch-ai/types';
import {
  useArchAIStore,
  type BuildAgentState,
  type BuildAgentUIStatus,
  type BuildState,
} from '@/lib/arch-ai/store/arch-ai-store';
import { getLockedTopology } from '@/lib/arch-ai/blueprint-flow';

type PersistedBuildProgress = {
  stage?: string;
  agentStatuses?: Record<string, string>;
} | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBuildCompleteWidgetPayload(value: unknown): boolean {
  return isRecord(value) && value.widgetType === 'BuildComplete';
}

export function isBuildExecutionActive(phase: BuildState['phase']): boolean {
  return phase === 'generating' || phase === 'validating';
}

export function mapPersistedBuildStatusToUi(status: string | undefined): BuildAgentUIStatus {
  switch (status) {
    case 'generated':
    case 'pending':
      return 'queued';
    case 'parsed':
      return 'parsed';
    case 'validated':
    case 'compiled':
      return 'validated';
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'queued';
  }
}

function makeBuildAgentState(status: BuildAgentUIStatus): BuildAgentState {
  return {
    status,
    errors: [],
    warnings: [],
    toolCount: 0,
    handoffCount: 0,
  };
}

function computeSummary(
  agents: Record<string, BuildAgentState>,
): NonNullable<BuildState['summary']> {
  const values = Object.values(agents);
  return {
    total: values.length,
    compiled: values.filter(
      (agent) =>
        agent.status === 'validated' || agent.status === 'compiled' || agent.status === 'warning',
    ).length,
    warnings: values.filter((agent) => agent.status === 'warning').length,
    errors: values.filter((agent) => agent.status === 'error').length,
  };
}

export function deriveBuildStateFromSession(session: ArchSession | null): BuildState {
  if (!session || session.metadata.phase !== 'BUILD') {
    return { phase: 'idle', agents: {}, summary: null, log: [] };
  }

  const topology =
    getLockedTopology(session) ??
    (session.metadata.topology as { agents?: Array<{ name?: string }> } | undefined);
  const topologyNames =
    topology?.agents
      ?.map((agent) => (typeof agent.name === 'string' ? agent.name : null))
      .filter((name): name is string => name !== null) ?? [];
  const buildProgress =
    (session.metadata.buildProgress as PersistedBuildProgress | undefined) ?? null;
  const persistedStatuses = buildProgress?.agentStatuses ?? {};
  const knownNames =
    topologyNames.length > 0 ? topologyNames : Object.keys(persistedStatuses ?? {});

  const agents: Record<string, BuildAgentState> = {};
  for (const name of knownNames) {
    agents[name] = makeBuildAgentState(mapPersistedBuildStatusToUi(persistedStatuses[name]));
  }

  const pendingPayload =
    session.metadata.pendingInteraction?.kind === 'widget'
      ? session.metadata.pendingInteraction.payload
      : null;
  const isComplete =
    buildProgress?.stage === 'agents_complete' ||
    buildProgress?.stage === 'complete' ||
    isBuildCompleteWidgetPayload(pendingPayload);

  if (isComplete) {
    return {
      phase: 'complete',
      agents,
      summary: computeSummary(agents),
      log: [],
    };
  }

  return {
    phase: buildProgress?.stage === 'generating' ? 'generating' : 'ready',
    agents,
    summary: null,
    log: [],
  };
}

export function syncBuildStateFromSession(session: ArchSession | null): void {
  useArchAIStore.getState().setBuildState(deriveBuildStateFromSession(session));
}
