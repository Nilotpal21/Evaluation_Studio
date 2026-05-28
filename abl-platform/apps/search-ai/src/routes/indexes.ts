/**
 * Search Index Routes
 *
 * CRUD operations for search indexes.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getLazyModel } from '../db/index.js';
import type {
  ISearchIndex,
  ICanonicalSchema,
  IKnowledgeBase,
  ISearchPipelineDefinition,
} from '@agent-platform/database/models';
import {
  CreateIndexSchema,
  UpdateIndexSchema,
  LLMConfigSchema,
  QueryLLMConfigSchema,
  validateEmbeddingDimensions,
} from '../validation/index-schemas.js';
import {
  resolveIndexLLMConfig,
  resolveEnhancedIndexLLMConfig,
} from '../services/llm-config/resolver.js';
import { getUseCaseDefaults, getAvailableUseCases } from '../services/llm-config/defaults.js';
import {
  resolveTenantModelById,
  resolveTenantModelWithFallback,
} from '../services/llm-config/tenant-model-adapter.js';
import { WorkerLLMClient } from '@agent-platform/llm';
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
import { AVAILABLE_CANONICAL_FIELDS } from '@agent-platform/search-ai-internal/canonical';
import { createReindexOrchestrator } from '../services/reindexing/index.js';
import { resolveEmbeddingCredentials } from '../services/llm-config/embedding-credentials.js';

const logger = createLogger('indexes');
import type { ITenantModel } from '@agent-platform/database/models';

// Model bound to platform database
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex'); // → abl_platform
const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema'); // → abl_platform
const KnowledgeBase = getLazyModel<IKnowledgeBase>('KnowledgeBase'); // → search_ai
const SearchPipelineDefinition = getLazyModel<ISearchPipelineDefinition>(
  'SearchPipelineDefinition',
); // → search_ai

const router: RouterType = Router();

// Singleton orchestrator
let _reindexOrchestrator: ReturnType<typeof createReindexOrchestrator> | null = null;
function getReindexOrchestrator() {
  if (!_reindexOrchestrator) {
    _reindexOrchestrator = createReindexOrchestrator();
  }
  return _reindexOrchestrator;
}

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

async function cleanupCreatedIndex(params: {
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
      logger.warn('Failed to compensate partially created SearchAI index', {
        indexId: params.indexId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
}

/**
 * GET / - List all search indexes
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { projectId, status } = req.query;

    const tenantId = req.tenantContext!.tenantId;
    let filter: Record<string, unknown> = { tenantId };
    if (projectId) {
      const scopedProjectId = String(projectId);
      if (!canAccessProject(req.tenantContext!, scopedProjectId)) {
        respondProjectScopedNotFound(res, 'INDEX_NOT_FOUND', 'Index not found');
        return;
      }
      filter.projectId = scopedProjectId;
    } else {
      filter = applyProjectScopeFilter(filter, req.tenantContext!);
    }
    if (status) filter.status = status;

    const indexes = await SearchIndex.find(filter).sort({ createdAt: -1 }).lean();

    res.json({ indexes, total: indexes.length });
  } catch (error) {
    logger.error('Failed to list indexes', {
      error: error instanceof Error ? error.message : String(error),
    });
    res
      .status(500)
      .json({ success: false, error: { code: 'LIST_FAILED', message: 'Failed to list indexes' } });
  }
});

/**
 * POST / - Create a new search index
 */
