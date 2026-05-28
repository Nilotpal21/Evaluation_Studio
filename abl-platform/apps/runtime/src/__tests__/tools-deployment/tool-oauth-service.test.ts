/**
 * Tool OAuth Service Tests
 *
 * Verifies the OAuth 2.0 authorization code flow for end-user tool access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolOAuthService, RedisOAuthStateStore } from '../../services/tool-oauth-service.js';
import type {
  OAuthTokenStore,
  OAuthEncryptor,
  OAuthProviderConfig,
  OAuthStateStore,
  OAuthRedisClient,
  PendingOAuthState,
  SessionOAuthArtifactStore,
} from '../../services/tool-oauth-service.js';

function createMockStore(): OAuthTokenStore & { tokens: Map<string, any> } {
  const tokens = new Map<string, any>();
  const key = (tenantId: string, userId: string, provider: string) =>
    `${tenantId}:${userId}:${provider}`;

  return {
    tokens,
    findToken: vi.fn(async (tenantId, userId, provider) => {
      return tokens.get(key(tenantId, userId, provider)) ?? null;
    }),
    upsertToken: vi.fn(async (params) => {
      tokens.set(key(params.tenantId, params.userId, params.provider), {
        encryptedAccessToken: params.encryptedAccessToken,
        encryptedRefreshToken: params.encryptedRefreshToken ?? null,
        scope: params.scope,
        expiresAt: params.expiresAt ?? null,
        version:
          (tokens.get(key(params.tenantId, params.userId, params.provider))?.version ?? -1) + 1,
      });
    }),
    compareAndSwapToken: vi.fn(async (params) => {
      const current = tokens.get(key(params.tenantId, params.userId, params.provider)) ?? null;
      const currentVersion = current?.version ?? null;
      if (currentVersion !== params.expectedVersion) {
        return false;
      }
      if (params.next.kind === 'revoke') {
        tokens.delete(key(params.tenantId, params.userId, params.provider));
        return true;
      }
      tokens.set(key(params.tenantId, params.userId, params.provider), {
        ...params.next.token,
        version: params.expectedVersion == null ? 0 : params.expectedVersion + 1,
      });
      return true;
    }),
    markRevoked: vi.fn(async (tenantId, userId, provider) => {
      tokens.delete(key(tenantId, userId, provider));
    }),
    updateLastUsed: vi.fn(async () => {}),
  };
}

function createMockEncryptor(): OAuthEncryptor {
  return {
    encryptForTenant: vi.fn((plain, tenantId) => `enc:${tenantId}:${plain}`),
    decryptForTenant: vi.fn((encrypted, _tenantId) => {
      const parts = encrypted.split(':');
      return parts.slice(2).join(':');
    }),
  };
}

function createMockSessionArtifactStore(): SessionOAuthArtifactStore & {
  tokens: Map<string, any>;
} {
  const tokens = new Map<string, any>();
  const key = (tenantId: string, projectId: string, sessionPrincipal: string, provider: string) =>
    `${tenantId}:${projectId}:${sessionPrincipal}:${provider}`;

  return {
    tokens,
    findToken: vi.fn(async (params) => {
      return (
        tokens.get(
          key(params.tenantId, params.projectId, params.sessionPrincipal, params.provider),
        ) ?? null
      );
    }),
    upsertToken: vi.fn(async (params) => {
      const artifactKey = key(
        params.tenantId,
        params.projectId,
        params.sessionPrincipal,
        params.provider,
      );
      tokens.set(artifactKey, {
        encryptedAccessToken: params.encryptedAccessToken,
        encryptedRefreshToken: params.encryptedRefreshToken ?? null,
        scope: params.scope,
        expiresAt: params.expiresAt ?? null,
        sessionId: params.sessionId,
        channelId: params.channelId ?? null,
        authProfileId: params.authProfileId ?? null,
        authProfileRef: params.authProfileRef ?? null,
        sessionExpiresAt: params.sessionExpiresAt,
        version: (tokens.get(artifactKey)?.version ?? -1) + 1,
      });
    }),
    compareAndSwapToken: vi.fn(async (params) => {
      const artifactKey = key(
        params.tenantId,
        params.projectId,
        params.sessionPrincipal,
        params.provider,
      );
      const current = tokens.get(artifactKey) ?? null;
      const currentVersion = current?.version ?? null;
      if (currentVersion !== params.expectedVersion) {
        return false;
      }
      if (params.next.kind === 'revoke') {
        tokens.delete(artifactKey);
        return true;
      }
      tokens.set(artifactKey, {
        ...params.next.token,
        sessionId: params.sessionId,
        channelId: params.channelId ?? null,
        authProfileId: params.authProfileId ?? null,
        authProfileRef: params.authProfileRef ?? null,
        sessionExpiresAt: params.sessionExpiresAt,
        version: params.expectedVersion == null ? 0 : params.expectedVersion + 1,
      });
      return true;
    }),
    deleteBySessionId: vi.fn(async (sessionId) => {
      let deleted = 0;
      for (const [artifactKey, artifact] of tokens.entries()) {
        if (artifact.sessionId === sessionId) {
          tokens.delete(artifactKey);
          deleted++;
        }
      }
      return deleted;
    }),
    updateLastUsed: vi.fn(async () => {}),
  };
}

function createProviderConfigs(): Map<string, OAuthProviderConfig> {
  return new Map([
    [
      'google',
      {
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        revokeUrl: 'https://oauth2.googleapis.com/revoke',
        scopes: ['calendar.readonly'],
      },
    ],
    [
      'slack',
      {
        clientId: 'slack-client-id',
        clientSecret: 'slack-client-secret',
        authorizeUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        scopes: ['chat:write'],
      },
    ],
  ]);
}

/**
 * A shared-Map-backed OAuthStateStore for testing multi-pod scenarios.
 * Two instances backed by the same Map simulate two pods sharing Redis.
 */
