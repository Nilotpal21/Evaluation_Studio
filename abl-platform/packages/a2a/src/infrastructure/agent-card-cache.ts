/**
 * AgentCardCache — LRU cache with TTL for discovered A2A agent cards.
 *
 * Agent cards are relatively stable. Caching avoids repeated network
 * calls to /.well-known/agent-card.json on every outbound handoff.
 *
 * Max entries: 100 (evicts least-recently-used on overflow)
 * Default TTL: 5 minutes
 */

import type { AgentCard } from '@a2a-js/sdk';

interface CacheEntry {
  card: AgentCard;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 100;

export class AgentCardCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(endpoint: string): AgentCard | undefined {
    const entry = this.cache.get(endpoint);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(endpoint);
      return undefined;
    }

    // LRU: re-insert to move to end (most-recently-used)
    this.cache.delete(endpoint);
    this.cache.set(endpoint, entry);

    return entry.card;
  }

  set(endpoint: string, card: AgentCard): void {
    // Evict expired entries first to avoid unnecessary eviction of valid ones
    if (this.cache.size >= MAX_ENTRIES && !this.cache.has(endpoint)) {
      this.evictExpired();
    }

    // If still at capacity, evict LRU (first entry in Map iteration order)
    if (this.cache.size >= MAX_ENTRIES && !this.cache.has(endpoint)) {
      const lru = this.cache.keys().next().value;
      if (lru !== undefined) {
        this.cache.delete(lru);
      }
    }

    this.cache.set(endpoint, {
      card,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** Number of non-expired entries currently in cache. */
  get size(): number {
    this.evictExpired();
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }

  /** Remove all expired entries. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}
