/**
 * Authentication Middleware (Runtime)
 *
 * Uses the unified auth middleware from @agent-platform/shared,
 * configured with the runtime's config and database.
 *
 * Supports all three auth flows:
 * 1. User JWT      — Authorization: Bearer <jwt>
 * 2. SDK Session   — X-SDK-Token: <token>
 * 3. API Key       — Authorization: Bearer abl_*
 */

import crypto from 'crypto';
import type { RequestHandler } from 'express';
import {
  createUnifiedAuthMiddleware,
  requireAuth,
  requireAuthWithTenant,
  verifyToken,
  extractUserIdFromToken as sharedExtractUserId,
  getRequestAccessDeniedReporter,
  PLATFORM_ADMIN_TENANT_ID,
  PLATFORM_JWT_ISSUER,
  SDK_SESSION_TOKEN_AUDIENCE,
  runWithTenantContext,
  toAuthContext,
} from '@agent-platform/shared-auth';
import type {
  AuthUser,
  SDKSessionTokenPayload,
  AuthEvent,
  AccessDeniedEvent,
  JWTPayload,
  TenantContextData,
} from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../config/index.js';
import { isDatabaseAvailable } from '../db/index.js';
import {
  verifyRuntimeSdkSessionForAuth,
  type RuntimeSdkSessionAuthResult,
} from '../services/identity/sdk-session-token-auth.js';
import { isPlatformAdminUser as isDbPlatformAdminUser } from '@agent-platform/database/platform-access-policy';
import {
  findUserById,
  resolveTenantMembership,
  resolveDefaultTenant,
  resolveApiKey,
  writeAuditLog,
} from '../repos/auth-repo.js';
import { resolveEffectivePermissions } from '../services/permission-resolution.js';

const log = createLogger('auth');

// =============================================================================
// AUTH AUDIT LOGGING
// =============================================================================

function writeAuthAuditLog(event: AuthEvent): void {
  // Skip routine token-validation successes — only audit meaningful security events.
  // Events WITH a reason (mfa_pending, platform_admin_bootstrap) are security-relevant.
  // All failures are always audited.
  if (event.outcome === 'success' && !event.reason) return;

  writeAuditLog({
    action: `auth.${event.authType}.${event.outcome}`,
    userId: event.userId,
    tenantId: event.tenantId,
    metadata: {
      reason: event.reason,
      ip: event.ip,
      userAgent: event.userAgent,
      requestId: event.requestId,
    },
  });
}

export function writeAccessDeniedAuditLog(event: AccessDeniedEvent): void {
  writeAuditLog({
    action: 'authorization:denied',
    userId: event.userId,
    tenantId: event.tenantId,
    metadata: {
      decision: event.decision,
      transport: event.transport,
      layer: event.layer,
      scope: event.scope,
      reasonCode: event.reasonCode,
      reason: event.reason,
      concealAsNotFound: event.concealAsNotFound,
      statusCode: event.statusCode,
      requestId: event.requestId,
      method: event.method,
      path: event.path,
      messageType: event.messageType,
      authType: event.authType,
      projectId: event.projectId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      requiredPermission: event.requiredPermission,
      metadata: event.metadata,
    },
  });
}

// =============================================================================
// SDK TOKEN AUDIENCE/ISSUER
// =============================================================================

const SDK_TOKEN_ISSUER = PLATFORM_JWT_ISSUER;
const SDK_TOKEN_AUDIENCE = SDK_SESSION_TOKEN_AUDIENCE;

type RuntimeSdkSessionVerifier = (token: string) => Promise<RuntimeSdkSessionAuthResult>;

let runtimeSdkSessionVerifier: RuntimeSdkSessionVerifier = verifyRuntimeSdkSessionForAuth;

export function setRuntimeSdkSessionVerifierForTesting(verifier: RuntimeSdkSessionVerifier): void {
  runtimeSdkSessionVerifier = verifier;
}

export function resetRuntimeSdkSessionVerifierForTesting(): void {
  runtimeSdkSessionVerifier = verifyRuntimeSdkSessionForAuth;
}

// =============================================================================
// SUPER ADMIN CHECK
// =============================================================================

function isSuperAdmin(userId: string): boolean {
  const superAdmins = getConfig().security.superAdminUserIds;
  return superAdmins.includes(userId);
}

