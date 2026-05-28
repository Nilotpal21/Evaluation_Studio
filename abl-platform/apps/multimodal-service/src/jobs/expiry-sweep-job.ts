/**
 * Expiry Sweep Job
 *
 * Runs hourly to find attachments expiring within the next 2 hours and
 * enqueue cleanup jobs for them. This ensures storage files and search
 * index entries are cleaned up BEFORE MongoDB's TTL index fires and
 * orphans the reference data.
 *
 * Each cleanup job is deduped by jobId (`cleanup:{attachmentId}`) so
 * repeated sweeps don't create duplicate work.
 */

import type { Queue } from 'bullmq';
import { Attachment } from '@agent-platform/database';
import type { CleanupJobData } from './queues.js';
import { workerLog, workerError } from './queues.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const WORKER_NAME = 'expiry-sweep';

/** How far ahead to look for expiring attachments (ms) */
const SWEEP_HORIZON_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Max attachments per sweep to avoid overloading the queue */
const SWEEP_BATCH_LIMIT = 500;

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create the expiry sweep function.
 *
 * Designed to be called by a BullMQ repeating job (every hour).
 */
export function createExpirySweep(cleanupQueue: Queue<CleanupJobData>): () => Promise<void> {
  return async (): Promise<void> => {
    const now = Date.now();
    const horizon = new Date(now + SWEEP_HORIZON_MS);

    workerLog(WORKER_NAME, 'Starting expiry sweep', {
      horizon: horizon.toISOString(),
    });

    try {
      // Find attachments expiring within the horizon
      const expiring = await Attachment.find({
        expiresAt: { $lte: horizon },
      })
        .select('_id tenantId')
        .limit(SWEEP_BATCH_LIMIT)
        .lean();

      if (expiring.length === 0) {
        workerLog(WORKER_NAME, 'No expiring attachments found');
        return;
      }

      workerLog(WORKER_NAME, `Found ${expiring.length} expiring attachments`);

      let enqueued = 0;
      for (const att of expiring) {
        try {
          await cleanupQueue.add(
            'cleanup',
            {
              attachmentId: att._id,
              tenantId: att.tenantId,
              reason: 'expired',
            },
            {
              // Dedup: same attachment won't be enqueued twice
              jobId: `cleanup:${att._id}`,
            },
          );
          enqueued++;
        } catch (err) {
          // Duplicate job IDs throw — expected for already-enqueued items
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('duplicate')) {
            workerError(WORKER_NAME, `Failed to enqueue cleanup for ${att._id}`, err);
          }
        }
      }

      workerLog(WORKER_NAME, 'Expiry sweep complete', {
        found: expiring.length,
        enqueued,
      });
    } catch (err) {
      workerError(WORKER_NAME, 'Expiry sweep failed', err);
    }
  };
}
