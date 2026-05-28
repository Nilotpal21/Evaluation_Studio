/**
 * Redis Connection Factory
 *
 * Creates and manages ioredis connections with:
 * - URL or host/port configuration
 * - TLS support (CA, cert, key files)
 * - Cluster mode (comma-separated nodes)
 * - Graceful degradation (returns null if Redis unavailable)
 * - Proper retry strategy (never gives up reconnecting)
 * - Connection duplication for BullMQ (maxRetriesPerRequest: null)
 *
 * Follows patterns from:
 * - Runtime redis-client.ts (TLS, cluster, retryStrategy)
 * - Workflow-engine redis.ts (graceful degradation, lazyConnect)
 * - Workflow-engine trigger-scheduler.ts (duplicate for BullMQ)
 */

import fs from 'node:fs';
import net from 'node:net';
import { Redis } from 'ioredis';
import type { Cluster, ClusterNode, ClusterOptions, RedisOptions } from 'ioredis';
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import { DEFAULT_REDIS_PORT } from '@agent-platform/config/constants';
import type {
  RedisClient,
  RedisConnectionOptions,
  RedisConnectionHandle,
  RedisTlsConfig,
} from './types.js';
import { clusterFailover, clusterNodeError } from './observability.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES_PER_REQUEST = 3;

/**
 * Cluster constructor options shared by `createRedisConnection` and
 * `RedisConnectionHandle.duplicate()`. Tuned for a 5s cluster-node-timeout:
 *  - maxRedirections 16 × ~500ms refresh ≈ 8s budget per command.
 *  - retryDelayOnMoved 50ms avoids ping-pong storms during slot transitions.
 *  - slotsRefreshTimeout 1000ms is the ioredis default.
 *  - enableOfflineQueue: true mirrors standalone default; runbook flags
 *    memory pressure under sustained partitions.
 *
 * Callers add `redisOptions` (and optionally `lazyConnect`) on top.
 */
export const DEFAULT_CLUSTER_OPTIONS: Omit<ClusterOptions, 'redisOptions'> = {
  maxRedirections: 16,
  slotsRefreshTimeout: 1000,
  retryDelayOnFailover: 500,
  retryDelayOnMoved: 50,
  scaleReads: 'master',
  enableOfflineQueue: true,
};

/**
 * Construct an ioredis Cluster. Encapsulates the `as unknown as` cast required
 * because `Redis.Cluster`'s exported type doesn't expose its constructor in a
 * `new`-callable form via the named import. This is the single point at which
 * the cast lives — every consumer that needs a Cluster goes through here.
 */
export function newCluster(nodes: ClusterNode[], options: ClusterOptions): Cluster {
  const ClusterClass = Redis.Cluster as unknown as new (
    nodes: ClusterNode[],
    options: ClusterOptions,
  ) => Cluster;
  return new ClusterClass(nodes, options);
}

// ---------------------------------------------------------------------------
// Retry Strategy (shared across all connections)
// ---------------------------------------------------------------------------

/**
 * Default retry strategy: linear backoff capped at 5s, never gives up.
 *
 * Returning `null` from retryStrategy tells ioredis to stop reconnecting,
 * which is almost never what you want. The correct approach is to always
 * return a delay value.
 */
function defaultRetryStrategy(times: number): number {
  return Math.min(times * 200, 5000);
}

// ---------------------------------------------------------------------------
// TLS Options Builder
// ---------------------------------------------------------------------------

function buildTlsOptions(tls: RedisTlsConfig, hostname: string): TlsConnectionOptions | undefined {
  if (!tls.enabled) return undefined;

  const opts: TlsConnectionOptions = {
    rejectUnauthorized: tls.rejectUnauthorized ?? true,
  };

  // When connecting to an IP address, skip hostname verification
  if (net.isIP(hostname)) {
    opts.checkServerIdentity = () => undefined;
  }

  if (tls.caFile) opts.ca = fs.readFileSync(tls.caFile);
  if (tls.certFile) opts.cert = fs.readFileSync(tls.certFile);
  if (tls.keyFile) opts.key = fs.readFileSync(tls.keyFile);

  return opts;
}

