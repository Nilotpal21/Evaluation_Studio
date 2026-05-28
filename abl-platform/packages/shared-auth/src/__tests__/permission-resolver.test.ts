import { describe, it, expect, beforeEach } from 'vitest';
import type {
  RoleDefinitionRecord,
  ResourcePermissionRecord,
} from '../rbac/permission-resolver.js';
import {
  SENSITIVE_EXACT_PERMISSIONS,
  hasPermission,
  hasExactPermission,
  isSensitiveExactPermission,
  hasSensitivePermission,
  hasAllPermissions,
  hasAnyPermission,
  resolveRolePermissions,
  mergeResourcePermissions,
  clearPermissionCache,
  cachePermissions,
  getCachedPermissions,
} from '../rbac/permission-resolver.js';

// ---------------------------------------------------------------------------
// hasPermission
// ---------------------------------------------------------------------------

describe('hasPermission', () => {
  it('returns true on exact match', () => {
    expect(hasPermission(['agent:read', 'agent:write'], 'agent:read')).toBe(true);
  });

  it('returns true on wildcard *:*', () => {
    expect(hasPermission(['*:*'], 'agent:delete')).toBe(true);
  });

  it('returns true on resource wildcard (project:*)', () => {
    expect(hasPermission(['project:*'], 'project:create')).toBe(true);
  });

  it('returns false when no match', () => {
    expect(hasPermission(['agent:read'], 'agent:write')).toBe(false);
  });

  it('returns false for empty granted list', () => {
    expect(hasPermission([], 'agent:read')).toBe(false);
  });

  it('returns false for malformed required permission (no colon)', () => {
    expect(hasPermission(['agent:read'], 'agentread')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sensitive exact permissions
// ---------------------------------------------------------------------------

describe('sensitive exact permissions', () => {
  it('registers pii:reveal as an exact sensitive permission', () => {
    expect(SENSITIVE_EXACT_PERMISSIONS).toContain('pii:reveal');
    expect(isSensitiveExactPermission('pii:reveal')).toBe(true);
    expect(isSensitiveExactPermission('project:read')).toBe(false);
  });

  it('checks exact grants without wildcard expansion', () => {
    expect(hasExactPermission(['pii:reveal'], 'pii:reveal')).toBe(true);
    expect(hasExactPermission(['*:*'], 'pii:reveal')).toBe(false);
    expect(hasExactPermission(['project:*'], 'pii:reveal')).toBe(false);
  });

  it('preserves wildcard behavior for normal permissions', () => {
    expect(hasSensitivePermission(['*:*'], 'agent:delete')).toBe(true);
    expect(hasSensitivePermission(['project:*'], 'project:update')).toBe(true);
  });

  it('requires an exact grant for sensitive reveal permissions', () => {
    expect(hasSensitivePermission(['pii:reveal'], 'pii:reveal')).toBe(true);
    expect(hasSensitivePermission(['*:*'], 'pii:reveal')).toBe(false);
    expect(hasSensitivePermission(['project:*'], 'pii:reveal')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasAllPermissions
// ---------------------------------------------------------------------------

describe('hasAllPermissions', () => {
  it('returns true when all required are present', () => {
    expect(
      hasAllPermissions(
        ['agent:read', 'agent:write', 'project:create'],
        ['agent:read', 'project:create'],
      ),
    ).toBe(true);
  });

  it('returns false when one is missing', () => {
    expect(hasAllPermissions(['agent:read'], ['agent:read', 'agent:delete'])).toBe(false);
  });

  it('returns true for empty required array', () => {
    expect(hasAllPermissions(['agent:read'], [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasAnyPermission
// ---------------------------------------------------------------------------

describe('hasAnyPermission', () => {
  it('returns true when one required is present', () => {
    expect(hasAnyPermission(['agent:read'], ['agent:read', 'agent:delete'])).toBe(true);
  });

  it('returns false when none present', () => {
    expect(hasAnyPermission(['project:create'], ['agent:read', 'agent:delete'])).toBe(false);
  });

  it('returns false for empty required array', () => {
    // Array.some on empty → false
    expect(hasAnyPermission(['agent:read'], [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveRolePermissions
// ---------------------------------------------------------------------------

describe('resolveRolePermissions', () => {
  it('resolves permissions from a single role (no parent)', () => {
    const role: RoleDefinitionRecord = {
      id: 'role-1',
      name: 'viewer',
      permissions: JSON.stringify(['agent:read', 'project:read']),
      parentRoleId: null,
    };
    const result = resolveRolePermissions(role, [role]);
    expect(result).toEqual(['agent:read', 'project:read']);
  });

  it('resolves permissions with parent chain', () => {
    const parent: RoleDefinitionRecord = {
      id: 'role-parent',
      name: 'viewer',
      permissions: JSON.stringify(['agent:read']),
      parentRoleId: null,
    };
    const child: RoleDefinitionRecord = {
      id: 'role-child',
      name: 'editor',
      permissions: JSON.stringify(['agent:write']),
      parentRoleId: 'role-parent',
    };
    const result = resolveRolePermissions(child, [parent, child]);
    expect(result).toContain('agent:read');
    expect(result).toContain('agent:write');
  });

  it('de-duplicates permissions from parent and child', () => {
    const parent: RoleDefinitionRecord = {
      id: 'role-parent',
      name: 'viewer',
      permissions: JSON.stringify(['agent:read', 'project:read']),
      parentRoleId: null,
    };
    const child: RoleDefinitionRecord = {
      id: 'role-child',
      name: 'editor',
      permissions: JSON.stringify(['agent:read', 'agent:write']),
      parentRoleId: 'role-parent',
    };
    const result = resolveRolePermissions(child, [parent, child]);
    const unique = [...new Set(result)];
    expect(result.length).toBe(unique.length);
  });

  it('handles cycle detection', () => {
    const roleA: RoleDefinitionRecord = {
      id: 'a',
      name: 'A',
      permissions: JSON.stringify(['perm:a']),
      parentRoleId: 'b',
    };
    const roleB: RoleDefinitionRecord = {
      id: 'b',
      name: 'B',
      permissions: JSON.stringify(['perm:b']),
      parentRoleId: 'a',
    };
    // Should not infinitely recurse
    const result = resolveRolePermissions(roleA, [roleA, roleB]);
    expect(result).toContain('perm:a');
    expect(result).toContain('perm:b');
  });

  it('handles missing parent gracefully', () => {
    const child: RoleDefinitionRecord = {
      id: 'role-child',
      name: 'editor',
      permissions: JSON.stringify(['agent:write']),
      parentRoleId: 'role-nonexistent',
    };
    const result = resolveRolePermissions(child, [child]);
    expect(result).toEqual(['agent:write']);
  });
});

// ---------------------------------------------------------------------------
// mergeResourcePermissions
// ---------------------------------------------------------------------------

describe('mergeResourcePermissions', () => {
  it('includes base permissions', () => {
    const result = mergeResourcePermissions(['agent:read'], []);
    expect(result).toContain('agent:read');
  });

  it('adds non-expired grants', () => {
    const grant: ResourcePermissionRecord = {
      resourceType: 'project',
      resourceId: 'proj-1',
      operations: JSON.stringify(['create', 'delete']),
      expiresAt: new Date(Date.now() + 100_000),
    };
    const result = mergeResourcePermissions(['agent:read'], [grant]);
    expect(result).toContain('agent:read');
    expect(result).toContain('project:create');
    expect(result).toContain('project:delete');
  });

  it('skips expired grants', () => {
    const grant: ResourcePermissionRecord = {
      resourceType: 'project',
      resourceId: 'proj-1',
      operations: JSON.stringify(['create']),
      expiresAt: new Date(Date.now() - 100_000),
    };
    const result = mergeResourcePermissions(['agent:read'], [grant]);
    expect(result).toContain('agent:read');
    expect(result).not.toContain('project:create');
  });

  it('includes grants with null expiresAt (never expires)', () => {
    const grant: ResourcePermissionRecord = {
      resourceType: 'project',
      resourceId: 'proj-1',
      operations: JSON.stringify(['create']),
      expiresAt: null,
    };
    const result = mergeResourcePermissions([], [grant]);
    expect(result).toContain('project:create');
  });

  it('produces no duplicates', () => {
    const grant: ResourcePermissionRecord = {
      resourceType: 'agent',
      resourceId: 'agent-1',
      operations: JSON.stringify(['read']),
      expiresAt: null,
    };
    const result = mergeResourcePermissions(['agent:read'], [grant]);
    const unique = [...new Set(result)];
    expect(result.length).toBe(unique.length);
  });
});

// ---------------------------------------------------------------------------
// clearPermissionCache
// ---------------------------------------------------------------------------

describe('clearPermissionCache', () => {
  it('can be called without error', () => {
    // clearPermissionCache is a side-effect function that clears the module-level cache.
    // We verify it doesn't throw and can be called multiple times.
    expect(() => clearPermissionCache()).not.toThrow();
    expect(() => clearPermissionCache()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// cachePermissions / getCachedPermissions
// ---------------------------------------------------------------------------

describe('cachePermissions and getCachedPermissions', () => {
  beforeEach(() => {
    clearPermissionCache();
  });

  it('returns null when nothing is cached', () => {
    expect(getCachedPermissions('tenant-1', 'user-1')).toBeNull();
  });

  it('caches and retrieves permissions', () => {
    cachePermissions('tenant-1', 'user-1', ['agent:read', 'agent:write']);
    const cached = getCachedPermissions('tenant-1', 'user-1');
    expect(cached).toEqual(['agent:read', 'agent:write']);
  });

  it('returns null for different tenant+user pair', () => {
    cachePermissions('tenant-1', 'user-1', ['agent:read']);
    expect(getCachedPermissions('tenant-2', 'user-1')).toBeNull();
    expect(getCachedPermissions('tenant-1', 'user-2')).toBeNull();
  });

  it('returns null after cache is cleared', () => {
    cachePermissions('tenant-1', 'user-1', ['agent:read']);
    clearPermissionCache();
    expect(getCachedPermissions('tenant-1', 'user-1')).toBeNull();
  });

  it('returns null after TTL expires', async () => {
    cachePermissions('tenant-1', 'user-1', ['agent:read'], 10); // 10ms TTL
    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getCachedPermissions('tenant-1', 'user-1')).toBeNull();
  });

  it('returns cached value within TTL', () => {
    cachePermissions('tenant-1', 'user-1', ['agent:read'], 60_000);
    expect(getCachedPermissions('tenant-1', 'user-1')).toEqual(['agent:read']);
  });

  it('overwrites existing cache entry', () => {
    cachePermissions('tenant-1', 'user-1', ['agent:read']);
    cachePermissions('tenant-1', 'user-1', ['agent:read', 'agent:write']);
    expect(getCachedPermissions('tenant-1', 'user-1')).toEqual(['agent:read', 'agent:write']);
  });

  it('caches empty permission arrays', () => {
    cachePermissions('tenant-1', 'user-1', []);
    expect(getCachedPermissions('tenant-1', 'user-1')).toEqual([]);
  });
});
