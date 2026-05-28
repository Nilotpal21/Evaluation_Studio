import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockRequireAuth = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockEnsureDb = vi.fn();
const mockFindOne = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();
const mockGetRedisClient = vi.fn();
const mockValidateUrlForSSRF = vi.fn();
const mockCreateOAuthState = vi.fn();
const mockSetOAuthCsrfCookie = vi.fn();
const mockEmitOAuthAuditEvent = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: () => false,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: () => false,
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: (...args: unknown[]) => mockEnsureDb(...args),
}));

vi.mock('@/lib/redis-client', () => ({
  getRedisClient: () => mockGetRedisClient(),
}));

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
  // ABLP-619: AuthProfileStatusSchema (in shared/validation) is sourced from
  // this const at module-init time, so the mock must expose it.
  AUTH_PROFILE_STATUSES: [
    'active',
    'expired',
    'revoked',
    'invalid',
    'pending_authorization',
  ] as const,
}));

vi.mock('@agent-platform/shared/security', () => ({
  validateUrlForSSRF: (...args: unknown[]) => mockValidateUrlForSSRF(...args),
  getDevSSRFOptions: () => ({}),
}));

vi.mock('@agent-platform/shared-kernel/security', () => ({
  getDevSSRFOptions: () => ({}),
}));

vi.mock('@/app/api/auth-profiles/oauth/_oauth-state-service', () => ({
  createOAuthState: (...args: unknown[]) => mockCreateOAuthState(...args),
  setOAuthCsrfCookie: (...args: unknown[]) => mockSetOAuthCsrfCookie(...args),
  AUTH_PROFILE_OAUTH_CSRF_COOKIE: 'csrf-cookie',
}));

vi.mock('@/app/api/auth-profiles/oauth/_oauth-audit', () => ({
  emitOAuthAuditEvent: (...args: unknown[]) => mockEmitOAuthAuditEvent(...args),
}));

vi.mock('@/lib/connection-config-utils', () => ({
  extractConnectionConfigFields: () => [],
}));

import { POST } from '@/app/api/projects/[id]/auth-profiles/oauth/initiate/route';
import { POST as WorkspacePOST } from '@/app/api/admin/auth-profiles/oauth/initiate/route';
import { POST as WorkspaceOAuthPOST } from '@/app/api/auth-profiles/oauth/initiate/route';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/projects/proj-1/auth-profiles/oauth/initiate', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      origin: 'http://localhost:3000',
    },
  });
}

function makeAppProfile(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'profile-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'shared-oauth',
    authType: 'oauth2_app',
    status: 'active',
    encryptedSecrets: JSON.stringify({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    }),
    config: {
      authorizationUrl: 'https://oauth.example.com/authorize',
      tokenUrl: 'https://oauth.example.com/token',
      defaultScopes: ['scope:read'],
      scopeSeparator: ' ',
    },
    ...overrides,
  };
}

