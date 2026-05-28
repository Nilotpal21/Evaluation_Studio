/**
 * TTL Cache
 *
 * In-memory LRU-style cache with max size, TTL, and eviction.
 * Used for hot-path MongoDB lookups (project, permission) to avoid
 * per-request DB calls after first hit.
 *
 * Invalidation strategy:
 * - TTL-based expiry (default 60s) ensures stale data is automatically purged.
 * - LRU eviction when cache reaches max size prevents unbounded memory growth.
 * - Explicit invalidation via invalidate(key) or clear() for mutation paths.
 *
 * The runtime does not mutate Project or ProjectMember records — those are
 * managed by Studio/Admin. TTL expiry alone is sufficient for consistency.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TTLCache<T> {
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(opts: { maxSize: number; ttlMs: number }) {
    this.maxSize = opts.maxSize;
    this.ttlMs = opts.ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end for LRU behavior (Map preserves insertion order)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Delete first so re-insertion moves to end
    this.cache.delete(key);

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
