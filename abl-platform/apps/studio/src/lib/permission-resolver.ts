/**
 * Permission Resolver Adapter for Studio
 *
 * Bridges Studio's Next.js auth layer with the shared RBAC permission system.
 * Resolves effective permissions for a user within their tenant context by:
 * 1. Looking up the user's RoleDefinition (walking parent chain)
 * 2. Merging any explicit ResourcePermission grants
 * 3. Caching with LRU eviction to avoid repeated DB queries
 *
 * Usage:
 *   const permissions = await resolveStudioPermissions(tenantId, userId, role);
 *   // => ['tool:read', 'tool:write', ...]
 */

import {
  hasPermission,
  hasAnyPermission,
  resolveRolePermissions,
  mergeResourcePermissions,
  TENANT_ROLE_PERMISSIONS,
  validateCustomRolePermissions,
  type RoleDefinitionRecord,
  type ResourcePermissionRecord,
} from '@agent-platform/shared/rbac';

// Re-export permission check helpers for route-handler convenience
export { hasPermission, hasAnyPermission };

// ─── Cache ─────────────────────────────────────────────────────────────────

interface CacheEntry {
  permissions: string[];
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000; // 1 minute
const CACHE_MAX_SIZE = 100;

const cache = new Map<string, CacheEntry>();

function studioPermissionCacheKey(tenantId: string, userId: string): string {
  return `tenant-user:${tenantId}:${userId}`;
}

function projectCustomRoleCacheKey(tenantId: string, customRoleId: string): string {
  return `project-role:${tenantId}:${customRoleId}`;
}

function evictIfNeeded(): void {
  if (cache.size < CACHE_MAX_SIZE) return;

  // Purge expired entries first — avoids evicting valid data
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(key);
  }

  if (cache.size < CACHE_MAX_SIZE) return;

  // Still full — evict oldest by insertion order
  const firstKey = cache.keys().next().value;
  if (firstKey !== undefined) cache.delete(firstKey);
}

function getCached(key: string): string[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.permissions;
}

function setCache(key: string, permissions: string[]): void {
  evictIfNeeded();
  cache.set(key, { permissions, expiresAt: Date.now() + CACHE_TTL_MS });
}

function sanitizePermissionArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const permissions = value.filter(
    (permission): permission is string => typeof permission === 'string' && permission.length > 0,
  );
  const { invalid } = validateCustomRolePermissions(permissions);

  if (invalid.length === 0) {
    return [...new Set(permissions)];
  }

  const invalidPermissions = new Set(invalid);
  return [...new Set(permissions.filter((permission) => !invalidPermissions.has(permission)))];
}

function mapRoleDefinitions(rawRoles: Array<Record<string, unknown>>): RoleDefinitionRecord[] {
  return rawRoles.map((role) => ({
    id: String(role._id),
    name: String(role.name ?? ''),
    permissions: JSON.stringify(role.permissions ?? []),
    parentRoleId: (role.parentRoleId as string | null) ?? null,
  }));
}

/** Clear the permission cache (for testing or after role changes). */
export function clearStudioPermissionCache(): void {
  cache.clear();
}

// ─── Resolver ──────────────────────────────────────────────────────────────

/**
 * Resolve effective permissions for a Studio user.
 *
 * @param tenantId - The tenant context
 * @param userId - The authenticated user ID
 * @param role - The user's role name within the tenant
 * @param customRoleId - Optional custom role override
 * @returns Flat array of permission strings (e.g. ['tool:read', 'tool:write'])
 */
export async function resolveStudioPermissions(
  tenantId: string,
  userId: string,
  role: string,
  customRoleId?: string | null,
): Promise<string[]> {
  const key = studioPermissionCacheKey(tenantId, userId);
  const cached = getCached(key);
  if (cached !== null) return cached;

  try {
    const { RoleDefinition, ResourcePermission } = await import('@agent-platform/database/models');

    // 1. Load all roles for this tenant (for parent-chain walking)
    // Mongoose .lean() returns _id + array fields; map to expected record shape
    const rawRoles = (await RoleDefinition.find({ tenantId }).lean()) as Array<
      Record<string, unknown>
    >;
    const allRoles = mapRoleDefinitions(rawRoles);

    // 2. Find the user's role (prefer customRoleId, fall back to role name)
    const userRole = customRoleId
      ? allRoles.find((r) => r.id === customRoleId)
      : allRoles.find((r) => r.name === role);

    let permissions: string[] = [];

    if (userRole) {
      permissions = resolveRolePermissions(userRole, allRoles);
    } else {
      // Fallback to built-in role permissions when no DB role exists
      // (e.g. dynamically created tenant with no seeded RoleDefinitions)
      const builtInPerms = TENANT_ROLE_PERMISSIONS[role.toUpperCase()];
      if (builtInPerms) {
        permissions = [...builtInPerms];
      }
    }

    // 3. Merge explicit resource grants for this user
    const rawGrants = await ResourcePermission.find({ tenantId, userId }).lean();
    const grants: ResourcePermissionRecord[] = rawGrants.map((g: Record<string, unknown>) => ({
      resourceType: g.resourceType as string,
      resourceId: g.resourceId as string,
      operations: JSON.stringify(g.operations ?? []),
      expiresAt: (g.expiresAt as Date | null) ?? null,
    }));

    if (grants.length > 0) {
      permissions = mergeResourcePermissions(permissions, grants);
    }

    setCache(key, permissions);
    return permissions;
  } catch (error) {
    // If DB lookup fails, return empty permissions (deny by default)
    console.error('[resolveStudioPermissions] Failed to resolve permissions:', error);
    return [];
  }
}

export async function resolveProjectCustomRolePermissions(
  tenantId: string,
  customRoleId?: string | null,
): Promise<string[]> {
  if (!customRoleId) {
    return [];
  }

  const key = projectCustomRoleCacheKey(tenantId, customRoleId);
  const cached = getCached(key);
  if (cached !== null) return cached;

  try {
    const { RoleDefinition } = await import('@agent-platform/database/models');
    const rawRoles = (await RoleDefinition.find({ tenantId }).lean()) as Array<
      Record<string, unknown>
    >;
    const allRoles = mapRoleDefinitions(rawRoles);
    const role = allRoles.find((candidate) => candidate.id === customRoleId);
    const permissions = role ? sanitizePermissionArray(resolveRolePermissions(role, allRoles)) : [];
    setCache(key, permissions);
    return permissions;
  } catch (error) {
    console.error('[resolveProjectCustomRolePermissions] Failed to resolve permissions:', error);
    return [];
  }
}
