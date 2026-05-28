/**
 * Authentication Middleware (Academy Service)
 *
 * Uses the unified auth middleware from @agent-platform/shared-auth.
 * All academy endpoints require authentication (user must be logged in).
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
import type { AuthUser } from '@agent-platform/shared-auth';
import { createLogger } from '@agent-platform/shared-observability';
import { getConfig } from '../config.js';

const log = createLogger('academy-auth');

/**
 * Unified auth middleware — populates req.user / req.tenantContext when
 * credentials are present, passes through silently when absent.
 */
export const unifiedAuth: RequestHandler = createUnifiedAuthMiddleware({
  getJwtSecret: () => getConfig().jwtSecret,

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
    // Academy uses a simplified permission model —
    // full RBAC is resolved on the runtime side.
    return [];
  },
});

/**
 * Require authentication — rejects unauthenticated requests with 401.
 * All academy routes require authentication.
 */
const _requireAuth = sharedRequireAuth();
export const requireAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  unifiedAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    _requireAuth(req, res, next);
  });
};
