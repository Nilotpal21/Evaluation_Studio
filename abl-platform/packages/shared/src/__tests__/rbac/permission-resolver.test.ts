import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPermissionCache,
  hasPermission,
  hasAllPermissions,
  hasAnyPermission,
  resolveRolePermissions,
  mergeResourcePermissions,
} from '../../rbac/index.js';
import {
  cachePermissions,
  clearPermissionCache as clearSharedAuthPermissionCache,
  getCachedPermissions,
  hasPermission as hasSharedAuthPermission,
  hasAllPermissions as hasSharedAuthAllPermissions,
  hasAnyPermission as hasSharedAuthAnyPermission,
  resolveRolePermissions as resolveSharedAuthRolePermissions,
  mergeResourcePermissions as mergeSharedAuthResourcePermissions,
} from '@agent-platform/shared-auth/rbac';

describe('shared RBAC permission resolver shim', () => {
  beforeEach(() => {
    clearPermissionCache();
    clearSharedAuthPermissionCache();
  });

  it('re-exports the shared-auth permission helpers without creating a second implementation', () => {
    expect(hasPermission).toBe(hasSharedAuthPermission);
    expect(hasAllPermissions).toBe(hasSharedAuthAllPermissions);
    expect(hasAnyPermission).toBe(hasSharedAuthAnyPermission);
    expect(resolveRolePermissions).toBe(resolveSharedAuthRolePermissions);
    expect(mergeResourcePermissions).toBe(mergeSharedAuthResourcePermissions);
    expect(clearPermissionCache).toBe(clearSharedAuthPermissionCache);
  });

  it('clears the shared-auth cache through the shared export', () => {
    cachePermissions('tenant-1', 'user-1', ['agent:read']);

    expect(getCachedPermissions('tenant-1', 'user-1')).toEqual(['agent:read']);

    clearPermissionCache();

    expect(getCachedPermissions('tenant-1', 'user-1')).toBeNull();
  });
});
