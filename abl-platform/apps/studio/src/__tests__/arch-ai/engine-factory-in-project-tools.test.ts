import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IN_PROJECT_TOOLS } from '@agent-platform/arch-ai';

const {
  buildV1CoreRefsMock,
  kbManageMock,
  mcpServerOpsMock,
  platformContextMock,
  projectConfigMock,
  sessionOpsMock,
  agentOpsMock,
} = vi.hoisted(() => ({
  buildV1CoreRefsMock: vi.fn(),
  kbManageMock: vi.fn(),
  mcpServerOpsMock: vi.fn(),
  platformContextMock: vi.fn(),
  projectConfigMock: vi.fn(),
  sessionOpsMock: vi.fn(),
  agentOpsMock: vi.fn(),
}));

vi.mock('@/lib/arch-ai/compat/v1-core-refs', () => ({
  buildV1CoreRefs: buildV1CoreRefsMock,
}));

vi.mock('@/lib/arch-ai/tools/agent-ops', () => ({
  executeAgentOps: agentOpsMock,
}));

import { buildOnboardingToolRegistry } from '@/lib/arch-ai/engine-factory';
import { buildInProjectTools } from '@/lib/arch-ai/tools/in-project-tools';

const CTX = {
  sessionId: 'session-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  mode: 'in-project' as const,
  projectId: 'project-1',
  signal: new AbortController().signal,
  emit: vi.fn(),
  services: {
    permissions: ['project:read', 'project:update', 'tool:read', 'tool:write'],
    authToken: 'token-123',
  },
};

