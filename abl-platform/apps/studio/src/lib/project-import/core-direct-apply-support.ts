import {
  COMPLETED_OPERATION_TTL_SECONDS,
  EvalEvaluator,
  EvalPersona,
  EvalScenario,
  EvalSet,
  ImportOperation,
  type IEvalEvaluator,
  type IEvalPersona,
  type IEvalScenario,
  type IEvalSet,
  type IImportOperation,
  type IMCPServerConfig,
  MCPServerConfig,
  PromptLibraryItem,
  PromptLibraryVersion,
  Project,
  ProjectAgent,
  ProjectConfigVariable,
  AgentModelConfig,
  ModelConfig,
  TenantModel,
  ProjectLLMConfig,
  ProjectRuntimeConfig,
  type IProjectAgent,
  type IProjectTool,
  ProjectTool,
  type ProjectToolType,
} from '@agent-platform/database/models';
import {
  type ProjectAgentDraftMetadata,
  type ProjectAgentDraftState,
} from '@agent-platform/project-io';
import { buildProjectAgentPath } from '@agent-platform/shared';
import {
  behaviorProfileConfigKeyToName,
  behaviorProfileNameToConfigKey,
  MCP_SERVER_CONFIG_EXPORT_SELECT,
  buildCoreImportExistingStateV2,
  localeAssetRelativePathToConfigKey,
  normalizeMcpServerConfigForIO,
  stripModelPolicyImportMetadata,
  type ProjectIOMcpServerConfig,
  type CoreImportApplyAdapterV2,
  type CoreImportStoreV2,
  type CoreImportOperationStatusV2,
  type CoreImportOperationStoreV2,
  type CoreImportSnapshotStateV2,
  sanitizeEvalImportData,
  type CoreImportAgentWriteOperationV2,
  type ExistingProjectStateV2,
  type CoreImportCreatedEvalIdsV2,
  type CoreImportEvalCollectionV2,
  type CoreImportEvalEntityStateV2,
  type CoreImportEvalOperationV2,
  type CoreImportEvalSetStateV2,
  type CoreImportEvalWriteOperationV2,
} from '@agent-platform/project-io/import';
import { listProjectLocalizationAssets } from '@/lib/localization-assets';
import { evaluateStudioProjectAgentDrafts } from '@/lib/abl/project-agent-draft-metadata';
import { getOrCreateDefaultVariableNamespaceIds } from '@/lib/default-variable-namespace';

interface StudioCoreImportAdapterParams {
  projectId: string;
  tenantId: string;
  userId: string;
  now?: Date;
}

const EVAL_COLLECTION_MODELS = {
  eval_sets: EvalSet,
  eval_scenarios: EvalScenario,
  eval_personas: EvalPersona,
  eval_evaluators: EvalEvaluator,
} as const;

const EVAL_COLLECTION_NAME_FIELD = 'name';

function toProjectAgentDraftState(record: {
  name?: string | null;
  dslContent?: string | null;
  systemPromptLibraryRef?: ProjectAgentDraftState['systemPromptLibraryRef'];
}): ProjectAgentDraftState | null {
  if (typeof record.name !== 'string' || record.name.length === 0) {
    return null;
  }

  return {
    recordName: record.name,
    dslContent: typeof record.dslContent === 'string' ? record.dslContent : null,
    systemPromptLibraryRef: record.systemPromptLibraryRef ?? null,
  };
}

function mergeProjectAgentDraftStates(
  currentAgents: readonly IProjectAgent[],
  operations: readonly CoreImportAgentWriteOperationV2[],
): ProjectAgentDraftState[] {
  const projected = new Map<string, ProjectAgentDraftState>();

  for (const agent of currentAgents) {
    const state = toProjectAgentDraftState(agent);
    if (state) {
      projected.set(state.recordName, state);
    }
  }

  for (const operation of operations) {
    projected.set(operation.agentName, {
      recordName: operation.agentName,
      dslContent: operation.dslContent,
      systemPromptLibraryRef: operation.systemPromptLibraryRef ?? null,
    });
  }

  return [...projected.values()];
}

async function evaluateImportedProjectAgentDrafts(input: {
  projectId: string;
  tenantId: string;
  agents: ProjectAgentDraftState[];
}): Promise<Map<string, ProjectAgentDraftMetadata>> {
  return evaluateStudioProjectAgentDrafts({
    projectId: input.projectId,
    tenantId: input.tenantId,
    agents: input.agents,
    diagnosticSource: 'project-import',
  });
}

async function buildImportedAgentDslMetadataMap(
  params: Pick<StudioCoreImportAdapterParams, 'projectId' | 'tenantId'>,
  agentOperations: CoreImportAgentWriteOperationV2[],
): Promise<Map<string, ProjectAgentDraftMetadata>> {
  const existingAgents = (await ProjectAgent.find({
    projectId: params.projectId,
    tenantId: params.tenantId,
  }).lean()) as IProjectAgent[];

  return evaluateImportedProjectAgentDrafts({
    projectId: params.projectId,
    tenantId: params.tenantId,
    agents: mergeProjectAgentDraftStates(existingAgents, agentOperations),
  });
}

