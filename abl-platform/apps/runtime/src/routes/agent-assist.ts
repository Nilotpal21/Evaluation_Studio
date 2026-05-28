/**
 * Agent Assist V1 Compatibility Facade — HTTP routes.
 *
 * Feature: docs/features/agent-assist-runtime-compat.md
 *
 * Mount path: `/api/v2/apps/:appId/environments/:envName/...`
 *
 * Middleware chain:
 *   json(size_cap) → authMiddleware → tenantRateLimit
 *   → resolveAndAuthorize → handler
 *
 * The Agent Assist facade is universally available — there is no tenant-level
 * feature gate. The per-project enable toggle is enforced inside
 * `resolveAndAuthorize` (via `resolveProjectAgentAssistEnabled`), so operators
 * can still kill the facade for a specific project from Studio settings.
 * (Mirrors the Agent Transfer pattern: no plan/Deal gate, project-only.)
 *
 * Three endpoints:
 *   - `runs/execute` sync + SSE + async-push (BullMQ enqueue)
 *   - `sessions` create or fetch
 *   - `sessions/terminate` end session via RuntimeExecutor
 *
 * Isolation:
 *   - `x-api-key` → authMiddleware (handled by the router-level middleware).
 *   - Resolved API-key `tenantId` must match the binding's `tenantId`.
 *   - API-key `projectScope` (when set) must include the binding's `projectId`.
 *   - Mismatches return 404 APP_NOT_FOUND (never 403) per existence-disclosure invariant.
 */

import crypto from 'node:crypto';
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from 'express';
import { createLogger } from '@abl/compiler/platform';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { type UnifiedBindingResolver } from '../services/agent-assist/binding-resolver.js';
import { debugRecorderMiddleware } from '../services/agent-assist/debug-recorder.js';
import {
  AGENT_ASSIST_MAX_BODY_BYTES,
  AGENT_ASSIST_SOURCE_TAG,
  AGENT_ASSIST_SSE_HEARTBEAT_MS,
} from '../services/agent-assist/constants.js';
import {
  buildV1Envelope,
  buildV1ErrorEnvelope,
} from '../services/agent-assist/envelope-builder.js';
import {
  computeAgentAssistSessionId,
  executeTurn as defaultExecuteTurn,
} from '../services/agent-assist/execution-bridge.js';
import { deliverAsyncCallback } from '../services/agent-assist/callback-sender.js';
import {
  resolveValidationOptions,
  validateCallbackUrl,
} from '../services/agent-assist/callback-url-validator.js';
import { normalizeV1Metadata } from '../services/agent-assist/metadata-normalizer.js';
import {
  buildCreateSessionResponse,
  buildTerminateSessionResponse,
} from '../services/agent-assist/session-envelope.js';
import { resolveWelcomeTextForBinding as defaultResolveWelcomeTextForBinding } from '../services/agent-assist/welcome-resolver.js';
import { V1SSEEmitter } from '../services/agent-assist/v1-sse-emitter.js';
import {
  resolveProjectAgentAssistEnabled,
  type FeatureGateDeps,
} from '../services/agent-assist/feature-gate.js';
import {
  emitReceived,
  emitBindingResolved,
  emitDelegated,
  emitTranslatedResponse,
  emitError,
  emitCallbackScheduled,
} from '../services/agent-assist/trace-events.js';
import type { AgentAssistBinding, V1SessionInfo } from '../services/agent-assist/types.js';
import type { AgentAssistCallbackJob } from '../workers/agent-assist-callback-worker.js';
import { v1ExecuteBodySchema, v1SessionsBodySchema } from './agent-assist.schemas.js';

const log = createLogger('agent-assist:routes');

/** Structured error body matching the V1 facade's documented error shape. */
interface StructuredErrorBody {
  success: false;
  error: { code: string; message: string };
}

function errorBody(code: string, message: string): StructuredErrorBody {
  return { success: false, error: { code, message } };
}

/** Sanitized default message returned to callers when an unexpected error escapes. */
const GENERIC_RUNTIME_ERROR_MESSAGE =
  'Agent is unable to process your request. Please try again in a moment.';

