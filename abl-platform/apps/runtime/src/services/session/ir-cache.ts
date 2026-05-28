/**
 * Two-Tier AgentIR Cache
 *
 * L1: Pod-local LRU (fast, zero network, ~90%+ hit rate after warmup)
 * L2: SessionStore (Redis or Memory, ~1ms on L2 miss)
 *
 * Usage:
 *   const cache = new TwoTierIRCache(store, { maxL1Entries: 50 });
 *   const ir = await cache.get(hash); // L1 hit → 0ms, L2 hit → ~1ms
 *   await cache.set(hash, ir);        // writes to both L1 + L2
 */

import type { AgentIR, CompilationOutput } from '@abl/compiler';
import type { SessionStore } from './session-store.js';

// =============================================================================
// LRU CACHE
// =============================================================================

class LRUCache<V> {
  private cache = new Map<string, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

// =============================================================================
// TWO-TIER CACHE
// =============================================================================

export interface IRCacheConfig {
  maxL1Entries: number;
}

const DEFAULT_CONFIG: IRCacheConfig = {
  maxL1Entries: 50,
};

export class TwoTierIRCache {
  private l1IR: LRUCache<AgentIR>;
  private l1Compilation: LRUCache<CompilationOutput>;
  private store: SessionStore;

  // Hit/miss counters for diagnostics
  private stats = { l1Hit: 0, l2Hit: 0, miss: 0 };

  constructor(store: SessionStore, config: Partial<IRCacheConfig> = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.l1IR = new LRUCache<AgentIR>(cfg.maxL1Entries);
    this.l1Compilation = new LRUCache<CompilationOutput>(cfg.maxL1Entries);
    this.store = store;
  }

  // =========================================================================
  // AgentIR
  // =========================================================================

  async getIR(hash: string): Promise<AgentIR | null> {
    if (!hash) return null;

    // L1 check
    const cached = this.l1IR.get(hash);
    if (cached) {
      this.stats.l1Hit++;
      return cached;
    }

    // L2 check
    const fromStore = await this.store.getAgentIR(hash);
    if (fromStore) {
      this.stats.l2Hit++;
      this.l1IR.set(hash, fromStore); // promote to L1
      return fromStore;
    }

    this.stats.miss++;
    return null;
  }

  async setIR(hash: string, ir: AgentIR): Promise<void> {
    this.l1IR.set(hash, ir);
    await this.store.setAgentIR(hash, ir);
  }

  // =========================================================================
  // CompilationOutput
  // =========================================================================

  async getCompilation(hash: string): Promise<CompilationOutput | null> {
    if (!hash) return null;

    const cached = this.l1Compilation.get(hash);
    if (cached) {
      this.stats.l1Hit++;
      return cached;
    }

    const fromStore = await this.store.getCompilationOutput(hash);
    if (fromStore) {
      this.stats.l2Hit++;
      this.l1Compilation.set(hash, fromStore);
      return fromStore;
    }

    this.stats.miss++;
    return null;
  }

  async setCompilation(hash: string, output: CompilationOutput): Promise<void> {
    this.l1Compilation.set(hash, output);
    await this.store.setCompilationOutput(hash, output);
  }

  // =========================================================================
  // Diagnostics
  // =========================================================================

  getStats(): { l1Hit: number; l2Hit: number; miss: number; l1Size: number } {
    return {
      ...this.stats,
      l1Size: this.l1IR.size + this.l1Compilation.size,
    };
  }

  clear(): void {
    this.l1IR.clear();
    this.l1Compilation.clear();
    this.stats = { l1Hit: 0, l2Hit: 0, miss: 0 };
  }
}
