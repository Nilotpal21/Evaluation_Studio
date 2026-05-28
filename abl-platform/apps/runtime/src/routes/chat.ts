/**
 * Chat Routes
 *
 * SSE streaming chat endpoint with model routing and usage tracking.
 * Uses SessionLLMClient for all LLM calls (enforces org-level policies).
 */

import crypto from 'crypto';
import { Readable } from 'stream';
import Busboy from 'busboy';
import { type Router as RouterType, type Request, type Response } from 'express';
import type { MessageMetadata } from '@abl/compiler/platform/core/types.js';
import type { Environment } from '@agent-platform/config';
import { errorToResponse } from '@agent-platform/shared-kernel';
import { MODEL_ROUTING_TIERS } from '@agent-platform/shared-kernel/model-routing';
import { isLlmError } from '../services/llm/classify-llm-error.js';
import { getRuntimeErrorCustomerMessage } from '../services/execution/runtime-error-envelope.js';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { getRuntimeExecutor } from '../services/runtime-executor.js';
import type { ResolvedAgent } from '../services/deployment-resolver.js';
import {
  getExecutionCoordinator,
  isCoordinatorAvailable,
} from '../services/execution/coordinator-singleton.js';
import { isTenantEncryptionReady } from '@agent-platform/shared/encryption';
import {
  SessionLLMClient,
  type Message,
  type ToolDefinition,
  type SessionStreamEvent,
} from '../services/llm/index.js';
import { getModelCapabilities, hasKnownPricing } from '../services/llm/model-router.js';
import { getStores } from '../services/stores/store-factory.js';
import {
  findProjectByIdAndTenant,
  findProjectRuntimeConfig,
  findProjectWithAgents,
  loadConfigVariablesMap,
  resolveProjectEntryAgentName,
} from '../repos/project-repo.js';
import { createLogger } from '@abl/compiler/platform';
import { getCurrentTraceId } from '@abl/compiler/platform/observability';
import { emitChannelResponseSent } from '../services/channel-trace-utils.js';
import type { MetricsStore } from '@abl/compiler/platform/stores/metrics-store.js';
import { tenantRateLimit, checkSessionMessageRate } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { findSessionById } from '../repos/session-repo.js';
import { isResolutionDatabaseAvailable } from '../repos/llm-resolution-repo.js';
import { getChatResolutionService } from '../services/llm/chat-resolution-service.js';
import { buildCallerContext } from '../services/identity/artifact-hasher.js';
import { registerResolutionKey, resolveSession } from '../services/identity/session-resolver.js';
import {
  persistMessage,
  persistMessageRecord,
  persistScopedMessage,
  persistScopedTurnMetrics,
  persistTurnMetrics,
} from '../services/message-persistence-queue.js';
import {
  buildContactProductionExecutionScope,
  buildRequiredContactProductionExecutionScope,
  requiresCanonicalContactProductionScope,
} from '../services/session/execution-scope-factory.js';
import { getContactLinkingDeps } from '../services/identity/contact-linking-deps.js';
import { resolveCanonicalContactForProductionScope } from '../services/identity/production-contact-resolution.js';
import { resolveSessionTimeouts } from '../channels/pipeline/session-factory.js';
import { getSessionService } from '../services/session/session-service.js';
import { buildAssistantPersistenceMessages } from '../services/channel/outcome-persistence.js';
import type {
  ExecutionResult,
  RuntimeSession,
  SessionDataStore,
} from '../services/execution/types.js';
import { MockToolExecutor } from '../services/execution/mock-tool-executor.js';
import {
  createTokenLookups,
  evaluateAuthPreflightFromIR,
} from '../services/auth-profile/auth-preflight.js';
import {
  buildChannelTraceEvent,
  buildAuthRequiredOutcome,
  buildExecutionOutcome,
  buildErrorOutcome,
  buildOutcomeTraceEvent,
  hasRenderableChannelOutcome,
  runWithExecutionTimeout,
  ChannelExecutionTimeoutError,
  toPublicChannelOutcome,
} from '../services/channel/outcome.js';
import { WS_MESSAGE_TIMEOUT_MS } from '../services/channel/constants.js';
import {
  accumulateResponseProvenance,
  buildResponseMessageMetadata,
  createResponseProvenanceAccumulator,
  extractLlmTraceMetrics,
} from '../services/channel/response-provenance.js';
import { getTraceStore } from '../services/trace-store.js';
import type { TraceEventType, TraceEventWithId } from '../types/index.js';
import {
  toPublicInlineTraceEvent,
  type InlineTraceEvent,
  type PublicInlineTraceEvent,
} from './inline-trace-response.js';
import {
  matchesSessionOwner,
  matchesPlatformMemberSessionOwner,
  isElevatedPlatformRole,
  toAuthContext,
  type ChannelArtifactType,
  type CallerContext,
  type TenantContextData,
} from '@agent-platform/shared-auth';
import { normalizeSdkMessageMetadata } from '../services/identity/sdk-message-metadata.js';
import {
  extractLegacyClientInfoInteractionContext,
  mergeInteractionContextInputs,
  normalizeInteractionContextInput,
} from '../services/execution/interaction-context.js';
import {
  buildSessionLocalizationCatalog,
  storeRuntimeSessionLocalizationCatalog,
} from '../services/execution/localized-messages.js';
import { resolvePersistedAgentVersion } from '../services/execution/agent-version-utils.js';
import { sessionMetadataSchema, updateSessionMetadata } from '../services/session-metadata.js';
import { applyCallerContextToRuntimeSession } from '../services/session/runtime-session-identity.js';
import {
  buildProductionSessionLocator,
  type ProductionExecutionScope,
} from '../services/session/execution-scope.js';
import { ScopeValidationError } from '../services/session/scope-policy.js';
import { TTLCache } from '../utils/ttl-cache.js';
import {
  buildProjectWorkingCopyAgentSources,
  compileProjectWorkingCopy,
} from '../services/project-working-copy-compiler.js';
import {
  buildProjectDslReadinessError,
  evaluateProjectExecutionReadiness,
} from '../services/session/project-agent-dsl-readiness.js';
import { renderRuntimeTraceEventsForReadSurface } from '../services/pii/runtime-read-surface-renderer.js';
import { MultimodalServiceClient } from '../attachments/multimodal-service-client.js';
import { resolveAttachmentConfig } from '../attachments/attachment-config-resolver.js';
import {
  buildMultimodalUploadConfig,
  mimeTypeMatchesAllowed,
  normalizeUploadMimeType,
} from '../attachments/multimodal-upload-config.js';

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/v1/chat',
  tags: ['Chat'],
});
const router: RouterType = openapi.router;
const log = createLogger('chat-routes');
const PERSISTED_CHAT_SESSION_CACHE_TTL_MS = 5_000;
const PERSISTED_CHAT_SESSION_CACHE_MAX_ENTRIES = 5_000;
const PERSISTED_CHAT_SESSION_CACHE_ENABLED =
  process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true';
const MAX_CHAT_MULTIPART_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_CHAT_MULTIPART_FILES = 10;
const persistedChatSessionCache = new TTLCache<string>({
  maxSize: PERSISTED_CHAT_SESSION_CACHE_MAX_ENTRIES,
  ttlMs: PERSISTED_CHAT_SESSION_CACHE_TTL_MS,
});

function getPersistedChatSessionId(sessionId: string): string | undefined {
  if (!PERSISTED_CHAT_SESSION_CACHE_ENABLED) {
    return undefined;
  }

  return persistedChatSessionCache.get(sessionId);
}

function markPersistedChatSession(runtimeSessionId: string, dbSessionId: string): void {
  if (!PERSISTED_CHAT_SESSION_CACHE_ENABLED) {
    return;
  }

  persistedChatSessionCache.set(runtimeSessionId, dbSessionId);
}

async function syncPersistedChatSessionContact(
  dbSessionId: string | undefined,
  contactId: string | undefined,
): Promise<void> {
  if (!dbSessionId || !contactId) {
    return;
  }

  try {
    await getStores().conversation.linkContact(dbSessionId, contactId);
  } catch (err) {
    log.warn('Failed to backfill HTTP chat session contact', {
      dbSessionId,
      contactId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// =============================================================================
// BENCHMARK TIMING
// =============================================================================
// When the X-Load-Test header is present, [BENCH] timing logs are emitted
// for observability. No layers are bypassed — full production path always runs.
// =============================================================================
function getResolvedAgentLifecycle(resolved: ResolvedAgent) {
  const entryAgent =
    resolved.agents[resolved.entryAgent] ?? Object.values(resolved.agents)[0] ?? undefined;
  return entryAgent?.execution?.sessionLifecycle;
}

// Lazy-initialized MetricsStore (created on first use — ClickHouse only)
let _metricsStore: MetricsStore | null = null;
let _metricsStoreInitPromise: Promise<MetricsStore> | null = null;
async function getMetricsStoreAsync(): Promise<MetricsStore> {
  if (_metricsStore) return _metricsStore;
  if (_metricsStoreInitPromise) return _metricsStoreInitPromise;

  _metricsStoreInitPromise = (async () => {
    try {
      const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
      const { ClickHouseMetricsStore } =
        await import('../services/stores/clickhouse-metrics-store.js');
      const client = getClickHouseClient();
      _metricsStore = new ClickHouseMetricsStore(
        { type: 'clickhouse' },
        { client, tenantId: 'default' },
      );
      return _metricsStore;
    } catch (err) {
      log.warn('ClickHouse metrics unavailable, falling back to in-memory store', {
        error: err instanceof Error ? err.message : String(err),
      });
      const { InMemoryMetricsStore } =
        await import('@abl/compiler/platform/stores/metrics-store.js');
      _metricsStore = new InMemoryMetricsStore({ type: 'memory' });
      return _metricsStore;
    }
  })();

  return _metricsStoreInitPromise;
}

// NOTE: ClickHouse message writes are now handled by DualWriteMessageStore
// via the message persistence queue — no ad-hoc message stores needed here.

// All routes require authentication + rate limiting
router.use(authMiddleware);
router.use(tenantRateLimit('request'));

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([
    z.string(),
    z.array(
      z.object({
        type: z.enum(['text', 'image_url']),
        text: z.string().optional(),
        image_url: z
          .object({
            url: z.string(),
            detail: z.enum(['auto', 'low', 'high']).optional(),
          })
          .optional(),
      }),
    ),
  ]),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.record(z.unknown()),
      }),
    )
    .optional(),
});

const toolSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.unknown()),
});

const chatRequestSchema = z.object({
  projectId: z.string().min(1),
  sessionId: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  tools: z.array(toolSchema).optional(),
  modelId: z.string().optional(), // Override project default
  tier: z.enum(MODEL_ROUTING_TIERS).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200000).optional(),
});

// =============================================================================
// SSE HELPERS
// =============================================================================

/**
 * Write an SSE event to the response.
 */
function writeSSE(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendProjectNotFound(res: Response): void {
  res.status(404).json({
    error: {
      code: 'PROJECT_NOT_FOUND',
      message: 'Project not found',
    },
  });
}

/**
 * Calculate estimated cost based on token usage and model config.
 */
function calculateCost(
  inputTokens: number,
  outputTokens: number,
  inputCostPer1k: number | null,
  outputCostPer1k: number | null,
): number | null {
  if (inputCostPer1k == null || outputCostPer1k == null) {
    return null;
  }
  const inputCost = (inputCostPer1k / 1000) * inputTokens;
  const outputCost = (outputCostPer1k / 1000) * outputTokens;
  return inputCost + outputCost;
}

function buildInlineTraceContext(
  sessionId?: string,
): { sessionId: string; delivery: 'inline' } | undefined {
  if (!sessionId) {
    return undefined;
  }

  return {
    sessionId,
    delivery: 'inline',
  };
}

function recordSyntheticTraceEvent(params: {
  traceEvents: InlineTraceEvent[];
  sessionId?: string;
  session?: Pick<RuntimeSession, 'id' | 'tracer'>;
  event?: InlineTraceEvent;
}): void {
  if (!params.event) {
    return;
  }

  const storedTraceEvent: TraceEventWithId = {
    id: crypto.randomUUID(),
    sessionId: params.sessionId ?? params.session?.id ?? 'unknown',
    type: params.event.type as TraceEventType,
    timestamp: new Date(),
    data: params.event.data,
  };

  params.traceEvents.push(storedTraceEvent);

  if (params.session?.tracer) {
    params.session.tracer.emit({
      type: params.event.type,
      data: params.event.data,
    });
    return;
  }

  if (!params.sessionId) {
    return;
  }

  getTraceStore().addEvent(params.sessionId, storedTraceEvent);
}

async function renderInlineTraceEventsForResponse(
  traceEvents: InlineTraceEvent[],
  runtimeSession?: RuntimeSession | null,
): Promise<PublicInlineTraceEvent[] | undefined> {
  if (traceEvents.length === 0) {
    return undefined;
  }

  return renderRuntimeTraceEventsForReadSurface(
    traceEvents.map(toPublicInlineTraceEvent),
    runtimeSession,
  );
}

function isTruthyQueryFlag(value: unknown): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === 'true' || raw === '1';
}

