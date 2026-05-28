/**
 * Workflows Execute Routes
 *
 * External-facing workflow execution API authenticated via API keys.
 * Supports sync, async (poll), and async (push) modes via ?mode= query param.
 *
 * Two equivalent URL forms for version pinning:
 *   Query-param form:   POST /api/v1/workflows/:workflowId/execute?version=v0.2.0
 *   Path-segment form:  POST /api/v1/workflows/:workflowId/versions/:version/execute
 *
 * Both forms resolve through the same adapter. When both sources supply a
 * version (path segment + query string), the path segment wins because it's
 * more explicit (RESTful resource coordinate).
 *
 * Status poll:
 *   GET /api/v1/workflows/:workflowId/executions/:executionId
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import { hasPermission } from '@agent-platform/shared-auth/rbac';
import { findWorkflowByIdAndTenant, findWorkflowVersion } from '../repos/workflow-repo.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import {
  handleWorkflowExecute,
  ENGINE_FETCH_TIMEOUT_MS,
  type WorkflowExecuteHandlerDeps,
} from './workflow-execute-handler.js';

const log = createLogger('workflows-execute');

// ─── Zod Schemas ──────────────────────────────────────────────────────

export const workflowsExecuteBodySchema = z
  .object({
    input: z.record(z.unknown()).optional().default({}),
    callbackUrl: z.string().url().optional(),
    accessToken: z.string().optional(),
    // executionId MUST be a UUID — engine Zod enforces .uuid() so validating
    // here avoids an UPSTREAM 502 for malformed values and lets us return
    // a proper 400 INVALID_EXECUTION_ID from the runtime boundary.
    executionId: z.string().uuid().optional(),
  })
  .strict();

export const workflowsExecuteQuerySchema = z.object({
  mode: z.enum(['sync', 'async', 'async_push']).default('sync'),
  version: z.string().min(1).optional(),
});

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function buildForwardedEngineHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const authorization = getHeaderValue(req.headers.authorization);
  if (authorization) headers.Authorization = authorization;

  const apiKey = getHeaderValue(req.headers['x-api-key']);
  if (apiKey) headers['x-api-key'] = apiKey;

  const requestId = getHeaderValue(req.headers['x-request-id']);
  if (requestId) headers['x-request-id'] = requestId;

  const traceparent = getHeaderValue(req.headers.traceparent);
  if (traceparent) headers.traceparent = traceparent;

  const tracestate = getHeaderValue(req.headers.tracestate);
  if (tracestate) headers.tracestate = tracestate;

  return headers;
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return undefined;
  }
  return schema as Record<string, unknown>;
}

// ─── Shared Execute Adapter ───────────────────────────────────────────

/**
 * Shared execute adapter — handles auth, validation, workflow + version
 * resolution, and dispatch to handleWorkflowExecute. Both URL forms use this.
 *
 * `pathVersion` is the semver string from the path segment (if present); when
 * provided it takes precedence over `?version=` query because the path-segment
 * form is more explicit and represents an intentional RESTful coordinate.
 */
async function executeAdapter(
  deps: WorkflowExecuteHandlerDeps,
  req: Request,
  res: Response,
  pathVersion?: string,
): Promise<Response | void> {
  const startTime = Date.now();
  const { workflowId } = req.params;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tenantContext = (req as any).tenantContext;

  // (a) Auth guard — API key required
  if (!tenantContext || tenantContext.authType !== 'api_key') {
    return res.status(401).json({
      success: false,
      error: {
        code: 'API_KEY_REQUIRED',
        message: 'Workflow execution requires API key authentication',
      },
    });
  }

  // Check workflow:execute permission
  if (!hasPermission(tenantContext.permissions ?? [], 'workflow:execute')) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'API key missing workflow:execute scope',
      },
    });
  }

  // (c) Validate query params
  const queryResult = workflowsExecuteQuerySchema.safeParse(req.query);
  if (!queryResult.success) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_MODE',
        message: queryResult.error.issues.map((i) => i.message).join(', '),
      },
    });
  }
  // Path segment wins over ?version= query when both are supplied —
  // the path-segment form is the explicit RESTful coordinate, and
  // silently ignoring it would be surprising.
  const { mode, version: queryVersion } = queryResult.data;
  const requestedVersion = pathVersion ?? queryVersion;

  // Validate body
  const bodyResult = workflowsExecuteBodySchema.safeParse(req.body);
  if (!bodyResult.success) {
    // Promote specific field-level errors to named HLD error codes when the
    // failing path is unambiguous; fall back to INVALID_INPUT otherwise.
    const issues = bodyResult.error.issues;
    const callbackIssue = issues.find((i) => i.path.length === 1 && i.path[0] === 'callbackUrl');
    if (callbackIssue) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_CALLBACK_URL', message: callbackIssue.message },
      });
    }
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: issues.map((i) => i.message).join(', '),
      },
    });
  }
  const { input, callbackUrl, accessToken, executionId } = bodyResult.data;

  // (b) Workflow fetch + scope check
  const workflow = await findWorkflowByIdAndTenant(workflowId, tenantContext.tenantId, {
    includeDeleted: false,
  });

  if (!workflow) {
    return res.status(404).json({
      success: false,
      error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' },
    });
  }

  const workflowDoc = workflow;

  // Verify project scope — API key must have access to the workflow's project
  if (
    tenantContext.projectScope?.length &&
    !tenantContext.projectScope.includes(workflowDoc.projectId)
  ) {
    return res.status(404).json({
      success: false,
      error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' },
    });
  }

  // (e) async_push guardrail — callbackUrl required for push mode
  if (mode === 'async_push' && !callbackUrl) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'MISSING_CALLBACK_URL',
        message: 'callbackUrl is required for async_push mode',
      },
    });
  }

  // (f) Version resolution
  let workflowVersionId: string | undefined;
  let workflowVersion: string | undefined;
  let inputSchema = normalizeInputSchema(workflowDoc.inputSchema);

  if (requestedVersion) {
    // Explicit version pin — state-agnostic, exclude soft-deleted
    const versionDoc = await findWorkflowVersion(
      workflowId,
      requestedVersion,
      tenantContext.tenantId,
      workflowDoc.projectId,
      { excludeDeleted: true },
    );

    if (!versionDoc) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'WORKFLOW_VERSION_NOT_FOUND',
          message: 'Requested workflow version not found',
        },
      });
    }

    workflowVersionId = String(versionDoc._id);
    workflowVersion = String(versionDoc.version);
    inputSchema = normalizeInputSchema(versionDoc.definition?.inputSchema) ?? inputSchema;
  } else {
    // Resolve default version (latest active published, or draft fallback)
    try {
      const { getWorkflowVersionService } = await import('../services/workflow-version-service.js');
      const resolved = await getWorkflowVersionService().resolveDefaultVersion(
        tenantContext.tenantId,
        workflowDoc.projectId,
        workflowId,
      );
      const resolvedDoc = resolved.version;
      workflowVersionId = String(resolvedDoc._id);
      workflowVersion = String(resolvedDoc.version);
      inputSchema = normalizeInputSchema(resolvedDoc.definition?.inputSchema) ?? inputSchema;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Default version resolution failed, proceeding without version pin', {
        workflowId,
        error: message,
      });
      // Proceed without version fields — engine will resolve its own default
    }
  }

  // (g) Invoke shared handler
  await handleWorkflowExecute(deps, {
    workflow: workflowDoc,
    inputSchema,
    tenantContext,
    workflowVersionId,
    workflowVersion,
    mode,
    input,
    callbackUrl,
    accessToken,
    executionId,
    engineHeaders: buildForwardedEngineHeaders(req),
    res,
    startTime,
  });
}

