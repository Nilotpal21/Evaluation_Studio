/**
 * Workflow Engine Proxy Middleware
 *
 * Forwards execution, approval, trigger, and connector requests from runtime
 * to the workflow-engine service (default port 9080).
 *
 * Mounted on `/api/projects/:projectId/workflows` AFTER the CRUD router so
 * Express tries design-time routes first, then these execution-time
 * proxy routes.
 *
 * Route mapping:
 *
 * Executions:
 *   POST /:workflowId/executions/execute     -> POST /api/v1/projects/:projectId/workflows/:workflowId/executions/execute
 *   GET  /:workflowId/executions              -> GET  /api/v1/projects/:projectId/workflows/:workflowId/executions
 *   GET  /:workflowId/executions/:executionId -> GET  /api/v1/projects/:projectId/workflows/:workflowId/executions/:executionId
 *   POST /:workflowId/executions/:executionId/cancel -> POST /api/v1/projects/:projectId/workflows/:workflowId/executions/:executionId/cancel
 *
 * Approvals:
 *   GET  /approvals                                                         -> GET  /api/v1/projects/:projectId/approvals
 *   POST /approvals/:workflowId/executions/:executionId/steps/:stepId/approve -> POST /api/v1/projects/:projectId/approvals/:workflowId/executions/:executionId/steps/:stepId/approve
 *
 * Triggers:
 *   GET    /triggers                          -> GET    /api/v1/projects/:projectId/triggers
 *   POST   /triggers                          -> POST   /api/v1/projects/:projectId/triggers
 *   DELETE /triggers/:registrationId          -> DELETE /api/v1/projects/:projectId/triggers/:registrationId
 *   POST   /triggers/:registrationId/pause    -> POST   /api/v1/projects/:projectId/triggers/:registrationId/pause
 *   POST   /triggers/:registrationId/resume   -> POST   /api/v1/projects/:projectId/triggers/:registrationId/resume
 *   POST   /triggers/:registrationId/fire     -> POST   /api/v1/projects/:projectId/triggers/:registrationId/fire
 *
 * Connectors:
 *   GET /connectors                           -> GET /api/v1/connectors (no project scope)
 *
 * Notification Rules:
 *   GET    /:workflowId/notifications              -> GET    /api/v1/projects/:projectId/workflows/:workflowId/notifications
 *   POST   /:workflowId/notifications              -> POST   /api/v1/projects/:projectId/workflows/:workflowId/notifications
 *   PUT    /:workflowId/notifications/:ruleId      -> PUT    /api/v1/projects/:projectId/workflows/:workflowId/notifications/:ruleId
 *   DELETE /:workflowId/notifications/:ruleId      -> DELETE /api/v1/projects/:projectId/workflows/:workflowId/notifications/:ruleId
 *   POST   /:workflowId/notifications/:ruleId/test -> POST   /api/v1/projects/:projectId/workflows/:workflowId/notifications/:ruleId/test
 */

import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { DEFAULT_WORKFLOW_ENGINE_PORT } from '@agent-platform/config/constants';
import { requireProjectPermission } from './rbac.js';
import type { SyncExecutionService } from '../services/sync-execution.js';

const log = createLogger('runtime:workflow-engine-proxy');

/** Timeout for proxy requests to the workflow engine (30 seconds) */
const PROXY_TIMEOUT_MS = 30_000;

/** Max time the runtime waits for a `mode=sync` execution before promoting to async. */
const SYNC_TIMEOUT_MS = parseInt(process.env.WORKFLOW_PROXY_SYNC_TIMEOUT_MS ?? '30000', 10);

/** Supported execution modes on the `/executions/execute` proxy route. */
const EXECUTION_MODES = new Set(['sync', 'async', 'async_push']);

