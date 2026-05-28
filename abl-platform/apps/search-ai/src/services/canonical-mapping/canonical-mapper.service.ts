/**
 * Canonical Mapper Service
 *
 * Applies three-layer schema architecture:
 * 1. Source Schema Discovery (ConnectorSchema)
 * 2. Canonical Schema Mapping (FieldMapping with transforms)
 * 3. Domain Vocabulary (DomainVocabulary for query resolution)
 *
 * Caching:
 * - LRU cache with max 500 entries, 5-minute TTL
 * - Cache key: `${connectorId}:${tenantId}`
 * - Redis pub/sub for distributed cache invalidation
 *
 * Observability:
 * - Cache hit/miss/eviction metrics
 * - Transform error logging
 */

import { LRUCache } from 'lru-cache';
import type { IFieldMapping, IConnectorSchema } from '@agent-platform/database/models';
import { getLazyModel } from '../../db/index.js';
import { createLogger } from '@abl/compiler/platform';
import type { RedisClient } from '@agent-platform/redis';
import { createSubscriber } from '@agent-platform/redis';
import { getSharedRedisClient, getSharedRedisHandle } from '../../workers/shared.js';

const logger = createLogger('canonical-mapper-service');

const REDIS_PUBLISH_TIMEOUT_MS = 500;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

// ─── Cache Observability Metrics ─────────────────────────────────────────────

export const cacheMetrics = {
  hits: 0,
  misses: 0,
  evictions: 0,
  /**
   * Calculate cache hit rate as a percentage.
   * Returns 0 if no cache operations have occurred.
   */
  getHitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : (this.hits / total) * 100;
  },
};

// ─── Type Definitions ────────────────────────────────────────────────────────

export interface TransformContext {
  sourceMetadata: Record<string, unknown>;
  tenantId: string;
  connectorId: string;
}

export interface MappingResult {
  canonicalMetadata: Record<string, unknown>;
  errors: string[];
}

// ─── Canonical Mapper Service ───────────────────────────────────────────────

export class CanonicalMapperService {
  private cache: LRUCache<string, IFieldMapping[]>;
  private FieldMapping = getLazyModel<IFieldMapping>('FieldMapping');
  private ConnectorSchema = getLazyModel<IConnectorSchema>('ConnectorSchema');
  private subscriber: RedisClient | null = null;
  private publisher: RedisClient | null = null;

  constructor() {
    // LRU cache with max 500 entries, 5-minute TTL
    this.cache = new LRUCache<string, IFieldMapping[]>({
      max: 500,
      ttl: 1000 * 60 * 5, // 5 minutes
      updateAgeOnGet: true,
    });

    // Initialize Redis pub/sub for distributed cache invalidation
    this.initRedis();

    logger.info('CanonicalMapperService initialized', {
      maxCacheSize: 500,
      ttlMs: 1000 * 60 * 5,
      redisPubSubEnabled: this.publisher !== null,
    });
  }

