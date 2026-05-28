/**
 * Cache provider implementations for query results.
 *
 * Two implementations:
 * - RedisCacheProvider: Production (uses existing Redis client)
 * - MemoryCacheProvider: Tests (in-memory Map with TTL)
 */

import type { ICacheProvider } from '../interfaces/event-query.js';

/**
 * Redis cache provider - production.
 */
export class RedisCacheProvider implements ICacheProvider {
  constructor(
    private redis: {
      get: (key: string) => Promise<string | null>;
      set: (key: string, value: string, ex: number) => Promise<void>;
      del: (key: string) => Promise<void>;
    },
  ) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

/**
 * Memory cache provider - tests.
 */
export class MemoryCacheProvider implements ICacheProvider {
  private cache = new Map<string, { value: string; expiresAt: number }>();
  private readonly maxSize: number;

  constructor(config?: { maxSize?: number }) {
    this.maxSize = config?.maxSize ?? 1000;

    // Periodic cleanup of expired entries (every 60s)
    setInterval(() => this.cleanup(), 60_000).unref?.();
  }

  async get(key: string): Promise<string | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check expiry
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    // Evict oldest entry if at max size
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async del(key: string): Promise<void> {
    this.cache.delete(key);
  }

  /**
   * Test helper: clear all cache entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Test helper: get cache size.
   */
  size(): number {
    return this.cache.size;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}
