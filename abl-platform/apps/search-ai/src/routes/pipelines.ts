/**
 * Pipeline Configuration Routes
 *
 * REST API endpoints for pipeline CRUD operations.
 *
 * ## Authentication & Permissions
 *
 * - All routes require authentication (JWT or API key)
 * - Project-level permissions enforced
 * - Tenant isolation on all queries
 *
 * ## Endpoints
 *
 * 1. GET /api/projects/:projectId/knowledge-bases/:kbId/pipelines
 * 2. PATCH /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id
 * 3. POST /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/publish
 * 3b. POST /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/reindex
 * 4. POST /api/projects/:projectId/knowledge-bases/:kbId/pipelines/validate
 * 5. POST /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/test-selection
 * 6. GET /api/projects/:projectId/pipelines/providers/:stageType/schemas
 *
 * Reference: docs/searchai/pipelines/design/frontend/UX-PIPELINE-CONFIGURATION.md
 */

import { Router, type Request, type Response } from 'express';
import { getLazyModel } from '../db/index.js';
import type {
  ISearchPipelineDefinition,
  IKnowledgeBase,
  ISearchIndex,
} from '@agent-platform/database';
import { PipelineValidationService } from '../services/pipeline-validation/index.js';
import { FlowSelectionService } from '../services/flow-selection/index.js';
import { ProviderRegistry } from '../services/provider-registry/index.js';
import { listEmbeddingProviders } from '../services/provider-registry/embedding-providers.js';
import {
  hasEmbeddingCredentials,
  resolveEmbeddingCredentials,
} from '../services/llm-config/embedding-credentials.js';
import { validateEmbeddingConfigAsync } from '../services/pipeline-validation/embedding-validation.js';
import { UpdateEmbeddingConfigSchema } from '../services/pipeline-validation/schemas.js';
import { createLogger } from '@abl/compiler/platform';
import { createReindexOrchestrator } from '../services/reindexing/index.js';
import type { AnalyzeResult } from '../services/reindexing/index.js';
import { syncFlowEmbeddingStages } from '../services/pipeline-orchestration/index.js';
import { canAccessProject } from './project-scope.js';

const logger = createLogger('routes:pipelines');

let _reindexOrchestrator: ReturnType<typeof createReindexOrchestrator> | null = null;
function getReindexOrchestrator() {
  if (!_reindexOrchestrator) {
    _reindexOrchestrator = createReindexOrchestrator();
  }
  return _reindexOrchestrator;
}

const SearchPipelineDefinition = getLazyModel<ISearchPipelineDefinition>(
  'SearchPipelineDefinition',
);
const KnowledgeBase = getLazyModel<IKnowledgeBase>('KnowledgeBase');
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

const router: Router = Router();

const validationService = new PipelineValidationService();
const flowSelectionService = new FlowSelectionService();
const providerRegistry = ProviderRegistry.getInstance();

// ─── Helper Functions ────────────────────────────────────────────────────

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

// ─── Human-Readable Validation Error Messages ──────────────────────────────

/**
 * Convert a machine-readable validation error into a user-friendly message.
 * These messages are shown in the Studio UI when publish fails.
 */
function humanizeValidationError(err: { code: string; message: string; path?: string }): string {
  switch (err.code) {
    case 'INVALID_PROVIDER_CONFIG':
      // Extract provider name from the original message if possible
      return err.message.replace(
        /Invalid configuration for provider '(.+?)'\..*/,
        "The configuration for provider '$1' is invalid. Open the stage settings and check the required fields (e.g., chunk size must be between 50 and 50,000).",
      );

    case 'PROVIDER_NOT_FOUND':
      return err.message.replace(
        /Provider '(.+?)' not found for stage type '(.+?)'/,
        "Provider '$1' is not available for '$2' stages. Select a different provider.",
      );

    case 'INVALID_STAGE_TYPE':
      return err.message;

    case 'INVALID_STAGE_SEQUENCE':
      return `${err.message}. Reorder the stages so extraction comes first, then chunking, then embedding.`;

    case 'NO_FLOWS':
      return 'Pipeline must have at least one processing flow. Add a flow to continue.';

    case 'NO_STAGES':
      return err.message + '. Each flow needs at least one processing stage (e.g., extraction).';

    case 'NO_ENABLED_FLOWS':
      return 'All flows are disabled. Enable at least one flow before publishing.';

    case 'PIPELINE_NO_DEFAULT_FLOW':
      return "Pipeline needs a default flow to handle documents that don't match any rules.";

    case 'PIPELINE_MULTIPLE_DEFAULT_FLOWS':
      return 'Only one flow can be the default. Remove the default flag from extra flows.';

    case 'DEFAULT_FLOW_HAS_RULES':
      return 'The default flow cannot have selection rules — it catches all unmatched documents.';

    case 'DEFAULT_FLOW_DISABLED':
      return 'The default flow cannot be disabled — it would drop unmatched documents.';

    case 'DEFAULT_FLOW_PRIORITY':
      return 'The default flow priority must be 0 — other flows with higher priority are evaluated first.';

    case 'FALLBACK_PROVIDER_SAME_AS_PRIMARY':
      return 'The fallback provider must be different from the primary provider.';

    case 'MISSING_EMBEDDING_CONFIG':
      return 'Pipeline must have an embedding configuration. Set the embedding model in the pipeline settings.';

    case 'EMBEDDING_CONFIG_MISMATCH':
      return err.message;

    case 'DUPLICATE_FLOW_ID':
      return err.message;

    case 'DUPLICATE_STAGE_ID':
      return err.message;

    default:
      return err.message;
  }
}

// ─── GET /api/projects/:projectId/knowledge-bases/:kbId/pipelines ────────

/**
 * Get pipelines for knowledge base.
 *
 * Returns all pipelines for the knowledge base (default + custom).
 * Use ?active=true to get only the active pipeline (backward compat).
 *
 * @permission knowledge-base:read
 * @returns { pipeline: ISearchPipelineDefinition, pipelines: ISearchPipelineDefinition[] }
 */
