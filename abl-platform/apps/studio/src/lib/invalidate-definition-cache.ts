/**
 * Invalidate the Redis-backed pipeline definition cache.
 *
 * Called from Studio API routes after pipeline save/activate/deactivate
 * so the pipeline-engine picks up fresh definitions immediately.
 *
 * Uses the same key prefix as pipeline-engine's definition-cache module.
 * Fail-open: silently skips if Redis is unavailable.
 */
import { scanKeys } from '@agent-platform/redis';
import { getRedisClient, isRedisAvailable } from './redis-client';

export async function invalidateDefinitionCache(): Promise<void> {
  if (!isRedisAvailable()) return;

  const redis = getRedisClient();
  if (!redis) return;

  try {
    // Must match DEFINITION_CACHE_KEY_PREFIX in pipeline-engine/src/pipeline/services/definition-cache.ts
    const pattern = `pipeline-def:*`;
    const keys: string[] = [];
    for await (const k of scanKeys(redis, pattern)) keys.push(k);
    if (keys.length > 0) {
      for (const k of keys) await redis.del(k);
    }
  } catch {
    // Non-fatal: cache entries expire within 60 seconds
  }
}
