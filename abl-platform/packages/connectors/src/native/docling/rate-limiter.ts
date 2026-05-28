/**
 * Workflow-docling per-tenant rate-limiter singleton (LLD Phase 2 Task 2.4).
 *
 * Lazily constructs a `RateLimiterRedis` (or `RateLimiterMemory` fallback when
 * Redis is unavailable — dev/CI) keyed on `workflow:docling:${tenantId}`.
 * Default 10 extractions/min sustained (LLD FR-8); env-overridable.
 *
 * Mirrors the `redisRateLimiter` singleton pattern at
 * `packages/shared/src/services/mcp-auth-resolver.ts:24,255-264`.
 */

import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';

export const DOCLING_RATE_LIMIT_KEY_PREFIX = 'workflow:docling';
export const DOCLING_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 10;

/**
 * Minimal Redis client shape `RateLimiterRedis` needs (a `call` method that
 * forwards arbitrary commands plus a status getter). Marked as an opaque
 * brand-typed alias because ioredis's overloaded `call` signature collides
 * with any narrower function shape; the caller treats this as a black-box
 * handle and forwards it to `RateLimiterRedis`'s `storeClient` field.
 */
export type DoclingRedisClient = {
  readonly status?: string;
  // `call` is intentionally typed broadly: ioredis exposes an overloaded
  // method whose narrower forms reject `(cmd, ...args: unknown[])`. We
  // sidestep the type-system mismatch by accepting any call signature and
  // letting `RateLimiterRedis` validate at runtime.
  readonly call: (...args: never[]) => unknown;
};

let redisLimiter: RateLimiterAbstract | null = null;
let memoryLimiter: RateLimiterAbstract | null = null;

function parsePoints(): number {
  const raw = process.env.DOCLING_WORKFLOW_RATE_LIMIT_PER_MIN;
  if (!raw) return DEFAULT_RATE_LIMIT_PER_MINUTE;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RATE_LIMIT_PER_MINUTE;
}

/**
 * Get (or lazily construct) the per-tenant Docling rate-limiter.
 *
 * Pass the shared `DoclingRedisClient` when available (workflow-engine wires
 * it via the connector deps factory). When `null` the memory limiter is used
 * (test environments + dev without Redis); a warning is NOT emitted because
 * tests legitimately rely on this fallback.
 */
export function getDoclingRateLimiter(redisClient: DoclingRedisClient | null): RateLimiterAbstract {
  if (redisClient) {
    // SEC-9: check connection status before returning the Redis limiter. When the
    // Redis connection has dropped (status !== 'ready'), fall through to the memory
    // limiter rather than silently skipping rate-limit decisions for ALL tenants.
    const isReady = !redisClient.status || redisClient.status === 'ready';
    if (isReady) {
      if (!redisLimiter) {
        redisLimiter = new RateLimiterRedis({
          points: parsePoints(),
          duration: DOCLING_RATE_LIMIT_WINDOW_SECONDS,
          keyPrefix: DOCLING_RATE_LIMIT_KEY_PREFIX,
          storeClient: redisClient as never,
        });
      }
      return redisLimiter;
    }
    // Redis not ready — reset cached limiter so it rebuilds when connection recovers.
    redisLimiter = null;
  }
  if (!memoryLimiter) {
    memoryLimiter = new RateLimiterMemory({
      points: parsePoints(),
      duration: DOCLING_RATE_LIMIT_WINDOW_SECONDS,
      keyPrefix: DOCLING_RATE_LIMIT_KEY_PREFIX,
    });
  }
  return memoryLimiter;
}

/** Test seam — drops both cached limiters so the next call rebuilds. */
export function resetDoclingRateLimiter(): void {
  redisLimiter = null;
  memoryLimiter = null;
}
