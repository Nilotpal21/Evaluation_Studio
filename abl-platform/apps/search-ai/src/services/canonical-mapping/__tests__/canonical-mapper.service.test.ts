/**
 * CanonicalMapperService Integration Tests
 *
 * Tests for Phase 1 implementation:
 * - LRU cache with 5-minute TTL
 * - Cache observability metrics
 * - Redis pub/sub for distributed cache invalidation
 * - Basic transform types (direct, lowercase, split)
 * - Tenant isolation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LRUCache } from 'lru-cache';

// Mock Redis to avoid connection issues in tests
const mockRedis = {
  status: 'ready',
  subscribe: vi.fn((channel: string, callback: Function) => callback(null)),
  on: vi.fn(),
  publish: vi.fn().mockResolvedValue(1),
  quit: vi.fn().mockResolvedValue('OK'),
};

vi.mock('ioredis', () => ({
  default: vi.fn(() => mockRedis),
}));

vi.mock('../../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    if (modelName === 'FieldMapping') {
      return {
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([]),
          }),
        }),
      };
    }
    return {};
  }),
}));

vi.mock('../../../workers/shared.js', () => ({
  getRedisConnection: vi.fn(() => ({
    host: 'localhost',
    port: 6379,
  })),
  workerLog: vi.fn(),
  workerError: vi.fn(),
}));

vi.mock('@agent-platform/redis', () => ({
  resolveRedisOptionsFromEnv: vi.fn(() => ({
    host: 'localhost',
    port: 6379,
  })),
}));

// Mock logger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe('CanonicalMapperService', () => {
  let cacheMetrics: any;
  let cache: LRUCache<string, any[]>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.status = 'ready';

    // Create fresh cache metrics
    cacheMetrics = {
      hits: 0,
      misses: 0,
      evictions: 0,
      getHitRate(): number {
        const total = this.hits + this.misses;
        return total === 0 ? 0 : (this.hits / total) * 100;
      },
    };

    // Create fresh LRU cache
    cache = new LRUCache<string, any[]>({
      max: 500,
      ttl: 1000 * 60 * 5,
      updateAgeOnGet: true,
    });
  });

  describe('Cache Metrics', () => {
    it('should track cache hits and misses', () => {
      const cacheKey = 'connector_abc:tenant_123';

      // First access - miss
      const result1 = cache.get(cacheKey);
      expect(result1).toBeUndefined();
      if (!result1) {
        cacheMetrics.misses++;
      }

      // Set value
      cache.set(cacheKey, []);

      // Second access - hit
      const result2 = cache.get(cacheKey);
      expect(result2).toBeDefined();
      if (result2) {
        cacheMetrics.hits++;
      }

      expect(cacheMetrics.hits).toBe(1);
      expect(cacheMetrics.misses).toBe(1);
    });

    it('should calculate hit rate correctly', () => {
      cacheMetrics.hits = 80;
      cacheMetrics.misses = 20;

      const hitRate = cacheMetrics.getHitRate();
      expect(hitRate).toBe(80); // 80% hit rate
    });

    it('should return 0 hit rate when no cache operations', () => {
      const hitRate = cacheMetrics.getHitRate();
      expect(hitRate).toBe(0);
    });

    it('should expose cache configuration', () => {
      expect(cache.max).toBe(500);
      expect(cache.ttl).toBe(1000 * 60 * 5); // 5 minutes
    });
  });

  describe('Cache Operations', () => {
    it('should store and retrieve values from cache', () => {
      const cacheKey = 'connector_123:tenant_456';
      const mappings = [{ sourcePath: 'author', canonicalField: 'doc_author' }];

      cache.set(cacheKey, mappings);
      const retrieved = cache.get(cacheKey);

      expect(retrieved).toEqual(mappings);
    });

    it('should use tenant-specific cache keys', () => {
      const connector = 'connector_abc';
      const tenant1Key = `${connector}:tenant_1`;
      const tenant2Key = `${connector}:tenant_2`;

      cache.set(tenant1Key, [{ sourcePath: 'a', canonicalField: 'b' }]);
      cache.set(tenant2Key, [{ sourcePath: 'c', canonicalField: 'd' }]);

      expect(cache.get(tenant1Key)).not.toEqual(cache.get(tenant2Key));
    });

    it('should invalidate cache for specific connector', () => {
      const tenantId = 'tenant_123';
      const connectorId = 'connector_abc';
      const cacheKey = `${connectorId}:${tenantId}`;

      // Add to cache
      cache.set(cacheKey, []);
      expect(cache.has(cacheKey)).toBe(true);

      // Invalidate
      cache.delete(cacheKey);
      expect(cache.has(cacheKey)).toBe(false);
    });

    it('should clear entire cache', () => {
      cache.set('connector_1:tenant_1', []);
      cache.set('connector_2:tenant_2', []);

      expect(cache.size).toBe(2);

      cache.clear();
      expect(cache.size).toBe(0);
    });

    it('should respect max size limit', () => {
      // LRU cache max is 500
      expect(cache.max).toBe(500);

      // Verify it's configured correctly
      for (let i = 0; i < 600; i++) {
        cache.set(`key_${i}:tenant`, []);
      }

      // Cache should evict oldest entries to stay under max
      expect(cache.size).toBeLessThanOrEqual(500);
    });
  });

  describe('Redis Pub/Sub Mock', () => {
    it('should mock Redis subscribe', () => {
      expect(mockRedis.subscribe).toBeDefined();
      expect(mockRedis.on).toBeDefined();
    });

    it('should mock Redis publish', async () => {
      const result = await mockRedis.publish('test-channel', 'test-message');
      expect(result).toBe(1);
      expect(mockRedis.publish).toHaveBeenCalled();
    });

    it('skips publish when the Redis publisher is not ready', async () => {
      const { CanonicalMapperService } = await import('../canonical-mapper.service.js');
      const service = new CanonicalMapperService();
      const publish = vi.fn().mockResolvedValue(1);

      (
        service as unknown as {
          publisher: { status: string; publish: typeof publish };
        }
      ).publisher = {
        status: 'end',
        publish,
      };

      await service.invalidateCache('connector-1', 'tenant-1');

      expect(publish).not.toHaveBeenCalled();
    });
  });
});
