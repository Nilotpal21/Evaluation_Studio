/**
 * Tenant-Scoped Request Cache (RFC-003 Phase 2.3)
 *
 * Short-lived cache for deduplicating identical rerank requests.
 * Keys are scoped by tenant and index to prevent cross-tenant cache hits.
 */

import { createHash } from 'crypto';
import type { RerankResponse } from './reranker-factory.js';
import type { CacheEntry, BatchConfig } from './batch-types.js';

export class RequestCache {
  private cache: Map<string, CacheEntry>;
  private readonly ttl: number;
  private readonly maxSize: number;

  // Statistics
  private hits = 0;
  private misses = 0;

  constructor(config: Pick<BatchConfig, 'deduplicationTTL' | 'cacheMaxSize'>) {
    this.cache = new Map();
    this.ttl = config.deduplicationTTL;
    this.maxSize = config.cacheMaxSize;
  }

  /**
   * Get cached response if available and not expired.
   * CRITICAL: Cache keys are tenant and index scoped.
   */
  get(
    tenantId: string,
    indexId: string,
    query: string,
    documents: string[],
  ): RerankResponse | null {
    const key = this.computeKey(tenantId, indexId, query, documents);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Verify tenant isolation (defense in depth)
    if (entry.tenantId !== tenantId || entry.indexId !== indexId) {
      console.error(
        '[RequestCache] CRITICAL: Cache key collision detected!',
        `Expected: ${tenantId}:${indexId}, Found: ${entry.tenantId}:${entry.indexId}`,
      );
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Check TTL expiration
    const age = Date.now() - entry.timestamp;
    if (age > this.ttl) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Cache hit
    entry.hitCount++;
    this.hits++;
    return entry.response;
  }

  /**
   * Store response in cache with tenant and index context.
   */
  set(
    tenantId: string,
    indexId: string,
    query: string,
    documents: string[],
    response: RerankResponse,
  ): void {
    // Enforce max size with LRU eviction
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    const key = this.computeKey(tenantId, indexId, query, documents);

    this.cache.set(key, {
      response,
      timestamp: Date.now(),
      hitCount: 0,
      tenantId,
      indexId,
    });
  }

  /**
   * Get cache statistics.
   */
  getStats(): { hits: number; misses: number; hitRate: number; size: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      size: this.cache.size,
    };
  }

  /**
   * Clear all cache entries (for testing or emergency).
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Clear cache entries for a specific tenant (for tenant deletion).
   */
  clearTenant(tenantId: string): void {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.tenantId === tenantId) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Remove expired entries (periodic cleanup).
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Compute cache key with tenant and index isolation.
   *
   * Key format: {tenantId}:{indexId}:{queryHash}:{docHash}
   *
   * CRITICAL: Tenant and index prefixes prevent cross-tenant cache hits.
   */
  private computeKey(
    tenantId: string,
    indexId: string,
    query: string,
    documents: string[],
  ): string {
    // Hash documents (sorted for consistent ordering)
    const docHash = createHash('sha256')
      .update(documents.slice().sort().join('|'))
      .digest('hex')
      .slice(0, 16);

    // Hash query
    const queryHash = createHash('sha256').update(query).digest('hex').slice(0, 16);

    // Combine with tenant and index scope
    return `${tenantId}:${indexId}:${queryHash}:${docHash}`;
  }

  /**
   * Evict oldest entry (LRU).
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}
