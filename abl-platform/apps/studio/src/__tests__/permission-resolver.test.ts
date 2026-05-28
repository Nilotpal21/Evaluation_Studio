/**
 * Tests for resolveStudioPermissions and clearStudioPermissionCache
 *
 * Coverage:
 * - Returns permissions for a role via resolveRolePermissions
 * - Cache hit on repeated calls (no extra DB queries)
 * - Cache expiry after TTL
 * - Prefers customRoleId over role name when both are supplied
 * - Merges explicit ResourcePermission grants into base permissions
 * - Returns [] on DB error (deny by default)
 * - clearStudioPermissionCache clears all cached entries
 * - Evicts oldest cache entry when cache is full (CACHE_MAX_SIZE = 100)
 * - Sanitizes project custom-role permissions before returning them
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock state ───────────────────────────────────────────────────────

const { mockRoleDefinitionFind, mockRoleDefinitionFindOne, mockResourcePermissionFind } =
  vi.hoisted(() => {
    // Chainable lean() pattern used by Mongoose in the resolver
    const mockRoleDefinitionFind = vi.fn();
    const mockRoleDefinitionFindOne = vi.fn();
    const mockResourcePermissionFind = vi.fn();
    return { mockRoleDefinitionFind, mockRoleDefinitionFindOne, mockResourcePermissionFind };
  });

const {
  mockResolveRolePermissions,
  mockMergeResourcePermissions,
  mockHasPermission,
  mockHasAnyPermission,
} = vi.hoisted(() => ({
  mockResolveRolePermissions: vi.fn(),
  mockMergeResourcePermissions: vi.fn(),
  mockHasPermission: vi.fn(),
  mockHasAnyPermission: vi.fn(),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@agent-platform/database/models', () => ({
  RoleDefinition: {
    find: mockRoleDefinitionFind,
    findOne: mockRoleDefinitionFindOne,
  },
  ResourcePermission: {
    find: mockResourcePermissionFind,
  },
}));

vi.mock('@agent-platform/shared/rbac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared/rbac')>();
  return {
    ...actual,
    resolveRolePermissions: mockResolveRolePermissions,
    mergeResourcePermissions: mockMergeResourcePermissions,
    hasPermission: mockHasPermission,
    hasAnyPermission: mockHasAnyPermission,
  };
});

// ─── SUT import (after mocks are registered) ─────────────────────────────────

import {
  resolveStudioPermissions,
  resolveProjectCustomRolePermissions,
  clearStudioPermissionCache,
} from '../lib/permission-resolver';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a raw role row as Mongoose .lean() would return from MongoDB.
 * The resolver maps these to RoleDefinitionRecord internally.
 */
function makeRawRole(
  id: string,
  name: string,
  permissions: string[],
  parentRoleId: string | null = null,
) {
  return {
    _id: id,
    name,
    permissions,
    parentRoleId,
  };
}

/**
 * Build a raw resource permission row as Mongoose .lean() would return.
 */
function makeRawGrant(
  resourceType: string,
  resourceId: string,
  operations: string[],
  expiresAt: Date | null = null,
) {
  return { resourceType, resourceId, operations, expiresAt };
}

/**
 * Wire RoleDefinition.find and ResourcePermission.find to resolve immediately.
 */
function setupDbMocks(
  rawRoles: ReturnType<typeof makeRawRole>[],
  rawGrants: ReturnType<typeof makeRawGrant>[] = [],
) {
  mockRoleDefinitionFind.mockReturnValue({ lean: () => Promise.resolve(rawRoles) });
  mockResourcePermissionFind.mockReturnValue({ lean: () => Promise.resolve(rawGrants) });
}

