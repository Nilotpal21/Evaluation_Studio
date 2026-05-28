/**
 * BullMQ Connection Helpers
 *
 * Provides properly configured Redis connections for BullMQ Queue and Worker
 * instances. Fixes the most common BullMQ Redis misconfiguration:
 *
 *   BullMQ Workers use blocking Redis commands (BRPOPLPUSH / XREADGROUP)
 *   which REQUIRE `maxRetriesPerRequest: null`. Without this, workers
 *   timeout prematurely and fail silently.
 *
 * Best practice (from workflow-engine + runtime):
 *   - Queue and Worker MUST use SEPARATE Redis connections
 *   - Both connections MUST have `maxRetriesPerRequest: null`
 *   - Duplicated connections MUST be explicitly disconnected on shutdown
 *     (BullMQ's .close() does NOT disconnect the underlying Redis)
 *
 * @module @agent-platform/redis/bullmq
 */

import { Redis, Cluster } from 'ioredis';
import type { ClusterNode, RedisOptions } from 'ioredis';
import type { ConnectionOptions } from 'bullmq';
import { DEFAULT_REDIS_PORT } from '@agent-platform/config/constants';
import type { RedisConnectionOptions, RedisClient, RedisConnectionHandle } from './types.js';
import { bullmqWatchdogRecover } from './observability.js';
import { DEFAULT_CLUSTER_OPTIONS, newCluster } from './connection.js';

export const BULLMQ_LEGACY_PREFIX = 'bull';
export const BULLMQ_CLUSTER_SAFE_PREFIX = '{bull}';

// ---------------------------------------------------------------------------
// BullMQ ConnectionOptions Builder
// ---------------------------------------------------------------------------

/**
 * Build BullMQ-compatible ConnectionOptions from RedisConnectionOptions.
 *
 * Sets `maxRetriesPerRequest: null` (required for BullMQ blocking commands).
 * Use this when you need to pass ConnectionOptions to `new Queue()` or
 * `new Worker()` without an existing ioredis client.
 */
export function createBullMQConnectionOptions(
  opts: RedisConnectionOptions = {},
): ConnectionOptions {
  const connOpts: ConnectionOptions = {
    maxRetriesPerRequest: null,
  };

  if (opts.url) {
    const parsed = new URL(opts.url);
    connOpts.host = parsed.hostname;
    connOpts.port = parsed.port ? parseInt(parsed.port, 10) : DEFAULT_REDIS_PORT;

    if (parsed.password) {
      connOpts.password = decodeURIComponent(parsed.password);
    }
    if (parsed.username && parsed.username !== 'default') {
      connOpts.username = decodeURIComponent(parsed.username);
    }
    if (parsed.protocol === 'rediss:') {
      connOpts.tls = {};
    }
    if (parsed.pathname && parsed.pathname.length > 1) {
      const dbNum = parseInt(parsed.pathname.substring(1), 10);
      if (!isNaN(dbNum)) {
        connOpts.db = dbNum;
      }
    }
  } else {
    connOpts.host = opts.host ?? 'localhost';
    connOpts.port = opts.port ?? DEFAULT_REDIS_PORT;
    if (opts.db) connOpts.db = opts.db;
  }

  if (opts.password) connOpts.password = opts.password;

  if (opts.tls?.enabled) {
    connOpts.tls = {};
  }

  return connOpts;
}

// ---------------------------------------------------------------------------
// BullMQ Connection Pair (from existing ioredis client)
// ---------------------------------------------------------------------------

/**
 * A pair of Redis connections for BullMQ Queue + Worker.
 *
 * Both connections have `maxRetriesPerRequest: null` as required by BullMQ.
 * Queue and Worker use SEPARATE connections to prevent blocking command
 * interference (BullMQ best practice).
 */
export interface BullMQConnectionPair {
  /** Connection for BullMQ Queue (job enqueuing). */
  queueConnection: RedisClient;
  /** Connection for BullMQ Worker (job processing). */
  workerConnection: RedisClient;
  /**
   * Disconnect both connections.
   * Call this AFTER `worker.close()` and `queue.close()` —
   * BullMQ's `.close()` does NOT disconnect the underlying Redis.
   */
  disconnect(): void;
}

/**
 * Create a BullMQ connection pair from an existing standalone ioredis client.
 *
 * This is kept for backward compatibility with older standalone-only call
 * sites. New code should prefer `createBullMQPair(handle)`, because the handle
 * retains the cluster seed nodes required to build independent Cluster
 * instances for Queue and Worker connections.
 *
 * In standalone mode this follows the historical pattern:
 *   1. Duplicate the base client with `maxRetriesPerRequest: null`
 *   2. Use separate duplicates for Queue and Worker
 *   3. Explicitly disconnect duplicates on shutdown
 *
 * @param redis - An existing ioredis client (e.g., from `getRedisClient()`)
 * @returns A pair of connections ready for BullMQ Queue and Worker
 * @deprecated Prefer `createBullMQPair(handle)` for standalone + cluster support.
 *
 * @example
 * ```typescript
 * const redis = getRedisClient();
 * if (redis) {
 *   const pair = createBullMQConnectionPair(redis);
 *   const queue = new Queue('my-queue', { connection: pair.queueConnection });
 *   const worker = new Worker('my-queue', handler, { connection: pair.workerConnection });
 *
 *   // Shutdown:
 *   await worker.close();
 *   await queue.close();
 *   pair.disconnect(); // MUST call — BullMQ doesn't disconnect Redis
 * }
 * ```
 */