router.get(
  '/api/projects/:projectId/knowledge-bases/:kbId/pipelines',
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { projectId, kbId } = req.params;
      const activeOnly = req.query.active === 'true';

      logger.info('Getting pipelines for knowledge base', {
        tenantId,
        projectId,
        kbId,
        activeOnly,
      });

      // Verify knowledge base exists
      const kb = await verifyKnowledgeBase(tenantId, projectId, kbId, req.tenantContext);
      if (!kb) {
        res.status(404).json({ error: 'Knowledge base not found' });
        return;
      }

      if (activeOnly) {
        // Return the active pipeline — prefer custom over default
        const pipeline = await SearchPipelineDefinition.findOne(
          { tenantId, knowledgeBaseId: kbId, status: 'active' },
          null,
          { sort: { isDefault: 1 } },
        ).lean();

        res.json({ pipeline: pipeline || null });
        return;
      }

      // Return all pipelines (default + custom, any status)
      const pipelines = await SearchPipelineDefinition.find({
        tenantId,
        knowledgeBaseId: kbId,
        status: { $ne: 'archived' },
      })
        .sort({ isDefault: -1, updatedAt: -1 })
        .lean();

      // Also identify which is active for backward compat
      const activePipeline = pipelines.find((p) => p.status === 'active') || null;

      res.json({
        pipeline: activePipeline,
        pipelines,
      });
    } catch (error) {
      logger.error('Failed to get pipelines', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to get pipelines' });
    }
  },
);

// ─── POST /api/projects/:projectId/knowledge-bases/:kbId/pipelines ───────

/**
 * Create a new pipeline for knowledge base.
 *
 * Creates the default pipeline if none exists.
 *
 * @permission knowledge-base:update
 * @returns { pipeline: ISearchPipelineDefinition }
 */