router.post('/', async (req: Request, res: Response) => {
  let createdIndexForCleanup: { indexId: string; tenantId: string; projectId: string } | null =
    null;

  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'TENANT_REQUIRED', message: 'Tenant context required' },
      });
      return;
    }
    const tenantId = req.tenantContext.tenantId;

    // Validate request body
    const validation = CreateIndexSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: validation.error.errors.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
        })),
      });
      return;
    }

    const {
      projectId,
      slug,
      name,
      description,
      embeddingModel,
      embeddingDimensions,
      vectorStore,
      searchDefaults,
    } = validation.data;

    if (!canAccessProject(req.tenantContext, projectId)) {
      respondProjectScopedNotFound(res, 'INDEX_NOT_FOUND', 'Index not found');
      return;
    }

    // Check for duplicate slug within tenant+project
    const existing = await SearchIndex.findOne({ tenantId, projectId, slug }).lean();
    if (existing) {
      res.status(409).json({
        success: false,
        error: {
          code: 'SLUG_CONFLICT',
          message: `Index with slug "${slug}" already exists in this project`,
        },
      });
      return;
    }

    // Set defaults from environment (consistent with knowledge-bases.ts route)
    const finalEmbeddingModel = embeddingModel || process.env.EMBEDDING_MODEL || 'bge-m3';
    const finalEmbeddingDimensions =
      embeddingDimensions || parseInt(process.env.EMBEDDING_DIMENSIONS || '1024', 10);

    // Validate embedding dimensions match model
    const dimensionValidation = validateEmbeddingDimensions(
      finalEmbeddingModel,
      finalEmbeddingDimensions,
    );
    if (!dimensionValidation.valid) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_DIMENSIONS', message: dimensionValidation.error },
      });
      return;
    }

    const index = await SearchIndex.create({
      tenantId,
      projectId,
      slug,
      name,
      description: description || null,
      embeddingModel: finalEmbeddingModel,
      embeddingDimensions: finalEmbeddingDimensions,
      vectorStore: vectorStore || {
        provider: (process.env.VECTOR_STORE_PROVIDER as string) || 'opensearch',
        collectionName: process.env.VECTOR_STORE_COLLECTION || slug,
      },
      searchDefaults: searchDefaults || {
        topK: 10,
        similarityThreshold: 0.2,
        includeMetadata: true,
        includeContent: true,
      },
      status: 'active',
      sourceCount: 0,
      documentCount: 0,
      chunkCount: 0,
    });
    createdIndexForCleanup = {
      indexId: String((index as any)._id),
      tenantId,
      projectId,
    };

    // Auto-create CanonicalSchema with core fields pre-mapped
    try {
      const buildField = (f: (typeof AVAILABLE_CANONICAL_FIELDS)[number], isCore: boolean) => ({
        name: f.storageField,
        label: f.label,
        type: f.type,
        storageField: f.storageField,
        indexed: isCore,
        filterable: f.type === 'keyword' || f.type === 'date' || f.type === 'float',
        aggregatable: f.type === 'keyword',
        sortable: f.type === 'keyword' || f.type === 'date' || f.type === 'float',
        description: f.label,
      });

      const fields = AVAILABLE_CANONICAL_FIELDS.map((f) => buildField(f, f.category === 'core'));

      await CanonicalSchema.create({
        tenantId,
        knowledgeBaseId: String((index as any)._id),
        version: 1,
        status: 'active',
        fields,
      });
    } catch (schemaErr: unknown) {
      logger.warn('Non-fatal: failed to auto-create canonical schema', {
        error: schemaErr instanceof Error ? schemaErr.message : String(schemaErr),
        indexId: String((index as any)._id),
      });
    }

    // Auto-register SearchAI KB tool for this index
    await registerSearchAITool({
      indexId: String((index as any)._id),
      tenantId,
      projectId,
      slug,
      name,
      description: description || undefined,
      createdBy: req.tenantContext?.userId ?? 'system',
    });
    createdIndexForCleanup = null;

    // No default source auto-created — sources are created on-demand
    // when the user uploads files (SetupGuide) or adds a connector.
    // Pre-creating a source skips the setup state and misleads the user
    // into thinking setup is already partially done.

    res.status(201).json({ index, defaultSource: null });
  } catch (error) {
    if (createdIndexForCleanup) {
      await cleanupCreatedIndex(createdIndexForCleanup);
    }
    logger.error('Failed to create index', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'CREATE_FAILED', message: 'Failed to create index' },
    });
  }
});

/**
 * GET /llm-config/use-cases - List all available LLM use cases with smart defaults
 *
 * Returns metadata about each use case: description, rationale, default tier,
 * cost rating, and volume estimate. Useful for UI to display configuration options.
 *
 * IMPORTANT: Static route — must be registered BEFORE /:indexId to avoid capture.
 */
router.get('/llm-config/use-cases', async (_req: Request, res: Response) => {
  try {
    const useCases = getAvailableUseCases();
    const useCaseDetails = useCases.map((useCase) => {
      const defaults = getUseCaseDefaults(useCase);
      return {
        name: useCase,
        enabled: defaults.enabled,
        modelTier: defaults.modelTier,
        description: defaults.description,
        rationale: defaults.rationale,
        costRating: defaults.costRating,
        volumeEstimate: defaults.volumeEstimate,
      };
    });

    res.json({
      useCases: useCaseDetails,
      total: useCaseDetails.length,
    });
  } catch (error) {
    logger.error('Failed to list use cases', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'LIST_FAILED', message: 'Failed to list use cases' },
    });
  }
});

