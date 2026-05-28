import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clearCollections, setupTestMongo, teardownTestMongo } from '../helpers/setup-mongo.js';
import { TENANT_ROLE_PERMISSIONS } from '@agent-platform/shared/rbac';

const CACHE_ENV_KEYS = [
  'RUNTIME_PERMISSION_CACHE_MAX_ENTRIES',
  'RUNTIME_PERMISSION_CACHE_TTL_MS',
  'RUNTIME_PERMISSION_CACHE_SWEEP_INTERVAL_MS',
] as const;

const ORIGINAL_ENV = new Map<string, string | undefined>(
  CACHE_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function restorePermissionCacheEnv(): void {
  for (const key of CACHE_ENV_KEYS) {
    const originalValue = ORIGINAL_ENV.get(key);
    if (originalValue === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = originalValue;
  }
}

async function loadPermissionResolutionModule(options?: {
  maxEntries?: number;
  ttlMs?: number;
  sweepIntervalMs?: number;
}) {
  restorePermissionCacheEnv();

  if (options?.maxEntries !== undefined) {
    process.env.RUNTIME_PERMISSION_CACHE_MAX_ENTRIES = String(options.maxEntries);
  }
  if (options?.ttlMs !== undefined) {
    process.env.RUNTIME_PERMISSION_CACHE_TTL_MS = String(options.ttlMs);
  }
  if (options?.sweepIntervalMs !== undefined) {
    process.env.RUNTIME_PERMISSION_CACHE_SWEEP_INTERVAL_MS = String(options.sweepIntervalMs);
  }

  vi.resetModules();
  return import('../../services/permission-resolution.js');
}

describe('runtime permission-resolution cache', () => {
  beforeAll(async () => {
    await setupTestMongo();
  }, 60_000);

  afterEach(async () => {
    restorePermissionCacheEnv();
    vi.useRealTimers();
    await clearCollections();
  });

  afterAll(async () => {
    await teardownTestMongo();
  }, 30_000);

  it('clearPermissionCache clears the runtime cache used by resolveEffectivePermissions', async () => {
    const permissionResolution = await loadPermissionResolutionModule();

    const initialPermissions = await permissionResolution.resolveEffectivePermissions(
      'tenant-clear',
      'user-clear',
      'MEMBER',
    );
    expect(initialPermissions).not.toContain('*:*');

    const stalePermissions = await permissionResolution.resolveEffectivePermissions(
      'tenant-clear',
      'user-clear',
      'OWNER',
    );
    expect(stalePermissions).not.toContain('*:*');

    permissionResolution.clearPermissionCache();

    const refreshedPermissions = await permissionResolution.resolveEffectivePermissions(
      'tenant-clear',
      'user-clear',
      'OWNER',
    );
    expect(refreshedPermissions).toContain('*:*');
  });

  it('resolves custom tenant-role permissions from RoleDefinition rows and merges resource grants', async () => {
    const permissionResolution = await loadPermissionResolutionModule();
    const { RoleDefinition, ResourcePermission } = await import('@agent-platform/database/models');

    await RoleDefinition.create({
      _id: 'role-parent',
      tenantId: 'tenant-custom',
      name: 'Support Base',
      permissions: ['tool:read'],
      createdBy: 'admin-user',
    });
    await RoleDefinition.create({
      _id: 'role-custom',
      tenantId: 'tenant-custom',
      name: 'Support Custom',
      permissions: ['agent:execute'],
      parentRoleId: 'role-parent',
      createdBy: 'admin-user',
    });
    await ResourcePermission.create({
      tenantId: 'tenant-custom',
      userId: 'user-custom',
      resourceType: 'workflow',
      resourceId: 'workflow-1',
      operations: ['execute'],
      grantedBy: 'admin-user',
    });

    const permissions = await permissionResolution.resolveEffectivePermissions(
      'tenant-custom',
      'user-custom',
      'MEMBER',
      'role-custom',
    );

    expect(permissions).toEqual(
      expect.arrayContaining(['tool:read', 'agent:execute', 'workflow:execute']),
    );
    expect(permissions).not.toEqual(expect.arrayContaining(TENANT_ROLE_PERMISSIONS.MEMBER));
  });

  it('falls back to normalized built-in tenant permissions when a custom role id is stale', async () => {
    const permissionResolution = await loadPermissionResolutionModule();

    const permissions = await permissionResolution.resolveEffectivePermissions(
      'tenant-fallback',
      'user-fallback',
      ' member ',
      'missing-custom-role',
    );

    expect(permissions).toEqual(expect.arrayContaining([...TENANT_ROLE_PERMISSIONS.MEMBER]));
    expect(permissions).not.toContain('*:*');
  });

  it('caches sanitized project custom-role permissions and refreshes them after clearPermissionCache', async () => {
    const permissionResolution = await loadPermissionResolutionModule();
    const { RoleDefinition } = await import('@agent-platform/database/models');

    await RoleDefinition.create({
      _id: 'project-parent-role',
      tenantId: 'tenant-project-role',
      name: 'Project Parent',
      permissions: ['tool:write'],
      createdBy: 'admin-user',
    });
    await RoleDefinition.create({
      _id: 'project-custom-role',
      tenantId: 'tenant-project-role',
      name: 'Project Support',
      permissions: ['agent:read', 'tool:write', 'agent:read', '*:*', 'invalid:permission'],
      parentRoleId: 'project-parent-role',
      createdBy: 'admin-user',
    });

    const first = await permissionResolution.resolveProjectCustomRolePermissions(
      'tenant-project-role',
      'project-custom-role',
    );
    expect(first).toEqual(['agent:read', 'tool:write']);

    await RoleDefinition.updateOne(
      { _id: 'project-custom-role', tenantId: 'tenant-project-role' },
      { $set: { permissions: ['agent:delete'] } },
    );

    const cached = await permissionResolution.resolveProjectCustomRolePermissions(
      'tenant-project-role',
      'project-custom-role',
    );
    expect(cached).toEqual(['agent:read', 'tool:write']);

    permissionResolution.clearPermissionCache();

    const refreshed = await permissionResolution.resolveProjectCustomRolePermissions(
      'tenant-project-role',
      'project-custom-role',
    );
    expect(refreshed).toEqual(['agent:delete', 'tool:write']);
  });

  it('resolves inherited project custom-role permissions through parentRoleId', async () => {
    const permissionResolution = await loadPermissionResolutionModule();
    const { RoleDefinition } = await import('@agent-platform/database/models');

    await RoleDefinition.create({
      _id: 'project-parent-role',
      tenantId: 'tenant-project-inherited',
      name: 'Project Parent',
      permissions: ['tool:write', 'invalid:permission'],
      createdBy: 'admin-user',
    });
    await RoleDefinition.create({
      _id: 'project-child-role',
      tenantId: 'tenant-project-inherited',
      name: 'Project Child',
      permissions: ['agent:read'],
      parentRoleId: 'project-parent-role',
      createdBy: 'admin-user',
    });

    const permissions = await permissionResolution.resolveProjectCustomRolePermissions(
      'tenant-project-inherited',
      'project-child-role',
    );

    expect(permissions).toEqual(['agent:read', 'tool:write']);
  });

  it('evicts the least recently used entry when the cache reaches max size', async () => {
    const permissionResolution = await loadPermissionResolutionModule({ maxEntries: 3 });

    await permissionResolution.resolveEffectivePermissions('tenant-lru', 'user-1', 'MEMBER');
    await permissionResolution.resolveEffectivePermissions('tenant-lru', 'user-2', 'MEMBER');
    await permissionResolution.resolveEffectivePermissions('tenant-lru', 'user-3', 'MEMBER');

    await permissionResolution.resolveEffectivePermissions('tenant-lru', 'user-1', 'MEMBER');
    await permissionResolution.resolveEffectivePermissions('tenant-lru', 'user-4', 'MEMBER');

    const evictedUserPermissions = await permissionResolution.resolveEffectivePermissions(
      'tenant-lru',
      'user-2',
      'OWNER',
    );
    expect(evictedUserPermissions).toContain('*:*');

    const retainedUserPermissions = await permissionResolution.resolveEffectivePermissions(
      'tenant-lru',
      'user-1',
      'OWNER',
    );
    expect(retainedUserPermissions).not.toContain('*:*');
  });

  it('sweeps expired entries on later cache activity before evicting fresh ones', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const permissionResolution = await loadPermissionResolutionModule({
      maxEntries: 2,
      ttlMs: 10,
      sweepIntervalMs: 5,
    });

    await permissionResolution.resolveEffectivePermissions('tenant-sweep', 'user-1', 'MEMBER');
    vi.advanceTimersByTime(1);
    await permissionResolution.resolveEffectivePermissions('tenant-sweep', 'user-2', 'MEMBER');

    vi.advanceTimersByTime(8);
    await permissionResolution.resolveEffectivePermissions('tenant-sweep', 'user-1', 'MEMBER');

    vi.advanceTimersByTime(2);
    await permissionResolution.resolveEffectivePermissions('tenant-sweep', 'user-3', 'MEMBER');

    const stillCachedFreshPermissions = await permissionResolution.resolveEffectivePermissions(
      'tenant-sweep',
      'user-2',
      'OWNER',
    );
    expect(stillCachedFreshPermissions).not.toContain('*:*');
  });
});
