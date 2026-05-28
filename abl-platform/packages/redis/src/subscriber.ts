/**
 * Mode-aware pub/sub subscriber factory.
 *
 * ioredis `Cluster` does not expose `.duplicate()`. The only correct way to
 * obtain an independent pub/sub Cluster connection is to construct a fresh
 * `new Cluster(nodes, opts)` from the original seed list. `RedisConnectionHandle`
 * captures `nodes` + `baseOptions` at construction time so this helper can
 * replay them without reaching into ioredis private state.
 *
 * In standalone mode, this falls back to `client.duplicate()` — verbatim the
 * existing platform behavior.
 */

import { Redis, Cluster } from 'ioredis';
import type { RedisClient, RedisConnectionHandle } from './types.js';
import { subscriberReconnect } from './observability.js';
import { DEFAULT_CLUSTER_OPTIONS, newCluster } from './connection.js';

/**
 * Create a Redis connection suitable for SUBSCRIBE / PSUBSCRIBE.
 *
 * In standalone mode, returns `handle.client.duplicate()` (existing behavior).
 *
 * In cluster mode, returns a fresh `Cluster` instance constructed from the
 * handle's seed nodes and base options. Pub/sub on a Cluster routes
 * subscriptions to the node that owns the channel's slot, with automatic
 * resubscribe on slot move — that is built in to ioredis Cluster.
 *
 * Reconnect behavior: ioredis already maintains the connection lifecycle and
 * resubscribes automatically. This helper attaches an `error` handler that
 * increments `redis.subscriber.reconnect` so operators can observe pub/sub
 * durability without needing to instrument every consumer.
 */
export function createSubscriber(handle: RedisConnectionHandle): RedisClient {
  if (handle.client instanceof Cluster) {
    if (!handle.nodes || !handle.baseOptions) {
      throw new Error(
        'createSubscriber: cluster handle is missing `nodes` or `baseOptions`. ' +
          'This indicates the connection was not constructed via createRedisConnection().',
      );
    }
    // Per-node auth/TLS/retry options must be nested under `redisOptions` —
    // top-level spread of RedisOptions is silently dropped by ioredis Cluster.
    // Pub/sub subscribers also must NOT use the offline queue: queued
    // PSUBSCRIBEs can race with the resubscribe-on-reconnect logic.
    const subscriber = newCluster(handle.nodes, {
      ...DEFAULT_CLUSTER_OPTIONS,
      redisOptions: handle.baseOptions,
      enableOfflineQueue: false,
    });
    attachReconnectMetrics(subscriber, 'cluster');
    return subscriber;
  }

  if (handle.client instanceof Redis) {
    const subscriber = handle.client.duplicate();
    attachReconnectMetrics(subscriber, 'standalone');
    return subscriber;
  }

  throw new Error('createSubscriber: handle.client is not a Redis or Cluster instance');
}

function attachReconnectMetrics(subscriber: RedisClient, mode: 'standalone' | 'cluster'): void {
  // ioredis emits 'reconnecting' on automatic reconnect attempts.
  subscriber.on('reconnecting', (delay: number) => {
    subscriberReconnect.add(1, { mode, delay_ms: String(delay) });
  });

  // Cluster also emits per-node connection errors that don't always trigger
  // 'reconnecting' on the top-level Cluster wrapper. Capture those too.
  if (subscriber instanceof Cluster) {
    subscriber.on('node error', () => {
      subscriberReconnect.add(1, { mode, source: 'node_error' });
    });
  }
}
