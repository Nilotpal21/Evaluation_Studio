/**
 * Ingestion Worker
 *
 * Entry point of the ingestion pipeline. Picks up IngestionJobData from
 * QUEUE_INGESTION, discovers documents within the source, creates or
 * deduplicates SearchDocument records, and fans out extraction jobs.
 *
 * Flow: ingest --> extract --> canonical-map --> enrich --> embed
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import {
  QUEUE_INGESTION,
  QUEUE_EXTRACTION,
  QUEUE_DOCLING_EXTRACTION,
  DocumentStatus,
  SourceStatus,
} from '@agent-platform/search-ai-sdk';
import { getLazyModel } from '../db/index.js';
import type {
  ISearchSource,
  ISearchDocument,
  ISearchPipelineDefinition,
  ISearchPipelineStage,
  IKnowledgeBase,
} from '@agent-platform/database/models';
import { FlowSelectionService } from '../services/flow-selection/flow-selection.service.js';

// Models bound to correct databases (platform vs content)
const SearchSource = getLazyModel<ISearchSource>('SearchSource'); // → search_ai
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const KnowledgeBase = getLazyModel<IKnowledgeBase>('KnowledgeBase');
const SearchPipelineDefinition = getLazyModel<ISearchPipelineDefinition>(
  'SearchPipelineDefinition',
);

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
  IngestionJobData,
  ExtractionJobData,
  DoclingExtractionJobData,
  PipelineStageConfig,
} from './shared.js';
import { routeDocument } from '../services/ingestion/document-routing.js';

// =============================================================================
// PIPELINE RESOLUTION
// =============================================================================

/**
 * Load the active pipeline for an index. Returns null if no pipeline exists
 * (backward compatible — workers fall back to hardcoded behavior).
 */
