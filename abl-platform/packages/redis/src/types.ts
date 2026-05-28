/**
 * Shared Redis Types
 *
 * Platform-wide type definitions for Redis connection configuration.
 * Decoupled from ioredis internals so consumers don't need to import ioredis directly.
 */

import type { Redis, Cluster, ClusterNode, ClusterOptions, RedisOptions } from 'ioredis';

// Re-export ioredis types consumers commonly need
export type { Redis, Cluster, ClusterNode, ClusterOptions, RedisOptions };

/**
 * Union type for any ioredis client (standalone or cluster).
 * Use this when you accept either mode.
 */
export type RedisClient = Redis | Cluster;

/**
 * TLS configuration for Redis connections.
 * Mirrors the platform's RedisConfigSchema.tls shape.
 */
export interface RedisTlsConfig {
  enabled: boolean;
  caFile?: string;
  certFile?: string;
  keyFile?: string;
  rejectUnauthorized?: boolean;
}

/**
 * Options for creating a Redis connection.
 *
 * Two modes:
 *   1. Provide `url` (redis:// or rediss://) — parsed into host/port/password.
 *   2. Provide `host` + `port` — direct connection.
 *
 * If neither is provided, falls back to localhost:DEFAULT_REDIS_PORT (6380).
 */
export interface RedisConnectionOptions {
  /** Full redis:// or rediss:// URL. Takes precedence over host/port. */
  url?: string;
  /** Redis host (default: 'localhost'). Ignored if `url` is provided. */
  host?: string;
  /** Redis port (default: DEFAULT_REDIS_PORT). Ignored if `url` is provided. */
  port?: number;
  /** Redis password. Overrides credentials embedded in `url` when both are provided. */
  password?: string;
  /** Redis database number (default: 0). */
  db?: number;
  /** TLS configuration. */
  tls?: RedisTlsConfig;
  /** Enable Redis Cluster mode. `url` becomes comma-separated host:port list. */
  cluster?: boolean;
  /**
   * Maximum retries per request before throwing.
   * - Set to a number (e.g., 3) for normal Redis commands.
   * - Set to `null` for BullMQ connections (blocking commands require infinite retries).
   * Default: 3.
   */
  maxRetriesPerRequest?: number | null;
  /** Enable lazy connection (don't connect until first command). Default: true. */
  lazyConnect?: boolean;
  /** Buffer commands while disconnected. Default: true. */
  enableOfflineQueue?: boolean;
  /**
   * Enable ioredis ready checks for standalone connections. Default is ioredis's
   * own default. Kept here so legacy direct-client call sites can migrate
   * without losing explicit connection behavior.
   */
  enableReadyCheck?: boolean;
}

/**
 * Lifecycle interface for Redis connection management.
 */
export interface RedisConnectionHandle {
  /** The ioredis client (standalone or cluster). */
  client: RedisClient;
  /** Whether the client is connected and ready. */
  isReady(): boolean;
  /** Duplicate the connection with optional overrides (e.g., for BullMQ). */
  duplicate(overrides?: Partial<RedisConnectionOptions>): RedisClient;
  /** Graceful disconnect. */
  disconnect(): Promise<void>;
  /**
   * Cluster seed nodes captured at construction.
   * Populated only when `client` is a Cluster instance; undefined otherwise.
   * Consumed by `createSubscriber` and `createBullMQPair` to construct
   * independent Cluster instances without re-parsing REDIS_URL.
   */
  readonly nodes?: ClusterNode[];
  /**
   * Base ioredis options captured at construction (TLS, password, etc).
   * Populated only when `client` is a Cluster instance; undefined otherwise.
   */
  readonly baseOptions?: Partial<RedisOptions>;
  /**
   * Safe serialization — redacts credentials so logging the handle never
   * exposes passwords or TLS key material.
   */
  toJSON?(): { mode: string; ready: boolean; nodeCount?: number };
}
