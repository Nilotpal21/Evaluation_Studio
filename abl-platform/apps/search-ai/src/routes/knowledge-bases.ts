/**
 * Knowledge Base Routes
 *
 * Facade over SearchIndex: KB operations auto-manage the linked index.
 * Users interact with KnowledgeBases; the system manages SearchIndexes.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { getLazyModel } from '../db/index.js';
import type {
  IKnowledgeBase,
  ISearchIndex,
  ISearchSource,
  ISearchDocument,
  ISearchChunk,
  IChunkQuestion,
  ICanonicalSchema,
} from '@agent-platform/database/models';

import type { ISearchPipelineDefinition, IConnectorConfig } from '@agent-platform/database/models';
import {
  AVAILABLE_CANONICAL_FIELDS,
  toCanonicalField,
} from '@agent-platform/search-ai-internal/canonical';
import {
  registerSearchAITool,
  unregisterSearchAITool,
} from '../services/searchai-tool-registration.js';
import {
  applyProjectScopeFilter,
  canAccessProject,
  respondProjectScopedNotFound,
} from './project-scope.js';
import { createLogger } from '@abl/compiler/platform';
import { escapeRegex, ALLOWED_KB_SORT_FIELDS, type KBSortField } from '../utils/query-helpers.js';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import { hasTenantModelsConfigured } from '../services/llm-config/tenant-model-adapter.js';
import { mappingSuggestionService } from '../services/mapping-suggestion/index.js';
import { queryKnowledgeBaseActivityAuditLogsFromClickHouse } from '../services/search-ai-clickhouse-audit-reader.js';
import { z } from 'zod';

const logger = createLogger('knowledge-bases');
import { createDefaultPipeline } from '../services/pipeline-orchestration/index.js';
import { slugify } from '@agent-platform/shared-kernel';

// Models bound to correct databases (platform vs content)
const KnowledgeBase = getLazyModel<IKnowledgeBase>('KnowledgeBase'); // → abl_platform
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex'); // → abl_platform
const SearchSource = getLazyModel<ISearchSource>('SearchSource'); // → search_ai
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk'); // → search_ai
const ChunkQuestion = getLazyModel<IChunkQuestion>('ChunkQuestion'); // → search_ai
const SearchPipelineDefinition = getLazyModel<ISearchPipelineDefinition>(
  'SearchPipelineDefinition',
); // → search_ai
const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig'); // → abl_platform
const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema'); // → abl_platform

const router: RouterType = Router();

/** Batch size for chunked delete operations to avoid OOM on large KBs */
const DELETE_BATCH_SIZE = 5000;

function getSearchAIRuntimeUrl(): string {
  return (
    process.env.SEARCH_AI_RUNTIME_URL ||
    `http://${process.env.SEARCH_AI_RUNTIME_HOST || 'localhost'}:${process.env.SEARCH_AI_RUNTIME_PORT || '3004'}`
  );
}

