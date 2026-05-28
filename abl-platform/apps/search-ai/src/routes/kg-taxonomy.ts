/**
 * Knowledge Graph Taxonomy Routes
 *
 * API endpoints for managing KG taxonomy configuration.
 *
 * GET    /:indexId/kg-configuration-status  - Check workspace-aware LLM configuration status
 * POST   /:indexId/kg-configure-model       - Configure LLM model for KG use case
 * POST   /:indexId/kg-taxonomy/setup        - One-time taxonomy setup
 * GET    /:indexId/kg-taxonomy              - Get current taxonomy
 * PUT    /:indexId/kg-taxonomy              - Update taxonomy
 * DELETE /:indexId/kg-taxonomy              - Delete taxonomy
 * GET    /:indexId/kg-taxonomy/setup/:jobId - Get setup job status
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import fs from 'fs/promises';

import { createQueue } from '../workers/shared.js';
import type { TaxonomySetupJobData } from '../workers/shared.js';
import path from 'path';

import { getConfig } from '../config/index.js';
import { getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';
import type {
  ISearchIndex,
  IKnowledgeGraphTaxonomy,
  IOrgProfileMetric,
  IKnowledgeGraphDomain,
  ITenantModel,
  IKnowledgeBase,
} from '@agent-platform/database/models';
import { createOrgProfileGenerator } from '../services/org-profile-generator.service.js';
import { createCustomDomainGenerator } from '../services/custom-domain-generator.service.js';
import type { OrgProfile } from '../schemas/org-profile.schema.js';
import type { DomainDefinition } from '../schemas/domain-definition.schema.js';
import { createLogger } from '@abl/compiler/platform';
import {
  assessKGCapabilities,
  recommendModelForKG,
  type AssessedModel,
} from '../services/kg-model-assessment.js';

const logger = createLogger('kg-taxonomy-routes');

const router: RouterType = Router();

// Queue name for taxonomy setup jobs
const QUEUE_TAXONOMY_SETUP = 'taxonomy-setup';

// Directory containing domain definition JSON files
const DOMAINS_DIR = path.resolve(process.cwd(), 'data', 'domains');
const DOMAIN_ID_PATTERN = /^[a-z0-9-]+$/i;
const DOMAIN_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN_OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

function isDatabaseDomainId(domainId: string): boolean {
  return DOMAIN_UUID_PATTERN.test(domainId) || DOMAIN_OBJECT_ID_PATTERN.test(domainId);
}

function resolveDomainFilePath(fileName: string): string {
  const resolvedPath = path.resolve(DOMAINS_DIR, fileName);
  const relativePath = path.relative(DOMAINS_DIR, resolvedPath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Domain path escaped built-in domains directory');
  }

  return resolvedPath;
}

function resolveBuiltInDomainPath(domainId: string): string {
  if (!DOMAIN_ID_PATTERN.test(domainId)) {
    throw new Error('Invalid domain ID format');
  }

  return resolveDomainFilePath(`${domainId}.json`);
}

/**
 * GET /:indexId/kg-configuration-status
 *
 * Check KG configuration status with workspace-aware model recommendations.
 * Three-level check:
 * 1. Workspace level - sibling indexes in same project with KG configured
 * 2. Tenant level - available TenantModels
 * 3. Configuration needed - no models configured
 *
 * Response:
 *   configurationLevel: 'workspace' | 'tenant' | 'none'
 *   workspace: { hasKGConfigured, configuredIndexes[], recommendation }
 *   tenant: { models[], recommendation }
 *   requiresConfiguration: boolean
 */
