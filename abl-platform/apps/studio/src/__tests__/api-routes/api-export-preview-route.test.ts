import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

const mockCanProjectPermissionContextPerform = vi.fn();
const mockResolveProjectPermissionContext = vi.fn();
const mockResolveStudioProjectPermissionAliases = vi.fn();

vi.mock('@/lib/project-permission', () => ({
  canProjectPermissionContextPerform: (...args: unknown[]) =>
    mockCanProjectPermissionContextPerform(...args),
  resolveProjectPermissionContext: (...args: unknown[]) =>
    mockResolveProjectPermissionContext(...args),
  resolveStudioProjectPermissionAliases: (...args: unknown[]) =>
    mockResolveStudioProjectPermissionAliases(...args),
}));

const mockHasPermission = vi.fn();
const mockHasAnyPermission = vi.fn();

vi.mock('@/lib/permission-resolver', () => ({
  resolveStudioPermissions: vi.fn().mockResolvedValue([]),
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
  hasAnyPermission: (...args: unknown[]) => mockHasAnyPermission(...args),
}));

vi.mock('@/config', () => ({
  getConfig: vi.fn(() => ({
    jwt: { secret: 'test-jwt-secret' },
    server: { frontendUrl: 'http://localhost:5173' },
  })),
  isConfigLoaded: vi.fn(() => true),
}));

const mockProjectAgentFind = vi.fn();
const mockProjectToolFind = vi.fn();
const mockProjectConfigVariableFind = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();
const mockConnectorConfigFind = vi.fn();
const mockMCPServerConfigFind = vi.fn();

function makeChainable(data: unknown[]) {
  return {
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(data) }),
    lean: vi.fn().mockResolvedValue(data),
  };
}

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  ProjectAgent: {
    find: (...args: unknown[]) => mockProjectAgentFind(...args),
  },
  ProjectTool: {
    find: (...args: unknown[]) => mockProjectToolFind(...args),
  },
  ProjectConfigVariable: {
    find: (...args: unknown[]) => mockProjectConfigVariableFind(...args),
  },
  ProjectRuntimeConfig: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockProjectRuntimeConfigFindOne(...args),
    }),
  },
  ProjectLLMConfig: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockProjectLLMConfigFindOne(...args),
    }),
  },
  ConnectorConfig: {
    find: (...args: unknown[]) => mockConnectorConfigFind(...args),
  },
  MCPServerConfig: {
    find: (...args: unknown[]) => mockMCPServerConfigFind(...args),
  },
}));

const mockBehaviorProfileConfigKeyToName = vi.fn((key: string) =>
  key.startsWith('profile:') ? key.slice('profile:'.length) : null,
);

vi.mock('@agent-platform/project-io', () => ({
  behaviorProfileConfigKeyToName: (...args: unknown[]) =>
    mockBehaviorProfileConfigKeyToName(...args),
}));

const mockResolveLayers = vi.fn();
const mockBuildLayerPreview = vi.fn();
const mockBuildExportProvisioningRequirements = vi.fn();

vi.mock('@agent-platform/project-io/export', () => ({
  resolveLayers: (...args: unknown[]) => mockResolveLayers(...args),
  buildLayerPreview: (...args: unknown[]) => mockBuildLayerPreview(...args),
  buildExportProvisioningRequirements: (...args: unknown[]) =>
    mockBuildExportProvisioningRequirements(...args),
}));

const mockBuildDependencyGraph = vi.fn();
const mockValidateDependencies = vi.fn();

vi.mock('@agent-platform/project-io/dependencies', () => ({
  buildDependencyGraph: (...args: unknown[]) => mockBuildDependencyGraph(...args),
  validateDependencies: (...args: unknown[]) => mockValidateDependencies(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/repos/project-repo', () => ({
  findProjectByIdAndTenant: vi.fn(),
  findProjectById: vi.fn(),
}));

const testUser = {
  id: 'user-1',
  email: 'test@test.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  permissions: ['project:read'],
};

const testProject = {
  id: 'proj-1',
  _id: 'proj-1',
  name: 'Support Ops',
  slug: 'support-ops',
  ownerId: 'user-1',
  tenantId: 'tenant-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockResolvedValue({ project: testProject });
  mockIsAccessError.mockReturnValue(false);
  mockResolveStudioProjectPermissionAliases.mockReturnValue(null);
  mockResolveProjectPermissionContext.mockResolvedValue({
    project: testProject,
    accessLevel: 'project_member',
    role: 'viewer',
    customRolePermissions: [],
  });
  mockCanProjectPermissionContextPerform.mockReturnValue(true);
  mockHasPermission.mockReturnValue(true);
  mockHasAnyPermission.mockReturnValue(true);

  mockProjectAgentFind.mockReturnValue(
    makeChainable([
      {
        name: 'support_agent',
        dslContent: 'AGENT support_agent',
        dslValidationStatus: 'valid',
        dslDiagnostics: [],
      },
    ]),
  );
  mockProjectToolFind.mockReturnValue(
    makeChainable([
      {
        name: 'search_docs',
        slug: 'search_docs',
        toolType: 'mcp',
        dslContent: 'TOOL search_docs',
      },
    ]),
  );
  mockProjectConfigVariableFind.mockReturnValue(
    makeChainable([
      {
        key: 'profile:vip_support',
        value: 'BEHAVIOR_PROFILE: vip_support\nPRIORITY: 10\nWHEN: always',
      },
    ]),
  );
  mockProjectRuntimeConfigFindOne.mockResolvedValue(null);
  mockProjectLLMConfigFindOne.mockResolvedValue(null);
  mockConnectorConfigFind.mockReturnValue(
    makeChainable([{ connectorType: 'salesforce' }, { connectorType: 'salesforce' }]),
  );
  mockMCPServerConfigFind.mockReturnValue(makeChainable([{ name: 'docs-mcp' }]));
  mockResolveLayers.mockReturnValue(['core', 'connections', 'guardrails', 'workflows']);
  mockBuildLayerPreview.mockResolvedValue([
    { name: 'core', defaultMode: 'always', entityCount: 3 },
    { name: 'connections', defaultMode: 'always', entityCount: 1 },
    { name: 'guardrails', defaultMode: 'on', entityCount: 0 },
    { name: 'workflows', defaultMode: 'on', entityCount: 2 },
    { name: 'evals', defaultMode: 'off', entityCount: 0 },
    { name: 'search', defaultMode: 'off', entityCount: 0 },
    { name: 'channels', defaultMode: 'off', entityCount: 0 },
    { name: 'vocabulary', defaultMode: 'off', entityCount: 0 },
  ]);
  mockBuildExportProvisioningRequirements.mockReturnValue({
    requiredEnvVars: ['OPENAI_API_KEY'],
    requiredAuthProfiles: [
      {
        authType: 'unknown',
        config: {},
        name: 'zendesk_oauth',
        referencedBy: ['support_agent'],
        scope: 'project',
      },
    ],
    requiredConnectors: ['salesforce'],
    requiredMcpServers: ['docs-mcp'],
  });
  mockBuildDependencyGraph.mockReturnValue({
    edges: [{ from: 'support_agent', to: 'billing_agent', type: 'handoff' }],
  });
  mockValidateDependencies.mockReturnValue({
    valid: true,
    missing: [],
    circular: [],
  });
});

