import { describe, expect, it } from 'vitest';
import { sanitizeAuthProfileError } from '../sanitize-error.js';
import type { AuthProfileErrorCode } from '../errors.js';

const ALL_AUTH_PROFILE_CODES: AuthProfileErrorCode[] = [
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
  'AUTH_PROFILE_IN_USE_BY_MCP',
  'AUTH_PROFILE_PER_USER_IN_MCP',
  'AUTH_PROFILE_PER_USER_IN_WORKFLOW',
  'AUTH_TYPE_NOT_MCP_COMPATIBLE',
  'MCP_TRANSPORT_NOT_TLS_CAPABLE',
  'AUTH_TOKEN_RATE_LIMITED',
  'AUTH_REFRESH_FAILED',
  'AUTH_REFRESH_RECONNECT',
  'AUTH_PROTOCOL_DISABLED',
  'OAUTH_REAUTH_REQUIRED',
  'OAUTH_FLOW_IN_PROGRESS',
  'JIT_AUTH_NOT_SUPPORTED',
  'AUTH_KERBEROS_NOT_BUILT',
  'AUTH_RESERVED_PRINCIPAL',
  'AUTH_PROFILE_NOT_AUTHORIZED',
  'AUTH_PROFILE_REFRESH_REQUIRED',
  'AUTH_PROFILE_REFRESH_FAILED',
  'AUTH_PROFILE_TOKEN_REQUIRED',
  'AUTH_PROFILE_CC_PROVIDER_ERROR',
];

describe('sanitizeAuthProfileError', () => {
  it('returns mapped safe output for every known auth profile error code', () => {
    for (const code of ALL_AUTH_PROFILE_CODES) {
      const sanitized = sanitizeAuthProfileError({
        code,
        message: 'tenantId=tenant-1 clientId=abc provider=google body={"error":"invalid_client"}',
      });

      expect(sanitized.code).toBe(code);
      expect(typeof sanitized.userMessage).toBe('string');
      expect(sanitized.userMessage.length).toBeGreaterThan(0);
    }
  });

  it('falls back to a safe generic error for unknown codes', () => {
    const sanitized = sanitizeAuthProfileError({
      code: 'TOTALLY_UNKNOWN_CODE',
      message: 'tenantId=tenant-123 provider=microsoft',
    });
    expect(sanitized).toEqual({
      code: 'AUTH_PROFILE_CREDENTIAL_RESOLUTION_FAILED',
      userMessage: 'Failed to resolve auth profile credentials.',
    });
  });

  it('falls back for non-object errors', () => {
    expect(sanitizeAuthProfileError(new Error('boom'))).toEqual({
      code: 'AUTH_PROFILE_CREDENTIAL_RESOLUTION_FAILED',
      userMessage: 'Failed to resolve auth profile credentials.',
    });
    expect(sanitizeAuthProfileError('boom')).toEqual({
      code: 'AUTH_PROFILE_CREDENTIAL_RESOLUTION_FAILED',
      userMessage: 'Failed to resolve auth profile credentials.',
    });
  });

  it('never leaks tenant/client/provider/raw-body terms in userMessage', () => {
    for (const code of ALL_AUTH_PROFILE_CODES) {
      const { userMessage } = sanitizeAuthProfileError({
        code,
        message:
          'tenantId=t1 clientId=c1 provider=google body={"access_token":"secret","error":"invalid_client"}',
      });

      expect(userMessage.toLowerCase()).not.toContain('tenantid');
      expect(userMessage.toLowerCase()).not.toContain('clientid');
      expect(userMessage.toLowerCase()).not.toContain('provider=');
      expect(userMessage.toLowerCase()).not.toContain('access_token');
      expect(userMessage.toLowerCase()).not.toContain('invalid_client');
    }
  });
});
