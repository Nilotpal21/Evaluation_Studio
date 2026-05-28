/**
 * @agent-platform/redis
 *
 * Shared Redis connection factory and BullMQ helpers.
 *
 * ## Quick Start
 *
 * ### For apps using centralized config (Runtime, Studio):
 * ```typescript
 * import { initializeRedis, getRedisClient } from '@agent-platform/redis';
 * import { resolveRedisOptionsFromConfig } from '@agent-platform/redis';
 *
 * const opts = resolveRedisOptionsFromConfig(config.redis);
 * if (opts) await initializeRedis(opts, log);
 *
 * const redis = getRedisClient(); // Redis | null
 * ```
 *
 * ### For apps reading env vars directly (SearchAI, Multimodal):
 * ```typescript
 * import { resolveRedisOptionsFromEnv, createRedisConnection } from '@agent-platform/redis';
 *
 * const opts = resolveRedisOptionsFromEnv();
 * if (opts) {
 *   const handle = createRedisConnection(opts);
 *   // use handle.client, handle.duplicate(), handle.disconnect()
 * }
 * ```
 *
 * ### For BullMQ Queue + Worker:
 * ```typescript
 * import { createBullMQPair } from '@agent-platform/redis/bullmq';
 *
 * const handle = getRedisHandle();
 * if (!handle) throw new Error('Redis unavailable');
 * const pair = createBullMQPair(handle);
 * const queue = new Queue('name', { connection: pair.queueConnection });
 * const worker = new Worker('name', fn, { connection: pair.workerConnection });
 *
 * // Shutdown:
 * await worker.close();
 * await queue.close();
 * pair.disconnect();
 * ```
 *
 * @module @agent-platform/redis
 */

// Connection factory (stateless)
export {
  createRedisConnection,
  resolveRedisOptionsFromEnv,
  resolveRedisOptionsFromConfig,
} from './connection.js';

// Singleton manager (stateful — for apps that need a shared client)
export {
  initializeRedis,
  getRedisClient,
  getRedisHandle,
  isRedisReady,
  getRedisInitError,
  duplicateRedisClient,
  disconnectRedis,
  resetRedisState,
} from './singleton.js';

// Types
export type {
  Redis,
  Cluster,
  ClusterNode,
  ClusterOptions,
  RedisOptions,
  RedisClient,
  RedisTlsConfig,
  RedisConnectionOptions,
  RedisConnectionHandle,
} from './types.js';

// BullMQ helpers (also available via '@agent-platform/redis/bullmq')
export {
  createBullMQConnectionOptions,
  createBullMQConnectionPair,
  createBullMQPair,
  resolveBullMQConnectionFromEnv,
  defaultWorkerOptions,
  getBullMQPrefix,
  BULLMQ_LEGACY_PREFIX,
  BULLMQ_CLUSTER_SAFE_PREFIX,
} from './bullmq.js';

export type { BullMQConnectionPair, CreateBullMQPairOptions } from './bullmq.js';

// Mode-aware helpers (Phase 0)
export { createSubscriber } from './subscriber.js';
export { runLuaScript } from './lua.js';
export type { LuaScript } from './lua.js';
export { hashTag, scanKeys } from './keys.js';
export { RedisOperationError, RedisCrossSlotError } from './errors.js';
