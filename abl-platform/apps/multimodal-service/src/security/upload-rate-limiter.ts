/**
 * Per-Tenant Upload Rate Limiter
 *
 * Provides sliding-window rate limiting for file uploads, scoped per tenant.
 * Uses `rate-limiter-flexible` with pluggable backends:
 *   - RateLimiterMemory  for dev/test/single-pod
 *   - RateLimiterRedis   for production (distributed, multi-pod)
 *
 * Follows the same per-tenant pattern as apps/runtime/src/middleware/rate-limiter.ts.
 */

import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('upload-rate-limiter');

// =============================================================================
// TYPES
// =============================================================================

export interface UploadRateLimiterConfig {
  /** Maximum number of uploads allowed per window */
  maxUploadsPerWindow: number;
  /** Window duration in seconds */
  windowSeconds: number;
}

export interface RateLimitResult {
  /** Whether the upload is allowed */
  allowed: boolean;
  /** Milliseconds the client should wait before retrying (present when denied) */
  retryAfterMs?: number;
  /** Number of remaining upload slots in the current window */
  remainingPoints?: number;
  /** The configured limit (total uploads per window) */
  limit: number;
}

// =============================================================================
// ENV-VAR-BACKED CONFIGURATION HELPERS
// =============================================================================

/** Parse an integer from an env var, returning the fallback on missing/NaN */
function safeParseInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default upload rate limit: uploads per window */
const DEFAULT_MAX_UPLOADS_PER_WINDOW = safeParseInt(
  process.env.UPLOAD_RATE_LIMIT_MAX_PER_WINDOW,
  50,
);

/** Default window duration in seconds (1 minute) */
const DEFAULT_WINDOW_SECONDS = safeParseInt(process.env.UPLOAD_RATE_LIMIT_WINDOW_SECONDS, 60);

/** Key prefix to namespace upload rate-limit keys in the backing store */
const UPLOAD_RATE_KEY_PREFIX = 'upload-rate';

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Per-tenant upload rate limiter.
 *
 * Each tenant gets an independent sliding window. When a tenant exhausts their
 * upload quota, subsequent requests receive `{ allowed: false, retryAfterMs }`
 * so the caller can respond with HTTP 429 and a Retry-After header.
 *
 * Usage:
 * ```ts
 * const limiter = new UploadRateLimiter({ maxUploadsPerWindow: 50, windowSeconds: 60 });
 * const result = await limiter.consume(tenantId);
 * if (!result.allowed) {
 *   res.status(429).json({ error: 'Rate limit exceeded', retryAfterMs: result.retryAfterMs });
 *   return;
 * }
 * ```
 */
export class UploadRateLimiter {
  private readonly limiter: RateLimiterAbstract;

  private readonly maxUploads: number;

  constructor(config?: Partial<UploadRateLimiterConfig>, redisClient?: unknown) {
    const maxUploads = config?.maxUploadsPerWindow ?? DEFAULT_MAX_UPLOADS_PER_WINDOW;
    this.maxUploads = maxUploads;
    const windowSec = config?.windowSeconds ?? DEFAULT_WINDOW_SECONDS;

    const baseOpts = {
      points: maxUploads,
      duration: windowSec,
      keyPrefix: UPLOAD_RATE_KEY_PREFIX,
    };

    if (redisClient) {
      this.limiter = new RateLimiterRedis({
        ...baseOpts,
        storeClient: redisClient,
      });
    } else {
      this.limiter = new RateLimiterMemory(baseOpts);
    }
  }

  /**
   * Attempt to consume one upload slot for the given tenant.
   *
   * @param tenantId - The tenant identifier (rate limits are independent per tenant)
   * @returns A RateLimitResult indicating whether the upload is allowed
   */
  async consume(tenantId: string): Promise<RateLimitResult> {
    try {
      const res = await this.limiter.consume(tenantId);
      return {
        allowed: true,
        remainingPoints: res.remainingPoints,
        limit: this.maxUploads,
      };
    } catch (rejRes: unknown) {
      // rate-limiter-flexible rejects with a RateLimiterRes object when the limit
      // is exceeded, but throws an actual Error when the backing store (Redis) is
      // down. Distinguish the two to avoid blocking all uploads during Redis outages.
      if (rejRes instanceof Error) {
        log.warn('Infrastructure error, allowing request (fail-open)', {
          error: rejRes.message,
        });
        return {
          allowed: true,
          remainingPoints: 0,
          limit: this.maxUploads,
        };
      }
      const rejection = rejRes as { msBeforeNext?: number };
      return {
        allowed: false,
        retryAfterMs: rejection.msBeforeNext ?? 0,
        remainingPoints: 0,
        limit: this.maxUploads,
      };
    }
  }
}