/**
 * GET /llm-config/tiers - List available model tiers for tenant
 *
 * Returns the actual models for each tier based on tenant's configured LLM provider.
 * Requires tenant context to determine which provider is configured.
 *
 * Query params:
 *   - provider: Optional provider override (anthropic, openai, gemini)
 *
 * IMPORTANT: Static route — must be registered BEFORE /:indexId to avoid capture.
 */
router.get('/llm-config/tiers', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'TENANT_REQUIRED', message: 'Tenant context required' },
      });
      return;
    }

    // Use query param provider if specified, otherwise will use tenant default
    const provider = (req.query.provider as string) || 'anthropic';

    // Create temporary WorkerLLMClient to get tier mappings
    // Note: API key not needed for tier lookup, but required by constructor
    const llmClient = new WorkerLLMClient(provider, 'dummy-key-for-tier-lookup', 'default');

    const tiers = {
      fast: {
        tier: 'fast',
        model: llmClient.getModelForTier('fast'),
        description: 'High-volume, cost-optimized tasks (summarization, question generation)',
        costMultiplier: 1,
      },
      balanced: {
        tier: 'balanced',
        model: llmClient.getModelForTier('balanced'),
        description: 'Quality-critical tasks (vision processing, multimodal analysis)',
        costMultiplier: 10,
      },
      powerful: {
        tier: 'powerful',
        model: llmClient.getModelForTier('powerful'),
        description: 'Maximum quality for complex reasoning (optional upgrade for any use case)',
        costMultiplier: 50,
      },
    };

    res.json({
      provider,
      tiers,
    });
  } catch (error) {
    logger.error('Failed to get model tiers', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'FETCH_FAILED', message: 'Failed to get model tiers' },
    });
  }
});

/**
 * GET /:indexId - Get index details with resolved LLM configuration
 */
router.get('/:indexId', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();

    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'INDEX_NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Resolve LLM configuration (includes smart defaults + tenant credentials)
    let resolvedLLMConfig = null;
    try {
      resolvedLLMConfig = await resolveIndexLLMConfig(index.tenantId, indexId);
    } catch (error) {
      logger.warn('Failed to resolve LLM config, continuing without it', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Non-fatal - return index without resolved config
    }

    // Also resolve enhanced config which uses tenant_models and returns the
    // exact model the user connected (displayName, provider, tier).
    // This is what the UI should use for "connected model" banners.
    let enhancedLLMConfig = null;
    try {
      enhancedLLMConfig = await resolveEnhancedIndexLLMConfig(index.tenantId, indexId);
    } catch (error) {
      logger.warn('Failed to resolve enhanced LLM config, continuing without it', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Resolve the tenant's DEFAULT model — the one with the star in Model Library.
    // This is used by the UI banner to show the exact model the user picked,
    // regardless of per-use-case tier resolution (which varies by task).
    let defaultModel: { displayName: string; provider: string; tier: string } | null = null;
    try {
      const TenantModel = getLazyModel<ITenantModel>('TenantModel');
      const tenantDefault = await TenantModel.findOne({
        tenantId: index.tenantId,
        isDefault: true,
        isActive: true,
        inferenceEnabled: true,
      })
        .select('displayName provider tier')
        .lean();
      if (tenantDefault) {
        defaultModel = {
          displayName: tenantDefault.displayName,
          provider: tenantDefault.provider ?? '',
          tier: tenantDefault.tier,
        };
      }
    } catch (error) {
      logger.warn('Failed to resolve default tenant model, continuing without it', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    res.json({
      index,
      resolvedLLMConfig,
      enhancedLLMConfig,
      defaultModel,
    });
  } catch (error) {
    logger.error('Failed to get index', {
      error: error instanceof Error ? error.message : String(error),
    });
    res
      .status(500)
      .json({ success: false, error: { code: 'FETCH_FAILED', message: 'Failed to get index' } });
  }
});

/**
 * PATCH /:indexId - Update index
 */
router.patch('/:indexId', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    // Validate request body
    const validation = UpdateIndexSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: validation.error.errors.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
        })),
      });
      return;
    }

    const updates = validation.data;

    const index = await SearchIndex.findOneAndUpdate(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
      { $set: updates },
      { new: true, runValidators: true },
    ).lean();

    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'INDEX_NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Invalidate search-ai-runtime caches when the index config changes.
    // The runtime's ownership cache holds the full SearchIndex document
    // (searchDefaults, queryLLMConfig, …) for 2 minutes, so any update leaves
    // that cached copy stale. invalidateRuntimeIndexCaches clears all three
    // runtime caches (pipeline + discovery + ownership), so the next search
    // request picks up the new config immediately rather than after the TTL.
    await invalidateRuntimeIndexCaches(indexId, tenantId, req.headers.authorization);

    res.json({ index });
  } catch (error) {
    logger.error('Failed to update index', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'UPDATE_FAILED', message: 'Failed to update index' },
    });
  }
});