async function refreshPersistedImportedAgentMetadata(params: {
  projectId: string;
  tenantId: string;
}): Promise<void> {
  const existingAgents = (await ProjectAgent.find({
    projectId: params.projectId,
    tenantId: params.tenantId,
  }).lean()) as IProjectAgent[];

  if (existingAgents.length === 0) {
    return;
  }

  const metadataByAgent = await evaluateImportedProjectAgentDrafts({
    projectId: params.projectId,
    tenantId: params.tenantId,
    agents: existingAgents
      .map((agent) => toProjectAgentDraftState(agent))
      .filter((agent): agent is ProjectAgentDraftState => agent !== null),
  });

  await ProjectAgent.bulkWrite(
    existingAgents.map((agent) => {
      const metadata = metadataByAgent.get(agent.name);
      return {
        updateOne: {
          filter: {
            _id: agent._id,
            projectId: params.projectId,
            tenantId: params.tenantId,
          },
          update: {
            $set: {
              sourceHash: metadata?.sourceHash ?? null,
              dslValidationStatus: metadata?.dslValidationStatus ?? null,
              dslDiagnostics: metadata?.dslDiagnostics ?? [],
            },
            $inc: { _v: 1 },
          },
        },
      };
    }),
  );
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

const PROJECT_MODEL_POLICY_REFERENCE_KEYS = new Set([
  'tenantModelId',
  'credentialId',
  'authProfileId',
]);

function sanitizeModelPolicyData(value: unknown): Record<string, unknown> {
  return stripModelPolicyImportMetadata(toRecord(value));
}

function sanitizeProjectModelPolicyData(value: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(sanitizeModelPolicyData(value)).filter(
      ([key]) => !PROJECT_MODEL_POLICY_REFERENCE_KEYS.has(key),
    ),
  );
}

function isRealtimeVoiceProjectModel(data: Record<string, unknown>): boolean {
  return data.tier === 'voice';
}

function hasRealtimeVoiceCapability(model: Record<string, unknown>): boolean {
  return Array.isArray(model.capabilities) && model.capabilities.includes('realtime_voice');
}

async function resolveDestinationTenantModelIdForImport(input: {
  data: Record<string, unknown>;
  tenantId: string;
  modelConfigName: string;
}): Promise<string | null> {
  const provider = typeof input.data.provider === 'string' ? input.data.provider.trim() : '';
  const modelId = typeof input.data.modelId === 'string' ? input.data.modelId.trim() : '';

  if (!provider || !modelId) {
    throw new Error(
      `Project model config "${input.modelConfigName}" must include provider and modelId for portable import binding`,
    );
  }

  const candidates = (await TenantModel.find({
    tenantId: input.tenantId,
    provider,
    modelId,
    isActive: true,
    inferenceEnabled: { $ne: false },
  }).lean()) as Array<Record<string, unknown>>;

  const usable = isRealtimeVoiceProjectModel(input.data)
    ? candidates.filter(hasRealtimeVoiceCapability)
    : candidates;

  if (usable.length !== 1) {
    return null;
  }

  const id = usable[0]._id ?? usable[0].id;
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  return id;
}

function hasOperationTierOverrides(data: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(data, 'operationTierOverrides');
}

function evalEntityState<T extends { name: string }>(entity: T): CoreImportEvalEntityStateV2 {
  return {
    name: entity.name,
    data: sanitizeEvalImportData(toRecord(entity)),
  };
}

function evalSetState(
  evalSet: IEvalSet,
  lookup: {
    scenarios: Map<string, string>;
    personas: Map<string, string>;
    evaluators: Map<string, string>;
  },
): CoreImportEvalSetStateV2 {
  return {
    name: evalSet.name,
    data: sanitizeEvalImportData({
      ...toRecord(evalSet),
      scenarioIds: [],
      personaIds: [],
      evaluatorIds: [],
    }),
    scenarioNames: (evalSet.scenarioIds ?? [])
      .map((id) => lookup.scenarios.get(String(id)))
      .filter((name): name is string => Boolean(name)),
    personaNames: (evalSet.personaIds ?? [])
      .map((id) => lookup.personas.get(String(id)))
      .filter((name): name is string => Boolean(name)),
    evaluatorNames: (evalSet.evaluatorIds ?? [])
      .map((id) => lookup.evaluators.get(String(id)))
      .filter((name): name is string => Boolean(name)),
  };
}

function groupEvalOperationsByCollection<T extends CoreImportEvalOperationV2>(
  operations: T[],
): Map<CoreImportEvalCollectionV2, T[]> {
  const grouped = new Map<CoreImportEvalCollectionV2, T[]>();
  for (const operation of operations) {
    grouped.set(operation.collection, [...(grouped.get(operation.collection) ?? []), operation]);
  }
  return grouped;
}

interface EvalModelLike {
  find(filter: Record<string, unknown>): {
    select(fields: string): { lean(): Promise<Array<{ _id: string; name: string }>> };
  };
  insertMany(records: Array<Record<string, unknown>>): Promise<Array<{ _id: string }>>;
  bulkWrite(operations: Array<Record<string, unknown>>): Promise<unknown>;
  deleteMany(filter: Record<string, unknown>): Promise<unknown>;
}

function evalModel(collection: CoreImportEvalCollectionV2): EvalModelLike {
  return EVAL_COLLECTION_MODELS[collection] as unknown as EvalModelLike;
}

async function verifyProjectModelConfigScope(projectId: string, tenantId: string): Promise<void> {
  const project = await Project.findOne({ _id: projectId, tenantId }).select('_id').lean();
  if (!project) {
    throw new Error('Project not found for tenant-scoped model config import');
  }
}

async function loadProjectModelConfigs(projectId: string, tenantId: string) {
  await verifyProjectModelConfigScope(projectId, tenantId);
  return ModelConfig.find({ projectId, tenantId }).lean() as Promise<
    Array<Record<string, unknown>>
  >;
}