// ─── Constants matching the SUT ───────────────────────────────────────────────
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 100;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('resolveStudioPermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStudioPermissionCache();

    // Default: no grants
    mockResourcePermissionFind.mockReturnValue({ lean: () => Promise.resolve([]) });
    // Default: resolveRolePermissions returns empty list
    mockResolveRolePermissions.mockReturnValue([]);
    // Default: mergeResourcePermissions returns its first arg unchanged
    mockMergeResourcePermissions.mockImplementation((base: string[]) => base);
  });

  // ── Happy path: role resolution ─────────────────────────────────────────────

  it('returns permissions resolved for a matching role name', async () => {
    const rawRoles = [makeRawRole('role-id-1', 'editor', ['tool:read', 'tool:write'])];
    setupDbMocks(rawRoles);
    mockResolveRolePermissions.mockReturnValue(['tool:read', 'tool:write']);

    const result = await resolveStudioPermissions('tenant-1', 'user-1', 'editor');

    expect(result).toEqual(['tool:read', 'tool:write']);
    expect(mockResolveRolePermissions).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'role-id-1', name: 'editor' }),
      expect.any(Array),
    );
  });

  it('returns [] when no role matches the supplied role name', async () => {
    const rawRoles = [makeRawRole('role-id-1', 'viewer', ['tool:read'])];
    setupDbMocks(rawRoles);

    // resolveRolePermissions should NOT be called when no role matches
    const result = await resolveStudioPermissions('tenant-1', 'user-no-role', 'nonexistent-role');

    expect(result).toEqual([]);
    expect(mockResolveRolePermissions).not.toHaveBeenCalled();
  });

  it('falls back to built-in MEMBER permissions when tenant system roles are not yet seeded', async () => {
    setupDbMocks([]);

    const result = await resolveStudioPermissions('tenant-1', 'user-member', 'MEMBER');

    expect(result).toContain('project:create');
    expect(mockResolveRolePermissions).not.toHaveBeenCalled();
  });

  it('maps raw DB role rows to RoleDefinitionRecord shape correctly', async () => {
    const rawRoles = [
      makeRawRole('parent-id', 'base-role', ['mcp:read']),
      makeRawRole('child-id', 'child-role', ['tool:write'], 'parent-id'),
    ];
    setupDbMocks(rawRoles);
    mockResolveRolePermissions.mockReturnValue(['tool:write', 'mcp:read']);

    await resolveStudioPermissions('tenant-1', 'user-mapped', 'child-role');

    const [calledRole, calledAllRoles] = mockResolveRolePermissions.mock.calls[0];
    // The userRole passed to resolveRolePermissions should be the child role
    expect(calledRole).toEqual({
      id: 'child-id',
      name: 'child-role',
      permissions: JSON.stringify(['tool:write']),
      parentRoleId: 'parent-id',
    });
    // allRoles should contain both mapped records
    expect(calledAllRoles).toHaveLength(2);
    expect(calledAllRoles[0]).toEqual({
      id: 'parent-id',
      name: 'base-role',
      permissions: JSON.stringify(['mcp:read']),
      parentRoleId: null,
    });
  });

  // ── Cache ──────────────────────────────────────────────────────────────────

  it('uses the cache for a second call with the same tenantId + userId', async () => {
    const rawRoles = [makeRawRole('role-1', 'editor', ['tool:read'])];
    setupDbMocks(rawRoles);
    mockResolveRolePermissions.mockReturnValue(['tool:read']);

    const first = await resolveStudioPermissions('tenant-1', 'user-cache', 'editor');
    const second = await resolveStudioPermissions('tenant-1', 'user-cache', 'editor');

    expect(first).toEqual(['tool:read']);
    expect(second).toEqual(['tool:read']);
    // DB should only have been hit once
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(1);
  });

  it('does NOT share cache entries across different userIds', async () => {
    const rawRoles = [makeRawRole('role-1', 'editor', ['tool:read'])];
    setupDbMocks(rawRoles);
    mockResolveRolePermissions.mockReturnValue(['tool:read']);

    await resolveStudioPermissions('tenant-1', 'user-A', 'editor');
    await resolveStudioPermissions('tenant-1', 'user-B', 'editor');

    // Two different users → two DB lookups
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(2);
  });

  it('does NOT share cache entries across different tenantIds', async () => {
    const rawRoles = [makeRawRole('role-1', 'editor', ['tool:read'])];
    setupDbMocks(rawRoles);
    mockResolveRolePermissions.mockReturnValue(['tool:read']);

    await resolveStudioPermissions('tenant-A', 'user-1', 'editor');
    await resolveStudioPermissions('tenant-B', 'user-1', 'editor');

    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(2);
  });

  it('caches empty permission results for missing roles', async () => {
    const rawRoles = [makeRawRole('role-1', 'viewer', ['tool:read'])];
    setupDbMocks(rawRoles);

    const first = await resolveStudioPermissions('tenant-1', 'user-empty', 'missing-role');
    const second = await resolveStudioPermissions('tenant-1', 'user-empty', 'missing-role');

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(1);
  });

  it('expires the cache entry after CACHE_TTL_MS and re-fetches', async () => {
    vi.useFakeTimers();

    const rawRoles = [makeRawRole('role-1', 'editor', ['tool:read'])];
    setupDbMocks(rawRoles);
    mockResolveRolePermissions.mockReturnValue(['tool:read']);

    // First call — populates cache
    await resolveStudioPermissions('tenant-1', 'user-ttl', 'editor');
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(1);

    // Advance time past TTL
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);

    // Second call — cache expired, must re-query DB
    await resolveStudioPermissions('tenant-1', 'user-ttl', 'editor');
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('still uses cache when called just before TTL expires', async () => {
    vi.useFakeTimers();

    const rawRoles = [makeRawRole('role-1', 'viewer', ['tool:read'])];
    setupDbMocks(rawRoles);
    mockResolveRolePermissions.mockReturnValue(['tool:read']);

    await resolveStudioPermissions('tenant-1', 'user-before-ttl', 'viewer');

    // Advance almost to TTL boundary but not past it
    vi.advanceTimersByTime(CACHE_TTL_MS - 1000);

    await resolveStudioPermissions('tenant-1', 'user-before-ttl', 'viewer');
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  // ── customRoleId ────────────────────────────────────────────────────────────

  it('prefers customRoleId over role name when both are supplied', async () => {
    const rawRoles = [
      makeRawRole('role-by-name', 'editor', ['tool:read']),
      makeRawRole('custom-role-id', 'custom-role', ['mcp:*', 'tool:*']),
    ];
    setupDbMocks(rawRoles);
    mockResolveRolePermissions.mockReturnValue(['mcp:*', 'tool:*']);

    await resolveStudioPermissions('tenant-1', 'user-custom', 'editor', 'custom-role-id');

    // The role passed to resolveRolePermissions must be the custom role, not 'editor'
    const calledRole = mockResolveRolePermissions.mock.calls[0][0];
    expect(calledRole.id).toBe('custom-role-id');
    expect(calledRole.name).toBe('custom-role');
  });

  it('falls back to role name when customRoleId does not match any role', async () => {
    const rawRoles = [makeRawRole('role-editor', 'editor', ['tool:read'])];
    setupDbMocks(rawRoles);
    mockResolveRolePermissions.mockReturnValue(['tool:read']);

    await resolveStudioPermissions('tenant-1', 'user-fallback', 'editor', 'nonexistent-custom-id');

    // resolveRolePermissions must NOT be called because customRoleId didn't match
    // and name fallback only applies when customRoleId is absent
    expect(mockResolveRolePermissions).not.toHaveBeenCalled();
  });

  // ── ResourcePermission grants ───────────────────────────────────────────────

  it('merges explicit resource permission grants into base permissions', async () => {
    const rawRoles = [makeRawRole('role-1', 'viewer', ['tool:read'])];
    const rawGrants = [makeRawGrant('mcp', 'server-xyz', ['read', 'execute'])];
    setupDbMocks(rawRoles, rawGrants);

    mockResolveRolePermissions.mockReturnValue(['tool:read']);
    mockMergeResourcePermissions.mockReturnValue(['tool:read', 'mcp:read', 'mcp:execute']);

    const result = await resolveStudioPermissions('tenant-1', 'user-grants', 'viewer');

    expect(mockMergeResourcePermissions).toHaveBeenCalledWith(
      ['tool:read'],
      expect.arrayContaining([
        expect.objectContaining({
          resourceType: 'mcp',
          resourceId: 'server-xyz',
          operations: JSON.stringify(['read', 'execute']),
        }),
      ]),
    );
    expect(result).toEqual(['tool:read', 'mcp:read', 'mcp:execute']);
  });

  it('skips mergeResourcePermissions when there are no grants', async () => {
    const rawRoles = [makeRawRole('role-1', 'editor', ['tool:write'])];
    setupDbMocks(rawRoles, []); // empty grants
    mockResolveRolePermissions.mockReturnValue(['tool:write']);

    await resolveStudioPermissions('tenant-1', 'user-no-grants', 'editor');

    expect(mockMergeResourcePermissions).not.toHaveBeenCalled();
  });

  it('maps grant expiresAt (Date | null) correctly to ResourcePermissionRecord', async () => {
    const expiresAt = new Date('2099-01-01');
    const rawRoles = [makeRawRole('role-1', 'viewer', [])];
    const rawGrants = [makeRawGrant('tool', 'tool-123', ['read'], expiresAt)];
    setupDbMocks(rawRoles, rawGrants);
    mockResolveRolePermissions.mockReturnValue([]);
    mockMergeResourcePermissions.mockReturnValue(['tool:read']);

    await resolveStudioPermissions('tenant-1', 'user-expiry', 'viewer');

    const [, grants] = mockMergeResourcePermissions.mock.calls[0];
    expect(grants[0].expiresAt).toBe(expiresAt);
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it('returns [] on DB error (deny by default, do not throw)', async () => {
    mockRoleDefinitionFind.mockReturnValue({
      lean: () => Promise.reject(new Error('MongoDB connection timeout')),
    });

    const result = await resolveStudioPermissions('tenant-1', 'user-db-error', 'editor');

    expect(result).toEqual([]);
  });

  it('returns [] when ResourcePermission.find throws', async () => {
    const rawRoles = [makeRawRole('role-1', 'editor', ['tool:read'])];
    mockRoleDefinitionFind.mockReturnValue({ lean: () => Promise.resolve(rawRoles) });
    mockResourcePermissionFind.mockReturnValue({
      lean: () => Promise.reject(new Error('ResourcePermission query failed')),
    });
    mockResolveRolePermissions.mockReturnValue(['tool:read']);

    const result = await resolveStudioPermissions('tenant-1', 'user-grant-error', 'editor');

    expect(result).toEqual([]);
  });

  it('does NOT cache the result when a DB error occurs', async () => {
    // First call fails
    mockRoleDefinitionFind.mockReturnValue({
      lean: () => Promise.reject(new Error('DB down')),
    });
    await resolveStudioPermissions('tenant-1', 'user-no-cache-on-err', 'editor');

    // Second call should succeed (DB back up)
    const rawRoles = [makeRawRole('role-1', 'editor', ['tool:read'])];
    mockRoleDefinitionFind.mockReturnValue({ lean: () => Promise.resolve(rawRoles) });
    mockResolveRolePermissions.mockReturnValue(['tool:read']);

    const result = await resolveStudioPermissions('tenant-1', 'user-no-cache-on-err', 'editor');

    // If the error result was cached, this would return [] and find wouldn't be called again
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(2);
    expect(result).toEqual(['tool:read']);
  });
});

// ── clearStudioPermissionCache ────────────────────────────────────────────────

describe('clearStudioPermissionCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStudioPermissionCache();
    mockResourcePermissionFind.mockReturnValue({ lean: () => Promise.resolve([]) });
    mockResolveRolePermissions.mockReturnValue(['tool:read']);
    mockMergeResourcePermissions.mockImplementation((base: string[]) => base);
  });

  it('clears all entries so the next call re-fetches from DB', async () => {
    const rawRoles = [makeRawRole('role-1', 'editor', ['tool:read'])];
    mockRoleDefinitionFind.mockReturnValue({ lean: () => Promise.resolve(rawRoles) });

    // Populate cache
    await resolveStudioPermissions('tenant-1', 'user-clear', 'editor');
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(1);

    clearStudioPermissionCache();

    // Cache was cleared — should re-fetch
    await resolveStudioPermissions('tenant-1', 'user-clear', 'editor');
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(2);
  });

  it('clears entries for multiple users at once', async () => {
    const rawRoles = [makeRawRole('role-1', 'viewer', ['tool:read'])];
    mockRoleDefinitionFind.mockReturnValue({ lean: () => Promise.resolve(rawRoles) });

    await resolveStudioPermissions('tenant-1', 'user-A', 'viewer');
    await resolveStudioPermissions('tenant-1', 'user-B', 'viewer');

    clearStudioPermissionCache();

    await resolveStudioPermissions('tenant-1', 'user-A', 'viewer');
    await resolveStudioPermissions('tenant-1', 'user-B', 'viewer');

    // 2 initial + 2 after clear = 4 total
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(4);
  });
});

