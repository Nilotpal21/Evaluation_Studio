/**
 * Distributed Redis Lock for Token Refresh
 *
 * Prevents concurrent refresh of the same token across multiple pods.
 * Uses Redis SET NX PX for atomic lock acquisition.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@agent-platform/shared-observability';
import type { RedisClient } from '@agent-platform/redis';
import { runLuaScript, type LuaScript } from '@agent-platform/redis';

const log = createLogger('refresh-lock');

const RELEASE_LOCK_SCRIPT: LuaScript = {
  name: 'auth-profile-refresh-lock-release',
  body: `
          if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("DEL", KEYS[1])
          end
          return 0
        `,
  numberOfKeys: 1,
};

const LOCK_TTL_MS = 30_000;
const LOCK_PREFIX = 'auth-profile:op-lock:';

export interface LockDeps {
  redis: RedisClient;
}

export interface RefreshLock {
  acquired: boolean;
  lockKey: string;
  release: () => Promise<void>;
}

/**
 * Attempt to acquire a distributed lock for token refresh.
 */
export async function acquireRefreshLock(
  profileId: string,
  tenantId: string,
  deps: LockDeps,
): Promise<RefreshLock> {
  const lockKey = `${LOCK_PREFIX}${tenantId}:${profileId}`;
  const lockValue = randomUUID();
  let acquired = false;

  try {
    const result = await deps.redis.set(lockKey, lockValue, 'PX', LOCK_TTL_MS, 'NX');
    acquired = result === 'OK';
  } catch (err) {
    log.warn('refresh_lock_unavailable', {
      profileId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    acquired,
    lockKey,
    release: async () => {
      if (acquired) {
        await runLuaScript(deps.redis, RELEASE_LOCK_SCRIPT, [lockKey], [lockValue]).catch((err) => {
          log.warn('refresh_lock_release_failed', {
            lockKey,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    },
  };
}