router.post(
  '/api/projects/:projectId/knowledge-bases/:kbId/pipelines',
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { projectId, kbId } = req.params;
      const userId = req.user?.id || 'system';

      logger.info('Creating pipeline for knowledge base', {
        tenantId,
        projectId,
        kbId,
        userId,
      });

      // Verify knowledge base exists
      const kb = await verifyKnowledgeBase(tenantId, projectId, kbId, req.tenantContext);
      if (!kb) {
        res.status(404).json({ error: 'Knowledge base not found' });
        return;
      }

      const { name, description } = req.body || {};

      // If caller provides a name, create a custom pipeline
      // If no name, create the system default pipeline
      const isCustom = !!name;

      if (!isCustom) {
        // Check if default pipeline already exists
        const existingDefault = await SearchPipelineDefinition.findOne({
          tenantId,
          knowledgeBaseId: kbId,
          isDefault: true,
        }).lean();

        if (existingDefault) {
          res
            .status(409)
            .json({ error: 'Default pipeline already exists for this knowledge base' });
          return;
        }
      } else {
        // Check if pipeline with same name exists
        const existingNamed = await SearchPipelineDefinition.findOne({
          tenantId,
          knowledgeBaseId: kbId,
          name,
        }).lean();

        if (existingNamed) {
          res
            .status(409)
            .json({ error: `Pipeline '${name}' already exists for this knowledge base` });
          return;
        }
      }

      let pipeline;

      if (isCustom) {
        // Create custom pipeline with same structure as default but user-given name
        const { createDefaultPipeline } =
          await import('../services/pipeline-orchestration/index.js');
        const templateData = createDefaultPipeline(tenantId, kbId, userId);
        pipeline = await SearchPipelineDefinition.create({
          ...templateData,
          name,
          description: description || '',
          isDefault: false,
          status: 'draft',
        });
      } else {
        // Create default pipeline
        const { createDefaultPipeline } =
          await import('../services/pipeline-orchestration/index.js');
        const pipelineData = createDefaultPipeline(tenantId, kbId, userId);
        pipeline = await SearchPipelineDefinition.create(pipelineData);
      }

      logger.info('Pipeline created', {
        pipelineId: pipeline._id,
        kbId,
      });

      res.status(201).json({
        pipeline: pipeline.toObject(),
      });
    } catch (error) {
      logger.error('Failed to create pipeline', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({
        error: 'Failed to create pipeline',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

// ─── PATCH /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id ──

/**
 * Update pipeline definition.
 *
 * Updates the pipeline and runs validation.
 * Increments version number on save.
 *
 * @permission knowledge-base:update
 * @returns { success: true, pipeline: ISearchPipelineDefinition, validation: ValidationResult }
 */
router.patch(
  '/api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id',
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { projectId, kbId, id } = req.params;
      const updates = req.body;

      logger.info('Updating pipeline', {
        tenantId,
        projectId,
        kbId,
        pipelineId: id,
      });

      // Verify knowledge base exists
      const kb = await verifyKnowledgeBase(tenantId, projectId, kbId, req.tenantContext);
      if (!kb) {
        res.status(404).json({ error: 'Knowledge base not found' });
        return;
      }

      // Get existing pipeline
      const existing = await SearchPipelineDefinition.findOne({
        _id: id,
        tenantId,
        knowledgeBaseId: kbId,
      });

      if (!existing) {
        res.status(404).json({ error: 'Pipeline not found' });
        return;
      }

      // Guard: prevent removing the default flow
      if (updates.flows) {
        const existingDefault = existing.flows.find((f: any) => f.isDefault);
        const updatedDefault = updates.flows.find((f: any) => f.isDefault);

        if (existingDefault && !updatedDefault) {
          res.status(400).json({
            success: false,
            error: {
              code: 'CANNOT_DELETE_DEFAULT_FLOW',
              message: 'The default flow cannot be deleted. It can only be customized.',
            },
          });
          return;
        }
      }

      // Guard: protect default pipeline from stage removal
      if ((existing as any).isDefault && updates.flows) {
        for (const updatedFlow of updates.flows) {
          const existingFlow = existing.flows.find((f: any) => f.id === updatedFlow.id);
          if (!existingFlow) continue;

          // Check that no existing stages were removed from the default pipeline
          const existingStageIds = new Set(existingFlow.stages.map((s: any) => s.id));
          const updatedStageIds = new Set((updatedFlow.stages || []).map((s: any) => s.id));

          for (const existingId of existingStageIds) {
            if (!updatedStageIds.has(existingId)) {
              res.status(400).json({
                success: false,
                error: {
                  code: 'CANNOT_REMOVE_DEFAULT_STAGE',
                  message:
                    'Stages cannot be removed from the default pipeline. Create a custom pipeline for full control.',
                },
              });
              return;
            }
          }
        }
      }

      // Guard: prevent changing isDefault flag
      if (updates.isDefault !== undefined && updates.isDefault !== (existing as any).isDefault) {
        res.status(400).json({
          success: false,
          error: {
            code: 'CANNOT_CHANGE_DEFAULT_FLAG',
            message: 'The isDefault flag cannot be changed after creation.',
          },
        });
        return;
      }

      // Apply updates
      Object.assign(existing, updates);

      // Validate before saving
      const validation = await validationService.validate(existing);

      // Save (even if validation has errors - user can fix and re-save)
      existing.validationStatus = validation.valid ? 'valid' : 'invalid';
      existing.validationErrors = validation.errors.map((e) => ({
        code: e.code,
        message: e.message,
        severity: e.severity,
        path: e.path || '',
      }));
      existing.lastValidatedAt = new Date();

      await existing.save();

      logger.info('Pipeline updated', {
        pipelineId: id,
        valid: validation.valid,
        errorCount: validation.summary.errorCount,
      });

      res.json({
        success: true,
        pipeline: existing.toObject(),
        validation,
      });
    } catch (error) {
      logger.error('Failed to update pipeline', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to update pipeline' });
    }
  },
);

// ─── DELETE /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id ─────

/**
 * Delete a custom pipeline.
 *
 * The default pipeline CANNOT be deleted. If the deleted pipeline was active,
 * the default pipeline is automatically activated as fallback.
 *
 * @permission knowledge-base:update
 * @returns { success: true }
 */
router.delete(
  '/api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id',
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { projectId, kbId, id } = req.params;

      logger.info('Deleting pipeline', { tenantId, projectId, kbId, pipelineId: id });

      const kb = await verifyKnowledgeBase(tenantId, projectId, kbId, req.tenantContext);
      if (!kb) {
        res.status(404).json({ error: 'Knowledge base not found' });
        return;
      }

      const pipeline = await SearchPipelineDefinition.findOne({
        _id: id,
        tenantId,
        knowledgeBaseId: kbId,
      });

      if (!pipeline) {
        res.status(404).json({ error: 'Pipeline not found' });
        return;
      }

      // Prevent deleting the default pipeline
      if ((pipeline as any).isDefault) {
        res.status(400).json({
          success: false,
          error: {
            code: 'CANNOT_DELETE_DEFAULT_PIPELINE',
            message:
              'The default pipeline cannot be deleted. It serves as a fallback for all document processing.',
          },
        });
        return;
      }

      const wasActive = pipeline.status === 'active';

      // Delete the pipeline
      await SearchPipelineDefinition.deleteOne({ _id: id, tenantId });

      // If deleted pipeline was active, activate the default pipeline as fallback
      if (wasActive) {
        const defaultPipeline = await SearchPipelineDefinition.findOne({
          tenantId,
          knowledgeBaseId: kbId,
          isDefault: true,
        });

        if (defaultPipeline) {
          defaultPipeline.status = 'active';
          await defaultPipeline.save();

          logger.info('Activated default pipeline as fallback', {
            defaultPipelineId: defaultPipeline._id,
            kbId,
          });
        }
      }

      logger.info('Pipeline deleted', { pipelineId: id, fallbackActivated: wasActive });

      res.json({
        success: true,
        fallbackActivated: wasActive,
      });
    } catch (error) {
      logger.error('Failed to delete pipeline', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to delete pipeline' });
    }
  },
);

// ─── GET /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/fallback-status

/**
 * Check if a pipeline is valid or needs to fall back to default.
 *
 * @permission knowledge-base:read
 * @returns { valid: boolean, fallbackPipelineId?: string, reason?: string }
 */
router.get(
  '/api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/fallback-status',
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { projectId, kbId, id } = req.params;

      const kb = await verifyKnowledgeBase(tenantId, projectId, kbId, req.tenantContext);
      if (!kb) {
        res.status(404).json({ error: 'Knowledge base not found' });
        return;
      }

      const pipeline = await SearchPipelineDefinition.findOne({
        _id: id,
        tenantId,
        knowledgeBaseId: kbId,
      });

      if (!pipeline) {
        res.status(404).json({ error: 'Pipeline not found' });
        return;
      }

      // Run validation
      const validation = await validationService.validate(pipeline);

      if (validation.valid) {
        res.json({ valid: true });
        return;
      }

      // Pipeline is invalid — find default fallback
      const defaultPipeline = await SearchPipelineDefinition.findOne({
        tenantId,
        knowledgeBaseId: kbId,
        isDefault: true,
      }).lean();

      res.json({
        valid: false,
        fallbackPipelineId: defaultPipeline?._id || null,
        fallbackPipelineName: defaultPipeline?.name || null,
        reason: `Pipeline has ${validation.summary.errorCount} validation error(s). The default pipeline will be used as fallback.`,
        errors: validation.errors.filter((e) => e.severity === 'error'),
      });
    } catch (error) {
      logger.error('Failed to check fallback status', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to check fallback status' });
    }
  },
);

// ─── POST /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/publish

/**
 * Publish pipeline.
 *
 * Activates the pipeline for use in ingestion.
 *
 * @permission knowledge-base:update
 * @returns { success: true, pipeline: ISearchPipelineDefinition }
 */
router.post(
  '/api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/publish',
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { projectId, kbId, id } = req.params;
      const userId = req.user?.id || 'system';

      logger.info('Publishing pipeline', {
        tenantId,
        projectId,
        kbId,
        pipelineId: id,
        userId,
      });

      // Verify knowledge base exists
      const kb = await verifyKnowledgeBase(tenantId, projectId, kbId, req.tenantContext);
      if (!kb) {
        res.status(404).json({ error: 'Knowledge base not found' });
        return;
      }

      // Get pipeline
      const pipeline = await SearchPipelineDefinition.findOne({
        _id: id,
        tenantId,
        knowledgeBaseId: kbId,
      });

      if (!pipeline) {
        res.status(404).json({ error: 'Pipeline not found' });
        return;
      }

      // Validate before publishing
      const validation = await validationService.validate(pipeline);
      if (!validation.valid) {
        // Build user-friendly error messages from validation errors
        const criticalErrors = validation.errors.filter((e) => e.severity === 'error');
        const errorMessages = criticalErrors.map((e) => humanizeValidationError(e));

        res.status(400).json({
          error: {
            code: 'PIPELINE_VALIDATION_FAILED',
            message:
              criticalErrors.length === 1
                ? errorMessages[0]
                : `Pipeline has ${criticalErrors.length} validation error(s) that must be fixed before publishing.`,
          },
          errors: criticalErrors.map((e) => ({
            msg: humanizeValidationError(e),
            code: e.code,
          })),
          validation,
        });
        return;
      }

      // Capture previous state for reindex comparison
      // Only look for OTHER active pipelines (not this one) to avoid comparing
      // the in-memory modified pipeline against itself
      const previousActivePipeline = await SearchPipelineDefinition.findOne({
        tenantId,
        knowledgeBaseId: kbId,
        status: 'active',
        _id: { $ne: id },
      }).lean();

      // Snapshot previous pipeline for future diffing
      // IMPORTANT: Preserve previousVersion.activeEmbeddingConfig if it was set by PATCH /embedding-config
      if (previousActivePipeline) {
        const preservedEmbeddingConfig = pipeline.previousVersion?.activeEmbeddingConfig;
        pipeline.previousVersion = previousActivePipeline as unknown as Record<string, unknown>;
        // Restore the preserved embedding config if it existed
        if (preservedEmbeddingConfig) {
          pipeline.previousVersion = {
            ...pipeline.previousVersion,
            activeEmbeddingConfig: preservedEmbeddingConfig,
          };
        }
      }

      // Deactivate other active pipelines for this KB (except the default — it stays as fallback)
      await SearchPipelineDefinition.updateMany(
        {
          tenantId,
          knowledgeBaseId: kbId,
          status: 'active',
          _id: { $ne: id },
          isDefault: { $ne: true },
        },
        {
          $set: { status: 'archived' },
        },
      );

      // Publish pipeline with optimistic concurrency control
      const currentVersion = pipeline.version;
      pipeline.status = 'active';
      pipeline.lastDeployedAt = new Date();
      pipeline.version = currentVersion + 1;

      const saved = await SearchPipelineDefinition.findOneAndUpdate(
        { _id: id, tenantId, version: currentVersion },
        {
          $set: {
            status: pipeline.status,
            lastDeployedAt: pipeline.lastDeployedAt,
            version: pipeline.version,
            previousVersion: pipeline.previousVersion,
          },
        },
        { new: true },
      );

      if (!saved) {
        res.status(409).json({
          error: 'Pipeline was modified concurrently. Please reload and try again.',
        });
        return;
      }

      logger.info('Pipeline published', {
        pipelineId: id,
        version: pipeline.version,
      });

      // Analyze reindex impact if there was a previous active pipeline
      const publishedPipeline = saved.toObject ? saved.toObject() : saved;
      let reindexAnalysis: AnalyzeResult | null = null;
      let reindexResult: any = null;

      // Check if we need to analyze reindex impact
      const needsReindexAnalysis =
        previousActivePipeline || publishedPipeline.previousVersion?.activeEmbeddingConfig;

      if (needsReindexAnalysis) {
        try {
          const kb = await KnowledgeBase.findOne({ _id: kbId, tenantId }).lean();
          const indexId = kb?.searchIndexId;
          if (indexId) {
            // If embedding was changed, use stored previous config for comparison
            // This takes precedence over previousActivePipeline to correctly detect embedding changes
            let comparisonPipeline = previousActivePipeline;
            if (publishedPipeline.previousVersion?.activeEmbeddingConfig) {
              // Construct a comparison pipeline with old embedding config
              // Use previousActivePipeline as base if it exists, otherwise use published pipeline
              comparisonPipeline = {
                ...(previousActivePipeline || publishedPipeline),
                activeEmbeddingConfig: publishedPipeline.previousVersion
                  .activeEmbeddingConfig as any,
              } as typeof comparisonPipeline;
            }

            if (comparisonPipeline) {
              // Ensure comparison pipeline has flows (previousVersion snapshots may omit them)
              const safeComparisonPipeline = {
                ...comparisonPipeline,
                flows: (comparisonPipeline as any).flows ?? publishedPipeline.flows,
              } as ISearchPipelineDefinition;
              reindexAnalysis = await getReindexOrchestrator().analyze(
                tenantId,
                indexId,
                safeComparisonPipeline,
                publishedPipeline as ISearchPipelineDefinition,
              );
            }

            // Check if we need to create/update vector index
            const previousDims = (comparisonPipeline as any)?.activeEmbeddingConfig?.dimensions;
            const newDims = (publishedPipeline as any).activeEmbeddingConfig?.dimensions;
            const dimensionsChanged = previousDims && newDims && previousDims !== newDims;

            // Auto-trigger reindexing if embedding model changed
            if (reindexAnalysis?.hasChanges && reindexAnalysis.changeSet.embeddingChanged) {
              logger.info('Embedding model changed, auto-triggering reindex', {
                pipelineId: id,
                previousEmbedding: (comparisonPipeline as any)?.activeEmbeddingConfig,
                newEmbedding: (publishedPipeline as any).activeEmbeddingConfig,
              });

              // Resolve vector index for the target dimensions.
              // Standard dimensions (used by known providers) → shared pool: search-vectors-{dims}-v{N}
              // Custom provider with non-standard dimensions → per-app: search-{tenantId}-{indexId}
              //
              // Why: kNN pre-filters by indexId, so different models at the same dimension
              // never cross-pollinate. Custom providers at standard dims (1024, 1536, 2048, 3072)
              // safely share the pool. Only truly exotic dimensions need a dedicated index.
              try {
                // Get the old index name BEFORE updating pointers
                const existingSearchIndex = await SearchIndex.findOne({
                  _id: indexId,
                  tenantId,
                }).lean();
                const oldVectorIndex = (existingSearchIndex as any)?.activeVectorIndex as
                  | string
                  | undefined;

                // Use shared vector index migration service
                const { resolveVectorIndex, updateVectorIndexPointers } =
                  await import('../services/vector-index-migration.js');

                const embeddingProvider = (publishedPipeline as any).activeEmbeddingConfig
                  ?.provider as string | undefined;
                const embeddingModel = (publishedPipeline as any).activeEmbeddingConfig?.model as
                  | string
                  | undefined;

                const migration = await resolveVectorIndex({
                  tenantId,
                  indexId,
                  newDimensions: newDims,
                  provider: embeddingProvider || 'bge-m3',
                  model: embeddingModel || 'bge-m3',
                  currentVectorIndex: oldVectorIndex,
                  currentDimensions: previousDims,
                });

                await updateVectorIndexPointers(SearchIndex, indexId, tenantId, migration, {
                  provider: embeddingProvider || 'bge-m3',
                  model: embeddingModel || 'bge-m3',
                  dimensions: newDims,
                });

                logger.info('Index pointers updated via shared service', {
                  indexId,
                  targetIndexName: migration.targetVectorIndex,
                  strategy: migration.strategy,
                  dimensionsChanged: migration.dimensionsChanged,
                });

                // Track appCount on shared index trackers for accurate capacity management
                // Only for shared pool indexes — per-app indexes don't use SharedIndexTracker
                const SharedIndexTracker = getLazyModel('SharedIndexTracker');
                const isSharedStrategy = migration.strategy === 'shared';
                const targetIndexName = migration.targetVectorIndex;

                if (isSharedStrategy) {
                  await SharedIndexTracker.findOneAndUpdate(
                    { indexName: targetIndexName },
                    { $inc: { appCount: 1 } },
                  );
                }

                // Clean up old vectors/index when KB moves to a different index
                if (oldVectorIndex && oldVectorIndex !== targetIndexName) {
                  const isOldIndexSharedPool = !!oldVectorIndex.match(
                    /^search-vectors-(\d+-)?v\d+$/,
                  );

                  // Create vectorStore for cleanup operations
                  const { createVectorStore } = await import('@agent-platform/search-ai-internal');
                  const vectorStore = createVectorStore({
                    provider: 'opensearch',
                    url: (process.env.OPENSEARCH_URL || process.env.VECTOR_STORE_URL)!,
                    apiKey: process.env.OPENSEARCH_PASSWORD || process.env.VECTOR_STORE_API_KEY,
                  });

                  if (isOldIndexSharedPool) {
                    // Old index is a shared pool — delete only THIS KB's vectors (not the index)
                    // Other KBs may still have vectors in this pool
                    try {
                      await vectorStore.deleteByFilter(oldVectorIndex, [
                        { field: 'sys.appId', operator: 'eq', value: indexId },
                      ]);
                      // Decrement appCount on old shared pool (this KB is leaving it)
                      // Guard: never go below 0
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
                    // Old index is a per-KB index — delete the entire index
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
              } catch (indexError) {
                logger.error('Failed to resolve shared index for embedding change', {
                  error: indexError instanceof Error ? indexError.message : String(indexError),
                  previousDims,
                  newDims,
                });
                // Don't throw - let reindex attempt anyway
              }

              // Invalidate runtime embedding cache so queries use new config immediately
              // This runs regardless of shared index resolution success — any embedding change
              // needs cache invalidation so runtime picks up the new model/dimensions
              try {
                const runtimeUrl = process.env.SEARCH_AI_RUNTIME_URL || 'http://localhost:3004';
                await fetch(`${runtimeUrl}/api/internal/invalidate-embedding-cache`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ indexId, tenantId }),
                  signal: AbortSignal.timeout(5000),
                });
                logger.info('Runtime embedding cache invalidated', { indexId, tenantId });
              } catch (cacheErr) {
                logger.warn('Failed to invalidate runtime cache (non-fatal)', {
                  error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
                });
              }

              try {
                reindexResult = await getReindexOrchestrator().execute(
                  tenantId,
                  kbId,
                  id,
                  indexId,
                  reindexAnalysis,
                  publishedPipeline.version,
                  (comparisonPipeline as any)?.version ?? publishedPipeline.version - 1,
                );

                logger.info('Auto-reindex triggered successfully', {
                  pipelineId: id,
                  batchId: reindexResult.batchId,
                  totalItems: reindexResult.totalItems,
                });
              } catch (reindexError) {
                logger.error('Auto-reindex failed (non-blocking)', {
                  error:
                    reindexError instanceof Error ? reindexError.message : String(reindexError),
                  pipelineId: id,
                });
              }
            }
          }
        } catch (analyzeError) {
          logger.error('Reindex analysis failed (non-blocking)', {
            error: analyzeError instanceof Error ? analyzeError.message : String(analyzeError),
            pipelineId: id,
          });
        }
      }

      res.json({
        success: true,
        pipeline: publishedPipeline,
        reindex: reindexAnalysis
          ? {
              hasChanges: reindexAnalysis.hasChanges,
              summary: reindexAnalysis.plan.summary,
              changeSet: {
                embeddingChanged: reindexAnalysis.changeSet.embeddingChanged,
                routingChanged: reindexAnalysis.changeSet.routingChanged,
                preChunkChanges: reindexAnalysis.changeSet.preChunkChanges.length,
                postChunkChanges: reindexAnalysis.changeSet.postChunkChanges.length,
              },
              autoTriggered: reindexAnalysis.changeSet.embeddingChanged,
              batchId: reindexResult?.batchId,
              totalItems: reindexResult?.totalItems,
            }
          : null,
      });
    } catch (error) {
      logger.error('Failed to publish pipeline', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to publish pipeline' });
    }
  },
);

