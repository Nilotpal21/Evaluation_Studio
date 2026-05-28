/**
 * Multi-Modal Worker
 *
 * Processes chunks with images and tables, generating descriptions and summaries
 * using vision and language models via the platform's LLM Hub.
 *
 * Runs in parallel with embedding workers after enrichment.
 *
 * Flow: ... → enrich → [multimodal + embedding] → indexed
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { QUEUE_MULTIMODAL, DocumentStatus } from '@agent-platform/search-ai-sdk';

import { withTenantContext } from '@agent-platform/database/mongo';
import { getConfig } from '../config/index.js';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import { MultiModalEnricher } from '../services/multimodal/index.js';
import type { ImageData, TableData } from '../services/multimodal/index.js';
import {
  createWorkerOptions,
  workerLog,
  workerError,
  withTraceContext,
  type MultiModalJobData,
} from './shared.js';

// =============================================================================
// WORKER PROCESSOR
// =============================================================================

import { getLazyModel } from '../db/index.js';
import type { ISearchDocument, ISearchChunk } from '@agent-platform/database/models';

// Models bound to correct databases (platform vs content)
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk'); // → search_ai
async function processMultiModalJob(job: Job<MultiModalJobData>): Promise<void> {
  const { indexId, documentId, tenantId } = job.data;
  let { chunkIds } = job.data;

  // When triggered via BullMQ Flow (reprocess), chunkIds may not be in job data
  // because the flow builder sets all job data upfront before chunks exist.
  // Resolve from DB in that case (same pattern as embedding-worker).
  if (!chunkIds || chunkIds.length === 0) {
    const allChunks = await SearchChunk.find({ indexId, documentId, tenantId })
      .select('_id')
      .lean();
    chunkIds = allChunks.map((c: { _id: string }) => String(c._id));
    workerLog('multimodal', `Resolved ${chunkIds.length} chunkIds from DB (not in job data)`, {
      indexId,
      documentId,
    });
  }

  workerLog('multimodal', `Processing multi-modal job ${job.id}`, {
    indexId,
    documentId,
    chunkIds: chunkIds.length,
    tenantId,
  });

  // Resolve per-index LLM configuration
  const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);

  // Check if multimodal is enabled for this index
  if (!llmConfig.useCases.multimodal.enabled) {
    workerLog('multimodal', `Multimodal disabled for index ${indexId}, skipping`, { documentId });
    return;
  }

  // Get global config for infrastructure settings (rate limits, max sizes only)
  const globalConfig = getConfig();

  // Use Model Library for BOTH vision and table summarization.
  // The resolved multimodal use-case config comes from the user's Model Library
  // via resolveIndexLLMConfig → tier fallback. No hardcoded env var models.
  const resolvedProvider = llmConfig.useCases.multimodal.provider as any;
  const resolvedApiKey = llmConfig.useCases.multimodal.apiKey;
  const resolvedModel = llmConfig.useCases.multimodal.model;

  workerLog('multimodal', `Resolved LLM config for multimodal`, {
    provider: resolvedProvider,
    hasApiKey: !!resolvedApiKey,
    model: resolvedModel,
    enableImageDescription: llmConfig.useCases.multimodal.enableImageDescription,
    enableTableSummarization: llmConfig.useCases.multimodal.enableTableSummarization,
  });

  const service = new MultiModalEnricher({
    enabled: true, // Already checked above
    visionProvider: resolvedProvider,
    visionApiKey: resolvedApiKey,
    visionModel: resolvedModel,
    tableSummarizerProvider: resolvedProvider,
    tableSummarizerApiKey: resolvedApiKey,
    tableSummarizerModel: resolvedModel,
    enableImageDescription: llmConfig.useCases.multimodal.enableImageDescription ?? true,
    enableTableSummarization: llmConfig.useCases.multimodal.enableTableSummarization ?? true,
    enableChartAnalysis: llmConfig.useCases.multimodal.enableChartAnalysis ?? true,
    maxImageSizeBytes: globalConfig.multiModal.maxImageSizeBytes,
    maxTableSizeBytes: globalConfig.multiModal.maxTableSizeBytes,
    rateLimitPerMinute: globalConfig.multiModal.rateLimitPerMinute,
  });

  if (!service.isAvailable()) {
    workerLog('multimodal', 'Multi-modal service not available (no API keys), skipping', {
      documentId,
    });
    return;
  }

  await withTraceContext(job.data as unknown as Record<string, unknown>, () =>
    withTenantContext({ tenantId }, async () => {
      try {
        // Load chunks
        const chunks = await SearchChunk.find({
          _id: { $in: chunkIds },
          documentId,
          tenantId,
          indexId,
        }).lean();

        if (chunks.length === 0) {
          workerLog('multimodal', `No chunks found for document ${documentId}`);
          return;
        }

        workerLog('multimodal', `Processing ${chunks.length} chunk(s)`, {
          documentId,
          indexId,
        });

        let totalImages = 0;
        let totalTables = 0;
        let totalCost = 0;
        let totalTokens = 0;

        // Process each chunk
        for (const chunk of chunks) {
          // Extract images and tables from chunk metadata
          const images = extractImagesFromChunk(chunk);
          const tables = extractTablesFromChunk(chunk);

          if (images.length === 0 && tables.length === 0) {
            continue; // Skip chunks without visual content
          }

          try {
            const result = await service.processChunk({ images, tables });

            // Update chunk with descriptions/summaries
            await SearchChunk.findOneAndUpdate(
              { _id: chunk._id, tenantId },
              {
                $set: {
                  'metadata.imageDescriptions': result.images,
                  'metadata.tableSummaries': result.tables,
                  'metadata.multiModalProcessed': true,
                  'metadata.multiModalCost': result.totalCostUsd,
                  'metadata.multiModalTokens': result.totalTokens,
                },
              },
            );

            totalImages += result.images?.length || 0;
            totalTables += result.tables?.length || 0;
            totalCost += result.totalCostUsd;
            totalTokens += result.totalTokens;

            workerLog('multimodal', `Processed chunk ${chunk._id}`, {
              images: result.images?.length || 0,
              tables: result.tables?.length || 0,
              cost: result.totalCostUsd,
            });
          } catch (error) {
            workerError('multimodal', `Failed to process chunk ${chunk._id}`, error);
            // Continue with other chunks
          }
        }

        // Update document with multi-modal metadata
        await SearchDocument.findOneAndUpdate(
          { _id: documentId, tenantId },
          {
            $set: {
              'metadata.multiModal': {
                totalImages,
                totalTables,
                totalCost,
                totalTokens,
                processedAt: new Date(),
              },
            },
          },
        );

        workerLog('multimodal', `Completed multi-modal processing`, {
          documentId,
          totalImages,
          totalTables,
          totalCost,
          totalTokens,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);

        // Update document with error (but don't fail the whole document)
        await SearchDocument.findOneAndUpdate(
          { _id: documentId, tenantId },
          {
            $set: {
              'metadata.multiModalError': errMsg,
            },
          },
        );

        workerError('multimodal', `Multi-modal processing failed for ${documentId}`, error);
        // Don't throw - this is optional enrichment
      }
    }),
  );
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Extract images from chunk metadata
 */