router.get('/:indexId/kg-configuration-status', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;
    const kgEnvironmentAvailable = getConfig().knowledgeGraph.enabled;

    // Get current index to find projectId
    const SearchIndex = await getLazyModel<ISearchIndex>('SearchIndex');
    const currentIndex = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();

    if (!currentIndex) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    const projectId = currentIndex.projectId;

    // ─── LEVEL 1: Check workspace (same project) ─────────────────────────

    const siblingIndexes = await SearchIndex.find({
      tenantId,
      projectId, // Same workspace
      _id: { $ne: indexId }, // Exclude current
      'llmConfig.useCases.knowledgeGraph.enabled': true,
    })
      .select('_id llmConfig.useCases.knowledgeGraph updatedAt')
      .lean();

    if (siblingIndexes.length > 0) {
      // Found existing KG config in workspace - get KB names
      const KnowledgeBase = await getLazyModel<IKnowledgeBase>('KnowledgeBase');
      const TenantModel = await getLazyModel<ITenantModel>('TenantModel');

      const configuredIndexes = await Promise.all(
        siblingIndexes.map(async (idx) => {
          const kb = await KnowledgeBase.findOne({
            searchIndexId: idx._id,
            tenantId,
          })
            .select('name')
            .lean();

          const kgConfig = (idx.llmConfig as any)?.useCases?.knowledgeGraph;
          const modelId = kgConfig?.modelId;

          // Resolve model details
          let model = null;
          if (modelId) {
            const tenantModel = await TenantModel.findOne({
              _id: modelId,
              tenantId,
            }).lean();
            if (tenantModel) {
              model = {
                id: String(tenantModel._id),
                displayName: tenantModel.displayName,
                provider: tenantModel.provider,
                tier: tenantModel.tier || 'standard',
              };
            }
          }

          return {
            indexId: idx._id,
            knowledgeBaseName: kb?.name || 'Unknown',
            model,
            configuredAt: idx.updatedAt,
          };
        }),
      );

      const workspaceConfig = {
        hasKGConfigured: true,
        configuredIndexes,
        recommendation: {
          action: 'inherit',
          message: `Use the same model as '${configuredIndexes[0].knowledgeBaseName}' for consistency`,
        },
      };

      // Early return with workspace inheritance option
      res.json({
        configurationLevel: 'workspace',
        workspace: workspaceConfig,
        tenant: null,
        requiresConfiguration: false,
        environment: {
          available: kgEnvironmentAvailable,
          reason: kgEnvironmentAvailable ? null : 'neo4j_not_provisioned',
        },
        autoConfigureModelId: null,
      });
      return;
    }

    // ─── LEVEL 2: Check tenant models ────────────────────────────────────

    const TenantModel = await getLazyModel<ITenantModel>('TenantModel');
    const tenantModels = await TenantModel.find({
      tenantId,
      isActive: true,
    }).lean();

    if (tenantModels.length === 0) {
      // No models configured anywhere
      res.json({
        configurationLevel: 'none',
        workspace: { hasKGConfigured: false, configuredIndexes: [] },
        tenant: { models: [], recommendation: null },
        requiresConfiguration: true,
        environment: {
          available: kgEnvironmentAvailable,
          reason: kgEnvironmentAvailable ? null : 'neo4j_not_provisioned',
        },
        autoConfigureModelId: null,
      });
      return;
    }

    // Assess tenant models for KG capabilities
    const assessedModels: AssessedModel[] = tenantModels.map((model) => ({
      id: String(model._id),
      displayName: model.displayName,
      provider: model.provider,
      tier: model.tier || 'standard',
      capabilities: {
        knowledgeGraph: assessKGCapabilities(model as ITenantModel),
      },
    }));

    const recommendation = recommendModelForKG(assessedModels);

    res.json({
      configurationLevel: 'tenant',
      workspace: { hasKGConfigured: false, configuredIndexes: [] },
      tenant: {
        models: assessedModels,
        recommendation,
      },
      requiresConfiguration: false,
      environment: {
        available: kgEnvironmentAvailable,
        reason: kgEnvironmentAvailable ? null : 'neo4j_not_provisioned',
      },
      autoConfigureModelId: recommendation?.modelId ?? null,
    });
  } catch (error) {
    logger.error('[kg-configuration-status] Failed to check configuration status', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: 'Failed to check configuration status',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /:indexId/kg-configure-model
 *
 * Configure LLM model for Knowledge Graph use case.
 * Stores model selection in SearchIndex.llmConfig.useCases.knowledgeGraph.
 *
 * Body:
 *   modelId: string - TenantModel ID to use for KG
 *   inheritedFrom?: string - Optional sibling index ID (for audit trail)
 *
 * Response:
 *   success: boolean
 *   message: string
 */
router.post('/:indexId/kg-configure-model', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const { modelId, inheritedFrom } = req.body;
    const tenantId = req.tenantContext.tenantId;

    if (!modelId) {
      res.status(400).json({ error: 'modelId is required' });
      return;
    }

    // Validate model exists and belongs to tenant
    const TenantModel = await getLazyModel<ITenantModel>('TenantModel');
    const model = await TenantModel.findOne({
      _id: modelId,
      tenantId,
      isActive: true,
    }).lean();

    if (!model) {
      res.status(404).json({ error: 'Model not found or inactive' });
      return;
    }

    // Update SearchIndex with KG configuration
    const SearchIndex = await getLazyModel<ISearchIndex>('SearchIndex');

    // MongoDB cannot $set dot-path fields through a null parent.
    // llmConfig defaults to null — initialize it first if needed.
    await SearchIndex.updateOne(
      applyProjectScopeFilter({ _id: indexId, tenantId, llmConfig: null }, req.tenantContext!),
      { $set: { llmConfig: { useCases: {} } } },
    );

    const kgConfig: Record<string, unknown> = {
      'llmConfig.useCases.knowledgeGraph.enabled': true,
      'llmConfig.useCases.knowledgeGraph.modelId': modelId,
      'llmConfig.useCases.knowledgeGraph.configuredAt': new Date(),
    };

    // Track inheritance source if provided
    if (inheritedFrom) {
      kgConfig['llmConfig.useCases.knowledgeGraph.inheritedFrom'] = inheritedFrom;
    }

    const result = await SearchIndex.findOneAndUpdate(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
      { $set: kgConfig },
      { new: true },
    );

    if (!result) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    logger.info('[kg-configure-model] Model configured for KG', {
      indexId,
      modelId,
      modelName: model.displayName,
      inheritedFrom,
    });

    res.json({
      success: true,
      message: `Knowledge Graph configured with ${model.displayName}`,
    });
  } catch (error) {
    logger.error('[kg-configure-model] Failed to configure model', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: 'Failed to configure model',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /kg-taxonomy/domains
 *
 * List available domain definitions. Reads the domains directory and returns
 * summary information for each domain JSON file.
 */
router.get('/kg-taxonomy/domains', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    let files: string[];
    try {
      files = await fs.readdir(DOMAINS_DIR);
    } catch {
      // data/domains/ may not exist in Docker — return empty list gracefully
      logger.warn('Built-in domains directory not found, returning empty list', {
        path: DOMAINS_DIR,
      });
      res.json({ domains: [] });
      return;
    }
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    const domains = await Promise.all(
      jsonFiles.map(async (file) => {
        const content = await fs.readFile(resolveDomainFilePath(file), 'utf-8');
        const domain = JSON.parse(content);
        return {
          id: domain.id,
          name: domain.name,
          version: domain.version,
          categoriesCount: domain.categories?.length ?? 0,
          productsCount: domain.products?.length ?? 0,
          attributesCount: domain.attributes?.length ?? 0,
        };
      }),
    );

    res.json({ domains });
  } catch (error) {
    logger.error('Failed to list domains', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: 'Failed to list domains',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /kg-taxonomy/domains/:domainId
 *
 * Fetches full domain definition including products, attributes, and categories.
 * Used for generating smart templates and product selection UI.
 *
 * Response:
 *   - Domain JSON with full structure
 */
router.get('/kg-taxonomy/domains/:domainId', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { domainId } = req.params;
    // Validate domainId to prevent path traversal (e.g. ../../etc/secrets)
    if (!DOMAIN_ID_PATTERN.test(domainId)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_DOMAIN_ID', message: 'Invalid domain ID' },
      });
      return;
    }
    const domainPath = resolveBuiltInDomainPath(domainId);

    try {
      const content = await fs.readFile(domainPath, 'utf-8');
      const domain = JSON.parse(content);
      res.json(domain);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'Domain not found' });
      } else {
        throw error;
      }
    }
  } catch (error) {
    logger.error('Failed to fetch domain', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'DOMAIN_FETCH_FAILED', message: 'Failed to fetch domain' },
    });
  }
});

/**
 * POST /:indexId/kg-taxonomy/generate-profile
 *
 * Generate organization profile using LLM from URL, name+industry, or paragraph description.
 * Part of RFC-001 Phase 2: LLM-Assisted Org Profile Generation.
 *
 * Body (JSON):
 *   - mode: 'url' | 'name-industry' | 'paragraph' [required]
 *   - input: { url?: string, name?: string, industry?: string, description?: string } [required]
 *
 * Response:
 *   - success: true
 *   - data: { profile: OrgProfile, generatedBy: 'llm' | 'manual', cost: number }
 *
 * Error Responses:
 *   - 400: SSRF violation, validation failure, invalid input
 *   - 503: LLM timeout, circuit breaker open (suggests manual flow)
 */
