import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveDistributed = vi.fn();
const mockRejectDistributedError = vi.fn();

vi.mock('../../services/auth-profile/paused-execution-store.js', () => ({
  getPausedExecutionStore: () => ({
    resolveDistributed: (...args: unknown[]) => mockResolveDistributed(...args),
    rejectDistributedError: (...args: unknown[]) => mockRejectDistributedError(...args),
  }),
}));

import {
  InMemoryOAuthStateStore,
  ToolOAuthService,
  type OAuthTokenRecord,
  type OAuthEncryptor,
  type OAuthProviderConfig,
  type OAuthTokenStore,
} from '../../services/tool-oauth-service.js';

function createTokenStore(
  initialToken?: OAuthTokenRecord | null,
): OAuthTokenStore & { tokens: Map<string, OAuthTokenRecord> } {
  const tokens = new Map<string, OAuthTokenRecord>();
  if (initialToken) {
    tokens.set('tenant-1:user-1:google', initialToken);
  }

  return {
    tokens,
    findToken: vi.fn(async (tenantId, userId, provider) => {
      return tokens.get(`${tenantId}:${userId}:${provider}`) ?? null;
    }),
    upsertToken: vi.fn(async (params) => {
      tokens.set(`${params.tenantId}:${params.userId}:${params.provider}`, {
        encryptedAccessToken: params.encryptedAccessToken,
        encryptedRefreshToken: params.encryptedRefreshToken ?? null,
        scope: params.scope,
        expiresAt: params.expiresAt ?? null,
        version:
          (tokens.get(`${params.tenantId}:${params.userId}:${params.provider}`)?.version ?? -1) + 1,
      });
    }),
    compareAndSwapToken: vi.fn(async (params) => {
      const key = `${params.tenantId}:${params.userId}:${params.provider}`;
      const current = tokens.get(key) ?? null;
      const currentVersion = current?.version ?? null;
      if (currentVersion !== params.expectedVersion) {
        return false;
      }
      if (params.next.kind === 'revoke') {
        tokens.delete(key);
        return true;
      }
      tokens.set(key, {
        ...params.next.token,
        version: params.expectedVersion == null ? 0 : params.expectedVersion + 1,
      });
      return true;
    }),
    markRevoked: vi.fn(async (tenantId, userId, provider) => {
      tokens.delete(`${tenantId}:${userId}:${provider}`);
    }),
    updateLastUsed: vi.fn(async () => {}),
  };
}

function createEncryptor(): OAuthEncryptor {
  return {
    encryptForTenant: (plaintext: string) => `enc:${plaintext}`,
    decryptForTenant: (encrypted: string) => encrypted.replace(/^enc:/, ''),
  };
}

function createProviders(): Map<string, OAuthProviderConfig> {
  return new Map([
    [
      'google',
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: ['calendar.readonly'],
      },
    ],
  ]);
}

describe('ToolOAuthService JIT delivery failures', () => {
  let service: ToolOAuthService;
  let stateStore: InMemoryOAuthStateStore;
  let originalFetch: typeof globalThis.fetch;
  let tokenStore: ReturnType<typeof createTokenStore>;

  beforeEach(() => {
    mockResolveDistributed.mockReset();
    mockRejectDistributedError.mockReset();
    mockRejectDistributedError.mockResolvedValue('handled');
    stateStore = new InMemoryOAuthStateStore();
    tokenStore = createTokenStore();
    service = new ToolOAuthService(tokenStore, createEncryptor(), createProviders(), stateStore);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    service.destroy();
    stateStore.destroy();
    globalThis.fetch = originalFetch;
  });

  it('fails the callback when the paused execution cannot be resumed', async () => {
    mockResolveDistributed.mockResolvedValueOnce('delivery_failed');

    const authUrl = await service.initiateJitOAuth(
      'google',
      'tenant-1',
      'user-1',
      'session-1',
      'tool-call-1',
      'https://app.example.com/oauth/callback',
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'fresh-token',
        expires_in: 3600,
      }),
    }) as unknown as typeof globalThis.fetch;

    const state = new URL(authUrl!).searchParams.get('state');
    await expect(service.handleOAuthCallback('google', 'auth-code', state!)).rejects.toThrow(
      'could not be resumed',
    );
    expect(tokenStore.compareAndSwapToken).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        provider: 'google',
        next: { kind: 'revoke' },
      }),
    );
    expect(tokenStore.tokens.size).toBe(0);
    expect(mockRejectDistributedError).toHaveBeenCalledWith(
      'session-1',
      'tool-call-1',
      'Authorization failed during callback. Please retry the tool call.',
    );
  });

  it('restores the previous token when JIT resume fails after rotating credentials', async () => {
    mockResolveDistributed.mockResolvedValueOnce('missing');

    const existingToken: OAuthTokenRecord = {
      encryptedAccessToken: 'enc:previous-token',
      encryptedRefreshToken: 'enc:previous-refresh',
      scope: 'calendar.readonly',
      expiresAt: new Date('2026-03-20T00:00:00.000Z'),
    };
    tokenStore = createTokenStore(existingToken);
    service.destroy();
    service = new ToolOAuthService(tokenStore, createEncryptor(), createProviders(), stateStore);

    const authUrl = await service.initiateJitOAuth(
      'google',
      'tenant-1',
      'user-1',
      'session-1',
      'tool-call-2',
      'https://app.example.com/oauth/callback',
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'fresh-token',
        refresh_token: 'fresh-refresh',
        expires_in: 3600,
      }),
    }) as unknown as typeof globalThis.fetch;

    const state = new URL(authUrl!).searchParams.get('state');
    await expect(service.handleOAuthCallback('google', 'auth-code', state!)).rejects.toThrow(
      'could not be resumed',
    );

    expect(tokenStore.compareAndSwapToken).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        provider: 'google',
        next: {
          kind: 'upsert',
          token: existingToken,
        },
      }),
    );
    expect(tokenStore.markRevoked).not.toHaveBeenCalled();
    expect(tokenStore.tokens.get('tenant-1:user-1:google')).toEqual({
      ...existingToken,
      version: 1,
    });
  });

  it('skips rollback when another flow updates the token after the callback write', async () => {
    const concurrentToken: OAuthTokenRecord = {
      encryptedAccessToken: 'enc:concurrent-token',
      encryptedRefreshToken: 'enc:concurrent-refresh',
      scope: 'calendar.readonly email.readonly',
      expiresAt: new Date('2026-03-21T00:00:00.000Z'),
    };

    mockResolveDistributed.mockImplementationOnce(async () => {
      tokenStore.tokens.set('tenant-1:user-1:google', concurrentToken);
      return 'delivery_failed';
    });

    const authUrl = await service.initiateJitOAuth(
      'google',
      'tenant-1',
      'user-1',
      'session-1',
      'tool-call-3',
      'https://app.example.com/oauth/callback',
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'fresh-token',
        refresh_token: 'fresh-refresh',
        expires_in: 3600,
      }),
    }) as unknown as typeof globalThis.fetch;

    const state = new URL(authUrl!).searchParams.get('state');
    await expect(service.handleOAuthCallback('google', 'auth-code', state!)).rejects.toThrow(
      'could not be resumed',
    );

    expect(tokenStore.tokens.get('tenant-1:user-1:google')).toEqual(concurrentToken);
    expect(tokenStore.markRevoked).not.toHaveBeenCalled();
    expect(mockRejectDistributedError).toHaveBeenCalledWith(
      'session-1',
      'tool-call-3',
      'Authorization failed during callback. Please retry the tool call.',
    );
  });
});