async function invalidateRuntimeIndexCaches(
  indexId: string,
  tenantId: string,
  authorizationHeader: string | string[] | undefined,
): Promise<void> {
  try {
    await fetch(`${getSearchAIRuntimeUrl()}/api/internal/invalidate-pipeline-cache`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: Array.isArray(authorizationHeader)
          ? authorizationHeader[0] || ''
          : authorizationHeader || '',
        'X-Tenant-Id': tenantId,
      },
      body: JSON.stringify({ indexId, tenantId }),
    });
  } catch (err) {
    logger.warn('Failed to invalidate runtime index caches', {
      indexId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function cleanupCreatedSearchIndex(params: {
  indexId: string;
  tenantId: string;
  projectId: string;
}): Promise<void> {
  const results = await Promise.allSettled([
    CanonicalSchema.deleteMany({
      tenantId: params.tenantId,
      knowledgeBaseId: params.indexId,
    }),
    SearchIndex.findOneAndDelete({
      _id: params.indexId,
      tenantId: params.tenantId,
      projectId: params.projectId,
    }),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn('Failed to compensate partially created SearchAI KB index', {
        indexId: params.indexId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
}

// ─── TENANT GUARD ────────────────────────────────────────────────────────

router.use((req: Request, res: Response, next) => {
  if (!req.tenantContext?.tenantId) {
    res.status(401).json({
      success: false,
      error: { code: 'TENANT_REQUIRED', message: 'Tenant context is required' },
    });
    return;
  }
  next();
});

// ─── LIST ────────────────────────────────────────────────────────────────

/**
 * GET / - List knowledge bases for a project
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const { projectId, status, search, sortBy, sortOrder } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    let filter: Record<string, unknown> = { tenantId };
    if (projectId) {
      const scopedProjectId = String(projectId);
      if (!canAccessProject(req.tenantContext!, scopedProjectId)) {
        respondProjectScopedNotFound(res, 'NOT_FOUND', 'Knowledge base not found');
        return;
      }
      filter.projectId = scopedProjectId;
    } else {
      filter = applyProjectScopeFilter(filter, req.tenantContext!);
    }
    if (status) filter.status = status;
    if (search) {
      filter.name = { $regex: escapeRegex(search as string), $options: 'i' };
    }

    const sortField: KBSortField = ALLOWED_KB_SORT_FIELDS.includes(sortBy as KBSortField)
      ? (sortBy as KBSortField)
      : 'createdAt';
    const sortDir = sortOrder === 'asc' ? 1 : -1;

    const [knowledgeBases, total] = await Promise.all([
      KnowledgeBase.find(filter)
        .sort({ [sortField]: sortDir })
        .skip(offset)
        .limit(limit)
        .lean(),
      KnowledgeBase.countDocuments(filter),
    ]);

    // Recalculate live counts from the actual collections.
    // Both SearchIndex.sourceCount and KnowledgeBase.documentCount drift
    // and become stale after uploads, syncs, and deletions.
    const indexIds = knowledgeBases
      .map((kb) => kb.searchIndexId)
      .filter((id): id is string => Boolean(id));

    let indexSourceCounts: Record<string, number> = {};
    let indexDocCounts: Record<string, number> = {};
    let failedDocuments = 0;

    if (indexIds.length > 0) {
      // Batch-aggregate source counts and document counts in parallel
      const [sourceAgg, docAgg] = await Promise.all([
        SearchSource.aggregate([
          { $match: { indexId: { $in: indexIds }, tenantId } },
          { $group: { _id: '$indexId', count: { $sum: 1 } } },
        ]),
        SearchDocument.aggregate([
          { $match: { indexId: { $in: indexIds }, tenantId } },
          {
            $group: {
              _id: '$indexId',
              total: { $sum: 1 },
              failed: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
            },
          },
        ]),
      ]);

      for (const entry of sourceAgg) {
        indexSourceCounts[entry._id] = entry.count;
      }
      for (const entry of docAgg) {
        indexDocCounts[entry._id] = entry.total;
        failedDocuments += entry.failed;
      }
    }

    const enrichedKBs = knowledgeBases.map((kb) => ({
      ...kb,
      connectorCount: kb.searchIndexId
        ? (indexSourceCounts[kb.searchIndexId] ?? 0)
        : (kb.connectorCount ?? 0),
      documentCount: kb.searchIndexId
        ? (indexDocCounts[kb.searchIndexId] ?? 0)
        : (kb.documentCount ?? 0),
    }));

    const totalDocuments = enrichedKBs.reduce((sum, kb) => sum + Math.max(kb.documentCount, 0), 0);
    const aggregateDocStats = { totalDocuments, failedDocuments };

    res.json({
      knowledgeBases: enrichedKBs,
      total,
      aggregateDocStats,
      pagination: { limit, offset, hasMore: offset + knowledgeBases.length < total },
    });
  } catch (error) {
    logger.error('Failed to list knowledge bases', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'LIST_FAILED', message: 'Failed to list knowledge bases' },
    });
  }
});

// ─── CREATE ──────────────────────────────────────────────────────────────

/**
 * POST / - Create a knowledge base with auto-managed SearchIndex
 */
router.post('/', async (req: Request, res: Response) => {
  let createdIndexForCleanup: { indexId: string; tenantId: string; projectId: string } | null =
    null;
  let knowledgeBaseCreated = false;

  try {
    const tenantId = req.tenantContext!.tenantId;

    const { projectId, name, description } = req.body;

    if (!projectId || !name) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'projectId and name are required' },
      });
      return;
    }

    if (!canAccessProject(req.tenantContext!, projectId)) {
      respondProjectScopedNotFound(res, 'NOT_FOUND', 'Knowledge base not found');
      return;
    }

    // Check for duplicate name within tenant+project
    const existing = await KnowledgeBase.findOne({ tenantId, projectId, name }).lean();
    if (existing) {
      res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_NAME',
          message: 'A knowledge base with this name already exists in this project',
        },
      });
      return;
    }

    const slug = slugify(name);

    // Create SearchIndex with system defaults
    // Use environment-configured embedding provider and vector store,
    // falling back to OpenSearch + BGE-M3 for local development.
    const embeddingModel = process.env.EMBEDDING_MODEL || 'bge-m3';
    const embeddingDimensions = parseInt(process.env.EMBEDDING_DIMENSIONS || '1024', 10);
    const vectorProvider = (process.env.VECTOR_STORE_PROVIDER as string) || 'opensearch';
    const vectorCollection = process.env.VECTOR_STORE_COLLECTION || 'search-vectors-v1';

    const index = await SearchIndex.create({
      tenantId,
      projectId,
      slug,
      name: `${name} Index`,
      description: description || null,
      embeddingModel,
      embeddingDimensions,
      vectorStore: { provider: vectorProvider, collectionName: vectorCollection },
      searchDefaults: {
        topK: 10,
        similarityThreshold: 0.2,
        includeMetadata: true,
        includeContent: true,
      },
      status: 'active',
    });
    createdIndexForCleanup = {
      indexId: String(index._id),
      tenantId,
      projectId,
    };

    // No default source auto-created — sources are created on-demand
    // when the user uploads files (SetupGuide) or adds a connector.
    // Pre-creating a source skips the setup state and misleads the user
    // into thinking setup is already partially done.

    // Auto-pick LLM from workspace if tenant already has models configured.
    // This enables query intelligence and enrichment features out of the box,
    // so the user doesn't see a "Configure LLM" warning on every new KB.
    try {
      const tenantHasModels = await hasTenantModelsConfigured(tenantId);
      if (tenantHasModels) {
        await SearchIndex.findOneAndUpdate(
          { _id: index._id, tenantId },
          {
            $set: {
              llmConfig: { enabled: true, useCases: {} },
              queryLLMConfig: {
                enabled: false,
                modelId: null,
                autoSelect: true,
                preferredTier: 'fast',
              },
            },
          },
        );
        logger.info('Auto-configured LLM from tenant models for new KB', {
          indexId: String(index._id),
          tenantId,
        });
      }
    } catch (llmErr: unknown) {
      // Non-fatal: LLM auto-config failure doesn't block KB creation
      logger.warn('Non-fatal: failed to auto-configure LLM for new KB', {
        error: llmErr instanceof Error ? llmErr.message : String(llmErr),
        indexId: String(index._id),
      });
    }

    // Auto-create CanonicalSchema with core fields pre-mapped.
    // This gives the query pipeline alias resolution and vocabulary something to work with
    // even before connector-based field mapping happens.
    let canonicalSchemaId: string | null = null;
    try {
      // Use toCanonicalField() which has the correct filterable logic (excludes source_url)
      const fields = AVAILABLE_CANONICAL_FIELDS.map((f) => ({
        ...toCanonicalField(f),
        name: f.storageField, // alias name = storage name for core fields
        indexed: f.category === 'core', // Only core fields are indexed
      }));

      const schema = await CanonicalSchema.create({
        tenantId,
        knowledgeBaseId: String(index._id),
        version: 1,
        status: 'active',
        fields,
      });
      canonicalSchemaId = String(schema._id);
      logger.info('Auto-created canonical schema for KB', {
        indexId: String(index._id),
        canonicalSchemaId,
        fieldCount: fields.length,
      });
    } catch (schemaErr: unknown) {
      // Non-fatal: schema can be created/synced later
      logger.warn('Non-fatal: failed to auto-create canonical schema', {
        error: schemaErr instanceof Error ? schemaErr.message : String(schemaErr),
        indexId: String(index._id),
      });
    }

    // NOTE: Vocabulary is NOT seeded at KB creation time.
    // It is generated lazily based on actual content:
    //   - JSON upload → vocabulary-generation-worker creates entries from canonical schema
    //   - Document upload → document metadata vocab seeded on first document upload
    //   - Both → merged automatically
    // This avoids polluting JSON/product KBs with irrelevant document metadata fields.

    // Auto-register SearchAI KB tool for this index
    await registerSearchAITool({
      indexId: String(index._id),
      tenantId,
      projectId,
      slug,
      name,
      description: description || undefined,
      createdBy: req.tenantContext?.userId ?? 'system',
    });

    // Create KnowledgeBase linked to the index
    const knowledgeBase = await KnowledgeBase.create({
      tenantId,
      projectId,
      name,
      description: description || null,
      searchIndexId: index._id,
      canonicalSchemaId: canonicalSchemaId || undefined,
      status: 'creating',
      createdBy: req.tenantContext?.userId ?? 'system',
    });
    knowledgeBaseCreated = true;
    createdIndexForCleanup = null;

    // Seed default pipeline for the new knowledge base
    const userId = req.tenantContext?.userId ?? 'system';
    try {
      const pipelineData = createDefaultPipeline(tenantId, String(knowledgeBase._id), userId);
      await SearchPipelineDefinition.create(pipelineData);
    } catch (err: unknown) {
      // Non-fatal: pipeline seeding failure doesn't block KB creation
      // User can create pipeline later via the UI
      logger.error('Failed to seed default pipeline', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Transition KB to active now that all creation steps have completed
    const updatedKb = await KnowledgeBase.findOneAndUpdate(
      applyProjectScopeFilter({ _id: knowledgeBase._id, tenantId }, req.tenantContext!),
      { $set: { status: 'active' } },
      { new: true },
    );

    res.status(201).json({ knowledgeBase: updatedKb ?? knowledgeBase });
  } catch (error) {
    if (createdIndexForCleanup && !knowledgeBaseCreated) {
      await cleanupCreatedSearchIndex(createdIndexForCleanup);
    }
    logger.error('Failed to create knowledge base', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'CREATE_FAILED', message: 'Failed to create knowledge base' },
    });
  }
});

