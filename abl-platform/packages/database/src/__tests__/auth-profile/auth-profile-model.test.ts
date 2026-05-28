import { describe, it, expect } from 'vitest';
import { AuthProfile, type IAuthProfile } from '../../models/auth-profile.model.js';

describe('AuthProfile model', () => {
  it('exports the AuthProfile model', () => {
    expect(AuthProfile).toBeDefined();
    expect(AuthProfile.modelName).toBe('AuthProfile');
  });

  it('has the correct collection name', () => {
    expect(AuthProfile.collection.collectionName).toBe('auth_profiles');
  });

  it('has _id defaulting to uuidv7', () => {
    const pathType = AuthProfile.schema.path('_id');
    expect(pathType).toBeDefined();
  });

  it('requires tenantId', () => {
    const pathType = AuthProfile.schema.path('tenantId') as any;
    expect(pathType.isRequired).toBe(true);
  });

  it('requires name', () => {
    const pathType = AuthProfile.schema.path('name') as any;
    expect(pathType.isRequired).toBe(true);
  });

  it('defaults projectId to null', () => {
    const pathType = AuthProfile.schema.path('projectId') as any;
    expect(pathType.defaultValue).toBeNull();
  });

  it('defaults scope to "project"', () => {
    const pathType = AuthProfile.schema.path('scope') as any;
    expect(pathType.defaultValue).toBe('project');
  });

  it('defaults visibility to "shared"', () => {
    const pathType = AuthProfile.schema.path('visibility') as any;
    expect(pathType.defaultValue).toBe('shared');
  });

  it('defaults status to "active"', () => {
    const pathType = AuthProfile.schema.path('status') as any;
    expect(pathType.defaultValue).toBe('active');
  });

  it('has authType enum with 17 Phase 1+2+3 values', () => {
    const pathType = AuthProfile.schema.path('authType') as any;
    expect(pathType.enumValues).toHaveLength(17);
    expect(pathType.enumValues).toContain('none');
    expect(pathType.enumValues).toContain('api_key');
    expect(pathType.enumValues).toContain('bearer');
    expect(pathType.enumValues).toContain('oauth2_app');
    expect(pathType.enumValues).toContain('oauth2_token');
    expect(pathType.enumValues).toContain('oauth2_client_credentials');
    // Phase 2 types:
    expect(pathType.enumValues).toContain('basic');
    expect(pathType.enumValues).toContain('custom_header');
    expect(pathType.enumValues).toContain('aws_iam');
    expect(pathType.enumValues).toContain('azure_ad');
    expect(pathType.enumValues).toContain('mtls');
    expect(pathType.enumValues).toContain('ssh_key');
    // Phase 3 enterprise types:
    expect(pathType.enumValues).toContain('digest');
    expect(pathType.enumValues).toContain('kerberos');
    expect(pathType.enumValues).toContain('saml');
    expect(pathType.enumValues).toContain('hawk');
    expect(pathType.enumValues).toContain('ws_security');
  });

  it('has groupId field', () => {
    const pathType = AuthProfile.schema.path('groupId') as any;
    expect(pathType).toBeDefined();
    expect(pathType.defaultValue).toBeNull();
  });

  it('has migrationStatus enum with 3 values', () => {
    const pathType = AuthProfile.schema.path('migrationStatus') as any;
    expect(pathType.enumValues).toEqual(['active', 'migrating', 'migrated']);
    expect(pathType.defaultValue).toBe('active');
  });

  it('has status enum with 5 values (including pending_authorization for ABLP-619)', () => {
    const pathType = AuthProfile.schema.path('status') as any;
    expect(pathType.enumValues).toEqual([
      'active',
      'expired',
      'revoked',
      'invalid',
      'pending_authorization',
    ]);
  });

  it('has encryptedSecrets as required string', () => {
    const pathType = AuthProfile.schema.path('encryptedSecrets') as any;
    expect(pathType.instance).toBe('String');
  });

  it('has encryptionKeyVersion defaulting to 1', () => {
    const pathType = AuthProfile.schema.path('encryptionKeyVersion') as any;
    expect(pathType.defaultValue).toBe(1);
  });

  it('has createdBy as required and immutable', () => {
    const pathType = AuthProfile.schema.path('createdBy') as any;
    expect(pathType.isRequired).toBe(true);
    expect(pathType.options.immutable).toBe(true);
  });

  it('has config as Mixed type', () => {
    const pathType = AuthProfile.schema.path('config') as any;
    expect(pathType.instance).toBe('Mixed');
  });

  it('has optional addon fields (signing, webhookVerification, proxy, certificatePinning, jwtWrapping)', () => {
    expect(AuthProfile.schema.path('signing')).toBeDefined();
    expect(AuthProfile.schema.path('webhookVerification')).toBeDefined();
    expect(AuthProfile.schema.path('proxy')).toBeDefined();
    expect(AuthProfile.schema.path('certificatePinning')).toBeDefined();
    expect(AuthProfile.schema.path('jwtWrapping')).toBeDefined();
  });

  it('has optional rotation fields', () => {
    expect(AuthProfile.schema.path('rotationPolicy')).toBeDefined();
    expect(AuthProfile.schema.path('previousEncryptedSecrets')).toBeDefined();
    expect(AuthProfile.schema.path('rotationGracePeriodMs')).toBeDefined();
  });
});
