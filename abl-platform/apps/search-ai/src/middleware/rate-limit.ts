/**
 * Per-Tenant Rate Limiting Middleware (Search-AI)
 *
 * Fixed-window rate limiting scoped per tenant using an atomic Redis Lua script.
 * Falls back to in-memory Map when Redis is unavailable.
 *
 * Default: 120 requests/minute/tenant (Search-AI has fewer but heavier operations).
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  createRedisConnection,
  resolveRedisOptionsFromEnv,
  type RedisClient,
} from '@agent-platform/redis';

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

/** Default rate limit: requests per window per tenant */
const DEFAULT_LIMIT = safeParseInt(process.env.SEARCH_AI_RATE_LIMIT, 120);

/** Default window duration in milliseconds (1 minute) */
const DEFAULT_WINDOW_MS = safeParseInt(process.env.SEARCH_AI_RATE_WINDOW_MS, 60_000);

/** Redis key prefix to namespace rate-limit keys */
const KEY_PREFIX = 'search-ai:rl:';

/** Max entries in in-memory fallback Map */
const MAX_MEMORY_ENTRIES = safeParseInt(process.env.SEARCH_AI_RATE_MAX_MEMORY_ENTRIES, 10_000);

// =============================================================================
// IN-MEMORY FALLBACK
// =============================================================================

interface WindowEntry {
  count: number;
  resetAt: number;
}

const memoryWindows = new Map<string, WindowEntry>();

function memoryCheck(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  let entry = memoryWindows.get(key);

  if (!entry || now >= entry.resetAt) {
    // Evict if at capacity — prefer expired entries over active ones
    if (!memoryWindows.has(key) && memoryWindows.size >= MAX_MEMORY_ENTRIES) {
      let evicted = false;
      for (const [k, v] of memoryWindows) {
        if (now >= v.resetAt) {
          memoryWindows.delete(k);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        const oldest = memoryWindows.keys().next().value;
        if (oldest !== undefined) memoryWindows.delete(oldest);
      }
    }
    entry = { count: 0, resetAt: now + windowMs };
    memoryWindows.set(key, entry);
  }

  const resetMs = entry.resetAt - now;

  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, resetMs };
  }

  entry.count++;
  return { allowed: true, remaining: limit - entry.count, resetMs };
}

// =============================================================================
// REDIS CHECK
// =============================================================================

let redisClient: RedisClient | null = null;
let redisInitAttempted = false;
let redisLastFailureAt = 0;

/** Retry Redis connection after this interval on transient failures */
const REDIS_RECOVERY_INTERVAL_MS = safeParseInt(
  process.env.SEARCH_AI_REDIS_RECOVERY_INTERVAL_MS,
  30_000,
);

async function getRedisClient(): Promise<RedisClient | null> {
  if (redisClient) return redisClient;

  // Allow retry after recovery interval (don't permanently fall back to memory)
  if (redisInitAttempted) {
    if (Date.now() - redisLastFailureAt < REDIS_RECOVERY_INTERVAL_MS) return null;
    redisInitAttempted = false;
  }

  redisInitAttempted = true;

  const opts = resolveRedisOptionsFromEnv();
  if (!opts) return null;

  try {
    const handle = createRedisConnection({
      ...opts,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    // Clear stale reference on disconnect so recovery timer can reconnect.
    handle.client.on('error', () => {
      const stale = redisClient;
      redisClient = null;
      redisLastFailureAt = Date.now();
      try {
        stale?.disconnect();
      } catch {
        /* already closing */
      }
    });
    await handle.client.connect();
    redisClient = handle.client;
    return redisClient;
  } catch {
    redisClient = null;
    redisLastFailureAt = Date.now();
    return null;
  }
}

/**
 * Lua script: atomic INCR + conditional PEXPIRE + PTTL in a single round-trip.
 * KEYS[1] = rate-limit key, ARGV[1] = window in ms.
 * Sets PEXPIRE on the first increment (count === 1) to start the window,
 * and also self-heals orphaned keys (PTTL === -1) that lost their TTL due
 * to a crash during the old non-atomic code path.
 * Returns { count, ttl_ms }.
 */
const LUA_FIXED_WINDOW = `
local count = redis.call('INCR', KEYS[1])
local ttl
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
else
  ttl = redis.call('PTTL', KEYS[1])
  if ttl == -1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
    ttl = tonumber(ARGV[1])
  end
end
return {count, ttl}
`;

async function redisCheck(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; remaining: number; resetMs: number } | null> {
  const client = await getRedisClient();
  if (!client) return null;

  try {
    const redisKey = `${KEY_PREFIX}${key}`;
    // Single atomic Redis round-trip via Lua EVAL
    const result = (await client.call(
      'EVAL',
      LUA_FIXED_WINDOW,
      '1',
      redisKey,
      String(windowMs),
    )) as number[];
    const count = result[0];
    const resetMs = result[1] > 0 ? result[1] : windowMs;

    if (count > limit) {
      return { allowed: false, remaining: 0, resetMs };
    }

    return { allowed: true, remaining: limit - count, resetMs };
  } catch {
    return null; // fall back to memory
  }
}

// =============================================================================
// MIDDLEWARE FACTORY
// =============================================================================

export interface SearchAiRateLimitOptions {
  /** Max requests per window per tenant (default 120) */
  limit?: number;
  /** Window duration in milliseconds (default 60_000) */
  windowMs?: number;
  /**
   * Operation key to scope the rate limit counter.
   * When set, the Redis/memory key becomes `{tenantId}:{operation}`,
   * giving each operation its own independent counter.
   * Without this, all rate limiters share the same counter per tenant,
   * causing low-limit routers (e.g. preview: 10/min) to be exhausted
   * by high-traffic routes sharing the same global counter.
   */
  operation?: string;
}

/**
 * Per-tenant rate limiting middleware for Search-AI.
 * Uses Redis INCR when available, falls back to in-memory.
 */
export function searchAiRateLimit(options?: SearchAiRateLimitOptions): RequestHandler {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const operation = options?.operation;

  return (async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Tenant ID from auth middleware (set by createUnifiedAuthMiddleware)
    const tenantId = req.tenantContext?.tenantId;
    const baseKey = tenantId || req.ip || 'anon';
    // Scope the counter by operation when specified, so routers with
    // different limits don't share the same counter.
    const key = operation ? `${baseKey}:${operation}` : baseKey;

    // Try Redis first, fall back to memory
    let result = await redisCheck(key, limit, windowMs);
    if (!result) {
      result = memoryCheck(key, limit, windowMs);
    }

    // Set standard rate-limit headers
    res.set('X-RateLimit-Limit', String(limit));
    res.set('X-RateLimit-Remaining', String(result.remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil((Date.now() + result.resetMs) / 1000)));

    if (!result.allowed) {
      res.status(429).json({
        error: 'Rate limit exceeded',
        operation: 'request',
        limit,
        retryAfterMs: result.resetMs,
      });
      return;
    }

    next();
  }) as RequestHandler;
}
