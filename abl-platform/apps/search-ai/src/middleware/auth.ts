/**
 * Authentication Middleware (Search Engine)
 *
 * Uses the shared unified auth middleware with real DB lookups via the
 * platform database connection (dual-MongoDB: platform + content).
 *
 * Auth scenarios:
 * 1. Internal Users (Studio/Platform users)
 *    Purpose: Manage indexes, sources, documents, schemas
 *    Auth: Platform JWT (tenantId claim required)
 *    Routes: /api/indexes, /api/sources, /api/documents, /api/admin
 *
 * 2. API Key
 *    Purpose: Programmatic access
 *    Auth: Authorization: Bearer abl_*
 *
 * Supports:
 * 1. User JWT      — Authorization: Bearer <jwt>
 * 2. API Key       — Authorization: Bearer abl_*
 */

import crypto from 'crypto';
import type { RequestHandler } from 'express';
import {
  createUnifiedAuthMiddleware,
  expandScopesToPermissions,
  requireAuthWithTenant,
} from '@agent-platform/shared-auth';
import type { AuthUser, AuthEvent } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../config/index.js';
import {
  findUserById as repoFindUser,
  resolveTenantMembership as repoResolveMembership,
  resolveDefaultTenant as repoResolveDefault,
} from '../repos/auth-repo.js';

const logger = createLogger('auth');

// =============================================================================
// ROLE-BASED PERMISSIONS
// =============================================================================

const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: [
    'index:read',
    'index:write',
    'source:read',
    'source:write',
    'document:read',
    'document:write',
    'schema:read',
    'schema:write',
    'job:read',
    'job:write',
    'admin:indexes:read',
    'admin:indexes:rotate',
    'admin:indexes:delete',
    'admin:errors:read',
    'admin:errors:retry',
    'admin:metrics:read',
    'admin:queues:read',
    'admin:queues:manage',
  ],
  ADMIN: [
    'index:read',
    'index:write',
    'source:read',
    'source:write',
    'document:read',
    'document:write',
    'schema:read',
    'schema:write',
    'job:read',
    'job:write',
    'admin:indexes:read',
    'admin:indexes:rotate',
    'admin:indexes:delete',
    'admin:errors:read',
    'admin:errors:retry',
    'admin:metrics:read',
    'admin:queues:read',
    'admin:queues:manage',
  ],
  MEMBER: [
    'index:read',
    'index:write',
    'source:read',
    'source:write',
    'document:read',
    'document:write',
    'schema:read',
    'schema:write',
    'job:read',
    'job:write',
  ],
  VIEWER: ['index:read', 'source:read', 'document:read', 'schema:read', 'job:read'],
};

function resolveRolePermissions(role: string): string[] {
  return ROLE_PERMISSIONS[role.toUpperCase()] ?? [];
}

// =============================================================================
// UNIFIED AUTH MIDDLEWARE
// =============================================================================

export const unifiedAuth: RequestHandler = createUnifiedAuthMiddleware({
  getJwtSecret: () => getConfig().jwt.secret,

  logger: {
    info: (msg, meta) => logger.info(msg, meta ?? {}),
    warn: (msg, meta) => logger.warn(msg, meta ?? {}),
    error: (msg, meta) => logger.error(msg, meta ?? {}),
  },

  onAuthEvent: (_event: AuthEvent) => {
    // Fire-and-forget audit logging
  },

  isSuperAdmin: (_userId: string): boolean => {
    return false;
  },

  getUserById: async (id: string): Promise<AuthUser | null> => {
    // Internal service tokens minted by Runtime use sub: 'service:runtime'.
    // These are service-to-service calls (e.g., SearchAI KB tool execution)
    // and don't correspond to a real User record. Return a synthetic user so
    // the unified auth middleware can attach tenant context from the JWT claims.
    // Without this, SDK/WebSDK sessions fail with 401 "User not found".
    if (id.startsWith('service:')) {
      return { id, email: `${id.replace(':', '-')}@internal.service`, name: id };
    }

    const user = await repoFindUser(id);
    if (!user) return null;
    return { id: user.id, email: user.email, name: user.name ?? id };
  },

  resolveTenantMembership: async (userId, tenantId) => {
    // Internal service tokens (sub: 'service:runtime') don't have tenant
    // membership records. Grant OWNER so the unified auth middleware can
    // build a valid TenantContext with the tenantId from the JWT claims.
    if (userId.startsWith('service:')) {
      return { role: 'OWNER', customRoleId: null };
    }

    const membership = await repoResolveMembership(userId, tenantId);
    if (!membership) return null;
    return {
      role: membership.role,
      customRoleId: membership.customRoleId,
      orgId: membership.orgId,
    };
  },

  resolveDefaultTenant: async (userId) => {
    const result = await repoResolveDefault(userId);
    if (!result) return null;
    return {
      tenantId: result.tenantId,
      role: result.role,
      customRoleId: result.customRoleId,
      orgId: result.orgId,
    };
  },

  resolvePermissions: async (_tenantId, _userId, role, _customRoleId) => {
    return resolveRolePermissions(role);
  },

  resolveApiKey: async (rawKey) => {
    try {
      const { ApiKey } = await import('@agent-platform/database/models');
      const prefix = rawKey.substring(0, 8);
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const apiKey = await ApiKey.findOne({ keyHash, revokedAt: null }).lean();
      if (!apiKey) return null;
      if (apiKey.prefix !== prefix) return null;
      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;
      return {
        tenantId: apiKey.tenantId,
        apiKeyId: apiKey._id,
        clientId: apiKey.clientId,
        createdBy: apiKey.createdBy,
        scopes: expandScopesToPermissions(apiKey.scopes || []),
        projectIds: apiKey.projectIds || [],
        environments: apiKey.environments || [],
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