/**
 * GET /:indexId/llm-config - Get enhanced LLM configuration for index
 *
 * Returns fully resolved LLM configuration with status tracking, tier fallback,
 * and actionable guidance. Includes:
 * - Feature status (active/pending/fallback/disabled)
 * - Model resolution details (which model was selected and why)
 * - Action required (for pending features)
 * - Cost estimates
 *
 * This is the primary endpoint for the KB Settings UI.
 */
router.get('/:indexId/llm-config', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    // Check if index exists (with tenant isolation)
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'INDEX_NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Resolve enhanced configuration with full status tracking
    const enhancedConfig = await resolveEnhancedIndexLLMConfig(tenantId, indexId);

    res.json({
      indexId,
      rawConfig: index.llmConfig, // What's stored in DB (user overrides)
      enhancedConfig, // Fully resolved with status tracking
    });
  } catch (error) {
    logger.error('Failed to get LLM config', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'FETCH_FAILED', message: 'Failed to retrieve LLM configuration' },
    });
  }
});

/**
 * PATCH /:indexId/llm-config - Update LLM configuration for index
 *
 * Allows updating per-use-case LLM settings (enable/disable, tier, params).
 * Validation ensures only valid use cases and settings are accepted.
 */
router.patch('/:indexId/llm-config', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantContext = req.tenantContext;
    if (!tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'TENANT_REQUIRED', message: 'Tenant context required' },
      });
      return;
    }

    const tenantId = tenantContext.tenantId;

    // Validate LLM config structure
    const validation = LLMConfigSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid LLM configuration',
        details: validation.error.errors.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
        })),
      });
      return;
    }

    // Check if index exists (with tenant isolation)
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, tenantContext),
    ).lean();
    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'INDEX_NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Update llmConfig field only (with tenant isolation)
    const updatedIndex = await SearchIndex.findOneAndUpdate(
      applyProjectScopeFilter({ _id: indexId, tenantId }, tenantContext),
      { $set: { llmConfig: validation.data } },
      { new: true, runValidators: true },
    ).lean();

    // Resolve enhanced configuration with full status tracking
    const enhancedConfig = await resolveEnhancedIndexLLMConfig(index.tenantId, indexId);

    res.json({
      index: updatedIndex,
      enhancedConfig, // Enhanced config with status tracking
      message: 'LLM configuration updated successfully',
    });
  } catch (error) {
    logger.error('Failed to update LLM config', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'UPDATE_FAILED', message: 'Failed to update LLM configuration' },
    });
  }
});

// ─── Query Pipeline LLM Configuration ──────────────────────────────────────

/**
 * GET /:indexId/query-llm-status - Get resolved query pipeline LLM status
 *
 * Returns which model the query pipeline will use for this KB,
 * the list of available models, and any warnings.
 */
