/**
 * Permission Resolution Service
 *
 * Wires the shared RBAC permission-resolver (pure logic) to DB queries.
 * Resolves effective permissions for a user within a tenant context.
 */

import { findRoleDefinitions, findResourcePermissions } from '../repos/rbac-repo.js';
import {
  resolveRolePermissions,
  mergeResourcePermissions,
  clearPermissionCache as clearSharedPermissionCache,
  type RoleDefinitionRecord,
  type ResourcePermissionRecord,
} from '@agent-platform/shared-auth/rbac';
import {
  TENANT_ROLE_PERMISSIONS,
  validateCustomRolePermissions,
} from '@agent-platform/shared/rbac';

// =============================================================================
// PERMISSION CACHE
// =============================================================================

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_CACHE_MAX_ENTRIES = 10_000;
const DEFAULT_CACHE_SWEEP_INTERVAL_MS = 30_000;

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CACHE_TTL_MS = parsePositiveIntegerEnv(
  process.env.RUNTIME_PERMISSION_CACHE_TTL_MS,
  DEFAULT_CACHE_TTL_MS,
);
const CACHE_MAX_ENTRIES = parsePositiveIntegerEnv(
  process.env.RUNTIME_PERMISSION_CACHE_MAX_ENTRIES,
  DEFAULT_CACHE_MAX_ENTRIES,
);
const CACHE_SWEEP_INTERVAL_MS = parsePositiveIntegerEnv(
  process.env.RUNTIME_PERMISSION_CACHE_SWEEP_INTERVAL_MS,
  DEFAULT_CACHE_SWEEP_INTERVAL_MS,
);

function resolveBuiltInTenantPermissions(role: string): string[] {
  const normalizedRole = role.trim().toUpperCase();
  return [...(TENANT_ROLE_PERMISSIONS[normalizedRole] ?? [])];
}

function mapRoleDefinitions(rawRoles: unknown[]): RoleDefinitionRecord[] {
  return rawRoles.map((role) => {
    const record = role as Record<string, unknown>;
    return {
      id: String(record.id ?? record._id),
      name: String(record.name ?? ''),
      permissions: JSON.stringify(record.permissions ?? []),
      parentRoleId: (record.parentRoleId as string | null) ?? null,
    };
  });
}

function mapResourcePermissions(rawGrants: unknown[]): ResourcePermissionRecord[] {
  return rawGrants.map((grant) => {
    const record = grant as Record<string, unknown>;
    return {
      resourceType: String(record.resourceType ?? ''),
      resourceId: String(record.resourceId ?? ''),
      operations: JSON.stringify(record.operations ?? []),
      expiresAt: (record.expiresAt as Date | null) ?? null,
    };
  });
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

function resolveMappedProjectRolePermissions(
  role: RoleDefinitionRecord | undefined,
  allRoles: RoleDefinitionRecord[],
): string[] {
  if (!role) {
    return [];
  }

  return sanitizePermissionArray(resolveRolePermissions(role, allRoles));
}

interface CacheEntry {
  permissions: string[];
  expiresAt: number;
}

const localCache = new Map<string, CacheEntry>();

let lastCacheSweepAt = 0;

function tenantUserCacheKey(tenantId: string, userId: string): string {
  return `tenant-user:${tenantId}:${userId}`;
}

function projectRoleCacheKey(tenantId: string, customRoleId: string): string {
  return `project-role:${tenantId}:${customRoleId}`;
}

function sweepExpiredEntries(now: number): void {
  for (const [key, entry] of localCache) {
    if (now > entry.expiresAt) {
      localCache.delete(key);
    }
  }

  lastCacheSweepAt = now;
}

function maybeSweepExpiredEntries(now: number, force = false): void {
  if (!force && now - lastCacheSweepAt < CACHE_SWEEP_INTERVAL_MS) {
    return;
  }

  sweepExpiredEntries(now);
}

function evictOldestEntries(requiredFreeSlots = 1): void {
  while (localCache.size + requiredFreeSlots > CACHE_MAX_ENTRIES) {
    const oldestKey = localCache.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    localCache.delete(oldestKey);
  }
}

function getCached(key: string): string[] | null {
  const now = Date.now();
  maybeSweepExpiredEntries(now);
  const entry = localCache.get(key);
  if (!entry) return null;
  if (now > entry.expiresAt) {
    localCache.delete(key);
    return null;
  }

  localCache.delete(key);
  localCache.set(key, entry);
  return entry.permissions;
}

function setCache(key: string, permissions: string[]): void {
  const now = Date.now();

  maybeSweepExpiredEntries(now, localCache.size >= CACHE_MAX_ENTRIES);
  localCache.delete(key);
  evictOldestEntries();
  localCache.set(key, { permissions, expiresAt: now + CACHE_TTL_MS });
}

/** Clear local permission cache (call after role changes). */
export function clearPermissionCache(): void {
  localCache.clear();
  lastCacheSweepAt = 0;
  clearSharedPermissionCache();
}

export async function resolveProjectCustomRolePermissions(
  tenantId: string,
  customRoleId?: string | null,
): Promise<string[]> {
  if (!customRoleId) {
    return [];
  }

  const key = projectRoleCacheKey(tenantId, customRoleId);
  const cached = getCached(key);
  if (cached !== null) {
    return cached;
  }

  const allRoles = mapRoleDefinitions(await findRoleDefinitions(tenantId));
  const permissions = resolveMappedProjectRolePermissions(
    allRoles.find((role) => role.id === customRoleId),
    allRoles,
  );
  setCache(key, permissions);
  return permissions;
}

// =============================================================================
// BUILT-IN ROLE DEFAULTS — imported from centralized module
// =============================================================================
// TENANT_ROLE_PERMISSIONS from @agent-platform/shared/rbac is the single
// source of truth. It replaces the former BUILTIN_ROLE_PERMISSIONS that was
// a divergent subset of SYSTEM_ROLES (CF-3 finding).

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Resolve effective permissions for a user within a tenant.
 *
 * 1. If customRoleId → find RoleDefinition, walk inheritance chain
 * 2. Else → use built-in defaults for the role name
 * 3. Merge per-resource grants from ResourcePermission
 */
export async function resolveEffectivePermissions(
  tenantId: string,
  userId: string,
  role: string,
  customRoleId?: string | null,
): Promise<string[]> {
  // Check cache first
  const key = tenantUserCacheKey(tenantId, userId);
  const cached = getCached(key);
  if (cached !== null) return cached;

  let basePermissions: string[];

  if (customRoleId) {
    // Custom role — resolve from RoleDefinition table with inheritance
    const allRoles = mapRoleDefinitions(await findRoleDefinitions(tenantId));

    const customRole = allRoles.find((r) => r.id === customRoleId);
    if (customRole) {
      basePermissions = resolveRolePermissions(customRole, allRoles);
    } else {
      // Fallback to built-in if custom role not found
      basePermissions = resolveBuiltInTenantPermissions(role);
    }
  } else {
    // Built-in role
    basePermissions = resolveBuiltInTenantPermissions(role);
  }

  // Merge per-resource grants
  const resourceGrants = mapResourcePermissions(
    await findResourcePermissions({
      tenantId,
      userId,
    }),
  );

  let result: string[];
  if (resourceGrants.length > 0) {
    result = mergeResourcePermissions(basePermissions, resourceGrants);
  } else {
    result = basePermissions;
  }

  // Cache resolved permissions
  setCache(key, result);

  return result;
}
