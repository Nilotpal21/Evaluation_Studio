import { describe, expect, it } from 'vitest';
import { AUTH_TYPE_ALIASES, normalizeAuthType } from '../../validation/auth-type-aliases.js';

describe('auth-type alias normalization', () => {
  it('maps legacy aliases to canonical auth types', () => {
    expect(normalizeAuthType('oauth2_client')).toBe('oauth2_client_credentials');
    expect(normalizeAuthType('oauth2_user')).toBe('oauth2_token');
    expect(normalizeAuthType('custom')).toBe('custom_header');
  });

  it('leaves canonical auth types unchanged', () => {
    expect(normalizeAuthType('oauth2_client_credentials')).toBe('oauth2_client_credentials');
    expect(normalizeAuthType('oauth2_token')).toBe('oauth2_token');
    expect(normalizeAuthType('custom_header')).toBe('custom_header');
    expect(normalizeAuthType('bearer')).toBe('bearer');
  });

  it('trims leading/trailing whitespace before normalization', () => {
    expect(normalizeAuthType('  oauth2_client  ')).toBe('oauth2_client_credentials');
  });

  it('exports the expected alias map', () => {
    expect(AUTH_TYPE_ALIASES).toEqual({
      oauth2_client: 'oauth2_client_credentials',
      oauth2_user: 'oauth2_token',
      custom: 'custom_header',
    });
  });
});