router.get('/:indexId/query-llm-status', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'INDEX_NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Load available models for this tenant
    const TenantModel = getLazyModel<ITenantModel>('TenantModel');
    const availableModels = await TenantModel.find({
      tenantId,
      isActive: true,
      inferenceEnabled: true,
    })
      .select('_id displayName provider modelId tier supportsTools')
      .lean();

    const config = (index as any).queryLLMConfig;
    let resolvedModel: Record<string, unknown> | null = null;
    let resolution: string = 'none';
    let warning: string | null = null;

    if (config?.modelId && !config.autoSelect) {
      // Pinned model — check if still active
      const pinned = availableModels.find((m: any) => String(m._id) === config.modelId);
      if (pinned) {
        resolvedModel = {
          id: String(pinned._id),
          displayName: pinned.displayName,
          provider: pinned.provider,
          modelId: pinned.modelId,
          tier: pinned.tier,
          isActive: true,
        };
        resolution = 'pinned';
      } else {
        // Pinned model was deactivated or deleted
        warning = 'Selected model is no longer active. Falling back to static matching.';
        resolution = 'pinned';
      }
    } else if (config?.autoSelect) {
      // Auto-select — resolve best model for tier
      const tier = config.preferredTier || 'fast';
      const result = await resolveTenantModelWithFallback(tenantId, tier);
      if (result.model) {
        resolvedModel = {
          id: null, // Auto-selected, no pinned ID
          displayName: result.model.displayName,
          provider: result.model.provider,
          modelId: result.model.modelId,
          tier: result.model.tier,
          isActive: true,
        };
        resolution = 'auto-selected';
      }
    }

    res.json({
      enabled: config?.enabled ?? false,
      configured: resolvedModel !== null,
      autoSelect: config?.autoSelect ?? true,
      preferredTier: config?.preferredTier ?? 'fast',
      model: resolvedModel,
      resolution,
      availableModels: availableModels.map((m: any) => ({
        id: String(m._id),
        displayName: m.displayName,
        provider: m.provider,
        modelId: m.modelId,
        tier: m.tier,
        supportsTools: m.supportsTools,
      })),
      fallback: resolvedModel ? null : 'static',
      warning,
    });
  } catch (error) {
    logger.error('Failed to get query LLM status', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'FETCH_FAILED', message: 'Failed to retrieve query LLM status' },
    });
  }
});

/**
 * PUT /:indexId/query-llm-config - Set query pipeline LLM model for this KB
 *
 * Pin a specific model, enable auto-select, or clear the selection.
 */
router.put('/:indexId/query-llm-config', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const validation = QueryLLMConfigSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid query LLM configuration',
        details: validation.error.errors.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
        })),
      });
      return;
    }

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'INDEX_NOT_FOUND', message: 'Index not found' } });
      return;
    }

    const { enabled, modelId, autoSelect, preferredTier } = validation.data;

    // If pinning a specific model, verify it exists and is active
    if (modelId) {
      const TenantModel = getLazyModel<ITenantModel>('TenantModel');
      const model = await TenantModel.findOne({
        _id: modelId,
        tenantId,
        isActive: true,
      }).lean();
      if (!model) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MODEL_NOT_FOUND',
            message: 'Model not found or not active for this tenant',
          },
        });
        return;
      }
    }

    // Merge with existing config, applying only provided fields
    const existing = (index as any).queryLLMConfig || {
      enabled: false,
      modelId: null,
      autoSelect: true,
      preferredTier: 'fast',
    };
    const updatedConfig = {
      enabled: enabled !== undefined ? enabled : (existing.enabled ?? false),
      modelId: modelId !== undefined ? modelId : existing.modelId,
      autoSelect: autoSelect !== undefined ? autoSelect : existing.autoSelect,
      preferredTier: preferredTier || existing.preferredTier,
    };

    // If user pins a model, turn off auto-select
    if (modelId && autoSelect === undefined) {
      updatedConfig.autoSelect = false;
    }

    const updatedIndex = await SearchIndex.findOneAndUpdate(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
      { $set: { queryLLMConfig: updatedConfig } },
      { new: true, runValidators: true },
    ).lean();

    // Invalidate pipeline + discovery caches on search-ai-runtime so
    // the toggle takes effect immediately (no 2-min stale cache).
    const runtimeUrl =
      process.env.SEARCH_AI_RUNTIME_URL ||
      `http://${process.env.SEARCH_AI_RUNTIME_HOST || 'localhost'}:${process.env.SEARCH_AI_RUNTIME_PORT || '3004'}`;
    fetch(`${runtimeUrl}/api/internal/invalidate-pipeline-cache`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: req.headers.authorization || '',
        'X-Tenant-Id': tenantId,
      },
      body: JSON.stringify({ indexId, tenantId }),
    }).catch((err) => {
      logger.warn('Failed to invalidate pipeline cache on runtime', {
        indexId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    res.json({
      queryLLMConfig: (updatedIndex as any)?.queryLLMConfig,
      message: 'Query pipeline LLM configuration updated',
    });
  } catch (error) {
    logger.error('Failed to update query LLM config', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'UPDATE_FAILED', message: 'Failed to update query LLM configuration' },
    });
  }
});

// ─── Embedding Model Configuration ─────────────────────────────────────────

/**
 * GET /:indexId/embedding-model-status - Get current embedding model status
 *
 * Returns the embedding model configuration and any ongoing migration status.
 */
