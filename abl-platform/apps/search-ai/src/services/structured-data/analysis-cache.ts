/**
 * Analysis Cache Service
 *
 * Caches structured data analysis results in Redis with 1-hour TTL.
 * Uses gzip compression for file buffers.
 */

import {
  createRedisConnection,
  resolveRedisOptionsFromEnv,
  type RedisClient,
  type RedisConnectionHandle,
} from '@agent-platform/redis';
import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';
import type { CachedAnalysis, AnalyzeResponse } from './ingestion-types.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const CACHE_PREFIX = 'structured-data:analysis:';
const CACHE_TTL_SECONDS = 60 * 60; // 1 hour

export class AnalysisCacheService {
  private redis: RedisClient;
  private static handle: RedisConnectionHandle | null = null;

  constructor(redisClient?: RedisClient) {
    if (redisClient) {
      this.redis = redisClient;
    } else {
      if (!AnalysisCacheService.handle) {
        throw new Error(
          'Redis client not initialized. Call AnalysisCacheService.initialize() first or provide a client.',
        );
      }
      this.redis = AnalysisCacheService.handle.client;
    }
  }

  /**
   * Initialize Redis client singleton (call once at startup).
   * Reads REDIS_URL, REDIS_CLUSTER, REDIS_PASSWORD, REDIS_TLS_ENABLED from env.
   * The optional redisUrl parameter is used as a fallback when REDIS_URL is not set.
   */
  static async initialize(redisUrl?: string): Promise<void> {
    if (AnalysisCacheService.handle) return;

    const opts = resolveRedisOptionsFromEnv() ?? {};
    if (redisUrl && !opts.url) opts.url = redisUrl;

    AnalysisCacheService.handle = createRedisConnection({
      ...opts,
      lazyConnect: false,
    });
  }

  /**
   * Store analysis result with compressed file buffer
   */
  async set(
    analysisId: string,
    tenantId: string,
    indexId: string,
    fileBuffer: Buffer,
    originalFilename: string,
    mimeType: string,
    fileSize: number,
    analysis: AnalyzeResponse,
  ): Promise<void> {
    const key = this.getKey(analysisId);

    // Compress file buffer
    const compressedBuffer = await gzipAsync(fileBuffer);

    const cached: CachedAnalysis = {
      fileBuffer: compressedBuffer as Buffer,
      originalFilename,
      mimeType,
      fileSize,
      analysis,
      tenantId,
      indexId,
      cachedAt: new Date(),
      expiresAt: analysis.expiresAt,
    };

    // Serialize to JSON (Buffer is base64-encoded automatically)
    const serialized = JSON.stringify(cached);

    // Store with TTL
    await this.redis.setex(key, CACHE_TTL_SECONDS, serialized);
  }

  /**
   * Retrieve analysis result and decompress file buffer
   */
  async get(analysisId: string): Promise<CachedAnalysis | null> {
    const key = this.getKey(analysisId);
    const serialized = await this.redis.get(key);

    if (!serialized) {
      return null;
    }

    // Deserialize
    const cached = JSON.parse(serialized) as CachedAnalysis;

    // Decompress file buffer
    const compressedBuffer = Buffer.from(cached.fileBuffer);
    const decompressedBuffer = await gunzipAsync(compressedBuffer);

    return {
      ...cached,
      fileBuffer: decompressedBuffer as Buffer,
      cachedAt: new Date(cached.cachedAt),
      expiresAt: new Date(cached.expiresAt),
    };
  }

  /**
   * Delete analysis from cache
   */
  async delete(analysisId: string): Promise<void> {
    const key = this.getKey(analysisId);
    await this.redis.del(key);
  }

  /**
   * Check if analysis exists and hasn't expired
   */
  async exists(analysisId: string): Promise<boolean> {
    const key = this.getKey(analysisId);
    const ttl = await this.redis.ttl(key);
    return ttl > 0;
  }

  /**
   * Generate Redis key
   */
  private getKey(analysisId: string): string {
    return `${CACHE_PREFIX}${analysisId}`;
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    await AnalysisCacheService.handle?.disconnect();
    AnalysisCacheService.handle = null;
  }
}
