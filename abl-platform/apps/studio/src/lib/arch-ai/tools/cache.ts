/**
 * Generic TTL Cache with LRU Eviction
 *
 * Advisory-only — a miss returns undefined, caller fetches fresh data.
 * Follows CLAUDE.md: "Every in-memory Map needs max size, TTL, and eviction."
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  lastAccessed: number;
}

export interface TTLCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T, ttlMs?: number): void;
  invalidate(key: string): void;
  clear(): void;
}

export function createTTLCache<T>(maxSize: number, defaultTTLMs: number): TTLCache<T> {
  const store = new Map<string, CacheEntry<T>>();

  function evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) {
        store.delete(key);
      }
    }
  }

  function evictLRU(): void {
    if (store.size <= maxSize) return;

    let oldestKey: string | undefined;
    let oldestAccess = Infinity;

    for (const [key, entry] of store) {
      if (entry.lastAccessed < oldestAccess) {
        oldestAccess = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      store.delete(oldestKey);
    }
  }

  return {
    get(key: string): T | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;

      // Lazy eviction of expired entries
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
      }

      // Update last-accessed for LRU tracking
      entry.lastAccessed = Date.now();
      return entry.value;
    },

    set(key: string, value: T, ttlMs?: number): void {
      const now = Date.now();
      const expiresAt = now + (ttlMs ?? defaultTTLMs);

      // If at capacity and key is new, evict
      if (!store.has(key) && store.size >= maxSize) {
        evictExpired();
        // Still full after expiry sweep — evict LRU
        if (store.size >= maxSize) {
          evictLRU();
        }
      }

      store.set(key, { value, expiresAt, lastAccessed: now });
    },

    invalidate(key: string): void {
      store.delete(key);
    },

    clear(): void {
      store.clear();
    },
  };
}
