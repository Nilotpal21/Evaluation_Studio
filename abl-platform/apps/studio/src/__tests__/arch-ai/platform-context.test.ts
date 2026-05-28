import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeToolFormToDsl } from '@agent-platform/shared';
import type { ToolPermissionContext } from '@/lib/arch-ai/guards';

const {
  ensureDbMock,
  getProjectAgentsMock,
  findProjectToolsByProjectMock,
  getActiveIntegrationDraftForSessionMock,
  toolEndpointFindMock,
  envVarFindMock,
  configVarFindMock,
  membershipFindMock,
  authProfileFindMock,
  channelCountDocumentsMock,
  draftCountDocumentsMock,
} = vi.hoisted(() => ({
  ensureDbMock: vi.fn().mockResolvedValue(undefined),
  getProjectAgentsMock: vi.fn(),
  findProjectToolsByProjectMock: vi.fn(),
  getActiveIntegrationDraftForSessionMock: vi.fn(),
  toolEndpointFindMock: vi.fn(),
  envVarFindMock: vi.fn(),
  configVarFindMock: vi.fn(),
  membershipFindMock: vi.fn(),
  authProfileFindMock: vi.fn(),
  channelCountDocumentsMock: vi.fn(),
  draftCountDocumentsMock: vi.fn(),
}));

function makeLeanQuery<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
  };
}

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: ensureDbMock,
}));

vi.mock('@/services/project-service', () => ({
  getProjectAgents: getProjectAgentsMock,
}));

vi.mock('@agent-platform/shared/repos', () => ({
  findProjectToolsByProject: findProjectToolsByProjectMock,
}));

vi.mock('@/lib/arch-ai/integration-draft-service', () => ({
  getActiveIntegrationDraftForSession: getActiveIntegrationDraftForSessionMock,
}));

vi.mock('@agent-platform/database/models', () => ({
  ToolTestEndpoint: {
    find: toolEndpointFindMock,
  },
  AuthProfile: {
    find: authProfileFindMock,
  },
  EnvironmentVariable: {
    find: envVarFindMock,
  },
  ProjectConfigVariable: {
    find: configVarFindMock,
  },
  VariableNamespaceMembership: {
    find: membershipFindMock,
  },
  ChannelConnection: {
    countDocuments: channelCountDocumentsMock,
  },
  ArchIntegrationDraft: {
    countDocuments: draftCountDocumentsMock,
  },
}));

const TOOL_CONTEXT: ToolPermissionContext = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  user: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    permissions: ['project:read', 'project:update', 'tool:read'],
  },
};

const bootstrapDsl = serializeToolFormToDsl({
  name: 'bootstrap_ping',
  toolType: 'http',
  description: 'Bootstrap test tool',
  parameters: [],
  returnType: 'object',
  endpoint: 'http://localhost:5173/api/public/tool-test/invoke-bootstrap',
  method: 'POST',
  auth: 'none',
});

const crmDsl = serializeToolFormToDsl({
  name: 'crm_lookup',
  toolType: 'http',
  description: 'CRM lookup',
  parameters: [{ name: 'customer_id', type: 'string', required: true }],
  returnType: 'object',
  endpoint: '{{env.CRM_BASE_URL}}/customers',
  method: 'GET',
  auth: 'none',
  authProfileRef: '{{config.CRM_AUTH_PROFILE}}',
});

