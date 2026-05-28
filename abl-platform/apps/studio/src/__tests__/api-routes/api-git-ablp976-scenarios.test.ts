/**
 * ABLP-976 scenario regressions for Git integration setup.
 *
 * This follows the deterministic-test architecture in
 * docs/architecture/runtime-deterministic-test-architecture.md:
 * a compact typed scenario corpus drives the production route seam. The
 * scenarios intentionally encode the target lifecycle contract, so they fail
 * while the audited Git setup gaps remain present.
 */

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
const mockGetConfig = vi.fn(() => ({
  jwt: { secret: 'test-jwt-secret' },
  server: { frontendUrl: 'http://localhost:5173' },
}));
const mockIsConfigLoaded = vi.fn(() => true);

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

const mockRequireProjectPermission = vi.fn();
const mockIsProjectPermissionError = vi.fn((result: unknown) => result instanceof NextResponse);

vi.mock('@/lib/project-permission', () => ({
  requireProjectPermission: (...args: unknown[]) => mockRequireProjectPermission(...args),
  isProjectPermissionError: (...args: unknown[]) => mockIsProjectPermissionError(...args),
}));

vi.mock('@/config', () => ({
  getConfig: () => mockGetConfig(),
  isConfigLoaded: () => mockIsConfigLoaded(),
}));

const mockReleaseGitOperationLock = vi.fn().mockResolvedValue(undefined);
const mockAcquireGitOperationLock = vi.fn().mockResolvedValue({
  acquired: true,
  release: mockReleaseGitOperationLock,
});

vi.mock('@/lib/git-operation-lock', () => ({
  acquireGitOperationLock: (...args: unknown[]) => mockAcquireGitOperationLock(...args),
  gitOperationLockedResponse: () =>
    NextResponse.json(
      {
        error: 'Another git operation is already in progress for this project',
        code: 'GIT_OPERATION_IN_PROGRESS',
      },
      { status: 423 },
    ),
}));

const mockResolveGitCredentials = vi.fn();

vi.mock('@/lib/git-credentials', () => ({
  resolveGitCredentials: (...args: unknown[]) => mockResolveGitCredentials(...args),
}));

const mockValidateConnection = vi.fn();
const mockRegisterWebhook = vi.fn();
const mockRemoveWebhook = vi.fn();
const mockCreateGitProvider = vi.fn(() => ({
  validateConnection: (...args: unknown[]) => mockValidateConnection(...args),
  registerWebhook: (...args: unknown[]) => mockRegisterWebhook(...args),
  removeWebhook: (...args: unknown[]) => mockRemoveWebhook(...args),
}));

vi.mock('@agent-platform/project-io/git', () => ({
  createGitProvider: (...args: unknown[]) => mockCreateGitProvider(...args),
}));

const mockGitIntegrationCreate = vi.fn();
const mockGitIntegrationFindOne = vi.fn();
const mockGitIntegrationFindOneAndUpdate = vi.fn();
const mockGitIntegrationDeleteOne = vi.fn();
const mockGitWebhookCleanupJobCreate = vi.fn();
const mockProjectFindOneAndUpdate = vi.fn();
const mockAuthProfileFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  GitIntegration: {
    create: (...args: unknown[]) => mockGitIntegrationCreate(...args),
    findOne: (...args: unknown[]) => mockGitIntegrationFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockGitIntegrationFindOneAndUpdate(...args),
    deleteOne: (...args: unknown[]) => mockGitIntegrationDeleteOne(...args),
  },
  GitWebhookCleanupJob: {
    create: (...args: unknown[]) => mockGitWebhookCleanupJobCreate(...args),
  },
  Project: {
    findOneAndUpdate: (...args: unknown[]) => mockProjectFindOneAndUpdate(...args),
  },
  AuthProfile: {
    findOne: (...args: unknown[]) => mockAuthProfileFindOne(...args),
  },
}));

const mockLogAuditEvent = vi.fn();

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  AuditActions: {
    GIT_INTEGRATION_CREATED: 'git_integration_created',
    GIT_INTEGRATION_UPDATED: 'git_integration_updated',
    GIT_INTEGRATION_DELETED: 'git_integration_deleted',
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

const testUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  permissions: ['project:git'],
};

const testProject = {
  id: 'project-1',
  _id: 'project-1',
  name: 'Test Project',
  slug: 'test-project',
  ownerId: 'owner-1',
  tenantId: 'tenant-1',
};

type ConnectBody = {
  provider: 'github' | 'gitlab' | 'bitbucket';
  repositoryUrl: string;
  defaultBranch?: string;
  syncPath?: string;
  credentials?: { type: string; secretId: string };
  authProfileId?: string | null;
  syncConfig?: { autoSync?: boolean; conflictStrategy?: string };
};

interface SetupScenario {
  name: string;
  body: ConnectBody;
  expectedCreate: {
    repositoryUrl?: string;
    authProfileId?: string | null;
    syncConfig?: { conflictStrategy: string };
  };
}