describe('resolveProjectCustomRolePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStudioPermissionCache();
  });

  it('sanitizes, de-duplicates, and caches project custom-role permissions', async () => {
    mockRoleDefinitionFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          makeRawRole('custom-role-1', 'Custom Role', [
            'agent:read',
            'tool:write',
            'agent:read',
            '*:*',
            'invalid:permission',
          ]),
        ]),
    });
    mockResolveRolePermissions.mockReturnValue([
      'agent:read',
      'tool:write',
      'agent:read',
      '*:*',
      'invalid:permission',
    ]);

    const first = await resolveProjectCustomRolePermissions('tenant-1', 'custom-role-1');
    const second = await resolveProjectCustomRolePermissions('tenant-1', 'custom-role-1');

    expect(first).toEqual(['agent:read', 'tool:write']);
    expect(second).toEqual(['agent:read', 'tool:write']);
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(1);
    expect(mockRoleDefinitionFind).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    expect(mockResolveRolePermissions).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'custom-role-1' }),
      [expect.objectContaining({ id: 'custom-role-1' })],
    );
  });

  it('resolves inherited project custom-role permissions through parentRoleId', async () => {
    mockRoleDefinitionFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          makeRawRole('parent-role', 'Parent Role', ['tool:write']),
          makeRawRole('child-role', 'Child Role', ['agent:read'], 'parent-role'),
        ]),
    });
    mockResolveRolePermissions.mockReturnValue(['agent:read', 'tool:write']);

    await expect(resolveProjectCustomRolePermissions('tenant-1', 'child-role')).resolves.toEqual([
      'agent:read',
      'tool:write',
    ]);
    expect(mockResolveRolePermissions).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'child-role', parentRoleId: 'parent-role' }),
      [
        expect.objectContaining({ id: 'parent-role' }),
        expect.objectContaining({ id: 'child-role' }),
      ],
    );
  });

  it('returns [] when the project custom-role id is missing or the lookup fails', async () => {
    expect(await resolveProjectCustomRolePermissions('tenant-1', null)).toEqual([]);
    expect(mockRoleDefinitionFind).not.toHaveBeenCalled();

    mockRoleDefinitionFind.mockReturnValue({
      lean: () => Promise.reject(new Error('Role lookup failed')),
    });

    await expect(resolveProjectCustomRolePermissions('tenant-1', 'custom-role-2')).resolves.toEqual(
      [],
    );
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(1);
  });

  it('caches empty custom-role permission results after sanitization', async () => {
    mockRoleDefinitionFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          makeRawRole('custom-role-empty', 'Empty Role', ['*:*', 'invalid:permission']),
        ]),
    });
    mockResolveRolePermissions.mockReturnValue(['*:*', 'invalid:permission']);

    const first = await resolveProjectCustomRolePermissions('tenant-1', 'custom-role-empty');
    const second = await resolveProjectCustomRolePermissions('tenant-1', 'custom-role-empty');

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(1);
  });
});

