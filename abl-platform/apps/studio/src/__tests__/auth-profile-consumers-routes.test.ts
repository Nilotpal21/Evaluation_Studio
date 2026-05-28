import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireAuth = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockEnsureDb = vi.fn();

// Workspace consumer models
const mockAuthProfileFindOne = vi.fn();
const mockTenantModelFind = vi.fn();
const mockTenantGuardrailProviderConfigFind = vi.fn();
const mockTenantServiceInstanceFind = vi.fn();
const mockConnectorConfigFind = vi.fn();
const mockArchWorkspaceConfigFind = vi.fn();

// Project consumer models
const mockConnectorConnectionFind = vi.fn();
const mockChannelConnectionFind = vi.fn();
const mockMCPServerConfigFind = vi.fn();
const mockServiceNodeFind = vi.fn();
const mockGitIntegrationFind = vi.fn();
const mockTriggerRegistrationFind = vi.fn();
const mockProjectToolFind = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: (...args: unknown[]) => mockEnsureDb(...args),
}));

vi.mock('@/app/api/auth-profiles/_auth-profile-route-utils', () => ({
  ensureReadableAuthProfile: vi.fn(() => null),
}));

vi.mock('@/lib/route-handler', () => ({
  withRouteHandler:
    (options: { requireProject?: boolean }, handler: Function) =>
    async (request: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
      const authResult = await mockRequireAuth(request);
      if (authResult instanceof NextResponse) return authResult;
      const params = await ctx.params;
      let project = undefined;
      if (options.requireProject) {
        const accessResult = await mockRequireProjectAccess(request, params.id);
        if (accessResult instanceof NextResponse) return accessResult;
        project = accessResult.project;
      }
      return handler({
        request,
        user: authResult,
        tenantId: authResult.tenantId,
        params,
        project,
      });
    },
}));

vi.mock('@/lib/permissions', () => ({
  StudioPermission: {
    AUTH_PROFILE_READ: 'auth-profile:read',
    AUTH_PROFILE_DECRYPT: 'auth-profile:decrypt',
  },
}));

vi.mock('@/lib/api-response', () => ({
  errorJson: vi.fn(
    (msg: string, status: number) =>
      new NextResponse(JSON.stringify({ success: false, error: { message: msg } }), { status }),
  ),
  ErrorCode: { NOT_FOUND: 'NOT_FOUND' },
}));

function mockSelectLean(data: unknown) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(data),
    }),
  };
}

function mockLeanResult(data: unknown) {
  return {
    lean: vi.fn().mockResolvedValue(data),
  };
}

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: unknown[]) => mockAuthProfileFindOne(...args),
  },
  // Workspace-scoped entity models
  TenantModel: {
    find: (...args: unknown[]) => mockTenantModelFind(...args),
  },
  TenantGuardrailProviderConfig: {
    find: (...args: unknown[]) => mockTenantGuardrailProviderConfigFind(...args),
  },
  TenantServiceInstance: {
    find: (...args: unknown[]) => mockTenantServiceInstanceFind(...args),
  },
  ConnectorConfig: {
    find: (...args: unknown[]) => mockConnectorConfigFind(...args),
  },
  ArchWorkspaceConfig: {
    find: (...args: unknown[]) => mockArchWorkspaceConfigFind(...args),
  },
  // Project-scoped entity models
  ConnectorConnection: {
    find: (...args: unknown[]) => mockConnectorConnectionFind(...args),
  },
  ChannelConnection: {
    find: (...args: unknown[]) => mockChannelConnectionFind(...args),
  },
  MCPServerConfig: {
    find: (...args: unknown[]) => mockMCPServerConfigFind(...args),
  },
  ServiceNode: {
    find: (...args: unknown[]) => mockServiceNodeFind(...args),
  },
  GitIntegration: {
    find: (...args: unknown[]) => mockGitIntegrationFind(...args),
  },
  TriggerRegistration: {
    find: (...args: unknown[]) => mockTriggerRegistrationFind(...args),
  },
  ProjectTool: {
    find: (...args: unknown[]) => mockProjectToolFind(...args),
  },
}));

import { GET as ProjectConsumersGET } from '@/app/api/projects/[id]/auth-profiles/[profileId]/consumers/route';
import { GET as WorkspaceConsumersGET } from '@/app/api/auth-profiles/[profileId]/consumers/route';