function extractImagesFromChunk(chunk: any): ImageData[] {
  const images: ImageData[] = [];

  // Check if chunk has images in metadata
  if (chunk.metadata?.images && Array.isArray(chunk.metadata.images)) {
    for (const img of chunk.metadata.images) {
      // Support multiple image source formats:
      // - img.base64: inline base64-encoded data
      // - img.url: direct HTTP(S) URL
      // - img.s3Url: local file or S3 URL (from Docling extraction)
      const imageSource = img.base64 || img.url || img.s3Url;
      if (imageSource) {
        const isBase64 = !!img.base64;
        images.push({
          data: imageSource,
          format: isBase64 ? 'base64' : 'url',
          mimeType: img.mimeType || `image/${img.format || 'png'}`,
          width: img.width,
          height: img.height,
          context: chunk.content.slice(0, 200), // First 200 chars as context
        });
      }
    }
  }

  return images;
}

/**
 * Extract tables from chunk metadata
 */
function extractTablesFromChunk(chunk: any): TableData[] {
  const tables: TableData[] = [];

  // Check if chunk has tables in metadata
  if (chunk.metadata?.tables && Array.isArray(chunk.metadata.tables)) {
    for (const table of chunk.metadata.tables) {
      if (table.html || table.csv) {
        tables.push({
          content: table.html || table.csv,
          format: table.html ? 'html' : 'csv',
          rowCount: table.rowCount,
          columnCount: table.columnCount,
          context: chunk.content.slice(0, 200),
        });
      }
    }
  }

  return tables;
}

// =============================================================================
// WORKER FACTORY
// =============================================================================

/**
 * Create and return the multi-modal worker.
 *
 * @param concurrency — max parallel multi-modal jobs (default 2, due to API rate limits)
 */
export default function createMultiModalWorker(concurrency = 2): Worker<MultiModalJobData> {
  const worker = new Worker<MultiModalJobData>(
    QUEUE_MULTIMODAL,
    processMultiModalJob,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('multimodal', `Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    workerError('multimodal', `Job ${job?.id} failed`, err);
  });

  worker.on('error', (err) => {
    workerError('multimodal', 'Worker error', err);
  });

  // Note: Cleanup handled by central shutdown in server.ts via stopWorkers()
  // Removed redundant SIGTERM handler to prevent listener accumulation

  workerLog('multimodal', `Started with concurrency=${concurrency}`);
  return worker;
}
