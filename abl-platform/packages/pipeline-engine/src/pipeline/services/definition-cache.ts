/**
 * DefinitionCache — Redis-backed cache for pipeline definitions.
 *
 * Used by PipelineTrigger to avoid querying MongoDB on every Kafka event.
 * Fail-open: cache misses and Redis errors fall back to direct MongoDB query.
 *
 * Key format:  pipeline-def:{kafkaTopic}
 * TTL:         60 seconds
 *
 * Invalidation:
 *   - Studio calls invalidateDefinitionCache() on pipeline save/activate/deactivate
 *   - Pipeline-engine clears on startup
 *   - Any service with a Redis client can invalidate using the exported key prefix
 */
import { createLogger } from '@abl/compiler/platform';
import { scanKeys, type RedisClient } from '@agent-platform/redis';

const log = createLogger('definition-cache');

/** Key prefix shared across services — import this to build consistent keys. */
export const DEFINITION_CACHE_KEY_PREFIX = 'pipeline-def';

const CACHE_TTL_SECONDS = 60;

/** Re-exported for backwards compatibility with prior `RedisLike` consumers. */
export type RedisLike = RedisClient;

// Module-level client, set via init()
let _redis: RedisLike | null = null;

/**
 * Initialize the definition cache with a Redis client.
 * Call once during server startup (e.g., in server.ts).
 */
export function initDefinitionCache(client: RedisLike | null): void {
  _redis = client;
}

/**
 * Get cached pipeline definitions for a Kafka topic.
 * Returns null on cache miss or if Redis is unavailable — caller must query MongoDB.
 */
export async function getCachedDefinitions<T>(kafkaTopic: string): Promise<T[] | null> {
  if (!_redis) return null;

  const key = `${DEFINITION_CACHE_KEY_PREFIX}:${kafkaTopic}`;
  try {
    const cached = await _redis.get(key);
    if (!cached) return null;
    return JSON.parse(cached) as T[];
  } catch (err) {
    log.warn('Definition cache get failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Store pipeline definitions in cache for a Kafka topic.
 */
export async function setCachedDefinitions<T>(kafkaTopic: string, definitions: T[]): Promise<void> {
  if (!_redis) return;

  const key = `${DEFINITION_CACHE_KEY_PREFIX}:${kafkaTopic}`;
  try {
    await _redis.set(key, JSON.stringify(definitions), 'EX', CACHE_TTL_SECONDS);
  } catch (err) {
    log.warn('Definition cache set failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Invalidate all cached pipeline definitions.
 *
 * Accepts an optional Redis client override — allows Studio (or any service)
 * to invalidate using its own connection without calling initDefinitionCache().
 */
export async function invalidateDefinitionCache(redis?: RedisLike): Promise<void> {
  const client = redis ?? _redis;
  if (!client) return;

  const pattern = `${DEFINITION_CACHE_KEY_PREFIX}:*`;
  try {
    const keys: string[] = [];
    for await (const k of scanKeys(client, pattern)) keys.push(k);
    if (keys.length > 0) {
      for (const k of keys) await client.del(k);
      log.debug('Definition cache invalidated', { keysRemoved: keys.length });
    }
  } catch (err) {
    log.warn('Definition cache invalidation failed', {
      pattern,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
