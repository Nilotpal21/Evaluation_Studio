import { createLogger } from '@abl/compiler/platform';
import {
  ArchJournal,
  ArchProjectMemory,
  ArchSpecDocument,
  Project,
  ProjectAgent,
  ProjectConfigVariable,
} from '@agent-platform/database/models';
import { buildProjectAgentPath } from '@agent-platform/shared';
import mongoose from 'mongoose';
import { renderArchManagedBehaviorProfiles } from './blueprint/managed-profiles.js';
import { JournalService } from './journal/index.js';
import { ProjectMemoryService, SessionService, type ArchFileStore } from './session/index.js';
import { SpecDocumentService } from './spec-document/index.js';
import { ArchSessionModel } from './models/index.js';
import { buildSkeleton, type AgentContext } from './generation/index.js';
import type {
  ArchContentBlock,
  ArchSSEEvent,
  ArchSession,
  TopologyAgent,
  TopologyOutput,
} from './types/index.js';
import { ToolRegistry } from './tools/index.js';
import type { TurnBuffer, TurnEngine } from './engine/index.js';
import type {
  ProcessMessageBuildResult,
  ProcessMessageDeps,
  ProcessMessageModelResolution,
} from './processors/process-message.js';

const log = createLogger('arch-ai:system-agent-process-deps');
const DEFAULT_DELEGATE_GATHER_PROMPT = 'Could you share the details I should use?';
const BEHAVIOR_PROFILE_CONFIG_KEY_PREFIX = 'profile:';
const ARCH_MANAGED_BEHAVIOR_PROFILE_KEYS = renderArchManagedBehaviorProfiles().map((profile) =>
  behaviorProfileNameToConfigKey(profile.name),
);

const sessionService = new SessionService(ArchSessionModel);
const journalService = new JournalService(ArchJournal);
const specDocumentService = new SpecDocumentService(
  ArchSpecDocument,
  ArchSessionModel,
  mongoose.connection,
);
const projectMemoryService = new ProjectMemoryService(ArchProjectMemory);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getTopology(session: ArchSession): TopologyOutput {
  const topology = session.metadata.lockedTopology ?? session.metadata.topology;
  if (!isRecord(topology) || !Array.isArray(topology.agents)) {
    throw new Error('Approved topology is missing from Arch session');
  }
  return topology as unknown as TopologyOutput;
}

function extractGoal(content: string): string | undefined {
  return (
    content.match(/^GOAL:\s*"([^"]+)"/m)?.[1]?.trim() ??
    content.match(/^GOAL:\s*'([^']+)'/m)?.[1]?.trim()
  );
}

function getAgentContext(topology: TopologyOutput, agent: TopologyAgent): AgentContext {
  const outgoing = topology.edges.filter((edge) => edge.from === agent.name);
  const incoming = topology.edges.filter((edge) => edge.to === agent.name);
  const isEntrySupervisor = topology.entryPoint === agent.name && outgoing.length > 0;
  const type: AgentContext['type'] = isEntrySupervisor
    ? 'supervisor'
    : agent.executionMode === 'scripted'
      ? 'scripted'
      : agent.executionMode === 'hybrid'
        ? 'hybrid'
        : 'specialist';

  return {
    name: agent.name,
    type,
    role: agent.role || agent.description || 'Assist users',
    domain: agent.description,
    modelPolicy: agent.modelPolicy,
    tools: agent.tools?.map((toolName) => ({
      name: toolName,
      description: `${toolName} project tool`,
    })),
    handoffTargets: outgoing.map((edge) => ({
      name: edge.to,
      returnExpected: edge.expectReturn !== false,
      experienceMode: edge.experienceMode,
    })),
    handoffSources: incoming.map((edge) => edge.from),
  };
}

function replacePlaceholders(value: string, replacements: Record<string, string>): string {
  let result = value;
  for (const [placeholder, replacement] of Object.entries(replacements)) {
    result = result.split(placeholder).join(replacement);
  }
  return result;
}

