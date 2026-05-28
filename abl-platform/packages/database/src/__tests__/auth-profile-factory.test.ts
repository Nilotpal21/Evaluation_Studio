import { describe, it, expect, vi } from 'vitest';
import {
  makeAuthProfile,
  makeDecryptedCredentials,
  makeAuthProfileService,
  AUTH_TYPE_FIXTURES,
} from './helpers/auth-profile-factory.js';

describe('makeAuthProfile', () => {
  it('returns a valid AuthProfile document with defaults', () => {
    const profile = makeAuthProfile();
    expect(profile.tenantId).toBeDefined();
    expect(profile.name).toBeDefined();
    expect(profile.authType).toBe('api_key');
    expect(profile.scope).toBe('project');
    expect(profile.projectId).toBeDefined();
    expect(profile.visibility).toBe('shared');
    expect(profile.status).toBe('active');
    expect(profile.createdBy).toBeDefined();
    expect(profile.encryptedSecrets).toBeDefined();
    expect(profile.encryptionKeyVersion).toBe(1);
    expect(profile.config).toBeDefined();
  });

  it('accepts overrides', () => {
    const profile = makeAuthProfile({
      authType: 'oauth2_app',
      name: 'Google OAuth',
      visibility: 'personal',
    });
    expect(profile.authType).toBe('oauth2_app');
    expect(profile.name).toBe('Google OAuth');
    expect(profile.visibility).toBe('personal');
  });

  it('generates unique _id per call', () => {
    const a = makeAuthProfile();
    const b = makeAuthProfile();
    expect(a._id).not.toBe(b._id);
  });

  it('sets projectId to null and scope to tenant when scope is tenant', () => {
    const profile = makeAuthProfile({ scope: 'tenant' });
    expect(profile.projectId).toBeNull();
    expect(profile.scope).toBe('tenant');
  });
});

describe('makeDecryptedCredentials', () => {
  for (const authType of [
    'none',
    'api_key',
    'bearer',
    'oauth2_app',
    'oauth2_token',
    'oauth2_client_credentials',
  ] as const) {
    it(`returns valid credentials for ${authType}`, () => {
      const creds = makeDecryptedCredentials(authType);
      expect(creds).toBeDefined();
      if (authType === 'none') {
        expect(creds).toEqual({});
      }
      if (authType === 'api_key') {
        expect(creds.apiKey).toBeDefined();
      }
      if (authType === 'bearer') {
        expect(creds.token).toBeDefined();
      }
      if (authType === 'oauth2_app') {
        expect(creds.clientId).toBeDefined();
        expect(creds.clientSecret).toBeDefined();
      }
      if (authType === 'oauth2_token') {
        expect(creds.accessToken).toBeDefined();
      }
      if (authType === 'oauth2_client_credentials') {
        expect(creds.clientId).toBeDefined();
        expect(creds.clientSecret).toBeDefined();
      }
    });
  }
});

describe('AUTH_TYPE_FIXTURES', () => {
  it('has config+secrets fixture for each Phase 1 auth type', () => {
    for (const authType of [
      'none',
      'api_key',
      'bearer',
      'oauth2_app',
      'oauth2_token',
      'oauth2_client_credentials',
    ]) {
      expect(AUTH_TYPE_FIXTURES[authType]).toBeDefined();
      expect(AUTH_TYPE_FIXTURES[authType].config).toBeDefined();
      expect(AUTH_TYPE_FIXTURES[authType].secrets).toBeDefined();
    }
  });
});

describe('makeAuthProfileService', () => {
  it('returns a mock service with all required methods', () => {
    const svc = makeAuthProfileService();
    expect(svc.create).toBeDefined();
    expect(svc.update).toBeDefined();
    expect(svc.delete).toBeDefined();
    expect(svc.resolve).toBeDefined();
    expect(svc.findById).toBeDefined();
    expect(svc.list).toBeDefined();
    expect(svc.validateAccess).toBeDefined();
    expect(svc.getConsumers).toBeDefined();
    expect(svc.revoke).toBeDefined();
  });

  it('accepts method overrides', () => {
    const profile = makeAuthProfile();
    const svc = makeAuthProfileService({
      findById: vi.fn().mockResolvedValue(profile),
    });
    expect(svc.findById).toBeDefined();
  });
});
