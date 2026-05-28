/**
 * Permission Resolver Tests
 *
 * Tests hasPermission, hasAllPermissions, hasAnyPermission,
 * resolveRolePermissions, mergeResourcePermissions, and the cache layer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  hasPermission,
  hasAllPermissions,
  hasAnyPermission,
  resolveRolePermissions,
  mergeResourcePermissions,
  clearPermissionCache,
} from '../rbac/permission-resolver.js';
import type {
  RoleDefinitionRecord,
  ResourcePermissionRecord,
} from '../rbac/permission-resolver.js';

// =============================================================================
// hasPermission
// =============================================================================

describe('hasPermission', () => {
  it('should match exact permission', () => {
    expect(hasPermission(['project:read', 'agent:execute'], 'project:read')).toBe(true);
  });

  it('should reject when permission not granted', () => {
    expect(hasPermission(['project:read'], 'tenant:delete')).toBe(false);
  });

  it('should match wildcard *:*', () => {
    expect(hasPermission(['*:*'], 'anything:here')).toBe(true);
  });

  it('should match resource wildcard project:*', () => {
    expect(hasPermission(['project:*'], 'project:create')).toBe(true);
    expect(hasPermission(['project:*'], 'project:delete')).toBe(true);
  });

  it('should not match resource wildcard for different resource', () => {
    expect(hasPermission(['project:*'], 'agent:execute')).toBe(false);
  });

  it('should return false for malformed required permission (no colon)', () => {
    expect(hasPermission(['project:read'], 'projectread')).toBe(false);
  });

  it('should return false for empty granted list', () => {
    expect(hasPermission([], 'project:read')).toBe(false);
  });
});

// =============================================================================
// hasAllPermissions
// =============================================================================

describe('hasAllPermissions', () => {
  it('should return true when all permissions are granted', () => {
    expect(
      hasAllPermissions(
        ['project:read', 'agent:execute', 'tenant:read'],
        ['project:read', 'agent:execute'],
      ),
    ).toBe(true);
  });

  it('should return false when one permission is missing', () => {
    expect(hasAllPermissions(['project:read'], ['project:read', 'tenant:delete'])).toBe(false);
  });

  it('should return true for empty required list', () => {
    expect(hasAllPermissions(['project:read'], [])).toBe(true);
  });

  it('should work with wildcards', () => {
    expect(hasAllPermissions(['*:*'], ['project:read', 'tenant:delete'])).toBe(true);
  });
});

// =============================================================================
// hasAnyPermission
// =============================================================================

describe('hasAnyPermission', () => {
  it('should return true when at least one permission is granted', () => {
    expect(hasAnyPermission(['project:read'], ['tenant:delete', 'project:read'])).toBe(true);
  });

  it('should return false when no permission is granted', () => {
    expect(hasAnyPermission(['project:read'], ['tenant:delete', 'tenant:create'])).toBe(false);
  });

  it('should return false for empty required list', () => {
    expect(hasAnyPermission(['project:read'], [])).toBe(false);
  });

  it('should work with wildcards', () => {
    expect(hasAnyPermission(['project:*'], ['project:create', 'tenant:delete'])).toBe(true);
  });
});

// =============================================================================
// resolveRolePermissions
// =============================================================================

describe('resolveRolePermissions', () => {
  it('should return permissions from a single role', () => {
    const role: RoleDefinitionRecord = {
      id: 'role1',
      name: 'Admin',
      permissions: JSON.stringify(['project:read', 'project:write']),
      parentRoleId: null,
    };

    const result = resolveRolePermissions(role, [role]);
    expect(result).toEqual(['project:read', 'project:write']);
  });

  it('should merge permissions from parent role', () => {
    const parentRole: RoleDefinitionRecord = {
      id: 'parent',
      name: 'Base',
      permissions: JSON.stringify(['project:read']),
      parentRoleId: null,
    };
    const childRole: RoleDefinitionRecord = {
      id: 'child',
      name: 'Admin',
      permissions: JSON.stringify(['project:write']),
      parentRoleId: 'parent',
    };

    const result = resolveRolePermissions(childRole, [parentRole, childRole]);
    expect(result).toContain('project:read');
    expect(result).toContain('project:write');
  });

  it('should deduplicate permissions from parent and child', () => {
    const parentRole: RoleDefinitionRecord = {
      id: 'parent',
      name: 'Base',
      permissions: JSON.stringify(['project:read', 'agent:execute']),
      parentRoleId: null,
    };
    const childRole: RoleDefinitionRecord = {
      id: 'child',
      name: 'Admin',
      permissions: JSON.stringify(['project:read', 'project:write']),
      parentRoleId: 'parent',
    };

    const result = resolveRolePermissions(childRole, [parentRole, childRole]);
    const readCount = result.filter((p) => p === 'project:read').length;
    expect(readCount).toBe(1);
  });

  it('should handle circular references (cycle guard)', () => {
    const roleA: RoleDefinitionRecord = {
      id: 'a',
      name: 'A',
      permissions: JSON.stringify(['a:read']),
      parentRoleId: 'b',
    };
    const roleB: RoleDefinitionRecord = {
      id: 'b',
      name: 'B',
      permissions: JSON.stringify(['b:read']),
      parentRoleId: 'a',
    };

    const result = resolveRolePermissions(roleA, [roleA, roleB]);
    expect(result).toContain('a:read');
    expect(result).toContain('b:read');
  });

  it('should handle missing parent role gracefully', () => {
    const childRole: RoleDefinitionRecord = {
      id: 'child',
      name: 'Child',
      permissions: JSON.stringify(['child:read']),
      parentRoleId: 'nonexistent',
    };

    const result = resolveRolePermissions(childRole, [childRole]);
    expect(result).toEqual(['child:read']);
  });

  it('should walk multi-level inheritance', () => {
    const grandparent: RoleDefinitionRecord = {
      id: 'gp',
      name: 'Grandparent',
      permissions: JSON.stringify(['gp:read']),
      parentRoleId: null,
    };
    const parent: RoleDefinitionRecord = {
      id: 'p',
      name: 'Parent',
      permissions: JSON.stringify(['p:read']),
      parentRoleId: 'gp',
    };
    const child: RoleDefinitionRecord = {
      id: 'c',
      name: 'Child',
      permissions: JSON.stringify(['c:read']),
      parentRoleId: 'p',
    };

    const result = resolveRolePermissions(child, [grandparent, parent, child]);
    expect(result).toContain('gp:read');
    expect(result).toContain('p:read');
    expect(result).toContain('c:read');
  });
});

// =============================================================================
// mergeResourcePermissions
// =============================================================================

describe('mergeResourcePermissions', () => {
  it('should merge resource grants into base permissions', () => {
    const base = ['project:read'];
    const grants: ResourcePermissionRecord[] = [
      {
        resourceType: 'agent',
        resourceId: 'agent1',
        operations: JSON.stringify(['execute', 'read']),
        expiresAt: null,
      },
    ];

    const result = mergeResourcePermissions(base, grants);
    expect(result).toContain('project:read');
    expect(result).toContain('agent:execute');
    expect(result).toContain('agent:read');
  });

  it('should filter out expired grants', () => {
    const base = ['project:read'];
    const pastDate = new Date(Date.now() - 86400_000); // yesterday
    const grants: ResourcePermissionRecord[] = [
      {
        resourceType: 'agent',
        resourceId: 'agent1',
        operations: JSON.stringify(['execute']),
        expiresAt: pastDate,
      },
    ];

    const result = mergeResourcePermissions(base, grants);
    expect(result).toEqual(['project:read']);
    expect(result).not.toContain('agent:execute');
  });

  it('should include non-expired grants', () => {
    const base = ['project:read'];
    const futureDate = new Date(Date.now() + 86400_000); // tomorrow
    const grants: ResourcePermissionRecord[] = [
      {
        resourceType: 'agent',
        resourceId: 'agent1',
        operations: JSON.stringify(['execute']),
        expiresAt: futureDate,
      },
    ];

    const result = mergeResourcePermissions(base, grants);
    expect(result).toContain('agent:execute');
  });

  it('should deduplicate merged permissions', () => {
    const base = ['agent:execute'];
    const grants: ResourcePermissionRecord[] = [
      {
        resourceType: 'agent',
        resourceId: 'agent1',
        operations: JSON.stringify(['execute']),
        expiresAt: null,
      },
    ];

    const result = mergeResourcePermissions(base, grants);
    const count = result.filter((p) => p === 'agent:execute').length;
    expect(count).toBe(1);
  });

  it('should handle empty grants', () => {
    const base = ['project:read'];
    const result = mergeResourcePermissions(base, []);
    expect(result).toEqual(['project:read']);
  });

  it('should handle empty base', () => {
    const grants: ResourcePermissionRecord[] = [
      {
        resourceType: 'agent',
        resourceId: 'agent1',
        operations: JSON.stringify(['execute']),
        expiresAt: null,
      },
    ];

    const result = mergeResourcePermissions([], grants);
    expect(result).toEqual(['agent:execute']);
  });
});

// =============================================================================
// clearPermissionCache
// =============================================================================

describe('clearPermissionCache', () => {
  it('should not throw when called', () => {
    expect(() => clearPermissionCache()).not.toThrow();
  });
});
