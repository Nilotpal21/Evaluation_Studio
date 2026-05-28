/**
 * Channel Queue Lifecycle
 *
 * Manages startup and shutdown of channel queues and workers.
 * Guards against missing Redis — gracefully no-ops when unavailable.
 */

import { createLogger } from '@abl/compiler/platform';
import { initChannelQueues, closeChannelQueues } from './channel-queues.js';
import { initPromoteContextQueue, closePromoteContextQueue } from './promote-context-producer.js';

const log = createLogger('channel-queue-lifecycle');

let workersStarted = false;

/**
 * Start channel queues and workers.
 * No-ops if Redis is unavailable.
 */
export async function startChannelQueues(): Promise<void> {
  const queuesReady = await initChannelQueues();
  if (!queuesReady) {
    log.info('Channel queues skipped — Redis not available');
    return;
  }

  try {
    const { startInboundWorker } = await import('./inbound-worker.js');
    const { startDeliveryWorker } = await import('./delivery-worker.js');
    const { startPromoteContextWorker } = await import('./promote-context-worker.js');

    await startInboundWorker();
    await startDeliveryWorker();
    await startPromoteContextWorker();
    workersStarted = true;

    log.info('Channel workers started');
  } catch (error) {
    log.warn('Failed to start channel workers', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  await initPromoteContextQueue();
}

/**
 * Stop channel queues and workers gracefully.
 */
export async function stopChannelQueues(): Promise<void> {
  if (workersStarted) {
    try {
      const { stopInboundWorker } = await import('./inbound-worker.js');
      const { stopDeliveryWorker } = await import('./delivery-worker.js');
      const { stopPromoteContextWorker } = await import('./promote-context-worker.js');

      await stopInboundWorker();
      await stopDeliveryWorker();
      await stopPromoteContextWorker();
    } catch (error) {
      log.warn('Failed to stop channel workers', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  await closePromoteContextQueue();
  await closeChannelQueues();
  workersStarted = false;

  log.info('Channel queue lifecycle stopped');
}