async function buildInlineDebugPayload(params: {
  includeDebug: boolean;
  sessionId?: string;
  state?: unknown;
  traceEvents: InlineTraceEvent[];
  runtimeSession?: RuntimeSession | null;
}): Promise<{
  state?: unknown;
  traceEvents?: InlineTraceEvent[];
  traceContext?: { sessionId: string; delivery: 'inline' };
}> {
  if (!params.includeDebug) {
    return {};
  }

  return {
    state: params.state,
    traceEvents: await renderInlineTraceEventsForResponse(
      params.traceEvents,
      params.runtimeSession,
    ),
    traceContext: buildInlineTraceContext(params.sessionId),
  };
}

function extractErrorTracePayload(body: unknown): { code: string; message: string } {
  const fallback = {
    code: 'REQUEST_FAILED',
    message: 'Request failed',
  };

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fallback;
  }

  const bodyRecord = body as Record<string, unknown>;
  const errorValue = bodyRecord.error;

  if (typeof errorValue === 'string') {
    return {
      code: fallback.code,
      message: errorValue,
    };
  }

  if (errorValue && typeof errorValue === 'object' && !Array.isArray(errorValue)) {
    const errorRecord = errorValue as Record<string, unknown>;
    return {
      code: typeof errorRecord.code === 'string' ? errorRecord.code : fallback.code,
      message:
        typeof errorRecord.message === 'string'
          ? errorRecord.message
          : typeof bodyRecord.message === 'string'
            ? bodyRecord.message
            : fallback.message,
    };
  }

  if (typeof bodyRecord.message === 'string') {
    return {
      code: fallback.code,
      message: bodyRecord.message,
    };
  }

  return fallback;
}

function buildStoredSessionCallerContext(
  session:
    | {
        tenantId?: string | null;
        channel?: string | null;
        contactId?: string | null;
        customerId?: string | null;
        sessionPrincipalId?: string | null;
        anonymousId?: string | null;
        channelArtifact?: string | null;
        channelArtifactType?: string | null;
        channelId?: string | null;
        initiatedById?: string | null;
        identityTier?: number | null;
        verificationMethod?: string | null;
      }
    | undefined,
): CallerContext | undefined {
  if (!session) {
    return undefined;
  }

  if (
    !session.customerId &&
    !session.sessionPrincipalId &&
    !session.anonymousId &&
    !session.channelArtifact
  ) {
    return undefined;
  }

  const sessionPrincipalId = session.sessionPrincipalId ?? session.anonymousId ?? undefined;
  const anonymousId = session.anonymousId ?? sessionPrincipalId;

  return {
    tenantId: session.tenantId ?? '',
    channel: session.channel ?? 'unknown',
    contactId: session.contactId ?? undefined,
    customerId: session.customerId ?? undefined,
    sessionPrincipalId,
    anonymousId,
    channelArtifact: session.channelArtifact ?? undefined,
    channelArtifactType:
      (session.channelArtifactType as ChannelArtifactType | null | undefined) ?? undefined,
    channelId: session.channelId ?? undefined,
    initiatedById: session.initiatedById ?? undefined,
    identityTier: (session.identityTier ?? 0) as 0 | 1 | 2,
    verificationMethod:
      (session.verificationMethod as CallerContext['verificationMethod'] | null | undefined) ??
      'none',
    authScope: session.customerId ? 'user' : sessionPrincipalId ? 'session' : undefined,
  };
}

function resolveRuntimeAuthPrincipal(
  tenantContext: TenantContextData | undefined,
): string | undefined {
  if (!tenantContext) {
    return undefined;
  }

  if (tenantContext.authType !== 'sdk_session') {
    return tenantContext.userId;
  }

  const authContext = toAuthContext(tenantContext);
  if (authContext.authType !== 'sdk_session') {
    return tenantContext.userId;
  }

  return (
    authContext.callerIdentity.customerId ||
    authContext.callerIdentity.sessionPrincipalId ||
    authContext.callerIdentity.anonymousId ||
    tenantContext.userId
  );
}

function buildChatCallerContext(
  tenantId: string,
  tenantContext: TenantContextData | undefined,
): CallerContext {
  if (tenantContext?.authType !== 'sdk_session') {
    return buildCallerContext({
      tenantId,
      channel: 'api',
      initiatedById: tenantContext?.userId,
      identityTier: 0,
      verificationMethod: 'none',
    });
  }

  const authContext = toAuthContext(tenantContext);
  if (authContext.authType !== 'sdk_session') {
    return buildCallerContext({
      tenantId,
      channel: 'api',
      initiatedById: tenantContext.userId,
      identityTier: 0,
      verificationMethod: 'none',
    });
  }

  const callerIdentity = authContext.callerIdentity;
  const callerContext = buildCallerContext({
    tenantId,
    channel: 'sdk_http',
    channelId: authContext.channelId,
    contactId: tenantContext.contactId,
    customerId: callerIdentity.customerId,
    anonymousId: callerIdentity.sessionPrincipalId || callerIdentity.anonymousId,
    initiatedById: tenantContext.userId,
    identityTier: callerIdentity.identityTier,
    verificationMethod: callerIdentity.verificationMethod,
  });

  return {
    ...callerContext,
    ...(callerIdentity.channelArtifact ? { channelArtifact: callerIdentity.channelArtifact } : {}),
    ...(callerIdentity.channelArtifactType
      ? { channelArtifactType: callerIdentity.channelArtifactType }
      : {}),
    ...(callerIdentity.sessionPrincipalId
      ? { sessionPrincipalId: callerIdentity.sessionPrincipalId }
      : {}),
    ...(callerIdentity.authScope ? { authScope: callerIdentity.authScope } : {}),
  };
}

function buildHttpChatPersistenceScope(params: {
  tenantContext: TenantContextData | undefined;
  tenantId: string | undefined;
  projectId: string;
  sessionId: string | undefined;
  environment: string | undefined;
  callerContext: CallerContext | undefined;
  contactId: string | undefined;
}): ProductionExecutionScope | null {
  const { tenantContext, tenantId, projectId, sessionId, environment, callerContext, contactId } =
    params;

  if (!tenantContext || tenantContext.authType !== 'sdk_session') {
    return null;
  }

  const channelId = tenantContext.channelId ?? callerContext?.channelId;
  return buildContactProductionExecutionScope({
    tenantId,
    projectId,
    sessionId,
    sessionPrincipalId:
      callerContext?.sessionPrincipalId ?? callerContext?.anonymousId ?? sessionId,
    channelId,
    environment,
    source: 'chat_http',
    authType: 'sdk_session',
    traceId: getCurrentTraceId() ?? crypto.randomUUID(),
    contactId,
    callerContext,
    identityTier: tenantContext.identityTier,
    verificationMethod: tenantContext.verificationMethod,
    channelArtifact: tenantContext.channelArtifact,
  });
}

function shouldRequireCanonicalHttpChatScope(
  tenantContext: TenantContextData | undefined,
  callerContext: CallerContext | undefined,
): boolean {
  if (!tenantContext || tenantContext.authType !== 'sdk_session') {
    return false;
  }

  return requiresCanonicalContactProductionScope({
    authScope: tenantContext.authScope,
    verifiedUserId: tenantContext.verifiedUserId,
    contactId: tenantContext.contactId ?? callerContext?.contactId,
    identityTier: tenantContext.identityTier ?? callerContext?.identityTier,
    verificationMethod: tenantContext.verificationMethod ?? callerContext?.verificationMethod,
  });
}

function buildRequiredHttpChatExecutionScope(params: {
  tenantContext: TenantContextData | undefined;
  tenantId: string | undefined;
  projectId: string;
  sessionId: string | undefined;
  environment: string | undefined;
  callerContext: CallerContext | undefined;
  contactId: string | undefined;
}): ProductionExecutionScope | null {
  const { tenantContext, tenantId, projectId, sessionId, environment, callerContext, contactId } =
    params;

  if (!shouldRequireCanonicalHttpChatScope(tenantContext, callerContext)) {
    return null;
  }

  const channelId = tenantContext?.channelId ?? callerContext?.channelId;
  return buildRequiredContactProductionExecutionScope({
    tenantId,
    projectId,
    sessionId,
    sessionPrincipalId:
      callerContext?.sessionPrincipalId ?? callerContext?.anonymousId ?? sessionId,
    channelId,
    environment,
    source: 'chat_http',
    authType: 'sdk_session',
    traceId: getCurrentTraceId() ?? crypto.randomUUID(),
    contactId,
    callerContext,
    identityTier: tenantContext?.identityTier ?? callerContext?.identityTier,
    verificationMethod: tenantContext?.verificationMethod ?? callerContext?.verificationMethod,
    channelArtifact: tenantContext?.channelArtifact ?? callerContext?.channelArtifact,
    channelArtifactType: callerContext?.channelArtifactType,
  });
}

async function ensureHttpChatContactForRequiredScope(params: {
  tenantContext: TenantContextData | undefined;
  tenantId: string | undefined;
  callerContext: CallerContext | undefined;
  sessionId?: string;
}): Promise<CallerContext | undefined> {
  const { tenantContext, tenantId, callerContext, sessionId } = params;

  if (
    !shouldRequireCanonicalHttpChatScope(tenantContext, callerContext) ||
    !tenantId ||
    !callerContext ||
    callerContext.contactId
  ) {
    return callerContext;
  }

  const deps = getContactLinkingDeps();
  if (!deps) {
    return callerContext;
  }

  const result = await resolveCanonicalContactForProductionScope(
    {
      tenantId,
      callerContext,
      channelType: callerContext.channel,
      sessionId,
    },
    deps,
  );

  if (!result) {
    return callerContext;
  }

  return {
    ...callerContext,
    contactId: result.contactId,
    ...(result.displayName ? { contactDisplayName: result.displayName } : {}),
  };
}

function sendChatScopeValidationError(res: Response, err: ScopeValidationError): void {
  res.status(400).json({
    success: false,
    error: {
      code: err.code,
      message:
        err.code === 'UNSUPPORTED_SCOPE_KIND'
          ? 'Unsupported execution scope kind.'
          : 'Invalid production session scope.',
    },
  });
}

function normalizeResolvedChatEnvironment(environment: string | null | undefined): Environment {
  const envMap: Record<string, Environment> = {
    dev: 'dev',
    development: 'dev',
    staging: 'staging',
    production: 'production',
    prod: 'production',
  };

  return envMap[environment ?? ''] ?? 'dev';
}

function hasVerifiedSdkContinuityArtifact(
  callerContext: CallerContext | undefined,
): callerContext is CallerContext & {
  authScope: 'user';
  channel: 'sdk_http';
  channelArtifact: string;
  channelId: string;
} {
  return (
    callerContext?.authScope === 'user' &&
    callerContext.channel === 'sdk_http' &&
    typeof callerContext.channelArtifact === 'string' &&
    callerContext.channelArtifact.length > 0 &&
    typeof callerContext.channelId === 'string' &&
    callerContext.channelId.length > 0
  );
}

async function registerChatResolutionKey(
  tenantId: string | undefined,
  callerContext: CallerContext | undefined,
  sessionId: string | undefined,
): Promise<void> {
  if (!tenantId || !sessionId || !hasVerifiedSdkContinuityArtifact(callerContext)) {
    return;
  }

  try {
    const sessionService = getSessionService();
    if (!sessionService.isDistributed()) {
      log.debug(
        'Skipping SDK HTTP continuity resolution key registration on non-distributed store',
        {
          tenantId,
          sessionId,
          channelId: callerContext.channelId,
        },
      );
      return;
    }

    await registerResolutionKey(sessionService.store, {
      tenantId,
      channelId: callerContext.channelId,
      artifactHash: callerContext.channelArtifact,
      sessionId,
    });
  } catch (err) {
    log.warn('Failed to register HTTP session resolution key', {
      tenantId,
      sessionId,
      channelId: callerContext.channelId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function ensureSessionResumeAccess(
  tenantContext: TenantContextData,
  projectId: string,
  session:
    | {
        tenantId?: string | null;
        projectId?: string | null;
        userId?: string | null;
        callerContext?: CallerContext;
      }
    | {
        tenantId?: string | null;
        projectId?: string | null;
        initiatedById?: string | null;
        callerContext?: CallerContext;
      },
): boolean {
  if ((session.tenantId ?? null) !== tenantContext.tenantId) {
    return false;
  }

  if ((session.projectId ?? null) !== projectId) {
    return false;
  }

  if (tenantContext.authType === 'sdk_session') {
    const authContext = toAuthContext(tenantContext);
    if (authContext.authType !== 'sdk_session' || !session.callerContext) {
      return false;
    }
    return matchesSessionOwner(
      session.callerContext,
      authContext.callerIdentity,
      authContext.channelId,
    );
  }

  if (tenantContext.authType === 'user' && !isElevatedPlatformRole(tenantContext.role)) {
    const ownerUserId =
      'initiatedById' in session
        ? session.initiatedById
        : 'userId' in session
          ? session.userId
          : undefined;
    return matchesPlatformMemberSessionOwner(ownerUserId, tenantContext.userId);
  }

  return true;
}

/**
 * Transform chat request messages into Anthropic format.
 * Extracts system messages into a separate systemPrompt.
 */
function transformMessages(messages: z.infer<typeof messageSchema>[]): {
  systemPrompt: string;
  llmMessages: Message[];
} {
  let systemPrompt = 'You are a helpful assistant.';
  const llmMessages: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      llmMessages.push({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      });
    }
  }

  return { systemPrompt, llmMessages };
}

/**
 * Transform request tools to Anthropic tool format.
 */
function transformTools(tools?: z.infer<typeof toolSchema>[]): ToolDefinition[] {
  if (!tools || tools.length === 0) return [];

  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object' as const,
      properties:
        (t.parameters as Record<string, { type: string; description?: string; enum?: string[] }>) ||
        {},
    },
  }));
}

