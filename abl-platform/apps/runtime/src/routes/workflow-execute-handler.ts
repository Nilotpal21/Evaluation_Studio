/**
 * Shared Workflow Execution Handler
 *
 * Pure function + helpers used by workflow execution routes. Previously the
 * home of the legacy `/api/v1/process/:workflowId` router — that route was
 * removed before first production release; only the shared handler remains.
 *
 * Current callers:
 *   - `routes/workflows-execute.ts` — `POST /api/v1/workflows/:id/execute` (short URL)
 *   - `routes/workflows-execute.ts` — `POST /api/v1/workflows/:id/versions/:v/execute` (path-segment)
 */

import type { Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import type { SyncExecutionService } from '../services/sync-execution.js';
import type { WorkflowDoc } from '../repos/workflow-repo.js';
import { auditWorkflowExecuted } from '../services/audit-helpers.js';

const log = createLogger('workflow-execute-handler');

// ─── Types ────────────────────────────────────────────────────────────

/**
 * Dependency interface for the shared workflow execution handler.
 */
export interface WorkflowExecuteHandlerDeps {
  syncExecution: () => SyncExecutionService | undefined;
  engineBaseUrl: string;
}

/**
 * Arguments for the shared workflow execution handler.
 * The route adapter pre-resolves everything; the handler is a pure function
 * that builds the engine payload, calls the engine, and writes the HTTP response.
 */
export interface WorkflowExecuteHandlerArgs {
  /** Pre-fetched workflow document (includes projectId, inputSchema). */
  workflow: WorkflowDoc;
  /** Effective input schema for the resolved execution target. */
  inputSchema?: Record<string, unknown>;
  tenantContext: {
    tenantId: string;
    projectScope?: string[];
    permissions?: string[];
    apiKeyId?: string;
    authType: 'api_key' | 'user_jwt';
  };
  /** Engine pins by _id when present — injected into enginePayload. */
  workflowVersionId?: string;
  /** Audit/log + engine body passthrough (semver or 'draft'). */
  workflowVersion?: string;
  /** Normalized external mode; the handler derives webhookMode + webhookDelivery. */
  mode: 'sync' | 'async' | 'async_push';
  input: Record<string, unknown>;
  callbackUrl?: string;
  accessToken?: string;
  executionId?: string;
  /** Forwarded caller auth + trace headers for workflow-engine. */
  engineHeaders: Record<string, string>;
  /** Express response object — the handler writes to this. */
  res: Response;
  startTime: number;
}

// ─── Config ───────────────────────────────────────────────────────────

const SYNC_TIMEOUT_MS = parseInt(process.env.PROCESS_API_SYNC_TIMEOUT_MS ?? '30000', 10);
export const ENGINE_FETCH_TIMEOUT_MS = 30_000;

// ─── Shared Workflow Execution Handler ───────────────────────────────

/**
 * Shared handler for executing a workflow via the engine. Extracts the
 * core execution logic (input-schema validation, executionId generation,
 * enginePayload build, engine fetch, sync/async branching, timeout
 * auto-promote) so both the legacy `POST /process/:workflowId` route
 * and the new `POST /workflows/:workflowId/execute` route can reuse it.
 *
 * This function writes directly to `args.res` — it does NOT return a value.
 * The caller (route adapter) is responsible for auth, body validation,
 * workflow fetch, project-scope check, version resolution, and mode
 * normalization. This handler receives a fully-resolved args bundle.
 */
export async function handleWorkflowExecute(
  deps: WorkflowExecuteHandlerDeps,
  args: WorkflowExecuteHandlerArgs,
): Promise<void> {
  const {
    workflow,
    inputSchema,
    tenantContext,
    workflowVersionId,
    workflowVersion,
    mode,
    input,
    callbackUrl,
    accessToken,
    engineHeaders,
    res,
    startTime,
  } = args;

  const workflowDoc = workflow;
  const workflowId = String(workflowDoc._id);

  // Step 1: Validate input against the resolved execution schema (if defined)
  if (inputSchema && Object.keys(inputSchema).length > 0) {
    const schema = inputSchema;
    const validationErrors: string[] = [];

    // Check required fields
    if (Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (typeof field === 'string' && !(field in input)) {
          validationErrors.push(`Missing required field: ${field}`);
        }
      }
    }

    // Check basic type matching for present fields
    if (schema.properties && typeof schema.properties === 'object') {
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      for (const [field, fieldSchema] of Object.entries(properties)) {
        if (!(field in input)) continue;
        const value = input[field];
        const expectedType = fieldSchema?.type;
        if (typeof expectedType !== 'string') continue;

        let actualType: string;
        if (value === null) {
          actualType = 'null';
        } else if (Array.isArray(value)) {
          actualType = 'array';
        } else {
          actualType = typeof value;
        }

        // JSON Schema type mapping check
        const typeMatches =
          (expectedType === 'string' && actualType === 'string') ||
          (expectedType === 'number' && actualType === 'number') ||
          (expectedType === 'integer' && actualType === 'number') ||
          (expectedType === 'boolean' && actualType === 'boolean') ||
          (expectedType === 'array' && actualType === 'array') ||
          (expectedType === 'object' && actualType === 'object') ||
          (expectedType === 'null' && actualType === 'null');

        if (!typeMatches) {
          validationErrors.push(
            `Field "${field}" expected type "${expectedType}" but got "${actualType}"`,
          );
        }
      }
    }

    if (validationErrors.length > 0) {
      res.status(400).json({
        success: false,
        error: {
          code: 'SCHEMA_MISMATCH',
          message: `Input validation failed: ${validationErrors.join('; ')}`,
        },
      });
      return;
    }
  }

  // Step 2: Generate executionId (UUIDv7 for sort-order consistency)
  const { uuidv7 } = await import('@agent-platform/database/mongo');
  const executionId = args.executionId ?? uuidv7();

  // Resolved-version fields are only present in the response envelope when
  // the adapter actually pinned a version. Built once so every response site
  // below stays consistent.
  const resolvedVersionFields: Record<string, string> = {};
  if (workflowVersion !== undefined) resolvedVersionFields.resolvedVersion = workflowVersion;
  if (workflowVersionId !== undefined) resolvedVersionFields.resolvedVersionId = workflowVersionId;

  // Fire-and-forget audit — records that an execution was initiated, including
  // resolved version for traceability across failed/timeout/completed paths.
  void auditWorkflowExecuted(
    {
      tenantId: tenantContext.tenantId,
      projectId: workflowDoc.projectId,
      workflowId,
      executionId,
      mode,
      workflowVersion,
      workflowVersionId,
      apiKeyId: tenantContext.apiKeyId,
    },
    tenantContext.apiKeyId ?? 'system',
  );

  // Build triggerMetadata for audit trail
  const triggerMetadata: Record<string, unknown> = {
    apiKeyId: tenantContext.apiKeyId,
    firedAt: new Date().toISOString(),
  };
  if (callbackUrl) {
    triggerMetadata.callbackUrl = callbackUrl;
  }
  if (accessToken) {
    triggerMetadata.accessToken = accessToken;
  }

  // Derive engine two-field enum from the normalized external mode
  let webhookMode: 'sync' | 'async';
  let webhookDelivery: 'poll' | 'push' | undefined;
  switch (mode) {
    case 'sync':
      webhookMode = 'sync';
      webhookDelivery = undefined;
      break;
    case 'async':
      webhookMode = 'async';
      webhookDelivery = 'poll';
      break;
    case 'async_push':
      webhookMode = 'async';
      webhookDelivery = 'push';
      break;
  }

  const isAsync = mode === 'async' || mode === 'async_push';

  // Step 3: Build engine payload
  const enginePayload: Record<string, unknown> = {
    executionId,
    payload: input,
    triggerType: 'webhook' as const,
    webhookMode,
    webhookDelivery,
    triggerMetadata,
  };

  // Inject version fields when defined (new short-URL route supplies these;
  // legacy adapter passes both as undefined → omitted from payload)
  if (workflowVersionId !== undefined) {
    enginePayload.workflowVersionId = workflowVersionId;
  }
  if (workflowVersion !== undefined) {
    enginePayload.workflowVersion = workflowVersion;
  }

  try {
    if (isAsync) {
      // Async mode: proxy to engine, return immediately with traceId
      const engineRes = await fetch(
        `${deps.engineBaseUrl}/api/v1/projects/${workflowDoc.projectId}/workflows/${workflowId}/executions/execute`,
        {
          method: 'POST',
          headers: engineHeaders,
          body: JSON.stringify(enginePayload),
          signal: AbortSignal.timeout(ENGINE_FETCH_TIMEOUT_MS),
        },
      );

      if (!engineRes.ok) {
        const errBody = await engineRes.json().catch(() => ({}));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const errMsg =
          (errBody as any)?.error?.message ||
          (errBody as any)?.error ||
          'Workflow engine unavailable';
        res.status(502).json({
          success: false,
          error: { code: 'UPSTREAM_UNAVAILABLE', message: String(errMsg) },
        });
        return;
      }

      log.info('Async execution started', {
        workflowId,
        executionId,
        apiKeyId: tenantContext.apiKeyId,
        version: workflowVersion ?? null,
        duration: Date.now() - startTime,
      });
      res.status(202).json({
        success: true,
        data: { traceId: executionId, status: 'running', ...resolvedVersionFields },
      });
      return;
    }

    // Sync mode: subscribe BEFORE starting, then wait for completion
    const syncService = deps.syncExecution();
    if (!syncService) {
      res.status(503).json({
        success: false,
        error: {
          code: 'SYNC_UNAVAILABLE',
          message: 'Sync execution is unavailable (Redis not configured)',
        },
      });
      return;
    }
    // Check sync concurrency limit
    if (syncService.activeCount >= 100) {
      res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Too many concurrent sync requests',
        },
      });
      return;
    }

    // Create abort controller for client disconnect
    const abortController = new AbortController();
    // Note: res has access to the underlying request via the Express connection
    // We need to listen on the socket/connection close
    res.on('close', () => abortController.abort());

    // Start waiting (subscribes to Redis Pub/Sub)
    const waitPromise = syncService.waitForCompletion(
      tenantContext.tenantId,
      executionId,
      SYNC_TIMEOUT_MS,
      abortController.signal,
    );

    // Proxy start request to engine
    const engineRes = await fetch(
      `${deps.engineBaseUrl}/api/v1/projects/${workflowDoc.projectId}/workflows/${workflowId}/executions/execute`,
      {
        method: 'POST',
        headers: engineHeaders,
        body: JSON.stringify(enginePayload),
        signal: AbortSignal.timeout(ENGINE_FETCH_TIMEOUT_MS),
      },
    );

    if (!engineRes.ok) {
      abortController.abort(); // cleanup subscription
      const errBody = await engineRes.json().catch(() => ({}));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errMsg =
        (errBody as any)?.error?.message ||
        (errBody as any)?.error ||
        'Workflow engine unavailable';
      res.status(502).json({
        success: false,
        error: { code: 'UPSTREAM_UNAVAILABLE', message: String(errMsg) },
      });
      return;
    }

    // Wait for completion or timeout
    const execResult = await waitPromise;
    const duration = Date.now() - startTime;

    if (execResult.status === 'timeout') {
      // Auto-promote to async
      log.info('Sync execution timed out, promoting to async', {
        workflowId,
        executionId,
        version: workflowVersion ?? null,
        duration,
      });
      res.status(202).json({
        success: true,
        data: { traceId: executionId, status: 'running', ...resolvedVersionFields },
      });
      return;
    }

    if (execResult.status === 'completed') {
      log.info('Sync execution completed', {
        workflowId,
        executionId,
        apiKeyId: tenantContext.apiKeyId,
        version: workflowVersion ?? null,
        duration,
      });
      res.status(200).json({
        success: true,
        data: {
          traceId: executionId,
          status: 'completed',
          result: execResult.result,
          ...resolvedVersionFields,
        },
      });
      return;
    }

    // Failed or cancelled
    log.info('Sync execution ended', {
      workflowId,
      executionId,
      status: execResult.status,
      version: workflowVersion ?? null,
      duration,
    });
    res.status(200).json({
      success: true,
      data: {
        traceId: executionId,
        status: execResult.status,
        error: execResult.error,
        ...resolvedVersionFields,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'SYNC_LIMIT_EXCEEDED') {
      res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Too many concurrent sync requests',
        },
      });
      return;
    }
    log.error('Process API execution error', {
      error: message,
      workflowId,
      executionId,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
}
