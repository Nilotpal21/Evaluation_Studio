/**
 * Rate Limiter (Redis → In-Memory Fallback)
 *
 * Uses Redis sorted-set sliding window when available (shared across pods).
 * Falls back to in-memory Map when Redis is unavailable.
 *
 * Same Lua script pattern as runtime's RedisRateLimiter.
 */

import { isRedisAvailable, getRedisClient } from '@/lib/redis-client';
import { runLuaScript, type LuaScript } from '@agent-platform/redis';

// ---------------------------------------------------------------------------
// In-Memory Fallback
// ---------------------------------------------------------------------------

/** Max entries in in-memory fallback Map */
const MAX_MEMORY_ENTRIES = 10_000;

const attempts = new Map<string, { count: number; resetAt: number }>();

function checkInMemory(
  key: string,
  maxAttempts: number,
  windowMs: number,
): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now > entry.resetAt) {
    // Evict if at capacity — prefer expired entries over active ones
    if (!attempts.has(key) && attempts.size >= MAX_MEMORY_ENTRIES) {
      let evicted = false;
      for (const [k, v] of attempts) {
        if (now > v.resetAt) {
          attempts.delete(k);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        const oldest = attempts.keys().next().value;
        if (oldest !== undefined) attempts.delete(oldest);
      }
    }
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (entry.count >= maxAttempts) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count++;
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Redis Lua Script (atomic sliding window)
// ---------------------------------------------------------------------------

const LUA_SLIDING_WINDOW: LuaScript = {
  name: 'studio-rate-limit-sliding-window',
  body: `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local id = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)

local count = redis.call('ZCARD', key)

if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetMs = windowMs
  if #oldest >= 2 then
    resetMs = tonumber(oldest[2]) + windowMs - now
    if resetMs < 0 then resetMs = 0 end
  end
  return {0, resetMs}
end

redis.call('ZADD', key, now, id)

local ttlSeconds = math.ceil(windowMs / 1000) + 10
redis.call('EXPIRE', key, ttlSeconds)

return {1, 0}
`,
  numberOfKeys: 1,
};

async function checkRedis(
  key: string,
  maxAttempts: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const redis = getRedisClient();
  const now = Date.now();
  const id = `${now}:${Math.random().toString(36).substring(2, 8)}`;
  const redisKey = `rl:studio:${key}`;

  // runLuaScript wraps Redis EVAL with cluster-safe NOSCRIPT fallback
  const result = await runLuaScript<number[]>(
    redis,
    LUA_SLIDING_WINDOW,
    [redisKey],
    [windowMs, now, maxAttempts, id],
  );

  if (result[0] === 1) {
    return { allowed: true };
  }
  return { allowed: false, retryAfter: Math.ceil(result[1] / 1000) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Async rate limit check — uses Redis when available, falls back to in-memory.
 * Redis is the primary gatekeeper for cross-pod consistency.
 * In-memory is only used when Redis is unavailable.
 */
export async function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfter?: number }> {
  if (isRedisAvailable()) {
    try {
      return await checkRedis(key, maxAttempts, windowMs);
    } catch (err) {
      console.warn('[RateLimit] Redis error, falling back to in-memory:', err);
    }
  }
  return checkInMemory(key, maxAttempts, windowMs);
}