function buildPromptBundles(
  promptItems: Array<{
    _id?: string;
    name?: string;
    description?: string;
    tags?: string[];
    status?: 'active' | 'archived';
    nextVersionNumber?: number;
  }>,
  promptVersions: Array<{
    _id?: string;
    promptId?: string;
    versionNumber?: number;
    template?: string;
    variables?: string[];
    description?: string;
    status?: 'draft' | 'active' | 'archived';
    sourceHash?: string;
    metadata?: Record<string, unknown> | null;
    publishedAt?: Date | null;
  }>,
) {
  const versionsByPromptId = new Map<
    string,
    Array<{
      versionId: string;
      versionNumber: number;
      template: string;
      variables: string[];
      description?: string;
      status: 'draft' | 'active' | 'archived';
      sourceHash: string;
      metadata?: Record<string, unknown>;
      publishedAt?: string;
    }>
  >();

  for (const version of promptVersions) {
    if (
      typeof version._id !== 'string' ||
      typeof version.promptId !== 'string' ||
      typeof version.versionNumber !== 'number' ||
      typeof version.template !== 'string' ||
      typeof version.sourceHash !== 'string'
    ) {
      continue;
    }

    versionsByPromptId.set(version.promptId, [
      ...(versionsByPromptId.get(version.promptId) ?? []),
      {
        versionId: version._id,
        versionNumber: version.versionNumber,
        template: version.template,
        variables: Array.isArray(version.variables) ? version.variables : [],
        ...(typeof version.description === 'string' ? { description: version.description } : {}),
        status: version.status ?? 'draft',
        sourceHash: version.sourceHash,
        ...(version.metadata && typeof version.metadata === 'object'
          ? { metadata: version.metadata }
          : {}),
        ...(version.publishedAt instanceof Date
          ? { publishedAt: version.publishedAt.toISOString() }
          : {}),
      },
    ]);
  }

  return promptItems
    .map((item) => {
      if (typeof item._id !== 'string' || typeof item.name !== 'string') {
        return null;
      }

      return {
        promptId: item._id,
        name: item.name,
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        tags: Array.isArray(item.tags) ? item.tags : [],
        status: item.status ?? 'active',
        nextVersionNumber: item.nextVersionNumber ?? 0,
        versions: (versionsByPromptId.get(item._id) ?? []).sort(
          (left, right) => left.versionNumber - right.versionNumber,
        ),
      };
    })
    .filter((bundle): bundle is NonNullable<typeof bundle> => bundle !== null);
}

export async function loadStudioCoreImportState(
  projectId: string,
  tenantId: string,
): Promise<{
  currentState: CoreImportSnapshotStateV2;
  existingState: ExistingProjectStateV2;
}> {
  const [
    existingAgents,
    existingPromptItems,
    existingPromptVersions,
    existingTools,
    existingMcpServers,
    existingLocales,
    existingProfileDocs,
    existingRuntimeConfig,
    existingLlmConfig,
    existingProjectModelConfigs,
    existingAgentModelConfigs,
    existingEvalSets,
    existingEvalScenarios,
    existingEvalPersonas,
    existingEvalEvaluators,
    project,
  ] = await Promise.all([
    ProjectAgent.find({ projectId, tenantId }).lean() as Promise<IProjectAgent[]>,
    PromptLibraryItem.find({ projectId, tenantId }).lean() as Promise<
      Array<{
        _id?: string;
        name?: string;
        description?: string;
        tags?: string[];
        status?: 'active' | 'archived';
        nextVersionNumber?: number;
      }>
    >,
    PromptLibraryVersion.find({ projectId, tenantId }).lean() as Promise<
      Array<{
        _id?: string;
        promptId?: string;
        versionNumber?: number;
        template?: string;
        variables?: string[];
        description?: string;
        status?: 'draft' | 'active' | 'archived';
        sourceHash?: string;
        metadata?: Record<string, unknown> | null;
        publishedAt?: Date | null;
      }>
    >,
    ProjectTool.find({ projectId, tenantId }).lean() as Promise<IProjectTool[]>,
    MCPServerConfig.find({ projectId, tenantId })
      .select(MCP_SERVER_CONFIG_EXPORT_SELECT)
      .lean() as Promise<
      Array<
        Partial<ProjectIOMcpServerConfig> & Pick<ProjectIOMcpServerConfig, 'name' | 'transport'>
      >
    >,
    listProjectLocalizationAssets(projectId, tenantId),
    ProjectConfigVariable.find({
      projectId,
      tenantId,
      key: /^profile:/,
    })
      .select('key value')
      .lean() as Promise<Array<{ key: string; value: string }>>,
    ProjectRuntimeConfig.findOne({ projectId, tenantId }).lean() as Promise<Record<
      string,
      unknown
    > | null>,
    ProjectLLMConfig.findOne({ projectId, tenantId }).lean() as Promise<Record<
      string,
      unknown
    > | null>,
    loadProjectModelConfigs(projectId, tenantId),
    AgentModelConfig.find({ projectId, tenantId }).lean() as Promise<
      Array<Record<string, unknown>>
    >,
    EvalSet.find({ projectId, tenantId }).lean() as Promise<IEvalSet[]>,
    EvalScenario.find({ projectId, tenantId }).lean() as Promise<IEvalScenario[]>,
    EvalPersona.find({ projectId, tenantId }).lean() as Promise<IEvalPersona[]>,
    EvalEvaluator.find({ projectId, tenantId }).lean() as Promise<IEvalEvaluator[]>,
    Project.findOne({ _id: projectId, tenantId }).select('entryAgentName').lean(),
  ]);

  const existingProfiles = existingProfileDocs
    .map((doc) => {
      const name = behaviorProfileConfigKeyToName(doc.key);
      return name ? { name, dslContent: doc.value } : null;
    })
    .filter((profile): profile is { name: string; dslContent: string } => profile !== null);
  const evalScenarioNames = new Map(
    existingEvalScenarios.map((scenario) => [String(scenario._id), scenario.name]),
  );
  const evalPersonaNames = new Map(
    existingEvalPersonas.map((persona) => [String(persona._id), persona.name]),
  );
  const evalEvaluatorNames = new Map(
    existingEvalEvaluators.map((evaluator) => [String(evaluator._id), evaluator.name]),
  );

  const currentState: CoreImportSnapshotStateV2 = {
    agents: existingAgents.map((agent) => ({
      name: agent.name,
      dslContent: agent.dslContent,
      description: agent.description ?? null,
      systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
    })),
    prompts: buildPromptBundles(existingPromptItems, existingPromptVersions),
    tools: existingTools.map((tool) => ({
      name: tool.name,
      dslContent: tool.dslContent,
      description: tool.description ?? null,
    })),
    mcpServers: existingMcpServers.map((server) => normalizeMcpServerConfigForIO(server)),
    locales: existingLocales.map((asset) => ({
      relativePath: asset.relativePath,
      value: asset.value,
      description: asset.description,
    })),
    profiles: existingProfiles,
    ...(existingRuntimeConfig
      ? { runtimeConfig: sanitizeModelPolicyData(existingRuntimeConfig) }
      : {}),
    ...(existingLlmConfig ? { llmConfig: sanitizeModelPolicyData(existingLlmConfig) } : {}),
    projectModelConfigs: existingProjectModelConfigs
      .map((config) => {
        const data = sanitizeProjectModelPolicyData(config);
        const name = typeof data.name === 'string' ? data.name : null;
        return name ? { name, data } : null;
      })
      .filter(
        (config): config is { name: string; data: Record<string, unknown> } => config !== null,
      ),
    agentModelConfigs: existingAgentModelConfigs
      .map((config) => {
        const data = sanitizeModelPolicyData(config);
        const agentName = typeof data.agentName === 'string' ? data.agentName : null;
        return agentName ? { agentName, data } : null;
      })
      .filter(
        (config): config is { agentName: string; data: Record<string, unknown> } => config !== null,
      ),
    evalSets: existingEvalSets.map((evalSet) =>
      evalSetState(evalSet, {
        scenarios: evalScenarioNames,
        personas: evalPersonaNames,
        evaluators: evalEvaluatorNames,
      }),
    ),
    evalScenarios: existingEvalScenarios.map(evalEntityState),
    evalPersonas: existingEvalPersonas.map(evalEntityState),
    evalEvaluators: existingEvalEvaluators.map(evalEntityState),
    entryAgentName: project?.entryAgentName ?? null,
  };

  return {
    currentState,
    existingState: buildCoreImportExistingStateV2(currentState),
  };
}