// ─── HEALTH SUMMARY ─────────────────────────────────────────────────────

const kbIdSchema = z.string().min(1);

/**
 * GET /:kbId/health-summary - Aggregated health status for a knowledge base
 *
 * Returns source sync status, pipeline validation, circuit breaker state,
 * and document status in a single response.
 */
router.get('/:kbId/health-summary', async (req: Request, res: Response) => {
  try {
    const kbIdResult = kbIdSchema.safeParse(req.params.kbId);
    if (!kbIdResult.success) {
      res
        .status(400)
        .json({ success: false, error: { code: 'INVALID_KB_ID', message: 'Invalid kbId' } });
      return;
    }
    const kbId = kbIdResult.data;
    const tenantId = req.tenantContext!.tenantId;

    // 1. Fetch KB (tenant-scoped)
    const kb = await KnowledgeBase.findOne(
      applyProjectScopeFilter({ _id: kbId, tenantId }, req.tenantContext!),
    ).lean();
    if (!kb) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Knowledge base not found' },
      });
      return;
    }

    const searchIndexId = kb.searchIndexId;

    // 2. Fetch sources for this KB's index
    const sources = searchIndexId
      ? await SearchSource.find({ indexId: searchIndexId, tenantId }).lean()
      : [];

    const sourceIds = sources.map((s) => String(s._id));

    // 3. Parallel queries for connector configs, pipeline, and document counts
    const [connectorConfigs, pipeline, docStatusAgg] = await Promise.all([
      // Connector configs for sync status
      sourceIds.length > 0
        ? ConnectorConfig.find({ sourceId: { $in: sourceIds }, tenantId }).lean()
        : Promise.resolve([]),

      // Pipeline definition
      SearchPipelineDefinition.findOne({ knowledgeBaseId: kbId, tenantId }).lean(),

      // Document status aggregation
      sourceIds.length > 0
        ? SearchDocument.aggregate([
            { $match: { sourceId: { $in: sourceIds }, tenantId } },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                errored: {
                  $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] },
                },
                processing: {
                  $sum: {
                    $cond: [{ $in: ['$status', ['extracting', 'enriching', 'embedding']] }, 1, 0],
                  },
                },
              },
            },
          ])
        : Promise.resolve([]),
    ]);

    // 4. Build sources summary
    const syncingCount = connectorConfigs.filter((c) => c.syncState?.syncInProgress).length;
    const sourceErrors = connectorConfigs
      .filter((c) => c.syncState?.lastSyncError)
      .map((c) => ({
        sourceId: c.sourceId,
        sourceName: sources.find((s) => String(s._id) === c.sourceId)?.name ?? c.sourceId,
        error: c.syncState.lastSyncError,
        lastSyncAt: c.syncState.lastFullSyncAt || c.syncState.lastDeltaSyncAt,
      }));

    // 5. Build pipeline summary
    const pipelineSummary = pipeline
      ? {
          status: pipeline.validationStatus ?? 'pending',
          errors: (pipeline.validationErrors ?? []).map((e) => ({
            code: e.code,
            message: e.message,
            severity: e.severity,
            path: e.path,
          })),
        }
      : { status: 'not-configured' as const, errors: [] };

    // 6. LLM config check (separate from circuit breaker so one doesn't mask the other)
    let circuitBreaker: {
      state: string;
      failureRate: number;
      provider: string;
    } | null = null;
    let llmConfigured = false;
    let resolvedProvider: string | null = null;

    if (searchIndexId) {
      // 6a. Check if tenant has real models in Model Library.
      // Use hasTenantModelsConfigured (checks TenantModel collection) instead of
      // resolveIndexLLMConfig which falls back to env vars and would report
      // "configured" even when the user hasn't connected any model.
      try {
        llmConfigured = await hasTenantModelsConfigured(tenantId);
      } catch (modelsErr) {
        logger.debug('Tenant models check failed', {
          error: modelsErr instanceof Error ? modelsErr.message : String(modelsErr),
          kbId,
        });
      }

      // 6b. Resolve provider for circuit breaker (best-effort, still uses old resolver)
      try {
        const llmConfig = await resolveIndexLLMConfig(tenantId, String(searchIndexId));
        resolvedProvider = llmConfig.provider || null;
      } catch (llmErr) {
        logger.debug('LLM config resolution failed', {
          error: llmErr instanceof Error ? llmErr.message : String(llmErr),
          kbId,
        });
      }

      // 6c. Circuit breaker status (independent of LLM resolution)
      if (resolvedProvider) {
        try {
          const cbStatus = await mappingSuggestionService.getCircuitBreakerStatus(
            tenantId,
            resolvedProvider,
          );
          if (cbStatus) {
            circuitBreaker = {
              state: cbStatus.state,
              failureRate: cbStatus.failureRate,
              provider: cbStatus.provider,
            };
          }
        } catch (cbErr) {
          logger.debug('Circuit breaker status unavailable', {
            error: cbErr instanceof Error ? cbErr.message : String(cbErr),
            kbId,
          });
          circuitBreaker = null;
        }
      }
    }

    // 7. Document counts
    const docStats = docStatusAgg[0] ?? { total: 0, errored: 0, processing: 0 };

    res.json({
      success: true,
      data: {
        sources: {
          total: sources.length,
          syncing: syncingCount,
          errors: sourceErrors,
        },
        pipeline: pipelineSummary,
        circuitBreaker,
        documents: {
          total: docStats.total,
          errored: docStats.errored,
          processing: docStats.processing,
        },
        llm: {
          configured: llmConfigured,
        },
      },
    });
  } catch (error) {
    logger.error('Failed to get health summary', {
      error: error instanceof Error ? error.message : String(error),
      kbId: req.params.kbId,
    });
    res.status(500).json({
      success: false,
      error: { code: 'HEALTH_SUMMARY_ERROR', message: 'Failed to get health summary' },
    });
  }
});