describe('auth profile OAuth initiate route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.STUDIO_OAUTH_ALLOWED_ORIGINS;
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['auth-profile:write'],
    });
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1' },
    });
    mockGetRedisClient.mockReturnValue({
      set: mockRedisSet,
      del: mockRedisDel,
    });
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockValidateUrlForSSRF.mockReturnValue({ safe: true });
    mockCreateOAuthState.mockResolvedValue({
      state: 'test-state-123',
      csrfNonce: 'test-csrf-nonce',
    });
  });

  it('prefers a project-scoped profile over a tenant fallback when resolving by name', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeAppProfile({
        _id: 'project-profile',
        config: {
          authorizationUrl: 'https://project.example.com/authorize',
          tokenUrl: 'https://project.example.com/token',
        },
        encryptedSecrets: JSON.stringify({
          clientId: 'project-client',
          clientSecret: 'project-secret',
        }),
      }),
    );

    const response = await POST(
      makeRequest({ connectorName: 'google', authProfileRef: 'shared-oauth' }),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockFindOne).toHaveBeenCalledTimes(1);
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'shared-oauth',
        tenantId: 'tenant-1',
        authType: 'oauth2_app',
        projectId: 'proj-1',
      }),
    );
    expect(payload.data.authUrl).toContain('client_id=project-client');
  });

  it('passes environment through authProfileRef lookup for same-name disambiguation', async () => {
    mockFindOne.mockResolvedValueOnce(makeAppProfile());

    const response = await POST(
      makeRequest({
        connectorName: 'google',
        authProfileRef: 'shared-oauth',
        environment: 'production',
      }),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'shared-oauth',
        projectId: 'proj-1',
        environment: 'production',
      }),
    );
  });

  it('stores redirectUri and PKCE state and includes them in the authorize URL', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeAppProfile({
        config: {
          authorizationUrl: 'https://oauth.example.com/authorize',
          tokenUrl: 'https://oauth.example.com/token',
          pkceRequired: true,
          pkceMethod: 'S256',
        },
      }),
    );

    const response = await POST(
      makeRequest({ connectorName: 'google', authProfileId: 'profile-1' }),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );
    const payload = await response.json();
    const authUrl = new URL(payload.data.authUrl);
    const storedState = mockCreateOAuthState.mock.calls[0][1] as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/oauth/auth-profile-callback',
    );
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(storedState.redirectUri).toBe('http://localhost:3000/oauth/auth-profile-callback');
    expect(typeof storedState.codeVerifier).toBe('string');
    expect((storedState.codeVerifier as string).length).toBeGreaterThan(0);
  });

  it('allows authProfileId initiate requests without connectorName', async () => {
    mockFindOne.mockResolvedValueOnce(makeAppProfile());

    const response = await POST(makeRequest({ authProfileId: 'profile-1' }), {
      params: Promise.resolve({ id: 'proj-1' }),
    });
    const payload = await response.json();
    const storedState = mockCreateOAuthState.mock.calls[0][1] as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(storedState.authProfileId).toBe('profile-1');
    expect(storedState).not.toHaveProperty('connectorName');
  });

  it('uses NEXT_PUBLIC_APP_URL as canonical OAuth callback origin', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://studio.example.com';
    mockFindOne.mockResolvedValueOnce(makeAppProfile());

    const response = await POST(
      new NextRequest('http://localhost:3000/api/projects/proj-1/auth-profiles/oauth/initiate', {
        method: 'POST',
        body: JSON.stringify({ connectorName: 'google', authProfileId: 'profile-1' }),
        headers: {
          'Content-Type': 'application/json',
          origin: 'https://evil.example.com',
          'x-forwarded-host': 'evil.example.com',
        },
      }),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );
    const payload = await response.json();
    const authUrl = new URL(payload.data.authUrl);
    const storedState = mockCreateOAuthState.mock.calls[0][1] as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'https://studio.example.com/oauth/auth-profile-callback',
    );
    expect(storedState.redirectUri).toBe('https://studio.example.com/oauth/auth-profile-callback');
  });

  it('prefers request origin in development to keep popup callback same-origin', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'development';
      process.env.NEXT_PUBLIC_APP_URL = 'https://studio.example.com';
      mockFindOne.mockResolvedValueOnce(makeAppProfile());

      const response = await POST(
        new NextRequest(
          'https://preview.example.com/api/projects/proj-1/auth-profiles/oauth/initiate',
          {
            method: 'POST',
            body: JSON.stringify({ connectorName: 'google', authProfileId: 'profile-1' }),
            headers: {
              'Content-Type': 'application/json',
              origin: 'https://preview.example.com',
              'x-forwarded-host': 'preview.example.com',
              'x-forwarded-proto': 'https',
            },
          },
        ),
        {
          params: Promise.resolve({ id: 'proj-1' }),
        },
      );
      const payload = await response.json();
      const authUrl = new URL(payload.data.authUrl);
      const storedState = mockCreateOAuthState.mock.calls[0][1] as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(authUrl.searchParams.get('redirect_uri')).toBe(
        'https://preview.example.com/oauth/auth-profile-callback',
      );
      expect(storedState.redirectUri).toBe(
        'https://preview.example.com/oauth/auth-profile-callback',
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('prefers an allowlisted request origin over the canonical host for popup completion', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://studio.example.com';
    process.env.STUDIO_OAUTH_ALLOWED_ORIGINS =
      'https://studio.example.com,https://preview.example.com';
    mockFindOne.mockResolvedValueOnce(makeAppProfile());

    const response = await POST(
      new NextRequest(
        'https://preview.example.com/api/projects/proj-1/auth-profiles/oauth/initiate',
        {
          method: 'POST',
          body: JSON.stringify({ connectorName: 'google', authProfileId: 'profile-1' }),
          headers: {
            'Content-Type': 'application/json',
            origin: 'https://preview.example.com',
            'x-forwarded-host': 'preview.example.com',
            'x-forwarded-proto': 'https',
          },
        },
      ),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );
    const payload = await response.json();
    const authUrl = new URL(payload.data.authUrl);
    const storedState = mockCreateOAuthState.mock.calls[0][1] as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'https://preview.example.com/oauth/auth-profile-callback',
    );
    expect(storedState.redirectUri).toBe('https://preview.example.com/oauth/auth-profile-callback');
  });

  it('rejects popup initiation from a non-allowlisted origin when an allowlist is configured', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://studio.example.com';
    process.env.STUDIO_OAUTH_ALLOWED_ORIGINS = 'https://studio.example.com';
    mockFindOne.mockResolvedValueOnce(makeAppProfile());

    const response = await POST(
      new NextRequest(
        'https://preview.example.com/api/projects/proj-1/auth-profiles/oauth/initiate',
        {
          method: 'POST',
          body: JSON.stringify({ connectorName: 'google', authProfileId: 'profile-1' }),
          headers: {
            'Content-Type': 'application/json',
            origin: 'https://preview.example.com',
            'x-forwarded-host': 'preview.example.com',
            'x-forwarded-proto': 'https',
          },
        },
      ),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(payload)).toContain('OAuth callback origin is not configured');
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('rejects expired OAuth app profiles before building the popup URL', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeAppProfile({
        expiresAt: new Date(Date.now() - 60_000),
      }),
    );

    const response = await POST(
      makeRequest({ connectorName: 'google', authProfileId: 'profile-1' }),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(JSON.stringify(payload)).toContain('expired');
  });
});