// ─── POST /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/reindex

/**
 * Trigger reindexing for a published pipeline.
 *
 * Called by the frontend after user confirms the reindex dialog.
 * Requires the pipeline to be active and have a previousVersion snapshot.
 *
 * @permission knowledge-base:update
 * @returns { success: true, batchId: string, summary: ReindexSummary }
 */
router.post(
  '/api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/reindex',
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { projectId, kbId, id } = req.params;

      logger.info('Reindex requested', { tenantId, projectId, kbId, pipelineId: id });

      const kb = await verifyKnowledgeBase(tenantId, projectId, kbId, req.tenantContext);
      if (!kb) {
        res.status(404).json({ error: 'Knowledge base not found' });
        return;
      }

      const indexId = kb.searchIndexId;
      if (!indexId) {
        res.status(400).json({ error: 'Knowledge base has no search index' });
        return;
      }

      const pipeline = await SearchPipelineDefinition.findOne({
        _id: id,
        tenantId,
        knowledgeBaseId: kbId,
        status: 'active',
      }).lean();

      if (!pipeline) {
        res.status(404).json({ error: 'Active pipeline not found' });
        return;
      }

      if (!pipeline.previousVersion) {
        res.status(400).json({ error: 'No previous pipeline version to compare against' });
        return;
      }

      // previousVersion may not have flows (snapshot only stores embedding config)
      // Fill in flows from current pipeline so stage diff returns empty (no false changes)
      const previousPipeline = {
        ...pipeline.previousVersion,
        flows: (pipeline.previousVersion as any)?.flows ?? pipeline.flows,
      } as unknown as ISearchPipelineDefinition;

      const analysis = await getReindexOrchestrator().analyze(
        tenantId,
        indexId,
        previousPipeline,
        pipeline as ISearchPipelineDefinition,
      );

      if (!analysis.hasChanges) {
        res.json({ success: true, message: 'No changes require reindexing' });
        return;
      }

      const result = await getReindexOrchestrator().execute(
        tenantId,
        kbId,
        id,
        indexId,
        analysis,
        pipeline.version,
        previousPipeline.version ?? 0,
      );

      logger.info('Reindex triggered', {
        pipelineId: id,
        batchId: result.batchId,
        totalItems: result.totalItems,
      });

      res.json({
        success: true,
        batchId: result.batchId,
        totalItems: result.totalItems,
        summary: result.summary,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : undefined;
      logger.error('Failed to trigger reindex', {
        error: errMsg,
        stack: errStack,
      });
      res.status(500).json({ error: 'Failed to trigger reindex', detail: errMsg });
    }
  },
);

