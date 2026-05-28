/**
 * Workflow Engine — Redis Connection
 *
 * Provides the raw ioredis client used by the inline publisher adapter in
 * `index.ts` for pub/sub event broadcasting. Gracefully degrades when Redis is
 * unavailable — workflow execution continues without live events.
 *
 * Cluster-aware: delegates connection construction to the shared
 * @agent-platform/redis factory so REDIS_CLUSTER=true transparently
 * builds a Cluster instance instead of a standalone client.
 */

import { createLogger } from '@abl/compiler/platform';
import { createRedisConnection, resolveRedisOptionsFromEnv } from '@agent-platform/redis';
import type { RedisClient, RedisConnectionHandle } from '@agent-platform/redis';

const log = createLogger('workflow-engine:redis');

let redisHandle: RedisConnectionHandle | null = null;

const DEFAULT_REDIS_URL = 'redis://localhost:6380';

/**
 * Initialize the Redis connection. Call once at startup.
 *
 * Graceful degradation: if Redis is unavailable, logs a warning and
 * continues without crashing. Pub/sub events will be silently skipped.
 */
export async function initRedis(): Promise<void> {
  const opts = resolveRedisOptionsFromEnv() ?? {};
  if (!opts.url && !opts.host) {
    opts.url = process.env.REDIS_URL || DEFAULT_REDIS_URL;
  }

  redisHandle = createRedisConnection(opts);

  redisHandle.client.on('error', (err: unknown) => {
    log.error('Redis connection error', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  try {
    await (redisHandle.client.connect() as Promise<void>);
    log.info('Redis connected', {
      url: (opts.url ?? `${opts.host}:${opts.port ?? 6380}`).replace(/\/\/.*@/, '//***@'),
      cluster: opts.cluster === true,
    });
  } catch (err) {
    log.warn('Redis initial connection failed, retryStrategy will reconnect', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Returns the Redis client, or null if not connected.
 *
 * Returns `RedisClient` (= `Redis | Cluster`) — call sites that previously
 * received `Redis` should accept the wider type, or use `getRedisHandle()`
 * and the helpers in `@agent-platform/redis` for cluster-safe operations.
 */
export function getRedisClient(): RedisClient | null {
  return redisHandle ? redisHandle.client : null;
}

/**
 * Returns the shared Redis connection handle, or null if not connected.
 * Required for cluster-aware helpers like `createBullMQPair(handle)` and
 * `createSubscriber(handle)`.
 */
export function getRedisHandle(): RedisConnectionHandle | null {
  return redisHandle;
}

/**
 * Active reachability check for the readiness probe. Returns true only when
 * a client exists and `PING` succeeds within the timeout. Callers (the
 * pipeline-health poller) treat any other outcome as unhealthy.
 */
export async function pingRedis(timeoutMs = 2_000): Promise<boolean> {
  if (!redisHandle) return false;
  try {
    const result = await Promise.race<string | undefined>([
      redisHandle.client.ping(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
    ]);
    return result === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Gracefully disconnect from Redis. Call during shutdown.
 */
export async function disconnectRedis(): Promise<void> {
  if (redisHandle) {
    await redisHandle.disconnect().catch((err: unknown) => {
      log.warn('Redis disconnect error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    redisHandle = null;
    log.info('Redis disconnected');
  }
}
