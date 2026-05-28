/**
 * Scan Worker - Virus Scanning Pipeline Stage
 *
 * Downloads the attachment file from storage, passes it through the
 * ScanProvider (ClamAV), and updates the Attachment record with the result.
 *
 * Pipeline flow:
 *   scan (this) -> validate -> process -> index
 *
 * If the file is clean, enqueues a validate-job. If infected, stops the
 * pipeline and marks the attachment accordingly. Scanner errors are recorded
 * but do not advance the pipeline.
 *
 * All DB queries are tenant-scoped: `findOne({ _id, tenantId })`.
 */

import type { Job } from 'bullmq';
import { Attachment } from '@agent-platform/database';
import type { StorageProvider, ScanProvider } from '@agent-platform/shared';
import type { ScanJobData, ValidateJobData } from './queues.js';
import { QUEUE_NAMES, workerLog, workerError } from './queues.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ScanWorkerDeps {
  storageProvider: StorageProvider;
  scanProvider: ScanProvider;
  /** Queue for enqueuing the next pipeline stage */
  validateQueue: { add(name: string, data: ValidateJobData): Promise<unknown> };
}

// =============================================================================
// FACTORY
// =============================================================================

const WORKER_NAME = 'scan';

/**
 * Create a scan worker processor function.
 *
 * Accepts dependencies via a factory pattern so providers and queues can be
 * injected (and mocked in tests) without module-level singletons.
 */
export function createScanWorker(deps: ScanWorkerDeps): (job: Job<ScanJobData>) => Promise<void> {
  const { storageProvider, scanProvider, validateQueue } = deps;

  return async (job: Job<ScanJobData>): Promise<void> => {
    const { attachmentId, tenantId } = job.data;

    workerLog(WORKER_NAME, 'Starting scan', { attachmentId, tenantId });

    // 1. Load attachment (tenant-scoped)
    const attachment = await Attachment.findOne({ _id: attachmentId, tenantId }).lean();

    if (!attachment) {
      workerLog(WORKER_NAME, 'Attachment not found, skipping', { attachmentId, tenantId });
      return;
    }

    try {
      // 2. Download file from storage
      const download = await storageProvider.download(attachment.storageKey);

      // 3. Scan the file
      const scanResult = await scanProvider.scan({
        fileStream: download.body,
        filename: attachment.originalFilename,
        sizeBytes: download.sizeBytes,
      });

      // 4. Update the attachment record with scan results
      await Attachment.findOneAndUpdate(
        { _id: attachmentId, tenantId },
        {
          $set: {
            scanStatus: scanResult.status,
            scanEngine: scanResult.engine,
            scannedAt: scanResult.scannedAt,
          },
        },
      );

      // 5. Decide next step based on scan result
      if (scanResult.status === 'clean') {
        workerLog(WORKER_NAME, 'File is clean, enqueuing validate', { attachmentId });

        await validateQueue.add(QUEUE_NAMES.VALIDATE, {
          attachmentId,
          tenantId,
        });
      } else if (scanResult.status === 'infected') {
        workerLog(WORKER_NAME, 'File is infected, pipeline stopped', {
          attachmentId,
          threats: scanResult.threats,
        });
        // Pipeline stops here - do not enqueue next stage
      } else {
        // status === 'error'
        workerError(WORKER_NAME, 'Scan returned error status', new Error('Scan engine error'));
        // Pipeline stops here - scan must succeed before advancing
      }
    } catch (err: unknown) {
      // Unexpected error during download or scan
      workerError(WORKER_NAME, 'Scan job failed', err);

      await Attachment.findOneAndUpdate(
        { _id: attachmentId, tenantId },
        {
          $set: {
            scanStatus: 'error',
            scanEngine: scanProvider.name,
            scannedAt: new Date(),
          },
        },
      ).catch((dbErr: unknown) => {
        workerError(WORKER_NAME, 'Failed to update scan status after error', dbErr);
      });
    }
  };
}