// ─── ACTIVITY FEED ──────────────────────────────────────────────────────

/**
 * GET /:kbId/activity - Activity feed for a knowledge base
 *
 * Returns shared audit log entries related to this KB's index and sources.
 */
router.get('/:kbId/activity', async (req: Request, res: Response) => {
  try {
    const kbIdResult = kbIdSchema.safeParse(req.params.kbId);
    if (!kbIdResult.success) {
      res
        .status(400)
        .json({ success: false, error: { code: 'INVALID_KB_ID', message: 'Invalid kbId' } });
      return;
    }
    const kbId = kbIdResult.data;
    const tenantId = req.tenantContext!.tenantId;

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    // 1. Fetch KB (tenant-scoped)
    const kb = await KnowledgeBase.findOne(
      applyProjectScopeFilter({ _id: kbId, tenantId }, req.tenantContext!),
    ).lean();
    if (!kb) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Knowledge base not found' },
      });
      return;
    }

    // 2. Get source IDs for this KB's index
    const sources = kb.searchIndexId
      ? await SearchSource.find({ indexId: kb.searchIndexId, tenantId }).select('_id').lean()
      : [];
    const sourceIds = sources.map((s) => String(s._id));

    const resourceIds = [kb.searchIndexId, ...sourceIds].filter(Boolean) as string[];
    if (resourceIds.length === 0) {
      res.json({ success: true, data: { activities: [], total: 0, hasMore: false } });
      return;
    }

    const { logs: activities, total } = await queryKnowledgeBaseActivityAuditLogsFromClickHouse({
      tenantId,
      indexId: kb.searchIndexId,
      sourceIds,
      limit,
      offset,
    });

    // Map to clean response shape — strip PII fields (ip, userAgent)
    const cleanActivities = activities.map((a) => ({
      id: a.id,
      action: a.action,
      metadata: a.metadata,
      timestamp: a.timestamp,
      userId: a.actor,
    }));

    res.json({
      success: true,
      data: {
        activities: cleanActivities,
        total,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    logger.error('Failed to get activity feed', {
      error: error instanceof Error ? error.message : String(error),
      kbId: req.params.kbId,
    });
    res.status(500).json({
      success: false,
      error: { code: 'ACTIVITY_FEED_ERROR', message: 'Failed to get activity feed' },
    });
  }
});

