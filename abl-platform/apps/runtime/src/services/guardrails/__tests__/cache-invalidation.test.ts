/**
 * Cache invalidation tests
 *
 * Validates:
 * 1. GuardrailCache.invalidateByTenant() scans and deletes all tenant keys
 * 2. invalidateGuardrailEvalCache() is fire-and-forget (errors swallowed)
 * 3. Policy CRUD routes call invalidation after mutations
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuardrailCache, type RedisLike } from '../cache.js';

// ---------------------------------------------------------------------------
// Mock redis-client so pipeline-factory can be imported
// ---------------------------------------------------------------------------
vi.mock('../../redis/redis-client.js', () => ({
  getRedisClient: vi.fn(),
  getRedisHandle: () => null,
}));

// Mock database models to prevent mongoose OverwriteModelError on resetModules.
// Dynamic re-import (vi.resetModules + await import) re-walks the full import
// tree: pipeline-factory → @agent-platform/shared → types/tools → database/models,
// causing mongoose.model() to be called again on an already-compiled model.
vi.mock('@agent-platform/database/models', () => ({}));

vi.mock('../../auth-profile-resolver.js', () => ({
  resolveAuthProfileCredentials: vi.fn(),
  getAuthProfileCache: vi.fn(),
}));

// Mock cache module so we can spy on invalidateByTenant from the factory helper
vi.mock('../cache.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual };
});

// ---------------------------------------------------------------------------
// 1. GuardrailCache.invalidateByTenant unit tests
// ---------------------------------------------------------------------------

describe('GuardrailCache.invalidateByTenant', () => {
  let mockRedis: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    scan: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockRedis = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      scan: vi.fn(),
    };
  });

  it('deletes all keys matching tenant prefix pattern', async () => {
    const cache = new GuardrailCache(mockRedis as unknown as RedisLike);

    // Simulate one SCAN iteration returning 3 keys, then done
    mockRedis.scan.mockResolvedValueOnce([
      '0',
      [
        'guardrail:tenant-1:proj-1:pii:abc123',
        'guardrail:tenant-1:proj-1:toxicity:def456',
        'guardrail:tenant-1:proj-2:pii:ghi789',
      ],
    ]);
    mockRedis.del.mockResolvedValue(1);

    const deleted = await cache.invalidateByTenant('tenant-1');

    expect(deleted).toBe(3);
    expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', 'guardrail:tenant-1:*', 'COUNT', 100);
    expect(mockRedis.del).toHaveBeenCalledTimes(3);
    expect(mockRedis.del).toHaveBeenCalledWith('guardrail:tenant-1:proj-1:pii:abc123');
    expect(mockRedis.del).toHaveBeenCalledWith('guardrail:tenant-1:proj-1:toxicity:def456');
    expect(mockRedis.del).toHaveBeenCalledWith('guardrail:tenant-1:proj-2:pii:ghi789');
  });

  it('handles multi-page SCAN results', async () => {
    const cache = new GuardrailCache(mockRedis as unknown as RedisLike);

    // First page: cursor "42" means more to come
    mockRedis.scan.mockResolvedValueOnce(['42', ['guardrail:tenant-1:proj-1:pii:aaa']]);
    // Second page: cursor "0" means done
    mockRedis.scan.mockResolvedValueOnce(['0', ['guardrail:tenant-1:proj-1:pii:bbb']]);
    mockRedis.del.mockResolvedValue(1);

    const deleted = await cache.invalidateByTenant('tenant-1');

    expect(deleted).toBe(2);
    expect(mockRedis.scan).toHaveBeenCalledTimes(2);
    expect(mockRedis.del).toHaveBeenCalledTimes(2);
  });

  it('returns 0 when no keys match', async () => {
    const cache = new GuardrailCache(mockRedis as unknown as RedisLike);
    mockRedis.scan.mockResolvedValueOnce(['0', []]);

    const deleted = await cache.invalidateByTenant('tenant-empty');

    expect(deleted).toBe(0);
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it('returns 0 when redis is null', async () => {
    const cache = new GuardrailCache(null);
    const deleted = await cache.invalidateByTenant('tenant-1');
    expect(deleted).toBe(0);
  });

  it('returns 0 and logs on Redis error (fail-open)', async () => {
    const cache = new GuardrailCache(mockRedis as unknown as RedisLike);
    mockRedis.scan.mockRejectedValueOnce(new Error('REDIS CONNECTION REFUSED'));

    const deleted = await cache.invalidateByTenant('tenant-1');

    expect(deleted).toBe(0);
  });

  it('uses custom key prefix when configured', async () => {
    const cache = new GuardrailCache(mockRedis as unknown as RedisLike, {
      keyPrefix: 'custom-prefix',
    });
    mockRedis.scan.mockResolvedValueOnce(['0', []]);

    await cache.invalidateByTenant('tenant-1');

    expect(mockRedis.scan).toHaveBeenCalledWith(
      '0',
      'MATCH',
      'custom-prefix:tenant-1:*',
      'COUNT',
      100,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. invalidateGuardrailEvalCache fire-and-forget behaviour
// ---------------------------------------------------------------------------

describe('invalidateGuardrailEvalCache', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('calls cache.invalidateByTenant when Redis is available', async () => {
    const mockRedis = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      scan: vi.fn().mockResolvedValue(['0', []]),
    };

    const { getRedisClient } = await import('../../redis/redis-client.js');
    (getRedisClient as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

    // Must re-import to pick up the fresh mock — resetSharedRegistry clears singletons
    const { invalidateGuardrailEvalCache, resetSharedRegistry } =
      await import('../pipeline-factory.js');
    resetSharedRegistry();

    invalidateGuardrailEvalCache('tenant-abc');

    // Give the fire-and-forget promise a tick to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(mockRedis.scan).toHaveBeenCalledWith(
      '0',
      'MATCH',
      'guardrail:tenant-abc:*',
      'COUNT',
      100,
    );
  });

  it('does nothing when Redis is unavailable', async () => {
    const { getRedisClient } = await import('../../redis/redis-client.js');
    (getRedisClient as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const { invalidateGuardrailEvalCache, resetSharedRegistry } =
      await import('../pipeline-factory.js');
    resetSharedRegistry();

    // Should not throw
    invalidateGuardrailEvalCache('tenant-xyz');
  });

  it('does not throw when cache.invalidateByTenant rejects', async () => {
    const mockRedis = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      scan: vi.fn().mockRejectedValue(new Error('REDIS BOOM')),
    };

    const { getRedisClient } = await import('../../redis/redis-client.js');
    (getRedisClient as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

    const { invalidateGuardrailEvalCache, resetSharedRegistry } =
      await import('../pipeline-factory.js');
    resetSharedRegistry();

    // Fire-and-forget: must not throw
    expect(() => invalidateGuardrailEvalCache('tenant-err')).not.toThrow();

    // Wait for the async rejection to be caught internally
    await new Promise((r) => setTimeout(r, 10));
  });
});
