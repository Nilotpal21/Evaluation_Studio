import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProjectAgentFind = vi.fn();
const mockProjectToolFind = vi.fn();
const mockProjectSettingsFindOne = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();
const mockModelConfigFind = vi.fn();
const mockAgentModelConfigFind = vi.fn();
const mockTenantModelFind = vi.fn();
const mockEnvironmentVariableFind = vi.fn();
const mockProjectConfigVariableFind = vi.fn();
const mockMCPServerConfigFind = vi.fn();
const mockExportSelect = vi.fn();
const mockProjectAgentCountDocuments = vi.fn();
const mockProjectToolCountDocuments = vi.fn();
const mockModelConfigCountDocuments = vi.fn();
const mockProjectConfigVariableCountDocuments = vi.fn();
const mockMCPServerConfigCountDocuments = vi.fn();
const mockProjectFindOne = vi.fn();

vi.mock('@agent-platform/database', () => ({
  ProjectAgent: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        select: () => mockProjectAgentFind(...args),
      }),
    }),
    countDocuments: (...args: unknown[]) => mockProjectAgentCountDocuments(...args),
  },
  ProjectTool: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        select: () => mockProjectToolFind(...args),
      }),
    }),
    countDocuments: (...args: unknown[]) => mockProjectToolCountDocuments(...args),
  },
  ProjectSettings: {
    findOne: (...args: unknown[]) => ({
      lean: () => ({
        select: (projection: unknown) => {
          mockExportSelect('ProjectSettings', projection);
          return mockProjectSettingsFindOne(...args);
        },
      }),
    }),
  },
  ProjectRuntimeConfig: {
    findOne: (...args: unknown[]) => ({
      lean: () => ({
        select: (projection: unknown) => {
          mockExportSelect('ProjectRuntimeConfig', projection);
          return mockProjectRuntimeConfigFindOne(...args);
        },
      }),
    }),
  },
  ProjectLLMConfig: {
    findOne: (...args: unknown[]) => ({
      lean: () => ({
        select: (projection: unknown) => {
          mockExportSelect('ProjectLLMConfig', projection);
          return mockProjectLLMConfigFindOne(...args);
        },
      }),
    }),
  },
  Project: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockProjectFindOne(...args),
    }),
  },
  ModelConfig: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        select: (projection: unknown) => {
          mockExportSelect('ModelConfig', projection);
          return mockModelConfigFind(...args);
        },
      }),
    }),
    countDocuments: (...args: unknown[]) => mockModelConfigCountDocuments(...args),
  },
  AgentModelConfig: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        select: (projection: unknown) => {
          mockExportSelect('AgentModelConfig', projection);
          return mockAgentModelConfigFind(...args);
        },
      }),
    }),
  },
  TenantModel: {
    find: (...args: unknown[]) => ({
      lean: () => mockTenantModelFind(...args),
    }),
  },
  EnvironmentVariable: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        select: (projection: unknown) => {
          mockExportSelect('EnvironmentVariable', projection);
          return mockEnvironmentVariableFind(...args);
        },
      }),
    }),
  },
  ProjectConfigVariable: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        select: (projection: unknown) => {
          mockExportSelect('ProjectConfigVariable', projection);
          return mockProjectConfigVariableFind(...args);
        },
      }),
    }),
    countDocuments: (...args: unknown[]) => mockProjectConfigVariableCountDocuments(...args),
  },
  MCPServerConfig: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        select: (projection: unknown) => {
          mockExportSelect('MCPServerConfig', projection);
          return mockMCPServerConfigFind(...args);
        },
      }),
    }),
    countDocuments: (...args: unknown[]) => mockMCPServerConfigCountDocuments(...args),
  },
}));

vi.mock('@agent-platform/database/models', () => ({
  TenantModel: {
    find: (...args: unknown[]) => ({
      lean: () => mockTenantModelFind(...args),
    }),
  },
}));

import { CoreAssembler } from '../export/layer-assemblers/core-assembler.js';