// ─── Router Factory ───────────────────────────────────────────────────

export function createWorkflowsExecuteRouter(deps: WorkflowExecuteHandlerDeps): Router {
  const router = Router();

  // Public-facing workflow execution is rate-limited per tenant/API-key. The
  // GET status-poll route below is intentionally not limited — polling-heavy
  // clients shouldn't burn their request budget on status checks.
  const executeLimit = tenantRateLimit('request');

  /**
   * POST /:workflowId/execute — query-param form (?version=v0.1.0 optional).
   */
  router.post('/:workflowId/execute', executeLimit, async (req: Request, res: Response) => {
    await executeAdapter(deps, req, res);
  });

  /**
   * POST /:workflowId/versions/:version/execute — path-segment form.
   * The :version path segment takes precedence over any `?version=` query.
   */
  router.post(
    '/:workflowId/versions/:version/execute',
    executeLimit,
    async (req: Request, res: Response) => {
      await executeAdapter(deps, req, res, req.params.version);
    },
  );

  /**
   * GET /:workflowId/executions/:executionId — Poll execution status
   *
   * Proxies to the workflow engine's execution status endpoint.
   * Does NOT reuse handleWorkflowExecute (that's for POST-execute only).
   */
  router.get('/:workflowId/executions/:executionId', async (req: Request, res: Response) => {
    const { workflowId, executionId } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tenantContext = (req as any).tenantContext;

    // Auth guard
    if (!tenantContext || tenantContext.authType !== 'api_key') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'API_KEY_REQUIRED',
          message: 'Execution status requires API key authentication',
        },
      });
    }

    if (!hasPermission(tenantContext.permissions ?? [], 'workflow:execute')) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'API key missing workflow:execute scope',
        },
      });
    }

    // Workflow fetch + project-scope check (includeDeleted: true for status poll)
    const workflow = await findWorkflowByIdAndTenant(workflowId, tenantContext.tenantId, {
      includeDeleted: true,
    });

    if (!workflow) {
      return res.status(404).json({
        success: false,
        error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' },
      });
    }

    const workflowDoc = workflow;

    // Verify project scope
    if (
      tenantContext.projectScope?.length &&
      !tenantContext.projectScope.includes(workflowDoc.projectId)
    ) {
      return res.status(404).json({
        success: false,
        error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' },
      });
    }

    try {
      // Proxy to workflow engine status endpoint
      const engineUrl =
        `${deps.engineBaseUrl}/api/v1/projects/${workflowDoc.projectId}` +
        `/workflows/${workflowId}/executions/${executionId}`;

      const engineRes = await fetch(engineUrl, {
        method: 'GET',
        headers: buildForwardedEngineHeaders(req),
        signal: AbortSignal.timeout(ENGINE_FETCH_TIMEOUT_MS),
      });

      const engineBody = await engineRes.json().catch(() => ({}));

      if (!engineRes.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engineError = (engineBody as any)?.error;
        const errorCode =
          engineError?.code === 'EXECUTION_NOT_FOUND'
            ? 'EXECUTION_NOT_FOUND'
            : 'UPSTREAM_UNAVAILABLE';
        const statusCode = errorCode === 'EXECUTION_NOT_FOUND' ? 404 : 502;
        return res.status(statusCode).json({
          success: false,
          error: {
            code: errorCode,
            message: engineError?.message ?? 'Execution not found or engine unavailable',
          },
        });
      }

      // Passthrough engine response with runtime-matching envelope
      return res.status(200).json({
        success: true,
        data: (engineBody as Record<string, unknown>).data ?? engineBody,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Execution status poll error', {
        error: message,
        workflowId,
        executionId,
      });
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      });
    }
  });

  return router;
}