// ─── GET ONE ─────────────────────────────────────────────────────────────

/**
 * GET /:kbId - Get knowledge base with linked index
 */
router.get('/:kbId', async (req: Request, res: Response) => {
  try {
    const kbIdResult = kbIdSchema.safeParse(req.params.kbId);
    if (!kbIdResult.success) {
      res
        .status(400)
        .json({ success: false, error: { code: 'INVALID_KB_ID', message: 'Invalid kbId' } });
      return;
    }
    const kbId = kbIdResult.data;
    const tenantId = req.tenantContext!.tenantId;
    const kb = await KnowledgeBase.findOne(
      applyProjectScopeFilter({ _id: kbId, tenantId }, req.tenantContext!),
    ).lean();

    if (!kb) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Knowledge base not found' },
      });
      return;
    }

    // Fetch linked SearchIndex for stats/config with the same project scope as the KB.
    const index = kb.searchIndexId
      ? await SearchIndex.findOne(
          applyProjectScopeFilter({ _id: kb.searchIndexId, tenantId }, req.tenantContext!),
        ).lean()
      : null;

    // Recalculate actual counts from database to avoid drift
    if (index) {
      const [actualDocCount, actualChunkCount, actualSourceCount] = await Promise.all([
        SearchDocument.countDocuments({ indexId: index._id, tenantId }),
        SearchChunk.countDocuments({ indexId: index._id, tenantId }),
        SearchSource.countDocuments({ indexId: index._id, tenantId }),
      ]);

      // Return actual counts, not stored counters
      const indexWithRealCounts = {
        ...index,
        documentCount: actualDocCount,
        chunkCount: actualChunkCount,
        sourceCount: actualSourceCount,
      };

      res.json({ knowledgeBase: { ...kb, index: indexWithRealCounts } });
    } else {
      res.json({ knowledgeBase: { ...kb, index } });
    }
  } catch (error) {
    logger.error('Failed to get knowledge base', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'GET_FAILED', message: 'Failed to get knowledge base' },
    });
  }
});