/** UUID format used by the engine — mirror the engine's UUID_RE for consistency. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Dependencies required by the proxy router factory. */
export interface WorkflowEngineProxyDeps {
  /**
   * Lazy getter for the SyncExecutionService — called at request time so the
   * router can be wired at module load (before Redis finishes initializing)
   * and still pick up the service once `initializeRedis()` resolves.
   * When it returns `undefined`, `mode=sync` responds 503.
   */
  syncExecution?: () => SyncExecutionService | undefined;
}

/** Params merged from the parent `/api/projects/:projectId/workflows` mount */
interface MergedParams {
  projectId: string;
  [key: string]: string;
}

/**
 * Proxy a request to the workflow-engine service.
 *
 * Copies method, body (for mutating verbs), authorization header, and
 * tenant context. Returns 502 if the engine is unreachable.
 */
async function proxyRequest(
  req: Request,
  res: Response,
  engineBase: string,
  enginePath: string,
): Promise<void> {
  const url = `${engineBase}${enginePath}`;
  try {
    const headers: Record<string, string> = {
      'content-type': req.headers['content-type'] || 'application/json',
    };
    if (req.headers.authorization) {
      headers['authorization'] = req.headers.authorization as string;
    }
    // Forward x-api-key so the workflow engine can authenticate API key callers
    const xApiKey = req.headers['x-api-key'] as string | undefined;
    if (xApiKey) headers['x-api-key'] = xApiKey;
    // Forward tenant context set by auth middleware (never trust client headers).
    // `req.tenantContext` is typed via shared-auth's global Express.Request augmentation.
    const tenantId = req.tenantContext?.tenantId;
    if (tenantId) headers['x-tenant-id'] = tenantId;
    const requestId = req.headers['x-request-id'];
    if (requestId) headers['x-request-id'] = requestId as string;
    const traceparent = req.headers['traceparent'];
    if (traceparent) headers['traceparent'] = traceparent as string;
    const tracestate = req.headers['tracestate'];
    if (tracestate) headers['tracestate'] = tracestate as string;

    const fetchOpts: RequestInit = {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    };
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.body !== undefined) {
      fetchOpts.body = JSON.stringify(req.body);
    }

    log.info('Proxying to workflow engine', { method: req.method, enginePath });
    const response = await fetch(url, fetchOpts);

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await response.json();
      res.status(response.status).json(data);
    } else {
      const text = await response.text();
      res.status(response.status).type(contentType).send(text);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Workflow engine unreachable', { path: enginePath, error: msg });
    res.status(502).json({
      success: false,
      error: { code: 'WORKFLOW_ENGINE_UNAVAILABLE', message: 'Workflow engine is not reachable' },
    });
  }
}

/**
 * Create an Express router that proxies execution-time workflow requests
 * to the workflow-engine service.
 */