export function createBullMQConnectionPair(redis: RedisClient): BullMQConnectionPair {
  if (redis instanceof Cluster) {
    throw new Error(
      'createBullMQConnectionPair: Cluster client passed in but no handle is available. ' +
        'Use createBullMQPair(handle) instead — Cluster does not expose .duplicate().',
    );
  }
  const queueConnection = redis.duplicate({ maxRetriesPerRequest: null });
  const workerConnection = redis.duplicate({ maxRetriesPerRequest: null });

  return {
    queueConnection,
    workerConnection,
    disconnect() {
      queueConnection.disconnect();
      workerConnection.disconnect();
    },
  };
}

// ---------------------------------------------------------------------------
// Mode-aware BullMQ Connection Pair (from RedisConnectionHandle)
// ---------------------------------------------------------------------------

/**
 * BullMQ connections must use brace-wrapped queue prefixes in cluster mode so
 * all keys for a queue share a hash slot. Default BullMQ wraps the queue name
 * already; only consumers passing a custom `prefix` need to wrap it themselves
 * (e.g., `prefix: '{bull}'` instead of `prefix: 'bull'`). See BullMQ docs:
 * https://docs.bullmq.io/bull/patterns/redis-cluster
 */
export interface CreateBullMQPairOptions {
  /**
   * If true, start a 5s interval that polls the Worker connection's status.
   * If stuck > 30s, replace the worker connection. Mitigates BullMQ #2964
   * (cluster-mode worker stalls after Redis reconnect).
   *
   * Default: `false` for standalone, `true` for cluster mode.
   * Pass `false` explicitly to opt out in cluster mode.
   */
  watchdog?: boolean;
}

/**
 * Resolve the BullMQ key prefix for the current Redis mode.
 *
 * Standalone keeps BullMQ's historical `bull` prefix for backward
 * compatibility with existing queues. Cluster mode must use a hash-tagged
 * prefix so BullMQ Lua scripts touch keys in one Redis slot.
 */
export interface BullMQPrefixOptions {
  /**
   * Prefix to use for standalone Redis. Defaults to BullMQ's historical
   * `bull` prefix. Existing queues that already used `{bull}` should pass
   * `BULLMQ_CLUSTER_SAFE_PREFIX` to avoid stranding standalone jobs.
   */
  standalonePrefix?: string;
}

export function getBullMQPrefix(
  redis: RedisConnectionHandle | RedisClient,
  opts: BullMQPrefixOptions = {},
): string {
  const maybeHandle = redis as RedisConnectionHandle;
  const client = typeof maybeHandle.isReady === 'function' ? maybeHandle.client : redis;
  return client instanceof Cluster
    ? BULLMQ_CLUSTER_SAFE_PREFIX
    : (opts.standalonePrefix ?? BULLMQ_LEGACY_PREFIX);
}

/**
 * Create a BullMQ Queue + Worker connection pair from a RedisConnectionHandle.
 *
 * **Standalone path**: duplicates the handle's client twice with
 * `maxRetriesPerRequest: null` (verbatim previous behavior).
 *
 * **Cluster path**: constructs two fresh `Cluster` instances from the handle's
 * captured `nodes` + `baseOptions`. ioredis Cluster has no `.duplicate()`.
 *
 * Both paths return objects whose connection types are `RedisClient`
 * (= `Redis | Cluster`). BullMQ accepts a `Cluster` instance at runtime; the
 * widened type matches the runtime contract.
 *
 * @param handle The base connection handle (from `getRedisHandle()` or
 *   `createRedisConnection()`)
 * @param opts   Optional `{ watchdog }` toggle
 */
