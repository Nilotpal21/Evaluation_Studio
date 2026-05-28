/**
 * Unified Auth Middleware
 *
 * Central dispatcher that detects the auth header pattern and delegates
 * to the appropriate handler. All three auth flows converge to a fully-
 * populated TenantContextData on req.tenantContext.
 *
 * Auth flows:
 * 1. User JWT      — Authorization: Bearer <jwt>
 * 2. SDK Session   — X-SDK-Token: <token>
 * 3. API Key       — Authorization: Bearer abl_*
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyToken } from './jwt-verify.js';
import type { TenantContextData, AuthUser, SDKSessionTokenPayload } from '../types/index.js';
import { resolveSdkSessionIdentityState } from '../sdk-session-state.js';
import { runWithTenantContext } from './tenant-context.js';
import { toAuthContext } from './auth-context-bridge.js';
import {
  attachAccessDeniedReporter,
  getRequestAccessDeniedReporter,
  PLATFORM_ADMIN_TENANT_ID,
  requireTenantContextValue,
  type AccessDeniedEvent,
  type AccessDeniedLogger,
} from './access-denial.js';

// =============================================================================
// AUTH EVENT TYPES
// =============================================================================

export type AuthEventOutcome = 'success' | 'failure';

export interface AuthEvent {
  outcome: AuthEventOutcome;
  authType: 'user' | 'sdk_session' | 'api_key';
  userId?: string;
  tenantId?: string;
  reason?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

// =============================================================================
// LOGGER INTERFACE
// =============================================================================

export interface AuthLogger extends AccessDeniedLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** @internal Exported for testing only */
export const defaultLogger: AuthLogger = {
  info: () => {},
  warn: (msg, meta) => console.warn(`[UnifiedAuth] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[UnifiedAuth] ${msg}`, meta ?? ''),
};

// =============================================================================
// CONFIG INTERFACE
// =============================================================================

/**
 * Resolution result for an API key lookup.
 */
export interface ApiKeyResolution {
  tenantId: string;
  apiKeyId: string;
  clientId: string;
  createdBy: string;
  scopes: string[];
  projectIds: string[];
  environments: string[];
}

/**
 * Configuration for the unified auth middleware.
 * Consumers inject their own DB queries and config.
 */
export interface UnifiedAuthConfig {
  /** Returns the JWT secret for verification */
  getJwtSecret(): string;
  /** Looks up a user by ID (from JWT sub claim) */
  getUserById(id: string): Promise<AuthUser | null>;
  /** Resolve tenant membership for a given user + tenant */
  resolveTenantMembership(
    userId: string,
    tenantId: string,
  ): Promise<{ role: string; customRoleId?: string | null; orgId?: string } | null>;
  /** Resolve the user's default (first) tenant */
  resolveDefaultTenant(userId: string): Promise<{
    tenantId: string;
    role: string;
    customRoleId?: string | null;
    orgId?: string;
  } | null>;
  /** Resolve effective permissions for a user in a tenant */
  resolvePermissions(
    tenantId: string,
    userId: string,
    role: string,
    customRoleId?: string | null,
  ): Promise<string[]>;
  /** Resolve an API key (abl_* prefix). Optional — if not provided, API key auth is disabled. */
  resolveApiKey?(rawKey: string): Promise<ApiKeyResolution | null>;
  /** Verify an SDK session token. Optional — if not provided, SDK session auth is disabled. */
  verifySDKSessionToken?(
    token: string,
  ): SDKSessionTokenPayload | null | Promise<SDKSessionTokenPayload | null>;
  /** Optional structured logger. Falls back to console.warn/error. */
  logger?: AuthLogger;
  /** Optional auth event callback for audit logging. Fire-and-forget. */
  onAuthEvent?(event: AuthEvent): void;
  /** Optional authorization/access-denied callback for audit logging. Fire-and-forget. */
  onAccessDenied?(event: AccessDeniedEvent): void;
  /** Whether this user ID should be treated as platform super-admin. Default: () => false */
  isSuperAdmin?(userId: string): boolean;
}

