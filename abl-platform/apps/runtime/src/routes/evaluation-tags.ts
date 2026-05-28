/**
 * Evaluation Tag Config API Routes
 *
 * Mounted at /api/projects/:projectId/evaluation-tags
 *
 * GET    /        List all evaluation tag configs for a project
 * PUT    /:tag    Upsert a tag config
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter, getValidatedRequestData } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('evaluation-tags-route');

// Lazy import to avoid circular dependencies at startup
async function getEvaluationTagConfigModel() {
  const { EvaluationTagConfig } = await import('../models/EvaluationTagConfig.js');
  return EvaluationTagConfig;
}

// ─── Router setup ───────────────────────────────────────────────────────────

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/evaluation-tags',
  tags: ['Evaluation Tags'],
  validateRequests: true,
  wrapAsyncHandlers: true,
  onValidationError: (error, _req, res) => {
    const firstIssue = error.issues[0];
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: firstIssue?.message ?? 'Invalid request',
      },
    });
  },
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

const upsertEvaluationTagParamsSchema = z.object({
  projectId: z.string(),
  tag: z.string(),
});

const upsertEvaluationTagBodySchema = z.object({
  direction: z
    .string({
      required_error: 'direction is required and must be "higher_is_better" or "lower_is_better"',
      invalid_type_error:
        'direction is required and must be "higher_is_better" or "lower_is_better"',
    })
    .refine(
      (value) => value === 'higher_is_better' || value === 'lower_is_better',
      'direction is required and must be "higher_is_better" or "lower_is_better"',
    ),
  threshold: z.number({
    required_error: 'threshold is required and must be a number',
    invalid_type_error: 'threshold is required and must be a number',
  }),
  displayName: z.string().optional(),
  description: z.string().optional(),
});

// ─── GET / ──────────────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/',
  {
    summary: 'List evaluation tag configs',
    description: 'Returns all evaluation tag configs for the current project.',
    response: z.object({
      success: z.boolean(),
      data: z.array(z.record(z.unknown())),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const validatedParams = getValidatedRequestData(res)?.params as
        | { projectId: string }
        | undefined;
      const projectId = validatedParams?.projectId ?? req.params.projectId;

      const Model = await getEvaluationTagConfigModel();
      const configs = await Model.find({ tenantId, projectId }).lean();

      res.json({ success: true, data: configs });
    } catch (error) {
      log.error('Failed to list evaluation tag configs', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to list evaluation tag configs',
        },
      });
    }
  },
);

// ─── PUT /:tag ──────────────────────────────────────────────────────────────

openapi.route(
  'put',
  '/:tag',
  {
    summary: 'Upsert an evaluation tag config',
    description: 'Creates or updates an evaluation tag config for the given tag name.',
    params: upsertEvaluationTagParamsSchema,
    body: upsertEvaluationTagBodySchema,
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'project:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const validated = getValidatedRequestData(res);
      const params = validated?.params as
        | z.infer<typeof upsertEvaluationTagParamsSchema>
        | undefined;
      const body = validated?.body as z.infer<typeof upsertEvaluationTagBodySchema> | undefined;
      const projectId = params?.projectId ?? req.params.projectId;
      const tag = params?.tag ?? req.params.tag;
      const { direction, threshold, displayName, description } = body ?? req.body;

      const Model = await getEvaluationTagConfigModel();
      const config = await Model.findOneAndUpdate(
        { tenantId, projectId, tag },
        {
          $set: {
            direction,
            threshold,
            ...(displayName !== undefined && { displayName }),
            ...(description !== undefined && { description }),
          },
          $setOnInsert: { tenantId, projectId, tag },
        },
        { new: true, upsert: true },
      );

      log.info('Evaluation tag config upserted', {
        tenantId,
        projectId,
        tag,
      });
      res.json({ success: true, data: config.toObject() });
    } catch (error) {
      log.error('Failed to upsert evaluation tag config', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        tag: req.params.tag,
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to upsert evaluation tag config',
        },
      });
    }
  },
);

export default openapi.router;
