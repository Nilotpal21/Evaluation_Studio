import { describe, it, expect } from 'vitest';
import {
  AUTH_PROFILE_USAGE_MODES,
  CreateAuthProfileSchema,
  UpdateAuthProfileSchema,
  NoneConfigSchema,
  ApiKeyConfigSchema,
  BearerConfigSchema,
  OAuth2AppConfigSchema,
  OAuth2TokenConfigSchema,
  OAuth2ClientCredentialsConfigSchema,
  NoneSecretsSchema,
  ApiKeySecretsSchema,
  BearerSecretsSchema,
  OAuth2AppSecretsSchema,
  OAuth2TokenSecretsSchema,
  OAuth2ClientCredentialsSecretsSchema,
} from '../../validation/auth-profile.schema.js';

// ── Config Schemas ──────────────────────────────────────────────────

describe('NoneConfigSchema', () => {
  it('accepts empty object', () => {
    expect(NoneConfigSchema.safeParse({}).success).toBe(true);
  });

  it('rejects unknown fields (.strict())', () => {
    expect(NoneConfigSchema.safeParse({ foo: 'bar' }).success).toBe(false);
  });
});

describe('ApiKeyConfigSchema', () => {
  it('requires headerName', () => {
    const result = ApiKeyConfigSchema.safeParse({ placement: 'header' });
    expect(result.success).toBe(false);
  });

  it('defaults placement to "header"', () => {
    const result = ApiKeyConfigSchema.safeParse({ headerName: 'X-Api-Key' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.placement).toBe('header');
    }
  });

  it('accepts "query" placement', () => {
    const result = ApiKeyConfigSchema.safeParse({
      headerName: 'api_key',
      placement: 'query',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown fields (.strict())', () => {
    const result = ApiKeyConfigSchema.safeParse({
      headerName: 'X-Api-Key',
      extra: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('BearerConfigSchema', () => {
  it('accepts empty object', () => {
    expect(BearerConfigSchema.safeParse({}).success).toBe(true);
  });

  it('accepts optional prefix (e.g. Bearer)', () => {
    const result = BearerConfigSchema.safeParse({ prefix: 'Bearer' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prefix).toBe('Bearer');
    }
  });

  it('rejects unknown fields', () => {
    expect(BearerConfigSchema.safeParse({ foo: 1 }).success).toBe(false);
  });
});

describe('OAuth2AppConfigSchema', () => {
  it('requires authorizationUrl and tokenUrl', () => {
    const result = OAuth2AppConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts valid full config', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      refreshUrl: 'https://oauth2.googleapis.com/token',
      defaultScopes: ['email', 'profile'],
      scopeSeparator: ' ',
      pkceRequired: true,
      pkceMethod: 'S256',
      supportedGrantTypes: ['authorization_code'],
    });
    expect(result.success).toBe(true);
  });

  it('normalizes legacy scopes to defaultScopes', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['email', 'profile'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultScopes).toEqual(['email', 'profile']);
      expect(result.data).not.toHaveProperty('scopes');
    }
  });

  it('rejects conflicting defaultScopes and legacy scopes values', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      defaultScopes: ['email'],
      scopes: ['profile'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-URL authorizationUrl', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      authorizationUrl: 'not-a-url',
      tokenUrl: 'https://example.com/token',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      malicious: 'data',
    });
    expect(result.success).toBe(false);
  });
});

describe('OAuth2TokenConfigSchema', () => {
  it('requires provider', () => {
    const result = OAuth2TokenConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts valid config', () => {
    const result = OAuth2TokenConfigSchema.safeParse({
      provider: 'google',
      scopes: ['email'],
      grantedScopes: ['email'],
      tokenType: 'bearer',
      refreshTokenRotation: false,
    });
    expect(result.success).toBe(true);
  });
});

describe('OAuth2ClientCredentialsConfigSchema', () => {
  it('requires tokenUrl', () => {
    const result = OAuth2ClientCredentialsConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts valid config', () => {
    const result = OAuth2ClientCredentialsConfigSchema.safeParse({
      tokenUrl: 'https://example.com/oauth/token',
      scopes: ['read', 'write'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional audience', () => {
    const result = OAuth2ClientCredentialsConfigSchema.safeParse({
      tokenUrl: 'https://example.com/oauth/token',
      scopes: ['read'],
      audience: 'https://api.example.com/',
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-HTTPS tokenUrl outside localhost', () => {
    const result = OAuth2ClientCredentialsConfigSchema.safeParse({
      tokenUrl: 'http://example.com/oauth/token',
      scopes: ['read'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects SSRF-unsafe tokenUrl', () => {
    const result = OAuth2ClientCredentialsConfigSchema.safeParse({
      tokenUrl: 'https://169.254.169.254/latest/meta-data/iam/security-credentials',
      scopes: ['read'],
    });
    expect(result.success).toBe(false);
  });
});

// ── Secrets Schemas ─────────────────────────────────────────────────

describe('NoneSecretsSchema', () => {
  it('accepts empty object', () => {
    expect(NoneSecretsSchema.safeParse({}).success).toBe(true);
  });
});

describe('ApiKeySecretsSchema', () => {
  it('requires apiKey', () => {
    expect(ApiKeySecretsSchema.safeParse({}).success).toBe(false);
  });

  it('accepts valid secrets', () => {
    expect(ApiKeySecretsSchema.safeParse({ apiKey: 'sk-1234' }).success).toBe(true);
  });
});

describe('BearerSecretsSchema', () => {
  it('requires token', () => {
    expect(BearerSecretsSchema.safeParse({}).success).toBe(false);
  });
});

describe('OAuth2AppSecretsSchema', () => {
  it('requires clientId and clientSecret', () => {
    expect(OAuth2AppSecretsSchema.safeParse({}).success).toBe(false);
    expect(OAuth2AppSecretsSchema.safeParse({ clientId: 'x' }).success).toBe(false);
  });

  it('accepts valid secrets', () => {
    expect(
      OAuth2AppSecretsSchema.safeParse({ clientId: 'id', clientSecret: 'secret' }).success,
    ).toBe(true);
  });
});

describe('OAuth2TokenSecretsSchema', () => {
  it('requires accessToken', () => {
    expect(OAuth2TokenSecretsSchema.safeParse({}).success).toBe(false);
  });

  it('accepts optional refreshToken, idToken, providerUserId', () => {
    const result = OAuth2TokenSecretsSchema.safeParse({
      accessToken: 'ya29.xxx',
      refreshToken: '1//xxx',
      idToken: 'eyJ...',
      providerUserId: 'user@gmail.com',
    });
    expect(result.success).toBe(true);
  });
});

describe('OAuth2ClientCredentialsSecretsSchema', () => {
  it('requires clientId and clientSecret', () => {
    expect(OAuth2ClientCredentialsSecretsSchema.safeParse({}).success).toBe(false);
  });
});

// ── CreateAuthProfileSchema (discriminated union) ───────────────────

describe('CreateAuthProfileSchema', () => {
  const base = {
    name: 'My Gmail App',
    projectId: 'proj-1',
    scope: 'project' as const,
    visibility: 'shared' as const,
  };

  it('accepts valid "none" profile', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'none',
      config: {},
      secrets: {},
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid "api_key" profile', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'api_key',
      config: { headerName: 'X-Api-Key' },
      secrets: { apiKey: 'sk-123' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid "bearer" profile with optional config.prefix', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'bearer',
      config: { prefix: 'Bearer' },
      secrets: { token: 'token-value' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid "oauth2_app" profile', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'oauth2_app',
      usageMode: 'jit',
      config: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
      },
      secrets: { clientId: 'id', clientSecret: 'secret' },
    });
    expect(result.success).toBe(true);
  });

  it('normalizes oauth2_app legacy scopes during create parsing', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'oauth2_app',
      config: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        refreshUrl: 'https://oauth2.googleapis.com/token',
        scopes: ['openid', 'email'],
      },
      secrets: { clientId: 'id', clientSecret: 'secret' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.config).toEqual({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        refreshUrl: 'https://oauth2.googleapis.com/token',
        defaultScopes: ['openid', 'email'],
      });
    }
  });

  it('accepts valid "oauth2_token" profile with linkedAppProfileId', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'oauth2_token',
      linkedAppProfileId: 'ap-google-app',
      config: {
        provider: 'google',
        tokenType: 'bearer',
      },
      secrets: { accessToken: 'ya29.token' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects "oauth2_token" profile without linkedAppProfileId', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'oauth2_token',
      config: {
        provider: 'google',
      },
      secrets: { accessToken: 'ya29.token' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects linkedAppProfileId on non-oauth2_token profiles', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'bearer',
      linkedAppProfileId: 'ap-google-app',
      config: {},
      secrets: { token: 'token-value' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects incompatible usageMode/authType combinations', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'api_key',
      usageMode: 'preflight',
      config: { headerName: 'X-Api-Key' },
      secrets: { apiKey: 'sk-123' },
    });

    expect(result.success).toBe(false);
  });

  it('accepts Phase 2 basic auth type', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'basic',
      config: {},
      secrets: { username: 'u', password: 'p' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown auth types', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'unknown_type',
      config: {},
      secrets: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects mismatched config for authType', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'api_key',
      config: {}, // missing headerName
      secrets: { apiKey: 'sk-123' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects addon fields in Phase 1', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'none',
      config: {},
      secrets: {},
      signing: { algorithm: 'hmac-sha256' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects rotationPolicy in Phase 1', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'none',
      config: {},
      secrets: {},
      rotationPolicy: { intervalDays: 90 },
    });
    expect(result.success).toBe(false);
  });

  it('enforces scope/projectId consistency: scope=tenant requires projectId=null', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'none',
      config: {},
      secrets: {},
      scope: 'tenant',
      projectId: 'proj-1', // invalid: tenant scope with projectId
    });
    expect(result.success).toBe(false);
  });

  it('enforces scope/projectId consistency: scope=project requires non-null projectId', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'none',
      config: {},
      secrets: {},
      scope: 'project',
      projectId: null, // invalid: project scope without projectId
    });
    expect(result.success).toBe(false);
  });

  it('enforces tenant-scope visibility: tenant + personal is rejected', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'none',
      config: {},
      secrets: {},
      scope: 'tenant',
      projectId: null,
      visibility: 'personal', // invalid: personal at tenant level
    });
    expect(result.success).toBe(false);
  });

  it('strips createdBy from body (never accepted from request)', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'none',
      config: {},
      secrets: {},
      createdBy: 'attacker-id',
    });
    // createdBy should not be in the parsed output
    if (result.success) {
      expect((result.data as any).createdBy).toBeUndefined();
    }
  });
});