function buildDeterministicAbl(topology: TopologyOutput, agent: TopologyAgent): string {
  const context = getAgentContext(topology, agent);
  const skeleton = buildSkeleton(context);
  const goal = `${agent.role || 'Help the user'} for ${agent.name}`;
  const persona =
    agent.description ||
    `You are ${agent.name}. Handle your assigned responsibilities clearly and concisely.`;

  return replacePlaceholders(skeleton, {
    '{{goal_placeholder}}': goal.replaceAll('"', "'"),
    '{{persona_placeholder}}': persona,
    '{{customer_prompt}}': DEFAULT_DELEGATE_GATHER_PROMPT,
  });
}

function behaviorProfileNameToConfigKey(profileName: string): string {
  return `${BEHAVIOR_PROFILE_CONFIG_KEY_PREFIX}${profileName}`;
}

export function buildManagedBehaviorProfileConfigVariables(
  topology: TopologyOutput,
): Array<{ key: string; value: string }> {
  const usesSharedVoiceHandoff = topology.edges.some(
    (edge) => edge.experienceMode === 'shared_voice_handoff',
  );
  if (!usesSharedVoiceHandoff) {
    return [];
  }

  return renderArchManagedBehaviorProfiles().map((profile) => ({
    key: behaviorProfileNameToConfigKey(profile.name),
    value: profile.dslContent,
  }));
}

export function getStaleManagedBehaviorProfileConfigKeys(topology: TopologyOutput): string[] {
  const activeKeys = new Set(
    buildManagedBehaviorProfileConfigVariables(topology).map((profile) => profile.key),
  );
  return ARCH_MANAGED_BEHAVIOR_PROFILE_KEYS.filter((key) => !activeKeys.has(key));
}

async function persistManagedBehaviorProfilesForTopology(
  ctx: { tenantId: string; userId: string },
  projectId: string,
  topology: TopologyOutput,
): Promise<number> {
  const profiles = buildManagedBehaviorProfileConfigVariables(topology);
  const staleManagedKeys = getStaleManagedBehaviorProfileConfigKeys(topology);
  for (const profile of profiles) {
    await ProjectConfigVariable.findOneAndUpdate(
      {
        tenantId: ctx.tenantId,
        projectId,
        key: profile.key,
      },
      {
        $set: {
          value: profile.value,
          updatedBy: ctx.userId,
        },
        $setOnInsert: {
          tenantId: ctx.tenantId,
          projectId,
          key: profile.key,
          description: null,
          createdBy: ctx.userId,
        },
      },
      { upsert: true },
    );
  }
  if (staleManagedKeys.length > 0) {
    await ProjectConfigVariable.deleteMany({
      tenantId: ctx.tenantId,
      projectId,
      key: { $in: staleManagedKeys },
    });
  }
  return profiles.length;
}

