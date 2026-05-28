/**
 * Permission Filter Service Tests
 *
 * Tests the query-time permission filtering service:
 * - getAccessibleDocuments with caching
 * - canAccessDocument for single document checks
 * - Cache invalidation (uses SCAN, not KEYS)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionFilterService } from '../services/permission-filter.service.js';
import type { UserIdentity } from '../services/permission-filter.service.js';

// =============================================================================
// Mocks
// =============================================================================

const mockPermissionStore = {
  getFlattenedPermissions: vi.fn(),
};

const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
  // SCAN replaces KEYS for non-blocking cache invalidation
  scan: vi.fn(),
};

// Mock logger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// =============================================================================
// Test Data
// =============================================================================

const testIdentity: UserIdentity = {
  tenantId: 'tenant-123',
  userId: 'user-456',
  email: 'john@example.com',
  groupIds: ['group-1', 'group-2'],
};

const mockFlattenedPermissions = {
  allowedUsers: ['john@example.com'],
  allowedGroups: [],
  allowedDomains: [],
  publicInDomain: false,
  publicEverywhere: false,
  source: 'test',
};

// =============================================================================
// Tests
// =============================================================================

describe('PermissionFilterService', () => {
  let service: PermissionFilterService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PermissionFilterService(mockPermissionStore as any, mockRedis as any);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ─── getAccessibleDocuments ────────────────────────────────────────────

  describe('getAccessibleDocuments', () => {
    test('returns empty documents from MongoDB (design-time no-op)', async () => {
      mockRedis.get.mockResolvedValue(null); // No cache

      const result = await service.getAccessibleDocuments(testIdentity);

      // queryAccessibleDocuments is an intentional no-op — returns []
      // Real filtering happens via OpenSearch 4-clause bool filter at runtime
      expect(result.documentIds).toEqual([]);
      expect(result.totalCount).toBe(0);
      expect(result.isComplete).toBe(true);
      expect(result.cacheHit).toBe(false);

      // Verify result was cached in Redis
      expect(mockRedis.setex).toHaveBeenCalled();
    });

    test('returns cached results when available', async () => {
      const cachedResult = {
        documentIds: ['doc-1', 'doc-2'],
        totalCount: 2,
        isComplete: true,
        cacheHit: false,
      };

      mockRedis.get.mockResolvedValue(JSON.stringify(cachedResult));

      const result = await service.getAccessibleDocuments(testIdentity);

      expect(result.documentIds).toEqual(['doc-1', 'doc-2']);
      expect(result.cacheHit).toBe(true);

      // Verify Redis GET was called
      expect(mockRedis.get).toHaveBeenCalled();
    });

    test('bypasses cache when skipCache is true', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ documentIds: ['cached'] }));

      const result = await service.getAccessibleDocuments(testIdentity, { skipCache: true });

      // Returns [] from the no-op queryAccessibleDocuments
      expect(result.documentIds).toEqual([]);
      expect(result.cacheHit).toBe(false);

      // Verify cache was bypassed — no Redis GET
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    test('respects maxDocuments limit', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.getAccessibleDocuments(testIdentity, {
        maxDocuments: 5000,
      });

      // queryAccessibleDocuments returns [] so isComplete is always true
      expect(result.isComplete).toBe(true);
      expect(result.documentIds).toEqual([]);
    });

    test('works without Redis (no caching)', async () => {
      const serviceWithoutRedis = new PermissionFilterService(mockPermissionStore as any);

      const result = await serviceWithoutRedis.getAccessibleDocuments(testIdentity);

      expect(result.documentIds).toEqual([]);
      expect(result.cacheHit).toBe(false);

      // Verify no Redis calls
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockRedis.setex).not.toHaveBeenCalled();
    });
  });

  // ─── canAccessDocument ─────────────────────────────────────────────────

  describe('canAccessDocument', () => {
    test('returns true when user has direct permission', async () => {
      mockPermissionStore.getFlattenedPermissions.mockResolvedValue(mockFlattenedPermissions);

      const result = await service.canAccessDocument(testIdentity, 'doc-1');

      expect(result).toBe(true);
      expect(mockPermissionStore.getFlattenedPermissions).toHaveBeenCalledWith(
        'tenant-123',
        'doc-1',
      );
    });

    test('returns true when user has group permission', async () => {
      mockPermissionStore.getFlattenedPermissions.mockResolvedValue({
        allowedUsers: [],
        allowedGroups: ['group-1'],
        allowedDomains: [],
        publicInDomain: false,
        publicEverywhere: false,
        source: 'test',
      });

      const result = await service.canAccessDocument(testIdentity, 'doc-1');

      expect(result).toBe(true);
    });

    test('returns true when document is public in domain', async () => {
      mockPermissionStore.getFlattenedPermissions.mockResolvedValue({
        allowedUsers: [],
        allowedGroups: [],
        allowedDomains: [],
        publicInDomain: true,
        publicEverywhere: false,
        source: 'test',
      });

      const result = await service.canAccessDocument(testIdentity, 'doc-1');

      expect(result).toBe(true);
    });

    test('returns true when document is public everywhere', async () => {
      mockPermissionStore.getFlattenedPermissions.mockResolvedValue({
        allowedUsers: [],
        allowedGroups: [],
        allowedDomains: [],
        publicInDomain: false,
        publicEverywhere: true,
        source: 'test',
      });

      const result = await service.canAccessDocument(testIdentity, 'doc-1');

      expect(result).toBe(true);
    });

    test('returns false when user has no permission', async () => {
      mockPermissionStore.getFlattenedPermissions.mockResolvedValue({
        allowedUsers: ['other@example.com'],
        allowedGroups: [],
        allowedDomains: [],
        publicInDomain: false,
        publicEverywhere: false,
        source: 'test',
      });

      const result = await service.canAccessDocument(testIdentity, 'doc-1');

      expect(result).toBe(false);
    });
  });

  // ─── Cache Invalidation ────────────────────────────────────────────────

  describe('invalidateCache', () => {
    test('deletes cache key for user', async () => {
      await service.invalidateCache(testIdentity);

      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining('tenant-123'));
    });

    test('does nothing when Redis is not available', async () => {
      const serviceWithoutRedis = new PermissionFilterService(mockPermissionStore as any);

      await serviceWithoutRedis.invalidateCache(testIdentity);

      // Should not throw, just no-op
      expect(mockRedis.del).not.toHaveBeenCalled();
    });
  });

  describe('invalidateTenantCache', () => {
    test('deletes all cache keys for tenant using SCAN', async () => {
      // First SCAN returns keys, second SCAN returns cursor '0' (done)
      mockRedis.scan.mockResolvedValueOnce([
        '0', // cursor=0 means done
        ['permission-filter:tenant-123:user-1:hash1', 'permission-filter:tenant-123:user-2:hash2'],
      ]);

      await service.invalidateTenantCache('tenant-123');

      // Verify SCAN was called instead of KEYS
      expect(mockRedis.scan).toHaveBeenCalledWith(
        '0',
        'MATCH',
        'permission-filter:tenant-123:*',
        'COUNT',
        200,
      );
      expect(mockRedis.del).toHaveBeenCalledWith('permission-filter:tenant-123:user-1:hash1');
      expect(mockRedis.del).toHaveBeenCalledWith('permission-filter:tenant-123:user-2:hash2');
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
    });

    test('handles empty cache gracefully', async () => {
      // SCAN returns no keys
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      await service.invalidateTenantCache('tenant-123');

      expect(mockRedis.scan).toHaveBeenCalled();
      expect(mockRedis.del).not.toHaveBeenCalled(); // No keys to delete
    });
  });
});
