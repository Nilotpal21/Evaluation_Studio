import { describe, expect, it, vi } from 'vitest';
import type { ImportPreviewV2 } from '../types.js';
import type {
  CoreImportApplyAdapterV2,
  CoreImportApplyPlanV2,
} from '../import/core-direct-apply.js';
import {
  applyCoreImportV2,
  applyCoreImportPlanWithSnapshotV2,
  buildCoreImportExistingStateV2,
  buildCoreImportSnapshotFilesV2,
  compressCoreImportSnapshotFilesV2,
  decompressCoreImportSnapshotFilesV2,
  previewCoreImportV2,
  prepareCoreImportApplyV2,
  revertCoreImportOperationV2,
  revertCoreImportFromSnapshotV2,
  type CoreImportStoreV2,
  type CoreImportOperationStoreV2,
  type CoreImportSnapshotStateV2,
} from '../import/core-direct-apply-orchestrator.js';

const PROJECT_ID = 'proj-test-1';
const TENANT_ID = 'tenant-test-1';
const USER_ID = 'user-test-1';

function buildPreview(overrides: Partial<ImportPreviewV2> = {}): ImportPreviewV2 {
  return {
    valid: true,
    formatVersion: '2.0',
    layers: ['core'],
    layerChanges: {
      core: { added: 0, modified: 0, removed: 0, unchanged: 0 },
    },
    agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
    toolChanges: { added: [], modified: [], removed: [] },
    shaIntegrity: {
      valid: true,
      integrityMatch: true,
      layerResults: {},
      errors: [],
      warnings: [],
    },
    crossLayerDeps: {
      valid: true,
      missingDependencies: [],
      warnings: [],
    },
    syntaxErrors: [],
    issues: [],
    hasBlockingIssues: false,
    requiresAcknowledgement: false,
    blockingIssueCount: 0,
    nonBlockingIssueCount: 0,
    entryAgentResolution: {
      requested: null,
      resolved: null,
      matchedBy: 'none',
    },
    warnings: [],
    ...overrides,
  };
}

function buildPlan(input?: {
  promptOperations?: CoreImportApplyPlanV2['promptOperations'];
  agentOperations?: CoreImportApplyPlanV2['agentOperations'];
  toolOperations?: CoreImportApplyPlanV2['toolOperations'];
  mcpServerOperations?: CoreImportApplyPlanV2['mcpServerOperations'];
  localeOperations?: CoreImportApplyPlanV2['localeOperations'];
  profileOperations?: CoreImportApplyPlanV2['profileOperations'];
  modelPolicyOperations?: CoreImportApplyPlanV2['modelPolicyOperations'];
  evalOperations?: CoreImportApplyPlanV2['evalOperations'];
  entryAgentName?: string | null;
}): CoreImportApplyPlanV2 {
  const promptOperations = input?.promptOperations ?? [];
  const agentOperations = input?.agentOperations ?? [];
  const toolOperations = input?.toolOperations ?? [];
  const mcpServerOperations = input?.mcpServerOperations ?? [];
  const localeOperations = input?.localeOperations ?? [];
  const profileOperations = input?.profileOperations ?? [];
  const modelPolicyOperations = input?.modelPolicyOperations ?? [];
  const evalOperations = input?.evalOperations ?? [];

  return {
    preparedFiles: new Map(),
    preview: buildPreview(),
    promptOperations,
    agentOperations,
    toolOperations,
    mcpServerOperations,
    localeOperations,
    profileOperations,
    modelPolicyOperations,
    evalOperations,
    entryAgentName: input?.entryAgentName ?? null,
    warnings: [],
    applied: {
      created: agentOperations.filter((operation) => operation.type === 'create').length,
      updated: agentOperations.filter((operation) => operation.type === 'update').length,
      deleted: agentOperations.filter((operation) => operation.type === 'delete').length,
      ...(promptOperations.length > 0
        ? {
            promptsCreated: promptOperations.filter((operation) => operation.type === 'create')
              .length,
            promptsUpdated: promptOperations.filter((operation) => operation.type === 'update')
              .length,
            promptsDeleted: promptOperations.filter((operation) => operation.type === 'delete')
              .length,
          }
        : {}),
      toolsCreated: toolOperations.filter((operation) => operation.type === 'create').length,
      toolsUpdated: toolOperations.filter((operation) => operation.type === 'update').length,
      toolsDeleted: toolOperations.filter((operation) => operation.type === 'delete').length,
      localesCreated: localeOperations.filter((operation) => operation.type === 'create').length,
      localesUpdated: localeOperations.filter((operation) => operation.type === 'update').length,
      localesDeleted: localeOperations.filter((operation) => operation.type === 'delete').length,
      profilesCreated: profileOperations.filter((operation) => operation.type === 'create').length,
      profilesUpdated: profileOperations.filter((operation) => operation.type === 'update').length,
      profilesDeleted: profileOperations.filter((operation) => operation.type === 'delete').length,
      ...(modelPolicyOperations.length > 0
        ? {
            modelPoliciesUpserted: modelPolicyOperations.filter(
              (operation) => operation.type === 'upsert',
            ).length,
            modelPoliciesDeleted: modelPolicyOperations.filter(
              (operation) => operation.type === 'delete',
            ).length,
          }
        : {}),
    },
  };
}

