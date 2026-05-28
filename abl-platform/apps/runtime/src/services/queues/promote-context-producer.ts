/**
 * Promote Contact Context — BullMQ Queue Producer
 *
 * Provides a thin Queue wrapper for enqueuing promote-contact-context jobs.
 * Non-critical: enqueue failures are logged but never thrown, so callers
 * (session close handlers) are never blocked by queue unavailability.
 */

import { createLogger } from '@abl/compiler/platform';
import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import {
  PROMOTE_CONTEXT_QUEUE_NAME,
  PROMOTE_CONTEXT_QUEUE_CONFIG,
  type PromoteContextJobData,
} from '../../contexts/orchestration/jobs/promote-contact-context.js';

const log = createLogger('promote-context-producer');

let promoteContextQueue: import('bullmq').Queue<PromoteContextJobData> | null = null;

/**
 * Initialize the BullMQ Queue for promote-contact-context jobs.
 * No-ops if BullMQ or Redis is unavailable.
 */
export async function initPromoteContextQueue(): Promise<void> {
  try {
    const { isConfigLoaded, getConfig } = await import('../../config/loader.js');
    if (!isConfigLoaded()) return;

    const config = getConfig();
    if (!config.redis.enabled || !config.redis.url) {
      log.info('Promote context queue skipped — Redis not available');
      return;
    }

    const bullmq = await import('bullmq');
    const { getRedisHandle } = await import('../redis/redis-client.js');
    const handle = getRedisHandle();
    if (!handle) {
      log.info('Promote context queue skipped — Redis handle not initialized');
      return;
    }
    promoteContextQueue = new bullmq.Queue<PromoteContextJobData>(PROMOTE_CONTEXT_QUEUE_NAME, {
      connection: handle.duplicate({ maxRetriesPerRequest: null }),
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    });
    log.info('Promote context queue initialized');
  } catch (err) {
    log.warn('Failed to initialize promote context queue', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Enqueue a promote-contact-context job.
 * Non-critical: errors are logged but never thrown.
 */
export async function enqueuePromoteContextJob(data: PromoteContextJobData): Promise<void> {
  if (!promoteContextQueue) return;
  try {
    await promoteContextQueue.add(
      'promote-context',
      data,
      PROMOTE_CONTEXT_QUEUE_CONFIG.defaultJobOptions,
    );
  } catch (err) {
    log.warn('Failed to enqueue promote-context job', {
      error: err instanceof Error ? err.message : String(err),
      tenantId: data.tenantId,
      contactId: data.contactId,
    });
  }
}

/**
 * Close the promote-context queue connection gracefully.
 */
export async function closePromoteContextQueue(): Promise<void> {
  if (!promoteContextQueue) return;
  try {
    await promoteContextQueue.close();
    promoteContextQueue = null;
  } catch (err) {
    log.warn('Failed to close promote context queue', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
