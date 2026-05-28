/**
 * Query Cache
 *
 * Redis-backed LRU cache for search query results.
 * Falls back to an in-memory Map when Redis is unavailable.
 */

import type { RedisClient } from '@agent-platform/redis';
import { scanKeys } from '@agent-platform/redis';

// =============================================================================
// QUERY CACHE
// =============================================================================

const CACHE_PREFIX = 'search:cache:';
const DEFAULT_TTL_SECONDS = 300; // 5 minutes
const MAX_MEMORY_ENTRIES = 1000;

export class QueryCache {
  private redisClient: RedisClient | null = null;
  private memoryCache: Map<string, { value: string; expiresAt: number }> = new Map();

  /**
   * Create a QueryCache instance.
   *
   * @param redisClient - Optional Redis client. If not provided, uses in-memory cache.
   */
  constructor(redisClient?: RedisClient) {
    this.redisClient = redisClient ?? null;
  }

  /**
   * Build a tenant-scoped cache key.
   * When tenantId is provided, keys are prefixed to prevent cross-tenant cache collision.
   */
  private buildKey(key: string, tenantId?: string): string {
    return tenantId ? `${CACHE_PREFIX}${tenantId}:${key}` : `${CACHE_PREFIX}${key}`;
  }

  /**
   * Get a cached value by key.
   *
   * @param key - Cache key
   * @param tenantId - Optional tenant ID for cache isolation
   * @returns Parsed JSON value or null if not found/expired
   */
  async get<T>(key: string, tenantId?: string): Promise<T | null> {
    const cacheKey = this.buildKey(key, tenantId);

    if (this.redisClient) {
      try {
        const raw = await this.redisClient.get(cacheKey);
        if (raw) return JSON.parse(raw) as T;
        return null;
      } catch {
        // Redis failure — fall through to memory cache
      }
    }

    // In-memory fallback
    const entry = this.memoryCache.get(cacheKey);
    if (entry) {
      if (Date.now() < entry.expiresAt) {
        return JSON.parse(entry.value) as T;
      }
      this.memoryCache.delete(cacheKey);
    }
    return null;
  }

  /**
   * Set a cached value with TTL.
   *
   * @param key - Cache key
   * @param value - Value to cache (will be JSON-serialized)
   * @param ttlSeconds - Time-to-live in seconds (default: 300)
   * @param tenantId - Optional tenant ID for cache isolation
   */
  async set<T>(
    key: string,
    value: T,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
    tenantId?: string,
  ): Promise<void> {
    const cacheKey = this.buildKey(key, tenantId);
    const serialized = JSON.stringify(value);

    if (this.redisClient) {
      try {
        await this.redisClient.setex(cacheKey, ttlSeconds, serialized);
        return;
      } catch {
        // Redis failure — fall through to memory cache
      }
    }

    // In-memory fallback
    if (this.memoryCache.size >= MAX_MEMORY_ENTRIES) {
      // Evict oldest entry (LRU approximation)
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey) this.memoryCache.delete(firstKey);
    }

    this.memoryCache.set(cacheKey, {
      value: serialized,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  /**
   * Invalidate all cached queries for a given index.
   *
   * @param indexId - The search index ID to invalidate
   * @param tenantId - Optional tenant ID for scoped invalidation
   */
  async invalidate(indexId: string, tenantId?: string): Promise<void> {
    const keyPrefix = tenantId
      ? `${CACHE_PREFIX}${tenantId}:${indexId}`
      : `${CACHE_PREFIX}${indexId}`;
    const pattern = `${keyPrefix}:*`;

    if (this.redisClient) {
      try {
        const keys: string[] = [];
        for await (const k of scanKeys(this.redisClient, pattern)) keys.push(k);
        if (keys.length > 0) {
          // Delete keys individually (cluster-safe — keys may hash to different slots)
          await Promise.all(keys.map((k) => this.redisClient!.del(k)));
        }
      } catch {
        // Redis failure — fall through to memory invalidation
      }
    }

    // In-memory fallback: remove matching keys
    const prefix = `${keyPrefix}:`;
    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(prefix)) {
        this.memoryCache.delete(key);
      }
    }
  }

  /**
   * Clear the entire cache.
   */
  async clear(): Promise<void> {
    if (this.redisClient) {
      try {
        const keys: string[] = [];
        for await (const k of scanKeys(this.redisClient, `${CACHE_PREFIX}*`)) keys.push(k);
        if (keys.length > 0) {
          // Delete keys individually (cluster-safe — keys may hash to different slots)
          await Promise.all(keys.map((k) => this.redisClient!.del(k)));
        }
      } catch {
        // Ignore Redis errors during clear
      }
    }
    this.memoryCache.clear();
  }
}
