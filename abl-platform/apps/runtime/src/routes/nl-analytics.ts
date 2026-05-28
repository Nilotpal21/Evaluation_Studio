/**
 * NL Analytics API Route
 *
 * Mounted at /api/projects/:projectId/nl-analytics
 *
 * POST   /ask    Ask a question in natural language, get SQL results
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

const log = createLogger('nl-analytics-route');

// ─── Lazy imports ───────────────────────────────────────────────────────────

async function getNLQueryService() {
  const { NLQueryService } = await import('@agent-platform/pipeline-engine');
  return new NLQueryService();
}

// ─── Router setup ───────────────────────────────────────────────────────────

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/nl-analytics',
  tags: ['NL Analytics'],
  validateRequests: true,
  wrapAsyncHandlers: true,
  onValidationError: (error, _req, res) => {
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          error.issues[0]?.message ?? 'Request body must include a non-empty "question" string',
      },
    });
  },
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// ─── POST /ask ──────────────────────────────────────────────────────────────

const askQuestionBodySchema = z.object({
  question: z
    .string({
      required_error: 'Request body must include a non-empty "question" string',
      invalid_type_error: 'Request body must include a non-empty "question" string',
    })
    .trim()
    .min(1, 'Request body must include a non-empty "question" string'),
});

openapi.route(
  'post',
  '/ask',
  {
    summary: 'Ask analytics question in natural language',
    description:
      'Generates SQL from a natural language question, validates and executes it against ClickHouse, and returns results.',
    body: askQuestionBodySchema,
    response: z.object({
      success: z.boolean(),
      data: z.object({
        question: z.string(),
        sql: z.string(),
        data: z.array(z.record(z.unknown())),
        rowCount: z.number(),
      }),
    }),
  },
  async (req, res) => {
    const validatedParams = getValidatedRequestData(res)?.params as
      | { projectId: string }
      | undefined;
    const validatedBody = getValidatedRequestData(res)?.body as
      | z.infer<typeof askQuestionBodySchema>
      | undefined;

    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const projectId = validatedParams?.projectId ?? req.params.projectId;
      const tenantId = req.tenantContext!.tenantId;
      const question = validatedBody?.question ?? '';

      const svc = await getNLQueryService();
      const result = await svc.executeQuery(tenantId, projectId, question);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('NL query failed', {
        error: message,
        projectId: req.params.projectId,
      });

      // Return validation errors as 400, not 500
      if (message.includes('SQL validation failed')) {
        res.status(400).json({
          success: false,
          error: { code: 'SQL_VALIDATION_FAILED', message },
        });
        return;
      }

      res.status(500).json({ success: false, error: 'Failed to execute analytics query' });
    }
  },
);

export default openapi.router;