function buildAdapter(): CoreImportApplyAdapterV2 & {
  createPrompts: ReturnType<typeof vi.fn>;
  updatePrompts: ReturnType<typeof vi.fn>;
  deletePrompts: ReturnType<typeof vi.fn>;
  createAgents: ReturnType<typeof vi.fn>;
  updateAgents: ReturnType<typeof vi.fn>;
  deleteAgents: ReturnType<typeof vi.fn>;
  createMcpServers: ReturnType<typeof vi.fn>;
  updateMcpServers: ReturnType<typeof vi.fn>;
  deleteMcpServers: ReturnType<typeof vi.fn>;
  createTools: ReturnType<typeof vi.fn>;
  updateTools: ReturnType<typeof vi.fn>;
  deleteTools: ReturnType<typeof vi.fn>;
  createLocales: ReturnType<typeof vi.fn>;
  updateLocales: ReturnType<typeof vi.fn>;
  deleteLocales: ReturnType<typeof vi.fn>;
  createProfiles: ReturnType<typeof vi.fn>;
  updateProfiles: ReturnType<typeof vi.fn>;
  deleteProfiles: ReturnType<typeof vi.fn>;
  upsertModelPolicyConfigs: ReturnType<typeof vi.fn>;
  deleteModelPolicyConfigs: ReturnType<typeof vi.fn>;
  setEntryAgent: ReturnType<typeof vi.fn>;
  rollbackCreated: ReturnType<typeof vi.fn>;
} {
  return {
    createPrompts: vi.fn().mockResolvedValue(['prompt-created-1']),
    updatePrompts: vi.fn().mockResolvedValue(undefined),
    deletePrompts: vi.fn().mockResolvedValue(undefined),
    createAgents: vi.fn().mockResolvedValue(['agent-created-1']),
    updateAgents: vi.fn().mockResolvedValue(undefined),
    deleteAgents: vi.fn().mockResolvedValue(undefined),
    createMcpServers: vi.fn().mockResolvedValue(['mcp-created-1']),
    updateMcpServers: vi.fn().mockResolvedValue(undefined),
    deleteMcpServers: vi.fn().mockResolvedValue(undefined),
    createTools: vi.fn().mockResolvedValue(['tool-created-1']),
    updateTools: vi.fn().mockResolvedValue(undefined),
    deleteTools: vi.fn().mockResolvedValue(undefined),
    createLocales: vi.fn().mockResolvedValue(['locale-created-1']),
    updateLocales: vi.fn().mockResolvedValue(undefined),
    deleteLocales: vi.fn().mockResolvedValue(undefined),
    createProfiles: vi.fn().mockResolvedValue(['profile-created-1']),
    updateProfiles: vi.fn().mockResolvedValue(undefined),
    deleteProfiles: vi.fn().mockResolvedValue(undefined),
    upsertModelPolicyConfigs: vi.fn().mockResolvedValue(undefined),
    deleteModelPolicyConfigs: vi.fn().mockResolvedValue(undefined),
    setEntryAgent: vi.fn().mockResolvedValue(undefined),
    rollbackCreated: vi.fn().mockResolvedValue(undefined),
  };
}

