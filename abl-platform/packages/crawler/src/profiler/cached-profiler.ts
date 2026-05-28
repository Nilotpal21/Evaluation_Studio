/**
 * Cached Profiler - Decorator with TTL-based caching
 *
 * Wraps any ISiteProfiler implementation with caching to avoid
 * repeated profiling of the same domain.
 *
 * Responsibilities (Decorator Pattern):
 * - Cache profile results by domain
 * - Respect TTL for cache invalidation
 * - Delegate to wrapped profiler on cache miss
 * - Forward getName() and getCapabilities() to wrapped profiler
 *
 * Cache Key Strategy:
 * - Key format: `profile:${domain}`
 * - Uses domain extracted from URL (e.g., "example.com")
 * - Case-insensitive (normalized to lowercase)
 *
 * Design Principles:
 * - Decorator Pattern: Wraps ISiteProfiler without modifying it
 * - Open/Closed: Can wrap any ISiteProfiler implementation
 * - Liskov Substitution: CachedProfiler is-a ISiteProfiler
 * - Dependency Inversion: Depends on ISiteProfiler abstraction
 */

import { ISiteProfiler, SiteProfile, ProfileOptions, ProfilerCapabilities } from './interfaces.js';

export interface CacheEntry {
  profile: SiteProfile;
  cachedAt: Date;
  expiresAt: Date;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRate: number;
}

export interface CachedProfilerOptions {
  ttlMs?: number; // Default: 1 hour
  maxSize?: number; // Default: 1000 entries
}

export class CachedProfiler implements ISiteProfiler {
  private readonly profiler: ISiteProfiler;
  private readonly cache: Map<string, CacheEntry>;
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private stats = { hits: 0, misses: 0 };

  constructor(profiler: ISiteProfiler, options: CachedProfilerOptions = {}) {
    this.profiler = profiler;
    this.cache = new Map();
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000; // 1 hour
    this.maxSize = options.maxSize ?? 1000;
  }

  getName(): string {
    return `cached-${this.profiler.getName()}`;
  }

  getCapabilities(): ProfilerCapabilities {
    // Caching makes profiling faster on cache hit
    const caps = this.profiler.getCapabilities();
    return {
      ...caps,
      avgDurationMs: Math.round(caps.avgDurationMs * 0.1), // ~10x faster on hit
    };
  }

  async profile(url: string, options: ProfileOptions = {}): Promise<SiteProfile> {
    const domain = this.extractDomain(url);
    const cacheKey = `profile:${domain}`;

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && this.isValid(cached)) {
      this.stats.hits++;
      return cached.profile;
    }

    // Cache miss - profile and cache
    this.stats.misses++;
    const profile = await this.profiler.profile(url, options);

    // Store in cache
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    this.cache.set(cacheKey, {
      profile,
      cachedAt: now,
      expiresAt,
    });

    // Evict oldest if exceeds max size (LRU-like behavior)
    if (this.cache.size > this.maxSize) {
      this.evictOldest();
    }

    return profile;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? this.stats.hits / total : 0;

    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      size: this.cache.size,
      hitRate,
    };
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0 };
  }

  /**
   * Invalidate cache entry for specific domain
   */
  invalidate(url: string): boolean {
    const domain = this.extractDomain(url);
    const cacheKey = `profile:${domain}`;
    return this.cache.delete(cacheKey);
  }

  /**
   * Extract domain from URL and normalize
   */
  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase();
    } catch {
      // If URL parsing fails, use the string as-is (normalized)
      return url
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .split('/')[0];
    }
  }

  /**
   * Check if cache entry is still valid
   */
  private isValid(entry: CacheEntry): boolean {
    return new Date() < entry.expiresAt;
  }

  /**
   * Evict oldest entry (LRU-like eviction)
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime: Date | null = null;

    for (const [key, entry] of this.cache.entries()) {
      if (!oldestTime || entry.cachedAt < oldestTime) {
        oldestKey = key;
        oldestTime = entry.cachedAt;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}
