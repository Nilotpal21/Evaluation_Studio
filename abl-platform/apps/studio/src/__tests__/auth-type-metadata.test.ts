import { describe, expect, it } from 'vitest';
import {
  AUTH_TYPE_CATEGORIES,
  AUTH_TYPE_METADATA,
  AUTH_TYPE_USAGE_MODES,
  SUPPORTED_AUTH_TYPES,
} from '@/components/auth-profiles/auth-type-metadata';

describe('AUTH_TYPE_METADATA', () => {
  it('uses defaultScopes for oauth2_app config fields', () => {
    const configKeys = AUTH_TYPE_METADATA.oauth2_app.configFields.map((field) => field.key);

    expect(configKeys).toContain('defaultScopes');
    expect(configKeys).not.toContain('scopes');
  });

  it('includes prefix for api_key config fields', () => {
    const configKeys = AUTH_TYPE_METADATA.api_key.configFields.map((field) => field.key);

    expect(configKeys).toContain('prefix');
  });

  it('marks oauth2_token linked app as a top-level field and requires provider config', () => {
    const providerField = AUTH_TYPE_METADATA.oauth2_token.configFields.find(
      (field) => field.key === 'provider',
    );
    const linkedAppField = AUTH_TYPE_METADATA.oauth2_token.configFields.find(
      (field) => field.key === 'linkedAppProfileId',
    );

    expect(providerField?.required).toBe(true);
    expect(linkedAppField?.target).toBe('profile');
  });

  it('defines supported usage modes per auth type', () => {
    expect(AUTH_TYPE_USAGE_MODES.oauth2_app).toEqual(['preconfigured', 'jit', 'preflight']);
    expect(AUTH_TYPE_USAGE_MODES.oauth2_token).toEqual(['user_token']);
    expect(AUTH_TYPE_USAGE_MODES.api_key).toEqual(['preconfigured']);
    expect(AUTH_TYPE_USAGE_MODES.aws_iam).toEqual(['preconfigured']);
    expect(AUTH_TYPE_USAGE_MODES.mtls).toEqual(['preconfigured']);
  });

  it('exposes the Phase 2 core auth types in the Studio selector list', () => {
    expect(SUPPORTED_AUTH_TYPES).toEqual(
      expect.arrayContaining(['basic', 'custom_header', 'aws_iam', 'mtls']),
    );
  });

  it('exposes the complete create-profile selector list by default', () => {
    expect(AUTH_TYPE_CATEGORIES).toEqual(
      expect.arrayContaining([{ key: 'enterprise', label: 'Enterprise Identity' }]),
    );
    expect(SUPPORTED_AUTH_TYPES).toEqual(
      expect.arrayContaining([
        'api_key',
        'bearer',
        'basic',
        'custom_header',
        'oauth2_app',
        'oauth2_client_credentials',
        'azure_ad',
        'mtls',
        'aws_iam',
        'ssh_key',
        'digest',
        'kerberos',
        'saml',
        'hawk',
        'ws_security',
      ]),
    );
    expect(AUTH_TYPE_METADATA.azure_ad.category).toBe('enterprise');
    expect(AUTH_TYPE_METADATA.aws_iam.label).toBe('AWS IAM (SigV4)');
    expect(AUTH_TYPE_METADATA.mtls.label).toBe('mTLS');
  });

  it('marks AWS IAM service as a required configuration field', () => {
    const serviceField = AUTH_TYPE_METADATA.aws_iam.configFields.find(
      (field) => field.key === 'service',
    );

    expect(serviceField?.required).toBe(true);
  });
});
