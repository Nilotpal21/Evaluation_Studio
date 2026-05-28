/**
 * AnalyticsCache — Redis cache for pipeline analytics query results.
 *
 * Fail-open: cache misses and Redis errors never block queries.
 * Key format: analytics:{tenantId}:{projectId}:{pipeline}:{queryType}:{hash}
 *
 * TTLs:
 *   summary       = 300s  (5 min)
 *   timeseries    = 600s  (10 min)
 *   breakdown     = 300s  (5 min)
 *   conversation  = 3600s (1 hour — single session is immutable)
 *   conversations = 300s  (5 min — list queries change as new data arrives)
 */
import { createHash } from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import { scanKeys, type RedisClient } from '@agent-platform/redis';

const log = createLogger('analytics-cache');

const TTL_SECONDS: Record<string, number> = {
  summary: 300,
  timeseries: 600,
  breakdown: 300,
  conversation: 3600,
  conversations: 300,
};

const DEFAULT_TTL = 300;

const KEY_PREFIX = 'analytics';

export interface AnalyticsCacheOptions {
  tenantId: string;
  projectId: string;
  pipelineType: string;
  queryType: string;
  params: Record<string, unknown>;
}

/** Build a cache key from query parameters. */
function buildKey(opts: AnalyticsCacheOptions): string {
  const paramsHash = createHash('sha256')
    .update(JSON.stringify(opts.params))
    .digest('hex')
    .slice(0, 16);
  return `${KEY_PREFIX}:${opts.tenantId}:${opts.projectId}:${opts.pipelineType}:${opts.queryType}:${paramsHash}`;
}

export class AnalyticsCache {
  private redis: RedisClient | null;

  constructor(redisClient: RedisClient | null) {
    this.redis = redisClient;
  }

  /**
   * Get a cached analytics result. Returns null on miss or error.
   */
  async get<T>(opts: AnalyticsCacheOptions): Promise<T | null> {
    if (!this.redis) return null;

    const key = buildKey(opts);
    try {
      const cached = await this.redis.get(key);
      if (!cached) return null;
      return JSON.parse(cached) as T;
    } catch (err) {
      log.warn('Analytics cache get failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Set a cached analytics result. Silently fails on error.
   */
  async set(opts: AnalyticsCacheOptions, data: unknown): Promise<void> {
    if (!this.redis) return;

    const key = buildKey(opts);
    const ttl = TTL_SECONDS[opts.queryType] ?? DEFAULT_TTL;
    try {
      await this.redis.set(key, JSON.stringify(data), 'EX', ttl);
    } catch (err) {
      log.warn('Analytics cache set failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Invalidate all cached results for a pipeline within a project.
   * Called after batch processing completes.
   */
  async invalidate(tenantId: string, projectId: string, pipelineType: string): Promise<void> {
    if (!this.redis) return;

    const pattern = `${KEY_PREFIX}:${tenantId}:${projectId}:${pipelineType}:*`;
    try {
      const keys: string[] = [];
      for await (const k of scanKeys(this.redis, pattern)) keys.push(k);
      if (keys.length > 0) {
        for (const k of keys) await this.redis.del(k);
        log.debug('Analytics cache invalidated', {
          tenantId,
          projectId,
          pipelineType,
          keysRemoved: keys.length,
        });
      }
    } catch (err) {
      log.warn('Analytics cache invalidation failed', {
        pattern,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
