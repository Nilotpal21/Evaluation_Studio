import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireAuth = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockEnsureDb = vi.fn();
const mockAuthProfileFindOne = vi.fn();
const mockAuthProfileUpdateOne = vi.fn();
const mockEndUserOAuthTokenFindOne = vi.fn();
const mockEndUserOAuthTokenCreate = vi.fn();
const mockEndUserOAuthTokenDeleteOne = vi.fn();
const mockGetdel = vi.fn();
const mockRedisDel = vi.fn();
const mockGetRedisClient = vi.fn();
const mockFetch = vi.fn();

const { MockAuthProfileError } = vi.hoisted(() => {
  class HoistedMockAuthProfileError extends Error {
    code: string;
    statusCode: number;

    constructor(code: string, message: string, statusCode = 400) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
    }
  }

  return {
    MockAuthProfileError: HoistedMockAuthProfileError,
  };
});

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

vi.mock('@/lib/redis-client', () => ({
  getRedisClient: () => mockGetRedisClient(),
}));

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: unknown[]) => mockAuthProfileFindOne(...args),
    updateOne: (...args: unknown[]) => mockAuthProfileUpdateOne(...args),
  },
  EndUserOAuthToken: {
    findOne: (...args: unknown[]) => mockEndUserOAuthTokenFindOne(...args),
    create: (...args: unknown[]) => mockEndUserOAuthTokenCreate(...args),
    deleteOne: (...args: unknown[]) => mockEndUserOAuthTokenDeleteOne(...args),
  },
}));

vi.mock('@agent-platform/shared/services/auth-profile', () => ({
  buildAuthProfileOAuthProviderKey: (authProfileId: string) => `auth-profile:${authProfileId}`,
  getAuthProfileMigrationState: () => null,
  AuthProfileError: MockAuthProfileError,
  emitAuthProfileAuditEvent: vi.fn().mockResolvedValue(undefined),
  mapOAuthError: vi.fn((input: { code: string; description?: string }) => ({
    code: `oauth_${input.code}`,
    adminMessage: `Mapped: ${input.description ?? input.code}`,
  })),
}));

vi.mock('@agent-platform/shared/security', () => ({
  validateUrlForSSRF: () => ({ safe: true }),
  getDevSSRFOptions: () => ({}),
}));

vi.mock('@/app/api/auth-profiles/oauth/_oauth-audit', () => ({
  emitOAuthAuditEvent: vi.fn().mockResolvedValue(undefined),
  mapIdpError: vi.fn((input: unknown) =>
    typeof input === 'string' ? `oauth_${input}` : 'provider_error',
  ),
}));

import { POST } from '@/app/api/projects/[id]/auth-profiles/oauth/callback/route';
import { AUTH_PROFILE_OAUTH_CSRF_COOKIE } from '@/app/api/auth-profiles/oauth/_oauth-state-service';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/projects/proj-1/auth-profiles/oauth/callback', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${AUTH_PROFILE_OAUTH_CSRF_COOKIE}=csrf-nonce`,
    },
  });
}

function makeAppProfile(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'app-profile-1',
    name: 'Mail App',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    scope: 'project',
    environment: null,
    visibility: 'personal',
    createdBy: 'user-1',
    authType: 'oauth2_app',
    status: 'active',
    encryptedSecrets: JSON.stringify({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    }),
    config: {
      tokenUrl: 'https://oauth.example.com/token',
    },
    ...overrides,
  };
}

function makeStatePayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    authProfileId: 'app-profile-1',
    scope: 'project',
    csrfNonce: 'csrf-nonce',
    authProfileScope: 'project',
    authProfileVisibility: 'personal',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    userId: 'user-1',
    connectorName: 'mock_mail',
    createdAt: Date.now(),
    redirectUri: 'http://localhost:3000/oauth/auth-profile-callback',
    targetVisibility: 'personal',
    scopes: ['mail.read'],
    ...overrides,
  });
}