// =============================================================================
// ROUTES
// =============================================================================

/**
 * POST /api/v1/chat/stream
 * SSE streaming chat completion via SessionLLMClient
 */
openapi.route(
  'post',
  '/stream',
  {
    summary: 'Stream chat completion',
    description: 'SSE streaming chat completion with model routing and usage tracking',
    body: chatRequestSchema,
    response: z.string(),
    responseContentType: 'text/event-stream',
  },
  async (req, res) => {
    const _t0 = Date.now();
    const result = chatRequestSchema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({ error: 'Invalid request', details: result.error.issues });
      return;
    }

    // Verify encryption is available for credential decryption
    if (!isTenantEncryptionReady()) {
      res.status(503).json({ error: 'Tenant DEK encryption is not initialized' });
      return;
    }

    const { projectId, sessionId, messages, tools } = result.data;
    const userId = resolveRuntimeAuthPrincipal(req.tenantContext) || req.tenantContext!.userId!;
    const _t1 = Date.now();

    try {
      if (!(await requireProjectPermission(req, res, 'session:send_message', projectId))) {
        return;
      }
      const _t2 = Date.now();

      // Per-session message rate limiting
      if (sessionId) {
        const msgRate = await checkSessionMessageRate(sessionId);
        if (!msgRate.allowed) {
          res.status(429).json({
            error: 'Session message rate limit exceeded',
            retryAfterMs: msgRate.retryAfterMs,
          });
          return;
        }
      }

      // Verify project access (also extract tenantId)
      // NOTE: Original code checked ownerId; repo function uses tenantId.
      // Using tenantId from auth context for multi-tenant consistency.
      const tenantId = req.tenantContext!.tenantId;
      const project = await findProjectByIdAndTenant(projectId, tenantId);
      const _t3 = Date.now();

      if (!project) {
        sendProjectNotFound(res);
        return;
      }

      // Create SessionLLMClient via ModelResolutionService (singleton)
      // This enforces tenant-level policies (provider allowlists, credential policies)
      const resolution = getChatResolutionService();
      const client = new SessionLLMClient(resolution, {
        tenantId: project.tenantId ?? undefined,
        projectId,
        agentName: 'chat',
        userId,
        sessionId: sessionId || 'adhoc',
      });

      // Transform messages and tools
      const { systemPrompt, llmMessages } = transformMessages(messages);
      const llmTools = transformTools(tools);
      const _t4 = Date.now();

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, 15000);

      // Track metrics
      const startTime = Date.now();
      // Benchmark timing: log breakdown of pre-LLM overhead
      const isBenchmark = !!req.headers['x-load-test'];
      if (isBenchmark) {
        log.info('[BENCH] Pre-LLM timing', {
          parse_validate: _t1 - _t0,
          permission_check: _t2 - _t1,
          project_lookup: _t3 - _t2,
          client_setup: _t4 - _t3,
          total_pre_llm: _t4 - _t0,
        });
      }
      let inputTokens = 0;
      let outputTokens = 0;
      let toolCallCount = 0;
      let resolvedModelId = '';
      let resolvedProvider = '';

      try {
        for await (const event of client.streamChatWithToolUse(
          systemPrompt,
          llmMessages,
          llmTools,
        )) {
          switch (event.type) {
            case 'metadata':
              resolvedModelId = event.resolvedModel?.modelId || '';
              resolvedProvider = event.resolvedModel?.provider || '';
              writeSSE(res, 'metadata', {
                modelId: resolvedModelId,
                provider: resolvedProvider,
                source: event.resolvedModel?.source,
              });
              break;
            case 'text_delta':
              writeSSE(res, 'text_delta', { delta: event.delta });
              break;
            case 'tool_call_start':
              toolCallCount++;
              writeSSE(res, 'tool_call_start', event.toolCall);
              break;
            case 'tool_call_delta':
              writeSSE(res, 'tool_call_delta', event.toolCall);
              break;
            case 'tool_call_end':
              writeSSE(res, 'tool_call_end', event.toolCall);
              break;
            case 'usage':
              if (event.usage) {
                inputTokens = event.usage.inputTokens || inputTokens;
                outputTokens = event.usage.outputTokens || outputTokens;
              }
              writeSSE(res, 'usage', event.usage);
              break;
            case 'error':
              log.error('Stream error', { error: event.error, sessionId });
              writeSSE(res, 'error', {
                error: event.error || 'An error occurred while processing your request',
              });
              break;
            case 'done':
              break;
          }
        }

        // Send completion event
        const latencyMs = Date.now() - startTime;
        // Benchmark timing: log LLM stream duration
        if (isBenchmark) {
          log.info('[BENCH] Stream timing', {
            llm_stream_ms: latencyMs,
            total_request_ms: Date.now() - _t0,
          });
        }

        // Get model config for cost calculation (best-effort)
        let estimatedCost: number | null = null;
        try {
          if (hasKnownPricing(resolvedModelId)) {
            const capabilities = getModelCapabilities(resolvedModelId);
            estimatedCost = calculateCost(
              inputTokens,
              outputTokens,
              capabilities.inputCostPer1k,
              capabilities.outputCostPer1k,
            );
          }
        } catch (err) {
          log.debug('Cost estimation failed', {
            modelId: resolvedModelId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        writeSSE(res, 'complete', {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          estimatedCost,
          latencyMs,
        });

        // Record usage metric (fire-and-forget)
        getMetricsStoreAsync()
          .then(async (store) => {
            await store.record({
              tenantId,
              sessionId: sessionId || 'adhoc',
              projectId,
              userId,
              modelId: resolvedModelId,
              provider: resolvedProvider,
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              estimatedCost,
              latencyMs,
              streamingUsed: true,
              toolCallCount,
              knownSource:
                (sessionId ? getRuntimeExecutor().getSession(sessionId)?.knownSource : undefined) ??
                'production',
            });
          })
          .catch((err: unknown) => log.warn('Chat stream metrics store record failed', { err }));
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error('Stream processing error', { error: errorMsg, sessionId });
        const userFacingError =
          getRuntimeErrorCustomerMessage(error) ??
          (isLlmError(error)
            ? "I'm having trouble completing that request. Please try again."
            : 'An error occurred while processing your request');
        writeSSE(res, 'error', { error: userFacingError });
      } finally {
        clearInterval(heartbeat);
        res.end();
        emitChannelResponseSent(sessionId || 'adhoc', 'chat-stream', Date.now() - startTime, {
          tenantId,
          projectId,
          configHash: sessionId
            ? getRuntimeExecutor().getSession(sessionId)?.configHash
            : undefined,
          knownSource: sessionId
            ? getRuntimeExecutor().getSession(sessionId)?.knownSource
            : undefined,
        });
      }
    } catch (error) {
      log.error('Stream setup error', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      } else {
        writeSSE(res, 'error', { error: 'Internal server error' });
        res.end();
      }
    }
  },
);

/**
 * POST /api/v1/chat/complete
 * Non-streaming chat completion via SessionLLMClient
 */
openapi.route(
  'post',
  '/complete',
  {
    summary: 'Non-streaming chat completion',
    description: 'Non-streaming chat completion with model routing and usage tracking',
    body: chatRequestSchema,
    response: z.object({
      content: z.string(),
      toolCalls: z
        .array(
          z.object({
            id: z.string(),
            name: z.string(),
            arguments: z.record(z.unknown()),
          }),
        )
        .optional(),
      model: z.string().optional(),
      finishReason: z.string().optional(),
      usage: z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        totalTokens: z.number(),
        estimatedCost: z.number().nullable(),
      }),
      latencyMs: z.number(),
    }),
  },
  async (req, res) => {
    const result = chatRequestSchema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({ error: 'Invalid request', details: result.error.issues });
      return;
    }

    if (!isTenantEncryptionReady()) {
      res.status(503).json({ error: 'Tenant DEK encryption is not initialized' });
      return;
    }

    const { projectId, sessionId, messages, tools } = result.data;
    const userId = req.tenantContext!.userId!;

    try {
      if (!(await requireProjectPermission(req, res, 'session:send_message', projectId))) {
        return;
      }

      // Per-session message rate limiting
      if (sessionId) {
        const msgRate = await checkSessionMessageRate(sessionId);
        if (!msgRate.allowed) {
          res.status(429).json({
            error: 'Session message rate limit exceeded',
            retryAfterMs: msgRate.retryAfterMs,
          });
          return;
        }
      }

      // Verify project access
      // NOTE: Original code checked ownerId; repo function uses tenantId.
      // Using tenantId from auth context for multi-tenant consistency.
      const tenantId = req.tenantContext!.tenantId;
      const project = await findProjectByIdAndTenant(projectId, tenantId);

      if (!project) {
        sendProjectNotFound(res);
        return;
      }

      // Create SessionLLMClient via ModelResolutionService (singleton)
      const resolution = getChatResolutionService();
      const client = new SessionLLMClient(resolution, {
        tenantId: project.tenantId ?? undefined,
        projectId,
        agentName: 'chat',
        userId,
        sessionId: sessionId || 'adhoc',
      });

      // Transform messages and tools
      const { systemPrompt, llmMessages } = transformMessages(messages);
      const llmTools = transformTools(tools);

      // Execute completion
      const startTime = Date.now();
      const completion = await client.chatWithToolUse(systemPrompt, llmMessages, llmTools);
      const latencyMs = Date.now() - startTime;

      const inputTokens = completion.usage?.inputTokens || 0;
      const outputTokens = completion.usage?.outputTokens || 0;

      // Get cost estimate (best-effort)
      let estimatedCost: number | null = null;
      try {
        const costModelId = completion.resolvedModel?.modelId || '';
        if (hasKnownPricing(costModelId)) {
          const capabilities = getModelCapabilities(costModelId);
          estimatedCost = calculateCost(
            inputTokens,
            outputTokens,
            capabilities.inputCostPer1k,
            capabilities.outputCostPer1k,
          );
        }
      } catch (err) {
        log.debug('Cost estimation failed', {
          modelId: completion.resolvedModel?.modelId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Record usage metric (fire-and-forget)
      getMetricsStoreAsync()
        .then(async (store) => {
          await store.record({
            tenantId,
            sessionId: sessionId || 'adhoc',
            projectId,
            userId,
            modelId: completion.resolvedModel?.modelId || '',
            provider: completion.resolvedModel?.provider || '',
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            estimatedCost,
            latencyMs,
            streamingUsed: false,
            toolCallCount: completion.toolCalls?.length || 0,
            knownSource:
              (sessionId ? getRuntimeExecutor().getSession(sessionId)?.knownSource : undefined) ??
              'production',
          });
        })
        .catch((err: unknown) => log.warn('Chat complete metrics store record failed', { err }));

      res.json({
        content: completion.text,
        toolCalls: completion.toolCalls.length > 0 ? completion.toolCalls : undefined,
        model: completion.resolvedModel?.modelId,
        finishReason: completion.stopReason,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          estimatedCost,
        },
        latencyMs,
      });
    } catch (error) {
      log.error('Complete error', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (isLlmError(error)) {
        res.status(error.statusCode).json({
          error:
            getRuntimeErrorCustomerMessage(error) ??
            "I'm having trouble completing that request. Please try again.",
        });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  },
);

/**
 * GET /api/v1/chat/usage
 * Get usage metrics for a project
 */
openapi.route(
  'get',
  '/usage',
  {
    summary: 'Get usage metrics',
    description:
      'Get usage metrics for a project with optional date range and grouping (query params: projectId, startDate, endDate, groupBy)',
    response: z.object({
      summary: z
        .object({
          totalTokens: z.number(),
          totalCost: z.number(),
          requestCount: z.number(),
          avgLatency: z.number(),
        })
        .optional(),
      byModel: z.array(
        z.object({
          modelId: z.string(),
          provider: z.string(),
          totalTokens: z.number(),
          totalCost: z.number(),
          requestCount: z.number(),
        }),
      ),
    }),
  },
  async (req, res) => {
    try {
      const { projectId, startDate, endDate, groupBy } = req.query;

      if (!projectId) {
        res.status(400).json({ error: 'projectId required' });
        return;
      }

      if (!(await requireProjectPermission(req, res, 'session:read', String(projectId)))) {
        return;
      }

      // Verify project access
      // NOTE: Original code checked ownerId; repo function uses tenantId.
      // Using tenantId from auth context for multi-tenant consistency.
      const tenantId = req.tenantContext!.tenantId;
      const project = await findProjectByIdAndTenant(projectId as string, tenantId);

      if (!project) {
        sendProjectNotFound(res);
        return;
      }

      // Build query params — use async version to pick ClickHouse when enabled
      const metricsStore = await getMetricsStoreAsync();
      const queryParams = {
        projectId: projectId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
      };

      // Get aggregated metrics
      const summary = await metricsStore.getUsage(queryParams);

      // Get breakdown by model if requested
      const byModel = groupBy === 'model' ? await metricsStore.getCostBreakdown(queryParams) : [];

      res.json({
        summary,
        byModel,
      });
    } catch (error) {
      log.error('Usage query error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// =============================================================================
// AGENT-BACKED CHAT (Sprint 3)
// =============================================================================

const testContextPayloadSchema = z
  .object({
    gatherValues: z.record(z.unknown()).optional(),
    sessionVariables: z.record(z.unknown()).optional(),
    callerContext: z
      .object({
        userId: z.string().max(200).optional(),
        channel: z.string().max(64).optional(),
        customAttributes: z.record(z.unknown()).optional(),
      })
      .optional(),
    toolMocks: z
      .array(
        z.object({
          toolName: z.string(),
          response: z.unknown().optional(),
          success: z.boolean().optional(),
          error: z.object({ code: z.string(), message: z.string() }).optional(),
          delayMs: z.number().max(30000).optional(),
          matchParams: z.record(z.unknown()).optional(),
        }),
      )
      .max(50)
      .optional(),
    skipOnStart: z.boolean().optional(),
    startAtStep: z.string().optional(),
  })
  .strict();

const interactionContextInputSchema = z
  .object({
    language: z.string().max(64).optional(),
    locale: z.string().max(64).optional(),
    timezone: z.string().max(128).optional(),
  })
  .strict();

const agentChatSchema = z.object({
  projectId: z.string().min(1),
  sessionId: z.string().optional(),
  message: z.string().min(1),
  attachmentIds: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
  interactionContext: interactionContextInputSchema.optional(),
  /** Integration-supplied session metadata — stored at session.data.values._metadata */
  sessionMetadata: sessionMetadataSchema,
  deploymentId: z.string().optional(),
  environment: z.string().optional(),
  /** Override which agent handles the first turn (eval use case) */
  agentId: z.string().optional(),
  /** Test context (requires WRITE_ROLES) */
  testContext: testContextPayloadSchema.optional(),
  /** Session purpose tag — requires eval/simulate permissions for non-production values */
  knownSource: z.enum(['production', 'eval', 'synthetic']).optional(),
  /** Include runtime debug fields such as state, traceEvents, and traceContext. */
  debug: z.boolean().optional(),
});

type AgentChatTestContext = z.infer<typeof testContextPayloadSchema>;

interface ChatMultipartFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

type ChatMultipartParseResult =
  | { success: true; body: Record<string, unknown>; files: ChatMultipartFile[] }
  | { success: false; status: number; error: { code: string; message: string } };

function parseJsonMultipartField(value: string, fieldName: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Field "${fieldName}" must be valid JSON`);
  }
}

function parseBooleanMultipartField(value: string): boolean {
  return value === 'true' || value === '1';
}

function normalizeMultipartAttachmentIds(value: string | string[]): string[] {
  const values = Array.isArray(value) ? value : [value];
  const ids: string[] = [];

  for (const item of values) {
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('[')) {
      const parsed = parseJsonMultipartField(trimmed, 'attachmentIds');
      if (!Array.isArray(parsed)) {
        throw new Error('Field "attachmentIds" must be a JSON array or repeated string field');
      }
      for (const id of parsed) {
        if (typeof id !== 'string') {
          throw new Error('Field "attachmentIds" must contain only strings');
        }
        ids.push(id);
      }
      continue;
    }
    ids.push(trimmed);
  }

  return ids;
}

function buildAgentChatBodyFromMultipartFields(
  fields: Record<string, string | string[]>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const stringFields = [
    'projectId',
    'sessionId',
    'message',
    'deploymentId',
    'environment',
    'agentId',
    'knownSource',
  ];
  const jsonFields = ['metadata', 'interactionContext', 'sessionMetadata', 'testContext'];

  for (const field of stringFields) {
    const value = fields[field];
    if (typeof value === 'string') {
      body[field] = value;
    }
  }

  for (const field of jsonFields) {
    const value = fields[field];
    if (typeof value === 'string' && value.trim()) {
      body[field] = parseJsonMultipartField(value, field);
    }
  }

  if (fields.attachmentIds) {
    body.attachmentIds = normalizeMultipartAttachmentIds(fields.attachmentIds);
  }

  if (typeof fields.debug === 'string') {
    body.debug = parseBooleanMultipartField(fields.debug);
  }

  return body;
}

function addMultipartField(
  fields: Record<string, string | string[]>,
  name: string,
  value: string,
): void {
  const existing = fields[name];
  if (existing === undefined) {
    fields[name] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    fields[name] = [existing, value];
  }
}

function parseAgentChatMultipartRequest(req: Request): Promise<ChatMultipartParseResult> {
  return new Promise((resolve) => {
    const fields: Record<string, string | string[]> = {};
    const files: ChatMultipartFile[] = [];
    let fileCount = 0;
    let resolved = false;

    const finish = (result: ChatMultipartParseResult) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    try {
      const bb = Busboy({
        headers: req.headers,
        limits: {
          fileSize: MAX_CHAT_MULTIPART_UPLOAD_BYTES,
          files: MAX_CHAT_MULTIPART_FILES,
        },
      });

      bb.on('field', (name: string, value: string) => {
        addMultipartField(fields, name, value);
      });

      bb.on(
        'file',
        (
          fieldName: string,
          stream: Readable,
          info: { filename: string; encoding: string; mimeType: string },
        ) => {
          if (fieldName !== 'file' && fieldName !== 'files') {
            stream.resume();
            return;
          }

          fileCount += 1;
          if (fileCount > MAX_CHAT_MULTIPART_FILES) {
            stream.resume();
            finish({
              success: false,
              status: 413,
              error: {
                code: 'TOO_MANY_FILES',
                message: `At most ${MAX_CHAT_MULTIPART_FILES} files can be uploaded per chat message`,
              },
            });
            return;
          }

          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            files.push({
              buffer: Buffer.concat(chunks),
              filename: info.filename || 'upload',
              mimeType: info.mimeType || 'application/octet-stream',
            });
          });
          stream.on('limit', () => {
            finish({
              success: false,
              status: 413,
              error: {
                code: 'PAYLOAD_TOO_LARGE',
                message: `File exceeds maximum size of ${MAX_CHAT_MULTIPART_UPLOAD_BYTES} bytes`,
              },
            });
          });
          stream.on('error', (err: Error) => {
            finish({
              success: false,
              status: 400,
              error: { code: 'STREAM_ERROR', message: err.message },
            });
          });
        },
      );

      bb.on('filesLimit', () => {
        finish({
          success: false,
          status: 413,
          error: {
            code: 'TOO_MANY_FILES',
            message: `At most ${MAX_CHAT_MULTIPART_FILES} files can be uploaded per chat message`,
          },
        });
      });

      bb.on('error', (err: Error) => {
        finish({
          success: false,
          status: 400,
          error: { code: 'PARSE_ERROR', message: `Multipart parsing failed: ${err.message}` },
        });
      });

      bb.on('close', () => {
        if (resolved) {
          return;
        }
        try {
          finish({ success: true, body: buildAgentChatBodyFromMultipartFields(fields), files });
        } catch (err) {
          finish({
            success: false,
            status: 400,
            error: {
              code: 'INVALID_MULTIPART_FIELD',
              message: err instanceof Error ? err.message : 'Invalid multipart field',
            },
          });
        }
      });

      req.pipe(bb);
    } catch (err) {
      finish({
        success: false,
        status: 400,
        error: {
          code: 'PARSE_ERROR',
          message: `Multipart parsing failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        },
      });
    }
  });
}

async function uploadAgentChatMultipartFiles(params: {
  files: ChatMultipartFile[];
  existingAttachmentCount: number;
  tenantId: string;
  projectId: string;
  sessionId: string;
}): Promise<
  { success: true; attachmentIds: string[] } | { success: false; status: number; error: unknown }
> {
  const { files, existingAttachmentCount, tenantId, projectId, sessionId } = params;
  if (files.length === 0) {
    return { success: true, attachmentIds: [] };
  }

  const attachmentConfig = await resolveAttachmentConfig(tenantId, projectId);
  if (!attachmentConfig.enabled) {
    return {
      success: false,
      status: 403,
      error: {
        code: 'ATTACHMENTS_DISABLED',
        message: 'Attachments are disabled for this project',
      },
    };
  }

  const client = new MultimodalServiceClient();
  const attachmentIds: string[] = [];
  const validatedFiles: Array<ChatMultipartFile & { mimeType: string }> = [];

  if (existingAttachmentCount + files.length > attachmentConfig.maxFilesPerSession) {
    return {
      success: false,
      status: 413,
      error: {
        code: 'TOO_MANY_FILES',
        message: `At most ${attachmentConfig.maxFilesPerSession} files can be uploaded per session`,
      },
    };
  }

  for (const file of files) {
    const mimeType = normalizeUploadMimeType(file.filename, file.mimeType);
    if (file.buffer.length > attachmentConfig.maxFileSizeBytes) {
      return {
        success: false,
        status: 413,
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `File exceeds maximum size of ${attachmentConfig.maxFileSizeBytes} bytes`,
        },
      };
    }

    if (
      attachmentConfig.allowedMimeTypes.length > 0 &&
      !mimeTypeMatchesAllowed(mimeType, attachmentConfig.allowedMimeTypes)
    ) {
      return {
        success: false,
        status: 415,
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'File type is not allowed for this project',
        },
      };
    }

    validatedFiles.push({ ...file, mimeType });
  }

  for (const file of validatedFiles) {
    const uploadResult = await client.upload({
      stream: Readable.from(file.buffer),
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.buffer.length,
      maxSizeBytes: attachmentConfig.maxFileSizeBytes,
      tenantId,
      projectId,
      sessionId,
      channel: 'api',
      config: buildMultimodalUploadConfig(attachmentConfig),
    });

    if (!uploadResult.success) {
      await cleanupUploadedChatAttachments(client, attachmentIds, tenantId);
      return {
        success: false,
        status: 502,
        error: uploadResult.error,
      };
    }

    attachmentIds.push(uploadResult.attachmentId);
  }

  return { success: true, attachmentIds };
}

