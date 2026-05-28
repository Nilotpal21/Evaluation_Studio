/**
 * Memory Bridge Registry
 *
 * Maps sessionId → ToolMemoryAPI so the HTTP memory-api route can look up
 * the in-process bridge for a given sandbox callback.
 *
 * Bounded Map with max size, TTL, and LRU eviction per CLAUDE.md invariant:
 * "Every in-memory Map needs max size, TTL, and eviction."
 */

import type { ToolMemoryAPI } from '@abl/compiler/platform/constructs/types.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('memory-bridge-registry');

const MAX_ENTRIES = 10_000;
const TTL_MS = 60 * 60 * 1000; // 1 hour

interface RegistryEntry {
  bridge: ToolMemoryAPI;
  accountId?: string;
  createdAt: number;
}

class MemoryBridgeRegistry {
  private entries = new Map<string, RegistryEntry>();

  /** Register a bridge for a session. Evicts oldest if at capacity. */
  register(sessionId: string, bridge: ToolMemoryAPI, accountId?: string): void {
    // Evict expired entries first, then oldest if still at capacity
    if (this.entries.size >= MAX_ENTRIES) {
      this.evictExpired();
    }
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
        log.debug('Evicted oldest memory bridge entry', { sessionId: oldest });
      }
    }

    this.entries.set(sessionId, { bridge, accountId, createdAt: Date.now() });
  }

  /** Look up a bridge by sessionId. Returns undefined if not found or expired. */
  get(sessionId: string): RegistryEntry | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;

    if (Date.now() - entry.createdAt > TTL_MS) {
      this.entries.delete(sessionId);
      return undefined;
    }

    // LRU: refresh timestamp on access
    entry.createdAt = Date.now();
    return entry;
  }

  /** Remove a bridge when a session ends. */
  unregister(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /** Evict all expired entries. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.createdAt > TTL_MS) {
        this.entries.delete(id);
      }
    }
  }

  /** Current registry size (for diagnostics). */
  get size(): number {
    return this.entries.size;
  }
}

// Module-level singleton
let instance: MemoryBridgeRegistry | null = null;

export function getMemoryBridgeRegistry(): MemoryBridgeRegistry {
  if (!instance) {
    instance = new MemoryBridgeRegistry();
  }
  return instance;
}
