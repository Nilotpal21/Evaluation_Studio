/**
 * Model Capabilities Route
 *
 * Returns hyperparameter definitions and capability metadata for a given model ID.
 * Used by Studio UI to render dynamic parameter controls.
 *
 * Mount: /api/model-capabilities
 */

import { type Response, type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import {
  getModelRegistryEntry,
  getHyperParameters,
  getModelCapabilities,
} from '@abl/compiler/platform/llm/model-capabilities.js';
import { modelSupportsResponsesApi } from '@abl/compiler/platform/llm/model-registry.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('model-capabilities-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/model-capabilities',
  tags: ['Model Capabilities'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);

// =============================================================================
// ROUTES
// =============================================================================

const hyperParameterSchema: z.ZodType = z.lazy(() =>
  z.object({
    type: z.string(),
    name: z.string(),
    unifiedParam: z.string(),
    displayName: z.string(),
    required: z.boolean(),
    defaultValue: z.union([z.number(), z.string(), z.boolean()]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    description: z.string(),
    valueMap: z.array(z.string()).optional(),
    options: z.array(hyperParameterSchema).optional(),
    hyperParameters: z.array(hyperParameterSchema).optional(),
    readonly: z.boolean().optional(),
    placeholder: z.string().optional(),
  }),
);

const responseSchema = z.object({
  success: z.literal(true),
  modelId: z.string(),
  provider: z.string(),
  hyperParameters: z.array(hyperParameterSchema),
  capabilities: z.array(z.string()),
  supportsTools: z.boolean(),
  supportsVision: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsRealtimeVoice: z.boolean(),
  supportsParallelToolCalls: z.boolean(),
  supportsStructuredOutput: z.boolean(),
  isReasoningModel: z.boolean(),
  supportsReasoningEffort: z.boolean(),
  supportsThinking: z.boolean(),
  supportsThinkingBudget: z.boolean(),
  temperatureDisabled: z.boolean(),
  topPDisabled: z.boolean(),
  supportsResponsesApi: z.boolean(),
  contextWindow: z.number(),
});

const capabilitiesQuerySchema = z.object({
  modelId: z.string().min(1),
});

function sendModelCapabilities(modelId: string, res: Response): void {
  try {
    const registryEntry = getModelRegistryEntry(modelId);
    const caps = getModelCapabilities(modelId);

    const capsList = registryEntry?.capabilities ?? [];

    // Inject platform-wide hyperParameters that apply to all models
    const baseHyperParameters = getHyperParameters(modelId);
    const ctxWindow = registryEntry?.contextWindow ?? 128_000;
    const ctxLabel =
      ctxWindow >= 1_000_000
        ? `${(ctxWindow / 1_000_000).toFixed(1)}M`
        : `${Math.round(ctxWindow / 1000)}K`;
    const compactionThresholdParam = {
      type: 'rangeSlider',
      name: 'compactionThreshold',
      unifiedParam: 'compactionThreshold',
      displayName: 'Compaction Threshold',
      required: false,
      defaultValue: 0.8,
      min: 0.1,
      max: 1,
      step: 0.05,
      description: `Context-usage ratio at which auto-compaction triggers. Model context window: ${ctxLabel} tokens. Default 0.8 = compaction at ~${Math.round((ctxWindow * 0.8) / 1000)}K tokens. Lower values compact earlier.`,
    };
    const hyperParameters = [...baseHyperParameters, compactionThresholdParam];

    res.json({
      success: true,
      modelId,
      provider: registryEntry?.provider ?? caps.provider,
      hyperParameters,
      capabilities: capsList,
      supportsTools: registryEntry?.supportsTools ?? caps.supportsTools,
      supportsVision: capsList.includes('imageToText'),
      supportsStreaming: registryEntry?.supportsStreaming ?? true,
      supportsRealtimeVoice: registryEntry?.supportsRealtimeVoice ?? false,
      supportsParallelToolCalls:
        registryEntry?.supportsParallelToolCalls ?? caps.supportsParallelToolCalls,
      supportsStructuredOutput:
        registryEntry?.supportsStructuredOutput ?? caps.supportsStructuredOutput,
      isReasoningModel: caps.isReasoningModel,
      supportsReasoningEffort: caps.supportsReasoningEffort,
      supportsThinking: caps.supportsThinking,
      supportsThinkingBudget: caps.supportsThinkingBudget,
      temperatureDisabled: caps.temperatureDisabled,
      topPDisabled: caps.topPDisabled,
      supportsResponsesApi: modelSupportsResponsesApi(modelId),
      contextWindow: ctxWindow,
    });
  } catch (error: unknown) {
    log.error('Failed to get model capabilities', {
      error: error instanceof Error ? error.message : String(error),
      modelId,
    });
    res.status(500).json({ success: false, error: 'Failed to get model capabilities' });
  }
}

/**
 * GET /api/model-capabilities?modelId=...
 *
 * Preferred form. Query parameter transport preserves provider-native model IDs
 * that contain slashes, for example meta-llama/Llama-3.3-70B-Instruct-Turbo.
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'Get model capabilities',
    description:
      'Returns hyperparameter definitions and capability metadata for a model ID. Use this query route for model IDs that contain slashes.',
    query: capabilitiesQuerySchema,
    response: responseSchema,
  },
  async (req, res) => {
    const modelId = typeof req.query.modelId === 'string' ? req.query.modelId.trim() : '';
    if (!modelId) {
      res.status(400).json({ success: false, error: 'modelId query parameter is required' });
      return;
    }

    sendModelCapabilities(modelId, res);
  },
);

/**
 * GET /api/model-capabilities/:modelId
 *
 * Legacy path form for slash-free model IDs.
 */
openapi.route(
  'get',
  '/:modelId',
  {
    summary: 'Get model capabilities and hyperparameters',
    description:
      'Returns hyperparameter definitions and capability metadata for dynamic UI rendering.',
    params: z.object({ modelId: z.string() }),
    response: responseSchema,
  },
  async (req, res) => {
    sendModelCapabilities(req.params.modelId, res);
  },
);

export default router;
