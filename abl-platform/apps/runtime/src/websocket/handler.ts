/**
 * WebSocket Message Handler
 *
 * Routes and processes WebSocket messages from clients.
 * Uses the real Agent ABL runtime engine for execution.
 * Internal Studio/runtime auth is carried in the WebSocket subprotocol header.
 */

import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import crypto from 'crypto';
import type { MessageMetadata } from '@abl/compiler/platform/core/types.js';
import { parseClientMessage, serializeServerMessage, ServerMessages } from './events.js';
import { validateActionSubmitEnvelope } from './action-submit-envelope.js';
import { buildSessionDiagnosticMessages } from './session-diagnostics.js';
import { validateSessionOwnership } from './session-ownership.js';
import { buildAgentDetails } from '../services/dsl-utils.js';
import { createTraceEmitter, type TraceEmitter } from '../services/trace-emitter.js';
import {
  getRuntimeExecutor,
  compileToResolvedAgent,
  buildExecutionResultContentEnvelope,
  type RuntimeSession,
} from '../services/runtime-executor.js';
import { TRACE_MODEL_UNKNOWN } from '../services/llm/session-llm-client.js';
import {
  getModelCapabilities,
  calculateCost,
  hasKnownPricing,
} from '../services/llm/model-router.js';
import {
  enqueueLLMRequest,
  BackpressureError,
  isLLMQueueEnabled,
} from '../services/llm/llm-queue.js';
import {
  getExecutionCoordinator,
  isCoordinatorAvailable,
} from '../services/execution/coordinator-singleton.js';
import { getTraceStore } from '../services/trace-store.js';
import { emitChannelResponseSent } from '../services/channel-trace-utils.js';
import { buildExecutionOutcome, hasRenderableChannelOutcome } from '../services/channel/outcome.js';
import {
  buildAssistantPersistenceMessages,
  type AssistantPersistenceMessage,
} from '../services/channel/outcome-persistence.js';
import { withAgentNameMetadata } from '../services/channel/message-metadata.js';
import {
  accumulateResponseProvenance,
  buildResponseMessageMetadata,
  createResponseProvenanceAccumulator,
  extractLlmTraceMetrics,
} from '../services/channel/response-provenance.js';
import { createLogger } from '@abl/compiler/platform';
import { runWithObservabilityContext } from '@abl/compiler/platform/observability';
import { isConfigLoaded, getConfig } from '../config/loader.js';
import { getRedisHandle } from '../services/redis/redis-client.js';
import { createSubscriber } from '@agent-platform/redis';
import { extractVerifiedUserTokenClaims, writeAccessDeniedAuditLog } from '../middleware/auth.js';
import { resolveEffectivePermissions } from '../services/permission-resolution.js';
import { isDatabaseAvailable } from '../db/index.js';
import {
  createAccessDeniedReporter,
  runWithTenantContext,
  resolveTenantContext,
  type AccessDeniedLayer,
  type AccessDeniedScope,
  type TenantContextData,
} from '@agent-platform/shared-auth';
import { isLlmError } from '../services/llm/classify-llm-error.js';
import { buildCallerContext } from '../services/identity/artifact-hasher.js';
import {
  DeploymentResolver,
  mergeWorkingCopyModules,
  type ResolvedAgent,
} from '../services/deployment-resolver.js';
import { getSessionService } from '../services/session/session-service.js';
import { mergeSessionDimensions } from '../services/metadata/custom-dimensions.js';
import type {
  ClientMessage,
  ServerMessage,
  AgentDetails,
  ResumedConversationMessage,
  TraceEventWithId,
} from '../types/index.js';
import { incrementActiveSessions, decrementActiveSessions } from '../observability/metrics.js';
import { getStores } from '../services/stores/store-factory.js';
import { resolveTenantMembership, resolveDefaultTenant } from '../repos/auth-repo.js';
import {
  findProjectByIdAndTenant,
  findProjectAgentByPath,
  findProjectAgentByName,
  findProjectAgentsForProject,
  findProjectRuntimeConfig,
  findProjectWithAgents,
  loadConfigVariablesMap,
} from '../repos/project-repo.js';
import { findSessionById, findMessagesForSession, updateSession } from '../repos/session-repo.js';
import {
  persistMessage,
  persistMessageRecord,
  persistTurnMetrics,
  flushMessageQueue,
} from '../services/message-persistence-queue.js';
import { resolveSessionTimeouts } from '../channels/pipeline/session-factory.js';
import { getTenantConfigService } from '../services/tenant-config.js';
import { buildProductionSessionLocator } from '../services/session/execution-scope.js';
import {
  auditContextInjected,
  auditToolMockSet,
  auditTestSessionCreated,
} from '../services/audit-helpers.js';
import { MockToolExecutor } from '../services/execution/mock-tool-executor.js';
import type {
  ToolMockConfig,
  TestContextPayload,
  ContextInjection,
} from '../types/test-context.js';
import {
  registerSessionWebSocket,
  unregisterSessionWebSocket,
} from '../services/agent-transfer/session-ws-registry.js';
import { getPausedExecutionStore } from '../services/auth-profile/paused-execution-store.js';
import { getToolOAuthService } from '../services/tool-oauth-service-singleton.js';
import { AUTH_PROFILE_OAUTH_PROVIDER_ID } from '../services/auth-profile/auth-profile-oauth-resolver.js';
import { buildRuntimeOAuthCallbackUri } from '../services/oauth-callback-url.js';
import {
  checkAuthPreflightFromIR,
  evaluateAuthPreflightFromIR,
  hasActiveAuthGateAsync,
  queueMessageBehindAuthGateAsync,
  reconcileAuthGateWithEvaluationAsync,
  cleanupAuthGateAsync,
  createTokenLookups,
} from '../services/auth-profile/auth-preflight.js';
import { buildAuthLifecycleTraceEvent } from '../services/auth-profile/auth-trace-events.js';
import { cleanupClosedSessionArtifacts } from '../services/session-lifecycle/artifact-cleanup.js';
import { SessionRuntimePolicyService } from '../services/session-lifecycle/runtime-policy-service.js';
import {
  isSessionTerminalizationEnabled,
  SessionTerminalizationService,
} from '../services/session-lifecycle/terminalization-service.js';
import { extractWebDebugTokenFromProtocolHeader } from '@agent-platform/shared/websocket-auth';
import { WebSocketConnectionManager, type ManagedClientState } from './connection-manager.js';
import {
  buildSessionLocalizationCatalog,
  storeRuntimeSessionLocalizationCatalog,
} from '../services/execution/localized-messages.js';
import { resolvePersistedAgentVersion } from '../services/execution/agent-version-utils.js';
import {
  buildPersistedAssistantStructuredContent,
  contentBlocksToText,
} from '../services/session/persisted-message-content.js';
import {
  buildProjectWorkingCopyAgentSources,
  compileProjectWorkingCopy,
  normalizeProjectWorkingCopyLibraryRef,
  type ProjectWorkingCopyAgentSource,
} from '../services/project-working-copy-compiler.js';
import {
  buildProjectDslReadinessError,
  evaluateProjectExecutionReadiness,
} from '../services/session/project-agent-dsl-readiness.js';

const wsLog = createLogger('ws-handler');
const runtimePolicyService = new SessionRuntimePolicyService();
const terminalizationService = new SessionTerminalizationService();

function getResolvedAgentLifecycle(resolved: ResolvedAgent) {
  const entryAgent =
    resolved.agents[resolved.entryAgent] ?? Object.values(resolved.agents)[0] ?? undefined;
  return entryAgent?.execution?.sessionLifecycle;
}

function getRuntimeAgentLifecycle(session?: RuntimeSession) {
  return session?.agentIR?.execution?.sessionLifecycle;
}

async function compileWebDebugWorkingCopy(params: {
  tenantId?: string;
  projectId?: string;
  entryAgentName: string;
  environment?: string;
  agents: ProjectWorkingCopyAgentSource[];
}): Promise<{
  resolved: ResolvedAgent;
  configVariables?: Record<string, string>;
}> {
  if (params.tenantId && params.projectId) {
    const compileResult = await compileProjectWorkingCopy({
      tenantId: params.tenantId,
      projectId: params.projectId,
      entryAgentName: params.entryAgentName,
      environment: params.environment || 'dev',
      agents: params.agents,
    });

    return {
      resolved: compileResult.resolved,
      configVariables:
        Object.keys(compileResult.configVariables).length > 0
          ? compileResult.configVariables
          : undefined,
    };
  }

  return {
    resolved: compileToResolvedAgent(
      params.agents.map((agent) => agent.dslContent),
      params.entryAgentName,
      undefined,
      undefined,
      params.environment || 'dev',
    ),
  };
}

/**
 * Resolve agentVersions for trace context. In dev/working-copy mode (no
 * deployment), versionInfo.versions is empty `{}` — emit a `{ agentName: 0 }`
 * sentinel so traces always carry version context for filtering.
 */
function resolveAgentVersionsForTrace(session: RuntimeSession): Record<string, number> | undefined {
  const versions = session.versionInfo?.versions;
  if (versions && Object.keys(versions).length > 0) {
    return versions;
  }
  // Dev/working-copy fallback — ensures trace events always have agentVersions
  return session.agentName ? { [session.agentName]: 0 } : undefined;
}

async function resolveWebDebugDisconnectLifecycle(
  state?: ClientState,
  runtimeSession?: RuntimeSession,
): Promise<{
  disposition: string;
  disconnectBehavior: 'end' | 'detach';
}> {
  const resolved = await runtimePolicyService.resolveDisconnectPolicy({
    channel: 'web_debug',
    tenantId: state?.tenantId ?? runtimeSession?.tenantId,
    projectId: state?.projectId ?? runtimeSession?.projectId,
    agentName: runtimeSession?.agentName ?? state?.agentDetails?.name,
    agentLifecycle: getRuntimeAgentLifecycle(runtimeSession),
  });

  return {
    disposition: resolved.disposition ?? 'completed',
    disconnectBehavior: resolved.disconnectBehavior ?? 'detach',
  };
}

const MAX_PREAUTH_BUFFERED_MESSAGES = 16;
const MAX_PREAUTH_BUFFERED_BYTES = 256 * 1024;

// Conversation store accessor — delegates to the store factory
function getConversationStore() {
  return getStores().conversation;
}

