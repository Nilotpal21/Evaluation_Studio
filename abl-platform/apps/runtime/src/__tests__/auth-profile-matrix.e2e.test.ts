import { describe, expect, it } from 'vitest';

/**
 * Matrix row inventory for auth-profile coverage drift lint.
 *
 * Full execution-matrix behavior tests are tracked separately; this suite
 * keeps the row registry explicit so CI hooks can prevent silent drift.
 */
export const AUTH_PROFILE_MATRIX_TYPES = [
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_client_credentials',
  'azure_ad',
  'basic',
  'custom_header',
  'mtls',
  'aws_iam',
  'ssh_key',
  'digest',
  'kerberos',
  'saml',
  'hawk',
  'ws_security',
] as const;

describe('auth-profile matrix row inventory', () => {
  it('contains unique auth types', () => {
    const unique = new Set(AUTH_PROFILE_MATRIX_TYPES);
    expect(unique.size).toBe(AUTH_PROFILE_MATRIX_TYPES.length);
  });

  it('contains the phase 2/3 runtime auth types', () => {
    expect(AUTH_PROFILE_MATRIX_TYPES).toEqual(
      expect.arrayContaining([
        'basic',
        'custom_header',
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
  });
});