async function transitionSessionToIdle(
  service: SessionService,
  ctx: { tenantId: string; userId: string },
  sessionId: string,
  reason: string,
): Promise<void> {
  try {
    await service.transitionState(ctx, sessionId, 'ACTIVE', 'IDLE');
  } catch (err: unknown) {
    log.warn('Unable to transition Arch session to IDLE', {
      sessionId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function closeAndResetIfActive(
  service: SessionService,
  ctx: { tenantId: string; userId: string },
  sessionId: string,
  close: () => void,
  reason: string,
): Promise<void> {
  await transitionSessionToIdle(service, ctx, sessionId, reason);
  close();
}

const emptyFileStore: ArchFileStore = {
  async getByBlobId(): Promise<never> {
    throw new Error('Arch system-agent driver does not support file attachments');
  },
  async getActiveFiles(): Promise<[]> {
    return [];
  },
  async markFailed(): Promise<void> {
    return undefined;
  },
};

function buildNoopTurnEngine(): { engine: TurnEngine; toolRegistry: ToolRegistry } {
  return {
    engine: {
      runTurn: async function* (): AsyncIterable<never> {},
    } as unknown as TurnEngine,
    toolRegistry: new ToolRegistry(),
  };
}

async function runDeterministicGeneration(
  agentNames: string[],
  ctx: { tenantId: string; userId: string },
  session: ArchSession,
  emit: (event: ArchSSEEvent) => void,
): Promise<ProcessMessageBuildResult[]> {
  const topology = getTopology(session);
  const requested = new Set(agentNames);
  const files: Record<string, { path: string; content: string }> = {};
  const results: ProcessMessageBuildResult[] = [];
  const agentStatuses: Record<string, 'compiled' | 'warning' | 'error'> = {};

  for (const agent of topology.agents) {
    if (!requested.has(agent.name)) {
      continue;
    }

    emit({
      type: 'build_agent_start',
      agent: agent.name,
      role: agent.role || agent.description || 'Assist users',
      mode: agent.executionMode,
    });
    const content = buildDeterministicAbl(topology, agent);
    files[agent.name] = { path: `${agent.name}.abl`, content };
    agentStatuses[agent.name] = 'compiled';
    results.push({
      agentName: agent.name,
      status: 'compiled',
      warnings: [],
      errors: [],
      mode: agent.executionMode,
      agentType: topology.entryPoint === agent.name ? 'entry' : 'specialist',
      toolCount: 0,
      handoffCount: topology.edges.filter((edge) => edge.from === agent.name).length,
      quality: {
        guardrails: true,
        memory: true,
        errorHandlers: false,
        constraints: false,
        catchAllHandoff: topology.entryPoint === agent.name,
      },
      elapsed: 0,
    });
    emit({
      type: 'build_agent_compiled',
      agent: agent.name,
      mode: agent.executionMode,
      warnings: [],
      elapsed: 0,
      agentType: topology.entryPoint === agent.name ? 'entry' : 'specialist',
      toolCount: 0,
      handoffCount: topology.edges.filter((edge) => edge.from === agent.name).length,
      quality: {
        guardrails: true,
        memory: true,
        errorHandlers: false,
        constraints: false,
        catchAllHandoff: topology.entryPoint === agent.name,
      },
    });
  }

  const setPatch: Record<string, unknown> = {
    'metadata.buildProgress': {
      stage: 'complete',
      agentStatuses,
      toolStatuses: {},
    },
  };
  for (const [agentName, file] of Object.entries(files)) {
    setPatch[`metadata.files.${agentName}`] = file;
  }

  await ArchSessionModel.updateOne(
    {
      _id: session.id,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      'metadata.projectId': session.metadata.projectId,
      state: { $ne: 'ARCHIVED' },
    },
    { $set: setPatch },
  );

  return results;
}

function buildCompletionSummary(results: ProcessMessageBuildResult[]): string {
  return `${results.length} agent${results.length === 1 ? '' : 's'} built: ${results
    .map((result) => result.agentName)
    .join(', ')}`;
}

function buildCompletionWidgetPayload(
  results: ProcessMessageBuildResult[],
  projectName?: string,
): Record<string, unknown> {
  return {
    widgetType: 'BuildComplete',
    question: projectName
      ? `${projectName} is ready to create.`
      : 'The generated agents are ready to create.',
    agents: results,
    stats: {
      total: results.length,
      compiled: results.length,
      warnings: 0,
      errors: 0,
      toolCount: 0,
      elapsedMs: 0,
    },
    projectName,
    options: [{ label: 'Create project', value: 'create' }],
    allowCustom: false,
  };
}

function extractBuildResultsFromPendingWidgetPayload(
  payload: Record<string, unknown>,
): ProcessMessageBuildResult[] {
  return Array.isArray(payload.agents)
    ? (payload.agents.filter(isRecord) as unknown as ProcessMessageBuildResult[])
    : [];
}

async function finalizeIntoRuntimeProject(
  projectId: string,
  ctx: { tenantId: string; userId: string },
  session: ArchSession,
  emit: (event: ArchSSEEvent) => void,
  close: () => void,
): Promise<void> {
  const project = await Project.findOne({ _id: projectId, tenantId: ctx.tenantId }).lean();
  if (!project) {
    emit({
      type: 'error',
      code: 'PROJECT_NOT_FOUND',
      message: 'Target project was not found for this tenant.',
      retryable: false,
    });
    await transitionSessionToIdle(sessionService, ctx, session.id, 'runtime_project_missing');
    close();
    return;
  }

  const agentFiles = (session.metadata.files ?? {}) as Record<
    string,
    { path: string; content: string }
  >;
  const persistedAgents: Array<{ name: string; status: 'saved' }> = [];

  for (const [agentName, file] of Object.entries(agentFiles)) {
    await ProjectAgent.findOneAndUpdate(
      { tenantId: ctx.tenantId, projectId, name: agentName },
      {
        $set: {
          tenantId: ctx.tenantId,
          projectId,
          name: agentName,
          agentPath: buildProjectAgentPath(projectId, agentName),
          dslContent: file.content,
          description: extractGoal(file.content) ?? null,
          ownerId: ctx.userId,
          lastEditedBy: ctx.userId,
          lastEditedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );
    persistedAgents.push({ name: agentName, status: 'saved' });
  }

  const topology = getTopology(session);
  const profileCount = await persistManagedBehaviorProfilesForTopology(ctx, projectId, topology);
  if (profileCount > 0) {
    log.info('Persisted managed behavior profiles for system-agent project', {
      projectId,
      profileCount,
    });
  }

  await Project.updateOne(
    { _id: projectId, tenantId: ctx.tenantId },
    { $set: { entryAgentName: topology.entryPoint ?? persistedAgents[0]?.name ?? null } },
  );

  await ArchSessionModel.updateOne(
    { _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId },
    {
      $set: {
        state: 'ARCHIVED',
        archivedAt: new Date(),
        'metadata.phase': 'CREATE',
        'metadata.projectId': projectId,
      },
    },
  );

  emit({
    type: 'tool_result',
    toolCallId: 'create_project',
    result: {
      success: true,
      projectId,
      results: persistedAgents,
      stats: {
        total: persistedAgents.length,
        saved: persistedAgents.length,
        failed: 0,
      },
    },
  });
  emit({ type: 'done' });
  close();
}

export function createSystemAgentProcessMessageDeps(projectId: string): ProcessMessageDeps {
  return {
    sessionService,
    journalService,
    specDocumentService,
    projectMemoryService,
    fileStoreService: emptyFileStore,
    resolveModel: async (): Promise<ProcessMessageModelResolution> => ({ model: {} }),
    createTurnEngine: async () => buildNoopTurnEngine(),
    buildServiceBagForTurn: (_buffer: TurnBuffer) => ({}),
    buildSuggestionGenerator: () => async () => [],
    buildTurnPlanLoaders: () => ({}),
    augmentUserInputWithFileRefs: async (_ctx, _sessionId, userText) => userText,
    buildUserContentFromFileRefs: async (): Promise<ArchContentBlock[] | undefined> => undefined,
    transitionSessionToIdle,
    closeAndResetIfActive,
    projectExistsByName: async () => false,
    finalizeProject: (ctx, session, emit, close) =>
      finalizeIntoRuntimeProject(projectId, ctx, session, emit, close),
    runParallelGeneration: runDeterministicGeneration,
    buildCompletionSummary,
    buildCompletionWidgetPayload,
    extractBuildResultsFromPendingWidgetPayload,
    handleBuildAction: async (answer) => {
      if (answer === 'create') {
        return { continueToLLM: false };
      }
      return { continueToLLM: false };
    },
    executePhaseTransition: async (ctx, session, service) => {
      await service.updatePhase(ctx, session.id, 'BUILD');
      return { transitioned: true, to: 'BUILD' };
    },
  };
}
