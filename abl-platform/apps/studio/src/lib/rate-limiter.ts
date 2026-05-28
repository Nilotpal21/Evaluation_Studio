/**
 * Sliding Window Rate Limiter
 *
 * In-memory rate limiter for Studio API routes. Uses a sliding window algorithm
 * with bounded storage (LRU eviction when maxEntries reached).
 *
 * Usage:
 *   const limiter = new SlidingWindowRateLimiter();
 *   const result = limiter.check('user:abc', { limit: 10, windowMs: 60_000 });
 *   if (!result.allowed) return 429;
 *
 * Future: Swap to RedisRateLimiter from apps/runtime when Studio gets Redis access.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

/** Rate limit scope — determines the bucketing dimension. */
export const RateLimitScope = {
  /** One bucket per tenant (all users in tenant share the limit) */
  TENANT: 'tenant',
  /** One bucket per user within a tenant (default) */
  USER: 'user',
  /** One bucket per source IP address */
  IP: 'ip',
} as const;

export type RateLimitScope = (typeof RateLimitScope)[keyof typeof RateLimitScope];

export interface RateLimitConfig {
  /** Max requests in the window */
  limit: number;
  /** Window size in ms (default: 60_000 = 1 minute) */
  windowMs?: number;
  /** Key scope — determines what the rate limit is per (default: 'user') */
  scope?: RateLimitScope;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Remaining requests in the current window */
  remaining: number;
  /** Time in ms until the window resets (for Retry-After header) */
  resetMs: number;
}

// ─── Constants ────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

// ─── Implementation ────────────────────────────────────────────────────────

export class SlidingWindowRateLimiter {
  private windows = new Map<string, number[]>();
  private maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  /**
   * Check if a request is allowed under the rate limit.
   *
   * @param key - Unique key for the rate limit bucket (e.g. 'user:abc')
   * @param config - Rate limit configuration
   * @returns Whether the request is allowed + remaining count + reset time
   */
  check(key: string, config: RateLimitConfig): RateLimitResult {
    const windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    const now = Date.now();
    const windowStart = now - windowMs;

    // Get or create timestamp array for this key
    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.evictIfNeeded();
      this.windows.set(key, timestamps);
    }

    // Remove timestamps outside the window
    const firstValid = timestamps.findIndex((t) => t > windowStart);
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    } else if (firstValid === -1 && timestamps.length > 0) {
      timestamps.length = 0;
    }

    const count = timestamps.length;

    if (count >= config.limit) {
      // Rate limited — calculate when the oldest request in window expires
      const oldestInWindow = timestamps[0];
      const resetMs = oldestInWindow ? oldestInWindow + windowMs - now : windowMs;
      return { allowed: false, remaining: 0, resetMs: Math.max(0, resetMs) };
    }

    // Allow and record
    timestamps.push(now);
    return {
      allowed: true,
      remaining: config.limit - count - 1,
      resetMs: windowMs,
    };
  }

  /** Remove all entries for a key (e.g. on auth failure reset) */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /** Clear all rate limit state */
  clear(): void {
    this.windows.clear();
  }

  /** Current number of tracked keys */
  get size(): number {
    return this.windows.size;
  }

  private evictIfNeeded(): void {
    if (this.windows.size < this.maxEntries) return;
    // Evict oldest entry (first key in Map = insertion order)
    const firstKey = this.windows.keys().next().value;
    if (firstKey !== undefined) this.windows.delete(firstKey);
  }
}

/**
 * Build a rate limit key from request context.
 *
 * @param scope - The bucketing scope
 * @param tenantId - The tenant ID
 * @param userId - The user ID
 * @param ip - The request IP (from X-Forwarded-For or connection)
 * @param routePath - The route path for per-route scoping
 */
export function buildRateLimitKey(
  scope: RateLimitScope,
  tenantId: string,
  userId: string,
  ip: string | null,
  routePath: string,
): string {
  switch (scope) {
    case RateLimitScope.TENANT:
      return `rl:${routePath}:t:${tenantId}`;
    case RateLimitScope.USER:
      return `rl:${routePath}:u:${tenantId}:${userId}`;
    case RateLimitScope.IP:
      return `rl:${routePath}:ip:${ip ?? 'unknown'}`;
  }
}

/** Singleton instance — shared across all route handlers in the process */
export const rateLimiter = new SlidingWindowRateLimiter();
