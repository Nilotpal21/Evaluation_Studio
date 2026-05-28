/**
 * Redis-Backed Rate Limiter
 *
 * Uses Redis SORTED SET sliding window with Lua script for atomic check+increment.
 * Key layout: `rl:{tenantId}:{operation}` — ZSET with score=timestamp.
 */

import type { RateLimitOperation } from '../../middleware/rate-limiter.js';
import { runLuaScript, type LuaScript } from '@agent-platform/redis';

// Lua script for atomic sliding window check+increment.
// KEYS[1] = rate limit key
// ARGV[1] = windowMs, ARGV[2] = now (ms), ARGV[3] = limit, ARGV[4] = increment, ARGV[5] = requestIdPrefix
//
// Returns: [allowed (0/1), remaining, resetMs]
const LUA_SLIDING_WINDOW: LuaScript = {
  name: 'rate-limit-sliding-window',
  body: `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local increment = tonumber(ARGV[4])
local idPrefix = ARGV[5]

-- Remove expired entries
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)

-- Count current entries
local count = redis.call('ZCARD', key)
local remaining = limit - count

if count + increment > limit then
  -- Rate limit exceeded
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetMs = windowMs
  if #oldest >= 2 then
    resetMs = tonumber(oldest[2]) + windowMs - now
    if resetMs < 0 then resetMs = 0 end
  end
  return {0, math.max(0, remaining), resetMs}
end

-- Add new entries (batch ZADD to avoid O(increment) individual calls)
local args = {}
for i = 1, increment do
  args[#args + 1] = now
  args[#args + 1] = idPrefix .. ':' .. tostring(i) .. ':' .. tostring(now)
end
redis.call('ZADD', key, unpack(args))

-- Set TTL slightly longer than window to auto-cleanup
local ttlSeconds = math.ceil(windowMs / 1000) + 10
redis.call('EXPIRE', key, ttlSeconds)

remaining = limit - count - increment
return {1, math.max(0, remaining), windowMs}
`,
  numberOfKeys: 1,
};

export class RedisRateLimiter {
  private redisClient: any; // ioredis client (Redis | Cluster)

  constructor(redisClient: any) {
    this.redisClient = redisClient;
  }

  /**
   * Check and increment a rate limit counter.
   * Returns { allowed, remaining, resetMs }.
   */
  async check(
    tenantId: string,
    operation: RateLimitOperation,
    limit: number,
    windowMs = 60000,
    increment = 1,
  ): Promise<{ allowed: boolean; remaining: number; resetMs: number }> {
    const key = `rl:${tenantId}:${operation}`;
    const now = Date.now();
    const idPrefix = `${now}:${Math.random().toString(36).substring(2, 8)}`;

    // runLuaScript handles EVALSHA + NOSCRIPT fallback transparently
    const result = await runLuaScript<number[]>(
      this.redisClient,
      LUA_SLIDING_WINDOW,
      [key],
      [windowMs, now, limit, increment, idPrefix],
    );

    return {
      allowed: result[0] === 1,
      remaining: result[1],
      resetMs: result[2],
    };
  }

  /**
   * Get current count without incrementing.
   */
  async peek(tenantId: string, operation: RateLimitOperation, windowMs = 60000): Promise<number> {
    const key = `rl:${tenantId}:${operation}`;
    const now = Date.now();

    try {
      // Remove expired, then count
      await this.redisClient.zremrangebyscore(key, 0, now - windowMs);
      return await this.redisClient.zcard(key);
    } catch {
      return 0;
    }
  }
}
