/**
 * Session Lock Utilities
 *
 * Distributed per-session lock using Redis SET NX + TTL.
 * Prevents concurrent message processing on the same runtime session.
 *
 * The release uses a Lua script to verify ownership before deleting,
 * preventing one caller from releasing another caller's lock.
 */

import { createLogger } from '@abl/compiler/platform';
import { runLuaScript, type LuaScript } from '@agent-platform/redis';

const log = createLogger('session-lock');

// Lua script: only delete the key if the stored value matches the owner
const RELEASE_SCRIPT: LuaScript = {
  name: 'session-lock-release',
  body: `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`,
  numberOfKeys: 1,
};

/**
 * Acquire a per-session lock to serialize message processing.
 * Polls every 500ms, gives up after 120 attempts (60s).
 * Lock auto-expires after 120s (TTL) to handle worker crashes.
 */
export async function acquireSessionLock(lockKey: string, lockOwner: string): Promise<boolean> {
  try {
    const { getRedisClient } = await import('../redis/redis-client.js');
    const redis = getRedisClient();
    if (!redis) {
      log.warn('Redis unavailable - session lock denied (degraded mode)', { lockKey, lockOwner });
      return false;
    }

    const maxAttempts = 120; // 120 * 500ms = 60s max wait
    for (let i = 0; i < maxAttempts; i++) {
      const result = await redis.set(lockKey, lockOwner, 'EX', 120, 'NX');
      if (result === 'OK') return true;
      if (i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    log.error('Session lock acquisition timed out', { lockKey, lockOwner });
    return false;
  } catch (err) {
    log.warn('Redis error during lock acquisition - session lock denied (degraded mode)', {
      lockKey,
      lockOwner,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Release a per-session lock after processing completes.
 * Uses a Lua script to verify ownership before deleting — prevents
 * one caller from accidentally releasing another caller's lock.
 */
export async function releaseSessionLock(lockKey: string, lockOwner: string): Promise<void> {
  try {
    const { getRedisClient } = await import('../redis/redis-client.js');
    const redis = getRedisClient();
    if (redis) {
      await runLuaScript(redis, RELEASE_SCRIPT, [lockKey], [lockOwner]);
    }
  } catch {
    // Lock will auto-expire via TTL
  }
}
