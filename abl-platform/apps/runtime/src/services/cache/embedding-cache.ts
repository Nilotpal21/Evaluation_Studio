/**
 * Redis-backed embedding cache for tool search.
 *
 * Caches (query, model) -> embedding vector in Redis with a 1-hour TTL.
 * This avoids redundant Azure OpenAI embedding API calls (~500-1500ms per call).
 *
 * Keying: emb:{model}:{sha256_16(query)}
 *
 * Fail-open: all Redis errors are caught and logged. A cache failure
 * results in a cache miss (return null), never a thrown error.
 */

import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import { getRedisClient } from '../redis/redis-client.js';

const log = createLogger('embedding-cache');

const EMBEDDING_CACHE_PREFIX = 'emb:';
const EMBEDDING_CACHE_TTL_S = 3600; // 1 hour

/**
 * Build a cache key from model and query.
 * Uses a truncated SHA-256 hash (16 hex chars = 64 bits) of the
 * lowercased/trimmed query for compact, collision-resistant keys.
 */
function buildKey(query: string, model: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(query.toLowerCase().trim())
    .digest('hex')
    .slice(0, 16);
  return `${EMBEDDING_CACHE_PREFIX}${model}:${hash}`;
}

/**
 * Get a cached embedding vector for a query string.
 * Returns null on cache miss or Redis unavailability.
 */
export async function getCachedEmbedding(query: string, model: string): Promise<number[] | null> {
  try {
    const redis = getRedisClient();
    if (!redis) return null;

    const key = buildKey(query, model);
    const cached = await redis.get(key);
    if (!cached) return null;

    log.debug('Embedding cache hit', { model, queryLength: query.length });
    return JSON.parse(cached);
  } catch (err) {
    log.warn('Embedding cache read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Store an embedding vector in the cache with a 1-hour TTL.
 * Silently fails on Redis errors (graceful degradation).
 */
export async function setCachedEmbedding(
  query: string,
  model: string,
  embedding: number[],
): Promise<void> {
  try {
    const redis = getRedisClient();
    if (!redis) return;

    const key = buildKey(query, model);
    await redis.set(key, JSON.stringify(embedding), 'EX', EMBEDDING_CACHE_TTL_S);
    log.debug('Embedding cached', {
      model,
      queryLength: query.length,
      dimensions: embedding.length,
    });
  } catch (err) {
    log.warn('Embedding cache write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
