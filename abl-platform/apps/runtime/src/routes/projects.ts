/**
 * Projects API Routes
 *
 * Project-level detail endpoint.
 * Mounted at /api/projects/:projectId
 *
 * GET /  Get project detail
 */

import { type Router as RouterType, type Request, type Response } from 'express';
import { createOpenAPIRouter, getValidatedRequestData } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { Project } from '@agent-platform/database/models';
import { createLogger } from '@abl/compiler/platform';

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId',
  tags: ['Projects'],
  validateRequests: true,
  wrapAsyncHandlers: true,
});
const router: RouterType = openapi.router;
const log = createLogger('projects-route');

// Middleware chain
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// ─── Response Schema ────────────────────────────────────────────────────────

const projectDetailResponseSchema = z.object({
  success: z.boolean(),
  project: z.object({
    _id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    entryAgentName: z.string().nullable(),
    kind: z.enum(['application', 'module']),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
});

// ─── GET / ──────────────────────────────────────────────────────────────────

/**
 * GET /api/projects/:projectId
 * Returns project detail including entryAgentName.
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'Get project detail',
    description: 'Returns project metadata including entry agent configuration.',
    response: projectDetailResponseSchema,
  },
  async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'project:read'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const validatedParams = getValidatedRequestData(res)?.params as
      | { projectId: string }
      | undefined;
    const projectId = validatedParams?.projectId ?? req.params.projectId;

    try {
      const project = await Project.findOne({ _id: projectId, tenantId }).lean();
      if (!project) {
        res.status(404).json({
          success: false,
          error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
        });
        return;
      }

      res.json({
        success: true,
        project: {
          _id: project._id,
          name: project.name,
          slug: project.slug,
          description: project.description ?? null,
          entryAgentName: project.entryAgentName ?? null,
          kind: project.kind,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      });
    } catch (err) {
      log.error('Failed to fetch project', {
        projectId,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'FETCH_FAILED', message: 'Failed to fetch project' },
      });
    }
  },
);

export default router;
