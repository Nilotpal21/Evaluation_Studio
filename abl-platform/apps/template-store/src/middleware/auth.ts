/**
 * Authentication Middleware (Template Store)
 *
 * Uses the unified auth middleware from @agent-platform/shared-auth.
 * Template store supports:
 * - Public access (no auth) for browsing templates
 * - Authenticated access for publishing/managing templates
 *
 * Auth flows:
 * 1. User JWT      — Authorization: Bearer <jwt>
 * 2. API Key       — Authorization: Bearer abl_*
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  createUnifiedAuthMiddleware,
  requireAuth as sharedRequireAuth,
} from '@agent-platform/shared-auth';
import type { AuthUser, TenantContextData } from '@agent-platform/shared-auth';
import { createLogger } from '@agent-platform/shared-observability';
import { getConfig } from '../config.js';

const log = createLogger('template-store-auth');

interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  tenantContext?: TenantContextData;
}

/**
 * Unified auth middleware — populates req.user / req.tenantContext when
 * credentials are present, passes through silently when absent.
 */
function checkIsSuperAdmin(userId: string): boolean {
  const raw = process.env.SUPER_ADMIN_USER_IDS || '';
  if (!raw) return false;
  const ids = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return ids.includes(userId);
}

export const unifiedAuth: RequestHandler = createUnifiedAuthMiddleware({
  getJwtSecret: () => getConfig().jwtSecret,

  isSuperAdmin: checkIsSuperAdmin,

  logger: {
    info: (msg, meta) => log.info(msg, meta),
    warn: (msg, meta) => log.warn(msg, meta),
    error: (msg, meta) => log.error(msg, meta),
  },

  getUserById: async (id: string): Promise<AuthUser | null> => {
    // Lazy import to avoid loading models before DB is ready
    const { User } = await import('@agent-platform/database/models');
    const user = await User.findOne({ _id: id }).lean();
    if (!user) {
      if (getConfig().env !== 'production') {
        return { id, email: id.includes('@') ? id : `${id}@dev.local`, name: id };
      }
      return null;
    }
    return { id: String(user._id), email: user.email, name: user.name };
  },

  resolveTenantMembership: async (userId, tenantId) => {
    const { TenantMember } = await import('@agent-platform/database/models');
    const member = await TenantMember.findOne({ userId, tenantId }).lean();
    if (!member) return null;
    return { role: member.role, customRoleId: member.customRoleId ?? null };
  },

  resolveDefaultTenant: async (userId) => {
    const { TenantMember } = await import('@agent-platform/database/models');
    const member = await TenantMember.findOne({ userId }).sort({ createdAt: 1 }).lean();
    if (!member) return null;
    return {
      tenantId: member.tenantId,
      role: member.role,
      customRoleId: member.customRoleId ?? null,
    };
  },

  resolvePermissions: async () => {
    // Template store uses a simplified permission model —
    // full RBAC is resolved on the runtime side.
    return [];
  },
});

/**
 * Require authentication — rejects unauthenticated requests with 401.
 * Use for routes that must be protected (publish, update, delete templates).
 */
const _requireAuth = sharedRequireAuth();
export const requireAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  unifiedAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    _requireAuth(req, res, next);
  });
};

/**
 * Optional auth — extracts user if JWT present but continues if not.
 * Use for routes that work both authenticated and unauthenticated
 * (e.g., browsing templates with optional personalization).
 *
 * IMPORTANT: `createUnifiedAuthMiddleware` sends a 401 response directly
 * (without calling next) when JWT verification fails. For truly optional auth,
 * we intercept the response: if unifiedAuth tries to send 401, we strip the
 * auth header and continue without a user context. This is critical for
 * cross-service calls where another service (e.g., Studio) may forward a JWT
 * signed with a different secret.
 */
export const optionalAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  // Intercept res.status to detect if unifiedAuth is about to send a 401
  const originalStatus = res.status.bind(res);
  const originalJson = res.json.bind(res);
  let intercepted = false;

  const interceptRes = Object.create(res) as Response;
  interceptRes.status = ((code: number) => {
    if (code === 401) {
      // unifiedAuth is trying to reject — suppress and continue without user
      intercepted = true;
      return interceptRes;
    }
    return originalStatus(code);
  }) as Response['status'];
  interceptRes.json = ((body: unknown) => {
    if (intercepted) {
      // Swallow the 401 response body — continue to next middleware
      intercepted = false;
      log.debug('optionalAuth: suppressed 401 from invalid/foreign JWT, continuing without user');
      return next() as unknown as Response;
    }
    return originalJson(body);
  }) as Response['json'];

  unifiedAuth(req, interceptRes, (err?: unknown) => {
    if (err) {
      // If unifiedAuth calls next(err), also suppress and continue
      log.debug('optionalAuth: suppressed auth error, continuing without user', {
        error: err instanceof Error ? err.message : String(err),
      });
      return next();
    }
    // Auth succeeded or no token present — continue with user populated (or not)
    const authReq = req as AuthenticatedRequest;
    log.debug('optionalAuth: auth chain completed', {
      hasUser: !!authReq.user,
      hasTenantContext: !!authReq.tenantContext,
      tenantId: authReq.tenantContext?.tenantId ?? 'none',
      hasAuthHeader: !!req.headers.authorization,
    });
    next();
  });
};