// ─── ABLP-619: workspace (admin) OAuth initiate route ────────────────────
function makeWorkspaceInitiateRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/auth-profiles/oauth/initiate', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      origin: 'http://localhost:3000',
    },
  });
}

function makeWorkspaceInitiateProfile(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'workspace-profile-1',
    tenantId: 'tenant-1',
    projectId: null,
    scope: 'tenant',
    name: 'workspace-oauth',
    authType: 'oauth2_app',
    status: 'active',
    visibility: 'shared',
    createdBy: 'admin-1',
    encryptedSecrets: JSON.stringify({
      clientId: 'workspace-client',
      clientSecret: 'workspace-secret',
    }),
    config: {
      authorizationUrl: 'https://oauth.example.com/authorize',
      tokenUrl: 'https://oauth.example.com/token',
      defaultScopes: ['scope:read'],
      scopeSeparator: ' ',
    },
    ...overrides,
  };
}

function readStoredOAuthState(): Record<string, unknown> {
  const stateCreate = mockCreateOAuthState.mock.calls.at(-1);
  if (!stateCreate || typeof stateCreate[1] !== 'object' || stateCreate[1] === null) {
    throw new Error('OAuth state write was not captured');
  }
  return stateCreate[1] as Record<string, unknown>;
}

describe('workspace (admin) OAuth initiate route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.STUDIO_OAUTH_ALLOWED_ORIGINS;
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['auth-profile:write'],
    });
    mockGetRedisClient.mockReturnValue({ set: mockRedisSet, del: mockRedisDel });
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockValidateUrlForSSRF.mockReturnValue({ safe: true });
    mockCreateOAuthState.mockResolvedValue({
      state: 'test-state-123',
      csrfNonce: 'test-csrf-nonce',
    });
  });

  it('builds an auth URL using a tenant-scoped profile when authProfileId provided', async () => {
    mockFindOne.mockResolvedValueOnce(makeWorkspaceInitiateProfile());

    const response = await WorkspacePOST(
      makeWorkspaceInitiateRequest({
        connectorName: 'google',
        authProfileId: 'workspace-profile-1',
      }),
      { params: Promise.resolve({}) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.authUrl).toContain('client_id=workspace-client');
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'workspace-profile-1',
        tenantId: 'tenant-1',
        projectId: null,
        scope: 'tenant',
        authType: 'oauth2_app',
      }),
    );
  });

  it('stores workspace scope with a null projectId in the Redis state payload', async () => {
    mockFindOne.mockResolvedValueOnce(makeWorkspaceInitiateProfile());

    await WorkspacePOST(
      makeWorkspaceInitiateRequest({
        connectorName: 'google',
        authProfileId: 'workspace-profile-1',
      }),
      { params: Promise.resolve({}) },
    );

    const storedState = readStoredOAuthState();
    expect(storedState).toHaveProperty('projectId', null);
    expect(storedState.scope).toBe('workspace');
    expect(storedState.authProfileScope).toBe('tenant');
    expect(storedState.tenantId).toBe('tenant-1');
  });

  it('uses tenant lookup for authProfileRef without project fallback', async () => {
    mockFindOne.mockResolvedValueOnce(makeWorkspaceInitiateProfile({ name: 'workspace-by-name' }));

    const response = await WorkspacePOST(
      makeWorkspaceInitiateRequest({
        connectorName: 'google',
        authProfileRef: 'workspace-by-name',
      }),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    expect(mockFindOne).toHaveBeenCalledTimes(1);
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'workspace-by-name',
        projectId: null,
        scope: 'tenant',
      }),
    );
  });

  it('returns 404 when the workspace profile is not found', async () => {
    mockFindOne.mockResolvedValueOnce(null);

    const response = await WorkspacePOST(
      makeWorkspaceInitiateRequest({
        connectorName: 'google',
        authProfileId: 'missing',
      }),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(404);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('admits a pending_authorization profile (Phase 4 will hit this from the slide-over)', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeWorkspaceInitiateProfile({ status: 'pending_authorization' }),
    );

    const response = await WorkspacePOST(
      makeWorkspaceInitiateRequest({
        connectorName: 'google',
        authProfileId: 'workspace-profile-1',
      }),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    expect(mockCreateOAuthState).toHaveBeenCalled();
  });
});