// ─── UPDATE ──────────────────────────────────────────────────────────────

/**
 * PATCH /:kbId - Update knowledge base (name, description only)
 */
router.patch('/:kbId', async (req: Request, res: Response) => {
  try {
    const kbIdResult = kbIdSchema.safeParse(req.params.kbId);
    if (!kbIdResult.success) {
      res
        .status(400)
        .json({ success: false, error: { code: 'INVALID_KB_ID', message: 'Invalid kbId' } });
      return;
    }
    const kbId = kbIdResult.data;
    const tenantId = req.tenantContext!.tenantId;
    const { name, description } = req.body;

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;

    const knowledgeBase = await KnowledgeBase.findOneAndUpdate(
      applyProjectScopeFilter({ _id: kbId, tenantId }, req.tenantContext!),
      { $set: updates },
      { new: true, runValidators: true },
    ).lean();

    if (!knowledgeBase) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Knowledge base not found' },
      });
      return;
    }

    // Re-register tool if name or description changed so the tool DSL stays in sync
    if ((name !== undefined || description !== undefined) && knowledgeBase.searchIndexId) {
      const searchIndex = await SearchIndex.findOne({
        _id: knowledgeBase.searchIndexId,
        tenantId,
      }).lean();
      if (searchIndex) {
        await registerSearchAITool({
          indexId: String(searchIndex._id),
          tenantId,
          projectId: knowledgeBase.projectId,
          slug: searchIndex.slug,
          name: knowledgeBase.name,
          description: knowledgeBase.description ?? undefined,
          createdBy: req.tenantContext!.userId || 'system',
        });
      }
    }

    res.json({ knowledgeBase });
  } catch (error) {
    logger.error('Failed to update knowledge base', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'UPDATE_FAILED', message: 'Failed to update knowledge base' },
    });
  }
});

