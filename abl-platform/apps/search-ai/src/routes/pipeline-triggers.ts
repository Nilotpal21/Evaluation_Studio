/**
 * Pipeline Trigger Routes
 *
 * REST API endpoints for manually triggering pipeline execution.
 *
 * ## Authentication & Permissions
 *
 * - All routes require authentication (JWT or API key)
 * - Project-level permissions enforced
 * - Tenant isolation on all queries
 *
 * ## Endpoints
 *
 * 1. POST /api/projects/:projectId/knowledge-bases/:kbId/documents/:docId/trigger-pipeline
 * 2. POST /api/projects/:projectId/knowledge-bases/:kbId/sources/:sourceId/trigger-pipeline
 * 3. POST /api/projects/:projectId/knowledge-bases/:kbId/trigger-pipeline
 *
 * ## Safety
 *
 * - Validates pipeline is published (active) before triggering
 * - Checks circuit breaker state before execution
 * - Applies backpressure checks to prevent Redis OOM
 * - Rate limited (10 req/min per tenant)
 * - Job deduplication via jobId pattern
 *
 * Reference: docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md
 */

import { Router, type Request, type Response } from 'express';
import { FlowProducer, Queue } from 'bullmq';
import { getLazyModel } from '../db/index.js';
import type {
  ISearchPipelineDefinition,
  IKnowledgeBase,
  ISearchDocument,
  ISearchSource,
  ISearchChunk,
  IChunkQuestion,
  IDocumentPage,
  IFieldMapping,
  ICanonicalSchema,
  ISearchIndex,
} from '@agent-platform/database';
import {
  PipelineFlowBuilder,
  safeAddFlow,
  checkBackpressure,
} from '../services/pipeline-orchestration/flow-builder.js';
import {
  BackpressureError,
  type FlowBuildContext,
} from '../services/pipeline-orchestration/types.js';
import {
  QUEUE_EXTRACTION,
  QUEUE_DOCLING_EXTRACTION,
  QUEUE_PAGE_PROCESSING,
  QUEUE_ENRICHMENT,
  QUEUE_EMBEDDING,
  QUEUE_MULTIMODAL,
  QUEUE_TREE_BUILDING,
  QUEUE_QUESTION_SYNTHESIS,
  QUEUE_SCOPE_CLASSIFICATION,
} from '@agent-platform/search-ai-sdk';
import { searchAiRateLimit } from '../middleware/rate-limit.js';
import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import { createQueue, getRedisConnection } from '../workers/shared.js';
import type { ExtractionJobData } from '../workers/shared.js';
import { routeDocument } from '../services/ingestion/document-routing.js';
import type { FieldMapping } from '../services/json-schema-mapping/json-schema-llm-mapper.js';
import { createLogger } from '@abl/compiler/platform';
import {
  createVectorStore,
  type VectorStoreProvider,
  type VectorStoreFactoryConfig,
} from '@agent-platform/search-ai-internal';
import { canAccessProject } from './project-scope.js';

const logger = createLogger('routes:pipeline-triggers');

const SearchPipelineDefinition = getLazyModel<ISearchPipelineDefinition>(
  'SearchPipelineDefinition',
);
const KnowledgeBase = getLazyModel<IKnowledgeBase>('KnowledgeBase');
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
const SearchSource = getLazyModel<ISearchSource>('SearchSource');
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');
const ChunkQuestion = getLazyModel<IChunkQuestion>('ChunkQuestion');
const DocumentPage = getLazyModel<IDocumentPage>('DocumentPage');

const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

const router: Router = Router();

const flowBuilder = new PipelineFlowBuilder();

/** Max documents per batch for source/KB-level triggers */
const MAX_BATCH_SIZE = 100;

// ─── Helper Functions ────────────────────────────────────────────────────

/**
 * Clean up all existing data for a document before reprocessing.
 *
 * Makes reprocess behave like a fresh upload by deleting:
 * 1. Old vectors from OpenSearch (by documentId filter)
 * 2. Old chunks from MongoDB
 * 3. Old chunk questions from MongoDB
 * 4. Old document pages from MongoDB
 * 5. Resetting document status and processing metadata
 *
 * Without this, reprocess creates duplicate chunks/vectors and search
 * returns stale + new results mixed together.
 */
