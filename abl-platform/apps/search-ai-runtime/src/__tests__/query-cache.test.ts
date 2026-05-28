/**
 * Query Cache Unit Tests
 *
 * Tests for QueryCache:
 * - Redis-backed cache operations (get, set, invalidate, clear)
 * - In-memory fallback when Redis is unavailable
 * - TTL expiration behavior
 * - LRU eviction when memory cache is full
 * - Redis error fallback to memory cache
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Active mock-redis ref for scanKeys delegation. Each createMockRedis() updates this.
let scanKeysClientRef: { keys: ReturnType<typeof vi.fn> } | null = null;

// Stub `scanKeys` so it yields whatever the active mock-redis `.keys()` returns —
// production code uses `for await (const k of scanKeys(client, pattern))`.
vi.mock('@agent-platform/redis', () => ({
  scanKeys: async function* (_client: unknown, pattern: string): AsyncIterable<string> {
    if (!scanKeysClientRef) return;
    const keys: string[] = await scanKeysClientRef.keys(pattern);
    for (const k of keys) yield k;
  },
}));

import { QueryCache } from '../services/query/query-cache.js';

// =============================================================================
// HELPERS
// =============================================================================

function createMockRedis(overrides?: Record<string, any>) {
  const mock = {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue('OK'),
    keys: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as any;
  scanKeysClientRef = mock;
  return mock;
}

// =============================================================================
// IN-MEMORY CACHE TESTS (no Redis)
// =============================================================================

describe('QueryCache — in-memory (no Redis)', () => {
  let cache: QueryCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new QueryCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── Basic Get/Set ────────────────────────────────────────────────────────

  describe('basic get/set', () => {
    test('returns null for non-existent key', async () => {
      const result = await cache.get('non-existent');
      expect(result).toBeNull();
    });

    test('stores and retrieves a string value', async () => {
      await cache.set('key1', 'hello world');
      const result = await cache.get<string>('key1');
      expect(result).toBe('hello world');
    });

    test('stores and retrieves a numeric value', async () => {
      await cache.set('num', 42);
      const result = await cache.get<number>('num');
      expect(result).toBe(42);
    });

    test('stores and retrieves a boolean value', async () => {
      await cache.set('flag', true);
      const result = await cache.get<boolean>('flag');
      expect(result).toBe(true);
    });

    test('stores and retrieves an object value', async () => {
      const obj = { results: [{ id: 1, score: 0.95 }], total: 1 };
      await cache.set('obj', obj);
      const result = await cache.get<typeof obj>('obj');
      expect(result).toEqual(obj);
    });

    test('stores and retrieves an array value', async () => {
      const arr = [1, 2, 3, 4, 5];
      await cache.set('arr', arr);
      const result = await cache.get<number[]>('arr');
      expect(result).toEqual(arr);
    });

    test('stores and retrieves a null value', async () => {
      await cache.set('null-val', null);
      const result = await cache.get('null-val');
      expect(result).toBeNull();
    });

    test('overwrites existing value with same key', async () => {
      await cache.set('key', 'first');
      await cache.set('key', 'second');
      const result = await cache.get<string>('key');
      expect(result).toBe('second');
    });

    test('stores nested objects correctly', async () => {
      const nested = { a: { b: { c: 'deep' } }, arr: [{ x: 1 }] };
      await cache.set('nested', nested);
      const result = await cache.get<typeof nested>('nested');
      expect(result).toEqual(nested);
    });
  });

  // ─── TTL Expiration ───────────────────────────────────────────────────────

  describe('TTL expiration', () => {
    test('returns value before TTL expires', async () => {
      await cache.set('key', 'value', 60);
      vi.advanceTimersByTime(59_000);
      const result = await cache.get<string>('key');
      expect(result).toBe('value');
    });

    test('returns null after TTL expires', async () => {
      await cache.set('key', 'value', 60);
      vi.advanceTimersByTime(61_000);
      const result = await cache.get<string>('key');
      expect(result).toBeNull();
    });

    test('uses default TTL of 300 seconds when not specified', async () => {
      await cache.set('key', 'value');
      vi.advanceTimersByTime(299_000);
      expect(await cache.get<string>('key')).toBe('value');

      vi.advanceTimersByTime(2_000);
      expect(await cache.get<string>('key')).toBeNull();
    });

    test('different keys can have different TTLs', async () => {
      await cache.set('short', 'a', 10);
      await cache.set('long', 'b', 600);

      vi.advanceTimersByTime(11_000);
      expect(await cache.get<string>('short')).toBeNull();
      expect(await cache.get<string>('long')).toBe('b');
    });

    test('expired entry is removed from cache on access', async () => {
      await cache.set('key', 'value', 5);
      vi.advanceTimersByTime(6_000);
      const result = await cache.get<string>('key');
      expect(result).toBeNull();

      // Set a new value for the same key — should work without issues
      await cache.set('key', 'new-value', 60);
      expect(await cache.get<string>('key')).toBe('new-value');
    });

    test('TTL of 1 second works correctly', async () => {
      await cache.set('key', 'value', 1);
      expect(await cache.get<string>('key')).toBe('value');

      vi.advanceTimersByTime(1_100);
      expect(await cache.get<string>('key')).toBeNull();
    });
  });

  // ─── LRU Eviction ────────────────────────────────────────────────────────

  describe('LRU eviction', () => {
    test('evicts oldest entry when max size (1000) is reached', async () => {
      // Fill the cache to the limit
      for (let i = 0; i < 1000; i++) {
        await cache.set(`key-${i}`, `value-${i}`);
      }

      // Key 0 should still exist at this point
      expect(await cache.get<string>('key-0')).toBe('value-0');

      // Adding one more should evict key-0 (the oldest)
      await cache.set('key-1000', 'value-1000');
      expect(await cache.get<string>('key-0')).toBeNull();

      // Key-1 should still exist
      expect(await cache.get<string>('key-1')).toBe('value-1');

      // The new entry should exist
      expect(await cache.get<string>('key-1000')).toBe('value-1000');
    });

    test('evicts entries one at a time', async () => {
      for (let i = 0; i < 1000; i++) {
        await cache.set(`key-${i}`, `value-${i}`);
      }

      // Add 3 more — should evict keys 0, 1, 2
      await cache.set('new-1', 'val');
      await cache.set('new-2', 'val');
      await cache.set('new-3', 'val');

      expect(await cache.get<string>('key-0')).toBeNull();
      expect(await cache.get<string>('key-1')).toBeNull();
      expect(await cache.get<string>('key-2')).toBeNull();
      expect(await cache.get<string>('key-3')).toBe('value-3');
    });
  });

  // ─── Invalidate ───────────────────────────────────────────────────────────

  describe('invalidate', () => {
    test('removes entries matching indexId prefix', async () => {
      await cache.set('idx-1:query-1', 'result-1');
      await cache.set('idx-1:query-2', 'result-2');
      await cache.set('idx-2:query-1', 'result-3');

      await cache.invalidate('idx-1');

      expect(await cache.get<string>('idx-1:query-1')).toBeNull();
      expect(await cache.get<string>('idx-1:query-2')).toBeNull();
      expect(await cache.get<string>('idx-2:query-1')).toBe('result-3');
    });

    test('does nothing when no entries match', async () => {
      await cache.set('idx-1:query-1', 'result-1');
      await cache.invalidate('idx-nonexistent');
      expect(await cache.get<string>('idx-1:query-1')).toBe('result-1');
    });

    test('handles empty cache gracefully', async () => {
      await cache.invalidate('idx-1');
      // No error should be thrown
    });
  });

  // ─── Clear ────────────────────────────────────────────────────────────────

  describe('clear', () => {
    test('removes all entries from memory cache', async () => {
      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');
      await cache.set('key3', 'value3');

      await cache.clear();

      expect(await cache.get<string>('key1')).toBeNull();
      expect(await cache.get<string>('key2')).toBeNull();
      expect(await cache.get<string>('key3')).toBeNull();
    });

    test('allows new entries after clear', async () => {
      await cache.set('key1', 'value1');
      await cache.clear();
      await cache.set('key1', 'new-value');
      expect(await cache.get<string>('key1')).toBe('new-value');
    });

    test('handles empty cache gracefully', async () => {
      await cache.clear();
      // No error should be thrown
    });
  });

  // ─── Key Namespacing ──────────────────────────────────────────────────────

  describe('key namespacing', () => {
    test('different keys do not collide', async () => {
      await cache.set('a', 'alpha');
      await cache.set('ab', 'alpha-beta');
      await cache.set('abc', 'alpha-beta-charlie');

      expect(await cache.get<string>('a')).toBe('alpha');
      expect(await cache.get<string>('ab')).toBe('alpha-beta');
      expect(await cache.get<string>('abc')).toBe('alpha-beta-charlie');
    });

    test('keys with special characters work', async () => {
      await cache.set('key:with:colons', 'v1');
      await cache.set('key/with/slashes', 'v2');
      await cache.set('key with spaces', 'v3');

      expect(await cache.get<string>('key:with:colons')).toBe('v1');
      expect(await cache.get<string>('key/with/slashes')).toBe('v2');
      expect(await cache.get<string>('key with spaces')).toBe('v3');
    });
  });
});

// =============================================================================
// REDIS-BACKED CACHE TESTS
// =============================================================================

describe('QueryCache — Redis-backed', () => {
  let cache: QueryCache;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    cache = new QueryCache(mockRedis);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── Get ──────────────────────────────────────────────────────────────────

  describe('get', () => {
    test('returns parsed value from Redis', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ id: 1, name: 'test' }));

      const result = await cache.get<{ id: number; name: string }>('my-key');
      expect(result).toEqual({ id: 1, name: 'test' });
      expect(mockRedis.get).toHaveBeenCalledWith('search:cache:my-key');
    });

    test('returns null when Redis key does not exist', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await cache.get('missing');
      expect(result).toBeNull();
    });

    test('returns string value from Redis', async () => {
      mockRedis.get.mockResolvedValue('"hello"');
      const result = await cache.get<string>('key');
      expect(result).toBe('hello');
    });

    test('returns numeric value from Redis', async () => {
      mockRedis.get.mockResolvedValue('42');
      const result = await cache.get<number>('key');
      expect(result).toBe(42);
    });

    test('falls back to memory cache when Redis get throws', async () => {
      mockRedis.get.mockRejectedValue(new Error('Connection refused'));

      // Should fall back to memory cache which has nothing
      const result = await cache.get('key');
      expect(result).toBeNull();
    });
  });

  // ─── Set ──────────────────────────────────────────────────────────────────

  describe('set', () => {
    test('calls Redis setex with correct parameters', async () => {
      await cache.set('my-key', { data: 'test' }, 120);

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'search:cache:my-key',
        120,
        JSON.stringify({ data: 'test' }),
      );
    });

    test('uses default TTL of 300 seconds', async () => {
      await cache.set('key', 'value');

      expect(mockRedis.setex).toHaveBeenCalledWith('search:cache:key', 300, '"value"');
    });

    test('falls back to memory cache when Redis setex throws', async () => {
      mockRedis.setex.mockRejectedValue(new Error('Redis down'));
      // Also make get fall through to memory
      mockRedis.get.mockRejectedValue(new Error('Redis down'));

      await cache.set('key', 'value', 60);
      const result = await cache.get<string>('key');
      expect(result).toBe('value');
    });
  });

  // ─── Invalidate ───────────────────────────────────────────────────────────

  describe('invalidate', () => {
    test('deletes Redis keys matching pattern', async () => {
      mockRedis.keys.mockResolvedValue([
        'search:cache:idx-1:query-1',
        'search:cache:idx-1:query-2',
      ]);

      await cache.invalidate('idx-1');

      expect(mockRedis.keys).toHaveBeenCalledWith('search:cache:idx-1:*');
      // Per-key del (cluster-safe — each key in its own call)
      expect(mockRedis.del).toHaveBeenCalledWith('search:cache:idx-1:query-1');
      expect(mockRedis.del).toHaveBeenCalledWith('search:cache:idx-1:query-2');
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
    });

    test('skips Redis del when no keys match', async () => {
      mockRedis.keys.mockResolvedValue([]);

      await cache.invalidate('idx-nonexistent');
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    test('falls back to memory invalidation when Redis keys throws', async () => {
      mockRedis.keys.mockRejectedValue(new Error('Redis error'));
      mockRedis.setex.mockRejectedValue(new Error('Redis error'));
      mockRedis.get.mockRejectedValue(new Error('Redis error'));

      // Pre-populate memory cache
      await cache.set('idx-1:q1', 'val');
      await cache.set('idx-1:q2', 'val');
      await cache.set('idx-2:q1', 'val');

      await cache.invalidate('idx-1');

      expect(await cache.get<string>('idx-1:q1')).toBeNull();
      expect(await cache.get<string>('idx-1:q2')).toBeNull();
      expect(await cache.get<string>('idx-2:q1')).toBe('val');
    });

    test('also clears memory cache entries during invalidation', async () => {
      mockRedis.keys.mockResolvedValue([]);
      mockRedis.setex.mockRejectedValue(new Error('Redis down'));
      mockRedis.get.mockRejectedValue(new Error('Redis down'));

      // These will fall through to memory cache
      await cache.set('idx-1:q1', 'val');

      await cache.invalidate('idx-1');

      const result = await cache.get<string>('idx-1:q1');
      expect(result).toBeNull();
    });
  });

  // ─── Clear ────────────────────────────────────────────────────────────────

  describe('clear', () => {
    test('clears Redis keys and memory cache', async () => {
      mockRedis.keys.mockResolvedValue(['search:cache:a', 'search:cache:b']);

      await cache.clear();

      expect(mockRedis.keys).toHaveBeenCalledWith('search:cache:*');
      // Per-key del (cluster-safe — each key in its own call)
      expect(mockRedis.del).toHaveBeenCalledWith('search:cache:a');
      expect(mockRedis.del).toHaveBeenCalledWith('search:cache:b');
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
    });

    test('skips del when no Redis keys found', async () => {
      mockRedis.keys.mockResolvedValue([]);
      await cache.clear();
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    test('handles Redis error during clear gracefully', async () => {
      mockRedis.keys.mockRejectedValue(new Error('Redis error'));

      // Should not throw
      await cache.clear();
    });

    test('clears memory cache even when Redis clear fails', async () => {
      mockRedis.keys.mockRejectedValue(new Error('Redis error'));
      mockRedis.setex.mockRejectedValue(new Error('Redis error'));
      mockRedis.get.mockRejectedValue(new Error('Redis error'));

      // Pre-populate memory cache
      await cache.set('key', 'value');

      await cache.clear();

      const result = await cache.get<string>('key');
      expect(result).toBeNull();
    });
  });

  // ─── Redis Error Fallback ─────────────────────────────────────────────────

  describe('Redis error fallback', () => {
    test('get falls back to memory cache on Redis error', async () => {
      // First, set a value successfully in Redis
      await cache.set('key', 'redis-value');

      // Then make Redis fail
      mockRedis.get.mockRejectedValue(new Error('Connection lost'));

      // Memory cache does not have the value because Redis set succeeded
      const result = await cache.get<string>('key');
      expect(result).toBeNull();
    });

    test('set stores in memory when Redis fails, get retrieves from memory when Redis fails', async () => {
      // Both set and get will fail on Redis
      mockRedis.setex.mockRejectedValue(new Error('Connection lost'));
      mockRedis.get.mockRejectedValue(new Error('Connection lost'));

      await cache.set('key', 'memory-value', 60);
      const result = await cache.get<string>('key');
      expect(result).toBe('memory-value');
    });

    test('memory cache respects TTL after Redis fallback', async () => {
      mockRedis.setex.mockRejectedValue(new Error('Redis down'));
      mockRedis.get.mockRejectedValue(new Error('Redis down'));

      await cache.set('key', 'value', 10);

      vi.advanceTimersByTime(9_000);
      expect(await cache.get<string>('key')).toBe('value');

      vi.advanceTimersByTime(2_000);
      expect(await cache.get<string>('key')).toBeNull();
    });

    test('memory cache eviction works after Redis fallback', async () => {
      mockRedis.setex.mockRejectedValue(new Error('Redis down'));
      mockRedis.get.mockRejectedValue(new Error('Redis down'));

      // Fill the memory cache past MAX_MEMORY_ENTRIES
      for (let i = 0; i < 1001; i++) {
        await cache.set(`key-${i}`, `value-${i}`);
      }

      // The first entry should have been evicted
      expect(await cache.get<string>('key-0')).toBeNull();
      expect(await cache.get<string>('key-1000')).toBe('value-1000');
    });
  });
});

// =============================================================================
// EDGE CASES & INTEGRATION
// =============================================================================

describe('QueryCache — edge cases', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('empty string key works', async () => {
    const cache = new QueryCache();
    await cache.set('', 'value');
    expect(await cache.get<string>('')).toBe('value');
  });

  test('empty string value works', async () => {
    const cache = new QueryCache();
    await cache.set('key', '');
    expect(await cache.get<string>('key')).toBe('');
  });

  test('very long key works', async () => {
    const cache = new QueryCache();
    const longKey = 'a'.repeat(10000);
    await cache.set(longKey, 'value');
    expect(await cache.get<string>(longKey)).toBe('value');
  });

  test('large value works', async () => {
    const cache = new QueryCache();
    const largeValue = { data: 'x'.repeat(100000) };
    await cache.set('key', largeValue);
    expect(await cache.get<typeof largeValue>('key')).toEqual(largeValue);
  });

  test('concurrent get/set operations work correctly', async () => {
    const cache = new QueryCache();
    const ops = Array.from({ length: 50 }, (_, i) => cache.set(`key-${i}`, `value-${i}`));
    await Promise.all(ops);

    const reads = Array.from({ length: 50 }, (_, i) => cache.get<string>(`key-${i}`));
    const results = await Promise.all(reads);

    for (let i = 0; i < 50; i++) {
      expect(results[i]).toBe(`value-${i}`);
    }
  });

  test('invalidate on empty key prefix clears cache entries that have empty prefix', async () => {
    const cache = new QueryCache();
    await cache.set(':query1', 'val1');
    await cache.set('other:query', 'val2');
    await cache.invalidate('');
    // The key ":query1" starts with "" so should be invalidated
    expect(await cache.get<string>(':query1')).toBeNull();
  });

  test('zero TTL causes immediate expiration', async () => {
    const cache = new QueryCache();
    await cache.set('key', 'value', 0);
    // With 0 TTL, expiresAt = Date.now() + 0, so Date.now() >= expiresAt immediately
    // However, with exact timing it might just pass depending on implementation
    vi.advanceTimersByTime(1);
    expect(await cache.get<string>('key')).toBeNull();
  });

  test('Redis constructor parameter is optional', () => {
    const cache1 = new QueryCache();
    const cache2 = new QueryCache(undefined);
    expect(cache1).toBeDefined();
    expect(cache2).toBeDefined();
  });

  test('multiple invalidate calls are idempotent', async () => {
    const cache = new QueryCache();
    await cache.set('idx-1:q1', 'val');
    await cache.invalidate('idx-1');
    await cache.invalidate('idx-1');
    await cache.invalidate('idx-1');
    expect(await cache.get<string>('idx-1:q1')).toBeNull();
  });

  test('multiple clear calls are idempotent', async () => {
    const cache = new QueryCache();
    await cache.set('key', 'value');
    await cache.clear();
    await cache.clear();
    await cache.clear();
    expect(await cache.get<string>('key')).toBeNull();
  });
});
