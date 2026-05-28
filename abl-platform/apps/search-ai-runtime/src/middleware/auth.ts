/**
 * Authentication Middleware (Search Runtime)
 *
 * Uses the unified auth middleware from @agent-platform/shared,
 * configured with the search-runtime's config and database.
 *
 * Supports:
 * 1. User JWT      — Authorization: Bearer <jwt>
 * 2. API Key       — Authorization: Bearer abl_*
 * 3. Internal service JWT — Runtime mints short-lived tokens with
 *    the shared JWT_SECRET for service-to-service calls.
 */

import crypto from 'crypto';
import type { RequestHandler } from 'express';
import { createUnifiedAuthMiddleware, requireAuthWithTenant } from '@agent-platform/shared';
import type { AuthUser } from '@agent-platform/shared';
import { expandScopesToPermissions } from '@agent-platform/shared-auth';
import type { IApiKey } from '@agent-platform/database/models';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../config/index.js';

// =============================================================================
// UNIFIED AUTH (JWT + API Key flows)
// =============================================================================

const logger = createLogger('search-runtime-auth');

export const unifiedAuth: RequestHandler = createUnifiedAuthMiddleware({
  getJwtSecret: () => getConfig().jwt.secret,

  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => logger.info(msg, meta ?? {}),
    warn: (msg: string, meta?: Record<string, unknown>) => logger.warn(msg, meta ?? {}),
    error: (msg: string, meta?: Record<string, unknown>) => logger.error(msg, meta ?? {}),
  },

  getUserById: async (id: string): Promise<AuthUser | null> => {
    // Internal service tokens minted by Runtime use sub: 'service:runtime'.
    // These are service-to-service calls (e.g., SearchAI KB tool execution)
    // and don't correspond to a real User record. Return a synthetic user so
    // the unified auth middleware can attach tenant context from the JWT claims.
    // Without this, SDK/WebSDK sessions fail with 401 "User not found" because
    // their resolvedUserId is a synthetic session principal, not a real user.
    if (id.startsWith('service:')) {
      return { id, email: `${id.replace(':', '-')}@internal.service`, name: id };
    }

    // In dev/test mode, allow any token subject as a user
    const env = getConfig().env;
    if (env === 'dev') {
      return { id, email: id.includes('@') ? id : `${id}@dev.local`, name: id };
    }

    // In production, look up user from database
    try {
      const { User } = await import('@agent-platform/database/models/user');
      const user = await User.findOne({ _id: id }).lean();
      if (!user) return null;
      return { id: user._id as string, email: user.email, name: user.name };
    } catch {
      return null;
    }
  },

  resolveTenantMembership: async (userId: string, tenantId: string) => {
    // Internal service tokens (sub: 'service:runtime') don't have tenant
    // membership records. Grant OWNER so the unified auth middleware can
    // build a valid TenantContext with the tenantId from the JWT claims.
    if (userId.startsWith('service:')) {
      return { role: 'OWNER', customRoleId: null };
    }

    // In dev mode, allow any internal/service token to pass membership checks.
    // The Runtime mints JWTs with internal:true for service-to-service calls
    // and these service users won't have real tenant_members records.
    const env = getConfig().env;
    if (env === 'dev') {
      // Dev mode: return synthetic OWNER membership.
      // The dual-connection setup doesn't register TenantMember on the platform DB,
      // and the default mongoose connection isn't connected, so DB lookups fail.
      return { role: 'OWNER', customRoleId: null };
    }

    try {
      const { TenantMember } = await import('@agent-platform/database/models/tenant-member');
      const m = await TenantMember.findOne({ userId, tenantId }).lean();
      if (!m) return null;
      return { role: m.role, customRoleId: (m as any).customRoleId ?? null };
    } catch {
      return null;
    }
  },

  resolveDefaultTenant: async (userId: string) => {
    try {
      const { TenantMember } = await import('@agent-platform/database/models/tenant-member');
      const m = await TenantMember.findOne({ userId }).sort({ createdAt: 1 }).lean();
      if (!m) return null;
      return {
        tenantId: m.tenantId,
        role: m.role,
        customRoleId: (m as any).customRoleId ?? null,
      };
    } catch {
      return null;
    }
  },

  resolvePermissions: async (
    _tenantId: string,
    _userId: string,
    _role: string,
    _customRoleId?: string | null,
  ) => {
    // Search runtime uses a simplified permission model.
    // Authenticated users (Studio JWT) get full search access.
    // API key permissions come from resolveApiKey → expandScopesToPermissions,
    // not from here (unified-auth sets ctx.permissions = resolution.scopes).
    return ['search:read', 'search:query', 'knowledge_base:read'];
  },

  resolveApiKey: async (rawKey: string) => {
    try {
      const { ApiKey } = await import('@agent-platform/database/models/api-key');
      const prefix = rawKey.substring(0, 8);
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const doc = (await ApiKey.findOne({ keyHash, revokedAt: null }).lean()) as IApiKey | null;
      if (!doc) return null;
      if (doc.prefix !== prefix) return null;
      if (doc.expiresAt && doc.expiresAt < new Date()) return null;
      return {
        tenantId: doc.tenantId,
        apiKeyId: doc._id as string,
        clientId: doc.clientId,
        createdBy: doc.createdBy,
        scopes: expandScopesToPermissions(doc.scopes ?? []),
        projectIds: doc.projectIds ?? [],
        environments: doc.environments ?? [],
      };
    } catch (err) {
      logger.error('Failed to resolve API key', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },
});

/**
 * Auth middleware that REQUIRES authentication plus tenant context.
 * Runs unified auth detection, then rejects unauthenticated or tenantless requests.
 */
const [requireAuthenticatedRequest, requireTenantContextMiddleware] = requireAuthWithTenant();
export const authMiddleware: RequestHandler = (req, res, next) => {
  unifiedAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    requireAuthenticatedRequest(req, res, (authErr?: unknown) => {
      if (authErr) return next(authErr);
      requireTenantContextMiddleware(req, res, next);
    });
  });
};
