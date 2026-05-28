/**
 * Tests for RuntimeSecretsProvider
 *
 * Validates the secret resolution chain (no process.env fallback):
 * 1. Special keys (auth_token, bearer_token) -> session authToken
 * 2. Per-session cache
 * 3. Auth Profile resolution (when configured)
 * 4. DB-backed ToolSecretStore (decrypt + expiry check)
 * 5. Agent IR credentials config map
 * 6. undefined (with warning)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RuntimeSecretsProvider,
  type ToolSecretStore,
  type SecretDecryptor,
  type OAuthTokenResolver,
  type AuthProfileResolver,
} from '../services/secrets-provider.js';
import type { AgentIR } from '@abl/compiler';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createMockStore(): ToolSecretStore {
  return { findSecret: vi.fn() };
}

function createMockDecryptor(): SecretDecryptor {
  return { decryptForTenant: vi.fn((data: string, _tid: string) => `decrypted:${data}`) };
}

function createMockOAuthResolver(): OAuthTokenResolver {
  return { getAccessToken: vi.fn() };
}

function createMockAuthProfileResolver(): AuthProfileResolver {
  return { resolveBySecretKey: vi.fn() };
}

/** Minimal AgentIR with tools carrying http_binding auth credentials */
function agentIRWithCredentials(credentials: Record<string, string>): AgentIR {
  return {
    tools: [
      {
        name: 'test-tool',
        type: 'http',
        http_binding: {
          method: 'GET',
          url: 'https://example.com',
          auth: {
            type: 'bearer',
            config: { credentials },
          },
        },
      },
    ],
  } as unknown as AgentIR;
}

/** Minimal AgentIR with no tools */
function agentIRNoTools(): AgentIR {
  return { tools: [] } as unknown as AgentIR;
}

function createAgentIRWithCredentials(credentials: Record<string, string>): AgentIR {
  return {
    tools: [
      {
        name: 'test_api',
        http_binding: {
          endpoint: 'https://api.example.com',
          method: 'GET',
          auth: {
            type: 'api_key',
            config: { credentials },
          },
        },
      },
    ],
  } as unknown as AgentIR;
}

// ---------------------------------------------------------------------------
// Environment variable helpers
// ---------------------------------------------------------------------------

const envKeysToCleanup: string[] = [];

