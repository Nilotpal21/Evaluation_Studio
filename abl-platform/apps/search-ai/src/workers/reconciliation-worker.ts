/**
 * Reconciliation Worker
 *
 * Processes daily reconciliation jobs: embeds novel attribute candidates,
 * matches against existing canonical attributes, clusters similar candidates,
 * and auto-promotes high-confidence attributes.
 *
 * Queue: reconciliation
 */

import { Worker } from 'bullmq';
import type { ReconciliationJobData } from './shared.js';
import { createWorkerOptions } from './shared.js';
import { processReconciliationJob } from './reconciliation-processor.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('worker:reconciliation');

export default function createReconciliationWorker(concurrency = 1): Worker<ReconciliationJobData> {
  const worker = new Worker<ReconciliationJobData>(
    'reconciliation',
    processReconciliationJob,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    log.info(`Reconciliation job ${job.id} completed`, { returnvalue: job.returnvalue });
  });

  worker.on('failed', (job, err) => {
    log.error(`Reconciliation job ${job?.id} failed`, {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  log.info(`Reconciliation worker started with concurrency=${concurrency}`);
  return worker;
}
