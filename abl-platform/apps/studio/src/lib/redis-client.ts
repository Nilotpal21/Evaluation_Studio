/**
 * Redis Client Singleton for Studio
 *
 * Uses `globalThis` to store the singleton so it survives Next.js module
 * isolation (instrumentation.ts and route handlers load separate module
 * instances — module-level `let` variables are NOT shared between them).
 *
 * Call `initializeRedis()` once at server startup (instrumentation.ts).
 * After that, `getRedisClient()` / `isRedisAvailable()` work from any
 * module scope.
 */

import { createRedisConnection, resolveRedisOptionsFromConfig } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { isConfigLoaded, getConfig } from '@/config';

// Store client on globalThis so it's shared across all Next.js entry points
const GLOBAL_KEY = '__studio_redis_client__' as const;
const INIT_KEY = '__studio_redis_initialized__' as const;
const log = createLogger('studio:redis-client');

declare global {
  // eslint-disable-next-line no-var
  var __studio_redis_client__: any;
  // eslint-disable-next-line no-var
  var __studio_redis_initialized__: boolean;
}

/**
 * Initialize the Redis client (async — call once at startup).
 * Delegates to `createRedisConnection` from `@agent-platform/redis`
 * for cluster-aware connection handling.
 * Safe to call multiple times — only the first call has effect.
 */
export async function initializeRedis(): Promise<void> {
  if (globalThis[INIT_KEY]) return;

  try {
    if (!isConfigLoaded()) return;

    const config = getConfig();
    log.info('Studio Redis config loaded', {
      enabled: config.redis?.enabled,
      url: config.redis?.url ? config.redis.url.replace(/:[^@]+@/, ':***@') : undefined,
    });

    const opts = resolveRedisOptionsFromConfig(config.redis);
    if (!opts) {
      log.info('Studio Redis disabled');
      globalThis[INIT_KEY] = true;
      return;
    }

    log.info('Studio Redis connecting', {
      url: config.redis?.url ? config.redis.url.replace(/:[^@]+@/, ':***@') : 'default',
    });

    const handle = createRedisConnection({ ...opts, lazyConnect: false });
    const client = handle.client;

    client.on('error', (err: Error) => {
      log.error('Studio Redis connection error', { error: err.message });
    });

    client.on('connect', () => {
      log.info('Studio Redis connected');
    });

    // Do NOT null out client on failure — retryStrategy will keep reconnecting.
    // When lazyConnect is false, ioredis connects immediately but may fail
    // on first attempt. The built-in retryStrategy will keep reconnecting.

    globalThis[GLOBAL_KEY] = client;
    globalThis[INIT_KEY] = true;
  } catch (error) {
    log.warn('Studio Redis initialization failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Do NOT set INIT_KEY here — allow retry on next call
  }
}

/**
 * Get the shared Redis client (sync).
 * Returns null if Redis is unavailable.
 */
export function getRedisClient(): any | null {
  return globalThis[GLOBAL_KEY] ?? null;
}

/**
 * Check if Redis is available and connected.
 */
export function isRedisAvailable(): boolean {
  const client = globalThis[GLOBAL_KEY];
  return client != null && client.status === 'ready';
}

/**
 * Disconnect Redis client (for graceful shutdown).
 */
export async function disconnectRedis(): Promise<void> {
  const client = globalThis[GLOBAL_KEY];
  if (client) {
    await client.quit().catch((err: unknown) =>
      log.warn('Studio Redis disconnect failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    globalThis[GLOBAL_KEY] = null;
    globalThis[INIT_KEY] = false;
  }
}