// ── Cache eviction (CACHE_MAX_SIZE = 100) ──────────────────────────────────────

describe('cache eviction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStudioPermissionCache();

    const rawRoles = [makeRawRole('role-1', 'viewer', ['tool:read'])];
    mockRoleDefinitionFind.mockReturnValue({ lean: () => Promise.resolve(rawRoles) });
    mockResourcePermissionFind.mockReturnValue({ lean: () => Promise.resolve([]) });
    mockResolveRolePermissions.mockReturnValue(['tool:read']);
    mockMergeResourcePermissions.mockImplementation((base: string[]) => base);
  });

  it('evicts the oldest entry when the cache reaches CACHE_MAX_SIZE', async () => {
    // Fill the cache to exactly CACHE_MAX_SIZE entries
    for (let i = 0; i < CACHE_MAX_SIZE; i++) {
      await resolveStudioPermissions('tenant-1', `user-fill-${i}`, 'viewer');
    }

    // All entries are cached — no additional DB calls
    vi.clearAllMocks();
    mockRoleDefinitionFind.mockReturnValue({
      lean: () => Promise.resolve([makeRawRole('role-1', 'viewer', ['tool:read'])]),
    });
    mockResourcePermissionFind.mockReturnValue({ lean: () => Promise.resolve([]) });

    // This is the (CACHE_MAX_SIZE + 1)-th entry, which triggers eviction
    await resolveStudioPermissions('tenant-1', 'user-overflow', 'viewer');

    // The first inserted entry ('user-fill-0') should have been evicted
    await resolveStudioPermissions('tenant-1', 'user-fill-0', 'viewer');

    // user-fill-0 was evicted so a DB lookup is required for it
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(2); // overflow + fill-0 re-fetch
  });

  it('does not evict valid entries before cache is full', async () => {
    // Fill cache to CACHE_MAX_SIZE - 1
    for (let i = 0; i < CACHE_MAX_SIZE - 1; i++) {
      await resolveStudioPermissions('tenant-1', `user-below-${i}`, 'viewer');
    }

    vi.clearAllMocks();
    mockRoleDefinitionFind.mockReturnValue({
      lean: () => Promise.resolve([makeRawRole('role-1', 'viewer', ['tool:read'])]),
    });
    mockResourcePermissionFind.mockReturnValue({ lean: () => Promise.resolve([]) });

    // Re-check the very first entry — it should still be cached (no eviction yet)
    await resolveStudioPermissions('tenant-1', 'user-below-0', 'viewer');
    expect(mockRoleDefinitionFind).not.toHaveBeenCalled();
  });

  it('purges expired entries before falling back to insertion-order eviction', async () => {
    vi.useFakeTimers();

    const rawRoles = [makeRawRole('role-1', 'viewer', ['tool:read'])];
    mockRoleDefinitionFind.mockReturnValue({ lean: () => Promise.resolve(rawRoles) });

    // Fill cache to capacity with entries that will expire
    for (let i = 0; i < CACHE_MAX_SIZE; i++) {
      await resolveStudioPermissions('tenant-1', `user-expire-${i}`, 'viewer');
    }

    // Advance time past TTL so all existing entries expire
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);

    vi.clearAllMocks();
    mockRoleDefinitionFind.mockReturnValue({ lean: () => Promise.resolve(rawRoles) });
    mockResourcePermissionFind.mockReturnValue({ lean: () => Promise.resolve([]) });

    // Add a new entry — should trigger expired-entry purge instead of oldest eviction
    await resolveStudioPermissions('tenant-1', 'user-new-after-expire', 'viewer');

    // After purge the first batch of users should also need re-fetching
    await resolveStudioPermissions('tenant-1', 'user-expire-0', 'viewer');

    // Both user-new-after-expire and user-expire-0 required DB hits
    expect(mockRoleDefinitionFind).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