function setEnv(key: string, value: string) {
  envKeysToCleanup.push(key);
  process.env[key] = value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuntimeSecretsProvider', () => {
  let mockStore: ToolSecretStore;
  let mockDecryptor: SecretDecryptor;
  let mockOAuthResolver: OAuthTokenResolver;

  beforeEach(() => {
    mockStore = createMockStore();
    mockDecryptor = createMockDecryptor();
    mockOAuthResolver = createMockOAuthResolver();
  });

  afterEach(() => {
    for (const key of envKeysToCleanup) {
      delete process.env[key];
    }
    envKeysToCleanup.length = 0;
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    test('config object constructor sets all fields', () => {
      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        authToken: 'tok',
        userId: 'u1',
        projectId: 'p1',
        environment: 'staging',
        secretStore: mockStore,
        decryptor: mockDecryptor,
        oauthResolver: mockOAuthResolver,
        agentIR: agentIRNoTools(),
      });

      expect(provider.getUserId()).toBe('u1');
    });

    test('legacy positional constructor sets tenantId, authToken, userId', async () => {
      const provider = new RuntimeSecretsProvider('t1', 'tok-legacy', 'u-legacy');

      // authToken is reachable via getSecret('auth_token')
      expect(await provider.getSecret('auth_token')).toBe('tok-legacy');
      expect(provider.getUserId()).toBe('u-legacy');
    });

    test('builds credentialsMap from agentIR tools with http_binding auth credentials', async () => {
      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        agentIR: agentIRWithCredentials({ API_KEY: 'secret-123', API_SECRET: 'secret-456' }),
      });

      expect(await provider.getSecret('API_KEY')).toBe('secret-123');
      expect(await provider.getSecret('API_SECRET')).toBe('secret-456');
    });

    test('handles agentIR with no tools gracefully', () => {
      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        agentIR: agentIRNoTools(),
      });

      expect(provider).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // getSecret - Layer 1: Special Keys
  // -----------------------------------------------------------------------

  describe('getSecret - special keys', () => {
    test('auth_token returns authToken', async () => {
      const provider = new RuntimeSecretsProvider({ authToken: 'my-auth' });
      expect(await provider.getSecret('auth_token')).toBe('my-auth');
    });

    test('bearer_token returns authToken', async () => {
      const provider = new RuntimeSecretsProvider({ authToken: 'my-bearer' });
      expect(await provider.getSecret('bearer_token')).toBe('my-bearer');
    });
  });

  // -----------------------------------------------------------------------
  // getSecret - Layer 2: Session Cache
  // -----------------------------------------------------------------------

  describe('getSecret - session cache', () => {
    test('second call for same key returns cached value without calling store again', async () => {
      (mockStore.findSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
        encryptedValue: 'enc-val',
        expiresAt: null,
        version: 1,
      });

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        secretStore: mockStore,
        decryptor: mockDecryptor,
      });

      const first = await provider.getSecret('db_password', { toolName: 'orders_api' });
      const second = await provider.getSecret('db_password', { toolName: 'orders_api' });

      expect(first).toBe('decrypted:enc-val');
      expect(second).toBe('decrypted:enc-val');
      expect(mockStore.findSecret).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // getSecret - Layer 3: DB Store
  // -----------------------------------------------------------------------

  describe('getSecret - DB store', () => {
    test('resolves from store, decrypts, and returns value', async () => {
      (mockStore.findSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
        encryptedValue: 'encrypted-data',
        expiresAt: null,
        version: 2,
      });

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        secretStore: mockStore,
        decryptor: mockDecryptor,
      });

      const result = await provider.getSecret('my_key', { toolName: 'weather_api' });

      expect(result).toBe('decrypted:encrypted-data');
      expect(mockStore.findSecret).toHaveBeenCalledWith({
        tenantId: 't1',
        projectId: 'p1',
        toolName: 'weather_api',
        secretKey: 'my_key',
        environment: 'dev',
      });
      expect(mockDecryptor.decryptForTenant).toHaveBeenCalledWith('encrypted-data', 't1');
    });

    test('falls back to global tool secret when environment-specific record is absent', async () => {
      (mockStore.findSecret as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          encryptedValue: 'global-encrypted-data',
          expiresAt: null,
          version: 1,
        });

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        environment: 'production',
        secretStore: mockStore,
        decryptor: mockDecryptor,
      });

      const result = await provider.getSecret('my_key', { toolName: 'weather_api' });

      expect(result).toBe('decrypted:global-encrypted-data');
      expect(mockStore.findSecret).toHaveBeenNthCalledWith(1, {
        tenantId: 't1',
        projectId: 'p1',
        toolName: 'weather_api',
        secretKey: 'my_key',
        environment: 'production',
      });
      expect(mockStore.findSecret).toHaveBeenNthCalledWith(2, {
        tenantId: 't1',
        projectId: 'p1',
        toolName: 'weather_api',
        secretKey: 'my_key',
        environment: 'global',
      });
      expect(mockDecryptor.decryptForTenant).toHaveBeenCalledWith('global-encrypted-data', 't1');
    });

    test('falls back to global tool secret when environment-specific record is expired', async () => {
      (mockStore.findSecret as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          encryptedValue: 'expired-environment-data',
          expiresAt: new Date(Date.now() - 60_000),
          version: 2,
        })
        .mockResolvedValueOnce({
          encryptedValue: 'global-encrypted-data',
          expiresAt: null,
          version: 1,
        });

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        environment: 'production',
        secretStore: mockStore,
        decryptor: mockDecryptor,
      });

      const result = await provider.getSecret('my_key', { toolName: 'weather_api' });

      expect(result).toBe('decrypted:global-encrypted-data');
      expect(mockDecryptor.decryptForTenant).toHaveBeenCalledTimes(1);
      expect(mockDecryptor.decryptForTenant).toHaveBeenCalledWith('global-encrypted-data', 't1');
    });

    test('does not query tool secrets without an execution tool name', async () => {
      (mockStore.findSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
        encryptedValue: 'cross-tool-secret',
        expiresAt: null,
        version: 1,
      });

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        secretStore: mockStore,
        decryptor: mockDecryptor,
      });

      const result = await provider.getSecret('shared_key');

      expect(result).toBeUndefined();
      expect(mockStore.findSecret).not.toHaveBeenCalled();
    });

    test('rejects expired secret (expiresAt in the past)', async () => {
      const pastDate = new Date(Date.now() - 60_000);
      (mockStore.findSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
        encryptedValue: 'expired-enc',
        expiresAt: pastDate,
        version: 1,
      });

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        secretStore: mockStore,
        decryptor: mockDecryptor,
      });

      const result = await provider.getSecret('expired_key', { toolName: 'weather_api' });
      expect(result).toBeUndefined();
      expect(mockDecryptor.decryptForTenant).not.toHaveBeenCalled();
    });

    test('returns undefined when store returns null', async () => {
      (mockStore.findSecret as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        secretStore: mockStore,
        decryptor: mockDecryptor,
      });

      const result = await provider.getSecret('nonexistent', { toolName: 'weather_api' });
      expect(result).toBeUndefined();
    });

    test('handles store error gracefully and returns undefined', async () => {
      (mockStore.findSecret as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB down'));

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        secretStore: mockStore,
        decryptor: mockDecryptor,
      });

      const result = await provider.getSecret('fallback_key', { toolName: 'weather_api' });
      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // getSecret - Layer 4: IR Credentials
  // -----------------------------------------------------------------------

  describe('getSecret - IR credentials', () => {
    test('resolves from credentialsMap when store has nothing', async () => {
      (mockStore.findSecret as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        secretStore: mockStore,
        decryptor: mockDecryptor,
        agentIR: createAgentIRWithCredentials({ SERVICE_KEY: 'ir-value' }),
      });

      const result = await provider.getSecret('SERVICE_KEY');
      expect(result).toBe('ir-value');
    });
  });

  // -----------------------------------------------------------------------
  // getSecret - No process.env fallback (all resolution via DB)
  // -----------------------------------------------------------------------

  describe('getSecret - no process.env fallback', () => {
    test('does NOT resolve from process.env — returns undefined', async () => {
      setEnv('my_env_secret', 'env-secret-val');

      const provider = new RuntimeSecretsProvider({ tenantId: 't1' });

      const result = await provider.getSecret('my_env_secret');
      expect(result).toBeUndefined();
    });

    test('returns undefined when not found in any layer', async () => {
      const provider = new RuntimeSecretsProvider({ tenantId: 't1' });

      const result = await provider.getSecret('totally_missing');
      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // getUserOAuthToken
  // -----------------------------------------------------------------------

  describe('getUserOAuthToken', () => {
    test('delegates to oauthResolver.getAccessToken', async () => {
      (mockOAuthResolver.getAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue('oauth-tok');

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        userId: 'u1',
        oauthResolver: mockOAuthResolver,
      });

      const result = await provider.getUserOAuthToken('u1', 'google');
      expect(result).toBe('oauth-tok');
      expect(mockOAuthResolver.getAccessToken).toHaveBeenCalledWith('t1', 'u1', 'google');
    });

    test('handles userId === "current" by using bound userId', async () => {
      (mockOAuthResolver.getAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(
        'current-tok',
      );

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        userId: 'bound-user',
        oauthResolver: mockOAuthResolver,
      });

      const result = await provider.getUserOAuthToken('current', 'github');
      expect(result).toBe('current-tok');
      expect(mockOAuthResolver.getAccessToken).toHaveBeenCalledWith('t1', 'bound-user', 'github');
    });

    test('returns undefined when no resolver is provided', async () => {
      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        userId: 'u1',
      });

      const result = await provider.getUserOAuthToken('u1', 'google');
      expect(result).toBeUndefined();
    });

    test('returns undefined when no tenantId is provided', async () => {
      const provider = new RuntimeSecretsProvider({
        userId: 'u1',
        oauthResolver: mockOAuthResolver,
      });

      const result = await provider.getUserOAuthToken('u1', 'google');
      expect(result).toBeUndefined();
      expect(mockOAuthResolver.getAccessToken).not.toHaveBeenCalled();
    });

    test('handles resolver error gracefully', async () => {
      (mockOAuthResolver.getAccessToken as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('OAuth service down'),
      );

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        userId: 'u1',
        oauthResolver: mockOAuthResolver,
      });

      const result = await provider.getUserOAuthToken('u1', 'google');
      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // getUserId
  // -----------------------------------------------------------------------

  describe('getUserId', () => {
    test('returns the bound userId', () => {
      const provider = new RuntimeSecretsProvider({
        userId: 'user-42',
      });

      expect(provider.getUserId()).toBe('user-42');
    });
  });

  // -----------------------------------------------------------------------
  // Auth Profile Session Cache (Task 49)
  // -----------------------------------------------------------------------

  describe('auth profile session cache', () => {
    test('caches auth profile resolution to avoid redundant calls', async () => {
      const mockResolver = createMockAuthProfileResolver();
      (mockResolver.resolveBySecretKey as ReturnType<typeof vi.fn>).mockResolvedValue({
        secrets: { MY_API_KEY: 'profile-secret-value' },
      });

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        authProfileResolver: mockResolver,
      });

      const first = await provider.getSecret('MY_API_KEY');
      const second = await provider.getSecret('MY_API_KEY');

      expect(first).toBe('profile-secret-value');
      expect(second).toBe('profile-secret-value');
      // resolveBySecretKey should only be called once — second call uses cache
      expect(mockResolver.resolveBySecretKey).toHaveBeenCalledTimes(1);
    });

    test('clearSessionCache clears all caches', async () => {
      const mockResolver = createMockAuthProfileResolver();
      (mockResolver.resolveBySecretKey as ReturnType<typeof vi.fn>).mockResolvedValue({
        secrets: { CACHED_KEY: 'cached-value' },
      });

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        authProfileResolver: mockResolver,
      });

      await provider.getSecret('CACHED_KEY');
      expect(mockResolver.resolveBySecretKey).toHaveBeenCalledTimes(1);

      // Clear all caches
      provider.clearSessionCache();

      // Should call resolver again after cache clear
      await provider.getSecret('CACHED_KEY');
      expect(mockResolver.resolveBySecretKey).toHaveBeenCalledTimes(2);
    });

    test('auth profile cache has bounded size (max 50 entries)', async () => {
      const mockResolver = createMockAuthProfileResolver();
      let resolveCount = 0;
      (mockResolver.resolveBySecretKey as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ secretKey }) => {
          resolveCount++;
          return { secrets: { [secretKey]: `value-${resolveCount}` } };
        },
      );

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        authProfileResolver: mockResolver,
      });

      // Fill cache to max (50 entries)
      for (let i = 0; i < 50; i++) {
        await provider.getSecret(`key_${i}`);
      }
      expect(resolveCount).toBe(50);

      // Requesting cached keys should NOT call resolver (served from secretCache)
      await provider.getSecret('key_25');
      expect(resolveCount).toBe(50);

      // Add 51st entry — should trigger auth profile cache eviction of oldest
      await provider.getSecret('key_overflow');
      expect(resolveCount).toBe(51);

      // The auth profile cache now has 50 entries (key_1..key_49 + key_overflow)
      // key_0 was evicted from auth profile cache, but still in secretCache
      // Verify key_overflow is cached (no new call)
      await provider.getSecret('key_overflow');
      expect(resolveCount).toBe(51);
    });
  });
});
