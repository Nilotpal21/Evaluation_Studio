import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockProjectAgentFind = vi.fn();
const mockProjectAgentInsertMany = vi.fn();
const mockProjectAgentBulkWrite = vi.fn();
const mockProjectAgentDeleteMany = vi.fn();
const mockPromptLibraryItemFind = vi.fn();
const mockPromptLibraryItemInsertMany = vi.fn();
const mockPromptLibraryItemBulkWrite = vi.fn();
const mockPromptLibraryItemDeleteMany = vi.fn();
const mockPromptLibraryVersionFind = vi.fn();
const mockPromptLibraryVersionInsertMany = vi.fn();
const mockPromptLibraryVersionDeleteMany = vi.fn();
const mockMCPServerConfigFind = vi.fn();
const mockMCPServerConfigInsertMany = vi.fn();
const mockMCPServerConfigBulkWrite = vi.fn();
const mockMCPServerConfigDeleteMany = vi.fn();
const mockProjectToolFind = vi.fn();
const mockProjectToolInsertMany = vi.fn();
const mockProjectToolBulkWrite = vi.fn();
const mockProjectToolDeleteMany = vi.fn();
const mockProjectConfigVariableFind = vi.fn();
const mockProjectConfigVariableInsertMany = vi.fn();
const mockProjectConfigVariableBulkWrite = vi.fn();
const mockProjectConfigVariableDeleteMany = vi.fn();
const mockVariableNamespaceFindOne = vi.fn();
const mockVariableNamespaceCreate = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectRuntimeConfigFindOneAndUpdate = vi.fn();
const mockProjectRuntimeConfigDeleteOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOneAndUpdate = vi.fn();
const mockProjectLLMConfigDeleteOne = vi.fn();
const mockModelConfigFind = vi.fn();
const mockModelConfigFindOneAndUpdate = vi.fn();
const mockModelConfigDeleteOne = vi.fn();
const mockTenantModelFind = vi.fn();
const mockAgentModelConfigFind = vi.fn();
const mockAgentModelConfigFindOneAndUpdate = vi.fn();
const mockAgentModelConfigDeleteOne = vi.fn();
const mockEvalSetFind = vi.fn();
const mockEvalSetInsertMany = vi.fn();
const mockEvalSetBulkWrite = vi.fn();
const mockEvalSetDeleteMany = vi.fn();
const mockEvalScenarioFind = vi.fn();
const mockEvalScenarioInsertMany = vi.fn();
const mockEvalScenarioBulkWrite = vi.fn();
const mockEvalScenarioDeleteMany = vi.fn();
const mockEvalPersonaFind = vi.fn();
const mockEvalPersonaInsertMany = vi.fn();
const mockEvalPersonaBulkWrite = vi.fn();
const mockEvalPersonaDeleteMany = vi.fn();
const mockEvalEvaluatorFind = vi.fn();
const mockEvalEvaluatorInsertMany = vi.fn();
const mockEvalEvaluatorBulkWrite = vi.fn();
const mockEvalEvaluatorDeleteMany = vi.fn();
const mockProjectFindOne = vi.fn();
const mockProjectFindOneAndUpdate = vi.fn();
const mockImportOperationFindOne = vi.fn();
const mockImportOperationCreate = vi.fn();
const mockImportOperationUpdateOne = vi.fn();
const mockListProjectLocalizationAssets = vi.fn();
const mockProjectSettingsFindOne = vi.fn();
const mockEnvironmentVariableFind = vi.fn();
const mockResolveToolImplementations = vi.fn();
const mockBuildStudioConnectorToolResolver = vi.fn();
const mockCompileABLtoIR = vi.fn((documents: unknown[]) => {
  const serialized = JSON.stringify(documents);
  return {
    compilation_errors: serialized.includes('booking_agent')
      ? [
          {
            agent: 'billing_agent',
            message: 'Handoff target "booking_agent" does not exist',
          },
        ]
      : [],
    compilation_warnings: [],
  };
});
const mockMapProjectRuntimeConfigDocumentToIR = vi.fn(() => ({}));

function createLeanSelectResult<T>(resolver: () => Promise<T> | T) {
  const run = () => Promise.resolve().then(resolver);
  return {
    select: () => run(),
    then: <TResult1 = T, TResult2 = never>(
      onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => run().then(onFulfilled, onRejected),
    catch: <TResult = never>(
      onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
    ) => run().catch(onRejected),
    finally: (onFinally?: (() => void) | null) => run().finally(onFinally),
  };
}

function createFindQuery<T>(resolver: () => Promise<T> | T) {
  return {
    lean: () => createLeanSelectResult(resolver),
    select: () => ({ lean: () => Promise.resolve().then(resolver) }),
    sort: () => createFindQuery(resolver),
  };
}

vi.mock('@agent-platform/database/models', () => ({
  COMPLETED_OPERATION_TTL_SECONDS: 30 * 24 * 3600,
  ImportOperation: {
    findOne: (...args: unknown[]) => ({ lean: () => mockImportOperationFindOne(...args) }),
    create: (...args: unknown[]) => mockImportOperationCreate(...args),
    updateOne: (...args: unknown[]) => mockImportOperationUpdateOne(...args),
  },
  ProjectAgent: {
    find: (...args: unknown[]) => ({ lean: () => mockProjectAgentFind(...args) }),
    insertMany: (...args: unknown[]) => mockProjectAgentInsertMany(...args),
    bulkWrite: (...args: unknown[]) => mockProjectAgentBulkWrite(...args),
    deleteMany: (...args: unknown[]) => mockProjectAgentDeleteMany(...args),
  },
  PromptLibraryItem: {
    find: (...args: unknown[]) => ({ lean: () => mockPromptLibraryItemFind(...args) }),
    insertMany: (...args: unknown[]) => mockPromptLibraryItemInsertMany(...args),
    bulkWrite: (...args: unknown[]) => mockPromptLibraryItemBulkWrite(...args),
    deleteMany: (...args: unknown[]) => mockPromptLibraryItemDeleteMany(...args),
  },
  PromptLibraryVersion: {
    find: (...args: unknown[]) => ({ lean: () => mockPromptLibraryVersionFind(...args) }),
    insertMany: (...args: unknown[]) => mockPromptLibraryVersionInsertMany(...args),
    deleteMany: (...args: unknown[]) => mockPromptLibraryVersionDeleteMany(...args),
  },
  MCPServerConfig: {
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockMCPServerConfigFind(...args) }),
    }),
    insertMany: (...args: unknown[]) => mockMCPServerConfigInsertMany(...args),
    bulkWrite: (...args: unknown[]) => mockMCPServerConfigBulkWrite(...args),
    deleteMany: (...args: unknown[]) => mockMCPServerConfigDeleteMany(...args),
  },
  ProjectTool: {
    find: (...args: unknown[]) => ({ lean: () => mockProjectToolFind(...args) }),
    insertMany: (...args: unknown[]) => mockProjectToolInsertMany(...args),
    bulkWrite: (...args: unknown[]) => mockProjectToolBulkWrite(...args),
    deleteMany: (...args: unknown[]) => mockProjectToolDeleteMany(...args),
  },
  ProjectConfigVariable: {
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockProjectConfigVariableFind(...args) }),
    }),
    insertMany: (...args: unknown[]) => mockProjectConfigVariableInsertMany(...args),
    bulkWrite: (...args: unknown[]) => mockProjectConfigVariableBulkWrite(...args),
    deleteMany: (...args: unknown[]) => mockProjectConfigVariableDeleteMany(...args),
  },
  VariableNamespace: {
    findOne: (...args: unknown[]) => ({ lean: () => mockVariableNamespaceFindOne(...args) }),
    create: (...args: unknown[]) => mockVariableNamespaceCreate(...args),
  },
  ProjectRuntimeConfig: {
    findOne: (...args: unknown[]) => ({ lean: () => mockProjectRuntimeConfigFindOne(...args) }),
    findOneAndUpdate: (...args: unknown[]) => mockProjectRuntimeConfigFindOneAndUpdate(...args),
    deleteOne: (...args: unknown[]) => mockProjectRuntimeConfigDeleteOne(...args),
  },
  ProjectLLMConfig: {
    findOne: (...args: unknown[]) => ({ lean: () => mockProjectLLMConfigFindOne(...args) }),
    findOneAndUpdate: (...args: unknown[]) => mockProjectLLMConfigFindOneAndUpdate(...args),
    deleteOne: (...args: unknown[]) => mockProjectLLMConfigDeleteOne(...args),
  },
  ModelConfig: {
    find: (...args: unknown[]) => ({ lean: () => mockModelConfigFind(...args) }),
    findOneAndUpdate: (...args: unknown[]) => mockModelConfigFindOneAndUpdate(...args),
    deleteOne: (...args: unknown[]) => mockModelConfigDeleteOne(...args),
  },
  TenantModel: {
    find: (...args: unknown[]) => ({ lean: () => mockTenantModelFind(...args) }),
  },
  AgentModelConfig: {
    find: (...args: unknown[]) => ({ lean: () => mockAgentModelConfigFind(...args) }),
    findOneAndUpdate: (...args: unknown[]) => mockAgentModelConfigFindOneAndUpdate(...args),
    deleteOne: (...args: unknown[]) => mockAgentModelConfigDeleteOne(...args),
  },
  EvalSet: {
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockEvalSetFind(...args) }),
      lean: () => mockEvalSetFind(...args),
    }),
    insertMany: (...args: unknown[]) => mockEvalSetInsertMany(...args),
    bulkWrite: (...args: unknown[]) => mockEvalSetBulkWrite(...args),
    deleteMany: (...args: unknown[]) => mockEvalSetDeleteMany(...args),
  },
  EvalScenario: {
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockEvalScenarioFind(...args) }),
      lean: () => mockEvalScenarioFind(...args),
    }),
    insertMany: (...args: unknown[]) => mockEvalScenarioInsertMany(...args),
    bulkWrite: (...args: unknown[]) => mockEvalScenarioBulkWrite(...args),
    deleteMany: (...args: unknown[]) => mockEvalScenarioDeleteMany(...args),
  },
  EvalPersona: {
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockEvalPersonaFind(...args) }),
      lean: () => mockEvalPersonaFind(...args),
    }),
    insertMany: (...args: unknown[]) => mockEvalPersonaInsertMany(...args),
    bulkWrite: (...args: unknown[]) => mockEvalPersonaBulkWrite(...args),
    deleteMany: (...args: unknown[]) => mockEvalPersonaDeleteMany(...args),
  },
  EvalEvaluator: {
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockEvalEvaluatorFind(...args) }),
      lean: () => mockEvalEvaluatorFind(...args),
    }),
    insertMany: (...args: unknown[]) => mockEvalEvaluatorInsertMany(...args),
    bulkWrite: (...args: unknown[]) => mockEvalEvaluatorBulkWrite(...args),
    deleteMany: (...args: unknown[]) => mockEvalEvaluatorDeleteMany(...args),
  },
  Project: {
    findOne: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockProjectFindOne(...args) }),
      lean: () => mockProjectFindOne(...args),
    }),
    findOneAndUpdate: (...args: unknown[]) => mockProjectFindOneAndUpdate(...args),
  },
}));

vi.mock('@abl/compiler', () => ({
  compileABLtoIR: (...args: unknown[]) => mockCompileABLtoIR(...args),
  mapProjectRuntimeConfigDocumentToIR: (...args: unknown[]) =>
    mockMapProjectRuntimeConfigDocumentToIR(...args),
}));

vi.mock('@agent-platform/database', () => ({
  ProjectAgent: {
    find: (...args: unknown[]) => createFindQuery(() => mockProjectAgentFind(...args)),
  },
  ProjectTool: {
    find: (...args: unknown[]) => createFindQuery(() => mockProjectToolFind(...args)),
  },
  ProjectSettings: {
    findOne: (...args: unknown[]) => mockProjectSettingsFindOne(...args),
  },
  ProjectRuntimeConfig: {
    findOne: (...args: unknown[]) => mockProjectRuntimeConfigFindOne(...args),
  },
  ProjectLLMConfig: {
    findOne: (...args: unknown[]) => mockProjectLLMConfigFindOne(...args),
  },
  ModelConfig: {
    find: (...args: unknown[]) => ({ lean: () => mockModelConfigFind(...args) }),
  },
  AgentModelConfig: {
    find: (...args: unknown[]) => ({ lean: () => mockAgentModelConfigFind(...args) }),
  },
  EnvironmentVariable: {
    find: (...args: unknown[]) => createFindQuery(() => mockEnvironmentVariableFind(...args)),
  },
  ProjectConfigVariable: {
    find: (...args: unknown[]) => createFindQuery(() => mockProjectConfigVariableFind(...args)),
  },
  MCPServerConfig: {
    find: (...args: unknown[]) => createFindQuery(() => mockMCPServerConfigFind(...args)),
  },
}));

vi.mock('@/lib/localization-assets', () => ({
  listProjectLocalizationAssets: (...args: unknown[]) => mockListProjectLocalizationAssets(...args),
}));

