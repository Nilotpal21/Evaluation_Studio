/**
 * Permission Resolver
 *
 * Resolves effective permissions for a user within a tenant context.
 * Reads RoleDefinition, ResourcePermission, and ProjectMember from the DB.
 * Caches results with a configurable TTL to avoid repeated queries.
 *
 * Permission string format: `{resourceType}:{operation}` — e.g. "agent:execute"
 * Wildcard: `*:*` matches everything; `project:*` matches any project operation.
 */

export const SENSITIVE_EXACT_PERMISSIONS = ['pii:reveal'] as const;
export type SensitiveExactPermission = (typeof SENSITIVE_EXACT_PERMISSIONS)[number];

const SENSITIVE_EXACT_PERMISSION_SET = new Set<string>(SENSITIVE_EXACT_PERMISSIONS);

// =============================================================================
// TYPES
// =============================================================================

export interface PermissionResolverConfig {
  /** Cache TTL in milliseconds (default: 60_000 = 1 minute) */
  cacheTtlMs?: number;
}

export interface ResolvedPermissions {
  /** Flat list of permission strings: "resource:operation" */
  permissions: string[];
  /** Source role name (for audit/debug) */
  roleName: string;
  /** Whether the user is a super-admin (bypasses all checks) */
  isSuperAdmin: boolean;
}

/** Minimal RoleDefinition shape expected from DB */
export interface RoleDefinitionRecord {
  id: string;
  name: string;
  permissions: string; // JSON array
  parentRoleId: string | null;
}

/** Minimal ResourcePermission shape expected from DB */
export interface ResourcePermissionRecord {
  resourceType: string;
  resourceId: string;
  operations: string; // JSON array
  expiresAt: Date | null;
}

/** Minimal ProjectMember shape expected from DB */
export interface ProjectMemberRecord {
  role: string;
  customRoleId: string | null;
}

// =============================================================================
// CACHE
// =============================================================================

interface CacheEntry {
  permissions: string[];
  expiresAt: number;
}

const permissionCache = new Map<string, CacheEntry>();

function cacheKey(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

function getCached(key: string): string[] | null {
  const entry = permissionCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    permissionCache.delete(key);
    return null;
  }
  return entry.permissions;
}

function setCache(key: string, permissions: string[], ttlMs: number): void {
  permissionCache.set(key, { permissions, expiresAt: Date.now() + ttlMs });
}

/** Clear the permission cache (for testing or after role changes). */
export function clearPermissionCache(): void {
  permissionCache.clear();
}

/**
 * Cache the resolved permissions for a tenant+user pair.
 * Called by external resolvers after computing the full permission set.
 */
export function cachePermissions(
  tenantId: string,
  userId: string,
  permissions: string[],
  ttlMs = 60_000,
): void {
  const key = cacheKey(tenantId, userId);
  setCache(key, permissions, ttlMs);
}

/**
 * Retrieve cached permissions for a tenant+user pair.
 * Returns null if not cached or expired.
 */
export function getCachedPermissions(tenantId: string, userId: string): string[] | null {
  const key = cacheKey(tenantId, userId);
  return getCached(key);
}

// =============================================================================
// PERMISSION CHECK LOGIC
// =============================================================================

/**
 * Check if a list of granted permissions satisfies a required permission.
 * Handles wildcards: `*:*` matches everything, `project:*` matches `project:create`, etc.
 */
export function hasPermission(granted: readonly string[], required: string): boolean {
  if (granted.includes('*:*')) return true;
  if (granted.includes(required)) return true;

  const [reqResource, reqOp] = required.split(':');
  if (!reqResource || !reqOp) return false;

  // Check resource wildcard: "project:*"
  if (granted.includes(`${reqResource}:*`)) return true;

  return false;
}

export function hasExactPermission(granted: readonly string[], required: string): boolean {
  return granted.includes(required);
}

export function isSensitiveExactPermission(
  permission: string,
): permission is SensitiveExactPermission {
  return SENSITIVE_EXACT_PERMISSION_SET.has(permission);
}

/**
 * Check permissions that must never be inferred from wildcards.
 *
 * This preserves normal RBAC wildcard behavior while giving reveal-grade
 * permissions a fail-closed helper for callers that need it.
 */
export function hasSensitivePermission(granted: readonly string[], required: string): boolean {
  if (isSensitiveExactPermission(required)) {
    return hasExactPermission(granted, required);
  }

  return hasPermission(granted, required);
}

/**
 * Check if granted permissions satisfy ALL required permissions.
 */
export function hasAllPermissions(
  granted: readonly string[],
  required: readonly string[],
): boolean {
  return required.every((perm) => hasPermission(granted, perm));
}

/**
 * Check if granted permissions satisfy ANY of the required permissions.
 */
export function hasAnyPermission(granted: readonly string[], required: readonly string[]): boolean {
  return required.some((perm) => hasPermission(granted, perm));
}

// =============================================================================
// ROLE RESOLUTION
// =============================================================================

/**
 * Resolve permissions from a RoleDefinition, walking the parentRoleId chain.
 * Returns a flat de-duplicated list of permission strings.
 */
export function resolveRolePermissions(
  role: RoleDefinitionRecord | undefined | null,
  allRoles: RoleDefinitionRecord[],
  visited = new Set<string>(),
): string[] {
  if (!role?.id) {
    return [];
  }

  if (visited.has(role.id)) return []; // cycle guard
  visited.add(role.id);

  let own: string[] = [];
  try {
    const raw =
      typeof role.permissions === 'string'
        ? role.permissions
        : JSON.stringify(role.permissions ?? []);
    own = JSON.parse(raw);
  } catch {
    return [];
  }

  if (role.parentRoleId) {
    const parent = allRoles.find((r) => r.id === role.parentRoleId);
    if (parent?.id) {
      const parentPerms = resolveRolePermissions(parent, allRoles, visited);
      return [...new Set([...own, ...parentPerms])];
    }
  }

  return own;
}

/**
 * Merge explicit ResourcePermission grants into a permission set.
 * Filters out expired grants.
 */
export function mergeResourcePermissions(
  base: readonly string[],
  grants: ResourcePermissionRecord[],
): string[] {
  const now = new Date();
  const merged = new Set(base);

  for (const grant of grants) {
    if (grant.expiresAt && grant.expiresAt < now) continue;
    const ops: string[] = JSON.parse(grant.operations);
    for (const op of ops) {
      merged.add(`${grant.resourceType}:${op}`);
    }
  }

  return [...merged];
}
