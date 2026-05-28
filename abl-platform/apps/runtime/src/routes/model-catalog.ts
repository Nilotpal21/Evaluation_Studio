/**
 * Model Catalog Route
 *
 * Lists available models from the curated built-in catalog.
 * New models are added through platform releases — no automatic
 * external refresh on read to avoid surprising enterprise tenants.
 *
 * Admins can explicitly refresh from LiteLLM via POST /refresh,
 * or discover gateway models via POST /gateway-discovery.
 *
 * Mount: /api/model-catalog
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { getModelCatalog } from '../services/llm/model-catalog.js';
import { requirePermission } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { tenantRateLimit } from '../middleware/rate-limiter.js';

const log = createLogger('model-catalog-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/model-catalog',
  tags: ['Model Catalog'],
});
const router: RouterType = openapi.router;

// Any authenticated user can browse the catalog + rate limiting
router.use(authMiddleware);
router.use(tenantRateLimit('request'));

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const modelCapabilitiesSchema = z.object({
  supportsTools: z.boolean().describe('Whether the model supports tool calling'),
  supportsVision: z.boolean().describe('Whether the model supports vision/image input'),
  supportsStreaming: z.boolean().describe('Whether the model supports streaming responses'),
  supportsRealtimeVoice: z
    .boolean()
    .optional()
    .describe('Whether the model supports realtime voice (audio-in/audio-out)'),
  contextWindow: z.number().describe('Maximum context window size in tokens'),
});

const modelPricingSchema = z
  .object({
    inputCostPer1k: z.number().describe('Cost per 1000 input tokens'),
    outputCostPer1k: z.number().describe('Cost per 1000 output tokens'),
  })
  .optional()
  .describe('Optional pricing information');

const catalogModelSchema = z.object({
  modelId: z.string().describe('Unique model identifier'),
  provider: z.string().describe('LLM provider name (e.g., anthropic, openai)'),
  displayName: z.string().describe('Human-readable model name'),
  source: z.enum(['litellm_data', 'platform', 'gateway']).describe('Source of model information'),
  capabilities: modelCapabilitiesSchema.describe('Model capabilities'),
  pricing: modelPricingSchema,
});

const listModelsQuerySchema = z.object({
  provider: z.string().optional().describe('Filter models by provider'),
});

const listModelsResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  models: z.array(catalogModelSchema).describe('List of available models'),
  total: z.number().describe('Total number of models'),
});

const getModelDetailsResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  model: catalogModelSchema.describe('Model details'),
});

const refreshCatalogResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  message: z.string().describe('Status message'),
  totalModels: z.number().describe('Total number of models in catalog after refresh'),
});

const gatewayDiscoveryRequestSchema = z.object({
  gatewayUrl: z.string().url().describe('LiteLLM gateway URL for model discovery'),
});

const gatewayDiscoveryResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  models: z.array(catalogModelSchema).describe('Models discovered from the gateway'),
  total: z.number().describe('Number of models discovered'),
  message: z.string().optional().describe('Additional status message'),
});

// =============================================================================
// ROUTES
// =============================================================================

/**
 * GET /api/model-catalog — List available models
 *
 * Lists models from the built-in catalog, optionally filtered by provider.
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'List available models',
    description: 'List models from the built-in catalog. Optionally filter by provider.',
    query: listModelsQuerySchema,
    response: listModelsResponseSchema,
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const catalog = getModelCatalog();
      const provider = req.query.provider ? String(req.query.provider) : undefined;
      const models = catalog.listModels({ provider });

      res.json({
        success: true,
        models,
        total: models.length,
      });
    } catch (error: any) {
      log.error('Failed to list model catalog', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to list model catalog' });
    }
  },
);

/**
 * GET /api/model-catalog/:modelId — Get model details
 *
 * Retrieve detailed information about a specific model by ID.
 */
openapi.route(
  'get',
  '/:modelId',
  {
    summary: 'Get model details',
    description: 'Retrieve detailed information about a specific model by its ID.',
    response: getModelDetailsResponseSchema,
  },
  async (req, res) => {
    try {
      const catalog = getModelCatalog();
      const model = catalog.getModel(req.params.modelId);

      if (!model) {
        res.status(404).json({ success: false, error: 'Model not found in catalog' });
        return;
      }

      res.json({ success: true, model });
    } catch (error: any) {
      log.error('Failed to get model details', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to get model details' });
    }
  },
);

/**
 * POST /api/model-catalog/refresh — Refresh the catalog from LiteLLM
 *
 * Force a refresh of the model catalog from LiteLLM remote data.
 * Requires credential:write permission (admin-only).
 */
openapi.route(
  'post',
  '/refresh',
  {
    summary: 'Refresh model catalog',
    description: 'Force refresh the catalog from LiteLLM remote data. Admin-only.',
    response: refreshCatalogResponseSchema,
  },
  requirePermission('credential:write'),
  async (_req, res) => {
    try {
      const catalog = getModelCatalog();
      await catalog.refreshCatalog();

      const models = catalog.listModels();
      res.json({
        success: true,
        message: 'Catalog refreshed',
        totalModels: models.length,
      });
    } catch (error: any) {
      log.error('Failed to refresh catalog', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to refresh catalog' });
    }
  },
);

/**
 * POST /api/model-catalog/gateway-discovery — Discover models from a LiteLLM gateway
 *
 * Discover available models from a remote LiteLLM gateway.
 * Requires credential:write permission (admin-only) to prevent SSRF abuse.
 */
openapi.route(
  'post',
  '/gateway-discovery',
  {
    summary: 'Discover gateway models',
    description: 'Discover available models from a remote LiteLLM gateway. Admin-only.',
    body: gatewayDiscoveryRequestSchema,
    response: gatewayDiscoveryResponseSchema,
  },
  requirePermission('credential:write'),
  async (req, res) => {
    try {
      const parseResult = gatewayDiscoveryRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({ success: false, error: 'Invalid request body' });
        return;
      }

      const { gatewayUrl } = parseResult.data;
      const catalog = getModelCatalog();
      const models = await catalog.listGatewayModels(gatewayUrl);

      if (models.length === 0) {
        res.json({
          success: true,
          models: [],
          total: 0,
          message: 'No models discovered. Ensure the URL is correct and accessible.',
        });
        return;
      }

      res.json({
        success: true,
        models,
        total: models.length,
      });
    } catch (error: any) {
      log.error('Failed gateway discovery', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed gateway discovery' });
    }
  },
);

export default router;
