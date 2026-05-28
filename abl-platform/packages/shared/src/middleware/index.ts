/**
 * Shared Middleware Exports
 */

export {
  requestIdMiddleware,
  getCurrentRequestId,
  type RequestIdMiddlewareOptions,
} from './request-id.js';
export {
  runWithTenantContext,
  getCurrentTenantId,
  getCurrentUserId,
  isSuperAdminContext,
  getTenantContextData,
} from './tenant-context.js';
export type { TenantContextData } from './tenant-context.js';
export {
  createAuthMiddleware,
  createOptionalAuthMiddleware,
  verifyToken,
  extractUserIdFromToken,
  createServiceToken,
  verifyServiceToken,
} from './jwt-verify.js';
export type { AuthMiddlewareConfig, ServiceTokenPayload } from './jwt-verify.js';
export { createObservabilityMiddleware } from './observability.js';
export type { ObservabilityContext, ObservabilityMiddlewareConfig } from './observability.js';
export {
  requirePermission,
  requireAllPermissions,
  requireAnyPermission,
  requireAuthType,
  requireProjectScope,
  requireEnvironmentScope,
  requirePlatformAdmin,
  requirePlatformAdminIp,
  isIpAllowed,
} from './permission-guard.js';
export {
  createUnifiedAuthMiddleware,
  requireAuth,
  requireTenantContext,
  requireAuthWithTenant,
  createAccessDeniedReporter,
  attachAccessDeniedReporter,
  getRequestAccessDeniedReporter,
  requireTenantContextValue,
  PLATFORM_ADMIN_TENANT_ID,
} from './unified-auth.js';
export {
  matchesSessionOwner,
  isElevatedPlatformRole,
  matchesPlatformMemberSessionOwner,
  buildSessionListFilter,
  evaluateSessionOwnershipAccess,
  createRequireSessionOwnership,
} from './session-ownership.js';
export type {
  SessionOwnershipConfig,
  SessionOwnershipSubject,
  SessionOwnershipEvaluation,
} from './session-ownership.js';
export { toAuthContext, toLegacyTenantContext } from './auth-context-bridge.js';
export { requireTenantMatch } from './tenant-match.js';
export {
  createExpressErrorHandler,
  normalizeExpressError,
  type ExpressErrorHandlerOptions,
  type NormalizedHttpError,
} from './error-handler.js';
