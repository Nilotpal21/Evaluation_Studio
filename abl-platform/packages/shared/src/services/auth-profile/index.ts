/**
 * Auth Profile Services — Re-exports from @agent-platform/shared-auth-profile
 *
 * This module is a thin re-export layer for backwards compatibility.
 * All implementation has moved to @agent-platform/shared-auth-profile.
 */
export {
  applyAuth,
  type ApplyAuthParams,
  type ApplyAuthResult,
  resolveClientCredentialsToken,
  type ClientCredentialsDeps,
  type ClientCredentialsResult,
  CredentialCache,
  validateLinkedAppProfile,
  validateResolvedOAuth2TokenLinkedApp,
  AuthProfileError,
  type ValidateLinkedAppParams,
  type ValidateResolvedOAuth2TokenLinkedAppParams,
  resolveOAuth2AppCredentials,
  type ResolveAppCredentialsParams,
  type OAuth2AppCredentials,
  AUTH_PROFILE_OAUTH_PROVIDER_PREFIX,
  buildAuthProfileOAuthProviderKey,
  parseAuthProfileOAuthProviderKey,
  acquireRefreshLock,
  type LockDeps,
  type RefreshLock,
  needsProactiveRefresh,
  refreshOAuth2Token,
  type RefreshTokenParams,
  type RefreshResult,
  validateAuthProfileUpdate,
  type ValidateUpdateParams,
  emitAuthProfileTraceEvent,
  AUTH_PROFILE_TRACE_EVENTS,
  type AuthProfileTraceEvent,
  dualReadCredentials,
  type DualReadResult,
  type DualReadOptions,
  applySigning,
  verifyWebhook,
  applyProxy,
  resolveWithGracePeriod,
  type GracePeriodProfile,
  redactAuthProfile,
  redactAuthProfileList,
  sanitizeAuthProfileError,
  type SanitizedAuthProfileError,
  LEGACY_OAUTH2_TOKEN_MIGRATION_STATUS,
  LEGACY_OAUTH2_TOKEN_READ_ONLY_MESSAGE,
  getAuthProfileMigrationState,
  type AuthProfileMigrationState,
} from '@agent-platform/shared-auth-profile';

// ─── ABLP-913 Phase 2 Modules (local to packages/shared) ─────────────

export {
  emitAuthProfileAuditEvent,
  _resetDedupeMap,
  type AuditEventEmitterDeps,
  type AuthProfileAuditEventType,
  type AuthProfileAuditEventInput,
} from './audit-event-emitter.js';

export {
  aggregate as aggregateBlastRadius,
  type BlastRadiusPayload,
  type BlastRadiusOptions,
  type BlastRadiusDeps,
} from './blast-radius-aggregator.js';

export {
  detectInsufficientScope,
  type ScopeInsufficientResult,
  type ProviderResponse,
} from './scope-insufficient-detector.js';

export { cleanupInlineHostsForTool } from './inline-host-cleanup.js';

export {
  publishAuthProfileInvalidate,
  AUTH_PROFILE_INVALIDATE_CHANNEL,
  type ForceInvalidatePayload,
  type RedisPublisher,
} from './force-invalidate-publisher.js';

export {
  revokeEndUserTokensForProfile,
  type EndUserTokenRevokerInput,
  type EndUserTokenRevokerDeps,
  type EndUserTokenRevokerResult,
} from './end-user-token-revoker.js';

export {
  INTEGRATION_CATALOG,
  getIntegrationCatalog,
  type IntegrationCatalogEntry,
} from './integration-catalog.js';

export {
  mapOAuthError,
  type OAuthProviderError,
  type MappedOAuthError,
} from './oauth-error-map.js';

// ─── Phase 4 re-exports from auth-profile.service.ts ─────────────────

export { computeIsAuthorized, type ComputeIsAuthorizedDeps } from '../auth-profile.service.js';
