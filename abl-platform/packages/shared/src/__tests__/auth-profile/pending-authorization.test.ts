/**
 * ABLP-619 — pending_authorization status, AUTH_PROFILE_NOT_AUTHORIZED /
 * AUTH_PROFILE_AUTHORIZE_FAILED error codes, AUTHORIZED / AUTHORIZE_FAILED trace events.
 */
import { describe, it, expect } from 'vitest';
import { AUTH_PROFILE_STATUSES } from '@agent-platform/database/models';
import {
  AuthProfileStatusSchema,
  UpdateAuthProfileSchema,
} from '../../validation/auth-profile.schema.js';
import { AuthProfileError } from '../../errors/auth-profile-errors.js';
import { AUTH_PROFILE_TRACE_EVENTS } from '@agent-platform/shared-auth-profile';

describe('AUTH_PROFILE_STATUSES const', () => {
  it('includes pending_authorization alongside the four legacy values', () => {
    expect(AUTH_PROFILE_STATUSES).toEqual([
      'active',
      'expired',
      'revoked',
      'invalid',
      'pending_authorization',
    ]);
  });
});

describe('AuthProfileStatusSchema', () => {
  it('accepts every value in AUTH_PROFILE_STATUSES', () => {
    for (const status of AUTH_PROFILE_STATUSES) {
      expect(AuthProfileStatusSchema.parse(status)).toBe(status);
    }
  });

  it('rejects unknown values', () => {
    expect(() => AuthProfileStatusSchema.parse('draft')).toThrow();
    expect(() => AuthProfileStatusSchema.parse('')).toThrow();
  });
});

describe('UpdateAuthProfileSchema status field', () => {
  it('admits pending_authorization (matches new enum)', () => {
    const result = UpdateAuthProfileSchema.parse({ status: 'pending_authorization' });
    expect(result.status).toBe('pending_authorization');
  });

  it('still admits the four legacy values', () => {
    for (const status of ['active', 'expired', 'revoked', 'invalid'] as const) {
      const result = UpdateAuthProfileSchema.parse({ status });
      expect(result.status).toBe(status);
    }
  });

  it('rejects unknown status values', () => {
    expect(() => UpdateAuthProfileSchema.parse({ status: 'bogus' })).toThrow();
  });
});

describe('AuthProfileError — new ABLP-619 codes', () => {
  it('AUTH_PROFILE_NOT_AUTHORIZED maps to HTTP 403 when constructed explicitly', () => {
    const err = new AuthProfileError(
      'AUTH_PROFILE_NOT_AUTHORIZED',
      'Auth profile has not completed authorization',
      403,
    );
    expect(err.code).toBe('AUTH_PROFILE_NOT_AUTHORIZED');
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('Auth profile has not completed authorization');
    expect(err).toBeInstanceOf(Error);
  });

  it('AUTH_PROFILE_AUTHORIZE_FAILED defaults to HTTP 400', () => {
    const err = new AuthProfileError(
      'AUTH_PROFILE_AUTHORIZE_FAILED',
      'Auth profile authorization failed',
    );
    expect(err.code).toBe('AUTH_PROFILE_AUTHORIZE_FAILED');
    expect(err.statusCode).toBe(400);
  });

  it('both new codes are typed members of AuthProfileErrorCode', () => {
    // Compile-time discriminator check: if these strings ever drift from the
    // AuthProfileErrorCode union, this file fails to type-check via the
    // PreToolUse incremental-typecheck hook.
    const notAuthorized: AuthProfileError = new AuthProfileError(
      'AUTH_PROFILE_NOT_AUTHORIZED',
      'x',
      403,
    );
    const authorizeFailed: AuthProfileError = new AuthProfileError(
      'AUTH_PROFILE_AUTHORIZE_FAILED',
      'x',
    );
    expect(notAuthorized.code).toBe('AUTH_PROFILE_NOT_AUTHORIZED');
    expect(authorizeFailed.code).toBe('AUTH_PROFILE_AUTHORIZE_FAILED');
  });
});

describe('AUTH_PROFILE_TRACE_EVENTS — new ABLP-619 events', () => {
  it('exposes AUTHORIZED with the canonical event name', () => {
    expect(AUTH_PROFILE_TRACE_EVENTS.AUTHORIZED).toBe('auth_profile.authorized');
  });

  it('exposes AUTHORIZE_FAILED with the canonical event name', () => {
    expect(AUTH_PROFILE_TRACE_EVENTS.AUTHORIZE_FAILED).toBe('auth_profile.authorize_failed');
  });
});
