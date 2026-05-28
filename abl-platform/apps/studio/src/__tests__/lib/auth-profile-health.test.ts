import { describe, expect, it } from 'vitest';
import { computeAuthProfileHealth } from '@/lib/auth-profile-health';

const baseInput = {
  authType: 'oauth2_app',
  lifecycleStatus: 'active',
  valid: false,
  configurationErrorCount: 0,
  isUserAuthorizedAtRuntime: false,
};

describe('computeAuthProfileHealth', () => {
  it('returns lifecycle_blocked for revoked / expired / invalid lifecycle states', () => {
    expect(computeAuthProfileHealth({ ...baseInput, lifecycleStatus: 'revoked' }).state).toBe(
      'lifecycle_blocked',
    );
    expect(computeAuthProfileHealth({ ...baseInput, lifecycleStatus: 'expired' }).state).toBe(
      'lifecycle_blocked',
    );
    expect(computeAuthProfileHealth({ ...baseInput, lifecycleStatus: 'invalid' }).state).toBe(
      'lifecycle_blocked',
    );
  });

  it('returns configuration_error when validation errors are present, regardless of auth type', () => {
    const result = computeAuthProfileHealth({ ...baseInput, configurationErrorCount: 3 });
    expect(result.state).toBe('configuration_error');
    expect(result.reason).toMatch(/validation/i);
  });

  it('oauth2_app + jit/preflight returns requires_user_authorization', () => {
    const result = computeAuthProfileHealth({
      ...baseInput,
      isUserAuthorizedAtRuntime: true,
      lastValidatedAt: '2026-05-06T08:00:00Z',
    });
    expect(result.state).toBe('requires_user_authorization');
    expect(result.lastVerifiedAt).toBe('2026-05-06T08:00:00Z');
  });

  it('oauth2_app with no grant -> not_authorized', () => {
    const result = computeAuthProfileHealth({
      ...baseInput,
      oauthGrant: { found: false, expired: false, refreshTokenStored: false },
    });
    expect(result.state).toBe('not_authorized');
    expect(result.refreshTokenStored).toBe(false);
  });

  it('oauth2_app with active grant + refresh token -> connected', () => {
    const result = computeAuthProfileHealth({
      ...baseInput,
      oauthGrant: { found: true, expired: false, refreshTokenStored: true },
      lastValidatedAt: '2026-05-06T08:00:00Z',
    });
    expect(result.state).toBe('connected');
    expect(result.refreshTokenStored).toBe(true);
    expect(result.lastVerifiedAt).toBe('2026-05-06T08:00:00Z');
  });

  it('oauth2_app with active grant but no refresh token -> connected_no_auto_renew (the user pain case)', () => {
    const result = computeAuthProfileHealth({
      ...baseInput,
      oauthGrant: { found: true, expired: false, refreshTokenStored: false },
    });
    expect(result.state).toBe('connected_no_auto_renew');
    expect(result.refreshTokenStored).toBe(false);
    expect(result.reason).toMatch(/refresh|offline/i);
  });

  it('oauth2_app with expired grant + refresh token -> still connected (auto-refresh on next use)', () => {
    const result = computeAuthProfileHealth({
      ...baseInput,
      oauthGrant: { found: true, expired: true, refreshTokenStored: true },
    });
    expect(result.state).toBe('connected');
    expect(result.refreshTokenStored).toBe(true);
  });

  it('oauth2_app with expired grant + no refresh token -> reauth_required', () => {
    const result = computeAuthProfileHealth({
      ...baseInput,
      oauthGrant: { found: true, expired: true, refreshTokenStored: false },
    });
    expect(result.state).toBe('reauth_required');
    expect(result.refreshTokenStored).toBe(false);
    expect(result.reason).toMatch(/Re-authorize|reauth/i);
  });

  it('oauth2_client_credentials with successful live token exchange -> verified', () => {
    const result = computeAuthProfileHealth({
      authType: 'oauth2_client_credentials',
      lifecycleStatus: 'active',
      valid: true,
      validationType: 'token_exchange',
      configurationErrorCount: 0,
      isUserAuthorizedAtRuntime: false,
    });
    expect(result.state).toBe('verified');
    expect(result.reason).toMatch(/Live verification/i);
  });

  it('static auth (basic / api_key / etc.) with valid config but no live test -> untested', () => {
    const result = computeAuthProfileHealth({
      authType: 'basic',
      lifecycleStatus: 'active',
      valid: true,
      validationType: 'configuration',
      configurationErrorCount: 0,
      isUserAuthorizedAtRuntime: false,
    });
    expect(result.state).toBe('untested');
  });

  it('static auth previously verified (lastValidatedAt present) -> verified', () => {
    const result = computeAuthProfileHealth({
      authType: 'basic',
      lifecycleStatus: 'active',
      valid: true,
      validationType: 'configuration',
      configurationErrorCount: 0,
      isUserAuthorizedAtRuntime: false,
      lastValidatedAt: '2026-05-06T08:00:00Z',
    });
    expect(result.state).toBe('verified');
    expect(result.lastVerifiedAt).toBe('2026-05-06T08:00:00Z');
  });

  it('static auth where validation FAILED -> configuration_error', () => {
    const result = computeAuthProfileHealth({
      authType: 'basic',
      lifecycleStatus: 'active',
      valid: false,
      validationType: 'configuration',
      configurationErrorCount: 0,
      isUserAuthorizedAtRuntime: false,
    });
    expect(result.state).toBe('configuration_error');
  });
});
