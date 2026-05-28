/**
 * Module Dependency Cache Tests
 *
 * Validates: TTL caching, eviction, and concurrent access
 * for ProjectModuleDependency.find() results.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the cache module in isolation — no platform mocks needed.
// The cache uses dynamic import of @agent-platform/database/models internally,
// so we provide a minimal stub via the factory function pattern.

describe('module-dependency-cache', () => {
  let loadModuleDependencies: typeof import('../module-dependency-cache.js').loadModuleDependencies;
  let resetModuleDependencyCache: typeof import('../module-dependency-cache.js').resetModuleDependencyCache;

  const fakeDeps = [
    { _id: 'dep1', alias: 'payments', moduleProjectId: 'mod1', resolvedReleaseId: 'rel1' },
    { _id: 'dep2', alias: 'crm', moduleProjectId: 'mod2', resolvedReleaseId: 'rel2' },
  ];

  const mockFind = vi.fn();
  const mockLean = vi.fn();

  beforeEach(async () => {
    vi.useFakeTimers();
    // Reset module between tests to clear the internal cache Map
    vi.resetModules();

    mockFind.mockReset();
    mockLean.mockReset();
    mockFind.mockReturnValue({ lean: mockLean });
    mockLean.mockResolvedValue(fakeDeps);

    // Mock the database models import
    vi.doMock('@agent-platform/database/models', () => ({
      ProjectModuleDependency: {
        find: mockFind,
      },
    }));

    const mod = await import('../module-dependency-cache.js');
    loadModuleDependencies = mod.loadModuleDependencies;
    resetModuleDependencyCache = mod.resetModuleDependencyCache;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should return results from database on first call', async () => {
    const result = await loadModuleDependencies('proj1', 'tenant1');

    expect(result).toEqual(fakeDeps);
    expect(mockFind).toHaveBeenCalledWith({ projectId: 'proj1', tenantId: 'tenant1' });
    expect(mockFind).toHaveBeenCalledTimes(1);
  });

  it('should cache results and return cached data on second call within TTL', async () => {
    const result1 = await loadModuleDependencies('proj1', 'tenant1');
    const result2 = await loadModuleDependencies('proj1', 'tenant1');

    expect(result1).toEqual(fakeDeps);
    expect(result2).toEqual(fakeDeps);
    // DB should only be queried once
    expect(mockFind).toHaveBeenCalledTimes(1);
  });

  it('should refetch after TTL expires (5 seconds)', async () => {
    await loadModuleDependencies('proj1', 'tenant1');
    expect(mockFind).toHaveBeenCalledTimes(1);

    // Advance past TTL
    vi.advanceTimersByTime(5001);

    const updatedDeps = [{ _id: 'dep3', alias: 'billing' }];
    mockLean.mockResolvedValue(updatedDeps);

    const result = await loadModuleDependencies('proj1', 'tenant1');
    expect(result).toEqual(updatedDeps);
    expect(mockFind).toHaveBeenCalledTimes(2);
  });

  it('should cache different projects independently', async () => {
    const depsA = [{ _id: 'depA' }];
    const depsB = [{ _id: 'depB' }];

    mockLean.mockResolvedValueOnce(depsA).mockResolvedValueOnce(depsB);

    const resultA = await loadModuleDependencies('projA', 'tenant1');
    const resultB = await loadModuleDependencies('projB', 'tenant1');

    expect(resultA).toEqual(depsA);
    expect(resultB).toEqual(depsB);
    expect(mockFind).toHaveBeenCalledTimes(2);

    // Second calls should be cached
    const resultA2 = await loadModuleDependencies('projA', 'tenant1');
    const resultB2 = await loadModuleDependencies('projB', 'tenant1');
    expect(resultA2).toEqual(depsA);
    expect(resultB2).toEqual(depsB);
    expect(mockFind).toHaveBeenCalledTimes(2); // No additional calls
  });

  it('should evict oldest entry when cache exceeds MAX_ENTRIES', async () => {
    // Fill cache to max (100 entries)
    for (let i = 0; i < 100; i++) {
      mockLean.mockResolvedValueOnce([{ _id: `dep-${i}` }]);
      await loadModuleDependencies(`proj-${i}`, 'tenant1');
      // Small time advance to differentiate timestamps
      vi.advanceTimersByTime(1);
    }
    expect(mockFind).toHaveBeenCalledTimes(100);

    // Adding one more should evict the oldest (proj-0)
    mockLean.mockResolvedValueOnce([{ _id: 'dep-new' }]);
    await loadModuleDependencies('proj-new', 'tenant1');
    expect(mockFind).toHaveBeenCalledTimes(101);

    // proj-0 should have been evicted, so next call should query DB
    mockLean.mockResolvedValueOnce([{ _id: 'dep-0-refetched' }]);
    const result = await loadModuleDependencies('proj-0', 'tenant1');
    expect(result).toEqual([{ _id: 'dep-0-refetched' }]);
    expect(mockFind).toHaveBeenCalledTimes(102);
  });

  it('should reset all cache entries', async () => {
    await loadModuleDependencies('proj1', 'tenant1');
    await loadModuleDependencies('proj2', 'tenant1');
    expect(mockFind).toHaveBeenCalledTimes(2);

    resetModuleDependencyCache();

    mockLean.mockResolvedValueOnce([{ _id: 'new1' }]).mockResolvedValueOnce([{ _id: 'new2' }]);

    await loadModuleDependencies('proj1', 'tenant1');
    await loadModuleDependencies('proj2', 'tenant1');
    expect(mockFind).toHaveBeenCalledTimes(4);
  });
});