// ─── POST /api/projects/:projectId/knowledge-bases/:kbId/pipelines/validate

/**
 * Validate pipeline without saving.
 *
 * Used by UI to show validation errors in real-time.
 *
 * @permission knowledge-base:read
 * @returns { valid: boolean, errors: ValidationError[], summary: ValidationSummary }
 */
router.post(
  '/api/projects/:projectId/knowledge-bases/:kbId/pipelines/validate',
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { projectId, kbId } = req.params;
      const pipelineData = req.body;

      logger.info('Validating pipeline', {
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

      // Create temporary pipeline document (not saved to DB)
      const tempPipeline = {
        ...pipelineData,
        tenantId,
        knowledgeBaseId: kbId,
      } as ISearchPipelineDefinition;

      // Validate
      const validation = await validationService.validate(tempPipeline);

      logger.info('Pipeline validation completed', {
        valid: validation.valid,
        errorCount: validation.summary.errorCount,
        warningCount: validation.summary.warningCount,
      });

      res.json(validation);
    } catch (error) {
      logger.error('Failed to validate pipeline', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({
        error: 'Failed to validate pipeline',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

// ─── POST /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/test-selection

/**
 * Test flow selection with sample document.
 *
 * Used by UI to preview which flow would be selected for a given document.
 *
 * @permission knowledge-base:read
 * @returns { success: true, selectedFlow: ISearchPipelineFlow, matchedRules?: ISearchRuleCondition[] }
 */
router.post(
  '/api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/test-selection',
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { projectId, kbId, id } = req.params;
      const { document, source } = req.body;

      if (!document) {
        res.status(400).json({ error: 'document field is required' });
        return;
      }

      logger.info('Testing flow selection', {
        tenantId,
        projectId,
        kbId,
        pipelineId: id,
      });

      // Verify knowledge base exists
      const kb = await verifyKnowledgeBase(tenantId, projectId, kbId, req.tenantContext);
      if (!kb) {
        res.status(404).json({ error: 'Knowledge base not found' });
        return;
      }

      // Get pipeline
      const pipeline = await SearchPipelineDefinition.findOne({
        _id: id,
        tenantId,
        knowledgeBaseId: kbId,
      }).lean();

      if (!pipeline) {
        res.status(404).json({ error: 'Pipeline not found' });
        return;
      }

      // Test flow selection
      const context = {
        document: {
          extension: document.extension || '',
          mimeType: document.mimeType || '',
          size: document.size || 0,
          name: document.name || '',
          language: document.language,
        },
        source: source || { connector: 'unknown' },
      };

      const selectionResult = await flowSelectionService.selectFlow(pipeline.flows, context);

      if (!selectionResult.success) {
        res.json({
          success: false,
          error: selectionResult.error,
          details: selectionResult.details,
        });
        return;
      }

      logger.info('Flow selection test completed', {
        pipelineId: id,
        selectedFlowId: selectionResult.flow?.id,
      });

      res.json({
        success: true,
        selectedFlow: selectionResult.flow,
        details: selectionResult.details,
      });
    } catch (error) {
      logger.error('Failed to test flow selection', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to test flow selection' });
    }
  },
);

// ─── GET /api/projects/:projectId/pipelines/providers/:stageType/schemas ─

/**
 * Get provider schemas for a stage type.
 *
 * Returns available providers and their JSON schemas for configuration.
 *
 * @permission project:read
 * @returns { providers: ProviderInfo[], schemas: Record<string, JSONSchema> }
 */
router.get(
  '/api/projects/:projectId/pipelines/providers/:stageType/schemas',
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const { stageType } = req.params;

      logger.info('Getting provider schemas', {
        stageType,
      });

      // Get all providers for stage type
      const providers = providerRegistry.listByStageType(stageType as any);

      if (providers.length === 0) {
        res.json({
          providers: [],
          schemas: {},
        });
        return;
      }

      // Build provider info and schemas
      const providerInfo = providers.map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        description: p.description || '',
      }));

      const schemas: Record<string, any> = {};
      for (const provider of providers) {
        schemas[provider.id] = provider.schema;
      }

      logger.info('Provider schemas retrieved', {
        stageType,
        providerCount: providers.length,
      });

      res.json({
        providers: providerInfo,
        schemas,
      });
    } catch (error) {
      logger.error('Failed to get provider schemas', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to get provider schemas' });
    }
  },
);

// ─── GET /api/projects/:projectId/pipelines/providers/embedding ───────────

/**
 * Get available embedding providers.
 *
 * Returns embedding providers with their models, dimensions, costs,
 * and credential availability for the current tenant.
 *
 * @permission project:read
 * @returns { providers: EmbeddingProviderInfo[] }
 */
router.get(
  '/api/projects/:projectId/pipelines/providers/embedding',
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Tenant context required' },
        });
        return;
      }

      const tenantId = req.tenantContext.tenantId;

      logger.info('Getting embedding providers', { tenantId });

      const providers = listEmbeddingProviders();

      // Check credential availability for each provider
      const providersWithCredentials = await Promise.all(
        providers.map(async (provider) => ({
          ...provider,
          hasCredentials: await hasEmbeddingCredentials(provider.id, tenantId),
        })),
      );

      // Merge tenant's embedding-capable models from workspace catalog
      // Dynamic detection: match by capabilities OR modelId pattern (no manual tagging needed)
      const TenantModel = getLazyModel('TenantModel');
      const tenantEmbeddingModels = await TenantModel.find({
        tenantId,
        isActive: true,
        $or: [
          { capabilities: 'embedding' },
          { modelId: { $regex: /embed/i } },
          { tier: 'embedding' },
        ],
      }).lean();

      const KNOWN_DIMENSIONS: Record<string, number[]> = {
        'text-embedding-3-small': [512, 1536],
        'text-embedding-3-large': [256, 1024, 3072],
        'text-embedding-ada-002': [1536],
        'azure/text-embedding-3-small': [512, 1536],
        'azure/text-embedding-3-large': [256, 1024, 3072],
        'azure/text-embedding-ada-002': [1536],
        'embed-english-v3.0': [1024],
        'embed-multilingual-v3.0': [1024],
        'embed-english-light-v3.0': [384],
        'text-embedding-004': [256, 768],
        'text-multilingual-embedding-002': [256, 768],
      };
      const KNOWN_DEFAULTS: Record<string, number> = {
        'text-embedding-3-small': 1536,
        'text-embedding-3-large': 3072,
        'text-embedding-ada-002': 1536,
        'azure/text-embedding-3-small': 1536,
        'azure/text-embedding-3-large': 3072,
        'azure/text-embedding-ada-002': 1536,
        'embed-english-v3.0': 1024,
        'embed-multilingual-v3.0': 1024,
        'embed-english-light-v3.0': 384,
        'text-embedding-004': 768,
        'text-multilingual-embedding-002': 768,
      };

      const tenantProviders = tenantEmbeddingModels.map((model: any) => {
        // Custom/self-hosted models don't need credentials
        const isCustomOrSelfHosted = model.provider === 'custom' || !!model.endpointUrl;
        return {
          id: `tenant:${model._id}`,
          name: model.displayName,
          description: `From workspace models (${model.provider})`,
          selfHosted: isCustomOrSelfHosted,
          requiresCredentials: !isCustomOrSelfHosted,
          hasCredentials:
            (model.connections || []).some((c: any) => c.isPrimary && c.isActive) ||
            isCustomOrSelfHosted,
          models: [
            {
              id: model.modelId,
              name: model.displayName,
              dimensions: KNOWN_DIMENSIONS[model.modelId] || [model.embeddingDimensions || 1024],
              defaultDimensions: KNOWN_DEFAULTS[model.modelId] || model.embeddingDimensions || 1024,
              costPer1MTokens: isCustomOrSelfHosted ? 0 : 0.02,
              maxBatchSize: 100,
              maxInputTokens: 8191,
            },
          ],
          tenantModelId: String(model._id),
          provider: model.provider,
        };
      });

      const allProviders = [...providersWithCredentials, ...tenantProviders];

      res.json({
        success: true,
        data: { providers: allProviders },
      });
    } catch (error) {
      logger.error('Failed to get embedding providers', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get embedding providers' },
      });
    }
  },
);