// =============================================================================
// HELPERS
// =============================================================================

function getRequestIp(req: Request): string | undefined {
  const forwardedHeader = req.headers['x-forwarded-for'];
  const forwarded = Array.isArray(forwardedHeader)
    ? forwardedHeader[forwardedHeader.length - 1]
    : forwardedHeader;
  if (typeof forwarded === 'string') {
    const parts = forwarded
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const rightmost = parts[parts.length - 1];
    if (rightmost) {
      return rightmost;
    }
  }

  const realIpHeader = req.headers['x-real-ip'];
  const realIp = Array.isArray(realIpHeader) ? realIpHeader[realIpHeader.length - 1] : realIpHeader;
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }

  return req.ip;
}

function extractRequestMeta(req: Request): { ip?: string; userAgent?: string; requestId?: string } {
  return {
    ip: getRequestIp(req),
    userAgent: req.headers['user-agent'] as string | undefined,
    requestId: req.headers['x-request-id'] as string | undefined,
  };
}

function errorJson(requestId?: string) {
  return requestId ? { requestId } : undefined;
}

function buildPlatformAdminContext(userId: string): TenantContextData {
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
// MIDDLEWARE FACTORY
// =============================================================================

/**
 * Create the unified auth middleware.
 *
 * This middleware populates req.user and/or req.tenantContext.
 * It does NOT reject unauthenticated requests — use `requireAuth()` after
 * this middleware for routes that require authentication.
 *
 * Routing logic:
 * | Header                        | Handler                           |
 * |-------------------------------|-----------------------------------|
 * | Authorization: Bearer abl_*   | API key flow                      |
 * | Authorization: Bearer <jwt>   | JWT flow                          |
 * | X-SDK-Token: <token>          | SDK session flow                  |
 * | None                          | Pass through                      |
 */
export function createUnifiedAuthMiddleware(config: UnifiedAuthConfig): RequestHandler {
  const log = config.logger ?? defaultLogger;
  const emit = config.onAuthEvent ?? (() => {});
  const checkSuperAdmin = config.isSuperAdmin ?? (() => false);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const reqMeta = extractRequestMeta(req);
    attachAccessDeniedReporter(req, {
      logger: log,
      onAccessDenied: config.onAccessDenied,
      requestId: reqMeta.requestId,
      method: req.method,
      path: req.originalUrl ?? req.url,
    });
    const reportUnifiedAuthDenied = (
      event: Omit<
        AccessDeniedEvent,
        'kind' | 'decision' | 'transport' | 'requestId' | 'method' | 'path' | 'layer'
      > &
        Partial<Pick<AccessDeniedEvent, 'requestId' | 'method' | 'path'>>,
    ) => {
      getRequestAccessDeniedReporter(req)({
        layer: 'unified_auth',
        ...event,
      });
    };

    try {
      const authHeader = req.headers.authorization;
      const sdkToken = req.headers['x-sdk-token'] as string | undefined;

      // --- Path 1: SDK Session Token ---
      if (sdkToken && config.verifySDKSessionToken) {
        const payload = await config.verifySDKSessionToken(sdkToken);
        if (!payload) {
          log.warn('Invalid SDK session token', reqMeta);
          emit({
            outcome: 'failure',
            authType: 'sdk_session',
            reason: 'invalid_token',
            ...reqMeta,
          });
          reportUnifiedAuthDenied({
            scope: 'auth',
            reasonCode: 'SDK_SESSION_TOKEN_INVALID',
            reason: 'Invalid or expired SDK session token',
            concealAsNotFound: false,
            statusCode: 401,
            authType: 'sdk_session',
          });
          res.status(401).json({
            error: 'Invalid or expired SDK session token',
            ...errorJson(reqMeta.requestId),
          });
          return;
        }

        const identityState = resolveSdkSessionIdentityState(payload);
        if (!identityState.success) {
          const reason =
            identityState.reason === 'missing_verified_user'
              ? 'missing verified user identity for user scope'
              : 'missing session principal';
          log.warn(`Invalid SDK session token: ${reason}`, {
            tenantId: payload.tenantId,
            projectId: payload.projectId,
            channelId: payload.channelId,
            ...reqMeta,
          });
          emit({
            outcome: 'failure',
            authType: 'sdk_session',
            reason: identityState.reason,
            ...reqMeta,
          });
          reportUnifiedAuthDenied({
            scope: 'auth',
            reasonCode: 'SDK_SESSION_TOKEN_INVALID',
            reason: 'Invalid SDK session token state',
            concealAsNotFound: false,
            statusCode: 401,
            authType: 'sdk_session',
            tenantId: payload.tenantId,
            projectId: payload.projectId,
          });
          res.status(401).json({
            error: 'Invalid or expired SDK session token',
            ...errorJson(reqMeta.requestId),
          });
          return;
        }

        const { sessionPrincipal, authScope, principalUserId, verifiedUserId } = identityState;

        const ctx: TenantContextData = {
          tenantId: payload.tenantId,
          userId: principalUserId,
          role: 'sdk_session',
          permissions: payload.permissions,
          authType: 'sdk_session',
          isSuperAdmin: false,
          projectId: payload.projectId,
          deploymentId: payload.deploymentId,
          channelId: payload.channelId,
          sessionId: payload.sessionId ?? sessionPrincipal,
          sessionPrincipal,
          // Propagate identity fields from SDK session token
          verifiedUserId,
          identityTier: payload.identityTier,
          verificationMethod: payload.verificationMethod,
          authScope,
          channelArtifact: payload.channelArtifact,
          userContext: payload.userContext,
        };

        req.tenantContext = ctx;
        req.authContext = toAuthContext(ctx);
        emit({
          outcome: 'success',
          authType: 'sdk_session',
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          ...reqMeta,
        });
        return runWithTenantContext(ctx, () => next());
      }

      // --- Path 2: API Key (x-api-key header or abl_* bearer prefix) ---
      const xApiKey = req.headers['x-api-key'] as string | undefined;
      const apiKeyRaw = xApiKey
        ? xApiKey
        : authHeader?.startsWith('Bearer abl_')
          ? authHeader.split(' ')[1]
          : undefined;

      if (apiKeyRaw && config.resolveApiKey) {
        const rawKey = apiKeyRaw;
        const resolution = await config.resolveApiKey(rawKey);

        if (!resolution) {
          log.warn('Invalid API key', reqMeta);
          emit({ outcome: 'failure', authType: 'api_key', reason: 'invalid_key', ...reqMeta });
          reportUnifiedAuthDenied({
            scope: 'auth',
            reasonCode: 'API_KEY_INVALID',
            reason: 'Invalid or expired API key',
            concealAsNotFound: false,
            statusCode: 401,
            authType: 'api_key',
          });
          res
            .status(401)
            .json({ error: 'Invalid or expired API key', ...errorJson(reqMeta.requestId) });
          return;
        }

        const ctx: TenantContextData = {
          tenantId: resolution.tenantId,
          userId: resolution.createdBy,
          role: 'api_key',
          permissions: resolution.scopes,
          authType: 'api_key',
          isSuperAdmin: false,
          apiKeyId: resolution.apiKeyId,
          clientId: resolution.clientId,
          projectScope: resolution.projectIds.length > 0 ? resolution.projectIds : undefined,
          environmentScope:
            resolution.environments.length > 0 ? resolution.environments : undefined,
        };

        req.tenantContext = ctx;
        req.authContext = toAuthContext(ctx);
        emit({
          outcome: 'success',
          authType: 'api_key',
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          ...reqMeta,
        });
        return runWithTenantContext(ctx, () => next());
      }

      // --- Path 3: User JWT ---
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        const secret = config.getJwtSecret();
        const payload = verifyToken(token, secret);

        if (!payload) {
          log.warn('Invalid JWT token', reqMeta);
          emit({ outcome: 'failure', authType: 'user', reason: 'invalid_token', ...reqMeta });
          reportUnifiedAuthDenied({
            scope: 'auth',
            reasonCode: 'JWT_TOKEN_INVALID',
            reason: 'Invalid or expired token',
            concealAsNotFound: false,
            statusCode: 401,
            authType: 'user',
          });
          res
            .status(401)
            .json({ error: 'Invalid or expired token', ...errorJson(reqMeta.requestId) });
          return;
        }

        // Handle MFA-pending tokens
        if (payload.type === 'mfa_pending') {
          const user = await config.getUserById(payload.sub);
          if (!user) {
            emit({
              outcome: 'failure',
              authType: 'user',
              reason: 'user_not_found',
              userId: payload.sub,
              ...reqMeta,
            });
            reportUnifiedAuthDenied({
              scope: 'auth',
              reasonCode: 'USER_NOT_FOUND',
              reason: 'User not found',
              concealAsNotFound: false,
              statusCode: 401,
              authType: 'user',
              userId: payload.sub,
            });
            res.status(401).json({ error: 'User not found', ...errorJson(reqMeta.requestId) });
            return;
          }
          req.user = user;
          req.mfaPending = true;
          emit({
            outcome: 'success',
            authType: 'user',
            userId: user.id,
            reason: 'mfa_pending',
            ...reqMeta,
          });

          // Wrap in ALS if we can resolve a tenant (best-effort for MFA-pending)
          if (payload.tenantId) {
            const membership = await config.resolveTenantMembership(user.id, payload.tenantId);
            if (membership) {
              const ctx: TenantContextData = {
                tenantId: payload.tenantId,
                orgId: payload.orgId,
                userId: user.id,
                role: membership.role,
                permissions: [],
                authType: 'user',
                isSuperAdmin: false,
              };
              req.tenantContext = ctx;
              req.authContext = toAuthContext(ctx);
              return runWithTenantContext(ctx, () => next());
            }
          }
          next();
          return;
        }

        // Full access token
        const user = await config.getUserById(payload.sub);
        if (!user) {
          emit({
            outcome: 'failure',
            authType: 'user',
            reason: 'user_not_found',
            userId: payload.sub,
            ...reqMeta,
          });
          reportUnifiedAuthDenied({
            scope: 'auth',
            reasonCode: 'USER_NOT_FOUND',
            reason: 'User not found',
            concealAsNotFound: false,
            statusCode: 401,
            authType: 'user',
            userId: payload.sub,
          });
          res.status(401).json({ error: 'User not found', ...errorJson(reqMeta.requestId) });
          return;
        }
        req.user = user;
        const isSuperAdmin = checkSuperAdmin(user.id);

        // Resolve tenant context
        let tenantId: string | undefined = payload.tenantId;
        let role: string | undefined;
        let customRoleId: string | null | undefined;
        let orgId: string | undefined = payload.orgId;

        if (tenantId) {
          // Token has tenantId — verify membership
          const membership = await config.resolveTenantMembership(user.id, tenantId);
          if (!membership) {
            if (isSuperAdmin) {
              const ctx = buildPlatformAdminContext(user.id);
              req.tenantContext = ctx;
              req.authContext = toAuthContext(ctx);
              emit({
                outcome: 'success',
                authType: 'user',
                userId: user.id,
                tenantId: ctx.tenantId,
                reason: 'platform_admin_bootstrap',
                ...reqMeta,
              });
              return runWithTenantContext(ctx, () => next());
            }
            emit({
              outcome: 'failure',
              authType: 'user',
              reason: 'not_tenant_member',
              userId: user.id,
              tenantId,
              ...reqMeta,
            });
            reportUnifiedAuthDenied({
              scope: 'tenant',
              reasonCode: 'TENANT_MEMBERSHIP_REQUIRED',
              reason: 'Not a member of this tenant',
              concealAsNotFound: false,
              statusCode: 403,
              authType: 'user',
              userId: user.id,
              tenantId,
              resourceType: 'tenant',
              resourceId: tenantId,
            });
            res
              .status(403)
              .json({ error: 'Not a member of this tenant', ...errorJson(reqMeta.requestId) });
            return;
          }
          role = membership.role;
          customRoleId = membership.customRoleId;
        } else {
          // No tenantId in token — resolve from user's default tenant.
          // SECURITY: Never read tenant hints from request headers (X-Tenant-Id,
          // X-Organization-Id) or query params. TenantId must come exclusively
          // from verified credentials (JWT claims, SDK tokens, API key lookups).
          const defaultTenant = await config.resolveDefaultTenant(user.id);
          if (defaultTenant) {
            tenantId = defaultTenant.tenantId;
            role = defaultTenant.role;
            customRoleId = defaultTenant.customRoleId;
            orgId = defaultTenant.orgId;
          }
        }

        if (tenantId && role) {
          const permissions = await config.resolvePermissions(
            tenantId,
            user.id,
            role,
            customRoleId,
          );
          const ctx: TenantContextData = {
            tenantId,
            orgId,
            userId: user.id,
            role,
            permissions,
            authType: 'user',
            isSuperAdmin,
            projectId: payload.projectId,
          };

          req.tenantContext = ctx;
          req.authContext = toAuthContext(ctx);
          emit({ outcome: 'success', authType: 'user', userId: user.id, tenantId, ...reqMeta });
          return runWithTenantContext(ctx, () => next());
        }

        if (isSuperAdmin) {
          const ctx = buildPlatformAdminContext(user.id);
          req.tenantContext = ctx;
          req.authContext = toAuthContext(ctx);
          emit({
            outcome: 'success',
            authType: 'user',
            userId: user.id,
            tenantId: ctx.tenantId,
            reason: 'platform_admin_bootstrap',
            ...reqMeta,
          });
          return runWithTenantContext(ctx, () => next());
        }

        // User authenticated but no tenant context (new user with no memberships)
        emit({ outcome: 'success', authType: 'user', userId: user.id, ...reqMeta });
        next();
        return;
      }

      // --- No auth header — pass through ---
      next();
    } catch (error) {
      log.error('Unhandled auth error', {
        error: error instanceof Error ? error.message : String(error),
        ...reqMeta,
      });
      res.status(500).json({ error: 'Internal server error', ...errorJson(reqMeta.requestId) });
    }
  };
}

