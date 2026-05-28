/**
 * @agent-platform/shared-auth-profile
 *
 * Auth Profile Services — extracted from @agent-platform/shared
 */
export { applyAuth } from './apply-auth.js';
export type { ApplyAuthParams, ApplyAuthResult } from './apply-auth.js';

export { resolveClientCredentialsToken } from './client-credentials-service.js';
export type {
  ClientCredentialsDeps,
  ClientCredentialsResult,
} from './client-credentials-service.js';

export { CredentialCache } from './credential-cache.js';

export {
  validateLinkedAppProfile,
  validateResolvedOAuth2TokenLinkedApp,
  AuthProfileError,
} from './linked-app-validator.js';
export type {
  ValidateLinkedAppParams,
  ValidateResolvedOAuth2TokenLinkedAppParams,
} from './linked-app-validator.js';

export { resolveOAuth2AppCredentials } from './oauth2-app-resolver.js';
export type { ResolveAppCredentialsParams, OAuth2AppCredentials } from './oauth2-app-resolver.js';

export {
  AUTH_PROFILE_OAUTH_PROVIDER_PREFIX,
  buildAuthProfileOAuthProviderKey,
  parseAuthProfileOAuthProviderKey,
} from './oauth-provider-key.js';

export { acquireRefreshLock } from './refresh-lock.js';
export type { LockDeps, RefreshLock } from './refresh-lock.js';

export { needsProactiveRefresh, refreshOAuth2Token } from './token-refresh-service.js';
export type {
  RefreshTokenParams,
  RefreshResult,
  RefreshTokenDeps,
  RefreshableAuthProfile,
  RefreshableDurableGrant,
  RefreshableSessionOAuthArtifact,
} from './token-refresh-service.js';

export { validateAuthProfileUpdate } from './update-validator.js';
export type { ValidateUpdateParams } from './update-validator.js';

export { emitAuthProfileTraceEvent, AUTH_PROFILE_TRACE_EVENTS } from './trace-events.js';
export type { AuthProfileTraceEvent } from './trace-events.js';

export { dualReadCredentials } from './dual-read.js';
export type { DualReadResult, DualReadOptions } from './dual-read.js';

export { applySigning } from './apply-signing.js';
export { verifyWebhook } from './verify-webhook.js';
export { applyProxy } from './apply-proxy.js';

export { resolveWithGracePeriod } from './grace-period.js';
export type { GracePeriodProfile } from './grace-period.js';

export { redactAuthProfile, redactAuthProfileList } from './redact.js';

export type { AuthProfileErrorCode } from './errors.js';
export { sanitizeAuthProfileError } from './sanitize-error.js';
export type { SafeError as SanitizedAuthProfileError } from './sanitize-error.js';

export { RESERVED_PRINCIPALS, assertNotReservedPrincipal } from './reserved-principals.js';
export type { ReservedPrincipal } from './reserved-principals.js';

export { verifyAwsIamCredentials } from './aws-sts-verify.js';
export type {
  AwsIamVerifyParams,
  AwsIamVerifyResult,
  AwsIamVerifyOk,
  AwsIamVerifyErr,
} from './aws-sts-verify.js';

export {
  LEGACY_OAUTH2_TOKEN_MIGRATION_STATUS,
  LEGACY_OAUTH2_TOKEN_READ_ONLY_MESSAGE,
  getAuthProfileMigrationState,
} from './legacy-auth-profile.js';
export type { AuthProfileMigrationState } from './legacy-auth-profile.js';