// ─── PATCH /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/embedding-config

/**
 * Update embedding configuration for a pipeline.
 *
 * Requires `confirm: true` in request body. Changes the active embedding
 * config and triggers reindexing. All flow embedding stages are updated
 * to match the new config. SearchIndex is synced for backward compat.
 *
 * @permission knowledge-base:update
 * @returns { success: true, data: { previousConfig, newConfig, reindexing } }
 */
router.patch(
  '/api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/embedding-config',
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Tenant context required' },
        });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { projectId, kbId, id } = req.params;

      // Validate request body
      const parseResult = UpdateEmbeddingConfigSchema.safeParse(req.body);
      if (!parseResult.success) {
        // Check if it's just missing confirm
        const hasConfirmError = parseResult.error.issues.some((i) => i.path.includes('confirm'));

        if (hasConfirmError) {
          // Return CONFIRMATION_REQUIRED with details
          const pipeline = await SearchPipelineDefinition.findOne({
            _id: id,
            tenantId,
            knowledgeBaseId: kbId,
          }).lean();

          const documentCount = pipeline ? await getDocumentCount(tenantId, kbId) : 0;

          res.status(400).json({
            success: false,
            error: {
              code: 'CONFIRMATION_REQUIRED',
              message: `Changing embedding config requires reindexing ${documentCount.toLocaleString()} documents. Set confirm: true to proceed.`,
              details: {
                documentCount,
              },
            },
          });
          return;
        }

        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parseResult.error.issues.map((i) => i.message).join('; '),
          },
        });
        return;
      }

      const { provider, model, dimensions, providerConfig } = parseResult.data;

      logger.info('Updating embedding config', {
        tenantId,
        projectId,
        kbId,
        pipelineId: id,
        provider,
        model,
        dimensions,
      });

      // Verify KB exists
      const kb = await verifyKnowledgeBase(tenantId, projectId, kbId, req.tenantContext);
      if (!kb) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Knowledge base not found' },
        });
        return;
      }

      // Get pipeline
      const pipeline = await SearchPipelineDefinition.findOne({
        _id: id,
        tenantId,
        knowledgeBaseId: kbId,
      });

      if (!pipeline) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Pipeline not found' } });
        return;
      }

      // Auto-populate providerConfig from credential authConfig for ALL providers.
      // Credentials may store provider-specific settings (e.g., Azure: resourceName,
      // deploymentId, apiVersion; future providers: custom headers, endpoints, etc.).
      // If the UI doesn't send providerConfig, resolve it from the credential's authConfig.
      //
      // IMPORTANT: For Azure, the credential's authConfig.deploymentId may belong to a
      // chat model (e.g. "gpt-5.4-mini"), NOT an embedding model. We MUST override
      // deploymentId with the embedding model name to avoid sending embedding requests
      // to a chat model deployment.
      let resolvedProviderConfig = providerConfig;
      if (!providerConfig || Object.keys(providerConfig).length === 0) {
        try {
          const credentials = await resolveEmbeddingCredentials(provider, tenantId, model);
          if (credentials.authConfig && Object.keys(credentials.authConfig).length > 0) {
            resolvedProviderConfig = {
              ...credentials.authConfig,
              ...providerConfig, // User-provided values take priority
            };

            // For Azure: ensure deploymentId matches the embedding model, not a chat model.
            // Azure deployments are named after the model they serve, so the embedding model
            // name IS the correct deploymentId for embedding operations.
            if (provider === 'azure' && model && resolvedProviderConfig) {
              const currentDeploymentId = resolvedProviderConfig.deploymentId as string | undefined;
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
                resolvedProviderConfig.deploymentId = model;
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

      const newConfig = { provider, model, dimensions, providerConfig: resolvedProviderConfig };

      // Validate embedding config (registry + credentials)
      const validationErrors = await validateEmbeddingConfigAsync(newConfig as any, tenantId);

      if (validationErrors.length > 0) {
        res.status(400).json({
          success: false,
          error: {
            code: 'EMBEDDING_CONFIG_INVALID',
            message: validationErrors.map((e) => e.message).join('; '),
            details: { validationErrors },
          },
        });
        return;
      }

      // Save previous config for response and comparison
      const previousConfig = pipeline.activeEmbeddingConfig
        ? { ...pipeline.activeEmbeddingConfig }
        : null;

      // Check if embedding actually changed
      const embeddingChanged =
        !previousConfig ||
        previousConfig.provider !== provider ||
        previousConfig.model !== model ||
        previousConfig.dimensions !== dimensions;

      // Update activeEmbeddingConfig
      pipeline.activeEmbeddingConfig = newConfig as any;

      // Store previous config in pipeline for publish-time comparison
      if (embeddingChanged && previousConfig) {
        pipeline.previousVersion = {
          ...(pipeline.previousVersion || {}),
          activeEmbeddingConfig: previousConfig,
        } as any;
      }

      // Update all flow embedding stages to match
      syncFlowEmbeddingStages(pipeline);

      await pipeline.save();

      // T14: Sync SearchIndex for backward compatibility
      await syncSearchIndexEmbeddingConfig(tenantId, kbId, model, dimensions);

      logger.info('Embedding config updated', {
        pipelineId: id,
        previousProvider: (previousConfig as any)?.provider,
        newProvider: provider,
      });

      // Reindexing is triggered via POST .../pipelines/:id/reindex
      // The frontend should prompt the user to confirm reindex after this change.

      res.json({
        success: true,
        data: {
          message: 'Embedding configuration updated. Reindexing required.',
          previousConfig,
          newConfig: pipeline.activeEmbeddingConfig,
          reindexRequired: true,
        },
      });
    } catch (error) {
      logger.error('Failed to update embedding config', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update embedding config' },
      });
    }
  },
);

