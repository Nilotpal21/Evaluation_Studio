import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { JWTAuth } from '../../adapters/auth/jwt.js';
import { OAuth2ClientAuth } from '../../adapters/auth/oauth2-client.js';
import { AdapterRegistry } from '../../adapters/registry.js';
import type { ProviderConfig } from '../../config/schema.js';
import type { AuthCredentials } from '../../types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../security/ssrf-guard.js', () => ({
  assertAllowedUrl: vi.fn().mockResolvedValue(undefined),
  assertAllowedUrlSync: vi.fn(),
}));

const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = mockFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function makeProviderConfig(authOverrides: Record<string, unknown>): ProviderConfig {
  return {
    name: 'test-provider',
    enabled: true,
    auth: authOverrides,
    options: {},
    circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000 },
    timeoutMs: 30000,
  };
}

describe('JWTAuth', () => {
  let auth: JWTAuth;

  beforeEach(() => {
    auth = new JWTAuth();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('authenticate', () => {
    it('returns static JWT when no tokenUrl is configured', async () => {
      const config = makeProviderConfig({ jwt: 'static-token-123' });
      const creds = await auth.authenticate(config);
      expect(creds.type).toBe('jwt');
      expect(creds.token).toBe('static-token-123');
      expect(creds.headers).toEqual({ authorization: 'Bearer static-token-123' });
      expect(creds.expiresAt).toBeGreaterThan(Date.now());
    });

    it('throws when neither jwt nor tokenUrl is provided', async () => {
      const config = makeProviderConfig({});
      await expect(auth.authenticate(config)).rejects.toThrow(
        'JWTAuth requires auth.jwt or auth.tokenUrl',
      );
    });

    it('fetches token from tokenUrl when configured', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'fetched-jwt-token', expires_in: 1800 }),
      });
      const config = makeProviderConfig({
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'my-client',
        clientSecret: 'my-secret',
      });
      const creds = await auth.authenticate(config);
      expect(creds.type).toBe('jwt');
      expect(creds.token).toBe('fetched-jwt-token');
      expect(creds.headers).toEqual({ authorization: 'Bearer fetched-jwt-token' });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('throws on token endpoint failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });
      const config = makeProviderConfig({
        tokenUrl: 'https://auth.example.com/token',
      });
      await expect(auth.authenticate(config)).rejects.toThrow(
        'JWT token request failed: 401 Unauthorized',
      );
    });

    it('throws when token endpoint returns no token field', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ some_other_field: 'value' }),
      });
      const config = makeProviderConfig({
        tokenUrl: 'https://auth.example.com/token',
      });
      await expect(auth.authenticate(config)).rejects.toThrow(
        'JWT token endpoint returned no access_token or token field',
      );
    });

    it('accepts token field as alternative to access_token', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ token: 'jwt-via-token-field', expires_in: 600 }),
      });
      const config = makeProviderConfig({
        tokenUrl: 'https://auth.example.com/token',
      });
      const creds = await auth.authenticate(config);
      expect(creds.token).toBe('jwt-via-token-field');
    });
  });

  describe('refresh', () => {
    it('returns existing credentials when no config is available', async () => {
      const existing: AuthCredentials = {
        type: 'jwt',
        token: 'old-token',
        headers: { authorization: 'Bearer old-token' },
        expiresAt: Date.now() - 1000,
      };
      const result = await auth.refresh(existing);
      expect(result).toBe(existing);
    });

    it('fetches a new token on refresh when tokenUrl is configured', async () => {
      // First call: authenticate to store config
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'initial-token', expires_in: 1800 }),
      });
      const config = makeProviderConfig({
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'my-client',
        clientSecret: 'my-secret',
      });
      await auth.authenticate(config);

      // Second call: refresh should fetch a new token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'refreshed-token', expires_in: 1800 }),
      });
      const existing: AuthCredentials = {
        type: 'jwt',
        token: 'initial-token',
        expiresAt: Date.now() - 1000,
      };
      const refreshed = await auth.refresh(existing);
      expect(refreshed.token).toBe('refreshed-token');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('re-reads static JWT from config on refresh', async () => {
      const config = makeProviderConfig({ jwt: 'static-jwt' });
      await auth.authenticate(config);

      const existing: AuthCredentials = {
        type: 'jwt',
        token: 'static-jwt',
        expiresAt: Date.now() - 1000,
      };
      const refreshed = await auth.refresh(existing);
      expect(refreshed.token).toBe('static-jwt');
      expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
    });
  });
});

