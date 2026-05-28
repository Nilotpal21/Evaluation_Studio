/**
 * AttachmentSearchProducer
 *
 * Feeds processed attachment content into the Search AI ingestion pipeline.
 * Takes an IAttachment record that has been processed (has processedContent
 * and/or imageDescription), resolves the project's search index, builds
 * combined content, and calls SearchAIClient.ingestDocument().
 *
 * All DB queries are tenant-scoped: findOneAndUpdate({ _id, tenantId }),
 * never findByIdAndUpdate().
 */

import { Attachment } from '@agent-platform/database';
import type { IAttachment } from '@agent-platform/database';
import type { SearchAIClient, IngestDocumentResult } from '@agent-platform/search-ai-sdk';
import { workerLog, workerError } from '../jobs/queues.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const WORKER_NAME = 'search-producer';

/** Separator between processedContent and imageDescription when both present */
const CONTENT_SEPARATOR = '\n\n';

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Resolves the Search AI index ID for a given project.
 * Injected by the index-job worker to decouple from direct DB queries.
 */
export interface SearchIndexResolver {
  resolveForProject(tenantId: string, projectId: string): Promise<string | null>;
}

export interface AttachmentSearchProducerDeps {
  searchClient: SearchAIClient;
  indexResolver: SearchIndexResolver;
}

export interface IngestResult {
  success: true;
  skipped?: false;
  documentId: string;
  chunkCount: number;
}

export interface IngestSkipped {
  success: true;
  skipped: true;
  reason: string;
}

export interface IngestError {
  success: false;
  error: { code: string; message: string };
}

export type IngestOutcome = IngestResult | IngestSkipped | IngestError;

// =============================================================================
// SERVICE
// =============================================================================

export class AttachmentSearchProducer {
  private readonly searchClient: SearchAIClient;
  private readonly indexResolver: SearchIndexResolver;

  constructor(deps: AttachmentSearchProducerDeps) {
    this.searchClient = deps.searchClient;
    this.indexResolver = deps.indexResolver;
  }

  /**
   * Ingest a processed attachment into Search AI.
   *
   * Preconditions:
   *   - attachment.processingStatus === 'completed'
   *   - At least one of processedContent or imageDescription is present
   *
   * Steps:
   *   1. Validate there is content to index
   *   2. Resolve the project's search index
   *   3. Build combined content string
   *   4. Call SearchAIClient.ingestDocument()
   *   5. Update the Attachment record with searchIndexId, searchDocumentId, embeddingStatus
   */
  async ingest(attachment: IAttachment): Promise<IngestOutcome> {
    const { _id: attachmentId, tenantId, projectId } = attachment;

    try {
      // 1. Check if there is indexable content
      const hasContent = attachment.processedContent || attachment.imageDescription;
      if (!hasContent) {
        workerLog(WORKER_NAME, 'No content to index, skipping', { attachmentId, tenantId });

        await Attachment.findOneAndUpdate(
          { _id: attachmentId, tenantId },
          { $set: { embeddingStatus: 'skipped' } },
        );

        return { success: true, skipped: true, reason: 'no_content' };
      }

      // 2. Resolve search index for project
      const searchIndexId = await this.indexResolver.resolveForProject(tenantId, projectId);
      if (!searchIndexId) {
        workerLog(WORKER_NAME, 'No search index configured for project, skipping', {
          attachmentId,
          tenantId,
          projectId,
        });

        await Attachment.findOneAndUpdate(
          { _id: attachmentId, tenantId },
          { $set: { embeddingStatus: 'skipped' } },
        );

        return { success: true, skipped: true, reason: 'no_search_index' };
      }

      // 3. Build combined content
      const rawText = buildContent(attachment);

      // 4. Build source metadata
      const sourceMetadata: Record<string, unknown> = {
        sourceType: 'attachment',
        attachmentId,
        tenantId,
        projectId,
        sessionId: attachment.sessionId,
        category: attachment.category,
        mimeType: attachment.mimeType,
        originalFilename: attachment.originalFilename,
      };

      // 5. Mark as processing and ingest into Search AI
      await Attachment.findOneAndUpdate(
        { _id: attachmentId, tenantId },
        { $set: { embeddingStatus: 'processing', searchIndexId } },
      );

      let result: IngestDocumentResult;
      try {
        result = await this.searchClient.ingestDocument(searchIndexId, {
          title: attachment.originalFilename,
          rawText,
          sourceMetadata,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        workerError(WORKER_NAME, 'Ingestion failed', err);

        await Attachment.findOneAndUpdate(
          { _id: attachmentId, tenantId },
          { $set: { embeddingStatus: 'failed', searchIndexId } },
        ).catch((dbErr: unknown) => {
          workerError(
            WORKER_NAME,
            'Failed to update embedding status after ingestion error',
            dbErr,
          );
        });

        return {
          success: false,
          error: { code: 'INGESTION_FAILED', message: errorMessage },
        };
      }

      // 6. Update attachment record with successful indexing result
      await Attachment.findOneAndUpdate(
        { _id: attachmentId, tenantId },
        {
          $set: {
            searchIndexId,
            searchDocumentId: result.documentId,
            embeddingStatus: 'completed',
            embeddedAt: new Date(),
          },
        },
      );

      workerLog(WORKER_NAME, 'Attachment indexed successfully', {
        attachmentId,
        tenantId,
        searchIndexId,
        documentId: result.documentId,
        chunkCount: result.chunkCount,
      });

      return {
        success: true,
        documentId: result.documentId,
        chunkCount: result.chunkCount,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      workerError(WORKER_NAME, 'Unexpected error during ingestion', err);

      return {
        success: false,
        error: { code: 'INGEST_ERROR', message: errorMessage },
      };
    }
  }

  /**
   * Remove an attachment's search index entry.
   *
   * Called during cleanup (expiry, session deletion, GDPR erasure).
   * Best-effort: returns success even if no search entry exists (no-op).
   */
  async remove(attachment: IAttachment): Promise<{ success: boolean }> {
    const { _id: attachmentId, tenantId, searchIndexId, searchDocumentId } = attachment;

    try {
      if (searchIndexId && searchDocumentId) {
        try {
          await this.searchClient.deleteDocument(searchIndexId, searchDocumentId);
        } catch (err) {
          workerError(WORKER_NAME, 'Failed to delete search document', err);
        }
      }

      await Attachment.findOneAndUpdate(
        { _id: attachmentId, tenantId },
        { $set: { searchIndexId: null, searchDocumentId: null, embeddingStatus: 'skipped' } },
      );

      return { success: true };
    } catch (err) {
      workerError(WORKER_NAME, 'Failed to remove search entry', err);
      return { success: false };
    }
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Build a combined content string from processedContent and imageDescription.
 * If both are present, they are joined with a separator.
 */
function buildContent(attachment: IAttachment): string {
  const parts: string[] = [];

  if (attachment.processedContent) {
    parts.push(attachment.processedContent);
  }

  if (attachment.imageDescription) {
    parts.push(attachment.imageDescription);
  }

  return parts.join(CONTENT_SEPARATOR);
}