describe('auth profile consumers routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureDb.mockResolvedValue(undefined);
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['auth-profile:read'],
    });
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1' },
    });

    // Default: profile found, all entity queries return empty
    mockAuthProfileFindOne.mockReturnValue(
      mockLeanResult({
        _id: 'profile-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        scope: 'project',
        visibility: 'shared',
        createdBy: 'user-1',
      }),
    );

    // Project consumer models return empty by default
    mockConnectorConnectionFind.mockReturnValue(mockSelectLean([]));
    mockChannelConnectionFind.mockReturnValue(mockSelectLean([]));
    mockMCPServerConfigFind.mockReturnValue(mockSelectLean([]));
    mockServiceNodeFind.mockReturnValue(mockSelectLean([]));
    mockGitIntegrationFind.mockReturnValue(mockSelectLean([]));
    mockTriggerRegistrationFind.mockReturnValue(mockSelectLean([]));
    mockProjectToolFind.mockReturnValue(mockSelectLean([]));

    // Workspace consumer models return empty by default
    mockTenantModelFind.mockReturnValue(mockSelectLean([]));
    mockTenantGuardrailProviderConfigFind.mockReturnValue(mockSelectLean([]));
    mockTenantServiceInstanceFind.mockReturnValue(mockSelectLean([]));
    mockConnectorConfigFind.mockReturnValue(mockSelectLean([]));
    mockArchWorkspaceConfigFind.mockReturnValue(mockSelectLean([]));
  });

  it('project consumers route queries entity models referencing the auth profile', async () => {
    mockConnectorConnectionFind.mockReturnValue(
      mockSelectLean([
        { _id: 'conn-1', displayName: 'My Salesforce', connectorName: 'salesforce' },
      ]),
    );
    mockChannelConnectionFind.mockReturnValue(
      mockSelectLean([{ _id: 'ch-1', displayName: 'Slack Channel', channelType: 'slack' }]),
    );

    const response = await ProjectConsumersGET(
      new NextRequest(
        'http://localhost:3000/api/projects/proj-1/auth-profiles/profile-1/consumers',
      ),
      {
        params: Promise.resolve({ id: 'proj-1', profileId: 'profile-1' }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'integration', id: 'conn-1', name: 'My Salesforce' }),
        expect.objectContaining({ type: 'channel', id: 'ch-1', name: 'Slack Channel' }),
      ]),
    );
    expect(body.tools).toBe(0);
    expect(body.a2aServers).toEqual([]);

    // Verify entity queries filter by authProfileId, tenantId, projectId,
    // and only include the caller's visible personal connections.
    expect(mockConnectorConnectionFind).toHaveBeenCalledWith({
      authProfileId: 'profile-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      $or: [{ scope: 'tenant' }, { scope: 'user', userId: 'user-1' }],
    });
    expect(mockChannelConnectionFind).toHaveBeenCalledWith({
      authProfileId: 'profile-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    expect(mockProjectToolFind).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      dslContent: { $regex: 'auth_profile\\s*:' },
    });
  });

  it('project consumers route includes HTTP tools referencing the auth profile by name', async () => {
    mockAuthProfileFindOne.mockReturnValue(
      mockLeanResult({
        _id: 'profile-1',
        name: 'billing_auth',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        scope: 'project',
        visibility: 'shared',
        createdBy: 'user-1',
      }),
    );
    mockProjectToolFind.mockReturnValue(
      mockSelectLean([
        {
          _id: 'tool-1',
          name: 'billing_lookup',
          dslContent: 'billing_lookup() -> object\n  type: http\n  auth_profile: "billing_auth"\n',
        },
        {
          _id: 'tool-2',
          name: 'unrelated',
          dslContent: 'unrelated() -> object\n  type: http\n  auth_profile: "other_profile"\n',
        },
      ]),
    );

    const response = await ProjectConsumersGET(
      new NextRequest(
        'http://localhost:3000/api/projects/proj-1/auth-profiles/profile-1/consumers',
      ),
      {
        params: Promise.resolve({ id: 'proj-1', profileId: 'profile-1' }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool',
          id: 'tool-1',
          name: 'billing_lookup',
          label: 'HTTP Tool',
        }),
      ]),
    );
  });

  it('does not leak service-node consumers from another tenant', async () => {
    mockServiceNodeFind.mockImplementation((filter: { tenantId?: string }) =>
      mockSelectLean(
        filter.tenantId === 'tenant-1'
          ? []
          : [{ _id: 'svc-foreign', displayName: 'Foreign Service Node', tenantId: 'tenant-2' }],
      ),
    );

    const response = await ProjectConsumersGET(
      new NextRequest(
        'http://localhost:3000/api/projects/proj-1/auth-profiles/profile-1/consumers',
      ),
      {
        params: Promise.resolve({ id: 'proj-1', profileId: 'profile-1' }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'service',
          id: 'svc-foreign',
          name: 'Foreign Service Node',
        }),
      ]),
    );
    expect(mockServiceNodeFind).toHaveBeenCalledWith({
      authProfileId: 'profile-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
  });

  it('workspace consumers route queries tenant-scoped entity models', async () => {
    mockAuthProfileFindOne.mockReturnValue(
      mockLeanResult({
        _id: 'profile-1',
        tenantId: 'tenant-1',
        projectId: null,
        scope: 'tenant',
        visibility: 'shared',
        createdBy: 'user-1',
      }),
    );

    mockTenantModelFind.mockReturnValue(
      mockSelectLean([{ _id: 'model-1', displayName: 'GPT-4o', provider: 'openai' }]),
    );

    const response = await WorkspaceConsumersGET(
      new NextRequest('http://localhost:3000/api/auth-profiles/profile-1/consumers'),
      {
        params: Promise.resolve({ profileId: 'profile-1' }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual(
      expect.objectContaining({ type: 'model', id: 'model-1', name: 'GPT-4o' }),
    );
  });

  it('returns 404 when the auth profile does not exist', async () => {
    mockAuthProfileFindOne.mockReturnValue(mockLeanResult(null));

    const response = await ProjectConsumersGET(
      new NextRequest(
        'http://localhost:3000/api/projects/proj-1/auth-profiles/profile-missing/consumers',
      ),
      {
        params: Promise.resolve({ id: 'proj-1', profileId: 'profile-missing' }),
      },
    );

    expect(response.status).toBe(404);
  });
});