// ─── DELETE ──────────────────────────────────────────────────────────────

/**
 * DELETE /:kbId - Delete knowledge base with cascading cleanup
 */
router.delete('/:kbId', async (req: Request, res: Response) => {
  try {
    const kbIdResult = kbIdSchema.safeParse(req.params.kbId);
    if (!kbIdResult.success) {
      res
        .status(400)
        .json({ success: false, error: { code: 'INVALID_KB_ID', message: 'Invalid kbId' } });
      return;
    }
    const kbId = kbIdResult.data;
    const tenantId = req.tenantContext!.tenantId;
    const kb = await KnowledgeBase.findOne(
      applyProjectScopeFilter({ _id: kbId, tenantId }, req.tenantContext!),
    ).lean();

    if (!kb) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Knowledge base not found' },
      });
      return;
    }

    // Unregister the generated ProjectTool before destructive deletion. If this
    // fails, leave the KB/index intact so retries do not create DB-to-tool drift.
    let deletedIndex: ISearchIndex | null = null;
    let indexToDelete: ISearchIndex | null = null;
    if (kb.searchIndexId) {
      indexToDelete = await SearchIndex.findOne(
        applyProjectScopeFilter({ _id: kb.searchIndexId, tenantId }, req.tenantContext!),
      ).lean();

      if (indexToDelete && indexToDelete.slug && indexToDelete.projectId) {
        await unregisterSearchAITool({
          indexId: String(indexToDelete._id),
          tenantId,
          projectId: indexToDelete.projectId,
          slug: indexToDelete.slug,
        });
      }

      // Cascading delete: questions → chunks → documents → sources → index → KB
      // All queries scoped to tenantId for defense-in-depth.
      const sources = await SearchSource.find({ indexId: kb.searchIndexId, tenantId }).lean();
      const sourceIds = sources.map((s) => s._id);

      if (sourceIds.length > 0) {
        const docIds = await SearchDocument.distinct('_id', {
          sourceId: { $in: sourceIds },
          tenantId,
        });

        // Delete documents with proper vector store cleanup (batched)
        const { deleteDocumentsWithVectorCleanup } =
          await import('../services/document-cleanup.service.js');
        for (let i = 0; i < docIds.length; i += DELETE_BATCH_SIZE) {
          const batch = docIds.slice(i, i + DELETE_BATCH_SIZE).map((id) => String(id));
          await deleteDocumentsWithVectorCleanup(batch, tenantId, kb.searchIndexId);
        }
      }
      await SearchSource.deleteMany({ indexId: kb.searchIndexId, tenantId });
      deletedIndex = await SearchIndex.findOneAndDelete(
        applyProjectScopeFilter({ _id: kb.searchIndexId, tenantId }, req.tenantContext!),
      ).lean();
    }

    await KnowledgeBase.findOneAndDelete(
      applyProjectScopeFilter({ _id: kbId, tenantId }, req.tenantContext!),
    );

    // Runtime authorization/discovery caches must be invalidated after the DB
    // row disappears so stale positive ownership decisions do not survive TTL.
    if (deletedIndex) {
      await invalidateRuntimeIndexCaches(
        String(deletedIndex._id),
        tenantId,
        req.headers.authorization,
      );
    }

    res.json({ deleted: true, kbId });
  } catch (error) {
    logger.error('Failed to delete knowledge base', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'DELETE_FAILED', message: 'Failed to delete knowledge base' },
    });
  }
});

