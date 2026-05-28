/**
 * Extraction Worker
 *
 * Picks up ExtractionJobData from QUEUE_EXTRACTION, loads the document,
 * extracts plain text from its raw content, and pushes the result downstream
 * to the canonical-map queue.
 *
 * The actual content-extraction logic (PDF, HTML, DOCX, etc.) is intentionally
 * stubbed — it reads the document's existing `extractedText` or raw content.
 * A dedicated extraction service will be wired in later.
 *
 * Flow: ingest --> extract --> canonical-map --> enrich --> embed
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import {
  QUEUE_EXTRACTION,
  QUEUE_PAGE_PROCESSING,
  DocumentStatus,
} from '@agent-platform/search-ai-sdk';
import { getDualConnection } from '../db/index.js';
import type { ISearchDocument, IDocumentPage } from '@agent-platform/database';
import type { Model } from 'mongoose';

// Helper to get models from dual connections
function getModels() {
  const dualConn = getDualConnection();
  const contentConn = dualConn.getContentConnection();

  return {
    SearchDocument: contentConn.models.SearchDocument as Model<ISearchDocument>,
    DocumentPage: contentConn.models.DocumentPage as Model<IDocumentPage>,
  };
}

import { withTenantContext } from '@agent-platform/database/mongo';
import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';
import { createQueue, createWorkerOptions, workerLog, workerError } from './shared.js';
import type { ExtractionJobData, PageProcessingJobData } from './shared.js';

// =============================================================================
// WORKER PROCESSOR
// =============================================================================

async function processExtractionJob(job: Job<ExtractionJobData>): Promise<void> {
  const { indexId, sourceId, documentId, tenantId } = job.data;

  workerLog('extraction', `Extracting document ${documentId}`, { indexId, sourceId });

  await withTenantContext({ tenantId }, async () => {
    // Get models from dual connections
    const { SearchDocument, DocumentPage } = getModels();

    // ── 1. Load the document ──────────────────────────────────────────────
    const document = await SearchDocument.findOne({ _id: documentId, indexId });
    if (!document) {
      throw new Error(`Document ${documentId} not found in index ${indexId}`);
    }

    // Mark document as extracting
    await SearchDocument.findOneAndUpdate(
      { _id: documentId, tenantId },
      {
        status: DocumentStatus.EXTRACTING,
        processingError: null,
      },
    );

    try {
      // ── 2. Extract content ────────────────────────────────────────────────
      let extractedText = document.extractedText;

      if (!extractedText && document.sourceUrl) {
        const fs = await import('fs/promises');
        const path = await import('path');

        let filePath: string;

        if (document.sourceUrl.startsWith('file://')) {
          filePath = document.sourceUrl.replace('file://', '');
        } else if (document.sourceUrl.startsWith('/')) {
          const relativePath = document.sourceUrl.slice(1);
          filePath = path.join(process.cwd(), relativePath);
        } else {
          if (document.sourceMetadata) {
            if (typeof document.sourceMetadata === 'string') {
              extractedText = document.sourceMetadata;
            } else if (typeof document.sourceMetadata === 'object') {
              extractedText = Object.values(document.sourceMetadata)
                .filter((v): v is string => typeof v === 'string')
                .join('\n\n');
            }
          }
          filePath = '';
        }

        // Check if pipeline has a http-webhook extraction provider (replacement mode).
        // If so, skip raw file read and delegate extraction to the webhook with file metadata.
        let webhookHandledExtraction = false;
        if (filePath) {
          try {
            const { executeCustomStagesForPhase } =
              await import('../services/pipeline-execution/execute-phase-stages.js');

            // Generate a permanent downloadable HTTP URL for citations/design-time access.
            // Runtime citations generate their own expiry-controlled tokens separately.
            const { resolvePermanentDownloadUrl } =
              await import('../services/ingestion/resolve-download-url.js');
            const downloadUrl = resolvePermanentDownloadUrl(documentId, tenantId);

            // Store download URL on the document for citations/reference
            await SearchDocument.findOneAndUpdate({ _id: documentId, tenantId }, { downloadUrl });

            const beforeResult = await executeCustomStagesForPhase(
              tenantId,
              indexId,
              documentId,
              'before-extraction',
              JSON.stringify({
                sourceUrl: downloadUrl,
                mimeType: document.contentType ?? '',
                fileName: document.originalReference ?? '',
                size: document.contentSizeBytes ?? 0,
              }),
            );
            if (beforeResult.executedCount > 0 && beforeResult.content) {
              extractedText = beforeResult.content;
              webhookHandledExtraction = true;
              workerLog('extraction', `Custom API handled extraction (before-extraction)`, {
                documentId,
                stagesRun: beforeResult.executedCount,
              });
            }
          } catch (webhookErr) {
            workerError('extraction', `Custom API before-extraction failed`, {
              documentId,
              error: webhookErr instanceof Error ? webhookErr.message : String(webhookErr),
            });
          }
        }

        if (!webhookHandledExtraction && filePath && !extractedText) {
          const mimeType = document.contentType ?? '';
          const isBinaryFormat =
            mimeType.startsWith('application/vnd.openxmlformats-officedocument.') ||
            mimeType.startsWith('application/vnd.ms-') ||
            mimeType === 'application/pdf' ||
            mimeType === 'application/zip' ||
            mimeType === 'application/msword';

          if (isBinaryFormat) {
            workerError('extraction', `Cannot read binary format as text`, {
              documentId,
              mimeType,
            });
          } else {
            try {
              workerLog('extraction', `Reading file from ${filePath}`);
              const fileContent = await fs.readFile(filePath, 'utf-8');
              extractedText = fileContent;
            } catch (error) {
              workerError('extraction', `Failed to read file ${filePath}`, {
                error: error instanceof Error ? error.message : String(error),
                documentId,
              });
            }
          }
        }
      }

      if (!extractedText || extractedText.trim().length === 0) {
        workerLog('extraction', `No content to extract for document ${documentId}`);
        await SearchDocument.findOneAndUpdate(
          { _id: documentId, tenantId },
          {
            status: DocumentStatus.ERROR,
            processingError: 'No extractable content found',
          },
        );
        return;
      }

      // ── 3. Run after-extraction custom stages (transformers) ────────────
      let processedText = extractedText;
      try {
        const { executeCustomStagesForPhase } =
          await import('../services/pipeline-execution/execute-phase-stages.js');
        const phaseResult = await executeCustomStagesForPhase(
          tenantId,
          indexId,
          documentId,
          'after-extraction',
          extractedText,
        );
        if (phaseResult.executedCount > 0 && phaseResult.content) {
          processedText = phaseResult.content;
          workerLog('extraction', `After-extraction stages modified content`, {
            documentId,
            stagesRun: phaseResult.executedCount,
          });
        }
      } catch {
        // Non-breaking — continue with original text
      }

      // ── 4. Update document with extracted content ─────────────────────────
      await SearchDocument.findOneAndUpdate(
        { _id: documentId, tenantId },
        {
          extractedText: processedText,
          contentSizeBytes: Buffer.byteLength(processedText, 'utf-8'),
          status: DocumentStatus.EXTRACTED,
          pageCount: 1,
        },
      );

      // ── 5. Create single DocumentPage for text content ────────────────────
      const page = await DocumentPage.create({
        tenantId,
        indexId,
        documentId,
        pageNumber: 1,
        text: processedText,
        tokenCount: countTokens(processedText),
        layout: {
          headings: [],
          structure: { type: 'legacy-text', source: 'plain-text-extraction' },
        },
        tables: [],
        images: [],
        screenshot: null,
        status: 'pending',
      });

      workerLog('extraction', `Created single page for document ${documentId}`, {
        pageId: page._id,
        tokenCount: page.tokenCount,
      });

      // ── 5. Enqueue page-processing job for chunking ───────────────────────
      const pageProcessingQueue = createQueue(QUEUE_PAGE_PROCESSING);
      try {
        // Propagate pipeline chunking config from upstream job data (if set)
        const jobDataAny = job.data as unknown as Record<string, unknown>;
        const chunkingStage = jobDataAny._chunkingStage as
          | import('./shared.js').PipelineStageConfig
          | undefined;

        const pageProcessingData: PageProcessingJobData = {
          indexId,
          documentId,
          pageIds: [page._id.toString()],
          tenantId,
          previousPageSummary: null,
          pipelineStage: chunkingStage,
        };

        await pageProcessingQueue.add(`page-processing:${documentId}`, pageProcessingData, {
          // Use timestamp suffix to avoid BullMQ job deduplication on reprocessing.
          // Old completed/failed job keys linger in Redis and block re-enqueue.
          jobId: `pp-${indexId}-${documentId}-${Date.now()}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
        });

        workerLog('extraction', `Enqueued page-processing job for document ${documentId}`);
      } finally {
        await pageProcessingQueue.close();
      }

      workerLog('extraction', `Document ${documentId} extracted successfully`, {
        sizeBytes: Buffer.byteLength(extractedText, 'utf-8'),
      });
    } catch (error) {
      // Mark document as errored
      const errMsg = error instanceof Error ? error.message : String(error);
      await SearchDocument.findOneAndUpdate(
        { _id: documentId, tenantId },
        {
          status: DocumentStatus.ERROR,
          processingError: `Extraction failed: ${errMsg}`,
        },
      );
      throw error;
    }
  });
}

// =============================================================================
// WORKER FACTORY
// =============================================================================

/**
 * Create and return the extraction worker.
 *
 * @param concurrency — max parallel extraction jobs (default 5)
 */
export default function createExtractionWorker(concurrency = 5): Worker<ExtractionJobData> {
  const worker = new Worker<ExtractionJobData>(
    QUEUE_EXTRACTION,
    processExtractionJob,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('extraction', `Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    workerError('extraction', `Job ${job?.id} failed`, err);
  });

  worker.on('error', (err) => {
    workerError('extraction', 'Worker error', err);
  });

  workerLog('extraction', `Started with concurrency=${concurrency}`);
  return worker;
}
