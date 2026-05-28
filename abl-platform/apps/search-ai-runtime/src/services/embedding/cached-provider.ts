/**
 * Cached Embedding Provider
 *
 * Decorator that adds LRU caching to any EmbeddingProvider implementation.
 * Useful for query-time embedding caching to reduce latency and cost.
 *
 * **Architecture:**
 * - Implements EmbeddingProvider interface via delegation
 * - LRU cache with configurable size and TTL
 * - Thread-safe (single-threaded Node.js runtime)
 * - Transparent caching (no API changes)
 *
 * **Usage:**
 * ```typescript
 * const baseProvider = getEmbeddingProvider();
 * const cachedProvider = new CachedEmbeddingProvider(baseProvider, {
 *   maxSize: 1000,
 *   ttlMs: 1000 * 60 * 30, // 30 minutes
 * });
 * ```
 */

import { LRUCache } from 'lru-cache';
import {
  EmbeddingProvider,
  type EmbeddingResult,
} from '@agent-platform/search-ai-internal/embedding';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('CachedEmbeddingProvider');

export interface CacheOptions {
  maxSize?: number;
  ttlMs?: number;
}

/**
 * Wrapper that adds LRU caching to any EmbeddingProvider
 *
 * Caches embeddings by text content with configurable TTL.
 * Implements full EmbeddingProvider interface via delegation.
 */
export class CachedEmbeddingProvider implements EmbeddingProvider {
  private cache: LRUCache<string, number[]>;

  constructor(
    private delegate: EmbeddingProvider,
    options: CacheOptions = {},
  ) {
    this.cache = new LRUCache({
      max: options.maxSize || 1000,
      ttl: options.ttlMs || 1000 * 60 * 30, // 30 minutes default
      updateAgeOnGet: true,
      ttlAutopurge: true,
    });

    logger.info('CachedEmbeddingProvider initialized', {
      delegate: delegate.name,
      maxSize: this.cache.max,
      ttlMs: options.ttlMs || 1000 * 60 * 30,
    });
  }

  // ─── EmbeddingProvider Interface ─────────────────────────────────────

  get name(): string {
    return `cached-${this.delegate.name}`;
  }

  get modelId(): string {
    return this.delegate.modelId;
  }

  get dimensions(): number {
    return this.delegate.dimensions;
  }

  get maxBatchSize(): number {
    return this.delegate.maxBatchSize;
  }

  /**
   * Generate embedding with caching
   */
  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached) {
      logger.debug('Cache hit', { text: text.substring(0, 50) });
      return cached;
    }

    const embedding = await this.delegate.embed(text);
    this.cache.set(text, embedding);

    logger.debug('Cache miss', { text: text.substring(0, 50) });
    return embedding;
  }

  /**
   * Generate embeddings for multiple texts with partial caching
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return {
        embeddings: [],
        totalTokens: 0,
        model: this.delegate.modelId,
        dimensions: this.delegate.dimensions,
      };
    }

    // Check cache for each text
    const embeddings: number[][] = [];
    const textsToEmbed: string[] = [];
    const indices: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = this.cache.get(texts[i]);
      if (cached) {
        embeddings[i] = cached;
      } else {
        textsToEmbed.push(texts[i]);
        indices.push(i);
      }
    }

    // Embed uncached texts
    if (textsToEmbed.length > 0) {
      const result = await this.delegate.embedBatch(textsToEmbed);

      // Cache and insert into result array
      for (let i = 0; i < result.embeddings.length; i++) {
        const originalIndex = indices[i];
        const text = textsToEmbed[i];
        const embedding = result.embeddings[i];

        embeddings[originalIndex] = embedding;
        this.cache.set(text, embedding);
      }

      logger.debug('Batch embeddings', {
        total: texts.length,
        cached: texts.length - textsToEmbed.length,
        generated: textsToEmbed.length,
      });

      return {
        embeddings,
        totalTokens: result.totalTokens,
        model: result.model,
        dimensions: result.dimensions,
      };
    } else {
      logger.debug('All embeddings from cache', { count: texts.length });

      return {
        embeddings,
        totalTokens: 0,
        model: this.delegate.modelId,
        dimensions: this.delegate.dimensions,
      };
    }
  }

  /**
   * Estimate tokens (delegate)
   */
  estimateTokens(text: string): number {
    return this.delegate.estimateTokens(text);
  }

  /**
   * Health check (delegate)
   */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    return this.delegate.healthCheck();
  }

  /**
   * Close provider and clear cache
   */
  async close(): Promise<void> {
    if (this.delegate.close) {
      await this.delegate.close();
    }
    this.cache.clear();
    logger.info('CachedEmbeddingProvider closed', { cacheSize: this.cache.size });
  }

  // ─── Cache Management ────────────────────────────────────────────────

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.cache.max,
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    const size = this.cache.size;
    this.cache.clear();
    logger.info('Cache cleared', { clearedSize: size });
  }
}