export function createBullMQPair(
  handle: RedisConnectionHandle,
  opts: CreateBullMQPairOptions = {},
): BullMQConnectionPair {
  const isCluster = handle.client instanceof Cluster;
  const watchdogEnabled = opts.watchdog ?? isCluster;

  let queueConnection: RedisClient;
  let workerConnection: RedisClient;

  if (handle.client instanceof Redis) {
    queueConnection = handle.client.duplicate({ maxRetriesPerRequest: null });
    workerConnection = handle.client.duplicate({ maxRetriesPerRequest: null });
  } else if (handle.client instanceof Cluster) {
    if (!handle.nodes || !handle.baseOptions) {
      throw new Error(
        'createBullMQPair: cluster handle missing `nodes` or `baseOptions`. ' +
          'This indicates the connection was not constructed via createRedisConnection().',
      );
    }
    queueConnection = buildClusterForBullMQ(handle.nodes, handle.baseOptions);
    workerConnection = buildClusterForBullMQ(handle.nodes, handle.baseOptions);
  } else {
    throw new Error('createBullMQPair: handle.client is not a Redis or Cluster instance');
  }

  let watchdogTimer: NodeJS.Timeout | undefined;
  if (watchdogEnabled) {
    watchdogTimer = startWorkerWatchdog(workerConnection);
  }

  return {
    queueConnection,
    workerConnection,
    disconnect() {
      if (watchdogTimer) clearInterval(watchdogTimer);
      queueConnection.disconnect();
      workerConnection.disconnect();
    },
  };
}

function buildClusterForBullMQ(nodes: ClusterNode[], baseOptions: Partial<RedisOptions>): Cluster {
  const merged: Partial<RedisOptions> = {
    ...baseOptions,
    maxRetriesPerRequest: null,
  };
  return newCluster(nodes, {
    ...DEFAULT_CLUSTER_OPTIONS,
    redisOptions: merged,
  });
}

const WATCHDOG_POLL_MS = 5_000;
const WATCHDOG_STUCK_THRESHOLD_MS = 30_000;

function startWorkerWatchdog(connection: RedisClient): NodeJS.Timeout {
  let stuckSince: number | null = null;
  const timer = setInterval(() => {
    const status = connection.status;
    const isHealthy = status === 'ready' || status === 'connecting' || status === 'reconnecting';
    if (isHealthy) {
      stuckSince = null;
      return;
    }
    const now = Date.now();
    if (stuckSince === null) {
      stuckSince = now;
      return;
    }
    if (now - stuckSince > WATCHDOG_STUCK_THRESHOLD_MS) {
      // Force a reconnect cycle. ioredis emits 'error' but will reconnect.
      try {
        connection.disconnect();
        bullmqWatchdogRecover.add(1);
      } catch (err) {
        // Persistent failures are observable via the next stuck-cycle counter
        // increment; emit a structured event for log-based correlation.
        bullmqWatchdogRecover.add(1, {
          outcome: 'disconnect_threw',
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
      stuckSince = now; // reset window after attempted recovery
    }
  }, WATCHDOG_POLL_MS);
  // Don't keep the event loop alive solely for the watchdog.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------
// Environment-Based BullMQ ConnectionOptions
// ---------------------------------------------------------------------------

/**
 * Build BullMQ ConnectionOptions directly from environment variables.
 *
 * Convenience function for apps that don't use the centralized config system
 * (e.g., SearchAI workers, multimodal-service).
 *
 * Reads: REDIS_URL, REDIS_HOST, REDIS_PORT, REDIS_CLUSTER.
 * Always sets `maxRetriesPerRequest: null`.
 *
 * Returns null if:
 *  - REDIS_ENABLED=false, OR
 *  - REDIS_CLUSTER=true (cluster mode requires constructing a Cluster instance;
 *    callers must use `createBullMQPair(handle)` against a handle from
 *    `createRedisConnection({ url, cluster: true })`).
 */
export function resolveBullMQConnectionFromEnv(
  env: Record<string, string | undefined> = process.env,
): ConnectionOptions | null {
  if (env.REDIS_ENABLED === 'false') return null;
  if (env.REDIS_CLUSTER === 'true') {
    // Cluster mode requires constructing a Cluster instance via createBullMQPair(handle).
    // Returning null here silently disables BullMQ for callers that don't check the return.
    // This is intentional — see the JSDoc above.
    return null;
  }

  const opts: RedisConnectionOptions = {};
  if (env.REDIS_URL) opts.url = env.REDIS_URL;
  if (env.REDIS_HOST) opts.host = env.REDIS_HOST;
  if (env.REDIS_PORT) opts.port = parseInt(env.REDIS_PORT, 10);
  if (env.REDIS_PASSWORD) opts.password = env.REDIS_PASSWORD;

  return createBullMQConnectionOptions(opts);
}

// ---------------------------------------------------------------------------
// Default Worker Options
// ---------------------------------------------------------------------------

/**
 * Standard BullMQ worker options used across the platform.
 *
 * Provides sane defaults for:
 * - `removeOnComplete`: 24 hours (prevents unbounded growth)
 * - `removeOnFail`: 7 days (keeps failed jobs for debugging)
 * - `concurrency`: configurable (default 5)
 *
 * Does NOT include `connection` — pass that separately.
 */
export function defaultWorkerOptions(concurrency = 5): {
  concurrency: number;
  prefix: string;
  removeOnComplete: { age: number };
  removeOnFail: { age: number };
} {
  return {
    concurrency,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    removeOnComplete: { age: 86_400 }, // 24 hours
    removeOnFail: { age: 604_800 }, // 7 days
  };
}