// ---------------------------------------------------------------------------
// URL Parsing
// ---------------------------------------------------------------------------

interface ParsedRedisUrl {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db: number;
  useTls: boolean;
}

interface ParsedRedisClusterSeedNode {
  host: string;
  port: number;
}

interface ParsedRedisClusterSeed {
  node: ParsedRedisClusterSeedNode;
  password?: string;
  username?: string;
  useTls: boolean;
}

function parseStandaloneRedisUrl(url: string): ParsedRedisUrl {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : DEFAULT_REDIS_PORT,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    username:
      parsed.username && parsed.username !== 'default'
        ? decodeURIComponent(parsed.username)
        : undefined,
    db:
      parsed.pathname && parsed.pathname.length > 1
        ? parseInt(parsed.pathname.substring(1), 10) || 0
        : 0,
    useTls: parsed.protocol === 'rediss:',
  };
}

function parseRedisClusterSeed(rawSeed: string): ParsedRedisClusterSeed | null {
  const trimmed = rawSeed.trim();
  if (!trimmed) return null;

  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `redis://${trimmed}`;
  const parsed = new URL(url);
  if (!parsed.hostname) return null;

  return {
    node: {
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : DEFAULT_REDIS_PORT,
    },
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    username:
      parsed.username && parsed.username !== 'default'
        ? decodeURIComponent(parsed.username)
        : undefined,
    useTls: parsed.protocol === 'rediss:',
  };
}

function parseRedisClusterSeeds(seedList: string): ParsedRedisClusterSeed[] {
  return seedList
    .split(',')
    .map((seed) => parseRedisClusterSeed(seed))
    .filter((seed): seed is ParsedRedisClusterSeed => seed !== null);
}

// ---------------------------------------------------------------------------
// Connection Factory
// ---------------------------------------------------------------------------

/**
 * Create a Redis connection from options.
 *
 * Supports three modes:
 * 1. **URL mode**: `{ url: 'redis://...' }` — parsed into components.
 * 2. **Host/port mode**: `{ host: '...', port: 6380 }` — direct connection.
 * 3. **Cluster mode**: `{ url: 'host1:port1,host2:port2', cluster: true }`.
 *
 * Returns a `RedisConnectionHandle` with the client and lifecycle methods.
 */