describe('CoreAssembler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectAgentFind.mockResolvedValue([
      {
        name: 'Main',
        description: 'Main agent',
        dslContent: 'AGENT: Main\nGOAL: Help\n',
      },
    ]);
    mockProjectToolFind.mockResolvedValue([
      {
        name: 'lookup_ticket',
        slug: 'lookup_ticket',
        dslContent: 'lookup_ticket(id: string) -> { status: string }\n',
      },
    ]);
    mockProjectSettingsFindOne.mockResolvedValue(null);
    mockProjectRuntimeConfigFindOne.mockResolvedValue(null);
    mockProjectLLMConfigFindOne.mockResolvedValue(null);
    mockProjectFindOne.mockResolvedValue({ _id: 'proj-1' });
    mockModelConfigFind.mockResolvedValue([]);
    mockAgentModelConfigFind.mockResolvedValue([]);
    mockTenantModelFind.mockResolvedValue([]);
    mockEnvironmentVariableFind.mockResolvedValue([]);
    mockProjectConfigVariableFind.mockResolvedValue([
      {
        key: 'profile:voice_vip',
        value: 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 5\nWHEN: channel == "voice"\n',
        description: 'Behavior profile: voice_vip',
      },
      {
        key: 'locale:fr/messages.json',
        value: '{"messages":{"conversation_complete":"Termine"}}',
        description: 'French shared messages',
      },
      {
        key: 'general.setting',
        value: 'value',
        description: 'General setting',
      },
    ]);
    mockMCPServerConfigFind.mockResolvedValue([]);
    mockProjectAgentCountDocuments.mockResolvedValue(1);
    mockProjectToolCountDocuments.mockResolvedValue(1);
    mockModelConfigCountDocuments.mockResolvedValue(0);
    mockProjectConfigVariableCountDocuments.mockResolvedValue(1);
    mockMCPServerConfigCountDocuments.mockResolvedValue(0);
  });

  it('exports stored behavior profiles as behavior_profile files', async () => {
    const assembler = new CoreAssembler();

    const result = await assembler.assemble({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      dslFormat: 'yaml',
    });

    expect(result.files.get('behavior_profiles/voice_vip.behavior_profile.abl')).toContain(
      'BEHAVIOR_PROFILE: voice_vip',
    );
    expect(result.files.get('locales/fr/messages.json')).toContain('conversation_complete');
    expect(result.files.get('environment/config-vars.json')).toContain('general.setting');
    expect(JSON.parse(result.files.get('environment/config-vars.json') ?? '[]')).toEqual([
      {
        key: 'general.setting',
        value: 'value',
        description: 'General setting',
      },
    ]);
    expect(result.files.get('environment/config-vars.json')).not.toContain('profile:voice_vip');
    expect(result.entityCount).toBe(3);
  });

  it('queries config collections with explicit portable projections', async () => {
    const assembler = new CoreAssembler();

    await assembler.assemble({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      dslFormat: 'yaml',
    });

    const projections = new Map<string, string>(
      mockExportSelect.mock.calls.map(([collection, projection]) => [
        collection as string,
        String(projection),
      ]),
    );

    expect(projections.get('ProjectSettings')).toContain('enableThinking');
    expect(projections.get('ProjectRuntimeConfig')).toContain('pipeline');
    expect(projections.get('ProjectLLMConfig')).toBe('operationTierOverrides');
    expect(projections.get('ModelConfig')).toContain('modelId');
    expect(projections.get('AgentModelConfig')).toContain('agentName');
    expect(projections.get('EnvironmentVariable')).toBe('key description isSecret environment');
    expect(projections.get('ProjectConfigVariable')).toBe('key value description');
    expect(projections.get('MCPServerConfig')).toContain('transport');

    for (const projection of projections.values()) {
      expect(projection.split(/\s+/)).not.toEqual(
        expect.arrayContaining([
          '_id',
          'id',
          '__v',
          '_v',
          'tenantId',
          'projectId',
          'createdBy',
          'updatedBy',
          'modifiedBy',
          'ownerId',
          'ownerTeamId',
          'lastEditedBy',
        ]),
      );
    }
  });

  it('preserves source DSL by default', async () => {
    mockProjectAgentFind.mockResolvedValue([
      {
        name: 'Supervisor',
        description: 'Routes',
        dslContent: 'SUPERVISOR: Main\nGOAL: Route requests',
      },
    ]);
    mockProjectToolFind.mockResolvedValue([]);
    mockProjectConfigVariableFind.mockResolvedValue([]);

    const assembler = new CoreAssembler();

    const result = await assembler.assemble({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });

    expect(result.layer).toBe('core');
    expect(result.files.get('agents/supervisor.agent.abl')).toBe(
      'SUPERVISOR: Main\nGOAL: Route requests',
    );
    expect(result.entityCount).toBe(1);
  });

  it('materializes agents to canonical YAML when requested', async () => {
    mockProjectAgentFind.mockResolvedValue([
      {
        name: 'Supervisor',
        description: 'Routes',
        dslContent: 'SUPERVISOR: Main\nGOAL: Route requests',
      },
    ]);
    mockProjectToolFind.mockResolvedValue([]);
    mockProjectConfigVariableFind.mockResolvedValue([]);

    const assembler = new CoreAssembler();

    const result = await assembler.assemble({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      dslFormat: 'yaml',
    });

    expect(result.files.has('agents/supervisor.agent.yaml')).toBe(true);
    expect(result.files.get('agents/supervisor.agent.yaml')).toContain('supervisor: Main');
    expect(result.files.get('agents/supervisor.agent.yaml')).toContain('goal: Route requests');
  });

  it('includes stored behavior profiles in core layer size accounting', async () => {
    const assembler = new CoreAssembler();
    mockModelConfigCountDocuments.mockResolvedValue(1);

    const entityCount = await assembler.countEntities({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      dslFormat: 'yaml',
    });

    expect(entityCount).toBe(4);
    expect(mockModelConfigCountDocuments).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(mockProjectConfigVariableCountDocuments).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      key: /^profile:/,
    });
  });

  it('does not count tenant-less legacy project model configs as exportable model policy state', async () => {
    const assembler = new CoreAssembler();
    mockModelConfigCountDocuments.mockResolvedValue(0);

    const entityCount = await assembler.countEntities({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      dslFormat: 'yaml',
    });

    expect(entityCount).toBe(3);
    expect(mockModelConfigCountDocuments).toHaveBeenCalledTimes(1);
    expect(mockModelConfigCountDocuments).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });

  it('suffixes colliding stored behavior profile filenames and records the final paths', async () => {
    mockProjectConfigVariableFind.mockResolvedValue([
      {
        key: 'profile:Formal-Tone',
        value: 'BEHAVIOR_PROFILE: Formal-Tone\nPRIORITY: 10\n',
        description: 'Behavior profile: Formal-Tone',
      },
      {
        key: 'profile:formal_tone',
        value: 'BEHAVIOR_PROFILE: formal_tone\nPRIORITY: 5\n',
        description: 'Behavior profile: formal_tone',
      },
    ]);

    const assembler = new CoreAssembler();

    const result = await assembler.assemble({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      dslFormat: 'yaml',
    });

    expect(result.files.get('behavior_profiles/formal_tone.behavior_profile.abl')).toContain(
      'BEHAVIOR_PROFILE: Formal-Tone',
    );
    expect(result.files.get('behavior_profiles/formal_tone_2.behavior_profile.abl')).toContain(
      'BEHAVIOR_PROFILE: formal_tone',
    );
    expect(result.metadata?.profiles).toEqual([
      {
        name: 'Formal-Tone',
        path: 'behavior_profiles/formal_tone.behavior_profile.abl',
      },
      {
        name: 'formal_tone',
        path: 'behavior_profiles/formal_tone_2.behavior_profile.abl',
      },
    ]);
  });

  it('exports project model configs as sanitized model policy files', async () => {
    mockProjectConfigVariableFind.mockResolvedValue([]);
    mockModelConfigFind.mockResolvedValue([
      {
        _id: 'mc-voice',
        projectId: 'proj-1',
        name: 'GPT-4o Realtime Preview (2025-06-03)',
        modelId: 'gpt-4o-realtime-preview-2025-06-03',
        provider: 'openai',
        tenantModelId: 'tm-voice',
        credentialId: 'cred-should-not-export',
        authProfileId: 'auth-profile-should-not-export',
        tier: 'voice',
        isDefault: true,
        priority: 10,
        temperature: 0.7,
        maxTokens: 4096,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
        hyperParameters: { enableThinking: true, thinkingBudget: 4096 },
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
        contextWindow: 128000,
        createdAt: new Date('2026-05-03T00:00:00.000Z'),
        updatedAt: new Date('2026-05-03T00:00:00.000Z'),
      },
    ]);

    const assembler = new CoreAssembler();
    const result = await assembler.assemble({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      dslFormat: 'yaml',
    });

    const exportedModel = [...result.files.entries()].find(([path]) =>
      path.startsWith('config/project-model-configs/'),
    );

    expect(exportedModel).toBeDefined();
    expect(mockModelConfigFind).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    const [, content] = exportedModel!;
    const parsed = JSON.parse(content);
    expect(parsed).toMatchObject({
      name: 'GPT-4o Realtime Preview (2025-06-03)',
      modelId: 'gpt-4o-realtime-preview-2025-06-03',
      provider: 'openai',
      tier: 'voice',
      isDefault: true,
      priority: 10,
      hyperParameters: { enableThinking: true, thinkingBudget: 4096 },
    });
    expect(parsed).not.toHaveProperty('_id');
    expect(parsed).not.toHaveProperty('projectId');
    expect(parsed).not.toHaveProperty('tenantModelId');
    expect(parsed).not.toHaveProperty('credentialId');
    expect(parsed).not.toHaveProperty('authProfileId');
  });

  it('keeps colliding config filenames distinct during export', async () => {
    mockProjectConfigVariableFind.mockResolvedValue([]);
    mockModelConfigFind.mockResolvedValue([
      {
        name: 'GPT 4',
        modelId: 'gpt-4',
        provider: 'openai',
        tier: 'balanced',
        isDefault: true,
        priority: 10,
        temperature: 0.7,
        maxTokens: 4096,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
        contextWindow: 128000,
      },
      {
        name: 'GPT/4',
        modelId: 'gpt-4-alt',
        provider: 'openai',
        tier: 'balanced',
        isDefault: false,
        priority: 20,
        temperature: 0.3,
        maxTokens: 8192,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
        supportsTools: true,
        supportsVision: true,
        supportsStreaming: true,
        contextWindow: 128000,
      },
    ]);
    mockAgentModelConfigFind.mockResolvedValue([
      { agentName: 'Sales Agent', defaultModel: 'gpt-4' },
      { agentName: 'Sales/Agent', defaultModel: 'gpt-4-alt' },
    ]);
    mockMCPServerConfigFind.mockResolvedValue([
      { name: 'Docs MCP', transport: 'sse', url: 'https://example.com/docs' },
      { name: 'Docs/MCP', transport: 'sse', url: 'https://example.com/docs-alt' },
    ]);

    const assembler = new CoreAssembler();
    const result = await assembler.assemble({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      dslFormat: 'yaml',
    });

    expect(result.files.has('config/project-model-configs/gpt_4.model-config.json')).toBe(true);
    expect(result.files.has('config/project-model-configs/gpt_4_2.model-config.json')).toBe(true);
    expect(result.files.get('config/project-model-configs/gpt_4.model-config.json')).toContain(
      '"modelId": "gpt-4"',
    );
    expect(result.files.get('config/project-model-configs/gpt_4_2.model-config.json')).toContain(
      '"modelId": "gpt-4-alt"',
    );
    expect(result.files.has('config/agent-model-configs/sales_agent.model-config.json')).toBe(true);
    expect(result.files.has('config/agent-model-configs/sales_agent_2.model-config.json')).toBe(
      true,
    );
    expect(result.files.has('core/mcp-servers/docs_mcp.mcp-config.json')).toBe(true);
    expect(result.files.has('core/mcp-servers/docs_mcp_2.mcp-config.json')).toBe(true);
  });

  it('keeps colliding standalone tool filenames distinct during export', async () => {
    mockProjectToolFind.mockResolvedValue([
      {
        name: 'Lookup Tool',
        slug: 'lookup-tool',
        dslContent: 'TOOL: lookup_first\n  type: http\n  endpoint: "/first"\n',
      },
      {
        name: 'Lookup/Tool',
        slug: 'lookup-tool-alt',
        dslContent: 'TOOL: lookup_second\n  type: http\n  endpoint: "/second"\n',
      },
    ]);
    mockProjectConfigVariableFind.mockResolvedValue([]);

    const assembler = new CoreAssembler();
    const result = await assembler.assemble({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      dslFormat: 'yaml',
    });

    expect(result.files.get('tools/lookup_tool.tools.abl')).toContain('lookup_first');
    expect(result.files.get('tools/lookup_tool_2.tools.abl')).toContain('lookup_second');
    expect(result.metadata?.tools).toEqual([
      { name: 'Lookup Tool', path: 'tools/lookup_tool.tools.abl' },
      { name: 'Lookup/Tool', path: 'tools/lookup_tool_2.tools.abl' },
    ]);
  });

  it('does not export tenant-less legacy project model configs after project tenant verification', async () => {
    mockProjectConfigVariableFind.mockResolvedValue([]);
    mockModelConfigFind.mockResolvedValue([]);

    const assembler = new CoreAssembler();
    const result = await assembler.assemble({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      dslFormat: 'yaml',
    });

    expect(mockProjectFindOne).toHaveBeenCalledWith({ _id: 'proj-1', tenantId: 'tenant-1' });
    expect(mockModelConfigFind).toHaveBeenNthCalledWith(1, {
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(mockModelConfigFind).toHaveBeenCalledTimes(1);
    expect(
      [...result.files.keys()].some((path) => path.startsWith('config/project-model-configs/')),
    ).toBe(false);
  });

  it('exports runtime tenant model bindings as portable descriptors without source tenant ids', async () => {
    mockProjectConfigVariableFind.mockResolvedValue([]);
    mockProjectRuntimeConfigFindOne.mockResolvedValue({
      _id: 'runtime-config-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      pipeline: {
        enabled: true,
        modelSource: 'tenant',
        tenantModelId: 'tm-source-pipeline',
      },
      filler: {
        enabled: true,
        modelSource: 'tenant',
        tenantModelId: 'tm-source-filler',
      },
    });
    mockTenantModelFind.mockResolvedValue([
      {
        _id: 'tm-source-pipeline',
        displayName: 'GPT-4o Realtime Preview (2025-06-03)',
        provider: 'openai',
        modelId: 'gpt-4o-realtime-preview-2025-06-03',
        tier: 'voice',
        capabilities: ['text', 'realtime_voice'],
      },
      {
        _id: 'tm-source-filler',
        displayName: 'GPT-4o Mini',
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        tier: 'fast',
        capabilities: ['text'],
      },
    ]);

    const assembler = new CoreAssembler();
    const result = await assembler.assemble({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      dslFormat: 'yaml',
    });

    const runtimeConfig = JSON.parse(result.files.get('config/runtime-config.json') ?? '{}');
    expect(mockTenantModelFind).toHaveBeenCalledWith({
      _id: { $in: ['tm-source-pipeline', 'tm-source-filler'] },
      tenantId: 'tenant-1',
    });
    expect(runtimeConfig.pipeline).toMatchObject({
      modelSource: 'tenant',
      tenantModelRef: {
        provider: 'openai',
        modelId: 'gpt-4o-realtime-preview-2025-06-03',
        tier: 'voice',
        capabilities: ['text', 'realtime_voice'],
        displayName: 'GPT-4o Realtime Preview (2025-06-03)',
      },
    });
    expect(runtimeConfig.filler).toMatchObject({
      modelSource: 'tenant',
      tenantModelRef: {
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        tier: 'fast',
        capabilities: ['text'],
        displayName: 'GPT-4o Mini',
      },
    });
    expect(runtimeConfig.pipeline).not.toHaveProperty('tenantModelId');
    expect(runtimeConfig.filler).not.toHaveProperty('tenantModelId');
  });

  it('exports runtime config as the effective normalized shape instead of raw partial DB fields', async () => {
    mockProjectConfigVariableFind.mockResolvedValue([]);
    mockProjectRuntimeConfigFindOne.mockResolvedValue({
      _id: 'runtime-config-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      extraction: {
        strategy: 'hybrid',
      },
    });

    const assembler = new CoreAssembler();
    const result = await assembler.assemble({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      dslFormat: 'yaml',
    });

    const runtimeConfig = JSON.parse(result.files.get('config/runtime-config.json') ?? '{}');
    expect(runtimeConfig.extraction).toEqual({
      strategy: 'hybrid',
      correction_detection: 'ml',
      sidecar_timeout_ms: 500,
      sidecar_circuit_breaker_threshold: 5,
      nlu_provider: 'standard',
      advanced_sidecar_timeout_ms: 3000,
      advanced_sidecar_circuit_breaker_threshold: 5,
    });
    expect(runtimeConfig.multi_intent).toMatchObject({
      enabled: true,
      strategy: 'primary_queue',
    });
    expect(runtimeConfig.filler).toMatchObject({
      enabled: true,
      modelSource: 'system',
    });
    expect(runtimeConfig.lookup_tables).toEqual([]);
  });

  it('does not export incompatible canonical LLM operation-tier overrides', async () => {
    mockProjectConfigVariableFind.mockResolvedValue([]);
    mockProjectLLMConfigFindOne.mockResolvedValue({
      _id: 'llm-config-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationTierOverrides: {
        response_gen: 'voice',
      },
    });

    const assembler = new CoreAssembler();
    const result = await assembler.assemble({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      dslFormat: 'yaml',
    });

    const llmConfig = JSON.parse(result.files.get('config/llm-config.json') ?? '{}');
    expect(llmConfig).not.toHaveProperty('operationTierOverrides');
    expect(result.warnings).toContain(
      'Skipped invalid LLM operation-tier overrides during export: Invalid operation-tier overrides (incompatible operation/tier pair(s): response_gen=voice). Valid operations: extraction, validation, tool_selection, response_gen, summarization, reasoning, coordination, realtime_voice. Valid tiers: fast, balanced, powerful, voice, embedding',
    );
  });
});