describe('core direct apply orchestrator', () => {
  it('builds snapshot files, derives existing state, and round-trips compressed buffers', async () => {
    const currentState: CoreImportSnapshotStateV2 = {
      agents: [
        {
          name: 'Main',
          description: 'Main agent',
          dslContent: 'AGENT: Main\nGOAL: Help customers\n',
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
      runtimeConfig: {
        operationTierOverrides: { response_gen: 'powerful' },
        extraction: { nlu_provider: 'native' },
      },
      llmConfig: {
        operationTierOverrides: { response_gen: 'powerful' },
      },
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
      entryAgentName: 'Main',
    };

    const existingState = buildCoreImportExistingStateV2(currentState);
    const snapshotFiles = buildCoreImportSnapshotFilesV2({
      ...currentState,
      description: 'Pre-import snapshot',
    });
    const compressed = await compressCoreImportSnapshotFilesV2(snapshotFiles);

    expect(existingState.agents.get('Main')).toEqual({
      name: 'Main',
      dslContent: 'AGENT: Main\nGOAL: Help customers\n',
      systemPromptLibraryRef: null,
    });
    expect(existingState.prompts?.get('pl_prompt_1')).toEqual({
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
    expect(existingState.tools?.get('lookup_ticket')).toEqual({
      name: 'lookup_ticket',
      dslContent: 'lookup_ticket(id: string) -> {status: string}\n',
    });
    expect(existingState.mcpServers?.get('public-repo-tools')).toEqual({
      name: 'public-repo-tools',
      config: expect.objectContaining({
        name: 'public-repo-tools',
        transport: 'http',
        url: 'https://mcp.example.com/public-repo',
      }),
    });
    expect(existingState.localeFiles?.get('locales/fr/messages.json')).toBe(
      JSON.stringify({ messages: { conversation_complete: 'Termine' } }, null, 2),
    );
    expect(existingState.locales?.get('locales/fr/messages.json')).toEqual({
      filePath: 'locales/fr/messages.json',
      value: JSON.stringify({ messages: { conversation_complete: 'Termine' } }, null, 2),
      description: 'French shared messages',
    });
    expect(existingState.runtimeConfig).toEqual({
      operationTierOverrides: { response_gen: 'powerful' },
      extraction: { nlu_provider: 'native' },
    });
    expect(existingState.llmConfig).toEqual({
      operationTierOverrides: { response_gen: 'powerful' },
    });
    expect(existingState.agentModelConfigs?.get('Main')).toEqual({
      agentName: 'Main',
      data: {
        agentName: 'Main',
        defaultModel: 'gpt-4o-mini',
        operationModels: { response_gen: 'gpt-4o' },
      },
    });
    expect(existingState.projectModelConfigs?.get('GPT-4o Realtime Preview (2025-06-03)')).toEqual({
      name: 'GPT-4o Realtime Preview (2025-06-03)',
      data: {
        name: 'GPT-4o Realtime Preview (2025-06-03)',
        modelId: 'gpt-4o-realtime-preview-2025-06-03',
        provider: 'openai',
        tier: 'voice',
        isDefault: true,
      },
    });
    expect(snapshotFiles['agents/Main.agent.abl']).toContain('AGENT: Main');
    expect(snapshotFiles['prompts/support_prompt.prompt.json']).toContain(
      '"promptId": "pl_prompt_1"',
    );
    expect(snapshotFiles['tools/lookup_ticket.tools.abl']).toContain('lookup_ticket');
    expect(snapshotFiles['core/mcp-servers/public-repo-tools.mcp-config.json']).toContain(
      '"name": "public-repo-tools"',
    );
    expect(snapshotFiles['locales/fr/messages.json']).toContain('"conversation_complete"');
    expect(JSON.parse(snapshotFiles['config/runtime-config.json'])).toEqual({
      extraction: { nlu_provider: 'native' },
    });
    expect(snapshotFiles['config/llm-config.json']).toContain('"response_gen"');
    expect(snapshotFiles['config/agent-model-configs/main.model-config.json']).toContain(
      '"gpt-4o-mini"',
    );
    expect(
      snapshotFiles[
        'config/project-model-configs/gpt-4o_realtime_preview__2025-06-03_.model-config.json'
      ],
    ).toContain('gpt-4o-realtime-preview-2025-06-03');
    expect(snapshotFiles['.core-import-snapshot.json']).toContain('French shared messages');
    expect(JSON.parse(snapshotFiles['project.json'])).toMatchObject({
      entry_agent: 'Main',
      metadata: {
        entity_counts: {
          agents: 1,
          prompt_library_items: 1,
          prompt_library_versions: 1,
          tools: 1,
          mcp_servers: 1,
          locale_files: 1,
        },
        required_mcp_servers: ['public-repo-tools'],
      },
    });

    expect(await decompressCoreImportSnapshotFilesV2(compressed)).toEqual(snapshotFiles);
    expect(await decompressCoreImportSnapshotFilesV2({ buffer: compressed })).toEqual(
      snapshotFiles,
    );
  });

  it('keeps colliding model-policy snapshot filenames distinct', () => {
    const snapshotFiles = buildCoreImportSnapshotFilesV2({
      description: 'snapshot',
      agents: [],
      tools: [],
      entryAgentName: null,
      projectModelConfigs: [
        { name: 'GPT 4', data: { name: 'GPT 4', modelId: 'gpt-4' } },
        { name: 'GPT/4', data: { name: 'GPT/4', modelId: 'gpt-4-alt' } },
      ],
      agentModelConfigs: [
        { agentName: 'Sales Agent', data: { agentName: 'Sales Agent' } },
        { agentName: 'Sales/Agent', data: { agentName: 'Sales/Agent' } },
      ],
      mcpServers: [
        { name: 'Docs MCP', transport: 'sse', url: 'https://example.com/docs' },
        { name: 'Docs/MCP', transport: 'sse', url: 'https://example.com/docs-alt' },
      ],
    });

    expect(Object.keys(snapshotFiles)).toEqual(
      expect.arrayContaining([
        'config/project-model-configs/gpt_4.model-config.json',
        'config/project-model-configs/gpt_4_2.model-config.json',
        'config/agent-model-configs/sales_agent.model-config.json',
        'config/agent-model-configs/sales_agent_2.model-config.json',
        'core/mcp-servers/docs_mcp.mcp-config.json',
        'core/mcp-servers/docs_mcp_2.mcp-config.json',
      ]),
    );
  });

  it('canonicalizes divergent runtime and LLM operation-tier overrides in snapshot files', () => {
    const snapshotFiles = buildCoreImportSnapshotFilesV2({
      agents: [],
      tools: [],
      description: 'Divergent model policy snapshot',
      runtimeConfig: {
        operationTierOverrides: { response_gen: 'fast', reasoning: 'balanced' },
        extraction: { nlu_provider: 'standard' },
      },
      llmConfig: {
        operationTierOverrides: { response_gen: 'powerful' },
      },
    });

    const runtimeConfig = JSON.parse(snapshotFiles['config/runtime-config.json']);
    const llmConfig = JSON.parse(snapshotFiles['config/llm-config.json']);

    expect(runtimeConfig).not.toHaveProperty('operationTierOverrides');
    expect(runtimeConfig.extraction).toEqual({ nlu_provider: 'standard' });
    expect(llmConfig.operationTierOverrides).toEqual({ response_gen: 'powerful' });
  });

  it('snapshots prompt-only state into prompt bundle files and prompt layers', () => {
    const currentState: CoreImportSnapshotStateV2 = {
      agents: [],
      prompts: [
        {
          promptId: 'pl_prompt_2',
          name: 'Escalation Prompt',
          tags: ['escalation'],
          status: 'active',
          nextVersionNumber: 3,
          versions: [
            {
              versionId: 'plv_prompt_2',
              versionNumber: 2,
              template: 'Escalate severe cases.',
              variables: ['severity'],
              status: 'active',
              sourceHash: 'prompt-version-hash-2',
            },
          ],
        },
      ],
      tools: [],
      entryAgentName: null,
    };

    const existingState = buildCoreImportExistingStateV2(currentState);
    const snapshotFiles = buildCoreImportSnapshotFilesV2({
      ...currentState,
      description: 'Prompt-only snapshot',
    });

    expect(existingState.prompts?.get('pl_prompt_2')).toEqual(currentState.prompts?.[0]);
    expect(snapshotFiles['prompts/escalation_prompt.prompt.json']).toContain(
      '"versionId": "plv_prompt_2"',
    );
    expect(JSON.parse(snapshotFiles['project.json']).layers_included).toEqual(['core', 'prompts']);
  });

  it('stores a pre-import snapshot before executing a core apply plan', async () => {
    const currentState: CoreImportSnapshotStateV2 = {
      agents: [
        {
          name: 'CurrentAgent',
          description: 'Current agent',
          dslContent: 'AGENT: CurrentAgent\nGOAL: Current flow\n',
        },
      ],
      tools: [
        {
          name: 'current_tool',
          description: 'Current tool',
          dslContent: 'current_tool() -> {ok: boolean}\n',
        },
      ],
      mcpServers: [
        {
          name: 'current-mcp',
          description: 'Current MCP server',
          transport: 'http',
          url: 'https://mcp.example.com/current',
          authType: 'none',
          priority: 0,
          tags: null,
          connectionTimeoutMs: 30000,
          requestTimeoutMs: 30000,
          autoReconnect: true,
          maxReconnectAttempts: 3,
          lastConnectionStatus: null,
        },
      ],
      entryAgentName: 'CurrentAgent',
    };
    const plan = buildPlan({
      promptOperations: [
        {
          type: 'create',
          promptId: 'pl_prompt_3',
          promptName: 'Imported Prompt',
          bundle: {
            promptId: 'pl_prompt_3',
            name: 'Imported Prompt',
            tags: ['support'],
            status: 'active',
            nextVersionNumber: 2,
            versions: [
              {
                versionId: 'plv_prompt_3',
                versionNumber: 1,
                template: 'Support imported users.',
                variables: ['customer_name'],
                status: 'active',
                sourceHash: 'prompt-version-hash-3',
              },
            ],
          },
          sourceHash: 'prompt-bundle-hash',
          sourceFile: 'prompts/imported_prompt.prompt.json',
        },
      ],
      agentOperations: [
        {
          type: 'create',
          agentName: 'ImportedAgent',
          description: 'Imported agent',
          dslContent: 'AGENT: ImportedAgent\nGOAL: Import flow\n',
          sourceHash: 'agent-hash',
        },
      ],
      toolOperations: [
        {
          type: 'create',
          toolName: 'imported_tool',
          toolType: 'http',
          description: 'Imported tool',
          dslContent: 'imported_tool() -> {ok: boolean}\n',
          sourceHash: 'tool-hash',
          sourceFile: 'tools/imported_tool.tools.abl',
          autogenerated: false,
        },
      ],
      mcpServerOperations: [
        {
          type: 'create',
          serverName: 'imported-mcp',
          config: {
            name: 'imported-mcp',
            description: 'Imported MCP server',
            transport: 'http',
            url: 'https://mcp.example.com/imported',
            authType: 'none',
            priority: 1,
            tags: null,
            connectionTimeoutMs: 15000,
            requestTimeoutMs: 45000,
            autoReconnect: true,
            maxReconnectAttempts: 5,
            lastConnectionStatus: 'connected',
          },
          sourceHash: 'mcp-hash',
          sourceFile: 'core/mcp-servers/imported-mcp.mcp-config.json',
        },
      ],
      entryAgentName: 'ImportedAgent',
    });
    const adapter = buildAdapter();
    const operationStore = {
      createCompletedOperation: vi.fn().mockResolvedValue({ operationId: 'import-op-1' }),
    };

    const result = await applyCoreImportPlanWithSnapshotV2({
      plan,
      currentState,
      adapter,
      operationStore,
      snapshotDescription: 'Pre-import snapshot',
    });

    expect(result).toEqual({
      success: true,
      operationId: 'import-op-1',
      applied: {
        created: 1,
        updated: 0,
        deleted: 0,
        promptsCreated: 1,
        promptsUpdated: 0,
        promptsDeleted: 0,
        toolsCreated: 1,
        toolsUpdated: 0,
        toolsDeleted: 0,
        localesCreated: 0,
        localesUpdated: 0,
        localesDeleted: 0,
        profilesCreated: 0,
        profilesUpdated: 0,
        profilesDeleted: 0,
      },
      entryAgentName: 'ImportedAgent',
    });

    const storedSnapshot = await decompressCoreImportSnapshotFilesV2(
      operationStore.createCompletedOperation.mock.calls[0][0],
    );
    expect(storedSnapshot['agents/CurrentAgent.agent.abl']).toContain('AGENT: CurrentAgent');
    expect(storedSnapshot['tools/current_tool.tools.abl']).toContain('current_tool');
    expect(storedSnapshot['core/mcp-servers/current-mcp.mcp-config.json']).toContain(
      '"name": "current-mcp"',
    );
    expect(adapter.createPrompts).toHaveBeenCalledWith([
      expect.objectContaining({
        promptId: 'pl_prompt_3',
        sourceHash: 'prompt-bundle-hash',
      }),
    ]);
    expect(adapter.createAgents).toHaveBeenCalledWith([
      expect.objectContaining({
        agentName: 'ImportedAgent',
        sourceHash: 'agent-hash',
      }),
    ]);
    expect(adapter.createAgents.mock.invocationCallOrder[0]).toBeGreaterThan(
      adapter.createPrompts.mock.invocationCallOrder[0],
    );
    expect(adapter.createMcpServers).toHaveBeenCalledWith([
      expect.objectContaining({
        serverName: 'imported-mcp',
        sourceHash: 'mcp-hash',
      }),
    ]);
    expect(adapter.createTools).toHaveBeenCalledWith([
      expect.objectContaining({
        toolName: 'imported_tool',
        sourceHash: 'tool-hash',
      }),
    ]);
    expect(adapter.setEntryAgent).toHaveBeenCalledWith('ImportedAgent');
  });

  it('prepares an apply plan from a state store before execution', async () => {
    const currentState: CoreImportSnapshotStateV2 = {
      agents: [
        {
          name: 'CurrentAgent',
          description: 'Current agent',
          dslContent: 'AGENT: CurrentAgent\nGOAL: Current flow\n',
        },
      ],
      tools: [
        {
          name: 'current_tool',
          description: 'Current tool',
          dslContent: 'current_tool() -> {ok: boolean}\n',
        },
      ],
      entryAgentName: 'CurrentAgent',
    };
    const stateStore = {
      loadCurrentState: vi.fn().mockResolvedValue(currentState),
    };

    const result = await prepareCoreImportApplyV2({
      files: new Map([
        ['project.json', JSON.stringify({ format_version: '2.0', layers_included: ['core'] })],
        ['agents/CurrentAgent.agent.abl', 'AGENT: CurrentAgent\nGOAL: Updated flow\n'],
      ]),
      planOptions: {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: false,
      },
      stateStore,
    });

    expect(result).toMatchObject({
      success: true,
      currentState,
      plan: {
        applied: {
          created: 0,
          updated: 1,
          deleted: 0,
          toolsCreated: 0,
          toolsUpdated: 0,
          toolsDeleted: 0,
          localesCreated: 0,
          localesUpdated: 0,
          localesDeleted: 0,
          profilesCreated: 0,
          profilesUpdated: 0,
          profilesDeleted: 0,
        },
        entryAgentName: null,
      },
    });
    expect(stateStore.loadCurrentState).toHaveBeenCalledTimes(1);
  });

  it('builds an enriched preview with a digest from the shared preview wrapper', async () => {
    const currentState: CoreImportSnapshotStateV2 = {
      agents: [
        {
          name: 'CurrentAgent',
          description: 'Current agent',
          dslContent: 'AGENT: CurrentAgent\nGOAL: Current flow\n',
        },
      ],
      tools: [],
      entryAgentName: 'CurrentAgent',
    };
    const stateStore = {
      loadCurrentState: vi.fn().mockResolvedValue(currentState),
    };

    const result = await previewCoreImportV2({
      files: new Map([
        ['project.json', JSON.stringify({ format_version: '2.0', layers_included: ['core'] })],
        ['agents/CurrentAgent.agent.abl', 'AGENT: CurrentAgent\nGOAL: Updated flow\n'],
      ]),
      planOptions: {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: false,
      },
      stateStore,
    });

    expect(result).toMatchObject({
      success: true,
      currentState,
      warnings: [],
      preview: {
        valid: true,
        hasBlockingIssues: false,
        requiresAcknowledgement: false,
      },
    });
    if (result.success) {
      expect(result.preview.previewDigest).toBeTruthy();
    }
  });

  it('compiles manifest-declared behavior profiles during preview enrichment', async () => {
    const profilePath = 'behavior_profiles/voltmart_voice.profile.abl';
    const stateStore = {
      loadCurrentState: vi.fn().mockResolvedValue({
        agents: [],
        tools: [],
        entryAgentName: null,
      }),
    };

    const result = await previewCoreImportV2({
      files: new Map([
        [
          'project.json',
          JSON.stringify({
            format_version: '2.0',
            name: 'VoltMart Support',
            slug: 'voltmart-support',
            description: null,
            abl_version: '1.0',
            exported_at: '2026-01-01T00:00:00Z',
            exported_by: USER_ID,
            entry_agent: 'Alex',
            dsl_format: 'legacy',
            layers_included: ['core'],
            agents: {
              Alex: {
                path: 'agents/alex.agent.abl',
                owner: null,
                ownerTeam: null,
                description: null,
                version: null,
              },
            },
            tools: {},
            behavior_profiles: {
              voltmart_voice: {
                name: 'voltmart_voice',
                path: profilePath,
                owner: null,
              },
            },
            metadata: {
              entity_counts: { core: 2, agents: 1, behavior_profiles: 1 },
              required_env_vars: [],
              required_connectors: [],
              required_mcp_servers: [],
            },
          }),
        ],
        [
          'agents/alex.agent.abl',
          `AGENT: Alex
VERSION: "1.0"

GOAL: "Help VoltMart customers"

USE BEHAVIOR_PROFILE: voltmart_voice

COMPLETE:
  - WHEN: true
    RESPOND: "Done"`,
        ],
        [
          profilePath,
          `BEHAVIOR_PROFILE: voltmart_voice
PRIORITY: 5
WHEN: channel.name == "voice"

VERSION: "1.0"

GOAL: "Respond with a concise voice style"

COMPLETE:
  - WHEN: true
    RESPOND: "Done"`,
        ],
      ]),
      planOptions: {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: false,
      },
      stateStore,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.preview.profileChanges?.added).toEqual([profilePath]);
    expect(result.preview.issues.map((issue) => issue.message).join('\n')).not.toContain(
      'PROFILE_NOT_FOUND',
    );
  });

  it('rejects invalid root locale paths during plan preparation with E_LOCALE_INVALID_PATH', async () => {
    const stateStore = {
      loadCurrentState: vi.fn().mockResolvedValue({
        agents: [],
        tools: [],
        entryAgentName: null,
      } satisfies CoreImportSnapshotStateV2),
    };

    const result = await prepareCoreImportApplyV2({
      files: new Map([
        ['project.json', JSON.stringify({ format_version: '2.0', layers_included: ['core'] })],
        ['agents/ImportedAgent.agent.abl', 'AGENT: ImportedAgent\nGOAL: Import flow\n'],
        ['locales/messages.json', JSON.stringify({ conversation_complete: 'Done' })],
      ]),
      planOptions: {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: false,
      },
      stateStore,
    });

    expect(result).toEqual({
      success: false,
      error: expect.objectContaining({
        code: 'E_LOCALE_INVALID_PATH',
        message: expect.stringContaining('Expected locales/<locale>/<file>.json'),
      }),
      warnings: [],
    });
  });

  it('applies a prepared import through the shared apply wrapper without snapshots', async () => {
    const currentState: CoreImportSnapshotStateV2 = {
      agents: [
        {
          name: 'CurrentAgent',
          description: 'Current agent',
          dslContent: 'AGENT: CurrentAgent\nGOAL: Current flow\n',
        },
      ],
      tools: [],
      entryAgentName: 'CurrentAgent',
    };
    const stateStore = {
      loadCurrentState: vi.fn().mockResolvedValue(currentState),
    };
    const adapter = buildAdapter();

    const result = await applyCoreImportV2({
      files: new Map([
        ['project.json', JSON.stringify({ format_version: '2.0', layers_included: ['core'] })],
        ['agents/ImportedAgent.agent.abl', 'AGENT: ImportedAgent\nGOAL: Import flow\n'],
      ]),
      planOptions: {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: true,
      },
      stateStore,
      adapter,
    });

    expect(result).toEqual({
      success: true,
      preview: expect.objectContaining({
        valid: true,
        hasBlockingIssues: false,
      }),
      warnings: [],
      applied: {
        created: 1,
        updated: 0,
        deleted: 1,
        toolsCreated: 0,
        toolsUpdated: 0,
        toolsDeleted: 0,
        localesCreated: 0,
        localesUpdated: 0,
        localesDeleted: 0,
        profilesCreated: 0,
        profilesUpdated: 0,
        profilesDeleted: 0,
      },
      entryAgentName: null,
    });
    expect(adapter.createAgents).toHaveBeenCalledWith([
      expect.objectContaining({ agentName: 'ImportedAgent' }),
    ]);
    expect(adapter.deleteAgents).toHaveBeenCalledWith(['CurrentAgent']);
  });

  it('skips storing oversized snapshots but still executes the apply plan', async () => {
    const adapter = buildAdapter();
    const onTooLarge = vi.fn();
    const operationStore = {
      createCompletedOperation: vi.fn().mockResolvedValue({ operationId: 'import-op-2' }),
    };

    const result = await applyCoreImportPlanWithSnapshotV2({
      plan: buildPlan(),
      currentState: {
        agents: [
          {
            name: 'Huge',
            description: null,
            dslContent: 'A'.repeat(2048),
          },
        ],
        tools: [],
        entryAgentName: null,
      },
      adapter,
      operationStore,
      snapshotDescription: 'Pre-import snapshot',
      snapshotCompression: {
        maxSnapshotSize: 1,
        onTooLarge,
      },
    });

    expect(result).toEqual({
      success: true,
      operationId: 'import-op-2',
      applied: {
        created: 0,
        updated: 0,
        deleted: 0,
        toolsCreated: 0,
        toolsUpdated: 0,
        toolsDeleted: 0,
        localesCreated: 0,
        localesUpdated: 0,
        localesDeleted: 0,
        profilesCreated: 0,
        profilesUpdated: 0,
        profilesDeleted: 0,
      },
      entryAgentName: null,
    });
    expect(onTooLarge).toHaveBeenCalledWith(expect.any(Number));
    expect(operationStore.createCompletedOperation).toHaveBeenCalledWith(null);
  });

  it('reverts from a stored snapshot and snapshots the pre-revert state', async () => {
    const currentState: CoreImportSnapshotStateV2 = {
      agents: [
        {
          name: 'CurrentAgent',
          description: 'Current agent',
          dslContent: 'AGENT: CurrentAgent\nGOAL: Current flow\n',
        },
      ],
      tools: [
        {
          name: 'current_tool',
          description: 'Current tool',
          dslContent: 'current_tool() -> {ok: boolean}\n',
        },
      ],
      locales: [
        {
          relativePath: 'fr/messages.json',
          value: JSON.stringify({ messages: { conversation_complete: 'Actuel' } }, null, 2),
          description: 'Current French messages',
        },
      ],
      entryAgentName: 'CurrentAgent',
    };
    const rawSnapshot = await compressCoreImportSnapshotFilesV2(
      buildCoreImportSnapshotFilesV2({
        agents: [
          {
            name: 'RestoredAgent',
            description: 'Restored agent',
            dslContent: 'AGENT: RestoredAgent\nGOAL: Restore flow\n',
          },
        ],
        tools: [
          {
            name: 'restored_tool',
            description: 'Restored tool',
            dslContent:
              'TOOLS:\n  restored_tool() -> {ok: boolean}\n    type: http\n    endpoint: "https://example.com/restored"\n    method: GET\n',
          },
        ],
        locales: [
          {
            relativePath: 'fr/messages.json',
            value: JSON.stringify({ messages: { conversation_complete: 'Restaure' } }, null, 2),
            description: 'Restored French messages',
          },
        ],
        entryAgentName: 'RestoredAgent',
        description: 'Pre-import snapshot',
      }),
    );
    const adapter = buildAdapter();
    const operationStore = {
      createCompletedOperation: vi.fn().mockResolvedValue({ operationId: 'revert-op-1' }),
    };

    const result = await revertCoreImportFromSnapshotV2({
      rawSnapshot,
      currentState,
      planOptions: {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: true,
      },
      adapter,
      operationStore,
      snapshotDescription: 'Pre-revert snapshot',
    });

    expect(result).toEqual({
      success: true,
      operationId: 'revert-op-1',
      applied: {
        created: 1,
        updated: 0,
        deleted: 1,
        toolsCreated: 1,
        toolsUpdated: 0,
        toolsDeleted: 1,
        localesCreated: 0,
        localesUpdated: 1,
        localesDeleted: 0,
        profilesCreated: 0,
        profilesUpdated: 0,
        profilesDeleted: 0,
      },
      entryAgentName: 'RestoredAgent',
    });

    expect(adapter.createAgents).toHaveBeenCalledWith([
      expect.objectContaining({ agentName: 'RestoredAgent' }),
    ]);
    expect(adapter.deleteAgents).toHaveBeenCalledWith(['CurrentAgent']);
    expect(adapter.createTools).toHaveBeenCalledWith([
      expect.objectContaining({ toolName: 'restored_tool' }),
    ]);
    expect(adapter.deleteTools).toHaveBeenCalledWith(['current_tool']);
    expect(adapter.updateLocales).toHaveBeenCalledWith([
      expect.objectContaining({
        relativePath: 'fr/messages.json',
        description: 'Restored French messages',
      }),
    ]);
    expect(adapter.setEntryAgent).toHaveBeenCalledWith('RestoredAgent');

    const preRevertSnapshot = await decompressCoreImportSnapshotFilesV2(
      operationStore.createCompletedOperation.mock.calls[0][0],
    );
    expect(preRevertSnapshot['agents/CurrentAgent.agent.abl']).toContain('AGENT: CurrentAgent');
    expect(preRevertSnapshot['tools/current_tool.tools.abl']).toContain('current_tool');
    expect(preRevertSnapshot['locales/fr/messages.json']).toContain('"Actuel"');
    expect(preRevertSnapshot['.core-import-snapshot.json']).toContain('Current French messages');
    expect(JSON.parse(preRevertSnapshot['project.json'])).toMatchObject({
      entry_agent: 'CurrentAgent',
      metadata: { entity_counts: { agents: 1, tools: 1, locale_files: 1 } },
    });
  });

  it('loads the snapshot from the operation store before fetching current state for revert', async () => {
    const rawSnapshot = await compressCoreImportSnapshotFilesV2(
      buildCoreImportSnapshotFilesV2({
        agents: [
          {
            name: 'RestoredAgent',
            description: 'Restored agent',
            dslContent: 'AGENT: RestoredAgent\nGOAL: Restore flow\n',
          },
        ],
        tools: [],
        entryAgentName: 'RestoredAgent',
        description: 'Pre-import snapshot',
      }),
    );
    const adapter = buildAdapter();
    const store: CoreImportStoreV2 = {
      loadCurrentState: vi.fn<() => Promise<CoreImportSnapshotStateV2>>().mockResolvedValue({
        agents: [
          {
            name: 'CurrentAgent',
            description: 'Current agent',
            dslContent: 'AGENT: CurrentAgent\nGOAL: Current flow\n',
          },
        ],
        tools: [],
        entryAgentName: 'CurrentAgent',
      }),
      createCompletedOperation: vi.fn().mockResolvedValue({ operationId: 'revert-op-3' }),
      getOperationStatus: vi.fn().mockResolvedValue(null),
      getOperationSnapshot: vi.fn().mockResolvedValue({
        success: true,
        rawSnapshot,
      }),
    };

    const result = await revertCoreImportOperationV2({
      operationId: 'import-op-3',
      planOptions: {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: true,
      },
      adapter,
      store,
      snapshotDescription: 'Pre-revert snapshot',
    });

    expect(result).toEqual({
      success: true,
      operationId: 'revert-op-3',
      applied: {
        created: 1,
        updated: 0,
        deleted: 1,
        toolsCreated: 0,
        toolsUpdated: 0,
        toolsDeleted: 0,
        localesCreated: 0,
        localesUpdated: 0,
        localesDeleted: 0,
        profilesCreated: 0,
        profilesUpdated: 0,
        profilesDeleted: 0,
      },
      entryAgentName: 'RestoredAgent',
    });
    expect(store.getOperationSnapshot).toHaveBeenCalledWith('import-op-3');
    expect(store.loadCurrentState).toHaveBeenCalledTimes(1);
    expect(adapter.createAgents).toHaveBeenCalledWith([
      expect.objectContaining({ agentName: 'RestoredAgent' }),
    ]);
    expect(adapter.deleteAgents).toHaveBeenCalledWith(['CurrentAgent']);
    expect(adapter.setEntryAgent).toHaveBeenCalledWith('RestoredAgent');
  });

  it('allows revert callers to derive plan options from snapshot files before planning', async () => {
    const rawSnapshot = await compressCoreImportSnapshotFilesV2(
      buildCoreImportSnapshotFilesV2({
        agents: [
          {
            name: 'RestoredAgent',
            description: 'Restored agent',
            dslContent: 'AGENT: RestoredAgent\nGOAL: Restore flow\n',
          },
        ],
        tools: [],
        runtimeConfig: {
          filler: {
            enabled: true,
            promptRef: {
              promptId: 'prompt-1',
              versionId: 'version-1',
            },
          },
        },
        entryAgentName: 'RestoredAgent',
        description: 'Pre-import snapshot',
      }),
    );
    const adapter = buildAdapter();
    const operationStore = {
      createCompletedOperation: vi.fn().mockResolvedValue({ operationId: 'revert-op-5' }),
    };
    const resolvePlanOptionsFromSnapshot = vi
      .fn<
        (
          snapshotFiles: Record<string, string>,
          basePlanOptions: {
            projectId: string;
            tenantId: string;
            userId: string;
            deleteUnmatched: boolean;
          },
        ) => Promise<{
          projectId: string;
          tenantId: string;
          userId: string;
          deleteUnmatched: boolean;
          validateRuntimeConfigForSave: () => Promise<{ valid: true }>;
        }>
      >()
      .mockImplementation(async (_snapshotFiles, basePlanOptions) => ({
        ...basePlanOptions,
        validateRuntimeConfigForSave: async () => ({ valid: true }),
      }));

    const result = await revertCoreImportFromSnapshotV2({
      rawSnapshot,
      currentState: {
        agents: [
          {
            name: 'CurrentAgent',
            description: 'Current agent',
            dslContent: 'AGENT: CurrentAgent\nGOAL: Current flow\n',
          },
        ],
        tools: [],
        entryAgentName: 'CurrentAgent',
      },
      planOptions: {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: true,
      },
      resolvePlanOptionsFromSnapshot,
      adapter,
      operationStore,
      snapshotDescription: 'Pre-revert snapshot',
    });

    expect(result).toMatchObject({
      success: true,
      operationId: 'revert-op-5',
      entryAgentName: 'RestoredAgent',
    });
    expect(resolvePlanOptionsFromSnapshot).toHaveBeenCalledTimes(1);
    expect(resolvePlanOptionsFromSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        'config/runtime-config.json': expect.stringContaining('"promptId": "prompt-1"'),
      }),
      {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: true,
      },
    );
  });

  it('returns an operation-stage error without loading current state when the snapshot is missing', async () => {
    const adapter = buildAdapter();
    const store: CoreImportStoreV2 = {
      loadCurrentState: vi.fn<() => Promise<CoreImportSnapshotStateV2>>(),
      createCompletedOperation: vi.fn().mockResolvedValue({ operationId: 'revert-op-4' }),
      getOperationStatus: vi.fn().mockResolvedValue(null),
      getOperationSnapshot: vi.fn().mockResolvedValue({
        success: false,
        error: {
          code: 'NO_SNAPSHOT',
          message: 'Import operation has no pre-import snapshot',
        },
      }),
    };

    const result = await revertCoreImportOperationV2({
      operationId: 'import-op-4',
      planOptions: {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: true,
      },
      adapter,
      store,
      snapshotDescription: 'Pre-revert snapshot',
    });

    expect(result).toEqual({
      success: false,
      stage: 'operation',
      error: {
        code: 'NO_SNAPSHOT',
        message: 'Import operation has no pre-import snapshot',
      },
    });
    expect(store.getOperationSnapshot).toHaveBeenCalledWith('import-op-4');
    expect(store.loadCurrentState).not.toHaveBeenCalled();
    expect(adapter.createAgents).not.toHaveBeenCalled();
    expect(adapter.createTools).not.toHaveBeenCalled();
    expect(adapter.deleteAgents).not.toHaveBeenCalled();
    expect(adapter.deleteTools).not.toHaveBeenCalled();
    expect(adapter.setEntryAgent).not.toHaveBeenCalled();
  });

  it('returns a snapshot-stage error for corrupt snapshot payloads', async () => {
    const adapter = buildAdapter();
    const operationStore = {
      createCompletedOperation: vi.fn().mockResolvedValue({ operationId: 'revert-op-2' }),
    };

    const result = await revertCoreImportFromSnapshotV2({
      rawSnapshot: Buffer.from('not-gzip'),
      currentState: {
        agents: [],
        tools: [],
        entryAgentName: null,
      },
      planOptions: {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: true,
      },
      adapter,
      operationStore,
      snapshotDescription: 'Pre-revert snapshot',
    });

    expect(result).toEqual({
      success: false,
      stage: 'snapshot',
      error: {
        code: 'SNAPSHOT_CORRUPT',
        message: 'Failed to decompress pre-import snapshot',
      },
    });
    expect(operationStore.createCompletedOperation).not.toHaveBeenCalled();
    expect(adapter.createAgents).not.toHaveBeenCalled();
    expect(adapter.createTools).not.toHaveBeenCalled();
    expect(adapter.deleteAgents).not.toHaveBeenCalled();
    expect(adapter.deleteTools).not.toHaveBeenCalled();
    expect(adapter.setEntryAgent).not.toHaveBeenCalled();
  });
});