// ── UpdateAuthProfileSchema ────────────────────────────────────────

describe('UpdateAuthProfileSchema', () => {
  it('accepts partial update (name only)', () => {
    const result = UpdateAuthProfileSchema.safeParse({ name: 'New Name' });
    expect(result.success).toBe(true);
  });

  it('accepts config + secrets update', () => {
    const result = UpdateAuthProfileSchema.safeParse({
      config: { headerName: 'X-New-Key' },
      secrets: { apiKey: 'new-key' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects authType change (immutable)', () => {
    const result = UpdateAuthProfileSchema.safeParse({ authType: 'bearer' });
    expect(result.success).toBe(false);
  });

  it('rejects createdBy change (immutable)', () => {
    const result = UpdateAuthProfileSchema.safeParse({ createdBy: 'new-user' });
    expect(result.success).toBe(false);
  });

  it('rejects addon fields in Phase 1', () => {
    const result = UpdateAuthProfileSchema.safeParse({
      signing: { algorithm: 'hmac-sha256' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty update', () => {
    const result = UpdateAuthProfileSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts usageMode updates', () => {
    const result = UpdateAuthProfileSchema.safeParse({
      usageMode: AUTH_PROFILE_USAGE_MODES[2],
    });
    expect(result.success).toBe(true);
  });
});
