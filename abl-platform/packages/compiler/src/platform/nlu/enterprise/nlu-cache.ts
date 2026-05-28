/**
 * NLU Result Cache
 *
 * In-memory cache for NLU results with tenant-scoped keys.
 * Follows the LLMResponseCache pattern from llm/cache.ts.
 */

import * as crypto from 'crypto';
import type { NLUContext, NLUTask } from '../types.js';
import type { NLUConfig } from '../config.js';
import type { NLUEncryptionPort } from './interfaces.js';

// =============================================================================
// CACHE ENTRY
// =============================================================================

interface CacheEntry {
  result: unknown;
  storedAt: number;
  ttlMs: number;
  accessCount: number;
}

// =============================================================================
// CACHE STATS
// =============================================================================

export interface NLUCacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  totalEntries: number;
}

// =============================================================================
// NLU RESULT CACHE
// =============================================================================

export class NLUResultCache {
  private cache = new Map<string, CacheEntry>();
  private config: NLUConfig['cache'];
  private encryption?: NLUEncryptionPort;
  private tenantId?: string;
  private stats: NLUCacheStats = { hits: 0, misses: 0, hitRate: 0, totalEntries: 0 };
  private maxEntries: number;

  constructor(
    config: NLUConfig['cache'],
    options?: {
      tenantId?: string;
      encryption?: NLUEncryptionPort;
      maxEntries?: number;
    },
  ) {
    this.config = config;
    this.tenantId = options?.tenantId;
    this.encryption = options?.encryption;
    this.maxEntries = options?.maxEntries ?? 5000;
  }

  /**
   * Check cache for a result.
   * Implements PipelineHooks.checkCache
   */
  async checkCache(ctx: NLUContext, task: NLUTask): Promise<unknown | null> {
    if (!this.config.enabled) return null;

    const key = this.buildKey(ctx, task);
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    // Check TTL
    if (Date.now() - entry.storedAt > entry.ttlMs) {
      this.cache.delete(key);
      this.stats.totalEntries--;
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    entry.accessCount++;
    this.stats.hits++;
    this.updateHitRate();

    return entry.result;
  }

  /**
   * Store a result in the cache.
   * Implements PipelineHooks.storeCache
   */
  async storeCache(ctx: NLUContext, task: NLUTask, result: unknown): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.isCacheableTask(task)) return;

    const key = this.buildKey(ctx, task);
    const ttlMs = this.getTTLForTask(task);

    this.cache.set(key, {
      result,
      storedAt: Date.now(),
      ttlMs,
      accessCount: 0,
    });
    this.stats.totalEntries = this.cache.size;

    // Evict if over limit
    if (this.cache.size > this.maxEntries) {
      this.evictOldest();
    }
  }

  /**
   * Invalidate all cache entries for a tenant
   */
  invalidateForTenant(tenantId: string): void {
    const prefix = `${tenantId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
    this.stats.totalEntries = this.cache.size;
  }

  /**
   * Invalidate all cache entries
   */
  invalidateAll(): void {
    this.cache.clear();
    this.stats.totalEntries = 0;
  }

  /**
   * Get cache statistics
   */
  getStats(): NLUCacheStats {
    return { ...this.stats };
  }

  // =========================================================================
  // PRIVATE
  // =========================================================================

  private buildKey(ctx: NLUContext, task: NLUTask): string {
    const contextHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          agentGoal: ctx.agentGoal,
          currentStep: ctx.currentStep,
          collectedData: ctx.collectedData,
        }),
      )
      .digest('hex')
      .substring(0, 12);

    const messageHash = crypto
      .createHash('sha256')
      .update(ctx.userMessage)
      .digest('hex')
      .substring(0, 12);

    const tenantPrefix = this.tenantId || 'default';
    return `${tenantPrefix}:${task}:${messageHash}:${contextHash}`;
  }

  private getTTLForTask(task: NLUTask): number {
    switch (task) {
      case 'intent_detection':
      case 'sub_intent_detection':
      case 'category_classification':
        return this.config.intentTtlMs;
      case 'entity_extraction':
        return this.config.entityTtlMs;
      default:
        return this.config.ttlMs;
    }
  }

  private isCacheableTask(task: NLUTask): boolean {
    // Correction detection is context-sensitive and shouldn't be cached
    return task !== 'correction_detection';
  }

  private evictOldest(): void {
    // Remove the 20% oldest entries
    const entries = [...this.cache.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);

    const toRemove = Math.ceil(entries.length * 0.2);
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0]);
    }
    this.stats.totalEntries = this.cache.size;
  }

  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }
}
