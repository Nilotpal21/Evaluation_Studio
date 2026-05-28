/**
 * Enrichment Worker
 *
 * Picks up EnrichmentJobData from QUEUE_ENRICHMENT, loads chunks,
 * computes text stats, updates chunk and document records, then
 * enqueues downstream jobs (embedding, multimodal, tree-building, etc.).
 *
 * Language detection: handled by docling-extraction-worker (Docling's fasttext/lingua).
 * Document summary: handled by page-processing-worker (LLM progressive summarization).
 * Entity extraction: handled by kg-enrichment-worker (taxonomy-scoped, hybrid regex+LLM).
 *
 * Flow: ingest --> extract --> page-processing --> canonical-map --> enrich --> embed
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import {
  QUEUE_ENRICHMENT,
  QUEUE_EMBEDDING,
  QUEUE_MULTIMODAL,
  QUEUE_TREE_BUILDING,
  QUEUE_SCOPE_CLASSIFICATION,
  DocumentStatus,
  ChunkStatus,
} from '@agent-platform/search-ai-sdk';
import { getLazyModel } from '../db/index.js';
import type { ISearchDocument, ISearchChunk, ISearchIndex } from '@agent-platform/database/models';

// Models bound to correct databases (platform vs content)
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk'); // → search_ai
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex'); // → abl_platform

import { withTenantContext } from '@agent-platform/database/mongo';
import { injectTrace } from '@agent-platform/shared-observability/tracing';
import { getObservabilityContext } from '@abl/compiler/platform/observability';
import {
  createQueue,
  createWorkerOptions,
  workerLog,
  workerError,
  withTraceContext,
} from './shared.js';
import type {
  EnrichmentJobData,
  EmbeddingJobData,
  MultiModalJobData,
  TreeBuildingJobData,
  ScopeClassificationJobData,
} from './shared.js';
import { getConfig } from '../config/index.js';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import { logStatusTransition } from './status-logger.js';
import { executeCustomEnrichmentStages } from '../services/pipeline-execution/execute-custom-stages.js';

// =============================================================================
// WORKER PROCESSOR
// =============================================================================

export async function processEnrichmentJob(job: Job<EnrichmentJobData>): Promise<void> {
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
    workerLog('enrichment', `Resolved ${chunkIds.length} chunkIds from DB (not in job data)`, {
      indexId,
      documentId,
    });
  }

  workerLog('enrichment', `Enriching document ${documentId} (${chunkIds.length} chunks)`, {
    indexId,
  });

  await withTraceContext(job.data as unknown as Record<string, unknown>, () =>
    withTenantContext({ tenantId }, async () => {
      // ── 1. Load the document ──────────────────────────────────────────────
      const document = await SearchDocument.findOne({ _id: documentId, indexId });
      if (!document) {
        throw new Error(`Document ${documentId} not found in index ${indexId}`);
      }

      // ── 2. Load chunks ────────────────────────────────────────────────────
      const chunks = await SearchChunk.find({
        _id: { $in: chunkIds },
        tenantId,
        indexId,
      });

      if (chunks.length === 0) {
        workerLog('enrichment', `No chunks found for document ${documentId}, skipping`);
        return;
      }

      // ── 3. Mark as ENRICHING ──────────────────────────────────────────────
      logStatusTransition({
        documentId,
        indexId,
        tenantId,
        fromStatus: document.status,
        toStatus: 'ENRICHING' as DocumentStatus,
        worker: 'enrichment',
        timestamp: new Date(),
      });

      try {
        // ── 3. Run enrichment on each chunk ─────────────────────────────────
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];

          // Compute basic text stats per chunk
          const enrichmentMetadata = {
            charCount: chunk.content.length,
            wordCount: chunk.content.split(/\s+/).filter(Boolean).length,
            enrichedAt: new Date().toISOString(),
          };

          // Update chunk: store enrichment stats in the generic metadata bag.
          // Language is set on canonicalMetadata from document.language (set by docling-extraction-worker).
          const updatedCanonical = { ...(chunk.canonicalMetadata ?? {}) };
          if (document.language && !updatedCanonical.language) {
            updatedCanonical.language = document.language;
          }

          await SearchChunk.findOneAndUpdate(
            { _id: chunk._id, tenantId },
            {
              $set: {
                canonicalMetadata: updatedCanonical,
                'metadata.enrichment': enrichmentMetadata,
                status: ChunkStatus.PENDING, // ready for embedding
              },
            },
          );

          // Report per-chunk progress
          const progress = Math.round(((i + 1) / chunks.length) * 100);
          await job.updateProgress(progress);
        }

        // ── 4. Update document status + textPreview ────────────────────────
        // Note: document language is set by docling-extraction-worker (from Docling's fasttext/lingua detection).
        // Document summary is written by page-processing-worker as metadata.documentSummary.
        // Document-level entity extraction is handled by kg-enrichment-worker (taxonomy-scoped).
        // textPreview: short raw text snippet for UI display (first 500 chars of first chunk by index).
        const sortedChunks = [...chunks].sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
        const textPreview = sortedChunks.length > 0 ? sortedChunks[0].content.slice(0, 500) : null;

        logStatusTransition({
          documentId,
          indexId,
          tenantId,
          fromStatus: 'ENRICHING' as DocumentStatus,
          toStatus: DocumentStatus.ENRICHED,
          worker: 'enrichment',
          timestamp: new Date(),
          metadata: { chunkCount: chunks.length },
        });

        await SearchDocument.findOneAndUpdate(
          { _id: documentId, tenantId },
          {
            status: DocumentStatus.ENRICHED,
            textPreview,
          },
        );

        // ── 5. Execute custom pipeline stages (webhook, JS sandbox) ────────
        // Runs any user-configured enrichment stages from the pipeline definition.
        // Non-breaking: if no pipeline or no custom stages, this is a no-op.
        try {
          const customCount = await executeCustomEnrichmentStages(
            tenantId,
            indexId,
            documentId,
            chunkIds,
          );
          if (customCount > 0) {
            workerLog(
              'enrichment',
              `Executed ${customCount} custom enrichment stage(s) for ${documentId}`,
            );
          }
        } catch (customError) {
          workerError(
            'enrichment',
            `Custom enrichment stages failed for ${documentId}`,
            customError instanceof Error ? customError : new Error(String(customError)),
          );
          // Don't fail the pipeline — custom stages are enhancement
        }

        // ── 6. Enqueue parallel downstream jobs ─────────────────────────────
        // All jobs are enqueued in parallel — BullMQ handles independent execution.
        // Config-gated features check app config; LLM-gated features check credentials.
        const config = getConfig();
        const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);

        // Multi-modal (config-gated)
        if (config.multiModal.enabled) {
          const mmData: MultiModalJobData = { indexId, documentId, chunkIds, tenantId };
          const obsCtxMm = getObservabilityContext();
          if (obsCtxMm) {
            injectTrace(mmData as unknown as Record<string, unknown>, {
              traceId: obsCtxMm.traceId,
              spanId: obsCtxMm.spanId,
            });
          }
          await createQueue(QUEUE_MULTIMODAL).add(`mm:${documentId}`, mmData, {
            jobId: `mm:${indexId}:${documentId}`,
            attempts: 2,
            backoff: { type: 'exponential', delay: 10_000 },
          });
        }

        // Tree building (config-gated)
        if (config.treeBuilder.enabled) {
          const treeData: TreeBuildingJobData = { indexId, documentId, tenantId };
          const obsCtxTree = getObservabilityContext();
          if (obsCtxTree) {
            injectTrace(treeData as unknown as Record<string, unknown>, {
              traceId: obsCtxTree.traceId,
              spanId: obsCtxTree.spanId,
            });
          }
          await createQueue(QUEUE_TREE_BUILDING).add(`tree:${documentId}`, treeData, {
            jobId: `tree:${indexId}:${documentId}`,
            attempts: 2,
            backoff: { type: 'exponential', delay: 10_000 },
          });
        }

        // Question synthesis: handled by page-processing-worker (per-chunk inline + document-level enqueue).
        // Do NOT enqueue here — it causes duplicate question generation and doubles LLM cost.

        // Scope classification (LLM-gated)
        if (llmConfig.useCases.scopeClassification?.enabled) {
          const scopeData: ScopeClassificationJobData = { indexId, documentId, tenantId };
          const obsCtxScope = getObservabilityContext();
          if (obsCtxScope) {
            injectTrace(scopeData as unknown as Record<string, unknown>, {
              traceId: obsCtxScope.traceId,
              spanId: obsCtxScope.spanId,
            });
          }
          await createQueue(QUEUE_SCOPE_CLASSIFICATION).add(`scope:${documentId}`, scopeData, {
            jobId: `scope:${indexId}:${documentId}`,
            attempts: 2,
            backoff: { type: 'exponential', delay: 10_000 },
          });
        }

        // ── 6. Enqueue embedding job ──────────────────────────────────────────
        const embeddingData: EmbeddingJobData = { indexId, documentId, chunkIds, tenantId };
        const obsCtxEmbed = getObservabilityContext();
        if (obsCtxEmbed) {
          injectTrace(embeddingData as unknown as Record<string, unknown>, {
            traceId: obsCtxEmbed.traceId,
            spanId: obsCtxEmbed.spanId,
          });
        }
        await createQueue(QUEUE_EMBEDDING).add(`embed:${documentId}`, embeddingData, {
          jobId: `embed:${indexId}:${documentId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
        });

        workerLog('enrichment', `Document ${documentId} enriched`, {
          language: document.language || null,
          chunkCount: chunks.length,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        await SearchDocument.findOneAndUpdate(
          { _id: documentId, tenantId },
          {
            status: DocumentStatus.ERROR,
            processingError: `Enrichment failed: ${errMsg}`,
          },
        );
        throw error;
      }
    }),
  );
}

// =============================================================================
// WORKER FACTORY
// =============================================================================

/**
 * Create and return the enrichment worker.
 *
 * @param concurrency — max parallel enrichment jobs (default 5)
 */
export default function createEnrichmentWorker(concurrency = 5): Worker<EnrichmentJobData> {
  const worker = new Worker<EnrichmentJobData>(
    QUEUE_ENRICHMENT,
    processEnrichmentJob,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('enrichment', `Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    workerError('enrichment', `Job ${job?.id} failed`, err);
  });

  worker.on('error', (err) => {
    workerError('enrichment', 'Worker error', err);
  });

  workerLog('enrichment', `Started with concurrency=${concurrency}`);
  return worker;
}
