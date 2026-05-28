/**
 * E2E: OAuth Callback -> JIT Paused Execution Resolution (Suite 3)
 *
 * Tests the FULL server-side circuit: tool pauses -> OAuth callback -> execution resumes.
 *
 * Real components:
 * - ToolOAuthService (handleOAuthCallback, initiateJitOAuth, getJitMetadata, clearJitMetadata)
 * - PausedExecutionStore (real singleton)
 * - InMemoryOAuthStateStore
 *
 * Mock boundaries: fetch (HTTP token exchange), OAuthTokenStore, OAuthEncryptor, Logger
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../services/redis/redis-client.js', () => ({
  isRedisAvailable: () => false,
  getRedisClient: () => null,
  getRedisHandle: () => null,
}));

// ── Imports (after mocks) ───────────────────────────────────────────

import {
  ToolOAuthService,
  InMemoryOAuthStateStore,
  type OAuthTokenStore,
  type OAuthEncryptor,
  type OAuthProviderConfig,
} from '../../services/tool-oauth-service.js';
import {
  PausedExecutionStore,
  resetPausedExecutionStore,
  getPausedExecutionStore,
} from '../../services/auth-profile/paused-execution-store.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createMockTokenStore(): OAuthTokenStore {
  const tokens = new Map<string, Record<string, unknown>>();
  return {
    findToken: vi.fn(async (tenantId, userId, provider) => {
      return (tokens.get(`${tenantId}:${userId}:${provider}`) as never) ?? null;
    }),
    upsertToken: vi.fn(async (params) => {
      const key = `${params.tenantId}:${params.userId}:${params.provider}`;
      tokens.set(key, {
        ...params,
        version: ((tokens.get(key) as { version?: number } | undefined)?.version ?? -1) + 1,
      });
    }),
    compareAndSwapToken: vi.fn(async (params) => {
      const key = `${params.tenantId}:${params.userId}:${params.provider}`;
      const current = (tokens.get(key) as { version?: number } | undefined) ?? null;
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
    markRevoked: vi.fn(),
    updateLastUsed: vi.fn(),
  };
}

function createMockEncryptor(): OAuthEncryptor {
  return {
    encryptForTenant: vi.fn((plaintext: string, tenantId: string) => {
      if (!tenantId) throw new Error('tenantId is required for encryption');
      return `encrypted:${tenantId}:${plaintext}`;
    }),
    decryptForTenant: vi.fn((encrypted: string, _tenantId: string) =>
      encrypted.replace(/^encrypted:[^:]+:/, ''),
    ),
  };
}

function createGoogleConfig(): OAuthProviderConfig {
  return {
    clientId: 'google-client-id',
    clientSecret: 'google-client-secret',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['gmail.readonly', 'calendar.readonly'],
  };
}

// ── Test Suite ──────────────────────────────────────────────────────

describe('Suite 3: OAuth Callback -> Async JIT Resume', () => {
  let service: ToolOAuthService;
  let tokenStore: OAuthTokenStore;
  let encryptor: OAuthEncryptor;
  let stateStore: InMemoryOAuthStateStore;
  let pausedStore: PausedExecutionStore;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    resetPausedExecutionStore();
    pausedStore = getPausedExecutionStore();
    tokenStore = createMockTokenStore();
    encryptor = createMockEncryptor();
    stateStore = new InMemoryOAuthStateStore();

    const providers = new Map<string, OAuthProviderConfig>();
    providers.set('google', createGoogleConfig());

    service = new ToolOAuthService(tokenStore, encryptor, providers, stateStore);

    // Save and mock fetch
    originalFetch = globalThis.fetch;
    process.env.JIT_AUTH_TIMEOUT_MS = '5000';
  });

  afterEach(() => {
    service.destroy();
    stateStore.destroy();
    pausedStore.destroy();
    globalThis.fetch = originalFetch;
    delete process.env.JIT_AUTH_TIMEOUT_MS;
  });

  it('3.1: Full circuit: pause -> auth_challenge -> OAuth callback -> resolve -> tool succeeds', async () => {
    // Step 1: Pause execution
    const pausePromise = pausedStore.pause({
      sessionId: 'session-jit',
      toolCallId: 'tc-jit-1',
      authProfileRef: 'google-creds',
      toolName: 'gmail_lookup',
      pausedAt: Date.now(),
      timeoutMs: 5000,
    });

    // Wait for async writeRedisKey to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(pausedStore.has('tc-jit-1')).toBe(true);

    // Step 2: Initiate JIT OAuth (creates state -> JIT metadata mapping)
    const authUrl = await service.initiateJitOAuth(
      'google',
      'tenant-1',
      'user-1',
      'session-jit',
      'tc-jit-1',
      'https://app.example.com/oauth/callback',
    );

    expect(authUrl).toBeDefined();
    expect(authUrl).toContain('accounts.google.com');

    // Extract state from the URL
    const url = new URL(authUrl!);
    const oauthState = url.searchParams.get('state')!;
    expect(oauthState).toBeTruthy();

    // Verify JIT metadata was stored
    const jitMeta = service.getJitMetadata(oauthState);
    expect(jitMeta).not.toBeNull();
    expect(jitMeta!.sessionId).toBe('session-jit');
    expect(jitMeta!.toolCallId).toBe('tc-jit-1');

    // Step 3: Mock token exchange response
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'fresh-access-token',
        refresh_token: 'fresh-refresh-token',
        expires_in: 3600,
        scope: 'gmail.readonly calendar.readonly',
      }),
    });

    // Step 4: Handle OAuth callback (should resolve the paused execution)
    await service.handleOAuthCallback('google', 'auth-code-123', oauthState);

    // The paused execution should have been resolved
    await pausePromise; // Should resolve without error

    // Token should be stored with tenant-scoped encryption
    expect(tokenStore.compareAndSwapToken).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        provider: 'google',
        next: expect.objectContaining({
          kind: 'upsert',
          token: expect.objectContaining({
            // Verify tenantId was passed to encryptForTenant (mock prefixes with tenant)
            encryptedAccessToken: expect.stringContaining('encrypted:tenant-1:'),
          }),
        }),
      }),
    );

    // Verify encryptForTenant was called with the correct tenantId
    expect(encryptor.encryptForTenant).toHaveBeenCalled();
    const encryptCalls = (encryptor.encryptForTenant as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of encryptCalls) {
      expect(call[1]).toBe('tenant-1');
    }

    // JIT metadata should be cleared
    expect(service.getJitMetadata(oauthState)).toBeNull();
    expect(pausedStore.has('tc-jit-1')).toBe(false);
  });

  it('3.2: Clearing the pod-local JIT cache does not bypass authoritative JIT rollback', async () => {
    // Create JIT metadata that's expired by manipulating time
    const authUrl = await service.initiateJitOAuth(
      'google',
      'tenant-1',
      'user-1',
      'session-jit',
      'tc-expired',
      'https://app.example.com/oauth/callback',
    );

    const url = new URL(authUrl!);
    const oauthState = url.searchParams.get('state')!;

    // Manually expire the JIT metadata by clearing and re-adding with old timestamp
    // Access the internal jitMetadataMap via the getJitMetadata/clearJitMetadata interface
    service.clearJitMetadata(oauthState);

    // After clearing, getJitMetadata returns null
    expect(service.getJitMetadata(oauthState)).toBeNull();

    // Mock token exchange
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-token',
        expires_in: 3600,
      }),
    });

    // Handle callback — pending state still marks this as JIT, so it should fail closed
    await expect(service.handleOAuthCallback('google', 'code-456', oauthState)).rejects.toThrow(
      'could not be resumed',
    );
    expect(tokenStore.compareAndSwapToken).toHaveBeenCalledTimes(2);
    expect(tokenStore.compareAndSwapToken).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        provider: 'google',
        next: { kind: 'revoke' },
      }),
    );
  });

  it('3.3: Race: callback arrives after cancellation -> new token is rolled back', async () => {
    // Pause execution
    const pausePromise = pausedStore.pause({
      sessionId: 'session-race',
      toolCallId: 'tc-race',
      authProfileRef: 'google-creds',
      toolName: 'gmail_lookup',
      pausedAt: Date.now(),
      timeoutMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 10));

    // Initiate JIT OAuth
    const authUrl = await service.initiateJitOAuth(
      'google',
      'tenant-1',
      'user-1',
      'session-race',
      'tc-race',
      'https://app.example.com/oauth/callback',
    );

    const url = new URL(authUrl!);
    const oauthState = url.searchParams.get('state')!;

    // Client cancels before callback arrives
    const { AuthCancelledError } =
      await import('../../services/auth-profile/paused-execution-store.js');
    pausedStore.reject('tc-race', new AuthCancelledError());

    await expect(pausePromise).rejects.toThrow('cancelled');
    expect(pausedStore.has('tc-race')).toBe(false);

    // Now OAuth callback arrives
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'late-token',
        expires_in: 3600,
      }),
    });

    // handleOAuthCallback should fail closed and revoke the newly granted token
    await expect(service.handleOAuthCallback('google', 'code-late', oauthState)).rejects.toThrow(
      'could not be resumed',
    );
    expect(tokenStore.compareAndSwapToken).toHaveBeenCalledTimes(2);
    expect(tokenStore.compareAndSwapToken).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        provider: 'google',
        next: { kind: 'revoke' },
      }),
    );
  });

  it('3.4: Non-JIT OAuth callback (no JIT metadata for state) -> works normally, no crash', async () => {
    // Initiate a regular (non-JIT) OAuth flow
    const { authUrl, state } = await service.initiateOAuthFlow(
      'google',
      'tenant-1',
      'user-1',
      ['gmail.readonly'],
      'https://app.example.com/oauth/callback',
    );

    expect(authUrl).toContain('accounts.google.com');

    // No JIT metadata for this state
    expect(service.getJitMetadata(state)).toBeNull();

    // Mock token exchange
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'regular-token',
        refresh_token: 'regular-refresh',
        expires_in: 3600,
      }),
    });

    // Handle callback — should work without JIT resolution
    await service.handleOAuthCallback('google', 'code-regular', state);

    // Token stored
    expect(tokenStore.upsertToken).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        provider: 'google',
      }),
    );
  });

  it('3.5: JIT metadata cleanup: after callback resolves, metadata is removed from map', async () => {
    // Pause execution
    const pausePromise = pausedStore.pause({
      sessionId: 'session-cleanup',
      toolCallId: 'tc-cleanup',
      authProfileRef: 'google-creds',
      toolName: 'gmail_lookup',
      pausedAt: Date.now(),
      timeoutMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 10));

    // Initiate JIT OAuth
    const authUrl = await service.initiateJitOAuth(
      'google',
      'tenant-1',
      'user-1',
      'session-cleanup',
      'tc-cleanup',
      'https://app.example.com/oauth/callback',
    );

    const url = new URL(authUrl!);
    const oauthState = url.searchParams.get('state')!;

    // Verify metadata exists before callback
    expect(service.getJitMetadata(oauthState)).not.toBeNull();

    // Mock token exchange
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'cleanup-token',
        expires_in: 3600,
      }),
    });

    // Handle callback
    await service.handleOAuthCallback('google', 'code-cleanup', oauthState);

    // JIT metadata should be cleared
    expect(service.getJitMetadata(oauthState)).toBeNull();

    // Pause should be resolved
    await pausePromise;
    expect(pausedStore.has('tc-cleanup')).toBe(false);
  });
});
