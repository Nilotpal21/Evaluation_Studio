import type { RequestHandler } from 'express';
import { createUnifiedAuthMiddleware, requireAuth } from '@agent-platform/shared';
import { expandScopesToPermissions } from '@agent-platform/shared-auth';
import { TENANT_ROLE_PERMISSIONS } from '@agent-platform/shared-auth/rbac';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('workflow-engine:auth');

export const unifiedAuth: RequestHandler = createUnifiedAuthMiddleware({
  getJwtSecret: () => {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET environment variable is required');
    return secret;
  },
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => log.info(msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => log.warn(msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => log.error(msg, meta),
  },
  isSuperAdmin: (userId: string) => {
    const ids = process.env.SUPER_ADMIN_USER_IDS?.split(',') ?? [];
    return ids.includes(userId);
  },
  getUserById: async (userId: string) => {
    if (userId.startsWith('service:')) {
      return { id: userId, email: `${userId.replace(':', '-')}@internal.service`, name: userId };
    }
    const { User } = await import('@agent-platform/database/models');
    const doc = await User.findOne({ _id: userId }, { email: 1, name: 1 }).lean();
    if (!doc) return null;
    return { id: doc._id as string, email: doc.email, name: doc.name };
  },
  resolveTenantMembership: async (userId: string, tenantId: string) => {
    if (userId.startsWith('service:')) {
      return { role: 'OWNER', customRoleId: null };
    }
    const { TenantMember } = await import('@agent-platform/database/models');
    const { Tenant } = await import('@agent-platform/database/models');
    const m = await TenantMember.findOne({ userId, tenantId }).lean();
    if (!m) return null;
    const tenant = await Tenant.findOne({ _id: tenantId }, { organizationId: 1 }).lean();
    return {
      role: m.role,
      customRoleId: m.customRoleId,
      orgId: (tenant as any)?.organizationId ?? undefined,
    };
  },
  resolveDefaultTenant: async (userId: string) => {
    const { TenantMember } = await import('@agent-platform/database/models');
    const { Tenant } = await import('@agent-platform/database/models');
    const m = await TenantMember.findOne({ userId }).sort({ lastAccessedAt: -1 }).lean();
    if (!m) return null;
    const tenant = await Tenant.findOne({ _id: m.tenantId }, { organizationId: 1 }).lean();
    return {
      tenantId: m.tenantId,
      role: m.role,
      customRoleId: m.customRoleId,
      orgId: (tenant as any)?.organizationId ?? undefined,
    };
  },
  resolvePermissions: async (
    _tenantId: string,
    _userId: string,
    role: string,
    _customRoleId?: string | null,
  ) => {
    const perms = TENANT_ROLE_PERMISSIONS[role.toUpperCase()];
    return perms ? [...perms] : [];
  },
  resolveApiKey: async (rawKey: string) => {
    const crypto = await import('crypto');
    const prefix = rawKey.substring(0, 8);
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const { ApiKey, PublicApiKey } = await import('@agent-platform/database/models');

    const apiKey = await ApiKey.findOne({ keyHash }).lean();
    if (apiKey) {
      if (apiKey.prefix !== prefix) return null;
      if (apiKey.revokedAt) return null;
      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;
      return {
        tenantId: apiKey.tenantId,
        apiKeyId: apiKey._id as string,
        clientId: apiKey.clientId,
        createdBy: apiKey.createdBy,
        scopes: expandScopesToPermissions(apiKey.scopes ?? []),
        projectIds: apiKey.projectIds,
        environments: apiKey.environments,
      };
    }

    const publicKey = await PublicApiKey.findOne({ keyHash }).lean();
    if (!publicKey) return null;
    if (!publicKey.keyPrefix.startsWith(prefix)) return null;
    if (!publicKey.isActive) return null;
    if (publicKey.expiresAt && publicKey.expiresAt < new Date()) return null;
    if (!publicKey.tenantId) return null;

    return {
      tenantId: publicKey.tenantId,
      apiKeyId: publicKey._id as string,
      clientId: `sdk-${publicKey._id as string}`,
      createdBy: 'sdk-key',
      scopes: ['*:*'],
      projectIds: [publicKey.projectId],
      environments: [],
    };
  },
});

export const authMiddleware: RequestHandler[] = [unifiedAuth, requireAuth()];
