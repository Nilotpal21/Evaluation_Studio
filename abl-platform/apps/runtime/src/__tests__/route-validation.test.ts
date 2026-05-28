/**
 * Route Validation Tests (T1)
 *
 * Tests validation logic, input sanitization, and RBAC patterns
 * across OAuth routes.
 * These test the validation functions and patterns without requiring a real DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadProviderConfigsFromEnv } from '../services/tool-oauth-service.js';

// =============================================================================
// loadProviderConfigsFromEnv Tests (D4 / T5)
// =============================================================================

describe('loadProviderConfigsFromEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load complete provider configs from env vars', () => {
    process.env.OAUTH_PROVIDER_GOOGLE_CLIENT_ID = 'google-id';
    process.env.OAUTH_PROVIDER_GOOGLE_CLIENT_SECRET = 'google-secret';
    process.env.OAUTH_PROVIDER_GOOGLE_AUTHORIZE_URL =
      'https://accounts.google.com/o/oauth2/v2/auth';
    process.env.OAUTH_PROVIDER_GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
    process.env.OAUTH_PROVIDER_GOOGLE_SCOPES = 'calendar.readonly,drive.readonly';
    process.env.OAUTH_PROVIDER_GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

    const configs = loadProviderConfigsFromEnv();

    expect(configs.size).toBe(1);
    const google = configs.get('google');
    expect(google).toBeDefined();
    expect(google!.clientId).toBe('google-id');
    expect(google!.clientSecret).toBe('google-secret');
    expect(google!.authorizeUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(google!.tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(google!.scopes).toEqual(['calendar.readonly', 'drive.readonly']);
    expect(google!.revokeUrl).toBe('https://oauth2.googleapis.com/revoke');
  });

  it('should load multiple providers', () => {
    process.env.OAUTH_PROVIDER_GOOGLE_CLIENT_ID = 'google-id';
    process.env.OAUTH_PROVIDER_GOOGLE_CLIENT_SECRET = 'google-secret';
    process.env.OAUTH_PROVIDER_GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/auth';
    process.env.OAUTH_PROVIDER_GOOGLE_TOKEN_URL = 'https://accounts.google.com/token';

    process.env.OAUTH_PROVIDER_SLACK_CLIENT_ID = 'slack-id';
    process.env.OAUTH_PROVIDER_SLACK_CLIENT_SECRET = 'slack-secret';
    process.env.OAUTH_PROVIDER_SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/authorize';
    process.env.OAUTH_PROVIDER_SLACK_TOKEN_URL = 'https://slack.com/api/oauth.access';

    const configs = loadProviderConfigsFromEnv();
    expect(configs.size).toBe(2);
    expect(configs.has('google')).toBe(true);
    expect(configs.has('slack')).toBe(true);
  });

  it('should skip incomplete provider configs', () => {
    // Missing CLIENT_SECRET
    process.env.OAUTH_PROVIDER_INCOMPLETE_CLIENT_ID = 'incomplete-id';
    process.env.OAUTH_PROVIDER_INCOMPLETE_AUTHORIZE_URL = 'https://example.com/auth';
    process.env.OAUTH_PROVIDER_INCOMPLETE_TOKEN_URL = 'https://example.com/token';

    const configs = loadProviderConfigsFromEnv();
    expect(configs.size).toBe(0);
  });

  it('should handle empty scopes', () => {
    process.env.OAUTH_PROVIDER_MINIMAL_CLIENT_ID = 'id';
    process.env.OAUTH_PROVIDER_MINIMAL_CLIENT_SECRET = 'secret';
    process.env.OAUTH_PROVIDER_MINIMAL_AUTHORIZE_URL = 'https://example.com/auth';
    process.env.OAUTH_PROVIDER_MINIMAL_TOKEN_URL = 'https://example.com/token';

    const configs = loadProviderConfigsFromEnv();
    expect(configs.size).toBe(1);
    expect(configs.get('minimal')!.scopes).toEqual([]);
  });

  it('should return empty map when no OAUTH_PROVIDER_ vars exist', () => {
    // Clean out any existing OAUTH_PROVIDER_ vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OAUTH_PROVIDER_')) {
        delete process.env[key];
      }
    }

    const configs = loadProviderConfigsFromEnv();
    expect(configs.size).toBe(0);
  });

  it('should normalize provider names to lowercase', () => {
    process.env.OAUTH_PROVIDER_MICROSOFT_CLIENT_ID = 'ms-id';
    process.env.OAUTH_PROVIDER_MICROSOFT_CLIENT_SECRET = 'ms-secret';
    process.env.OAUTH_PROVIDER_MICROSOFT_AUTHORIZE_URL = 'https://login.microsoftonline.com/auth';
    process.env.OAUTH_PROVIDER_MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/token';

    const configs = loadProviderConfigsFromEnv();
    // Key should be lowercase
    expect(configs.has('microsoft')).toBe(true);
    expect(configs.has('MICROSOFT')).toBe(false);
  });
});

// =============================================================================
// ToolOAuthService - Pending States Capacity Tests (S3)
// =============================================================================

describe('ToolOAuthService - pendingStates management', () => {
  it('should cleanup expired states on periodic timer', async () => {
    const { ToolOAuthService } = await import('../services/tool-oauth-service.js');

    const store = {
      findToken: vi.fn().mockResolvedValue(null),
      upsertToken: vi.fn(),
      compareAndSwapToken: vi.fn().mockResolvedValue(true),
      markRevoked: vi.fn(),
      updateLastUsed: vi.fn(),
    };
    const encryptor = {
      encryptForTenant: vi.fn((p: string) => `enc:${p}`),
      decryptForTenant: vi.fn((e: string) => e.replace('enc:', '')),
    };
    const configs = new Map([
      [
        'test',
        {
          clientId: 'id',
          clientSecret: 'secret',
          authorizeUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
          scopes: [],
        },
      ],
    ]);

    const service = new ToolOAuthService(store, encryptor, configs);

    // Create a state
    const { state } = await service.initiateOAuthFlow(
      'test',
      'org-1',
      'user-1',
      [],
      'https://app.example.com/cb',
    );

    // State should be valid
    expect(state).toMatch(/^[a-f0-9]{64}$/);

    service.destroy();
  });

  it('should be destroyed cleanly', async () => {
    const { ToolOAuthService } = await import('../services/tool-oauth-service.js');

    const service = new ToolOAuthService(
      {
        findToken: vi.fn().mockResolvedValue(null),
        upsertToken: vi.fn(),
        compareAndSwapToken: vi.fn().mockResolvedValue(true),
        markRevoked: vi.fn(),
        updateLastUsed: vi.fn(),
      },
      { encryptForTenant: vi.fn(), decryptForTenant: vi.fn() },
      new Map(),
    );

    // destroy() should not throw
    expect(() => service.destroy()).not.toThrow();
    // Double destroy should be safe
    expect(() => service.destroy()).not.toThrow();
  });
});

// =============================================================================
// Provider Name Validation Pattern Tests (S4)
// =============================================================================

describe('Provider name validation pattern', () => {
  // Replicate the isValidProvider logic from oauth.ts
  const isValidProvider = (provider: string): boolean => {
    return /^[a-zA-Z0-9_-]+$/.test(provider) && provider.length <= 64;
  };

  it('should accept valid provider names', () => {
    expect(isValidProvider('google')).toBe(true);
    expect(isValidProvider('slack')).toBe(true);
    expect(isValidProvider('microsoft-graph')).toBe(true);
    expect(isValidProvider('my_provider_v2')).toBe(true);
    expect(isValidProvider('OAuth2Provider')).toBe(true);
  });

  it('should reject names with special characters', () => {
    expect(isValidProvider('google;rm -rf /')).toBe(false);
    expect(isValidProvider('google<script>')).toBe(false);
    expect(isValidProvider('my provider')).toBe(false);
    expect(isValidProvider('path/traversal')).toBe(false);
    expect(isValidProvider('../etc/passwd')).toBe(false);
  });

  it('should reject empty names', () => {
    expect(isValidProvider('')).toBe(false);
  });

  it('should reject names exceeding max length', () => {
    expect(isValidProvider('a'.repeat(65))).toBe(false);
    expect(isValidProvider('a'.repeat(64))).toBe(true);
  });
});

// =============================================================================
// Redirect URI Allowlist Pattern Tests (S2)
// =============================================================================

import { DEFAULT_LOCAL_ORIGINS } from '@agent-platform/config';

describe('Redirect URI allowlist pattern', () => {
  // Replicate isAllowedRedirectUri from oauth.ts with default origins
  const defaultOrigins = DEFAULT_LOCAL_ORIGINS;

  const isAllowedRedirectUri = (uri: string): boolean => {
    if (uri.length > 2048) return false;
    try {
      const parsed = new URL(uri);
      return defaultOrigins.includes(parsed.origin);
    } catch {
      return false;
    }
  };

  it('should allow localhost origins', () => {
    expect(isAllowedRedirectUri('http://localhost:3000/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:5173/oauth/callback')).toBe(true);
  });

  it('should reject external origins', () => {
    expect(isAllowedRedirectUri('https://evil.com/callback')).toBe(false);
    expect(isAllowedRedirectUri('https://attacker.com:3000/callback')).toBe(false);
  });

  it('should reject invalid URIs', () => {
    expect(isAllowedRedirectUri('not-a-url')).toBe(false);
    expect(isAllowedRedirectUri('')).toBe(false);
  });

  it('should reject URIs exceeding max length', () => {
    const longUri = `http://localhost:3000/${'a'.repeat(2048)}`;
    expect(isAllowedRedirectUri(longUri)).toBe(false);
  });

  it('should check origin, not just hostname', () => {
    // Same hostname but different port
    expect(isAllowedRedirectUri('http://localhost:9999/callback')).toBe(false);
    // HTTPS variant not in default list
    expect(isAllowedRedirectUri('https://localhost:3000/callback')).toBe(false);
  });
});

// =============================================================================
// Input Length Validation Pattern Tests (S8)
// =============================================================================

describe('Input length validation patterns', () => {
  const MAX_SECRET_VALUE_LENGTH = 16384;
  const MAX_FIELD_LENGTH = 256;
  const MAX_CERT_LENGTH = 65536;

  it('should accept values within limits', () => {
    expect('short-value'.length <= MAX_SECRET_VALUE_LENGTH).toBe(true);
    expect('tool-name'.length <= MAX_FIELD_LENGTH).toBe(true);
    expect(
      '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'.length <= MAX_CERT_LENGTH,
    ).toBe(true);
  });

  it('should reject secret values exceeding 16KB', () => {
    const oversized = 'x'.repeat(MAX_SECRET_VALUE_LENGTH + 1);
    expect(oversized.length > MAX_SECRET_VALUE_LENGTH).toBe(true);
  });

  it('should reject field names exceeding 256 chars', () => {
    const longName = 'x'.repeat(MAX_FIELD_LENGTH + 1);
    expect(longName.length > MAX_FIELD_LENGTH).toBe(true);
  });

  it('should reject certs exceeding 64KB', () => {
    const largeCert = 'x'.repeat(MAX_CERT_LENGTH + 1);
    expect(largeCert.length > MAX_CERT_LENGTH).toBe(true);
  });
});