async function cleanupUploadedChatAttachments(
  client: MultimodalServiceClient,
  attachmentIds: string[],
  tenantId: string,
): Promise<void> {
  for (const attachmentId of attachmentIds) {
    try {
      await client.deleteAttachment(attachmentId, tenantId);
    } catch (err) {
      log.warn('Failed to clean up multipart chat attachment after upload failure', {
        attachmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const HTTP_TEST_CONTEXT_WRITE_ROLES = new Set(['OWNER', 'ADMIN', 'OPERATOR', 'EVAL-RUNNER']);

function hasHttpTestContextPermission(ctx: TenantContextData | undefined): boolean {
  const role = ctx?.role?.toUpperCase();
  if (role && HTTP_TEST_CONTEXT_WRITE_ROLES.has(role)) {
    return true;
  }

  const permissions = ctx?.permissions ?? [];
  return (
    permissions.includes('project:*') ||
    permissions.includes('simulate:execute') ||
    permissions.includes('eval:execute')
  );
}

function ensureRuntimeSessionData(session: RuntimeSession): SessionDataStore {
  const mutableSession = session as RuntimeSession & { data?: SessionDataStore };
  mutableSession.data ??= { values: {}, gatheredKeys: new Set<string>() };
  mutableSession.data.values ??= {};
  if (!(mutableSession.data.gatheredKeys instanceof Set)) {
    const gatheredKeys = mutableSession.data.gatheredKeys as unknown;
    mutableSession.data.gatheredKeys = new Set(
      Array.isArray(gatheredKeys)
        ? gatheredKeys.filter((key): key is string => typeof key === 'string')
        : [],
    );
  }
  return mutableSession.data;
}

function wrapSessionToolMocks(
  session: RuntimeSession,
  context: AgentChatTestContext,
  onTraceEvent?: (event: InlineTraceEvent) => void,
): void {
  const mocks = context.toolMocks;
  if (!mocks || mocks.length === 0 || !session.toolExecutor) {
    return;
  }

  session.toolMocks = mocks;
  if (session.toolExecutor instanceof MockToolExecutor) {
    session.toolExecutor.setMocks(mocks);
    return;
  }

  session.toolExecutor = new MockToolExecutor(session.toolExecutor, mocks, (toolName) => {
    onTraceEvent?.({
      type: 'tool_mock_hit',
      data: { toolName, source: 'http_test_context' },
    });
  });
}

function applyAgentChatTestContext(
  session: RuntimeSession,
  context: AgentChatTestContext | undefined,
  onTraceEvent?: (event: InlineTraceEvent) => void,
): void {
  if (!context) {
    return;
  }

  const data = ensureRuntimeSessionData(session);
  const injectedKeys: string[] = [];

  for (const [key, value] of Object.entries(context.gatherValues ?? {})) {
    data.values[key] = value;
    data.gatheredKeys.add(key);
    injectedKeys.push(key);
  }

  for (const [key, value] of Object.entries(context.sessionVariables ?? {})) {
    data.values[key] = value;
    injectedKeys.push(key);
  }

  if (context.callerContext?.userId) {
    session.userId = context.callerContext.userId;
  }
  for (const [key, value] of Object.entries(context.callerContext?.customAttributes ?? {})) {
    data.values[key] = value;
    injectedKeys.push(key);
  }

  wrapSessionToolMocks(session, context, onTraceEvent);

  if (context.skipOnStart) {
    session.initialized = true;
  }

  if (context.startAtStep && session.agentIR?.flow) {
    session.currentFlowStep = context.startAtStep;
    const activeThread = session.threads[session.activeThreadIndex];
    if (activeThread) {
      activeThread.currentFlowStep = context.startAtStep;
    }
  }

  if (
    injectedKeys.length > 0 ||
    !!context.skipOnStart ||
    !!context.startAtStep ||
    !!context.toolMocks?.length
  ) {
    onTraceEvent?.({
      type: 'engine_decision',
      data: {
        decision: 'context_injection',
        source: 'http_test_context',
        keys: injectedKeys,
        hasMocks: !!context.toolMocks?.length,
        skipOnStart: !!context.skipOnStart,
        startAtStep: context.startAtStep,
      },
    });
  }
}

const agentActionSchema = z
  .object({
    type: z.string(),
  })
  .catchall(z.unknown());

const responseProvenanceSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(['scripted', 'llm', 'mixed']),
  disclaimerRequired: z.boolean(),
  usedLlmInternally: z.boolean(),
});

const responseMessageMetadataSchema = z.object({
  isLlmGenerated: z.boolean(),
  responseProvenance: responseProvenanceSchema,
});

/**
 * POST /api/v1/chat/session
 * Create a pre-initialized session with optional sessionMetadata.
 * Returns the session ID without executing any message.
 */
const sessionCreateSchema = z.object({
  projectId: z.string().min(1),
  deploymentId: z.string().optional(),
  environment: z.string().optional(),
  agentId: z.string().optional(),
  sessionMetadata: sessionMetadataSchema,
});

openapi.route(
  'post',
  '/session',
  {
    summary: 'Create a chat session',
    description:
      'Create a pre-initialized session with optional session metadata. Returns the session ID without executing a message.',
    body: sessionCreateSchema,
    response: z.object({
      sessionId: z.string(),
      agentName: z.string(),
      status: z.literal('ready'),
    }),
  },
  async (req, res) => {
    const result = sessionCreateSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: 'Invalid request', details: result.error.issues });
      return;
    }

    const { projectId, deploymentId, environment, agentId, sessionMetadata } = result.data;
    const preGeneratedSessionId = crypto.randomUUID();
    const executor = getRuntimeExecutor();
    let tenantId: string | undefined;
    let sessionSlotClaimed = false;

    try {
      if (!(await requireProjectPermission(req, res, 'session:send_message', projectId))) {
        return;
      }

      if (!executor.isConfigured()) {
        res.status(503).json({
          error:
            'Runtime not configured. Ensure model resolution is set up with tenant credentials.',
        });
        return;
      }

      tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      // Quota check
      try {
        await executor.checkSessionQuota(tenantId, projectId, preGeneratedSessionId);
        sessionSlotClaimed = true;
      } catch (err) {
        if ((err as any)?.statusCode === 429) {
          res.status(429).json({ error: 'Concurrent session limit exceeded' });
          return;
        }
        // Non-fatal — allow session creation if quota check itself fails
      }

      let callerCtx = buildChatCallerContext(tenantId, req.tenantContext);
      let resolved: ResolvedAgent;
      let resolvedEnv: Environment = 'dev';
      let agentVersion = '1.0';
      let session: RuntimeSession;

      if (isResolutionDatabaseAvailable() && (deploymentId || environment)) {
        const { DeploymentResolver } = await import('../services/deployment-resolver.js');
        const resolver = new DeploymentResolver(getSessionService());
        let configVariables: Record<string, string> | undefined;
        try {
          const loaded = await loadConfigVariablesMap(projectId, tenantId);
          if (Object.keys(loaded).length > 0) {
            configVariables = loaded;
          }
        } catch (err) {
          log.warn('Failed to load config variables for deployment-resolved /chat/session', {
            projectId,
            tenantId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        resolved = await resolver.resolve({ projectId, tenantId, deploymentId, environment });
        callerCtx =
          (await ensureHttpChatContactForRequiredScope({
            tenantContext: req.tenantContext,
            tenantId,
            callerContext: callerCtx,
            sessionId: preGeneratedSessionId,
          })) ?? callerCtx;

        resolvedEnv = normalizeResolvedChatEnvironment(resolved.versionInfo.environment);

        const sessionTimeouts = await resolveSessionTimeouts(
          tenantId,
          projectId,
          getResolvedAgentLifecycle(resolved),
        );
        let requiredChatScope: ProductionExecutionScope | null;
        try {
          requiredChatScope = buildRequiredHttpChatExecutionScope({
            tenantContext: req.tenantContext,
            tenantId,
            projectId,
            sessionId: preGeneratedSessionId,
            environment: resolvedEnv,
            callerContext: callerCtx,
            contactId: callerCtx.contactId,
          });
        } catch (err) {
          if (sessionSlotClaimed) {
            await executor.releaseSessionSlot(tenantId, preGeneratedSessionId);
            sessionSlotClaimed = false;
          }
          if (err instanceof ScopeValidationError) {
            sendChatScopeValidationError(res, err);
            return;
          }
          throw err;
        }

        session = executor.createSessionFromResolved(resolved, {
          sessionId: preGeneratedSessionId,
          tenantId,
          projectId,
          userId: resolveRuntimeAuthPrincipal(req.tenantContext),
          permissions: req.tenantContext?.permissions,
          channelType: 'http',
          deploymentId,
          callerContext: callerCtx,
          metadata: sessionMetadata,
          scope: requiredChatScope ?? undefined,
          ...sessionTimeouts,
        });
        storeRuntimeSessionLocalizationCatalog(
          session,
          buildSessionLocalizationCatalog(configVariables),
        );
        agentVersion = resolvePersistedAgentVersion(resolved.versionInfo, resolved.entryAgent);
      } else if (isResolutionDatabaseAvailable()) {
        const project = await findProjectWithAgents(projectId, tenantId);
        if (!project || project.agents.length === 0) {
          if (sessionSlotClaimed) {
            await executor.releaseSessionSlot(tenantId, preGeneratedSessionId);
            sessionSlotClaimed = false;
          }
          res.status(404).json({ error: 'Project not found or has no agents' });
          return;
        }

        const readiness = await evaluateProjectExecutionReadiness({
          agents: project.agents,
          tenantId,
          projectId,
          runtimeConfig: await findProjectRuntimeConfig(projectId, tenantId),
          lazyBackfill: true,
        });
        if (readiness.hasBlockingErrors) {
          if (sessionSlotClaimed) {
            await executor.releaseSessionSlot(tenantId, preGeneratedSessionId);
            sessionSlotClaimed = false;
          }
          log.warn('Refusing HTTP working-copy chat for project with readiness errors', {
            tenantId,
            projectId,
            issueKinds: readiness.issues.map((issue) => issue.kind),
            blockedAgents: readiness.blockedAgents,
          });
          res.status(422).json({
            error: buildProjectDslReadinessError(),
            issues: readiness.issues,
          });
          return;
        }

        const workingCopyAgents = buildProjectWorkingCopyAgentSources(
          (readiness.executableAgents ?? []) as Array<{
            name?: unknown;
            dslContent?: unknown;
            systemPromptLibraryRef?: unknown;
          }>,
        );
        if (workingCopyAgents.length === 0) {
          if (sessionSlotClaimed) {
            await executor.releaseSessionSlot(tenantId, preGeneratedSessionId);
            sessionSlotClaimed = false;
          }
          res.status(400).json({ error: 'No agent DSL content found' });
          return;
        }

        const entryAgent = resolveProjectEntryAgentName(project, agentId);
        const compileResult = await compileProjectWorkingCopy({
          tenantId,
          projectId,
          entryAgentName: entryAgent,
          agents: workingCopyAgents,
        });
        const configVariables =
          Object.keys(compileResult.configVariables).length > 0
            ? compileResult.configVariables
            : undefined;
        callerCtx =
          (await ensureHttpChatContactForRequiredScope({
            tenantContext: req.tenantContext,
            tenantId,
            callerContext: callerCtx,
            sessionId: preGeneratedSessionId,
          })) ?? callerCtx;
        resolved = compileResult.resolved;
        const sessionTimeouts = await resolveSessionTimeouts(
          tenantId,
          projectId,
          getResolvedAgentLifecycle(resolved),
        );
        let requiredChatScope: ProductionExecutionScope | null;
        try {
          requiredChatScope = buildRequiredHttpChatExecutionScope({
            tenantContext: req.tenantContext,
            tenantId,
            projectId,
            sessionId: preGeneratedSessionId,
            environment: resolvedEnv,
            callerContext: callerCtx,
            contactId: callerCtx.contactId,
          });
        } catch (err) {
          if (sessionSlotClaimed) {
            await executor.releaseSessionSlot(tenantId, preGeneratedSessionId);
            sessionSlotClaimed = false;
          }
          if (err instanceof ScopeValidationError) {
            sendChatScopeValidationError(res, err);
            return;
          }
          throw err;
        }

        session = executor.createSessionFromResolved(resolved, {
          sessionId: preGeneratedSessionId,
          tenantId,
          projectId,
          userId: resolveRuntimeAuthPrincipal(req.tenantContext),
          permissions: req.tenantContext?.permissions,
          channelType: 'api',
          deploymentId,
          callerContext: callerCtx,
          metadata: sessionMetadata,
          scope: requiredChatScope ?? undefined,
          ...sessionTimeouts,
        });
        storeRuntimeSessionLocalizationCatalog(
          session,
          buildSessionLocalizationCatalog(configVariables),
        );
      } else {
        if (sessionSlotClaimed) {
          await executor.releaseSessionSlot(tenantId, preGeneratedSessionId);
          sessionSlotClaimed = false;
        }
        res.status(503).json({ error: 'Database not available for project lookup' });
        return;
      }

      sessionSlotClaimed = false; // slot is now owned by the live session

      // Persist to conversation store
      try {
        const convStore = getStores().conversation;
        const dbSession = await convStore.createSession({
          id: session.id,
          channel: 'api',
          agentName: resolved.entryAgent,
          agentVersion,
          environment: resolvedEnv,
          projectId,
          tenantId,
          customerId: callerCtx.customerId,
          anonymousId: callerCtx.anonymousId,
          contactId: callerCtx.contactId,
          initiatedById: req.tenantContext?.userId,
          entryAgentName: resolved.entryAgent,
          deploymentId,
          channelArtifact: callerCtx.channelArtifact,
          channelArtifactType: callerCtx.channelArtifactType,
          identityTier: callerCtx.identityTier,
          verificationMethod: callerCtx.verificationMethod,
          channelId: callerCtx.channelId,
        });
        markPersistedChatSession(session.id, dbSession.id);
      } catch (err) {
        log.warn('Failed to create DB session for /chat/session', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await registerChatResolutionKey(tenantId, callerCtx, session.id);

      res.status(201).json({
        sessionId: session.id,
        agentName: resolved.entryAgent,
        status: 'ready' as const,
      });
    } catch (err) {
      const statusCode = (err as any)?.statusCode;
      if (sessionSlotClaimed && tenantId) {
        try {
          await executor.releaseSessionSlot(tenantId, preGeneratedSessionId);
        } catch {
          // releaseSessionSlot already logs failures; suppress to preserve original error
        }
      }
      if (statusCode === 410) {
        res.status(410).json({ error: 'Deployment is retired' });
        return;
      }
      log.error('Failed to create chat session', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to create session' });
    }
  },
);

/**
 * POST /api/v1/chat/agent
 * Agent-backed chat endpoint — executes a message through the ABL runtime.
 * Creates a session on first call; reuses existing session via sessionId.
 */
openapi.route(
  'post',
  '/agent',
  {
    summary: 'Agent-backed chat',
    description:
      'Execute a message through the ABL runtime with agent-backed chat. Creates a session on first call; reuses existing session via sessionId.',
    body: agentChatSchema,
    response: z.object({
      sessionId: z.string(),
      response: z.string(),
      action: agentActionSchema.optional(),
      state: z.record(z.unknown()).optional(),
      traceEvents: z
        .array(
          z.object({
            type: z.string(),
            data: z.record(z.unknown()),
          }),
        )
        .optional(),
      traceContext: z
        .object({
          sessionId: z.string(),
          delivery: z.enum(['inline', 'correlation_only']),
        })
        .optional(),
      responseMetadata: responseMessageMetadataSchema.optional(),
      voiceConfig: z.unknown().optional(),
      richContent: z.unknown().optional(),
      actions: z.unknown().optional(),
      localization: z.record(z.unknown()).optional(),
      outcome: z.record(z.unknown()).optional(),
    }),
  },
  async (req, res) => {
    const contentType = req.headers['content-type'] || '';
    const multipartRequest = contentType.includes('multipart/form-data')
      ? await parseAgentChatMultipartRequest(req)
      : null;
    if (multipartRequest && !multipartRequest.success) {
      res.status(multipartRequest.status).json({
        error: multipartRequest.error.message,
        details: [multipartRequest.error],
      });
      return;
    }

    const result = agentChatSchema.safeParse(multipartRequest?.body ?? req.body);
    if (!result.success) {
      res.status(400).json({ error: 'Invalid request', details: result.error.issues });
      return;
    }

    const {
      projectId,
      sessionId: existingSessionId,
      message,
      attachmentIds,
      metadata,
      interactionContext,
      sessionMetadata,
      deploymentId,
      environment,
      agentId,
      testContext,
      knownSource: rawKnownSource,
      debug,
    } = result.data;
    let effectiveAttachmentIds = attachmentIds ? [...attachmentIds] : [];
    let uploadedMultipartAttachmentIds: string[] = [];
    let uploadedMultipartTenantId: string | undefined;
    const includeDebug =
      debug === true || isTruthyQueryFlag(req.query.debug) || isTruthyQueryFlag(req.query.verbose);
    const metadataResult = normalizeSdkMessageMetadata(metadata);
    if (!metadataResult.success) {
      res.status(400).json({
        error: 'Invalid message metadata',
        details: metadataResult.error.issues,
      });
      return;
    }
    const messageMetadata = metadataResult.data;
    const interactionContextResult = normalizeInteractionContextInput(interactionContext, 'strict');
    if (!interactionContextResult.success) {
      res.status(400).json({
        error: interactionContextResult.error.message,
        details: interactionContextResult.error.issues,
      });
      return;
    }
    const legacyClientInfoResult = extractLegacyClientInfoInteractionContext(sessionMetadata);
    const requestInteractionContext = mergeInteractionContextInputs(
      legacyClientInfoResult.success ? legacyClientInfoResult.data : undefined,
      interactionContextResult.data,
    );

    let sessionSlotClaimed = false;
    const quotaTenantId = req.tenantContext?.tenantId;
    let sessionId = existingSessionId;
    let claimedSessionId: string | undefined;
    const traceEvents: InlineTraceEvent[] = [];

    try {
      if (!(await requireProjectPermission(req, res, 'session:send_message', projectId))) {
        return;
      }
      if (testContext && !hasHttpTestContextPermission(req.tenantContext)) {
        res.status(403).json({ error: 'Insufficient permissions for test context injection' });
        return;
      }

      // Non-production knownSource requires same permission gate as testContext
      // to prevent unprivileged callers from billing-excluding their sessions
      const knownSource =
        rawKnownSource && rawKnownSource !== 'production'
          ? hasHttpTestContextPermission(req.tenantContext)
            ? rawKnownSource
            : undefined // silently drop unprivileged non-production tags
          : rawKnownSource;

      const executor = getRuntimeExecutor();

      if (!executor.isConfigured()) {
        res.status(503).json({
          error:
            'Runtime not configured. Ensure model resolution is set up with tenant credentials.',
        });
        return;
      }

      let dbSessionId: string | undefined;
      let resolvedTenantId: string | undefined;
      let chatContactId: string | undefined;
      let chatEnvironment: string | undefined;
      let requiredChatScope: ProductionExecutionScope | null = null;
      let requestCallerContext = req.tenantContext
        ? buildChatCallerContext(req.tenantContext.tenantId, req.tenantContext)
        : undefined;

      if (requestCallerContext && !sessionId) {
        const sessionService = getSessionService();
        if (
          sessionService.isDistributed() &&
          hasVerifiedSdkContinuityArtifact(requestCallerContext)
        ) {
          const resolution = await resolveSession(sessionService.store, {
            tenantId: req.tenantContext!.tenantId,
            channelId: requestCallerContext.channelId,
            callerContext: requestCallerContext,
          });
          if (resolution.outcome === 'existing' && resolution.sessionId) {
            sessionId = resolution.sessionId;
          }
        } else if (hasVerifiedSdkContinuityArtifact(requestCallerContext)) {
          log.debug('Skipping SDK HTTP continuity resolution on non-distributed session store', {
            tenantId: req.tenantContext!.tenantId,
            channelId: requestCallerContext.channelId,
          });
        }
      }

      // ─── Session resume access guard ───────────────────────────────────
      // Resuming a session must preserve all isolation boundaries:
      // tenant, project, SDK end-user ownership, and non-admin platform user
      // ownership. Return 404 (not 403) to avoid leaking existence.
      if (sessionId) {
        const tenantContext = req.tenantContext;
        const inMemorySession = executor.getSession(sessionId);
        if (inMemorySession) {
          if (
            !tenantContext ||
            !ensureSessionResumeAccess(tenantContext, projectId, inMemorySession)
          ) {
            res.status(404).json({ error: 'Session not found' });
            return;
          }

          resolvedTenantId = inMemorySession.tenantId ?? tenantContext?.tenantId;
          chatContactId = chatContactId ?? inMemorySession.callerContext?.contactId;
          dbSessionId = getPersistedChatSessionId(sessionId);

          // Keep the hot-path optimization for sessions we positively know have a
          // backing Mongo row. Otherwise, fall back to a lightweight existence check
          // so best-effort DB-session creation failures do not cause repeated async
          // message-persistence errors on later turns.
          if (!dbSessionId && isResolutionDatabaseAvailable()) {
            const dbSession = await findSessionById(sessionId, tenantContext.tenantId);
            if (dbSession) {
              dbSessionId = dbSession.id;
              resolvedTenantId = dbSession.tenantId ?? tenantContext.tenantId;
              chatContactId = dbSession.contactId ?? undefined;
              chatEnvironment =
                typeof dbSession.environment === 'string' ? dbSession.environment : undefined;
              markPersistedChatSession(sessionId, dbSession.id);
            }
          }

          resolvedTenantId =
            resolvedTenantId ?? inMemorySession.tenantId ?? tenantContext?.tenantId;
          chatContactId = chatContactId ?? inMemorySession.callerContext?.contactId;
          chatEnvironment = chatEnvironment ?? inMemorySession.versionInfo?.environment;
        } else {
          // Session not in memory — verify via DB
          const callerTenantId = tenantContext?.tenantId;
          if (!callerTenantId) {
            res.status(401).json({ error: 'Tenant context required for session resume' });
            return;
          }
          if (isResolutionDatabaseAvailable()) {
            const dbSession = await findSessionById(sessionId, callerTenantId);
            if (
              !dbSession ||
              !tenantContext ||
              !ensureSessionResumeAccess(tenantContext, projectId, {
                tenantId: dbSession.tenantId,
                projectId: dbSession.projectId,
                initiatedById: dbSession.initiatedById,
                callerContext: buildStoredSessionCallerContext(dbSession),
              })
            ) {
              res.status(404).json({ error: 'Session not found' });
              return;
            }

            dbSessionId = dbSession.id;
            resolvedTenantId = dbSession.tenantId ?? callerTenantId;
            chatContactId = dbSession.contactId ?? undefined;
            chatEnvironment =
              typeof dbSession.environment === 'string' ? dbSession.environment : undefined;
            markPersistedChatSession(sessionId, dbSession.id);
          } else {
            // DB unavailable and session not in memory — cannot verify ownership
            res.status(404).json({ error: 'Session not found' });
            return;
          }
        }
      }

      // Create new session if needed
      if (!sessionId) {
        // Pre-generate a session ID so the quota SET key and the actual session share the same ID
        const preGeneratedSessionId = crypto.randomUUID();
        claimedSessionId = preGeneratedSessionId;

        // Pre-flight quota check: verify tenant has session capacity before creating
        if (quotaTenantId) {
          try {
            await executor.checkSessionQuota(quotaTenantId, projectId, preGeneratedSessionId);
            sessionSlotClaimed = true;
          } catch (err) {
            if ((err as any)?.statusCode === 429) {
              res.status(429).json({ error: 'Concurrent session limit exceeded' });
              return;
            }
            // Non-fatal — allow session creation if quota check itself fails
          }
        }

        if (isResolutionDatabaseAvailable()) {
          if (deploymentId || environment) {
            resolvedTenantId = req.tenantContext?.tenantId;
            if (!resolvedTenantId) {
              res.status(401).json({ error: 'Tenant context required for deployment resolution' });
              return;
            }
            const tenantId = resolvedTenantId;

            try {
              const { DeploymentResolver } = await import('../services/deployment-resolver.js');
              const { getSessionService } = await import('../services/session/session-service.js');

              const resolver = new DeploymentResolver(getSessionService());
              let configVariables: Record<string, string> | undefined;
              try {
                const loaded = await loadConfigVariablesMap(projectId, tenantId);
                if (Object.keys(loaded).length > 0) {
                  configVariables = loaded;
                }
              } catch (err) {
                log.warn('Failed to load config variables for deployment-resolved chat session', {
                  projectId,
                  tenantId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
              const resolved = await resolver.resolve({
                projectId,
                tenantId,
                deploymentId,
                environment,
              });

              const baseCallerCtx =
                requestCallerContext ?? buildChatCallerContext(tenantId, req.tenantContext);
              const callerCtx =
                (await ensureHttpChatContactForRequiredScope({
                  tenantContext: req.tenantContext,
                  tenantId,
                  callerContext: baseCallerCtx,
                  sessionId: preGeneratedSessionId,
                })) ?? baseCallerCtx;
              chatContactId = callerCtx.contactId;
              const resolvedEnv = normalizeResolvedChatEnvironment(
                resolved.versionInfo.environment,
              );
              chatEnvironment = resolvedEnv;

              const sessionTimeouts1 = await resolveSessionTimeouts(
                tenantId,
                projectId,
                getResolvedAgentLifecycle(resolved),
              );
              try {
                requiredChatScope = buildRequiredHttpChatExecutionScope({
                  tenantContext: req.tenantContext,
                  tenantId,
                  projectId,
                  sessionId: preGeneratedSessionId,
                  environment: resolvedEnv,
                  callerContext: callerCtx,
                  contactId: chatContactId,
                });
              } catch (err) {
                if (sessionSlotClaimed && quotaTenantId) {
                  await executor.releaseSessionSlot(quotaTenantId, preGeneratedSessionId);
                  sessionSlotClaimed = false;
                }
                if (err instanceof ScopeValidationError) {
                  sendChatScopeValidationError(res, err);
                  return;
                }
                throw err;
              }
              const session = executor.createSessionFromResolved(resolved, {
                sessionId: preGeneratedSessionId,
                tenantId,
                projectId,
                userId: resolveRuntimeAuthPrincipal(req.tenantContext),
                permissions: req.tenantContext?.permissions,
                channelType: 'http',
                deploymentId,
                callerContext: callerCtx,
                interactionContext: requestInteractionContext,
                metadata: sessionMetadata,
                scope: requiredChatScope ?? undefined,
                ...sessionTimeouts1,
                ...(knownSource ? { knownSource } : {}),
              });
              storeRuntimeSessionLocalizationCatalog(
                session,
                buildSessionLocalizationCatalog(configVariables),
              );
              applyAgentChatTestContext(session, testContext, (event) =>
                recordSyntheticTraceEvent({
                  traceEvents,
                  sessionId: session.id,
                  session,
                  event,
                }),
              );
              sessionId = session.id;
              sessionSlotClaimed = false; // slot now owned by the session
              await registerChatResolutionKey(tenantId, callerCtx, session.id);

              try {
                const convStore = getStores().conversation;
                const dbSession = await convStore.createSession({
                  id: session.id, // use canonical session UUID as DB _id
                  channel: 'api',
                  agentName: resolved.entryAgent,
                  agentVersion: resolvePersistedAgentVersion(
                    resolved.versionInfo,
                    resolved.entryAgent,
                  ),
                  environment: resolvedEnv,
                  projectId,
                  tenantId,
                  customerId: callerCtx.customerId,
                  anonymousId: callerCtx.anonymousId,
                  sessionPrincipalId: callerCtx.sessionPrincipalId ?? callerCtx.anonymousId,
                  contactId: callerCtx.contactId,
                  initiatedById: req.tenantContext?.userId,
                  entryAgentName: resolved.entryAgent,
                  deploymentId,
                  channelArtifact: callerCtx.channelArtifact,
                  channelArtifactType: callerCtx.channelArtifactType,
                  identityTier: callerCtx.identityTier,
                  verificationMethod: callerCtx.verificationMethod,
                  channelId: callerCtx.channelId,
                  ...(knownSource ? { knownSource } : {}),
                });
                dbSessionId = dbSession.id;
                markPersistedChatSession(session.id, dbSession.id);
              } catch (err) {
                log.warn('Failed to create DB session for chat', {
                  sessionId: session.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            } catch (err) {
              const statusCode = (err as any).statusCode;
              if (statusCode === 410) {
                if (sessionSlotClaimed && quotaTenantId) {
                  await executor.releaseSessionSlot(quotaTenantId, preGeneratedSessionId);
                  sessionSlotClaimed = false;
                }
                res.status(410).json({ error: 'Deployment is retired' });
                return;
              }
              throw err;
            }
          } else {
            if (!req.tenantContext) {
              res.status(401).json({ error: 'Tenant context required' });
              return;
            }

            const tenantId = req.tenantContext.tenantId;
            resolvedTenantId = tenantId;
            const project = await findProjectWithAgents(projectId, tenantId);

            if (!project || project.agents.length === 0) {
              if (sessionSlotClaimed && quotaTenantId) {
                await executor.releaseSessionSlot(quotaTenantId, preGeneratedSessionId);
              }
              res.status(404).json({ error: 'Project not found or has no agents' });
              return;
            }

            const readiness = await evaluateProjectExecutionReadiness({
              agents: project.agents,
              tenantId,
              projectId,
              runtimeConfig: await findProjectRuntimeConfig(projectId, tenantId),
              lazyBackfill: true,
            });
            if (readiness.hasBlockingErrors) {
              if (sessionSlotClaimed && quotaTenantId) {
                await executor.releaseSessionSlot(quotaTenantId, preGeneratedSessionId);
                sessionSlotClaimed = false;
              }
              log.warn('Refusing HTTP working-copy chat for project with readiness errors', {
                tenantId,
                projectId,
                issueKinds: readiness.issues.map((issue) => issue.kind),
                blockedAgents: readiness.blockedAgents,
              });
              res.status(422).json({
                error: buildProjectDslReadinessError(),
                issues: readiness.issues,
              });
              return;
            }

            const workingCopyAgents = buildProjectWorkingCopyAgentSources(
              (readiness.executableAgents ?? []) as Array<{
                name?: unknown;
                dslContent?: unknown;
                systemPromptLibraryRef?: unknown;
              }>,
            );

            if (workingCopyAgents.length === 0) {
              if (sessionSlotClaimed && quotaTenantId) {
                await executor.releaseSessionSlot(quotaTenantId, preGeneratedSessionId);
              }
              res.status(400).json({ error: 'No agent DSL content found' });
              return;
            }

            const entryAgent = resolveProjectEntryAgentName(project, agentId);
            const compileResult = await compileProjectWorkingCopy({
              tenantId,
              projectId,
              entryAgentName: entryAgent,
              agents: workingCopyAgents,
            });
            const configVariables =
              Object.keys(compileResult.configVariables).length > 0
                ? compileResult.configVariables
                : undefined;

            const baseLegacyCallerCtx =
              requestCallerContext ?? buildChatCallerContext(tenantId, req.tenantContext);
            const legacyCallerCtx =
              (await ensureHttpChatContactForRequiredScope({
                tenantContext: req.tenantContext,
                tenantId,
                callerContext: baseLegacyCallerCtx,
                sessionId: preGeneratedSessionId,
              })) ?? baseLegacyCallerCtx;
            chatContactId = legacyCallerCtx?.contactId ?? undefined;
            chatEnvironment = 'dev';
            const resolved = compileResult.resolved;
            const sessionTimeouts2 = await resolveSessionTimeouts(
              tenantId,
              projectId,
              getResolvedAgentLifecycle(resolved),
            );
            try {
              requiredChatScope = buildRequiredHttpChatExecutionScope({
                tenantContext: req.tenantContext,
                tenantId,
                projectId,
                sessionId: preGeneratedSessionId,
                environment: chatEnvironment,
                callerContext: legacyCallerCtx,
                contactId: chatContactId,
              });
            } catch (err) {
              if (sessionSlotClaimed && quotaTenantId) {
                await executor.releaseSessionSlot(quotaTenantId, preGeneratedSessionId);
                sessionSlotClaimed = false;
              }
              if (err instanceof ScopeValidationError) {
                sendChatScopeValidationError(res, err);
                return;
              }
              throw err;
            }
            const session = executor.createSessionFromResolved(resolved, {
              sessionId: preGeneratedSessionId,
              channelType: 'api',
              projectId,
              userId: resolveRuntimeAuthPrincipal(req.tenantContext),
              permissions: req.tenantContext?.permissions,
              tenantId: req.tenantContext?.tenantId,
              callerContext: legacyCallerCtx,
              interactionContext: requestInteractionContext,
              metadata: sessionMetadata,
              scope: requiredChatScope ?? undefined,
              ...sessionTimeouts2,
              ...(knownSource ? { knownSource } : {}),
            });
            storeRuntimeSessionLocalizationCatalog(
              session,
              buildSessionLocalizationCatalog(configVariables),
            );
            applyAgentChatTestContext(session, testContext, (event) =>
              recordSyntheticTraceEvent({
                traceEvents,
                sessionId: session.id,
                session,
                event,
              }),
            );
            sessionId = session.id;
            sessionSlotClaimed = false; // slot now owned by the session
            await registerChatResolutionKey(tenantId, legacyCallerCtx, session.id);

            try {
              const convStore = getStores().conversation;
              const dbSession = await convStore.createSession({
                id: session.id, // use canonical session UUID as DB _id
                channel: 'api',
                agentName: entryAgent,
                agentVersion: '1.0',
                environment: 'dev',
                projectId,
                tenantId,
                customerId: legacyCallerCtx.customerId,
                anonymousId: legacyCallerCtx.anonymousId,
                sessionPrincipalId:
                  legacyCallerCtx.sessionPrincipalId ?? legacyCallerCtx.anonymousId,
                contactId: legacyCallerCtx.contactId,
                initiatedById: req.tenantContext?.userId,
                entryAgentName: entryAgent,
                channelArtifact: legacyCallerCtx.channelArtifact,
                channelArtifactType: legacyCallerCtx.channelArtifactType,
                identityTier: legacyCallerCtx.identityTier,
                verificationMethod: legacyCallerCtx.verificationMethod,
                channelId: legacyCallerCtx.channelId,
                ...(knownSource ? { knownSource } : {}),
              });
              dbSessionId = dbSession.id;
              markPersistedChatSession(session.id, dbSession.id);
            } catch (err) {
              log.warn('Failed to create DB session for chat', {
                sessionId: session.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } else {
          if (sessionSlotClaimed && quotaTenantId) {
            await executor.releaseSessionSlot(quotaTenantId, preGeneratedSessionId);
          }
          res.status(503).json({ error: 'Database not available for project lookup' });
          return;
        }
      }

      let session = sessionId ? executor.getSession(sessionId) : undefined;
      if (!session && sessionId) {
        const sessionLocator = buildProductionSessionLocator({
          tenantId: resolvedTenantId ?? req.tenantContext?.tenantId,
          projectId,
          sessionId,
        });
        session =
          (await executor.rehydrateSession(
            sessionId,
            sessionLocator ? { locator: sessionLocator } : undefined,
          )) ?? undefined;
      }

      const previousChatContactId =
        chatContactId ?? requestCallerContext?.contactId ?? session?.callerContext?.contactId;
      const scopedRequestCallerContext = await ensureHttpChatContactForRequiredScope({
        tenantContext: req.tenantContext,
        tenantId: resolvedTenantId ?? req.tenantContext?.tenantId ?? session?.tenantId,
        callerContext: requestCallerContext ?? session?.callerContext,
        sessionId,
      });
      if (scopedRequestCallerContext) {
        if (requestCallerContext) {
          requestCallerContext = scopedRequestCallerContext;
        }
        if (session) {
          applyCallerContextToRuntimeSession(session, scopedRequestCallerContext);
        }
      }
      chatContactId =
        chatContactId ??
        scopedRequestCallerContext?.contactId ??
        requestCallerContext?.contactId ??
        session?.callerContext?.contactId;
      if (
        scopedRequestCallerContext?.contactId &&
        scopedRequestCallerContext.contactId !== previousChatContactId
      ) {
        await syncPersistedChatSessionContact(dbSessionId, scopedRequestCallerContext.contactId);
      }

      try {
        requiredChatScope =
          requiredChatScope ??
          buildRequiredHttpChatExecutionScope({
            tenantContext: req.tenantContext,
            tenantId: resolvedTenantId ?? req.tenantContext?.tenantId ?? session?.tenantId,
            projectId,
            sessionId,
            environment:
              chatEnvironment ?? session?.versionInfo?.environment ?? environment ?? 'dev',
            callerContext: requestCallerContext ?? session?.callerContext,
            contactId: chatContactId,
          });
      } catch (err) {
        if (err instanceof ScopeValidationError) {
          sendChatScopeValidationError(res, err);
          return;
        }
        throw err;
      }

      // Merge sessionMetadata into existing session's _metadata (follow-up messages)
      if (session && sessionMetadata && Object.keys(sessionMetadata).length > 0) {
        updateSessionMetadata(session.data, sessionMetadata);
      }

      if (session?.compilationOutput) {
        try {
          const preflightStatus = await evaluateAuthPreflightFromIR(
            session.compilationOutput,
            {
              userId: resolveRuntimeAuthPrincipal(req.tenantContext),
              tenantId: resolvedTenantId || req.tenantContext?.tenantId,
              projectId,
              environment,
            },
            createTokenLookups(
              resolvedTenantId || req.tenantContext?.tenantId,
              projectId,
              environment,
            ),
            session.agentName ? { agentNames: [session.agentName] } : undefined,
          );

          if (preflightStatus) {
            const authOutcome = buildAuthRequiredOutcome({
              channelType: 'api',
              pending: preflightStatus.pending,
              satisfied: preflightStatus.satisfied,
              session,
            });
            recordSyntheticTraceEvent({
              traceEvents,
              sessionId,
              session,
              event: buildOutcomeTraceEvent(authOutcome),
            });
            res.json({
              sessionId,
              response: authOutcome.responseText,
              action: {
                type: 'auth_required',
                pending: preflightStatus.pending,
                satisfied: preflightStatus.satisfied,
              },
              outcome: toPublicChannelOutcome(authOutcome),
              ...(await buildInlineDebugPayload({
                includeDebug,
                sessionId,
                state: session.state,
                traceEvents,
                runtimeSession: session,
              })),
            });
            return;
          }
        } catch (err) {
          log.warn('HTTP auth preflight check failed; blocking request', {
            sessionId,
            projectId,
            error: err instanceof Error ? err.message : String(err),
          });
          res
            .status(503)
            .json({ error: 'Authentication preflight is temporarily unavailable. Please retry.' });
          return;
        }
      }

      // Per-session message rate limiting
      if (sessionId) {
        const msgRate = await checkSessionMessageRate(sessionId);
        if (!msgRate.allowed) {
          res.status(429).json({
            error: 'Session message rate limit exceeded',
            retryAfterMs: msgRate.retryAfterMs,
          });
          return;
        }
      }

      if (multipartRequest?.files.length) {
        const uploadTenantId = resolvedTenantId ?? req.tenantContext?.tenantId ?? session?.tenantId;
        if (!uploadTenantId) {
          res.status(401).json({ error: 'Tenant context required for attachment upload' });
          return;
        }

        const uploadResult = await uploadAgentChatMultipartFiles({
          files: multipartRequest.files,
          existingAttachmentCount: effectiveAttachmentIds.length,
          tenantId: uploadTenantId,
          projectId,
          sessionId,
        });
        if (!uploadResult.success) {
          res.status(uploadResult.status).json({
            error:
              typeof uploadResult.error === 'object' &&
              uploadResult.error &&
              'message' in uploadResult.error
                ? String(uploadResult.error.message)
                : 'Failed to upload attachment',
            details: uploadResult.error,
          });
          return;
        }

        uploadedMultipartAttachmentIds = uploadResult.attachmentIds;
        uploadedMultipartTenantId = uploadTenantId;
        effectiveAttachmentIds = [...effectiveAttachmentIds, ...uploadResult.attachmentIds];
      }

      const cleanupUploadedMultipartOnFailure = async () => {
        if (!uploadedMultipartTenantId || uploadedMultipartAttachmentIds.length === 0) {
          return;
        }
        await cleanupUploadedChatAttachments(
          new MultimodalServiceClient(),
          uploadedMultipartAttachmentIds,
          uploadedMultipartTenantId,
        );
        uploadedMultipartAttachmentIds = [];
      };

      // Execute message with counter accumulation
      const chunks: string[] = [];
      let turnTokensIn = 0;
      let turnTokensOut = 0;
      let turnCost = 0;
      let turnTraceCount = 0;
      let turnErrorCount = 0;
      let turnHandoffCount = 0;
      let turnToolCallCount = 0;
      let lastModelId = '';
      let lastProvider = '';
      const startTime = Date.now();
      const responseProvenance = createResponseProvenanceAccumulator();

      const onChunk = (chunk: string) => {
        chunks.push(chunk);
      };
      const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
        traceEvents.push(event);
        if (event.type === 'llm_call' && event.data) {
          const usage = extractLlmTraceMetrics(event.data);
          turnTokensIn += usage.tokensIn;
          turnTokensOut += usage.tokensOut;
          // Gap 3: filter 'unknown' from lastModelId
          if (usage.model && usage.model !== 'unknown') lastModelId = usage.model;
          if (usage.provider) lastProvider = usage.provider;
          accumulateResponseProvenance(responseProvenance, event);

          // Write one row per LLM call — accurate per-call latency and counts
          if (usage.tokensIn > 0 || usage.tokensOut > 0) {
            const callModelId = usage.model && usage.model !== 'unknown' ? usage.model : '';
            const callDurationMs =
              typeof event.data.durationMs === 'number' ? event.data.durationMs : 0;
            const callToolCount =
              typeof event.data.toolCallCount === 'number' ? event.data.toolCallCount : 0;
            let callCost: number | null = usage.cost || null;
            if (!callCost && callModelId && hasKnownPricing(callModelId)) {
              try {
                const caps = getModelCapabilities(callModelId);
                callCost = calculateCost(
                  caps.inputCostPer1k,
                  caps.outputCostPer1k,
                  usage.tokensIn,
                  usage.tokensOut,
                );
              } catch {
                // non-fatal
              }
            }
            // Gap 2: accumulate resolved callCost (incl. fallback) for turn aggregate
            turnCost += callCost || 0;
            getMetricsStoreAsync()
              .then(async (store) => {
                await store.record({
                  tenantId: resolvedTenantId,
                  sessionId: sessionId || 'adhoc',
                  projectId,
                  userId: resolveRuntimeAuthPrincipal(req.tenantContext),
                  modelId: callModelId,
                  provider: usage.provider || '',
                  inputTokens: usage.tokensIn,
                  outputTokens: usage.tokensOut,
                  totalTokens: usage.tokensIn + usage.tokensOut,
                  estimatedCost: callCost,
                  latencyMs: callDurationMs,
                  streamingUsed: event.data.streaming === true,
                  toolCallCount: callToolCount,
                  // Gap 1: field_validation uses 'purpose', not 'operationType'
                  operationType: String(
                    event.data.operationType || event.data.purpose || 'response_gen',
                  ),
                  agentName: String(event.data.agent || ''),
                  knownSource: knownSource ?? 'production',
                });
              })
              .catch((err: unknown) =>
                log.warn('Chat agent llm call metrics store record failed', { err }),
              );
          }
        }
        if (event.type === 'tool_call') turnToolCallCount++;
        turnTraceCount++;
        if (event.type === 'error') turnErrorCount++;
        if (event.type === 'handoff') turnHandoffCount++;
      };

      // Route through ExecutionCoordinator when available (handles dedup, concurrency, queueing).
      // Falls back to direct executor path when coordinator is not initialized.
      const executionSessionId = sessionId;
      if (!executionSessionId) {
        throw new Error('Runtime session unavailable');
      }

      let execResult: ExecutionResult;
      try {
        const executionLocator = buildProductionSessionLocator({
          tenantId: resolvedTenantId ?? req.tenantContext?.tenantId ?? session?.tenantId,
          projectId,
          sessionId: executionSessionId,
        });
        execResult = await runWithExecutionTimeout(async (signal) => {
          if (isCoordinatorAvailable()) {
            const coordinator = getExecutionCoordinator();
            const execution = await coordinator.submit(executionSessionId, message, {
              tenantId: resolvedTenantId || req.tenantContext?.tenantId || 'default',
              attachmentIds: effectiveAttachmentIds.length > 0 ? effectiveAttachmentIds : undefined,
              messageMetadata,
              interactionContext: requestInteractionContext,
              sessionLocator: executionLocator ?? undefined,
              onChunk,
              onTraceEvent,
              signal,
              channelMetadata: {
                channel: 'api',
                contentLength: message.length,
                hasAttachments: effectiveAttachmentIds.length > 0,
                attachmentCount: effectiveAttachmentIds.length,
              },
            });

            // Handle failed executions — the coordinator resolves (not rejects) on failure,
            // so we must check execution.status to surface errors to the client.
            if (execution.status === 'failed' && execution.error) {
              const executionError = new Error(
                execution.error.message || 'Execution failed',
              ) as Error & {
                code?: string;
                statusCode?: number;
              };
              executionError.code = execution.error.code;
              executionError.statusCode = execution.error.code === 'QUEUE_FULL' ? 429 : 500;
              throw executionError;
            }

            // The coordinator stashes the full ExecutionResult on execution.resultData.
            const resultData = execution.resultData as typeof execResult | undefined;
            return (
              resultData ?? {
                response: execution.response || '',
                action: { type: 'continue' as const },
                stateUpdates: undefined,
                voiceConfig: undefined,
                richContent: undefined,
                actions: undefined,
              }
            );
          }

          return executor.executeMessage(executionSessionId, message, onChunk, onTraceEvent, {
            attachmentIds: effectiveAttachmentIds.length > 0 ? effectiveAttachmentIds : undefined,
            messageMetadata,
            interactionContext: requestInteractionContext,
            sessionLocator: executionLocator ?? undefined,
            signal,
            channelMetadata: {
              channel: 'api',
              contentLength: message.length,
              hasAttachments: effectiveAttachmentIds.length > 0,
              attachmentCount: effectiveAttachmentIds.length,
            },
          });
        }, WS_MESSAGE_TIMEOUT_MS);
      } catch (error) {
        const queueFullError = error as Error & { code?: string; statusCode?: number };
        if (queueFullError.code === 'QUEUE_FULL') {
          await cleanupUploadedMultipartOnFailure();
          recordSyntheticTraceEvent({
            traceEvents,
            sessionId,
            session: executor.getSession(executionSessionId) ?? session ?? undefined,
            event: buildChannelTraceEvent({
              severity: 'error',
              code: 'QUEUE_FULL',
              message: queueFullError.message,
              category: 'execution',
            }),
          });
          res.status(429).json({
            sessionId,
            error: 'Execution queue full',
            message: queueFullError.message,
            ...(await buildInlineDebugPayload({
              includeDebug,
              sessionId,
              traceEvents,
              runtimeSession: executor.getSession(executionSessionId) ?? session ?? undefined,
            })),
          });
          return;
        }
        if (error instanceof ChannelExecutionTimeoutError) {
          await cleanupUploadedMultipartOnFailure();
          const timeoutOutcome = buildErrorOutcome({
            channelType: 'api',
            error,
            session: executor.getSession(executionSessionId) ?? undefined,
          });
          recordSyntheticTraceEvent({
            traceEvents,
            sessionId,
            session: executor.getSession(executionSessionId) ?? undefined,
            event: buildOutcomeTraceEvent(timeoutOutcome),
          });
          res.status(504).json({
            sessionId,
            response: timeoutOutcome.responseText,
            action: { type: 'timeout' },
            outcome: toPublicChannelOutcome(timeoutOutcome),
            ...(await buildInlineDebugPayload({
              includeDebug,
              sessionId,
              state: executor.getSession(executionSessionId)?.state,
              traceEvents,
              runtimeSession: executor.getSession(executionSessionId) ?? undefined,
            })),
          });
          return;
        }
        await cleanupUploadedMultipartOnFailure();
        throw error;
      }

      const updatedSession = executor.getSession(executionSessionId);
      chatEnvironment =
        chatEnvironment ??
        updatedSession?.versionInfo?.environment ??
        session?.versionInfo?.environment;
      const outcome = buildExecutionOutcome({
        channelType: 'api',
        result: execResult,
        streamedText: chunks.length > 0 ? chunks.join('') : undefined,
        session: updatedSession ?? session ?? undefined,
      });
      const assistantResponseText =
        outcome.usedFallback && outcome.responseText
          ? outcome.responseText
          : execResult.response || outcome.responseText;
      const responseMetadata =
        execResult.responseMetadata ?? buildResponseMessageMetadata(responseProvenance);
      const assistantPersistenceMessages = buildAssistantPersistenceMessages({
        outcome: { ...outcome, responseText: assistantResponseText },
        responseMetadata,
        agentName: updatedSession?.agentName ?? session?.agentName,
      });
      const assistantHasRenderablePayload = hasRenderableChannelOutcome({
        ...outcome,
        responseText: assistantResponseText,
      });

      // Persist messages and metrics via batched queue
      if (dbSessionId) {
        const scopedPersistence =
          requiredChatScope ??
          buildHttpChatPersistenceScope({
            tenantContext: req.tenantContext,
            tenantId: resolvedTenantId,
            projectId,
            sessionId: executionSessionId,
            environment: chatEnvironment,
            callerContext:
              requestCallerContext ?? updatedSession?.callerContext ?? session?.callerContext,
            contactId: chatContactId,
          });

        if (scopedPersistence) {
          persistScopedMessage({
            scope: scopedPersistence,
            message: {
              dbSessionId,
              role: 'user',
              content: message,
              channel: 'api',
            },
          }).catch((err: unknown) => log.warn('Chat user message persist failed', { err }));
          if (assistantHasRenderablePayload) {
            for (const assistantMessage of assistantPersistenceMessages) {
              persistScopedMessage({
                scope: scopedPersistence,
                message: {
                  dbSessionId,
                  role: 'assistant',
                  content: assistantMessage.content,
                  structuredContent: assistantMessage.structuredContent,
                  channel: 'api',
                  metadata: assistantMessage.metadata as typeof responseMetadata | undefined,
                  messageId: assistantMessage.messageId,
                  agentName: assistantMessage.agentName,
                },
              }).catch((err: unknown) =>
                log.warn('Chat assistant message persist failed', { err }),
              );
            }
          }
          persistScopedTurnMetrics({
            scope: scopedPersistence,
            metrics: {
              dbSessionId,
              tokensIn: turnTokensIn,
              tokensOut: turnTokensOut,
              cost: turnCost,
              traceEventCount: turnTraceCount,
              errorCount: turnErrorCount,
              handoffCount: turnHandoffCount,
            },
          }).catch((err: unknown) => log.warn('Chat metrics persist failed', { err }));
        } else {
          persistMessage(
            dbSessionId,
            'user',
            message,
            'api',
            resolvedTenantId,
            undefined,
            chatContactId,
            projectId,
          ).catch((err: unknown) => log.warn('Chat user message persist failed', { err }));
          if (assistantHasRenderablePayload) {
            for (const assistantMessage of assistantPersistenceMessages) {
              persistMessageRecord({
                dbSessionId,
                role: 'assistant',
                content: assistantMessage.content,
                channel: 'api',
                tenantId: resolvedTenantId,
                contactId: chatContactId,
                projectId,
                messageTimestamp: assistantMessage.messageTimestamp,
                structuredContent: assistantMessage.structuredContent,
                metadata: assistantMessage.metadata as Partial<MessageMetadata> | undefined,
                messageId: assistantMessage.messageId,
                agentName: assistantMessage.agentName,
              }).catch((err: unknown) =>
                log.warn('Chat assistant message persist failed', { err }),
              );
            }
          }
          persistTurnMetrics({
            dbSessionId,
            tenantId: resolvedTenantId,
            tokensIn: turnTokensIn,
            tokensOut: turnTokensOut,
            cost: turnCost,
            traceEventCount: turnTraceCount,
            errorCount: turnErrorCount,
            handoffCount: turnHandoffCount,
          }).catch((err: unknown) => log.warn('Chat metrics persist failed', { err }));
        }
      }

      // llm_metrics written per-call inside onTraceEvent above.
      // Write one turn-aggregate row with e2e latency and totals across all calls.
      const latencyMs = Date.now() - startTime;
      if (turnTokensIn > 0 || turnTokensOut > 0) {
        let turnCostFinal: number | null = turnCost || null;
        if (!turnCostFinal && lastModelId && hasKnownPricing(lastModelId)) {
          try {
            const caps = getModelCapabilities(lastModelId);
            turnCostFinal = calculateCost(
              caps.inputCostPer1k,
              caps.outputCostPer1k,
              turnTokensIn,
              turnTokensOut,
            );
          } catch {
            /* non-fatal */
          }
        }
        getMetricsStoreAsync()
          .then(async (store) => {
            await store.record({
              tenantId: resolvedTenantId,
              sessionId: sessionId || 'adhoc',
              projectId,
              userId: resolveRuntimeAuthPrincipal(req.tenantContext),
              modelId: lastModelId,
              provider: lastProvider,
              inputTokens: turnTokensIn,
              outputTokens: turnTokensOut,
              totalTokens: turnTokensIn + turnTokensOut,
              estimatedCost: turnCostFinal,
              latencyMs,
              streamingUsed: false,
              toolCallCount: turnToolCallCount,
              operationType: 'turn_aggregate',
              knownSource: knownSource ?? 'production',
            });
          })
          .catch((err: unknown) =>
            log.warn('Chat agent turn aggregate metrics record failed', { err }),
          );
      }

      res.json({
        sessionId,
        response: outcome.responseText,
        action: execResult.action,
        responseMetadata,
        voiceConfig: outcome.voiceConfig || undefined,
        richContent: outcome.richContent || undefined,
        actions: outcome.actions || undefined,
        localization: outcome.localization,
        outcome: toPublicChannelOutcome(outcome),
        ...(await buildInlineDebugPayload({
          includeDebug,
          sessionId,
          state: execResult.stateUpdates || updatedSession?.state,
          traceEvents,
          runtimeSession: updatedSession ?? session ?? undefined,
        })),
      });

      emitChannelResponseSent(sessionId, 'chat-agent', latencyMs, {
        tenantId: resolvedTenantId,
        projectId,
        configHash: executor.getSession(executionSessionId)?.configHash,
        knownSource: executor.getSession(executionSessionId)?.knownSource,
      });

      // NOTE: ClickHouse message writes are now handled by DualWriteMessageStore
      // via the message persistence queue — no ad-hoc writes needed here.
    } catch (error) {
      if (sessionSlotClaimed && quotaTenantId && claimedSessionId) {
        await getRuntimeExecutor().releaseSessionSlot(quotaTenantId, claimedSessionId);
      }
      log.error('[Chat] Agent execution error', {
        error: error instanceof Error ? error.message : String(error),
      });
      const { statusCode, body } = errorToResponse(error);
      if (sessionId && body && typeof body === 'object' && !Array.isArray(body)) {
        recordSyntheticTraceEvent({
          traceEvents,
          sessionId,
          session: getRuntimeExecutor().getSession(sessionId) ?? undefined,
          event: (() => {
            const { code, message } = extractErrorTracePayload(body);
            return buildChannelTraceEvent({
              severity: 'error',
              code,
              message,
              category: 'execution',
            });
          })(),
        });

        res.status(statusCode).json({
          ...(body as Record<string, unknown>),
          sessionId,
          ...(await buildInlineDebugPayload({
            includeDebug,
            sessionId,
            traceEvents,
            runtimeSession: getRuntimeExecutor().getSession(sessionId) ?? undefined,
          })),
        });
        return;
      }
      res.status(statusCode).json(body);
    }
  },
);

export default openapi.router;
