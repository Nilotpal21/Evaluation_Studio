import type { AuthProfileErrorCode } from './errors.js';

export interface SafeError {
  code: AuthProfileErrorCode | string;
  userMessage: string;
}

const SAFE_MESSAGES: Record<AuthProfileErrorCode, string> = {
  AUTH_PROFILE_NOT_FOUND: 'Auth profile not found.',
  AUTH_PROFILE_EXPIRED: 'Auth profile has expired.',
  AUTH_PROFILE_REVOKED: 'Auth profile has been revoked.',
  AUTH_PROFILE_VALIDATION_FAILED: 'Auth profile configuration is invalid.',
  AUTH_PROFILE_CROSS_TENANT_LINK: 'Auth profile link is not allowed.',
  AUTH_PROFILE_INCOMPATIBLE_TYPE: 'Auth profile type is incompatible with this action.',
  AUTH_PROFILE_INVALID_AUTH_TYPE: 'Auth type is not supported.',
  AUTH_PROFILE_AUTH_TYPE_MUTATION: 'Auth profile type cannot be changed.',
  AUTH_PROFILE_OAUTH_STATE_INVALID: 'OAuth state is invalid.',
  AUTH_PROFILE_OAUTH_STATE_EXPIRED: 'OAuth state has expired.',
  AUTH_PROFILE_OAUTH_EXCHANGE_FAILED: 'OAuth token exchange failed.',
  AUTH_PROFILE_TOKEN_REFRESH_FAILED: 'OAuth token refresh failed.',
  AUTH_PROFILE_TOKEN_REFRESH_LOCKED: 'OAuth token refresh is already in progress.',
  AUTH_PROFILE_CREDENTIAL_RESOLUTION_FAILED: 'Failed to resolve auth profile credentials.',
  AUTH_PROFILE_SECRETS_DECRYPTION_FAILED: 'Failed to decrypt auth profile secrets.',
  AUTH_PROFILE_LINKED_APP_NOT_FOUND: 'Linked OAuth app profile is unavailable.',
  AUTH_PROFILE_CONSUMER_DEPENDENCY:
    'Auth profile is in use by active consumers and cannot be deleted.',
  AUTH_PROFILE_IN_USE_BY_MCP:
    'Auth profile is currently attached to MCP servers and cannot be deleted.',
  AUTH_PROFILE_PER_USER_IN_MCP: 'Per-user auth profiles are not supported for MCP server bindings.',
  AUTH_PROFILE_PER_USER_IN_WORKFLOW:
    'Per-user auth profiles are not supported for workflow tool execution.',
  AUTH_TYPE_NOT_MCP_COMPATIBLE: 'Auth type is not compatible with MCP server usage.',
  MCP_TRANSPORT_NOT_TLS_CAPABLE:
    'Selected MCP transport does not support this auth profile requirements.',
  AUTH_TOKEN_RATE_LIMITED: 'Auth token exchange is rate limited. Please retry shortly.',
  AUTH_REFRESH_FAILED: 'Auth refresh failed. Reconnect and retry.',
  AUTH_REFRESH_RECONNECT: 'Auth refresh requires reconnecting the MCP transport.',
  AUTH_PROTOCOL_DISABLED: 'This auth protocol is disabled in the current deployment.',
  OAUTH_REAUTH_REQUIRED: 'OAuth authorization is required. Reconnect profile and retry.',
  OAUTH_FLOW_IN_PROGRESS: 'OAuth authorization is already in progress for this profile.',
  JIT_AUTH_NOT_SUPPORTED: 'Interactive JIT auth is not supported in this execution context.',
  AUTH_KERBEROS_NOT_BUILT: 'Kerberos support is not enabled in this build.',
  AUTH_RESERVED_PRINCIPAL: 'Reserved principal identifiers are not allowed for user accounts.',
  AUTH_PROFILE_NOT_AUTHORIZED:
    'This auth profile has not been authorized yet. Open Auth Profiles in Studio and click Authorize.',
  AUTH_PROFILE_REFRESH_REQUIRED:
    'The OAuth token expired and no refresh token is stored. Re-authorize the profile (set access_type=offline for Google, or include offline_access in scopes for Microsoft) so it can auto-renew.',
  AUTH_PROFILE_REFRESH_FAILED:
    'OAuth token refresh failed. The provider may have revoked the grant — re-authorize the profile and retry.',
  AUTH_PROFILE_TOKEN_REQUIRED:
    'This auth profile does not have a usable token. Authorize the profile and retry.',
  AUTH_PROFILE_AUTHORIZE_FAILED:
    'Authorization failed for this auth profile. Retry authorization and verify provider settings.',
  AUTH_PROFILE_CC_PROVIDER_ERROR:
    'The OAuth provider rejected the client credentials. Verify the client ID, client secret, and scopes against the provider settings.',
  AUTH_PROFILE_DISABLED:
    'This auth profile is disabled. Re-enable it in Auth Profiles to allow workflows, agents, and tools to use it.',
};

const DEFAULT_SAFE_ERROR: SafeError = {
  code: 'AUTH_PROFILE_CREDENTIAL_RESOLUTION_FAILED',
  userMessage: SAFE_MESSAGES.AUTH_PROFILE_CREDENTIAL_RESOLUTION_FAILED,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toKnownCode(input: unknown): AuthProfileErrorCode | null {
  if (typeof input !== 'string') {
    return null;
  }
  return Object.prototype.hasOwnProperty.call(SAFE_MESSAGES, input)
    ? (input as AuthProfileErrorCode)
    : null;
}

export function sanitizeAuthProfileError(err: unknown): SafeError {
  if (!isObject(err)) {
    return DEFAULT_SAFE_ERROR;
  }

  const code = toKnownCode(err.code);
  if (!code) {
    return DEFAULT_SAFE_ERROR;
  }

  return {
    code,
    userMessage: SAFE_MESSAGES[code],
  };
}