// ─── SYNC COUNTERS ───────────────────────────────────────────────────────

/**
 * POST /:kbId/sync-counters - Recalculate and sync document/chunk counts
 *
 * Fixes counter drift by querying actual DB counts and updating SearchIndex + KnowledgeBase
 */
router.post('/:kbId/sync-counters', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const tenantId = req.tenantContext.tenantId;
    const { kbId } = req.params;

    const kb = await KnowledgeBase.findOne(
      applyProjectScopeFilter({ _id: kbId, tenantId }, req.tenantContext),
    ).lean();
    if (!kb) {
      res.status(404).json({ error: 'Knowledge base not found' });
      return;
    }

    if (!kb.searchIndexId) {
      res.json({ success: true, message: 'No index to sync' });
      return;
    }

    // Count actual documents and chunks
    const actualDocCount = await SearchDocument.countDocuments({
      indexId: kb.searchIndexId,
      tenantId,
    });
    const actualChunkCount = await SearchChunk.countDocuments({
      indexId: kb.searchIndexId,
      tenantId,
    });

    // Update SearchIndex
    await SearchIndex.findOneAndUpdate(
      applyProjectScopeFilter({ _id: kb.searchIndexId, tenantId }, req.tenantContext),
      {
        $set: {
          documentCount: actualDocCount,
          chunkCount: actualChunkCount,
        },
      },
    );

    // Update KnowledgeBase
    await KnowledgeBase.findOneAndUpdate(
      applyProjectScopeFilter({ _id: kbId, tenantId }, req.tenantContext),
      {
        $set: {
          documentCount: actualDocCount,
        },
      },
    );

    logger.info('Counters synced', {
      kbId,
      indexId: kb.searchIndexId,
      documentCount: actualDocCount,
      chunkCount: actualChunkCount,
    });

    res.json({
      success: true,
      documentCount: actualDocCount,
      chunkCount: actualChunkCount,
    });
  } catch (error) {
    logger.error('Failed to sync counters', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to sync counters' });
  }
});

// ─── REBUILD ─────────────────────────────────────────────────────────────

/**
 * POST /:kbId/rebuild - Trigger rebuild of knowledge base index
 */
router.post('/:kbId/rebuild', async (_req: Request, res: Response) => {
  // TODO: Implement rebuild via BullMQ job when rebuild worker is available
  res.status(501).json({
    success: false,
    error: { code: 'NOT_IMPLEMENTED', message: 'Rebuild is not yet implemented' },
  });
});

export default router;