async function isPlatformAdminPrincipal(userId: string, email?: string | null): Promise<boolean> {
  if (isSuperAdmin(userId)) {
    return true;
  }

  if (!isDatabaseAvailable()) {
    return false;
  }

  try {
    return await isDbPlatformAdminUser({ id: userId, email });
  } catch (error) {
    log.error('DB-managed platform admin check failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function createPlatformAdminTenantContext(userId: string): TenantContextData {
  return {
    tenantId: PLATFORM_ADMIN_TENANT_ID,
    userId,
    role: 'platform_admin',
    permissions: [],
    authType: 'user',
    isSuperAdmin: true,
  };
}

// =============================================================================
// UNIFIED AUTH (all three flows)
// =============================================================================

export const unifiedAuth: RequestHandler = createUnifiedAuthMiddleware({
  getJwtSecret: () => getConfig().jwt.secret,

  logger: {
    info: (msg, meta) => log.info(msg, meta),
    warn: (msg, meta) => log.warn(msg, meta),
    error: (msg, meta) => log.error(msg, meta),
  },

  onAuthEvent: writeAuthAuditLog,
  onAccessDenied: writeAccessDeniedAuditLog,

  isSuperAdmin,

  getUserById: async (id: string): Promise<AuthUser | null> => {
    const user = await findUserById(id);
    if (user) return { id: user.id, email: user.email, name: user.name };
    // In dev/test mode only, allow dev-login tokens (sub is an email/name, not a DB id)
    if (getConfig().env === 'dev') {
      return { id, email: id.includes('@') ? id : `${id}@dev.local`, name: id };
    }
    return null;
  },

  resolveTenantMembership: async (userId, tenantId) => {
    const m = await resolveTenantMembership(userId, tenantId);
    return m ? { role: m.role, customRoleId: m.customRoleId, orgId: m.orgId } : null;
  },

  resolveDefaultTenant: async (userId) => {
    const m = await resolveDefaultTenant(userId);
    return m
      ? {
          tenantId: m.tenantId,
          role: m.role,
          customRoleId: m.customRoleId,
          orgId: m.orgId,
        }
      : null;
  },

  resolvePermissions: resolveEffectivePermissions,

  resolveApiKey: async (rawKey) => {
    try {
      const prefix = rawKey.substring(0, 8);
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      return await resolveApiKey(keyHash, prefix);
    } catch (error) {
      log.error('API key resolution failed', {
        error: error instanceof Error ? error.message : String(error),
        keyPrefix: rawKey.substring(0, 8),
        possibleDataCorruption: error instanceof Error && error.message.includes('JSON'),
      });
      return null;
    }
  },

  verifySDKSessionToken: async (token) => {
    const result = await runtimeSdkSessionVerifier(token);
    return result.success ? result.payload : null;
  },
});

/**
 * Auth middleware that REQUIRES authentication plus tenant context.
 * Runs unified auth detection, then rejects unauthenticated or tenantless requests.
 * Use for tenant-scoped routes that must be protected.
 */
const [requireAuthenticatedRequest, requireTenantContextMiddleware] = requireAuthWithTenant();
const requireAuthenticatedRequestOnly = requireAuth();
export const authMiddleware: RequestHandler = (req, res, next) => {
  unifiedAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    requireAuthenticatedRequest(req, res, (authErr?: unknown) => {
      if (authErr) return next(authErr);
      requireTenantContextMiddleware(req, res, next);
    });
  });
};

/**
 * Auth middleware for platform-admin routes.
 * Requires authentication + super-admin status but intentionally does not
 * require tenant context, because platform-admin routes operate above tenant scope.
 *
 * 3-step chain: authenticate → verify user identity → verify super-admin.
 *
 * NOTE: Downstream routes may still call `requirePlatformAdmin()` from shared-auth.
 * That is now redundant but harmless — cleanup deferred to a later pass.
 */
export const platformAdminAuthMiddleware: RequestHandler = (req, res, next) => {
  unifiedAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    requireAuthenticatedRequestOnly(req, res, (authErr?: unknown) => {
      if (authErr) return next(authErr);
      const userId = req.tenantContext?.userId ?? req.user?.id;
      void isPlatformAdminPrincipal(userId ?? '', req.user?.email)
        .then((isPlatformAdmin) => {
          if (!userId || !isPlatformAdmin) {
            getRequestAccessDeniedReporter(req)({
              layer: 'platform_admin',
              scope: 'auth',
              reasonCode: 'NOT_SUPER_ADMIN',
              reason: 'User is not a platform super admin',
              statusCode: 403,
              concealAsNotFound: false,
            });
            res.status(403).json({
              success: false,
              error: { code: 'FORBIDDEN', message: 'Platform admin access required' },
            });
            return;
          }

          if (req.tenantContext) {
            req.tenantContext.isSuperAdmin = true;
            req.authContext = toAuthContext(req.tenantContext);
            next();
            return;
          }

          const platformAdminContext = createPlatformAdminTenantContext(userId);
          req.tenantContext = platformAdminContext;
          req.authContext = toAuthContext(platformAdminContext);
          runWithTenantContext(platformAdminContext, () => next());
        })
        .catch(next);
    });
  });
};

// =============================================================================
// WEBSOCKET HELPERS
// =============================================================================

export interface VerifiedUserTokenClaims {
  userId: string;
  tenantId?: string;
  role?: string;
  orgId?: string;
}

function isStringClaim(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function extractVerifiedUserTokenClaims(token: string): VerifiedUserTokenClaims | null {
  const payload = verifyToken(token, getConfig().jwt.secret) as JWTPayload | null;
  if (!payload || payload.type !== 'access' || !isStringClaim(payload.sub)) {
    return null;
  }

  return {
    userId: payload.sub,
    tenantId: isStringClaim(payload.tenantId) ? payload.tenantId : undefined,
    role: isStringClaim(payload.role) ? payload.role : undefined,
    orgId: isStringClaim(payload.orgId) ? payload.orgId : undefined,
  };
}

export function extractUserIdFromToken(token: string): string | null {
  return (
    extractVerifiedUserTokenClaims(token)?.userId ??
    sharedExtractUserId(token, getConfig().jwt.secret)
  );
}

// Re-export for SDK token creation
export { SDK_TOKEN_ISSUER, SDK_TOKEN_AUDIENCE };
