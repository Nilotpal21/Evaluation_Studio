/**
 * Redis Client Wrapper
 *
 * Provides a simplified interface for Redis operations
 * Used by permission filter caching, JWKS caching, and query caching.
 */

import { createLogger } from '@abl/compiler/platform';
import { scanKeys, type RedisClient as DualModeRedisClient } from '@agent-platform/redis';

const logger = createLogger('redis-client');

/**
 * Redis Client
 *
 * Wrapper around ioredis for standardized Redis operations.
 * Provides graceful degradation on Redis errors.
 *
 * Holds a `Redis | Cluster` from `@agent-platform/redis` so this wrapper is
 * cluster-aware: SCAN iteration uses the per-master fan-out path automatically
 * when the underlying client is a Cluster instance.
 */
export class RedisClient {
  private redis: DualModeRedisClient | null;

  constructor(redis?: DualModeRedisClient) {
    this.redis = redis ?? null;
  }

  /**
   * Get a value from Redis
   *
   * @param key - Cache key
   * @returns Value or null if not found
   */
  async get(key: string): Promise<string | null> {
    if (!this.redis) {
      return null;
    }

    try {
      return await this.redis.get(key);
    } catch (error) {
      logger.error('Redis GET failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null; // Graceful degradation
    }
  }

  /**
   * Set a value in Redis with TTL
   *
   * @param key - Cache key
   * @param value - Value to store
   * @param ttlSeconds - Time-to-live in seconds
   */
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!this.redis) {
      return;
    }

    try {
      await this.redis.setex(key, ttlSeconds, value);
    } catch (error) {
      logger.error('Redis SET failed', {
        key,
        ttlSeconds,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - caching is optional optimization
    }
  }

  /**
   * Delete one or more keys
   *
   * @param keys - Keys to delete
   * @returns Number of keys deleted
   */
  async del(...keys: string[]): Promise<number> {
    if (!this.redis || keys.length === 0) {
      return 0;
    }

    try {
      if (keys.length === 1) {
        return await this.redis.del(keys[0]!);
      }
      // Delete one key at a time: cluster-safe — multi-key DEL throws CROSSSLOT
      // when keys span different hash slots.
      let deleted = 0;
      for (const key of keys) {
        deleted += await this.redis.del(key);
      }
      return deleted;
    } catch (error) {
      logger.error('Redis DEL failed', {
        keyCount: keys.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Find keys matching a pattern using SCAN (non-blocking, cluster-safe).
   *
   * Delegates to `scanKeys()` from `@agent-platform/redis`, which iterates
   * every master in cluster mode and dedupes keys observed during slot
   * migration. Top-level KEYS would return partial results in cluster mode.
   *
   * @param pattern - Key pattern (e.g., "searchai:*")
   * @returns Array of matching keys
   */
  async scanByPattern(pattern: string): Promise<string[]> {
    if (!this.redis) {
      return [];
    }

    try {
      const allKeys: string[] = [];
      for await (const key of scanKeys(this.redis, pattern, 200)) {
        allKeys.push(key);
      }
      return allKeys;
    } catch (error) {
      logger.error('Redis SCAN failed', {
        pattern,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get and atomically delete a key (GETDEL).
   * Used for one-time-use tokens/state (PKCE, nonces).
   * Returns null if key not found or Redis unavailable.
   */
  async getdel(key: string): Promise<string | null> {
    if (!this.redis) {
      return null;
    }

    try {
      const result = await this.redis.getdel(key);
      return typeof result === 'string' ? result : null;
    } catch (error) {
      logger.error('Redis GETDEL failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Check if Redis is available
   */
  isAvailable(): boolean {
    return this.redis !== null && this.redis.status === 'ready';
  }
}

/**
 * Global Redis client instance (initialized by server.ts)
 */
let globalRedisClient: RedisClient | null = null;

export function setGlobalRedisClient(redis: DualModeRedisClient): void {
  globalRedisClient = new RedisClient(redis);
}

export function getGlobalRedisClient(): RedisClient {
  if (!globalRedisClient) {
    // Return no-op client if Redis not initialized
    logger.warn('Redis client not initialized, using no-op client');
    return new RedisClient();
  }
  return globalRedisClient;
}