function extractTextInput(input: { type: string; content: unknown }[]): string {
  const parts: string[] = [];
  for (const item of input) {
    if (item.type !== 'text') continue;
    if (typeof item.content === 'string') parts.push(item.content);
  }
  return parts.join(' ').trim();
}

function extractSessionReference(identities: { type: string; value: string }[]): {
  sessionReference?: string;
  userReference?: string;
  sessionId?: string;
} {
  const out: { sessionReference?: string; userReference?: string; sessionId?: string } = {};
  for (const identity of identities) {
    if (identity.type === 'sessionReference' && !out.sessionReference)
      out.sessionReference = identity.value;
    if (identity.type === 'userReference' && !out.userReference) out.userReference = identity.value;
    if ((identity.type === 'sessionId' || identity.type === 'sessionIdentity') && !out.sessionId) {
      out.sessionId = identity.value;
    }
  }
  return out;
}

interface AgentAssistCallbackQueueProducer {
  add(data: AgentAssistCallbackJob): Promise<unknown>;
}

/**
 * Look up the binding for the (appId, envName) pair and enforce tenant / project
 * isolation against the resolved API-key principal. Returns either a resolved binding
 * or an already-written 401/404 response.
 */
async function resolveAndAuthorize(
  req: Request,
  res: Response,
  bindings: UnifiedBindingResolver,
): Promise<AgentAssistBinding | null> {
  const tenantContext = (req as Request & { tenantContext?: Record<string, unknown> })
    .tenantContext;
  if (!tenantContext || typeof tenantContext !== 'object') {
    res.status(401).json(errorBody('API_KEY_REQUIRED', 'x-api-key authentication is required.'));
    return null;
  }
  if ((tenantContext as { authType?: unknown }).authType !== 'api_key') {
    res.status(401).json(errorBody('API_KEY_REQUIRED', 'x-api-key authentication is required.'));
    return null;
  }

  const { appId, envName } = req.params;
  const tenantId = (tenantContext as { tenantId?: unknown }).tenantId;
  if (typeof tenantId !== 'string') {
    res.status(404).json(errorBody('APP_NOT_FOUND', 'Agent Assist app not found.'));
    return null;
  }

  const binding = await bindings.resolve(tenantId, appId, envName);

  if (!binding) {
    res.status(404).json(errorBody('APP_NOT_FOUND', 'Agent Assist app not found.'));
    return null;
  }

  if (binding.status === 'disabled') {
    // Per FR-12 / CLAUDE.md existence-disclosure invariant: a disabled binding
    // returns the same 404 APP_NOT_FOUND envelope as a missing binding so the
    // operational state of the binding is not observable from outside.
    log.info('agent-assist binding disabled', {
      appId,
      envName,
      bindingId: binding.bindingId,
      tenantId: binding.tenantId,
    });
    res.status(404).json(errorBody('APP_NOT_FOUND', 'Agent Assist app not found.'));
    return null;
  }

  const projectEnabled = await resolveProjectAgentAssistEnabled(
    binding.tenantId,
    binding.projectId,
  );
  if (projectEnabled === false) {
    log.info('agent-assist binding project disabled', {
      appId,
      envName,
      projectId: binding.projectId,
      tenantId: binding.tenantId,
    });
    res.status(404).json(errorBody('APP_NOT_FOUND', 'Agent Assist app not found.'));
    return null;
  }

  if (tenantId !== binding.tenantId) {
    log.warn('agent-assist tenant mismatch', {
      appId,
      envName,
      apiKeyTenantId: tenantId,
      bindingTenantId: binding.tenantId,
    });
    res.status(404).json(errorBody('APP_NOT_FOUND', 'Agent Assist app not found.'));
    return null;
  }

  const projectScope = (tenantContext as { projectScope?: unknown }).projectScope;
  if (Array.isArray(projectScope) && projectScope.length > 0) {
    const scopes = projectScope.filter((x): x is string => typeof x === 'string');
    if (!scopes.includes(binding.projectId)) {
      log.warn('agent-assist project scope mismatch', {
        appId,
        envName,
        apiKeyProjectScope: scopes,
        bindingProjectId: binding.projectId,
      });
      res.status(404).json(errorBody('APP_NOT_FOUND', 'Agent Assist app not found.'));
      return null;
    }
  }

  if (!(await requireProjectPermission(req, res, 'session:send_message', binding.projectId))) {
    return null;
  }

  log.debug('agent-assist binding resolved', {
    appId,
    envName,
    bindingStatus: binding.status,
    tenantId,
  });

  emitBindingResolved({
    tenantId: binding.tenantId,
    projectId: binding.projectId,
    appId: binding.appId,
    environment: binding.environment,
    bindingId: binding.bindingId,
    bindingStatus: binding.status,
  });

  return binding;
}