function makeRequest(body: ConnectBody): NextRequest {
  const { credentials: _credentials, ...rest } = body;
  const payload = {
    authProfileId: rest.authProfileId ?? 'auth-profile-1',
    ...rest,
  };
  return new NextRequest('http://localhost/api/projects/project-1/git', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
    },
    body: JSON.stringify(payload),
  });
}

function makeRawRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/projects/project-1/git', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
    },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(): NextRequest {
  return new NextRequest('http://localhost/api/projects/project-1/git', {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  });
}

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/projects/project-1/git', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
    },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(): NextRequest {
  return new NextRequest('http://localhost/api/projects/project-1/git', {
    method: 'DELETE',
    headers: { authorization: 'Bearer test-token' },
  });
}

function gitCreatePayload() {
  expect(mockGitIntegrationCreate).toHaveBeenCalledTimes(1);
  return mockGitIntegrationCreate.mock.calls[0]?.[0] as Record<string, unknown>;
}

const setupScenarios: SetupScenario[] = [
  {
    name: 'persists selected GitHub auth profiles as authProfileId',
    body: {
      provider: 'github',
      repositoryUrl: 'https://github.com/acme/support-agents',
      authProfileId: 'auth-profile-1',
      syncConfig: { conflictStrategy: 'manual' },
    },
    expectedCreate: {
      authProfileId: 'auth-profile-1',
      syncConfig: { conflictStrategy: 'manual' },
    },
  },
  {
    name: 'persists selected GitLab auth profiles as authProfileId',
    body: {
      provider: 'gitlab',
      repositoryUrl: 'https://gitlab.com/acme/support-agents',
      authProfileId: 'auth-profile-1',
      syncConfig: { conflictStrategy: 'manual' },
    },
    expectedCreate: {
      authProfileId: 'auth-profile-1',
      syncConfig: { conflictStrategy: 'manual' },
    },
  },
  {
    name: 'persists selected Bitbucket auth profiles as authProfileId',
    body: {
      provider: 'bitbucket',
      repositoryUrl: 'https://bitbucket.org/koreteam1/cigna',
      defaultBranch: 'develop',
      authProfileId: 'auth-profile-1',
      syncConfig: { conflictStrategy: 'manual' },
    },
    expectedCreate: {
      authProfileId: 'auth-profile-1',
      syncConfig: { conflictStrategy: 'manual' },
    },
  },
  {
    name: 'normalizes copied Bitbucket browser URLs to the repository root',
    body: {
      provider: 'bitbucket',
      repositoryUrl: 'https://bitbucket.org/koreteam1/cigna/src/main/',
      defaultBranch: 'develop',
      authProfileId: 'auth-profile-1',
      syncConfig: { conflictStrategy: 'manual' },
    },
    expectedCreate: {
      repositoryUrl: 'https://bitbucket.org/koreteam1/cigna',
      authProfileId: 'auth-profile-1',
      syncConfig: { conflictStrategy: 'manual' },
    },
  },
  {
    name: 'maps local-wins conflict strategy from UI vocabulary to project-io vocabulary',
    body: {
      provider: 'gitlab',
      repositoryUrl: 'https://gitlab.com/acme/support-agents',
      authProfileId: 'auth-profile-1',
      syncConfig: { conflictStrategy: 'ours' },
    },
    expectedCreate: {
      authProfileId: 'auth-profile-1',
      syncConfig: { conflictStrategy: 'local_wins' },
    },
  },
  {
    name: 'maps remote-wins conflict strategy from UI vocabulary to project-io vocabulary',
    body: {
      provider: 'github',
      repositoryUrl: 'https://github.com/acme/support-agents',
      authProfileId: 'auth-profile-1',
      syncConfig: { conflictStrategy: 'theirs' },
    },
    expectedCreate: {
      authProfileId: 'auth-profile-1',
      syncConfig: { conflictStrategy: 'remote_wins' },
    },
  },
];