export function buildStudioCoreExistingState(
  existingAgents: IProjectAgent[],
  existingTools: IProjectTool[],
  existingMcpServers: Array<
    Partial<ProjectIOMcpServerConfig> & Pick<ProjectIOMcpServerConfig, 'name' | 'transport'>
  > = [],
  existingLocales: Array<{
    relativePath: string;
    value: string;
    description?: string | null;
  }> = [],
  existingProfiles: Array<{
    name: string;
    dslContent: string;
  }> = [],
  existingEvalSets: IEvalSet[] = [],
  existingEvalScenarios: IEvalScenario[] = [],
  existingEvalPersonas: IEvalPersona[] = [],
  existingEvalEvaluators: IEvalEvaluator[] = [],
  existingPrompts: ReturnType<typeof buildPromptBundles> = [],
): ExistingProjectStateV2 {
  const evalScenarioNames = new Map(
    existingEvalScenarios.map((scenario) => [String(scenario._id), scenario.name]),
  );
  const evalPersonaNames = new Map(
    existingEvalPersonas.map((persona) => [String(persona._id), persona.name]),
  );
  const evalEvaluatorNames = new Map(
    existingEvalEvaluators.map((evaluator) => [String(evaluator._id), evaluator.name]),
  );
  return buildCoreImportExistingStateV2({
    agents: existingAgents.map((agent) => ({
      name: agent.name,
      dslContent: agent.dslContent,
      description: agent.description ?? null,
      systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
    })),
    prompts: existingPrompts,
    tools: existingTools.map((tool) => ({
      name: tool.name,
      dslContent: tool.dslContent,
      description: tool.description ?? null,
    })),
    mcpServers: existingMcpServers.map((server) => normalizeMcpServerConfigForIO(server)),
    locales: existingLocales.map((locale) => ({
      relativePath: locale.relativePath,
      value: locale.value,
      description: locale.description ?? null,
    })),
    profiles: existingProfiles.map((profile) => ({
      name: profile.name,
      dslContent: profile.dslContent,
    })),
    evalSets: existingEvalSets.map((evalSet) =>
      evalSetState(evalSet, {
        scenarios: evalScenarioNames,
        personas: evalPersonaNames,
        evaluators: evalEvaluatorNames,
      }),
    ),
    evalScenarios: existingEvalScenarios.map(evalEntityState),
    evalPersonas: existingEvalPersonas.map(evalEntityState),
    evalEvaluators: existingEvalEvaluators.map(evalEntityState),
    entryAgentName: null,
  });
}

