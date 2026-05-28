/**
 * Tests for Git Integration CRUD API Routes
 *
 * Covers:
 *   GET    /api/projects/:id/git — Get current git integration
 *   POST   /api/projects/:id/git — Create git integration
 *   PATCH  /api/projects/:id/git — Update settings
 *   DELETE /api/projects/:id/git — Disconnect
 *   Auth checks, tenant isolation, duplicate handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);
const mockLogAuditEvent = vi.fn();
const mockRequireProjectPermission = vi.fn();
const mockIsProjectPermissionError = vi.fn((result: unknown) => result instanceof NextResponse);

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

vi.mock('@/lib/project-permission', () => ({
  requireProjectPermission: (...args: unknown[]) => mockRequireProjectPermission(...args),
  isProjectPermissionError: (...args: unknown[]) => mockIsProjectPermissionError(...args),
}));

vi.mock('@/config', () => ({
  getConfig: vi.fn(() => ({
    jwt: { secret: 'test-jwt-secret' },
    server: { frontendUrl: 'http://localhost:5173' },
  })),
  isConfigLoaded: vi.fn(() => true),
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  AuditActions: {
    GIT_INTEGRATION_CREATED: 'git_integration_created',
    GIT_INTEGRATION_UPDATED: 'git_integration_updated',
    GIT_INTEGRATION_DELETED: 'git_integration_deleted',
  },
}));

// Database models
const mockGitIntegrationFindOne = vi.fn();
const mockGitIntegrationCreate = vi.fn();
const mockGitIntegrationFindOneAndUpdate = vi.fn();
const mockGitIntegrationDeleteOne = vi.fn();
const mockProjectFindOneAndUpdate = vi.fn();
const mockGitWebhookCleanupJobCreate = vi.fn();
const mockAuthProfileFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  GitIntegration: {
    findOne: mockGitIntegrationFindOne,
    create: mockGitIntegrationCreate,
    findOneAndUpdate: mockGitIntegrationFindOneAndUpdate,
    deleteOne: mockGitIntegrationDeleteOne,
  },
  Project: {
    findOneAndUpdate: mockProjectFindOneAndUpdate,
  },
  AuthProfile: {
    findOne: (...args: unknown[]) => mockAuthProfileFindOne(...args),
  },
  GitWebhookCleanupJob: {
    create: (...args: unknown[]) => mockGitWebhookCleanupJobCreate(...args),
  },
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

const mockResolveGitCredentials = vi.fn().mockResolvedValue({
  type: 'token',
  token: 'resolved-token',
});

vi.mock('@/lib/git-credentials', () => ({
  resolveGitCredentials: (...args: unknown[]) => mockResolveGitCredentials(...args),
}));

const mockValidateConnection = vi.fn().mockResolvedValue({ valid: true });
const mockRemoveWebhook = vi.fn().mockResolvedValue(undefined);
const mockRegisterWebhook = vi.fn().mockResolvedValue('provider-hook-1');
const mockCreateGitProvider = vi.fn(() => ({
  validateConnection: (...args: unknown[]) => mockValidateConnection(...args),
  removeWebhook: (...args: unknown[]) => mockRemoveWebhook(...args),
  registerWebhook: (...args: unknown[]) => mockRegisterWebhook(...args),
}));

vi.mock('@agent-platform/project-io/git', () => ({
  createGitProvider: (...args: unknown[]) => mockCreateGitProvider(...args),
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testUser = {
  id: 'user-1',
  email: 'test@test.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  permissions: ['project:git'],
};

const testProject = {
  id: 'proj-1',
  _id: 'proj-1',
  name: 'Test Project',
  slug: 'test-project',
  ownerId: 'user-1',
  tenantId: 'tenant-1',
};

const testIntegration = {
  _id: 'git-int-1',
  projectId: 'proj-1',
  tenantId: 'tenant-1',
  provider: 'github',
  repositoryUrl: 'https://github.com/org/repo',
  defaultBranch: 'main',
  syncPath: '/',
  authProfileId: 'auth-profile-1',
  syncConfig: { autoSync: false, conflictStrategy: 'manual' },
};

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  const opts: any = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  return new NextRequest(new URL(url, 'http://localhost:3000'), opts);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockResolvedValue({ project: testProject });
  mockIsAccessError.mockReturnValue(false);
  mockRequireProjectPermission.mockResolvedValue({ project: testProject });
  mockIsProjectPermissionError.mockImplementation(
    (result: unknown) => result instanceof NextResponse,
  );
  mockLogAuditEvent.mockResolvedValue(undefined);
  mockAcquireGitOperationLock.mockResolvedValue({
    acquired: true,
    release: mockReleaseGitOperationLock,
  });
  mockReleaseGitOperationLock.mockResolvedValue(undefined);
  mockResolveGitCredentials.mockResolvedValue({
    type: 'token',
    token: 'resolved-token',
  });
  mockValidateConnection.mockResolvedValue({ valid: true });
  mockRegisterWebhook.mockResolvedValue('provider-hook-1');
  mockRemoveWebhook.mockResolvedValue(undefined);
  mockAuthProfileFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue({
      _id: 'auth-profile-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      scope: 'project',
      status: 'active',
      authType: 'bearer',
    }),
  });
  mockGitIntegrationFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(testIntegration),
  });
});

// ===========================================================================
// GET /api/projects/:id/git
// ===========================================================================

describe('GET /api/projects/:id/git', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/git/route');
    handler = mod.GET;
  });

  it('returns current git integration', async () => {
    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(testIntegration),
    });

    const req = new NextRequest(new URL('/api/projects/proj-1/git', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.integration).toBeDefined();
    expect(body.integration.provider).toBe('github');
    expect(body.integration.repositoryUrl).toBe('https://github.com/org/repo');
    expect(body.integration).not.toHaveProperty('credentials');
  });

  it('returns null integration when none exists', async () => {
    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = new NextRequest(new URL('/api/projects/proj-1/git', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.integration).toBeNull();
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/projects/proj-1/git', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when project access denied', async () => {
    const accessResponse = NextResponse.json({ error: 'Not found' }, { status: 404 });
    mockRequireProjectPermission.mockResolvedValue(accessResponse);
    mockIsProjectPermissionError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/projects/proj-1/git', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 500 on database error', async () => {
    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockRejectedValue(new Error('DB error')),
    });

    const req = new NextRequest(new URL('/api/projects/proj-1/git', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/projects/:id/git
// ===========================================================================

describe('POST /api/projects/:id/git', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/git/route');
    handler = mod.POST;
  });

  it('creates integration with provider/repositoryUrl/authProfileId', async () => {
    mockGitIntegrationCreate.mockResolvedValue({
      _id: 'git-int-new',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      provider: 'github',
      repositoryUrl: 'https://github.com/org/repo',
      defaultBranch: 'main',
      syncPath: '/',
      authProfileId: 'auth-profile-1',
    });
    mockProjectFindOneAndUpdate.mockResolvedValue({});

    const req = makeRequest('/api/projects/proj-1/git', 'POST', {
      provider: 'github',
      repositoryUrl: 'https://github.com/org/repo',
      authProfileId: 'auth-profile-1',
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.integration).toBeDefined();
    expect(body.integration.provider).toBe('github');

    // Verify GitIntegration.create was called with tenant-scoped data
    expect(mockGitIntegrationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', tenantId: 'tenant-1' }),
    );

    // Verify Project.findOneAndUpdate was called with tenant-scoped filter
    expect(mockProjectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'proj-1', tenantId: 'tenant-1' },
      expect.objectContaining({ gitIntegrationId: 'git-int-new' }),
    );
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-1',
        action: 'git_integration_created',
        metadata: expect.objectContaining({
          projectId: 'proj-1',
          resourceType: 'git_integration',
          resourceId: 'git-int-new',
        }),
      }),
    );
  });

  it('serializes created Mongoose documents without leaking document internals', async () => {
    mockGitIntegrationCreate.mockResolvedValue({
      $__: { activePaths: {} },
      _doc: { provider: 'github' },
      toObject: () => ({
        _id: 'git-int-new',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/org/repo',
        defaultBranch: 'main',
        syncPath: '/',
        authProfileId: 'auth-profile-1',
        webhookSecret: 'whsec_secret',
        credentials: { token: 'secret-token' },
        syncConfig: { autoSync: false, conflictStrategy: 'manual' },
      }),
    });
    mockProjectFindOneAndUpdate.mockResolvedValue({});

    const req = makeRequest('/api/projects/proj-1/git', 'POST', {
      provider: 'github',
      repositoryUrl: 'https://github.com/org/repo',
      authProfileId: 'auth-profile-1',
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.integration).toEqual(
      expect.objectContaining({
        id: 'git-int-new',
        provider: 'github',
        repositoryUrl: 'https://github.com/org/repo',
        authProfileId: 'auth-profile-1',
      }),
    );
    expect(body.integration).not.toHaveProperty('$__');
    expect(body.integration).not.toHaveProperty('_doc');
    expect(body.integration).not.toHaveProperty('webhookSecret');
    expect(body.integration).not.toHaveProperty('credentials');
  });

  it('returns 409 for duplicate integration', async () => {
    const duplicateError = new Error('Duplicate key') as Error & { code: number };
    duplicateError.code = 11000;
    mockGitIntegrationCreate.mockRejectedValue(duplicateError);

    const req = makeRequest('/api/projects/proj-1/git', 'POST', {
      provider: 'github',
      repositoryUrl: 'https://github.com/org/repo',
      authProfileId: 'auth-profile-1',
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toContain('already exists');
  });

  it('returns 400 when required fields are missing', async () => {
    const req = makeRequest('/api/projects/proj-1/git', 'POST', {
      provider: 'github',
      // missing repositoryUrl and authProfileId
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('required');
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = new NextRequest(new URL('/api/projects/proj-1/git', 'http://localhost:3000'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
      body: 'not-json{{{',
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest('/api/projects/proj-1/git', 'POST', {
      provider: 'github',
      repositoryUrl: 'https://github.com/org/repo',
      authProfileId: 'auth-profile-1',
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when project access denied', async () => {
    const accessResponse = NextResponse.json({ error: 'Not found' }, { status: 404 });
    mockRequireProjectPermission.mockResolvedValue(accessResponse);
    mockIsProjectPermissionError.mockReturnValue(true);

    const req = makeRequest('/api/projects/proj-1/git', 'POST', {
      provider: 'github',
      repositoryUrl: 'https://github.com/org/repo',
      authProfileId: 'auth-profile-1',
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected database error', async () => {
    mockGitIntegrationCreate.mockRejectedValue(new Error('Connection lost'));

    const req = makeRequest('/api/projects/proj-1/git', 'POST', {
      provider: 'github',
      repositoryUrl: 'https://github.com/org/repo',
      authProfileId: 'auth-profile-1',
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(500);
  });

  it('returns 400 for repository URL with private IP', async () => {
    const privateUrls = [
      'https://localhost/org/repo',
      'https://127.0.0.1/org/repo',
      'https://10.0.0.1/org/repo',
      'https://192.168.1.1/org/repo',
      'https://myhost.local/org/repo',
      'https://myhost.internal/org/repo',
    ];

    for (const url of privateUrls) {
      const req = makeRequest('/api/projects/proj-1/git', 'POST', {
        provider: 'github',
        repositoryUrl: url,
        authProfileId: 'auth-profile-1',
      });
      const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('internal addresses are not allowed');
    }
  });

  it('returns 400 for repository URL with non-HTTP scheme', async () => {
    const req = makeRequest('/api/projects/proj-1/git', 'POST', {
      provider: 'github',
      repositoryUrl: 'ftp://github.com/org/repo',
      authProfileId: 'auth-profile-1',
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('only HTTPS schemes are allowed');
  });
});

// ===========================================================================
// PATCH /api/projects/:id/git
// ===========================================================================

describe('PATCH /api/projects/:id/git', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/git/route');
    handler = mod.PATCH;
  });

  it('updates allowed fields', async () => {
    mockGitIntegrationFindOneAndUpdate.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        ...testIntegration,
        defaultBranch: 'develop',
        syncPath: '/agents',
      }),
    });

    const req = makeRequest('/api/projects/proj-1/git', 'PATCH', {
      defaultBranch: 'develop',
      syncPath: '/agents',
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.integration.defaultBranch).toBe('develop');
    expect(body.integration.syncPath).toBe('/agents');

    // Verify findOneAndUpdate was called with correct tenant-scoped filter and $set
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'proj-1', tenantId: 'tenant-1' },
      { $set: expect.objectContaining({ defaultBranch: 'develop', syncPath: '/agents' }) },
      { new: true },
    );
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-1',
        action: 'git_integration_updated',
        metadata: expect.objectContaining({
          projectId: 'proj-1',
          resourceType: 'git_integration',
          resourceId: 'git-int-1',
          updatedFields: expect.arrayContaining(['defaultBranch', 'syncPath']),
        }),
      }),
    );
  });

  it('returns 404 when no integration exists', async () => {
    mockGitIntegrationFindOneAndUpdate.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest('/api/projects/proj-1/git', 'PATCH', {
      defaultBranch: 'develop',
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toContain('No git integration');
  });

  it('returns 400 when no valid fields to update', async () => {
    const req = makeRequest('/api/projects/proj-1/git', 'PATCH', {
      provider: 'gitlab', // not an allowed patch field
      repositoryUrl: 'https://gitlab.com/org/repo', // not an allowed patch field
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('No valid fields');
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = new NextRequest(new URL('/api/projects/proj-1/git', 'http://localhost:3000'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
      body: '{bad json',
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest('/api/projects/proj-1/git', 'PATCH', { defaultBranch: 'develop' });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 500 on database error', async () => {
    mockGitIntegrationFindOneAndUpdate.mockReturnValue({
      lean: vi.fn().mockRejectedValue(new Error('DB error')),
    });

    const req = makeRequest('/api/projects/proj-1/git', 'PATCH', { defaultBranch: 'develop' });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// DELETE /api/projects/:id/git
// ===========================================================================

describe('DELETE /api/projects/:id/git', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/git/route');
    handler = mod.DELETE;
  });

  it('removes integration and clears project reference', async () => {
    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(testIntegration),
    });
    mockGitIntegrationDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mockProjectFindOneAndUpdate.mockResolvedValue({});

    const req = new NextRequest(new URL('/api/projects/proj-1/git', 'http://localhost:3000'), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-jwt' },
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify deleteOne was scoped to projectId + tenantId
    expect(mockGitIntegrationDeleteOne).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });

    // Verify project reference was cleared
    expect(mockProjectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'proj-1', tenantId: 'tenant-1' },
      { gitIntegrationId: null },
    );
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-1',
        action: 'git_integration_deleted',
        metadata: expect.objectContaining({
          projectId: 'proj-1',
          resourceType: 'git_integration',
          resourceId: 'git-int-1',
          provider: 'github',
        }),
      }),
    );
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/projects/proj-1/git', 'http://localhost:3000'), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-jwt' },
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when project access denied', async () => {
    const accessResponse = NextResponse.json({ error: 'Not found' }, { status: 404 });
    mockRequireProjectPermission.mockResolvedValue(accessResponse);
    mockIsProjectPermissionError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/projects/proj-1/git', 'http://localhost:3000'), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-jwt' },
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 500 on database error', async () => {
    mockGitIntegrationDeleteOne.mockRejectedValue(new Error('DB error'));

    const req = new NextRequest(new URL('/api/projects/proj-1/git', 'http://localhost:3000'), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-jwt' },
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(500);
  });
});