router.post('/:indexId/kg-taxonomy/generate-profile', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;
    const { mode, input } = req.body;

    // Get SearchIndex model (lazy loaded for dual-DB setup)
    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Validate mode
    if (!mode || !['url', 'name-industry', 'paragraph'].includes(mode)) {
      res.status(400).json({
        error: 'Invalid or missing mode',
        message: 'mode must be one of: url, name-industry, paragraph',
      });
      return;
    }

    // Validate input based on mode
    if (!input || typeof input !== 'object') {
      res.status(400).json({
        error: 'Missing or invalid input',
        message: 'input object is required',
      });
      return;
    }

    // Mode-specific validation
    if (mode === 'url' && !input.url) {
      res.status(400).json({
        error: 'Missing required field: input.url',
        message: 'url is required when mode is "url"',
      });
      return;
    }

    if (mode === 'name-industry' && (!input.name || !input.industry)) {
      res.status(400).json({
        error: 'Missing required fields: input.name and input.industry',
        message: 'name and industry are required when mode is "name-industry"',
      });
      return;
    }

    if (mode === 'paragraph' && !input.description) {
      res.status(400).json({
        error: 'Missing required field: input.description',
        message: 'description is required when mode is "paragraph"',
      });
      return;
    }

    // Create generator (resolves LLM credentials)
    const generator = await createOrgProfileGenerator(tenantId, indexId);
    if (!generator) {
      res.status(503).json({
        error: 'LLM service unavailable',
        message:
          'No LLM credentials configured for this tenant. Please use manual profile creation.',
        suggestedAction: 'manual',
      });
      return;
    }

    // Check circuit breaker state
    const circuitState = generator.getCircuitBreakerState();
    if (circuitState === 'OPEN') {
      res.status(503).json({
        error: 'LLM service temporarily unavailable',
        message:
          'Circuit breaker is open due to repeated failures. Please try again later or use manual profile creation.',
        suggestedAction: 'manual',
        retryAfter: 30, // seconds
      });
      return;
    }

    // Log generation start
    logger.info('Starting org profile generation', {
      tenantId,
      indexId,
      mode,
      inputType: mode === 'url' ? 'url' : mode === 'paragraph' ? 'paragraph' : 'name-industry',
      inputLength: mode === 'paragraph' ? input.description?.length : undefined,
    });

    // Generate profile
    let profile: OrgProfile;
    const startTime = Date.now();
    const OrgProfileMetric = getLazyModel<IOrgProfileMetric>('OrgProfileMetric');

    try {
      if (mode === 'url') {
        profile = await generator.generateFromURL(input.url);
      } else if (mode === 'name-industry') {
        profile = await generator.generateFromNameAndIndustry(input.name, input.industry);
      } else {
        // mode === 'paragraph'
        profile = await generator.generateFromParagraph(input.description);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const endTime = Date.now();
      const durationMs = endTime - startTime;
      const estimatedInputTokens = 3000;
      const estimatedOutputTokens = 0; // No output on error
      const cost = (estimatedInputTokens * 3) / 1_000_000;

      // SSRF violation
      if (errorMessage.includes('Private IP') || errorMessage.includes('blocked')) {
        // Record metrics (non-blocking - don't fail endpoint if metrics fail)
        try {
          await OrgProfileMetric.create({
            tenantId,
            indexId,
            mode,
            status: 'ssrf_blocked',
            durationMs,
            estimatedCost: cost,
            inputTokens: estimatedInputTokens,
            outputTokens: estimatedOutputTokens,
            circuitBreakerState: generator.getCircuitBreakerState(),
            inputType: mode === 'url' ? 'url' : mode,
            inputLength: mode === 'paragraph' ? input.description?.length : undefined,
            errorType: 'ssrf_violation',
            errorMessage,
            suggestedAction: 'use-public-url',
          });
        } catch (metricError) {
          logger.error('Failed to record org profile metric', {
            error: metricError instanceof Error ? metricError.message : String(metricError),
          });
        }

        res.status(400).json({
          error: 'SSRF protection triggered',
          message: errorMessage,
          suggestedAction: 'use-public-url',
        });
        return;
      }

      // Validation failure
      if (errorMessage.includes('invalid org profile') || errorMessage.includes('validation')) {
        // Record metrics (non-blocking)
        try {
          await OrgProfileMetric.create({
            tenantId,
            indexId,
            mode,
            status: 'validation_failure',
            durationMs,
            estimatedCost: cost,
            inputTokens: estimatedInputTokens,
            outputTokens: estimatedOutputTokens,
            circuitBreakerState: generator.getCircuitBreakerState(),
            inputType: mode === 'url' ? 'url' : mode,
            inputLength: mode === 'paragraph' ? input.description?.length : undefined,
            errorType: 'validation_failure',
            errorMessage,
            suggestedAction: 'retry-or-manual',
          });
        } catch (metricError) {
          logger.error('Failed to record org profile metric', {
            error: metricError instanceof Error ? metricError.message : String(metricError),
          });
        }

        res.status(400).json({
          error: 'LLM generated invalid profile',
          message: errorMessage,
          suggestedAction: 'retry-or-manual',
        });
        return;
      }

      // Circuit breaker or timeout
      if (errorMessage.includes('Circuit breaker') || errorMessage.includes('timeout')) {
        const status = errorMessage.includes('timeout') ? 'timeout' : 'circuit_breaker';

        // Record metrics (non-blocking)
        try {
          await OrgProfileMetric.create({
            tenantId,
            indexId,
            mode,
            status,
            durationMs,
            estimatedCost: cost,
            inputTokens: estimatedInputTokens,
            outputTokens: estimatedOutputTokens,
            circuitBreakerState: generator.getCircuitBreakerState(),
            inputType: mode === 'url' ? 'url' : mode,
            inputLength: mode === 'paragraph' ? input.description?.length : undefined,
            errorType: status,
            errorMessage,
            suggestedAction: 'manual',
          });
        } catch (metricError) {
          logger.error('Failed to record org profile metric', {
            error: metricError instanceof Error ? metricError.message : String(metricError),
          });
        }

        res.status(503).json({
          error: 'LLM service temporarily unavailable',
          message: errorMessage,
          suggestedAction: 'manual',
          retryAfter: 30,
        });
        return;
      }

      // Generic LLM error
      // Record metrics (non-blocking)
      try {
        await OrgProfileMetric.create({
          tenantId,
          indexId,
          mode,
          status: 'llm_error',
          durationMs,
          estimatedCost: cost,
          inputTokens: estimatedInputTokens,
          outputTokens: estimatedOutputTokens,
          circuitBreakerState: generator.getCircuitBreakerState(),
          inputType: mode === 'url' ? 'url' : mode,
          inputLength: mode === 'paragraph' ? input.description?.length : undefined,
          errorType: 'llm_error',
          errorMessage,
          suggestedAction: 'retry-or-manual',
        });
      } catch (metricError) {
        logger.error('Failed to record org profile metric', {
          error: metricError instanceof Error ? metricError.message : String(metricError),
        });
      }

      logger.error('Org profile generation failed', {
        tenantId,
        indexId,
        mode,
        error: errorMessage,
      });

      res.status(500).json({
        error: 'Profile generation failed',
        message: errorMessage,
        suggestedAction: 'retry-or-manual',
      });
      return;
    }

    const endTime = Date.now();
    const durationMs = endTime - startTime;

    // Calculate cost (rough estimate based on Claude Sonnet pricing)
    // Input: ~3000 tokens, Output: ~500 tokens
    // Claude Sonnet 4.5: $3/M input, $15/M output
    const estimatedInputTokens = 3000;
    const estimatedOutputTokens = 500;
    const cost = (estimatedInputTokens * 3) / 1_000_000 + (estimatedOutputTokens * 15) / 1_000_000;

    // Record success metrics (non-blocking)
    try {
      await OrgProfileMetric.create({
        tenantId,
        indexId,
        mode,
        status: 'success',
        durationMs,
        estimatedCost: cost,
        inputTokens: estimatedInputTokens,
        outputTokens: estimatedOutputTokens,
        circuitBreakerState: generator.getCircuitBreakerState(),
        inputType: mode === 'url' ? 'url' : mode,
        inputLength: mode === 'paragraph' ? input.description?.length : undefined,
        organizationName: profile.organizationName,
        industry: profile.industry,
        keyTermsCount: profile.keyTerms.length,
        acronymsCount: Object.keys(profile.acronyms).length,
        departmentBoundariesCount: profile.departmentBoundaries?.length || 0,
        productSpecificNamesCount: Object.keys(profile.productSpecificNames || {}).length,
      });
    } catch (metricError) {
      logger.error('Failed to record org profile metric', {
        error: metricError instanceof Error ? metricError.message : String(metricError),
      });
    }

    logger.info('Org profile generated successfully', {
      tenantId,
      indexId,
      mode,
      organizationName: profile.organizationName,
      durationMs,
      cost,
    });

    res.status(200).json({
      success: true,
      data: {
        profile,
        generatedBy: 'llm',
        cost: parseFloat(cost.toFixed(6)), // 6 decimal places (e.g., $0.000015)
        metadata: {
          mode,
          durationMs,
          circuitBreakerState: generator.getCircuitBreakerState(),
        },
      },
    });
  } catch (error) {
    logger.error('Org profile generation endpoint failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: 'Failed to generate org profile',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /:indexId/kg-taxonomy/domains/generate
 *
 * Generate custom domain definition from organization profile using LLM.
 * Part of RFC-001 Phase 3: Domain Auto-Generation.
 *
 * Body (JSON):
 *   - orgProfile: OrgProfile object [required]
 *
 * Response:
 *   - success: true
 *   - data: { domain: DomainDefinition, generatedBy: 'llm', cost: number }
 *
 * Error Responses:
 *   - 400: Validation failure, invalid input
 *   - 503: LLM timeout, circuit breaker open
 */
router.post('/:indexId/kg-taxonomy/domains/generate', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;
    const { orgProfile } = req.body;

    // Get SearchIndex model (lazy loaded for dual-DB setup)
    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Validate orgProfile
    if (!orgProfile || typeof orgProfile !== 'object') {
      res.status(400).json({
        error: 'Missing or invalid orgProfile',
        message:
          'orgProfile object is required with fields: organizationName, industry, keyTerms, acronyms',
      });
      return;
    }

    // Validate required fields in orgProfile
    if (!orgProfile.organizationName || !orgProfile.industry) {
      res.status(400).json({
        error: 'Missing required fields in orgProfile',
        message: 'orgProfile must include organizationName and industry',
      });
      return;
    }

    if (!Array.isArray(orgProfile.keyTerms) || orgProfile.keyTerms.length === 0) {
      res.status(400).json({
        error: 'Missing or invalid keyTerms',
        message: 'orgProfile.keyTerms must be a non-empty array',
      });
      return;
    }

    // Create generator (resolves LLM credentials)
    const generator = await createCustomDomainGenerator(tenantId, indexId);
    if (!generator) {
      res.status(503).json({
        error: 'LLM service unavailable',
        message: 'No LLM credentials configured for this tenant. Cannot generate custom domain.',
        suggestedAction: 'configure-credentials',
      });
      return;
    }

    // Check circuit breaker state
    const circuitState = generator.getCircuitBreakerState();
    if (circuitState === 'OPEN') {
      res.status(503).json({
        error: 'LLM service temporarily unavailable',
        message: 'Circuit breaker is open due to repeated failures. Please try again later.',
        suggestedAction: 'retry-later',
        retryAfter: 30, // seconds
      });
      return;
    }

    // Log generation start
    logger.info('Starting custom domain generation', {
      tenantId,
      indexId,
      organizationName: orgProfile.organizationName,
      industry: orgProfile.industry,
      keyTermsCount: orgProfile.keyTerms.length,
    });

    // Generate domain
    let domain: DomainDefinition;
    const startTime = Date.now();

    try {
      domain = await generator.generateFromOrgProfile(orgProfile);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const endTime = Date.now();
      const durationMs = endTime - startTime;

      // Validation failure
      if (errorMessage.includes('invalid domain') || errorMessage.includes('validation')) {
        logger.error('Domain generation validation failed', {
          tenantId,
          indexId,
          error: errorMessage,
        });

        res.status(400).json({
          error: 'LLM generated invalid domain',
          message: errorMessage,
          suggestedAction: 'retry',
        });
        return;
      }

      // Circuit breaker or timeout
      if (errorMessage.includes('Circuit breaker') || errorMessage.includes('timeout')) {
        logger.error('Domain generation service unavailable', {
          tenantId,
          indexId,
          error: errorMessage,
        });

        res.status(503).json({
          error: 'LLM service temporarily unavailable',
          message: errorMessage,
          suggestedAction: 'retry-later',
          retryAfter: 30,
        });
        return;
      }

      // Generic LLM error
      logger.error('Custom domain generation failed', {
        tenantId,
        indexId,
        error: errorMessage,
      });

      res.status(500).json({
        error: 'Domain generation failed',
        message: errorMessage,
        suggestedAction: 'retry',
      });
      return;
    }

    const endTime = Date.now();
    const durationMs = endTime - startTime;

    // Calculate cost (Claude Sonnet 4.5: $3/M input, $15/M output)
    // Domain generation uses larger context: ~5000 input tokens, ~2000 output tokens
    const estimatedInputTokens = 5000;
    const estimatedOutputTokens = 2000;
    const cost = (estimatedInputTokens * 3) / 1_000_000 + (estimatedOutputTokens * 15) / 1_000_000;

    logger.info('Custom domain generated successfully', {
      tenantId,
      indexId,
      domainName: domain.name,
      categoriesCount: domain.categories.length,
      productsCount: domain.products.length,
      attributesCount: domain.attributes.length,
      durationMs,
      cost,
    });

    res.status(200).json({
      success: true,
      data: {
        domain,
        generatedBy: 'llm',
        cost: parseFloat(cost.toFixed(6)),
        metadata: {
          durationMs,
          circuitBreakerState: generator.getCircuitBreakerState(),
          statistics: {
            categoriesCount: domain.categories.length,
            productsCount: domain.products.length,
            attributesCount: domain.attributes.length,
            departmentBoundariesCount: domain.departmentBoundaries.length,
          },
        },
      },
    });
  } catch (error) {
    logger.error('Domain generation endpoint failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: 'Failed to generate custom domain',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /:indexId/kg-taxonomy/domains
 *
 * Save a custom domain definition to the database.
 * Part of RFC-001 Phase 3: Domain Auto-Generation.
 *
 * Body (JSON):
 *   - domain: DomainDefinition object [required]
 *   - setAsActive: boolean [optional] - Whether to immediately set this domain as the active taxonomy
 *
 * Response:
 *   - success: true
 *   - data: { domainId: string, domain: IKnowledgeGraphDomain }
 *
 * Error Responses:
 *   - 400: Validation failure, duplicate domain name
 *   - 404: Index not found
 */
router.post('/:indexId/kg-taxonomy/domains', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;
    const userId = req.tenantContext.userId;
    const { domain, setAsActive = false } = req.body;

    // Validate domain object
    if (!domain || typeof domain !== 'object') {
      res.status(400).json({
        error: 'Missing or invalid domain',
        message: 'domain object is required',
      });
      return;
    }

    // Get SearchIndex model
    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Get KnowledgeGraphDomain model
    const KnowledgeGraphDomain = getLazyModel<IKnowledgeGraphDomain>('KnowledgeGraphDomain');

    // Check for duplicate domain name
    const existingDomain = await KnowledgeGraphDomain.findOne({
      tenantId,
      name: domain.name,
    }).lean();

    if (existingDomain) {
      res.status(400).json({
        error: 'Duplicate domain name',
        message: `A domain with name '${domain.name}' already exists. Please use a different name.`,
      });
      return;
    }

    // Create domain record
    const newDomain = await KnowledgeGraphDomain.create({
      tenantId,
      name: domain.name,
      version: domain.version,
      industry: domain.industry,
      categories: domain.categories,
      products: domain.products,
      attributes: domain.attributes,
      departmentBoundaries: domain.departmentBoundaries || [],
      createdBy: userId,
    });

    logger.info('Custom domain saved to database', {
      tenantId,
      indexId,
      domainId: newDomain._id,
      domainName: newDomain.name,
      setAsActive,
    });

    // Optionally set as active taxonomy (enqueue taxonomy-setup worker)
    if (setAsActive) {
      const queue = createQueue(QUEUE_TAXONOMY_SETUP);
      try {
        await queue.add(
          `taxonomy-setup:${indexId}`,
          {
            indexId,
            tenantId,
            domainId: newDomain._id,
            source: 'custom-domain',
          },
          {
            jobId: `taxonomy-setup:${indexId}:${newDomain._id}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
          },
        );

        logger.info('Taxonomy setup job enqueued for custom domain', {
          tenantId,
          indexId,
          domainId: newDomain._id,
        });
      } finally {
        await queue.close();
      }
    }

    res.status(201).json({
      success: true,
      data: {
        domainId: newDomain._id,
        domain: newDomain,
        taxonomySetupEnqueued: setAsActive,
      },
    });
  } catch (error) {
    logger.error('Failed to save custom domain', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: 'Failed to save custom domain',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /:indexId/kg-taxonomy/domains
 *
 * List all custom domains saved for this index's tenant.
 * Part of RFC-001 Phase 3: Domain Auto-Generation.
 *
 * Response:
 *   - success: true
 *   - data: { domains: IKnowledgeGraphDomain[] }
 */
router.get('/:indexId/kg-taxonomy/domains', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    // Get SearchIndex model
    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Get KnowledgeGraphDomain model
    const KnowledgeGraphDomain = getLazyModel<IKnowledgeGraphDomain>('KnowledgeGraphDomain');

    // List all domains for this tenant (most recent first)
    const domains = await KnowledgeGraphDomain.find({ tenantId })
      .sort({ createdAt: -1 })
      .select({
        _id: 1,
        name: 1,
        version: 1,
        industry: 1,
        createdBy: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .lean();

    // Add counts for UI display
    const domainsWithCounts = domains.map((d: any) => ({
      ...d,
      categoriesCount: d.categories?.length ?? 0,
      productsCount: d.products?.length ?? 0,
      attributesCount: d.attributes?.length ?? 0,
    }));

    res.status(200).json({
      success: true,
      data: {
        domains: domainsWithCounts,
        total: domains.length,
      },
    });
  } catch (error) {
    logger.error('Failed to list custom domains', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: 'Failed to list custom domains',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /:indexId/kg-taxonomy/domains/:domainId
 *
 * Get full details of a specific custom domain.
 * Part of RFC-001 Phase 3: Domain Auto-Generation.
 *
 * Response:
 *   - success: true
 *   - data: { domain: IKnowledgeGraphDomain }
 *
 * Error Responses:
 *   - 404: Domain not found or doesn't belong to tenant
 */
router.get('/:indexId/kg-taxonomy/domains/:domainId', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId, domainId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    // Get SearchIndex model
    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Get KnowledgeGraphDomain model
    const KnowledgeGraphDomain = getLazyModel<IKnowledgeGraphDomain>('KnowledgeGraphDomain');

    // Find domain by ID AND tenant (tenant isolation)
    const domain = await KnowledgeGraphDomain.findOne({
      _id: domainId,
      tenantId,
    }).lean();

    if (!domain) {
      res.status(404).json({ error: 'Domain not found' });
      return;
    }

    res.status(200).json({
      success: true,
      data: { domain },
    });
  } catch (error) {
    logger.error('Failed to get custom domain', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: 'Failed to get custom domain',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * DELETE /:indexId/kg-taxonomy/domains/:domainId
 *
 * Delete a custom domain.
 * Part of RFC-001 Phase 3: Domain Auto-Generation.
 *
 * Response:
 *   - success: true
 *   - data: { deleted: true, domainId: string }
 *
 * Error Responses:
 *   - 404: Domain not found or doesn't belong to tenant
 *   - 409: Domain is currently active (must deactivate first)
 */
router.delete('/:indexId/kg-taxonomy/domains/:domainId', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId, domainId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    // Get SearchIndex model
    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Check if this domain is currently active in any taxonomy
    const KnowledgeGraphTaxonomy = getLazyModel<IKnowledgeGraphTaxonomy>('KnowledgeGraphTaxonomy');
    const activeTaxonomy = await KnowledgeGraphTaxonomy.findOne({
      tenantId,
      indexId,
      'taxonomy.domain.id': domainId,
    }).lean();

    if (activeTaxonomy) {
      res.status(409).json({
        error: 'Domain is currently active',
        message:
          'Cannot delete a domain that is currently active in a taxonomy. Please deactivate it first.',
      });
      return;
    }

    // Get KnowledgeGraphDomain model
    const KnowledgeGraphDomain = getLazyModel<IKnowledgeGraphDomain>('KnowledgeGraphDomain');

    // Delete domain (tenant isolation ensures we only delete if it belongs to this tenant)
    const result = await KnowledgeGraphDomain.deleteOne({
      _id: domainId,
      tenantId,
    });

    if (result.deletedCount === 0) {
      res.status(404).json({ error: 'Domain not found' });
      return;
    }

    logger.info('Custom domain deleted', {
      tenantId,
      indexId,
      domainId,
    });

    res.status(200).json({
      success: true,
      data: {
        deleted: true,
        domainId,
      },
    });
  } catch (error) {
    logger.error('Failed to delete custom domain', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: 'Failed to delete custom domain',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /kg-taxonomy/metrics/org-profile-generation
 *
 * Query aggregate metrics for org profile generation.
 * Provides success rates, average cost, average duration, and error breakdown.
 *
 * Query Parameters:
 *   - indexId: Filter by specific index (optional)
 *   - mode: Filter by generation mode (url, name-industry, paragraph) (optional)
 *   - status: Filter by status (success, validation_failure, etc.) (optional)
 *   - since: Start date (ISO 8601) (optional)
 *   - until: End date (ISO 8601) (optional)
 *   - groupBy: Time grouping (day, week, month) (optional)
 *
 * Response:
 *   - success: true
 *   - data: {
 *       overall: { total, successCount, successRate, avgCost, avgDuration, totalCost },
 *       byMode: { url: {...}, name-industry: {...}, paragraph: {...} },
 *       byStatus: { success: count, validation_failure: count, ... },
 *       timeline: [{ date, total, successCount, ... }] (if groupBy specified)
 *     }
 */
router.get('/kg-taxonomy/metrics/org-profile-generation', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const tenantId = req.tenantContext.tenantId;
    const { indexId, mode, status, since, until, groupBy } = req.query;

    const OrgProfileMetric = getLazyModel<IOrgProfileMetric>('OrgProfileMetric');

    // Build query filter
    const filter: any = { tenantId };

    if (indexId) {
      filter.indexId = indexId;
    }

    if (mode && ['url', 'name-industry', 'paragraph'].includes(mode as string)) {
      filter.mode = mode;
    }

    if (status) {
      filter.status = status;
    }

    if (since || until) {
      filter.createdAt = {};
      if (since) {
        filter.createdAt.$gte = new Date(since as string);
      }
      if (until) {
        filter.createdAt.$lte = new Date(until as string);
      }
    }

    // Overall metrics
    const allMetrics = await OrgProfileMetric.find(filter);

    const total = allMetrics.length;
    const successCount = allMetrics.filter((m) => m.status === 'success').length;
    const successRate = total > 0 ? (successCount / total) * 100 : 0;
    const avgCost = total > 0 ? allMetrics.reduce((sum, m) => sum + m.estimatedCost, 0) / total : 0;
    const avgDuration =
      total > 0 ? allMetrics.reduce((sum, m) => sum + m.durationMs, 0) / total : 0;
    const totalCost = allMetrics.reduce((sum, m) => sum + m.estimatedCost, 0);

    // By mode
    const byMode: any = {};
    for (const m of ['url', 'name-industry', 'paragraph']) {
      const modeMetrics = allMetrics.filter((metric) => metric.mode === m);
      const modeTotal = modeMetrics.length;
      const modeSuccessCount = modeMetrics.filter((metric) => metric.status === 'success').length;

      byMode[m] = {
        total: modeTotal,
        successCount: modeSuccessCount,
        successRate: modeTotal > 0 ? (modeSuccessCount / modeTotal) * 100 : 0,
        avgCost:
          modeTotal > 0
            ? modeMetrics.reduce((sum, metric) => sum + metric.estimatedCost, 0) / modeTotal
            : 0,
        avgDuration:
          modeTotal > 0
            ? modeMetrics.reduce((sum, metric) => sum + metric.durationMs, 0) / modeTotal
            : 0,
      };
    }

    // By status
    const byStatus: Record<string, number> = {};
    for (const metric of allMetrics) {
      byStatus[metric.status] = (byStatus[metric.status] || 0) + 1;
    }

    // Timeline (if groupBy specified)
    let timeline: any[] | undefined = undefined;
    if (groupBy && ['day', 'week', 'month'].includes(groupBy as string)) {
      const grouped = new Map<string, any>();

      for (const metric of allMetrics) {
        let dateKey: string;
        const date = new Date(metric.createdAt);

        if (groupBy === 'day') {
          dateKey = date.toISOString().split('T')[0]; // YYYY-MM-DD
        } else if (groupBy === 'week') {
          const weekStart = new Date(date);
          weekStart.setDate(date.getDate() - date.getDay()); // Sunday
          dateKey = weekStart.toISOString().split('T')[0];
        } else {
          // month
          dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; // YYYY-MM
        }

        if (!grouped.has(dateKey)) {
          grouped.set(dateKey, {
            date: dateKey,
            total: 0,
            successCount: 0,
            totalCost: 0,
            avgDuration: 0,
            byMode: { url: 0, 'name-industry': 0, paragraph: 0 },
          });
        }

        const entry = grouped.get(dateKey);
        entry.total += 1;
        if (metric.status === 'success') entry.successCount += 1;
        entry.totalCost += metric.estimatedCost;
        entry.avgDuration += metric.durationMs;
        entry.byMode[metric.mode] += 1;
      }

      // Calculate averages
      for (const entry of grouped.values()) {
        entry.avgDuration = entry.total > 0 ? entry.avgDuration / entry.total : 0;
        entry.successRate = entry.total > 0 ? (entry.successCount / entry.total) * 100 : 0;
      }

      timeline = Array.from(grouped.values()).sort((a, b) => a.date.localeCompare(b.date));
    }

    res.status(200).json({
      success: true,
      data: {
        overall: {
          total,
          successCount,
          successRate: parseFloat(successRate.toFixed(2)),
          avgCost: parseFloat(avgCost.toFixed(6)),
          avgDuration: Math.round(avgDuration),
          totalCost: parseFloat(totalCost.toFixed(6)),
        },
        byMode,
        byStatus,
        timeline,
      },
    });
  } catch (error) {
    logger.error('Failed to query org profile metrics', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: 'Failed to query metrics',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /:indexId/kg-taxonomy/setup
 *
 * One-time taxonomy setup for an index. Loads domain definitions from system,
 * parses customer organization profile (markdown), merges them, validates,
 * and stores in MongoDB + creates Neo4j graph structure.
 *
 * Body (JSON):
 *   - domain: Domain ID to use (e.g., "financial-services") [required]
 *   - organizationProfilePath: Path to customer's organization profile markdown [required]
 *   - priority: 'low' | 'normal' | 'high' [optional, default: 'normal']
 *
 * Response:
 *   - jobId: Job ID for status polling
 *   - status: 'QUEUED'
 *   - pollUrl: URL to poll for status
 */
router.post('/:indexId/kg-taxonomy/setup', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;
    const { domain, organizationProfilePath, organizationProfile, priority } = req.body;

    // Validate required fields
    if (!domain) {
      res.status(400).json({
        error: 'Missing required field: domain',
        message: 'Domain ID is required (e.g., "financial-services")',
      });
      return;
    }

    // Get models (lazy loaded for dual-DB setup)
    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
    const KnowledgeGraphTaxonomy = getLazyModel<IKnowledgeGraphTaxonomy>('KnowledgeGraphTaxonomy');

    // Verify index exists AND belongs to tenant (tenant isolation)
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // ─── Auto-configure KG model if requested ──────────────────────────
    const autoConfigureModelId =
      typeof req.body.autoConfigureModelId === 'string' && req.body.autoConfigureModelId.length > 0
        ? req.body.autoConfigureModelId
        : null;

    const existingKgModelId = (
      (index.llmConfig as Record<string, unknown> | null)?.useCases as
        | Record<string, unknown>
        | undefined
    )?.knowledgeGraph
      ? (
          ((index.llmConfig as Record<string, unknown> | null)?.useCases as Record<string, unknown>)
            ?.knowledgeGraph as Record<string, unknown>
        )?.modelId
      : null;

    if (autoConfigureModelId && !existingKgModelId) {
      const TenantModel = await getLazyModel<ITenantModel>('TenantModel');
      const model = await TenantModel.findOne({
        _id: autoConfigureModelId,
        tenantId,
        isActive: true,
      }).lean();

      if (!model) {
        res.status(400).json({
          success: false,
          error: { code: 'MODEL_NOT_FOUND', message: 'Specified model not found or inactive' },
        });
        return;
      }

      // Initialize llmConfig if null
      await SearchIndex.updateOne(
        applyProjectScopeFilter({ _id: indexId, tenantId, llmConfig: null }, req.tenantContext!),
        { $set: { llmConfig: { useCases: {} } } },
      );

      // Set KG config
      await SearchIndex.findOneAndUpdate(
        applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
        {
          $set: {
            'llmConfig.useCases.knowledgeGraph.enabled': true,
            'llmConfig.useCases.knowledgeGraph.modelId': autoConfigureModelId,
            'llmConfig.useCases.knowledgeGraph.configuredAt': new Date(),
          },
        },
      );

      logger.info('[kg-taxonomy-setup] Auto-configured KG model', {
        indexId,
        modelId: autoConfigureModelId,
        tenantId,
      });
    }

    // Check if taxonomy already exists
    const existingTaxonomy = await KnowledgeGraphTaxonomy.findOne({ tenantId, indexId }).lean();
    if (existingTaxonomy) {
      res.status(409).json({
        error: 'Taxonomy already exists for this index',
        message:
          'Use PUT /api/indexes/:indexId/kg-taxonomy to update existing taxonomy or DELETE first',
        existingVersion: existingTaxonomy.version,
        createdAt: existingTaxonomy.createdAt,
      });
      return;
    }

    // Resolve domain definition path from domain ID.
    // Custom domains stored in MongoDB are referenced by ObjectId (24-char hex) or UUID.
    // Built-in domains are resolved to filesystem JSON paths (kebab-case slugs).
    // Validate non-database domain IDs to prevent path traversal (e.g. ../../etc/secrets)
    const isDatabaseId = isDatabaseDomainId(domain);
    if (!isDatabaseId && !DOMAIN_ID_PATTERN.test(domain)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_DOMAIN', message: 'Invalid domain ID format' },
      });
      return;
    }
    const domainDefinitionPaths = [isDatabaseId ? domain : resolveBuiltInDomainPath(domain)];

    // Create job data
    const jobData: TaxonomySetupJobData = {
      indexId,
      tenantId,
      domainDefinitionPaths,
      organizationProfilePath,
      organizationProfile,
      priority: priority || 'normal',
    };

    // Enqueue setup job
    const jobId = `taxonomy-setup:${indexId}:${Date.now()}`;
    const queue = createQueue(QUEUE_TAXONOMY_SETUP);

    try {
      await queue.add(jobId, jobData, {
        jobId,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        priority: priority === 'high' ? 1 : priority === 'low' ? 10 : 5,
      });

      logger.info('Taxonomy setup job enqueued', {
        jobId,
        indexId,
        tenantId,
        domain,
      });
    } finally {
      await queue.close();
    }

    res.status(201).json({
      success: true,
      jobId,
      status: 'QUEUED',
      indexId,
      domain,
      pollUrl: `/api/indexes/${indexId}/kg-taxonomy/setup/${jobId}`,
      createdAt: new Date(),
    });
  } catch (error) {
    logger.error('Failed to trigger taxonomy setup', {
      error: error instanceof Error ? error.message : String(error),
      indexId: req.params.indexId,
    });
    res.status(500).json({
      error: 'Failed to trigger taxonomy setup',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /:indexId/kg-taxonomy/setup/:jobId
 *
 * Get taxonomy setup job status.
 *
 * Response:
 *   - jobId: Job ID
 *   - status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED'
 *   - progress: Progress percentage (0-100)
 *   - createdAt: Job creation timestamp
 *   - processedAt: Job start timestamp (if processing)
 *   - finishedAt: Job completion timestamp (if completed)
 *   - error: Error message (if failed)
 *   - taxonomyVersion: Created taxonomy version (if completed)
 */
router.get('/:indexId/kg-taxonomy/setup/:jobId', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId, jobId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    // Get SearchIndex model (lazy loaded for dual-DB setup)
    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Get job status from BullMQ
    const queue = createQueue(QUEUE_TAXONOMY_SETUP);

    try {
      const job = await queue.getJob(jobId);

      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      // Verify job belongs to this tenant/index (security)
      const jobData = job.data as TaxonomySetupJobData;
      if (jobData.tenantId !== tenantId || jobData.indexId !== indexId) {
        res.status(403).json({ error: 'Job does not belong to this tenant/index' });
        return;
      }

      // Map BullMQ state to our status
      const state = await job.getState();
      const status =
        state === 'completed'
          ? 'COMPLETED'
          : state === 'failed'
            ? 'FAILED'
            : state === 'active'
              ? 'PROCESSING'
              : 'QUEUED';

      const response: any = {
        jobId: job.id,
        status,
        progress: typeof job.progress === 'number' ? job.progress : 0,
        createdAt: new Date(job.timestamp),
        processedAt: job.processedOn ? new Date(job.processedOn) : null,
        finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
      };

      // Add taxonomy version if completed
      const returnValue = job.returnvalue;
      if (status === 'COMPLETED' && returnValue?.taxonomyId) {
        response.taxonomyId = returnValue.taxonomyId;
        response.taxonomyVersion = returnValue.version;
        response.domains = returnValue.domains;
        response.productsCount = returnValue.productsCount;
        response.attributesCount = returnValue.attributesCount;
      }

      // Add error if failed. Stack traces are kept server-side only (BullMQ
      // retains job.stacktrace in Redis); leaking them to API callers exposes
      // internal file paths and module structure.
      if (status === 'FAILED') {
        response.error = job.failedReason || 'Unknown error';
      }

      res.json(response);
    } finally {
      await queue.close();
    }
  } catch (error) {
    logger.error('Get setup job status failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: 'Failed to get setup job status',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /:indexId/kg-taxonomy
 *
 * Get current taxonomy configuration for an index.
 *
 * Response:
 *   - taxonomyId: Taxonomy document ID
 *   - version: Taxonomy version
 *   - domains: List of domain IDs
 *   - taxonomy: Full taxonomy structure
 *   - createdAt: Creation timestamp
 *   - updatedAt: Last update timestamp
 */
router.get('/:indexId/kg-taxonomy', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    // Get models (lazy loaded for dual-DB setup)
    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
    const KnowledgeGraphTaxonomy = getLazyModel<IKnowledgeGraphTaxonomy>('KnowledgeGraphTaxonomy');

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Get taxonomy
    const taxonomy = await KnowledgeGraphTaxonomy.findOne({ tenantId, indexId }).lean();
    if (!taxonomy) {
      res.status(404).json({
        error: 'Taxonomy not found',
        message: 'No taxonomy configured for this index',
        nextSteps: {
          setupTaxonomy: `POST /api/indexes/${indexId}/kg-taxonomy/setup`,
        },
      });
      return;
    }

    res.json({
      taxonomyId: taxonomy._id,
      version: taxonomy.version,
      domains: taxonomy.domains,
      taxonomy: taxonomy.taxonomy,
      customDomainFiles: taxonomy.customDomainFiles,
      organizationProfileFile: taxonomy.organizationProfileFile,
      createdAt: taxonomy.createdAt,
      updatedAt: taxonomy.updatedAt,
      statistics: {
        categoriesCount: taxonomy.taxonomy.categories.length,
        productsCount: taxonomy.taxonomy.products.length,
        attributesCount: taxonomy.taxonomy.attributes.length,
        departmentBoundariesCount: taxonomy.taxonomy.departmentBoundaries.length,
      },
    });
  } catch (error) {
    logger.error('Get taxonomy failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: 'Failed to get taxonomy',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * PUT /:indexId/kg-taxonomy
 *
 * Update taxonomy configuration for an index. Reloads domain definitions and/or
 * organization profile, validates, and optionally triggers re-classification of
 * existing documents.
 *
 * Body (JSON):
 *   - domain: Domain ID (optional, defaults to existing)
 *   - organizationProfilePath: Path to updated org profile (optional, defaults to existing)
 *   - reclassify: boolean - Trigger re-classification of existing documents [optional, default: false]
 *   - priority: 'low' | 'normal' | 'high' [optional, default: 'normal']
 *
 * Response:
 *   - setupJobId: Job ID for taxonomy reload (if domain/org changed)
 *   - reclassifyJobId: Job ID for re-classification (if reclassify=true)
 *   - status: 'QUEUED'
 *   - newVersion: New taxonomy version
 *   - pollUrls: URLs to poll for status
 */
router.put('/:indexId/kg-taxonomy', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;
    const { domain, organizationProfilePath, reclassify, priority } = req.body;

    // Get models (lazy loaded for dual-DB setup)
    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
    const KnowledgeGraphTaxonomy = getLazyModel<IKnowledgeGraphTaxonomy>('KnowledgeGraphTaxonomy');

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Check if taxonomy exists
    const existingTaxonomy = await KnowledgeGraphTaxonomy.findOne({ tenantId, indexId }).lean();
    if (!existingTaxonomy) {
      res.status(404).json({
        error: 'Taxonomy not found',
        message: 'No taxonomy configured for this index. Use POST to create one first.',
        nextSteps: {
          setupTaxonomy: `POST /api/indexes/${indexId}/kg-taxonomy/setup`,
        },
      });
      return;
    }

    // Determine what changed
    const domainChanged = domain && domain !== existingTaxonomy.domains[0];
    const orgProfileChanged =
      organizationProfilePath &&
      organizationProfilePath !== existingTaxonomy.organizationProfileFile;

    if (!domainChanged && !orgProfileChanged && !reclassify) {
      res.status(400).json({
        error: 'No changes provided',
        message:
          'Must provide domain, organizationProfilePath, or reclassify=true to update taxonomy',
        currentDomain: existingTaxonomy.domains[0],
        currentOrgProfile: existingTaxonomy.organizationProfileFile,
      });
      return;
    }

    const response: any = {
      success: true,
      status: 'QUEUED',
      indexId,
      changes: {
        domainChanged,
        orgProfileChanged,
        willReclassify: reclassify || false,
      },
      pollUrls: {},
    };

    // If domain or org profile changed, reload taxonomy
    if (domainChanged || orgProfileChanged) {
      // Resolve domain definition path — custom domains pass through as-is.
      const domainToUse = domain || existingTaxonomy.domains[0];
      const isDatabaseDomain = isDatabaseDomainId(domainToUse);
      // Validate built-in domain IDs to prevent path traversal.
      if (!isDatabaseDomain && !DOMAIN_ID_PATTERN.test(domainToUse)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_DOMAIN', message: 'Invalid domain ID format' },
        });
        return;
      }
      const domainDefinitionPaths = [
        isDatabaseDomain ? domainToUse : resolveBuiltInDomainPath(domainToUse),
      ];

      const orgProfileToUse = organizationProfilePath || existingTaxonomy.organizationProfileFile;

      // Create setup job data
      const setupJobData: TaxonomySetupJobData = {
        indexId,
        tenantId,
        domainDefinitionPaths,
        organizationProfilePath: orgProfileToUse,
        priority: priority || 'normal',
      };

      // Enqueue setup job
      const setupJobId = `taxonomy-setup:${indexId}:${Date.now()}`;
      const setupQueue = createQueue('taxonomy-setup');

      try {
        await setupQueue.add(setupJobId, setupJobData, {
          jobId: setupJobId,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          priority: priority === 'high' ? 1 : priority === 'low' ? 10 : 5,
        });

        logger.info('Taxonomy update job enqueued', {
          setupJobId,
          indexId,
          tenantId,
          domain: domainToUse,
        });
      } finally {
        await setupQueue.close();
      }

      response.setupJobId = setupJobId;
      response.pollUrls.setup = `/api/indexes/${indexId}/kg-taxonomy/setup/${setupJobId}`;
    }

    // If reclassify requested, enqueue re-classification job
    if (reclassify) {
      const reclassifyJobId = `kg-enrich-${indexId}-${Date.now()}-reclassify`;
      const reclassifyQueue = createQueue('kg-enrichment');

      try {
        await reclassifyQueue.add(
          reclassifyJobId,
          {
            indexId,
            tenantId,
            options: {
              batchSize: 50,
              forceReclassify: true, // Re-process ALL documents regardless of status
            },
            priority: priority || 'normal',
          },
          {
            jobId: reclassifyJobId,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 5000,
            },
            priority: priority === 'high' ? 1 : priority === 'low' ? 10 : 5,
          },
        );

        logger.info('Re-classification job enqueued', {
          reclassifyJobId,
          indexId,
          tenantId,
        });
      } finally {
        await reclassifyQueue.close();
      }

      response.reclassifyJobId = reclassifyJobId;
      response.pollUrls.reclassify = `/api/indexes/${indexId}/kg-enrich/jobs/${reclassifyJobId}`;
    }

    res.status(200).json(response);
  } catch (error) {
    logger.error('Update taxonomy failed', {
      error: error instanceof Error ? error.message : String(error),
      indexId: req.params.indexId,
    });
    res.status(500).json({
      error: 'Failed to update taxonomy',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * DELETE /:indexId/kg-taxonomy
 *
 * Delete taxonomy configuration for an index.
 *
 * Response:
 *   - success: true
 *   - message: Confirmation message
 */
router.delete('/:indexId/kg-taxonomy', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    // Get models (lazy loaded for dual-DB setup)
    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
    const KnowledgeGraphTaxonomy = getLazyModel<IKnowledgeGraphTaxonomy>('KnowledgeGraphTaxonomy');

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Delete taxonomy (tenant isolation in query)
    const result = await KnowledgeGraphTaxonomy.deleteOne({ tenantId, indexId });

    if (result.deletedCount === 0) {
      res.status(404).json({
        error: 'Taxonomy not found',
        message: 'No taxonomy configured for this index',
      });
      return;
    }

    logger.info('Taxonomy deleted', { tenantId, indexId });

    // Invalidate Redis cache so runtime pods stop serving stale data
    try {
      const { getTaxonomyCacheWriter } = await import('../services/taxonomy-cache-writer.js');
      const cacheWriter = getTaxonomyCacheWriter();
      await cacheWriter.invalidate(tenantId, indexId);
    } catch (cacheError) {
      logger.warn('Failed to invalidate taxonomy cache', {
        error: cacheError instanceof Error ? cacheError.message : String(cacheError),
      });
    }

    res.json({
      success: true,
      message: 'Taxonomy deleted successfully',
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    logger.error('Delete taxonomy failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: 'Failed to delete taxonomy',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * PUT /:indexId/kg-toggle
 *
 * Toggle per-index knowledge graph enrichment on or off.
 * Uses dot notation to set `llmConfig.useCases.knowledgeGraph.enabled` without
 * overwriting other llmConfig fields.
 *
 * Body (JSON):
 *   - enabled: boolean [required]
 *
 * Response:
 *   - success: true
 *   - enabled: boolean
 */
router.put('/:indexId/kg-toggle', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      res.status(400).json({
        error: 'Missing or invalid field: enabled',
        message: 'enabled must be a boolean (true or false)',
      });
      return;
    }

    // Get SearchIndex model (lazy loaded for dual-DB setup)
    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

    // First ensure llmConfig is not null — dot notation $set fails on null parents.
    // Use a two-step approach: initialize llmConfig if null, then set the nested field.
    await SearchIndex.findOneAndUpdate(
      applyProjectScopeFilter({ _id: indexId, tenantId, llmConfig: null }, req.tenantContext!),
      { $set: { llmConfig: {} } },
    );

    // Now set the nested field with dot notation (safe since llmConfig is an object)
    const result = await SearchIndex.findOneAndUpdate(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
      { $set: { 'llmConfig.useCases.knowledgeGraph.enabled': enabled } },
      { new: true },
    );

    if (!result) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    logger.info('KG toggle updated', { tenantId, indexId, enabled });

    res.json({
      success: true,
      enabled,
      indexId,
    });
  } catch (error) {
    logger.error('KG toggle failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: 'Failed to update KG toggle',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