function createSharedMapStateStore(sharedMap: Map<string, PendingOAuthState>): OAuthStateStore {
  return {
    async set(state: string, data: PendingOAuthState): Promise<void> {
      sharedMap.set(state, data);
    },
    async getAndDelete(state: string): Promise<PendingOAuthState | null> {
      const data = sharedMap.get(state) ?? null;
      if (data) sharedMap.delete(state);
      return data;
    },
  };
}

function createMockRedisClient(overrides?: Partial<OAuthRedisClient>): OAuthRedisClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    getdel: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

describe('RedisOAuthStateStore', () => {
  let redis: OAuthRedisClient;
  let stateStore: RedisOAuthStateStore;

  beforeEach(() => {
    redis = createMockRedisClient();
    stateStore = new RedisOAuthStateStore(redis);
  });

  describe('set', () => {
    it('should store state with TTL in Redis', async () => {
      const data: PendingOAuthState = {
        provider: 'google',
        tenantId: 'org-1',
        userId: 'user-1',
        redirectUri: 'https://app.example.com/callback',
        expiresAt: Date.now() + 600_000, // 10 minutes
      };

      await stateStore.set('abc123', data);

      expect(redis.set).toHaveBeenCalledWith(
        'oauth_state:abc123',
        expect.any(String),
        'EX',
        expect.any(Number),
      );
      const ttl = (redis.set as any).mock.calls[0][3];
      expect(ttl).toBeGreaterThan(590);
      expect(ttl).toBeLessThanOrEqual(600);
    });

    it('should skip storing already-expired states', async () => {
      const data: PendingOAuthState = {
        provider: 'google',
        tenantId: 'org-1',
        userId: 'user-1',
        redirectUri: 'https://app.example.com/callback',
        expiresAt: Date.now() - 1000,
      };

      await stateStore.set('abc123', data);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('should throw on Redis set error', async () => {
      redis = createMockRedisClient({
        set: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      stateStore = new RedisOAuthStateStore(redis);

      const data: PendingOAuthState = {
        provider: 'google',
        tenantId: 'org-1',
        userId: 'user-1',
        redirectUri: 'https://app.example.com/callback',
        expiresAt: Date.now() + 600_000,
      };

      await expect(stateStore.set('abc123', data)).rejects.toThrow('Connection refused');
    });
  });

  describe('getAndDelete', () => {
    it('should return parsed state using atomic getdel', async () => {
      const data: PendingOAuthState = {
        provider: 'google',
        tenantId: 'org-1',
        userId: 'user-1',
        redirectUri: 'https://app.example.com/callback',
        expiresAt: Date.now() + 600_000,
      };
      const state = 'a'.repeat(64); // valid 64 hex chars
      (redis.getdel as any).mockResolvedValue(JSON.stringify(data));

      const result = await stateStore.getAndDelete(state);

      expect(result).toEqual(data);
      expect(redis.getdel).toHaveBeenCalledWith(`oauth_state:${state}`);
      // Should NOT use separate get+del
      expect(redis.get).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('should accept explicit principal metadata without legacy userId', async () => {
      const data: PendingOAuthState = {
        provider: 'google',
        tenantId: 'org-1',
        principalScope: 'session',
        principalId: 'sdk-session-1',
        sessionPrincipal: 'sdk-session-1',
        sessionId: 'runtime-session-1',
        redirectUri: 'https://app.example.com/callback',
        expiresAt: Date.now() + 600_000,
        projectId: 'project-1',
      };
      const state = 'f'.repeat(64);
      (redis.getdel as any).mockResolvedValue(JSON.stringify(data));

      const result = await stateStore.getAndDelete(state);

      expect(result).toEqual(data);
    });

    it('normalizes legacy runtimeSessionId-only state to canonical sessionId', async () => {
      const legacyData = {
        provider: 'google',
        tenantId: 'org-1',
        principalScope: 'session',
        principalId: 'sdk-session-1',
        sessionPrincipal: 'sdk-session-1',
        runtimeSessionId: 'legacy-runtime-session-1',
        redirectUri: 'https://app.example.com/callback',
        expiresAt: Date.now() + 600_000,
        projectId: 'project-1',
      };
      const state = '9'.repeat(64);
      (redis.getdel as any).mockResolvedValue(JSON.stringify(legacyData));

      const result = await stateStore.getAndDelete(state);

      expect(result).toEqual({
        provider: 'google',
        tenantId: 'org-1',
        principalScope: 'session',
        principalId: 'sdk-session-1',
        sessionPrincipal: 'sdk-session-1',
        sessionId: 'legacy-runtime-session-1',
        redirectUri: 'https://app.example.com/callback',
        expiresAt: legacyData.expiresAt,
        projectId: 'project-1',
      });
      expect(result).not.toHaveProperty('runtimeSessionId');
    });

    it('should return null for cache miss', async () => {
      const state = 'b'.repeat(64);
      const result = await stateStore.getAndDelete(state);
      expect(result).toBeNull();
    });

    it('should reject invalid state format', async () => {
      const result = await stateStore.getAndDelete('short-state');
      expect(result).toBeNull();
      expect(redis.getdel).not.toHaveBeenCalled();
    });

    it('should reject non-hex state format', async () => {
      const result = await stateStore.getAndDelete('g'.repeat(64)); // 'g' is not hex
      expect(result).toBeNull();
      expect(redis.getdel).not.toHaveBeenCalled();
    });

    it('should return null for malformed JSON', async () => {
      const state = 'c'.repeat(64);
      (redis.getdel as any).mockResolvedValue('not valid json{{{');

      // JSON.parse will throw, which should propagate
      await expect(stateStore.getAndDelete(state)).rejects.toThrow();
    });

    it('should return null for valid JSON with missing fields', async () => {
      const state = 'd'.repeat(64);
      (redis.getdel as any).mockResolvedValue(JSON.stringify({ foo: 'bar' }));

      const result = await stateStore.getAndDelete(state);
      expect(result).toBeNull();
    });

    it('should throw on Redis error', async () => {
      const state = 'e'.repeat(64);
      (redis.getdel as any).mockRejectedValue(new Error('Connection refused'));

      await expect(stateStore.getAndDelete(state)).rejects.toThrow('Connection refused');
    });
  });
});

describe('ToolOAuthService', () => {
  let store: ReturnType<typeof createMockStore>;
  let encryptor: OAuthEncryptor;
  let service: ToolOAuthService;
  let sessionArtifactStore: ReturnType<typeof createMockSessionArtifactStore>;

  beforeEach(() => {
    vi.restoreAllMocks();
    store = createMockStore();
    encryptor = createMockEncryptor();
    sessionArtifactStore = createMockSessionArtifactStore();
    service = new ToolOAuthService(
      store,
      encryptor,
      createProviderConfigs(),
      undefined,
      undefined,
      sessionArtifactStore,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    service.destroy();
  });

  describe('initiateOAuthFlow', () => {
    it('should return authUrl and state', async () => {
      const { authUrl, state } = await service.initiateOAuthFlow(
        'google',
        'org-1',
        'user-1',
        ['calendar.readonly'],
        'https://app.example.com/callback',
      );

      expect(authUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(authUrl).toContain('client_id=google-client-id');
      expect(authUrl).toContain('redirect_uri=');
      expect(authUrl).toContain('response_type=code');
      expect(authUrl).toContain('state=');
      expect(state).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should throw for unknown provider', async () => {
      await expect(
        service.initiateOAuthFlow(
          'unknown',
          'org-1',
          'user-1',
          [],
          'https://app.example.com/callback',
        ),
      ).rejects.toThrow('Unknown OAuth provider');
    });
  });

  describe('handleOAuthCallback', () => {
    it('should exchange code for tokens and store encrypted', async () => {
      const { state } = await service.initiateOAuthFlow(
        'google',
        'org-1',
        'user-1',
        ['calendar.readonly'],
        'https://app.example.com/callback',
      );

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'access-123',
              refresh_token: 'refresh-456',
              expires_in: 3600,
              scope: 'calendar.readonly',
            }),
        }),
      );

      await service.handleOAuthCallback('google', 'auth-code-xyz', state);

      expect(store.upsertToken).toHaveBeenCalled();
      const call = (store.upsertToken as any).mock.calls[0][0];
      expect(call.tenantId).toBe('org-1');
      expect(call.userId).toBe('user-1');
      expect(call.provider).toBe('google');
      expect(call.encryptedAccessToken).toContain('enc:');
      expect(call.encryptedRefreshToken).toContain('enc:');

      vi.unstubAllGlobals();
    });

    it('should reject invalid state', async () => {
      await expect(service.handleOAuthCallback('google', 'code', 'invalid-state')).rejects.toThrow(
        'Invalid or expired OAuth state',
      );
    });

    it('rejects legacy pending states that omit explicit principal metadata', async () => {
      const state = 'f'.repeat(64);
      const stateStore = createSharedMapStateStore(new Map<string, PendingOAuthState>());
      await stateStore.set(state, {
        provider: 'google',
        tenantId: 'org-1',
        userId: 'legacy-user-1',
        redirectUri: 'https://app.example.com/callback',
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'access-legacy',
              refresh_token: 'refresh-legacy',
              expires_in: 3600,
              scope: 'calendar.readonly',
            }),
        }),
      );
      service.destroy();
      service = new ToolOAuthService(
        store,
        encryptor,
        createProviderConfigs(),
        stateStore,
        undefined,
        sessionArtifactStore,
      );

      await expect(service.handleOAuthCallback('google', 'code', state)).rejects.toThrow(
        'Invalid or expired OAuth state',
      );
    });

    it('stores anonymous session-scoped authorizations in the session artifact store', async () => {
      const state = 'a'.repeat(64);
      const stateStore = createSharedMapStateStore(new Map<string, PendingOAuthState>());
      await stateStore.set(state, {
        provider: 'google',
        tenantId: 'org-1',
        principalScope: 'session',
        principalId: 'sdk-session-1',
        sessionPrincipal: 'sdk-session-1',
        sessionId: 'runtime-session-1',
        sessionExpiresAt: Date.now() + 15 * 60 * 1000,
        redirectUri: 'https://app.example.com/callback',
        expiresAt: Date.now() + 10 * 60 * 1000,
        projectId: 'project-1',
        channelId: 'channel-1',
        requestedScopes: ['calendar.readonly'],
      });
      service.destroy();
      service = new ToolOAuthService(
        store,
        encryptor,
        createProviderConfigs(),
        stateStore,
        undefined,
        sessionArtifactStore,
      );

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'access-123',
              refresh_token: 'refresh-456',
              expires_in: 3600,
              scope: 'calendar.readonly',
            }),
        }),
      );

      await service.handleOAuthCallback('google', 'auth-code-xyz', state);

      expect(sessionArtifactStore.upsertToken).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'org-1',
          projectId: 'project-1',
          sessionPrincipal: 'sdk-session-1',
          sessionId: 'runtime-session-1',
          provider: 'google',
          channelId: 'channel-1',
        }),
      );
      expect(store.upsertToken).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it('should reject expired state', async () => {
      const { state } = await service.initiateOAuthFlow(
        'google',
        'org-1',
        'user-1',
        [],
        'https://app.example.com/callback',
      );

      // Fast-forward time past the 10-minute window
      vi.useFakeTimers();
      vi.advanceTimersByTime(11 * 60 * 1000);

      await expect(service.handleOAuthCallback('google', 'code', state)).rejects.toThrow('expired');

      vi.useRealTimers();
    });
  });

  describe('getAccessToken', () => {
    it('should return decrypted access token', async () => {
      store.tokens.set('org-1:user-1:google', {
        encryptedAccessToken: 'enc:org-1:valid-token',
        encryptedRefreshToken: null,
        scope: 'calendar.readonly',
        expiresAt: new Date(Date.now() + 3600_000),
      });

      const token = await service.getAccessToken('org-1', 'user-1', 'google');
      expect(token).toBe('valid-token');
    });

    it('should return undefined when no token stored', async () => {
      const token = await service.getAccessToken('org-1', 'user-1', 'google');
      expect(token).toBeUndefined();
    });

    it('should return undefined when token expired and no refresh token', async () => {
      store.tokens.set('org-1:user-1:google', {
        encryptedAccessToken: 'enc:org-1:expired-token',
        encryptedRefreshToken: null,
        scope: 'calendar.readonly',
        expiresAt: new Date(Date.now() - 60_000),
      });

      const token = await service.getAccessToken('org-1', 'user-1', 'google');
      expect(token).toBeUndefined();
    });

    it('should refresh expired token when refresh token available', async () => {
      store.tokens.set('org-1:user-1:google', {
        encryptedAccessToken: 'enc:org-1:expired-token',
        encryptedRefreshToken: 'enc:org-1:refresh-token',
        scope: 'calendar.readonly',
        expiresAt: new Date(Date.now() - 60_000),
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'new-access-token',
              expires_in: 3600,
            }),
        }),
      );

      const token = await service.getAccessToken('org-1', 'user-1', 'google');
      expect(token).toBe('new-access-token');

      vi.unstubAllGlobals();
    });

    it('should preserve scope after token refresh', async () => {
      store.tokens.set('org-1:user-1:google', {
        encryptedAccessToken: 'enc:org-1:expired-token',
        encryptedRefreshToken: 'enc:org-1:refresh-token',
        scope: 'calendar.readonly drive.file',
        expiresAt: new Date(Date.now() - 60_000), // expired
      });

      // Refresh response does NOT include scope
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'new-access-token',
              expires_in: 3600,
            }),
        }),
      );

      await service.getAccessToken('org-1', 'user-1', 'google');

      // Verify scope was preserved from existing record, not overwritten with ''
      const upsertCall = (store.upsertToken as any).mock.calls[0][0];
      expect(upsertCall.scope).toBe('calendar.readonly drive.file');

      vi.unstubAllGlobals();
    });

    it('should use new scope when refresh response provides one', async () => {
      store.tokens.set('org-1:user-1:google', {
        encryptedAccessToken: 'enc:org-1:expired-token',
        encryptedRefreshToken: 'enc:org-1:refresh-token',
        scope: 'calendar.readonly',
        expiresAt: new Date(Date.now() - 60_000),
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'new-access-token',
              expires_in: 3600,
              scope: 'calendar.readonly calendar.events',
            }),
        }),
      );

      await service.getAccessToken('org-1', 'user-1', 'google');

      const upsertCall = (store.upsertToken as any).mock.calls[0][0];
      expect(upsertCall.scope).toBe('calendar.readonly calendar.events');

      vi.unstubAllGlobals();
    });

    it('should update lastUsed on access', async () => {
      store.tokens.set('org-1:user-1:google', {
        encryptedAccessToken: 'enc:org-1:token',
        encryptedRefreshToken: null,
        scope: 'calendar.readonly',
        expiresAt: new Date(Date.now() + 3600_000),
      });

      await service.getAccessToken('org-1', 'user-1', 'google');
      expect(store.updateLastUsed).toHaveBeenCalledWith('org-1', 'user-1', 'google');
    });

    it('reads anonymous session-scoped tokens from the session artifact store', async () => {
      sessionArtifactStore.tokens.set('org-1:project-1:sdk-session-1:google', {
        encryptedAccessToken: 'enc:org-1:session-token',
        encryptedRefreshToken: null,
        scope: 'calendar.readonly',
        expiresAt: new Date(Date.now() + 3600_000),
        sessionId: 'runtime-session-1',
        sessionExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
        version: 0,
      });

      const token = await service.getAccessToken('org-1', 'sdk-session-1', 'google', {
        projectId: 'project-1',
        authScope: 'session',
      });

      expect(token).toBe('session-token');
      expect(sessionArtifactStore.updateLastUsed).toHaveBeenCalledWith({
        tenantId: 'org-1',
        projectId: 'project-1',
        sessionPrincipal: 'sdk-session-1',
        provider: 'google',
      });
      expect(store.updateLastUsed).not.toHaveBeenCalled();
    });
  });

  describe('revokeToken', () => {
    it('should mark token as revoked', async () => {
      store.tokens.set('org-1:user-1:google', {
        encryptedAccessToken: 'enc:org-1:token',
        encryptedRefreshToken: null,
        scope: 'calendar.readonly',
        expiresAt: null,
      });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

      await service.revokeToken('org-1', 'user-1', 'google');
      expect(store.markRevoked).toHaveBeenCalledWith('org-1', 'user-1', 'google');

      vi.unstubAllGlobals();
    });

    it('should not throw when no token exists', async () => {
      await expect(service.revokeToken('org-1', 'user-1', 'google')).resolves.not.toThrow();
    });

    it('should still revoke locally if provider endpoint fails', async () => {
      store.tokens.set('org-1:user-1:google', {
        encryptedAccessToken: 'enc:org-1:token',
        encryptedRefreshToken: null,
        scope: 'calendar.readonly',
        expiresAt: null,
      });

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      await service.revokeToken('org-1', 'user-1', 'google');
      expect(store.markRevoked).toHaveBeenCalled();

      vi.unstubAllGlobals();
    });
  });

  describe('multi-pod state store', () => {
    it('should allow state created on one store to be consumed on another', async () => {
      const sharedMap = new Map<string, PendingOAuthState>();
      const storeA = createSharedMapStateStore(sharedMap);
      const storeB = createSharedMapStateStore(sharedMap);

      const serviceA = new ToolOAuthService(store, encryptor, createProviderConfigs(), storeA);
      const serviceB = new ToolOAuthService(store, encryptor, createProviderConfigs(), storeB);

      const { state } = await serviceA.initiateOAuthFlow(
        'google',
        'org-1',
        'user-1',
        ['calendar.readonly'],
        'https://app.example.com/callback',
      );

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'cross-pod-token',
              refresh_token: 'cross-pod-refresh',
              expires_in: 3600,
              scope: 'calendar.readonly',
            }),
        }),
      );

      await serviceB.handleOAuthCallback('google', 'auth-code-xyz', state);

      expect(store.upsertToken).toHaveBeenCalled();
      const call = (store.upsertToken as any).mock.calls[0][0];
      expect(call.tenantId).toBe('org-1');

      vi.unstubAllGlobals();
      serviceA.destroy();
      serviceB.destroy();
    });

    it('should reject callback when state is consumed twice', async () => {
      const sharedMap = new Map<string, PendingOAuthState>();
      const storeA = createSharedMapStateStore(sharedMap);
      const storeB = createSharedMapStateStore(sharedMap);

      const serviceA = new ToolOAuthService(store, encryptor, createProviderConfigs(), storeA);
      const serviceB = new ToolOAuthService(store, encryptor, createProviderConfigs(), storeB);

      const { state } = await serviceA.initiateOAuthFlow(
        'google',
        'org-1',
        'user-1',
        ['calendar.readonly'],
        'https://app.example.com/callback',
      );

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'token',
              expires_in: 3600,
              scope: 'calendar.readonly',
            }),
        }),
      );

      await serviceA.handleOAuthCallback('google', 'code', state);

      await expect(serviceB.handleOAuthCallback('google', 'code', state)).rejects.toThrow(
        'Invalid or expired OAuth state',
      );

      vi.unstubAllGlobals();
      serviceA.destroy();
      serviceB.destroy();
    });

    it('should default to in-memory when no state store provided', () => {
      const defaultService = new ToolOAuthService(store, encryptor, createProviderConfigs());
      expect(defaultService).toBeDefined();
      defaultService.destroy();
    });
  });

  describe('cleanupSessionScopedArtifactsBySessionId', () => {
    it('deletes session-scoped artifacts by canonical session id', async () => {
      sessionArtifactStore.tokens.set('org-1:project-1:sdk-session-1:google', {
        encryptedAccessToken: 'enc:org-1:session-token',
        encryptedRefreshToken: null,
        scope: 'calendar.readonly',
        expiresAt: null,
        sessionId: 'runtime-session-1',
        sessionExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
        version: 0,
      });

      const deleted = await service.cleanupSessionScopedArtifactsBySessionId('runtime-session-1');

      expect(deleted).toBe(1);
      expect(sessionArtifactStore.deleteBySessionId).toHaveBeenCalledWith('runtime-session-1');
    });
  });
});