async function loadPipelineForIndex(
  indexId: string,
  tenantId: string,
): Promise<ISearchPipelineDefinition | null> {
  try {
    // Find KB that owns this index
    const kb = await KnowledgeBase.findOne({ searchIndexId: indexId, tenantId }).lean();
    if (!kb) return null;

    // Find active pipeline for KB — prefer custom over default
    const pipeline = await SearchPipelineDefinition.findOne(
      { knowledgeBaseId: kb._id, tenantId, status: 'active' },
      null,
      { sort: { isDefault: 1 } },
    ).lean();

    return pipeline ?? null;
  } catch (error) {
    workerLog('ingestion', 'Failed to load pipeline — falling back to default routing', {
      indexId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Find the stage config for a given stage type in the selected flow.
 * Returns undefined if not found (worker uses default behavior).
 */
function findStageConfig(
  stages: ISearchPipelineStage[],
  stageType: string,
  pipelineId: string,
  flowId: string,
): PipelineStageConfig | undefined {
  const stage = stages.find((s) => s.type === stageType);
  if (!stage) return undefined;
  return {
    pipelineId,
    flowId,
    provider: stage.provider,
    providerConfig: stage.providerConfig as Record<string, unknown>,
  };
}

// =============================================================================
// WORKER PROCESSOR
// =============================================================================

async function processIngestionJob(job: Job<IngestionJobData>): Promise<void> {
  const { indexId, sourceId, tenantId, documentIds, options } = job.data;
  const batchSize = options?.batchSize ?? 100;
  const forceExtract = options?.forceExtract ?? false;

  workerLog('ingestion', `Processing ingestion job ${job.id}`, {
    indexId,
    sourceId,
    tenantId,
    documentIds: documentIds?.length,
    forceExtract,
  });

  await withTraceContext(job.data as unknown as Record<string, unknown>, () =>
    withTenantContext({ tenantId }, async () => {
      // ── 1. Load the source ──────────────────────────────────────────────
      const source = await SearchSource.findOne({ _id: sourceId, indexId });
      if (!source) {
        throw new Error(`Source ${sourceId} not found for index ${indexId}`);
      }

      // Mark source as syncing
      await SearchSource.findOneAndUpdate(
        { _id: sourceId, tenantId },
        {
          status: SourceStatus.SYNCING,
          syncError: null,
        },
      );

      try {
        // ── 1b. Load active pipeline (if any) ────────────────────────────────
        const pipeline = await loadPipelineForIndex(indexId, tenantId);
        const flowSelectionService = pipeline ? new FlowSelectionService() : null;

        if (pipeline) {
          workerLog('ingestion', 'Loaded active pipeline for index', {
            indexId,
            pipelineId: pipeline._id,
            pipelineVersion: pipeline.version,
            flowCount: pipeline.flows.length,
          });
        }

        // ── 2. Resolve target documents ─────────────────────────────────────
        // If explicit documentIds were provided, only process those.
        // Otherwise, pull all documents for this source.
        let documents;
        if (documentIds && documentIds.length > 0) {
          documents = await SearchDocument.find({
            _id: { $in: documentIds },
            indexId,
            sourceId,
          }).lean();
        } else {
          documents = await SearchDocument.find({ indexId, sourceId }).lean();
        }

        workerLog('ingestion', `Found ${documents.length} document(s) to process`, {
          indexId,
          sourceId,
        });

        // ── 3. Dedup and create/update documents ────────────────────────────
        // Create queues for both extraction paths (Docling for rich formats, legacy for plain text)
        const legacyQueue = createQueue(QUEUE_EXTRACTION);
        const doclingQueue = createQueue(QUEUE_DOCLING_EXTRACTION);
        let enqueuedCount = 0;

        try {
          for (let i = 0; i < documents.length; i += batchSize) {
            const batch = documents.slice(i, i + batchSize);

            for (const doc of batch) {
              // Skip documents that are already indexed unless forceExtract
              if (!forceExtract && doc.status === DocumentStatus.INDEXED) {
                workerLog('ingestion', `Skipping already indexed document ${doc._id}`);
                continue;
              }

              // Check for content hash duplication within the same index
              if (!forceExtract && doc.contentHash) {
                const existing = await SearchDocument.findOne({
                  indexId,
                  contentHash: doc.contentHash,
                  _id: { $ne: doc._id },
                  status: DocumentStatus.INDEXED,
                }).lean();

                if (existing) {
                  workerLog(
                    'ingestion',
                    `Skipping duplicate document ${doc._id} (matches ${existing._id})`,
                  );
                  continue;
                }
              }

              // Update document status to pending
              await SearchDocument.findOneAndUpdate(
                { _id: doc._id, tenantId },
                {
                  status: DocumentStatus.PENDING,
                  processingError: null,
                },
              );

              // ── 3a. Select pipeline flow for this document (if pipeline exists) ──
              let extractionStage: PipelineStageConfig | undefined;
              let chunkingStage: PipelineStageConfig | undefined;
              let enrichmentStage: PipelineStageConfig | undefined;
              let contentIntelligenceStage: PipelineStageConfig | undefined;
              let visualAnalysisStage: PipelineStageConfig | undefined;
              let embeddingStage: PipelineStageConfig | undefined;

              if (pipeline && flowSelectionService) {
                try {
                  const selectionResult = await flowSelectionService.selectFlow(pipeline.flows, {
                    document: {
                      extension: doc.originalReference?.split('.').pop() ?? '',
                      mimeType: doc.contentType ?? '',
                      size: 0,
                      name: doc.originalReference ?? '',
                    },
                    source: { connector: (source as any).type ?? '' },
                  });

                  if (selectionResult.success && selectionResult.flow) {
                    const flow = selectionResult.flow;
                    const pid = pipeline._id as string;
                    extractionStage = findStageConfig(flow.stages, 'extraction', pid, flow.id);
                    chunkingStage = findStageConfig(flow.stages, 'chunking', pid, flow.id);
                    enrichmentStage = findStageConfig(flow.stages, 'enrichment', pid, flow.id);
                    contentIntelligenceStage = findStageConfig(
                      flow.stages,
                      'content-intelligence',
                      pid,
                      flow.id,
                    );
                    visualAnalysisStage = findStageConfig(
                      flow.stages,
                      'visual-analysis',
                      pid,
                      flow.id,
                    );
                    embeddingStage = findStageConfig(flow.stages, 'embedding', pid, flow.id);

                    // V2 stages: content-intelligence maps to enrichment queue,
                    // visual-analysis maps to visual-enrichment queue.
                    // If flow has content-intelligence but no enrichment, use CI as enrichment config.
                    if (!enrichmentStage && contentIntelligenceStage) {
                      enrichmentStage = contentIntelligenceStage;
                    }

                    workerLog('ingestion', `Pipeline flow selected for ${doc._id}`, {
                      flowId: flow.id,
                      flowName: flow.name,
                      extractionProvider: extractionStage?.provider,
                      chunkingProvider: chunkingStage?.provider,
                      hasContentIntelligence: !!contentIntelligenceStage,
                      hasVisualAnalysis: !!visualAnalysisStage,
                    });
                  }
                } catch (selErr) {
                  workerLog('ingestion', 'Flow selection failed — using default routing', {
                    documentId: doc._id,
                    error: selErr instanceof Error ? selErr.message : String(selErr),
                  });
                }
              }

              // Route to correct extraction pipeline based on content type
              const useDocling = routeDocument(doc.contentType) === 'docling';

              // Propagate trace context to downstream job
              const obsCtx = getObservabilityContext();

              if (useDocling && doc.sourceUrl) {
                // Docling path: PDF, Office docs, HTML, images
                const doclingData: DoclingExtractionJobData = {
                  indexId,
                  documentId: doc._id,
                  sourceUrl: doc.sourceUrl,
                  tenantId,
                  // Inject pipeline stage configs for downstream workers
                  pipelineStage: extractionStage,
                };

                // Attach downstream stage configs as extra fields for propagation
                const doclingDataWithPipeline = doclingData as DoclingExtractionJobData &
                  Record<string, unknown>;
                if (chunkingStage) doclingDataWithPipeline._chunkingStage = chunkingStage;
                if (enrichmentStage) doclingDataWithPipeline._enrichmentStage = enrichmentStage;
                if (visualAnalysisStage)
                  doclingDataWithPipeline._visualAnalysisStage = visualAnalysisStage;
                if (embeddingStage) doclingDataWithPipeline._embeddingStage = embeddingStage;

                if (obsCtx) {
                  injectTrace(doclingDataWithPipeline as unknown as Record<string, unknown>, {
                    traceId: obsCtx.traceId,
                    spanId: obsCtx.spanId,
                  });
                }

                await doclingQueue.add(`docling-extract:${doc._id}`, doclingDataWithPipeline, {
                  jobId: `docling-extract:${indexId}:${doc._id}`,
                  attempts: 3,
                  backoff: { type: 'exponential', delay: 5_000 },
                });

                workerLog(
                  'ingestion',
                  `Routed ${doc._id} to Docling extraction (${doc.contentType})`,
                  { pipelineProvider: extractionStage?.provider },
                );
              } else {
                // Legacy path: plain text, markdown, or docs without sourceUrl
                const extractionData: ExtractionJobData = {
                  indexId,
                  sourceId,
                  documentId: doc._id,
                  tenantId,
                };

                if (obsCtx) {
                  injectTrace(extractionData as unknown as Record<string, unknown>, {
                    traceId: obsCtx.traceId,
                    spanId: obsCtx.spanId,
                  });
                }

                await legacyQueue.add(`extract:${doc._id}`, extractionData, {
                  jobId: `extract:${indexId}:${doc._id}`,
                  attempts: 3,
                  backoff: { type: 'exponential', delay: 5_000 },
                });
              }
              enqueuedCount++;
            }

            // Report progress
            const progress = Math.round(((i + batch.length) / documents.length) * 100);
            await job.updateProgress(progress);
          }
        } finally {
          await legacyQueue.close();
          await doclingQueue.close();
        }

        workerLog('ingestion', `Enqueued ${enqueuedCount} extraction job(s)`, {
          indexId,
          sourceId,
        });

        // ── 4. Update source stats and restore active status ────────────────
        await SearchSource.findOneAndUpdate(
          { _id: sourceId, tenantId },
          {
            status: SourceStatus.ACTIVE,
            documentCount: documents.length,
            lastSyncAt: new Date(),
            syncError: null,
          },
        );
      } catch (error) {
        // Mark source as errored
        const errMsg = error instanceof Error ? error.message : String(error);
        await SearchSource.findOneAndUpdate(
          { _id: sourceId, tenantId },
          {
            status: SourceStatus.ERROR,
            syncError: errMsg,
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
 * Create and return the ingestion pipeline entry-point worker.
 *
 * @param concurrency — max parallel ingestion jobs (default 3)
 */
export default function createIngestionWorker(concurrency = 3): Worker<IngestionJobData> {
  const worker = new Worker<IngestionJobData>(
    QUEUE_INGESTION,
    processIngestionJob,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('ingestion', `Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    workerError('ingestion', `Job ${job?.id} failed`, err);
  });

  worker.on('error', (err) => {
    workerError('ingestion', 'Worker error', err);
  });

  workerLog('ingestion', `Started with concurrency=${concurrency}`);
  return worker;
}
