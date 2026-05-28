/**
 * Tests for SDK / Deployment API Routes
 *
 * Covers:
 *   GET/POST /api/sdk/keys              - List / create SDK API keys
 *   DELETE   /api/sdk/keys/:keyId       - Revoke SDK API key
 *   POST     /api/sdk/preview-token     - Issue preview token
 *   POST /api/sdk/share                 - Generate share token
 *   POST /api/sdk/share/exchange        - Exchange share token for an SDK session
 *   GET      /api/sdk/embed/:projectId  - Get embed code snippet
 *   GET/PUT  /api/sdk/widget/:projectId - Get / update widget config
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();
const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  requireTenantAuth: mockRequireTenantAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

const mockFindPublicApiKeys = vi.fn();
const mockCreatePublicApiKey = vi.fn();
const mockFindPublicApiKeyById = vi.fn();
const mockUpdatePublicApiKey = vi.fn();
const mockFindActiveSdkChannelById = vi.fn();
const mockFindActiveSdkChannelsByProject = vi.fn();
const mockFindWidgetConfig = vi.fn();
const mockUpsertWidgetConfig = vi.fn();

vi.mock('@/repos/sdk-repo', () => ({
  findPublicApiKeys: mockFindPublicApiKeys,
  createPublicApiKey: mockCreatePublicApiKey,
  findPublicApiKeyById: mockFindPublicApiKeyById,
  updatePublicApiKey: mockUpdatePublicApiKey,
  findActiveSdkChannelById: mockFindActiveSdkChannelById,
  findActiveSdkChannelsByProject: mockFindActiveSdkChannelsByProject,
  findWidgetConfig: mockFindWidgetConfig,
  upsertWidgetConfig: mockUpsertWidgetConfig,
}));

const mockFindProjectByIdAndTenant = vi.fn();
vi.mock('@/repos/project-repo', () => ({
  findProjectByIdAndTenant: mockFindProjectByIdAndTenant,
}));

const mockCheckRateLimit = vi.fn();
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

const mockProjectFindOne = vi.fn();
const mockTenantMemberFind = vi.fn();
const mockPublicApiKeyFindOne = vi.fn();
const mockSdkChannelFindOne = vi.fn();
const mockGetConfig = vi.fn(() => ({
  env: 'test',
  jwt: { secret: 'test-jwt-secret' },
  auth: {
    sdk: {
      bootstrapSigningSecret: 'test-jwt-secret',
    },
  },
  server: { frontendUrl: 'http://localhost:5173' },
}));
const mockIsConfigLoaded = vi.fn(() => true);

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  setMasterKey: vi.fn(),
  Project: {
    findOne: mockProjectFindOne,
  },
  TenantMember: {
    find: mockTenantMemberFind,
  },
  PublicApiKey: {
    findOne: mockPublicApiKeyFindOne,
  },
  SDKChannel: {
    findOne: mockSdkChannelFindOne,
  },
}));

vi.mock('@/config', () => ({
  getConfig: mockGetConfig,
  isConfigLoaded: mockIsConfigLoaded,
}));

vi.mock('@agent-platform/openapi/nextjs', () => ({
  withOpenAPI: (_schema: unknown, handler: Function) => handler,
  validateBody: async (request: NextRequest, schema: z.ZodTypeAny) => {
    const body = await request.json().catch(() => undefined);
    const parsed = schema.safeParse(body);
    if (parsed.success) {
      return { success: true, data: parsed.data };
    }

    return {
      success: false,
      response: new Response(
        JSON.stringify({
          success: false,
          errors: parsed.error.issues.map((issue) => ({
            code: 'VALIDATION_ERROR',
            msg:
              issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
          })),
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    };
  },
}));

const mockExchangeSdkBootstrapArtifactWithRuntime = vi.fn();

vi.mock('@/lib/runtime-sdk-session', () => ({
  exchangeSdkBootstrapArtifactWithRuntime: (...args: any[]) =>
    mockExchangeSdkBootstrapArtifactWithRuntime(...args),
}));

const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

const mockRequireSdkProjectAccess = vi.fn();
const mockIsSdkProjectAccessError = vi.fn(() => false);
const mockResolveSdkBootstrapChannel = vi.fn();

vi.mock('@/lib/sdk-project-access', () => ({
  requireSdkProjectAccess: mockRequireSdkProjectAccess,
  isSdkProjectAccessError: mockIsSdkProjectAccessError,
}));

vi.mock('@/lib/sdk-bootstrap-channel', () => ({
  resolveSdkBootstrapChannel: (...args: any[]) => mockResolveSdkBootstrapChannel(...args),
}));

const shareRouteModulePromise = import('@/app/api/sdk/share/route');
const shareExchangeRouteModulePromise = import('@/app/api/sdk/share/exchange/route');
const previewTokenRouteModulePromise = import('@/app/api/sdk/preview-token/route');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testUser = { id: 'user-1', email: 'test@test.com', name: 'Test User', tenantId: 'tenant-1' };
const TEST_JWT_SECRET = 'test-jwt-secret';

function makeRequest(url: string, body?: unknown, method = 'POST'): NextRequest {
  const opts: any = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  return new NextRequest(new URL(url, 'http://localhost:3000'), opts);
}

function readIssuedPermissions(token: string): string[] {
  const payload = jwt.verify(token, TEST_JWT_SECRET) as { permissions?: unknown };
  return Array.isArray(payload.permissions) ? (payload.permissions as string[]) : [];
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RUNTIME_URL;
  delete process.env.RUNTIME_PUBLIC_BASE_URL;
  delete process.env.NEXT_PUBLIC_RUNTIME_URL;
  delete process.env.FRONTEND_URL;
  mockGetConfig.mockReturnValue({
    env: 'test',
    jwt: { secret: 'test-jwt-secret' },
    auth: {
      sdk: {
        bootstrapSigningSecret: 'test-jwt-secret',
      },
    },
    server: { frontendUrl: 'http://localhost:5173' },
  });
  mockIsConfigLoaded.mockReturnValue(true);
  mockRequireAuth.mockResolvedValue(testUser);
  mockRequireTenantAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockResolvedValue({});
  mockIsAccessError.mockReturnValue(false);
  mockRequireSdkProjectAccess.mockResolvedValue({
    project: {
      id: 'proj-1',
      name: 'Test Project',
      slug: 'test-project',
      ownerId: 'user-1',
      tenantId: 'tenant-1',
    },
    accessLevel: 'project_owner',
  });
  mockFindProjectByIdAndTenant.mockResolvedValue({
    id: 'proj-1',
    name: 'Test Project',
    ownerId: 'user-1',
    tenantId: 'tenant-1',
  });
  mockIsSdkProjectAccessError.mockReturnValue(false);
  mockResolveSdkBootstrapChannel.mockResolvedValue({
    success: true,
    channel: {
      id: 'channel-1',
      name: 'default',
      publicApiKeyId: 'key-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      config: {},
      showActivityUpdates: false,
    },
  });
  mockFindActiveSdkChannelsByProject.mockResolvedValue([]);
  mockFindPublicApiKeyById.mockResolvedValue({
    id: 'key-1',
    keyPrefix: 'pk_abc',
    name: 'Main Key',
    isActive: true,
  });
  mockFindActiveSdkChannelById.mockResolvedValue({
    id: 'channel-1',
    name: 'default',
    projectId: 'proj-1',
    tenantId: 'tenant-1',
  });
  mockFindWidgetConfig.mockResolvedValue(null);
  mockCheckRateLimit.mockResolvedValue({ allowed: true });
  mockSdkChannelFindOne.mockReturnValue({
    lean: () => Promise.resolve(null),
  });
  mockTenantMemberFind.mockReturnValue({
    lean: () => Promise.resolve([{ tenantId: 'tenant-1' }]),
  });
  mockProjectFindOne.mockReturnValue({
    lean: () =>
      Promise.resolve({
        _id: 'proj-1',
        name: 'Test Project',
        ownerId: 'user-1',
        tenantId: 'tenant-1',
      }),
  });
  mockExchangeSdkBootstrapArtifactWithRuntime.mockImplementation(async (bootstrapToken: string) => {
    const { verifySdkBootstrapArtifact } = await import('@agent-platform/shared');
    const payload = verifySdkBootstrapArtifact(bootstrapToken, TEST_JWT_SECRET);
    if (!payload) {
      return {
        success: false,
        status: 401,
        body: { error: 'Invalid or expired token' },
      };
    }

    const permissions = Array.isArray(payload.permissions)
      ? payload.permissions.filter((permission) => typeof permission === 'string')
      : ['session:send_message'];
    const channelId = payload.channelId;

    return {
      success: true,
      data: {
        token: jwt.sign(
          {
            type: 'sdk_session',
            tenantId: payload.tenantId,
            projectId: payload.projectId,
            channelId,
            permissions,
          },
          TEST_JWT_SECRET,
          {
            issuer: 'agent-platform',
            audience: 'sdk-session',
            expiresIn: '4h',
          },
        ),
        tenantId: payload.tenantId,
        projectId: payload.projectId,
        channelId,
        permissions,
        showActivityUpdates: false,
        expiresIn: 14_400,
      },
    };
  });
});

// ===========================================================================
// GET /api/sdk/keys
// ===========================================================================

describe('GET /api/sdk/keys', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/sdk/keys/route');
    handler = mod.GET;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/sdk/keys?projectId=proj-1', 'http://localhost:3000'));
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when projectId is missing', async () => {
    const req = new NextRequest(new URL('/api/sdk/keys', 'http://localhost:3000'));
    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('projectId');
  });

  it('returns 404 when project not found', async () => {
    const accessResponse = NextResponse.json({ error: 'Project not found' }, { status: 404 });
    mockRequireSdkProjectAccess.mockResolvedValue(accessResponse);
    mockIsSdkProjectAccessError.mockReturnValue(true);

    const req = new NextRequest(
      new URL('/api/sdk/keys?projectId=nonexistent', 'http://localhost:3000'),
    );
    const res = await handler(req);
    expect(res.status).toBe(404);
  });

  it('returns active keys list on success', async () => {
    mockFindPublicApiKeys.mockResolvedValue([
      {
        id: 'key-1',
        keyPrefix: 'pk_abc12345',
        name: 'Test Key',
        allowedOrigins: ['https://example.com'],
        permissions: { chat: true, voice: false },
        isActive: true,
        lastUsedAt: null,
        createdAt: '2024-01-01T00:00:00Z',
        expiresAt: null,
      },
    ]);

    const req = new NextRequest(new URL('/api/sdk/keys?projectId=proj-1', 'http://localhost:3000'));
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].keyPrefix).toBe('pk_abc12345');
    expect(body.keys[0].permissions.chat).toBe(true);
    expect(mockFindPublicApiKeys).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      isActive: true,
    });
  });

  it('handles keys with null allowedOrigins', async () => {
    mockFindPublicApiKeys.mockResolvedValue([
      {
        id: 'key-2',
        keyPrefix: 'pk_xyz',
        name: 'Open Key',
        allowedOrigins: null,
        permissions: { chat: true, voice: true },
        isActive: true,
        lastUsedAt: null,
        createdAt: '2024-01-01T00:00:00Z',
        expiresAt: null,
      },
    ]);

    const req = new NextRequest(new URL('/api/sdk/keys?projectId=proj-1', 'http://localhost:3000'));
    const res = await handler(req);
    const body = await res.json();
    expect(body.keys[0].allowedOrigins).toBeNull();
  });

  it('returns 500 on service error', async () => {
    mockFindPublicApiKeys.mockRejectedValue(new Error('DB error'));

    const req = new NextRequest(new URL('/api/sdk/keys?projectId=proj-1', 'http://localhost:3000'));
    const res = await handler(req);
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/sdk/keys
// ===========================================================================

describe('POST /api/sdk/keys', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/sdk/keys/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(makeRequest('/api/sdk/keys', { projectId: 'proj-1', name: 'Key' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing projectId', async () => {
    const res = await handler(makeRequest('/api/sdk/keys', { name: 'Key' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing name', async () => {
    const res = await handler(makeRequest('/api/sdk/keys', { projectId: 'proj-1' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when project not found', async () => {
    const accessResponse = NextResponse.json({ error: 'Project not found' }, { status: 404 });
    mockRequireSdkProjectAccess.mockResolvedValue(accessResponse);
    mockIsSdkProjectAccessError.mockReturnValue(true);

    const res = await handler(makeRequest('/api/sdk/keys', { projectId: 'bad', name: 'Key' }));
    expect(res.status).toBe(404);
  });

  it('creates a key successfully', async () => {
    mockCreatePublicApiKey.mockResolvedValue({
      id: 'key-new',
      keyPrefix: 'pk_abc',
      name: 'My Key',
      allowedOrigins: null,
      permissions: { chat: true, voice: false },
      isActive: true,
      createdAt: '2024-06-01T00:00:00Z',
      expiresAt: null,
    });

    const res = await handler(
      makeRequest('/api/sdk/keys', {
        projectId: 'proj-1',
        name: 'My Key',
      }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.id).toBe('key-new');
    expect(body.key).toBeDefined();
    expect(body.key).toMatch(/^pk_/);
    expect(mockCreatePublicApiKey).toHaveBeenCalledWith(
      'proj-1',
      'tenant-1',
      expect.objectContaining({
        allowedOrigins: null,
        permissions: { chat: true, voice: false },
      }),
    );
  });

  it('returns 500 on service error', async () => {
    mockCreatePublicApiKey.mockRejectedValue(new Error('DB error'));

    const res = await handler(
      makeRequest('/api/sdk/keys', {
        projectId: 'proj-1',
        name: 'Key',
      }),
    );
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// DELETE /api/sdk/keys/:keyId
// ===========================================================================

describe('DELETE /api/sdk/keys/:keyId', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/sdk/keys/[keyId]/route');
    handler = mod.DELETE;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/sdk/keys/key-1', 'http://localhost:3000'), {
      method: 'DELETE',
    });
    const res = await handler(req, { params: Promise.resolve({ keyId: 'key-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when key not found', async () => {
    mockFindPublicApiKeys.mockResolvedValue([]);

    const req = new NextRequest(new URL('/api/sdk/keys/key-999', 'http://localhost:3000'), {
      method: 'DELETE',
    });
    const res = await handler(req, { params: Promise.resolve({ keyId: 'key-999' }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 when project not owned by user', async () => {
    mockFindPublicApiKeys.mockResolvedValue([{ id: 'key-1', projectId: 'proj-1' }]);
    const accessResponse = NextResponse.json({ error: 'API key not found' }, { status: 404 });
    mockRequireSdkProjectAccess.mockResolvedValue(accessResponse);
    mockIsSdkProjectAccessError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/sdk/keys/key-1', 'http://localhost:3000'), {
      method: 'DELETE',
    });
    const res = await handler(req, { params: Promise.resolve({ keyId: 'key-1' }) });
    expect(res.status).toBe(404);
  });

  it('revokes key successfully', async () => {
    mockFindPublicApiKeys.mockResolvedValue([{ id: 'key-1', projectId: 'proj-1' }]);
    mockUpdatePublicApiKey.mockResolvedValue(undefined);

    const req = new NextRequest(new URL('/api/sdk/keys/key-1', 'http://localhost:3000'), {
      method: 'DELETE',
    });
    const res = await handler(req, { params: Promise.resolve({ keyId: 'key-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockUpdatePublicApiKey).toHaveBeenCalledWith('key-1', 'proj-1', 'tenant-1', {
      isActive: false,
    });
  });

  it('returns 500 on service error', async () => {
    mockFindPublicApiKeys.mockRejectedValue(new Error('DB error'));

    const req = new NextRequest(new URL('/api/sdk/keys/key-1', 'http://localhost:3000'), {
      method: 'DELETE',
    });
    const res = await handler(req, { params: Promise.resolve({ keyId: 'key-1' }) });
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/sdk/preview-token
// ===========================================================================

describe('POST /api/sdk/preview-token', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await previewTokenRouteModulePromise;
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(makeRequest('/api/sdk/preview-token', { projectId: 'proj-1' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when projectId is missing', async () => {
    const res = await handler(makeRequest('/api/sdk/preview-token', {}));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errors[0]?.msg).toContain('projectId');
  });

  it('returns 400 when projectId is not a string', async () => {
    const res = await handler(makeRequest('/api/sdk/preview-token', { projectId: 123 }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when project not found', async () => {
    const accessResponse = NextResponse.json({ error: 'Project not found' }, { status: 404 });
    mockRequireSdkProjectAccess.mockResolvedValue(accessResponse);
    mockIsSdkProjectAccessError.mockReturnValue(true);

    const res = await handler(makeRequest('/api/sdk/preview-token', { projectId: 'nonexistent' }));
    expect(res.status).toBe(404);
  });

  it('returns 429 when the preview-token route is rate limited', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfter: 17 });

    const res = await handler(makeRequest('/api/sdk/preview-token', { projectId: 'proj-1' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('17');
  });

  it('returns SDK token on success', async () => {
    const res = await handler(makeRequest('/api/sdk/preview-token', { projectId: 'proj-1' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.sdkToken).toBeDefined();
    expect(typeof body.sdkToken).toBe('string');
    expect(readIssuedPermissions(body.sdkToken)).toEqual(['session:send_message', 'session:read']);
  });

  it('includes voice permission when widget preview enables voice', async () => {
    mockFindWidgetConfig.mockResolvedValue({
      chatEnabled: true,
      voiceEnabled: true,
    });

    const res = await handler(makeRequest('/api/sdk/preview-token', { projectId: 'proj-1' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(readIssuedPermissions(body.sdkToken)).toEqual([
      'session:send_message',
      'session:voice',
      'session:read',
    ]);
  });

  it('preserves runtime-derived session:read permission in preview tokens', async () => {
    const runtimePermissions = ['session:send_message', 'session:read'];
    mockExchangeSdkBootstrapArtifactWithRuntime.mockResolvedValueOnce({
      success: true,
      data: {
        token: jwt.sign(
          {
            type: 'sdk_session',
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            channelId: 'channel-1',
            permissions: runtimePermissions,
          },
          TEST_JWT_SECRET,
          {
            issuer: 'agent-platform',
            audience: 'sdk-session',
            expiresIn: '4h',
          },
        ),
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        channelId: 'channel-1',
        permissions: runtimePermissions,
        showActivityUpdates: false,
        expiresIn: 14_400,
      },
    });

    const res = await handler(makeRequest('/api/sdk/preview-token', { projectId: 'proj-1' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(readIssuedPermissions(body.sdkToken)).toEqual(runtimePermissions);
  });

  it('returns 500 on unexpected error', async () => {
    mockRequireSdkProjectAccess.mockRejectedValueOnce(new Error('DB error'));

    const res = await handler(makeRequest('/api/sdk/preview-token', { projectId: 'proj-1' }));
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/sdk/share
// ===========================================================================

describe('POST /api/sdk/share', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await shareRouteModulePromise;
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireTenantAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(makeRequest('/api/sdk/share', { projectId: 'proj-1' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when projectId is missing', async () => {
    const res = await handler(makeRequest('/api/sdk/share', {}));
    expect(res.status).toBe(400);
  });

  it('returns 404 when project not found', async () => {
    const accessResponse = NextResponse.json({ error: 'Project not found' }, { status: 404 });
    mockRequireSdkProjectAccess.mockResolvedValue(accessResponse);
    mockIsSdkProjectAccessError.mockReturnValue(true);

    const res = await handler(makeRequest('/api/sdk/share', { projectId: 'nonexistent' }));
    expect(res.status).toBe(404);
  });

  it('generates share token on success', async () => {
    const req = makeRequest('/api/sdk/share', { projectId: 'proj-1' });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    const { verifyShareToken } = await import('@/lib/sdk-share-token');
    const payload = verifyShareToken(body.token);
    expect(body.token).toBeDefined();
    expect(body.shareUrl).toMatch(/^http:\/\/localhost:5173\/preview#share_token=/);
    expect(body.expiresAt).toBeDefined();
    expect(body.projectId).toBe('proj-1');
    expect(body.projectName).toBe('Test Project');
    expect(payload?.permissions).toEqual(['session:send_message', 'session:read']);
  });

  it('falls back to the request origin for share links when frontend config is unset', async () => {
    mockGetConfig.mockReturnValue({
      env: 'test',
      jwt: { secret: 'test-jwt-secret' },
      auth: {
        sdk: {
          bootstrapSigningSecret: 'test-jwt-secret',
        },
      },
      server: { frontendUrl: '' },
    });

    const req = makeRequest('/api/sdk/share', { projectId: 'proj-1' });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.shareUrl).toMatch(/^http:\/\/localhost:3000\/preview#share_token=/);
  });

  it('snapshots voice capability into the share token when the SDK channel enables voice', async () => {
    mockResolveSdkBootstrapChannel.mockResolvedValueOnce({
      success: true,
      channel: {
        id: 'channel-1',
        name: 'default',
        publicApiKeyId: 'key-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        config: {
          mode: 'unified',
          chatEnabled: true,
          voiceEnabled: true,
        },
        showActivityUpdates: false,
      },
    });
    mockFindWidgetConfig.mockResolvedValue({
      chatEnabled: false,
      voiceEnabled: false,
    });

    const req = makeRequest('/api/sdk/share', { projectId: 'proj-1' });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    const { verifyShareToken } = await import('@/lib/sdk-share-token');
    const payload = verifyShareToken(body.token);
    expect(payload?.permissions).toEqual(['session:send_message', 'session:voice', 'session:read']);
  });

  it('returns 422 when the SDK channel disables both chat and voice', async () => {
    mockResolveSdkBootstrapChannel.mockResolvedValueOnce({
      success: true,
      channel: {
        id: 'channel-1',
        name: 'default',
        publicApiKeyId: 'key-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        config: {
          chatEnabled: false,
          voiceEnabled: false,
        },
        showActivityUpdates: false,
      },
    });
    mockFindWidgetConfig.mockResolvedValue({
      chatEnabled: true,
      voiceEnabled: true,
    });

    const req = makeRequest('/api/sdk/share', { projectId: 'proj-1' });
    const res = await handler(req);

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      error: 'Preview is not enabled for this project',
    });
  });

  it('returns 500 on unexpected error', async () => {
    mockRequireSdkProjectAccess.mockRejectedValueOnce(new Error('DB error'));

    const res = await handler(makeRequest('/api/sdk/share', { projectId: 'proj-1' }));
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/sdk/share/exchange
// ===========================================================================

describe('POST /api/sdk/share/exchange', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await shareExchangeRouteModulePromise;
    handler = mod.POST;
  });

  it('returns 400 when token is missing', async () => {
    const req = makeRequest('/api/sdk/share/exchange', {});
    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errors[0]?.msg).toContain('token');
  });

  it('returns 401 for invalid token', async () => {
    const req = makeRequest('/api/sdk/share/exchange', { token: 'invalid-token' });
    const res = await handler(req);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toContain('Invalid or expired');
  });

  it('returns 429 when share exchange is rate limited', async () => {
    mockCheckRateLimit
      .mockResolvedValueOnce({ allowed: true, retryAfter: undefined })
      .mockResolvedValueOnce({ allowed: false, retryAfter: 11 });

    const { POST: createShare } = await shareRouteModulePromise;
    const createResponse = await createShare(
      makeRequest('/api/sdk/share', { projectId: 'proj-1' }),
    );
    const { token } = (await createResponse.json()) as { token: string };

    // Now block rate limit for the exchange call
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfter: 11 });

    const res = await handler(makeRequest('/api/sdk/share/exchange', { token }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('11');
  });

  it('issues an SDK session token for a valid share token', async () => {
    const { POST: createShare } = await shareRouteModulePromise;
    const createResponse = await createShare(
      makeRequest('/api/sdk/share', { projectId: 'proj-1' }),
    );
    const { token } = (await createResponse.json()) as { token: string };

    const exchangeResponse = await handler(makeRequest('/api/sdk/share/exchange', { token }));
    expect(exchangeResponse.status).toBe(200);

    const body = await exchangeResponse.json();
    expect(body.valid).toBe(true);
    expect(body.projectId).toBe('proj-1');
    expect(body.sdkToken).toBeDefined();
    expect(body.permissions).toEqual(['session:send_message', 'session:read']);
    expect(body.config.chatEnabled).toBe(true);
    expect(readIssuedPermissions(body.sdkToken)).toEqual(['session:send_message', 'session:read']);
  });

  it('keeps exchanged Runtime SDK session permissions aligned with the share permissions', async () => {
    mockExchangeSdkBootstrapArtifactWithRuntime.mockImplementationOnce(
      async (bootstrapToken: string) => {
        const { verifySdkBootstrapArtifact } = await import('@agent-platform/shared');
        const payload = verifySdkBootstrapArtifact(bootstrapToken, TEST_JWT_SECRET);
        if (!payload) {
          return {
            success: false,
            status: 401,
            body: { error: 'Invalid or expired token' },
          };
        }

        const requestedPermissions = Array.isArray(payload.permissions)
          ? payload.permissions.filter((permission) => typeof permission === 'string')
          : ['session:send_message'];
        const runtimePermissions = Array.from(new Set([...requestedPermissions, 'session:read']));

        return {
          success: true,
          data: {
            token: jwt.sign(
              {
                type: 'sdk_session',
                tenantId: payload.tenantId,
                projectId: payload.projectId,
                channelId: payload.channelId,
                permissions: runtimePermissions,
              },
              TEST_JWT_SECRET,
              {
                issuer: 'agent-platform',
                audience: 'sdk-session',
                expiresIn: '4h',
              },
            ),
            tenantId: payload.tenantId,
            projectId: payload.projectId,
            channelId: payload.channelId,
            permissions: runtimePermissions,
            showActivityUpdates: false,
            expiresIn: 14_400,
          },
        };
      },
    );

    const { POST: createShare } = await shareRouteModulePromise;
    const createResponse = await createShare(
      makeRequest('/api/sdk/share', { projectId: 'proj-1' }),
    );
    const { token } = (await createResponse.json()) as { token: string };

    const exchangeResponse = await handler(makeRequest('/api/sdk/share/exchange', { token }));
    expect(exchangeResponse.status).toBe(200);

    const body = await exchangeResponse.json();
    expect(body.permissions).toEqual(['session:send_message', 'session:read']);
    expect(readIssuedPermissions(body.sdkToken)).toEqual(body.permissions);
  });

  it('returns a null welcome message when the widget does not configure one', async () => {
    mockFindWidgetConfig.mockResolvedValue({
      mode: 'chat',
      position: 'bottom-right',
      welcomeMessage: null,
      placeholderText: 'Type a message...',
      voiceEnabled: false,
      chatEnabled: true,
      theme: '{}',
    });

    const { POST: createShare } = await shareRouteModulePromise;
    const createResponse = await createShare(
      makeRequest('/api/sdk/share', { projectId: 'proj-1' }),
    );
    const { token } = (await createResponse.json()) as { token: string };

    const exchangeResponse = await handler(makeRequest('/api/sdk/share/exchange', { token }));
    expect(exchangeResponse.status).toBe(200);

    const body = await exchangeResponse.json();
    expect(body.config.welcomeMessage).toBeNull();
  });

  it('rejects voice-only share exchange when the share link does not grant voice access', async () => {
    const { POST: createShare } = await shareRouteModulePromise;
    const createResponse = await createShare(
      makeRequest('/api/sdk/share', { projectId: 'proj-1' }),
    );
    const { token } = (await createResponse.json()) as { token: string };

    const exchangeResponse = await handler(
      makeRequest('/api/sdk/share/exchange', {
        token,
        requiredPermission: 'session:voice',
      }),
    );

    expect(exchangeResponse.status).toBe(403);
    await expect(exchangeResponse.json()).resolves.toEqual({
      error: 'Share link does not grant the required permission',
    });
  });

  it('issues a voice-scoped SDK token when the share link and SDK channel both allow voice', async () => {
    mockFindWidgetConfig.mockResolvedValue({
      mode: 'unified',
      position: 'bottom-right',
      welcomeMessage: 'Hello!',
      placeholderText: 'Speak or type...',
      voiceEnabled: true,
      chatEnabled: true,
      theme: '{}',
    });
    mockResolveSdkBootstrapChannel.mockResolvedValueOnce({
      success: true,
      channel: {
        id: 'channel-1',
        name: 'default',
        publicApiKeyId: 'key-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        config: {
          mode: 'unified',
          position: 'bottom-right',
          welcomeMessage: 'Hello!',
          placeholderText: 'Speak or type...',
          voiceEnabled: true,
          chatEnabled: true,
        },
        showActivityUpdates: false,
      },
    });
    mockFindActiveSdkChannelById.mockResolvedValueOnce({
      id: 'channel-1',
      name: 'default',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      config: {
        mode: 'unified',
        position: 'bottom-right',
        welcomeMessage: 'Hello!',
        placeholderText: 'Speak or type...',
        voiceEnabled: true,
        chatEnabled: true,
      },
    });

    const { POST: createShare } = await shareRouteModulePromise;
    const createResponse = await createShare(
      makeRequest('/api/sdk/share', { projectId: 'proj-1' }),
    );
    const { token } = (await createResponse.json()) as { token: string };

    const exchangeResponse = await handler(
      makeRequest('/api/sdk/share/exchange', {
        token,
        requiredPermission: 'session:voice',
      }),
    );

    expect(exchangeResponse.status).toBe(200);

    const body = await exchangeResponse.json();
    expect(body.valid).toBe(true);
    expect(body.permissions).toEqual(['session:voice', 'session:read']);
    expect(body.config.voiceEnabled).toBe(true);
    expect(readIssuedPermissions(body.sdkToken)).toEqual(['session:voice', 'session:read']);
  });

  it('uses the SDK channel config instead of stale widget config when exchanging a channel share token', async () => {
    mockFindWidgetConfig.mockResolvedValue({
      mode: 'chat',
      position: 'bottom-right',
      welcomeMessage: 'Old widget welcome',
      placeholderText: 'Old widget placeholder',
      voiceEnabled: false,
      chatEnabled: true,
      theme: '{"primaryColor":"#111111"}',
    });
    mockResolveSdkBootstrapChannel.mockResolvedValueOnce({
      success: true,
      channel: {
        id: 'channel-1',
        name: 'default',
        publicApiKeyId: 'key-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        config: {
          mode: 'unified',
          position: 'top-left',
          welcomeMessage: 'Fresh channel welcome',
          placeholderText: 'Fresh channel placeholder',
          voiceEnabled: true,
          chatEnabled: false,
          showActivityUpdates: true,
        },
        showActivityUpdates: true,
      },
    });
    mockFindActiveSdkChannelById.mockResolvedValueOnce({
      id: 'channel-1',
      name: 'default',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      config: {
        mode: 'unified',
        position: 'top-left',
        welcomeMessage: 'Fresh channel welcome',
        placeholderText: 'Fresh channel placeholder',
        voiceEnabled: true,
        chatEnabled: false,
        showActivityUpdates: true,
      },
    });

    const { POST: createShare } = await shareRouteModulePromise;
    const createResponse = await createShare(
      makeRequest('/api/sdk/share', { projectId: 'proj-1', channelId: 'channel-1' }),
    );
    const { token } = (await createResponse.json()) as { token: string };

    const exchangeResponse = await handler(makeRequest('/api/sdk/share/exchange', { token }));
    expect(exchangeResponse.status).toBe(200);

    const body = await exchangeResponse.json();
    expect(body.permissions).toEqual(['session:voice', 'session:read']);
    expect(body.config).toMatchObject({
      mode: 'unified',
      position: 'top-left',
      welcomeMessage: 'Fresh channel welcome',
      placeholderText: 'Fresh channel placeholder',
      voiceEnabled: true,
      chatEnabled: false,
      showActivityUpdates: true,
    });
  });
});

// ===========================================================================
// GET /api/sdk/widget/:projectId
// ===========================================================================

describe('GET /api/sdk/widget/:projectId', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/sdk/widget/[projectId]/route');
    handler = mod.GET;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/sdk/widget/proj-1', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when project not found', async () => {
    const accessResponse = NextResponse.json({ error: 'Project not found' }, { status: 404 });
    mockRequireSdkProjectAccess.mockResolvedValue(accessResponse);
    mockIsSdkProjectAccessError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/sdk/widget/bad', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'bad' }) });
    expect(res.status).toBe(404);
  });

  it('returns default widget config when none exists', async () => {
    mockFindWidgetConfig.mockResolvedValue(null);

    const req = new NextRequest(new URL('/api/sdk/widget/proj-1', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.channelId).toBeNull();
    expect(body.position).toBe('bottom-right');
    expect(body.voiceEnabled).toBe(false);
    expect(body.chatEnabled).toBe(true);
    expect(body.showActivityUpdates).toBe(false);
  });

  it('returns stored widget config', async () => {
    mockFindWidgetConfig.mockResolvedValue({
      channelId: 'channel-1',
      mode: 'voice',
      position: 'top-left',
      welcomeMessage: 'Hi!',
      placeholderText: 'Speak...',
      voiceEnabled: true,
      chatEnabled: false,
      theme: '{"primaryColor":"#ff0000"}',
    });
    mockFindActiveSdkChannelById.mockResolvedValueOnce({
      id: 'channel-1',
      config: { showActivityUpdates: false },
    });

    const req = new NextRequest(new URL('/api/sdk/widget/proj-1', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.channelId).toBe('channel-1');
    expect(body.position).toBe('top-left');
    expect(body.voiceEnabled).toBe(true);
    expect(body.showActivityUpdates).toBe(false);
    expect(body.theme.primaryColor).toBe('#ff0000');
  });

  it('reads showActivityUpdates from an explicitly requested SDK channel', async () => {
    mockFindWidgetConfig.mockResolvedValue({
      channelId: 'channel-default',
      mode: 'chat',
      position: 'bottom-right',
      welcomeMessage: 'Hi!',
      placeholderText: 'Type...',
      voiceEnabled: false,
      chatEnabled: true,
      theme: '{}',
    });
    mockFindActiveSdkChannelById.mockResolvedValueOnce({
      id: 'channel-explicit',
      config: { showActivityUpdates: true },
    });

    const req = new NextRequest(
      new URL('/api/sdk/widget/proj-1?channelId=channel-explicit', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      channelId: 'channel-default',
      showActivityUpdates: true,
    });
  });

  it('returns 500 on service error', async () => {
    mockFindWidgetConfig.mockRejectedValue(new Error('DB error'));

    const req = new NextRequest(new URL('/api/sdk/widget/proj-1', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// PUT /api/sdk/widget/:projectId
// ===========================================================================

describe('PUT /api/sdk/widget/:projectId', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/sdk/widget/[projectId]/route');
    handler = mod.PUT;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest('/api/sdk/widget/proj-1', { mode: 'voice' }, 'PUT');
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid mode', async () => {
    const req = makeRequest('/api/sdk/widget/proj-1', { mode: 'invalid' }, 'PUT');
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 when project not found', async () => {
    const accessResponse = NextResponse.json({ error: 'Project not found' }, { status: 404 });
    mockRequireSdkProjectAccess.mockResolvedValue(accessResponse);
    mockIsSdkProjectAccessError.mockReturnValue(true);

    const req = makeRequest('/api/sdk/widget/bad', { mode: 'chat' }, 'PUT');
    const res = await handler(req, { params: Promise.resolve({ projectId: 'bad' }) });
    expect(res.status).toBe(404);
  });

  it('updates widget config successfully', async () => {
    mockFindActiveSdkChannelById.mockResolvedValue({
      id: 'channel-1',
      config: { showActivityUpdates: false },
    });
    mockUpsertWidgetConfig.mockResolvedValue({
      channelId: 'channel-1',
      mode: 'unified',
      position: 'bottom-left',
      welcomeMessage: 'Welcome!',
      placeholderText: 'Type...',
      voiceEnabled: true,
      chatEnabled: true,
      theme: '{"primaryColor":"#0000ff"}',
    });

    const req = makeRequest(
      '/api/sdk/widget/proj-1',
      {
        channelId: 'channel-1',
        mode: 'unified',
        position: 'bottom-left',
        voiceEnabled: true,
      },
      'PUT',
    );
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();

    expect(mockFindActiveSdkChannelById).toHaveBeenCalledWith('channel-1', 'proj-1', 'tenant-1');
    expect(body.channelId).toBe('channel-1');
    expect(body.position).toBe('bottom-left');
    expect(body.voiceEnabled).toBe(true);
    expect(body.showActivityUpdates).toBe(false);
  });

  it('returns 404 when widget config is bound to a missing channel', async () => {
    mockFindActiveSdkChannelById.mockResolvedValueOnce(null);

    const req = makeRequest('/api/sdk/widget/proj-1', { channelId: 'missing-channel' }, 'PUT');
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Channel not found' });
  });

  it('returns 500 on service error', async () => {
    mockUpsertWidgetConfig.mockRejectedValue(new Error('DB error'));

    const req = makeRequest('/api/sdk/widget/proj-1', { mode: 'chat' }, 'PUT');
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// GET /api/sdk/embed/:projectId
// ===========================================================================

describe('GET /api/sdk/embed/:projectId', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/sdk/embed/[projectId]/route');
    handler = mod.GET;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/sdk/embed/proj-1', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when project not found', async () => {
    const accessResponse = NextResponse.json({ error: 'Project not found' }, { status: 404 });
    mockRequireSdkProjectAccess.mockResolvedValue(accessResponse);
    mockIsSdkProjectAccessError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/sdk/embed/bad', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'bad' }) });
    expect(res.status).toBe(404);
  });

  it('returns 422 when the resolved channel is not bound to an active public API key', async () => {
    mockFindWidgetConfig.mockResolvedValue(null);
    mockFindPublicApiKeyById.mockResolvedValueOnce(null);

    const req = new NextRequest(new URL('/api/sdk/embed/proj-1', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.error).toContain('selected SDK channel');
  });

  it('returns embed snippet on success', async () => {
    process.env.RUNTIME_PUBLIC_BASE_URL = 'https://runtime.embed.example.test/';
    mockFindWidgetConfig.mockResolvedValue({
      mode: 'chat',
      position: 'bottom-right',
      welcomeMessage: 'Hello!',
      theme: '{}',
      voiceEnabled: false,
      chatEnabled: true,
      channelId: 'channel-1',
    });

    const req = new NextRequest(new URL('/api/sdk/embed/proj-1', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.snippet).toContain('<agent-widget');
    expect(body.snippet).toContain('proj-1');
    expect(body.snippet).toContain('YOUR_PUBLIC_API_KEY');
    expect(body.snippet).toContain(`endpoint="${body.runtimeEndpoint}"`);
    expect(body.snippet).toContain('channel-id="channel-1"');
    expect(body.snippet).toContain('chat-enabled="true"');
    expect(body.snippet).toContain('voice-enabled="false"');
    expect(body.snippet).not.toContain('show-activity-updates=');
    expect(body.runtimeEndpoint).toBe('https://runtime.embed.example.test');
    expect(body.config.channelId).toBe('channel-1');
    expect(body.config.channelName).toBe('default');
    expect(body.config.showActivityUpdates).toBe(false);
    expect(body.keyPrefix).toBe('pk_abc');
    expect(body.keyName).toBe('Main Key');
    expect(body.sdkUrl).toContain('/api/sdk/embed/script');
    expect(typeof body.runtimeEndpoint).toBe('string');
    expect(body.runtimeEndpoint.length).toBeGreaterThan(0);
  });

  it('propagates authoritative chat and voice capability attributes into the embed snippet', async () => {
    process.env.RUNTIME_PUBLIC_BASE_URL = 'https://runtime.embed.example.test/';
    mockFindWidgetConfig.mockResolvedValue({
      mode: 'unified',
      position: 'bottom-right',
      welcomeMessage: 'Hello!',
      theme: '{}',
      voiceEnabled: true,
      chatEnabled: false,
      channelId: 'channel-1',
    });
    mockResolveSdkBootstrapChannel.mockResolvedValueOnce({
      success: true,
      channel: {
        id: 'channel-1',
        name: 'default',
        publicApiKeyId: 'key-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        config: { showActivityUpdates: true },
        showActivityUpdates: true,
      },
    });

    const req = new NextRequest(new URL('/api/sdk/embed/proj-1', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.config.mode).toBe('unified');
    expect(body.config.chatEnabled).toBe(false);
    expect(body.config.voiceEnabled).toBe(true);
    expect(body.config.showActivityUpdates).toBe(true);
    expect(body.snippet).toContain('mode="unified"');
    expect(body.snippet).toContain('chat-enabled="false"');
    expect(body.snippet).toContain('voice-enabled="true"');
    expect(body.snippet).not.toContain('show-activity-updates=');
  });

  it('returns 422 and skips channel resolution when the widget disables both chat and voice', async () => {
    process.env.RUNTIME_PUBLIC_BASE_URL = 'https://runtime.embed.example.test/';
    mockFindWidgetConfig.mockResolvedValue({
      mode: 'unified',
      position: 'bottom-right',
      theme: '{}',
      voiceEnabled: false,
      chatEnabled: false,
      channelId: 'channel-1',
    });

    const req = new NextRequest(new URL('/api/sdk/embed/proj-1', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      error: 'Embed is not enabled for this project',
    });
    expect(mockResolveSdkBootstrapChannel).not.toHaveBeenCalled();
    expect(mockFindPublicApiKeyById).not.toHaveBeenCalled();
  });

  it('falls back to the request origin for localhost embed snippets when explicit runtime configuration is missing', async () => {
    mockFindWidgetConfig.mockResolvedValue({
      mode: 'chat',
      position: 'bottom-right',
      welcomeMessage: 'Hello!',
      theme: '{}',
      voiceEnabled: false,
      chatEnabled: true,
    });

    const req = new NextRequest(new URL('/api/sdk/embed/proj-1', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.runtimeEndpoint).toBe('http://localhost:3000');
    expect(body.snippet).toContain('endpoint="http://localhost:3000"');
  });

  it('falls back to the request origin for same-host embed snippets when no public runtime URL is configured', async () => {
    mockFindWidgetConfig.mockResolvedValue({
      mode: 'chat',
      position: 'bottom-right',
      welcomeMessage: 'Hello!',
      theme: '{}',
      voiceEnabled: false,
      chatEnabled: true,
    });

    const req = new NextRequest(new URL('/api/sdk/embed/proj-1', 'https://studio.example.test'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(200);

    await expect(res.json()).resolves.toMatchObject({
      runtimeEndpoint: 'https://studio.example.test',
    });
  });

  it('preserves forwarded request host when generating the embed script URL', async () => {
    process.env.RUNTIME_PUBLIC_BASE_URL = 'https://runtime.embed.example.test';
    mockFindWidgetConfig.mockResolvedValue({
      mode: 'chat',
      position: 'bottom-right',
      welcomeMessage: 'Hello!',
      theme: '{}',
      voiceEnabled: false,
      chatEnabled: true,
    });

    const req = new NextRequest(new URL('/api/sdk/embed/proj-1', 'http://localhost:3000'), {
      headers: {
        host: '127.0.0.1:3000',
        'x-forwarded-host': '127.0.0.1:3000',
        'x-forwarded-proto': 'http',
      },
    });
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.sdkUrl).toBe('http://127.0.0.1:3000/api/sdk/embed/script');
    expect(body.snippet).toContain(
      '<script src="http://127.0.0.1:3000/api/sdk/embed/script" defer></script>',
    );
  });

  it('prefers explicit embed channel selection over widget defaults', async () => {
    process.env.RUNTIME_PUBLIC_BASE_URL = 'https://runtime.embed.example.test';
    mockFindWidgetConfig.mockResolvedValue({
      channelId: 'channel-default',
      mode: 'chat',
      position: 'bottom-right',
      theme: '{}',
      voiceEnabled: false,
      chatEnabled: true,
    });
    mockResolveSdkBootstrapChannel.mockResolvedValueOnce({
      success: true,
      channel: {
        id: 'channel-explicit',
        name: 'voice-preview',
        publicApiKeyId: 'key-voice',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        config: {},
        showActivityUpdates: false,
      },
    });
    mockFindPublicApiKeyById.mockResolvedValueOnce({
      id: 'key-voice',
      keyPrefix: 'pk_voice',
      name: 'Voice Key',
      isActive: true,
    });

    const req = new NextRequest(
      new URL('/api/sdk/embed/proj-1?channelId=channel-explicit', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(200);
    expect(mockResolveSdkBootstrapChannel).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      channelId: 'channel-explicit',
      fallbackChannelId: 'channel-default',
      surface: 'embed',
    });

    const body = await res.json();
    expect(body.keyPrefix).toBe('pk_voice');
    expect(body.config.channelId).toBe('channel-explicit');
    expect(body.snippet).toContain('channel-id="channel-explicit"');
    expect(body.snippet).toContain('chat-enabled="true"');
    expect(body.snippet).toContain('voice-enabled="false"');
  });

  it('renders explicit widget capability flags into the embed snippet', async () => {
    process.env.RUNTIME_PUBLIC_BASE_URL = 'https://runtime.embed.example.test';
    mockFindWidgetConfig.mockResolvedValue({
      channelId: 'channel-1',
      mode: 'voice',
      position: 'bottom-right',
      theme: '{}',
      voiceEnabled: true,
      chatEnabled: false,
    });

    const req = new NextRequest(new URL('/api/sdk/embed/proj-1', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.config.mode).toBe('voice');
    expect(body.config.chatEnabled).toBe(false);
    expect(body.config.voiceEnabled).toBe(true);
    expect(body.config.showActivityUpdates).toBe(false);
    expect(body.snippet).toContain('chat-enabled="false"');
    expect(body.snippet).toContain('voice-enabled="true"');
    expect(body.snippet).not.toContain('show-activity-updates=');
  });

  it('returns 500 on service error', async () => {
    mockFindWidgetConfig.mockRejectedValue(new Error('DB error'));

    const req = new NextRequest(new URL('/api/sdk/embed/proj-1', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    expect(res.status).toBe(500);
  });
});