describe('platform_context', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { projectCache } = await import('@/lib/arch-ai/tools/platform-context');
    projectCache.clear();

    getProjectAgentsMock.mockResolvedValue([
      {
        name: 'RouterAgent',
        description: 'Routes CRM actions',
        dslContent: `AGENT: RouterAgent
TOOLS:
  - crm_lookup(customer_id: string) -> object
  - bootstrap_ping() -> object
`,
      },
    ]);
    findProjectToolsByProjectMock.mockResolvedValue({
      data: [
        {
          id: 'tool-bootstrap',
          name: 'bootstrap_ping',
          toolType: 'http',
          description: 'Bootstrap test tool',
          dslContent: bootstrapDsl,
          variableNamespaceIds: [],
        },
        {
          id: 'tool-crm',
          name: 'crm_lookup',
          toolType: 'http',
          description: 'CRM lookup',
          dslContent: crmDsl,
          variableNamespaceIds: ['ns-crm'],
        },
      ],
      pagination: { page: 1, limit: 50, total: 2, hasMore: false },
    });
    toolEndpointFindMock.mockReturnValue(
      makeLeanQuery([
        {
          projectToolId: 'tool-bootstrap',
          invokeCapability: 'invoke-bootstrap',
          specCapability: 'spec-bootstrap',
          status: 'active',
        },
      ]),
    );
    envVarFindMock.mockReturnValue(
      makeLeanQuery([{ _id: 'env-1', key: 'CRM_BASE_URL', environment: 'production' }]),
    );
    configVarFindMock.mockReturnValue(
      makeLeanQuery([{ _id: 'cfg-1', key: 'CRM_AUTH_PROFILE', value: 'crm_shared_auth' }]),
    );
    membershipFindMock.mockReturnValue(
      makeLeanQuery([
        { variableId: 'env-1', namespaceId: 'ns-crm', variableType: 'env' },
        { variableId: 'cfg-1', namespaceId: 'ns-crm', variableType: 'config' },
      ]),
    );
    authProfileFindMock.mockReturnValue(
      makeLeanQuery([
        {
          _id: 'auth-1',
          name: 'crm_shared_auth',
          authType: 'bearer',
          status: 'ready',
          projectId: 'proj-1',
          scope: 'project',
          visibility: 'shared',
          connectionMode: 'shared',
        },
      ]),
    );
    channelCountDocumentsMock.mockResolvedValue(0);
    draftCountDocumentsMock.mockResolvedValue(1);
  });

  it('returns tool readiness, impacted agents, and the active session draft', async () => {
    getActiveIntegrationDraftForSessionMock.mockResolvedValue({
      id: 'draft-a',
      title: 'CRM Integration',
    });

    const { executePlatformContext } = await import('@/lib/arch-ai/tools/platform-context');
    const result = await executePlatformContext({ action: 'list_tools' }, TOOL_CONTEXT);

    expect(result.success).toBe(true);
    expect(getActiveIntegrationDraftForSessionMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
    expect(result.data).toMatchObject({
      activeIntegrationDraft: { id: 'draft-a', title: 'CRM Integration' },
    });

    const data = result.data as {
      tools: Array<{
        name: string;
        implementation: { mode: string; studioTestEndpoint?: { active: boolean } | null };
        readiness: {
          overallReady: boolean;
          missingEnvKeys: string[];
          missingConfigKeys: string[];
          auth: {
            ready: boolean;
            configKey: string | null;
            resolvedProfile: { name: string } | null;
          };
        };
        impactedAgents: string[];
      }>;
    };

    expect(data.tools).toHaveLength(2);
    expect(data.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'bootstrap_ping',
          implementation: expect.objectContaining({
            mode: 'studio_test_api',
            studioTestEndpoint: expect.objectContaining({ active: true }),
          }),
          readiness: expect.objectContaining({
            overallReady: true,
          }),
          impactedAgents: ['RouterAgent'],
        }),
        expect.objectContaining({
          name: 'crm_lookup',
          implementation: expect.objectContaining({ mode: 'external' }),
          readiness: expect.objectContaining({
            overallReady: true,
            missingEnvKeys: [],
            missingConfigKeys: [],
            auth: expect.objectContaining({
              ready: true,
              configKey: 'CRM_AUTH_PROFILE',
              resolvedProfile: expect.objectContaining({ name: 'crm_shared_auth' }),
            }),
          }),
          impactedAgents: ['RouterAgent'],
        }),
      ]),
    );
  });

  it('does not reuse cached tool context across sessions with different active drafts', async () => {
    getActiveIntegrationDraftForSessionMock
      .mockResolvedValueOnce({ id: 'draft-a' })
      .mockResolvedValueOnce({ id: 'draft-b' });

    const { executePlatformContext } = await import('@/lib/arch-ai/tools/platform-context');
    const first = await executePlatformContext({ action: 'list_tools' }, TOOL_CONTEXT);
    const second = await executePlatformContext(
      { action: 'list_tools' },
      {
        ...TOOL_CONTEXT,
        sessionId: 'sess-2',
      },
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(
      (first.data as { activeIntegrationDraft: { id: string } | null }).activeIntegrationDraft,
    ).toEqual({ id: 'draft-a' });
    expect(
      (second.data as { activeIntegrationDraft: { id: string } | null }).activeIntegrationDraft,
    ).toEqual({ id: 'draft-b' });
  });
});