describe('auth profile OAuth callback route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureDb.mockResolvedValue(undefined);
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['auth-profile:write'],
    });
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1' },
    });
    mockGetRedisClient.mockReturnValue({
      getdel: mockGetdel,
      del: mockRedisDel,
    });
    mockGetdel.mockResolvedValue(makeStatePayload());
    mockAuthProfileFindOne.mockResolvedValue(makeAppProfile());
    mockAuthProfileUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockEndUserOAuthTokenFindOne.mockResolvedValue(null);
    mockEndUserOAuthTokenDeleteOne.mockResolvedValue({ deletedCount: 0 });
    mockRedisDel.mockResolvedValue(1);
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    mockEndUserOAuthTokenCreate.mockResolvedValue({ _id: 'grant-1' });
    vi.stubGlobal('fetch', mockFetch);
  });

  it('rejects the callback when the linked app no longer matches the scope captured in state', async () => {
    mockGetdel.mockResolvedValue(
      makeStatePayload({
        authProfileScope: 'tenant',
        authProfileVisibility: 'shared',
        targetVisibility: 'shared',
        isUserConsent: false,
      }),
    );
    mockAuthProfileFindOne.mockResolvedValue(
      makeAppProfile({
        scope: 'project',
        visibility: 'shared',
      }),
    );

    const response = await POST(makeRequest({ code: 'auth-code', state: 'a'.repeat(64) }), {
      params: Promise.resolve({ id: 'proj-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(JSON.stringify(payload)).toContain(
      'OAuth app profile changed during authorization. Restart authorization.',
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockEndUserOAuthTokenCreate).not.toHaveBeenCalled();
  });

  it('mints a personal OAuth grant from a shared app during user-consent flows', async () => {
    mockGetdel.mockResolvedValue(
      makeStatePayload({
        authProfileVisibility: 'shared',
        targetVisibility: 'personal',
        isUserConsent: true,
      }),
    );
    mockAuthProfileFindOne.mockResolvedValue(
      makeAppProfile({
        visibility: 'shared',
        createdBy: 'admin-1',
      }),
    );

    const response = await POST(makeRequest({ code: 'auth-code', state: 'b'.repeat(64) }), {
      params: Promise.resolve({ id: 'proj-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.data).toMatchObject({
      id: 'auth-profile:app-profile-1',
      authProfileId: 'app-profile-1',
      provider: 'auth-profile:app-profile-1',
      principalScope: 'user',
      principalId: 'user-1',
      storage: 'oauth_grant_store',
      scope: 'mail.read',
    });
    expect(mockEndUserOAuthTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        profileId: 'app-profile-1',
        userId: 'user-1',
        provider: 'auth-profile:app-profile-1',
        providerUserId: 'user-1',
        encryptedAccessToken: 'access-token',
        encryptedRefreshToken: 'refresh-token',
        scope: 'mail.read',
      }),
    );
    expect(mockEndUserOAuthTokenFindOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      provider: 'auth-profile:app-profile-1',
    });
  });

  it('stores tenant-scoped shared OAuth grants under the tenant principal sentinel', async () => {
    mockGetdel.mockResolvedValue(
      makeStatePayload({
        authProfileScope: 'tenant',
        authProfileVisibility: 'shared',
        targetVisibility: 'shared',
        isUserConsent: false,
      }),
    );
    mockAuthProfileFindOne.mockResolvedValue(
      makeAppProfile({
        projectId: null,
        scope: 'tenant',
        visibility: 'shared',
        createdBy: 'admin-1',
      }),
    );

    const response = await POST(makeRequest({ code: 'auth-code', state: 'c'.repeat(64) }), {
      params: Promise.resolve({ id: 'proj-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.data).toMatchObject({
      provider: 'auth-profile:app-profile-1',
      principalScope: 'tenant',
      principalId: '__tenant__',
    });
    expect(mockEndUserOAuthTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        profileId: 'app-profile-1',
        userId: '__tenant__',
        providerUserId: '__tenant__',
        provider: 'auth-profile:app-profile-1',
      }),
    );
  });

  it('updates an existing durable OAuth grant instead of creating a duplicate auth profile', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    mockEndUserOAuthTokenFindOne.mockResolvedValue({
      tenantId: 'tenant-1',
      userId: 'user-1',
      provider: 'auth-profile:app-profile-1',
      providerUserId: 'user-1',
      encryptedAccessToken: 'old-access',
      encryptedRefreshToken: 'old-refresh',
      scope: 'mail.read',
      expiresAt: null,
      refreshedAt: null,
      consentedAt: null,
      revokedAt: new Date('2026-01-01T00:00:00.000Z'),
      save,
    });

    const response = await POST(makeRequest({ code: 'auth-code', state: 'd'.repeat(64) }), {
      params: Promise.resolve({ id: 'proj-1' }),
    });

    expect(response.status).toBe(201);
    expect(save).toHaveBeenCalledOnce();
    expect(mockEndUserOAuthTokenCreate).not.toHaveBeenCalled();
  });
});
