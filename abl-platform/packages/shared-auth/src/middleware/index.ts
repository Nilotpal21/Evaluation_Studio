// ─── JWT / Token ──────────────────────────────────────────────────────
export {
  verifyToken,
  createAuthMiddleware,
  createOptionalAuthMiddleware,
  extractUserIdFromToken,
  createServiceToken,
  createInternalUserToken,
  verifyServiceToken,
} from './jwt-verify.js';
export type { AuthMiddlewareConfig, ServiceTokenPayload } from './jwt-verify.js';

export {
  AuthError,
  PLATFORM_JWT_ISSUER,
  PLATFORM_ACCESS_TOKEN_AUDIENCE,
  SDK_SESSION_TOKEN_AUDIENCE,
  STUDIO_SESSION_TOKEN_AUDIENCE,
  FEEDBACK_TOKEN_AUDIENCE,
  GUPSHUP_WEBHOOK_TOKEN_AUDIENCE,
  FEEDBACK_TOKEN_PURPOSE,
  GUPSHUP_WEBHOOK_TOKEN_PURPOSE,
  signPlatformAccessToken,
  verifyPlatformAccessToken,
  signSDKSessionToken,
  verifySDKSessionToken,
  verifyStudioSessionToken,
  signFeedbackToken,
  verifyFeedbackToken,
  signGupshupWebhookToken,
  verifyGupshupWebhookToken,
  type AuthErrorCode,
  type FeedbackTokenPayload,
  type GupshupWebhookTokenPayload,
} from '../purpose-jwt.js';

// ─── Unified Auth ─────────────────────────────────────────────────────
export {
  createAccessDeniedReporter,
  attachAccessDeniedReporter,
  getRequestAccessDeniedReporter,
  requireTenantContextValue,
  PLATFORM_ADMIN_TENANT_ID,
} from './access-denial.js';
export type {
  AccessDeniedEvent,
  AccessDeniedReporter,
  AccessDeniedReporterConfig,
  AccessDeniedLogger,
  AccessDeniedTransport,
  AccessDeniedLayer,
  AccessDeniedScope,
  AccessDeniedStatusCode,
} from './access-denial.js';

export {
  createUnifiedAuthMiddleware,
  requireAuth,
  requireTenantContext,
  requireAuthWithTenant,
} from './unified-auth.js';
export type {
  AuthEventOutcome,
  AuthEvent,
  AuthLogger,
  ApiKeyResolution,
  UnifiedAuthConfig,
} from './unified-auth.js';

// ─── Tenant Context (AsyncLocalStorage) ───────────────────────────────
export {
  runWithTenantContext,
  getCurrentTenantId,
  getCurrentUserId,
  isSuperAdminContext,
  getTenantContextData,
} from './tenant-context.js';
export type { TenantContextData } from './tenant-context.js';

// ─── Permission Guards ────────────────────────────────────────────────
export {
  requirePermission,
  requireAllPermissions,
  requireAnyPermission,
  requireProjectScope,
  requireEnvironmentScope,
  requireAuthType,
  requirePlatformAdmin,
  isIpAllowed,
  requirePlatformAdminIp,
} from './permission-guard.js';

// ─── Session Ownership ────────────────────────────────────────────────
export {
  matchesSessionOwner,
  isElevatedPlatformRole,
  matchesPlatformMemberSessionOwner,
  buildSessionListFilter,
  evaluateSessionOwnershipAccess,
  createRequireSessionOwnership,
} from './session-ownership.js';
export type {
  SessionAccessSource,
  SessionOwnershipConfig,
  SessionOwnershipSubject,
  SessionOwnershipEvaluation,
} from './session-ownership.js';

// ─── Auth Context Bridge ──────────────────────────────────────────────
export { toAuthContext, toLegacyTenantContext } from './auth-context-bridge.js';
