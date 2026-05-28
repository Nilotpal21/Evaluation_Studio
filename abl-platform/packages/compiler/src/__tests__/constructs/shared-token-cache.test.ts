/**
 * Shared Token Cache Tests
 *
 * Tests InMemoryTokenCache, RedisTokenCache, and createTokenCache factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  InMemoryTokenCache,
  RedisTokenCache,
  createTokenCache,
} from '../../platform/constructs/executors/shared-token-cache.js';
import type { TokenCacheRedisClient } from '../../platform/constructs/executors/shared-token-cache.js';

function createMockRedisClient(overrides?: Partial<TokenCacheRedisClient>): TokenCacheRedisClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    ping: vi.fn().mockResolvedValue('PONG'),
    ...overrides,
  };
}

describe('InMemoryTokenCache', () => {
  let cache: InMemoryTokenCache;

  beforeEach(() => {
    cache = new InMemoryTokenCache();
  });

  it('should return undefined on cache miss', async () => {
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('should store and retrieve entries', async () => {
    const entry = { token: 'abc', expiresAt: Date.now() + 60_000 };
    await cache.set('key1', entry);
    expect(await cache.get('key1')).toEqual(entry);
  });

  it('should return undefined for expired entries', async () => {
    await cache.set('key1', { token: 'abc', expiresAt: Date.now() - 1000 });
    expect(await cache.get('key1')).toBeUndefined();
  });

  it('should delete entries', async () => {
    await cache.set('key1', { token: 'abc', expiresAt: Date.now() + 60_000 });
    await cache.delete('key1');
    expect(await cache.get('key1')).toBeUndefined();
  });

  it('should evict oldest entry when at capacity', async () => {
    // Fill cache to max (1000)
    for (let i = 0; i < 1000; i++) {
      await cache.set(`key-${i}`, { token: `t-${i}`, expiresAt: Date.now() + 60_000 });
    }
    // Adding one more should evict key-0
    await cache.set('key-new', { token: 'new', expiresAt: Date.now() + 60_000 });
    expect(await cache.get('key-0')).toBeUndefined();
    expect(await cache.get('key-new')).toBeDefined();
  });
});

describe('RedisTokenCache', () => {
  let redis: TokenCacheRedisClient;
  let cache: RedisTokenCache;

  beforeEach(() => {
    redis = createMockRedisClient();
    cache = new RedisTokenCache(redis);
  });

  it('should return undefined on cache miss', async () => {
    expect(await cache.get('missing')).toBeUndefined();
    expect(redis.get).toHaveBeenCalledWith('oauth_token:missing');
  });

  it('should return parsed entry on cache hit', async () => {
    const entry = { token: 'abc', expiresAt: Date.now() + 60_000 };
    (redis.get as any).mockResolvedValue(JSON.stringify(entry));

    const result = await cache.get('key1');
    expect(result).toEqual(entry);
  });

  it('should return undefined for expired cached entry', async () => {
    const entry = { token: 'abc', expiresAt: Date.now() - 1000 };
    (redis.get as any).mockResolvedValue(JSON.stringify(entry));

    expect(await cache.get('key1')).toBeUndefined();
  });

  it('should set entry with correct TTL', async () => {
    const expiresAt = Date.now() + 120_000; // 2 minutes
    await cache.set('key1', { token: 'abc', expiresAt });

    expect(redis.set).toHaveBeenCalledWith(
      'oauth_token:key1',
      expect.any(String),
      'EX',
      expect.any(Number),
    );

    const callArgs = (redis.set as any).mock.calls[0];
    const ttl = callArgs[3]; // positional arg index 3
    expect(ttl).toBeGreaterThan(100);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('should skip Redis set for already-expired entries', async () => {
    await cache.set('key1', { token: 'abc', expiresAt: Date.now() - 1000 });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('should return undefined for malformed JSON in Redis', async () => {
    (redis.get as any).mockResolvedValue('not valid json{{{');
    expect(await cache.get('key1')).toBeUndefined();
  });

  it('should return undefined for valid JSON with unexpected shape', async () => {
    (redis.get as any).mockResolvedValue(JSON.stringify({ foo: 'bar' }));
    expect(await cache.get('key1')).toBeUndefined();
  });

  it('should handle Redis get errors gracefully', async () => {
    (redis.get as any).mockRejectedValue(new Error('Connection refused'));
    expect(await cache.get('key1')).toBeUndefined();
  });

  it('should handle Redis set errors gracefully', async () => {
    (redis.set as any).mockRejectedValue(new Error('Connection refused'));
    await expect(
      cache.set('key1', { token: 'abc', expiresAt: Date.now() + 60_000 }),
    ).resolves.not.toThrow();
  });

  it('should handle Redis del errors gracefully', async () => {
    (redis.del as any).mockRejectedValue(new Error('Connection refused'));
    await expect(cache.delete('key1')).resolves.not.toThrow();
  });
});

describe('createTokenCache', () => {
  const originalEnv = process.env.TOKEN_CACHE_BACKEND;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TOKEN_CACHE_BACKEND;
    } else {
      process.env.TOKEN_CACHE_BACKEND = originalEnv;
    }
  });

  it('should return InMemoryTokenCache by default', async () => {
    delete process.env.TOKEN_CACHE_BACKEND;
    const cache = await createTokenCache();
    expect(cache).toBeInstanceOf(InMemoryTokenCache);
  });

  it('should return InMemoryTokenCache when backend is memory', async () => {
    process.env.TOKEN_CACHE_BACKEND = 'memory';
    const cache = await createTokenCache();
    expect(cache).toBeInstanceOf(InMemoryTokenCache);
  });

  it('should return RedisTokenCache when backend is redis and client provided', async () => {
    process.env.TOKEN_CACHE_BACKEND = 'redis';
    const redis = createMockRedisClient();
    const cache = await createTokenCache({ redisClient: redis });
    expect(cache).toBeInstanceOf(RedisTokenCache);
    expect(redis.ping).toHaveBeenCalled();
  });

  it('should fall back to in-memory when Redis ping fails', async () => {
    process.env.TOKEN_CACHE_BACKEND = 'redis';
    const redis = createMockRedisClient({
      ping: vi.fn().mockRejectedValue(new Error('Connection refused')),
    });
    const cache = await createTokenCache({ redisClient: redis });
    expect(cache).toBeInstanceOf(InMemoryTokenCache);
  });

  it('should fall back to in-memory when no Redis client provided', async () => {
    process.env.TOKEN_CACHE_BACKEND = 'redis';
    const cache = await createTokenCache();
    expect(cache).toBeInstanceOf(InMemoryTokenCache);
  });

  it('should fall back to in-memory for unknown backend value', async () => {
    process.env.TOKEN_CACHE_BACKEND = 'memcached';
    const cache = await createTokenCache();
    expect(cache).toBeInstanceOf(InMemoryTokenCache);
  });
});
