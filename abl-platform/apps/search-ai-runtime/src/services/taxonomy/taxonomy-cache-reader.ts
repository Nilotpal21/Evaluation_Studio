/**
 * Taxonomy Cache Reader
 *
 * Runtime-side service that reads taxonomy from Redis (written by the
 * engine-side TaxonomyCacheWriter) with an in-process LRU cache.
 * Listens to Redis pub/sub invalidation events so stale LRU entries
 * are evicted when taxonomy is updated.
 *
 * Pattern: mirrors AliasResolver in this package (LRU + Redis pub/sub,
 * separate subscriber/client connections, fail-open).
 */

import { LRUCache } from 'lru-cache';
import { createLogger } from '@abl/compiler/platform';
import {
  createRedisConnection,
  createSubscriber,
  resolveRedisOptionsFromEnv,
  type RedisClient,
  type RedisConnectionHandle,
} from '@agent-platform/redis';
import type { IKnowledgeGraphTaxonomy } from '@agent-platform/database/models';

const logger = createLogger('taxonomy-cache-reader');

// ─── Constants ────────────────────────────────────────────────────────────

const CACHE_KEY_PREFIX = 'taxonomy:cache';
const INVALIDATION_CHANNEL = 'taxonomy:invalidate';

// ─── Service ──────────────────────────────────────────────────────────────

export class TaxonomyCacheReader {
  private cache: LRUCache<string, IKnowledgeGraphTaxonomy>;
  private subscriber: RedisClient | null = null;
  private handle: RedisConnectionHandle | null = null;

  constructor() {
    this.cache = new LRUCache<string, IKnowledgeGraphTaxonomy>({
      max: 200,
      ttl: 1000 * 60 * 5, // 5 minutes
    });

    this.initRedis();
    logger.info('TaxonomyCacheReader initialized');
  }

  /**
   * Get taxonomy for an index. Checks LRU first, then Redis.
   * Returns null on cache miss (caller should fall back to MongoDB or skip).
   * Fail-open: Redis errors return null, never throw.
   */
  async getTaxonomy(tenantId: string, indexId: string): Promise<IKnowledgeGraphTaxonomy | null> {
    const lruKey = `${tenantId}:${indexId}`;

    // Check LRU
    const cached = this.cache.get(lruKey);
    if (cached) return cached;

    // Check Redis
    try {
      if (!this.handle) return null;

      const redisKey = `${CACHE_KEY_PREFIX}:${tenantId}:${indexId}`;
      const raw = await this.handle.client.get(redisKey);
      if (!raw) return null;

      const taxonomy = JSON.parse(raw) as IKnowledgeGraphTaxonomy;
      this.cache.set(lruKey, taxonomy);
      return taxonomy;
    } catch (error) {
      logger.error('Failed to read taxonomy from Redis cache', {
        tenantId,
        indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get cache metrics for monitoring.
   */
  getCacheMetrics(): { size: number } {
    return { size: this.cache.size };
  }

  /**
   * Cleanup Redis connections on shutdown.
   */
  async close(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(INVALIDATION_CHANNEL);
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    if (this.handle) {
      await this.handle.disconnect();
      this.handle = null;
    }
    logger.info('TaxonomyCacheReader closed');
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private initRedis(): void {
    try {
      const opts = resolveRedisOptionsFromEnv() ?? {};
      this.handle = createRedisConnection(opts);
      this.subscriber = createSubscriber(this.handle);

      this.subscriber.on('error', (err: Error) => {
        logger.warn('Taxonomy subscriber Redis error (non-fatal)', { error: err.message });
      });
      this.subscriber.subscribe(INVALIDATION_CHANNEL, (err: Error | null | undefined) => {
        if (err) {
          logger.error('Failed to subscribe to taxonomy invalidation channel', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      this.subscriber.on('message', (channel: string, message: string) => {
        if (channel === INVALIDATION_CHANNEL) {
          try {
            const { tenantId, indexId } = JSON.parse(message);
            this.cache.delete(`${tenantId}:${indexId}`);
          } catch (error) {
            logger.error('Failed to parse taxonomy invalidation message', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });
    } catch (error) {
      logger.error('Failed to initialize Redis pub/sub for taxonomy cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _reader: TaxonomyCacheReader | null = null;

export function getTaxonomyCacheReader(): TaxonomyCacheReader {
  if (!_reader) {
    _reader = new TaxonomyCacheReader();
  }
  return _reader;
}
