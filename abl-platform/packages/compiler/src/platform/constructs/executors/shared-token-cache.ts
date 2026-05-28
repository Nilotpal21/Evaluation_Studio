/**
 * Shared Token Cache
 *
 * Pluggable OAuth token cache interface with in-memory and Redis backends.
 * For multi-pod deployments, use createTokenCache() which reads
 * TOKEN_CACHE_BACKEND env var to select Redis or in-memory.
 */

import { createLogger } from '../../logger.js';

const log = createLogger('shared-token-cache');

/** Maximum cached OAuth tokens for in-memory implementation. */
const MAX_CACHE_SIZE = 1000;

const REDIS_KEY_PREFIX = 'oauth_token:';

export interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

export interface TokenCache {
  get(key: string): Promise<TokenCacheEntry | undefined>;
  set(key: string, value: TokenCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Minimal Redis client interface for token caching.
 * Uses positional args for ioredis compatibility (the runtime uses ioredis).
 */
export interface TokenCacheRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
  ping?(): Promise<string>;
}

/** In-memory implementation (bounded to MAX_CACHE_SIZE with LRU eviction) */
export class InMemoryTokenCache implements TokenCache {
  private cache = new Map<string, TokenCacheEntry>();

  async get(key: string): Promise<TokenCacheEntry | undefined> {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU: move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  async set(key: string, value: TokenCacheEntry): Promise<void> {
    if (this.cache.size >= MAX_CACHE_SIZE && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }
}

/**
 * Redis-backed token cache for multi-pod deployments.
 * Stores tokens as JSON with TTL matching token expiry.
 * Gracefully handles Redis errors — logs warnings, never throws.
 */
export class RedisTokenCache implements TokenCache {
  constructor(private redis: TokenCacheRedisClient) {}

  async get(key: string): Promise<TokenCacheEntry | undefined> {
    try {
      const raw = await this.redis.get(`${REDIS_KEY_PREFIX}${key}`);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.token !== 'string' || typeof parsed?.expiresAt !== 'number') {
        log.warn('Invalid token cache entry in Redis, treating as miss', { key });
        return undefined;
      }
      const entry = parsed as TokenCacheEntry;
      if (entry.expiresAt <= Date.now()) {
        await this.redis.del(`${REDIS_KEY_PREFIX}${key}`).catch(() => {});
        return undefined;
      }
      return entry;
    } catch (error) {
      log.warn('Redis token cache get failed, treating as miss', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return undefined;
    }
  }

  async set(key: string, value: TokenCacheEntry): Promise<void> {
    try {
      const ttlSeconds = Math.ceil((value.expiresAt - Date.now()) / 1000);
      if (ttlSeconds <= 0) return; // already expired
      await this.redis.set(`${REDIS_KEY_PREFIX}${key}`, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      log.warn('Redis token cache set failed', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(`${REDIS_KEY_PREFIX}${key}`);
    } catch (error) {
      log.warn('Redis token cache delete failed', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

/**
 * Create a TokenCache based on configuration.
 * Reads TOKEN_CACHE_BACKEND env var: 'redis' | 'memory' (default: 'memory').
 * Falls back to in-memory if Redis client is not provided or ping fails.
 */
export async function createTokenCache(config?: {
  redisClient?: TokenCacheRedisClient;
}): Promise<TokenCache> {
  const backend = process.env.TOKEN_CACHE_BACKEND?.toLowerCase();

  if (backend === 'redis' && config?.redisClient) {
    try {
      if (config.redisClient.ping) {
        await config.redisClient.ping();
      }
      log.info('Token cache using Redis backend');
      return new RedisTokenCache(config.redisClient);
    } catch (error) {
      log.warn('Redis ping failed, falling back to in-memory token cache', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  if (backend === 'redis' && !config?.redisClient) {
    log.warn('TOKEN_CACHE_BACKEND=redis but no Redis client provided, using in-memory');
  } else if (backend && backend !== 'memory' && backend !== 'redis') {
    log.warn(`Unknown TOKEN_CACHE_BACKEND value "${backend}", falling back to in-memory`);
  }

  log.info('Token cache using in-memory backend');
  return new InMemoryTokenCache();
}
