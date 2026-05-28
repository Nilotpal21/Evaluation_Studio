/**
 * Diagnostics API Routes
 *
 * Unified diagnostic engine endpoints for agent and session health checks.
 * Mounted at /api/projects/:projectId/diagnostics
 *
 * GET /agents/:agentName       Quick (infra-only) diagnostic for an agent
 * GET /sessions/:sessionId     Full diagnostic for a session (depth configurable)
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
import { getDiagnosticEngine, ensureAnalyzersReady } from '../services/diagnostics/engine.js';
import type { DiagnosticDepth } from '../services/diagnostics/types.js';
import { resolveProjectSessionAccess } from '../middleware/session-access.js';

const log = createLogger('diagnostics-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/diagnostics',
  tags: ['Diagnostics'],
  validateRequests: true,
  wrapAsyncHandlers: true,
});
const router: RouterType = openapi.router;

// Middleware chain
router.use(authMiddleware);
router.use(requireProjectScope('projectId', { concealOutOfScope: true }));
router.use(tenantRateLimit('request'));

const VALID_DEPTHS: DiagnosticDepth[] = ['quick', 'standard', 'deep'];

/** Merged params from parent route (/api/projects/:projectId) + this route */
interface AgentDiagParams {
  projectId: string;
  agentName: string;
}
interface SessionDiagParams {
  projectId: string;
  sessionId: string;
}

const diagnosticResponseSchema = z.object({
  success: z.boolean(),
  data: z.unknown(),
});

/**
 * GET /agents/:agentName
 * Quick (infra-only) diagnostic for a named agent.
 */
openapi.route(
  'get',
  '/agents/:agentName',
  {
    summary: 'Get agent diagnostic',
    description: 'Runs a quick diagnostics pass for a named project agent.',
    response: diagnosticResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'agent:read'))) return;

      const validatedParams = getValidatedRequestData(res)?.params as AgentDiagParams | undefined;
      const projectId = validatedParams?.projectId ?? req.params.projectId;
      const agentName = validatedParams?.agentName ?? req.params.agentName;
      const tenantId = req.tenantContext!.tenantId;

      const engine = getDiagnosticEngine();
      await ensureAnalyzersReady();
      const report = await engine.diagnose({
        tenantId,
        projectId,
        agentName,
        depth: 'quick',
      });

      res.json({ success: true, data: report });
    } catch (err) {
      const projectId = req.params.projectId;
      const agentName = req.params.agentName;
      log.error('Agent diagnostic failed', {
        error: err instanceof Error ? err.message : String(err),
        agentName,
        projectId,
      });
      res.status(500).json(toErrorResponse('DIAGNOSTIC_FAILED', 'Diagnostic analysis failed'));
    }
  },
);

/**
 * GET /sessions/:sessionId
 * Full diagnostic for a session. Accepts ?depth=quick|standard|deep (default: standard).
 */
openapi.route(
  'get',
  '/sessions/:sessionId',
  {
    summary: 'Get session diagnostic',
    description:
      'Runs diagnostics for a session with optional depth selection, defaulting to standard.',
    response: diagnosticResponseSchema,
  },
  async (req, res) => {
    try {
      const validatedParams = getValidatedRequestData(res)?.params as SessionDiagParams | undefined;
      const projectId = validatedParams?.projectId ?? req.params.projectId;
      const sessionId = validatedParams?.sessionId ?? req.params.sessionId;
      const sessionAccess = await resolveProjectSessionAccess(req, {
        sessionId,
        projectId,
        requiredPermission: 'session:read',
      });
      if ('denial' in sessionAccess) {
        const body: Record<string, unknown> = {
          success: false,
          error: {
            code: 'ACCESS_DENIED',
            message: sessionAccess.denial.publicError,
          },
        };
        if (sessionAccess.denial.publicMessage) {
          body.message = sessionAccess.denial.publicMessage;
        }
        res.status(sessionAccess.denial.statusCode).json(body);
        return;
      }

      const tenantId = req.tenantContext!.tenantId;

      const depthParam = (req.query.depth as string) || 'standard';
      const depth: DiagnosticDepth = VALID_DEPTHS.includes(depthParam as DiagnosticDepth)
        ? (depthParam as DiagnosticDepth)
        : 'standard';

      // Try to resolve the agent name from the session
      let agentName =
        typeof sessionAccess.session.agentName === 'string'
          ? sessionAccess.session.agentName
          : undefined;
      try {
        if (!agentName) {
          const { getRuntimeExecutor } = await import('../services/runtime-executor.js');
          const executor = getRuntimeExecutor();
          if (executor) {
            const session = executor.getSession(sessionId);
            if (session) {
              agentName = session.agentName;
            }
          }
        }
      } catch {
        // Session lookup is best-effort — diagnostics still work without it
      }

      const engine = getDiagnosticEngine();
      await ensureAnalyzersReady();
      const report = await engine.diagnose({
        tenantId,
        projectId,
        agentName,
        sessionId,
        depth,
      });

      res.json({ success: true, data: report });
    } catch (err) {
      const projectId = req.params.projectId;
      const sessionId = req.params.sessionId;
      log.error('Session diagnostic failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId,
        projectId,
      });
      res.status(500).json(toErrorResponse('DIAGNOSTIC_FAILED', 'Diagnostic analysis failed'));
    }
  },
);

export default router;
