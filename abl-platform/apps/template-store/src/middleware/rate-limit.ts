/**
 * Rate Limiter Middleware (Template Store)
 *
 * In-memory sliding window rate limiter per IP address for public endpoints.
 * Configurable via config.rateLimitWindowMs and config.rateLimitMaxRequests.
 *
 * Design:
 * - Uses a Map with max size, TTL, and periodic eviction (per CLAUDE.md rules)
 * - Returns 429 Too Many Requests when exceeded
 * - Lightweight — suitable for single-instance dev; production should use Redis
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('template-store-rate-limit');

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum number of tracked IPs before oldest entries are evicted */
const MAX_BUCKET_SIZE = 10_000;

/** How often to run the eviction sweep (ms) */
const EVICTION_INTERVAL_MS = 60_000;

// ─── Types ──────────────────────────────────────────────────────────────────

interface RateBucket {
  /** Timestamps of requests within the current window */
  timestamps: number[];
  /** Last access time — used for TTL eviction */
  lastAccess: number;
}

export interface RateLimitOptions {
  /** Sliding window size in milliseconds */
  windowMs: number;
  /** Maximum requests allowed within the window */
  maxRequests: number;
}

// ─── Rate Limiter Factory ───────────────────────────────────────────────────

/**
 * Create rate limiter middleware with the given options.
 *
 * Uses a sliding window approach: each request's timestamp is recorded,
 * and only timestamps within [now - windowMs, now] count toward the limit.
 */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const { windowMs, maxRequests } = options;
  const buckets = new Map<string, RateBucket>();

  // Periodic eviction of stale entries
  const evictionTimer = setInterval(() => {
    const now = Date.now();
    const cutoff = now - windowMs * 2; // Evict entries not accessed in 2x the window

    // If over max size, evict oldest entries first
    if (buckets.size > MAX_BUCKET_SIZE) {
      const entries = Array.from(buckets.entries());
      entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
      const toRemove = entries.slice(0, entries.length - MAX_BUCKET_SIZE);
      for (const [key] of toRemove) {
        buckets.delete(key);
      }
    }

    // Evict entries older than TTL
    for (const [key, bucket] of buckets) {
      if (bucket.lastAccess < cutoff) {
        buckets.delete(key);
      }
    }
  }, EVICTION_INTERVAL_MS);

  // Don't keep the process alive just for cleanup
  evictionTimer.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    // req.ip respects the trust proxy setting configured in server.ts
    // (app.set('trust proxy', 1)) — no manual XFF parsing needed.
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    let bucket = buckets.get(ip);

    if (!bucket) {
      // Enforce max size — if at capacity, evict oldest entry
      if (buckets.size >= MAX_BUCKET_SIZE) {
        let oldestKey: string | undefined;
        let oldestTime = Infinity;
        for (const [key, b] of buckets) {
          if (b.lastAccess < oldestTime) {
            oldestTime = b.lastAccess;
            oldestKey = key;
          }
        }
        if (oldestKey) {
          buckets.delete(oldestKey);
        }
      }

      bucket = { timestamps: [], lastAccess: now };
      buckets.set(ip, bucket);
    }

    // Slide the window — remove timestamps outside the current window
    bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart);
    bucket.lastAccess = now;

    if (bucket.timestamps.length >= maxRequests) {
      // Calculate retry-after from the oldest timestamp in the window
      const oldestInWindow = bucket.timestamps[0];
      const retryAfterMs = oldestInWindow + windowMs - now;
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);

      log.warn('Rate limit exceeded', { ip, count: bucket.timestamps.length, windowMs });

      res.set('Retry-After', String(retryAfterSec));
      res.status(429).json({
        success: false,
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: `Rate limit exceeded. Try again in ${retryAfterSec} seconds.`,
        },
      });
      return;
    }

    // Record this request
    bucket.timestamps.push(now);

    // Set rate limit headers (standard draft)
    res.set('X-RateLimit-Limit', String(maxRequests));
    res.set('X-RateLimit-Remaining', String(maxRequests - bucket.timestamps.length));
    res.set('X-RateLimit-Reset', String(Math.ceil((now + windowMs) / 1000)));

    next();
  };
}