describe('OAuth2ClientAuth', () => {
  let auth: OAuth2ClientAuth;

  beforeEach(() => {
    auth = new OAuth2ClientAuth();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('authenticate', () => {
    it('fetches access_token via client_credentials grant', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'oauth-token-abc', expires_in: 3600 }),
      });
      const config = makeProviderConfig({
        clientId: 'client-123',
        clientSecret: 'secret-456',
        tokenUrl: 'https://auth.example.com/oauth/token',
      });
      const creds = await auth.authenticate(config);
      expect(creds.type).toBe('oauth2');
      expect(creds.token).toBe('oauth-token-abc');
      expect(creds.headers).toEqual({ authorization: 'Bearer oauth-token-abc' });
    });

    it('throws when clientId is missing', async () => {
      const config = makeProviderConfig({
        clientSecret: 'secret',
        tokenUrl: 'https://auth.example.com/token',
      });
      await expect(auth.authenticate(config)).rejects.toThrow(
        'OAuth2ClientAuth requires auth.clientId',
      );
    });

    it('throws when clientSecret is missing', async () => {
      const config = makeProviderConfig({
        clientId: 'client',
        tokenUrl: 'https://auth.example.com/token',
      });
      await expect(auth.authenticate(config)).rejects.toThrow(
        'OAuth2ClientAuth requires auth.clientSecret',
      );
    });

    it('throws when tokenUrl is missing', async () => {
      const config = makeProviderConfig({
        clientId: 'client',
        clientSecret: 'secret',
      });
      await expect(auth.authenticate(config)).rejects.toThrow(
        'OAuth2ClientAuth requires auth.tokenUrl',
      );
    });
  });

  describe('refresh', () => {
    it('returns existing credentials when no config is available', async () => {
      const existing: AuthCredentials = {
        type: 'oauth2',
        token: 'old-oauth-token',
        expiresAt: Date.now() - 1000,
      };
      const result = await auth.refresh(existing);
      expect(result).toBe(existing);
    });

    it('fetches a new token on refresh using stored config', async () => {
      // Authenticate first
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'initial-oauth', expires_in: 3600 }),
      });
      const config = makeProviderConfig({
        clientId: 'client-123',
        clientSecret: 'secret-456',
        tokenUrl: 'https://auth.example.com/oauth/token',
      });
      await auth.authenticate(config);

      // Refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'refreshed-oauth', expires_in: 3600 }),
      });
      const existing: AuthCredentials = {
        type: 'oauth2',
        token: 'initial-oauth',
        expiresAt: Date.now() - 1000,
      };
      const refreshed = await auth.refresh(existing);
      expect(refreshed.token).toBe('refreshed-oauth');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('replaces stale token with fresh one', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token-v1', expires_in: 10 }),
      });
      const config = makeProviderConfig({
        clientId: 'c',
        clientSecret: 's',
        tokenUrl: 'https://auth.example.com/token',
      });
      const initial = await auth.authenticate(config);
      expect(initial.token).toBe('token-v1');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token-v2', expires_in: 3600 }),
      });
      const refreshed = await auth.refresh(initial);
      expect(refreshed.token).toBe('token-v2');
      expect(refreshed.token).not.toBe(initial.token);
    });
  });
});

describe('AdapterRegistry.invalidateAuth', () => {
  it('calls adapter.invalidateAuth when the adapter supports it', () => {
    const registry = new AdapterRegistry();
    const invalidateAuth = vi.fn();
    const adapter = {
      name: 'test',
      capabilities: {
        supportsPreChecks: false,
        supportsPostAgentDialog: false,
        supportsFileUpload: false,
        supportsTranslation: false,
        transportType: 'webhook' as const,
        authType: 'oauth2' as const,
      },
      initialize: vi.fn(),
      execute: vi.fn(),
      sendUserMessage: vi.fn(),
      endSession: vi.fn(),
      onAgentMessage: vi.fn(),
      onSessionEvent: vi.fn(),
      invalidateAuth,
    };
    registry.register('test', adapter);
    registry.invalidateAuth('test', 'tenant-1');
    expect(invalidateAuth).toHaveBeenCalledWith('tenant-1');
  });

  it('does not throw when adapter lacks invalidateAuth', () => {
    const registry = new AdapterRegistry();
    const adapter = {
      name: 'basic',
      capabilities: {
        supportsPreChecks: false,
        supportsPostAgentDialog: false,
        supportsFileUpload: false,
        supportsTranslation: false,
        transportType: 'webhook' as const,
        authType: 'basic' as const,
      },
      initialize: vi.fn(),
      execute: vi.fn(),
      sendUserMessage: vi.fn(),
      endSession: vi.fn(),
      onAgentMessage: vi.fn(),
      onSessionEvent: vi.fn(),
    };
    registry.register('basic', adapter);
    expect(() => registry.invalidateAuth('basic', 'tenant-1')).not.toThrow();
  });

  it('warns when adapter is not found', () => {
    const registry = new AdapterRegistry();
    expect(() => registry.invalidateAuth('nonexistent', 'tenant-1')).not.toThrow();
  });
});