export function createStudioCoreImportApplyAdapter(
  params: StudioCoreImportAdapterParams,
): CoreImportApplyAdapterV2 {
  const now = params.now ?? new Date();

  async function resolveEvalReferenceIds(operations: CoreImportEvalWriteOperationV2[]): Promise<{
    scenarios: Map<string, string>;
    personas: Map<string, string>;
    evaluators: Map<string, string>;
  }> {
    const scenarioNames = new Set<string>();
    const personaNames = new Set<string>();
    const evaluatorNames = new Set<string>();

    for (const operation of operations) {
      for (const name of operation.scenarioNames ?? []) scenarioNames.add(name);
      for (const name of operation.personaNames ?? []) personaNames.add(name);
      for (const name of operation.evaluatorNames ?? []) evaluatorNames.add(name);
    }

    async function loadNames(
      collection: CoreImportEvalCollectionV2,
      names: Set<string>,
    ): Promise<Map<string, string>> {
      if (names.size === 0) {
        return new Map();
      }
      const records = await evalModel(collection)
        .find({
          projectId: params.projectId,
          tenantId: params.tenantId,
          [EVAL_COLLECTION_NAME_FIELD]: { $in: [...names] },
        })
        .select('_id name')
        .lean();
      return new Map(records.map((record) => [record.name, String(record._id)]));
    }

    const [scenarios, personas, evaluators] = await Promise.all([
      loadNames('eval_scenarios', scenarioNames),
      loadNames('eval_personas', personaNames),
      loadNames('eval_evaluators', evaluatorNames),
    ]);

    return { scenarios, personas, evaluators };
  }

  function materializeEvalRecord(
    operation: CoreImportEvalWriteOperationV2,
    references: {
      scenarios: Map<string, string>;
      personas: Map<string, string>;
      evaluators: Map<string, string>;
    },
  ): Record<string, unknown> {
    const base = {
      ...operation.data,
      projectId: params.projectId,
      tenantId: params.tenantId,
    };

    if (operation.collection !== 'eval_sets') {
      return base;
    }

    return {
      ...base,
      scenarioIds: (operation.scenarioNames ?? []).flatMap((name) => {
        const id = references.scenarios.get(name);
        return id ? [id] : [];
      }),
      personaIds: (operation.personaNames ?? []).flatMap((name) => {
        const id = references.personas.get(name);
        return id ? [id] : [];
      }),
      evaluatorIds: (operation.evaluatorNames ?? []).flatMap((name) => {
        const id = references.evaluators.get(name);
        return id ? [id] : [];
      }),
    };
  }

  return {
    createPrompts: async (promptOperations) => {
      const promptDocs = promptOperations.map((operation) => ({
        _id: operation.promptId,
        projectId: params.projectId,
        tenantId: params.tenantId,
        name: operation.bundle.name,
        description: operation.bundle.description,
        tags: operation.bundle.tags,
        usageCount: 0,
        nextVersionNumber: operation.bundle.nextVersionNumber,
        status: operation.bundle.status,
        createdBy: params.userId,
      }));
      const created = await PromptLibraryItem.insertMany(promptDocs);
      const versionDocs = promptOperations.flatMap((operation) =>
        operation.bundle.versions.map((version) => ({
          _id: version.versionId,
          projectId: params.projectId,
          tenantId: params.tenantId,
          promptId: operation.promptId,
          versionNumber: version.versionNumber,
          template: version.template,
          variables: version.variables,
          description: version.description,
          status: version.status,
          sourceHash: version.sourceHash,
          metadata: version.metadata ?? null,
          createdBy: params.userId,
          publishedAt: version.publishedAt ? new Date(version.publishedAt) : null,
          publishedBy: version.publishedAt ? params.userId : null,
        })),
      );
      if (versionDocs.length > 0) {
        await PromptLibraryVersion.insertMany(versionDocs);
      }
      return created.map((document: { _id: string }) => String(document._id));
    },
    updatePrompts: async (promptOperations) => {
      await PromptLibraryItem.bulkWrite(
        promptOperations.map((operation) => ({
          updateOne: {
            filter: {
              projectId: params.projectId,
              tenantId: params.tenantId,
              _id: operation.promptId,
            },
            update: {
              $set: {
                name: operation.bundle.name,
                description: operation.bundle.description,
                tags: operation.bundle.tags,
                nextVersionNumber: operation.bundle.nextVersionNumber,
                status: operation.bundle.status,
              },
            },
          },
        })),
      );
      await PromptLibraryVersion.deleteMany({
        projectId: params.projectId,
        tenantId: params.tenantId,
        promptId: { $in: promptOperations.map((operation) => operation.promptId) },
      });
      const versionDocs = promptOperations.flatMap((operation) =>
        operation.bundle.versions.map((version) => ({
          _id: version.versionId,
          projectId: params.projectId,
          tenantId: params.tenantId,
          promptId: operation.promptId,
          versionNumber: version.versionNumber,
          template: version.template,
          variables: version.variables,
          description: version.description,
          status: version.status,
          sourceHash: version.sourceHash,
          metadata: version.metadata ?? null,
          createdBy: params.userId,
          publishedAt: version.publishedAt ? new Date(version.publishedAt) : null,
          publishedBy: version.publishedAt ? params.userId : null,
        })),
      );
      if (versionDocs.length > 0) {
        await PromptLibraryVersion.insertMany(versionDocs);
      }
    },
    deletePrompts: async (promptIds) => {
      await PromptLibraryVersion.deleteMany({
        projectId: params.projectId,
        tenantId: params.tenantId,
        promptId: { $in: promptIds },
      });
      await PromptLibraryItem.deleteMany({
        projectId: params.projectId,
        tenantId: params.tenantId,
        _id: { $in: promptIds },
      });
    },
    createAgents: async (agentOperations) => {
      const metadataByAgentName = await buildImportedAgentDslMetadataMap(params, agentOperations);
      const docs = agentOperations.map((operation) => {
        const metadata = metadataByAgentName.get(operation.agentName);
        return {
          projectId: params.projectId,
          tenantId: params.tenantId,
          name: operation.agentName,
          agentPath: buildProjectAgentPath(params.projectId, operation.agentName),
          description: operation.description,
          dslContent: operation.dslContent,
          systemPromptLibraryRef: operation.systemPromptLibraryRef ?? null,
          sourceHash: operation.sourceHash,
          lastEditedBy: params.userId,
          lastEditedAt: now,
          dslValidationStatus: metadata?.dslValidationStatus ?? 'valid',
          dslDiagnostics: metadata?.dslDiagnostics ?? [],
        };
      });
      const created = await ProjectAgent.insertMany(docs);
      return created.map((document: { _id: string }) => String(document._id));
    },
    updateAgents: async (agentOperations) => {
      const metadataByAgentName = await buildImportedAgentDslMetadataMap(params, agentOperations);
      await ProjectAgent.bulkWrite(
        agentOperations.map((operation) => {
          const metadata = metadataByAgentName.get(operation.agentName);
          return {
            updateOne: {
              filter: {
                projectId: params.projectId,
                tenantId: params.tenantId,
                name: operation.agentName,
              },
              update: {
                $set: {
                  dslContent: operation.dslContent,
                  description: operation.description,
                  systemPromptLibraryRef: operation.systemPromptLibraryRef ?? null,
                  sourceHash: operation.sourceHash,
                  lastEditedBy: params.userId,
                  lastEditedAt: now,
                  dslValidationStatus: metadata?.dslValidationStatus ?? 'valid',
                  dslDiagnostics: metadata?.dslDiagnostics ?? [],
                },
                $inc: { _v: 1 },
              },
            },
          };
        }),
      );
    },
    deleteAgents: async (agentNames) => {
      await ProjectAgent.deleteMany({
        projectId: params.projectId,
        tenantId: params.tenantId,
        name: { $in: agentNames },
      });
    },
    refreshAgentDraftMetadata: async () => {
      await refreshPersistedImportedAgentMetadata({
        projectId: params.projectId,
        tenantId: params.tenantId,
      });
    },
    upsertModelPolicyConfigs: async (operations) => {
      let projectModelScopeVerified = false;
      for (const operation of operations) {
        const data = sanitizeModelPolicyData(operation.data);

        if (operation.configType === 'runtime') {
          await ProjectRuntimeConfig.findOneAndUpdate(
            { projectId: params.projectId, tenantId: params.tenantId },
            { $set: { ...data, projectId: params.projectId, tenantId: params.tenantId } },
            { upsert: true, new: true },
          );
          if (hasOperationTierOverrides(data)) {
            await ProjectLLMConfig.findOneAndUpdate(
              { projectId: params.projectId, tenantId: params.tenantId },
              {
                $set: {
                  projectId: params.projectId,
                  tenantId: params.tenantId,
                  operationTierOverrides: data.operationTierOverrides,
                },
              },
              { upsert: true, new: true },
            );
          }
          continue;
        }

        if (operation.configType === 'llm') {
          await ProjectLLMConfig.findOneAndUpdate(
            { projectId: params.projectId, tenantId: params.tenantId },
            { $set: { ...data, projectId: params.projectId, tenantId: params.tenantId } },
            { upsert: true, new: true },
          );
          if (hasOperationTierOverrides(data)) {
            await ProjectRuntimeConfig.findOneAndUpdate(
              { projectId: params.projectId, tenantId: params.tenantId },
              {
                $set: {
                  projectId: params.projectId,
                  tenantId: params.tenantId,
                  operationTierOverrides: data.operationTierOverrides,
                },
              },
              { upsert: true, new: true },
            );
          }
          continue;
        }

        if (operation.configType === 'project_model') {
          const projectModelData = sanitizeProjectModelPolicyData(data);
          const modelConfigName = operation.modelConfigName;
          if (!modelConfigName) {
            continue;
          }
          if (!projectModelScopeVerified) {
            await verifyProjectModelConfigScope(params.projectId, params.tenantId);
            projectModelScopeVerified = true;
          }
          const tenantModelId = await resolveDestinationTenantModelIdForImport({
            data: projectModelData,
            tenantId: params.tenantId,
            modelConfigName,
          });
          await ModelConfig.findOneAndUpdate(
            { projectId: params.projectId, tenantId: params.tenantId, name: modelConfigName },
            {
              $set: {
                ...projectModelData,
                tenantModelId,
                projectId: params.projectId,
                tenantId: params.tenantId,
                name: modelConfigName,
              },
            },
            { upsert: true, new: true },
          );
          continue;
        }

        const agentName = operation.agentName;
        if (!agentName) {
          continue;
        }
        await AgentModelConfig.findOneAndUpdate(
          { projectId: params.projectId, tenantId: params.tenantId, agentName },
          { $set: { ...data, projectId: params.projectId, tenantId: params.tenantId, agentName } },
          { upsert: true, new: true },
        );
      }
    },
    deleteModelPolicyConfigs: async (operations) => {
      let projectModelScopeVerified = false;
      for (const operation of operations) {
        if (operation.configType === 'runtime') {
          await ProjectRuntimeConfig.deleteOne({
            projectId: params.projectId,
            tenantId: params.tenantId,
          });
          continue;
        }

        if (operation.configType === 'llm') {
          await ProjectLLMConfig.deleteOne({
            projectId: params.projectId,
            tenantId: params.tenantId,
          });
          await ProjectRuntimeConfig.findOneAndUpdate(
            { projectId: params.projectId, tenantId: params.tenantId },
            { $set: { operationTierOverrides: {} } },
            { new: true },
          );
          continue;
        }

        if (operation.configType === 'project_model' && operation.modelConfigName) {
          if (!projectModelScopeVerified) {
            await verifyProjectModelConfigScope(params.projectId, params.tenantId);
            projectModelScopeVerified = true;
          }
          await ModelConfig.deleteOne({
            projectId: params.projectId,
            tenantId: params.tenantId,
            name: operation.modelConfigName,
          });
          continue;
        }

        if (operation.agentName) {
          await AgentModelConfig.deleteOne({
            projectId: params.projectId,
            tenantId: params.tenantId,
            agentName: operation.agentName,
          });
        }
      }
    },
    createMcpServers: async (serverOperations) => {
      const docs = serverOperations.map((operation) => ({
        projectId: params.projectId,
        tenantId: params.tenantId,
        ...operation.config,
        createdBy: params.userId,
        modifiedBy: params.userId,
      }));
      const created = await MCPServerConfig.insertMany(docs as IMCPServerConfig[]);
      return created.map((document: { _id: string }) => String(document._id));
    },
    updateMcpServers: async (serverOperations) => {
      await MCPServerConfig.bulkWrite(
        serverOperations.map((operation) => ({
          updateOne: {
            filter: {
              projectId: params.projectId,
              tenantId: params.tenantId,
              name: operation.serverName,
            },
            update: {
              $set: {
                ...operation.config,
                modifiedBy: params.userId,
              },
              $inc: { _v: 1 },
            },
          },
        })),
      );
    },
    deleteMcpServers: async (serverNames) => {
      await MCPServerConfig.deleteMany({
        projectId: params.projectId,
        tenantId: params.tenantId,
        name: { $in: serverNames },
      });
    },
    createTools: async (toolOperations) => {
      const variableNamespaceIds = await getOrCreateDefaultVariableNamespaceIds({
        tenantId: params.tenantId,
        projectId: params.projectId,
        createdBy: params.userId,
      });
      const docs = toolOperations.map((operation) => ({
        projectId: params.projectId,
        tenantId: params.tenantId,
        name: operation.toolName,
        slug: operation.toolName,
        toolType: (operation.toolType ?? 'http') as ProjectToolType,
        description: operation.description,
        dslContent: operation.dslContent,
        sourceHash: operation.sourceHash,
        variableNamespaceIds,
        createdBy: params.userId,
        lastEditedBy: params.userId,
      }));
      const created = await ProjectTool.insertMany(docs);
      return created.map((document: { _id: string }) => String(document._id));
    },
    updateTools: async (toolOperations) => {
      const existingTools = (await ProjectTool.find(
        {
          projectId: params.projectId,
          tenantId: params.tenantId,
          name: { $in: toolOperations.map((operation) => operation.toolName) },
        },
        { name: 1, variableNamespaceIds: 1 },
      ).lean()) as Array<{ name?: string; variableNamespaceIds?: string[] }>;
      const existingNamespaceIdsByName = new Map(
        existingTools
          .filter((tool): tool is { name: string; variableNamespaceIds?: string[] } => {
            return typeof tool.name === 'string';
          })
          .map((tool) => [tool.name, tool.variableNamespaceIds ?? []]),
      );
      const needsDefaultNamespace = toolOperations.some((operation) => {
        const namespaceIds = existingNamespaceIdsByName.get(operation.toolName);
        return !Array.isArray(namespaceIds) || namespaceIds.length === 0;
      });
      const defaultVariableNamespaceIds = needsDefaultNamespace
        ? await getOrCreateDefaultVariableNamespaceIds({
            tenantId: params.tenantId,
            projectId: params.projectId,
            createdBy: params.userId,
          })
        : [];

      await ProjectTool.bulkWrite(
        toolOperations.map((operation) => {
          const namespaceIds = existingNamespaceIdsByName.get(operation.toolName);
          const setFields: Record<string, unknown> = {
            dslContent: operation.dslContent,
            description: operation.description,
            toolType: (operation.toolType ?? 'http') as ProjectToolType,
            sourceHash: operation.sourceHash,
            lastEditedBy: params.userId,
          };

          if (!Array.isArray(namespaceIds) || namespaceIds.length === 0) {
            setFields.variableNamespaceIds = defaultVariableNamespaceIds;
          }

          return {
            updateOne: {
              filter: {
                projectId: params.projectId,
                tenantId: params.tenantId,
                name: operation.toolName,
              },
              update: {
                $set: setFields,
                $inc: { _v: 1 },
              },
            },
          };
        }),
      );
    },
    deleteTools: async (toolNames) => {
      await ProjectTool.deleteMany({
        projectId: params.projectId,
        tenantId: params.tenantId,
        name: { $in: toolNames },
      });
    },
    createLocales: async (localeOperations) => {
      const docs = localeOperations.map((operation) => ({
        projectId: params.projectId,
        tenantId: params.tenantId,
        key: localeAssetRelativePathToConfigKey(operation.relativePath),
        value: operation.value,
        description: operation.description ?? null,
        createdBy: params.userId,
        updatedBy: params.userId,
      }));
      const created = await ProjectConfigVariable.insertMany(docs);
      return created.map((document: { _id: string }) => String(document._id));
    },
    updateLocales: async (localeOperations) => {
      await ProjectConfigVariable.bulkWrite(
        localeOperations.map((operation) => ({
          updateOne: {
            filter: {
              projectId: params.projectId,
              tenantId: params.tenantId,
              key: localeAssetRelativePathToConfigKey(operation.relativePath),
            },
            update: {
              $set: {
                value: operation.value,
                updatedBy: params.userId,
              },
            },
          },
        })),
      );
    },
    createProfiles: async (profileOperations) => {
      const docs = profileOperations.map((operation) => ({
        projectId: params.projectId,
        tenantId: params.tenantId,
        key: behaviorProfileNameToConfigKey(operation.profileName),
        value: operation.dslContent,
        description: `Behavior profile: ${operation.profileName}`,
        createdBy: params.userId,
        updatedBy: params.userId,
      }));
      const created = await ProjectConfigVariable.insertMany(docs);
      return created.map((document: { _id: string }) => String(document._id));
    },
    updateProfiles: async (profileOperations) => {
      await ProjectConfigVariable.bulkWrite(
        profileOperations.map((operation) => ({
          updateOne: {
            filter: {
              projectId: params.projectId,
              tenantId: params.tenantId,
              key: behaviorProfileNameToConfigKey(operation.profileName),
            },
            update: {
              $set: {
                value: operation.dslContent,
                description: `Behavior profile: ${operation.profileName}`,
                updatedBy: params.userId,
              },
            },
          },
        })),
      );
    },
    deleteLocales: async (relativePaths) => {
      await ProjectConfigVariable.deleteMany({
        projectId: params.projectId,
        tenantId: params.tenantId,
        key: {
          $in: relativePaths.map((relativePath) =>
            localeAssetRelativePathToConfigKey(relativePath),
          ),
        },
      });
    },
    deleteProfiles: async (profileNames) => {
      await ProjectConfigVariable.deleteMany({
        projectId: params.projectId,
        tenantId: params.tenantId,
        key: {
          $in: profileNames.map((profileName) => behaviorProfileNameToConfigKey(profileName)),
        },
      });
    },
    createEvalRecords: async (evalOperations) => {
      const created: CoreImportCreatedEvalIdsV2 = {};
      const references = await resolveEvalReferenceIds(evalOperations);
      const grouped = groupEvalOperationsByCollection(evalOperations);

      for (const [collection, operations] of grouped) {
        const docs = operations.map((operation) => ({
          ...materializeEvalRecord(operation, references),
          createdBy: params.userId,
        }));
        const inserted = await evalModel(collection).insertMany(docs);
        created[collection] = inserted.map((document) => String(document._id));
      }

      return created;
    },
    updateEvalRecords: async (evalOperations) => {
      const references = await resolveEvalReferenceIds(evalOperations);
      const grouped = groupEvalOperationsByCollection(evalOperations);

      for (const [collection, operations] of grouped) {
        await evalModel(collection).bulkWrite(
          operations.map((operation) => ({
            updateOne: {
              filter: {
                projectId: params.projectId,
                tenantId: params.tenantId,
                name: operation.name,
              },
              update: {
                $set: materializeEvalRecord(operation, references),
                $inc: { _v: 1 },
              },
            },
          })),
        );
      }
    },
    deleteEvalRecords: async (evalOperations) => {
      const grouped = groupEvalOperationsByCollection(evalOperations);
      for (const [collection, operations] of grouped) {
        await evalModel(collection).deleteMany({
          projectId: params.projectId,
          tenantId: params.tenantId,
          name: { $in: operations.map((operation) => operation.name) },
        });
      }
    },
    setEntryAgent: async (entryAgentName) => {
      await Project.findOneAndUpdate(
        { _id: params.projectId, tenantId: params.tenantId },
        entryAgentName ? { $set: { entryAgentName } } : { $unset: { entryAgentName: 1 } },
      );
    },
    rollbackCreated: async (
      promptIds,
      agentIds,
      toolIds,
      mcpServerIds,
      localeIds,
      profileIds,
      evalIds,
    ) => {
      const rollbackOperations: Promise<unknown>[] = [];
      const projectId = params.projectId;
      const tenantId = params.tenantId;
      if (promptIds.length > 0) {
        rollbackOperations.push(
          PromptLibraryVersion.deleteMany({ projectId, tenantId, promptId: { $in: promptIds } }),
        );
        rollbackOperations.push(
          PromptLibraryItem.deleteMany({ projectId, tenantId, _id: { $in: promptIds } }),
        );
      }
      if (agentIds.length > 0) {
        rollbackOperations.push(
          ProjectAgent.deleteMany({ projectId, tenantId, _id: { $in: agentIds } }),
        );
      }
      if (toolIds.length > 0) {
        rollbackOperations.push(
          ProjectTool.deleteMany({ projectId, tenantId, _id: { $in: toolIds } }),
        );
      }
      if (mcpServerIds.length > 0) {
        rollbackOperations.push(
          MCPServerConfig.deleteMany({ projectId, tenantId, _id: { $in: mcpServerIds } }),
        );
      }
      if (localeIds.length > 0) {
        rollbackOperations.push(
          ProjectConfigVariable.deleteMany({ projectId, tenantId, _id: { $in: localeIds } }),
        );
      }
      if (profileIds.length > 0) {
        rollbackOperations.push(
          ProjectConfigVariable.deleteMany({ projectId, tenantId, _id: { $in: profileIds } }),
        );
      }
      for (const [collection, ids] of Object.entries(evalIds ?? {}) as Array<
        [CoreImportEvalCollectionV2, string[] | undefined]
      >) {
        if (ids && ids.length > 0) {
          rollbackOperations.push(
            evalModel(collection).deleteMany({ projectId, tenantId, _id: { $in: ids } }),
          );
        }
      }
      await Promise.all(rollbackOperations);
    },
  };
}

