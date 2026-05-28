import { describe, it, expect } from 'vitest';
import { OAuth2AppConfigSchema } from '../../validation/auth-profile.schema.js';

const VALID_BASE_CONFIG = {
  authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
};

describe('OAuth2AppConfigSchema — integration extension fields', () => {
  it('accepts authorizationParams as record of strings', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      ...VALID_BASE_CONFIG,
      authorizationParams: { access_type: 'offline', prompt: 'consent' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.authorizationParams).toEqual({
        access_type: 'offline',
        prompt: 'consent',
      });
    }
  });

  it('accepts tokenParams as record of strings', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      ...VALID_BASE_CONFIG,
      tokenParams: { audience: 'https://api.example.com' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tokenParams).toEqual({
        audience: 'https://api.example.com',
      });
    }
  });

  it('accepts connectionConfig as record of strings', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      ...VALID_BASE_CONFIG,
      connectionConfig: { instance: 'mycompany' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.connectionConfig).toEqual({ instance: 'mycompany' });
    }
  });

  it('rejects authorizationParams with non-string value (wrong type)', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      ...VALID_BASE_CONFIG,
      authorizationParams: 'string',
    });
    expect(result.success).toBe(false);
  });

  it('rejects connectionConfig with non-string record values', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      ...VALID_BASE_CONFIG,
      connectionConfig: { key: 123 },
    });
    expect(result.success).toBe(false);
  });

  it('still rejects unknown fields (.strict() preserved)', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      ...VALID_BASE_CONFIG,
      unknownField: 'should-fail',
    });
    expect(result.success).toBe(false);
  });

  it('validates existing oauth2_app configs without new fields', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      ...VALID_BASE_CONFIG,
      defaultScopes: ['openid', 'email'],
      pkceRequired: true,
      pkceMethod: 'S256',
    });
    expect(result.success).toBe(true);
  });

  it('accepts all three new fields simultaneously', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      ...VALID_BASE_CONFIG,
      authorizationParams: { access_type: 'offline' },
      tokenParams: { audience: 'https://api.example.com' },
      connectionConfig: { instance: 'mycompany', subdomain: 'api' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.authorizationParams).toEqual({
        access_type: 'offline',
      });
      expect(result.data.tokenParams).toEqual({
        audience: 'https://api.example.com',
      });
      expect(result.data.connectionConfig).toEqual({
        instance: 'mycompany',
        subdomain: 'api',
      });
    }
  });
});
