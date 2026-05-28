/**
 * Promote Contact Context — BullMQ Worker
 *
 * Processes promote-contact-context jobs: merges session dataValues into
 * the contact's cross-session ContactContext and persists via
 * ContactContextService (which invalidates the Redis cache).
 *
 * The session dataValues are embedded in the job payload at enqueue time
 * (captured before endSession clears Redis), so no Redis read is needed
 * during job processing.
 */

import { createLogger } from '@abl/compiler/platform';
import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import {
  PROMOTE_CONTEXT_QUEUE_NAME,
  PROMOTE_CONTEXT_QUEUE_CONFIG,
  createPromoteContextProcessor,
  type PromoteContextDeps,
} from '../../contexts/orchestration/jobs/promote-contact-context.js';
import { getContactContextService } from '../contact-context-service.js';

const log = createLogger('promote-context-worker');

let worker: import('bullmq').Worker | null = null;

/**
 * Start the BullMQ worker for promote-contact-context jobs.
 * No-ops if BullMQ or Redis is unavailable.
 */
export async function startPromoteContextWorker(): Promise<void> {
  try {
    const { isConfigLoaded, getConfig } = await import('../../config/loader.js');
    if (!isConfigLoaded()) return;

    const config = getConfig();
    if (!config.redis.enabled || !config.redis.url) {
      log.info('Promote context worker skipped — Redis not available');
      return;
    }

    const bullmq = await import('bullmq');
    const { getRedisHandle } = await import('../redis/redis-client.js');
    const handle = getRedisHandle();
    if (!handle) {
      log.info('Promote context worker skipped — Redis handle not initialized');
      return;
    }
    const connection = handle.duplicate({ maxRetriesPerRequest: null });

    worker = new bullmq.Worker<
      import('../../contexts/orchestration/jobs/promote-contact-context.js').PromoteContextJobData
    >(
      PROMOTE_CONTEXT_QUEUE_NAME,
      async (job) => {
        // Session dataValues were captured at enqueue time (before endSession cleared Redis).
        // Return them directly so loadSessionSnapshot never races with Redis cleanup.
        const capturedDataValues = job.data.dataValues;

        const deps: PromoteContextDeps = {
          loadSessionSnapshot: async (_tenantId, _sessionId) =>
            capturedDataValues ? { dataValues: capturedDataValues } : null,
          getContactContext: async (tenantId, contactId) =>
            (await getContactContextService()).get(tenantId, contactId),
          updateContactContext: async (tenantId, contactId, context) =>
            (await getContactContextService()).update(tenantId, contactId, context),
        };

        const processor = createPromoteContextProcessor(deps);
        await processor(job);
      },
      {
        connection,
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
        concurrency: PROMOTE_CONTEXT_QUEUE_CONFIG.concurrency,
      },
    );

    worker.on('failed', (job, err) => {
      log.warn('Promote context job failed', {
        jobId: job?.id,
        tenantId: job?.data?.tenantId,
        contactId: job?.data?.contactId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    log.info('Promote context worker started');
  } catch (err) {
    log.warn('Failed to start promote context worker', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Stop the promote-context worker gracefully.
 */
export async function stopPromoteContextWorker(): Promise<void> {
  if (!worker) return;
  try {
    await worker.close();
    worker = null;
    log.info('Promote context worker stopped');
  } catch (err) {
    log.warn('Failed to stop promote context worker', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
