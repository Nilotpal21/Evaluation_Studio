import { createLogger } from '@abl/compiler/platform';
import { runLuaScript, type LuaScript, type RedisClient } from '@agent-platform/redis';
const log = createLogger('rate-limiter');

export interface RateLimitConfig {
  maxTransfers: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

const DEFAULT_CONFIG: RateLimitConfig = { maxTransfers: 100, windowMs: 60_000 };

/**
 * Lua script that atomically checks the rate limit and only adds a new entry
 * when the limit has not been exceeded. This prevents memory amplification
 * from rejected requests inflating the sorted set.
 *
 * KEYS[1] = rate limit sorted set key
 * ARGV[1] = windowStart (entries older than this are pruned)
 * ARGV[2] = maxTransfers (limit)
 * ARGV[3] = now (score for the new entry)
 * ARGV[4] = member (unique entry value)
 * ARGV[5] = windowMs (TTL for the key in milliseconds)
 *
 * Returns: count + 1 if allowed, -1 if rejected
 */
const SCRIPT_RATE_CHECK: LuaScript = {
  name: 'agent_transfer.rate_check',
  numberOfKeys: 1,
  body: `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
local count = redis.call('ZCARD', KEYS[1])
if count < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return count + 1
end
return -1
`,
};

export async function checkRateLimit(
  redis: RedisClient,
  tenantId: string,
  config: RateLimitConfig = DEFAULT_CONFIG,
): Promise<RateLimitResult> {
  const key = `at_ratelimit:${tenantId}`;
  const now = Date.now();
  const windowStart = now - config.windowMs;
  const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;

  const result = await runLuaScript<number>(
    redis,
    SCRIPT_RATE_CHECK,
    [key],
    [
      windowStart.toString(),
      config.maxTransfers.toString(),
      now.toString(),
      member,
      config.windowMs.toString(),
    ],
  );

  const allowed = result !== -1;
  const count = allowed ? result : config.maxTransfers;

  if (!allowed) {
    log.warn('Rate limit exceeded', { tenantId, count, max: config.maxTransfers });
  }

  return {
    allowed,
    remaining: Math.max(0, config.maxTransfers - count),
    resetMs: config.windowMs,
  };
}
