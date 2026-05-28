/**
 * Cleanup Worker - Attachment Cleanup Pipeline Stage
 *
 * Handles cleanup of attachments that have been flagged for removal:
 *   - Infected files detected during scan
 *   - Expired attachments past retention period
 *   - Attachments from deleted sessions
 *   - Manual cleanup requests
 *
 * Responsible for removing search index entries, storage files, and DB records.
 */

import type { Job } from 'bullmq';
import { Attachment } from '@agent-platform/database';
import type { StorageProvider } from '@agent-platform/shared';
import type { AttachmentSearchProducer } from '../services/attachment-search-producer.js';
import type { CleanupJobData } from './queues.js';
import { workerLog, workerError } from './queues.js';

// =============================================================================
// TYPES
// =============================================================================

export interface CleanupEvent {
  attachmentId: string;
  tenantId: string;
  sessionId: string;
  reason: string;
  storageKeysDeleted: number;
}

export interface CleanupWorkerDeps {
  storageProvider: StorageProvider;
  searchProducer: AttachmentSearchProducer;
  onCleanupComplete?: (event: CleanupEvent) => void;
}

// =============================================================================
// FACTORY
// =============================================================================

const WORKER_NAME = 'cleanup';

/**
 * Create a cleanup worker processor function.
 *
 * Steps:
 *   1. Load attachment (tenant-scoped)
 *   2. Remove search index entry (best-effort)
 *   3. Delete storage files (original + resized + thumbnail)
 *   4. Delete DB record
 */
export function createCleanupWorker(
  deps: CleanupWorkerDeps,
): (job: Job<CleanupJobData>) => Promise<void> {
  return async (job: Job<CleanupJobData>): Promise<void> => {
    const { attachmentId, tenantId, reason } = job.data;

    workerLog(WORKER_NAME, 'Processing cleanup', { attachmentId, tenantId, reason });

    // 1. Load attachment (tenant-scoped)
    const attachment = await Attachment.findOne({ _id: attachmentId, tenantId }).lean();
    if (!attachment) {
      workerLog(WORKER_NAME, 'Attachment not found (already deleted?)', { attachmentId, tenantId });
      return;
    }

    // 2. Remove search index entry (best-effort)
    if (attachment.searchIndexId || attachment.searchDocumentId) {
      try {
        await deps.searchProducer.remove(attachment);
      } catch (err) {
        workerError(WORKER_NAME, 'Search cleanup failed (continuing)', err);
      }
    }

    // 3. Delete storage files
    try {
      await deps.storageProvider.delete(attachment.storageKey);

      if (attachment.resizedStorageKey) {
        await deps.storageProvider.delete(attachment.resizedStorageKey);
      }
      if (attachment.thumbnailStorageKey) {
        await deps.storageProvider.delete(attachment.thumbnailStorageKey);
      }
    } catch (err) {
      workerError(WORKER_NAME, 'Storage cleanup failed (continuing)', err);
    }

    // 4. Emit structured cleanup event
    const storageKeysDeleted =
      1 + (attachment.resizedStorageKey ? 1 : 0) + (attachment.thumbnailStorageKey ? 1 : 0);

    deps.onCleanupComplete?.({
      attachmentId,
      tenantId,
      sessionId: attachment.sessionId,
      reason,
      storageKeysDeleted,
    });

    // 5. Delete DB record
    await Attachment.deleteOne({ _id: attachmentId, tenantId });

    workerLog(WORKER_NAME, 'Cleanup completed', { attachmentId, tenantId, reason });
  };
}
