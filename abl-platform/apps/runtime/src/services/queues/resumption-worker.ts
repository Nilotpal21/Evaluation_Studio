/**
 * Resumption Worker — BullMQ worker for the 'execution-resume' queue.
 *
 * Processes callback payloads by delegating to ResumptionService.resume().
 * Uses exponential backoff retry (5 attempts) for transient failures.
 */

import { createLogger } from '@abl/compiler/platform';
import { getBullMQPrefix, type RedisClient } from '@agent-platform/redis';
import type { ResumptionService } from '../execution/resumption-service.js';

const log = createLogger('resumption-worker');

type Worker = any;
let worker: Worker | null = null;

export interface ResumptionWorkerDeps {
  resumptionService: ResumptionService;
  /** Pre-created cluster-safe BullMQ worker connection (from createBullMQPair). */
  workerConnection: RedisClient;
}

export async function startResumptionWorker(deps: ResumptionWorkerDeps): Promise<void> {
  if (worker) return;

  const bullmq = await import('bullmq');

  worker = new bullmq.Worker(
    'execution-resume',
    async (job: any) => {
      const { suspensionId, callbackId, tenantId, payload, receivedAt } = job.data;

      log.info('Processing resume job', {
        jobId: job.id,
        suspensionId,
        callbackId,
        attempt: job.attemptsMade + 1,
      });

      try {
        await deps.resumptionService.resume(suspensionId, {
          type: job.data.type || 'handoff_result',
          callbackId,
          tenantId: tenantId || '',
          payload,
          receivedAt,
        });
      } catch (err) {
        log.error('Resume job failed', {
          jobId: job.id,
          suspensionId,
          attempt: job.attemptsMade + 1,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err; // Re-throw so BullMQ retries
      }
    },
    {
      connection: deps.workerConnection,
      prefix: getBullMQPrefix(deps.workerConnection, { standalonePrefix: '{bull}' }),
      concurrency: 10,
      removeOnComplete: { count: 1000, age: 86400 },
      removeOnFail: { count: 5000, age: 604800 },
      settings: {
        backoffStrategy: (attemptsMade: number) => {
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s
          return Math.min(1000 * Math.pow(2, attemptsMade), 30_000);
        },
      },
    },
  );

  worker.on('error', (err: Error) => {
    log.error('Resumption worker error', { error: err.message });
  });

  log.info('Resumption worker started');
}

export async function stopResumptionWorker(): Promise<void> {
  if (!worker) return;
  await worker.close();
  worker = null;
  log.info('Resumption worker stopped');
}