router.get('/:indexId/embedding-model-status', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'INDEX_NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Determine if provider is self-hosted or cloud
    const selfHostedProviders = ['bge-m3', 'custom'];
    const type = selfHostedProviders.includes(index.embeddingModel) ? 'self-hosted' : 'cloud';

    // Check for ongoing migration status
    // TODO: Query migration status from reindexing orchestrator
    const migrationStatus = undefined;

    res.json({
      provider: index.embeddingModel,
      model: index.embeddingModel,
      dimensions: index.embeddingDimensions,
      type,
      isActive: true,
      migrationStatus,
    });
  } catch (error) {
    logger.error('Failed to get embedding model status', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'FETCH_FAILED', message: 'Failed to retrieve embedding model status' },
    });
  }
});

/**
 * PUT /:indexId/embedding-model-config - Update embedding model
 *
 * Changes the embedding model and triggers re-indexing of all documents.
 * This operation is expensive and should be used carefully.
 */
router.put('/:indexId/embedding-model-config', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    let { provider, model, dimensions, providerConfig } = req.body;

    // Auto-populate providerConfig from credential authConfig for ALL providers.
    // Credentials may store provider-specific settings (e.g., Azure: resourceName,
    // deploymentId, apiVersion). If the UI doesn't send providerConfig, resolve from credential.
    if (!providerConfig || Object.keys(providerConfig).length === 0) {
      try {
        const credentials = await resolveEmbeddingCredentials(provider, tenantId, model);
        if (credentials.authConfig && Object.keys(credentials.authConfig).length > 0) {
          providerConfig = { ...credentials.authConfig };

          // For Azure: ensure deploymentId matches the embedding model, not a chat model
          if (provider === 'azure' && model && providerConfig) {
            const currentDeploymentId = providerConfig.deploymentId as string | undefined;
            if (
              currentDeploymentId &&
              !currentDeploymentId.toLowerCase().includes('embed') &&
              model.toLowerCase().includes('embed')
            ) {
              logger.info('Overriding credential deploymentId with embedding model name', {
                tenantId,
                provider,
                oldDeploymentId: currentDeploymentId,
                newDeploymentId: model,
              });
              providerConfig.deploymentId = model;
            }
          }

          logger.info('Auto-populated providerConfig from credential authConfig', {
            tenantId,
            provider,
            authConfigKeys: Object.keys(credentials.authConfig),
          });
        }
      } catch (credErr) {
        logger.warn('Failed to auto-populate providerConfig from credential', {
          tenantId,
          provider,
          error: credErr instanceof Error ? credErr.message : String(credErr),
        });
      }
    }

    // Validate dimensions for the model
    const dimensionCheck = validateEmbeddingDimensions(model, dimensions);
    if (!dimensionCheck.valid) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_DIMENSIONS',
          message: `Invalid dimensions ${dimensions} for model ${model}. ${dimensionCheck.error}`,
        },
      });
      return;
    }

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'INDEX_NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Check if embedding config actually changed
    const hasChanges = index.embeddingModel !== model || index.embeddingDimensions !== dimensions;

    if (!hasChanges) {
      res.json({
        message: 'Embedding model unchanged',
        requiresReindex: false,
      });
      return;
    }

    // Find the knowledge base and pipeline to update
    const kb = await KnowledgeBase.findOne({ searchIndexId: indexId, tenantId }).lean();
    if (!kb) {
      res.status(404).json({
        success: false,
        error: {
          code: 'KB_NOT_FOUND',
          message: 'Knowledge base not found for this search index',
        },
      });
      return;
    }

    const pipeline = await SearchPipelineDefinition.findOne({
      tenantId,
      knowledgeBaseId: (kb as any)._id,
      status: 'active',
    });

    if (!pipeline) {
      res.status(404).json({
        success: false,
        error: {
          code: 'PIPELINE_NOT_FOUND',
          message: 'Active pipeline not found for this knowledge base',
        },
      });
      return;
    }

    // Update pipeline's activeEmbeddingConfig
    const previousConfig = pipeline.activeEmbeddingConfig
      ? { ...pipeline.activeEmbeddingConfig }
      : null;
    pipeline.activeEmbeddingConfig = {
      provider,
      model,
      dimensions,
      providerConfig: providerConfig || pipeline.activeEmbeddingConfig?.providerConfig || {},
    } as any;

    // Store previous config for publish-time comparison
    if (previousConfig) {
      pipeline.previousVersion = {
        ...(pipeline.previousVersion || {}),
        activeEmbeddingConfig: previousConfig,
      } as any;
    }

    // Sync all flow embedding stages
    const { syncFlowEmbeddingStages } =
      await import('../services/pipeline-orchestration/embedding-sync.js');
    syncFlowEmbeddingStages(pipeline);

    await pipeline.save();

    // Set rebuilding status immediately (fast DB write)
    await SearchIndex.findOneAndUpdate(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
      { $set: { status: 'rebuilding', embeddingModel: model, embeddingDimensions: dimensions } },
    );

    logger.info('Embedding model config saved, firing background migration', {
      indexId,
      tenantId,
      kbId: (kb as any)._id,
      pipelineId: pipeline._id,
      oldModel: index.embeddingModel,
      newModel: model,
      oldDimensions: index.embeddingDimensions,
      newDimensions: dimensions,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // RESPOND IMMEDIATELY — all heavy work (vector index migration, cleanup,
    // re-embedding) happens in background. The UI should not wait for OpenSearch
    // operations or reindexing. Status is already set to 'rebuilding'.
    // ═══════════════════════════════════════════════════════════════════════════
    res.json({
      message: 'Embedding model updated. Re-indexing in progress.',
      requiresReindex: true,
      status: 'rebuilding',
    });

    // ─── Background: vector index migration + cleanup + reindex ──────────────
    const oldPipeline = { ...pipeline.toObject(), activeEmbeddingConfig: previousConfig } as any;
    const newPipeline = pipeline.toObject();

    setImmediate(async () => {
      try {
        // Resolve vector index (may create new OpenSearch index)
        const { resolveVectorIndex, updateVectorIndexPointers } =
          await import('../services/vector-index-migration.js');

        const migration = await resolveVectorIndex({
          tenantId,
          indexId,
          newDimensions: dimensions,
          provider,
          model,
          currentVectorIndex: index.activeVectorIndex ?? undefined,
          currentDimensions: index.embeddingDimensions,
        });

        // Update SearchIndex and IndexRegistry with new vector index
        await updateVectorIndexPointers(SearchIndex, indexId, tenantId, migration, {
          provider,
          model,
          dimensions,
        });

        // Track appCount on shared index trackers
        const SharedIndexTracker = getLazyModel('SharedIndexTracker');
        const isSharedStrategy = migration.strategy === 'shared';
        const targetIndexName = migration.targetVectorIndex;
        const oldVectorIndex = index.activeVectorIndex;

        if (isSharedStrategy) {
          await SharedIndexTracker.findOneAndUpdate(
            { indexName: targetIndexName },
            { $inc: { appCount: 1 } },
          );
        }

        // Clean up old vectors/index when KB moves to a different index
        if (oldVectorIndex && oldVectorIndex !== targetIndexName) {
          const isOldIndexSharedPool = !!oldVectorIndex.match(/^search-vectors-(\d+-)?v\d+$/);

          const { createVectorStore } = await import('@agent-platform/search-ai-internal');
          const vectorStore = createVectorStore({
            provider: 'opensearch',
            url: (process.env.OPENSEARCH_URL || process.env.VECTOR_STORE_URL)!,
            apiKey: process.env.OPENSEARCH_PASSWORD || process.env.VECTOR_STORE_API_KEY,
          });

          if (isOldIndexSharedPool) {
            try {
              await vectorStore.deleteByFilter(oldVectorIndex, [
                { field: 'sys.appId', operator: 'eq', value: indexId },
              ]);
              await SharedIndexTracker.findOneAndUpdate(
                { indexName: oldVectorIndex, appCount: { $gt: 0 } },
                { $inc: { appCount: -1 } },
              );
              logger.info('Deleted KB vectors from old shared pool', {
                oldVectorIndex,
                indexId,
                newIndex: targetIndexName,
              });
            } catch (deleteErr) {
              logger.warn('Failed to delete KB vectors from old shared pool (non-fatal)', {
                oldVectorIndex,
                indexId,
                error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
              });
            }
          } else {
            try {
              await vectorStore.deleteCollection(oldVectorIndex);
              logger.info('Old per-KB vector index deleted', {
                oldVectorIndex,
                newIndex: targetIndexName,
              });
            } catch (deleteErr) {
              logger.warn('Failed to delete old per-KB vector index (non-fatal)', {
                oldVectorIndex,
                error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
              });
            }
          }
        }

        logger.info('Vector index migration complete', {
          indexId,
          tenantId,
          newVectorIndex: migration.targetVectorIndex,
          strategy: migration.strategy,
        });

        // Trigger reindexing via orchestrator
        const orchestrator = getReindexOrchestrator();
        const analyzeResult = await orchestrator.analyze(
          tenantId,
          indexId,
          oldPipeline,
          newPipeline,
        );

        const reindexResult = await orchestrator.execute(
          tenantId,
          (kb as any)._id,
          pipeline._id,
          indexId,
          analyzeResult,
          pipeline.version,
          (pipeline as any).previousVersion?.version ?? pipeline.version - 1,
        );

        logger.info('Re-indexing triggered successfully', {
          indexId,
          tenantId,
          batchId: reindexResult.batchId,
          totalItems: reindexResult.totalItems,
        });
      } catch (bgError) {
        logger.error('Background embedding migration failed', {
          indexId,
          tenantId,
          error: bgError instanceof Error ? bgError.message : String(bgError),
        });
        // Set status to error so UI can show retry
        await SearchIndex.findOneAndUpdate(
          { _id: indexId, tenantId },
          { $set: { status: 'error' } },
        ).catch((statusErr) => {
          logger.error('Failed to set error status after migration failure', {
            indexId,
            error: statusErr instanceof Error ? statusErr.message : String(statusErr),
          });
        });
      }
    });
  } catch (error) {
    logger.error('Failed to update embedding model', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'UPDATE_FAILED', message: 'Failed to update embedding model configuration' },
    });
  }
});

