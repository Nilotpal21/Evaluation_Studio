/**
 * Session Timeout Queue Factory
 *
 * Creates a BullMQ queue and worker for session timeout processing.
 * The queue handles delayed jobs that fire when a session's TTL expires.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import type { RedisConnectionHandle } from '@agent-platform/redis';
import { createBullMQPair, type BullMQConnectionPair } from '@agent-platform/redis/bullmq';
import { createLogger } from '@abl/compiler/platform';
import { SessionTimeoutScheduler, type TimeoutJob } from '@agent-platform/agent-transfer';

const log = createLogger('session-timeout-queue');

const QUEUE_NAME = 'agent-transfer-session-timeout';

export interface SessionTimeoutQueueComponents {
  queue: Queue;
  worker: Worker;
  scheduler: SessionTimeoutScheduler;
  /** Disconnect the BullMQ connection pair (must be called after worker/queue close). */
  disconnect(): void;
}

/**
 * Create BullMQ queue, worker, and SessionTimeoutScheduler.
 * The worker processes timeout jobs by invoking the scheduler's processTimeout method.
 */
export function createSessionTimeoutQueue(
  handle: RedisConnectionHandle,
  onTimeout: (sessionKey: string) => Promise<void>,
): SessionTimeoutQueueComponents {
  const pair: BullMQConnectionPair = createBullMQPair(handle);

  const queue = new Queue(QUEUE_NAME, {
    connection: pair.queueConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    defaultJobOptions: {
      removeOnComplete: { count: 1000, age: 86400 },
      removeOnFail: { count: 50, age: 604800 },
    },
  });

  // Wrap BullMQ Queue to satisfy TimeoutQueueHandle (remove returns void, not number)
  const queueHandle = {
    add: (name: string, data: unknown, opts?: Record<string, unknown>) =>
      queue.add(name, data, opts as any),
    remove: async (jobId: string) => {
      await queue.remove(jobId);
    },
    close: () => queue.close(),
  };

  const scheduler = new SessionTimeoutScheduler(queueHandle);
  scheduler.onTimeout(onTimeout);

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job<TimeoutJob>) => {
      await scheduler.processTimeout(job.data);
    },
    {
      connection: pair.workerConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      concurrency: 20,
    },
  );

  worker.on('failed', async (job, error) => {
    log.error('Session timeout job failed', {
      sessionKey: job?.data?.sessionKey ?? 'unknown',
      error: error instanceof Error ? error.message : String(error),
      attempts: job?.attemptsMade ?? 0,
    });
    // If all retries exhausted, attempt the timeout directly as last resort
    if (job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
      try {
        await onTimeout(job.data.sessionKey);
        log.info('Session timeout executed via failed handler fallback', {
          sessionKey: job.data.sessionKey,
        });
      } catch (fallbackErr) {
        log.error('Failed handler fallback also failed for session timeout', {
          sessionKey: job.data.sessionKey,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
      }
    }
  });

  worker.on('error', (err) => {
    log.error('Session timeout worker error', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  log.info('Session timeout queue and worker created', { queueName: QUEUE_NAME });

  return { queue, worker, scheduler, disconnect: () => pair.disconnect() };
}

/**
 * Gracefully close timeout queue components.
 */
export async function closeSessionTimeoutQueue(
  components: SessionTimeoutQueueComponents,
): Promise<void> {
  try {
    await components.scheduler.close();
    await components.worker.close();
    await components.queue.close();
    // Disconnect BullMQ connection pair — BullMQ's .close() does NOT disconnect Redis.
    components.disconnect();
    log.info('Session timeout queue closed');
  } catch (err) {
    log.error('Failed to close session timeout queue', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
