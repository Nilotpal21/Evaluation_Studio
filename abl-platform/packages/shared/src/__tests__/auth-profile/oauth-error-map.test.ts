/**
 * OAuth Error Map Tests
 *
 * Tests all 9 known error codes + 1 fallback case for unknown codes.
 */

import { describe, it, expect } from 'vitest';
import { mapOAuthError } from '../../services/auth-profile/oauth-error-map.js';

describe('mapOAuthError', () => {
  // ─── Known Error Codes ──────────────────────────────────────────────

  it('maps redirect_uri_mismatch with redirectUri', () => {
    const result = mapOAuthError({
      code: 'redirect_uri_mismatch',
      redirectUri: 'https://app.example.com/callback',
    });
    expect(result.code).toBe('oauth_redirect_uri_mismatch');
    expect(result.adminMessage).toContain('redirect URI');
    expect(result.adminMessage).toContain('https://app.example.com/callback');
  });

  it('maps redirect_uri_mismatch without redirectUri', () => {
    const result = mapOAuthError({ code: 'redirect_uri_mismatch' });
    expect(result.code).toBe('oauth_redirect_uri_mismatch');
    expect(result.adminMessage).toContain('redirect URI');
    expect(result.adminMessage).not.toContain('undefined');
  });

  it('maps invalid_client', () => {
    const result = mapOAuthError({ code: 'invalid_client' });
    expect(result.code).toBe('oauth_invalid_client');
    expect(result.adminMessage).toContain('client credentials');
  });

  it('maps invalid_grant', () => {
    const result = mapOAuthError({ code: 'invalid_grant' });
    expect(result.code).toBe('oauth_invalid_grant');
    expect(result.adminMessage).toContain('authorization code');
  });

  it('maps access_denied', () => {
    const result = mapOAuthError({ code: 'access_denied' });
    expect(result.code).toBe('oauth_access_denied');
    expect(result.adminMessage).toContain('denied');
  });

  it('maps unauthorized_client', () => {
    const result = mapOAuthError({ code: 'unauthorized_client' });
    expect(result.code).toBe('oauth_unauthorized_client');
    expect(result.adminMessage).toContain('grant type');
  });

  it('maps unsupported_response_type', () => {
    const result = mapOAuthError({ code: 'unsupported_response_type' });
    expect(result.code).toBe('oauth_unsupported_response_type');
    expect(result.adminMessage).toContain('response type');
  });

  it('maps invalid_scope', () => {
    const result = mapOAuthError({ code: 'invalid_scope' });
    expect(result.code).toBe('oauth_invalid_scope');
    expect(result.adminMessage).toContain('scopes');
  });

  it('maps server_error', () => {
    const result = mapOAuthError({ code: 'server_error' });
    expect(result.code).toBe('oauth_server_error');
    expect(result.adminMessage).toContain('internal error');
  });

  it('maps temporarily_unavailable', () => {
    const result = mapOAuthError({ code: 'temporarily_unavailable' });
    expect(result.code).toBe('oauth_temporarily_unavailable');
    expect(result.adminMessage).toContain('temporarily unavailable');
  });

  // ─── Unknown Error Code ─────────────────────────────────────────────

  it('returns fallback for unknown error code with description', () => {
    const result = mapOAuthError({
      code: 'some_custom_error',
      description: 'Something went wrong',
    });
    expect(result.code).toBe('oauth_unknown_error');
    expect(result.adminMessage).toBe('Authorization failed: Something went wrong');
  });

  it('returns fallback for unknown error code without description', () => {
    const result = mapOAuthError({ code: 'mystery_error' });
    expect(result.code).toBe('oauth_unknown_error');
    expect(result.adminMessage).toBe('Authorization failed: mystery_error');
  });
});