  /**
   * Initialize Redis pub/sub for distributed cache invalidation.
   * Creates subscriber and publisher clients.
   *
   * Gracefully degrades when Redis is unavailable or disabled:
   * - Checks REDIS_ENABLED env var via resolveRedisOptionsFromEnv()
   * - Uses fast-fail connection options (connectTimeout, maxRetries, retryStrategy)
   * - Attaches error handlers to prevent uncaught exceptions
   */
  private initRedis(): void {
    try {
      const handle = getSharedRedisHandle();

      if (!handle) {
        logger.warn('Redis is disabled or unavailable, skipping pub/sub initialization');
        return;
      }

      // Subscriber for receiving invalidation events from other pods
      this.subscriber = createSubscriber(handle);
      this.subscriber.on('error', (err: Error) => {
        logger.warn('Redis subscriber error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      this.subscriber.subscribe('canonical-mapping:invalidate', (err: Error | null | undefined) => {
        if (err) {
          logger.error('Failed to subscribe to canonical-mapping:invalidate', {
            error: err instanceof Error ? err.message : String(err),
          });
        } else {
          logger.info('Subscribed to canonical-mapping:invalidate channel');
        }
      });

      // Handle incoming invalidation messages
      this.subscriber.on('message', (channel: string, message: string) => {
        if (channel === 'canonical-mapping:invalidate') {
          try {
            const { connectorId, tenantId } = JSON.parse(message);
            const cacheKey = `${connectorId}:${tenantId}`;
            this.cache.delete(cacheKey);
            logger.info('Cache invalidated via Redis pub/sub', { connectorId, tenantId });
          } catch (error) {
            logger.error('Failed to parse invalidation message', {
              message,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });

      // Publisher for broadcasting invalidation events to other pods
      this.publisher = getSharedRedisClient();
      if (this.publisher) {
        this.publisher.on('error', (err: Error) => {
          logger.warn('Redis publisher error', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      logger.info('Redis pub/sub initialized for distributed cache invalidation');
    } catch (error) {
      logger.error('Failed to initialize Redis pub/sub', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue without Redis pub/sub - local cache still works
      this.subscriber = null;
      this.publisher = null;
    }
  }

  /**
   * Apply canonical field mappings to source metadata.
   *
   * @param sourceMetadata — raw metadata from source document
   * @param tenantId — tenant ID for isolation
   * @param connectorId — connector that ingested the document (null for direct uploads)
   * @returns mapped canonical metadata with error log
   */
  async applyMapping(
    sourceMetadata: Record<string, unknown> | null,
    tenantId: string,
    connectorId: string | null,
  ): Promise<MappingResult> {
    // Skip if no metadata or no connector
    if (!sourceMetadata || !connectorId) {
      return {
        canonicalMetadata: sourceMetadata || {},
        errors: [],
      };
    }

    // Load field mappings (cached)
    const mappings = await this.getFieldMappings(connectorId, tenantId);

    if (mappings.length === 0) {
      // No mappings configured - pass through
      return {
        canonicalMetadata: { ...sourceMetadata },
        errors: [],
      };
    }

    // Apply transforms
    const canonicalMetadata: Record<string, unknown> = {};
    const errors: string[] = [];

    for (const mapping of mappings) {
      try {
        const value = this.extractSourceValue(sourceMetadata, mapping.sourcePath);
        if (value !== undefined) {
          const transformed = this.applyTransform(value, mapping);
          canonicalMetadata[mapping.canonicalField] = transformed;
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        errors.push(`Field ${mapping.sourcePath} → ${mapping.canonicalField}: ${errMsg}`);
        logger.warn('Transform error', {
          sourcePath: mapping.sourcePath,
          canonicalField: mapping.canonicalField,
          error: errMsg,
        });
      }
    }

    return {
      canonicalMetadata,
      errors,
    };
  }

  /**
   * Get field mappings for a connector (with LRU caching).
   *
   * @param connectorId — connector ID
   * @param tenantId — tenant ID for isolation
   * @returns array of field mappings
   */
  private async getFieldMappings(connectorId: string, tenantId: string): Promise<IFieldMapping[]> {
    const cacheKey = `${connectorId}:${tenantId}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached) {
      cacheMetrics.hits++;
      return cached;
    }

    // Cache miss - load from database
    cacheMetrics.misses++;

    const mappings = await this.FieldMapping.find({
      connectorId,
      tenantId,
      isActive: true,
    })
      .sort({ priority: -1 })
      .lean();

    // Store in cache
    this.cache.set(cacheKey, mappings);

    return mappings;
  }

  /**
   * Extract value from source metadata using dot-notation path.
   *
   * @param sourceMetadata — raw metadata object
   * @param path — dot-notation path (e.g., "metadata.author.name")
   * @returns extracted value or undefined
   */
  private extractSourceValue(sourceMetadata: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: any = sourceMetadata;

    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  /**
   * Apply transform to extracted value.
   *
   * @param value — raw value from source
   * @param mapping — field mapping with transform config
   * @returns transformed value
   */
  private applyTransform(value: unknown, mapping: IFieldMapping): unknown {
    const transformType = mapping.transform.type;
    const transformConfig = mapping.transform;

    switch (transformType) {
      case 'direct':
        return value;

      case 'lowercase':
        return typeof value === 'string' ? value.toLowerCase() : value;

      case 'split':
        if (typeof value === 'string' && transformConfig?.delimiter) {
          return value.split(transformConfig.delimiter).map((s: string) => s.trim());
        }
        return value;

      case 'date_format':
        // TODO: Phase 2 - implement date parsing
        return value;

      case 'rename_value':
        // TODO: Phase 2 - implement value mapping
        return value;

      case 'extract':
        // TODO: Phase 2 - implement regex extraction
        return value;

      case 'coalesce':
        // TODO: Phase 2 - implement fallback chain
        return value;

      case 'compute':
        // TODO: Phase 2 - implement computed fields
        return value;

      default:
        logger.warn('Unknown transform type', { transformType });
        return value;
    }
  }

  /**
   * Invalidate cache for a specific connector.
   *
   * Called when field mappings are updated via API.
   * Publishes invalidation event to Redis for distributed cache clearing.
   *
   * @param connectorId — connector ID
   * @param tenantId — tenant ID for isolation
   */
  async invalidateCache(connectorId: string, tenantId: string): Promise<void> {
    const cacheKey = `${connectorId}:${tenantId}`;

    // Invalidate local cache
    this.cache.delete(cacheKey);

    // Broadcast to other pods via Redis pub/sub
    if (this.publisher) {
      if (this.publisher.status !== 'ready') {
        logger.info('Skipping cache invalidation broadcast because Redis publisher is not ready', {
          connectorId,
          tenantId,
          status: this.publisher.status,
        });
        return;
      }

      try {
        await withTimeout(
          this.publisher.publish(
            'canonical-mapping:invalidate',
            JSON.stringify({ connectorId, tenantId }),
          ),
          REDIS_PUBLISH_TIMEOUT_MS,
          `Timed out publishing cache invalidation after ${REDIS_PUBLISH_TIMEOUT_MS}ms`,
        );
        logger.info('Cache invalidated and broadcasted', { connectorId, tenantId });
      } catch (error) {
        logger.error('Failed to publish invalidation event', {
          connectorId,
          tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue - local cache was still invalidated
      }
    } else {
      logger.info('Cache invalidated locally (Redis pub/sub not available)', {
        connectorId,
        tenantId,
      });
    }
  }

  /**
   * Clear all cache entries.
   *
   * Used for testing or manual cache flush.
   */
  clearCache(): void {
    this.cache.clear();
    logger.info('Cache cleared');
  }

  /**
   * Get current cache statistics.
   *
   * @returns cache metrics
   */
  getCacheMetrics() {
    return {
      size: this.cache.size,
      maxSize: 500,
      hits: cacheMetrics.hits,
      misses: cacheMetrics.misses,
      evictions: 0, // LRUCache v10+ doesn't emit eviction events, tracked manually if needed
      hitRate: cacheMetrics.getHitRate(),
    };
  }

  /**
   * Cleanup Redis connections on shutdown.
   * Should be called when the service is being shut down.
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up CanonicalMapperService...');

    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = null;
    }

    if (this.publisher) {
      await this.publisher.quit();
      this.publisher = null;
    }

    this.cache.clear();
    logger.info('CanonicalMapperService cleanup complete');
  }
}

// ─── Singleton Instance ──────────────────────────────────────────────────────

let instance: CanonicalMapperService | null = null;

/**
 * Get or create the singleton CanonicalMapperService instance.
 */
export function getCanonicalMapperService(): CanonicalMapperService {
  if (!instance) {
    instance = new CanonicalMapperService();
  }
  return instance;
}
