/**
 * Redis Singleton Manager
 *
 * Manages a shared Redis connection with:
 * - Async initialization (call once at startup)
 * - Sync getter (returns client or null)
 * - Graceful degradation (never crashes if Redis unavailable)
 * - Proper shutdown (quit + null out)
 * - Reset for testing
 *
 * Modeled after the Runtime pattern (apps/runtime/src/services/redis/redis-client.ts)
 * but generalized for any app.
 *
 * For apps using Next.js (Studio), use `createGlobalThisSingleton()` instead
 * to survive module isolation.
 */

import type { RedisClient, RedisConnectionOptions, RedisConnectionHandle } from './types.js';
import { createRedisConnection } from './connection.js';

// ---------------------------------------------------------------------------
// Singleton State
// ---------------------------------------------------------------------------

let handle: RedisConnectionHandle | null = null;
let initialized = false;
let initError: Error | null = null;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Initialize the shared Redis connection.
 *
 * Safe to call multiple times — only the first call has effect.
 * If Redis is unavailable, logs and returns without throwing.
 *
 * @param opts - Connection options (from env, config, or manual)
 * @param log  - Optional logger ({ info, warn, error } interface)
 */
export async function initializeRedis(
  opts: RedisConnectionOptions,
  log?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  },
): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    handle = createRedisConnection(opts);

    handle.client.on('error', (err: Error) => {
      if (log) {
        log.error('Redis connection error', { error: err.message });
      }
    });

    handle.client.on('connect', () => {
      if (log) {
        log.info('Redis connected');
      }
    });

    // Attempt connection. Do NOT null out handle on failure —
    // retryStrategy will keep reconnecting in background.
    // Both Redis and Cluster expose `.connect()`.
    await handle.client.connect().catch((err: Error) => {
      if (log) {
        log.warn('Redis initial connection failed, retryStrategy will reconnect', {
          error: err.message,
        });
      }
    });
  } catch (err) {
    initError = err instanceof Error ? err : new Error(String(err));
    handle = null;
    if (log) {
      log.warn('Redis initialization failed', { error: initError.message });
    }
  }
}

/**
 * Get the shared Redis client.
 * Returns null if not initialized or Redis unavailable.
 */
export function getRedisClient(): RedisClient | null {
  return handle?.client ?? null;
}

/**
 * Get the shared Redis connection handle.
 * Returns null if not initialized or Redis unavailable.
 *
 * Consumers needing pub/sub or BullMQ should call this and pass the handle
 * to `createSubscriber(handle)` or `createBullMQPair(handle)` — those helpers
 * use the handle's captured `nodes` + `baseOptions` to construct independent
 * Cluster instances when in cluster mode.
 */
export function getRedisHandle(): RedisConnectionHandle | null {
  return handle;
}

/**
 * Check if the shared Redis client is connected and ready.
 */
export function isRedisReady(): boolean {
  return handle?.isReady() ?? false;
}

/**
 * Return the error from the last failed `initializeRedis` call, or null if
 * initialization succeeded or hasn't been called yet. Useful for health-check
 * endpoints that want to surface the root cause when Redis is unavailable.
 */
export function getRedisInitError(): Error | null {
  return initError;
}

/**
 * Duplicate the shared Redis connection with optional overrides.
 * Returns null if the shared client is not available.
 *
 * Common use: `duplicate({ maxRetriesPerRequest: null })` for BullMQ.
 */
export function duplicateRedisClient(
  overrides?: Partial<RedisConnectionOptions>,
): RedisClient | null {
  if (!handle) return null;
  return handle.duplicate(overrides);
}

/**
 * Graceful disconnect. Call during app shutdown.
 */
export async function disconnectRedis(): Promise<void> {
  if (handle) {
    await handle.disconnect();
    handle = null;
    initialized = false;
    initError = null;
  }
}

/**
 * Reset all state. For testing only.
 */
export function resetRedisState(): void {
  handle = null;
  initialized = false;
  initError = null;
}