describe('buildOnboardingToolRegistry in-project capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectConfigMock.mockResolvedValue({ success: true });
    kbManageMock.mockResolvedValue({ success: true });
    mcpServerOpsMock.mockResolvedValue({ success: true });
    platformContextMock.mockResolvedValue({ success: true });
    sessionOpsMock.mockResolvedValue({ success: true });
    agentOpsMock.mockResolvedValue({ success: true });
    buildV1CoreRefsMock.mockResolvedValue({
      projectConfig: projectConfigMock,
      kbManage: kbManageMock,
      mcpServerOps: mcpServerOpsMock,
      platformContext: platformContextMock,
      sessionOps: sessionOpsMock,
    });
  });

  it('registers declared project and knowledge-base tools in the live registry', () => {
    const registry = buildOnboardingToolRegistry();

    for (const toolName of [
      'project_config',
      'kb_manage',
      'kb_search',
      'kb_health',
      'kb_ingest',
      'kb_connector',
      'kb_documents',
      'mcp_server_ops',
      'session_ops',
    ]) {
      expect(registry.get(toolName), `${toolName} should be registered`).toBeDefined();
    }
  });

  it('registers every model-visible in-project tool declared for specialist routing', () => {
    const registry = buildOnboardingToolRegistry();

    const missing = IN_PROJECT_TOOLS.filter((toolName) => !registry.get(toolName));

    expect(missing).toEqual([]);
  });

  it('registers documentation search and topology pattern lookup tools', async () => {
    const registry = buildOnboardingToolRegistry();
    const searchDocs = registry.get('search_docs');
    const topologyPatterns = registry.get('get_topology_patterns');

    expect(searchDocs?.inputSchema.safeParse({ query: 'handoff', limit: 1 })).toMatchObject({
      success: true,
    });
    expect(topologyPatterns?.inputSchema.safeParse({ filter: 'simple' })).toMatchObject({
      success: true,
    });

    await expect(searchDocs?.execute?.({ query: 'handoff', limit: 1 }, CTX)).resolves.toMatchObject(
      {
        success: true,
      },
    );
    await expect(topologyPatterns?.execute?.({ filter: 'simple' }, CTX)).resolves.toMatchObject({
      patterns: expect.arrayContaining([
        expect.objectContaining({ id: 'single_agent' }),
        expect.objectContaining({ id: 'triage_specialists' }),
      ]),
    });
  });

  it('accepts the prompted manage_memory delete action and legacy remove alias', () => {
    const registry = buildOnboardingToolRegistry();
    const tool = registry.get('manage_memory');

    expect(tool?.inputSchema.safeParse({ action: 'delete', memoryId: 'memory-1' })).toMatchObject({
      success: true,
    });
    expect(tool?.inputSchema.safeParse({ action: 'remove', memoryId: 'memory-1' })).toMatchObject({
      success: true,
    });
  });

  it('accepts the session, trace, and insight contracts needed for behavior analysis', () => {
    const registry = buildOnboardingToolRegistry();

    expect(
      registry.get('session_ops')?.inputSchema.safeParse({
        action: 'get_analysis',
        sessionId: 'session-123',
      }),
    ).toMatchObject({ success: true });
    expect(
      registry.get('trace_diagnosis')?.inputSchema.safeParse({
        action: 'compare',
        query: 'compare today vs yesterday for Billing_Agent',
        compareWithTimeRange: 'yesterday',
        agentName: 'Billing_Agent',
      }),
    ).toMatchObject({ success: true });
    expect(
      registry.get('query_traces')?.inputSchema.safeParse({
        sessionId: 'session-123',
        eventTypes: ['tool_call', 'error'],
        severity: 'error',
        includeData: true,
        limit: 50,
      }),
    ).toMatchObject({ success: true });
    expect(
      registry.get('read_insights')?.inputSchema.safeParse({
        action: 'agent_performance',
        agentName: 'Billing_Agent',
        timeRange: '24h',
      }),
    ).toMatchObject({ success: true });
  });

  it('uses the secure collect_secret contract expected by auth_ops and SecretInput', () => {
    const registry = buildOnboardingToolRegistry();
    const tool = registry.get('collect_secret');

    expect(tool?.kind).toBe('interactive');
    expect(
      tool?.inputSchema.safeParse({ flowId: 'flow-1', field: 'apiKey', label: 'API Key' }),
    ).toMatchObject({
      success: true,
    });
    expect(
      tool?.inputSchema.safeParse({ message: 'Enter your API key', secretType: 'api_key' }),
    ).toMatchObject({
      success: false,
    });
  });

  it('accepts the full configure_model apply contract including confirmation fields', () => {
    const registry = buildOnboardingToolRegistry();
    const tool = registry.get('configure_model');

    expect(
      tool?.inputSchema.safeParse({
        action: 'apply',
        agentName: 'LeadIntake',
        source: 'manual',
        provider: 'openai',
        modelId: 'gpt-4.1',
        temperature: 0.2,
        maxTokens: 1200,
        operationModels: { default: 'gpt-4.1-mini' },
        confirmed: true,
      }),
    ).toMatchObject({
      success: true,
    });
  });

  it('accepts the MCP server ops contract for auth-backed server setup', () => {
    const registry = buildOnboardingToolRegistry();
    const tool = registry.get('mcp_server_ops');

    expect(
      tool?.inputSchema.safeParse({
        action: 'create',
        name: 'corp-tools',
        transport: 'http',
        url: '{{env.CORP_MCP_URL}}/mcp',
        authType: 'oauth2_client_credentials',
        authConfig: {
          tokenEndpoint: 'https://auth.example.com/oauth/token',
          scopes: ['tools.read'],
        },
      }),
    ).toMatchObject({
      success: true,
    });
  });

  it('accepts validate_agent depth for project runtime validation', () => {
    const registry = buildOnboardingToolRegistry();
    const tool = registry.get('validate_agent');

    expect(tool?.inputSchema.safeParse({ agentName: 'LeadIntake', depth: 'deep' })).toMatchObject({
      success: true,
    });
  });

  it('delegates project_config and kb_manage to existing compat refs', async () => {
    const registry = buildOnboardingToolRegistry();

    await expect(
      registry.get('project_config')?.execute?.({ action: 'get_config', confirmed: false }, CTX),
    ).resolves.toEqual({ success: true });

    await expect(
      registry.get('kb_manage')?.execute?.({ action: 'list', confirmed: false }, CTX),
    ).resolves.toEqual({ success: true });

    expect(projectConfigMock).toHaveBeenCalledWith(CTX, 'project-1', {
      action: 'get_config',
      confirmed: false,
    });
    expect(kbManageMock).toHaveBeenCalledWith(CTX, 'project-1', {
      action: 'list',
      confirmed: false,
    });
  });

  it('delegates mcp_server_ops to existing compat refs', async () => {
    const registry = buildOnboardingToolRegistry();
    const input = { action: 'list' };

    await expect(registry.get('mcp_server_ops')?.execute?.(input, CTX)).resolves.toEqual({
      success: true,
    });

    expect(mcpServerOpsMock).toHaveBeenCalledWith(CTX, 'project-1', input);
  });

  it('delegates session_ops to existing compat refs', async () => {
    const registry = buildOnboardingToolRegistry();
    const input = { action: 'list', limit: 5 };

    await expect(registry.get('session_ops')?.execute?.(input, CTX)).resolves.toEqual({
      success: true,
    });

    expect(sessionOpsMock).toHaveBeenCalledWith(CTX, 'project-1', input);
  });

  it('delegates in-project platform_context to the project-aware implementation', async () => {
    const registry = buildOnboardingToolRegistry();
    const input = { action: 'list_agents' };

    await expect(registry.get('platform_context')?.execute?.(input, CTX)).resolves.toEqual({
      success: true,
    });

    expect(platformContextMock).toHaveBeenCalledWith(CTX, 'project-1', input);
  });

  it('forwards mutation guard services into in-project tool contexts', async () => {
    const registry = buildOnboardingToolRegistry();
    const guardedCtx = {
      ...CTX,
      services: {
        ...CTX.services,
        archMutationGuard: {
          requireApprovedPlanForMutation: true,
          approvedPlan: { id: 'plan-1', status: 'approved' },
        },
      },
    };
    const input = { action: 'list' };

    await expect(registry.get('agent_ops')?.execute?.(input, guardedCtx)).resolves.toEqual({
      success: true,
    });

    expect(agentOpsMock).toHaveBeenCalledWith(
      input,
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'session-1',
        requireApprovedPlanForMutation: true,
        approvedPlan: { id: 'plan-1', status: 'approved' },
      }),
    );
  });

  it('registers the 4 newly wired in-project ops tools and drops legacy run_test', () => {
    const tools = buildInProjectTools(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'session-1',
      'project-1',
    );
    const toolNames = Object.keys(tools);

    expect(toolNames).toContain('agent_ops');
    expect(toolNames).toContain('deployment_ops');
    expect(toolNames).toContain('testing_ops');
    expect(toolNames).toContain('analytics_ops');

    // Task 5 collapsed the standalone run_test tool into testing_ops:run_test
    // (the action). Asserting absence here protects against a future revert
    // that would re-introduce the standalone tool and silently shadow the
    // collapsed action.
    expect(toolNames).not.toContain('run_test');
  });
});
