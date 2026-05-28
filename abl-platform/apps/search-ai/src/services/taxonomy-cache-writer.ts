/**
 * Taxonomy Cache Writer
 *
 * Engine-side service that writes taxonomy data to Redis so that
 * search-ai-runtime can read it without a MongoDB connection.
 * Publishes invalidation events via Redis pub/sub so runtime pods
 * can evict their LRU entries.
 *
 * Pattern: same as AliasResolver in search-ai-runtime (fail-open,
 * single ioredis connection, JSON serialization with TTL).
 */

import type { RedisClient } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';
import { getSharedRedisClient } from '../workers/shared.js';
import type { IKnowledgeGraphTaxonomy } from '@agent-platform/database/models';

const logger = createLogger('taxonomy-cache-writer');

// ─── Constants ────────────────────────────────────────────────────────────

export const CACHE_KEY_PREFIX = 'taxonomy:cache';
export const INVALIDATION_CHANNEL = 'taxonomy:invalidate';
export const TTL_SECONDS = 1800; // 30 minutes

// ─── Service ──────────────────────────────────────────────────────────────

export class TaxonomyCacheWriter {
  private client: RedisClient | null;

  constructor(redis?: RedisClient) {
    this.client = redis ?? getSharedRedisClient();

    logger.info('TaxonomyCacheWriter initialized', {
      redisAvailable: this.client !== null,
    });
  }

  /**
   * Write a full taxonomy document to Redis with TTL.
   * Fail-open: errors are logged but never thrown to callers.
   */
  async writeTaxonomy(
    tenantId: string,
    indexId: string,
    taxonomy: IKnowledgeGraphTaxonomy,
  ): Promise<void> {
    if (!this.client) return;
    const key = `${CACHE_KEY_PREFIX}:${tenantId}:${indexId}`;
    try {
      await this.client.set(key, JSON.stringify(taxonomy), 'EX', TTL_SECONDS);
    } catch (error) {
      logger.error('Failed to write taxonomy to Redis cache', {
        tenantId,
        indexId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Delete cached taxonomy and publish an invalidation event so runtime
   * pods evict their LRU entries.
   * Fail-open: errors are logged but never thrown to callers.
   */
  async invalidate(tenantId: string, indexId: string): Promise<void> {
    if (!this.client) return;
    const key = `${CACHE_KEY_PREFIX}:${tenantId}:${indexId}`;
    try {
      await this.client.del(key);
      await this.client.publish(INVALIDATION_CHANNEL, JSON.stringify({ tenantId, indexId }));
    } catch (error) {
      logger.error('Failed to invalidate taxonomy cache', {
        tenantId,
        indexId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Disconnect the Redis client.
   */
  async close(): Promise<void> {
    // Shared client — nothing to close per-writer.
    logger.info('TaxonomyCacheWriter closed');
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _writer: TaxonomyCacheWriter | null = null;

export function getTaxonomyCacheWriter(): TaxonomyCacheWriter {
  if (!_writer) {
    _writer = new TaxonomyCacheWriter();
  }
  return _writer;
}