// ─── ABLP-775 / DFA-6: Redis lock release on error ────────────────────
describe('workspace OAuth initiate — lock release on error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.WORKSPACE_OAUTH_ENABLED;
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['auth-profile:write'],
    });
    mockGetRedisClient.mockReturnValue({ set: mockRedisSet, del: mockRedisDel });
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockValidateUrlForSSRF.mockReturnValue({ safe: true });
  });

  function makeWsOAuthRequest(body: unknown): NextRequest {
    return new NextRequest('http://localhost:3000/api/auth-profiles/oauth/initiate', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost:3000',
      },
    });
  }

  function makeWsProfile(overrides: Record<string, unknown> = {}) {
    return {
      _id: 'ws-profile-1',
      tenantId: 'tenant-1',
      projectId: null,
      scope: 'tenant',
      name: 'ws-oauth',
      authType: 'oauth2_app',
      status: 'active',
      visibility: 'shared',
      usageMode: 'preconfigured',
      connector: 'google',
      environment: null,
      encryptedSecrets: JSON.stringify({
        clientId: 'ws-client',
        clientSecret: 'ws-secret',
      }),
      config: {
        authorizationUrl: 'https://oauth.example.com/authorize',
        tokenUrl: 'https://oauth.example.com/token',
        defaultScopes: ['scope:read'],
        scopeSeparator: ' ',
      },
      ...overrides,
    };
  }

  it('releases the Redis lock when createOAuthState throws', async () => {
    mockFindOne.mockResolvedValueOnce(makeWsProfile());
    mockCreateOAuthState.mockRejectedValueOnce(new Error('state storage failed'));

    const response = await WorkspaceOAuthPOST(
      makeWsOAuthRequest({ authProfileId: 'ws-profile-1' }),
      {
        params: Promise.resolve({}),
      },
    );

    expect(response.status).toBe(500);

    // The lock key should have been deleted on error
    expect(mockRedisDel).toHaveBeenCalledWith(
      expect.stringContaining('auth-profile:oauth-init-lock:tenant-1:ws-profile-1'),
    );
  });

  it('does NOT release the lock on successful initiation', async () => {
    mockFindOne.mockResolvedValueOnce(makeWsProfile());
    mockCreateOAuthState.mockResolvedValueOnce({
      state: 'ok-state',
      csrfNonce: 'ok-nonce',
    });

    const response = await WorkspaceOAuthPOST(
      makeWsOAuthRequest({ authProfileId: 'ws-profile-1' }),
      {
        params: Promise.resolve({}),
      },
    );

    expect(response.status).toBe(200);
    // Lock should NOT be deleted on success (600s TTL acts as rate limit)
    expect(mockRedisDel).not.toHaveBeenCalled();
  });
});
