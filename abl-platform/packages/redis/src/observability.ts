/**
 * Redis observability counters.
 *
 * Uses `@opentelemetry/api` directly (no SDK initialization here). When no SDK
 * is registered (e.g. in unit tests), the API returns NoopMeterProvider whose
 * counters are silent — that is the intended "no-op default".
 *
 * Apps that initialize an OTel SDK (runtime, workflow-engine) automatically
 * receive these counters via the global meter provider.
 */

import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('@agent-platform/redis', '1.0.0');

/** Lua scripts whose KEYS span multiple cluster slots — a code defect. */
export const crossslotErrors = meter.createCounter('redis.crossslot.errors', {
  description: 'Lua scripts whose KEYS span multiple cluster slots (programming error)',
});

/**
 * Per-node connection errors from ioredis Cluster (`'node error'` event).
 *
 * NOTE: This is wired to ioredis's `'node error'` event, which fires on
 * TCP-level connection failures to individual cluster nodes. ioredis does not
 * emit a per-redirect event for MOVED/ASK responses (those are handled
 * internally), so this counter is named after what it actually measures —
 * not after the LLD's original "MOVED redirects" framing.
 */
export const clusterNodeError = meter.createCounter('redis.cluster.node_error', {
  description: 'ioredis Cluster per-node connection errors',
});

/** +node / -node events from ioredis Cluster — failover indicator. */
export const clusterFailover = meter.createCounter('redis.cluster.failover', {
  description: '+node / -node events from ioredis Cluster',
});

/** createSubscriber reconnect attempts — pub/sub durability indicator. */
export const subscriberReconnect = meter.createCounter('redis.subscriber.reconnect', {
  description: 'createSubscriber reconnect attempts',
});

/** SCAN-on-cluster per-node failures — indicates partial result risk. */
export const scanKeysNodeError = meter.createCounter('redis.scan_keys.node_error', {
  description: 'scanKeys per-node SCAN failures (cluster mode)',
});

/** BullMQ watchdog forced reconnects — GAP-008 mitigation activations. */
export const bullmqWatchdogRecover = meter.createCounter('redis.bullmq.watchdog.recover', {
  description: 'BullMQ Worker watchdog forced a connection reset after stuck-status threshold',
});
