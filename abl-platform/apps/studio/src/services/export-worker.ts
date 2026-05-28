/**
 * Export Worker -- processes async export jobs.
 *
 * This worker runs in the same process as Studio (not a separate service).
 * It's initialized lazily on first async export request.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import { createRedisConnection, resolveRedisOptionsFromEnv } from '@agent-platform/redis';
import {
  createBullMQPair,
  BULLMQ_CLUSTER_SAFE_PREFIX,
  type BullMQConnectionPair,
} from '@agent-platform/redis/bullmq';
import type { ExportJobData } from './export-queue';

const log = createLogger('export-worker');

let _worker: any = null;
let _workerPair: BullMQConnectionPair | undefined;
let _initialized = false;

/**
 * Initialize the export worker if not already running.
 * Called lazily when the first async export job is queued.
 */
export async function ensureExportWorker(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  const opts = resolveRedisOptionsFromEnv();
  if (!opts) {
    log.warn('Redis not configured — export worker will not start');
    return;
  }

  const handle = createRedisConnection(opts);
  const pair = createBullMQPair(handle);
  _workerPair = pair;

  const { Worker } = await import('bullmq');
  const { EXPORT_QUEUE_NAME } = await import('./export-queue');

  _worker = new Worker(
    EXPORT_QUEUE_NAME,
    async (job) => {
      const data = job.data as ExportJobData;
      log.info('Processing export job', { jobId: job.id, projectId: data.projectId });

      try {
        await job.updateProgress(10);

        // Dynamic import to avoid circular dependencies
        const { processExportJob } = await import('./export-job-processor');
        const result = await processExportJob(data, (progress: number) => {
          job.updateProgress(progress);
        });

        await job.updateProgress(100);
        log.info('Export job completed', { jobId: job.id, projectId: data.projectId });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('Export job failed', {
          jobId: job.id,
          projectId: data.projectId,
          error: message,
        });
        throw error;
      }
    },
    {
      connection: pair.workerConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      concurrency: 2, // Max 2 concurrent exports
      limiter: { max: 5, duration: 60_000 }, // Max 5 per minute
    },
  );

  _worker.on('failed', (job: any, err: Error) => {
    log.error('Export worker job failed', { jobId: job?.id, error: err.message });
  });

  log.info('Export worker initialized');
}

/**
 * Close the export worker and disconnect the BullMQ Redis connections.
 */
export async function closeExportWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
  }
  _workerPair?.disconnect();
  _workerPair = undefined;
  _initialized = false;
}