async function reactivatePersistedSessionSummary(
  sessionId: string,
  tenantId: string | undefined,
): Promise<void> {
  if (!tenantId || !isDatabaseAvailable()) {
    return;
  }

  try {
    await updateSession(
      sessionId,
      {
        status: 'active',
        endedAt: null,
        disposition: null,
        dispositionCode: null,
        lastActivityAt: new Date(),
      },
      tenantId,
    );
  } catch (err) {
    wsLog.warn('[WS] Failed to reactivate persisted session summary', {
      sessionId,
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function buildWsSessionLocator(
  sessionId: string | undefined,
  state?: Pick<ClientState, 'tenantId' | 'projectId' | 'runtimeSession'>,
) {
  if (!sessionId) {
    return null;
  }

  return buildProductionSessionLocator({
    tenantId: state?.tenantId ?? state?.runtimeSession?.tenantId,
    projectId: state?.projectId ?? state?.runtimeSession?.projectId,
    sessionId,
  });
}

// =============================================================================
// CLICKHOUSE PERSISTENCE (lazy singleton)
// NOTE: ClickHouse message writes are now handled by DualWriteMessageStore
// via the message persistence queue — only metrics stores here.
// =============================================================================

interface ChStores {
  metricsStore: import('../services/stores/clickhouse-metrics-store.js').ClickHouseMetricsStore;
}

const CLICKHOUSE_INIT_BACKOFF_MS = 60_000;

let _chStores: ChStores | null = null;
let _chInitPromise: Promise<ChStores | null> | null = null;
let _chRetryAfter = 0;

export function __resetDebugWsClickHouseStateForTests(): void {
  _chStores = null;
  _chInitPromise = null;
  _chRetryAfter = 0;
}

function shouldUseClickHouse(): boolean {
  return process.env.USE_MONGO_CLICKHOUSE === 'true';
}

function canAttemptClickHouseInit(): boolean {
  return shouldUseClickHouse() && Date.now() >= _chRetryAfter;
}

/**
 * Get ClickHouse store singletons. These are tenant-agnostic — tenantId is
 * passed per-write to avoid the first-tenant-locks-all corruption bug.
 */
async function getChStores(): Promise<ChStores | null> {
  if (!canAttemptClickHouseInit()) return null;
  if (_chStores) return _chStores;
  if (_chInitPromise) return _chInitPromise;

  _chInitPromise = (async () => {
    try {
      const { ClickHouseMetricsStore } =
        await import('../services/stores/clickhouse-metrics-store.js');
      const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
      const client = getClickHouseClient();
      _chRetryAfter = 0;
      _chStores = {
        metricsStore: new ClickHouseMetricsStore(
          { type: 'clickhouse' },
          { client, tenantId: 'system' },
        ),
      };
      return _chStores;
    } catch (err) {
      _chRetryAfter = Date.now() + CLICKHOUSE_INIT_BACKOFF_MS;
      wsLog.warn('ClickHouse unavailable for debug websocket handler, backing off writes', {
        retryInMs: CLICKHOUSE_INIT_BACKOFF_MS,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      _chInitPromise = null;
    }
  })();

  return _chInitPromise;
}

// =============================================================================
// CLIENT STATE
// =============================================================================

interface ClientState extends ManagedClientState {
  ws: WebSocket;
  sessionId?: string;
  runtimeSession?: RuntimeSession;
  /** Monotonic per-connection load sequence so stale load requests can be ignored. */
  loadRequestSeq?: number;
  traceEmitter?: TraceEmitter;
  userId?: string; // Authenticated user ID (if any)
  authToken?: string; // Raw token for tool API auth
  /** Full tenant context resolved at connection time (same as REST req.tenantContext) */
  tenantContext?: TenantContextData;
  /** Loaded agent details (for test case lookup etc.) */
  agentDetails?: AgentDetails;
  /** DB session ID for enterprise persistence */
  dbSessionId?: string;
  /** Deferred DB session info (materialized on first user message) */
  pendingDbSession?: {
    agentName: string;
    agentVersion: string;
    sessionId: string;
    entryAgentName: string;
    deploymentId?: string;
    projectId: string;
    tenantId: string;
  };
  /** Project ID for the loaded agent */
  projectId?: string;
  /** Tenant ID for the loaded agent (derived from tenantContext or project lookup) */
  tenantId?: string;
  /** Per-connection trace ID (W3C 32-hex format) for WS observability context */
  traceId?: string;
  /** WebSocket connection registry ID, used to unregister on disconnect */
  _wsConnectionId?: string;
  /**
   * contactId alias registered alongside the session ID in the WS registry.
   * The agent-transfer bridge receives events keyed by contactId, not by the
   * MongoDB session ID, so registering both keys ensures reliable delivery.
   */
  _wsContactId?: string;
}

const clients = new WebSocketConnectionManager<ClientState>({
  label: 'internal',
  maxConnections: 10_000,
  staleTtlMs: 5 * 60 * 1000, // 5 minutes
  sweepIntervalMs: 60 * 1000, // 60 seconds
});

/** Getter for the internal WS connection manager — used by callback handlers that need to broadcast to sessions. */
export function getInternalConnectionManager(): WebSocketConnectionManager<ClientState> {
  return clients;
}

const MAX_JIT_PROVIDER_NAME_LENGTH = 64;

function claimLoadRequest(ws: WebSocket): number | null {
  const state = clients.get(ws);
  if (!state) {
    return null;
  }

  const nextRequestId = (state.loadRequestSeq ?? 0) + 1;
  state.loadRequestSeq = nextRequestId;
  return nextRequestId;
}

function isCurrentLoadRequest(ws: WebSocket, requestId: number): boolean {
  const state = clients.get(ws);
  return !!state && state.loadRequestSeq === requestId;
}

function getBoundSessionId(state?: ClientState): string | undefined {
  return state?.sessionId || state?.runtimeSession?.id;
}

function buildRuntimeResumeMessageId(
  sessionId: string,
  index: number,
  role: string,
  content: string,
): string {
  const contentHash = crypto
    .createHash('sha1')
    .update(`${role}\0${content}`)
    .digest('hex')
    .slice(0, 12);
  return `resume-${sessionId}-${index}-${contentHash}`;
}

function buildResumedConversationHistoryFromRuntime(
  session: RuntimeSession,
): ResumedConversationMessage[] {
  return session.conversationHistory
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message, index) => {
      const content =
        typeof message.content === 'string'
          ? message.content
          : contentBlocksToText(message.content);
      return {
        id: buildRuntimeResumeMessageId(session.id, index, message.role, content),
        role: message.role,
        content,
        ...(Array.isArray(message.content) ? { rawContent: message.content } : {}),
        ...(message.contentEnvelope ? { contentEnvelope: message.contentEnvelope } : {}),
        ...(message.metadata ? { metadata: message.metadata } : {}),
      };
    });
}

function buildResumedConversationHistoryFromPersistedMessages(
  messages: Array<{
    id: string;
    role: string;
    content: string;
    rawContent?: import('@abl/compiler/platform/llm/types.js').ContentBlock[];
    contentEnvelope?: import('../services/session/persisted-message-content.js').PersistedStructuredMessageEnvelopeV2;
    metadata?: Record<string, unknown>;
  }>,
): ResumedConversationMessage[] {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      ...(message.rawContent ? { rawContent: message.rawContent } : {}),
      ...(message.contentEnvelope ? { contentEnvelope: message.contentEnvelope } : {}),
      ...(message.metadata ? { metadata: message.metadata } : {}),
    }));
}

function releaseStaleLoadedSession(
  ws: WebSocket,
  executor: ReturnType<typeof getRuntimeExecutor>,
  sessionId: string,
): void {
  const state = clients.get(ws);
  if (state && getBoundSessionId(state) === sessionId) {
    if (state._wsConnectionId) {
      unregisterSession(state._wsConnectionId, sessionId);
    }
    unregisterSessionWebSocket(sessionId);
    if (state._wsContactId) {
      unregisterSessionWebSocket(state._wsContactId);
    }
    state.sessionId = undefined;
    state.runtimeSession = undefined;
    state.traceEmitter = undefined;
    state.agentDetails = undefined;
    state.dbSessionId = undefined;
    state.pendingDbSession = undefined;
    state.projectId = undefined;
    state.tenantId = undefined;
    state.traceId = undefined;
    state._wsConnectionId = undefined;
    state._wsContactId = undefined;
  }

  executor.endSession(sessionId);
}

// --- Module-level singletons set from server.ts ---

import type { WebSocketConnectionRegistry } from './connection-registry.js';
let _wsRegistry: WebSocketConnectionRegistry | null = null;
let _redisPubSub: any = null;
let _redisSubscriber: any = null;

function isSupportedJitProviderName(profileId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(profileId) && profileId.length <= MAX_JIT_PROVIDER_NAME_LENGTH;
}

function getRuntimeApiBaseUrl(): string {
  const fromEnv = process.env.RUNTIME_PUBLIC_BASE_URL || process.env.RUNTIME_BASE_URL;
  if (fromEnv) {
    return fromEnv.replace(/\/+$/, '');
  }

  if (isConfigLoaded()) {
    const config = getConfig();
    return (config.server.apiUrl || `http://localhost:${config.server.port}`).replace(/\/+$/, '');
  }

  return 'http://localhost:3112';
}

function createJitAuthCallbacks(
  ws: WebSocket,
  context: { tenantId?: string; userId?: string },
): {
  sendAuthChallenge: RuntimeSession['sendAuthChallenge'];
  initiateJitOAuth: RuntimeSession['initiateJitOAuth'];
} {
  const runtimeApiBaseUrl = getRuntimeApiBaseUrl();

  return {
    sendAuthChallenge: (params) => {
      send(
        ws,
        ServerMessages.authChallenge(params.sessionId, {
          toolCallId: params.toolCallId,
          authType: params.authType,
          authUrl: params.authUrl,
          profileId: params.profileId,
          profileName: params.profileName ?? '',
          prompt: params.prompt ?? '',
          timeoutMs: params.timeoutMs ?? 0,
        }),
      );
    },
    initiateJitOAuth: async ({
      profileId,
      authProfileRef,
      sessionId,
      toolCallId,
      projectId,
      environment,
      scopes,
      connectionMode,
    }) => {
      if (!context.tenantId || !context.userId) {
        return undefined;
      }

      const oauthService = getToolOAuthService();
      if (!oauthService) {
        return undefined;
      }

      if (authProfileRef) {
        // JIT always stores tokens under the real user — the end user is giving
        // consent themselves. connection_mode:'shared' with __tenant__ is
        // exclusively for preconfigured mode (admin-managed credentials).
        return oauthService.initiateAuthProfileJitOAuth({
          authProfileRef,
          tenantId: context.tenantId,
          userId: context.userId,
          sessionId,
          toolCallId,
          redirectUri: buildRuntimeOAuthCallbackUri(
            runtimeApiBaseUrl,
            AUTH_PROFILE_OAUTH_PROVIDER_ID,
          ),
          projectId,
          environment,
          scopes,
          lookupScope: 'user',
        });
      }

      if (!isSupportedJitProviderName(profileId)) {
        return undefined;
      }

      return oauthService.initiateJitOAuth(
        profileId,
        context.tenantId,
        context.userId,
        sessionId,
        toolCallId,
        buildRuntimeOAuthCallbackUri(runtimeApiBaseUrl, profileId),
      );
    },
  };
}

function bindJitAuthCallbacksToSession(ws: WebSocket, session: RuntimeSession): void {
  const executor = getRuntimeExecutor();
  const callbacks = createJitAuthCallbacks(ws, {
    tenantId: session.tenantId,
    userId: session.userId,
  });

  session.sendAuthChallenge = callbacks.sendAuthChallenge;
  session.initiateJitOAuth = callbacks.initiateJitOAuth;
  executor.rewireSessionToolExecutor(session.id);
}

function emitAuthLifecycleTrace(
  ws: WebSocket,
  params: Parameters<typeof buildAuthLifecycleTraceEvent>[0],
): void {
  const traceEvent = buildAuthLifecycleTraceEvent(params);

  try {
    getTraceStore().addEvent(params.sessionId, traceEvent);
  } catch (err) {
    wsLog.warn('TraceStore unavailable for auth lifecycle trace', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  send(ws, ServerMessages.traceEvent(params.sessionId, traceEvent));
}

async function activateAuthGateIfRequired(
  ws: WebSocket,
  sessionId: string,
  runtimeSession: RuntimeSession,
  userId?: string,
): Promise<boolean> {
  if (!runtimeSession.compilationOutput) {
    return false;
  }

  if (await hasActiveAuthGateAsync(sessionId)) {
    return true;
  }

  const tokenLookups = createTokenLookups(
    runtimeSession.tenantId,
    runtimeSession.projectId,
    runtimeSession.versionInfo?.environment,
  );
  const gateState = await checkAuthPreflightFromIR(
    sessionId,
    runtimeSession.compilationOutput,
    {
      userId,
      tenantId: runtimeSession.tenantId,
      projectId: runtimeSession.projectId,
      environment: runtimeSession.versionInfo?.environment,
    },
    tokenLookups,
    runtimeSession.agentName ? { agentNames: [runtimeSession.agentName] } : undefined,
  );

  if (!gateState) {
    return false;
  }

  send(ws, ServerMessages.authRequired(sessionId, gateState.pending, gateState.satisfied));
  const clientState = clients.get(ws);
  emitAuthLifecycleTrace(ws, {
    sessionId,
    decision: 'preflight_required',
    pending: gateState.pending,
    satisfied: gateState.satisfied,
    traceId: clientState?.traceId,
    spanId: clientState?.traceEmitter?.getCurrentSpanId(),
    agentName: runtimeSession.agentName,
  });
  wsLog.info('Auth gate activated for debug session', {
    sessionId,
    pendingCount: gateState.pending.length,
  });
  return true;
}

interface SessionAccessTarget {
  tenantId?: string;
  userId?: string;
  initiatedById?: string;
  callerContext?: {
    initiatedById?: string;
  };
}

function createWsAccessDeniedReporter(options: {
  tenantContext?: TenantContextData;
  projectId?: string;
  messageType: string;
  requestId?: string;
  path?: string;
  method?: string;
}) {
  return createAccessDeniedReporter({
    transport: 'websocket',
    logger: {
      warn: (message, meta) => wsLog.warn(message, meta),
    },
    onAccessDenied: writeAccessDeniedAuditLog,
    messageType: options.messageType,
    requestId: options.requestId,
    path: options.path,
    method: options.method,
    tenantContext: options.tenantContext,
    projectId: options.projectId,
  });
}

function getHeaderString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function getSessionOwnerUserId(session: SessionAccessTarget): string | undefined {
  return session.userId ?? session.initiatedById ?? session.callerContext?.initiatedById;
}

function getWsDeniedScope(reasonCode: string): AccessDeniedScope {
  if (
    reasonCode === 'SESSION_USER_MISMATCH' ||
    reasonCode === 'CLIENT_SESSION_BINDING_MISMATCH' ||
    reasonCode === 'SESSION_OWNER_CONTEXT_MISSING'
  ) {
    return 'user';
  }
  if (reasonCode === 'CLIENT_USER_CONTEXT_REQUIRED' || reasonCode === 'AUTHENTICATION_REQUIRED') {
    return 'auth';
  }
  return 'tenant';
}

function reportWsConnectionAccessDenied(
  req: IncomingMessage | undefined,
  details: {
    layer: AccessDeniedLayer;
    scope: AccessDeniedScope;
    reasonCode: string;
    reason: string;
    statusCode: 401 | 403 | 404;
    authType?: TenantContextData['authType'];
    tenantId?: string;
    userId?: string;
    metadata?: Record<string, unknown>;
  },
): void {
  createWsAccessDeniedReporter({
    messageType: 'connect',
    requestId: getHeaderString(req?.headers['x-request-id']),
    path: req?.url ?? '/ws',
    method: 'GET',
  })({
    layer: details.layer,
    scope: details.scope,
    reasonCode: details.reasonCode,
    reason: details.reason,
    concealAsNotFound: details.statusCode === 404,
    statusCode: details.statusCode,
    authType: details.authType,
    tenantId: details.tenantId,
    userId: details.userId,
    metadata: details.metadata,
  });
}

function reportWsAccessDenied(
  ws: WebSocket,
  details: {
    messageType: string;
    sessionId: string;
    reasonCode: string;
    reason: string;
    concealAsNotFound: boolean;
    scope?: AccessDeniedScope;
    layer?: AccessDeniedLayer;
    statusCode?: 401 | 403 | 404;
    metadata?: Record<string, unknown>;
  },
): void {
  const clientState = clients.get(ws);
  createWsAccessDeniedReporter({
    messageType: details.messageType,
    tenantContext: clientState?.tenantContext,
    projectId: clientState?.projectId ?? clientState?.tenantContext?.projectId,
  })({
    layer: details.layer ?? 'session_ownership',
    scope: details.scope ?? getWsDeniedScope(details.reasonCode),
    reasonCode: details.reasonCode,
    reason: details.reason,
    concealAsNotFound: details.concealAsNotFound,
    statusCode: details.statusCode ?? (details.concealAsNotFound ? 404 : 403),
    resourceType: 'session',
    resourceId: details.sessionId,
    metadata: details.metadata,
  });
}

function runWithClientTenantContext<T>(ws: WebSocket, fn: () => T): T {
  const tenantContext = clients.get(ws)?.tenantContext;
  if (!tenantContext) {
    return fn();
  }

  return runWithTenantContext(tenantContext, fn);
}

function getSessionAccessResult(ws: WebSocket, session: SessionAccessTarget) {
  const clientState = clients.get(ws);
  return validateSessionOwnership({
    clientTenantId: clientState?.tenantId,
    clientUserId: clientState?.userId,
    sessionTenantId: session.tenantId,
    sessionOwnerUserId: getSessionOwnerUserId(session),
  });
}

function ensureWsSessionBinding(ws: WebSocket, sessionId: string, messageType: string): boolean {
  const clientState = clients.get(ws);
  if (!clientState?.sessionId || clientState.sessionId !== sessionId) {
    reportWsAccessDenied(ws, {
      messageType,
      sessionId,
      reasonCode: 'CLIENT_SESSION_BINDING_MISMATCH',
      reason: 'Session not found',
      concealAsNotFound: true,
      statusCode: 404,
      scope: 'user',
      metadata: {
        requestedSessionId: sessionId,
        ownedSessionId: clientState?.sessionId,
      },
    });
    return false;
  }

  return true;
}

function ensureWsSessionAccess(
  ws: WebSocket,
  sessionId: string,
  session: SessionAccessTarget,
  messageType: string,
): boolean {
  const access = getSessionAccessResult(ws, session);
  if (!access.allowed) {
    reportWsAccessDenied(ws, {
      messageType,
      sessionId,
      reasonCode: access.reasonCode ?? 'SESSION_ACCESS_DENIED',
      reason: access.reason ?? 'Session not found',
      concealAsNotFound: access.concealAsNotFound === true,
      statusCode: access.statusCode,
    });
    return false;
  }
  return true;
}

function getAuthorizedRuntimeSession(
  ws: WebSocket,
  sessionId: string,
  messageType: string,
): RuntimeSession | null {
  const runtimeSession = getRuntimeExecutor().getSession(sessionId);
  if (!runtimeSession) {
    return null;
  }

  if (ensureWsSessionAccess(ws, sessionId, runtimeSession, messageType)) {
    return runtimeSession;
  }

  return null;
}

async function getAuthorizedPersistedSession(
  ws: WebSocket,
  sessionId: string,
  messageType: string,
): Promise<SessionAccessTarget | null> {
  const tenantId = clients.get(ws)?.tenantId;
  if (!tenantId || !isDatabaseAvailable()) {
    return null;
  }

  const session = await findSessionById(sessionId, tenantId);
  if (!session) {
    return null;
  }

  if (ensureWsSessionAccess(ws, sessionId, session, messageType)) {
    return session;
  }

  return null;
}

async function hasAuthorizedSessionAccess(
  ws: WebSocket,
  sessionId: string,
  messageType: string,
): Promise<boolean> {
  const runtimeSession = getRuntimeExecutor().getSession(sessionId);
  if (runtimeSession) {
    return ensureWsSessionAccess(ws, sessionId, runtimeSession, messageType);
  }

  const persistedSession = await getAuthorizedPersistedSession(ws, sessionId, messageType);
  if (persistedSession) {
    return true;
  }

  return false;
}

/** Called from server.ts during graceful shutdown to stop timers and close connections. */
export function shutdownInternalClients(): void {
  clients.shutdown();
}

/** Called from server.ts to wire the shared WS connection registry. */
export function setConnectionRegistry(registry: WebSocketConnectionRegistry): void {
  _wsRegistry = registry;
}

/** Called from server.ts to wire Redis for cross-pod Pub/Sub delivery. */
export function setRedisPubSub(redis: any): void {
  _redisPubSub = redis;
  // Create a dedicated subscriber connection for cross-pod delivery
  try {
    const handle = getRedisHandle();
    if (!handle) {
      // Fallback for standalone/test environments: use redis.duplicate() if available.
      if (typeof redis?.duplicate === 'function') {
        // eslint-disable-next-line no-restricted-syntax
        _redisSubscriber = redis.duplicate();
      } else {
        return;
      }
    } else {
      _redisSubscriber = createSubscriber(handle);
    }
    _redisSubscriber.on('message', (channel: string, message: string) => {
      // Channel format: ws:deliver:{sessionId}
      const sessionId = channel.replace('ws:deliver:', '');
      // Find the WS client for this session and deliver
      for (const [ws, state] of clients) {
        if (getBoundSessionId(state) === sessionId && (ws as any).readyState === 1) {
          try {
            const parsed = JSON.parse(message);
            const msgId = `cross-pod-${Date.now()}`;
            const response = parsed.data?.response || parsed.response || '';
            const richContent = parsed.data?.richContent || parsed.richContent || undefined;
            const actions = parsed.data?.actions || parsed.actions || undefined;
            const voiceConfig = parsed.data?.voiceConfig || parsed.voiceConfig || undefined;
            const localization = parsed.data?.localization || parsed.localization || undefined;
            const handoffProgress =
              parsed.data?.handoffProgress || parsed.handoffProgress || undefined;
            const rawResponseMetadata =
              parsed.data?.responseMetadata || parsed.responseMetadata || undefined;
            const responseMetadata =
              rawResponseMetadata || state.runtimeSession?.agentName
                ? withAgentNameMetadata(rawResponseMetadata ?? {}, state.runtimeSession?.agentName)
                : undefined;
            const citations = parsed.data?.citations || parsed.citations || undefined;
            const executionId =
              typeof parsed.data?.executionId === 'string'
                ? parsed.data.executionId
                : typeof parsed.executionId === 'string'
                  ? parsed.executionId
                  : `exec-${crypto.randomUUID()}`;
            if (handoffProgress) {
              send(ws, ServerMessages.handoffProgress(sessionId, handoffProgress));
            }
            send(ws, ServerMessages.responseStart(sessionId, msgId, executionId));
            send(
              ws,
              ServerMessages.responseChunk(sessionId, msgId, response, richContent, actions),
            );
            send(
              ws,
              ServerMessages.responseEnd(
                sessionId,
                msgId,
                response,
                voiceConfig,
                richContent,
                actions,
                executionId,
                responseMetadata,
                localization,
                citations,
              ),
            );
          } catch {
            // Fail-open: don't crash the subscriber on malformed messages
          }
          break;
        }
      }
    });
  } catch {
    // Redis subscriber creation is best-effort
  }
}

/** Register a WS connection with the shared registry + subscribe to cross-pod channel. */
function registerSession(connectionId: string, sessionId: string, ws: WebSocket): void {
  if (_wsRegistry) {
    _wsRegistry.register(connectionId, sessionId, ws);
  }
  if (_redisSubscriber) {
    _redisSubscriber.subscribe(`ws:deliver:${sessionId}`).catch(() => {
      // Best-effort subscription
    });
  }
}

/** Unregister a WS connection from the shared registry + unsubscribe from cross-pod channel. */
function unregisterSession(connectionId: string, sessionId?: string): void {
  if (_wsRegistry) {
    _wsRegistry.unregister(connectionId);
  }
  if (_redisSubscriber && sessionId) {
    _redisSubscriber.unsubscribe(`ws:deliver:${sessionId}`).catch(() => {
      // Best-effort unsubscription
    });
  }
}

/** In-flight DB session creation per client (prevents duplicates from concurrent calls) */
const _debugDbCreating = new WeakMap<ClientState, Promise<string | undefined>>();

/**
 * Lazily create a DB session for debug WS once the session has durable activity
 * (user traffic, ON_START output, or resumed history).
 * Prevents ghost sessions from transient WS connections while keeping resumed
 * sessions visible across pods.
 */
async function ensureDebugDbSession(state: ClientState): Promise<string | undefined> {
  if (state.dbSessionId) return state.dbSessionId;
  if (!state.pendingDbSession || !isDatabaseAvailable()) return undefined;

  const inflight = _debugDbCreating.get(state);
  if (inflight) return inflight;

  const promise = (async () => {
    if (state.dbSessionId) return state.dbSessionId;
    const pending = state.pendingDbSession;
    if (!pending) return undefined;
    if (!pending.projectId) {
      wsLog.error(
        '[WS] Cannot create debug DB session without projectId — omitting it will prevent agent compilation',
        {
          sessionId: pending.sessionId,
          tenantId: pending.tenantId,
          agentName: pending.agentName,
        },
      );
      state.pendingDbSession = undefined;
      return undefined;
    }
    try {
      const convStore = getConversationStore();
      const dbSession = await convStore.createSession({
        id: pending.sessionId, // canonical session ID is also the DB _id
        channel: 'web_debug',
        agentName: pending.agentName,
        agentVersion: pending.agentVersion,
        environment: 'dev',
        projectId: pending.projectId,
        tenantId: pending.tenantId,
        initiatedById: state.userId,
        entryAgentName: pending.entryAgentName,
        ...(pending.deploymentId && { deploymentId: pending.deploymentId }),
      });
      state.dbSessionId = dbSession.id;
      state.pendingDbSession = undefined;
      state.projectId = pending.projectId;

      wsLog.info(
        `[WS] Created DB session: ${dbSession.id} (session: ${pending.sessionId}, tenant: ${pending.tenantId}, project: ${pending.projectId})`,
      );

      // session.created event is now emitted centrally from MongoConversationStore.createSession()

      return dbSession.id;
    } catch (err) {
      wsLog.error('Failed to create DB session', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    } finally {
      _debugDbCreating.delete(state);
    }
  })();

  _debugDbCreating.set(state, promise);
  return promise;
}

// =============================================================================
// TRACE ACCUMULATION HELPERS
// =============================================================================

interface TraceAccumulator {
  tokensIn: number;
  tokensOut: number;
  cost: number;
  traceCount: number;
  errorCount: number;
  handoffCount: number;
  lastModelId: string;
  lastProvider: string;
  responseProvenance: ReturnType<typeof createResponseProvenanceAccumulator>;
}

function createTraceAccumulator(): TraceAccumulator {
  return {
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    traceCount: 0,
    errorCount: 0,
    handoffCount: 0,
    lastModelId: '',
    lastProvider: '',
    responseProvenance: createResponseProvenanceAccumulator(),
  };
}

function createOnTraceEvent(
  sessionId: string,
  ws: WebSocket,
  acc: TraceAccumulator,
  agentName?: string,
  traceEmitter?: TraceEmitter,
  tenantId?: string,
  executionId?: string,
): (event: { type: string; data: Record<string, unknown> }) => void {
  return (event) => {
    // Accumulate token counts from LLM call events
    if (event.type === 'llm_call' && event.data) {
      const metrics = extractLlmTraceMetrics(event.data);
      acc.tokensIn += metrics.tokensIn;
      acc.tokensOut += metrics.tokensOut;
      acc.cost += metrics.cost;
      if (metrics.model) acc.lastModelId = metrics.model;
      if (metrics.provider) acc.lastProvider = metrics.provider;
      accumulateResponseProvenance(acc.responseProvenance, event);
    }
    // Count trace/error/handoff events for DB persistence
    acc.traceCount++;
    if (event.type === 'error') acc.errorCount++;
    if (event.type === 'handoff') acc.handoffCount++;
    // Send trace event to client with extended fields
    const traceEvent: TraceEventWithId = {
      id: crypto.randomUUID(),
      sessionId,
      type: event.type as import('../types/index.js').TraceEventType,
      timestamp: new Date(),
      data: event.data,
      agentName: (event.data?.agentName as string) || agentName,
      spanId: traceEmitter?.getCurrentSpanId(),
    };
    send(ws, ServerMessages.traceEvent(sessionId, traceEvent));

    const isInternalCoordinationEvent =
      event.data?.visibility === 'internal' || event.data?.suppressChildOutput === true;

    // Emit dedicated agent_switch WS message so the UI can show which agent is active
    if (event.type === 'agent_switch' && event.data?.agentName && !isInternalCoordinationEvent) {
      send(
        ws,
        ServerMessages.agentSwitch(
          sessionId,
          event.data.agentName as string,
          (event.data.mode as string) || 'reasoning',
          event.data.previousAgent as string | undefined,
          event.data.agentDisplayName as string | undefined,
        ),
      );
    }

    // Emit dedicated handoff_progress WS message for richer Studio UI consumption
    if (event.type === 'handoff_progress' && event.data?.phase) {
      send(
        ws,
        ServerMessages.handoffProgress(sessionId, {
          phase: event.data.phase as import('../types/index.js').HandoffProgressPhase,
          targetAgent: event.data.targetAgent as string,
          taskId: event.data.taskId as string | undefined,
          async: event.data.async as boolean | undefined,
          error: event.data.error as string | undefined,
          durationMs: event.data.durationMs as number | undefined,
        }),
      );
    }

    // Emit dedicated status_update / status_clear WS messages for filler rendering.
    // These are transient — not persisted to trace store or conversation history.
    if (event.type === 'status_update' && event.data?.text) {
      send(
        ws,
        ServerMessages.statusUpdate(
          sessionId,
          event.data.text as string,
          (event.data.operation as string) || 'general',
          (event.data.index as number) || 0,
          executionId,
        ),
      );
    }
    if (event.type === 'status_clear') {
      send(ws, ServerMessages.statusClear(sessionId));
    }

    // NOTE: TraceStore and ClickHouse persistence are now centralized in
    // RuntimeExecutor.createCentralizedTraceHandler() — no per-handler storage needed.

    // Business events (handoff, escalation, tool.*) are now emitted centrally
    // from RuntimeExecutor.createCentralizedTraceHandler() — no per-handler emission needed.
  };
}

// =============================================================================
// CONNECTION MANAGEMENT
// =============================================================================

/**
 * Resolve tenant context for a WebSocket connection.
 *
 * Mirrors the REST unified auth middleware: JWT → userId → tenant membership
 * → role → permissions → TenantContextData. This ensures WS connections get
 * the same centralized tenant isolation as REST endpoints.
 */
/**
 * Resolve tenant context for a WebSocket connection.
 * Delegates to the centralized resolveTenantContext() from shared-auth,
 * injecting runtime-specific DB dependencies.
 */
async function resolveWSTenantContext(
  userId: string,
  tenantIdHint?: string,
): Promise<TenantContextData | undefined> {
  if (!isDatabaseAvailable()) return undefined;

  try {
    const config = getConfig();
    const superAdmins = config.security?.superAdminUserIds ?? [];

    return await resolveTenantContext(
      { userId, tenantIdHint, authType: 'user' },
      {
        resolveTenantMembership,
        resolveDefaultTenant,
        resolveEffectivePermissions,
        superAdminUserIds: superAdmins,
      },
    );
  } catch (err) {
    wsLog.warn('Failed to resolve tenant context', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Handle new WebSocket connection
 * Auth: Sec-WebSocket-Protocol: web-debug-auth,<access_token>
 */
export function handleConnection(ws: WebSocket, req?: IncomingMessage): void {
  const token = req ? extractWebDebugTokenFromProtocolHeader(req.headers) : null;
  if (!token) {
    reportWsConnectionAccessDenied(req, {
      layer: 'require_auth',
      scope: 'auth',
      reasonCode: 'AUTHENTICATION_REQUIRED',
      reason: 'Authentication required',
      statusCode: 401,
      metadata: {
        remoteAddress: req?.socket?.remoteAddress,
      },
    });
    wsLog.warn('Rejecting internal WebSocket connection without auth token at handler entry', {
      remoteAddress: req?.socket?.remoteAddress,
    });
    ws.close(4001, 'Authentication required');
    return;
  }

  const claims = extractVerifiedUserTokenClaims(token);
  if (!claims) {
    reportWsConnectionAccessDenied(req, {
      layer: 'require_auth',
      scope: 'auth',
      reasonCode: 'INVALID_AUTHENTICATION_TOKEN',
      reason: 'Invalid authentication token',
      statusCode: 401,
      metadata: {
        remoteAddress: req?.socket?.remoteAddress,
      },
    });
    wsLog.warn('Rejecting internal WebSocket connection with invalid auth token', {
      remoteAddress: req?.socket?.remoteAddress,
    });
    ws.close(4001, 'Invalid authentication token');
    return;
  }

  wsLog.info('[WS] Client connected');
  wsLog.info(`[WS] Authenticated user: ${claims.userId}`);

  const userId = claims.userId;
  const authToken = token;
  const tenantIdHint = claims.tenantId;
  const state: ClientState = { ws, userId, authToken, lastActivity: Date.now() };
  if (!clients.add(ws, state)) {
    wsLog.warn('Rejecting internal WebSocket connection: server at capacity', {
      userId,
      current: clients.size,
    });
    ws.close(1013, 'Server at capacity — try again later');
    return;
  }
  incrementActiveSessions();
  const bufferedMessages: string[] = [];
  let bufferedMessageBytes = 0;
  let authReady = false;

  ws.on('message', (data) => {
    clients.touch(ws);
    const payload = data.toString();
    if (!authReady) {
      const nextPayloadBytes = Buffer.byteLength(payload, 'utf8');
      if (
        bufferedMessages.length >= MAX_PREAUTH_BUFFERED_MESSAGES ||
        bufferedMessageBytes + nextPayloadBytes > MAX_PREAUTH_BUFFERED_BYTES
      ) {
        wsLog.warn('Rejecting internal WebSocket connection with excessive pre-auth buffering', {
          userId,
          bufferedMessages: bufferedMessages.length,
          bufferedMessageBytes,
          nextPayloadBytes,
        });
        ws.close(1008, 'Too many queued messages before authentication');
        return;
      }

      bufferedMessages.push(payload);
      bufferedMessageBytes += nextPayloadBytes;
      return;
    }

    runWithClientTenantContext(ws, () => {
      handleMessage(ws, payload);
    });
  });

  // Set up close handler — use shared lifecycle policy with legacy defaults.
  ws.on('close', () => {
    runWithClientTenantContext(ws, () => {
      void (async () => {
        wsLog.info('[WS] Client disconnected');
        decrementActiveSessions();
        const state = clients.get(ws);
        const runtimeId = getBoundSessionId(state);
        const executor = getRuntimeExecutor();
        const runtimeSession =
          (runtimeId ? executor.getSession(runtimeId) : undefined) ?? state?.runtimeSession;

        try {
          // Unregister from shared WS registry + Redis Pub/Sub
          const connId = state?._wsConnectionId;
          if (connId) {
            unregisterSession(connId, runtimeId);
          }
          if (runtimeId) {
            unregisterSessionWebSocket(runtimeId);
          }
          if (state?._wsContactId) {
            unregisterSessionWebSocket(state._wsContactId);
          }

          const { disposition, disconnectBehavior } = await resolveWebDebugDisconnectLifecycle(
            state,
            runtimeSession,
          );

          // Clean up paused JIT auth executions only when the session is ending.
          if (runtimeId && disconnectBehavior === 'end') {
            getPausedExecutionStore()
              .cleanupSession(runtimeId, 'disconnect')
              .catch((err) => {
                wsLog.warn('Failed to cleanup paused executions on disconnect', {
                  error: err instanceof Error ? err.message : String(err),
                  sessionId: runtimeId,
                });
              });
          }

          // Clean up auth gate state when session is ending
          if (runtimeId && disconnectBehavior === 'end') {
            void cleanupAuthGateAsync(runtimeId).catch((err) => {
              wsLog.warn('Failed to cleanup auth gate on disconnect', {
                error: err instanceof Error ? err.message : String(err),
                sessionId: runtimeId,
              });
            });
          }

          // Helper: flush DB messages and end the DB session only when disconnect policy requires it.
          const flushAndMaybeEndSession = async (st: typeof state): Promise<void> => {
            if (!st?.dbSessionId) return;
            const dbSid = st.dbSessionId;
            const tid = st.tenantId;

            try {
              await flushMessageQueue(dbSid);
            } catch (err) {
              wsLog.error('Failed to flush debug DB session on disconnect', {
                error: err instanceof Error ? err.message : String(err),
                dbSessionId: dbSid,
                disconnectBehavior,
              });
              return;
            }

            if (disconnectBehavior !== 'end') {
              wsLog.info('[WS] Preserving debug DB session after resumable disconnect', {
                sessionId: runtimeId ?? st.sessionId,
                dbSessionId: dbSid,
                projectId: st.projectId,
              });
              // Mark analytics session as idle so resumable disconnects do not look active
              // while still preserving non-terminal resume semantics.
              const tenantId = st.tenantId ?? runtimeSession?.tenantId;
              if (isDatabaseAvailable() && dbSid && tenantId) {
                updateSession(dbSid, { status: 'idle', endedAt: null }, tenantId).catch(
                  (err: unknown) => {
                    wsLog.warn('[WS] Failed to mark session as idle on resumable disconnect', {
                      dbSessionId: dbSid,
                      error: err instanceof Error ? err.message : String(err),
                    });
                  },
                );
              }
              return;
            }

            try {
              if (isDatabaseAvailable()) {
                await getConversationStore().endSession(
                  dbSid,
                  disposition as import('@abl/compiler/platform/core/types').CallDisposition,
                );
              }

              // session.ended event is now emitted centrally from MongoConversationStore.endSession()
            } catch (err) {
              wsLog.error('Failed to end DB session', {
                error: err instanceof Error ? err.message : String(err),
                dbSessionId: dbSid,
              });
            }
          };

          const terminalizeDisconnectSession = async (st: typeof state): Promise<boolean> => {
            if (
              !isSessionTerminalizationEnabled() ||
              disconnectBehavior !== 'end' ||
              !st?.tenantId ||
              !st?.projectId ||
              (!st.dbSessionId && !runtimeId)
            ) {
              return false;
            }

            if (runtimeId && runtimeSession) {
              try {
                await executor.saveSessionSnapshot(runtimeSession);
              } catch (err) {
                wsLog.warn('Failed to save session snapshot before disconnect terminalization', {
                  sessionId: runtimeId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }

            if (st.dbSessionId) {
              try {
                await flushMessageQueue(st.dbSessionId);
              } catch (err) {
                wsLog.warn('Failed to flush message queue before disconnect terminalization', {
                  dbSessionId: st.dbSessionId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }

            const result = await terminalizationService.terminateConversationSession({
              tenantId: st.tenantId,
              projectId: st.projectId,
              sessionId: st.dbSessionId ?? runtimeId!,
              agentName: runtimeSession?.agentName ?? st.runtimeSession?.agentName,
              channel: 'web_debug',
              disposition:
                disposition as import('@abl/compiler/platform/core/types').CallDisposition,
              source: 'disconnect',
            });

            if (!result) {
              return false;
            }

            await cleanupClosedSessionArtifacts(result.artifactSessionIds);

            return true;
          };

          const terminalized = await terminalizeDisconnectSession(state);

          if (!terminalized) {
            if (runtimeId) {
              if (runtimeSession) {
                try {
                  await executor.saveSessionSnapshot(runtimeSession);
                } catch (err) {
                  wsLog.warn('Failed to save session snapshot before disconnect cleanup', {
                    sessionId: runtimeId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }

              if (disconnectBehavior === 'end') {
                executor.endSession(runtimeId);
              } else {
                executor.detachSession(runtimeId);
              }
            }

            await flushAndMaybeEndSession(state);
          }
        } catch (err) {
          wsLog.warn('Web debug disconnect cleanup hit an unexpected error', {
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          // Unsubscribe from all trace sessions
          getTraceStore().unsubscribeAll(ws);
          clients.remove(ws);
        }
      })();
    });
  });

  // Set up error handler
  ws.on('error', (error) => {
    wsLog.error('Client error', { error: error instanceof Error ? error.message : String(error) });
    void (async () => {
      const state = clients.get(ws);
      const runtimeId = getBoundSessionId(state);
      const runtimeSession =
        (runtimeId ? getRuntimeExecutor().getSession(runtimeId) : undefined) ??
        state?.runtimeSession;

      try {
        const { disconnectBehavior } = await resolveWebDebugDisconnectLifecycle(
          state,
          runtimeSession,
        );
        if (runtimeId && disconnectBehavior === 'end') {
          void cleanupAuthGateAsync(runtimeId).catch((err) => {
            wsLog.warn('Failed to cleanup auth gate after socket error', {
              error: err instanceof Error ? err.message : String(err),
              sessionId: runtimeId,
            });
          });
        }
      } catch (err) {
        wsLog.warn('Web debug socket error lifecycle resolution failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clients.remove(ws);
      }
    })();
  });

  if (!isDatabaseAvailable()) {
    wsLog.error('Rejecting internal WebSocket connection while database is unavailable', {
      userId,
    });
    ws.close(1011, 'Database unavailable');
    return;
  }

  void resolveWSTenantContext(userId, tenantIdHint)
    .then((ctx) => {
      if (!ctx) {
        reportWsConnectionAccessDenied(req, {
          layer: 'require_tenant_context',
          scope: 'tenant',
          reasonCode: 'TENANT_MEMBERSHIP_REQUIRED',
          reason: 'Tenant membership required',
          statusCode: 403,
          authType: 'user',
          tenantId: tenantIdHint,
          userId,
          metadata: {
            tenantIdHint,
          },
        });
        wsLog.warn('Rejecting internal WebSocket connection without tenant membership', {
          userId,
          tenantIdHint,
        });
        ws.close(4003, 'Tenant membership required');
        return;
      }

      state.tenantContext = ctx;
      state.tenantId = ctx.tenantId;
      authReady = true;
      wsLog.info(`[WS] Tenant context resolved: tenant=${ctx.tenantId} role=${ctx.role}`);
      send(ws, ServerMessages.info('Connected to Test Server (Real Runtime Mode)', true));
      for (const payload of bufferedMessages.splice(0)) {
        runWithClientTenantContext(ws, () => {
          handleMessage(ws, payload);
        });
      }
      bufferedMessageBytes = 0;
    })
    .catch((err: unknown) => {
      wsLog.warn('Tenant context resolution failed', {
        error: err instanceof Error ? err.message : String(err),
        userId,
      });
      ws.close(1011, 'Tenant context resolution failed');
    });
}

// =============================================================================
// MESSAGE HANDLING
// =============================================================================

/**
 * Handle incoming WebSocket message
 */
function handleMessage(ws: WebSocket, data: string): void {
  const state = clients.get(ws);

  // Require authentication for all operations
  if (!state?.userId || !state.tenantContext?.tenantId) {
    createWsAccessDeniedReporter({
      messageType: 'pre_auth_message',
      tenantContext: state?.tenantContext,
      projectId: state?.projectId ?? state?.tenantContext?.projectId,
    })({
      layer: 'require_auth',
      scope: 'auth',
      reasonCode: 'AUTHENTICATION_REQUIRED',
      reason: 'Authentication required',
      concealAsNotFound: false,
      statusCode: 401,
      metadata: {
        payloadBytes: Buffer.byteLength(data, 'utf8'),
      },
    });
    send(ws, ServerMessages.error('Authentication required. Please sign in first.'));
    return;
  }

  const message = parseClientMessage(data);

  if (!message) {
    send(ws, ServerMessages.error('Invalid message format'));
    return;
  }

  wsLog.info('Received message', { type: message.type, userId: state.userId });

  switch (message.type) {
    case 'load_agent':
      handleLoadAgent(ws, message).catch((err) => {
        wsLog.error('handleLoadAgent error', {
          error: err instanceof Error ? err.message : String(err),
        });
        send(ws, ServerMessages.error('Failed to load agent'));
      });
      break;

    case 'send_message':
      handleSendMessage(ws, message);
      break;

    case 'ensure_session_persisted':
      handleEnsureSessionPersisted(ws, message).catch((err) => {
        wsLog.error('handleEnsureSessionPersisted error', {
          error: err instanceof Error ? err.message : String(err),
        });
        send(
          ws,
          ServerMessages.sessionPersistFailed(message.sessionId, message.requestId, {
            code: 'SESSION_PERSIST_FAILED',
            message: 'Failed to persist session',
          }),
        );
      });
      break;

    case 'run_test':
      handleRunTest(ws, message);
      break;

    case 'get_state':
      handleGetState(ws, message);
      break;

    case 'subscribe_session':
      handleSubscribeSession(ws, message);
      break;

    case 'unsubscribe_session':
      handleUnsubscribeSession(ws, message);
      break;

    case 'resume_session':
      handleResumeSession(ws, message).catch((err) => {
        wsLog.error('handleResumeSession error', {
          error: err instanceof Error ? err.message : String(err),
        });
        send(ws, ServerMessages.error('Failed to resume session'));
      });
      break;

    case 'list_sessions':
      handleListSessions(ws);
      break;

    // Test context handlers (debug sessions only)
    case 'load_agent_with_context':
      handleLoadAgentWithContext(ws, message).catch((err) => {
        wsLog.error('handleLoadAgentWithContext error', {
          error: err instanceof Error ? err.message : String(err),
        });
        send(ws, ServerMessages.error('Failed to load agent with context'));
      });
      break;

    case 'inject_context':
      handleInjectContext(ws, message);
      break;

    case 'set_tool_mocks':
      handleSetToolMocks(ws, message);
      break;

    case 'clear_tool_mocks':
      handleClearToolMocks(ws, message);
      break;

    case 'cancel_execution':
      handleCancelExecution(ws, message).catch((err) => {
        wsLog.error('handleCancelExecution error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      break;

    case 'fork_session':
      handleForkSession(ws, message).catch((err) => {
        wsLog.error('handleForkSession error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      break;

    case 'auth_response':
      handleAuthResponse(ws, message).catch((err) => {
        wsLog.error('handleAuthResponse error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      break;

    case 'consent_satisfy':
      handleConsentSatisfy(ws, message);
      break;

    case 'action_submit':
      handleActionSubmit(ws, message).catch((err) => {
        wsLog.error('handleActionSubmit error', {
          error: err instanceof Error ? err.message : String(err),
        });
        send(ws, ServerMessages.error('Failed to process action'));
      });
      break;
  }
}

// =============================================================================
// MESSAGE HANDLERS
// =============================================================================

async function handleEnsureSessionPersisted(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'ensure_session_persisted' }>,
): Promise<void> {
  const { sessionId, requestId } = message;
  const state = clients.get(ws);

  if (!state || !ensureWsSessionBinding(ws, sessionId, 'ensure_session_persisted')) {
    send(
      ws,
      ServerMessages.sessionPersistFailed(sessionId, requestId, {
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found',
      }),
    );
    return;
  }

  const runtimeSession =
    state.runtimeSession?.id === sessionId
      ? state.runtimeSession
      : getRuntimeExecutor().getSession(sessionId);

  if (
    !runtimeSession ||
    !ensureWsSessionAccess(ws, sessionId, runtimeSession, 'ensure_session_persisted')
  ) {
    send(
      ws,
      ServerMessages.sessionPersistFailed(sessionId, requestId, {
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found',
      }),
    );
    return;
  }

  if (!state.dbSessionId) {
    await ensureDebugDbSession(state);
  }

  if (!state.dbSessionId) {
    send(
      ws,
      ServerMessages.sessionPersistFailed(sessionId, requestId, {
        code: 'SESSION_PERSIST_FAILED',
        message: 'Failed to persist session',
      }),
    );
    return;
  }

  send(ws, ServerMessages.sessionPersisted(sessionId, requestId, true));
}

/**
 * Handle agent loading request.
 *
 * Resolution path:
 *   1. Database (ProjectAgent with dslContent) scoped to the requested project
 */
async function handleLoadAgent(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'load_agent' }>,
): Promise<void> {
  const loadRequestId = claimLoadRequest(ws);
  if (loadRequestId === null) {
    return;
  }

  await handleLoadAgentRequest(ws, message, loadRequestId);
}

async function handleLoadAgentRequest(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'load_agent' }>,
  loadRequestId: number,
): Promise<void> {
  const { agentPath, projectId, deploymentId, environment } = message;

  // Clean up previous session if user reloads agent in the same connection
  const prevState = clients.get(ws);
  if (getBoundSessionId(prevState)) {
    const prevRuntimeId = getBoundSessionId(prevState);
    if (prevRuntimeId) {
      if (prevState?._wsConnectionId) {
        unregisterSession(prevState._wsConnectionId, prevRuntimeId);
      }
      unregisterSessionWebSocket(prevRuntimeId);
      if (prevState?._wsContactId) {
        unregisterSessionWebSocket(prevState._wsContactId);
        prevState._wsContactId = undefined;
      }
      // Preserve cold state so the session remains resumable from the sidebar.
      // The user started a new chat — they haven't deleted the old session.
      getRuntimeExecutor().endSession(prevRuntimeId, { preserveColdState: true });
    }
    // End previous DB session
    if (prevState?.dbSessionId && isDatabaseAvailable()) {
      getConversationStore()
        .endSession(prevState.dbSessionId, 'completed')
        .catch((err: unknown) =>
          wsLog.warn('[WS] Failed to end previous DB session', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      prevState.dbSessionId = undefined;
    }
    if (prevState) {
      prevState._wsConnectionId = undefined;
    }
  }

  // Create a runtime session (single session authority)
  const executor = getRuntimeExecutor();
  let runtimeSession: RuntimeSession | undefined;
  const currentClientState = clients.get(ws);
  const callerData = message.callerData;

  // Resolve tenantId: prefer the centralized tenant context (resolved at connection time),
  // then fall back to project lookup. Cross-tenant access is blocked by verifying the
  // project's tenant matches the user's authenticated tenant context.
  let resolvedTenantId: string | undefined = currentClientState?.tenantContext?.tenantId;
  if (isDatabaseAvailable()) {
    try {
      if (resolvedTenantId) {
        const project = await findProjectByIdAndTenant(projectId, resolvedTenantId);
        if (!isCurrentLoadRequest(ws, loadRequestId)) {
          return;
        }
        if (!project) {
          // Project not found for this tenant — block cross-tenant access
          wsLog.warn(
            `Cross-tenant access blocked: user tenant=${resolvedTenantId}, project=${projectId}`,
          );
          send(
            ws,
            ServerMessages.agentLoadError(
              'Access denied: project belongs to a different workspace',
            ),
          );
          return;
        }
      }
    } catch (err) {
      wsLog.warn('Project lookup failed, using connection-level tenantId', {
        error: err instanceof Error ? err.message : String(err),
        projectId,
      });
    }
  }

  // 1. Try database first (ProjectAgent by agentPath or name, tenant + project scoped)
  const dbResult = await loadAgentFromDatabase(agentPath, projectId, resolvedTenantId);
  if (!isCurrentLoadRequest(ws, loadRequestId)) {
    return;
  }

  const agent: AgentDetails | null = dbResult?.agent ?? null;
  const dbAgentId = dbResult?.dbAgentId;
  const workingCopySource = dbResult?.workingCopySource;

  if (!agent) {
    send(ws, ServerMessages.agentLoadError(`Agent not found in project: ${agentPath}`));
    return;
  }

  // Pre-generate a session ID so the quota SET key and the actual session share the same ID
  const preGeneratedSessionId = crypto.randomUUID();

  // Pre-flight quota check: verify tenant has session capacity before creating
  let sessionSlotClaimed = false;
  if (resolvedTenantId) {
    try {
      await executor.checkSessionQuota(resolvedTenantId, projectId, preGeneratedSessionId);
      sessionSlotClaimed = true;
    } catch (err) {
      wsLog.warn('Session quota check failed, proceeding anyway', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!isCurrentLoadRequest(ws, loadRequestId)) {
    if (sessionSlotClaimed && resolvedTenantId) {
      await executor.releaseSessionSlot(resolvedTenantId, preGeneratedSessionId);
    }
    return;
  }

  try {
    // =====================================================================
    // DEPLOYMENT-AWARE PATH: Use DeploymentResolver for specific versions
    // =====================================================================
    if ((deploymentId || environment) && projectId && isDatabaseAvailable()) {
      try {
        let deploymentConfigVarMap: Record<string, string> | undefined;
        if (resolvedTenantId) {
          try {
            const loaded = await loadConfigVariablesMap(projectId, resolvedTenantId);
            if (Object.keys(loaded).length > 0) {
              deploymentConfigVarMap = loaded;
            }
          } catch (err) {
            wsLog.warn('[WS] Failed to load config variables for deployment-resolved session', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        const resolver = new DeploymentResolver(getSessionService());
        const resolved = await resolver.resolve({
          projectId,
          tenantId: resolvedTenantId || 'debug',
          agentName: agent.name,
          deploymentId,
          environment,
          allowWorkingCopy: !deploymentId && !environment,
        });
        const debugCallerCtx = buildCallerContext({
          tenantId: resolvedTenantId || 'debug',
          channel: 'web_debug',
          initiatedById: currentClientState?.userId,
          identityTier: 0,
          verificationMethod: 'none',
          // Forward known CallerContext keys from callerData (e.g., customerId)
          ...(callerData?.customerId ? { customerId: String(callerData.customerId) } : {}),
        });
        const debugSessionTimeouts = await resolveSessionTimeouts(
          resolvedTenantId,
          projectId,
          getResolvedAgentLifecycle(resolved),
        );
        runtimeSession = executor.createSessionFromResolved(resolved, {
          sessionId: preGeneratedSessionId,
          projectId,
          tenantId: resolvedTenantId,
          channelType: 'debug_websocket',
          authToken: currentClientState?.authToken,
          userId: currentClientState?.userId,
          deploymentId,
          callerContext: debugCallerCtx,
          callerData,
          ...createJitAuthCallbacks(ws, {
            tenantId: resolvedTenantId,
            userId: currentClientState?.userId,
          }),
          ...debugSessionTimeouts,
        });
        storeRuntimeSessionLocalizationCatalog(
          runtimeSession,
          buildSessionLocalizationCatalog(deploymentConfigVarMap),
        );
        sessionSlotClaimed = false; // slot now owned by the session

        wsLog.info(
          `[WS] Created deployment-resolved session: ${runtimeSession.id} (deployment=${deploymentId}, env=${environment})`,
        );
      } catch (err) {
        const statusCode = (err as any).statusCode;
        if (statusCode === 410) {
          if (sessionSlotClaimed && resolvedTenantId) {
            await executor.releaseSessionSlot(resolvedTenantId, preGeneratedSessionId);
            sessionSlotClaimed = false;
          }
          send(ws, ServerMessages.error('Deployment is retired', 410));
          return;
        }
        wsLog.warn('[WS] DeploymentResolver failed, falling back to DSL compile', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Fall through to legacy path
      }
    }

    // =====================================================================
    // LEGACY PATH: Compile from DSL
    // =====================================================================
    if (!runtimeSession) {
      let configVarMap: Record<string, string> | undefined;

      if (agent.isSupervisor) {
        // Load all child agents from the same project
        // Strictly scope sibling resolution to the current project.
        const siblingAgentSources =
          projectId && dbAgentId
            ? await loadSiblingAgentSources(projectId, dbAgentId, currentClientState?.tenantId)
            : [];

        // Check if there are module dependencies (so supervisors with only
        // module children are not rejected as "no child agents").
        let hasModuleDeps = false;
        if (projectId && currentClientState?.tenantId) {
          try {
            const { ProjectModuleDependency } = await import('@agent-platform/database/models');
            hasModuleDeps =
              (await ProjectModuleDependency.countDocuments({
                projectId,
                tenantId: currentClientState.tenantId,
              })) > 0;
          } catch (err) {
            wsLog.warn('[WS] Failed to count module dependencies for supervisor session', {
              projectId,
              tenantId: currentClientState.tenantId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (siblingAgentSources.length > 0 || hasModuleDeps) {
          const allAgentSources = [
            workingCopySource ?? {
              name: agent.name,
              dslContent: agent.dsl,
            },
            ...siblingAgentSources,
          ];
          wsLog.info(
            `[WS] Creating multi-agent session: ${agent.name} + ${siblingAgentSources.length} children (DB, project=${projectId})`,
          );

          const supervisorCallerCtx = buildCallerContext({
            tenantId: resolvedTenantId || 'debug',
            channel: 'web_debug',
            initiatedById: currentClientState?.userId,
            identityTier: 0,
            verificationMethod: 'none',
            ...(callerData?.customerId ? { customerId: String(callerData.customerId) } : {}),
          });
          const compileResult = await compileWebDebugWorkingCopy({
            tenantId: resolvedTenantId,
            projectId,
            entryAgentName: agent.name,
            environment: environment || 'dev',
            agents: allAgentSources,
          });
          configVarMap = compileResult.configVariables;

          // Merge module agents from pre-compiled release IR (not DSL)
          // so they bypass tool resolution and readiness checks.
          if (projectId && resolvedTenantId) {
            await mergeWorkingCopyModules(compileResult.resolved, resolvedTenantId, projectId);
          }

          const supervisorSessionTimeouts = await resolveSessionTimeouts(
            resolvedTenantId,
            projectId,
            getResolvedAgentLifecycle(compileResult.resolved),
          );
          runtimeSession = executor.createSessionFromResolved(compileResult.resolved, {
            sessionId: preGeneratedSessionId,
            authToken: currentClientState?.authToken,
            userId: currentClientState?.userId,
            tenantId: resolvedTenantId,
            projectId,
            callerContext: supervisorCallerCtx,
            callerData,
            ...createJitAuthCallbacks(ws, {
              tenantId: resolvedTenantId,
              userId: currentClientState?.userId,
            }),
            ...supervisorSessionTimeouts,
          });
          storeRuntimeSessionLocalizationCatalog(
            runtimeSession,
            buildSessionLocalizationCatalog(configVarMap),
          );
          sessionSlotClaimed = false; // slot now owned by the session
        } else {
          // No child agents found in database — supervisor project is misconfigured
          wsLog.warn(
            `[WS] Supervisor "${agent.name}" has no child agents in database project ${projectId}`,
          );
          if (sessionSlotClaimed && resolvedTenantId) {
            await executor.releaseSessionSlot(resolvedTenantId, preGeneratedSessionId);
            sessionSlotClaimed = false;
          }
          send(
            ws,
            ServerMessages.agentLoadError(
              `Supervisor "${agent.name}" has no child agents in database project ${projectId}. Seed child agents first.`,
            ),
          );
          return;
        }
      } else {
        const singleCallerCtx = buildCallerContext({
          tenantId: resolvedTenantId || 'debug',
          channel: 'web_debug',
          initiatedById: currentClientState?.userId,
          identityTier: 0,
          verificationMethod: 'none',
          ...(callerData?.customerId ? { customerId: String(callerData.customerId) } : {}),
        });
        const compileResult = await compileWebDebugWorkingCopy({
          tenantId: resolvedTenantId,
          projectId,
          entryAgentName: agent.name,
          environment: environment || 'dev',
          agents: [
            workingCopySource ?? {
              name: agent.name,
              dslContent: agent.dsl,
            },
          ],
        });

        // Merge module dependencies for non-supervisor single-agent debug path
        if (projectId && resolvedTenantId) {
          await mergeWorkingCopyModules(compileResult.resolved, resolvedTenantId, projectId);
        }

        configVarMap = compileResult.configVariables;
        const singleSessionTimeouts = await resolveSessionTimeouts(
          resolvedTenantId,
          projectId,
          getResolvedAgentLifecycle(compileResult.resolved),
        );
        runtimeSession = executor.createSessionFromResolved(compileResult.resolved, {
          sessionId: preGeneratedSessionId,
          authToken: currentClientState?.authToken,
          userId: currentClientState?.userId,
          tenantId: resolvedTenantId,
          projectId,
          callerContext: singleCallerCtx,
          callerData,
          ...createJitAuthCallbacks(ws, {
            tenantId: resolvedTenantId,
            userId: currentClientState?.userId,
          }),
          ...singleSessionTimeouts,
        });
        storeRuntimeSessionLocalizationCatalog(
          runtimeSession,
          buildSessionLocalizationCatalog(configVarMap),
        );
        sessionSlotClaimed = false; // slot now owned by the session
      }
    }
    wsLog.info(`[WS] Created runtime session: ${runtimeSession.id}`);
  } catch (error) {
    if (sessionSlotClaimed && resolvedTenantId) {
      await executor.releaseSessionSlot(resolvedTenantId, preGeneratedSessionId);
    }
    if (!isCurrentLoadRequest(ws, loadRequestId)) {
      return;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    wsLog.error('[WS] Failed to create runtime session', { error: errorMessage });
    // Send the actual error message so the UI can show a helpful diagnostic.
    // The sanitizeServerError helper on the client side will strip any
    // technical details before displaying to the user.
    send(ws, ServerMessages.agentLoadError(errorMessage || 'Failed to create runtime session'));
    return;
  }

  const sessionId = runtimeSession.id;

  if (!isCurrentLoadRequest(ws, loadRequestId)) {
    releaseStaleLoadedSession(ws, executor, sessionId);
    return;
  }

  // Register with shared WS registry for async resumption delivery
  const connectionId = `ws-${sessionId}-${Date.now()}`;
  registerSession(connectionId, sessionId, ws);

  // Register with agent-transfer message bridge so inbound agent
  // messages (webhooks) can be pushed to this WS client.
  // Also register the contactId alias: agent-transfer events carry a contactId
  // (not the MongoDB session ID) so both keys must resolve to the same socket.
  // The alias is namespaced as "tenantId:contactId" to prevent cross-tenant key
  // collisions — bare contactIds are only unique within a tenant.
  registerSessionWebSocket(sessionId, ws);
  // Fall back to sessionId when callerContext.contactId is absent (Studio debug sessions
  // never populate contactId in buildCallerContext, but sessionId === contactId for them).
  // This ensures the bridge's tenantId:contactId lookup always resolves to this socket.
  const rawContactId =
    typeof runtimeSession.callerContext?.contactId === 'string'
      ? runtimeSession.callerContext.contactId
      : sessionId;
  const wsContactId = runtimeSession.tenantId
    ? `${runtimeSession.tenantId}:${rawContactId}`
    : rawContactId;
  if (wsContactId) {
    registerSessionWebSocket(wsContactId, ws);
  }

  // Update client state
  const state = clients.get(ws);
  if (state) {
    state.sessionId = sessionId;
    state.runtimeSession = runtimeSession;
    state._wsContactId = wsContactId;
    const tenantCfg1 = await getTenantConfigService()
      .getConfigAsync(runtimeSession.tenantId ?? '')
      .catch(() => null);
    state._wsConnectionId = connectionId;
    state.traceEmitter = createTraceEmitter({
      sessionId,
      ws,
      tenantId: runtimeSession.tenantId,
      projectId,
      deploymentId: runtimeSession.versionInfo?.deploymentId,
      environment: runtimeSession.versionInfo?.environment,
      agentVersions: resolveAgentVersionsForTrace(runtimeSession),
      scrubPII: tenantCfg1?.security?.scrubPII ?? true,
      piiRecognizerRegistry: runtimeSession.piiRecognizerRegistry,
      customDimensions: runtimeSession.customDimensions,
      sessionRef: runtimeSession,
      moduleProvenanceMap: runtimeSession.moduleProvenance,
    });
    state.agentDetails = agent;
    state.projectId = projectId;
    state.tenantId = runtimeSession.tenantId;
    state.traceId = crypto.randomUUID().replace(/-/g, '');
  } else {
    wsLog.error('[WS] ERROR: Client state not found for WebSocket!');
  }

  // Defer DB session creation until the session produces real traffic so reconnect-only
  // transports do not create empty rows, but keep the full persistence contract ready.
  if (state) {
    const dbTenantId = runtimeSession.tenantId || resolvedTenantId;
    state.pendingDbSession = {
      agentName: agent.name,
      agentVersion: resolvePersistedAgentVersion(runtimeSession.versionInfo, agent.name),
      sessionId,
      entryAgentName: agent.name,
      deploymentId: runtimeSession.versionInfo?.deploymentId,
      projectId,
      tenantId: dbTenantId || 'debug',
    };
  }

  // Register session in TraceStore for subscription support
  getTraceStore().setSessionAgent(sessionId, agent.name);

  if (!isCurrentLoadRequest(ws, loadRequestId)) {
    releaseStaleLoadedSession(ws, executor, sessionId);
    return;
  }

  // Discovery runs in parallel — NOT blocking agent_loaded.
  // By the time the user types and sends their first message (~2-5s),
  // discovery is already done. The KB fast path awaits the promise
  // just-in-time if the user is faster than discovery.

  // Send agent loaded response
  send(ws, ServerMessages.agentLoaded(sessionId, agent, state?.traceId));

  for (const diagnosticMessage of buildSessionDiagnosticMessages(sessionId, runtimeSession)) {
    send(ws, diagnosticMessage);
  }

  // Send initial state from RuntimeSession
  const initialState: Record<string, unknown> = {
    gatherProgress: runtimeSession.state.gatherProgress,
    context: runtimeSession.state.context,
    conversationPhase: runtimeSession.state.conversationPhase,
  };
  send(
    ws,
    ServerMessages.stateUpdate(
      sessionId,
      initialState as unknown as import('../types/index.js').AgentState,
      {},
    ),
  );

  wsLog.info(`[WS] Loaded agent: ${agent.name} (session: ${sessionId})`);

  // Auth preflight check: if the agent requires preflight consent, send auth_required
  // and activate the auth gate before ON_START fires.
  if (runtimeSession.compilationOutput) {
    try {
      if (await activateAuthGateIfRequired(ws, sessionId, runtimeSession, state?.userId)) {
        return; // Do not fire ON_START until auth gate is satisfied
      }
    } catch (err) {
      wsLog.warn('Auth preflight check failed; blocking session initialization', {
        error: err instanceof Error ? err.message : String(err),
        sessionId,
      });
      send(
        ws,
        ServerMessages.error(
          'Authentication preflight is temporarily unavailable. Please retry in a moment.',
        ),
      );
      return;
    }
  }

  // Unified initialization — handles flow + reasoning + ON_START
  if (runtimeSession.currentFlowStep || runtimeSession.agentIR?.on_start) {
    wsLog.info(
      `[WS] Initializing agent ${agent.name} (flow: ${!!runtimeSession.currentFlowStep}, on_start: ${!!runtimeSession.agentIR?.on_start})`,
    );
    initializeAgent(ws, sessionId, runtimeSession);
  }
}

/**
 * Load agent from database by agentPath or name within a project.
 * Returns agent details and the DB record ID for scoping sibling lookups.
 */
async function loadAgentFromDatabase(
  agentPath: string,
  projectId: string,
  tenantId?: string,
): Promise<{
  agent: AgentDetails;
  dbAgentId: string;
  workingCopySource: ProjectWorkingCopyAgentSource;
} | null> {
  if (!isDatabaseAvailable()) return null;

  try {
    // Try exact agentPath match first (tenant + project scoped)
    let record = await findProjectAgentByPath(agentPath, tenantId, { projectId });

    // Fallback: match by name (last segment of "domain/name" path) in the same project
    if (!record) {
      const name = agentPath.includes('/') ? agentPath.split('/').pop()! : agentPath;
      record = await findProjectAgentByName(name, { tenantId, projectId });
    }

    if (!record?.dslContent) return null;

    // Build AgentDetails from DSL content
    const agent = buildAgentDetails(record.dslContent, record.name);

    if (!agent) return null;

    return {
      agent,
      dbAgentId: (record as any).id ?? (record as any)._id,
      workingCopySource: {
        name: record.name,
        dslContent: record.dslContent,
        dslValidationStatus:
          typeof record.dslValidationStatus === 'string' || record.dslValidationStatus === null
            ? record.dslValidationStatus
            : undefined,
        dslDiagnostics: Array.isArray(record.dslDiagnostics) ? record.dslDiagnostics : null,
        systemPromptLibraryRef: normalizeProjectWorkingCopyLibraryRef(record),
      },
    };
  } catch (error) {
    wsLog.warn('[WS] Database agent lookup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Load sibling agent working-copy sources for a supervisor from the same project.
 * Scoped by projectId to prevent cross-project agent leakage.
 * Excludes the supervisor itself by DB record ID (not DSL name, which may differ).
 */
async function loadSiblingAgentSources(
  projectId: string,
  excludeAgentId: string,
  tenantId?: string,
): Promise<ProjectWorkingCopyAgentSource[]> {
  if (!isDatabaseAvailable()) return [];

  try {
    const allAgents = await findProjectAgentsForProject(projectId, {
      includeDSLContent: true,
      tenantId,
    });

    return buildProjectWorkingCopyAgentSources(
      allAgents
        .filter((a: any) => {
          const agentId = a.id ?? a._id;
          return agentId !== excludeAgentId && a.dslContent;
        })
        .map((a: any) => ({
          name: a.name,
          dslContent: a.dslContent,
          dslValidationStatus:
            typeof a.dslValidationStatus === 'string' || a.dslValidationStatus === null
              ? a.dslValidationStatus
              : undefined,
          dslDiagnostics: Array.isArray(a.dslDiagnostics) ? a.dslDiagnostics : null,
          systemPromptLibraryRef: a.systemPromptLibraryRef,
        })),
    );
  } catch (err) {
    wsLog.warn('Failed to load sibling agent sources', {
      error: err instanceof Error ? err.message : String(err),
      projectId,
      excludeAgentId,
    });
    return [];
  }
}

/**
 * Unified agent initialization — handles both flow and reasoning mode ON_START.
 * Uses executor.initializeSession() which is idempotent (safe if called again later).
 */
async function initializeAgent(
  ws: WebSocket,
  sessionId: string,
  runtimeSession: RuntimeSession,
): Promise<void> {
  const executor = getRuntimeExecutor();
  const responseMessageId = crypto.randomUUID();
  const initExecutionId = `exec-${crypto.randomUUID()}`;

  // Defer responseStart until first chunk arrives — avoids orphaned
  // responseStart with no responseEnd for SET-only ON_START (no RESPOND).
  let responseFrameOpen = false;
  const allChunks: string[] = [];
  let lastChunkTime = 0;
  const acc = createTraceAccumulator();

  try {
    const result = await executor.initializeSession(
      runtimeSession.id,
      (chunk: string) => {
        lastChunkTime = Date.now();
        if (!responseFrameOpen) {
          send(ws, ServerMessages.responseStart(sessionId, responseMessageId, initExecutionId));
          responseFrameOpen = true;
        }
        allChunks.push(chunk);
        send(ws, ServerMessages.responseChunk(sessionId, responseMessageId, chunk));
      },
      createOnTraceEvent(
        sessionId,
        ws,
        acc,
        runtimeSession.agentName,
        clients.get(ws)?.traceEmitter,
        runtimeSession?.tenantId,
        initExecutionId,
      ),
    );

    if (!result) {
      return;
    }

    const outcome = buildExecutionOutcome({
      channelType: 'web_debug',
      result,
      streamedText: allChunks.length > 0 ? allChunks.join('') : undefined,
      session: executor.getSession(runtimeSession.id) ?? runtimeSession,
    });
    const fullResponse = outcome.responseText;
    const responseMetadata = withAgentNameMetadata(
      outcome.responseMetadata ??
        result.responseMetadata ??
        buildResponseMessageMetadata(acc.responseProvenance),
      runtimeSession.agentName,
    );

    if (!responseFrameOpen) {
      send(ws, ServerMessages.responseStart(sessionId, responseMessageId, initExecutionId));
      responseFrameOpen = true;
    }

    if (responseFrameOpen) {
      // For reasoning mode ON_START, store the message (flow mode stores internally)
      if (!runtimeSession.currentFlowStep) {
        executor.addMessage(
          sessionId,
          'assistant',
          fullResponse,
          responseMetadata,
          buildExecutionResultContentEnvelope(result),
        );
      }

      // Persist ON_START response to DB via queue
      const initState = clients.get(ws);
      if (initState && !initState.dbSessionId) {
        await ensureDebugDbSession(initState);
      }

      if (initState?.dbSessionId) {
        persistMessage(
          initState.dbSessionId,
          'assistant',
          fullResponse,
          'web_debug',
          initState.tenantId,
          undefined,
          undefined,
          initState.projectId,
          lastChunkTime || Date.now(),
          buildPersistedAssistantStructuredContent(outcome),
          responseMetadata,
        ).catch((err: unknown) =>
          wsLog.warn('[WS] ON_START persist failed', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        // Persist metrics via batched queue (fire-and-forget)
        persistTurnMetrics({
          dbSessionId: initState.dbSessionId,
          tenantId: initState.tenantId,
          tokensIn: acc.tokensIn,
          tokensOut: acc.tokensOut,
          cost: acc.cost,
          traceEventCount: acc.traceCount,
          errorCount: acc.errorCount,
          handoffCount: acc.handoffCount,
        }).catch((err: unknown) => {
          wsLog.warn('[WS] ON_START metrics persist failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } else {
        wsLog.warn(
          '[WS] ON_START response was not persisted because no debug DB session is bound',
          {
            sessionId,
            runtimeSessionId: runtimeSession.id,
            projectId: initState?.projectId ?? runtimeSession.projectId,
            tenantId: initState?.tenantId ?? runtimeSession.tenantId,
          },
        );
      }

      send(
        ws,
        ServerMessages.responseEnd(
          sessionId,
          responseMessageId,
          fullResponse,
          outcome.voiceConfig,
          outcome.richContent,
          outcome.actions,
          initExecutionId,
          responseMetadata,
          outcome.localization,
          result?.citations,
        ),
      );
    }

    const action = result.action as import('../types/index.js').ConstructAction;
    send(ws, ServerMessages.actionTaken(sessionId, action));

    // Send updated state after initialization
    const updatedSession = executor.getSession(runtimeSession.id);
    if (updatedSession) {
      const updatedState: Record<string, unknown> = {
        gatherProgress: updatedSession.state.gatherProgress,
        context: updatedSession.state.context,
        conversationPhase: updatedSession.state.conversationPhase,
      };
      send(
        ws,
        ServerMessages.stateUpdate(
          sessionId,
          updatedState as unknown as import('../types/index.js').AgentState,
          {},
        ),
      );
    }
  } catch (error) {
    wsLog.error('[WS] Agent initialization error', {
      error: error instanceof Error ? error.message : String(error),
    });
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    // Ensure we close the frame if we opened one, or open+close for the error
    if (!responseFrameOpen) {
      send(ws, ServerMessages.responseStart(sessionId, responseMessageId, initExecutionId));
    }
    send(
      ws,
      ServerMessages.responseEnd(
        sessionId,
        responseMessageId,
        'An error occurred while initializing the agent',
        undefined,
        undefined,
        undefined,
        initExecutionId,
      ),
    );
  }
}

/**
 * Handle user message - uses real runtime executor
 */
async function handleSendMessage(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'send_message' }>,
): Promise<void> {
  // Capture arrival time immediately — before any async session validation work.
  const messageArrivalTime = Date.now();
  const { sessionId, text, attachmentIds, messageId } = message;

  // Get client state
  const clientState = clients.get(ws);
  const executor = getRuntimeExecutor();
  let traceEmitter = clientState?.traceEmitter;
  let runtimeSession =
    clientState?.runtimeSession?.id === sessionId ? clientState.runtimeSession : undefined;
  const sessionLocator = buildWsSessionLocator(sessionId, clientState);

  if (runtimeSession && !ensureWsSessionAccess(ws, sessionId, runtimeSession, 'send_message')) {
    send(ws, ServerMessages.error('Session not found'));
    return;
  }

  // Safety net: rehydrate if session dropped (e.g. WS reconnect) but sessionId is valid
  if (!runtimeSession && sessionId) {
    const inMemorySession = executor.getSession(sessionId);
    if (inMemorySession) {
      if (!ensureWsSessionAccess(ws, sessionId, inMemorySession, 'send_message')) {
        send(ws, ServerMessages.error('Session not found'));
        return;
      }
      runtimeSession = inMemorySession;
    }

    if (!runtimeSession) {
      const rehydratedSession =
        (await executor.rehydrateSession(
          sessionId,
          sessionLocator ? { locator: sessionLocator } : undefined,
        )) ?? undefined;

      if (rehydratedSession) {
        if (!ensureWsSessionAccess(ws, sessionId, rehydratedSession, 'send_message')) {
          send(ws, ServerMessages.error('Session not found'));
          return;
        }
        runtimeSession = rehydratedSession;
      }
    }

    if (runtimeSession) {
      bindJitAuthCallbacksToSession(ws, runtimeSession);
      const state = clients.get(ws);
      if (state) {
        state.sessionId = runtimeSession.id;
        state.runtimeSession = runtimeSession;
        const tenantCfg2 = await getTenantConfigService()
          .getConfigAsync(runtimeSession.tenantId ?? '')
          .catch(() => null);
        state.traceEmitter = createTraceEmitter({
          sessionId: runtimeSession.id,
          ws,
          tenantId: runtimeSession.tenantId,
          projectId: runtimeSession.projectId,
          deploymentId: runtimeSession.versionInfo?.deploymentId,
          environment: runtimeSession.versionInfo?.environment,
          agentVersions: resolveAgentVersionsForTrace(runtimeSession),
          scrubPII: tenantCfg2?.security?.scrubPII ?? true,
          piiRecognizerRegistry: runtimeSession.piiRecognizerRegistry,
          customDimensions: runtimeSession.customDimensions,
          sessionRef: runtimeSession,
          moduleProvenanceMap: runtimeSession.moduleProvenance,
        });
        traceEmitter = state.traceEmitter;
      }
      wsLog.info(`[WS] Session auto-rehydrated in handleSendMessage: ${sessionId}`);
    }
  }

  if (!runtimeSession) {
    send(ws, ServerMessages.error(`Session not found: ${sessionId}`));
    return;
  }

  await reactivatePersistedSessionSummary(runtimeSession.id, runtimeSession.tenantId);

  // Queue messages behind auth gate if active
  const runtimeSidForGate = clientState?.sessionId || runtimeSession?.id;
  if (runtimeSidForGate && runtimeSession) {
    let gateActive = false;
    try {
      gateActive = await hasActiveAuthGateAsync(runtimeSidForGate);
      if (!gateActive) {
        gateActive = await activateAuthGateIfRequired(
          ws,
          runtimeSidForGate,
          runtimeSession,
          clientState?.userId ?? runtimeSession.userId,
        );
      }
    } catch (err) {
      wsLog.warn('Auth preflight re-check failed; blocking message execution', {
        sessionId: runtimeSidForGate,
        error: err instanceof Error ? err.message : String(err),
      });
      send(
        ws,
        ServerMessages.error(
          'Authentication preflight is temporarily unavailable. Please retry in a moment.',
        ),
      );
      return;
    }

    if (gateActive) {
      try {
        await queueMessageBehindAuthGateAsync(runtimeSidForGate, text, attachmentIds);
        send(ws, ServerMessages.messageQueued(sessionId, 'auth_gate_active'));
        emitAuthLifecycleTrace(ws, {
          sessionId: runtimeSidForGate,
          decision: 'message_queued',
          reason: 'auth_gate_active',
          attachmentCount: attachmentIds?.length ?? 0,
          textLength: text.length,
          traceId: clientState?.traceId,
          spanId: traceEmitter?.getCurrentSpanId(),
          agentName: runtimeSession.agentName,
        });
      } catch (err) {
        send(ws, ServerMessages.error(err instanceof Error ? err.message : String(err)));
      }
      return;
    }
  }

  // Lazily create DB session on first user message (not on WS connect / agent load)
  if (clientState && !clientState.dbSessionId) {
    await ensureDebugDbSession(clientState);
  }

  // Generate response message ID
  const responseMessageId = crypto.randomUUID();
  const turnExecutionId = `exec-${crypto.randomUUID()}`;

  // When the session is already in agent-transfer mode, the user message is
  // forwarded straight to the human agent — no LLM streaming occurs. Skip
  // response_start so the Studio client never enters streaming state and
  // never shows the empty thought placeholder that would otherwise appear
  // between response_start and the transfer_active response_end.
  const sessionIsInTransfer = Boolean(
    runtimeSession?.transferInitiated && runtimeSession?.isEscalated,
  );

  if (!sessionIsInTransfer) {
    send(ws, ServerMessages.responseStart(sessionId, responseMessageId, turnExecutionId));
  }

  // NOTE: user_message and agent_enter/agent_exit lifecycle events are now emitted
  // centrally inside RuntimeExecutor.executeMessage(). Channel metadata is passed
  // via ExecuteMessageOptions.channelMetadata. No per-handler lifecycle code needed.

  // Flow mode doesn't require API key (no LLM needed for scripted flows)
  const isFlowMode = runtimeSession?.currentFlowStep !== undefined;
  const canExecute = runtimeSession && (executor.isConfigured() || isFlowMode);

  if (canExecute) {
    const session = runtimeSession!;
    const startTime = Date.now();
    const agentName = session.agentName || 'unknown';

    // Channel metadata for centralized lifecycle events
    const channelMetadata = {
      channel: 'web_debug' as const,
      contentLength: text.length,
      hasAttachments: !!attachmentIds?.length,
      attachmentCount: attachmentIds?.length || 0,
    };

    try {
      // Stream chunk and trace callbacks.
      // Accumulate all chunks so response_end.fullText includes everything
      // (remote agent streaming + supervisor LLM follow-up).
      const allChunks: string[] = [];
      let lastChunkTime = 0;
      const onChunk = (chunk: string) => {
        lastChunkTime = Date.now();
        allChunks.push(chunk);
        send(ws, ServerMessages.responseChunk(sessionId, responseMessageId, chunk));
      };
      // Accumulate token usage from trace events
      const acc = createTraceAccumulator();
      const onTraceEvent = createOnTraceEvent(
        sessionId,
        ws,
        acc,
        agentName,
        traceEmitter,
        session.tenantId,
        turnExecutionId,
      );

      // Route through ExecutionCoordinator when available (handles dedup, concurrency, queueing).
      // Falls back to direct executor/queue paths when coordinator is not initialized.
      let result;
      if (isCoordinatorAvailable()) {
        const coordinator = getExecutionCoordinator();
        const execution = await coordinator.submit(session.id, text, {
          tenantId: session.tenantId || clientState?.tenantId || 'default',
          ...(messageId ? { dedupKey: `web_debug:${messageId}` } : {}),
          executionId: turnExecutionId,
          attachmentIds,
          onChunk,
          onTraceEvent,
          channelMetadata,
          sessionLocator: sessionLocator ?? undefined,
        });

        // Surface coordinator execution failures as errors so the client sees them.
        if (execution.status === 'failed' && execution.error) {
          throw new Error(execution.error.message || 'Execution failed');
        }

        const execResult = execution.resultData as typeof result | undefined;
        result = execResult ?? {
          response: execution.response || '',
          action: { type: 'continue' as const },
          stateUpdates: undefined,
          voiceConfig: undefined,
          richContent: undefined,
          actions: undefined,
        };
      } else if (isLLMQueueEnabled() && !isFlowMode) {
        result = await enqueueLLMRequest(
          session.id,
          text,
          onChunk,
          onTraceEvent,
          session.tenantId,
          {
            channelMetadata,
            ...(sessionLocator ? { sessionLocator } : {}),
          },
        );
      } else {
        // TODO(ABLP-155): wire interactionContext when the web WS protocol supports it.
        // The SDK handler (sdk-handler.ts) already passes interactionContext per-message;
        // the web handler does not expose it in the client message schema yet.
        const execOptions: import('../services/execution/types.js').ExecuteMessageOptions = {
          ...(attachmentIds?.length ? { attachmentIds } : {}),
          channelMetadata,
          ...(sessionLocator ? { sessionLocator } : {}),
        };
        result = await executor.executeMessage(
          session.id,
          text,
          onChunk,
          onTraceEvent,
          execOptions,
        );
      }

      // Agent transfer active — message was forwarded to the human agent.
      // Suppress the response bubble; the agent's reply arrives via webhook.
      const isTransferActive = result.action?.type === 'transfer_active';
      let fullText = '';
      let responseMetadata = withAgentNameMetadata(
        result.responseMetadata ?? buildResponseMessageMetadata(acc.responseProvenance),
        agentName,
      );
      let assistantStructuredContent:
        | {
            richContent?: typeof result.richContent;
            actions?: typeof result.actions;
            voiceConfig?: typeof result.voiceConfig;
          }
        | undefined;
      let assistantPersistenceMessages: AssistantPersistenceMessage[] = [];
      let assistantHasRenderablePayload = false;

      if (isTransferActive) {
        // Send response_end with a transfer_active action marker so the Studio
        // frontend (WebSocketContext.tsx) can suppress the empty-response diagnostic.
        // Bypass ServerMessage typing — Studio checks actions as a plain array.
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'response_end',
              sessionId,
              messageId: responseMessageId,
              fullText: '',
              executionId: turnExecutionId,
              actions: [{ type: 'transfer_active' }],
            }),
          );
        }
      } else {
        // Signal response end.
        // When streaming occurred (remote A2A handoff + supervisor follow-up),
        // use accumulated chunks as fullText to preserve everything the user saw.
        // For normal LLM streaming, allChunks.join('') === result.response.
        const outcome = buildExecutionOutcome({
          channelType: 'web_debug',
          result,
          streamedText: allChunks.length > 0 ? allChunks.join('') : undefined,
          session: executor.getSession(session.id) ?? session,
        });
        responseMetadata = withAgentNameMetadata(
          outcome.responseMetadata ??
            result.responseMetadata ??
            buildResponseMessageMetadata(acc.responseProvenance),
          agentName,
        );
        fullText = outcome.responseText;
        assistantHasRenderablePayload = hasRenderableChannelOutcome(outcome);
        assistantStructuredContent = buildPersistedAssistantStructuredContent(outcome);
        assistantPersistenceMessages = buildAssistantPersistenceMessages({
          outcome,
          responseMetadata,
          responseMessageId,
          agentName,
          messageTimestamp: lastChunkTime || Date.now(),
        });
        send(
          ws,
          ServerMessages.responseEnd(
            sessionId,
            responseMessageId,
            fullText,
            outcome.voiceConfig,
            outcome.richContent,
            outcome.actions,
            turnExecutionId,
            responseMetadata,
            outcome.localization,
            result.citations,
          ),
        );
      }

      // RuntimeExecutor emits the canonical agent_response trace centrally.
      // Keep transport observability on channel_response_sent in finally; emitting
      // another agent_response here makes Studio show duplicate response rows.

      // Persist messages to DB via queue (batched, Redis-backed)
      if (!clientState?.dbSessionId) {
        wsLog.warn('[WS] No dbSessionId — message persistence skipped for entire turn', {
          sessionId,
          agentName,
        });
      }
      if (clientState?.dbSessionId) {
        // Use the time the last LLM chunk arrived as the assistant timestamp.
        // Falls back to Date.now() for non-streaming (single-shot) responses.
        const assistantTimestamp = lastChunkTime || Date.now();
        if (!isTransferActive) {
          persistMessage(
            clientState.dbSessionId,
            'user',
            text,
            'web_debug',
            clientState.tenantId,
            undefined,
            undefined,
            clientState.projectId,
            messageArrivalTime,
          ).catch((err: unknown) =>
            wsLog.warn('[WS] User message persist failed', {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }

        // message.user and message.agent events are emitted centrally
        // from RuntimeExecutor.executeMessage() — no per-handler duplication.

        if (assistantHasRenderablePayload) {
          if (result.outputMessages?.length) {
            for (const assistantMessage of assistantPersistenceMessages) {
              persistMessageRecord({
                dbSessionId: clientState.dbSessionId,
                role: 'assistant',
                content: assistantMessage.content,
                channel: 'web_debug',
                tenantId: clientState.tenantId,
                projectId: clientState.projectId,
                messageTimestamp: assistantMessage.messageTimestamp ?? assistantTimestamp,
                structuredContent: assistantMessage.structuredContent,
                metadata: assistantMessage.metadata as Partial<MessageMetadata> | undefined,
                messageId: assistantMessage.messageId,
                agentName: assistantMessage.agentName,
              }).catch((err: unknown) =>
                wsLog.warn('[WS] Assistant message persist failed', {
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
            }
          } else {
            persistMessage(
              clientState.dbSessionId,
              'assistant',
              fullText,
              'web_debug',
              clientState.tenantId,
              undefined,
              undefined,
              clientState.projectId,
              assistantTimestamp,
              assistantStructuredContent,
              responseMetadata,
            ).catch((err: unknown) =>
              wsLog.warn('[WS] Assistant message persist failed', {
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }
        // Persist token/trace/error metrics via batched queue
        persistTurnMetrics({
          dbSessionId: clientState.dbSessionId,
          tenantId: clientState.tenantId,
          tokensIn: acc.tokensIn,
          tokensOut: acc.tokensOut,
          cost: acc.cost,
          traceEventCount: acc.traceCount,
          errorCount: acc.errorCount,
          handoffCount: acc.handoffCount,
        }).catch((err: unknown) => {
          wsLog.warn('Metrics persist failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      // Record to centralized metrics store (ClickHouse) — fire-and-forget
      const wsLatencyMs = Date.now() - startTime;
      let wsEstimatedCost: number | null = null;
      try {
        if (acc.lastModelId && hasKnownPricing(acc.lastModelId)) {
          const caps = getModelCapabilities(acc.lastModelId);
          wsEstimatedCost = calculateCost(
            caps.inputCostPer1k ?? 0,
            caps.outputCostPer1k ?? 0,
            acc.tokensIn,
            acc.tokensOut,
          );
        }
      } catch (err) {
        wsLog.debug('Cost estimation failed', {
          modelId: acc.lastModelId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (shouldUseClickHouse()) {
        getChStores()
          .then((stores) => {
            if (!stores) return;
            return stores.metricsStore.record({
              tenantId: runtimeSession?.tenantId || clientState?.tenantId,
              sessionId,
              projectId: clientState?.projectId || '',
              userId: clientState?.userId,
              modelId: acc.lastModelId,
              provider: acc.lastProvider,
              inputTokens: acc.tokensIn,
              outputTokens: acc.tokensOut,
              totalTokens: acc.tokensIn + acc.tokensOut,
              estimatedCost: wsEstimatedCost,
              latencyMs: wsLatencyMs,
              streamingUsed: true,
              toolCallCount: 0,
            });
          })
          .catch((err: unknown) => {
            wsLog.warn('ClickHouse metrics record failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      // Add assistant message - convert action to ConstructAction type
      const action: import('../types/index.js').ConstructAction =
        result.action.type === 'continue'
          ? { type: 'continue', data: result.action.data as Record<string, unknown> }
          : { type: 'continue' }; // Default fallback

      // Response is already in thread history via executeMessage — no separate addMessage needed

      // Persist metrics to ClickHouse and route the shared audit event through
      // the centralized audit pipeline (fire-and-forget).
      // NOTE: ClickHouse message writes are now handled by DualWriteMessageStore
      // via the message persistence queue — no ad-hoc message writes needed here.
      if (shouldUseClickHouse()) {
        const chTenantId = runtimeSession?.tenantId || 'default';
        const latencyMs = Date.now() - startTime;
        const projectId = runtimeSession?.projectId ?? clientState?.projectId;
        getChStores()
          .then(async (stores) => {
            if (!stores) return;

            // LLM Metrics — use TRACE_MODEL_UNKNOWN since actual resolved model
            // is not available at this handler level (it's inside the executor)
            await stores.metricsStore
              .record({
                tenantId: chTenantId,
                modelId: acc.lastModelId || TRACE_MODEL_UNKNOWN,
                provider: acc.lastProvider || 'unknown',
                sessionId,
                projectId: projectId ?? '',
                inputTokens: text.length,
                outputTokens: result.response.length,
                totalTokens: text.length + result.response.length,
                latencyMs,
                estimatedCost: 0,
                streamingUsed: false,
                toolCallCount: 0,
              })
              .catch((metricsErr: unknown) => {
                wsLog.warn('ClickHouse metrics record failed', {
                  sessionId,
                  error: metricsErr instanceof Error ? metricsErr.message : String(metricsErr),
                });
              });

            wsLog.info('[WS] Metrics persisted', { sessionId, tenantId: chTenantId });
          })
          .catch((chErr) => {
            wsLog.error('Failed to initialize ClickHouse metrics persistence', {
              error: chErr instanceof Error ? chErr.message : String(chErr),
            });
          });
      }

      // Update state from RuntimeSession (executor already updated session state)
      // Always read the current session for decision log (may have entries even without stateUpdates)
      const currentSession = executor.getSession(sessionId);
      if (result.stateUpdates) {
        const stateUpdate: Record<string, unknown> = {
          gatherProgress: result.stateUpdates?.gatherProgress || {},
          context: result.stateUpdates?.context || {},
          conversationPhase: result.stateUpdates?.conversationPhase || 'active',
        };
        // Pass through activeAgent info if present (from handoff)
        if (result.stateUpdates?.activeAgent) {
          stateUpdate.activeAgent = result.stateUpdates.activeAgent;
        }
        send(
          ws,
          ServerMessages.stateUpdate(
            sessionId,
            stateUpdate as unknown as import('../types/index.js').AgentState,
            {},
          ),
        );

        // Emit session updated event (analytics)
        if (traceEmitter) {
          const contextKeys = Object.keys(result.stateUpdates?.context || {});
          if (contextKeys.length > 0) {
            traceEmitter.logSessionUpdated({
              updateSource: 'execution',
              keysUpdated: contextKeys,
              updateCount: contextKeys.length,
              agentName,
            });
          }
        }
      }

      // Transition conversationPhase from 'start' to 'active' after the first
      // substantive response, even when the executor did not emit stateUpdates.
      if (
        currentSession &&
        currentSession.state.conversationPhase === 'start' &&
        fullText?.trim()
      ) {
        currentSession.state = { ...currentSession.state, conversationPhase: 'active' };
        // TODO(ABLP-155): emit stateUpdate WS frame to client when conversationPhase transitions
        // from 'start' to 'active'. Currently the phase change is persisted to the session but
        // not pushed to the WS client; the client only sees it on the next full state refresh.
      }

      // Send action taken
      send(ws, ServerMessages.actionTaken(sessionId, action));

      // NOTE: agent_exit is now emitted centrally in executeMessage()'s finally block.
      // No per-handler logAgentExit needed here.
    } catch (error) {
      // Handle backpressure from LLM queue
      if (error instanceof BackpressureError) {
        send(
          ws,
          ServerMessages.responseEnd(
            sessionId,
            responseMessageId,
            'The service is experiencing high load. Please try again in a moment.',
            undefined,
            undefined,
            undefined,
            turnExecutionId,
          ),
        );
        return;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      wsLog.error('[WS] Runtime execution error', { error: errorMessage });

      // Surface classified LLM errors with their contextual message;
      // fall back to a generic message for non-LLM errors.
      const userFacingMessage = isLlmError(error)
        ? error.message
        : 'I apologize, but I encountered an error. Please try again.';

      send(
        ws,
        ServerMessages.responseEnd(
          sessionId,
          responseMessageId,
          userFacingMessage,
          undefined,
          undefined,
          undefined,
          turnExecutionId,
        ),
      );

      if (traceEmitter) {
        traceEmitter.logError({ errorType: 'execution_error', message: errorMessage });
      }
    } finally {
      // STI flush: emit channel_response_sent so STR buffer drains for this trace.
      // Must run on both success and error paths; must never fail the WS response.
      try {
        emitChannelResponseSent(sessionId, 'ws', Date.now() - startTime, {
          tenantId: clientState?.tenantId,
          projectId: clientState?.projectId,
          configHash: runtimeSession?.configHash,
          knownSource: runtimeSession?.knownSource,
        });
      } catch {
        // best-effort — never fail the WS response
      }
    }
  } else {
    // Fallback: No runtime available, use simple response
    wsLog.info('[WS] Using fallback mode (no runtime configured)');
    const fallbackStartTime = Date.now();
    const fallbackAgentName = runtimeSession?.agentName || 'fallback';

    // Emit agent_enter for fallback
    if (traceEmitter) {
      traceEmitter.logAgentEnter({
        agentName: fallbackAgentName,
        mode: 'reasoning',
        trigger: 'user_message',
      });
    }

    // Build minimal agent details for fallback response
    const fallbackAgent = {
      id: fallbackAgentName,
      name: fallbackAgentName,
      type: 'agent' as const,
      mode: 'reasoning' as const,
      dsl: '',
    } as import('../types/index.js').AgentDetails;
    const fallbackResponse = generateFallbackResponse(fallbackAgent, text);

    // Stream the response in chunks
    const chunks = chunkText(fallbackResponse.text, 20);
    for (const chunk of chunks) {
      send(ws, ServerMessages.responseChunk(sessionId, responseMessageId, chunk));
      await sleep(30);
    }

    send(
      ws,
      ServerMessages.responseEnd(
        sessionId,
        responseMessageId,
        fallbackResponse.text,
        undefined,
        undefined,
        undefined,
        turnExecutionId,
      ),
    );

    // Store message via RuntimeExecutor
    executor.addMessage(sessionId, 'user', text);
    executor.addMessage(sessionId, 'assistant', fallbackResponse.text);

    send(ws, ServerMessages.actionTaken(sessionId, fallbackResponse.action));

    if (traceEmitter) {
      const fallbackDuration = Date.now() - fallbackStartTime;
      traceEmitter.logLLMCall({
        model: 'fallback (no API key)',
        messagesIn: 1,
        tokensIn: text.length,
        tokensOut: fallbackResponse.text.length,
        latencyMs: fallbackDuration,
        messages: [{ role: 'user', content: text }],
        response: fallbackResponse.text,
      });

      // Emit agent_exit for fallback
      traceEmitter.logAgentExit({
        agentName: fallbackAgentName,
        result: 'completed',
        durationMs: fallbackDuration,
      });
    }
  }
}

/**
 * Handle cancel_execution — cancel a specific execution or all executions for the session.
 */
async function handleCancelExecution(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'cancel_execution' }>,
): Promise<void> {
  if (!isCoordinatorAvailable()) {
    send(ws, ServerMessages.error('Execution coordinator not available'));
    return;
  }

  const coordinator = getExecutionCoordinator();
  const clientState = clients.get(ws);
  const sessionId = getBoundSessionId(clientState);

  if (message.executionId) {
    const execution = await coordinator.getStatus(message.executionId);
    if (
      !execution ||
      !(await hasAuthorizedSessionAccess(ws, execution.sessionId, 'cancel_execution'))
    ) {
      send(ws, ServerMessages.error('Execution not found'));
      return;
    }

    const cancelled = await coordinator.cancel(message.executionId);
    if (!cancelled) {
      send(ws, ServerMessages.error('Execution not found'));
      return;
    }

    wsLog.info('Cancel execution request', {
      executionId: message.executionId,
      cancelled,
    });
  } else if (sessionId) {
    if (!(await hasAuthorizedSessionAccess(ws, sessionId, 'cancel_execution'))) {
      send(ws, ServerMessages.error('Session not found'));
      return;
    }

    await coordinator.cancelSession(sessionId);
    wsLog.info('Cancel all executions for session', { sessionId });
  } else {
    send(ws, ServerMessages.error('No active session to cancel'));
  }
}

/**
 * Handle test execution
 */
async function handleRunTest(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'run_test' }>,
): Promise<void> {
  const { sessionId, testId } = message;

  const clientState = clients.get(ws);
  const agentDetails = clientState?.agentDetails;
  if (!agentDetails) {
    send(ws, ServerMessages.error(`Session not found: ${sessionId}`));
    return;
  }

  // Find test case from agent details
  const testCase = agentDetails.suggestedTests?.find((t) => t.id === testId);
  if (!testCase) {
    send(ws, ServerMessages.error(`Test not found: ${testId}`));
    return;
  }

  // Run test inputs
  for (const input of testCase.inputs) {
    // Simulate user sending message
    await handleSendMessage(ws, { type: 'send_message', sessionId, text: input });
    await sleep(500); // Delay between messages
  }
}

/**
 * Handle state request
 */
function handleGetState(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'get_state' }>,
): void {
  const session = getAuthorizedRuntimeSession(ws, message.sessionId, 'get_state');

  if (!session) {
    send(ws, ServerMessages.error(`Session not found: ${message.sessionId}`));
    return;
  }

  const sessionState = {
    gatherProgress: session.state.gatherProgress,
    context: session.state.context,
    conversationPhase: session.state.conversationPhase,
    activeAgent: session.state.activeAgent,
  };
  send(
    ws,
    ServerMessages.stateUpdate(
      message.sessionId,
      sessionState as import('../types/index.js').AgentState,
      {},
    ),
  );
}

// =============================================================================
// TRACE SUBSCRIPTION HANDLERS
// =============================================================================

/**
 * Handle session subscription request
 * Subscribes the client to receive trace events from a session
 */
async function handleSubscribeSession(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'subscribe_session' }>,
): Promise<void> {
  const { sessionId } = message;

  const runtimeSession = getAuthorizedRuntimeSession(ws, sessionId, 'subscribe_session');
  let persistedSession:
    | Awaited<ReturnType<typeof getAuthorizedPersistedSession>>
    | null
    | undefined = null;
  if (!runtimeSession) {
    persistedSession = await getAuthorizedPersistedSession(ws, sessionId, 'subscribe_session');
    if (!persistedSession) {
      send(ws, ServerMessages.error('Session not found'));
      return;
    }
  }

  const traceStore = getTraceStore();
  const traceReadOptions =
    runtimeSession?.tenantId || persistedSession?.tenantId
      ? {
          tenantId: runtimeSession?.tenantId ?? persistedSession?.tenantId,
        }
      : undefined;

  const result = await traceStore.subscribe(sessionId, ws, traceReadOptions);

  if (result.success) {
    send(ws, {
      type: 'subscribed',
      sessionId,
      eventCount: result.eventCount,
    });
    wsLog.info(`[WS] Client subscribed to session ${sessionId}`);
  } else {
    send(ws, ServerMessages.error(`Failed to subscribe to session: ${sessionId}`));
  }
}

/**
 * Handle session unsubscription request
 */
function handleUnsubscribeSession(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'unsubscribe_session' }>,
): void {
  const { sessionId } = message;
  const traceStore = getTraceStore();

  traceStore.unsubscribe(sessionId, ws);

  send(ws, {
    type: 'unsubscribed',
    sessionId,
  });
  wsLog.info(`[WS] Client unsubscribed from session ${sessionId}`);
}

/**
 * Handle list sessions request
 * Returns all active sessions that can be subscribed to
 */
function handleListSessions(ws: WebSocket): void {
  const clientState = clients.get(ws);
  const clientTenantId = clientState?.tenantId;
  const clientUserId = clientState?.userId;

  if (!clientTenantId) {
    send(ws, { type: 'session_list', sessions: [] });
    return;
  }

  const executor = getRuntimeExecutor();
  const traceStore = getTraceStore();
  const sessionIds = traceStore.getActiveSessions();

  const sessions: Array<{
    sessionId: string;
    agentName?: string;
    eventCount: number;
    lastActivity: Date;
  }> = [];

  for (const sessionId of sessionIds) {
    // Filter by tenant + user ownership
    const runtimeSession = executor.getSession(sessionId);
    if (!runtimeSession) continue;
    if (runtimeSession.tenantId !== clientTenantId) continue;
    // When runtimeSession.userId is unset, the session is a channel/anonymous session
    // (not user-owned) and is visible to any authenticated user within the same tenant.
    // TODO: Add role-based gating once WS client state includes user role (admin bypass).
    if (clientUserId && runtimeSession.userId && runtimeSession.userId !== clientUserId) continue;

    const info = traceStore.getSessionInfo?.(sessionId);
    sessions.push({
      sessionId,
      agentName: info?.agentName,
      eventCount: info?.eventCount || 0,
      lastActivity: info?.lastActivity || new Date(),
    });
  }

  send(ws, { type: 'session_list', sessions });
}

// =============================================================================
// SESSION RESUMPTION
// =============================================================================

type ResumeAgentIrLike = {
  flow?: unknown;
  tools?: unknown[];
  gather?: { fields?: unknown[] };
  coordination?: { handoffs?: unknown[] };
  routing?: { rules?: unknown[] };
};

async function buildResumedAgentDetails(session: RuntimeSession): Promise<AgentDetails> {
  const entryAgentName = session.threads?.[0]?.agentName ?? session.agentName;

  // Try to fetch full agent details (DSL + IR) from the database so the debug
  // panel IR tab is populated the same way it is for fresh sessions.
  if (session.projectId && entryAgentName) {
    try {
      const dbAgent = await loadAgentFromDatabase(
        entryAgentName,
        session.projectId,
        session.tenantId,
      );
      if (dbAgent) return dbAgent.agent;
    } catch (err) {
      wsLog.warn('[WS] Could not load agent DSL for resumed session debug panel', {
        sessionId: session.id,
        agentName: entryAgentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fallback: build from in-memory IR (no DSL, but IR tab still works).
  const compilationAgents = session.compilationOutput?.agents as
    | Record<string, ResumeAgentIrLike>
    | undefined;
  const entryAgentIr = compilationAgents?.[entryAgentName];
  const agentIr = entryAgentIr ?? (session.agentIR as ResumeAgentIrLike | null) ?? null;
  const toolCount = Array.isArray(agentIr?.tools) ? agentIr.tools.length : 0;
  const gatherFieldCount = Array.isArray(agentIr?.gather?.fields)
    ? agentIr.gather.fields.length
    : 0;
  const isSupervisor =
    (Array.isArray(agentIr?.coordination?.handoffs) && agentIr.coordination.handoffs.length > 0) ||
    (Array.isArray(agentIr?.routing?.rules) && agentIr.routing.rules.length > 0);

  return {
    id: entryAgentName,
    name: entryAgentName,
    filePath: '',
    type: isSupervisor ? 'supervisor' : 'agent',
    mode: agentIr?.flow ? 'scripted' : 'reasoning',
    toolCount,
    gatherFieldCount,
    isSupervisor,
    dsl: '',
    ir: agentIr ?? undefined,
  };
}

/**
 * Handle session resumption after client reconnect.
 * Tries in-memory first (same pod), then rehydrates from SessionService (cross-pod).
 */
async function handleResumeSession(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'resume_session' }>,
): Promise<void> {
  const { sessionId } = message;
  const executor = getRuntimeExecutor();
  let persistedSession: Awaited<ReturnType<typeof findSessionById>> = null;
  let resumedConversationHistory: ResumedConversationMessage[] | null = null;
  const sessionLocator = buildWsSessionLocator(sessionId, clients.get(ws));

  // 1. Try same-pod in-memory lookup
  let runtimeSession = executor.getSession(sessionId);
  if (runtimeSession && !ensureWsSessionAccess(ws, sessionId, runtimeSession, 'resume_session')) {
    send(ws, {
      type: 'session_expired',
      sessionId,
      reason: 'Session not found or expired',
      reasonCode: 'resume_not_found',
    });
    return;
  }

  // 2. Try cross-pod rehydration from SessionService (Redis/memory store)
  if (!runtimeSession) {
    const rehydratedSession =
      (await executor.rehydrateSession(
        sessionId,
        sessionLocator ? { locator: sessionLocator } : undefined,
      )) ?? undefined;
    if (rehydratedSession) {
      if (!ensureWsSessionAccess(ws, sessionId, rehydratedSession, 'resume_session')) {
        send(ws, {
          type: 'session_expired',
          sessionId,
          reason: 'Session not found or expired',
          reasonCode: 'resume_not_found',
        });
        return;
      }
      runtimeSession = rehydratedSession;
    }
  }

  // 3. DB fallback — rebuild runtime session from persisted data
  if (!runtimeSession && isDatabaseAvailable()) {
    const tenantId = clients.get(ws)?.tenantId;
    if (!tenantId) {
      // Cannot safely query without tenant context
      send(ws, {
        type: 'session_expired',
        sessionId,
        reason: 'Session not found or expired',
        reasonCode: 'resume_not_found',
      });
      return;
    }
    try {
      const dbSession = await findSessionById(sessionId, tenantId);
      persistedSession = dbSession;
      if (dbSession && dbSession.projectId && dbSession.tenantId) {
        if (!ensureWsSessionAccess(ws, sessionId, dbSession, 'resume_session')) {
          send(ws, {
            type: 'session_expired',
            sessionId,
            reason: 'Session not found or expired',
            reasonCode: 'resume_not_found',
          });
          return;
        }

        const project = await findProjectWithAgents(dbSession.projectId, dbSession.tenantId);
        if (project && project.agents.length > 0) {
          const readiness = await evaluateProjectExecutionReadiness({
            agents: project.agents,
            tenantId: dbSession.tenantId,
            projectId: dbSession.projectId,
            runtimeConfig: await findProjectRuntimeConfig(dbSession.projectId, dbSession.tenantId),
            lazyBackfill: true,
          });
          if (readiness.hasBlockingErrors) {
            wsLog.warn('Refusing websocket working-copy resume for project with readiness errors', {
              tenantId: dbSession.tenantId,
              projectId: dbSession.projectId,
              sessionId,
              issueKinds: readiness.issues.map((issue) => issue.kind),
              blockedAgents: readiness.blockedAgents,
            });
            send(ws, {
              type: 'session_expired',
              sessionId,
              reason: buildProjectDslReadinessError(),
              reasonCode: 'project_dsl_not_ready',
            });
            return;
          }

          const allAgentSources = buildProjectWorkingCopyAgentSources(
            (readiness.executableAgents ?? []) as Array<{
              name?: unknown;
              dslContent?: unknown;
              systemPromptLibraryRef?: unknown;
            }>,
          );

          if (allAgentSources.length > 0) {
            const entryAgentName = dbSession.entryAgentName || project.agents[0].name;
            const compileResult = await compileProjectWorkingCopy({
              tenantId: dbSession.tenantId,
              projectId: dbSession.projectId,
              entryAgentName,
              environment: 'dev',
              agents: allAgentSources,
            });
            const resumeConfigVariables =
              Object.keys(compileResult.configVariables).length > 0
                ? compileResult.configVariables
                : undefined;

            const resumeCallerCtx = buildCallerContext({
              tenantId: dbSession.tenantId || 'debug',
              channel: 'web_debug',
              initiatedById: clients.get(ws)?.userId,
              identityTier: 0,
              verificationMethod: 'none',
            });
            runtimeSession = executor.createSessionFromResolved(compileResult.resolved, {
              sessionId, // preserve original session ID across reconnects
              tenantId: dbSession.tenantId,
              projectId: dbSession.projectId,
              authToken: clients.get(ws)?.authToken,
              userId: clients.get(ws)?.userId,
              callerContext: resumeCallerCtx,
              ...createJitAuthCallbacks(ws, {
                tenantId: dbSession.tenantId,
                userId: clients.get(ws)?.userId,
              }),
            });
            storeRuntimeSessionLocalizationCatalog(
              runtimeSession,
              buildSessionLocalizationCatalog(resumeConfigVariables),
            );

            // Restore conversation history from DB messages
            const dbMessages = await findMessagesForSession(dbSession.id, 200, dbSession.tenantId);
            if (dbMessages.length > 0) {
              resumedConversationHistory =
                buildResumedConversationHistoryFromPersistedMessages(dbMessages);
              runtimeSession.conversationHistory = dbMessages
                .filter((m: any) => m.role === 'user' || m.role === 'assistant')
                .map((m: any) => ({
                  role: m.role,
                  content: m.rawContent ?? m.content,
                  ...(m.metadata ? { metadata: m.metadata } : {}),
                  ...(m.contentEnvelope ? { contentEnvelope: m.contentEnvelope } : {}),
                }));
            }

            // Mark as initialized (ON_START already ran in original session)
            runtimeSession.initialized = true;

            wsLog.info(
              `[WS] Session rebuilt from DB: ${sessionId} (${runtimeSession.conversationHistory.length} messages)`,
            );
          }
        }
      }
    } catch (err) {
      wsLog.warn('[WS] DB session rebuild failed', {
        error:
          err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err),
      });
    }
  }

  // 4. Session not found anywhere — truly expired
  if (!runtimeSession) {
    send(ws, {
      type: 'session_expired',
      sessionId,
      reason: 'Session not found or expired',
      reasonCode: 'resume_not_found',
    });
    return;
  }

  // 4b. Fail-closed tenant + user ownership check
  if (!ensureWsSessionAccess(ws, sessionId, runtimeSession, 'resume_session')) {
    send(ws, {
      type: 'session_expired',
      sessionId,
      reason: 'Session not found or expired',
      reasonCode: 'resume_not_found',
    });
    return;
  }

  bindJitAuthCallbacksToSession(ws, runtimeSession);

  if (!persistedSession && isDatabaseAvailable() && runtimeSession.tenantId) {
    try {
      persistedSession = await findSessionById(runtimeSession.id, runtimeSession.tenantId);
    } catch (err) {
      wsLog.warn('[WS] Failed to rebind persisted debug session during resume', {
        sessionId: runtimeSession.id,
        tenantId: runtimeSession.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const persistedProjectId =
    typeof persistedSession?.projectId === 'string' ? persistedSession.projectId : undefined;
  const persistedTenantId =
    typeof persistedSession?.tenantId === 'string' ? persistedSession.tenantId : undefined;
  const resumeProjectId = runtimeSession.projectId ?? persistedProjectId;
  const resumeTenantId = runtimeSession.tenantId ?? persistedTenantId;

  if (resumeProjectId && !runtimeSession.projectId) {
    runtimeSession.projectId = resumeProjectId;
  }
  if (resumeTenantId && !runtimeSession.tenantId) {
    runtimeSession.tenantId = resumeTenantId;
  }

  if (
    persistedSession?.id &&
    persistedProjectId &&
    resumeProjectId &&
    persistedProjectId !== resumeProjectId
  ) {
    wsLog.warn('[WS] Refusing to bind resumed debug session to mismatched persisted project', {
      sessionId: runtimeSession.id,
      persistedProjectId,
      runtimeProjectId: resumeProjectId,
      tenantId: resumeTenantId,
    });
    persistedSession = null;
  }

  // 5. Update ClientState for this WS connection (use runtimeSession.id — may differ from original sessionId if rebuilt)
  const effectiveSessionId = runtimeSession.id;
  const state = clients.get(ws);
  const previousSessionId = state ? getBoundSessionId(state) : undefined;
  if (state?._wsConnectionId) {
    unregisterSession(state._wsConnectionId, previousSessionId);
  }
  if (previousSessionId && previousSessionId !== effectiveSessionId) {
    unregisterSessionWebSocket(previousSessionId);
    if (state?._wsContactId) {
      unregisterSessionWebSocket(state._wsContactId);
    }
  }

  const connectionId = `ws-${effectiveSessionId}-${Date.now()}`;
  registerSession(connectionId, effectiveSessionId, ws);
  registerSessionWebSocket(effectiveSessionId, ws);
  const rawResumedContactId =
    typeof runtimeSession.callerContext?.contactId === 'string'
      ? runtimeSession.callerContext.contactId
      : effectiveSessionId;
  const resumedContactId = runtimeSession.tenantId
    ? `${runtimeSession.tenantId}:${rawResumedContactId}`
    : rawResumedContactId;
  if (resumedContactId) {
    registerSessionWebSocket(resumedContactId, ws);
  }

  if (state) {
    state.sessionId = effectiveSessionId;
    state.runtimeSession = runtimeSession;
    state.projectId = resumeProjectId;
    state.tenantId = resumeTenantId;
    state._wsContactId = resumedContactId;
    state._wsConnectionId = connectionId;
    state.traceId = crypto.randomUUID().replace(/-/g, '');

    if (persistedSession?.id) {
      state.dbSessionId = persistedSession.id;
      state.pendingDbSession = undefined;
      wsLog.info('[WS] Rebound resumed debug session to persisted DB session', {
        sessionId: effectiveSessionId,
        dbSessionId: persistedSession.id,
        projectId: persistedProjectId ?? resumeProjectId,
        tenantId: persistedTenantId ?? resumeTenantId,
      });
    } else if (resumeProjectId && resumeTenantId) {
      state.dbSessionId = undefined;
      state.pendingDbSession = {
        agentName: runtimeSession.agentName,
        agentVersion: resolvePersistedAgentVersion(
          runtimeSession.versionInfo,
          runtimeSession.agentName,
        ),
        sessionId: effectiveSessionId,
        entryAgentName: runtimeSession.threads?.[0]?.agentName ?? runtimeSession.agentName,
        deploymentId: runtimeSession.versionInfo?.deploymentId,
        projectId: resumeProjectId,
        tenantId: resumeTenantId,
      };

      const hasVisibleConversation = runtimeSession.conversationHistory.some(
        (entry) => entry.role === 'user' || entry.role === 'assistant',
      );
      if (hasVisibleConversation) {
        await ensureDebugDbSession(state);
      }

      if (state.dbSessionId) {
        wsLog.info('[WS] Materialized debug DB session during resume for durable visibility', {
          sessionId: effectiveSessionId,
          dbSessionId: state.dbSessionId,
          projectId: resumeProjectId,
          tenantId: resumeTenantId,
          historyMessages: runtimeSession.conversationHistory.length,
        });
      } else {
        wsLog.warn('[WS] Resumed debug session without a persisted DB binding', {
          sessionId: effectiveSessionId,
          projectId: resumeProjectId,
          tenantId: resumeTenantId,
          historyMessages: runtimeSession.conversationHistory.length,
        });
      }
    } else {
      state.dbSessionId = undefined;
      state.pendingDbSession = undefined;
      wsLog.warn('[WS] Resumed debug session without enough scope to bind persistence', {
        sessionId: effectiveSessionId,
        projectId: resumeProjectId,
        tenantId: resumeTenantId,
      });
    }

    const tenantCfg3 = await getTenantConfigService()
      .getConfigAsync(resumeTenantId ?? '')
      .catch(() => null);
    state.traceEmitter = createTraceEmitter({
      sessionId: effectiveSessionId,
      ws,
      tenantId: resumeTenantId,
      projectId: resumeProjectId,
      deploymentId: runtimeSession.versionInfo?.deploymentId,
      environment: runtimeSession.versionInfo?.environment,
      agentVersions: resolveAgentVersionsForTrace(runtimeSession),
      scrubPII: tenantCfg3?.security?.scrubPII ?? true,
      piiRecognizerRegistry: runtimeSession.piiRecognizerRegistry,
      customDimensions: runtimeSession.customDimensions,
      sessionRef: runtimeSession,
      moduleProvenanceMap: runtimeSession.moduleProvenance,
    });
  } else {
    wsLog.warn('[WS] Client state missing while rebinding resumed session', {
      sessionId: effectiveSessionId,
    });
  }

  await reactivatePersistedSessionSummary(runtimeSession.id, runtimeSession.tenantId);

  getTraceStore().setSessionAgent(effectiveSessionId, runtimeSession.agentName);

  if (!resumedConversationHistory && persistedSession?.id && persistedSession.tenantId) {
    try {
      const persistedMessages = await findMessagesForSession(
        persistedSession.id,
        200,
        persistedSession.tenantId,
      );
      if (persistedMessages.length > 0) {
        resumedConversationHistory =
          buildResumedConversationHistoryFromPersistedMessages(persistedMessages);
      }
    } catch (err) {
      wsLog.warn('[WS] Failed to load persisted message history for resume hydration', {
        sessionId: effectiveSessionId,
        tenantId: persistedSession.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 6. Build state snapshot and conversation history for client restore
  const agentState: import('../types/index.js').AgentState = {
    gatherProgress: runtimeSession.state.gatherProgress,
    context: runtimeSession.state.context,
    conversationPhase: runtimeSession.state.conversationPhase,
    constraintResults: {},
    lastToolResults: {},
    memory: {
      session: {},
      persistentCache: {},
      pendingRemembers: [],
    },
    activeAgent: runtimeSession.state.activeAgent,
  };

  const conversationHistory =
    resumedConversationHistory ?? buildResumedConversationHistoryFromRuntime(runtimeSession);

  const resumedAgent = await buildResumedAgentDetails(runtimeSession);
  send(
    ws,
    ServerMessages.sessionResumed(
      effectiveSessionId,
      agentState,
      conversationHistory,
      resumedAgent,
    ),
  );
  wsLog.info(
    `[WS] Session resumed: ${effectiveSessionId} (${conversationHistory.length} messages)`,
  );

  try {
    const traceReadOptions = resumeTenantId ? { tenantId: resumeTenantId } : undefined;
    const replay = await Promise.resolve(
      getTraceStore().readSince(effectiveSessionId, message.lastSeenTraceEventId, traceReadOptions),
    );
    send(ws, {
      type: 'trace_replay',
      sessionId: effectiveSessionId,
      events: replay.events as TraceEventWithId[],
      totalBuffered: replay.totalBuffered,
      source: 'resume',
      afterEventId: replay.afterEventId,
      snapshotRequired: replay.snapshotRequired,
    });
  } catch (err) {
    wsLog.warn('[WS] Failed to prepare resume trace replay', {
      sessionId: effectiveSessionId,
      lastSeenTraceEventId: message.lastSeenTraceEventId,
      error: err instanceof Error ? err.message : String(err),
    });
    send(ws, {
      type: 'trace_replay',
      sessionId: effectiveSessionId,
      events: [],
      totalBuffered: 0,
      source: 'resume',
      afterEventId: message.lastSeenTraceEventId,
      snapshotRequired: true,
    });
  }

  try {
    await activateAuthGateIfRequired(
      ws,
      effectiveSessionId,
      runtimeSession,
      clients.get(ws)?.userId ?? runtimeSession.userId,
    );
  } catch (err) {
    wsLog.warn('[WS] Auth preflight re-check on resume failed; blocking session resume', {
      sessionId: effectiveSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    send(
      ws,
      ServerMessages.error(
        'Authentication preflight is temporarily unavailable. Please retry in a moment.',
      ),
    );
    return;
  }

  // Deliver any pending results that were stored while the client was disconnected
  try {
    const asyncInfra = (getRuntimeExecutor() as any)._asyncInfra;
    if (asyncInfra?.pendingDeliveryStore) {
      const pending = await asyncInfra.pendingDeliveryStore.retrieve(effectiveSessionId);
      if (pending.length > 0) {
        for (const entry of pending) {
          const result = entry.result;
          if (!result) {
            continue;
          }
          const response = typeof result.response === 'string' ? result.response : '';
          const hasRenderablePayload =
            response.trim().length > 0 ||
            (result.richContent &&
              typeof result.richContent === 'object' &&
              Object.keys(result.richContent).length > 0) ||
            result.actions !== undefined ||
            result.voiceConfig !== undefined;
          if (!hasRenderablePayload) {
            continue;
          }

          const msgId = crypto.randomUUID();
          const executionId =
            typeof entry.executionId === 'string'
              ? entry.executionId
              : typeof result.executionId === 'string'
                ? result.executionId
                : `exec-${crypto.randomUUID()}`;
          send(ws, ServerMessages.responseStart(effectiveSessionId, msgId, executionId));
          if (response) {
            send(
              ws,
              ServerMessages.responseChunk(
                effectiveSessionId,
                msgId,
                response,
                result.richContent as import('@abl/compiler').RichContentIR | undefined,
                result.actions as import('@abl/compiler').ActionSetIR | undefined,
              ),
            );
          }
          send(
            ws,
            ServerMessages.responseEnd(
              effectiveSessionId,
              msgId,
              response,
              result.voiceConfig as import('@abl/compiler').VoiceConfigIR | undefined,
              result.richContent as import('@abl/compiler').RichContentIR | undefined,
              result.actions as import('@abl/compiler').ActionSetIR | undefined,
              executionId,
              result.responseMetadata,
              result.localization,
              result.citations as import('../types/index.js').Citation[] | undefined,
            ),
          );
        }
        await asyncInfra.pendingDeliveryStore.remove(effectiveSessionId);
        wsLog.info(
          `[WS] Delivered ${pending.length} pending result(s) for session ${effectiveSessionId}`,
        );
      }
    }
  } catch (pendingErr) {
    wsLog.warn('[WS] Failed to deliver pending results', {
      error: pendingErr instanceof Error ? pendingErr.message : String(pendingErr),
    });
  }
}

// =============================================================================
// TEST CONTEXT HANDLERS
// =============================================================================

const WRITE_ROLES = ['OWNER', 'ADMIN', 'OPERATOR'];

/**
 * Check if the client state represents a debug session with write permissions.
 * Context injection is only allowed for debug sessions with WRITE_ROLES.
 */
function canInjectContext(state: ClientState): boolean {
  const role = state.tenantContext?.role;
  return !!role && WRITE_ROLES.includes(role);
}

/**
 * Apply test context to a runtime session (used by both load_agent_with_context and inject_context).
 * Writes gather values, session variables, and sets up tool mocks.
 */
function applyTestContext(
  session: RuntimeSession,
  context: TestContextPayload,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): void {
  const injectedKeys: string[] = [];

  // Pre-fill gather values → mark as gathered
  if (context.gatherValues) {
    for (const [key, value] of Object.entries(context.gatherValues)) {
      session.data.values[key] = value;
      session.data.gatheredKeys.add(key);
      injectedKeys.push(key);
    }
  }

  // Set session variables (not marked as gathered)
  if (context.sessionVariables) {
    for (const [key, value] of Object.entries(context.sessionVariables)) {
      session.data.values[key] = value;
      injectedKeys.push(key);
    }
  }

  // Caller context overrides
  if (context.callerContext) {
    if (context.callerContext.userId) session.userId = context.callerContext.userId;
    if (context.callerContext.customAttributes) {
      for (const [key, value] of Object.entries(context.callerContext.customAttributes)) {
        session.data.values[key] = value;
      }
      // Validate and populate customDimensions for analytics extraction
      mergeSessionDimensions(session, context.callerContext.customAttributes);
    }
  }

  // Tool mocks
  if (context.toolMocks && context.toolMocks.length > 0) {
    session.toolMocks = context.toolMocks;
    wrapExecutorWithMocks(session, context.toolMocks, onTraceEvent);
  }

  // Skip ON_START
  if (context.skipOnStart) {
    session.initialized = true;
  }

  // Start at specific step (scripted only)
  if (context.startAtStep && session.agentIR?.flow) {
    session.currentFlowStep = context.startAtStep;
    // Also update the active thread
    if (session.threads.length > 0) {
      const activeThread = session.threads[session.activeThreadIndex];
      if (activeThread) {
        activeThread.currentFlowStep = context.startAtStep;
      }
    }
  }

  // Emit trace event
  if (onTraceEvent && injectedKeys.length > 0) {
    onTraceEvent({
      type: 'engine_decision',
      data: {
        decision: 'context_injection',
        source: 'test_context',
        keys: injectedKeys,
        hasMocks: !!(context.toolMocks && context.toolMocks.length > 0),
        skipOnStart: !!context.skipOnStart,
        startAtStep: context.startAtStep,
      },
    });
  }
}

/**
 * Wrap a session's tool executor with MockToolExecutor.
 */
function wrapExecutorWithMocks(
  session: RuntimeSession,
  mocks: ToolMockConfig[],
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): void {
  if (!session.toolExecutor) return;

  // If already wrapped, just update mocks
  if (session.toolExecutor instanceof MockToolExecutor) {
    (session.toolExecutor as MockToolExecutor).setMocks(mocks);
    return;
  }

  // Wrap the real executor
  session.toolExecutor = new MockToolExecutor(
    session.toolExecutor,
    mocks,
    (toolName, params, mock) => {
      onTraceEvent?.({
        type: 'tool_call',
        data: {
          toolName,
          params,
          isMocked: true,
          mockSuccess: mock.success !== false,
          mockDelayMs: mock.delayMs,
        },
      });
    },
  );
}

/**
 * Handle load_agent_with_context: loads agent and applies test context before ON_START.
 */
async function handleLoadAgentWithContext(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'load_agent_with_context' }>,
): Promise<void> {
  const state = clients.get(ws);
  if (!state) return;

  // Permission check
  if (!canInjectContext(state)) {
    send(
      ws,
      ServerMessages.contextInjectionError('', {
        code: 'FORBIDDEN',
        message:
          'Insufficient permissions for test context injection. Requires OWNER, ADMIN, or OPERATOR role.',
      }),
    );
    return;
  }

  const { context } = message;
  const loadRequestId = claimLoadRequest(ws);
  if (loadRequestId === null) {
    return;
  }

  // First, load the agent using the standard handler (sends agent_loaded, creates session)
  await handleLoadAgentRequest(
    ws,
    {
      type: 'load_agent',
      agentPath: message.agentPath,
      projectId: message.projectId,
    },
    loadRequestId,
  );

  if (!isCurrentLoadRequest(ws, loadRequestId)) {
    return;
  }

  // Retrieve the newly created session
  const updatedState = clients.get(ws);
  const loadedSessionId = getBoundSessionId(updatedState);
  if (!loadedSessionId) {
    // Agent load failed — error already sent by handleLoadAgentRequest
    return;
  }

  const executor = getRuntimeExecutor();
  const session = executor.getSession(loadedSessionId);
  if (!session) return;

  if (!isCurrentLoadRequest(ws, loadRequestId)) {
    releaseStaleLoadedSession(ws, executor, loadedSessionId);
    return;
  }

  // Apply context before ON_START runs
  // Note: handleLoadAgent already called initializeAgent if needed,
  // but context.skipOnStart may have been set. If ON_START already ran and
  // skipOnStart was true, the session.initialized flag prevents re-run.
  const acc = createTraceAccumulator();
  const onTraceEvent = createOnTraceEvent(
    loadedSessionId,
    ws,
    acc,
    session.agentName,
    updatedState?.traceEmitter,
    session.tenantId,
  );

  applyTestContext(session, context, onTraceEvent);

  if (!isCurrentLoadRequest(ws, loadRequestId)) {
    releaseStaleLoadedSession(ws, executor, loadedSessionId);
    return;
  }

  // If skipOnStart was set AND agent had already been initialized by handleLoadAgent,
  // that's fine — the flag was set before initializeAgent checked it.
  // But if we need to re-initialize with the pre-filled context...
  // Actually, handleLoadAgent calls initializeAgent after the session is created.
  // Since we apply context AFTER handleLoadAgent, if there's an ON_START, it ran already.
  // For the skipOnStart case, we need a different approach:
  // Mark initialized=true before the agent init check.
  // This is handled in applyTestContext setting session.initialized = true.

  // Send updated state to reflect injected values
  const updatedSessionState = {
    gatherProgress: Object.fromEntries(
      [...session.data.gatheredKeys].map((k) => [k, session.data.values[k]]),
    ),
    context: { ...session.data.values },
    conversationPhase: session.state.conversationPhase,
  };
  send(
    ws,
    ServerMessages.stateUpdate(
      loadedSessionId,
      updatedSessionState as import('../types/index.js').AgentState,
      {},
    ),
  );

  // Audit
  auditTestSessionCreated(
    loadedSessionId,
    state.userId || 'anonymous',
    state.tenantId ?? 'anonymous',
    Object.keys(context.gatherValues || {}),
  ).catch((err: unknown) => {
    wsLog.warn('[WS] Audit test session created failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  wsLog.info(
    `[WS] Loaded agent with context: ${message.agentPath} (session: ${loadedSessionId}, keys: ${Object.keys(context.gatherValues || {}).length} gather, ${Object.keys(context.sessionVariables || {}).length} vars, ${(context.toolMocks || []).length} mocks)`,
  );
}

/**
 * Handle mid-session context injection.
 */
function handleInjectContext(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'inject_context' }>,
): void {
  const state = clients.get(ws);
  const { sessionId, injection } = message;

  if (!state || !canInjectContext(state)) {
    send(
      ws,
      ServerMessages.contextInjectionError(sessionId, {
        code: 'FORBIDDEN',
        message: 'Insufficient permissions for context injection',
      }),
    );
    return;
  }

  const session = getAuthorizedRuntimeSession(ws, sessionId, 'inject_context');
  if (!session) {
    send(
      ws,
      ServerMessages.contextInjectionError(sessionId, {
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${sessionId}`,
      }),
    );
    return;
  }

  const updatedValues: Record<string, unknown> = {};

  // Merge values
  if (injection.values) {
    for (const [key, value] of Object.entries(injection.values)) {
      session.data.values[key] = value;
      updatedValues[key] = value;
    }
  }

  // Mark keys as gathered
  if (injection.markAsGathered) {
    for (const key of injection.markAsGathered) {
      session.data.gatheredKeys.add(key);
    }
  }

  // Update tool mocks
  if (injection.toolMocks && injection.toolMocks.length > 0) {
    session.toolMocks = injection.toolMocks;
    const acc = createTraceAccumulator();
    const onTraceEvent = createOnTraceEvent(
      sessionId,
      ws,
      acc,
      session.agentName,
      state.traceEmitter,
      session.tenantId,
    );
    wrapExecutorWithMocks(session, injection.toolMocks, onTraceEvent);
  }

  // Force step (scripted mode)
  if (injection.forceStep && session.agentIR?.flow) {
    session.currentFlowStep = injection.forceStep;
    if (session.threads.length > 0) {
      const activeThread = session.threads[session.activeThreadIndex];
      if (activeThread) {
        activeThread.currentFlowStep = injection.forceStep;
      }
    }
  }

  // Send confirmation
  send(ws, ServerMessages.contextInjected(sessionId, updatedValues));

  // Send state update
  const updatedSessionState = {
    gatherProgress: Object.fromEntries(
      [...session.data.gatheredKeys].map((k) => [k, session.data.values[k]]),
    ),
    context: { ...session.data.values },
    conversationPhase: session.state.conversationPhase,
  };
  send(
    ws,
    ServerMessages.stateUpdate(
      sessionId,
      updatedSessionState as import('../types/index.js').AgentState,
      {},
    ),
  );

  // Audit
  auditContextInjected(
    sessionId,
    state.userId || 'anonymous',
    state.tenantId ?? 'anonymous',
    Object.keys(updatedValues),
    'websocket',
  ).catch((err: unknown) => {
    wsLog.warn('[WS] Audit context injected failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  wsLog.info(
    `[WS] Context injected: session=${sessionId}, keys=${Object.keys(updatedValues).join(',')}`,
  );
}

/**
 * Handle set_tool_mocks.
 */
function handleSetToolMocks(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'set_tool_mocks' }>,
): void {
  const state = clients.get(ws);
  const { sessionId, mocks } = message;

  if (!state || !canInjectContext(state)) {
    send(
      ws,
      ServerMessages.contextInjectionError(sessionId, {
        code: 'FORBIDDEN',
        message: 'Insufficient permissions for tool mocks',
      }),
    );
    return;
  }

  const session = getAuthorizedRuntimeSession(ws, sessionId, 'set_tool_mocks');
  if (!session) {
    send(
      ws,
      ServerMessages.contextInjectionError(sessionId, {
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${sessionId}`,
      }),
    );
    return;
  }

  session.toolMocks = mocks;
  const acc = createTraceAccumulator();
  const onTraceEvent = createOnTraceEvent(
    sessionId,
    ws,
    acc,
    session.agentName,
    state.traceEmitter,
    session.tenantId,
  );
  wrapExecutorWithMocks(session, mocks, onTraceEvent);

  send(ws, ServerMessages.toolMockSet(sessionId, mocks.length));

  // Audit
  auditToolMockSet(
    sessionId,
    state.userId || 'anonymous',
    state.tenantId ?? 'anonymous',
    mocks.length,
    mocks.map((m) => m.toolName),
  ).catch((err: unknown) => {
    wsLog.warn('[WS] Audit tool mock set failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  wsLog.info(`[WS] Tool mocks set: session=${sessionId}, count=${mocks.length}`);
}

/**
 * Handle clear_tool_mocks.
 */
function handleClearToolMocks(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'clear_tool_mocks' }>,
): void {
  const state = clients.get(ws);
  const { sessionId } = message;

  if (!state || !canInjectContext(state)) {
    send(
      ws,
      ServerMessages.contextInjectionError(sessionId, {
        code: 'FORBIDDEN',
        message: 'Insufficient permissions for tool mocks',
      }),
    );
    return;
  }

  const session = getAuthorizedRuntimeSession(ws, sessionId, 'clear_tool_mocks');
  if (!session) {
    send(
      ws,
      ServerMessages.contextInjectionError(sessionId, {
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${sessionId}`,
      }),
    );
    return;
  }

  session.toolMocks = undefined;
  // If wrapped in MockToolExecutor, we can't easily unwrap — set empty mocks
  if (session.toolExecutor instanceof MockToolExecutor) {
    (session.toolExecutor as MockToolExecutor).setMocks([]);
  }

  send(ws, ServerMessages.toolMockSet(sessionId, 0));
  wsLog.info(`[WS] Tool mocks cleared: session=${sessionId}`);
}

// =============================================================================
// FALLBACK RESPONSE (when no API key)
// =============================================================================

/**
 * Generate a fallback response when runtime is not configured
 */
function generateFallbackResponse(
  agent: AgentDetails,
  userInput: string,
): {
  text: string;
  action: import('../types/index.js').ConstructAction;
} {
  const input = userInput.toLowerCase();

  // Check for escalation keywords
  if (
    input.includes('human') ||
    input.includes('real person') ||
    input.includes('speak to someone')
  ) {
    return {
      text: "I understand you'd like to speak with a human agent. In a live system, I would transfer you now.",
      action: { type: 'escalate', reason: 'User request', priority: 'medium' },
    };
  }

  // Check for goodbye
  if (input.match(/\b(bye|goodbye|thanks|thank you|that's all|done)\b/)) {
    return {
      text: 'Thank you for chatting with me! Have a great day!',
      action: { type: 'complete', message: 'Conversation completed' },
    };
  }

  // Default fallback response
  return {
    text:
      `Hello! I'm **${agent.name.replace(/_/g, ' ')}**.\n\n` +
      `⚠️ **Note:** No model credentials are configured for this tenant, so I'm running in fallback mode.\n\n` +
      `To enable real AI interactions:\n` +
      `1. Configure a TenantModel with credentials in the Model Hub\n` +
      `2. Ensure the project has a ModelConfig linked to the tenant model\n\n` +
      `Once configured, I'll use the real Agent ABL runtime engine for intelligent conversations!`,
    action: { type: 'continue' },
  };
}

/**
 * Handle action_submit: process a UI action (button click, select change, form submit)
 * from the chat widget. Validates session ownership and input before forwarding
 * to the runtime executor.
 */
async function handleActionSubmit(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'action_submit' }>,
): Promise<void> {
  const { sessionId, actionId, value, formData, renderId } = message;

  // --- Input validation ---
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) {
    send(ws, ServerMessages.error('Invalid sessionId in action_submit'));
    return;
  }
  const actionEnvelope = validateActionSubmitEnvelope({
    actionId,
    value,
    formData,
    formDataPresent: formData !== undefined,
    renderId,
  });
  if (!actionEnvelope.ok) {
    send(ws, ServerMessages.error(actionEnvelope.message));
    return;
  }

  // --- Session ownership validation ---
  const clientState = clients.get(ws);
  if (!clientState || !ensureWsSessionBinding(ws, sessionId, 'action_submit')) {
    send(ws, ServerMessages.error('Session not found'));
    return;
  }

  const boundSessionId = getBoundSessionId(clientState);
  if (!boundSessionId) {
    send(ws, ServerMessages.error('No active session'));
    return;
  }

  // --- Tenant ownership (fail-closed) ---
  const runtimeSession =
    clientState.runtimeSession ?? getRuntimeExecutor().getSession(boundSessionId);
  if (runtimeSession) {
    if (!ensureWsSessionAccess(ws, sessionId, runtimeSession, 'action_submit')) {
      send(ws, ServerMessages.error('Session not found'));
      return;
    }
  }

  // --- Execute action ---
  const executor = getRuntimeExecutor();
  if (!executor.isConfigured()) {
    send(ws, ServerMessages.error('Runtime not configured'));
    return;
  }

  if (!clientState.dbSessionId) {
    await ensureDebugDbSession(clientState);
  }

  const responseMessageId = crypto.randomUUID();
  const actionExecutionId = `exec-${crypto.randomUUID()}`;
  send(ws, ServerMessages.responseStart(sessionId, responseMessageId, actionExecutionId));

  try {
    const acc = createTraceAccumulator();
    const allChunks: string[] = [];
    const onChunk = (chunk: string) => {
      allChunks.push(chunk);
      send(ws, ServerMessages.responseChunk(sessionId, responseMessageId, chunk));
    };
    const runtimeSessionForTrace =
      clientState.runtimeSession ?? getRuntimeExecutor().getSession(boundSessionId);

    const actionTraceId = clientState.traceId || crypto.randomUUID().replace(/-/g, '');
    const actionSpanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const result = await runWithObservabilityContext(
      { traceId: actionTraceId, spanId: actionSpanId },
      () =>
        executor.executeMessage(
          boundSessionId,
          '',
          onChunk,
          createOnTraceEvent(
            sessionId,
            ws,
            acc,
            runtimeSessionForTrace?.agentName,
            clientState.traceEmitter,
            runtimeSessionForTrace?.tenantId,
            actionExecutionId,
          ),
          {
            actionEvent: { actionId, value, formData, renderId, source: 'websocket' },
            sessionLocator: buildWsSessionLocator(boundSessionId, clientState) ?? undefined,
          },
        ),
    );
    const outcome = buildExecutionOutcome({
      channelType: 'web_debug',
      result,
      streamedText: allChunks.length > 0 ? allChunks.join('') : undefined,
      session: executor.getSession(boundSessionId) ?? clientState.runtimeSession,
    });
    const responseMetadata = withAgentNameMetadata(
      outcome.responseMetadata ??
        result.responseMetadata ??
        buildResponseMessageMetadata(acc.responseProvenance),
      clientState.runtimeSession?.agentName,
    );
    const assistantStructuredContent = buildPersistedAssistantStructuredContent(outcome);

    send(
      ws,
      ServerMessages.responseEnd(
        sessionId,
        responseMessageId,
        outcome.responseText,
        outcome.voiceConfig || undefined,
        outcome.richContent || undefined,
        outcome.actions || undefined,
        actionExecutionId,
        responseMetadata,
        outcome.localization,
        result.citations,
      ),
    );

    if (clientState.dbSessionId && hasRenderableChannelOutcome(outcome)) {
      persistMessage(
        clientState.dbSessionId,
        'assistant',
        outcome.responseText,
        'web_debug',
        clientState.tenantId,
        undefined,
        undefined,
        clientState.projectId,
        Date.now(),
        assistantStructuredContent,
        responseMetadata,
      ).catch((err: unknown) =>
        wsLog.warn('[WS] Action assistant message persist failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    wsLog.error('Action submit execution error', {
      sessionId,
      actionId,
      error: errorMessage,
    });
    send(
      ws,
      ServerMessages.responseEnd(
        sessionId,
        responseMessageId,
        'Sorry, I encountered an error processing that action.',
        undefined,
        undefined,
        undefined,
        actionExecutionId,
      ),
    );
  }
}

/**
 * Handle consent_satisfy: mark a connector as authorized, update auth gate,
 * and replay queued messages when all connectors are satisfied.
 */
function handleConsentSatisfy(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'consent_satisfy' }>,
): void {
  const { sessionId, authProfileRef, requirementKey } = message;
  const clientState = clients.get(ws);
  const runtimeSid = getBoundSessionId(clientState);

  if (!authProfileRef || !runtimeSid) {
    send(ws, ServerMessages.error('Missing authProfileRef or session'));
    return;
  }

  // Validate session ownership — the WS connection must own the session
  if (sessionId && !ensureWsSessionBinding(ws, sessionId, 'consent_satisfy')) {
    send(ws, ServerMessages.error('Session not found'));
    return;
  }

  const runtimeSession = clientState?.runtimeSession ?? getRuntimeExecutor().getSession(runtimeSid);
  if (runtimeSession && !ensureWsSessionAccess(ws, runtimeSid, runtimeSession, 'consent_satisfy')) {
    send(ws, ServerMessages.error('Session not found'));
    return;
  }
  if (!runtimeSession?.compilationOutput) {
    send(ws, ServerMessages.error('No auth gate found for this session'));
    return;
  }

  const tokenLookups = createTokenLookups(
    runtimeSession.tenantId,
    runtimeSession.projectId,
    runtimeSession.versionInfo?.environment,
  );

  void evaluateAuthPreflightFromIR(
    runtimeSession.compilationOutput,
    {
      sessionId: runtimeSid,
      userId: runtimeSession.userId ?? clientState?.userId,
      tenantId: runtimeSession.tenantId,
      projectId: runtimeSession.projectId,
      environment: runtimeSession.versionInfo?.environment,
    },
    tokenLookups,
    runtimeSession.agentName ? { agentNames: [runtimeSession.agentName] } : undefined,
  )
    .then(async (evaluation) => {
      const result = await reconcileAuthGateWithEvaluationAsync(runtimeSid, evaluation);
      if (!result) {
        send(ws, ServerMessages.error('No auth gate found for this session'));
        return;
      }

      if (result.allSatisfied) {
        send(ws, ServerMessages.authGateSatisfied(clientState?.sessionId || sessionId));
        emitAuthLifecycleTrace(ws, {
          sessionId: runtimeSid,
          decision: 'gate_satisfied',
          queuedMessageCount: result.queuedMessages.length,
          traceId: clientState?.traceId,
          spanId: clientState?.traceEmitter?.getCurrentSpanId(),
          agentName: runtimeSession.agentName,
        });
        if (runtimeSession.currentFlowStep || runtimeSession.agentIR?.on_start) {
          try {
            await initializeAgent(ws, runtimeSid, runtimeSession);
          } catch (err) {
            wsLog.error('Failed to run ON_START before replaying queued messages', {
              sessionId: runtimeSid,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        for (const queued of result.queuedMessages) {
          try {
            await handleSendMessage(ws, {
              type: 'send_message',
              sessionId: clientState?.sessionId || sessionId,
              text: queued.text,
              attachmentIds: queued.attachmentIds,
            });
          } catch (err) {
            wsLog.error('Failed to replay queued message after auth gate satisfied', {
              error: err instanceof Error ? err.message : String(err),
              sessionId: clientState?.sessionId,
            });
          }
        }
        return;
      }

      send(
        ws,
        ServerMessages.authGateUpdated(
          clientState?.sessionId || sessionId,
          result.state.pending,
          result.state.satisfied,
        ),
      );
      emitAuthLifecycleTrace(ws, {
        sessionId: runtimeSid,
        decision: 'gate_updated',
        pending: result.state.pending,
        satisfied: result.state.satisfied,
        traceId: clientState?.traceId,
        spanId: clientState?.traceEmitter?.getCurrentSpanId(),
        agentName: runtimeSession.agentName,
      });

      const pendingRequirement = result.state.pending.find(
        (pending) =>
          pending.requirementKey === requirementKey ||
          (!requirementKey && pending.authProfileRef === authProfileRef),
      );
      if (pendingRequirement) {
        const connectionModeLabel =
          pendingRequirement.connectionMode === 'shared' ? 'shared' : 'per-user';
        send(
          ws,
          ServerMessages.error(
            `Authorization for "${authProfileRef}" (${connectionModeLabel}) is still pending. Complete the OAuth flow and try again.`,
          ),
        );
      }
    })
    .catch((err) => {
      wsLog.warn('Failed to re-evaluate auth gate after consent signal', {
        sessionId: runtimeSid,
        authProfileRef,
        error: err instanceof Error ? err.message : String(err),
      });
      send(ws, ServerMessages.error('Failed to verify updated authorization state'));
    });
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Send a message to a WebSocket client
 */
function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(serializeServerMessage(message));
  }
}

/**
 * Split text into chunks
 */
function chunkText(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// FORK SESSION
// =============================================================================

/**
 * Handle JIT auth response from client (Phase 5).
 * Resolves or rejects the paused tool execution based on user action.
 */
async function handleAuthResponse(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'auth_response' }>,
): Promise<void> {
  const { toolCallId, status } = message;
  const store = getPausedExecutionStore();

  // Validate session ownership — prevent cross-session auth_response spoofing
  const clientState = clients.get(ws);
  const clientSessionId = getBoundSessionId(clientState);
  const pausedData = store.get(toolCallId);
  if (pausedData && clientSessionId && pausedData.sessionId !== clientSessionId) {
    reportWsAccessDenied(ws, {
      messageType: 'auth_response',
      sessionId: pausedData.sessionId,
      reasonCode: 'CLIENT_SESSION_BINDING_MISMATCH',
      reason: 'Session not found',
      concealAsNotFound: true,
      statusCode: 404,
      scope: 'user',
      metadata: {
        toolCallId,
        expectedSessionId: pausedData.sessionId,
        actualSessionId: clientSessionId,
      },
    });
    wsLog.warn('Auth response rejected — session ownership mismatch', {
      toolCallId,
      expectedSessionId: pausedData.sessionId,
      actualSessionId: clientSessionId,
    });
    return;
  }

  const sessionId = clientSessionId ?? pausedData?.sessionId;
  if (!sessionId) {
    wsLog.warn('Auth response rejected — session context missing', { toolCallId, status });
    return;
  }

  if (!(await hasAuthorizedSessionAccess(ws, sessionId, 'auth_response'))) {
    return;
  }

  const result =
    status === 'completed'
      ? await store.resolveDistributed(sessionId, toolCallId)
      : await store.rejectDistributed(sessionId, toolCallId, 'cancelled');

  if (result === 'missing') {
    wsLog.warn('Auth response rejected — paused execution not found', {
      toolCallId,
      sessionId,
      status,
    });
    send(
      ws,
      ServerMessages.error(
        'Authorization could not be applied because the paused tool execution was no longer available. Please retry the tool call.',
      ),
    );
    return;
  }

  if (result === 'delivery_failed' || result === 'unavailable') {
    wsLog.warn('Auth response could not be delivered to paused execution owner', {
      toolCallId,
      sessionId,
      status,
      result,
    });
    send(
      ws,
      ServerMessages.error(
        'Authorization completed, but the paused tool execution could not be resumed. Please retry the tool call.',
      ),
    );
    return;
  }

  wsLog.info('Auth response received', { toolCallId, status });
}

async function handleForkSession(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'fork_session' }>,
): Promise<void> {
  const state = clients.get(ws);
  if (!state) return;

  const { sessionId, threadIndex } = message;
  if (!sessionId) {
    send(ws, ServerMessages.error('Missing sessionId for fork'));
    return;
  }

  try {
    const executor = getRuntimeExecutor();
    const svc = executor.sessionService;
    if (!svc) {
      send(ws, ServerMessages.error('Session service not initialized'));
      return;
    }

    const sessionData = await svc.store.load(sessionId);
    if (!sessionData) {
      // Return 404-equivalent (not found) to avoid leaking existence
      send(ws, ServerMessages.error(`Session ${sessionId} not found`));
      return;
    }

    // Fail-closed tenant + user ownership check
    if (!ensureWsSessionAccess(ws, sessionId, sessionData, 'fork_session')) {
      send(ws, ServerMessages.error(`Session ${sessionId} not found`));
      return;
    }

    const { forkSession } = await import('../services/session/session-operations.js');
    const result = await forkSession(svc, sessionData, {
      forkAtThreadIndex: threadIndex,
    });

    send(ws, {
      type: 'session_forked',
      sessionId: result.sessionId,
      parentSessionId: result.parentSessionId,
      forkPoint: result.forkPoint,
    });
  } catch (err) {
    wsLog.error('fork session failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    send(
      ws,
      ServerMessages.error(`Fork failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}