// =============================================================================
// REQUIRE AUTH GUARD
// =============================================================================

/**
 * Middleware that rejects requests lacking authentication.
 * Use AFTER createUnifiedAuthMiddleware() for mandatory-auth routes.
 *
 * Checks that at least one of req.user or req.tenantContext was set
 * by the upstream unified auth middleware.
 */
export function requireAuth(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.user || req.tenantContext) {
      next();
      return;
    }
    const requestId = req.headers['x-request-id'] as string | undefined;
    getRequestAccessDeniedReporter(req)({
      layer: 'require_auth',
      scope: 'auth',
      reasonCode: 'AUTHENTICATION_REQUIRED',
      reason: 'Authentication required',
      concealAsNotFound: false,
      statusCode: 401,
      requestId,
    });
    res.status(401).json({ error: 'Authentication required', ...errorJson(requestId) });
  };
}

/**
 * Middleware that guarantees `req.tenantContext` is populated with a valid tenantId.
 * Returns 403 with standard error envelope if tenant context is missing or invalid.
 *
 * Use after `createUnifiedAuthMiddleware()` on routes that require tenant isolation.
 */
export function requireTenantContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = requireTenantContextValue(req, res);
    if (ctx) {
      next();
    }
  };
}

/**
 * Convenience: requireAuth() + requireTenantContext() in one call.
 * Most tenant-scoped routes should use this instead of requireAuth() alone.
 *
 * For routes that genuinely don't need tenant context (e.g., /me, /tenants),
 * use requireAuth() directly with a comment explaining why.
 */
export function requireAuthWithTenant(): RequestHandler[] {
  return [requireAuth(), requireTenantContext()];
}
