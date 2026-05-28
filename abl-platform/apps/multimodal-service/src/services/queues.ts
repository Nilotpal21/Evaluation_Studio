/**
 * Multimodal Service BullMQ Queues
 *
 * Manages attachment processing queues:
 * - attachment-scan: Virus scanning and validation pipeline
 *
 * Uses the cluster-aware createQueue() from jobs/queues.ts for both
 * standalone and Redis Cluster compatibility.
 */

import type { Queue } from 'bullmq';
import { createLogger } from '@abl/compiler/platform';
import { createQueue as createBullQueue, QUEUE_NAMES } from '../jobs/queues.js';

const log = createLogger('multimodal-queues');

let scanQueue: Queue | null = null;

/**
 * Initialize attachment processing queue.
 * Returns false if Redis is not available.
 */
export async function initAttachmentQueues(): Promise<boolean> {
  if (scanQueue) return true;

  try {
    scanQueue = createBullQueue(QUEUE_NAMES.SCAN);
    log.info('Attachment queues initialized');
    return true;
  } catch (error) {
    log.error('Failed to initialize attachment queues', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Get the scan queue wrapper compatible with AttachmentService interface.
 * Returns null if queue is not initialized.
 */
export function getScanQueue(): {
  add(name: string, data: Record<string, unknown>): Promise<void>;
} | null {
  if (!scanQueue) return null;

  return {
    add: async (name: string, data: Record<string, unknown>): Promise<void> => {
      await scanQueue!.add(name, data);
    },
  };
}

/**
 * Get the raw BullMQ queue instance (for advanced operations).
 */
export function getScanQueueRaw(): Queue | null {
  return scanQueue;
}

/**
 * Close all queues gracefully.
 */
export async function closeAttachmentQueues(): Promise<void> {
  if (scanQueue) {
    await scanQueue.close();
    scanQueue = null;
    log.info('Attachment queues closed');
  }
}