export function createStudioCoreImportOperationStore(params: {
  projectId: string;
  tenantId: string;
}): CoreImportOperationStoreV2 {
  return createStudioCoreImportStore(params);
}

export function createStudioCoreImportStore(params: {
  projectId: string;
  tenantId: string;
}): CoreImportStoreV2 {
  const completedOperationTtlMs = COMPLETED_OPERATION_TTL_SECONDS * 1000;

  return {
    loadCurrentState: async () => {
      const { currentState } = await loadStudioCoreImportState(params.projectId, params.tenantId);
      return currentState;
    },
    createCompletedOperation: async (snapshot) => {
      const operation = await ImportOperation.create({
        projectId: params.projectId,
        tenantId: params.tenantId,
        status: 'completed',
        ...(snapshot ? { preImportSnapshot: snapshot } : {}),
        expiresAt: new Date(Date.now() + completedOperationTtlMs),
      });

      return {
        operationId: String(operation._id),
      };
    },
    getOperationStatus: async (operationId) => {
      const operation = (await ImportOperation.findOne({
        _id: operationId,
        projectId: params.projectId,
        tenantId: params.tenantId,
      }).lean()) as IImportOperation | null;

      if (!operation) {
        return null;
      }

      const status: CoreImportOperationStatusV2 = {
        operationId: String(operation._id),
        status: operation.status,
        layers: operation.layers ?? {},
        error: operation.error ?? null,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
      };

      return status;
    },
    getOperationSnapshot: async (operationId) => {
      const operation = (await ImportOperation.findOne({
        _id: operationId,
        projectId: params.projectId,
        tenantId: params.tenantId,
      }).lean()) as IImportOperation | null;

      if (!operation) {
        return {
          success: false as const,
          error: {
            code: 'OPERATION_NOT_FOUND' as const,
            message: 'Import operation not found',
          },
        };
      }

      if (!operation.preImportSnapshot) {
        return {
          success: false as const,
          error: {
            code: 'NO_SNAPSHOT' as const,
            message: 'Import operation has no pre-import snapshot',
          },
        };
      }

      return {
        success: true as const,
        rawSnapshot: operation.preImportSnapshot,
      };
    },
  };
}
