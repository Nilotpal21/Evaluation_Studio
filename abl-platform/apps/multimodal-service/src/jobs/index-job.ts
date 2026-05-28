/**
 * Index Worker - Search Indexing Pipeline Stage
 *
 * Sends processed content to Search AI for embedding and indexing,
 * enabling semantic search across attachment contents.
 *
 * Pipeline flow:
 *   scan -> validate -> process -> index (this)
 *
 * Loads the attachment from DB (tenant-scoped), validates it has completed
 * processing, then calls AttachmentSearchProducer.ingest() to feed content
 * into the Search AI ingestion pipeline.
 *
 * Never throws — all errors are caught and logged.
 * All DB queries are tenant-scoped: findOne({ _id, tenantId }).
 */

import type { Job } from 'bullmq';
import { Attachment } from '@agent-platform/database';
import type { IAttachment } from '@agent-platform/database';
import type { IngestOutcome } from '../services/attachment-search-producer.js';
import type { IndexJobData } from './queues.js';
import { workerLog, workerError } from './queues.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const WORKER_NAME = 'index';

/** The processing status an attachment must have before indexing. */
const REQUIRED_PROCESSING_STATUS = 'completed';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Interface for the search producer dependency.
 * Uses a structural type rather than the concrete class to allow easy mocking.
 */
export interface SearchProducerDep {
  ingest(attachment: IAttachment): Promise<IngestOutcome>;
}

export interface IndexWorkerDeps {
  searchProducer: SearchProducerDep;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create an index worker processor function.
 *
 * Accepts dependencies via a factory pattern so providers can be
 * injected (and mocked in tests) without module-level singletons.
 */
export function createIndexWorker(
  deps: IndexWorkerDeps,
): (job: Job<IndexJobData>) => Promise<void> {
  const { searchProducer } = deps;

  return async (job: Job<IndexJobData>): Promise<void> => {
    const { attachmentId, tenantId } = job.data;

    workerLog(WORKER_NAME, 'Starting search indexing', { attachmentId, tenantId });

    try {
      // 1. Load attachment (tenant-scoped)
      const attachment = await Attachment.findOne({ _id: attachmentId, tenantId }).lean();

      if (!attachment) {
        workerLog(WORKER_NAME, 'Attachment not found, skipping', { attachmentId, tenantId });
        return;
      }

      // 2. Validate processing has completed
      if (attachment.processingStatus !== REQUIRED_PROCESSING_STATUS) {
        workerLog(WORKER_NAME, 'Attachment not yet processed, skipping', {
          attachmentId,
          tenantId,
          processingStatus: attachment.processingStatus,
        });
        return;
      }

      // 3. Call searchProducer.ingest()
      const outcome = await searchProducer.ingest(attachment);

      // 4. Log the outcome
      if (!outcome.success) {
        workerError(WORKER_NAME, 'Search indexing failed', new Error(outcome.error.message));
        return;
      }

      if (outcome.skipped) {
        workerLog(WORKER_NAME, 'Search indexing skipped', {
          attachmentId,
          tenantId,
          reason: outcome.reason,
        });
        return;
      }

      // TypeScript narrows to IngestResult here (success: true, skipped?: false)
      workerLog(WORKER_NAME, 'Search indexing completed', {
        attachmentId,
        tenantId,
        documentId: outcome.documentId,
        chunkCount: outcome.chunkCount,
      });
    } catch (err: unknown) {
      workerError(WORKER_NAME, 'Unexpected error during search indexing', err);
    }
  };
}
