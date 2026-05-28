/**
 * AuthProfileError — Typed error class with reason discriminant
 *
 * Provides structured error codes for all auth profile failure modes.
 * Consumers can switch on `error.code` for programmatic handling.
 */

export type AuthProfileErrorCode =
  | 'AUTH_PROFILE_NOT_FOUND'
  | 'AUTH_PROFILE_EXPIRED'
  | 'AUTH_PROFILE_REVOKED'
  | 'AUTH_PROFILE_VALIDATION_FAILED'
  | 'AUTH_PROFILE_CROSS_TENANT_LINK'
  | 'AUTH_PROFILE_INCOMPATIBLE_TYPE'
  | 'AUTH_PROFILE_INVALID_AUTH_TYPE'
  | 'AUTH_PROFILE_AUTH_TYPE_MUTATION'
  | 'AUTH_PROFILE_OAUTH_STATE_INVALID'
  | 'AUTH_PROFILE_OAUTH_STATE_EXPIRED'
  | 'AUTH_PROFILE_OAUTH_EXCHANGE_FAILED'
  | 'AUTH_PROFILE_TOKEN_REFRESH_FAILED'
  | 'AUTH_PROFILE_TOKEN_REFRESH_LOCKED'
  | 'AUTH_PROFILE_CREDENTIAL_RESOLUTION_FAILED'
  | 'AUTH_PROFILE_SECRETS_DECRYPTION_FAILED'
  | 'AUTH_PROFILE_LINKED_APP_NOT_FOUND'
  | 'AUTH_PROFILE_CONSUMER_DEPENDENCY'
  | 'AUTH_PROFILE_IN_USE_BY_MCP'
  | 'AUTH_PROFILE_PER_USER_IN_MCP'
  | 'AUTH_PROFILE_PER_USER_IN_WORKFLOW'
  | 'AUTH_TYPE_NOT_MCP_COMPATIBLE'
  | 'MCP_TRANSPORT_NOT_TLS_CAPABLE'
  | 'AUTH_TOKEN_RATE_LIMITED'
  | 'AUTH_REFRESH_FAILED'
  | 'AUTH_REFRESH_RECONNECT'
  | 'AUTH_PROTOCOL_DISABLED'
  | 'OAUTH_REAUTH_REQUIRED'
  | 'OAUTH_FLOW_IN_PROGRESS'
  | 'JIT_AUTH_NOT_SUPPORTED'
  | 'AUTH_KERBEROS_NOT_BUILT'
  | 'AUTH_RESERVED_PRINCIPAL'
  // Granular token-availability codes — distinguish "never authorized" from
  // "authorized but expired with no refresh token" from "refresh attempted and
  // failed". The legacy AUTH_PROFILE_TOKEN_REQUIRED is retained as a fallback
  // for cases where the cause cannot be determined.
  | 'AUTH_PROFILE_NOT_AUTHORIZED'
  | 'AUTH_PROFILE_REFRESH_REQUIRED'
  | 'AUTH_PROFILE_REFRESH_FAILED'
  // Token-required when full reason is unknown (covers the legacy code path).
  | 'AUTH_PROFILE_TOKEN_REQUIRED'
  | 'AUTH_PROFILE_AUTHORIZE_FAILED'
  // Client-credentials provider error, surfaces RFC 6749 §5.2 error / error_description
  // from the provider's HTTP response so users can correlate against the IdP docs.
  | 'AUTH_PROFILE_CC_PROVIDER_ERROR'
  // Admin/owner has disabled this profile; runtime resolution short-circuits
  // before secrets are decrypted. Re-enable in Auth Profiles to resume use.
  | 'AUTH_PROFILE_DISABLED';

export class AuthProfileError extends Error {
  public readonly code: AuthProfileErrorCode;
  public readonly statusCode: number;

  constructor(code: AuthProfileErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = 'AuthProfileError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