describe('ABLP-976 Git setup scenario corpus', () => {
  let POST: (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
  let GET: (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
  let PATCH: (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
  let DELETE: (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    mockRequireAuth.mockResolvedValue({ ...testUser });
    mockGetConfig.mockReturnValue({
      jwt: { secret: 'test-jwt-secret' },
      server: { frontendUrl: 'http://localhost:5173' },
    });
    mockIsConfigLoaded.mockReturnValue(true);
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({ project: testProject });
    mockIsAccessError.mockReturnValue(false);
    mockIsProjectPermissionError.mockImplementation(
      (result: unknown) => result instanceof NextResponse,
    );
    mockRequireProjectPermission.mockImplementation(async (_projectId, user, permission) => {
      const permissions = (user as { permissions?: string[] }).permissions ?? [];
      if (!permissions.includes(permission) && !permissions.includes('project:*')) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      return {
        project: testProject,
        accessLevel: 'tenant_rbac',
        actorPermissions: permissions,
        customRolePermissions: [],
      };
    });
    mockReleaseGitOperationLock.mockResolvedValue(undefined);
    mockAcquireGitOperationLock.mockResolvedValue({
      acquired: true,
      release: mockReleaseGitOperationLock,
    });
    mockGitIntegrationCreate.mockImplementation(async (payload) => ({
      _id: 'git-integration-1',
      ...payload,
    }));
    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        credentials: { type: 'token', secretId: 'secret-1', token: 'raw-token' },
        authProfileId: 'auth-profile-1',
        webhookSecret: 'webhook-secret',
        syncConfig: { autoSync: true, autoDeploy: null, conflictStrategy: 'manual' },
      }),
    });
    mockGitIntegrationFindOneAndUpdate.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'develop',
        syncPath: '/agents',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: 'auth-profile-1',
        syncConfig: { autoSync: false, autoDeploy: null, conflictStrategy: 'local_wins' },
      }),
    });
    mockGitIntegrationDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mockProjectFindOneAndUpdate.mockResolvedValue({});
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'auth-profile-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        scope: 'project',
        authType: 'bearer',
        status: 'active',
      }),
    });
    mockResolveGitCredentials.mockResolvedValue({ type: 'token', token: 'resolved-secret' });
    mockValidateConnection.mockResolvedValue({ valid: true });
    mockRegisterWebhook.mockResolvedValue('provider-hook-1');
    mockRemoveWebhook.mockResolvedValue(undefined);
    mockLogAuditEvent.mockResolvedValue(undefined);

    const mod = await import('@/app/api/projects/[id]/git/route');
    POST = mod.POST;
    GET = mod.GET;
    PATCH = mod.PATCH;
    DELETE = mod.DELETE;
  });

  for (const scenario of setupScenarios) {
    it(scenario.name, async () => {
      const response = await POST(makeRequest(scenario.body), {
        params: Promise.resolve({ id: 'project-1' }),
      });

      const expectedCreate = {
        ...scenario.expectedCreate,
        ...(scenario.expectedCreate.syncConfig
          ? { syncConfig: expect.objectContaining(scenario.expectedCreate.syncConfig) }
          : {}),
      };

      expect(response.status).toBe(201);
      expect(gitCreatePayload()).toEqual(expect.objectContaining(expectedCreate));
    });
  }

  it('checks project:git permission before creating an integration', async () => {
    mockRequireAuth.mockResolvedValueOnce({
      ...testUser,
      permissions: ['project:read'],
    });

    const response = await POST(makeRequest(setupScenarios[0].body), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(403);
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
  });

  it('allows project-role Git permission grants without requiring a global project:git permission', async () => {
    mockRequireAuth.mockResolvedValueOnce({
      ...testUser,
      permissions: ['project:read'],
    });
    mockRequireProjectPermission.mockResolvedValueOnce({
      project: testProject,
      accessLevel: 'project_member',
      role: 'custom',
      actorPermissions: ['project:read'],
      customRolePermissions: ['project:git'],
    });

    const response = await POST(makeRequest(setupScenarios[0].body), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(201);
    expect(mockRequireProjectPermission).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ permissions: ['project:read'] }),
      'project:git',
    );
    expect(mockGitIntegrationCreate).toHaveBeenCalled();
  });

  it('validates repository credentials with the provider before persistence', async () => {
    const response = await POST(makeRequest(setupScenarios[0].body), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(201);
    expect(mockResolveGitCredentials).toHaveBeenCalledBefore(mockGitIntegrationCreate);
    expect(mockCreateGitProvider).toHaveBeenCalledBefore(mockGitIntegrationCreate);
    expect(mockValidateConnection).toHaveBeenCalledBefore(mockGitIntegrationCreate);
  });

  it('serializes setup with the shared git operation lock before provider side effects', async () => {
    const response = await POST(makeRequest(setupScenarios[0].body), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(201);
    expect(mockAcquireGitOperationLock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      operation: 'setup',
    });
    expect(mockAcquireGitOperationLock).toHaveBeenCalledBefore(mockValidateConnection);
    expect(mockReleaseGitOperationLock).toHaveBeenCalled();
  });

  it('does not validate or persist setup while another git operation is active', async () => {
    mockAcquireGitOperationLock.mockResolvedValueOnce({
      acquired: false,
      status: 423,
      body: {
        error: 'Another git operation is already in progress for this project',
        code: 'GIT_OPERATION_IN_PROGRESS',
      },
    });

    const response = await POST(makeRequest(setupScenarios[0].body), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(423);
    expect(mockValidateConnection).not.toHaveBeenCalled();
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
    expect(mockReleaseGitOperationLock).not.toHaveBeenCalled();
  });

  it('returns a clear 400 when provider validation rejects the repository credentials', async () => {
    mockValidateConnection.mockResolvedValueOnce({
      valid: false,
      error: 'Bitbucket API returned 401',
    });

    const response = await POST(makeRequest(setupScenarios[0].body), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining('credentials'),
      }),
    );
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
  });

  it('rejects legacy credential payloads with a clear 400 instead of saving a dead integration', async () => {
    const response = await POST(
      makeRawRequest({
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/ssh-repo',
        authProfileId: 'auth-profile-1',
        credentials: { type: 'ssh_key', secretId: 'ssh-secret-1' },
        syncConfig: { conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: 'Git credentials are managed by auth profiles',
      }),
    );
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
  });

  it('rejects unknown conflict strategy values before persistence', async () => {
    const response = await POST(
      makeRequest({
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        credentials: { type: 'pat', secretId: 'secret-pat-invalid-strategy' },
        syncConfig: { conflictStrategy: 'merge-everything' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining('conflict'),
      }),
    );
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
  });

  it('rejects provider and repository host mismatches before persistence', async () => {
    const response = await POST(
      makeRequest({
        provider: 'bitbucket',
        repositoryUrl: 'https://github.com/acme/wrong-provider',
        credentials: { type: 'pat', secretId: 'secret-provider-mismatch' },
        syncConfig: { conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining('provider'),
      }),
    );
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
  });

  it.each([
    [
      'GitHub .git URL',
      'https://github.com/acme/support-agents.git',
      'https://github.com/acme/support-agents',
    ],
    [
      'GitHub tree browser URL',
      'https://github.com/acme/support-agents/tree/main/agents',
      'https://github.com/acme/support-agents',
    ],
    [
      'GitLab .git URL',
      'https://gitlab.com/acme/support-agents.git',
      'https://gitlab.com/acme/support-agents',
    ],
    [
      'GitLab tree browser URL',
      'https://gitlab.com/acme/support-agents/-/tree/main/agents',
      'https://gitlab.com/acme/support-agents',
    ],
    [
      'Bitbucket branch browser URL',
      'https://bitbucket.org/acme/support-agents/branch/main/',
      'https://bitbucket.org/acme/support-agents',
    ],
  ])('normalizes %s to the repository root', async (_name, repositoryUrl, expectedUrl) => {
    const response = await POST(
      makeRequest({
        provider: repositoryUrl.includes('bitbucket')
          ? 'bitbucket'
          : repositoryUrl.includes('gitlab')
            ? 'gitlab'
            : 'github',
        repositoryUrl,
        credentials: { type: 'pat', secretId: 'secret-url-normalization' },
        syncConfig: { conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(201);
    expect(gitCreatePayload()).toEqual(
      expect.objectContaining({
        repositoryUrl: expectedUrl,
      }),
    );
  });

  it.each([
    ['empty sync path', '', '/'],
    ['root sync path', '/', '/'],
    ['bare sync path segment', 'agents', '/agents'],
    ['slash-prefixed sync path segment', '/agents/', '/agents'],
  ])('normalizes %s before persistence', async (_name, syncPath, expectedSyncPath) => {
    const response = await POST(
      makeRequest({
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        syncPath,
        credentials: { type: 'pat', secretId: 'secret-sync-path' },
        syncConfig: { conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(201);
    expect(gitCreatePayload()).toEqual(expect.objectContaining({ syncPath: expectedSyncPath }));
  });

  it('persists disabled auto-deploy as null while preserving auto-sync', async () => {
    const response = await POST(
      makeRequest({
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        credentials: { type: 'pat', secretId: 'secret-auto-sync' },
        syncConfig: { autoSync: true, conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(201);
    expect(mockRegisterWebhook).toHaveBeenCalledWith(
      'http://localhost:5173/api/webhooks/git/project-1',
      expect.stringMatching(/^whsec_/),
    );
    expect(gitCreatePayload()).toEqual(
      expect.objectContaining({
        webhookId: 'provider-hook-1',
        webhookSecret: expect.stringMatching(/^whsec_/),
        syncConfig: expect.objectContaining({
          autoSync: true,
          autoDeploy: null,
        }),
      }),
    );
  });

  it('does not persist auto-sync setup when provider webhook registration fails', async () => {
    mockRegisterWebhook.mockRejectedValueOnce(new Error('webhook permission denied'));

    const response = await POST(
      makeRequest({
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        credentials: { type: 'pat', secretId: 'secret-auto-sync' },
        syncConfig: { autoSync: true, conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(502);
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
    expect(mockProjectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rolls back provider webhook registration when integration persistence races a duplicate', async () => {
    mockGitIntegrationCreate.mockRejectedValueOnce(
      Object.assign(new Error('duplicate'), { code: 11000 }),
    );

    const response = await POST(
      makeRequest({
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        credentials: { type: 'pat', secretId: 'secret-auto-sync' },
        syncConfig: { autoSync: true, conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(409);
    expect(mockRemoveWebhook).toHaveBeenCalledWith('provider-hook-1');
    expect(mockProjectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('registers a missing provider webhook when patch enables auto-sync', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: 'auth-profile-1',
        webhookId: null,
        webhookSecret: null,
        syncConfig: { autoSync: false, autoDeploy: null, conflictStrategy: 'manual' },
      }),
    });

    const response = await PATCH(makePatchRequest({ syncConfig: { autoSync: true } }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockRegisterWebhook).toHaveBeenCalledWith(
      'http://localhost:5173/api/webhooks/git/project-1',
      expect.stringMatching(/^whsec_/),
    );
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-1', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          'syncConfig.autoSync': true,
          webhookId: 'provider-hook-1',
          webhookSecret: expect.stringMatching(/^whsec_/),
        }),
      },
      { new: true },
    );
  });

  it('rejects credential PATCH payloads before provider validation or persistence', async () => {
    const response = await PATCH(
      makePatchRequest({
        credentials: { type: 'token', secretId: 'rotated-secret-1' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: 'Git credentials are managed by auth profiles',
      }),
    );
    expect(mockResolveGitCredentials).not.toHaveBeenCalled();
    expect(mockValidateConnection).not.toHaveBeenCalled();
    expect(mockGitIntegrationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('removes and clears the provider webhook when PATCH disables auto-sync', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: 'auth-profile-1',
        webhookId: 'provider-hook-1',
        webhookSecret: 'webhook-secret',
        syncConfig: { autoSync: true, autoDeploy: null, conflictStrategy: 'manual' },
      }),
    });

    const response = await PATCH(makePatchRequest({ syncConfig: { autoSync: false } }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockRemoveWebhook).toHaveBeenCalledWith('provider-hook-1');
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledBefore(mockRemoveWebhook);
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-1', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          'syncConfig.autoSync': false,
        }),
      },
      { new: true },
    );
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-1', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          webhookId: null,
          webhookSecret: null,
          previousWebhookSecret: null,
          previousWebhookSecretExpiresAt: null,
        }),
      },
      { new: true },
    );
  });

  it('clears stale webhook fields and queues cleanup when provider removal fails', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: 'auth-profile-1',
        webhookId: 'provider-hook-1',
        webhookSecret: 'webhook-secret',
        syncConfig: { autoSync: true, autoDeploy: null, conflictStrategy: 'manual' },
      }),
    });
    mockRemoveWebhook.mockRejectedValueOnce(new Error('provider unavailable'));

    const response = await PATCH(makePatchRequest({ syncConfig: { autoSync: false } }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        warnings: expect.arrayContaining([
          'Git webhook cleanup was queued after provider removal failed',
        ]),
      }),
    );
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-1', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          'syncConfig.autoSync': false,
        }),
      },
      { new: true },
    );
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-1', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          webhookId: null,
          webhookSecret: null,
          previousWebhookSecret: null,
          previousWebhookSecretExpiresAt: null,
        }),
      },
      { new: true },
    );
    expect(mockGitWebhookCleanupJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        provider: 'github',
        webhookId: 'provider-hook-1',
        operation: 'disable_auto_sync',
        status: 'pending',
        lastError: 'provider unavailable',
      }),
    );
  });

  it('uses configured or request URL origin for webhook callback instead of trusting Origin header', async () => {
    const previousFrontendUrl = process.env.FRONTEND_URL;
    delete process.env.FRONTEND_URL;
    mockIsConfigLoaded.mockReturnValueOnce(false);

    const response = await POST(
      new NextRequest('https://studio.example.com/api/projects/project-1/git', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-token',
          origin: 'https://attacker.example.com',
        },
        body: JSON.stringify({
          provider: 'github',
          repositoryUrl: 'https://github.com/acme/support-agents',
          authProfileId: 'auth-profile-1',
          syncConfig: { autoSync: true, conflictStrategy: 'manual' },
        }),
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    if (previousFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = previousFrontendUrl;
    }

    expect(response.status).toBe(201);
    expect(mockRegisterWebhook).toHaveBeenCalledWith(
      'https://studio.example.com/api/webhooks/git/project-1',
      expect.stringMatching(/^whsec_/),
    );
  });

  it('redacts all secret material when reading an existing integration', async () => {
    const response = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual(
      expect.objectContaining({
        integration: expect.objectContaining({
          authProfileId: 'auth-profile-1',
        }),
      }),
    );
    expect(JSON.stringify(payload)).not.toContain('raw-token');
    expect(JSON.stringify(payload)).not.toContain('secret-1');
    expect(mockGitIntegrationFindOne).toHaveBeenCalledWith({
      projectId: 'project-1',
      tenantId: 'tenant-1',
    });
  });

  it('updates authProfileId without accepting credential payloads', async () => {
    const response = await PATCH(makePatchRequest({ authProfileId: 'auth-profile-2' }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-1', tenantId: 'tenant-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          authProfileId: 'auth-profile-2',
        }),
      }),
      { new: true },
    );
  });

  it('rejects mixed authProfileId and credential PATCH payloads', async () => {
    const response = await PATCH(
      makePatchRequest({
        authProfileId: 'auth-profile-2',
        credentials: { type: 'token', secretId: 'ignored-secret' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: 'Git credentials are managed by auth profiles',
      }),
    );
    expect(mockGitIntegrationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('serializes PATCH updates with the shared git operation lock before provider validation', async () => {
    const response = await PATCH(makePatchRequest({ authProfileId: 'auth-profile-1' }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockAcquireGitOperationLock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      operation: 'update',
    });
    expect(mockAcquireGitOperationLock).toHaveBeenCalledBefore(mockValidateConnection);
    expect(mockReleaseGitOperationLock).toHaveBeenCalled();
  });

  it('does not mutate settings while another git operation is active', async () => {
    mockAcquireGitOperationLock.mockResolvedValueOnce({
      acquired: false,
      status: 423,
      body: {
        error: 'Another git operation is already in progress for this project',
        code: 'GIT_OPERATION_IN_PROGRESS',
      },
    });

    const response = await PATCH(makePatchRequest({ syncPath: '/agents' }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(423);
    expect(mockGitIntegrationFindOne).not.toHaveBeenCalled();
    expect(mockGitIntegrationFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockReleaseGitOperationLock).not.toHaveBeenCalled();
  });

  it('rejects switching back to raw secret credentials', async () => {
    const response = await PATCH(
      makePatchRequest({
        authProfileId: null,
        credentials: { type: 'token', secretId: 'raw-secret-2' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: 'authProfileId is required',
      }),
    );
    expect(mockGitIntegrationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', () => GET(makeGetRequest(), { params: Promise.resolve({ id: 'project-1' }) })],
    [
      'PATCH',
      () =>
        PATCH(makePatchRequest({ syncPath: '/agents' }), {
          params: Promise.resolve({ id: 'project-1' }),
        }),
    ],
    ['DELETE', () => DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: 'project-1' }) })],
  ])('checks project:git permission before %s integration access', async (_method, execute) => {
    mockRequireAuth.mockResolvedValueOnce({
      ...testUser,
      permissions: ['project:read'],
    });

    const response = await execute();

    expect(response.status).toBe(403);
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
    expect(mockGitIntegrationFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockGitIntegrationDeleteOne).not.toHaveBeenCalled();
  });

  it('disconnect clears the project pointer and deletes only within the project tenant scope', async () => {
    const response = await DELETE(makeDeleteRequest(), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockGitIntegrationFindOne).toHaveBeenCalledWith({
      projectId: 'project-1',
      tenantId: 'tenant-1',
    });
    expect(mockGitIntegrationDeleteOne).toHaveBeenCalledWith({
      projectId: 'project-1',
      tenantId: 'tenant-1',
    });
    expect(mockProjectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'project-1', tenantId: 'tenant-1' },
      { gitIntegrationId: null },
    );
  });

  it('disconnect deletes local state before provider webhook cleanup', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: 'auth-profile-1',
        webhookId: 'provider-hook-1',
        webhookSecret: 'webhook-secret',
      }),
    });

    const response = await DELETE(makeDeleteRequest(), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockResolveGitCredentials).toHaveBeenCalledWith('auth-profile-1', 'tenant-1', {
      projectId: 'project-1',
      userId: 'user-1',
    });
    expect(mockRemoveWebhook).toHaveBeenCalledWith('provider-hook-1');
    expect(mockGitIntegrationDeleteOne).toHaveBeenCalledBefore(mockRemoveWebhook);
  });

  it('keeps disconnect durable when provider webhook removal fails', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: 'auth-profile-1',
        webhookId: 'provider-hook-1',
        webhookSecret: 'webhook-secret',
      }),
    });
    mockRemoveWebhook.mockRejectedValueOnce(new Error('provider unavailable'));

    const response = await DELETE(makeDeleteRequest(), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        warnings: expect.arrayContaining([
          'Git integration disconnected, and webhook cleanup was queued for retry',
        ]),
      }),
    );
    expect(mockGitIntegrationDeleteOne).toHaveBeenCalledWith({
      projectId: 'project-1',
      tenantId: 'tenant-1',
    });
    expect(mockProjectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'project-1', tenantId: 'tenant-1' },
      { gitIntegrationId: null },
    );
    expect(mockGitWebhookCleanupJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        provider: 'github',
        webhookId: 'provider-hook-1',
        operation: 'disconnect',
        status: 'pending',
        lastError: 'provider unavailable',
      }),
    );
  });

  it('returns conflict without mutating the project pointer when setup races an existing integration', async () => {
    mockGitIntegrationCreate.mockRejectedValueOnce(
      Object.assign(new Error('duplicate'), { code: 11000 }),
    );

    const response = await POST(makeRequest(setupScenarios[0].body), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining('already exists'),
      }),
    );
    expect(mockProjectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('cleans up the created integration when project pointer persistence fails', async () => {
    mockProjectFindOneAndUpdate.mockRejectedValueOnce(new Error('project pointer write failed'));

    const response = await POST(makeRequest(setupScenarios[0].body), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(500);
    expect(mockGitIntegrationCreate).toHaveBeenCalledTimes(1);
    expect(mockGitIntegrationDeleteOne).toHaveBeenCalledWith({
      _id: 'git-integration-1',
      projectId: 'project-1',
      tenantId: 'tenant-1',
    });
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it('does not update the project pointer when integration creation fails before persistence', async () => {
    mockGitIntegrationCreate.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await POST(makeRequest(setupScenarios[0].body), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(500);
    expect(mockProjectFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it('keeps setup successful when audit logging fails after durable state is written', async () => {
    mockLogAuditEvent.mockRejectedValueOnce(new Error('audit sink unavailable'));

    const response = await POST(makeRequest(setupScenarios[0].body), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(201);
    expect(mockGitIntegrationCreate).toHaveBeenCalledTimes(1);
    expect(mockProjectFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('keeps PATCH successful when audit logging fails after durable state is written', async () => {
    mockLogAuditEvent.mockRejectedValueOnce(new Error('audit sink unavailable'));

    const response = await PATCH(makePatchRequest({ syncPath: '/agents' }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('keeps disconnect successful when audit logging fails after durable state is cleared', async () => {
    mockLogAuditEvent.mockRejectedValueOnce(new Error('audit sink unavailable'));

    const response = await DELETE(makeDeleteRequest(), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockGitIntegrationDeleteOne).toHaveBeenCalledWith({
      projectId: 'project-1',
      tenantId: 'tenant-1',
    });
    expect(mockProjectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'project-1', tenantId: 'tenant-1' },
      { gitIntegrationId: null },
    );
  });

  it('omits credentials, secret ids, and webhook secrets from setup audit metadata', async () => {
    const response = await POST(makeRequest(setupScenarios[0].body), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(201);
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    const serializedAudit = JSON.stringify(mockLogAuditEvent.mock.calls[0]);
    expect(serializedAudit).not.toContain('secret-github-pat');
    expect(serializedAudit).not.toContain('credentials');
    expect(serializedAudit).not.toContain('webhook-secret');
  });

  it('merges partial syncConfig PATCH updates without dropping existing nested settings', async () => {
    const response = await PATCH(makePatchRequest({ syncConfig: { autoSync: false } }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-1', tenantId: 'tenant-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          'syncConfig.autoSync': false,
        }),
      }),
      { new: true },
    );
    expect(mockGitIntegrationFindOneAndUpdate).not.toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          syncConfig: { autoSync: false },
        }),
      }),
      expect.any(Object),
    );
  });

  it.each([
    ['parent traversal', '../agents'],
    ['nested traversal', 'agents/../../secrets'],
    ['current directory segment', './agents'],
    ['encoded traversal', 'agents/%2e%2e/secrets'],
    ['malformed percent encoding', 'agents/%zz/secrets'],
    ['duplicate slash segment', 'agents//prod'],
  ])('rejects unsafe setup syncPath values: %s', async (_name, syncPath) => {
    const response = await POST(
      makeRequest({
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        syncPath,
        credentials: { type: 'pat', secretId: 'secret-unsafe-sync-path' },
        syncConfig: { conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining('syncPath'),
      }),
    );
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['parent traversal', '../agents'],
    ['encoded traversal', 'agents/%2e%2e/secrets'],
    ['malformed percent encoding', 'agents/%zz/secrets'],
  ])('rejects unsafe PATCH syncPath values: %s', async (_name, syncPath) => {
    const response = await PATCH(makePatchRequest({ syncPath }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(400);
    expect(mockGitIntegrationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects repository URLs that embed credentials in userinfo', async () => {
    const response = await POST(
      makeRequest({
        provider: 'github',
        repositoryUrl: 'https://token-secret@github.com/acme/support-agents',
        credentials: { type: 'pat', secretId: 'secret-url-userinfo' },
        syncConfig: { conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain('token-secret');
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
  });

  it('rejects repository URLs that downgrade provider access to HTTP', async () => {
    const response = await POST(
      makeRequest({
        provider: 'github',
        repositoryUrl: 'http://github.com/acme/support-agents',
        credentials: { type: 'pat', secretId: 'secret-http-url' },
        syncConfig: { conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['setup traversal branch', '../main'],
    ['setup leading slash branch', '/main'],
    ['setup trailing slash branch', 'feature/'],
    ['setup spaced branch', 'feature branch'],
  ])('rejects unsafe defaultBranch values: %s', async (_name, defaultBranch) => {
    const response = await POST(
      makeRequest({
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch,
        credentials: { type: 'pat', secretId: 'secret-branch' },
        syncConfig: { conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
  });

  it('rejects unsafe PATCH defaultBranch values before persistence', async () => {
    const response = await PATCH(makePatchRequest({ defaultBranch: '../main' }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(400);
    expect(mockGitIntegrationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['decimal localhost', 'https://2130706433/acme/support-agents'],
    ['ipv6 mapped localhost', 'https://[::ffff:127.0.0.1]/acme/support-agents'],
    ['encoded host label', 'https://%31%32%37.0.0.1/acme/support-agents'],
    ['nip loopback host', 'https://127.0.0.1.nip.io/acme/support-agents'],
  ])('rejects SSRF repository URL variants: %s', async (_name, repositoryUrl) => {
    const response = await POST(
      makeRequest({
        provider: 'github',
        repositoryUrl,
        credentials: { type: 'pat', secretId: 'secret-ssrf-url' },
        syncConfig: { conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
  });

  it('rejects project-scoped auth profiles from a different project during setup', async () => {
    mockAuthProfileFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue(null),
    });

    const response = await POST(
      makeRequest({
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        credentials: { type: 'pat', secretId: 'auth-profile-other-project' },
        authProfileId: 'auth-profile-other-project',
        syncConfig: { conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockAuthProfileFindOne).toHaveBeenCalledWith({
      _id: 'auth-profile-other-project',
      tenantId: 'tenant-1',
      status: 'active',
      $or: [{ projectId: 'project-1' }, { projectId: null, scope: 'tenant' }],
    });
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
  });

  it('rejects personal auth profiles for project-level git setup even when they match the project', async () => {
    mockAuthProfileFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'personal-profile-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        scope: 'personal',
        createdBy: 'user-1',
        authType: 'bearer',
        status: 'active',
      }),
    });

    const response = await POST(
      makeRequest({
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        credentials: { type: 'pat', secretId: 'personal-profile-1' },
        authProfileId: 'personal-profile-1',
        syncConfig: { conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockAuthProfileFindOne).toHaveBeenCalledWith({
      _id: 'personal-profile-1',
      tenantId: 'tenant-1',
      status: 'active',
      $or: [{ projectId: 'project-1' }, { projectId: null, scope: 'tenant' }],
    });
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining('Personal auth profiles'),
      }),
    );
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
  });

  it.each(['none', 'basic', 'oauth2_app', 'ssh_key'])(
    'rejects non-token auth profile type %s during setup',
    async (authType) => {
      mockAuthProfileFindOne.mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue({
          _id: 'auth-profile-wrong-type',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          scope: 'project',
          authType,
          status: 'active',
        }),
      });

      const response = await POST(
        makeRequest({
          provider: 'github',
          repositoryUrl: 'https://github.com/acme/support-agents',
          credentials: { type: 'pat', secretId: 'auth-profile-wrong-type' },
          authProfileId: 'auth-profile-wrong-type',
          syncConfig: { conflictStrategy: 'manual' },
        }),
        {
          params: Promise.resolve({ id: 'project-1' }),
        },
      );

      expect(response.status).toBe(400);
      expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
    },
  );

  it('rejects generic git provider until setup and webhook lifecycle explicitly support it', async () => {
    const response = await POST(
      makeRequest({
        provider: 'generic' as 'github',
        repositoryUrl: 'https://git.example.com/acme/support-agents.git',
        credentials: { type: 'pat', secretId: 'secret-generic' },
        syncConfig: { conflictStrategy: 'manual' },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockGitIntegrationCreate).not.toHaveBeenCalled();
  });

  it('does not leak raw provider validation details or credential ids in setup errors', async () => {
    mockValidateConnection.mockResolvedValueOnce({
      valid: false,
      error: 'GitHub token secret-github-pat for tenant-1 was rejected with 401',
    });

    const response = await POST(makeRequest(setupScenarios[0].body), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain('secret-github-pat');
    expect(JSON.stringify(payload)).not.toContain('tenant-1');
    expect(JSON.stringify(payload)).not.toContain('401');
  });

  it('does not expose legacy persisted credential fields on read', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-legacy',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents.git',
        defaultBranch: 'main',
        syncPath: 'agents',
        credentials: { type: 'pat', secretId: 'legacy-secret-1' },
        authProfileId: null,
        syncConfig: { autoSync: true, conflictStrategy: 'ours' },
      }),
    });

    const response = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual(
      expect.objectContaining({
        integration: expect.objectContaining({
          repositoryUrl: 'https://github.com/acme/support-agents',
          syncPath: '/agents',
          authProfileId: null,
          syncConfig: expect.objectContaining({ conflictStrategy: 'local_wins' }),
        }),
      }),
    );
    expect(JSON.stringify(payload)).not.toContain('legacy-secret-1');
  });

  it('preserves webhook secret redaction when returning existing integrations', async () => {
    const response = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain('webhook-secret');
  });

  it('returns API-client-compatible normalized fields when reading existing integrations', async () => {
    const response = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        integration: expect.objectContaining({
          id: 'git-integration-1',
          authProfileId: 'auth-profile-1',
          syncConfig: expect.objectContaining({
            autoDeploy: null,
            conflictStrategy: 'manual',
          }),
        }),
      }),
    );
  });

  it('serializes stored auto-deploy config objects without boolean coercion', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: 'auth-profile-1',
        webhookSecret: 'webhook-secret',
        syncConfig: {
          autoSync: true,
          autoDeploy: { enabled: true, environment: 'staging', branch: 'main' },
          conflictStrategy: 'manual',
        },
      }),
    });

    const response = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        integration: expect.objectContaining({
          syncConfig: expect.objectContaining({
            autoDeploy: { enabled: true, environment: 'staging', branch: 'main' },
          }),
        }),
      }),
    );
  });
});