export function createRedisConnection(opts: RedisConnectionOptions = {}): RedisConnectionHandle {
  const lazyConnect = opts.lazyConnect ?? true;
  const enableOfflineQueue = opts.enableOfflineQueue ?? true;
  const maxRetriesPerRequest =
    opts.maxRetriesPerRequest !== undefined
      ? opts.maxRetriesPerRequest
      : DEFAULT_MAX_RETRIES_PER_REQUEST;

  // Resolve host/port/password from URL or direct options
  let host = opts.host ?? 'localhost';
  let port = opts.port ?? DEFAULT_REDIS_PORT;
  let password = opts.password;
  let username: string | undefined;
  let db = opts.db ?? 0;
  let urlTls = false;

  let clusterNodes: ClusterNode[] | undefined;
  let clusterBaseOptions: Partial<RedisOptions> | undefined;

  if (opts.cluster && !opts.url) {
    // Misconfiguration: REDIS_CLUSTER=true requires a comma-separated seed list
    // in REDIS_URL. Falling through to standalone here would silently downgrade
    // a production deployment, so refuse loudly instead.
    throw new Error(
      'createRedisConnection: cluster mode requires `url` (comma-separated seed nodes). ' +
        'Set REDIS_URL to e.g. "redis://host1:6379,redis://host2:6379,redis://host3:6379".',
    );
  }

  if (opts.cluster && opts.url) {
    const parsedSeeds = parseRedisClusterSeeds(opts.url);
    if (parsedSeeds.length === 0) {
      throw new Error(
        'createRedisConnection: REDIS_URL produced an empty seed list after parsing. ' +
          'Expected one or more "host:port" entries separated by commas.',
      );
    }
    clusterNodes = parsedSeeds.map((seed) => seed.node);

    const authSeed = parsedSeeds.find((seed) => seed.password || seed.username);
    password = password ?? authSeed?.password;
    username = authSeed?.username;
    urlTls = parsedSeeds.some((seed) => seed.useTls);
    host = parsedSeeds[0]?.node.host ?? host;
  } else if (opts.url) {
    const parsed = parseStandaloneRedisUrl(opts.url);
    host = parsed.host;
    port = parsed.port;
    password = password ?? parsed.password;
    username = parsed.username;
    db = parsed.db || db;
    urlTls = parsed.useTls;
  }

  // Build base ioredis options after URL/seed parsing so credentials and TLS
  // from REDIS_URL, REDIS_PASSWORD, and rediss:// seeds are all preserved.
  const baseOpts: Partial<RedisOptions> = {
    maxRetriesPerRequest,
    retryStrategy: defaultRetryStrategy,
    lazyConnect,
    enableOfflineQueue,
  };

  if (opts.enableReadyCheck !== undefined) baseOpts.enableReadyCheck = opts.enableReadyCheck;
  if (password) baseOpts.password = password;
  if (username) baseOpts.username = username;
  if (db) baseOpts.db = db;

  // TLS: from explicit config OR from rediss:// URL scheme
  const hostname = host;
  if (opts.tls?.enabled || urlTls) {
    const tlsConfig: RedisTlsConfig = opts.tls ?? { enabled: true };
    baseOpts.tls = buildTlsOptions({ ...tlsConfig, enabled: true }, hostname);
  }

  let client: RedisClient;

  if (opts.cluster && clusterNodes) {
    clusterBaseOptions = baseOpts;

    const clusterOpts: ClusterOptions = {
      ...DEFAULT_CLUSTER_OPTIONS,
      redisOptions: baseOpts,
      lazyConnect,
    };
    const cluster = newCluster(clusterNodes, clusterOpts);
    cluster.on('+node', () => {
      clusterFailover.add(1, { event: 'add' });
    });
    cluster.on('-node', () => {
      clusterFailover.add(1, { event: 'remove' });
    });
    cluster.on('node error', () => {
      clusterNodeError.add(1);
    });
    client = cluster;
  } else {
    client = new Redis(port, host, baseOpts);
  }

  const handle: RedisConnectionHandle = {
    client,
    nodes: clusterNodes,
    baseOptions: clusterBaseOptions,

    toJSON() {
      return {
        mode: client instanceof Redis ? 'standalone' : 'cluster',
        ready: client.status === 'ready',
        nodeCount: clusterNodes?.length,
      };
    },

    isReady(): boolean {
      return client.status === 'ready';
    },

    duplicate(overrides: Partial<RedisConnectionOptions> = {}): RedisClient {
      const dupOpts: Partial<RedisOptions> = {};
      if (overrides.maxRetriesPerRequest !== undefined) {
        dupOpts.maxRetriesPerRequest = overrides.maxRetriesPerRequest;
      }
      if (client instanceof Redis) {
        return client.duplicate(dupOpts);
      }
      // Cluster path: rebuild a fresh Cluster from captured seeds + overrides.
      // ioredis Cluster has no `.duplicate()` method.
      if (!clusterNodes || !clusterBaseOptions) {
        throw new Error('duplicate(): cluster handle missing nodes/baseOptions');
      }
      const merged: Partial<RedisOptions> = { ...clusterBaseOptions, ...dupOpts };
      return newCluster(clusterNodes, {
        ...DEFAULT_CLUSTER_OPTIONS,
        redisOptions: merged,
      });
    },

    async disconnect(): Promise<void> {
      try {
        await client.quit();
      } catch {
        // QUIT raced with an already-broken socket. Force a synchronous
        // disconnect so the FD is released; ignore errors from that too —
        // shutdown callers (process exit, test teardown) cannot recover.
        try {
          client.disconnect();
        } catch {
          // socket already gone
        }
      }
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Environment-Based Factory
// ---------------------------------------------------------------------------

/**
 * Build RedisConnectionOptions from environment variables.
 *
 * Reads:
 * - `REDIS_URL` — full connection URL (takes precedence). In cluster mode,
 *   this is a comma-separated host:port seed list.
 * - `REDIS_HOST` — host (default: 'localhost')
 * - `REDIS_PORT` — port (default: DEFAULT_REDIS_PORT = 6380)
 * - `REDIS_ENABLED` — 'true'/'false' (default: 'true' if any Redis var is set)
 * - `REDIS_CLUSTER` — 'true'/'false' (default: false). When true, REDIS_URL
 *   becomes a comma-separated seed list.
 *
 * Returns null if Redis is explicitly disabled.
 */
export function resolveRedisOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): RedisConnectionOptions | null {
  const enabled = env.REDIS_ENABLED;
  if (enabled === 'false') return null;

  const url = env.REDIS_URL;
  const host = env.REDIS_HOST;
  const portStr = env.REDIS_PORT;
  const cluster = env.REDIS_CLUSTER === 'true';

  // If nothing is set and not explicitly enabled, still return defaults
  // (local dev with docker-compose at localhost:6380)
  const opts: RedisConnectionOptions = {};

  if (url) {
    opts.url = url;
  } else {
    if (host) opts.host = host;
    if (portStr) opts.port = parseInt(portStr, 10);
    // If neither URL nor host/port, defaults in createRedisConnection apply
  }

  if (env.REDIS_PASSWORD) opts.password = env.REDIS_PASSWORD;
  if (cluster) opts.cluster = true;
  if (env.REDIS_TLS_ENABLED === 'true' || env.REDIS_TLS === 'true') {
    opts.tls = { enabled: true };
  } else if (env.REDIS_TLS_ENABLED === 'false' || env.REDIS_TLS === 'false') {
    opts.tls = { enabled: false };
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Platform Config Factory
// ---------------------------------------------------------------------------

/**
 * Build RedisConnectionOptions from the platform's centralized config.
 *
 * Designed for apps using `@agent-platform/config` (Runtime, Studio, etc.).
 * Pass the `redis` section of your app config.
 *
 * @param config - The `redis` section from getConfig()
 * @returns RedisConnectionOptions or null if disabled
 */
export function resolveRedisOptionsFromConfig(config: {
  url?: string;
  enabled?: boolean;
  tls?:
    | {
        enabled?: boolean;
        caFile?: string;
        certFile?: string;
        keyFile?: string;
        rejectUnauthorized?: boolean;
      }
    | boolean;
  cluster?: boolean;
  password?: string;
}): RedisConnectionOptions | null {
  if (config.enabled === false) return null;
  if (!config.url && config.enabled !== true) return null;

  const opts: RedisConnectionOptions = {};

  if (config.url) opts.url = config.url;
  if (config.cluster) opts.cluster = true;
  if (config.password) opts.password = config.password;

  // Normalize TLS (config schema allows boolean or object)
  if (config.tls) {
    if (typeof config.tls === 'boolean') {
      opts.tls = { enabled: config.tls };
    } else {
      opts.tls = {
        enabled: config.tls.enabled ?? false,
        caFile: config.tls.caFile,
        certFile: config.tls.certFile,
        keyFile: config.tls.keyFile,
        rejectUnauthorized: config.tls.rejectUnauthorized,
      };
    }
  }

  return opts;
}