// ─── Helper Functions (Embedding) ──────────────────────────────────────

/**
 * T14: Sync SearchIndex embedding fields when pipeline config changes.
 *
 * Keeps SearchIndex.embeddingModel and embeddingDimensions in sync
 * with the pipeline's activeEmbeddingConfig for backward compatibility.
 */
async function syncSearchIndexEmbeddingConfig(
  tenantId: string,
  kbId: string,
  embeddingModel: string,
  embeddingDimensions: number,
): Promise<void> {
  try {
    const kb = await KnowledgeBase.findOne({ _id: kbId, tenantId }).lean();
    if (!kb?.searchIndexId) return;

    await SearchIndex.updateOne(
      { _id: kb.searchIndexId, tenantId },
      { $set: { embeddingModel, embeddingDimensions } },
    );

    logger.info('SearchIndex embedding config synced', {
      tenantId,
      kbId,
      searchIndexId: kb.searchIndexId,
      embeddingModel,
      embeddingDimensions,
    });
  } catch (error) {
    logger.error('Failed to sync SearchIndex embedding config', {
      error: error instanceof Error ? error.message : String(error),
      tenantId,
      kbId,
    });
  }
}

/**
 * Get document count for a knowledge base (for confirmation dialog).
 */
async function getDocumentCount(tenantId: string, kbId: string): Promise<number> {
  try {
    const kb = await KnowledgeBase.findOne({ _id: kbId, tenantId }).lean();
    return kb?.documentCount ?? 0;
  } catch {
    return 0;
  }
}

