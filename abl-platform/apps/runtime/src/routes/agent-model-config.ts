/**
 * Agent Model Config Routes
 *
 * Per-agent model configuration: default model, operation models, temperature, maxTokens.
 * Mounted at /api/projects/:projectId/agents/:agentName/model-config
 *
 * GET  / — Load agent model config (or empty defaults)
 * PUT  / — Upsert agent model config
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import {
  findProjectAgentForProject,
  findAgentModelConfig,
  upsertAgentModelConfig,
} from '../repos/project-repo.js';
import { createLogger } from '@abl/compiler/platform';
import { invalidateModelResolutionCaches } from '../services/llm/model-cache-invalidation.js';

const log = createLogger('agent-model-config');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/agents/:agentName/model-config',
  tags: ['Agent Model Config'],
});
const router: RouterType = openapi.router;

// All routes require authentication
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const operationModelsSchema = z
  .record(z.string())
  .describe('Mapping of operation names to model identifiers');

const agentModelConfigSchema = z.object({
  projectId: z.string().describe('Project ID'),
  agentName: z.string().describe('Agent name'),
  defaultModel: z.string().nullable().describe('Default model identifier, or null for no default'),
  operationModels: operationModelsSchema.describe('Per-operation model overrides'),
  temperature: z
    .number()
    .nullable()
    .describe('Temperature parameter (0-2), or null for no override'),
  maxTokens: z.number().nullable().describe('Maximum tokens, or null for no limit'),
  hyperParameters: z
    .record(z.unknown())
    .nullable()
    .describe('Flexible parameter bag for all hyperparameters'),
  useResponsesApi: z
    .boolean()
    .nullable()
    .describe('OpenAI only: override for Responses API vs Chat Completions'),
  useStreaming: z
    .boolean()
    .nullable()
    .describe('Override for streaming vs non-streaming LLM calls'),
});

const getAgentModelConfigResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  config: agentModelConfigSchema.describe('Agent model configuration'),
});

const upsertAgentModelConfigRequestSchema = z.object({
  defaultModel: z.string().nullable().optional().describe('Default model identifier'),
  operationModels: operationModelsSchema.optional().describe('Per-operation model overrides'),
  temperature: z.number().nullable().optional().describe('Temperature parameter (0-2)'),
  maxTokens: z.number().nullable().optional().describe('Maximum tokens'),
  hyperParameters: z
    .record(z.unknown())
    .nullable()
    .optional()
    .describe('Flexible parameter bag for all hyperparameters'),
  useResponsesApi: z
    .boolean()
    .nullable()
    .optional()
    .describe('OpenAI only: Responses API override'),
  useStreaming: z
    .boolean()
    .nullable()
    .optional()
    .describe('Override for streaming vs non-streaming'),
});

const upsertAgentModelConfigResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  config: agentModelConfigSchema.describe('Updated agent model configuration'),
});

// =============================================================================
// ENDPOINTS
// =============================================================================

/**
 * GET /api/projects/:projectId/agents/:agentName/model-config
 * Load agent model config or return empty defaults.
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'Get agent model configuration',
    description:
      'Retrieve the model configuration for a specific agent, or empty defaults if not configured',
    response: getAgentModelConfigResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'agent:read'))) return;

      const { projectId, agentName } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const config = await findAgentModelConfig(projectId, agentName, tenantId);

      if (!config) {
        // Return empty defaults
        res.json({
          success: true,
          config: {
            projectId,
            agentName,
            defaultModel: null,
            operationModels: {},
            temperature: null,
            maxTokens: null,
            hyperParameters: null,
            useResponsesApi: null,
            useStreaming: null,
          },
        });
        return;
      }

      const opModels =
        typeof config.operationModels === 'string'
          ? JSON.parse(config.operationModels || '{}')
          : (config.operationModels ?? {});

      res.json({
        success: true,
        config: {
          ...config,
          operationModels: opModels,
        },
      });
    } catch (err) {
      log.error('Failed to get agent model config', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to get agent model config' });
    }
  },
);

/**
 * PUT /api/projects/:projectId/agents/:agentName/model-config
 * Upsert agent model config.
 */