export function createWorkflowEngineProxy(deps: WorkflowEngineProxyDeps): Router {
  const router = Router({ mergeParams: true });
  const engineBase =
    process.env.WORKFLOW_ENGINE_URL || `http://localhost:${DEFAULT_WORKFLOW_ENGINE_PORT}`;

  // Helper to read merged params (projectId comes from the parent mount)
  const params = (req: Request): MergedParams => req.params as unknown as MergedParams;

  // ─── Executions ─────────────────────────────────────────────────────────────

  // POST /:workflowId/executions/execute
  // Supports three modes via `?mode=` query:
  //   sync        (default) — wait up to SYNC_TIMEOUT_MS, return result inline.
  //   async                 — fire-and-forget, 202 with { executionId }.
  //   async_push            — fire-and-forget + deliver webhook on completion.
  router.post('/:workflowId/executions/execute', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:execute'))) return;
    const { projectId, workflowId } = params(req);

    const rawMode = (req.query.mode as string | undefined) ?? 'sync';
    const mode = rawMode.toLowerCase();
    if (!EXECUTION_MODES.has(mode)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_MODE',
          message: `mode must be one of: ${[...EXECUTION_MODES].join(', ')}`,
        },
      });
      return;
    }

    const tenantContext = req.tenantContext;
    const tenantId = tenantContext?.tenantId;
    if (!tenantId) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: 'Missing tenant context' },
      });
      return;
    }

    // ─── Body translation: snippet shape → engine shape ─────────────────────
    // Snippets send { input, callbackUrl, accessToken } at top level. Engine
    // expects { payload, triggerType, triggerMetadata: { callbackUrl, ... } }.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input =
      body.input && typeof body.input === 'object' && !Array.isArray(body.input)
        ? (body.input as Record<string, unknown>)
        : // Back-compat: if caller sent `payload` directly (pre-mode callers), honor it.
          body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
          ? (body.payload as Record<string, unknown>)
          : {};

    const clientCallbackUrl = typeof body.callbackUrl === 'string' ? body.callbackUrl : undefined;
    const clientAccessToken = typeof body.accessToken === 'string' ? body.accessToken : undefined;

    if (mode === 'async_push' && !clientCallbackUrl) {
      res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_CALLBACK_URL',
          message: 'callbackUrl is required when mode=async_push',
        },
      });
      return;
    }
    if (clientCallbackUrl) {
      try {
        // Basic URL shape validation; SSRF protection is enforced at delivery time.
        new URL(clientCallbackUrl);
      } catch {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_CALLBACK_URL', message: 'callbackUrl is not a valid URL' },
        });
        return;
      }
    }

    // Allow caller to supply an executionId (used for idempotent retries).
    const clientExecutionId = typeof body.executionId === 'string' ? body.executionId : undefined;
    if (clientExecutionId && !UUID_RE.test(clientExecutionId)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_EXECUTION_ID', message: 'executionId must be a valid UUID' },
      });
      return;
    }
    const executionId = clientExecutionId ?? crypto.randomUUID();

    // Optional version pin — forwarded to the engine, which loads the
    // WorkflowVersion doc and runs its canvas. When absent, the engine
    // resolves the active version and falls back to draft only if none.
    const clientWorkflowVersionId =
      typeof body.workflowVersionId === 'string' ? body.workflowVersionId : undefined;
    const bodyWorkflowVersion =
      typeof body.workflowVersion === 'string' ? body.workflowVersion : undefined;

    // Query string `?version=` — safe-coerce: if Express parsed as string[], take
    // the first element; reject non-string types silently (treat as absent).
    const rawQueryVersion = req.query.version;
    const queryWorkflowVersion =
      typeof rawQueryVersion === 'string'
        ? rawQueryVersion
        : Array.isArray(rawQueryVersion) && typeof rawQueryVersion[0] === 'string'
          ? rawQueryVersion[0]
          : undefined;

    // Precedence: body wins over query. Warn when both present and differ.
    let clientWorkflowVersion: string | undefined;
    if (bodyWorkflowVersion !== undefined && queryWorkflowVersion !== undefined) {
      clientWorkflowVersion = bodyWorkflowVersion;
      if (bodyWorkflowVersion !== queryWorkflowVersion) {
        log.warn('proxy.version.conflict', {
          query: queryWorkflowVersion,
          body: bodyWorkflowVersion,
        });
      }
    } else {
      clientWorkflowVersion = bodyWorkflowVersion ?? queryWorkflowVersion;
    }
    // Optional webhook semantics — meaningful for API-key callers that want
    // explicit sync/async + poll/push behavior on the proxy path.
    const clientWebhookMode =
      body.webhookMode === 'sync' || body.webhookMode === 'async' ? body.webhookMode : undefined;
    const clientWebhookDelivery =
      body.webhookDelivery === 'poll' || body.webhookDelivery === 'push'
        ? body.webhookDelivery
        : undefined;

    const triggerMetadata: Record<string, unknown> = {
      firedAt: new Date().toISOString(),
    };
    if (tenantContext.apiKeyId) triggerMetadata.apiKeyId = tenantContext.apiKeyId;
    if (tenantContext.userId) triggerMetadata.userId = tenantContext.userId;
    if (mode === 'async_push' && clientCallbackUrl) {
      triggerMetadata.callbackUrl = clientCallbackUrl;
      if (clientAccessToken) triggerMetadata.accessToken = clientAccessToken;
    }

    // Map caller auth to the engine's unified trigger taxonomy:
    //   JWT → 'studio'   (user-initiated from Studio UI; callbackUrl stripped by engine)
    //   API key → 'webhook' (external programmatic caller; callbackUrl preserved)
    // Note: 'agent' is reserved for agent-initiated workflow invocations, which
    // go through the runtime's internal workflow-tool-executor, not this proxy.
    const triggerType = tenantContext.authType === 'api_key' ? 'webhook' : 'studio';

    const enginePayload: Record<string, unknown> = {
      executionId,
      payload: input,
      triggerType,
      triggerMetadata,
    };
    if (clientWorkflowVersionId) enginePayload.workflowVersionId = clientWorkflowVersionId;
    if (clientWorkflowVersion) enginePayload.workflowVersion = clientWorkflowVersion;
    if (clientWebhookMode) enginePayload.webhookMode = clientWebhookMode;
    if (clientWebhookDelivery) enginePayload.webhookDelivery = clientWebhookDelivery;

    // Forward the caller's original credential to the engine — the engine's
    // unified auth middleware only accepts user JWTs, API keys, and SDK
    // sessions (not internal service tokens). This matches how the other
    // proxy routes in this file forward auth via proxyRequest().
    const engineHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-tenant-id': tenantId,
    };
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string') engineHeaders['Authorization'] = authHeader;
    const xApiKey = req.headers['x-api-key'];
    if (typeof xApiKey === 'string') engineHeaders['x-api-key'] = xApiKey;
    const requestId = req.headers['x-request-id'];
    if (typeof requestId === 'string') engineHeaders['x-request-id'] = requestId;
    const traceparent = req.headers['traceparent'];
    if (typeof traceparent === 'string') engineHeaders['traceparent'] = traceparent;
    const tracestate = req.headers['tracestate'];
    if (typeof tracestate === 'string') engineHeaders['tracestate'] = tracestate;

    const engineUrl = `${engineBase}/api/v1/projects/${projectId}/workflows/${workflowId}/executions/execute`;

    // ─── async / async_push — fire-and-forget ────────────────────────────────
    if (mode === 'async' || mode === 'async_push') {
      try {
        const engineRes = await fetch(engineUrl, {
          method: 'POST',
          headers: engineHeaders,
          body: JSON.stringify(enginePayload),
          signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        });
        if (!engineRes.ok) {
          const errBody = (await engineRes.json().catch(() => ({}))) as Record<string, unknown>;
          const errMsg =
            (errBody.error as { message?: string } | undefined)?.message ||
            (typeof errBody.error === 'string' ? errBody.error : undefined) ||
            'Workflow engine returned an error';
          res.status(engineRes.status).json({
            success: false,
            error: { code: 'UPSTREAM_ERROR', message: errMsg },
          });
          return;
        }
        res.status(202).json({ success: true, executionId });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Workflow engine unreachable (async dispatch)', {
          workflowId,
          executionId,
          error: msg,
        });
        res.status(502).json({
          success: false,
          error: {
            code: 'WORKFLOW_ENGINE_UNAVAILABLE',
            message: 'Workflow engine is not reachable',
          },
        });
        return;
      }
    }

    // ─── sync — subscribe, dispatch, wait ────────────────────────────────────
    const syncService = deps.syncExecution?.();
    if (!syncService) {
      res.status(503).json({
        success: false,
        error: {
          code: 'SYNC_UNAVAILABLE',
          message: 'Sync execution requires Redis. Use ?mode=async or configure REDIS_URL.',
        },
      });
      return;
    }

    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    // Subscribe BEFORE dispatching so we do not miss fast completions.
    const waitPromise = syncService.waitForCompletion(
      tenantId,
      executionId,
      SYNC_TIMEOUT_MS,
      abortController.signal,
    );

    try {
      const engineRes = await fetch(engineUrl, {
        method: 'POST',
        headers: engineHeaders,
        body: JSON.stringify(enginePayload),
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
      if (!engineRes.ok) {
        abortController.abort();
        const errBody = (await engineRes.json().catch(() => ({}))) as Record<string, unknown>;
        const errMsg =
          (errBody.error as { message?: string } | undefined)?.message ||
          (typeof errBody.error === 'string' ? errBody.error : undefined) ||
          'Workflow engine returned an error';
        res.status(engineRes.status).json({
          success: false,
          error: { code: 'UPSTREAM_ERROR', message: errMsg },
        });
        return;
      }
    } catch (err) {
      abortController.abort();
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Workflow engine unreachable (sync dispatch)', {
        workflowId,
        executionId,
        error: msg,
      });
      res.status(502).json({
        success: false,
        error: {
          code: 'WORKFLOW_ENGINE_UNAVAILABLE',
          message: 'Workflow engine is not reachable',
        },
      });
      return;
    }

    const execResult = await waitPromise;

    if (execResult.status === 'timeout') {
      // Auto-promote to async — caller polls GET /executions/:executionId.
      log.info('Sync execution timed out, returning running status', {
        workflowId,
        executionId,
      });
      res.status(202).json({ success: true, executionId, status: 'running' });
      return;
    }

    if (execResult.status === 'completed') {
      res.status(200).json({
        success: true,
        executionId,
        status: 'completed',
        output: execResult.result ?? {},
      });
      return;
    }

    // failed | cancelled
    res.status(200).json({
      success: false,
      executionId,
      status: execResult.status,
      ...(execResult.error ? { error: execResult.error } : {}),
    });
  });

  // GET /:workflowId/executions
  router.get('/:workflowId/executions', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;
    const { projectId, workflowId } = params(req);
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const path = `/api/v1/projects/${projectId}/workflows/${workflowId}/executions${qs ? `?${qs}` : ''}`;
    await proxyRequest(req, res, engineBase, path);
  });

  // GET /:workflowId/executions/:executionId
  router.get('/:workflowId/executions/:executionId', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;
    const { projectId, workflowId, executionId } = params(req);
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const path = `/api/v1/projects/${projectId}/workflows/${workflowId}/executions/${executionId}${qs ? `?${qs}` : ''}`;
    await proxyRequest(req, res, engineBase, path);
  });

  // POST /:workflowId/executions/:executionId/cancel
  router.post(
    '/:workflowId/executions/:executionId/cancel',
    async (req: Request, res: Response) => {
      if (!(await requireProjectPermission(req, res, 'workflow:execute'))) return;
      const { projectId, workflowId, executionId } = params(req);
      await proxyRequest(
        req,
        res,
        engineBase,
        `/api/v1/projects/${projectId}/workflows/${workflowId}/executions/${executionId}/cancel`,
      );
    },
  );

  // ─── Approvals ──────────────────────────────────────────────────────────────

  // GET /approvals
  router.get('/approvals', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'approval:read'))) return;
    const { projectId } = params(req);
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const path = `/api/v1/projects/${projectId}/approvals${qs ? `?${qs}` : ''}`;
    await proxyRequest(req, res, engineBase, path);
  });

  // POST /approvals/:workflowId/executions/:executionId/steps/:stepId/approve
  router.post(
    '/approvals/:workflowId/executions/:executionId/steps/:stepId/approve',
    async (req: Request, res: Response) => {
      if (!(await requireProjectPermission(req, res, 'approval:write'))) return;
      const { projectId, workflowId, executionId, stepId } = params(req);
      await proxyRequest(
        req,
        res,
        engineBase,
        `/api/v1/projects/${projectId}/approvals/${workflowId}/executions/${executionId}/steps/${stepId}/approve`,
      );
    },
  );

  // POST /:workflowId/executions/:executionId/steps/:stepId/approve
  // Alternate approval path — handles direct proxy from Studio middleware (turbopack
  // workaround rewrites deeply nested paths to Runtime, bypassing the Studio route
  // handler that would normally insert 'approvals/' into the path).
  router.post(
    '/:workflowId/executions/:executionId/steps/:stepId/approve',
    async (req: Request, res: Response) => {
      if (!(await requireProjectPermission(req, res, 'approval:write'))) return;
      const { projectId, workflowId, executionId, stepId } = params(req);
      await proxyRequest(
        req,
        res,
        engineBase,
        `/api/v1/projects/${projectId}/approvals/${workflowId}/executions/${executionId}/steps/${stepId}/approve`,
      );
    },
  );

  // ─── Triggers ───────────────────────────────────────────────────────────────

  // GET /triggers/catalog — trigger catalog (registry-wide, not project-scoped
  // on the engine; project scope is enforced here for consistent RBAC).
  // NOTE: registered BEFORE /triggers/:registrationId so the literal
  // 'catalog' segment isn't captured as a registrationId param.
  router.get('/triggers/catalog', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const path = `/api/v1/connectors/triggers/catalog${qs ? `?${qs}` : ''}`;
    await proxyRequest(req, res, engineBase, path);
  });

  // GET /triggers — list trigger registrations
  router.get('/triggers', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;
    const { projectId } = params(req);
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const path = `/api/v1/projects/${projectId}/triggers${qs ? `?${qs}` : ''}`;
    await proxyRequest(req, res, engineBase, path);
  });

  // POST /triggers
  router.post('/triggers', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:write'))) return;
    const { projectId } = params(req);
    await proxyRequest(req, res, engineBase, `/api/v1/projects/${projectId}/triggers`);
  });

  // DELETE /triggers/:registrationId
  router.delete('/triggers/:registrationId', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:write'))) return;
    const { projectId, registrationId } = params(req);
    await proxyRequest(
      req,
      res,
      engineBase,
      `/api/v1/projects/${projectId}/triggers/${registrationId}`,
    );
  });

  // PUT /triggers/:registrationId — Update trigger config (cron/webhook/connector)
  router.put('/triggers/:registrationId', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:write'))) return;
    const { projectId, registrationId } = params(req);
    await proxyRequest(
      req,
      res,
      engineBase,
      `/api/v1/projects/${projectId}/triggers/${registrationId}`,
    );
  });

  // POST /triggers/:registrationId/pause
  router.post('/triggers/:registrationId/pause', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:write'))) return;
    const { projectId, registrationId } = params(req);
    await proxyRequest(
      req,
      res,
      engineBase,
      `/api/v1/projects/${projectId}/triggers/${registrationId}/pause`,
    );
  });

  // POST /triggers/:registrationId/resume
  router.post('/triggers/:registrationId/resume', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:write'))) return;
    const { projectId, registrationId } = params(req);
    await proxyRequest(
      req,
      res,
      engineBase,
      `/api/v1/projects/${projectId}/triggers/${registrationId}/resume`,
    );
  });

  // POST /triggers/:registrationId/fire
  router.post('/triggers/:registrationId/fire', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:execute'))) return;
    const { projectId, registrationId } = params(req);
    await proxyRequest(
      req,
      res,
      engineBase,
      `/api/v1/projects/${projectId}/triggers/${registrationId}/fire`,
    );
  });

  // GET /triggers/:registrationId/sample-payload — returns last fire payload
  // so Studio's Fire Now modal can pre-populate its JSON editor.
  router.get('/triggers/:registrationId/sample-payload', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;
    const { projectId, registrationId } = params(req);
    await proxyRequest(
      req,
      res,
      engineBase,
      `/api/v1/projects/${projectId}/triggers/${registrationId}/sample-payload`,
    );
  });

  // POST /triggers/:registrationId/test-sample — run connector trigger.run()
  // with stored creds to fetch live sample data; persists result as samplePayload.
  router.post('/triggers/:registrationId/test-sample', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:write'))) return;
    const { projectId, registrationId } = params(req);
    await proxyRequest(
      req,
      res,
      engineBase,
      `/api/v1/projects/${projectId}/triggers/${registrationId}/test-sample`,
    );
  });

  // POST /:workflowId/nodes/:nodeId/test-action — run an integration node's
  // action with provided params; persists output as node.config.sampleOutput.
  router.post('/:workflowId/nodes/:nodeId/test-action', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:write'))) return;
    const { projectId } = params(req);
    const { workflowId, nodeId } = req.params;
    await proxyRequest(
      req,
      res,
      engineBase,
      `/api/v1/projects/${projectId}/workflows/${workflowId}/nodes/${nodeId}/test-action`,
    );
  });

  // ─── Connectors ─────────────────────────────────────────────────────────────

  // GET /connectors (no project scope on engine side)
  router.get('/connectors', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const path = `/api/v1/connectors${qs ? `?${qs}` : ''}`;
    await proxyRequest(req, res, engineBase, path);
  });

  // GET /connectors/:connectorName — connector detail
  router.get('/connectors/:connectorName', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;
    const connectorName = req.params.connectorName;
    await proxyRequest(
      req,
      res,
      engineBase,
      `/api/v1/connectors/${encodeURIComponent(connectorName)}`,
    );
  });

  // GET /connectors/:connectorName/actions — connector actions
  router.get('/connectors/:connectorName/actions', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;
    const connectorName = req.params.connectorName;
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const path = `/api/v1/connectors/${encodeURIComponent(connectorName)}/actions${qs ? `?${qs}` : ''}`;
    await proxyRequest(req, res, engineBase, path);
  });

  // ─── Notification Rules ──────────────────────────────────────────────────────

  // GET /:workflowId/notifications — list notification rules
  router.get('/:workflowId/notifications', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;
    const { projectId, workflowId } = params(req);
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const path = `/api/v1/projects/${projectId}/workflows/${workflowId}/notifications${qs ? `?${qs}` : ''}`;
    await proxyRequest(req, res, engineBase, path);
  });

  // POST /:workflowId/notifications — create a notification rule
  router.post('/:workflowId/notifications', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:update'))) return;
    const { projectId, workflowId } = params(req);
    await proxyRequest(
      req,
      res,
      engineBase,
      `/api/v1/projects/${projectId}/workflows/${workflowId}/notifications`,
    );
  });

  // PUT /:workflowId/notifications/:ruleId — update a notification rule
  router.put('/:workflowId/notifications/:ruleId', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:update'))) return;
    const { projectId, workflowId } = params(req);
    const ruleId = req.params.ruleId;
    await proxyRequest(
      req,
      res,
      engineBase,
      `/api/v1/projects/${projectId}/workflows/${workflowId}/notifications/${ruleId}`,
    );
  });

  // DELETE /:workflowId/notifications/:ruleId — delete a notification rule
  router.delete('/:workflowId/notifications/:ruleId', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:update'))) return;
    const { projectId, workflowId } = params(req);
    const ruleId = req.params.ruleId;
    await proxyRequest(
      req,
      res,
      engineBase,
      `/api/v1/projects/${projectId}/workflows/${workflowId}/notifications/${ruleId}`,
    );
  });

  // POST /:workflowId/notifications/:ruleId/test — test a notification rule
  router.post('/:workflowId/notifications/:ruleId/test', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:execute'))) return;
    const { projectId, workflowId } = params(req);
    const ruleId = req.params.ruleId;
    await proxyRequest(
      req,
      res,
      engineBase,
      `/api/v1/projects/${projectId}/workflows/${workflowId}/notifications/${ruleId}/test`,
    );
  });

  return router;
}