// ─── Citation Configuration ─────────────────────────────────────────────────

const CitationConfigBodySchema = z
  .object({
    enabled: z.boolean(),
    linkMode: z.enum(['direct', 'time_limited', 'click_limited', 'disabled']),
    linkTtlSeconds: z.number().int().min(60).max(604800),
    maxClicks: z.number().int().min(1).max(100),
  })
  .strict();

/**
 * PUT /:indexId/citation-config - Update citation configuration for index
 *
 * Controls how citations appear in search-powered answers: link behavior,
 * time-limited / click-limited expiry, and enable/disable toggle.
 */
router.put('/:indexId/citation-config', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;

    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'TENANT_REQUIRED', message: 'Tenant context required' },
      });
      return;
    }
    const tenantId = req.tenantContext.tenantId;

    const validation = CitationConfigBodySchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: validation.error.errors
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join('; '),
        },
      });
      return;
    }

    const result = await SearchIndex.findOneAndUpdate(
      { _id: indexId, tenantId },
      { $set: { citationConfig: validation.data } },
      { new: true },
    ).lean();

    if (!result) {
      res
        .status(404)
        .json({ success: false, error: { code: 'INDEX_NOT_FOUND', message: 'Index not found' } });
      return;
    }

    res.json({ success: true, data: (result as any).citationConfig });
  } catch (error) {
    logger.error('Failed to update citation config', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'UPDATE_FAILED', message: 'Failed to update citation configuration' },
    });
  }
});