openapi.route(
  'put',
  '/',
  {
    summary: 'Update agent model configuration',
    description:
      'Upsert the model configuration for a specific agent, updating one or more parameters',
    body: upsertAgentModelConfigRequestSchema,
    response: upsertAgentModelConfigResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'agent:update'))) return;

      const { projectId, agentName } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      // Verify agent exists in project
      const agent = await findProjectAgentForProject(projectId, agentName, tenantId);
      if (!agent) {
        res.status(404).json({ success: false, error: 'Agent not found in project' });
        return;
      }

      const {
        defaultModel,
        operationModels,
        temperature,
        maxTokens,
        hyperParameters,
        useResponsesApi,
        useStreaming,
      } = req.body;

      // Additional validation for temperature bounds (Zod schema has basic type check)
      if (
        temperature !== undefined &&
        temperature !== null &&
        (temperature < 0 || temperature > 2)
      ) {
        res
          .status(400)
          .json({ success: false, error: 'temperature must be a number between 0 and 2' });
        return;
      }

      // Additional validation for maxTokens bounds (Zod schema has basic type check)
      if (maxTokens !== undefined && maxTokens !== null && maxTokens < 1) {
        res.status(400).json({ success: false, error: 'maxTokens must be a positive number' });
        return;
      }

      const requestedModelIds = [
        typeof defaultModel === 'string' && defaultModel.length > 0 ? defaultModel : undefined,
        ...Object.values((operationModels ?? {}) as Record<string, string>).filter(
          (modelId): modelId is string => typeof modelId === 'string' && modelId.length > 0,
        ),
      ].filter((modelId): modelId is string => typeof modelId === 'string');

      if (requestedModelIds.length > 0) {
        const { ModelConfig } = await import('@agent-platform/database/models');
        const uniqueModelIds = [...new Set(requestedModelIds)];
        const foundModelIds = await ModelConfig.distinct('modelId', {
          projectId,
          tenantId,
          modelId: { $in: uniqueModelIds },
        });
        const foundModelIdSet = new Set(foundModelIds);
        if (uniqueModelIds.some((modelId) => !foundModelIdSet.has(modelId))) {
          res.status(400).json({
            success: false,
            error: 'Selected model must belong to this project',
          });
          return;
        }
      }

      const update: Parameters<typeof upsertAgentModelConfig>[0] = {
        projectId,
        agentName,
        tenantId,
      };

      if (Object.prototype.hasOwnProperty.call(req.body, 'defaultModel')) {
        update.defaultModel = defaultModel ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(req.body, 'operationModels')) {
        update.operationModels = operationModels ?? {};
      }

      if (Object.prototype.hasOwnProperty.call(req.body, 'temperature')) {
        update.temperature = temperature ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(req.body, 'maxTokens')) {
        update.maxTokens = maxTokens ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(req.body, 'hyperParameters')) {
        update.hyperParameters = hyperParameters ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(req.body, 'useResponsesApi')) {
        update.useResponsesApi = useResponsesApi ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(req.body, 'useStreaming')) {
        update.useStreaming = useStreaming ?? null;
      }

      const config = await upsertAgentModelConfig(update);

      if (!config) {
        res.status(404).json({ success: false, error: 'Project not found or access denied' });
        return;
      }

      log.info('Agent model config saved', {
        projectId,
        agentName,
        defaultModel: config.defaultModel,
      });

      // Invalidate model resolution caches so the new config takes effect immediately
      invalidateModelResolutionCaches(tenantId);

      // Defense-in-depth: warn if defaultModel has no project ModelConfig
      if (config.defaultModel) {
        const { ModelConfig } = await import('@agent-platform/database/models');
        const projectModelConfig = await ModelConfig.findOne({
          projectId,
          tenantId,
          modelId: config.defaultModel,
        }).lean();
        if (!projectModelConfig) {
          log.warn('Agent model config references model with no project ModelConfig entry', {
            projectId,
            agentName,
            defaultModel: config.defaultModel,
          });
        }
      }

      const opModels =
        typeof config.operationModels === 'string'
          ? JSON.parse(config.operationModels || '{}')
          : (config.operationModels ?? {});

      res.json({
        success: true,
        config: {
          ...config,
          operationModels: opModels,
        },
      });
    } catch (err) {
      log.error('Failed to save agent model config', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to save agent model config' });
    }
  },
);

export default openapi.router;