async function cleanupDocumentForReprocess(
  docId: string,
  indexId: string,
  tenantId: string,
): Promise<{ chunksDeleted: number; pagesDeleted: number; vectorsDeleted: boolean }> {
  // 1. Collect existing chunk IDs for vector deletion
  const existingChunks = await SearchChunk.find({ documentId: docId, tenantId }, { _id: 1 }).lean();
  const chunkIds = existingChunks.map((c: any) => String(c._id));

  // Also collect existing question IDs (they have vectors too)
  const existingQuestions = await ChunkQuestion.find(
    { documentId: docId, tenantId },
    { _id: 1 },
  ).lean();
  const questionIds = existingQuestions.map((q: any) => String(q._id));

  // 2. Delete vectors from OpenSearch (best-effort — don't fail reprocess if this fails)
  let vectorsDeleted = false;
  const allVectorIds = [...chunkIds, ...questionIds];
  if (allVectorIds.length > 0) {
    try {
      // Resolve the vector index name from SearchIndex
      const searchIndex = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
      const vectorIndexName = (searchIndex as any)?.activeVectorIndex;

      if (vectorIndexName) {
        const vectorStoreConfig: VectorStoreFactoryConfig = {
          provider:
            (process.env.VECTOR_STORE_PROVIDER as
              | 'opensearch'
              | 'qdrant'
              | 'pinecone'
              | 'pgvector') || 'opensearch',
          url: process.env.VECTOR_STORE_URL || 'http://localhost:9200',
          apiKey: process.env.VECTOR_STORE_API_KEY,
        };
        const vectorStore: VectorStoreProvider = createVectorStore(vectorStoreConfig);
        await vectorStore.delete(vectorIndexName, allVectorIds);
        vectorsDeleted = true;

        logger.info('Deleted vectors from OpenSearch for reprocess', {
          documentId: docId,
          vectorIndex: vectorIndexName,
          chunkVectors: chunkIds.length,
          questionVectors: questionIds.length,
        });
      } else {
        logger.warn('No activeVectorIndex found on SearchIndex, skipping vector deletion', {
          documentId: docId,
          indexId,
        });
      }
    } catch (err) {
      // Non-fatal: vectors may be orphaned but reprocess should continue.
      // The embedding worker uses upsert, so new chunks get new vectors.
      // Orphaned old vectors will only cause minor search noise until next
      // full reindex or TTL expiry.
      logger.warn('Vector cleanup failed during reprocess (continuing)', {
        documentId: docId,
        vectorCount: allVectorIds.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Remove stale BullMQ jobs from ALL pipeline queues.
  //    Workers use deterministic jobIds (e.g., `page-processing:${indexId}:${docId}`).
  //    If the old job still exists in Redis (completed/failed), BullMQ silently
  //    ignores new jobs with the same ID, causing the pipeline to stall.
  const staleJobIds: Array<{ queue: string; jobId: string }> = [
    { queue: QUEUE_DOCLING_EXTRACTION, jobId: `docling-extract:${indexId}:${docId}` },
    { queue: QUEUE_PAGE_PROCESSING, jobId: `page-processing:${indexId}:${docId}` },
    { queue: QUEUE_ENRICHMENT, jobId: `enrich:${indexId}:${docId}` },
    { queue: QUEUE_EMBEDDING, jobId: `embed:${indexId}:${docId}` },
    { queue: QUEUE_MULTIMODAL, jobId: `mm:${indexId}:${docId}` },
    { queue: QUEUE_TREE_BUILDING, jobId: `tree:${indexId}:${docId}` },
    { queue: QUEUE_QUESTION_SYNTHESIS, jobId: `question:${indexId}:${docId}` },
    { queue: QUEUE_SCOPE_CLASSIFICATION, jobId: `scope:${indexId}:${docId}` },
  ];

  let staleJobsRemoved = 0;
  await Promise.all(
    staleJobIds.map(async ({ queue: queueName, jobId }) => {
      const queue = createQueue(queueName);
      try {
        const job = await queue.getJob(jobId);
        if (job) {
          await job.remove();
          staleJobsRemoved++;
        }
      } catch (err) {
        // Non-fatal: stale job may not exist or be locked — continue
        logger.debug('Stale job removal skipped', {
          queueName,
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        await queue.close();
      }
    }),
  );

  if (staleJobsRemoved > 0) {
    logger.info('Removed stale BullMQ jobs for reprocess', {
      documentId: docId,
      staleJobsRemoved,
    });
  }

  // 4. Delete MongoDB data (chunks, questions, pages)
  const [chunkResult, , pageResult] = await Promise.all([
    SearchChunk.deleteMany({ documentId: docId, tenantId }),
    ChunkQuestion.deleteMany({ documentId: docId, tenantId }),
    DocumentPage.deleteMany({ documentId: docId, tenantId }),
  ]);

  // 5. Reset document status and processing metadata to match a fresh upload
  await SearchDocument.updateOne(
    { _id: docId, tenantId },
    {
      $set: {
        status: 'pending',
        processingError: null,
        extractedText: null,
        chunkCount: 0,
        pageCount: 0,
        updatedAt: new Date(),
      },
    },
  );

  logger.info('Document cleaned up for reprocess', {
    documentId: docId,
    chunksDeleted: chunkResult.deletedCount,
    questionsDeleted: existingQuestions.length,
    pagesDeleted: pageResult.deletedCount,
    vectorsDeleted,
  });

  return {
    chunksDeleted: chunkResult.deletedCount,
    pagesDeleted: pageResult.deletedCount,
    vectorsDeleted,
  };
}

/**
 * Verify knowledge base exists and belongs to tenant/project.
 */
async function verifyKnowledgeBase(
  tenantId: string,
  projectId: string,
  kbId: string,
  tenantContext: NonNullable<Request['tenantContext']>,
): Promise<IKnowledgeBase | null> {
  if (!canAccessProject(tenantContext, projectId)) {
    return null;
  }

  const kb = await KnowledgeBase.findOne({
    _id: kbId,
    tenantId,
    projectId,
  }).lean();

  return kb;
}

/**
 * Get the active pipeline for a knowledge base.
 * Returns null if no active pipeline exists.
 */
async function getActivePipeline(
  tenantId: string,
  kbId: string,
): Promise<ISearchPipelineDefinition | null> {
  const pipeline = await SearchPipelineDefinition.findOne({
    tenantId,
    knowledgeBaseId: kbId,
    status: 'active',
  }).lean();

  return pipeline;
}

/**
 * Create a FlowProducer with shared Redis connection.
 */
function getFlowProducer(): FlowProducer {
  return new FlowProducer({ connection: getRedisConnection(), prefix: BULLMQ_CLUSTER_SAFE_PREFIX });
}

/**
 * Create a queue for the parent job for verification.
 */
function getParentQueue(queueName: string): Queue {
  return new Queue(queueName, {
    connection: getRedisConnection(),
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
  });
}

/**
 * Extract file extension from an original reference (filename or URL).
 */
function getExtension(originalReference: string | null): string {
  if (!originalReference) return '';
  const name = originalReference.split('/').pop() || originalReference;
  const dotIndex = name.lastIndexOf('.');
  return dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : '';
}

/**
 * Trigger pipeline for a single document.
 *
 * @param sourceType - Source type (e.g., 'google-drive', 'sharepoint'). Pass 'unknown' if not available.
 * @returns Trigger result with flow job ID
 */
async function triggerPipelineForDocument(
  pipeline: ISearchPipelineDefinition,
  document: ISearchDocument,
  tenantId: string,
  kbId: string,
  sourceType: string = 'unknown',
): Promise<{
  success: boolean;
  flowJobId?: string;
  selectedFlowId?: string;
  error?: string;
}> {
  const docId = String(document._id);
  const indexId = String(document.indexId || kbId);
  const sourceId = String(document.sourceId || '');

  // ── Clean up old data so reprocess behaves like fresh upload ─────────
  // Deletes old chunks, pages, questions, and vectors from OpenSearch.
  // This prevents duplicate results in search and stale data lingering.
  await cleanupDocumentForReprocess(docId, indexId, tenantId);

  // ── Route documents based on content type to the correct pipeline.
  //    The BullMQ flow builder only handles docling/structured flows.
  //    Legacy (text/markdown) and JSON documents need dedicated queues.
  const route = routeDocument(document.contentType);

  // ── JSON record chunking: enqueue directly on json-record-chunking queue.
  //    The json-record-chunking worker handles parsing, schema mapping,
  //    chunk creation, and chains to embedding. The flow builder does NOT
  //    support this route and would incorrectly produce an extraction→enrichment
  //    flow that fails on JSON documents.
  //
  //    On reprocess, we reconstruct resolvedMappings from existing FieldMapping
  //    docs so the worker uses the saved canonical mapping instead of re-running
  //    the LLM (which may fail or produce different results).
  if (route === 'json-chunking') {
    logger.info('Routing document to json-record-chunking pipeline', {
      documentId: docId,
      contentType: document.contentType,
      route,
    });

    // Reconstruct resolvedMappings from existing FieldMapping + CanonicalSchema,
    // falling back to jsonFieldConfig on the SearchIndex if schema is missing.
    let resolvedMappings: FieldMapping[] | undefined;
    try {
      const CanonicalSchemaModel = getLazyModel<ICanonicalSchema>('CanonicalSchema');
      const FieldMappingModel = getLazyModel<IFieldMapping>('FieldMapping');

      const schema = await CanonicalSchemaModel.findOne({
        knowledgeBaseId: indexId,
        tenantId,
        status: 'active',
      }).lean();

      if (schema) {
        const mappings = await FieldMappingModel.find({
          canonicalSchemaId: schema._id,
          tenantId,
          status: 'active',
        }).lean();

        if (mappings.length > 0) {
          // Build a lookup from canonical field → schema field metadata
          const schemaFieldMap = new Map(
            (schema.fields || []).map((f: any) => [f.storageField, f]),
          );

          resolvedMappings = mappings.map((m: any) => {
            const schemaField = schemaFieldMap.get(m.canonicalField);
            return {
              sourceField: m.sourcePath,
              canonicalField: m.canonicalField,
              type: (schemaField?.type === 'number'
                ? 'number'
                : schemaField?.type === 'date'
                  ? 'date'
                  : 'keyword') as 'keyword' | 'number' | 'text' | 'date',
              filterable: schemaField?.filterable ?? true,
              sortable: schemaField?.sortable ?? false,
              aggregatable: schemaField?.aggregatable ?? false,
              alias: schemaField?.name || schemaField?.label || m.sourcePath,
              synonyms: [],
              description: schemaField?.description || `${m.sourcePath} → ${m.canonicalField}`,
              sampleValues: schemaField?.enumValues
                ? Object.keys(schemaField.enumValues)
                : undefined,
            };
          });

          logger.info('Reconstructed resolvedMappings from DB for reprocess', {
            documentId: docId,
            mappingCount: resolvedMappings.length,
          });
        }
      }

      // ── Fallback: always prefer jsonFieldConfig on SearchIndex ──────────
      // The jsonFieldConfig is the authoritative source of field→canonical mappings
      // for JSON documents. CanonicalSchema/FieldMappings in the DB may be out of
      // sync (deleted, partial, or stale). If jsonFieldConfig has more mappings than
      // what was found in the DB, use it — it's what the upload route uses.
      const searchIndex = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
      const jsonFieldConfig = (searchIndex as any)?.jsonFieldConfig as {
        fields?: Array<{
          fieldPath: string;
          fieldType: string;
          selected: boolean;
          canonicalMapping?: string;
          sampleValues?: string[];
        }>;
      } | null;

      if (jsonFieldConfig?.fields?.length) {
        const configMappings = jsonFieldConfig.fields
          .filter((f) => f.selected && f.canonicalMapping)
          .map((f) => {
            const alias = f.fieldPath
              .replace(/([a-z])([A-Z])/g, '$1 $2')
              .split(/[._-]/)
              .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' ');
            const synonyms: string[] = [];
            if (f.fieldPath !== alias) synonyms.push(f.fieldPath);
            return {
              sourceField: f.fieldPath,
              canonicalField: f.canonicalMapping!,
              type: (f.fieldType === 'number'
                ? 'number'
                : f.fieldType === 'date'
                  ? 'date'
                  : 'keyword') as 'keyword' | 'number' | 'text' | 'date',
              filterable: true,
              sortable: f.fieldType === 'number' || f.fieldType === 'date',
              aggregatable: f.fieldType === 'number',
              alias,
              synonyms,
              description: `${f.fieldPath} → ${f.canonicalMapping}`,
              sampleValues: f.sampleValues || [],
            };
          });

        // Use jsonFieldConfig if it has more mappings (DB may be partial/stale)
        const dbMappingCount = resolvedMappings?.length || 0;
        if (configMappings.length > dbMappingCount) {
          resolvedMappings = configMappings;
          logger.info('Using jsonFieldConfig for reprocess (more complete than DB)', {
            documentId: docId,
            configMappingCount: configMappings.length,
            dbMappingCount,
          });
        }
      }
    } catch (err) {
      // Non-fatal: worker will fall back to LLM analysis
      logger.warn('Failed to reconstruct resolvedMappings, worker will use LLM fallback', {
        documentId: docId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const QUEUE_JSON_RECORD_CHUNKING = 'json-record-chunking';
    const jsonQueue = createQueue(QUEUE_JSON_RECORD_CHUNKING);
    try {
      await checkBackpressure(jsonQueue, QUEUE_JSON_RECORD_CHUNKING);

      const job = await jsonQueue.add(
        `json-chunk:${docId}`,
        {
          indexId,
          documentId: docId,
          sourceUrl: (document as any).sourceUrl || document.originalReference || '',
          tenantId,
          ...(resolvedMappings ? { resolvedMappings } : {}),
        },
        {
          jobId: `reprocess-json-${indexId}-${docId}-${Date.now()}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
        },
      );

      await SearchDocument.findOneAndUpdate(
        { _id: docId, tenantId },
        { $set: { flowId: 'flow-json-record-chunking' } },
      );

      return {
        success: true,
        flowJobId: job.id,
        selectedFlowId: 'flow-json-record-chunking',
      };
    } finally {
      await jsonQueue.close();
    }
  }

  if (route === 'legacy') {
    logger.info('Routing document to legacy extraction pipeline', {
      documentId: docId,
      contentType: document.contentType,
      route,
    });

    const extractionQueue = createQueue(QUEUE_EXTRACTION);
    try {
      // Check backpressure on the legacy extraction queue
      await checkBackpressure(extractionQueue, QUEUE_EXTRACTION);

      const extractionData: ExtractionJobData = {
        indexId,
        sourceId,
        documentId: docId,
        tenantId,
      };

      const job = await extractionQueue.add(`extract:${docId}`, extractionData, {
        jobId: `reprocess-extract-${indexId}-${docId}-${Date.now()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      });

      // Set flowId for provenance
      await SearchDocument.findOneAndUpdate(
        { _id: docId, tenantId },
        { $set: { flowId: 'flow-legacy-extraction' } },
      );

      return {
        success: true,
        flowJobId: job.id,
        selectedFlowId: 'flow-legacy-extraction',
      };
    } finally {
      await extractionQueue.close();
    }
  }

  // ── Standard BullMQ flow path (docling, json-chunking, structured) ────
  const context: FlowBuildContext = {
    documentId: docId,
    tenantId,
    sourceId,
    indexId,
    sourceUrl: (document as any).sourceUrl || document.originalReference || '',
    document: {
      extension: getExtension(document.originalReference),
      mimeType: document.contentType || 'application/octet-stream',
      size: document.contentSizeBytes || 0,
      name: document.originalReference || '',
      language: document.language || undefined,
    },
    source: {
      connector: sourceType,
    },
  };

  // Build the BullMQ flow (flow selection happens inside)
  const buildResult = await flowBuilder.buildFlow(pipeline, context);

  if (!buildResult.success || !buildResult.flow) {
    return {
      success: false,
      error: buildResult.error || 'Failed to build flow',
    };
  }

  // Set flowId on document for reindex provenance
  const selectedFlowId = buildResult.details.selectedFlowId;
  if (selectedFlowId) {
    await SearchDocument.findOneAndUpdate(
      { _id: document._id, tenantId },
      { $set: { flowId: selectedFlowId } },
    );
  }

  // Get FlowProducer and parent queue for validation
  const flowProducer = getFlowProducer();
  const parentQueue = getParentQueue(buildResult.flow.queueName);

  try {
    // Check backpressure before adding flow
    await checkBackpressure(parentQueue, buildResult.flow.queueName);

    // Safely add flow with validation (handles Issue #3851)
    const result = await safeAddFlow(flowProducer, buildResult.flow, parentQueue);

    return {
      success: true,
      flowJobId: result.job.id,
      selectedFlowId,
    };
  } finally {
    // Cleanup
    await flowProducer.close();
    await parentQueue.close();
  }
}

// ─── POST /api/projects/:projectId/knowledge-bases/:kbId/documents/:docId/trigger-pipeline

/**
 * Trigger pipeline for a specific document.
 *
 * @permission knowledge-base:update
 * @returns { success: true, flowJobId: string, selectedFlow: string }
 */
router.post(
  '/api/projects/:projectId/knowledge-bases/:kbId/documents/:docId/trigger-pipeline',
  searchAiRateLimit({ limit: 10, windowMs: 60_000 }),
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { projectId, kbId, docId } = req.params;

      logger.info('Triggering pipeline for document', {
        tenantId,
        projectId,
        kbId,
        documentId: docId,
      });

      // Verify knowledge base exists
      const kb = await verifyKnowledgeBase(tenantId, projectId, kbId, req.tenantContext);
      if (!kb) {
        res.status(404).json({ error: 'Knowledge base not found' });
        return;
      }

      // Get active pipeline
      const pipeline = await getActivePipeline(tenantId, kbId);
      if (!pipeline) {
        res.status(400).json({ error: 'No active pipeline found for this knowledge base' });
        return;
      }

      // Get document
      const document = await SearchDocument.findOne({
        _id: docId,
        tenantId,
        indexId: String(kb.searchIndexId),
      }).lean();

      if (!document) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      // Trigger pipeline
      const result = await triggerPipelineForDocument(pipeline, document, tenantId, kbId);

      if (!result.success) {
        res.status(500).json({
          error: 'Failed to trigger pipeline',
          details: result.error,
        });
        return;
      }

      logger.info('Pipeline triggered for document', {
        documentId: docId,
        flowJobId: result.flowJobId,
      });

      res.json({
        success: true,
        flowJobId: result.flowJobId,
        documentId: docId,
        pipelineId: pipeline._id,
        pipelineVersion: pipeline.version,
      });
    } catch (error) {
      if (error instanceof BackpressureError) {
        logger.warn('Backpressure limit exceeded', {
          queueName: error.queueName,
          currentDepth: error.currentDepth,
          maxDepth: error.maxDepth,
        });
        res.status(503).json({
          error: 'Service temporarily unavailable - queue capacity exceeded',
          retryAfterMs: error.retryAfterMs,
        });
        return;
      }

      logger.error('Failed to trigger pipeline for document', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to trigger pipeline' });
    }
  },
);

// ─── POST /api/projects/:projectId/knowledge-bases/:kbId/sources/:sourceId/trigger-pipeline

/**
 * Trigger pipeline for all documents in a source.
 *
 * @permission knowledge-base:update
 * @returns { success: true, triggeredCount: number, flowJobIds: string[] }
 */
router.post(
  '/api/projects/:projectId/knowledge-bases/:kbId/sources/:sourceId/trigger-pipeline',
  searchAiRateLimit({ limit: 10, windowMs: 60_000 }),
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { projectId, kbId, sourceId } = req.params;

      logger.info('Triggering pipeline for source', {
        tenantId,
        projectId,
        kbId,
        sourceId,
      });

      // Verify knowledge base exists
      const kb = await verifyKnowledgeBase(tenantId, projectId, kbId, req.tenantContext);
      if (!kb) {
        res.status(404).json({ error: 'Knowledge base not found' });
        return;
      }

      // Get active pipeline
      const pipeline = await getActivePipeline(tenantId, kbId);
      if (!pipeline) {
        res.status(400).json({ error: 'No active pipeline found for this knowledge base' });
        return;
      }

      // Verify source exists
      const source = await SearchSource.findOne({
        _id: sourceId,
        tenantId,
        indexId: String(kb.searchIndexId),
      }).lean();

      if (!source) {
        res.status(404).json({ error: 'Source not found' });
        return;
      }

      // Get documents for source (limited batch)
      const documents = await SearchDocument.find({
        sourceId,
        tenantId,
        indexId: String(kb.searchIndexId),
        isDeleted: { $ne: true },
      })
        .limit(MAX_BATCH_SIZE)
        .select(
          '_id sourceId indexId contentType contentSizeBytes originalReference language sourceUrl',
        )
        .lean();

      if (documents.length === 0) {
        res.json({
          success: true,
          triggeredCount: 0,
          flowJobIds: [],
          message: 'No documents found in source',
        });
        return;
      }

      // Trigger pipeline for each document (pass source type for flow selection)
      const results: { docId: string; flowJobId?: string; error?: string }[] = [];
      let triggeredCount = 0;

      for (const document of documents) {
        try {
          const result = await triggerPipelineForDocument(
            pipeline,
            document,
            tenantId,
            kbId,
            source.sourceType,
          );

          if (result.success) {
            triggeredCount++;
            results.push({ docId: document._id as string, flowJobId: result.flowJobId });
          } else {
            results.push({ docId: document._id as string, error: result.error });
          }
        } catch (error) {
          if (error instanceof BackpressureError) {
            // Stop processing on backpressure
            logger.warn('Backpressure hit during source trigger, stopping batch', {
              sourceId,
              processedCount: triggeredCount,
              remainingCount: documents.length - triggeredCount,
            });
            break;
          }

          results.push({
            docId: document._id as string,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const flowJobIds = results.filter((r) => r.flowJobId).map((r) => r.flowJobId as string);

      logger.info('Pipeline triggered for source', {
        sourceId,
        triggeredCount,
        totalDocuments: documents.length,
      });

      res.json({
        success: true,
        triggeredCount,
        totalDocuments: documents.length,
        flowJobIds,
        pipelineId: pipeline._id,
        pipelineVersion: pipeline.version,
      });
    } catch (error) {
      if (error instanceof BackpressureError) {
        res.status(503).json({
          error: 'Service temporarily unavailable - queue capacity exceeded',
          retryAfterMs: error.retryAfterMs,
        });
        return;
      }

      logger.error('Failed to trigger pipeline for source', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to trigger pipeline for source' });
    }
  },
);

// ─── POST /api/projects/:projectId/knowledge-bases/:kbId/trigger-pipeline ─

/**
 * Trigger pipeline for entire knowledge base.
 *
 * Creates flows for all documents (paginated with batch limit).
 *
 * @permission knowledge-base:update
 * @returns { success: true, triggeredCount: number, batchId: string }
 */
router.post(
  '/api/projects/:projectId/knowledge-bases/:kbId/trigger-pipeline',
  searchAiRateLimit({ limit: 10, windowMs: 60_000 }),
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { projectId, kbId } = req.params;

      logger.info('Triggering pipeline for knowledge base', {
        tenantId,
        projectId,
        kbId,
      });

      // Verify knowledge base exists
      const kb = await verifyKnowledgeBase(tenantId, projectId, kbId, req.tenantContext);
      if (!kb) {
        res.status(404).json({ error: 'Knowledge base not found' });
        return;
      }

      // Get active pipeline
      const pipeline = await getActivePipeline(tenantId, kbId);
      if (!pipeline) {
        res.status(400).json({ error: 'No active pipeline found for this knowledge base' });
        return;
      }

      // Get documents for entire KB (limited batch)
      // Use indexId from knowledge base to find documents
      const documents = await SearchDocument.find({
        tenantId,
        indexId: String(kb.searchIndexId),
        isDeleted: { $ne: true },
      })
        .limit(MAX_BATCH_SIZE)
        .select(
          '_id sourceId indexId contentType contentSizeBytes originalReference language sourceUrl',
        )
        .lean();

      if (documents.length === 0) {
        res.json({
          success: true,
          triggeredCount: 0,
          totalDocuments: 0,
          message: 'No documents found in knowledge base',
        });
        return;
      }

      // Generate batch ID for tracking
      const batchId = `batch-${kbId}-${Date.now()}`;

      // Trigger pipeline for each document
      let triggeredCount = 0;
      const flowJobIds: string[] = [];

      for (const document of documents) {
        try {
          const result = await triggerPipelineForDocument(pipeline, document, tenantId, kbId);

          if (result.success && result.flowJobId) {
            triggeredCount++;
            flowJobIds.push(result.flowJobId);
          }
        } catch (error) {
          if (error instanceof BackpressureError) {
            logger.warn('Backpressure hit during KB trigger, stopping batch', {
              kbId,
              processedCount: triggeredCount,
              remainingCount: documents.length - triggeredCount,
            });
            break;
          }

          logger.error('Failed to trigger pipeline for document in batch', {
            documentId: document._id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info('Pipeline triggered for knowledge base', {
        kbId,
        batchId,
        triggeredCount,
        totalDocuments: documents.length,
      });

      res.json({
        success: true,
        triggeredCount,
        totalDocuments: documents.length,
        batchId,
        flowJobIds,
        pipelineId: pipeline._id,
        pipelineVersion: pipeline.version,
      });
    } catch (error) {
      if (error instanceof BackpressureError) {
        res.status(503).json({
          error: 'Service temporarily unavailable - queue capacity exceeded',
          retryAfterMs: error.retryAfterMs,
        });
        return;
      }

      logger.error('Failed to trigger pipeline for knowledge base', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to trigger pipeline for knowledge base' });
    }
  },
);

// ─── POST /api/projects/:projectId/knowledge-bases/:kbId/documents/bulk-reprocess

/**
 * Bulk reprocess documents: clean old chunks, reset status, re-trigger pipeline.
 *
 * Works on documents in ANY status (not just 'error'), making it suitable
 * for re-indexing already-indexed documents.
 *
 * For each document:
 *   1. Delete existing chunks and chunk questions (cleanup)
 *   2. Reset document status to 'pending'
 *   3. Trigger pipeline to create new BullMQ flow jobs
 *
 * @permission knowledge-base:update
 * @body { documentIds: string[] } — 1-50 document IDs
 * @returns { success, triggeredCount, results[] }
 */
router.post(
  '/api/projects/:projectId/knowledge-bases/:kbId/documents/bulk-reprocess',
  // No per-route rate limit — the global 120 req/min already protects this endpoint,
  // and the handler validates max 50 document IDs per call. The per-route limit of 10
  // was sharing a counter with the global middleware, causing premature 429s.
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({
          success: false,
          error: { code: 'AUTH_REQUIRED', message: 'Tenant context required' },
        });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { projectId, kbId } = req.params;
      const { documentIds } = req.body;

      // Validate input
      if (
        !Array.isArray(documentIds) ||
        documentIds.length === 0 ||
        documentIds.length > 50 ||
        !documentIds.every((id: unknown) => typeof id === 'string' && id.length > 0)
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'documentIds must be array of 1-50 non-empty string IDs',
          },
        });
        return;
      }

      logger.info('Bulk reprocess requested', {
        tenantId,
        projectId,
        kbId,
        documentCount: documentIds.length,
      });

      // Verify knowledge base
      const kb = await verifyKnowledgeBase(tenantId, projectId, kbId, req.tenantContext);
      if (!kb) {
        res.status(404).json({
          success: false,
          error: { code: 'KB_NOT_FOUND', message: 'Knowledge base not found' },
        });
        return;
      }

      // Get active pipeline
      const pipeline = await getActivePipeline(tenantId, kbId);
      if (!pipeline) {
        res.status(400).json({
          success: false,
          error: {
            code: 'NO_PIPELINE',
            message: 'No active pipeline found for this knowledge base',
          },
        });
        return;
      }

      // Load documents (tenant-scoped)
      const documents = await SearchDocument.find({
        _id: { $in: documentIds },
        tenantId,
        indexId: String(kb.searchIndexId),
        isDeleted: { $ne: true },
      })
        .select(
          '_id sourceId indexId contentType contentSizeBytes originalReference language status sourceUrl',
        )
        .lean();

      if (documents.length === 0) {
        res.status(404).json({
          success: false,
          error: { code: 'NO_DOCUMENTS', message: 'No matching documents found' },
        });
        return;
      }

      const results: { docId: string; status: string; flowJobId?: string; error?: string }[] = [];
      let triggeredCount = 0;

      for (const document of documents) {
        const docId = String(document._id);
        try {
          // triggerPipelineForDocument now handles full cleanup internally
          // (chunks, pages, questions, OpenSearch vectors, status reset)
          // so reprocess works identically to a fresh upload.
          const result = await triggerPipelineForDocument(pipeline, document, tenantId, kbId);

          if (result.success) {
            triggeredCount++;
            results.push({ docId, status: 'triggered', flowJobId: result.flowJobId });
          } else {
            results.push({ docId, status: 'trigger_failed', error: result.error });
          }
        } catch (error) {
          if (error instanceof BackpressureError) {
            logger.warn('Backpressure hit during bulk reprocess, stopping', {
              processedCount: triggeredCount,
              remainingCount: documents.length - triggeredCount,
            });
            results.push({ docId, status: 'backpressure', error: 'Queue capacity exceeded' });
            break;
          }

          results.push({
            docId,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info('Bulk reprocess completed', {
        kbId,
        triggeredCount,
        totalRequested: documentIds.length,
        totalFound: documents.length,
      });

      res.json({
        success: true,
        triggeredCount,
        totalRequested: documentIds.length,
        totalFound: documents.length,
        results,
      });
    } catch (error) {
      if (error instanceof BackpressureError) {
        res.status(503).json({
          success: false,
          error: {
            code: 'BACKPRESSURE',
            message: 'Service temporarily unavailable - queue capacity exceeded',
          },
          retryAfterMs: error.retryAfterMs,
        });
        return;
      }

      logger.error('Failed to bulk reprocess documents', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to bulk reprocess documents' },
      });
    }
  },
);

export default router;