// ─── POST /api/projects/:projectId/knowledge-bases/:kbId/pipelines/test-webhook

/**
 * Test a Custom API (http-webhook) endpoint from the server side.
 *
 * Avoids browser CORS restrictions by proxying the test request.
 * Sends a sample payload and returns the response status + body preview.
 *
 * @permission knowledge-base:update
 * @returns { success: true, status: number, body: string } or error
 */
router.post(
  '/api/projects/:projectId/knowledge-bases/:kbId/pipelines/test-webhook',
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Tenant context required' },
        });
        return;
      }

      const { projectId, kbId } = req.params;
      const { url, method, headers, auth, timeout, payload } = req.body;

      if (!url || typeof url !== 'string') {
        res
          .status(400)
          .json({ success: false, error: { code: 'INVALID_URL', message: 'url is required' } });
        return;
      }

      // Validate URL
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        res
          .status(400)
          .json({ success: false, error: { code: 'INVALID_URL', message: 'Invalid URL format' } });
        return;
      }

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_URL', message: 'URL must use http or https' },
        });
        return;
      }

      // SSRF protection: block internal/private network addresses
      const hostname = parsed.hostname;
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '0.0.0.0' ||
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        hostname.endsWith('.internal') ||
        hostname.endsWith('.local') ||
        hostname === '169.254.169.254'
      ) {
        res.status(400).json({
          success: false,
          error: { code: 'BLOCKED_URL', message: 'Internal network URLs not allowed' },
        });
        return;
      }

      const kb = await verifyKnowledgeBase(
        req.tenantContext.tenantId,
        projectId,
        kbId,
        req.tenantContext,
      );
      if (!kb) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Knowledge base not found' },
        });
        return;
      }

      // Build request headers
      const reqHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (headers && typeof headers === 'object') {
        for (const [k, v] of Object.entries(headers)) {
          if (typeof v === 'string') reqHeaders[k] = v;
        }
      }
      if (auth && typeof auth === 'object') {
        const a = auth as { type?: string; token?: string; headerName?: string };
        if (a.type === 'bearer' && a.token) {
          reqHeaders['Authorization'] = `Bearer ${a.token}`;
        } else if (a.type === 'api-key' && a.token) {
          reqHeaders[a.headerName ?? 'X-API-Key'] = a.token;
        } else if (a.type === 'basic' && a.token) {
          reqHeaders['Authorization'] = `Basic ${a.token}`;
        }
      }

      const testPayload =
        payload ??
        JSON.stringify({
          documentId: 'test-connection',
          content: 'Sample document content for connectivity test.',
          contentType: 'text/plain',
          metadata: {},
        });

      const httpMethod = (method ?? 'POST').toUpperCase();
      const reqTimeout = Math.min(Number(timeout) || 15000, 30000);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), reqTimeout);

      const response = await fetch(url, {
        method: httpMethod,
        headers: reqHeaders,
        body: httpMethod !== 'GET' ? testPayload : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseBody = await response.text().catch(() => '');
      const preview =
        responseBody.length > 1000 ? responseBody.slice(0, 1000) + '...' : responseBody;

      res.json({
        success: response.ok,
        status: response.status,
        statusText: response.statusText,
        body: preview,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('abort') || msg.includes('AbortError')) {
        res
          .status(504)
          .json({ success: false, error: { code: 'TIMEOUT', message: 'Request timed out' } });
      } else {
        logger.error('Test webhook failed', { error: msg });
        res
          .status(502)
          .json({ success: false, error: { code: 'CONNECTION_FAILED', message: msg } });
      }
    }
  },
);

export default router;
