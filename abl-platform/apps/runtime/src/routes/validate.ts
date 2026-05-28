/**
 * Validate API Route
 *
 * Runs preflight validation checks against project agents.
 * Mounted at /api/projects/:projectId/validate
 *
 * POST /   Run preflight validation for specified (or all) agents
 */

import { type Router as RouterType } from 'express';
import { z } from 'zod';
import { createOpenAPIRouter, getValidatedRequestData } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { toErrorResponse } from '@agent-platform/shared-kernel';
import { runPreflightValidation } from '../services/preflight-validation-service.js';
import { findProjectAgentsForProject } from '../repos/project-repo.js';

const log = createLogger('validate-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/validate',
  tags: ['Validate'],
  validateRequests: true,
  wrapAsyncHandlers: true,
  onValidationError: (_error, _req, res) => {
    res
      .status(400)
      .json(
        toErrorResponse(
          'INVALID_INPUT',
          'Request body must include an optional "agentNames" array',
        ),
      );
  },
});
const router: RouterType = openapi.router;

// Middleware chain (same as diagnostics route)
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

/** Merged params from parent route (/api/projects/:projectId) */
interface ValidateParams {
  projectId: string;
}

const validateRequestBodySchema = z
  .object({
    agentNames: z.array(z.string()).optional(),
  })
  .optional()
  .transform((value) => value ?? {});

const validateResponseSchema = z.object({
  success: z.boolean(),
  data: z.unknown(),
});

/**
 * POST /api/projects/:projectId/validate
 * Run preflight validation for the given agent names (or all project agents).
 *
 * Body: { agentNames?: string[] }
 * Response: PreflightReport
 */
openapi.route(
  'post',
  '/',
  {
    summary: 'Run preflight validation',
    description:
      'Runs quick diagnostic checks for the provided agent names, or for all project agents when no names are supplied.',
    body: validateRequestBodySchema,
    response: validateResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'deployment:create'))) return;

      const validatedParams = getValidatedRequestData(res)?.params as ValidateParams | undefined;
      const validatedBody = getValidatedRequestData(res)?.body as
        | z.infer<typeof validateRequestBodySchema>
        | undefined;
      const projectId = validatedParams?.projectId ?? req.params.projectId;
      const tenantId = req.tenantContext!.tenantId;

      let agentNames = validatedBody?.agentNames ?? [];

      // If no agent names provided, discover all agents in the project
      if (agentNames.length === 0) {
        const allAgents = await findProjectAgentsForProject(projectId, { tenantId });
        agentNames = (allAgents as Array<{ name: string }>).map((a) => a.name);
      }

      const report = await runPreflightValidation({
        tenantId,
        projectId,
        agentNames,
      });

      res.json({ success: true, data: report });
    } catch (err) {
      const projectId = req.params.projectId;
      log.error('Preflight validation failed', {
        error: err instanceof Error ? err.message : String(err),
        projectId,
      });
      res.status(500).json(toErrorResponse('VALIDATION_FAILED', 'Preflight validation failed'));
    }
  },
);

export default router;