vi.mock('@agent-platform/shared/tools/resolve', () => ({
  resolveToolImplementations: (...args: unknown[]) => mockResolveToolImplementations(...args),
}));

vi.mock('@agent-platform/shared/repos', () => ({
  findMcpServerConfigsRaw: vi.fn().mockResolvedValue([]),
}));

vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    buildProjectAgentPath: (projectId: string, agentName: string) =>
      `projects/${projectId}/agents/${agentName}`,
  };
});

vi.mock('@/lib/connection-service', () => ({
  buildStudioConnectorToolResolver: (...args: unknown[]) =>
    mockBuildStudioConnectorToolResolver(...args),
}));

import { IMPORT_LIFECYCLE_FIELD } from '@agent-platform/project-io/import';
import {
  buildLayeredAppliedCounts,
  createStudioLayeredImportDbAdapter,
  loadStudioLayeredImportExistingState,
  revertStudioLayeredImportOperation,
} from '@/lib/project-import/layered-import-support';
import {
  buildStudioCoreExistingState,
  createStudioCoreImportApplyAdapter,
  createStudioCoreImportStore,
  createStudioCoreImportOperationStore,
  loadStudioCoreImportState,
} from '@/lib/project-import/core-direct-apply-support';

function createRawCollection(records: Array<Record<string, unknown>> = []) {
  return {
    find: vi.fn((_filter: Record<string, unknown>, _options?: Record<string, unknown>) => ({
      toArray: () => Promise.resolve(records),
    })),
    insertMany: vi.fn(async (_records: Array<Record<string, unknown>>) => undefined),
    deleteMany: vi.fn(async (_filter: Record<string, unknown>) => undefined),
    updateMany: vi.fn(
      async (_filter: Record<string, unknown>, _update: Record<string, unknown>) => undefined,
    ),
    bulkWrite: vi.fn(
      async (_operations: Array<Record<string, unknown>>, _options?: Record<string, unknown>) =>
        undefined,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveToolImplementations.mockResolvedValue({
    resolvedByAgent: new Map(),
    errors: [],
    warnings: [],
  });
  mockCompileABLtoIR.mockClear();
  mockMapProjectRuntimeConfigDocumentToIR.mockClear();
  mockBuildStudioConnectorToolResolver.mockResolvedValue('connector-resolver');
  mockProjectSettingsFindOne.mockResolvedValue(null);
  mockEnvironmentVariableFind.mockResolvedValue([]);
  mockProjectAgentFind.mockResolvedValue([
    {
      _id: 'agent-1',
      name: 'Main',
      description: 'Main agent',
      dslContent: 'AGENT: Main\nGOAL: Help\n',
    },
  ]);
  mockPromptLibraryItemFind.mockResolvedValue([
    {
      _id: 'pl_prompt_1',
      name: 'Support Prompt',
      description: 'Guidance for support replies',
      tags: ['support'],
      status: 'active',
      nextVersionNumber: 2,
    },
  ]);
  mockPromptLibraryVersionFind.mockResolvedValue([
    {
      _id: 'plv_prompt_1',
      promptId: 'pl_prompt_1',
      versionNumber: 1,
      template: 'Answer politely.',
      variables: ['customer_name'],
      description: 'Active support prompt',
      status: 'active',
      sourceHash: 'prompt-version-hash-1',
      metadata: { tone: 'friendly' },
    },
  ]);
  mockPromptLibraryItemInsertMany.mockResolvedValue([{ _id: 'pl_prompt_1' }]);
  mockPromptLibraryVersionInsertMany.mockResolvedValue([{ _id: 'plv_prompt_1' }]);
  mockPromptLibraryItemBulkWrite.mockResolvedValue(undefined);
  mockPromptLibraryItemDeleteMany.mockResolvedValue(undefined);
  mockPromptLibraryVersionDeleteMany.mockResolvedValue(undefined);
  mockProjectToolFind.mockResolvedValue([
    {
      _id: 'tool-1',
      name: 'lookup_ticket',
      description: 'Lookup ticket',
      dslContent: 'lookup_ticket(id: string) -> {status: string}\n',
    },
  ]);
  mockMCPServerConfigFind.mockResolvedValue([
    {
      _id: 'mcp-1',
      name: 'public-repo-tools',
      description: 'Public MCP server',
      transport: 'http',
      url: 'https://mcp.example.com/public-repo',
      authType: 'none',
      priority: 10,
      tags: null,
      connectionTimeoutMs: 15000,
      requestTimeoutMs: 45000,
      autoReconnect: true,
      maxReconnectAttempts: 5,
      lastConnectionStatus: 'connected',
    },
  ]);
  mockProjectFindOne.mockResolvedValue({ entryAgentName: 'Main' });
  mockProjectAgentInsertMany.mockResolvedValue([{ _id: 'created-agent-1' }]);
  mockMCPServerConfigInsertMany.mockResolvedValue([{ _id: 'created-mcp-1' }]);
  mockMCPServerConfigBulkWrite.mockResolvedValue({ modifiedCount: 1 });
  mockMCPServerConfigDeleteMany.mockResolvedValue({ deletedCount: 1 });
  mockProjectToolInsertMany.mockResolvedValue([{ _id: 'created-tool-1' }]);
  mockProjectAgentBulkWrite.mockResolvedValue({ modifiedCount: 1 });
  mockProjectToolBulkWrite.mockResolvedValue({ modifiedCount: 1 });
  mockProjectAgentDeleteMany.mockResolvedValue({ deletedCount: 1 });
  mockProjectToolDeleteMany.mockResolvedValue({ deletedCount: 1 });
  mockProjectConfigVariableFind.mockResolvedValue([
    {
      key: 'profile:voice_vip',
      value: 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 5\nWHEN: channel == "voice"\n',
    },
  ]);
  mockProjectConfigVariableInsertMany.mockResolvedValue([{ _id: 'created-locale-1' }]);
  mockProjectConfigVariableBulkWrite.mockResolvedValue({ modifiedCount: 1 });
  mockProjectConfigVariableDeleteMany.mockResolvedValue({ deletedCount: 1 });
  mockVariableNamespaceFindOne.mockResolvedValue({ _id: 'ns-default' });
  mockVariableNamespaceCreate.mockResolvedValue({
    toObject: () => ({ _id: 'ns-default' }),
  });
  mockProjectRuntimeConfigFindOne.mockResolvedValue({
    operationTierOverrides: { response_gen: 'powerful' },
    extraction: { nlu_provider: 'standard' },
  });
  mockProjectRuntimeConfigFindOneAndUpdate.mockResolvedValue({});
  mockProjectRuntimeConfigDeleteOne.mockResolvedValue({ deletedCount: 1 });
  mockProjectLLMConfigFindOne.mockResolvedValue({
    operationTierOverrides: { realtime_voice: 'voice' },
  });
  mockProjectLLMConfigFindOneAndUpdate.mockResolvedValue({});
  mockProjectLLMConfigDeleteOne.mockResolvedValue({ deletedCount: 1 });
  mockModelConfigFind.mockResolvedValue([
    {
      name: 'GPT-4o Realtime Preview (2025-06-03)',
      modelId: 'gpt-4o-realtime-preview-2025-06-03',
      provider: 'openai',
      tenantModelId: 'tm-voice',
      credentialId: 'cred-should-not-round-trip',
      authProfileId: 'auth-profile-should-not-round-trip',
      tier: 'voice',
      isDefault: true,
    },
  ]);
  mockModelConfigFindOneAndUpdate.mockResolvedValue({});
  mockModelConfigDeleteOne.mockResolvedValue({ deletedCount: 1 });
  mockTenantModelFind.mockResolvedValue([
    {
      _id: 'tm-destination-voice',
      modelId: 'gpt-4o-realtime-preview-2025-06-03',
      provider: 'openai',
      capabilities: ['text', 'streaming', 'realtime_voice'],
      tier: 'voice',
    },
  ]);
  mockAgentModelConfigFind.mockResolvedValue([
    {
      agentName: 'Main',
      defaultModel: 'gpt-4o-mini',
      operationModels: { response_gen: 'gpt-4o' },
    },
  ]);
  mockAgentModelConfigFindOneAndUpdate.mockResolvedValue({});
  mockAgentModelConfigDeleteOne.mockResolvedValue({ deletedCount: 1 });
  mockEvalScenarioFind.mockImplementation((filter) => {
    if (filter?.name?.$in) {
      return Promise.resolve([{ _id: 'scenario-1', name: 'GreetingScenario' }]);
    }
    return Promise.resolve([
      {
        _id: 'scenario-1',
        name: 'GreetingScenario',
        description: 'Greets users',
        difficulty: 'easy',
        initialMessage: 'Hello',
        maxTurns: 3,
        tags: [],
        agentPath: ['Main'],
        expectedMilestones: [],
        version: 1,
      },
    ]);
  });
  mockEvalPersonaFind.mockImplementation((filter) => {
    if (filter?.name?.$in) {
      return Promise.resolve([{ _id: 'persona-1', name: 'FriendlyPersona' }]);
    }
    return Promise.resolve([
      {
        _id: 'persona-1',
        name: 'FriendlyPersona',
        communicationStyle: 'casual',
        domainKnowledge: 'beginner',
        behaviorTraits: ['friendly'],
        goals: 'Get help',
        constraints: '',
        source: 'custom',
        version: 1,
        isAdversarial: false,
        isBuiltIn: false,
      },
    ]);
  });
  mockEvalEvaluatorFind.mockImplementation((filter) => {
    if (filter?.name?.$in) {
      return Promise.resolve([{ _id: 'evaluator-1', name: 'QualityJudge' }]);
    }
    return Promise.resolve([
      {
        _id: 'evaluator-1',
        name: 'QualityJudge',
        type: 'llm_judge',
        category: 'quality',
        chainOfThought: true,
        temperature: 0,
        biasSettings: {},
        isBuiltIn: false,
        version: 1,
      },
    ]);
  });
  mockEvalSetFind.mockImplementation((filter) => {
    if (filter?.name?.$in) {
      return Promise.resolve([{ _id: 'set-1', name: 'SmokeSet' }]);
    }
    return Promise.resolve([
      {
        _id: 'set-1',
        name: 'SmokeSet',
        description: 'Smoke evals',
        scenarioIds: ['scenario-1'],
        personaIds: ['persona-1'],
        evaluatorIds: ['evaluator-1'],
        variants: 1,
        maxConcurrency: 1,
        ciEnabled: false,
      },
    ]);
  });
  mockEvalScenarioInsertMany.mockResolvedValue([{ _id: 'created-scenario-1' }]);
  mockEvalPersonaInsertMany.mockResolvedValue([{ _id: 'created-persona-1' }]);
  mockEvalEvaluatorInsertMany.mockResolvedValue([{ _id: 'created-evaluator-1' }]);
  mockEvalSetInsertMany.mockResolvedValue([{ _id: 'created-set-1' }]);
  mockEvalScenarioBulkWrite.mockResolvedValue({ modifiedCount: 1 });
  mockEvalPersonaBulkWrite.mockResolvedValue({ modifiedCount: 1 });
  mockEvalEvaluatorBulkWrite.mockResolvedValue({ modifiedCount: 1 });
  mockEvalSetBulkWrite.mockResolvedValue({ modifiedCount: 1 });
  mockEvalScenarioDeleteMany.mockResolvedValue({ deletedCount: 1 });
  mockEvalPersonaDeleteMany.mockResolvedValue({ deletedCount: 1 });
  mockEvalEvaluatorDeleteMany.mockResolvedValue({ deletedCount: 1 });
  mockEvalSetDeleteMany.mockResolvedValue({ deletedCount: 1 });
  mockProjectFindOneAndUpdate.mockResolvedValue({});
  mockListProjectLocalizationAssets.mockResolvedValue([
    {
      id: 'locale-1',
      key: 'locale:fr/messages.json',
      value: JSON.stringify({ messages: { conversation_complete: 'Termine' } }, null, 2),
      description: 'French shared messages',
      relativePath: 'fr/messages.json',
      filePath: 'locales/fr/messages.json',
      localeCode: 'fr',
      fileName: 'messages.json',
      assetName: 'messages',
      scope: 'agent',
      createdAt: '2026-04-01T09:00:00.000Z',
      updatedAt: '2026-04-01T09:05:00.000Z',
    },
  ]);
  mockImportOperationFindOne.mockResolvedValue({
    _id: 'import-op-1',
    status: 'completed',
    layers: { core: { status: 'activated' } },
    error: null,
    preImportSnapshot: Buffer.from('stored-snapshot'),
    createdAt: new Date('2026-04-01T09:00:00.000Z'),
    updatedAt: new Date('2026-04-01T09:05:00.000Z'),
  });
  mockImportOperationCreate.mockResolvedValue({ _id: 'import-op-1' });
  mockImportOperationUpdateOne.mockResolvedValue({});
});

describe('core direct apply support', () => {
  it('loads current studio core state and exposes it as ExistingProjectStateV2', async () => {
    const result = await loadStudioCoreImportState('proj-1', 'tenant-1');

    expect(result.currentState).toEqual({
      agents: [
        {
          name: 'Main',
          description: 'Main agent',
          dslContent: 'AGENT: Main\nGOAL: Help\n',
          systemPromptLibraryRef: null,
        },
      ],
      prompts: [
        {
          promptId: 'pl_prompt_1',
          name: 'Support Prompt',
          description: 'Guidance for support replies',
          tags: ['support'],
          status: 'active',
          nextVersionNumber: 2,
          versions: [
            {
              versionId: 'plv_prompt_1',
              versionNumber: 1,
              template: 'Answer politely.',
              variables: ['customer_name'],
              description: 'Active support prompt',
              status: 'active',
              sourceHash: 'prompt-version-hash-1',
              metadata: { tone: 'friendly' },
            },
          ],
        },
      ],
      tools: [
        {
          name: 'lookup_ticket',
          description: 'Lookup ticket',
          dslContent: 'lookup_ticket(id: string) -> {status: string}\n',
        },
      ],
      mcpServers: [
        {
          name: 'public-repo-tools',
          description: 'Public MCP server',
          transport: 'http',
          url: 'https://mcp.example.com/public-repo',
          authType: 'none',
          priority: 10,
          tags: null,
          connectionTimeoutMs: 15000,
          requestTimeoutMs: 45000,
          autoReconnect: true,
          maxReconnectAttempts: 5,
          lastConnectionStatus: 'connected',
        },
      ],
      locales: [
        {
          relativePath: 'fr/messages.json',
          value: JSON.stringify({ messages: { conversation_complete: 'Termine' } }, null, 2),
          description: 'French shared messages',
        },
      ],
      profiles: [
        {
          name: 'voice_vip',
          dslContent: 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 5\nWHEN: channel == "voice"\n',
        },
      ],
      runtimeConfig: {
        operationTierOverrides: { response_gen: 'powerful' },
        extraction: { nlu_provider: 'standard' },
      },
      llmConfig: {
        operationTierOverrides: { realtime_voice: 'voice' },
      },
      projectModelConfigs: [
        {
          name: 'GPT-4o Realtime Preview (2025-06-03)',
          data: {
            name: 'GPT-4o Realtime Preview (2025-06-03)',
            modelId: 'gpt-4o-realtime-preview-2025-06-03',
            provider: 'openai',
            tier: 'voice',
            isDefault: true,
          },
        },
      ],
      agentModelConfigs: [
        {
          agentName: 'Main',
          data: {
            agentName: 'Main',
            defaultModel: 'gpt-4o-mini',
            operationModels: { response_gen: 'gpt-4o' },
          },
        },
      ],
      evalSets: [
        {
          name: 'SmokeSet',
          data: {
            name: 'SmokeSet',
            description: 'Smoke evals',
            scenarioIds: [],
            personaIds: [],
            evaluatorIds: [],
            variants: 1,
            maxConcurrency: 1,
            ciEnabled: false,
          },
          scenarioNames: ['GreetingScenario'],
          personaNames: ['FriendlyPersona'],
          evaluatorNames: ['QualityJudge'],
        },
      ],
      evalScenarios: [
        {
          name: 'GreetingScenario',
          data: {
            name: 'GreetingScenario',
            description: 'Greets users',
            difficulty: 'easy',
            initialMessage: 'Hello',
            maxTurns: 3,
            tags: [],
            agentPath: ['Main'],
            expectedMilestones: [],
            version: 1,
          },
        },
      ],
      evalPersonas: [
        {
          name: 'FriendlyPersona',
          data: {
            name: 'FriendlyPersona',
            communicationStyle: 'casual',
            domainKnowledge: 'beginner',
            behaviorTraits: ['friendly'],
            goals: 'Get help',
            constraints: '',
            source: 'custom',
            version: 1,
            isAdversarial: false,
            isBuiltIn: false,
          },
        },
      ],
      evalEvaluators: [
        {
          name: 'QualityJudge',
          data: {
            name: 'QualityJudge',
            type: 'llm_judge',
            category: 'quality',
            chainOfThought: true,
            temperature: 0,
            biasSettings: {},
            isBuiltIn: false,
            version: 1,
          },
        },
      ],
      entryAgentName: 'Main',
    });
    const expectedExistingState = buildStudioCoreExistingState(
      [
        {
          _id: 'agent-1',
          name: 'Main',
          description: 'Main agent',
          dslContent: 'AGENT: Main\nGOAL: Help\n',
        } as never,
      ],
      [
        {
          _id: 'tool-1',
          name: 'lookup_ticket',
          description: 'Lookup ticket',
          dslContent: 'lookup_ticket(id: string) -> {status: string}\n',
        } as never,
      ],
      [
        {
          _id: 'mcp-1',
          name: 'public-repo-tools',
          description: 'Public MCP server',
          transport: 'http',
          url: 'https://mcp.example.com/public-repo',
          authType: 'none',
          priority: 10,
          tags: null,
          connectionTimeoutMs: 15000,
          requestTimeoutMs: 45000,
          autoReconnect: true,
          maxReconnectAttempts: 5,
          lastConnectionStatus: 'connected',
        } as never,
      ],
      [
        {
          relativePath: 'fr/messages.json',
          value: JSON.stringify({ messages: { conversation_complete: 'Termine' } }, null, 2),
          description: 'French shared messages',
        },
      ],
      [
        {
          name: 'voice_vip',
          dslContent: 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 5\nWHEN: channel == "voice"\n',
        },
      ],
      [
        {
          _id: 'set-1',
          name: 'SmokeSet',
          description: 'Smoke evals',
          scenarioIds: ['scenario-1'],
          personaIds: ['persona-1'],
          evaluatorIds: ['evaluator-1'],
          variants: 1,
          maxConcurrency: 1,
          ciEnabled: false,
        } as never,
      ],
      [
        {
          _id: 'scenario-1',
          name: 'GreetingScenario',
          description: 'Greets users',
          difficulty: 'easy',
          initialMessage: 'Hello',
          maxTurns: 3,
          tags: [],
          agentPath: ['Main'],
          expectedMilestones: [],
          version: 1,
        } as never,
      ],
      [
        {
          _id: 'persona-1',
          name: 'FriendlyPersona',
          communicationStyle: 'casual',
          domainKnowledge: 'beginner',
          behaviorTraits: ['friendly'],
          goals: 'Get help',
          constraints: '',
          source: 'custom',
          version: 1,
          isAdversarial: false,
          isBuiltIn: false,
        } as never,
      ],
      [
        {
          _id: 'evaluator-1',
          name: 'QualityJudge',
          type: 'llm_judge',
          category: 'quality',
          chainOfThought: true,
          temperature: 0,
          biasSettings: {},
          isBuiltIn: false,
          version: 1,
        } as never,
      ],
      [
        {
          promptId: 'pl_prompt_1',
          name: 'Support Prompt',
          description: 'Guidance for support replies',
          tags: ['support'],
          status: 'active',
          nextVersionNumber: 2,
          versions: [
            {
              versionId: 'plv_prompt_1',
              versionNumber: 1,
              template: 'Answer politely.',
              variables: ['customer_name'],
              description: 'Active support prompt',
              status: 'active',
              sourceHash: 'prompt-version-hash-1',
              metadata: { tone: 'friendly' },
            },
          ],
        },
      ],
    );
    expectedExistingState.runtimeConfig = {
      operationTierOverrides: { response_gen: 'powerful' },
      extraction: { nlu_provider: 'standard' },
    };
    expectedExistingState.llmConfig = {
      operationTierOverrides: { realtime_voice: 'voice' },
    };
    expectedExistingState.projectModelConfigs = new Map([
      [
        'GPT-4o Realtime Preview (2025-06-03)',
        {
          name: 'GPT-4o Realtime Preview (2025-06-03)',
          data: {
            name: 'GPT-4o Realtime Preview (2025-06-03)',
            modelId: 'gpt-4o-realtime-preview-2025-06-03',
            provider: 'openai',
            tier: 'voice',
            isDefault: true,
          },
        },
      ],
    ]);
    expectedExistingState.agentModelConfigs = new Map([
      [
        'Main',
        {
          agentName: 'Main',
          data: {
            agentName: 'Main',
            defaultModel: 'gpt-4o-mini',
            operationModels: { response_gen: 'gpt-4o' },
          },
        },
      ],
    ]);
    expectedExistingState.prompts = new Map([
      [
        'pl_prompt_1',
        {
          promptId: 'pl_prompt_1',
          name: 'Support Prompt',
          description: 'Guidance for support replies',
          tags: ['support'],
          status: 'active',
          nextVersionNumber: 2,
          versions: [
            {
              versionId: 'plv_prompt_1',
              versionNumber: 1,
              template: 'Answer politely.',
              variables: ['customer_name'],
              description: 'Active support prompt',
              status: 'active',
              sourceHash: 'prompt-version-hash-1',
              metadata: { tone: 'friendly' },
            },
          ],
        },
      ],
    ]);
    expect(result.existingState).toMatchObject(expectedExistingState);
    expect(result.existingState.runtimeConfig).toEqual({
      operationTierOverrides: { response_gen: 'powerful' },
      extraction: { nlu_provider: 'standard' },
    });
    expect(result.existingState.llmConfig).toEqual({
      operationTierOverrides: { realtime_voice: 'voice' },
    });
    expect(
      result.existingState.projectModelConfigs?.get('GPT-4o Realtime Preview (2025-06-03)'),
    ).toEqual({
      name: 'GPT-4o Realtime Preview (2025-06-03)',
      data: {
        name: 'GPT-4o Realtime Preview (2025-06-03)',
        modelId: 'gpt-4o-realtime-preview-2025-06-03',
        provider: 'openai',
        tier: 'voice',
        isDefault: true,
      },
    });
    expect(result.existingState.agentModelConfigs?.get('Main')).toEqual({
      agentName: 'Main',
      data: {
        agentName: 'Main',
        defaultModel: 'gpt-4o-mini',
        operationModels: { response_gen: 'gpt-4o' },
      },
    });
    expect(mockModelConfigFind).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(mockAgentModelConfigFind).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(result.existingState.agents.get('Main')).toEqual({
      name: 'Main',
      dslContent: 'AGENT: Main\nGOAL: Help\n',
      systemPromptLibraryRef: null,
    });
    expect(result.existingState.prompts?.get('pl_prompt_1')).toEqual({
      promptId: 'pl_prompt_1',
      name: 'Support Prompt',
      description: 'Guidance for support replies',
      tags: ['support'],
      status: 'active',
      nextVersionNumber: 2,
      versions: [
        {
          versionId: 'plv_prompt_1',
          versionNumber: 1,
          template: 'Answer politely.',
          variables: ['customer_name'],
          description: 'Active support prompt',
          status: 'active',
          sourceHash: 'prompt-version-hash-1',
          metadata: { tone: 'friendly' },
        },
      ],
    });
    expect(result.existingState.tools.get('lookup_ticket')).toEqual({
      name: 'lookup_ticket',
      dslContent: 'lookup_ticket(id: string) -> {status: string}\n',
    });
    expect(result.existingState.mcpServers?.get('public-repo-tools')).toEqual({
      name: 'public-repo-tools',
      config: {
        name: 'public-repo-tools',
        description: 'Public MCP server',
        transport: 'http',
        url: 'https://mcp.example.com/public-repo',
        authType: 'none',
        priority: 10,
        tags: null,
        connectionTimeoutMs: 15000,
        requestTimeoutMs: 45000,
        autoReconnect: true,
        maxReconnectAttempts: 5,
        lastConnectionStatus: 'connected',
      },
    });
    expect(result.existingState.localeFiles?.get('locales/fr/messages.json')).toBe(
      JSON.stringify({ messages: { conversation_complete: 'Termine' } }, null, 2),
    );
    expect(
      result.existingState.profileFiles?.get('behavior_profiles/voice_vip.behavior_profile.abl'),
    ).toBe('BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 5\nWHEN: channel == "voice"\n');
  });

  it('creates a shared adapter with the expected database writes', async () => {
    const adapter = createStudioCoreImportApplyAdapter({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      now: new Date('2026-04-01T09:30:00.000Z'),
    });

    await adapter.createAgents([
      {
        type: 'create',
        agentName: 'ImportedAgent',
        description: 'Imported agent',
        dslContent: 'AGENT: ImportedAgent\nGOAL: Import\n',
        sourceHash: 'agent-hash',
      },
    ]);
    await adapter.updateAgents([
      {
        type: 'update',
        agentName: 'Main',
        description: 'Updated main',
        dslContent: 'AGENT: Main\nGOAL: Updated\n',
        sourceHash: 'updated-hash',
      },
    ]);
    await adapter.createPrompts([
      {
        type: 'create',
        promptId: 'pl_prompt_1',
        promptName: 'Support Prompt',
        bundle: {
          promptId: 'pl_prompt_1',
          name: 'Support Prompt',
          description: 'Guidance for support replies',
          tags: ['support'],
          status: 'active',
          nextVersionNumber: 2,
          versions: [
            {
              versionId: 'plv_prompt_1',
              versionNumber: 1,
              template: 'Answer politely.',
              variables: ['customer_name'],
              description: 'Active support prompt',
              status: 'active',
              sourceHash: 'prompt-version-hash-1',
            },
          ],
        },
        sourceHash: 'prompt-bundle-hash',
        sourceFile: 'prompts/support_prompt.prompt.json',
      },
    ]);
    await adapter.deleteAgents(['Legacy']);
    await adapter.upsertModelPolicyConfigs([
      {
        type: 'upsert',
        configType: 'runtime',
        data: { operationTierOverrides: { response_gen: 'powerful' } },
        sourceFile: 'config/runtime-config.json',
        sourceHash: 'runtime-hash',
      },
      {
        type: 'upsert',
        configType: 'llm',
        data: { operationTierOverrides: { realtime_voice: 'voice' } },
        sourceFile: 'config/llm-config.json',
        sourceHash: 'llm-hash',
      },
      {
        type: 'upsert',
        configType: 'project_model',
        modelConfigName: 'GPT-4o Realtime Preview (2025-06-03)',
        data: {
          name: 'GPT-4o Realtime Preview (2025-06-03)',
          modelId: 'gpt-4o-realtime-preview-2025-06-03',
          provider: 'openai',
          tenantModelId: 'tm-source-voice',
          tier: 'voice',
          isDefault: true,
        },
        sourceFile:
          'config/project-model-configs/gpt_4o_realtime_preview_2025_06_03.model-config.json',
        sourceHash: 'project-model-hash',
      },
      {
        type: 'upsert',
        configType: 'agent_model',
        agentName: 'Main',
        data: {
          agentName: 'Main',
          defaultModel: 'gpt-4o-mini',
          operationModels: { response_gen: 'gpt-4o' },
        },
        sourceFile: 'config/agent-model-configs/Main.model-config.json',
        sourceHash: 'agent-model-hash',
      },
    ]);
    await adapter.deleteModelPolicyConfigs([
      {
        type: 'delete',
        configType: 'agent_model',
        agentName: 'Legacy',
        data: null,
        sourceFile: null,
        sourceHash: null,
      },
    ]);
    await adapter.createMcpServers([
      {
        type: 'create',
        serverName: 'public-repo-tools',
        config: {
          name: 'public-repo-tools',
          description: 'Public MCP server',
          transport: 'http',
          url: 'https://mcp.example.com/public-repo',
          authType: 'none',
          priority: 10,
          tags: null,
          connectionTimeoutMs: 15000,
          requestTimeoutMs: 45000,
          autoReconnect: true,
          maxReconnectAttempts: 5,
          lastConnectionStatus: 'connected',
        },
        sourceHash: 'mcp-hash',
        sourceFile: 'core/mcp-servers/public-repo-tools.mcp-config.json',
      },
    ]);
    await adapter.updateMcpServers([
      {
        type: 'update',
        serverName: 'public-repo-tools',
        config: {
          name: 'public-repo-tools',
          description: 'Updated MCP server',
          transport: 'http',
          url: 'https://mcp.example.com/public-repo-v2',
          authType: 'none',
          priority: 5,
          tags: null,
          connectionTimeoutMs: 12000,
          requestTimeoutMs: 40000,
          autoReconnect: true,
          maxReconnectAttempts: 3,
          lastConnectionStatus: 'untested',
        },
        sourceHash: 'mcp-hash-2',
        sourceFile: 'core/mcp-servers/public-repo-tools.mcp-config.json',
      },
    ]);
    await adapter.deleteMcpServers(['obsolete-mcp']);
    await adapter.createTools([
      {
        type: 'create',
        toolName: 'lookup_ticket',
        toolType: 'http',
        description: 'Lookup ticket',
        dslContent: 'lookup_ticket(id: string) -> {status: string}\n',
        sourceHash: 'tool-hash',
        sourceFile: 'tools/lookup_ticket.tools.abl',
      },
    ]);
    await adapter.updateTools([
      {
        type: 'update',
        toolName: 'lookup_ticket',
        toolType: 'http',
        description: 'Updated lookup',
        dslContent: 'lookup_ticket(id: string) -> {status: string, ok: boolean}\n',
        sourceHash: 'tool-hash-2',
        sourceFile: 'tools/lookup_ticket.tools.abl',
      },
    ]);
    await adapter.deleteTools(['obsolete_tool']);
    await adapter.createLocales([
      {
        type: 'create',
        relativePath: 'fr/messages.json',
        filePath: 'locales/fr/messages.json',
        value: JSON.stringify({ messages: { conversation_complete: 'Termine' } }, null, 2),
        description: 'French shared messages',
        sourceHash: 'locale-hash',
        sourceFile: 'locales/fr/messages.json',
      },
    ]);
    await adapter.updateLocales([
      {
        type: 'update',
        relativePath: 'fr/messages.json',
        filePath: 'locales/fr/messages.json',
        value: JSON.stringify({ messages: { conversation_complete: 'Mis a jour' } }, null, 2),
        description: 'French shared messages',
        sourceHash: 'locale-hash-2',
        sourceFile: 'locales/fr/messages.json',
      },
    ]);
    await adapter.deleteLocales(['fr/messages.json']);
    await adapter.createProfiles([
      {
        type: 'create',
        profileName: 'voice_vip',
        filePath: 'behavior_profiles/voice_vip.behavior_profile.abl',
        dslContent: 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 5\nWHEN: channel == "voice"\n',
        sourceHash: 'profile-hash',
        sourceFile: 'behavior_profiles/voice_vip.behavior_profile.abl',
      },
    ]);
    await adapter.updateProfiles([
      {
        type: 'update',
        profileName: 'voice_vip',
        filePath: 'behavior_profiles/voice_vip.behavior_profile.abl',
        dslContent:
          'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 7\nWHEN: channel == "voice" || channel == "phone"\n',
        sourceHash: 'profile-hash-2',
        sourceFile: 'behavior_profiles/voice_vip.behavior_profile.abl',
      },
    ]);
    await adapter.deleteProfiles(['voice_vip']);
    await adapter.createEvalRecords?.([
      {
        type: 'create',
        collection: 'eval_scenarios',
        name: 'GreetingScenario',
        data: { name: 'GreetingScenario', difficulty: 'easy' },
        sourceHash: 'scenario-hash',
        sourceFile: 'evals/scenarios/greeting.scenario.json',
      },
      {
        type: 'create',
        collection: 'eval_sets',
        name: 'SmokeSet',
        data: { name: 'SmokeSet', variants: 1 },
        sourceHash: 'set-hash',
        sourceFile: 'evals/smoke/eval-set.json',
        scenarioNames: ['GreetingScenario'],
        personaNames: ['FriendlyPersona'],
        evaluatorNames: ['QualityJudge'],
      },
    ]);
    await adapter.updateEvalRecords?.([
      {
        type: 'update',
        collection: 'eval_sets',
        name: 'SmokeSet',
        data: { name: 'SmokeSet', variants: 2 },
        sourceHash: 'set-hash-2',
        sourceFile: 'evals/smoke/eval-set.json',
        scenarioNames: ['GreetingScenario'],
        personaNames: ['FriendlyPersona'],
        evaluatorNames: ['QualityJudge'],
      },
    ]);
    await adapter.deleteEvalRecords?.([
      {
        type: 'delete',
        collection: 'eval_sets',
        name: 'OldSet',
        data: null,
        sourceHash: null,
        sourceFile: null,
      },
    ]);
    await adapter.setEntryAgent('ImportedAgent');
    await adapter.rollbackCreated(
      [],
      ['agent-created-1'],
      ['tool-created-1'],
      ['mcp-created-1'],
      ['created-locale-1'],
      ['created-profile-1'],
      { eval_sets: ['created-set-1'], eval_scenarios: ['created-scenario-1'] },
    );

    expect(mockProjectAgentInsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'ImportedAgent',
        lastEditedBy: 'user-1',
        lastEditedAt: new Date('2026-04-01T09:30:00.000Z'),
        dslValidationStatus: 'valid',
        dslDiagnostics: [],
      }),
    ]);
    expect(mockPromptLibraryItemInsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        _id: 'pl_prompt_1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'Support Prompt',
        createdBy: 'user-1',
      }),
    ]);
    expect(mockPromptLibraryVersionInsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        _id: 'plv_prompt_1',
        promptId: 'pl_prompt_1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        createdBy: 'user-1',
      }),
    ]);
    expect(mockProjectAgentBulkWrite).toHaveBeenCalledWith([
      expect.objectContaining({
        updateOne: expect.objectContaining({
          filter: { projectId: 'proj-1', tenantId: 'tenant-1', name: 'Main' },
          update: expect.objectContaining({
            $set: expect.objectContaining({
              dslValidationStatus: 'valid',
              dslDiagnostics: [],
            }),
          }),
        }),
      }),
    ]);
    expect(mockProjectAgentDeleteMany).toHaveBeenNthCalledWith(1, {
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: { $in: ['Legacy'] },
    });
    expect(mockProjectAgentDeleteMany).toHaveBeenNthCalledWith(2, {
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      _id: { $in: ['agent-created-1'] },
    });

    expect(mockProjectRuntimeConfigFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'proj-1', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          operationTierOverrides: { response_gen: 'powerful' },
        }),
      },
      { upsert: true, new: true },
    );
    expect(mockProjectLLMConfigFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'proj-1', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          operationTierOverrides: { realtime_voice: 'voice' },
        }),
      },
      { upsert: true, new: true },
    );
    expect(mockTenantModelFind).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      provider: 'openai',
      modelId: 'gpt-4o-realtime-preview-2025-06-03',
      isActive: true,
      inferenceEnabled: { $ne: false },
    });
    expect(mockModelConfigFindOneAndUpdate).toHaveBeenCalledWith(
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'GPT-4o Realtime Preview (2025-06-03)',
      },
      {
        $set: expect.objectContaining({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          name: 'GPT-4o Realtime Preview (2025-06-03)',
          modelId: 'gpt-4o-realtime-preview-2025-06-03',
          provider: 'openai',
          tier: 'voice',
          tenantModelId: 'tm-destination-voice',
        }),
      },
      { upsert: true, new: true },
    );
    expect(mockAgentModelConfigFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'proj-1', tenantId: 'tenant-1', agentName: 'Main' },
      {
        $set: expect.objectContaining({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          agentName: 'Main',
          defaultModel: 'gpt-4o-mini',
        }),
      },
      { upsert: true, new: true },
    );
    expect(mockAgentModelConfigDeleteOne).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      agentName: 'Legacy',
    });

    expect(mockMCPServerConfigInsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'public-repo-tools',
        createdBy: 'user-1',
        modifiedBy: 'user-1',
      }),
    ]);
    expect(mockMCPServerConfigBulkWrite).toHaveBeenCalledWith([
      expect.objectContaining({
        updateOne: expect.objectContaining({
          filter: { projectId: 'proj-1', tenantId: 'tenant-1', name: 'public-repo-tools' },
        }),
      }),
    ]);
    expect(mockMCPServerConfigDeleteMany).toHaveBeenNthCalledWith(1, {
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: { $in: ['obsolete-mcp'] },
    });
    expect(mockMCPServerConfigDeleteMany).toHaveBeenNthCalledWith(2, {
      _id: { $in: ['mcp-created-1'] },
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });

    expect(mockProjectToolInsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'lookup_ticket',
        toolType: 'http',
        createdBy: 'user-1',
      }),
    ]);
    expect(mockProjectToolBulkWrite).toHaveBeenCalledWith([
      expect.objectContaining({
        updateOne: expect.objectContaining({
          filter: { projectId: 'proj-1', tenantId: 'tenant-1', name: 'lookup_ticket' },
        }),
      }),
    ]);
    expect(mockProjectToolDeleteMany).toHaveBeenNthCalledWith(1, {
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: { $in: ['obsolete_tool'] },
    });
    expect(mockProjectToolDeleteMany).toHaveBeenNthCalledWith(2, {
      _id: { $in: ['tool-created-1'] },
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(mockProjectConfigVariableInsertMany).toHaveBeenNthCalledWith(1, [
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        key: 'locale:fr/messages.json',
        value: JSON.stringify({ messages: { conversation_complete: 'Termine' } }, null, 2),
        description: 'French shared messages',
        createdBy: 'user-1',
        updatedBy: 'user-1',
      },
    ]);
    expect(mockProjectConfigVariableInsertMany).toHaveBeenNthCalledWith(2, [
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        key: 'profile:voice_vip',
        value: 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 5\nWHEN: channel == "voice"\n',
        description: 'Behavior profile: voice_vip',
        createdBy: 'user-1',
        updatedBy: 'user-1',
      },
    ]);
    expect(mockProjectConfigVariableBulkWrite).toHaveBeenNthCalledWith(1, [
      {
        updateOne: {
          filter: {
            projectId: 'proj-1',
            tenantId: 'tenant-1',
            key: 'locale:fr/messages.json',
          },
          update: {
            $set: {
              value: JSON.stringify({ messages: { conversation_complete: 'Mis a jour' } }, null, 2),
              updatedBy: 'user-1',
            },
          },
        },
      },
    ]);
    expect(mockProjectConfigVariableBulkWrite).toHaveBeenNthCalledWith(2, [
      {
        updateOne: {
          filter: {
            projectId: 'proj-1',
            tenantId: 'tenant-1',
            key: 'profile:voice_vip',
          },
          update: {
            $set: {
              value:
                'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 7\nWHEN: channel == "voice" || channel == "phone"\n',
              description: 'Behavior profile: voice_vip',
              updatedBy: 'user-1',
            },
          },
        },
      },
    ]);
    expect(mockProjectConfigVariableDeleteMany).toHaveBeenNthCalledWith(1, {
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      key: { $in: ['locale:fr/messages.json'] },
    });
    expect(mockProjectConfigVariableDeleteMany).toHaveBeenNthCalledWith(2, {
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      key: { $in: ['profile:voice_vip'] },
    });
    expect(mockProjectConfigVariableDeleteMany).toHaveBeenNthCalledWith(3, {
      _id: { $in: ['created-locale-1'] },
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(mockProjectConfigVariableDeleteMany).toHaveBeenNthCalledWith(4, {
      _id: { $in: ['created-profile-1'] },
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(mockEvalScenarioInsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'GreetingScenario',
        createdBy: 'user-1',
      }),
    ]);
    expect(mockEvalSetInsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'SmokeSet',
        scenarioIds: ['scenario-1'],
        personaIds: ['persona-1'],
        evaluatorIds: ['evaluator-1'],
        createdBy: 'user-1',
      }),
    ]);
    expect(mockEvalSetBulkWrite).toHaveBeenCalledWith([
      {
        updateOne: {
          filter: { projectId: 'proj-1', tenantId: 'tenant-1', name: 'SmokeSet' },
          update: {
            $set: expect.objectContaining({
              projectId: 'proj-1',
              tenantId: 'tenant-1',
              scenarioIds: ['scenario-1'],
              personaIds: ['persona-1'],
              evaluatorIds: ['evaluator-1'],
            }),
            $inc: { _v: 1 },
          },
        },
      },
    ]);
    expect(mockEvalSetDeleteMany).toHaveBeenNthCalledWith(1, {
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: { $in: ['OldSet'] },
    });
    expect(mockEvalSetDeleteMany).toHaveBeenNthCalledWith(2, {
      _id: { $in: ['created-set-1'] },
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(mockEvalScenarioDeleteMany).toHaveBeenCalledWith({
      _id: { $in: ['created-scenario-1'] },
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(mockProjectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'proj-1', tenantId: 'tenant-1' },
      { $set: { entryAgentName: 'ImportedAgent' } },
    );
  });

  it('imports project model configs as unfulfilled when the target tenant model is absent', async () => {
    mockTenantModelFind.mockResolvedValueOnce([]);

    const adapter = createStudioCoreImportApplyAdapter({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      now: new Date('2026-04-01T09:30:00.000Z'),
    });

    await adapter.upsertModelPolicyConfigs([
      {
        type: 'upsert',
        configType: 'project_model',
        modelConfigName: 'GPT-4.1 Nano',
        data: {
          name: 'GPT-4.1 Nano',
          modelId: 'gpt-4.1-nano-2025-04-14',
          provider: 'openai',
          tier: 'fast',
          isDefault: true,
          tenantModelId: 'source-tenant-model',
        },
        sourceFile: 'config/project-model-configs/GPT-4.1 Nano.model-config.json',
        sourceHash: 'project-model-hash',
      },
    ]);

    expect(mockTenantModelFind).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      provider: 'openai',
      modelId: 'gpt-4.1-nano-2025-04-14',
      isActive: true,
      inferenceEnabled: { $ne: false },
    });
    expect(mockModelConfigFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'proj-1', tenantId: 'tenant-1', name: 'GPT-4.1 Nano' },
      {
        $set: expect.objectContaining({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          name: 'GPT-4.1 Nano',
          modelId: 'gpt-4.1-nano-2025-04-14',
          provider: 'openai',
          tenantModelId: null,
        }),
      },
      { upsert: true, new: true },
    );
  });

  it('assigns destination default variable namespace IDs to imported tools', async () => {
    const adapter = createStudioCoreImportApplyAdapter({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    });

    await adapter.createTools([
      {
        type: 'create',
        toolName: 'lookup_customer',
        toolType: 'http',
        description: 'Lookup customer',
        dslContent:
          'lookup_customer(id: string) -> object\n  type: http\n  endpoint: "{{config.CRM_BASE_URL}}/customers/{{input.id}}"',
        sourceHash: 'tool-hash',
        sourceFile: 'tools/lookup_customer.tools.abl',
      },
    ]);

    expect(mockVariableNamespaceFindOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      isDefault: true,
    });
    expect(mockProjectToolInsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'lookup_customer',
        variableNamespaceIds: ['ns-default'],
      }),
    ]);
  });

  it('backfills destination default variable namespace IDs when updating legacy imported tools', async () => {
    mockProjectToolFind.mockResolvedValueOnce([
      {
        _id: 'tool-legacy',
        name: 'lookup_customer',
        variableNamespaceIds: [],
      },
      {
        _id: 'tool-scoped',
        name: 'lookup_order',
        variableNamespaceIds: ['ns-custom'],
      },
    ]);

    const adapter = createStudioCoreImportApplyAdapter({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    });

    await adapter.updateTools([
      {
        type: 'update',
        toolName: 'lookup_customer',
        toolType: 'http',
        description: 'Lookup customer',
        dslContent:
          'lookup_customer(id: string) -> object\n  type: http\n  endpoint: "{{config.CRM_BASE_URL}}/customers/{{input.id}}"',
        sourceHash: 'tool-hash-1',
        sourceFile: 'tools/lookup_customer.tools.abl',
      },
      {
        type: 'update',
        toolName: 'lookup_order',
        toolType: 'http',
        description: 'Lookup order',
        dslContent:
          'lookup_order(id: string) -> object\n  type: http\n  endpoint: "{{config.ORDER_BASE_URL}}/orders/{{input.id}}"',
        sourceHash: 'tool-hash-2',
        sourceFile: 'tools/lookup_order.tools.abl',
      },
    ]);

    expect(mockProjectToolBulkWrite).toHaveBeenCalledWith([
      expect.objectContaining({
        updateOne: expect.objectContaining({
          filter: expect.objectContaining({ name: 'lookup_customer' }),
          update: expect.objectContaining({
            $set: expect.objectContaining({ variableNamespaceIds: ['ns-default'] }),
          }),
        }),
      }),
      expect.objectContaining({
        updateOne: expect.objectContaining({
          filter: expect.objectContaining({ name: 'lookup_order' }),
          update: expect.objectContaining({
            $set: expect.not.objectContaining({ variableNamespaceIds: expect.anything() }),
          }),
        }),
      }),
    ]);
  });

  it('keeps model policy delete mirrors consistent without runtime deletes erasing LLM config', async () => {
    const adapter = createStudioCoreImportApplyAdapter({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      now: new Date('2026-04-01T09:30:00.000Z'),
    });

    await adapter.deleteModelPolicyConfigs([
      {
        type: 'delete',
        configType: 'runtime',
        data: null,
        sourceFile: null,
        sourceHash: null,
      },
      {
        type: 'delete',
        configType: 'llm',
        data: null,
        sourceFile: null,
        sourceHash: null,
      },
    ]);

    expect(mockProjectRuntimeConfigDeleteOne).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(mockProjectLLMConfigDeleteOne).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(mockProjectLLMConfigDeleteOne).toHaveBeenCalledTimes(1);
    expect(mockProjectRuntimeConfigFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'proj-1', tenantId: 'tenant-1' },
      { $set: { operationTierOverrides: {} } },
      { new: true },
    );
  });

  it('deletes project model configs inside the destination tenant only', async () => {
    const adapter = createStudioCoreImportApplyAdapter({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      now: new Date('2026-04-01T09:30:00.000Z'),
    });

    await adapter.deleteModelPolicyConfigs([
      {
        type: 'delete',
        configType: 'project_model',
        modelConfigName: 'GPT-4o Realtime Preview (2025-06-03)',
        data: null,
        sourceFile: null,
        sourceHash: null,
      },
    ]);

    expect(mockModelConfigDeleteOne).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'GPT-4o Realtime Preview (2025-06-03)',
    });
  });

  it('annotates imported agent writes with DSL validation metadata', async () => {
    const adapter = createStudioCoreImportApplyAdapter({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      now: new Date('2026-04-01T09:30:00.000Z'),
    });

    await adapter.createAgents([
      {
        type: 'create',
        agentName: 'ImportedAgent',
        description: 'Imported agent',
        dslContent: 'AGENT: ImportedAgent\nGOAL: "Import"\nPERSONA: "Helpful"\n',
        sourceHash: 'agent-hash',
      },
    ]);
    await adapter.updateAgents([
      {
        type: 'update',
        agentName: 'BrokenAgent',
        description: 'Broken agent',
        dslContent: 'GOAL: "Missing agent header"\n',
        sourceHash: 'broken-hash',
      },
    ]);

    expect(mockProjectAgentInsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'ImportedAgent',
        dslValidationStatus: 'valid',
        dslDiagnostics: [],
      }),
    ]);
    expect(mockProjectAgentBulkWrite).toHaveBeenCalledWith([
      expect.objectContaining({
        updateOne: expect.objectContaining({
          filter: { projectId: 'proj-1', tenantId: 'tenant-1', name: 'BrokenAgent' },
          update: expect.objectContaining({
            $set: expect.objectContaining({
              dslValidationStatus: 'error',
              dslDiagnostics: expect.arrayContaining([
                expect.objectContaining({
                  severity: 'error',
                  source: 'project-import',
                }),
              ]),
            }),
          }),
        }),
      }),
    ]);
  });

  it('marks parse-valid but compiler-invalid imported drafts as error', async () => {
    mockProjectAgentFind.mockResolvedValue([]);

    const adapter = createStudioCoreImportApplyAdapter({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      now: new Date('2026-04-01T09:30:00.000Z'),
    });

    await adapter.createAgents([
      {
        type: 'create',
        agentName: 'billing_agent',
        description: 'Imported billing agent',
        dslContent: `AGENT: billing_agent
GOAL: "Handle billing questions"

HANDOFF:
  - TO: booking_agent
    WHEN: always
    CONTEXT:
      pass: []
`,
        sourceHash: 'billing-hash',
      },
    ]);

    expect(mockProjectAgentInsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'billing_agent',
        dslValidationStatus: 'error',
        dslDiagnostics: expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            source: 'project-import',
            message: expect.stringContaining('Handoff target "booking_agent" does not exist'),
          }),
        ]),
      }),
    ]);
  });

  it('validates imported agent drafts with the Studio tool resolution context', async () => {
    mockProjectAgentFind.mockResolvedValue([]);

    const adapter = createStudioCoreImportApplyAdapter({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      now: new Date('2026-04-01T09:30:00.000Z'),
    });

    await adapter.createAgents([
      {
        type: 'create',
        agentName: 'ImportedAgent',
        description: 'Imported agent',
        dslContent: `AGENT: ImportedAgent
GOAL: "Import"

TOOLS:
  lookup_ticket(query: string) -> object
    description: "Lookup a ticket"
`,
        sourceHash: 'agent-hash',
      },
    ]);

    expect(mockResolveToolImplementations).toHaveBeenCalledTimes(1);
    const [input, deps] = mockResolveToolImplementations.mock.calls[0];
    expect(input).toEqual({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      toolsByAgent: new Map([['ImportedAgent', ['lookup_ticket']]]),
    });
    expect(deps).toMatchObject({
      connectorToolResolver: 'connector-resolver',
      mcpServerConfigRawLoader: expect.any(Function),
    });
  });

  it('refreshes untouched sibling metadata against the final imported agent set', async () => {
    mockProjectAgentFind.mockResolvedValueOnce([
      {
        _id: 'agent-billing',
        name: 'billing_agent',
        dslContent: `AGENT: billing_agent
GOAL: "Handle billing questions"

HANDOFF:
  - TO: booking_agent
    WHEN: always
    CONTEXT:
      pass: []
`,
      },
    ]);

    const adapter = createStudioCoreImportApplyAdapter({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      now: new Date('2026-04-01T09:30:00.000Z'),
    });

    await adapter.refreshAgentDraftMetadata?.();

    expect(mockProjectAgentBulkWrite).toHaveBeenCalledWith([
      expect.objectContaining({
        updateOne: expect.objectContaining({
          filter: {
            _id: 'agent-billing',
            projectId: 'proj-1',
            tenantId: 'tenant-1',
          },
          update: expect.objectContaining({
            $set: expect.objectContaining({
              dslValidationStatus: 'error',
              dslDiagnostics: expect.arrayContaining([
                expect.objectContaining({
                  severity: 'error',
                  source: 'project-import',
                  message: expect.stringContaining('Handoff target "booking_agent" does not exist'),
                }),
              ]),
            }),
          }),
        }),
      }),
    ]);
  });

  it('creates and reads import operations through the shared store', async () => {
    const store = createStudioCoreImportStore({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });

    const currentState = await store.loadCurrentState();
    const operation = await store.createCompletedOperation(Buffer.from('snapshot'));
    const status = await store.getOperationStatus('import-op-1');
    const snapshot = await store.getOperationSnapshot('import-op-1');

    expect(currentState).toEqual({
      agents: [
        {
          name: 'Main',
          description: 'Main agent',
          dslContent: 'AGENT: Main\nGOAL: Help\n',
          systemPromptLibraryRef: null,
        },
      ],
      prompts: [
        {
          promptId: 'pl_prompt_1',
          name: 'Support Prompt',
          description: 'Guidance for support replies',
          tags: ['support'],
          status: 'active',
          nextVersionNumber: 2,
          versions: [
            {
              versionId: 'plv_prompt_1',
              versionNumber: 1,
              template: 'Answer politely.',
              variables: ['customer_name'],
              description: 'Active support prompt',
              status: 'active',
              sourceHash: 'prompt-version-hash-1',
              metadata: { tone: 'friendly' },
            },
          ],
        },
      ],
      tools: [
        {
          name: 'lookup_ticket',
          description: 'Lookup ticket',
          dslContent: 'lookup_ticket(id: string) -> {status: string}\n',
        },
      ],
      mcpServers: [
        {
          name: 'public-repo-tools',
          description: 'Public MCP server',
          transport: 'http',
          url: 'https://mcp.example.com/public-repo',
          authType: 'none',
          priority: 10,
          tags: null,
          connectionTimeoutMs: 15000,
          requestTimeoutMs: 45000,
          autoReconnect: true,
          maxReconnectAttempts: 5,
          lastConnectionStatus: 'connected',
        },
      ],
      locales: [
        {
          relativePath: 'fr/messages.json',
          value: JSON.stringify({ messages: { conversation_complete: 'Termine' } }, null, 2),
          description: 'French shared messages',
        },
      ],
      profiles: [
        {
          name: 'voice_vip',
          dslContent: 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 5\nWHEN: channel == "voice"\n',
        },
      ],
      runtimeConfig: {
        operationTierOverrides: { response_gen: 'powerful' },
        extraction: { nlu_provider: 'standard' },
      },
      llmConfig: {
        operationTierOverrides: { realtime_voice: 'voice' },
      },
      projectModelConfigs: [
        {
          name: 'GPT-4o Realtime Preview (2025-06-03)',
          data: {
            name: 'GPT-4o Realtime Preview (2025-06-03)',
            modelId: 'gpt-4o-realtime-preview-2025-06-03',
            provider: 'openai',
            tier: 'voice',
            isDefault: true,
          },
        },
      ],
      agentModelConfigs: [
        {
          agentName: 'Main',
          data: {
            agentName: 'Main',
            defaultModel: 'gpt-4o-mini',
            operationModels: { response_gen: 'gpt-4o' },
          },
        },
      ],
      evalSets: [
        {
          name: 'SmokeSet',
          data: {
            name: 'SmokeSet',
            description: 'Smoke evals',
            scenarioIds: [],
            personaIds: [],
            evaluatorIds: [],
            variants: 1,
            maxConcurrency: 1,
            ciEnabled: false,
          },
          scenarioNames: ['GreetingScenario'],
          personaNames: ['FriendlyPersona'],
          evaluatorNames: ['QualityJudge'],
        },
      ],
      evalScenarios: [
        {
          name: 'GreetingScenario',
          data: {
            name: 'GreetingScenario',
            description: 'Greets users',
            difficulty: 'easy',
            initialMessage: 'Hello',
            maxTurns: 3,
            tags: [],
            agentPath: ['Main'],
            expectedMilestones: [],
            version: 1,
          },
        },
      ],
      evalPersonas: [
        {
          name: 'FriendlyPersona',
          data: {
            name: 'FriendlyPersona',
            communicationStyle: 'casual',
            domainKnowledge: 'beginner',
            behaviorTraits: ['friendly'],
            goals: 'Get help',
            constraints: '',
            source: 'custom',
            version: 1,
            isAdversarial: false,
            isBuiltIn: false,
          },
        },
      ],
      evalEvaluators: [
        {
          name: 'QualityJudge',
          data: {
            name: 'QualityJudge',
            type: 'llm_judge',
            category: 'quality',
            chainOfThought: true,
            temperature: 0,
            biasSettings: {},
            isBuiltIn: false,
            version: 1,
          },
        },
      ],
      entryAgentName: 'Main',
    });
    expect(mockImportOperationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        status: 'completed',
        preImportSnapshot: expect.any(Buffer),
        expiresAt: expect.any(Date),
      }),
    );
    expect(operation).toEqual({ operationId: 'import-op-1' });
    expect(status).toEqual({
      operationId: 'import-op-1',
      status: 'completed',
      layers: { core: { status: 'activated' } },
      error: null,
      createdAt: new Date('2026-04-01T09:00:00.000Z'),
      updatedAt: new Date('2026-04-01T09:05:00.000Z'),
    });
    expect(snapshot).toEqual({
      success: true,
      rawSnapshot: Buffer.from('stored-snapshot'),
    });
    expect(mockImportOperationFindOne).toHaveBeenNthCalledWith(1, {
      _id: 'import-op-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(mockImportOperationFindOne).toHaveBeenNthCalledWith(2, {
      _id: 'import-op-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });

  it('surfaces not-found and missing-snapshot cases through the shared store', async () => {
    const store = createStudioCoreImportOperationStore({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });

    mockImportOperationFindOne.mockResolvedValueOnce(null);
    mockImportOperationFindOne.mockResolvedValueOnce({
      _id: 'import-op-no-snapshot',
      status: 'completed',
      layers: {},
      error: null,
      createdAt: new Date('2026-04-01T09:00:00.000Z'),
      updatedAt: new Date('2026-04-01T09:05:00.000Z'),
    });

    await expect(store.getOperationStatus('missing-op')).resolves.toBeNull();
    await expect(store.getOperationSnapshot('import-op-no-snapshot')).resolves.toEqual({
      success: false,
      error: {
        code: 'NO_SNAPSHOT',
        message: 'Import operation has no pre-import snapshot',
      },
    });
  });

  it('stages layered import records under an isolated shadow project without touching domain status', async () => {
    const rawCollection = createRawCollection();
    const adapter = createStudioLayeredImportDbAdapter(
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      },
      {
        collectionProvider: () => rawCollection,
        idFactory: () => 'new-record-1',
        now: () => new Date('2026-04-01T09:30:00.000Z'),
      },
    );

    await adapter.createImportOperation({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      layers: { guardrails: { status: 'pending' } },
      expiresAt: new Date('2026-04-01T10:30:00.000Z'),
    });

    const ids = await adapter.insertStagedRecords('guardrail_policies', [
      {
        _id: 'exported-policy-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'PCI Guardrail',
        scope: { type: 'project', projectId: 'source-project' },
        status: 'draft',
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'guardrails',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
    ]);

    expect(ids).toEqual(['new-record-1']);
    expect(rawCollection.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        _id: 'new-record-1',
        projectId: 'proj-1:__abl_import_staging__:import-op-1',
        tenantId: 'tenant-1',
        name: 'PCI Guardrail:__abl_import_staging__:import-op-1',
        scope: {
          type: 'project',
          projectId: 'proj-1:__abl_import_staging__:import-op-1',
        },
        status: 'draft',
        [IMPORT_LIFECYCLE_FIELD]: expect.objectContaining({
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'guardrails',
          originalName: 'PCI Guardrail',
        }),
      }),
    ]);
  });

  it('materializes staged project agents with staging-scoped agent paths', async () => {
    const rawCollection = createRawCollection();
    const ids = ['new-agent-1', 'new-agent-2'];
    const adapter = createStudioLayeredImportDbAdapter(
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      },
      {
        collectionProvider: () => rawCollection,
        idFactory: () => ids.shift() ?? 'fallback-id',
        now: () => new Date('2026-04-01T09:30:00.000Z'),
      },
    );

    await adapter.createImportOperation({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      layers: { core: { status: 'pending' } },
      expiresAt: new Date('2026-04-01T10:30:00.000Z'),
    });

    await adapter.insertStagedRecords('project_agents', [
      {
        _id: 'exported-agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'CignaRouter',
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'core',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
      {
        _id: 'exported-agent-2',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'CAIAuth_Specialist',
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'core',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
    ]);

    expect(rawCollection.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        _id: 'new-agent-1',
        projectId: 'proj-1:__abl_import_staging__:import-op-1',
        tenantId: 'tenant-1',
        name: 'CignaRouter',
        agentPath: 'projects/proj-1:__abl_import_staging__:import-op-1/agents/CignaRouter',
      }),
      expect.objectContaining({
        _id: 'new-agent-2',
        projectId: 'proj-1:__abl_import_staging__:import-op-1',
        tenantId: 'tenant-1',
        name: 'CAIAuth_Specialist',
        agentPath: 'projects/proj-1:__abl_import_staging__:import-op-1/agents/CAIAuth_Specialist',
      }),
    ]);
  });

  it('resolves portable layered project model configs to destination tenant models while staging', async () => {
    const rawCollection = createRawCollection();
    mockTenantModelFind.mockResolvedValueOnce([
      {
        _id: 'tm-destination-balanced',
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        capabilities: ['text'],
      },
    ]);
    const adapter = createStudioLayeredImportDbAdapter(
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      },
      {
        collectionProvider: () => rawCollection,
        idFactory: () => 'new-model-config-1',
        now: () => new Date('2026-04-01T09:30:00.000Z'),
      },
    );

    await adapter.createImportOperation({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      layers: { core: { status: 'pending' } },
      expiresAt: new Date('2026-04-01T10:30:00.000Z'),
    });

    await adapter.insertStagedRecords('model_configs', [
      {
        name: 'Balanced',
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        tier: 'balanced',
        tenantModelId: 'tm-source',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'core',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
    ]);

    expect(mockTenantModelFind).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      isActive: true,
      inferenceEnabled: { $ne: false },
    });
    expect(rawCollection.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        _id: 'new-model-config-1',
        projectId: 'proj-1:__abl_import_staging__:import-op-1',
        tenantId: 'tenant-1',
        tenantModelId: 'tm-destination-balanced',
      }),
    ]);
  });

  it('materializes staged workflow versions and triggers with staged workflow IDs', async () => {
    const rawCollections = new Map<string, ReturnType<typeof createRawCollection>>();
    const collectionProvider = (collectionName: string) => {
      const existing = rawCollections.get(collectionName);
      if (existing) {
        return existing;
      }
      const rawCollection = createRawCollection();
      rawCollections.set(collectionName, rawCollection);
      return rawCollection;
    };
    const ids = ['wf-loan', 'wf-card', 'wfv-loan-draft', 'wfv-card-draft', 'trigger-loan'];
    const adapter = createStudioLayeredImportDbAdapter(
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      },
      {
        collectionProvider,
        idFactory: () => ids.shift() ?? 'fallback-id',
        now: () => new Date('2026-04-01T09:30:00.000Z'),
      },
    );

    await adapter.createImportOperation({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      layers: { workflows: { status: 'pending' } },
      expiresAt: new Date('2026-04-01T10:30:00.000Z'),
    });

    await adapter.insertStagedRecords('workflows', [
      {
        _id: 'exported-loan-workflow',
        name: 'Loan_Application_Processing',
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'workflows',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
      {
        _id: 'exported-card-workflow',
        name: 'Card_Issuance_Risk_Review',
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'workflows',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
    ]);
    await adapter.insertStagedRecords('workflow_versions', [
      {
        _workflowName: 'Loan_Application_Processing',
        version: 'draft',
        definition: { nodes: [], edges: [] },
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'workflows',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
      {
        _workflowName: 'Card_Issuance_Risk_Review',
        version: 'draft',
        definition: { nodes: [], edges: [] },
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'workflows',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
    ]);
    await adapter.insertStagedRecords('trigger_registrations', [
      {
        triggerName: 'loan_started',
        _workflowName: 'Loan_Application_Processing',
        _workflowVersion: 'draft',
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'workflows',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
    ]);

    expect(rawCollections.get('workflow_versions')?.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        _id: 'wfv-loan-draft',
        workflowId: 'wf-loan',
        version: 'draft',
      }),
      expect.objectContaining({
        _id: 'wfv-card-draft',
        workflowId: 'wf-card',
        version: 'draft',
      }),
    ]);
    expect(rawCollections.get('trigger_registrations')?.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        _id: 'trigger-loan',
        workflowId: 'wf-loan',
        workflowVersionId: 'wfv-loan-draft',
        triggerName: 'loan_started',
      }),
    ]);
  });

  it('materializes staged vocabulary records with staged knowledge base IDs', async () => {
    const rawCollections = new Map<string, ReturnType<typeof createRawCollection>>();
    const collectionProvider = (collectionName: string) => {
      const existing = rawCollections.get(collectionName);
      if (existing) {
        return existing;
      }
      const rawCollection = createRawCollection();
      rawCollections.set(collectionName, rawCollection);
      return rawCollection;
    };
    const ids = ['kb-loans', 'vocab-loans', 'schema-loans'];
    const adapter = createStudioLayeredImportDbAdapter(
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      },
      {
        collectionProvider,
        idFactory: () => ids.shift() ?? 'fallback-id',
        now: () => new Date('2026-04-01T09:30:00.000Z'),
      },
    );

    await adapter.createImportOperation({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      layers: { search: { status: 'pending' }, vocabulary: { status: 'pending' } },
      expiresAt: new Date('2026-04-01T10:30:00.000Z'),
    });

    await adapter.insertStagedRecords('knowledge_bases', [
      {
        _exportedId: 'source-kb-loans',
        name: 'Loans KB',
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'search',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
    ]);
    await adapter.insertStagedRecords('domain_vocabularies', [
      {
        projectKnowledgeBaseId: 'source-kb-loans',
        _vocabularyKnowledgeBaseId: 'source-kb-loans',
        version: 1,
        entries: [],
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'vocabulary',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
    ]);
    await adapter.insertStagedRecords('canonical_schemas', [
      {
        knowledgeBaseId: 'source-kb-loans',
        _schemaKnowledgeBaseId: 'source-kb-loans',
        version: 1,
        fields: [],
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'vocabulary',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
    ]);

    expect(rawCollections.get('domain_vocabularies')?.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        _id: 'vocab-loans',
        projectKnowledgeBaseId: 'kb-loans',
      }),
    ]);
    expect(rawCollections.get('canonical_schemas')?.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        _id: 'schema-loans',
        knowledgeBaseId: 'kb-loans',
      }),
    ]);
  });

  it('materializes staged connector configs with staged search source IDs', async () => {
    const rawCollections = new Map<string, ReturnType<typeof createRawCollection>>();
    const collectionProvider = (collectionName: string) => {
      const existing = rawCollections.get(collectionName);
      if (existing) {
        return existing;
      }
      const rawCollection = createRawCollection();
      rawCollections.set(collectionName, rawCollection);
      return rawCollection;
    };
    const ids = ['source-loans', 'config-loans'];
    const adapter = createStudioLayeredImportDbAdapter(
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      },
      {
        collectionProvider,
        idFactory: () => ids.shift() ?? 'fallback-id',
        now: () => new Date('2026-04-01T09:30:00.000Z'),
      },
    );

    await adapter.createImportOperation({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      layers: { connections: { status: 'pending' }, search: { status: 'pending' } },
      expiresAt: new Date('2026-04-01T10:30:00.000Z'),
    });

    await adapter.insertStagedRecords('search_sources', [
      {
        _exportedId: 'source-search-source',
        name: 'Loans source',
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'search',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
    ]);
    await adapter.insertStagedRecords('connector_configs', [
      {
        sourceId: 'source-search-source',
        _connectorConfigSourceId: 'source-search-source',
        connectorType: 'sharepoint',
        connectionConfig: {},
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'connections',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
    ]);

    expect(rawCollections.get('connector_configs')?.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        _id: 'config-loans',
        sourceId: 'source-loans',
        connectorType: 'sharepoint',
      }),
    ]);
  });

  it('stages tenant-unique crawl pattern domains under import shadow values', async () => {
    const rawCollection = createRawCollection();
    const adapter = createStudioLayeredImportDbAdapter(
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      },
      {
        collectionProvider: () => rawCollection,
        idFactory: () => 'crawl-new-1',
        now: () => new Date('2026-04-01T09:30:00.000Z'),
      },
    );

    await adapter.createImportOperation({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      layers: { search: { status: 'pending' } },
      expiresAt: new Date('2026-04-01T10:30:00.000Z'),
    });

    await adapter.insertStagedRecords('crawl_patterns', [
      {
        _id: 'source-crawl-1',
        domain: 'mercury-bank.example',
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'search',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
    ]);

    expect(rawCollection.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        _id: 'crawl-new-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1:__abl_import_staging__:import-op-1',
        domain: 'mercury-bank.example:__abl_import_staging__:import-op-1',
        [IMPORT_LIFECYCLE_FIELD]: expect.objectContaining({
          originalScopeField: 'domain',
          originalScopeValue: 'mercury-bank.example',
        }),
      }),
    ]);
  });

  it('keeps imported active channel connections inactive on activation', async () => {
    const rawCollections = new Map<string, ReturnType<typeof createRawCollection>>();
    rawCollections.set(
      'channel_connections',
      createRawCollection([
        {
          _id: 'staged-channel',
          status: 'inactive',
          [IMPORT_LIFECYCLE_FIELD]: { originalStatus: 'active' },
        },
        { _id: 'active-channel', status: 'active' },
      ]),
    );
    const collectionProvider = (collectionName: string) => {
      const existing = rawCollections.get(collectionName);
      if (existing) {
        return existing;
      }
      const rawCollection = createRawCollection();
      rawCollections.set(collectionName, rawCollection);
      return rawCollection;
    };
    const ids = ['staged-channel'];
    const adapter = createStudioLayeredImportDbAdapter(
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      },
      {
        collectionProvider,
        idFactory: () => ids.shift() ?? 'fallback-id',
        now: () => new Date('2026-04-01T09:30:00.000Z'),
      },
    );

    await adapter.createImportOperation({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      layers: { channels: { status: 'pending' } },
      expiresAt: new Date('2026-04-01T10:30:00.000Z'),
    });

    await adapter.insertStagedRecords('channel_connections', [
      {
        channelType: 'slack',
        externalIdentifier: 'T123',
        displayName: 'Slack',
        status: 'active',
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          layer: 'channels',
          stagedAt: '2026-04-01T09:30:00.000Z',
        },
      },
    ]);
    await adapter.activateLayer('channel_connections', ['staged-channel'], ['active-channel']);

    expect(rawCollections.get('channel_connections')?.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        _id: 'staged-channel',
        status: 'inactive',
        [IMPORT_LIFECYCLE_FIELD]: expect.objectContaining({
          originalStatus: 'active',
        }),
      }),
    ]);
    expect(rawCollections.get('channel_connections')?.bulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: expect.objectContaining({ _id: 'active-channel' }),
            update: expect.objectContaining({
              $set: expect.objectContaining({
                projectId: 'proj-1:__abl_import_superseded__:import-op-1',
                status: 'inactive',
              }),
            }),
          }),
        }),
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: expect.objectContaining({ _id: 'staged-channel' }),
            update: expect.objectContaining({
              $set: expect.objectContaining({
                projectId: 'proj-1',
                status: 'inactive',
              }),
              $unset: { [IMPORT_LIFECYCLE_FIELD]: 1 },
            }),
          }),
        }),
      ],
      { ordered: true },
    );
  });

  it('activates layered import records via shadow project swaps and preserves business status fields', async () => {
    const activationOrder: string[] = [];
    const rawCollection = createRawCollection([
      {
        _id: 'active-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'PCI Guardrail',
        scope: { type: 'project', projectId: 'proj-1' },
      },
      {
        _id: 'staged-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1:__abl_import_staging__:import-op-1',
        name: 'PCI Guardrail:__abl_import_staging__:import-op-1',
        scope: {
          type: 'project',
          projectId: 'proj-1:__abl_import_staging__:import-op-1',
        },
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          originalName: 'PCI Guardrail',
        },
      },
    ]);
    rawCollection.bulkWrite.mockImplementation(async () => {
      activationOrder.push('bulkWrite');
      return undefined;
    });
    const guardrailPolicyIndexRepair = vi.fn(async () => {
      activationOrder.push('guardrailPolicyIndexRepair');
    });
    const adapter = createStudioLayeredImportDbAdapter(
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      },
      {
        collectionProvider: () => rawCollection,
        now: () => new Date('2026-04-01T09:30:00.000Z'),
        guardrailPolicyIndexRepair,
      },
    );

    await adapter.createImportOperation({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      layers: { guardrails: { status: 'pending' } },
      expiresAt: new Date('2026-04-01T10:30:00.000Z'),
    });
    await adapter.activateLayer('guardrail_policies', ['staged-1'], ['active-1']);

    expect(guardrailPolicyIndexRepair).toHaveBeenCalledTimes(1);
    expect(activationOrder).toEqual(['guardrailPolicyIndexRepair', 'bulkWrite']);
    expect(rawCollection.bulkWrite).toHaveBeenCalledWith(
      [
        {
          updateOne: {
            filter: {
              _id: 'active-1',
              tenantId: 'tenant-1',
              $or: [{ projectId: 'proj-1' }, { 'scope.projectId': 'proj-1' }],
            },
            update: {
              $set: {
                projectId: 'proj-1:__abl_import_superseded__:import-op-1',
                updatedAt: new Date('2026-04-01T09:30:00.000Z'),
                name: 'PCI Guardrail:__abl_import_superseded__:import-op-1',
                'scope.projectId': 'proj-1:__abl_import_superseded__:import-op-1',
                [IMPORT_LIFECYCLE_FIELD]: {
                  operationId: 'import-op-1',
                  state: 'superseded',
                  supersededAt: '2026-04-01T09:30:00.000Z',
                  originalName: 'PCI Guardrail',
                },
              },
            },
          },
        },
        {
          updateOne: {
            filter: {
              _id: 'staged-1',
              tenantId: 'tenant-1',
              $or: [
                { projectId: 'proj-1:__abl_import_staging__:import-op-1' },
                { 'scope.projectId': 'proj-1:__abl_import_staging__:import-op-1' },
              ],
              [`${IMPORT_LIFECYCLE_FIELD}.state`]: 'staged',
            },
            update: {
              $set: {
                projectId: 'proj-1',
                updatedAt: new Date('2026-04-01T09:30:00.000Z'),
                name: 'PCI Guardrail',
                'scope.projectId': 'proj-1',
              },
              $unset: { [IMPORT_LIFECYCLE_FIELD]: 1 },
            },
          },
        },
      ],
      { ordered: true },
    );

    const [[operations]] = rawCollection.bulkWrite.mock.calls;
    expect(JSON.stringify(operations)).not.toContain('"status"');
  });

  it('activates tenant-unique crawl pattern domains by shadowing active records first', async () => {
    const rawCollection = createRawCollection([
      {
        _id: 'active-crawl',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        domain: 'mercury-bank.example',
      },
      {
        _id: 'staged-crawl',
        tenantId: 'tenant-1',
        projectId: 'proj-1:__abl_import_staging__:import-op-1',
        domain: 'mercury-bank.example:__abl_import_staging__:import-op-1',
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'staged',
          originalScopeField: 'domain',
          originalScopeValue: 'mercury-bank.example',
        },
      },
    ]);
    const adapter = createStudioLayeredImportDbAdapter(
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      },
      {
        collectionProvider: () => rawCollection,
        now: () => new Date('2026-04-01T09:30:00.000Z'),
      },
    );

    await adapter.createImportOperation({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      layers: { search: { status: 'pending' } },
      expiresAt: new Date('2026-04-01T10:30:00.000Z'),
    });
    await adapter.activateLayer('crawl_patterns', ['staged-crawl'], ['active-crawl']);

    expect(rawCollection.bulkWrite).toHaveBeenCalledWith(
      [
        {
          updateOne: {
            filter: {
              _id: 'active-crawl',
              tenantId: 'tenant-1',
            },
            update: {
              $set: {
                projectId: 'proj-1:__abl_import_superseded__:import-op-1',
                updatedAt: new Date('2026-04-01T09:30:00.000Z'),
                domain: 'mercury-bank.example:__abl_import_superseded__:import-op-1',
                [IMPORT_LIFECYCLE_FIELD]: {
                  operationId: 'import-op-1',
                  state: 'superseded',
                  supersededAt: '2026-04-01T09:30:00.000Z',
                  originalScopeField: 'domain',
                  originalScopeValue: 'mercury-bank.example',
                },
              },
            },
          },
        },
        {
          updateOne: {
            filter: {
              _id: 'staged-crawl',
              tenantId: 'tenant-1',
              projectId: 'proj-1:__abl_import_staging__:import-op-1',
              [`${IMPORT_LIFECYCLE_FIELD}.state`]: 'staged',
            },
            update: {
              $set: {
                projectId: 'proj-1',
                updatedAt: new Date('2026-04-01T09:30:00.000Z'),
                domain: 'mercury-bank.example',
              },
              $unset: { [IMPORT_LIFECYCLE_FIELD]: 1 },
            },
          },
        },
      ],
      { ordered: true },
    );
  });

  it('rolls back activated guardrail policy swaps by deleting staged records before restoring names', async () => {
    const rawCollection = createRawCollection([
      {
        _id: 'active-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1:__abl_import_superseded__:import-op-1',
        name: 'PCI Guardrail:__abl_import_superseded__:import-op-1',
        scope: {
          type: 'project',
          projectId: 'proj-1:__abl_import_superseded__:import-op-1',
        },
        [IMPORT_LIFECYCLE_FIELD]: {
          operationId: 'import-op-1',
          state: 'superseded',
          originalName: 'PCI Guardrail',
        },
      },
    ]);
    const adapter = createStudioLayeredImportDbAdapter(
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      },
      {
        operationId: 'import-op-1',
        collectionProvider: () => rawCollection,
        now: () => new Date('2026-04-01T09:30:00.000Z'),
      },
    );

    await adapter.rollbackLayer('guardrail_policies', ['staged-1'], ['active-1']);

    expect(rawCollection.deleteMany).toHaveBeenCalledWith({
      _id: { $in: ['staged-1'] },
      tenantId: 'tenant-1',
      projectId: {
        $in: ['proj-1', 'proj-1:__abl_import_staging__:import-op-1'],
      },
    });
    expect(rawCollection.bulkWrite).toHaveBeenCalledWith(
      [
        {
          updateOne: {
            filter: {
              _id: 'active-1',
              tenantId: 'tenant-1',
              $or: [
                { projectId: 'proj-1:__abl_import_superseded__:import-op-1' },
                { 'scope.projectId': 'proj-1:__abl_import_superseded__:import-op-1' },
              ],
            },
            update: {
              $set: {
                projectId: 'proj-1',
                updatedAt: new Date('2026-04-01T09:30:00.000Z'),
                name: 'PCI Guardrail',
                'scope.projectId': 'proj-1',
              },
              $unset: { [IMPORT_LIFECYCLE_FIELD]: 1 },
            },
          },
        },
      ],
      { ordered: true },
    );
  });

  it('activates project agents with canonical active and superseded agent paths', async () => {
    const rawCollection = createRawCollection([
      { _id: 'active-1', name: 'OldAgent' },
      { _id: 'staged-1', name: 'NewAgent' },
    ]);
    const adapter = createStudioLayeredImportDbAdapter(
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      },
      {
        collectionProvider: () => rawCollection,
        now: () => new Date('2026-04-01T09:30:00.000Z'),
      },
    );

    await adapter.createImportOperation({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      layers: { core: { status: 'pending' } },
      expiresAt: new Date('2026-04-01T10:30:00.000Z'),
    });
    await adapter.activateLayer('project_agents', ['staged-1'], ['active-1']);

    expect(rawCollection.bulkWrite).toHaveBeenCalledWith(
      [
        {
          updateOne: {
            filter: {
              _id: 'active-1',
              tenantId: 'tenant-1',
              projectId: 'proj-1',
            },
            update: {
              $set: {
                projectId: 'proj-1:__abl_import_superseded__:import-op-1',
                agentPath: 'projects/proj-1:__abl_import_superseded__:import-op-1/agents/OldAgent',
                updatedAt: new Date('2026-04-01T09:30:00.000Z'),
                [IMPORT_LIFECYCLE_FIELD]: {
                  operationId: 'import-op-1',
                  state: 'superseded',
                  supersededAt: '2026-04-01T09:30:00.000Z',
                },
              },
            },
          },
        },
        {
          updateOne: {
            filter: {
              _id: 'staged-1',
              tenantId: 'tenant-1',
              projectId: 'proj-1:__abl_import_staging__:import-op-1',
              [`${IMPORT_LIFECYCLE_FIELD}.state`]: 'staged',
            },
            update: {
              $set: {
                projectId: 'proj-1',
                agentPath: 'projects/proj-1/agents/NewAgent',
                updatedAt: new Date('2026-04-01T09:30:00.000Z'),
              },
              $unset: { [IMPORT_LIFECYCLE_FIELD]: 1 },
            },
          },
        },
      ],
      { ordered: true },
    );
  });

  it('preserves superseded layered records during cleanup so completed operations remain reversible', async () => {
    const rawCollection = createRawCollection();
    const adapter = createStudioLayeredImportDbAdapter(
      {
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      },
      {
        operationId: 'import-op-1',
        collectionProvider: () => rawCollection,
        now: () => new Date('2026-04-01T09:30:00.000Z'),
      },
    );

    await adapter.deleteRecordsByIds('guardrail_policies', ['staged-1', 'superseded-1']);

    expect(rawCollection.deleteMany).toHaveBeenCalledWith({
      _id: { $in: ['staged-1', 'superseded-1'] },
      tenantId: 'tenant-1',
      projectId: 'proj-1:__abl_import_staging__:import-op-1',
    });
    expect(rawCollection.updateMany).toHaveBeenCalledWith(
      {
        _id: { $in: ['staged-1', 'superseded-1'] },
        tenantId: 'tenant-1',
        projectId: 'proj-1:__abl_import_superseded__:import-op-1',
      },
      {
        $set: {
          updatedAt: new Date('2026-04-01T09:30:00.000Z'),
          [IMPORT_LIFECYCLE_FIELD]: {
            operationId: 'import-op-1',
            state: 'deleted',
            deletedAt: '2026-04-01T09:30:00.000Z',
          },
        },
      },
    );
  });

  it('rolls back completed layered operations from stored staged and superseded ids', async () => {
    const rawCollections = new Map<string, ReturnType<typeof createRawCollection>>();
    rawCollections.set(
      'project_agents',
      createRawCollection([{ _id: 'agent-old-1', name: 'OldAgent' }]),
    );
    const collectionProvider = (collectionName: string) => {
      const existing = rawCollections.get(collectionName);
      if (existing) {
        return existing;
      }
      const rawCollection = createRawCollection();
      rawCollections.set(collectionName, rawCollection);
      return rawCollection;
    };

    mockImportOperationFindOne.mockResolvedValue({
      _id: 'import-op-layered-1',
      status: 'completed',
      layers: { core: { status: 'activated' } },
      stagedRecordIds: {
        project_agents: ['agent-new-1'],
        project_tools: ['tool-new-1'],
      },
      supersededRecordIds: {
        project_agents: ['agent-old-1'],
        project_tools: ['tool-old-1'],
        project_runtime_configs: ['runtime-old-1'],
      },
      error: null,
      createdAt: new Date('2026-04-01T09:00:00.000Z'),
      updatedAt: new Date('2026-04-01T09:05:00.000Z'),
    });

    const result = await revertStudioLayeredImportOperation({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      operationId: 'import-op-layered-1',
      collectionProvider,
      now: () => new Date('2026-04-01T09:30:00.000Z'),
    });

    expect(result).toEqual({
      success: true,
      operationId: 'import-op-layered-1',
      applied: {
        created: 0,
        updated: 3,
        deleted: 2,
        toolsCreated: 0,
        toolsUpdated: 1,
        toolsDeleted: 1,
        localesCreated: 0,
        localesUpdated: 0,
        localesDeleted: 0,
        profilesCreated: 0,
        profilesUpdated: 0,
        profilesDeleted: 0,
        modelPoliciesUpserted: 1,
        modelPoliciesDeleted: 0,
      },
    });
    expect(mockImportOperationUpdateOne).toHaveBeenCalledWith(
      { _id: 'import-op-layered-1', projectId: 'proj-1', tenantId: 'tenant-1' },
      { $set: { status: 'rolling_back' } },
    );
    expect(mockImportOperationUpdateOne).toHaveBeenCalledWith(
      { _id: 'import-op-layered-1', projectId: 'proj-1', tenantId: 'tenant-1' },
      { $set: { status: 'reverted' } },
    );
    expect(rawCollections.get('project_agents')?.deleteMany).toHaveBeenCalledWith({
      _id: { $in: ['agent-new-1'] },
      tenantId: 'tenant-1',
      projectId: {
        $in: ['proj-1', 'proj-1:__abl_import_staging__:import-op-layered-1'],
      },
    });
    expect(rawCollections.get('project_agents')?.bulkWrite).toHaveBeenCalledWith(
      [
        {
          updateOne: {
            filter: {
              _id: 'agent-old-1',
              tenantId: 'tenant-1',
              projectId: 'proj-1:__abl_import_superseded__:import-op-layered-1',
            },
            update: {
              $set: {
                projectId: 'proj-1',
                agentPath: 'projects/proj-1/agents/OldAgent',
                updatedAt: new Date('2026-04-01T09:30:00.000Z'),
              },
              $unset: { [IMPORT_LIFECYCLE_FIELD]: 1 },
            },
          },
        },
      ],
      { ordered: true },
    );
    expect(rawCollections.get('project_runtime_configs')?.updateMany).toHaveBeenCalledWith(
      {
        _id: { $in: ['runtime-old-1'] },
        tenantId: 'tenant-1',
        projectId: 'proj-1:__abl_import_superseded__:import-op-layered-1',
      },
      {
        $set: {
          projectId: 'proj-1',
          updatedAt: new Date('2026-04-01T09:30:00.000Z'),
        },
        $unset: { [IMPORT_LIFECYCLE_FIELD]: 1 },
      },
    );
  });

  it('loads active layered records with lifecycle filtering for cross-layer diffing', async () => {
    const rawCollections = new Map<string, ReturnType<typeof createRawCollection>>();
    const collectionProvider = (collectionName: string) => {
      const rawCollection = createRawCollection(
        collectionName === 'guardrail_policies'
          ? [
              {
                _id: 'policy-1',
                name: 'PCI Guardrail',
                scope: { type: 'project', projectId: 'proj-1' },
                status: 'active',
              },
            ]
          : collectionName === 'crawl_patterns'
            ? [
                {
                  _id: 'crawl-pattern-1',
                  domain: 'mercury-bank.example',
                },
              ]
            : [],
      );
      rawCollections.set(collectionName, rawCollection);
      return rawCollection;
    };

    const state = await loadStudioLayeredImportExistingState({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      collectionProvider,
    });

    expect(state.activeRecords.get('guardrail_policies')).toEqual([
      {
        _id: 'policy-1',
        name: 'PCI Guardrail',
        scope: { type: 'project', projectId: 'proj-1' },
        status: 'active',
      },
    ]);
    expect(state.activeRecords.get('crawl_patterns')).toEqual([
      {
        _id: 'crawl-pattern-1',
        domain: 'mercury-bank.example',
      },
    ]);
    expect(rawCollections.get('guardrail_policies')?.find).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        $and: [
          {
            $or: [
              { [`${IMPORT_LIFECYCLE_FIELD}.state`]: { $exists: false } },
              {
                [`${IMPORT_LIFECYCLE_FIELD}.state`]: {
                  $nin: ['staged', 'superseded', 'deleted'],
                },
              },
            ],
          },
          {
            $or: [
              { projectId: 'proj-1' },
              { 'scope.type': 'project', 'scope.projectId': 'proj-1' },
              { 'scope.type': 'agent', 'scope.projectId': 'proj-1' },
            ],
          },
        ],
      },
      { projection: { _id: 1, name: 1 } },
    );
    expect(rawCollections.get('crawl_patterns')?.find).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        $or: [
          { [`${IMPORT_LIFECYCLE_FIELD}.state`]: { $exists: false } },
          {
            [`${IMPORT_LIFECYCLE_FIELD}.state`]: {
              $nin: ['staged', 'superseded', 'deleted'],
            },
          },
        ],
      },
      { projection: { _id: 1, domain: 1 } },
    );
  });

  it('counts layered runtime/model config file mutations for cache invalidation', () => {
    const preview = {
      valid: true,
      formatVersion: '2.0',
      layers: ['core'],
      layerChanges: { core: { added: 0, modified: 0, removed: 0, unchanged: 0 } },
      agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
      toolChanges: { added: [], modified: [], removed: [], unchanged: [] },
      localeChanges: { added: [], modified: [], removed: [], unchanged: [] },
      profileChanges: { added: [], modified: [], removed: [], unchanged: [] },
      shaIntegrity: {
        valid: true,
        integrityMatch: true,
        layerResults: {},
        errors: [],
        warnings: [],
      },
      crossLayerDeps: { valid: true, missingDependencies: [], warnings: [] },
      syntaxErrors: [],
      issues: [],
      hasBlockingIssues: false,
      requiresAcknowledgement: false,
      blockingIssueCount: 0,
      nonBlockingIssueCount: 0,
      entryAgentResolution: { requested: null, resolved: null, matchedBy: 'none' },
      warnings: [],
    } as const;
    const files = new Map([
      ['config/runtime-config.json', '{}'],
      ['config/agent-model-configs/Main.model-config.json', '{}'],
      ['config/project-model-configs/default.model-config.json', '{}'],
    ]);

    expect(buildLayeredAppliedCounts(preview, files).modelPoliciesUpserted).toBe(3);
    expect(buildLayeredAppliedCounts(preview, new Map(), 'replace').modelPoliciesDeleted).toBe(1);
  });
});
