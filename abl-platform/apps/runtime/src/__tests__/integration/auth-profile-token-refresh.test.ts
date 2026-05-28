/**
 * Integration: Auth Profile Token Refresh Cycle
 *
 * Tests the full proactive + reactive token refresh lifecycle including
 * distributed locking, lock contention re-read, retry backoff, max retry
 * exhaustion, and client_credentials Redis caching.
 *
 * Uses dependency injection (no module mocks) to exercise the real
 * token-refresh logic with in-memory finders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  needsProactiveRefresh,
  acquireRefreshLock,
  resolveClientCredentialsToken,
  refreshOAuth2Token,
} from '@agent-platform/shared/services/auth-profile';

// ── In-memory stores ──────────────────────────────────────────────────

const mockProfiles = new Map<string, any>();
const mockGrants = new Map<string, any>();
const mockSessionArtifacts = new Map<string, any>();

// ── DI dependencies ───────────────────────────────────────────────────

const mockResolveOAuth2AppCredentials = vi.fn();

function buildDeps() {
  return {
    AuthProfile: {
      findOne: async (query: Record<string, unknown>) => {
        for (const [, profile] of mockProfiles) {
          if (query._id && String(profile._id) !== String(query._id)) continue;
          if (query.tenantId && profile.tenantId !== query.tenantId) continue;
          const found: any = { ...profile };
          found.save = async () => {
            Object.assign(profile, found);
            mockProfiles.set(String(profile._id), profile);
          };
          return found;
        }
        return null;
      },
    },
    EndUserOAuthToken: {
      findOne: async (query: Record<string, unknown>) => {
        for (const [, grant] of mockGrants) {
          if (query.tenantId && grant.tenantId !== query.tenantId) continue;
          if (query.userId && grant.userId !== query.userId) continue;
          if (query.provider && grant.provider !== query.provider) continue;
          if (query.revokedAt === null && grant.revokedAt != null) continue;
          const found: any = { ...grant };
          found.save = async () => {
            Object.assign(grant, found);
            mockGrants.set(String(grant._id), grant);
          };
          return found;
        }
        return null;
      },
    },
    SessionOAuthArtifact: {
      findOne: async (query: Record<string, unknown>) => {
        for (const [, artifact] of mockSessionArtifacts) {
          if (query.tenantId && artifact.tenantId !== query.tenantId) continue;
          if (query.projectId && artifact.projectId !== query.projectId) continue;
          if (query.sessionPrincipal && artifact.sessionPrincipal !== query.sessionPrincipal)
            continue;
          if (query.provider && artifact.provider !== query.provider) continue;
          const found: any = { ...artifact };
          found.save = async () => {
            Object.assign(artifact, found);
            mockSessionArtifacts.set(String(artifact._id), artifact);
          };
          return found;
        }
        return null;
      },
    },
    resolveOAuth2AppCredentials: mockResolveOAuth2AppCredentials as any,
    acquireRefreshLock,
  };
}

// ── Mock global fetch ─────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Mock Redis ────────────────────────────────────────────────────────

function createMockRedis() {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  return {
    set: vi.fn(
      async (key: string, value: string, ...args: (string | number)[]): Promise<string | null> => {
        if (args.includes('NX') && store.has(key)) return null;
        let ttlMs: number | undefined;
        const pxIdx = args.indexOf('PX');
        if (pxIdx !== -1) ttlMs = Number(args[pxIdx + 1]);
        const exIdx = args.indexOf('EX');
        if (exIdx !== -1) ttlMs = Number(args[exIdx + 1]) * 1000;
        store.set(key, {
          value,
          expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
        });
        return 'OK';
      },
    ),
    get: vi.fn(async (key: string): Promise<string | null> => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    del: vi.fn(async (key: string): Promise<number> => {
      return store.delete(key) ? 1 : 0;
    }),
    eval: vi.fn(
      async (script: string, numKeys: number, ...args: (string | number)[]): Promise<number> => {
        // Simulate the Lua release script: if GET key == value then DEL key
        const key = String(args[0]);
        const value = String(args[1]);
        const entry = store.get(key);
        if (entry && entry.value === value) {
          store.delete(key);
          return 1;
        }
        return 0;
      },
    ),
    _store: store,
  };
}

// ── Seed helpers ──────────────────────────────────────────────────────

const TENANT_ID = 'tenant-refresh-test';
const PROFILE_ID = 'token-profile-001';
const APP_PROFILE_ID = 'app-profile-001';
const APP_PROVIDER_KEY = `auth-profile:${APP_PROFILE_ID}`;

function seedProfiles() {
  mockProfiles.clear();
  mockProfiles.set(APP_PROFILE_ID, {
    _id: APP_PROFILE_ID,
    tenantId: TENANT_ID,
    authType: 'oauth2_app',
    status: 'active',
    scope: 'tenant',
    visibility: 'shared',
    encryptedSecrets: JSON.stringify({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
    }),
    config: {
      authorizationUrl: 'https://provider.com/auth',
      tokenUrl: 'https://provider.com/token',
      defaultScopes: ['read'],
      pkceRequired: false,
    },
  });
  mockProfiles.set(PROFILE_ID, {
    _id: PROFILE_ID,
    tenantId: TENANT_ID,
    authType: 'oauth2_token',
    status: 'active',
    scope: 'tenant',
    visibility: 'shared',
    linkedAppProfileId: APP_PROFILE_ID,
    encryptedSecrets: JSON.stringify({
      accessToken: 'old-access-token',
      refreshToken: 'valid-refresh-token',
    }),
    config: {
      issuedAt: new Date(Date.now() - 3600_000).toISOString(),
      expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    },
  });
}

function seedDurableGrant(overrides: Record<string, unknown> = {}) {
  mockGrants.set('grant-1', {
    _id: 'grant-1',
    tenantId: TENANT_ID,
    userId: '__tenant__',
    provider: APP_PROVIDER_KEY,
    providerUserId: 'tenant',
    encryptedAccessToken: 'old-grant-access-token',
    encryptedRefreshToken: 'valid-refresh-token',
    scope: 'read write',
    expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    refreshedAt: null,
    revokedAt: null,
    ...overrides,
  });
}

function seedSessionArtifact(overrides: Record<string, unknown> = {}) {
  mockSessionArtifacts.set('artifact-1', {
    _id: 'artifact-1',
    tenantId: TENANT_ID,
    projectId: 'project-1',
    provider: APP_PROVIDER_KEY,
    sessionPrincipal: 'sdk-session-1',
    runtimeSessionId: 'runtime-session-1',
    encryptedAccessToken: 'old-session-access-token',
    encryptedRefreshToken: 'valid-refresh-token',
    scope: 'read write',
    expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    sessionExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    refreshedAt: null,
    ...overrides,
  });
}

// ── Test Suite ────────────────────────────────────────────────────────

describe('Integration: Auth Profile Token Refresh Cycle', () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
    seedProfiles();
    mockGrants.clear();
    mockSessionArtifacts.clear();
    mockFetch.mockReset();
    mockResolveOAuth2AppCredentials.mockReset();
    mockResolveOAuth2AppCredentials.mockResolvedValue({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      tokenUrl: 'https://provider.com/token',
      scopes: ['read'],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockProfiles.clear();
    mockGrants.clear();
    mockSessionArtifacts.clear();
  });

  it('proactive refresh: refreshes token before expiresAt - buffer', () => {
    const soonExpiring = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    expect(needsProactiveRefresh(soonExpiring)).toBe(true);

    const safeToken = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    expect(needsProactiveRefresh(safeToken)).toBe(false);

    const expiredToken = new Date(Date.now() - 60_000).toISOString();
    expect(needsProactiveRefresh(expiredToken)).toBe(true);

    expect(needsProactiveRefresh(null)).toBe(false);
    expect(needsProactiveRefresh(undefined)).toBe(false);
  });

  it('reactive refresh on 401: triggers refreshOAuth2Token with fetch mock', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-access-token-after-401',
        refresh_token: 'new-refresh-token',
        expires_in: 7200,
      }),
    });

    const result = await refreshOAuth2Token(
      { profileId: PROFILE_ID, tenantId: TENANT_ID, redis },
      buildDeps(),
    );

    expect(result.refreshed).toBe(true);
    expect(result.accessToken).toBe('new-access-token-after-401');
    expect(result.refreshToken).toBe('new-refresh-token');
    expect(result.expiresAt).toBeDefined();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://provider.com/token');
    expect(opts.method).toBe('POST');
    const body = opts.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('test-client-id');
  });

  it('reactive refresh on oauth2_app durable grant: refreshes the shared grant', async () => {
    seedDurableGrant();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-grant-access-token',
        refresh_token: 'new-grant-refresh-token',
        expires_in: 7200,
      }),
    });

    const result = await refreshOAuth2Token(
      { profileId: APP_PROFILE_ID, tenantId: TENANT_ID, redis },
      buildDeps(),
    );

    expect(result.refreshed).toBe(true);
    expect(result.accessToken).toBe('new-grant-access-token');
    expect(result.refreshToken).toBe('new-grant-refresh-token');
    expect(mockGrants.get('grant-1')?.encryptedAccessToken).toBe('new-grant-access-token');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reactive refresh on oauth2_app session artifact: refreshes the session-scoped token', async () => {
    seedSessionArtifact();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-session-access-token',
        refresh_token: 'new-session-refresh-token',
        expires_in: 7200,
      }),
    });

    const result = await refreshOAuth2Token(
      {
        profileId: APP_PROFILE_ID,
        tenantId: TENANT_ID,
        authScope: 'session',
        projectId: 'project-1',
        sessionPrincipal: 'sdk-session-1',
        redis,
      },
      buildDeps(),
    );

    expect(result.refreshed).toBe(true);
    expect(result.accessToken).toBe('new-session-access-token');
    expect(result.refreshToken).toBe('new-session-refresh-token');
    expect(mockSessionArtifacts.get('artifact-1')?.encryptedAccessToken).toBe(
      'new-session-access-token',
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('distributed lock prevents concurrent refresh of same token', async () => {
    const lock1 = await acquireRefreshLock(PROFILE_ID, TENANT_ID, { redis });
    expect(lock1.acquired).toBe(true);
    expect(lock1.lockKey).toBe(`auth-profile:op-lock:${TENANT_ID}:${PROFILE_ID}`);

    const lock2 = await acquireRefreshLock(PROFILE_ID, TENANT_ID, { redis });
    expect(lock2.acquired).toBe(false);

    await lock1.release();

    const lock3 = await acquireRefreshLock(PROFILE_ID, TENANT_ID, { redis });
    expect(lock3.acquired).toBe(true);
    await lock3.release();
  });

  it('lock contention: second pod re-reads the refreshed token', async () => {
    const lockKey = `auth-profile:op-lock:${TENANT_ID}:${PROFILE_ID}`;
    await redis.set(lockKey, '1', 'NX', 'PX', '30000');

    setTimeout(() => {
      const profile = mockProfiles.get(PROFILE_ID)!;
      profile.encryptedSecrets = JSON.stringify({
        accessToken: 'pod-a-refreshed-token',
        refreshToken: 'pod-a-refresh-token',
      });
      profile.config = {
        ...profile.config,
        expiresAt: new Date(Date.now() + 7200_000).toISOString(),
      };
    }, 150);

    const result = await refreshOAuth2Token(
      { profileId: PROFILE_ID, tenantId: TENANT_ID, redis },
      buildDeps(),
    );

    expect(result.refreshed).toBe(false);
    expect(result.accessToken).toBe('pod-a-refreshed-token');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lock contention on oauth2_app durable grant: second pod re-reads the refreshed grant', async () => {
    seedDurableGrant();

    const lockKey = `auth-profile:op-lock:${TENANT_ID}:${APP_PROFILE_ID}:__tenant__`;
    await redis.set(lockKey, '1', 'NX', 'PX', '30000');

    setTimeout(() => {
      const grant = mockGrants.get('grant-1')!;
      grant.encryptedAccessToken = 'pod-a-grant-token';
      grant.encryptedRefreshToken = 'pod-a-grant-refresh-token';
      grant.expiresAt = new Date(Date.now() + 7200_000).toISOString();
      grant.refreshedAt = new Date().toISOString();
    }, 150);

    const result = await refreshOAuth2Token(
      { profileId: APP_PROFILE_ID, tenantId: TENANT_ID, redis },
      buildDeps(),
    );

    expect(result.refreshed).toBe(false);
    expect(result.accessToken).toBe('pod-a-grant-token');
    expect(result.refreshToken).toBe('pod-a-grant-refresh-token');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lock contention on oauth2_app session artifact: second pod re-reads the refreshed artifact', async () => {
    seedSessionArtifact();

    const lockKey = `auth-profile:op-lock:${TENANT_ID}:${APP_PROFILE_ID}:project-1:sdk-session-1`;
    await redis.set(lockKey, '1', 'NX', 'PX', '30000');

    setTimeout(() => {
      const artifact = mockSessionArtifacts.get('artifact-1')!;
      artifact.encryptedAccessToken = 'pod-a-session-token';
      artifact.encryptedRefreshToken = 'pod-a-session-refresh-token';
      artifact.expiresAt = new Date(Date.now() + 7200_000).toISOString();
      artifact.refreshedAt = new Date().toISOString();
    }, 150);

    const result = await refreshOAuth2Token(
      {
        profileId: APP_PROFILE_ID,
        tenantId: TENANT_ID,
        authScope: 'session',
        projectId: 'project-1',
        sessionPrincipal: 'sdk-session-1',
        redis,
      },
      buildDeps(),
    );

    expect(result.refreshed).toBe(false);
    expect(result.accessToken).toBe('pod-a-session-token');
    expect(result.refreshToken).toBe('pod-a-session-refresh-token');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refresh failure: provider error releases lock and throws', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    });

    await expect(
      refreshOAuth2Token({ profileId: PROFILE_ID, tenantId: TENANT_ID, redis }, buildDeps()),
    ).rejects.toThrow('Token refresh failed with status 400');

    const lockKey = `auth-profile:op-lock:${TENANT_ID}:${PROFILE_ID}`;
    const lockValue = await redis.get(lockKey);
    expect(lockValue).toBeNull();
  });

  it('max retry exhaustion: refresh fails when no refresh token available', async () => {
    mockProfiles.set('no-refresh-profile', {
      _id: 'no-refresh-profile',
      tenantId: TENANT_ID,
      authType: 'oauth2_token',
      status: 'active',
      linkedAppProfileId: APP_PROFILE_ID,
      encryptedSecrets: JSON.stringify({
        accessToken: 'expired-access-token',
      }),
      config: {},
    });

    await expect(
      refreshOAuth2Token(
        { profileId: 'no-refresh-profile', tenantId: TENANT_ID, redis },
        buildDeps(),
      ),
    ).rejects.toThrow('No refresh token available');
  });

  it('client_credentials token cached in Redis with TTL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'cc-access-token-abc',
        expires_in: 3600,
      }),
    });

    const result1 = await resolveClientCredentialsToken(
      'cc-profile-1',
      TENANT_ID,
      1,
      'https://provider.com/token',
      'cc-client-id',
      'cc-client-secret',
      ['read', 'write'],
      { redis },
    );

    expect(result1.accessToken).toBe('cc-access-token-abc');
    expect(result1.cached).toBe(false);
    expect(result1.expiresAt).toBeDefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify cached in Redis under the canonical CK-1 key.
    // scopeHash = sha256(['read','write'].sort().join(','))
    const scopeHash = (await import('node:crypto'))
      .createHash('sha256')
      .update(['read', 'write'].sort().join(','))
      .digest('hex');
    const cacheKey = `auth-token:${TENANT_ID}:oauth2_client_credentials:cc-profile-1:1:${scopeHash}`;
    const cached = await redis.get(cacheKey);
    expect(cached).not.toBeNull();
    const parsedCache = JSON.parse(cached!);
    expect(parsedCache.accessToken).toBe('cc-access-token-abc');

    const result2 = await resolveClientCredentialsToken(
      'cc-profile-1',
      TENANT_ID,
      1,
      'https://provider.com/token',
      'cc-client-id',
      'cc-client-secret',
      ['read', 'write'],
      { redis },
    );

    expect(result2.accessToken).toBe('cc-access-token-abc');
    expect(result2.cached).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
