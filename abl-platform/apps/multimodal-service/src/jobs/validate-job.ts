/**
 * Validate Worker - MIME Validation Pipeline Stage
 *
 * Downloads the first bytes of the attachment from storage, runs magic-byte
 * MIME detection via `validateMime()`, and updates the Attachment record.
 *
 * Pipeline flow:
 *   scan -> validate (this) -> process -> index
 *
 * If the MIME type is valid, enqueues a process-job with the detected category.
 * If invalid, marks the attachment as failed and stops the pipeline.
 *
 * All DB queries are tenant-scoped: `findOne({ _id, tenantId })`.
 */

import type { Job } from 'bullmq';
import { Attachment } from '@agent-platform/database';
import type { StorageProvider } from '@agent-platform/shared';
import type { ValidateJobData, ProcessJobData } from './queues.js';
import { QUEUE_NAMES, workerLog, workerError } from './queues.js';
import { validateMime, mimeToCategory } from '../security/mime-validator.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Number of bytes to download for magic-byte detection.
 * 4100 bytes is sufficient for all known magic-byte signatures.
 */
const MAGIC_BYTE_BUFFER_SIZE = 4100;

// =============================================================================
// TYPES
// =============================================================================

export interface ValidateWorkerDeps {
  storageProvider: StorageProvider;
  /** Queue for enqueuing the next pipeline stage */
  processQueue: { add(name: string, data: ProcessJobData): Promise<unknown> };
}

// =============================================================================
// FACTORY
// =============================================================================

const WORKER_NAME = 'validate';

/**
 * Create a validate worker processor function.
 *
 * Accepts dependencies via a factory pattern so providers and queues can be
 * injected (and mocked in tests) without module-level singletons.
 */
export function createValidateWorker(
  deps: ValidateWorkerDeps,
): (job: Job<ValidateJobData>) => Promise<void> {
  const { storageProvider, processQueue } = deps;

  return async (job: Job<ValidateJobData>): Promise<void> => {
    const { attachmentId, tenantId } = job.data;

    workerLog(WORKER_NAME, 'Starting MIME validation', { attachmentId, tenantId });

    // 1. Load attachment (tenant-scoped)
    const attachment = await Attachment.findOne({ _id: attachmentId, tenantId }).lean();

    if (!attachment) {
      workerLog(WORKER_NAME, 'Attachment not found, skipping', { attachmentId, tenantId });
      return;
    }

    try {
      // 2. Download file from storage (only need first bytes for magic detection)
      const download = await storageProvider.download(attachment.storageKey);

      // 3. Read the first MAGIC_BYTE_BUFFER_SIZE bytes from the stream
      const buffer = await readFirstBytes(download.body, MAGIC_BYTE_BUFFER_SIZE);

      // 4. Validate MIME type via magic-byte detection
      const result = await validateMime(buffer, attachment.mimeType);

      // 5. Update the attachment record with the detected MIME type
      await Attachment.findOneAndUpdate(
        { _id: attachmentId, tenantId },
        {
          $set: {
            detectedMimeType: result.detectedMimeType,
          },
        },
      );

      if (result.valid) {
        // 6a. Valid MIME: determine category and enqueue process-job
        const category = mimeToCategory(result.detectedMimeType) ?? attachment.category;

        workerLog(WORKER_NAME, 'MIME valid, enqueuing process', {
          attachmentId,
          detectedMimeType: result.detectedMimeType,
          category,
        });

        await processQueue.add(QUEUE_NAMES.PROCESS, {
          attachmentId,
          tenantId,
          category,
        });
      } else {
        // 6b. Invalid MIME: mark processing as failed, stop pipeline
        workerLog(WORKER_NAME, 'MIME validation failed', {
          attachmentId,
          declared: attachment.mimeType,
          detected: result.detectedMimeType,
        });

        await Attachment.findOneAndUpdate(
          { _id: attachmentId, tenantId },
          {
            $set: {
              processingStatus: 'failed',
              processingError: `MIME mismatch: declared ${attachment.mimeType}, detected ${result.detectedMimeType}`,
            },
          },
        );
      }
    } catch (err: unknown) {
      workerError(WORKER_NAME, 'Validate job failed', err);

      await Attachment.findOneAndUpdate(
        { _id: attachmentId, tenantId },
        {
          $set: {
            processingStatus: 'failed',
            processingError: err instanceof Error ? err.message : String(err),
          },
        },
      ).catch((dbErr: unknown) => {
        workerError(
          WORKER_NAME,
          'Failed to update processing status after validation error',
          dbErr,
        );
      });
    }
  };
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Read the first `maxBytes` from a Readable stream into a Buffer.
 *
 * Destroys the stream after reading enough bytes to avoid resource leaks.
 */
async function readFirstBytes(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalRead = 0;

  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf-8')
        : Buffer.from(chunk as unknown as ArrayBuffer);
    chunks.push(buf);
    totalRead += buf.length;

    if (totalRead >= maxBytes) {
      // Destroy the stream to release the underlying resource
      if ('destroy' in stream && typeof stream.destroy === 'function') {
        stream.destroy();
      }
      break;
    }
  }

  const combined = Buffer.concat(chunks);
  return combined.subarray(0, maxBytes);
}