/** Build the creator / owner context from the resolved tenantContext. */
function callerFromContext(req: Request): { apiKeyId?: string; userId?: string } {
  const ctx = (req as Request & { tenantContext?: Record<string, unknown> }).tenantContext ?? {};
  const apiKeyIdRaw = (ctx as { apiKeyId?: unknown }).apiKeyId;
  const userIdRaw = (ctx as { userId?: unknown }).userId;
  return {
    apiKeyId: typeof apiKeyIdRaw === 'string' ? apiKeyIdRaw : undefined,
    userId: typeof userIdRaw === 'string' ? userIdRaw : undefined,
  };
}

/**
 * Attempt to call RuntimeExecutor.endSession for a given session ID.
 * Fire-and-forget: logs errors but never throws.
 */
function tryEndSession(sessionId: string, binding: AgentAssistBinding): void {
  try {
    // Dynamic import to avoid circular dependency at module load time
    import('../services/runtime-executor.js')
      .then(({ getRuntimeExecutor }) => {
        const executor = getRuntimeExecutor();
        executor.endSession(sessionId);
        log.info('agent-assist session terminated via RuntimeExecutor', {
          sessionId,
          appId: binding.appId,
          tenantId: binding.tenantId,
        });
      })
      .catch((err: unknown) => {
        log.warn('agent-assist session terminate — executor call failed', {
          sessionId,
          appId: binding.appId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  } catch (err) {
    log.warn('agent-assist session terminate — unexpected error', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface AgentAssistRouterOptions {
  /** Required binding resolver — usually Mongo-backed via `createBindingResolver`. */
  bindings: UnifiedBindingResolver;
  /**
   * Override the auth stack. Production leaves this unset to use the shared
   * `authMiddleware` (unified auth: x-api-key / Authorization Bearer / SDK).
   * Tests inject a stub that populates `req.tenantContext` directly.
   */
  authMiddleware?: RequestHandler | RequestHandler[];
  /** Body size limit (bytes). Defaults to AGENT_ASSIST_MAX_BODY_BYTES. */
  bodyLimitBytes?: number;
  /**
   * @deprecated The tenant-level feature gate has been removed — Agent Assist
   * is universally available, gated only at the per-project level inside
   * `resolveAndAuthorize`. Retained for test compatibility; passing this has
   * no effect.
   */
  featureGateDeps?: FeatureGateDeps;
  /**
   * @deprecated The tenant-level feature gate has been removed. Retained for
   * test compatibility; passing `true` is a no-op.
   */
  skipFeatureGate?: boolean;
  /**
   * Skip the per-tenant rate limit middleware. Production leaves this
   * unset; tests pass `true` so the route runs without booting the
   * HybridRateLimiter (which expects Redis or a connected Mongo).
   */
  skipRateLimit?: boolean;
  /** Lazy callback queue getter — wired after Redis/BullMQ bootstrap in server.ts. */
  callbackQueue?: () => AgentAssistCallbackQueueProducer | undefined;
  /** Test seam for route-level tests; production uses the real RuntimeExecutor bridge. */
  executeTurn?: typeof defaultExecuteTurn;
  /** Test seam for route-level tests; production resolves welcome text from deployments. */
  resolveWelcomeTextForBinding?: typeof defaultResolveWelcomeTextForBinding;
}

export function createAgentAssistRouter(options: AgentAssistRouterOptions): Router {
  const router = express.Router();
  const bindings = options.bindings;
  const auth = options.authMiddleware ?? authMiddleware;
  const bodyLimit = options.bodyLimitBytes ?? AGENT_ASSIST_MAX_BODY_BYTES;
  const callbackValidationOptions = resolveValidationOptions();
  const executeAgentAssistTurn = options.executeTurn ?? defaultExecuteTurn;
  const resolveWelcomeText =
    options.resolveWelcomeTextForBinding ?? defaultResolveWelcomeTextForBinding;

  router.use((req: Request, _res: Response, next: NextFunction) => {
    log.info('agent-assist router ENTRY', {
      path: req.path,
      method: req.method,
      originalUrl: req.originalUrl,
    });
    next();
  });
  router.use(express.json({ limit: bodyLimit }));
  // Debug recorder — gated by AGENT_ASSIST_DEBUG_RECORD=true. Must run
  // AFTER express.json so we can capture the parsed body.
  router.use(debugRecorderMiddleware());
  if (Array.isArray(auth)) {
    router.use(...auth);
  } else {
    router.use(auth);
  }

  // No tenant-level feature gate — Agent Assist is universally available.
  // The per-project enable toggle is enforced inside `resolveAndAuthorize`.

  // Per-tenant request throttle so a single misbehaving x-api-key holder
  // cannot drive unbounded LLM cost.
  if (!options.skipRateLimit) {
    router.use(tenantRateLimit('request'));
  }

  router.post('/:appId/environments/:envName/runs/execute', async (req: Request, res: Response) => {
    log.info('agent-assist execute route HIT', {
      appId: req.params.appId,
      envName: req.params.envName,
      hasAuth: Boolean(
        (req as Request & { tenantContext?: Record<string, unknown> }).tenantContext,
      ),
    });
    const binding = await resolveAndAuthorize(req, res, bindings);
    if (!binding) return;

    const parsed = v1ExecuteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        code: i.code,
        message: i.message,
      }));
      const rawBodyKeys =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? Object.keys(req.body as Record<string, unknown>)
          : [];
      log.warn('agent-assist Zod validation failed', {
        appId: binding.appId,
        envName: req.params.envName,
        issues,
        rawBodyKeys,
      });
      res
        .status(400)
        .json(
          errorBody(
            'INVALID_INPUT',
            parsed.error.issues.map((i) => i.message).join(', ') || 'Invalid request body.',
          ),
        );
      return;
    }
    const body = parsed.data;

    const userText = extractTextInput(body.input);
    if (!userText) {
      log.warn('agent-assist empty text input', {
        appId: binding.appId,
        inputTypes: body.input.map((i) => i.type),
      });
      res
        .status(400)
        .json(
          errorBody('INVALID_INPUT', 'input[] must contain at least one non-empty text block.'),
        );
      return;
    }

    const identity = extractSessionReference(body.sessionIdentity);
    const sessionReference =
      identity.sessionReference ?? identity.sessionId ?? identity.userReference;
    if (!sessionReference) {
      log.warn('agent-assist missing sessionReference', {
        appId: binding.appId,
        identityTypes: body.sessionIdentity.map((s) => s.type),
      });
      res
        .status(400)
        .json(
          errorBody(
            'INVALID_INPUT',
            'sessionIdentity must include one of sessionReference | sessionId | userReference.',
          ),
        );
      return;
    }

    const normalizedMetadata = normalizeV1Metadata(body.metadata);
    const forwardMetadata: Record<string, unknown> = {
      ...normalizedMetadata.forward,
      _agentAssist: {
        source: body.source,
        historyLength: normalizedMetadata.history.length,
      },
    };
    if (normalizedMetadata.history.length > 0) {
      forwardMetadata.history = normalizedMetadata.history;
    }

    const messageId = `msg_${crypto.randomUUID()}`;
    const caller = callerFromContext(req);
    const streaming = body.stream?.enable === true;
    const isAsync = body.isAsync === true;

    // Emit trace: request received
    emitReceived({
      tenantId: binding.tenantId,
      projectId: binding.projectId,
      appId: binding.appId,
      environment: binding.environment,
      messageId,
      isAsync,
      streaming,
    });

    const sessionInfoBase: V1SessionInfo = {
      sessionId: '',
      runId: '',
      status: 'processing',
      sessionReference,
      appId: binding.appId,
      source: body.source,
      userReference: identity.userReference,
      userId: caller.userId,
    };

    // ── SSE streaming path ───────────────────────────────────────────
    // Streaming takes precedence over `isAsync`. Kore.ai Agent Assist sends
    // `isAsync: true` together with `stream.enable: true` to request a
    // streaming response; in that mode the response is delivered over SSE
    // and no callbackUrl is required.
    if (streaming) {
      const emitter = new V1SSEEmitter(res, AGENT_ASSIST_SSE_HEARTBEAT_MS);
      emitter.start(req);

      const streamSessionId = computeAgentAssistSessionId(binding, sessionReference);
      const streamRunId = crypto.randomUUID();
      let emitterSessionInfo: V1SessionInfo = {
        ...sessionInfoBase,
        sessionId: streamSessionId,
        runId: streamRunId,
      };
      let openerEmitted = false;
      const emitOpener = (sessionId: string, runId: string): void => {
        if (openerEmitted) return;
        openerEmitted = true;
        emitterSessionInfo = { ...sessionInfoBase, sessionId, runId, status: 'processing' };
        emitter.emitOpener(emitterSessionInfo, messageId);
      };

      try {
        const result = await executeAgentAssistTurn({
          binding,
          input: {
            userMessage: userText,
            sessionReference,
            messageMetadata: forwardMetadata,
          },
          onChunk: (delta: string) => {
            emitOpener(streamSessionId, streamRunId);
            emitter.emitDelta(delta, messageId);
          },
          apiKeyId: caller.apiKeyId,
          userId: caller.userId,
          runId: streamRunId,
        });

        emitOpener(result.sessionId, result.runId);
        emitterSessionInfo = {
          ...emitterSessionInfo,
          sessionId: result.sessionId,
          runId: result.runId,
          status: 'completed',
        };

        emitDelegated({
          tenantId: binding.tenantId,
          projectId: binding.projectId,
          appId: binding.appId,
          environment: binding.environment,
          sessionId: result.sessionId,
          runId: result.runId,
          deploymentId: result.deploymentId,
        });

        emitter.emitFinal({
          messageId,
          sessionInfo: emitterSessionInfo,
          outputText: result.responseText,
          ...(result.richContent ? { richContent: result.richContent } : {}),
          ...(result.actions ? { actions: result.actions } : {}),
          ...(result.voiceConfig ? { voiceConfig: result.voiceConfig } : {}),
          ...(result.contentEnvelope ? { contentEnvelope: result.contentEnvelope } : {}),
          metadata: body.metadata,
        });

        emitTranslatedResponse({
          tenantId: binding.tenantId,
          projectId: binding.projectId,
          appId: binding.appId,
          environment: binding.environment,
          sessionId: result.sessionId,
          runId: result.runId,
          responseLength: result.responseText.length,
          mode: 'stream',
        });
      } catch (err) {
        const message = sanitizeError(err);
        log.error('agent-assist stream execution failed', {
          tenantId: binding.tenantId,
          projectId: binding.projectId,
          appId: binding.appId,
          error: err instanceof Error ? err.message : String(err),
        });
        emitError({
          tenantId: binding.tenantId,
          projectId: binding.projectId,
          appId: binding.appId,
          environment: binding.environment,
          errorCode: 'STREAM_EXECUTION_FAILED',
          errorMessage: message,
        });
        emitOpener(streamSessionId, streamRunId);
        emitter.emitError({
          messageId,
          sessionInfo: emitterSessionInfo,
          message,
        });
      } finally {
        emitter.end();
      }
      return;
    }

    // ── Async-push path ──────────────────────────────────────────────
    if (isAsync && typeof body.callbackUrl === 'string' && body.callbackUrl.length > 0) {
      const callbackUrl = body.callbackUrl;

      // Validate callback URL per D-16 (layered: syntactic at route, policy at worker)
      const urlCheck = validateCallbackUrl(callbackUrl, callbackValidationOptions);
      if (!urlCheck.valid) {
        res.status(400).json(errorBody('INVALID_CALLBACK_URL', 'Invalid callback URL.'));
        return;
      }

      const callbackQueue = options.callbackQueue?.();
      const allowSyncCallbackFallback = process.env.AGENT_ASSIST_CALLBACK_SYNC === 'true';
      if (!callbackQueue && !allowSyncCallbackFallback) {
        res
          .status(503)
          .json(
            errorBody(
              'CALLBACK_DELIVERY_UNAVAILABLE',
              'Async callback delivery is temporarily unavailable.',
            ),
          );
        return;
      }

      // Pre-compute sessionId + runId so the initial 202 envelope and the subsequent
      // callback envelope stay correlated. Previously the handler awaited `executeTurn`
      // before sending 202, which made async-push effectively sync from the caller's
      // perspective (they'd wait out the LLM roundtrip for a status they already chose).
      const asyncSessionId = computeAgentAssistSessionId(binding, sessionReference);
      const asyncRunId = crypto.randomUUID();

      const processingEnvelope = buildV1Envelope({
        messageId,
        sessionId: asyncSessionId,
        runId: asyncRunId,
        appId: binding.appId,
        sessionReference,
        userReference: identity.userReference,
        userId: caller.userId,
        source: body.source ?? AGENT_ASSIST_SOURCE_TAG,
        outputText: '',
        metadata: body.metadata,
        status: 'processing',
      });
      if (callbackQueue) {
        await callbackQueue.add({
          messageId,
          runId: asyncRunId,
          tenantId: binding.tenantId,
          projectId: binding.projectId,
          appId: binding.appId,
          envName: binding.environment,
          bindingId: binding.bindingId ?? '',
          callbackUrl,
          binding: {
            deploymentId: binding.deploymentId ?? null,
            apiKeyId: binding.apiKeyId ?? null,
            runtimeBaseUrl: binding.runtimeBaseUrl ?? null,
          },
          input: {
            executionInput: {
              userMessage: userText,
              sessionReference,
              messageMetadata: forwardMetadata,
            },
            source: body.source ?? AGENT_ASSIST_SOURCE_TAG,
            metadata: body.metadata,
            userReference: identity.userReference,
            callerUserId: caller.userId,
            callerApiKeyId: caller.apiKeyId,
          },
        });
        emitCallbackScheduled({
          tenantId: binding.tenantId,
          projectId: binding.projectId,
          appId: binding.appId,
          environment: binding.environment,
          runId: asyncRunId,
          callbackUrl,
        });
        res.status(202).json(processingEnvelope);
        return;
      }

      res.status(202).json(processingEnvelope);
      emitCallbackScheduled({
        tenantId: binding.tenantId,
        projectId: binding.projectId,
        appId: binding.appId,
        environment: binding.environment,
        runId: asyncRunId,
        callbackUrl,
      });

      void (async () => {
        try {
          const result = await executeAgentAssistTurn({
            binding,
            input: {
              userMessage: userText,
              sessionReference,
              messageMetadata: forwardMetadata,
            },
            apiKeyId: caller.apiKeyId,
            userId: caller.userId,
            runId: asyncRunId,
          });

          const envelope = buildV1Envelope({
            messageId,
            sessionId: result.sessionId,
            runId: result.runId,
            appId: binding.appId,
            sessionReference,
            userReference: identity.userReference,
            userId: caller.userId,
            source: body.source ?? AGENT_ASSIST_SOURCE_TAG,
            outputText: result.responseText,
            ...(result.richContent ? { richContent: result.richContent } : {}),
            ...(result.actions ? { actions: result.actions } : {}),
            ...(result.voiceConfig ? { voiceConfig: result.voiceConfig } : {}),
            ...(result.contentEnvelope ? { contentEnvelope: result.contentEnvelope } : {}),
            metadata: body.metadata,
            status: 'completed',
          });

          await deliverAsyncCallback(callbackUrl, envelope, {
            appId: binding.appId,
            tenantId: binding.tenantId,
            projectId: binding.projectId,
            sessionId: result.sessionId,
            runId: result.runId,
          });
        } catch (err) {
          const message = sanitizeError(err);
          log.error('agent-assist async execution failed', {
            tenantId: binding.tenantId,
            projectId: binding.projectId,
            appId: binding.appId,
            error: err instanceof Error ? err.message : String(err),
          });
          emitError({
            tenantId: binding.tenantId,
            projectId: binding.projectId,
            appId: binding.appId,
            environment: binding.environment,
            errorCode: 'EXECUTION_FAILED',
            errorMessage: message,
          });
          const errorEnvelope = buildV1ErrorEnvelope({
            messageId,
            sessionId: asyncSessionId,
            runId: asyncRunId,
            appId: binding.appId,
            sessionReference,
            userReference: identity.userReference,
            userId: caller.userId,
            source: body.source ?? AGENT_ASSIST_SOURCE_TAG,
            outputText: message,
            metadata: body.metadata,
          });
          await deliverAsyncCallback(callbackUrl, errorEnvelope, {
            appId: binding.appId,
            tenantId: binding.tenantId,
            projectId: binding.projectId,
            sessionId: asyncSessionId,
            runId: asyncRunId,
          });
        }
      })();
      return;
    }

    // ── Async flag without callbackUrl → validate ─────────────────────
    // Reached only when not streaming (the streaming branch above returns first).
    if (isAsync && (!body.callbackUrl || body.callbackUrl.length === 0)) {
      res
        .status(400)
        .json(errorBody('CALLBACK_URL_REQUIRED', 'callbackUrl is required when isAsync is true.'));
      return;
    }

    // ── Sync path ────────────────────────────────────────────────────
    try {
      const result = await executeAgentAssistTurn({
        binding,
        input: {
          userMessage: userText,
          sessionReference,
          messageMetadata: forwardMetadata,
        },
        apiKeyId: caller.apiKeyId,
        userId: caller.userId,
        runId: crypto.randomUUID(),
      });

      emitDelegated({
        tenantId: binding.tenantId,
        projectId: binding.projectId,
        appId: binding.appId,
        environment: binding.environment,
        sessionId: result.sessionId,
        runId: result.runId,
        deploymentId: result.deploymentId,
      });

      const envelope = buildV1Envelope({
        messageId,
        sessionId: result.sessionId,
        runId: result.runId,
        appId: binding.appId,
        sessionReference,
        userReference: identity.userReference,
        userId: caller.userId,
        source: body.source ?? AGENT_ASSIST_SOURCE_TAG,
        outputText: result.responseText,
        ...(result.richContent ? { richContent: result.richContent } : {}),
        ...(result.actions ? { actions: result.actions } : {}),
        ...(result.voiceConfig ? { voiceConfig: result.voiceConfig } : {}),
        ...(result.contentEnvelope ? { contentEnvelope: result.contentEnvelope } : {}),
        metadata: body.metadata,
        status: 'completed',
      });

      emitTranslatedResponse({
        tenantId: binding.tenantId,
        projectId: binding.projectId,
        appId: binding.appId,
        environment: binding.environment,
        sessionId: result.sessionId,
        runId: result.runId,
        responseLength: result.responseText.length,
        mode: 'sync',
      });

      res.status(200).json(envelope);
    } catch (err) {
      const message = sanitizeError(err);
      log.error('agent-assist sync execution failed', {
        tenantId: binding.tenantId,
        projectId: binding.projectId,
        appId: binding.appId,
        error: err instanceof Error ? err.message : String(err),
      });
      emitError({
        tenantId: binding.tenantId,
        projectId: binding.projectId,
        appId: binding.appId,
        environment: binding.environment,
        errorCode: 'SYNC_EXECUTION_FAILED',
        errorMessage: message,
      });
      const envelope = buildV1ErrorEnvelope({
        messageId,
        sessionId: computeAgentAssistSessionId(binding, sessionReference),
        runId: crypto.randomUUID(),
        appId: binding.appId,
        sessionReference,
        userReference: identity.userReference,
        userId: caller.userId,
        source: body.source ?? AGENT_ASSIST_SOURCE_TAG,
        outputText: message,
        metadata: body.metadata,
      });
      // V1 contract: runtime errors are HTTP 200 with sessionInfo.status:"error".
      res.status(200).json(envelope);
    }
  });

  router.post('/:appId/environments/:envName/sessions', async (req: Request, res: Response) => {
    const binding = await resolveAndAuthorize(req, res, bindings);
    if (!binding) return;
    const parsed = v1SessionsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      log.warn('agent-assist sessions create — validation failed', {
        appId: binding.appId,
        issues,
      });
      res
        .status(400)
        .json(errorBody('INVALID_INPUT', parsed.error.issues.map((i) => i.message).join(', ')));
      return;
    }
    const body = parsed.data;
    const sessionRefEntry = body.sessionIdentity.find(
      (i) =>
        i.type === 'sessionReference' || i.type === 'sessionId' || i.type === 'sessionIdentity',
    );
    const userRefEntry = body.sessionIdentity.find((i) => i.type === 'userReference');
    const sessionReference = sessionRefEntry?.value ?? null;
    const userReference = userRefEntry?.value ?? sessionRefEntry?.value ?? 'anonymous';
    const caller = callerFromContext(req);

    const metadataObj =
      typeof body.metadata === 'object' && body.metadata !== null
        ? (body.metadata as Record<string, unknown>)
        : undefined;
    const metadataSource =
      typeof metadataObj?.source === 'string' ? (metadataObj.source as string) : undefined;
    const resolvedSource = body.source ?? metadataSource ?? AGENT_ASSIST_SOURCE_TAG;

    const wantsWelcome = metadataObj?.isSendWelcomeMessage === true;
    // Welcome content, when requested, is resolved from the binding's active
    // deployment via AgentIR.on_start.respond → messages.greeting → platform
    // default (see welcome-resolver.ts). Failure is best-effort: we log and
    // emit an empty Welcome_Event slot rather than fail the session request.
    const welcomeText = wantsWelcome ? await resolveWelcomeText(binding) : undefined;

    const response = buildCreateSessionResponse({
      binding,
      sessionReference,
      userReference,
      source: resolvedSource,
      welcomeText,
      apiKeyIdSeed: caller.apiKeyId,
    });
    log.info('agent-assist session created', {
      appId: binding.appId,
      sessionId: response.session.sessionId,
      userId: response.session.userId,
      sessionReference,
      source: resolvedSource,
      wantsWelcome,
      welcomeTextLength: welcomeText?.length ?? 0,
    });
    res.status(200).json(response);
  });

  router.post(
    '/:appId/environments/:envName/sessions/terminate',
    async (req: Request, res: Response) => {
      const binding = await resolveAndAuthorize(req, res, bindings);
      if (!binding) return;
      const parsed = v1SessionsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        }));
        log.warn('agent-assist sessions terminate — validation failed', {
          appId: binding.appId,
          issues,
        });
        res
          .status(400)
          .json(errorBody('INVALID_INPUT', parsed.error.issues.map((i) => i.message).join(', ')));
        return;
      }
      const body = parsed.data;
      const idEntry = body.sessionIdentity.find(
        (i) => i.type === 'sessionId' || i.type === 'sessionIdentity',
      );
      const refEntry = body.sessionIdentity.find((i) => i.type === 'sessionReference');
      const userRefEntry = body.sessionIdentity.find((i) => i.type === 'userReference');
      const caller = callerFromContext(req);
      const response = buildTerminateSessionResponse({
        binding,
        sessionId: idEntry?.value,
        sessionReference: refEntry?.value,
        userReference: userRefEntry?.value,
        apiKeyIdSeed: caller.apiKeyId,
      });

      // Wire the real terminate via RuntimeExecutor.endSession (fire-and-forget).
      // Always return the terminate envelope even if the session doesn't exist.
      tryEndSession(response.sessionId, binding);

      log.info('agent-assist session terminated', {
        appId: binding.appId,
        sessionId: response.sessionId,
        sessionReference: response.sessionReference,
      });
      res.status(200).json(response);
    },
  );

  // Explicit 404 for anything else under this mount.
  router.use((_req: Request, res: Response) => {
    res.status(404).json(errorBody('APP_NOT_FOUND', 'Agent Assist app not found.'));
  });

  return router;
}

function sanitizeError(err: unknown): string {
  // Keep detailed messages in logs only; callers get a generic, non-identifying message.
  if (err instanceof Error && err.name === 'ZodError') {
    return 'Request validation failed.';
  }
  return GENERIC_RUNTIME_ERROR_MESSAGE;
}

// Re-export for backward compatibility
export { validateCallbackUrl };
