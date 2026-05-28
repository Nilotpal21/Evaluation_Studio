import { describe, expect, it } from 'vitest';
import {
  AUTH_TYPE_METADATA,
  SUPPORTED_AUTH_TYPES,
} from '@/components/auth-profiles/auth-type-metadata';

const phase23Types = [
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

describe('auth-type-metadata', () => {
  it('defines metadata entries for all Phase 2/3 auth types', () => {
    expect(Object.keys(AUTH_TYPE_METADATA)).toEqual(expect.arrayContaining(phase23Types));
  });

  it('exposes Phase 2/3 auth types through SUPPORTED_AUTH_TYPES when UI gate is enabled', () => {
    const flagValue =
      process.env.NEXT_PUBLIC_AUTH_PROFILE_PHASE_2_3_UI ?? process.env.AUTH_PROFILE_PHASE_2_3_UI;
    if (flagValue === 'false') {
      expect(SUPPORTED_AUTH_TYPES).not.toEqual(expect.arrayContaining(phase23Types));
      return;
    }
    expect(SUPPORTED_AUTH_TYPES).toEqual(expect.arrayContaining(phase23Types));
  });

  it('defines supported form fields for enterprise auth profile inputs', () => {
    expect(AUTH_TYPE_METADATA['custom_header'].configFields).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'headerName', type: 'text' })]),
    );
    expect(AUTH_TYPE_METADATA['custom_header'].secretFields).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'headerValue', type: 'password' })]),
    );
    expect(AUTH_TYPE_METADATA['mtls'].secretFields).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'clientCert', type: 'password' })]),
    );
    expect(AUTH_TYPE_METADATA['saml'].secretFields).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'certificate', type: 'password' })]),
    );
  });

  it('keeps oauth2_app fields compatible with the slide-over renderer', () => {
    const oauthAppFields = AUTH_TYPE_METADATA['oauth2_app'].configFields;
    expect(oauthAppFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'authorizationUrl', type: 'url' }),
        expect.objectContaining({ key: 'tokenUrl', type: 'url' }),
        expect.objectContaining({ key: 'defaultScopes', type: 'tags' }),
      ]),
    );
  });
});
