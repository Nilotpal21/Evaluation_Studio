/**
 * Authorization Test Helper
 *
 * Provides configurable tenant context injection for testing RBAC enforcement.
 * Uses the canonical permission maps from @agent-platform/shared/rbac.
 */

import type { Request, Response, NextFunction } from 'express';
import {
  TENANT_ROLE_PERMISSIONS,
  PROJECT_ROLE_PERMISSIONS as CANONICAL_PROJECT_ROLE_PERMISSIONS,
} from '@agent-platform/shared/rbac';

/**
 * Canonical tenant role→permission mappings from centralized shared/rbac module.
 * Mutable copy for test compatibility (readonly source → mutable test values).
 */
export const ROLE_PERMISSIONS: Record<string, string[]> = Object.fromEntries(
  Object.entries(TENANT_ROLE_PERMISSIONS).map(([k, v]) => [k, [...v]]),
);

export interface TenantContextData {
  tenantId: string;
  userId: string;
  permissions: string[];
  authType?: string;
  role?: string;
  isSuperAdmin?: boolean;
  projectScope?: string[];
}

/**
 * Create a TenantContextData for a given role.
 */
export function makeTenantContext(
  tenantId: string,
  userId: string,
  role: keyof typeof ROLE_PERMISSIONS,
  overrides?: Partial<TenantContextData>,
): TenantContextData {
  return {
    tenantId,
    userId,
    permissions: ROLE_PERMISSIONS[role],
    authType: 'jwt',
    role,
    ...overrides,
  };
}

/**
 * Canonical project role→permission mappings from centralized shared/rbac module.
 * Mutable copy for test compatibility.
 */
export const PROJECT_ROLE_PERMISSIONS: Record<string, string[]> = Object.fromEntries(
  Object.entries(CANONICAL_PROJECT_ROLE_PERMISSIONS).map(([k, v]) => [k, [...v]]),
);

export function injectTenantContext(ctx: TenantContextData) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    (req as any).tenantContext = {
      ...ctx,
      ...(ctx.isSuperAdmin !== undefined && { isSuperAdmin: ctx.isSuperAdmin }),
      ...(ctx.projectScope && { projectScope: ctx.projectScope }),
    };
    (req as any).user = { id: ctx.userId, email: `${ctx.userId}@test.com` };
    next();
  };
}