/**
 * DELETE /:indexId - Delete index
 */
router.delete('/:indexId', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();

    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'INDEX_NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Unregister the SearchAI KB tool for this index
    if (index.slug && index.projectId) {
      await unregisterSearchAITool({
        indexId: String(index._id),
        tenantId,
        projectId: index.projectId,
        slug: index.slug,
      });
    }

    await SearchIndex.findOneAndDelete(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    await invalidateRuntimeIndexCaches(String(index._id), tenantId, req.headers.authorization);

    res.json({ deleted: true, indexId });
  } catch (error) {
    logger.error('Failed to delete index', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'DELETE_FAILED', message: 'Failed to delete index' },
    });
  }
});

/**
 * POST /:indexId/rebuild - Trigger index rebuild
 */
router.post('/:indexId/rebuild', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();

    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'INDEX_NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Mark index as rebuilding
    await SearchIndex.findOneAndUpdate(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
      { $set: { status: 'rebuilding', indexError: null } },
    );

    // TODO: Enqueue rebuild job via BullMQ

    res.json({
      message: 'Rebuild initiated',
      indexId,
      status: 'rebuilding',
    });
  } catch (error) {
    logger.error('Failed to trigger rebuild', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'REBUILD_FAILED', message: 'Failed to trigger rebuild' },
    });
  }
});

export default router;
