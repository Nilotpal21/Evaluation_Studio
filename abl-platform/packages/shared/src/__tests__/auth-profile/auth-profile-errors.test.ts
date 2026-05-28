/**
 * Task 38: AuthProfileError class tests
 */
import { describe, it, expect } from 'vitest';
import { AuthProfileError } from '../../errors/auth-profile-errors.js';

describe('AuthProfileError', () => {
  it('has correct name, code, and message', () => {
    const err = new AuthProfileError('AUTH_PROFILE_NOT_FOUND', 'Profile not found');
    expect(err.name).toBe('AuthProfileError');
    expect(err.code).toBe('AUTH_PROFILE_NOT_FOUND');
    expect(err.message).toBe('Profile not found');
    expect(err).toBeInstanceOf(Error);
  });

  it('defaults statusCode to 400', () => {
    const err = new AuthProfileError('AUTH_PROFILE_VALIDATION_FAILED', 'Invalid');
    expect(err.statusCode).toBe(400);
  });

  it('accepts custom statusCode', () => {
    const err = new AuthProfileError('AUTH_PROFILE_NOT_FOUND', 'Not found', 404);
    expect(err.statusCode).toBe(404);
  });

  it('supports all error codes', () => {
    const codes = [
      'AUTH_PROFILE_NOT_FOUND',
      'AUTH_PROFILE_EXPIRED',
      'AUTH_PROFILE_REVOKED',
      'AUTH_PROFILE_VALIDATION_FAILED',
      'AUTH_PROFILE_CROSS_TENANT_LINK',
      'AUTH_PROFILE_INCOMPATIBLE_TYPE',
      'AUTH_PROFILE_INVALID_AUTH_TYPE',
      'AUTH_PROFILE_AUTH_TYPE_MUTATION',
      'AUTH_PROFILE_OAUTH_STATE_INVALID',
      'AUTH_PROFILE_OAUTH_STATE_EXPIRED',
      'AUTH_PROFILE_OAUTH_EXCHANGE_FAILED',
      'AUTH_PROFILE_TOKEN_REFRESH_FAILED',
      'AUTH_PROFILE_TOKEN_REFRESH_LOCKED',
      'AUTH_PROFILE_CREDENTIAL_RESOLUTION_FAILED',
      'AUTH_PROFILE_SECRETS_DECRYPTION_FAILED',
      'AUTH_PROFILE_LINKED_APP_NOT_FOUND',
      'AUTH_PROFILE_CONSUMER_DEPENDENCY',
    ] as const;

    for (const code of codes) {
      const err = new AuthProfileError(code, `test ${code}`);
      expect(err.code).toBe(code);
    }
  });
});
