/**
 * Channel BullMQ Queues
 *
 * Two queues for channel message processing:
 * - channel-inbound: Incoming messages from external channels
 * - webhook-delivery: Outbound webhook delivery to callback URLs
 *
 * Cluster-aware: in standalone mode, uses BullMQ ConnectionOptions built from
 * REDIS_URL via createBullMQConnectionOptions; in cluster mode, BullMQ accepts
 * a Cluster instance directly at `connection`, sourced from the runtime's
 * shared RedisConnectionHandle.
 */

import { createLogger } from '@abl/compiler/platform';
import { BULLMQ_CLUSTER_SAFE_PREFIX, createBullMQConnectionOptions } from '@agent-platform/redis';

const log = createLogger('channel-queues');

// BullMQ types (dynamically imported)
type Queue = any;

let inboundQueue: Queue | null = null;
let deliveryQueue: Queue | null = null;

/**
 * Initialize both channel queues.
 * Returns false if Redis is not available.
 */
export async function initChannelQueues(): Promise<boolean> {
  if (inboundQueue && deliveryQueue) return true;

  try {
    const { isConfigLoaded, getConfig } = await import('../../config/index.js');
    if (!isConfigLoaded()) return false;

    const config = getConfig();
    if (!config.redis.enabled || !config.redis.url) {
      log.info('Redis not configured — channel queues disabled');
      return false;
    }

    const bullmq = await import('bullmq');

    // In cluster mode, use the shared handle's Cluster instance directly —
    // BullMQ accepts a Cluster at `connection`. Falls back to URL-derived
    // ConnectionOptions in standalone mode.
    let connection: any;
    if (config.redis.cluster) {
      const { getRedisHandle } = await import('../redis/redis-client.js');
      const handle = getRedisHandle();
      if (!handle) {
        log.warn('Redis handle unavailable in cluster mode — channel queues disabled');
        return false;
      }
      connection = handle.duplicate({ maxRetriesPerRequest: null });
    } else {
      connection = createBullMQConnectionOptions({ url: config.redis.url });
    }

    inboundQueue = new bullmq.Queue('channel-inbound', {
      connection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      defaultJobOptions: {
        removeOnComplete: { count: 1000, age: 86400 },
        removeOnFail: { count: 5000, age: 604800 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    });

    deliveryQueue = new bullmq.Queue('webhook-delivery', {
      connection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      defaultJobOptions: {
        removeOnComplete: { count: 1000, age: 86400 },
        removeOnFail: { count: 5000, age: 604800 },
        attempts: 5,
        backoff: { type: 'exponential', delay: 3000 },
      },
    });

    log.info('Channel queues initialized', {
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      mode: config.redis.cluster ? 'cluster' : 'standalone',
    });
    return true;
  } catch (error) {
    log.warn('Failed to initialize channel queues', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

/**
 * Get the inbound message queue.
 */
export function getInboundQueue(): Queue | null {
  return inboundQueue;
}

/**
 * Get the webhook delivery queue.
 */
export function getDeliveryQueue(): Queue | null {
  return deliveryQueue;
}

/**
 * Close both queues gracefully.
 */
export async function closeChannelQueues(): Promise<void> {
  if (inboundQueue) {
    await inboundQueue.close();
    inboundQueue = null;
  }
  if (deliveryQueue) {
    await deliveryQueue.close();
    deliveryQueue = null;
  }
  log.info('Channel queues closed');
}
