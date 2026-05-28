import { describe, expect, it } from 'vitest';
import { AuthProfileTokenRequiredError } from '../../../services/auth-profile/resolve-tool-auth.js';

describe('AuthProfileTokenRequiredError reason discriminant', () => {
  const baseParams = {
    profileName: 'OAuth_AuthProfile',
    toolName: 'get_messages',
    jitAuth: false,
    connectionMode: 'shared' as const,
    requiredScopes: [],
  };

  it('emits AUTH_PROFILE_NOT_AUTHORIZED for reason=no_grant with "has not been authorized" copy', () => {
    const err = new AuthProfileTokenRequiredError({ ...baseParams, reason: 'no_grant' });
    expect(err.code).toBe('AUTH_PROFILE_NOT_AUTHORIZED');
    expect(err.reason).toBe('no_grant');
    expect(err.message).toContain('has not been authorized');
    // Must NOT misrepresent as a refresh issue
    expect(err.message).not.toContain('refresh token');
  });

  it('emits AUTH_PROFILE_REFRESH_REQUIRED for reason=expired_no_refresh_token with offline-access guidance', () => {
    const err = new AuthProfileTokenRequiredError({
      ...baseParams,
      reason: 'expired_no_refresh_token',
    });
    expect(err.code).toBe('AUTH_PROFILE_REFRESH_REQUIRED');
    expect(err.reason).toBe('expired_no_refresh_token');
    expect(err.message).toContain('access token has expired');
    expect(err.message).toContain('no refresh token is stored');
    // Guidance must mention the actual fix
    expect(err.message).toMatch(/access_type=offline|offline_access/);
  });

  it('emits AUTH_PROFILE_REFRESH_FAILED for reason=expired_refresh_failed with revocation hint', () => {
    const err = new AuthProfileTokenRequiredError({
      ...baseParams,
      reason: 'expired_refresh_failed',
    });
    expect(err.code).toBe('AUTH_PROFILE_REFRESH_FAILED');
    expect(err.reason).toBe('expired_refresh_failed');
    expect(err.message).toContain('refresh token');
    expect(err.message.toLowerCase()).toContain('rejected');
    expect(err.message.toLowerCase()).toMatch(/revoked|rotated/);
  });

  it('emits legacy AUTH_PROFILE_TOKEN_REQUIRED for reason=unknown (and when reason omitted)', () => {
    const errExplicit = new AuthProfileTokenRequiredError({ ...baseParams, reason: 'unknown' });
    expect(errExplicit.code).toBe('AUTH_PROFILE_TOKEN_REQUIRED');
    expect(errExplicit.reason).toBe('unknown');

    const errImplicit = new AuthProfileTokenRequiredError(baseParams);
    expect(errImplicit.code).toBe('AUTH_PROFILE_TOKEN_REQUIRED');
    expect(errImplicit.reason).toBe('unknown');
    expect(errImplicit.message).toContain('does not have an authorized');
  });

  it('appends required-scopes suffix when scopes are present', () => {
    const err = new AuthProfileTokenRequiredError({
      ...baseParams,
      reason: 'no_grant',
      requiredScopes: ['gmail.readonly', 'gmail.send'],
    });
    expect(err.message).toContain('Required scopes: gmail.readonly, gmail.send.');
  });

  it('appends JIT guidance only when jitAuth=true (regression: do not duplicate guidance)', () => {
    const jitErr = new AuthProfileTokenRequiredError({
      ...baseParams,
      jitAuth: true,
      reason: 'no_grant',
    });
    expect(jitErr.message).toContain('JIT auth will request authorization');

    const noJitErr = new AuthProfileTokenRequiredError({ ...baseParams, reason: 'no_grant' });
    expect(noJitErr.message).not.toContain('JIT auth will request authorization');
  });

  it('preserves the runtime error class for instanceof checks downstream (middleware compatibility)', () => {
    const err = new AuthProfileTokenRequiredError({ ...baseParams, reason: 'no_grant' });
    expect(err).toBeInstanceOf(AuthProfileTokenRequiredError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AuthProfileTokenRequiredError');
  });
});
