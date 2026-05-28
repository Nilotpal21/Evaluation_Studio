/**
 * Centralized Tenant Context Resolver (Sprint 1 — Task 1.2)
 *
 * Single resolution path for tenant context used by REST, WS debug, and SDK channels.
 * Replaces the duplicate `resolveWSTenantContext()` in handler.ts.
 *
 * Uses dependency injection for DB lookups to avoid coupling shared-auth to
 * specific model implementations.
 */

import type { TenantContextData, AuthType } from '../types/index.js';

// ─── Input / Dependency Types ─────────────────────────────────────────────

export interface TenantResolutionInput {
  userId: string;
  tenantIdHint?: string; // from JWT claims or query param
  authType: AuthType;
}

export interface TenantResolutionDeps {
  /** Look up the user's membership in a specific tenant. Returns null if not a member. */
  resolveTenantMembership: (
    userId: string,
    tenantId: string,
  ) => Promise<{ role: string; customRoleId?: string | null; orgId?: string } | null>;

  /** Resolve the user's default tenant (first membership). Returns null if none. */
  resolveDefaultTenant: (userId: string) => Promise<{
    tenantId: string;
    role: string;
    customRoleId?: string | null;
    orgId?: string;
  } | null>;

  /** Resolve effective permissions for a user in a tenant given their role. */
  resolveEffectivePermissions: (
    tenantId: string,
    userId: string,
    role: string,
    customRoleId?: string | null,
  ) => Promise<string[]>;

  /** User IDs that should be treated as super admins. */
  superAdminUserIds?: string[];
}

// ─── Resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve tenant context for a user across any channel (REST, WS, SDK).
 *
 * Resolution order:
 * 1. If `tenantIdHint` is provided, verify membership in that tenant.
 * 2. Otherwise, resolve the user's default tenant.
 * 3. Resolve effective permissions.
 * 4. Return a complete `TenantContextData`.
 *
 * Throws on failure (fail-closed): no membership = no access.
 */
export async function resolveTenantContext(
  input: TenantResolutionInput,
  deps: TenantResolutionDeps,
): Promise<TenantContextData> {
  const { userId, tenantIdHint, authType } = input;
  const isSuperAdmin = deps.superAdminUserIds?.includes(userId) ?? false;

  let tenantId: string;
  let role: string;
  let customRoleId: string | null | undefined;
  let orgId: string | undefined;

  if (tenantIdHint) {
    // Explicit tenant — verify membership
    const membership = await deps.resolveTenantMembership(userId, tenantIdHint);
    if (!membership) {
      throw new Error(`User ${userId} is not a member of tenant ${tenantIdHint}`);
    }
    tenantId = tenantIdHint;
    role = membership.role;
    customRoleId = membership.customRoleId;
    orgId = membership.orgId;
  } else {
    // No hint — resolve default tenant
    const defaultTenant = await deps.resolveDefaultTenant(userId);
    if (!defaultTenant) {
      throw new Error(`User ${userId} has no tenant membership`);
    }
    tenantId = defaultTenant.tenantId;
    role = defaultTenant.role;
    customRoleId = defaultTenant.customRoleId;
    orgId = defaultTenant.orgId;
  }

  // Resolve effective permissions
  const permissions = await deps.resolveEffectivePermissions(tenantId, userId, role, customRoleId);

  return {
    tenantId,
    orgId,
    userId,
    role,
    permissions,
    authType,
    isSuperAdmin,
  };
}
