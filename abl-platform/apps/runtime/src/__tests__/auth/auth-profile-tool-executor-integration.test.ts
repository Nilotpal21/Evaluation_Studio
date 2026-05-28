/**
 * Auth Profile Tool Executor Integration Tests
 *
 * Validates that:
 * - Tools with auth_profile_ref resolve credentials via resolveByName()
 * - auth_profile_ref takes precedence over inline auth when both present
 * - Missing auth profile produces a clear error
 * - Config var templates in auth_profile_ref are resolved before name lookup
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn().mockReturnValue({
  catch: vi.fn(),
});
const originalFetch = globalThis.fetch;

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    find: (...args: any[]) => ({
      limit: async () => {
        const value = await mockFindOne(...args);
        if (Array.isArray(value)) {
          return value;
        }
        return value ? [value] : [];
      },
    }),
    findOne: (...args: any[]) => mockFindOne(...args),
    updateOne: (...args: any[]) => mockUpdateOne(...args),
  },
}));

const mockGetRedisClient = vi.fn();
vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: () => mockGetRedisClient(),
  getRedisHandle: () => ({
    client: mockGetRedisClient(),
    isReady: () => true,
    duplicate: () =>
      mockGetRedisClient().duplicate ? mockGetRedisClient().duplicate() : mockGetRedisClient(),
    disconnect: async () => {},
  }),
}));

const mockGetAccessToken = vi.fn();
vi.mock('../../services/tool-oauth-service-singleton.js', () => ({
  getToolOAuthService: () => ({
    getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
  }),
}));

// ---------------------------------------------------------------------------
// SUT — import the REAL resolveToolAuth, not an inline copy
// ---------------------------------------------------------------------------

import { resolveToolAuth } from '../../services/auth-profile/resolve-tool-auth.js';
import { getAuthProfileCache } from '../../services/auth-profile-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'profile-staging',
    tenantId: 'tenant-1',
    name: 'staging-api-key',
    authType: 'api_key',
    config: { headerName: 'X-API-Key' },
    encryptedSecrets: JSON.stringify({ apiKey: 'resolved-key-123' }),
    previousEncryptedSecrets: null,
    rotationGracePeriodMs: 24 * 60 * 60 * 1000,
    updatedAt: new Date(),
    lastUsedAt: new Date(),
    status: 'active',
    environment: null,
    visibility: 'shared',
    createdBy: 'user-default',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveToolAuth (real module)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear the resolver cache to prevent cross-test cache hits
    getAuthProfileCache().clear();
    mockGetRedisClient.mockReturnValue(null);
    mockGetAccessToken.mockReset();
    globalThis.fetch = originalFetch;
  });

  it('resolves auth profile by name and applies API key header', async () => {
    mockFindOne.mockResolvedValueOnce(makeProfile());

    const result = await resolveToolAuth(
      { auth_profile_ref: 'staging-api-key', name: 'my-tool' },
      'tenant-1',
    );

    expect(result.source).toBe('auth_profile');
    expect(result.headers['X-API-Key']).toBe('resolved-key-123');
  });

  it('resolves bearer auth type and applies Authorization header', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        authType: 'bearer',
        config: {},
        encryptedSecrets: JSON.stringify({ token: 'bearer-token-456' }),
      }),
    );

    const result = await resolveToolAuth(
      { auth_profile_ref: 'my-bearer-profile', name: 'my-tool' },
      'tenant-1',
    );

    expect(result.source).toBe('auth_profile');
    expect(result.headers['Authorization']).toBe('Bearer bearer-token-456');
  });

  it('fails closed when auth_profile_ref points to a legacy oauth2_token profile', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        _id: 'token-profile',
        authType: 'oauth2_token',
        scope: 'project',
        visibility: 'shared',
        projectId: 'project-1',
        linkedAppProfileId: 'app-1',
        config: { provider: 'google' },
        encryptedSecrets: JSON.stringify({ accessToken: 'oauth-token-123' }),
      }),
    );

    await expect(
      resolveToolAuth(
        { auth_profile_ref: 'google-token', name: 'my-tool' },
        'tenant-1',
        undefined,
        { projectId: 'project-1' },
      ),
    ).rejects.toThrow('AUTH_PROFILE_NOT_FOUND');
  });

  it('requires a durable grant when an oauth2_app ref has no token in the grant store', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        _id: 'app-1',
        name: 'google-app',
        authType: 'oauth2_app',
        scope: 'project',
        visibility: 'personal',
        createdBy: 'user-1',
        projectId: 'project-1',
      }),
    );
    mockGetAccessToken.mockResolvedValue(undefined);

    await expect(
      resolveToolAuth(
        {
          auth_profile_ref: 'google-app',
          name: 'my-tool',
          http_binding: {
            endpoint: 'https://example.com',
            method: 'GET',
            auth: {
              type: 'oauth2',
              config: {
                oauth: {
                  scopes: ['gmail.readonly'],
                },
              },
            },
          },
        },
        'tenant-1',
        undefined,
        { projectId: 'project-1', userId: 'user-1' },
      ),
    ).rejects.toThrow('AUTH_PROFILE_TOKEN_REQUIRED');
  });

  it('fails closed when an oauth2_token profile ref is used even if the linked oauth2_app is valid', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        _id: 'token-profile',
        authType: 'oauth2_token',
        scope: 'project',
        visibility: 'shared',
        projectId: 'project-1',
        linkedAppProfileId: 'app-1',
        config: { provider: 'google' },
        encryptedSecrets: JSON.stringify({ accessToken: 'oauth-token-123' }),
      }),
    );

    await expect(
      resolveToolAuth(
        { auth_profile_ref: 'google-token', name: 'my-tool' },
        'tenant-1',
        undefined,
        { projectId: 'project-1' },
      ),
    ).rejects.toThrow('AUTH_PROFILE_NOT_FOUND');
  });

  it('exchanges oauth2_client_credentials profiles into a bearer token', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        authType: 'oauth2_client_credentials',
        config: {
          tokenUrl: 'https://oauth.example.com/token',
          scopes: ['read:all'],
          audience: 'https://api.example.com/',
        },
        encryptedSecrets: JSON.stringify({
          clientId: 'client-id',
          clientSecret: 'client-secret',
        }),
      }),
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'cc-access-token',
        expires_in: 3600,
      }),
    }) as unknown as typeof globalThis.fetch;

    const result = await resolveToolAuth(
      { auth_profile_ref: 'client-creds-profile', name: 'my-tool' },
      'tenant-1',
    );

    expect(result.headers['Authorization']).toBe('Bearer cc-access-token');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://oauth.example.com/token',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const requestInit = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as
      | RequestInit
      | undefined;
    const body = requestInit?.body;
    const encodedBody =
      body instanceof URLSearchParams ? body.toString() : body ? String(body) : undefined;
    expect(encodedBody).toContain('audience=https%3A%2F%2Fapi.example.com%2F');
  });

  it('accepts legacy oauth2_client_credentials config.scope string', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        authType: 'oauth2_client_credentials',
        config: {
          tokenUrl: 'https://oauth.example.com/token',
          scope: 'read,write',
        },
        encryptedSecrets: JSON.stringify({
          clientId: 'client-id',
          clientSecret: 'client-secret',
        }),
      }),
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'legacy-cc-access-token',
        expires_in: 3600,
      }),
    }) as unknown as typeof globalThis.fetch;

    const result = await resolveToolAuth(
      { auth_profile_ref: 'legacy-client-creds-profile', name: 'my-tool' },
      'tenant-1',
    );

    expect(result.headers['Authorization']).toBe('Bearer legacy-cc-access-token');
    const requestInit = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as
      | RequestInit
      | undefined;
    const body = requestInit?.body;
    const encodedBody =
      body instanceof URLSearchParams ? body.toString() : body ? String(body) : undefined;
    expect(encodedBody).toContain('scope=read+write');
  });

  it('auth_profile_ref takes precedence over inline auth', async () => {
    mockFindOne.mockResolvedValueOnce(makeProfile());

    const result = await resolveToolAuth(
      {
        auth_profile_ref: 'staging-api-key',
        name: 'my-tool',
        http_binding: {
          endpoint: 'https://example.com',
          method: 'GET',
          auth: { type: 'bearer' },
        },
      },
      'tenant-1',
    );

    // Should use auth profile, not inline bearer
    expect(result.source).toBe('auth_profile');
    expect(result.authType).toBe('api_key');
    expect(result.headers['X-API-Key']).toBe('resolved-key-123');
    expect(result.headers['Authorization']).toBeUndefined();
    expect(result.secrets).toEqual({ apiKey: 'resolved-key-123' });
  });

  it('throws clear error when auth profile not found', async () => {
    mockFindOne.mockResolvedValueOnce(null);

    await expect(
      resolveToolAuth({ auth_profile_ref: 'missing-profile', name: 'my-tool' }, 'tenant-1'),
    ).rejects.toThrow('AUTH_PROFILE_NOT_FOUND');
  });

  it('throws descriptive error for jit_auth when profile not found', async () => {
    mockFindOne.mockResolvedValueOnce(null);

    await expect(
      resolveToolAuth(
        { auth_profile_ref: 'missing-profile', jit_auth: true, name: 'my-tool' },
        'tenant-1',
      ),
    ).rejects.toThrow('JIT auth will trigger user consent');
  });

  it('falls back to inline auth when no auth_profile_ref', async () => {
    const result = await resolveToolAuth(
      {
        name: 'my-tool',
        http_binding: {
          endpoint: 'https://example.com',
          method: 'GET',
          auth: { type: 'bearer' },
        },
      },
      'tenant-1',
    );

    expect(result.source).toBe('inline');
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('returns none when no auth configured', async () => {
    const result = await resolveToolAuth({ name: 'my-tool' }, 'tenant-1');

    expect(result.source).toBe('none');
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('resolves config var template in auth_profile_ref', async () => {
    const mockConfigVarStore = {
      findConfigVar: vi.fn().mockResolvedValueOnce({ value: 'prod-api-key' }),
    };

    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        name: 'prod-api-key',
        encryptedSecrets: JSON.stringify({ apiKey: 'prod-key-789' }),
      }),
    );

    const result = await resolveToolAuth(
      { auth_profile_ref: '{{config.AUTH_PROFILE}}', name: 'my-tool' },
      'tenant-1',
      undefined,
      { projectId: 'project-1', configVarStore: mockConfigVarStore },
    );

    expect(result.source).toBe('auth_profile');
    expect(result.headers['X-API-Key']).toBe('prod-key-789');
    expect(mockConfigVarStore.findConfigVar).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      key: 'AUTH_PROFILE',
    });
  });

  it('throws when config var cannot be resolved', async () => {
    const mockConfigVarStore = {
      findConfigVar: vi.fn().mockResolvedValueOnce(null),
    };

    await expect(
      resolveToolAuth(
        { auth_profile_ref: '{{config.MISSING_VAR}}', name: 'my-tool' },
        'tenant-1',
        undefined,
        { projectId: 'project-1', configVarStore: mockConfigVarStore },
      ),
    ).rejects.toThrow('AUTH_PROFILE_CONFIG_VAR_NOT_FOUND');
  });

  it('passes projectId and userId through to the resolver query', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        projectId: 'project-1',
        visibility: 'personal',
        createdBy: 'user-1',
      }),
    );

    await resolveToolAuth(
      { auth_profile_ref: 'staging-api-key', name: 'my-tool' },
      'tenant-1',
      'staging',
      { projectId: 'project-1', userId: 'user-1' },
    );

    const query = mockFindOne.mock.calls[0][0];
    expect(query).toEqual(
      expect.objectContaining({
        environment: 'staging',
        visibility: 'personal',
        createdBy: 'user-1',
      }),
    );
    expect(query.$and).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          $or: expect.arrayContaining([
            expect.objectContaining({
              projectId: 'project-1',
            }),
          ]),
        }),
      ]),
    );
  });

  it('keeps shared oauth2_app auth session-scoped for anonymous SDK callers', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        name: 'google-oauth',
        authType: 'oauth2_app',
        config: { provider: 'google' },
      }),
    );
    mockGetAccessToken.mockResolvedValueOnce('session-scoped-token');

    const result = await resolveToolAuth(
      {
        auth_profile_ref: 'google-oauth',
        name: 'my-tool',
        connection_mode: 'shared',
      },
      'tenant-1',
      undefined,
      {
        projectId: 'project-1',
        sessionPrincipalId: 'sdk-session-1',
        authScope: 'session',
      },
    );

    expect(result.source).toBe('auth_profile');
    expect(result.headers['Authorization']).toBe('Bearer session-scoped-token');
    expect(mockGetAccessToken).toHaveBeenCalledWith('tenant-1', 'sdk-session-1', 'google-oauth', {
      projectId: 'project-1',
      environment: undefined,
      scopes: [],
      lookupScope: 'user',
      preferAuthProfile: true,
      authScope: 'session',
    });
  });

  it('keeps auth profile lookup user-scoped while storing session auth under the session principal', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        name: 'google-oauth',
        authType: 'oauth2_app',
        visibility: 'personal',
        createdBy: 'profile-owner-1',
        config: { provider: 'google' },
      }),
    );
    mockGetAccessToken.mockResolvedValueOnce('session-scoped-token');

    const result = await resolveToolAuth(
      {
        auth_profile_ref: 'google-oauth',
        name: 'my-tool',
        connection_mode: 'per_user',
      },
      'tenant-1',
      undefined,
      {
        projectId: 'project-1',
        userId: 'profile-owner-1',
        sessionPrincipalId: 'sdk-session-22',
        authScope: 'session',
      },
    );

    expect(result.source).toBe('auth_profile');
    expect(result.headers['Authorization']).toBe('Bearer session-scoped-token');
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        visibility: 'personal',
        createdBy: 'profile-owner-1',
      }),
    );
    expect(mockGetAccessToken).toHaveBeenCalledWith('tenant-1', 'sdk-session-22', 'google-oauth', {
      projectId: 'project-1',
      environment: undefined,
      scopes: [],
      lookupScope: 'user',
      preferAuthProfile: true,
      authScope: 'session',
    });
  });

  it('continues to use tenant-scoped auth for shared oauth2_app callers outside SDK session scope', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        name: 'google-oauth',
        authType: 'oauth2_app',
        config: { provider: 'google' },
      }),
    );
    mockGetAccessToken.mockResolvedValueOnce('tenant-scoped-token');

    const result = await resolveToolAuth(
      {
        auth_profile_ref: 'google-oauth',
        name: 'my-tool',
        connection_mode: 'shared',
      },
      'tenant-1',
      undefined,
      {
        projectId: 'project-1',
        userId: 'channel-user-1',
      },
    );

    expect(result.source).toBe('auth_profile');
    expect(result.headers['Authorization']).toBe('Bearer tenant-scoped-token');
    expect(mockGetAccessToken).toHaveBeenCalledWith('tenant-1', '__tenant__', 'google-oauth', {
      projectId: 'project-1',
      environment: undefined,
      scopes: [],
      lookupScope: 'tenant',
      preferAuthProfile: true,
      authScope: 'tenant',
    });
  });

  it('falls back to profile connectionMode when tool connection_mode is missing', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        name: 'google-oauth',
        authType: 'oauth2_app',
        connectionMode: 'shared',
        config: { provider: 'google' },
      }),
    );
    mockGetAccessToken.mockResolvedValueOnce('tenant-scoped-token');

    const result = await resolveToolAuth(
      {
        auth_profile_ref: 'google-oauth',
        name: 'my-tool',
      },
      'tenant-1',
      undefined,
      {
        projectId: 'project-1',
      },
    );

    expect(result.source).toBe('auth_profile');
    expect(result.headers['Authorization']).toBe('Bearer tenant-scoped-token');
    expect(mockGetAccessToken).toHaveBeenCalledWith('tenant-1', '__tenant__', 'google-oauth', {
      projectId: 'project-1',
      environment: undefined,
      scopes: [],
      lookupScope: 'tenant',
      preferAuthProfile: true,
      authScope: 'tenant',
    });
  });

  it('defaults legacy shared-visibility oauth2_app profiles to tenant lookup when mode is missing', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        name: 'legacy-shared-oauth',
        authType: 'oauth2_app',
        visibility: 'shared',
        connectionMode: undefined,
        config: { provider: 'google' },
      }),
    );
    mockGetAccessToken.mockResolvedValueOnce('tenant-shared-token');

    const result = await resolveToolAuth(
      {
        auth_profile_ref: 'legacy-shared-oauth',
        name: 'my-tool',
      },
      'tenant-1',
      undefined,
      {
        projectId: 'project-1',
      },
    );

    expect(result.source).toBe('auth_profile');
    expect(result.headers['Authorization']).toBe('Bearer tenant-shared-token');
    expect(mockGetAccessToken).toHaveBeenCalledWith(
      'tenant-1',
      '__tenant__',
      'legacy-shared-oauth',
      {
        projectId: 'project-1',
        environment: undefined,
        scopes: [],
        lookupScope: 'tenant',
        preferAuthProfile: true,
        authScope: 'tenant',
      },
    );
  });

  it('uses shared compatibility principal when tenant grant is missing in non-interactive context', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        _id: 'legacy-shared-app',
        name: 'legacy-shared-app',
        authType: 'oauth2_app',
        visibility: 'shared',
        createdBy: 'owner-user-1',
        connectionMode: 'shared',
        config: { provider: 'google' },
      }),
    );
    mockGetAccessToken.mockResolvedValueOnce(undefined).mockResolvedValueOnce('owner-grant-token');

    const result = await resolveToolAuth(
      {
        auth_profile_ref: 'legacy-shared-app',
        name: 'my-tool',
      },
      'tenant-1',
      undefined,
      {
        projectId: 'project-1',
      },
    );

    expect(result.source).toBe('auth_profile');
    expect(result.headers['Authorization']).toBe('Bearer owner-grant-token');
    expect(mockGetAccessToken).toHaveBeenNthCalledWith(
      1,
      'tenant-1',
      '__tenant__',
      'legacy-shared-app',
      {
        projectId: 'project-1',
        environment: undefined,
        scopes: [],
        lookupScope: 'tenant',
        preferAuthProfile: true,
        authScope: 'tenant',
      },
    );
    expect(mockGetAccessToken).toHaveBeenNthCalledWith(
      2,
      'tenant-1',
      'owner-user-1',
      'legacy-shared-app',
      {
        projectId: 'project-1',
        environment: undefined,
        scopes: [],
        lookupScope: 'user',
        preferAuthProfile: true,
        authScope: 'user',
      },
    );
  });
});
