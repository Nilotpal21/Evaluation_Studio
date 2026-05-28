/**
 * Redis Client Singleton
 *
 * Shared ioredis client used by:
 * - Circuit breaker store (F6)
 * - BullMQ job scheduler (F4)
 * - Future Redis-backed caches
 *
 * Supports TLS, Redis Cluster, and graceful fallback when unavailable.
 *
 * Call `initializeRedis()` once at server startup (async). After that,
 * `getRedisClient()` returns the client synchronously — no caller changes needed.
 */

import { isConfigLoaded, getConfig } from '../../config/loader.js';
import { createLogger } from '@abl/compiler/platform';
import {
  createRedisConnection,
  createSubscriber,
  resolveRedisOptionsFromConfig,
} from '@agent-platform/redis';
import type { RedisClient, RedisConnectionHandle } from '@agent-platform/redis';

const log = createLogger('redis-client');

let redisHandle: RedisConnectionHandle | null = null;
let initialized = false;

/**
 * Initialize the Redis client (async — call once at startup).
 * Delegates to the shared @agent-platform/redis factory which handles
 * standalone vs. cluster transparently.
 * Safe to call multiple times — only the first call has effect.
 */
export async function initializeRedis(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    if (!isConfigLoaded()) return;

    const config = getConfig();
    const opts = resolveRedisOptionsFromConfig(config.redis);
    if (!opts) return;

    redisHandle = createRedisConnection(opts);

    redisHandle.client.on('error', (err: Error) => {
      log.error('Redis connection error', { error: err.message });
    });

    redisHandle.client.on('connect', () => {
      log.info('Redis connected');
    });

    // Attempt connection (non-blocking — lazyConnect is true).
    // Do NOT clear redisHandle on failure — retryStrategy will keep reconnecting.
    await (redisHandle.client.connect() as Promise<void>).catch((err: Error) => {
      log.warn('Redis initial connection failed, retryStrategy will reconnect', {
        error: err.message,
      });
    });
  } catch (error) {
    log.warn('Redis initialization failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Alias for initializeRedis() — used by server startup code.
 */
export const ensureRedisInitialized = initializeRedis;

/**
 * Get the shared Redis client (sync).
 * Returns null if `initializeRedis()` hasn't been called or Redis is unavailable.
 *
 * Type is `RedisClient = Redis | Cluster`. Callers that need a Redis-specific
 * method (`.duplicate()`, multi-key `MULTI`/`EVAL` against multiple slots) must
 * either narrow via `instanceof Redis` or use the cluster-aware helpers in
 * `@agent-platform/redis` (`createSubscriber`, `createBullMQPair`, `runLuaScript`,
 * `scanKeys`). Use `getRedisHandle()` for the handle wrapper.
 */
export function getRedisClient(): RedisClient | null {
  return redisHandle ? redisHandle.client : null;
}

/**
 * Get the shared Redis connection handle (sync). Required for cluster-aware
 * helpers like `createSubscriber(handle)` and `createBullMQPair(handle)`.
 */
export function getRedisHandle(): RedisConnectionHandle | null {
  return redisHandle;
}

/**
 * Check if Redis is available and connected.
 */
export function isRedisAvailable(): boolean {
  return redisHandle !== null && redisHandle.client.status === 'ready';
}

/**
 * Disconnect Redis client (for graceful shutdown).
 *
 * Uses `quit()` when connected (sends QUIT command, waits for response).
 * Falls back to `disconnect()` when the client is reconnecting or not
 * connected — `quit()` would block waiting for a connection that may
 * never arrive (e.g. dummy Redis port in E2E tests).
 */
export async function disconnectRedis(): Promise<void> {
  if (redisHandle) {
    await redisHandle.disconnect().catch((err: unknown) =>
      log.warn('Redis disconnect failed', {
        error: err instanceof Error ? err.stack : String(err),
      }),
    );
    redisHandle = null;
    initialized = false;
  }
}

/**
 * Reset Redis state (for testing).
 */
export function resetRedisClient(): void {
  redisHandle = null;
  initialized = false;
}

/**
 * Create a duplicate Redis connection (for Pub/Sub subscriber).
 * Pub/Sub connections cannot be used for regular commands in ioredis.
 * Returns null if Redis is not available.
 */
export function createRedisSubscriber(): RedisClient | null {
  if (!redisHandle) return null;
  try {
    return createSubscriber(redisHandle);
  } catch (err) {
    log.warn('Failed to create subscriber connection', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