describe('POST /api/projects/:id/export/preview', () => {
  it('returns canonical layer metadata and passes profile names into dependency analysis', async () => {
    const { POST } = await import('@/app/api/projects/[id]/export/preview/route');

    const response = await POST(
      new NextRequest('http://localhost/api/projects/proj-1/export/preview', { method: 'POST' }),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.project).toEqual({ name: 'Support Ops', slug: 'support-ops' });
    expect(body.profiles).toEqual(['vip_support']);
    expect(body.provisioning).toEqual({
      requiredEnvVars: ['OPENAI_API_KEY'],
      requiredAuthProfiles: [
        {
          authType: 'unknown',
          config: {},
          name: 'zendesk_oauth',
          referencedBy: ['support_agent'],
          scope: 'project',
        },
      ],
      requiredConnectors: ['salesforce'],
      requiredMcpServers: ['docs-mcp'],
    });
    expect(mockBuildExportProvisioningRequirements).toHaveBeenCalledWith(
      expect.objectContaining({
        profiles: expect.arrayContaining([{ name: 'vip_support', dslContent: expect.any(String) }]),
      }),
    );
    expect(body.layers).toEqual([
      { name: 'core', defaultMode: 'always', entityCount: 3 },
      { name: 'connections', defaultMode: 'always', entityCount: 1 },
      { name: 'guardrails', defaultMode: 'on', entityCount: 0 },
      { name: 'workflows', defaultMode: 'on', entityCount: 2 },
      { name: 'evals', defaultMode: 'off', entityCount: 0 },
      { name: 'search', defaultMode: 'off', entityCount: 0 },
      { name: 'channels', defaultMode: 'off', entityCount: 0 },
      { name: 'vocabulary', defaultMode: 'off', entityCount: 0 },
    ]);
    expect(body.defaultLayers).toEqual(['core', 'connections', 'guardrails', 'workflows']);

    expect(mockBuildDependencyGraph).toHaveBeenCalledWith(
      [{ name: 'support_agent', dslContent: 'AGENT support_agent' }],
      [
        {
          name: 'search_docs',
          path: 'tools/search_docs.tools.abl',
          content: 'TOOL search_docs',
        },
      ],
      ['vip_support'],
    );
    expect(mockBuildLayerPreview).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', tenantId: 'tenant-1' }),
    );
    expect(mockBuildExportProvisioningRequirements).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorConfigs: [{ connectorType: 'salesforce' }, { connectorType: 'salesforce' }],
        mcpServers: [{ name: 'docs-mcp' }],
      }),
    );
  });

  it('returns 409 when project-level export readiness is blocked by runtime config', async () => {
    mockProjectRuntimeConfigFindOne.mockResolvedValueOnce({
      extraction: {
        nlu_provider: 'advanced',
      },
    });
    mockProjectAgentFind.mockReturnValue(
      makeChainable([
        {
          name: 'support_agent',
          dslContent: 'AGENT support_agent',
          dslValidationStatus: 'valid',
          dslDiagnostics: [],
        },
      ]),
    );

    const { POST } = await import('@/app/api/projects/[id]/export/preview/route');

    const response = await POST(
      new NextRequest('http://localhost/api/projects/proj-1/export/preview', { method: 'POST' }),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({
      success: false,
      error: { code: 'INVALID_AGENT_DRAFT' },
      issues: [
        {
          kind: 'runtime_config',
          diagnostics: [
            {
              severity: 'error',
              message: expect.stringContaining('advanced_sidecar_url is required'),
            },
          ],
        },
      ],
    });
    expect(mockBuildDependencyGraph).not.toHaveBeenCalled();
    expect(mockBuildLayerPreview).not.toHaveBeenCalled();
  });

  it('returns 401 when authentication fails', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const { POST } = await import('@/app/api/projects/[id]/export/preview/route');
    const response = await POST(
      new NextRequest('http://localhost/api/projects/proj-1/export/preview', { method: 'POST' }),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );

    expect(response.status).toBe(401);
  });
});
