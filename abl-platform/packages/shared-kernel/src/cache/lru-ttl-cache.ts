/**
 * LRU + TTL Cache
 *
 * Bounded in-memory cache with both max-entry eviction (LRU, insertion-order)
 * and time-based expiry (TTL). Lazy TTL eviction on `get` — no background timer.
 *
 * CLAUDE.md invariant: "Every in-memory Map needs max size, TTL, and eviction."
 */

// ─── Options ────────────────────────────────────────────────────────────────

export interface LRUTTLCacheOptions {
  /** Maximum number of entries before LRU eviction. */
  maxEntries: number;
  /** Time-to-live in milliseconds. Entries expire on read after this age. */
  ttlMs: number;
  /** Clock function for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

// ─── Internal entry ─────────────────────────────────────────────────────────

interface CacheEntry<V> {
  value: V;
  insertedAt: number;
}

// ─── Class ──────────────────────────────────────────────────────────────────

export class LRUTTLCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: LRUTTLCacheOptions) {
    this.maxEntries = opts.maxEntries;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Retrieve a cached value. Returns `undefined` if the key is absent or
   * the entry has expired (lazy eviction).
   */
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    // TTL check — lazy eviction
    if (this.now() - entry.insertedAt >= this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /**
   * Insert or update a cache entry. If the cache exceeds `maxEntries`,
   * the least-recently-inserted entry is evicted (Map insertion order).
   *
   * Re-setting an existing key refreshes its position (moves to end).
   */
  set(key: string, value: V): void {
    // Delete first so re-insertion moves to the end of Map iteration order
    this.store.delete(key);

    // Evict oldest entry if at capacity
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }

    this.store.set(key, { value, insertedAt: this.now() });
  }

  /**
   * Check whether a non-expired entry exists. Does NOT evict on expiry
   * (mirrors typical `has` semantics — read via `get` to trigger eviction).
   */
  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.now() - entry.insertedAt >= this.ttlMs) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /** Remove an entry. Returns `true` if the key was present. */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.store.clear();
  }

  /** Number of entries (including potentially expired ones awaiting lazy eviction). */
  get size(): number {
    return this.store.size;
  }
}
