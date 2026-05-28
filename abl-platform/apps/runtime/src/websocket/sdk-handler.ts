/**
 * SDK WebSocket Handler
 *
 * Handles WebSocket connections from embedded SDK widgets.
 * Validates issued SDK session tokens and connects to the actual agent runtime.
 */

import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import crypto from 'crypto';
import {
  getRuntimeExecutor,
  compileToResolvedAgent,
  resolveProjectTools,
  type RuntimeSession,
} from '../services/runtime-executor.js';
import {
  enqueueLLMRequest,
  BackpressureError,
  isLLMQueueEnabled,
} from '../services/llm/llm-queue.js';
import {
  getExecutionCoordinator,
  isCoordinatorAvailable,
} from '../services/execution/coordinator-singleton.js';
import { isLlmError } from '../services/llm/classify-llm-error.js';
import { isDatabaseAvailable } from '../db/index.js';
import { getConfig } from '../config/index.js';
import { getStores } from '../services/stores/store-factory.js';
import { mergeSessionDimensions } from '../services/metadata/custom-dimensions.js';
import {
  persistMessage,
  persistMessageRecord,
  persistScopedMessage,
  persistScopedTurnMetrics,
  persistTurnMetrics,
  flushMessageQueue,
} from '../services/message-persistence-queue.js';
import type { MessageMetadata } from '@abl/compiler/platform/core/types';
import {
  buildContactProductionExecutionScope,
  buildRequiredContactProductionExecutionScope,
  requiresCanonicalContactProductionScope,
} from '../services/session/execution-scope-factory.js';
import {
  createRuntimeSession,
  resolveEnvironmentLabel,
  resolveSessionTimeouts,
} from '../channels/pipeline/session-factory.js';

import {
  findProjectRuntimeConfig,
  findProjectWithAgents,
  resolveProjectEntryAgentName,
} from '../repos/project-repo.js';
import { updateSession as updateDbSessionFields } from '../repos/session-repo.js';
import { getFeedbackService } from '../services/feedback/feedback-service-singleton.js';
import {
  FeedbackSubmitSchema,
  isFeedbackActionId,
  normaliseActionSubmit,
  normaliseFeedbackSubmit,
  type FeedbackSubmission,
} from '../services/feedback/types.js';
import { createLogger } from '@abl/compiler/platform';
import {
  getCurrentTraceId,
  runWithObservabilityContext,
} from '@abl/compiler/platform/observability';
import {
  extractSdkTicketFromProtocolHeader,
  extractSdkTokenFromProtocolHeader,
} from '@agent-platform/shared/websocket-auth';
import type { ResolvedAgent } from '../services/deployment-resolver.js';
import { getSessionService } from '../services/session/session-service.js';
import { applyCallerContextToRuntimeSession } from '../services/session/runtime-session-identity.js';
import type {
  ServerMessage,
  TraceEventWithId,
  TraceEventType,
  VoiceSessionCapabilities,
} from '../types/index.js';
import { getTraceStore } from '../services/trace-store.js';
import { emitChannelResponseSent } from '../services/channel-trace-utils.js';
import { buildExecutionOutcome, hasRenderableChannelOutcome } from '../services/channel/outcome.js';
import { buildAssistantPersistenceMessages } from '../services/channel/outcome-persistence.js';
import { withAgentNameMetadata } from '../services/channel/message-metadata.js';
import { buildPersistedAssistantStructuredContent } from '../services/session/persisted-message-content.js';
import {
  accumulateResponseProvenance,
  buildResponseMessageMetadata,
  createResponseProvenanceAccumulator,
  extractLlmTraceMetrics,
  type ResponseMessageMetadata,
} from '../services/channel/response-provenance.js';
import type { VoiceServiceFactory } from '../services/voice/voice-service-factory.js';
import { ServerMessages, serializeServerMessage } from './events.js';
import {
  tryParseLegacyActionFormData,
  validateActionSubmitEnvelope,
} from './action-submit-envelope.js';
import { buildSessionDiagnosticMessages } from './session-diagnostics.js';
import {
  startVoiceTurn,
  getActiveVoiceTurn,
  startSTTPhase,
  completeSTTPhase,
  startLLMPhase,
  completeLLMPhase,
  startTTSPhase,
  recordTTSFirstChunk,
  completeTTSPhase,
  completeVoiceTurn,
  failVoiceTurn,
  createTimingReportEvent,
  type VoiceTurnContext,
  type ClientTraceContext,
} from '../observability/voice-trace.js';
import {
  RUNTIME_CHANNEL,
  PLATFORM_MESSAGES,
  MAX_SDK_CLIENTS,
  MAX_CLICKHOUSE_STORE_CACHE,
  MAX_RATE_LIMITER_ENTRIES,
  WS_MESSAGE_TIMEOUT_MS,
} from '../services/channel/constants.js';
import { WebSocketConnectionManager, type ManagedClientState } from './connection-manager.js';
import type { WebSocketConnectionRegistry } from './connection-registry.js';
import { checkSessionMessageRate } from '../middleware/rate-limiter.js';
import { recordWsRateLimitRejection } from '../observability/metrics.js';
import {
  checkAuthPreflightFromIR,
  evaluateAuthPreflightFromIR,
  hasActiveAuthGateAsync,
  queueMessageBehindAuthGateAsync,
  reconcileAuthGateWithEvaluationAsync,
  cleanupAuthGateAsync,
  createTokenLookups,
} from '../services/auth-profile/auth-preflight.js';
import { getPausedExecutionStore } from '../services/auth-profile/paused-execution-store.js';
import { AUTH_PREFLIGHT_REQUIRED_CODE } from '../services/auth-profile/auth-contract.js';
import { buildAuthLifecycleTraceEvent } from '../services/auth-profile/auth-trace-events.js';
import { cleanupClosedSessionArtifacts } from '../services/session-lifecycle/artifact-cleanup.js';
import { SessionRuntimePolicyService } from '../services/session-lifecycle/runtime-policy-service.js';
import {
  isSessionTerminalizationEnabled,
  SessionTerminalizationService,
} from '../services/session-lifecycle/terminalization-service.js';
import { getToolOAuthService } from '../services/tool-oauth-service-singleton.js';
import { AUTH_PROFILE_OAUTH_PROVIDER_ID } from '../services/auth-profile/auth-profile-oauth-resolver.js';
import {
  buildRuntimeOAuthCallbackUri,
  resolveRuntimePublicOAuthBaseUrl,
} from '../services/oauth-callback-url.js';
import { resolvePersistedAgentVersion } from '../services/execution/agent-version-utils.js';
import {
  buildProjectDslReadinessError,
  evaluateProjectExecutionReadiness,
} from '../services/session/project-agent-dsl-readiness.js';
import {
  interruptRealtimeVoiceSession,
  registerRealtimeInterruptionTarget,
  unregisterRealtimeInterruptionTarget,
} from '../services/voice/realtime-interruption-coordinator.js';

import {
  registerSessionWebSocket,
  unregisterSessionWebSocket,
} from '../services/agent-transfer/message-bridge.js';

// Omnichannel live session imports
import * as liveSessionService from '../services/omnichannel/live-session-service.js';
import * as participantRegistry from '../services/omnichannel/participant-registry.js';
import {
  fanOutTranscriptItem,
  fanOutParticipantEvent,
} from '../services/omnichannel/transcript-fanout.js';
import type {
  Participant,
  ParticipantSurface,
  TranscriptItem,
} from '../services/omnichannel/types.js';
import { createParticipant, normalizeTranscriptItem } from '../services/omnichannel/types.js';

// SDK client → server incoming message (untyped parse target; outgoing is typed ServerMessage)
interface SDKIncomingMessage {
  type: string;
  [key: string]: unknown;
}

interface SDKMessageExecutionContext {
  signal: AbortSignal;
}

const log = createLogger('sdk-ws');
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

// =============================================================================
// CLIENT STATE
// =============================================================================

/** Info needed to materialize or recover a durable DB session */
import type {
  CanonicalSessionDisposition,
  CallDisposition,
  Channel,
  Environment,
  SessionTerminalSource,
} from '@abl/compiler/platform/core/types';

type DisconnectBehavior = 'end' | 'detach';

interface DisconnectLifecycleOverride {
  disposition?: CallDisposition;
  disconnectBehavior: DisconnectBehavior;
}

interface PendingDbSession {
  channel: Channel;
  agentName: string;
  agentVersion: string;
  environment: Environment;
  entryAgentName: string;
  deploymentId?: string;
}

import {
  resolveSdkSessionIdentityState,
  type CallerContext,
  type SDKSessionTokenPayload,
  type TenantContextData,
} from '@agent-platform/shared-auth';
import { runWithTenantContext } from '@agent-platform/shared-auth/middleware';
import type { ExecuteMessageOptions } from '../services/execution/types.js';
import { buildCallerContext } from '../services/identity/artifact-hasher.js';
import { resolveSession, registerResolutionKey } from '../services/identity/session-resolver.js';
import {
  resolveAndLinkContact,
  resolveContactForProductionScope,
} from './sdk-handler-contact-linking.js';
import { getContactLinkingDeps } from '../services/identity/contact-linking-deps.js';
import {
  authorizeRuntimeSdkSessionPayloadForAuth,
  verifyRuntimeSdkSessionForAuth,
  type RuntimeSdkSessionAuthResult,
} from '../services/identity/sdk-session-token-auth.js';
import { consumeSdkWsTicket } from '../services/identity/sdk-ws-ticket-store.js';
import { normalizeSdkMessageMetadata } from '../services/identity/sdk-message-metadata.js';
import {
  mergeInteractionContextInputs,
  normalizeInteractionContextInput,
} from '../services/execution/interaction-context.js';
import {
  buildProductionSessionLocator,
  type ProductionExecutionScope,
} from '../services/session/execution-scope.js';
import { ScopeValidationError } from '../services/session/scope-policy.js';
import {
  executeLiveVoiceSemanticTurn,
  executeLiveVoiceToolCall,
} from '../services/voice/live-voice-runtime-bridge.js';

// Exported so integration tests can construct a state shape compatible with
// handleFeedbackSubmit / handleActionSubmitFeedback without standing up a
// real WS connection.
export interface SDKClientState extends ManagedClientState {
  ws: WebSocket;
  connectionId: string;
  registeredSessionId?: string;
  registeredLiveSessionId?: string;
  projectId: string;
  keyId: string;
  sessionId: string;
  runtimeSession?: RuntimeSession;
  permissions: { chat: boolean; voice: boolean };
  tenantId?: string;
  authToken?: string;
  /** Auth lookup principal (verified user or session principal) */
  userId?: string;
  /** Verified end-user identity, when present */
  verifiedUserId?: string;
  /** Scope for OAuth/auth-preflight artifacts */
  authScope?: 'session' | 'user';
  /** Deployment ID from SDK session token (deployment-aware serving) */
  deploymentId?: string;
  /** Deployment environment from SDK session token/channel binding. */
  environment?: Environment;
  dbSessionId?: string;
  /** Metadata for durable DB session materialization/recovery */
  pendingDbSession?: PendingDbSession;
  /** Channel type for lifecycle config lookup */
  channel?: typeof RUNTIME_CHANNEL.WEB_CHAT | typeof RUNTIME_CHANNEL.API;
  /** SDK channel ID from session token (for voice pipeline config lookup) */
  channelId?: string;
  /** User context from SDK init (for personalization only — no mocks) */
  userContext?: { userId?: string; customAttributes?: Record<string, unknown> };
  /** Unified end-user identity */
  callerContext?: CallerContext;
  /** Active live session joined by this SDK socket, if any. */
  joinedLiveSessionId?: string;
  /** Participant ID assigned when this SDK socket joins a live session. */
  liveSessionParticipantId?: string;
  /** Contact ID associated with the active joined live session. */
  liveSessionContactId?: string;
  /** Per-connection trace ID (W3C 32-hex format) for WS observability context */
  traceId?: string;
  /** Optional lifecycle override used when the client explicitly ends the session. */
  disconnectLifecycleOverride?: DisconnectLifecycleOverride;
  /** Optional terminal source override used by explicit close flows. */
  terminalSourceOverride?: SessionTerminalSource;
  /** Tracks whether explicit SDK end terminalization already completed before socket close. */
  explicitTerminalizationHandled?: boolean;
  /** Prevents duplicate explicit SDK end terminalization requests. */
  explicitTerminalizationInFlight?: boolean;
  // Realtime voice state
  voiceMode?: 'realtime';
  realtimeExecutor?: import('../services/voice/realtime-voice-executor.js').RealtimeVoiceExecutor;
  realtimeInterruptionRegistrationId?: string;
}

const sdkClients = new WebSocketConnectionManager<SDKClientState>({
  label: 'sdk',
  maxConnections: MAX_SDK_CLIENTS,
  staleTtlMs: 5 * 60 * 1000, // 5 minutes
  sweepIntervalMs: 60 * 1000, // 60 seconds
});

/** Getter for the SDK WS connection manager — used by callback handlers that need to broadcast to sessions. */
export function getSdkConnectionManager(): WebSocketConnectionManager<SDKClientState> {
  return sdkClients;
}

const MAX_JIT_PROVIDER_NAME_LENGTH = 64;
const WS_MESSAGE_TIMEOUT_CLOSE_CODE = 4011;
let _wsRegistry: WebSocketConnectionRegistry | null = null;
const SDK_REALTIME_VOICE_CAPABILITIES: VoiceSessionCapabilities = {
  localBargeIn: true,
  remoteTypedInterrupt: true,
  dtmf: false,
  returnToParent: true,
  activeAgentSync: false,
};

export function setConnectionRegistry(registry: WebSocketConnectionRegistry | null): void {
  _wsRegistry = registry;
}

function bindRuntimeSession(state: SDKClientState, runtimeSession: RuntimeSession): void {
  state.sessionId = runtimeSession.id;
  if (state.callerContext) {
    applyCallerContextToRuntimeSession(runtimeSession, state.callerContext);
  }
  state.runtimeSession = runtimeSession;
  applyUserContext(runtimeSession, state);

  if (state.voiceMode === 'realtime' && state.realtimeExecutor) {
    registerSdkRealtimeInterruptionTarget(state.ws, state);
  }
}

function getBoundSessionId(state?: SDKClientState): string | undefined {
  if (!state) return undefined;
  return state.runtimeSession?.id ?? state.sessionId;
}

function interruptRealtimeVoiceSessions(
  targetSessionId: string,
  options: {
    tenantId?: string;
    reason: 'barge_in' | 'typed_interrupt';
  },
): { interrupted: number; acknowledgements: number } {
  const result = interruptRealtimeVoiceSession(targetSessionId, options);

  if (result.interrupted > 0) {
    log.info('Interrupted realtime voice session(s)', {
      sessionId: targetSessionId,
      interrupted: result.interrupted,
      acknowledgements: result.acknowledgements,
      reason: options.reason,
    });
  }

  return result;
}

function unregisterSdkRealtimeInterruptionTarget(state?: SDKClientState): void {
  if (!state?.realtimeInterruptionRegistrationId) {
    return;
  }

  unregisterRealtimeInterruptionTarget(state.realtimeInterruptionRegistrationId);
  state.realtimeInterruptionRegistrationId = undefined;
}

function registerSdkRealtimeInterruptionTarget(ws: WebSocket, state: SDKClientState): void {
  unregisterSdkRealtimeInterruptionTarget(state);

  if (state.voiceMode !== 'realtime' || !state.realtimeExecutor) {
    return;
  }

  const sessionId = getBoundSessionId(state) ?? state.sessionId;
  state.realtimeInterruptionRegistrationId = registerRealtimeInterruptionTarget({
    sessionIds: [sessionId],
    tenantId: state.tenantId,
    provider: 'sdk',
    interrupt: () => {
      state.realtimeExecutor?.cancelResponse();
    },
    acknowledge: () => {
      send(ws, ServerMessages.voiceBargeInAck());
    },
  });
}

async function resolveDisconnectLifecycle(
  state?: SDKClientState,
  runtimeSession?: RuntimeSession,
): Promise<{
  disposition: CallDisposition;
  disconnectBehavior: DisconnectBehavior;
  shouldCleanupAuthState: boolean;
}> {
  const channel = state?.channel || RUNTIME_CHANNEL.WEB_CHAT;
  const resolved = await runtimePolicyService.resolveDisconnectPolicy({
    channel,
    tenantId: state?.tenantId ?? runtimeSession?.tenantId,
    projectId: state?.projectId ?? runtimeSession?.projectId,
    agentName: runtimeSession?.agentName ?? state?.pendingDbSession?.agentName,
    agentLifecycle: getRuntimeAgentLifecycle(runtimeSession),
  });
  let disposition: CallDisposition = (resolved.disposition ?? 'abandoned') as CallDisposition;
  let disconnectBehavior: DisconnectBehavior = (resolved.disconnectBehavior ??
    'detach') as DisconnectBehavior;

  if (state?.disconnectLifecycleOverride) {
    disposition = state.disconnectLifecycleOverride.disposition ?? disposition;
    disconnectBehavior = state.disconnectLifecycleOverride.disconnectBehavior;
  }

  return {
    disposition,
    disconnectBehavior,
    shouldCleanupAuthState: disconnectBehavior === 'end',
  };
}

function capturePromotableSessionDataValues(
  runtimeSession?: RuntimeSession,
): Record<string, unknown> | undefined {
  if (!runtimeSession?.data.values) {
    return undefined;
  }

  const { env: _env, ...valuesForPromotion } = runtimeSession.data.values;
  return valuesForPromotion;
}

function enqueuePromoteContextAfterSessionEnd(params: {
  tenantId?: string;
  contactId?: string;
  sessionId: string;
  disposition: CanonicalSessionDisposition;
  dataValues?: Record<string, unknown>;
}): void {
  const { tenantId, contactId, dataValues } = params;

  if (!tenantId || !contactId || !dataValues) {
    return;
  }

  import('../services/queues/promote-context-producer.js')
    .then(({ enqueuePromoteContextJob }) =>
      enqueuePromoteContextJob({
        tenantId,
        contactId,
        sessionId: params.sessionId,
        disposition: params.disposition,
        dataValues,
      }),
    )
    .catch((err: unknown) =>
      log.warn('Failed to enqueue promote-context job', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
        contactId,
      }),
    );
}

async function terminalizeSdkConversationSession(params: {
  state: SDKClientState;
  runtimeSession?: RuntimeSession;
  disposition: CallDisposition;
  source: SessionTerminalSource;
  capturedDataValues?: Record<string, unknown>;
  sendHookResponse?: (message: string) => Promise<void>;
}): Promise<boolean> {
  if (!isSessionTerminalizationEnabled()) {
    return false;
  }

  const { state, runtimeSession, disposition, source, capturedDataValues, sendHookResponse } =
    params;
  const terminalSessionId = state.dbSessionId ?? state.runtimeSession?.id ?? runtimeSession?.id;

  if (!state.tenantId || !state.projectId || !terminalSessionId) {
    return false;
  }

  if (state.dbSessionId) {
    try {
      await flushMessageQueue(state.dbSessionId);
    } catch (err) {
      log.warn('Failed to flush pending SDK session messages before terminalization', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: state.dbSessionId,
      });
    }
  }

  const result = await terminalizationService.terminateConversationSession({
    tenantId: state.tenantId,
    projectId: state.projectId,
    sessionId: terminalSessionId,
    agentName: runtimeSession?.agentName ?? state.pendingDbSession?.agentName,
    channel: state.channel ?? 'web_chat',
    disposition,
    source,
    ...(sendHookResponse !== undefined
      ? {
          hook: {
            sendResponse: sendHookResponse,
          },
        }
      : {}),
  });

  if (!result) {
    return false;
  }

  await cleanupClosedSessionArtifacts(result.artifactSessionIds);
  enqueuePromoteContextAfterSessionEnd({
    tenantId: state.tenantId,
    contactId: state.callerContext?.contactId,
    sessionId: result.sessionId,
    disposition: result.disposition,
    dataValues: capturedDataValues,
  });

  return true;
}

async function sendSdkEndHookResponse(
  ws: WebSocket,
  state: SDKClientState,
  message: string,
): Promise<void> {
  const messageId = crypto.randomUUID();
  send(ws, {
    type: 'response_start',
    messageId,
    sessionId: state.sessionId,
  });
  send(ws, {
    type: 'response_end',
    messageId,
    sessionId: state.sessionId,
    fullText: message,
  });
}

function isSupportedJitProviderName(profileId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(profileId) && profileId.length <= MAX_JIT_PROVIDER_NAME_LENGTH;
}

function syncSdkRegistry(ws: WebSocket, state: SDKClientState): void {
  if (!_wsRegistry) {
    return;
  }

  if (state.registeredSessionId === state.sessionId) {
    return;
  }

  if (state.registeredSessionId) {
    _wsRegistry.unregister(state.connectionId, state.registeredSessionId);
    unregisterSessionWebSocket(state.registeredSessionId);
  }

  _wsRegistry.register(state.connectionId, state.sessionId, ws);
  registerSessionWebSocket(state.sessionId, ws);
  state.registeredSessionId = state.sessionId;
}

function syncJoinedLiveSessionRegistry(
  ws: WebSocket,
  state: SDKClientState,
  liveSessionId?: string,
): void {
  if (!_wsRegistry) {
    return;
  }

  if (state.registeredLiveSessionId === liveSessionId) {
    return;
  }

  if (state.registeredLiveSessionId) {
    _wsRegistry.unregister(state.connectionId, state.registeredLiveSessionId);
    state.registeredLiveSessionId = undefined;
  }

  if (!liveSessionId) {
    return;
  }

  _wsRegistry.register(state.connectionId, liveSessionId, ws);
  state.registeredLiveSessionId = liveSessionId;
}

function unregisterSdkRegistry(state?: SDKClientState): void {
  if (!state) {
    return;
  }

  if (state.registeredSessionId) {
    unregisterSessionWebSocket(state.registeredSessionId);
  }

  if (_wsRegistry) {
    _wsRegistry.unregister(state.connectionId);
  }

  state.registeredSessionId = undefined;
  state.registeredLiveSessionId = undefined;
}

function getRuntimeSdkOAuthBaseUrl(): string | null {
  return resolveRuntimePublicOAuthBaseUrl();
}

function createJitAuthCallbacks(
  ws: WebSocket,
  context: { tenantId?: string; userId?: string; authScope?: 'session' | 'user' },
): {
  sendAuthChallenge: RuntimeSession['sendAuthChallenge'];
  initiateJitOAuth: RuntimeSession['initiateJitOAuth'];
} {
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

      const runtimeApiBaseUrl = getRuntimeSdkOAuthBaseUrl();
      if (!runtimeApiBaseUrl) {
        log.warn('SDK JIT OAuth initiation denied — RUNTIME_PUBLIC_BASE_URL is not configured', {
          tenantId: context.tenantId,
          userId: context.userId,
          sessionId,
          toolCallId,
          authProfileRef,
          profileId,
        });
        return undefined;
      }

      if (authProfileRef) {
        // JIT always stores tokens under the real user — the end user is giving
        // consent themselves. connection_mode:'shared' with __tenant__ is
        // exclusively for preconfigured mode. Session scope is preserved for
        // anonymous SDK sessions that have no authenticated user identity.
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
          authScope: context.authScope === 'session' ? 'session' : 'user',
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
        {
          authScope: context.authScope,
          projectId,
        },
      );
    },
  };
}

function bindJitAuthCallbacksToSession(ws: WebSocket, session: RuntimeSession): void {
  const executor = getRuntimeExecutor();
  const callbacks = createJitAuthCallbacks(ws, {
    tenantId: session.tenantId,
    userId: session.userId,
    authScope: session.callerContext?.authScope,
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
    log.warn('TraceStore unavailable for auth lifecycle trace', {
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
  authScope?: 'session' | 'user',
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
    {
      authScope,
      ...(authScope === 'session' && userId ? { sessionPrincipal: userId } : {}),
    },
  );
  const gateState = await checkAuthPreflightFromIR(
    sessionId,
    runtimeSession.compilationOutput,
    {
      userId,
      tenantId: runtimeSession.tenantId,
      projectId: runtimeSession.projectId,
      environment: runtimeSession.versionInfo?.environment,
      authScope,
      allowTenantTokenReuse: authScope !== 'session',
    },
    tokenLookups,
    runtimeSession.agentName ? { agentNames: [runtimeSession.agentName] } : undefined,
  );

  if (!gateState) {
    return false;
  }

  send(ws, ServerMessages.authRequired(sessionId, gateState.pending, gateState.satisfied));
  const state = sdkClients.get(ws);
  emitAuthLifecycleTrace(ws, {
    sessionId,
    decision: 'preflight_required',
    pending: gateState.pending,
    satisfied: gateState.satisfied,
    traceId: state?.traceId,
    agentName: runtimeSession.agentName,
  });
  log.info('Auth gate activated for SDK session', {
    sessionId,
    pendingCount: gateState.pending.length,
  });
  return true;
}

/**
 * Build a TenantContextData from SDK client state for ALS propagation.
 * SDK WebSocket connections authenticate via session tokens, so authType
 * is always 'sdk_session' and permissions come from the token payload.
 */
function buildTenantContextData(state: SDKClientState): TenantContextData {
  const sessionPrincipal =
    state.callerContext?.sessionPrincipalId ?? state.callerContext?.anonymousId ?? state.sessionId;
  return {
    tenantId: state.tenantId!,
    userId: state.userId || state.sessionId,
    role: 'sdk_session',
    permissions: [
      ...(state.permissions.chat ? ['session:send_message'] : []),
      ...(state.permissions.voice ? ['session:voice'] : []),
    ],
    authType: 'sdk_session',
    isSuperAdmin: false,
    deploymentId: state.deploymentId,
    channelId: state.channelId,
    sessionId: state.sessionId,
    sessionPrincipal,
    verifiedUserId: state.verifiedUserId,
    identityTier: state.callerContext?.identityTier,
    verificationMethod: state.callerContext?.verificationMethod,
    authScope: state.authScope,
    channelArtifact: state.callerContext?.channelArtifact,
    userContext: state.userContext,
  };
}

function shouldRequireSdkProductionScope(
  state: Pick<
    SDKClientState,
    'authScope' | 'verifiedUserId' | 'callerContext' | 'tenantId' | 'projectId' | 'channelId'
  >,
): boolean {
  return requiresCanonicalContactProductionScope({
    authScope: state.authScope,
    verifiedUserId: state.verifiedUserId,
    contactId: state.callerContext?.contactId,
    identityTier: state.callerContext?.identityTier,
    verificationMethod: state.callerContext?.verificationMethod,
  });
}

function resolveSdkScopeEnvironment(state: SDKClientState): string {
  return (
    state.environment ??
    state.runtimeSession?.versionInfo?.environment ??
    (state.deploymentId ? 'unknown' : 'dev')
  );
}

async function ensureSdkContactForRequiredProductionScope(state: SDKClientState): Promise<void> {
  if (
    !shouldRequireSdkProductionScope(state) ||
    !state.callerContext ||
    state.callerContext.contactId
  ) {
    return;
  }

  const deps = getContactLinkingDeps();
  if (!deps) {
    return;
  }

  const result = await resolveContactForProductionScope(state, deps);
  if (!result || !state.callerContext) {
    return;
  }

  state.callerContext = {
    ...state.callerContext,
    contactId: result.contactId,
    ...(result.displayName ? { contactDisplayName: result.displayName } : {}),
  };
}

function buildSdkPersistenceScope(state: SDKClientState): ProductionExecutionScope | null {
  const contactId = state.callerContext?.contactId;
  const runtimeSessionId = getBoundSessionId(state) ?? state.sessionId;
  const scopeInput = {
    tenantId: state.tenantId,
    projectId: state.projectId,
    sessionId: runtimeSessionId,
    channelId: state.channelId,
    environment: resolveSdkScopeEnvironment(state),
    source: 'sdk_ws',
    authType: 'sdk_session',
    traceId: state.traceId ?? getCurrentTraceId() ?? crypto.randomUUID(),
    sessionPrincipalId:
      state.callerContext?.sessionPrincipalId ??
      state.callerContext?.anonymousId ??
      state.sessionId,
    contactId,
    callerContext: state.callerContext,
    identityTier: state.callerContext?.identityTier,
    verificationMethod: state.callerContext?.verificationMethod,
    channelArtifact: state.callerContext?.channelArtifact,
    channelArtifactType: state.callerContext?.channelArtifactType,
  };

  if (shouldRequireSdkProductionScope(state)) {
    return buildRequiredContactProductionExecutionScope(scopeInput);
  }

  return buildContactProductionExecutionScope(scopeInput);
}

function shouldUseLegacySdkPersistence(state: SDKClientState): boolean {
  return !shouldRequireSdkProductionScope(state);
}

function buildSdkSessionLocator(
  state: Pick<
    SDKClientState,
    'tenantId' | 'projectId' | 'sessionId' | 'runtimeSession' | 'callerContext'
  >,
  sessionId?: string,
) {
  return buildProductionSessionLocator({
    tenantId: state.tenantId,
    projectId: state.projectId,
    sessionId: sessionId ?? state.runtimeSession?.id ?? state.sessionId,
    sessionPrincipalId: state.callerContext?.sessionPrincipalId ?? state.callerContext?.anonymousId,
  });
}

// Conversation store accessor via store factory (backend-aware)
function getConversationStore() {
  return getStores().conversation;
}

async function syncDbSessionContactIdentity(
  state: Pick<SDKClientState, 'callerContext'>,
  dbSessionId: string | undefined,
  persistedContactId?: string | null,
): Promise<void> {
  const contactId = state.callerContext?.contactId;
  if (!dbSessionId || !contactId || persistedContactId === contactId || !isDatabaseAvailable()) {
    return;
  }

  try {
    await getConversationStore().linkContact(dbSessionId, contactId);
  } catch (err) {
    log.warn('Failed to backfill SDK DB session contact', {
      dbSessionId,
      contactId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Ensure a durable DB session exists for this runtime session.
 * Returns the dbSessionId (cached after first call) and reuses an existing
 * persisted session for resumed connections when present.
 */
/** In-flight DB session creation promise — prevents duplicate sessions from concurrent calls */
const _dbSessionCreating = new WeakMap<SDKClientState, Promise<string | undefined>>();

async function ensureDbSession(
  state: SDKClientState,
  channelOverride?: Channel,
): Promise<string | undefined> {
  if (state.dbSessionId) return state.dbSessionId;
  if (!isDatabaseAvailable()) return undefined;

  // Deduplicate: if a creation is already in flight for this state, await it
  const inflight = _dbSessionCreating.get(state);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      // Re-check after await (another caller may have resolved first)
      if (state.dbSessionId) return state.dbSessionId;

      const convStore = getConversationStore();
      const sessionId = state.runtimeSession?.id || state.sessionId;

      // Resumed sessions may already have a persisted DB record. Reuse it instead of
      // attempting to create a duplicate document with the same runtime-scoped ID.
      if (sessionId) {
        const existingSession = await convStore.getSession(sessionId);
        if (existingSession) {
          state.dbSessionId = existingSession.id;
          state.pendingDbSession = undefined;
          await syncDbSessionContactIdentity(state, existingSession.id, existingSession.contactId);
          return existingSession.id;
        }
      }

      const pending = state.pendingDbSession;
      if (!pending || !sessionId) return undefined;
      const channel = channelOverride || pending.channel;
      const dbSession = await convStore.createSession({
        id: sessionId,
        channel,
        agentName: pending.agentName,
        agentVersion: pending.agentVersion,
        environment: pending.environment,
        projectId: state.projectId,
        tenantId: state.tenantId,
        entryAgentName: pending.entryAgentName,
        deploymentId: pending.deploymentId,
        // Session identity fields from CallerContext
        ...(state.callerContext && {
          customerId: state.callerContext.customerId,
          anonymousId: state.callerContext.anonymousId,
          sessionPrincipalId:
            state.callerContext.sessionPrincipalId ?? state.callerContext.anonymousId,
          contactId: state.callerContext.contactId,
          channelArtifact: state.callerContext.channelArtifact,
          channelArtifactType: state.callerContext.channelArtifactType,
          identityTier: state.callerContext.identityTier,
          verificationMethod: state.callerContext.verificationMethod,
          channelId: state.callerContext.channelId,
          initiatedById: state.callerContext.initiatedById,
        }),
      });
      state.dbSessionId = dbSession.id;
      state.pendingDbSession = undefined; // consumed

      // Persist experiment assignment to the newly created DB session (fire-and-forget)
      const rs = state.runtimeSession;
      if (rs?.experimentId && rs?.experimentGroup && state.tenantId) {
        updateDbSessionFields(
          dbSession.id,
          { experimentId: rs.experimentId, experimentGroup: rs.experimentGroup },
          state.tenantId,
        ).catch((err) => {
          log.warn('Failed to persist experiment assignment to DB session', {
            sessionId: dbSession.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      return dbSession.id;
    } catch (err) {
      log.error('Failed to ensure DB session', { err });
      return undefined;
    } finally {
      _dbSessionCreating.delete(state);
    }
  })();

  _dbSessionCreating.set(state, promise);
  return promise;
}

// Lazy ClickHouse metrics store accessor — writes when ClickHouse client is available
// NOTE: ClickHouse message writes are now handled by DualWriteMessageStore
// via the message persistence queue — no ad-hoc message stores needed here.
import { ClickHouseMetricsStore } from '../services/stores/clickhouse-metrics-store.js';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import {
  calculateCost,
  hasKnownPricing,
  getModelCapabilities,
} from '../services/llm/model-router.js';
// Per-tenant ClickHouse metrics stores (tenant isolation)
const _chMetricsStores = new Map<string, ClickHouseMetricsStore>();

async function getClickHouseMetricsStore(tenantId: string): Promise<ClickHouseMetricsStore> {
  if (!_chMetricsStores.has(tenantId)) {
    // Evict oldest entry if cache is at capacity
    if (_chMetricsStores.size >= MAX_CLICKHOUSE_STORE_CACHE) {
      const oldest = _chMetricsStores.keys().next().value;
      if (oldest !== undefined) _chMetricsStores.delete(oldest);
    }
    const client = getClickHouseClient();
    if (!client) throw new Error('ClickHouse client not available');
    _chMetricsStores.set(
      tenantId,
      new ClickHouseMetricsStore({ type: 'clickhouse' }, { client, tenantId }),
    );
  }
  return _chMetricsStores.get(tenantId)!;
}

// =============================================================================
// IP EXTRACTION
// =============================================================================

/**
 * Extract client IP from the request, using the rightmost X-Forwarded-For
 * entry (added by the trusted proxy/load-balancer) rather than the leftmost
 * (which is client-controlled and can be spoofed).
 */
function extractClientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const ips = xff.split(',').map((s) => s.trim());
    return ips[ips.length - 1] || req.socket.remoteAddress || 'unknown';
  }
  return req.socket.remoteAddress || 'unknown';
}

// =============================================================================
// CONNECTION HANDLER
// =============================================================================

/**
 * Handle new SDK WebSocket connection.
 * Auth: Sec-WebSocket-Protocol: sdk-auth,<sdk_session_token>
 *
 * Clients MUST obtain a session token via POST /api/v1/sdk/init first.
 */
export async function handleSDKConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  log.info('SDK client connecting');

  const sdkTicket = extractSdkTicketFromProtocolHeader(req.headers);
  const sdkToken = extractSdkTokenFromProtocolHeader(req.headers);

  if (!sdkTicket && !sdkToken) {
    log.warn('Missing SDK session token');
    ws.close(4001, 'Missing token — obtain one via POST /api/v1/sdk/init');
    return;
  }

  // Rate limit by IP before doing any token verification.
  // Use rightmost IP from X-Forwarded-For (added by trusted proxy), not leftmost (client-controlled).
  const clientIp = extractClientIp(req);
  if (!wsRateLimiter.check(clientIp)) {
    log.warn('SDK WS rate limit exceeded', { ip: clientIp });
    recordWsRateLimitRejection({ ip: clientIp });
    ws.close(4029, 'Too many connections — try again later');
    return;
  }

  const tokenState = sdkTicket
    ? await handleTicketAuth(ws, sdkTicket)
    : await handleTokenAuth(ws, sdkToken!);
  if (!tokenState) return; // ws already closed with error

  // Post-auth rate limit scoped by tenant+IP so tenants behind the same NAT
  // (corporate proxy, shared IP) each get their own rate limit bucket.
  if (tokenState.tenantId && !wsRateLimiter.check(clientIp, tokenState.tenantId)) {
    log.warn('SDK WS tenant rate limit exceeded', {
      ip: clientIp,
      tenantId: tokenState.tenantId,
    });
    recordWsRateLimitRejection({ ip: clientIp });
    ws.close(4029, 'Too many connections — try again later');
    return;
  }

  tokenState.traceId = crypto.randomUUID().replace(/-/g, '');
  // ConnectionManager enforces max capacity (MAX_SDK_CLIENTS)
  if (!sdkClients.add(ws, tokenState)) {
    log.error('Max SDK clients reached, rejecting connection', { current: sdkClients.size });
    ws.close(4029, 'Server at capacity — try again later');
    return;
  }
  setupClientHandlers(ws, tokenState);

  // All downstream operations (agent init, DB queries, ON_START) need tenant context
  // in ALS so MongoConversationStore and Mongoose plugins apply tenant isolation.
  const tenantCtx = tokenState.tenantId ? buildTenantContextData(tokenState) : undefined;

  const initAndGreet = async () => {
    // Initialize agent
    await initializeProjectAgent(ws, tokenState);
    syncSdkRegistry(ws, tokenState);

    const runtimeSession = tokenState.runtimeSession;

    // SDK chat sessions must be durable as soon as session_start is emitted so
    // session-scoped HTTP APIs (attachments, history, etc.) can resolve the same
    // session across pods without requiring a first chat turn.
    if (tokenState.permissions.chat) {
      await ensureDbSession(tokenState);
    }

    send(
      ws,
      ServerMessages.sessionStart(
        tokenState.sessionId,
        tokenState.projectId,
        tokenState.permissions,
        tokenState.traceId,
      ),
    );

    if (runtimeSession) {
      for (const diagnosticMessage of buildSessionDiagnosticMessages(
        tokenState.sessionId,
        runtimeSession,
      )) {
        send(ws, diagnosticMessage);
      }
    }

    // Auth preflight check: if the agent requires preflight consent, send auth_required
    // and activate the auth gate before ON_START fires.
    if (runtimeSession?.compilationOutput) {
      try {
        const runtimeSid = getBoundSessionId(tokenState) ?? runtimeSession.id;
        if (
          await activateAuthGateIfRequired(
            ws,
            runtimeSid,
            runtimeSession,
            tokenState.userId,
            tokenState.authScope,
          )
        ) {
          return; // Do not fire ON_START until auth gate is satisfied
        }
      } catch (err) {
        log.warn('Auth preflight check failed; blocking SDK session initialization', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: tokenState.sessionId,
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

    await deliverPendingSdkResults(ws, tokenState);

    // Proactively fire ON_START so the agent greets without waiting for user input
    fireOnStart(ws, tokenState);
  };

  if (tenantCtx) {
    await runWithTenantContext(tenantCtx, initAndGreet);
  } else {
    await initAndGreet();
  }
}

// =============================================================================
// SDK SESSION TOKEN AUTH (new flow)
// =============================================================================

/**
 * Authenticate a WebSocket connection using an SDK session token.
 * Returns the client state or null if auth fails (ws is closed).
 */
async function handleTokenAuth(ws: WebSocket, token: string): Promise<SDKClientState | null> {
  try {
    log.warn('SDK WebSocket authenticated with deprecated sdk-auth session-token protocol', {
      authProtocol: 'sdk-auth',
      replacementProtocol: 'sdk-ticket',
    });
    const verifiedSession = await verifyRuntimeSdkSessionForAuth(token);
    if (!verifiedSession.success) {
      ws.close(4003, 'Invalid or expired session token');
      return null;
    }
    return buildClientStateFromVerifiedSession(ws, verifiedSession);
  } catch (error) {
    log.warn('Invalid SDK session token', {
      error: error instanceof Error ? error.message : String(error),
    });
    ws.close(4003, 'Invalid or expired session token');
    return null;
  }
}

async function handleTicketAuth(ws: WebSocket, ticket: string): Promise<SDKClientState | null> {
  try {
    const consumed = await consumeSdkWsTicket(ticket);
    if (!consumed.success) {
      log.warn('Invalid SDK WebSocket ticket', { reason: consumed.reason });
      ws.close(4003, 'Invalid or expired session token');
      return null;
    }

    const authorized = await authorizeRuntimeSdkSessionPayloadForAuth(
      consumed.record.payload,
      consumed.record.envelope,
    );
    if (!authorized.success) {
      log.warn('SDK WebSocket ticket rejected by live authorization', {
        reason: authorized.logReason,
      });
      ws.close(4003, 'Invalid or expired session token');
      return null;
    }

    return buildClientStateFromVerifiedSession(ws, authorized);
  } catch (error) {
    log.warn('Invalid SDK WebSocket ticket', {
      error: error instanceof Error ? error.message : String(error),
    });
    ws.close(4003, 'Invalid or expired session token');
    return null;
  }
}

async function buildClientStateFromVerifiedSession(
  ws: WebSocket,
  verifiedSession: Extract<RuntimeSdkSessionAuthResult, { success: true }>,
): Promise<SDKClientState | null> {
  const payload = verifiedSession.payload;
  const identityState = resolveSdkSessionIdentityState(payload);

  if (!identityState.success) {
    log.warn('Invalid SDK session token state for WebSocket auth', {
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      channelId: payload.channelId,
      reason: identityState.reason,
    });
    ws.close(4003, 'Invalid or expired session token');
    return null;
  }

  const { sessionPrincipal, authScope, principalUserId, verifiedUserId } = identityState;
  const sessionId = payload.sessionId || sessionPrincipal;
  const permissions = {
    chat: payload.permissions.includes('session:send_message'),
    voice: payload.permissions.includes('session:voice'),
  };

  // Build CallerContext from token payload (identity fields set during sdk/init)
  const baseCallerContext = buildCallerContext({
    tenantId: payload.tenantId,
    channel: 'sdk_websocket',
    channelId: payload.channelId,
    customerId: verifiedUserId,
    anonymousId: authScope === 'session' ? sessionPrincipal : undefined,
    identityTier: payload.identityTier ?? 0,
    verificationMethod: payload.verificationMethod ?? 'none',
  });

  // If the token carries a pre-hashed channelArtifact, merge it without mutation
  const callerContext = {
    ...baseCallerContext,
    ...(payload.channelArtifact ? { channelArtifact: payload.channelArtifact } : {}),
    sessionPrincipalId: sessionPrincipal,
    authScope,
  };

  // Resolve deployment binding from live auth first. Token-carried binding is
  // only a legacy fallback for pre-source SDK session tokens that cannot be
  // reauthorized against a current channel binding.
  let resolvedDeploymentId = verifiedSession.currentBinding
    ? verifiedSession.currentBinding.deploymentId
    : payload.deploymentId;
  let resolvedEnvironment = verifiedSession.currentBinding
    ? verifiedSession.currentBinding.environment
      ? resolveEnvironmentLabel(verifiedSession.currentBinding.environment)
      : undefined
    : typeof payload.environment === 'string'
      ? resolveEnvironmentLabel(payload.environment)
      : undefined;
  if (
    !verifiedSession.currentBinding &&
    (!resolvedDeploymentId || !resolvedEnvironment) &&
    payload.channelId &&
    payload.tenantId
  ) {
    try {
      const { findSDKChannelById } = await import('../repos/channel-repo.js');
      const channel = await findSDKChannelById(
        payload.channelId,
        payload.projectId,
        payload.tenantId,
      );
      if (channel) {
        if (!resolvedDeploymentId && (channel as any).deploymentId) {
          resolvedDeploymentId = (channel as any).deploymentId;
        }
        if (!resolvedEnvironment && typeof (channel as any).environment === 'string') {
          resolvedEnvironment = resolveEnvironmentLabel((channel as any).environment);
        }
        log.info('Resolved SDK channel binding context', {
          channelId: payload.channelId,
          deploymentId: resolvedDeploymentId,
          environment: resolvedEnvironment,
        });
      }
    } catch {
      // Non-blocking — falls through to legacy path
    }
  }

  const state: SDKClientState = {
    ws,
    connectionId: crypto.randomUUID(),
    projectId: payload.projectId,
    keyId: `token:${payload.channelId}`,
    channelId: payload.channelId,
    sessionId,
    permissions,
    tenantId: payload.tenantId,
    userId: principalUserId,
    verifiedUserId,
    authScope,
    deploymentId: resolvedDeploymentId,
    environment: resolvedEnvironment,
    channel: RUNTIME_CHANNEL.WEB_CHAT,
    userContext: payload.userContext,
    callerContext,
    lastActivity: Date.now(),
  };

  log.info('SDK client authenticated via session token', {
    sessionId,
    projectId: payload.projectId,
    channelId: payload.channelId,
    deploymentId: resolvedDeploymentId,
    environment: resolvedEnvironment,
    identityTier: callerContext.identityTier,
    authScope,
  });

  return state;
}

// =============================================================================
// CLIENT HANDLER SETUP
// =============================================================================

/**
 * Set up message, close, and error handlers for an SDK WebSocket client.
 */
function setupClientHandlers(ws: WebSocket, state: SDKClientState): void {
  log.info('SDK client connected', { sessionId: state.sessionId, projectId: state.projectId });

  ws.on('message', (data) => {
    sdkClients.touch(ws);
    if (!state.tenantId) {
      send(ws, ServerMessages.error('No tenant context'));
      return;
    }
    let timedOut = false;
    const executionAbortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      executionAbortController.abort();

      void handleMessageTimeout(ws, state);
    }, WS_MESSAGE_TIMEOUT_MS);

    void runWithTenantContext(buildTenantContextData(state), () =>
      handleSDKMessage(ws, data.toString(), { signal: executionAbortController.signal }),
    )
      .catch((err) => {
        if (timedOut) {
          log.warn('WS message finished after timeout boundary', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: state.sessionId,
          });
          return;
        }

        log.error('WS message processing failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: state.sessionId,
        });
        send(ws, ServerMessages.error('Failed to process message'));
      })
      .finally(() => {
        clearTimeout(timeoutHandle);
      });
  });

  ws.on('close', () => {
    void (async () => {
      const clientState = sdkClients.get(ws);
      const disconnectLiveSessionId = clientState?.joinedLiveSessionId;
      const disconnectLiveParticipantId = clientState?.liveSessionParticipantId;
      const disconnectLiveContactId =
        clientState?.liveSessionContactId ?? clientState?.callerContext?.contactId;
      unregisterSdkRegistry(clientState);
      unregisterSdkRealtimeInterruptionTarget(clientState);
      try {
        // Clean up realtime voice executor (fire-and-forget)
        if (clientState?.realtimeExecutor) {
          clientState.realtimeExecutor.stop().catch((err) => {
            log.warn('Voice executor cleanup failed on WS close', {
              error: err instanceof Error ? err.message : String(err),
              sessionId: clientState.sessionId,
            });
          });
        }

        const runtimeId = clientState?.runtimeSession?.id;
        const executor = getRuntimeExecutor();
        const runtimeSession =
          (runtimeId ? executor.getSession(runtimeId) : undefined) ?? clientState?.runtimeSession;
        const { disposition, disconnectBehavior, shouldCleanupAuthState } =
          await resolveDisconnectLifecycle(clientState, runtimeSession);
        const capturedDataValues = capturePromotableSessionDataValues(runtimeSession);

        let terminalizationHandled = clientState?.explicitTerminalizationHandled === true;
        if (!terminalizationHandled && clientState?.terminalSourceOverride === 'sdk_end_session') {
          if (runtimeSession) {
            try {
              await executor.saveSessionSnapshot(runtimeSession);
            } catch (err) {
              log.warn('Failed to save SDK session snapshot before explicit terminalization', {
                error: err instanceof Error ? err.message : String(err),
                sessionId: runtimeSession.id,
              });
            }
          }

          terminalizationHandled = await terminalizeSdkConversationSession({
            state: clientState,
            runtimeSession,
            disposition,
            source: clientState.terminalSourceOverride,
            capturedDataValues,
          });
        } else if (!terminalizationHandled && clientState && disconnectBehavior === 'end') {
          if (runtimeSession) {
            try {
              await executor.saveSessionSnapshot(runtimeSession);
            } catch (err) {
              log.warn('Failed to save SDK session snapshot before disconnect terminalization', {
                error: err instanceof Error ? err.message : String(err),
                sessionId: runtimeSession.id,
              });
            }
          }

          terminalizationHandled = await terminalizeSdkConversationSession({
            state: clientState,
            runtimeSession,
            disposition,
            source: 'disconnect',
            capturedDataValues,
          });
        }

        if (!terminalizationHandled) {
          if (runtimeId) {
            if (runtimeSession) {
              executor.saveSessionSnapshot(runtimeSession).finally(() => {
                if (disconnectBehavior === 'end') {
                  executor.endSession(runtimeId);
                } else {
                  executor.detachSession(runtimeId);
                }
              });
            } else {
              if (disconnectBehavior === 'end') {
                executor.endSession(runtimeId);
              } else {
                executor.detachSession(runtimeId);
              }
            }
          }
          // Flush pending messages then end DB session — run inside tenant context
          // so MongoConversationStore.endSession() has ALS tenant isolation when needed.
          if (clientState?.dbSessionId) {
            const dbSid = clientState.dbSessionId;
            const doFlushAndFinalize = () =>
              flushMessageQueue(dbSid)
                .then(() => {
                  if (disconnectBehavior === 'end' && isDatabaseAvailable()) {
                    return getConversationStore().endSession(dbSid, disposition);
                  }
                })
                // session.ended event is now emitted centrally from MongoConversationStore.endSession()
                .catch((err: unknown) =>
                  log.error('Failed to flush/finalize DB session', {
                    error: err instanceof Error ? err.message : String(err),
                    dbSid,
                    disconnectBehavior,
                  }),
                )
                .then(() => {
                  if (disconnectBehavior === 'end') {
                    enqueuePromoteContextAfterSessionEnd({
                      tenantId: clientState.tenantId,
                      contactId: clientState.callerContext?.contactId,
                      sessionId: dbSid,
                      disposition,
                      dataValues: capturedDataValues,
                    });
                  } else {
                    log.info('Preserving SDK DB session after resumable disconnect', {
                      dbSid,
                      sessionId: runtimeId ?? clientState.sessionId,
                      projectId: clientState.projectId,
                    });
                  }
                });

            if (clientState.tenantId) {
              runWithTenantContext(buildTenantContextData(clientState), doFlushAndFinalize);
            } else {
              doFlushAndFinalize();
            }
          }
        }
        // Resolution keys intentionally survive WS disconnects — they expire via TTL.
        // This allows returning users to resume sessions across connections.

        // Clean up auth state only when the session itself is ending.
        if (runtimeId && shouldCleanupAuthState) {
          getPausedExecutionStore()
            .cleanupSession(runtimeId, 'disconnect')
            .catch((err) => {
              log.warn('Failed to cleanup paused executions on SDK disconnect', {
                error: err instanceof Error ? err.message : String(err),
                sessionId: runtimeId,
              });
            });
        }

        // Clean up auth gate state for this session only when disconnect ends the session.
        const runtimeSidForCleanup = clientState?.runtimeSession?.id;
        if (runtimeSidForCleanup && shouldCleanupAuthState) {
          void cleanupAuthGateAsync(runtimeSidForCleanup).catch((err) => {
            log.warn('Failed to cleanup auth gate on SDK disconnect', {
              error: err instanceof Error ? err.message : String(err),
              sessionId: runtimeSidForCleanup,
            });
          });
        }

        // Omnichannel: detach any live session participant for this connection
        if (
          disconnectLiveSessionId &&
          disconnectLiveParticipantId &&
          disconnectLiveContactId &&
          clientState?.tenantId
        ) {
          liveSessionService
            .detachParticipant(
              disconnectLiveSessionId,
              disconnectLiveParticipantId,
              clientState.tenantId,
              clientState.projectId,
            )
            .then(async () => {
              fanOutParticipantEvent(
                disconnectLiveSessionId,
                'participant_detached',
                createParticipant({
                  participantId: disconnectLiveParticipantId,
                  sessionId: disconnectLiveSessionId,
                  contactId: disconnectLiveContactId,
                  surface: 'web',
                  interactive: false,
                }),
              );

              // Check if session should end (no remaining participants)
              const remaining = await participantRegistry.getParticipants(disconnectLiveSessionId);
              if (remaining.length === 0) {
                await liveSessionService.endLiveSync(
                  disconnectLiveSessionId,
                  clientState.tenantId,
                  clientState.projectId,
                  disconnectLiveContactId,
                );
              }
            })
            .catch((err) => {
              log.warn('Failed to detach omnichannel participant on disconnect', {
                error: err instanceof Error ? err.message : String(err),
                sessionId: state.sessionId,
              });
            });
        }
      } catch (err) {
        log.warn('SDK disconnect cleanup failed unexpectedly', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: state.sessionId,
        });
      } finally {
        sdkClients.remove(ws);
        log.info('SDK client disconnected', { sessionId: state.sessionId });
      }
    })();
  });

  ws.on('error', (error) => {
    log.error('SDK client error', { error: error.message, sessionId: state.sessionId });
    void (async () => {
      try {
        const errState = sdkClients.get(ws);
        unregisterSdkRegistry(errState);
        const errRuntimeSid = errState?.runtimeSession?.id;
        const runtimeSession =
          (errRuntimeSid ? getRuntimeExecutor().getSession(errRuntimeSid) : undefined) ??
          errState?.runtimeSession;
        const { disconnectBehavior } = await resolveDisconnectLifecycle(errState, runtimeSession);
        if (errRuntimeSid && disconnectBehavior === 'end') {
          void cleanupAuthGateAsync(errRuntimeSid).catch((err) => {
            log.warn('Failed to cleanup auth gate after SDK socket error', {
              error: err instanceof Error ? err.message : String(err),
              sessionId: errRuntimeSid,
            });
          });
        }
      } catch (err) {
        log.warn('SDK socket error lifecycle resolution failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: state.sessionId,
        });
      } finally {
        sdkClients.remove(ws);
      }
    })();
  });
}

async function handleMessageTimeout(ws: WebSocket, state: SDKClientState): Promise<void> {
  const sessionId = getBoundSessionId(state);
  log.error('WS message processing timed out', {
    sessionId: sessionId ?? state.sessionId,
  });

  if (sessionId && isCoordinatorAvailable()) {
    try {
      await getExecutionCoordinator().cancelSession(sessionId);
    } catch (err) {
      log.warn('Failed to cancel timed-out SDK execution', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: sessionId,
      });
    }
  }

  send(ws, ServerMessages.error('Request timed out'));
  if (ws.readyState === ws.OPEN) {
    ws.close(WS_MESSAGE_TIMEOUT_CLOSE_CODE, 'Request timed out');
  }
}

function buildExecuteMessageOptions(params: {
  attachmentIds?: string[];
  messageMetadata?: ExecuteMessageOptions['messageMetadata'];
  interactionContext?: ExecuteMessageOptions['interactionContext'];
  actionEvent?: ExecuteMessageOptions['actionEvent'];
  sessionLocator?: ExecuteMessageOptions['sessionLocator'];
  signal?: AbortSignal;
  channelMetadata?: ExecuteMessageOptions['channelMetadata'];
}): ExecuteMessageOptions | undefined {
  const options: ExecuteMessageOptions = {};
  if (params.attachmentIds && params.attachmentIds.length > 0) {
    options.attachmentIds = params.attachmentIds;
  }
  if (params.messageMetadata) {
    options.messageMetadata = params.messageMetadata;
  }
  if (params.interactionContext) {
    options.interactionContext = params.interactionContext;
  }
  if (params.actionEvent) {
    options.actionEvent = params.actionEvent;
  }
  if (params.sessionLocator) {
    options.sessionLocator = params.sessionLocator;
  }
  if (params.signal) {
    options.signal = params.signal;
  }
  if (params.channelMetadata) {
    options.channelMetadata = params.channelMetadata;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

// =============================================================================
// WS CONNECTION RATE LIMITER
// =============================================================================

/** Parse an integer from an env var, returning the fallback on missing/NaN */
function safeParseInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Default max WebSocket connections per IP per minute */
const WS_CONN_RATE_LIMIT_PER_IP = safeParseInt(process.env.WS_CONN_RATE_LIMIT_PER_IP, 30);

/** Cleanup interval for stale WS rate limiter entries in ms (default: 2 minutes) */
const WS_RATE_LIMITER_CLEANUP_MS = safeParseInt(process.env.WS_RATE_LIMITER_CLEANUP_MS, 120_000);

/**
 * Simple sliding-window rate limiter for WebSocket connection attempts.
 * Keyed by IP address (pre-auth) or tenant+IP (post-auth) to prevent
 * connection floods while ensuring tenants behind the same NAT don't
 * interfere with each other's rate limits.
 */
export class WSConnectionRateLimiter {
  private windows = new Map<string, { count: number; windowStart: number }>();
  private readonly maxPerMinute: number;
  private readonly windowMs = 60_000;

  constructor(maxPerMinute = WS_CONN_RATE_LIMIT_PER_IP) {
    this.maxPerMinute = maxPerMinute;
    // Cleanup stale entries periodically
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.windows) {
        if (now - entry.windowStart > this.windowMs * 2) this.windows.delete(key);
      }
    }, WS_RATE_LIMITER_CLEANUP_MS);
    timer.unref();
  }

  /**
   * Check whether a connection attempt is within the rate limit.
   *
   * @param ip - Client IP address
   * @param tenantId - Optional tenant ID. When provided, the rate limit bucket
   *   is scoped to `tenantId:ip` so that different tenants behind the same
   *   corporate NAT each get their own limit.
   * @returns true if under the limit, false if rate-limited
   */
  check(ip: string, tenantId?: string): boolean {
    const key = tenantId ? `${tenantId}:${ip}` : ip;
    const now = Date.now();
    let entry = this.windows.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      // Enforce max entries: evict oldest entry to make room (prevents unbounded growth
      // without failing open, which would allow DDoS traffic through unchecked)
      if (!entry && this.windows.size >= MAX_RATE_LIMITER_ENTRIES) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
      entry = { count: 0, windowStart: now };
      this.windows.set(key, entry);
    }
    entry.count++;
    return entry.count <= this.maxPerMinute;
  }
}

const wsRateLimiter = new WSConnectionRateLimiter();

// =============================================================================
// SESSION RESOLUTION HELPERS
// =============================================================================

/**
 * Register a resolution key after session creation (fire-and-forget).
 * Only registers if the caller has a channel artifact for future resolution.
 */
function registerResolutionKeyIfArtifact(state: SDKClientState, sessionId: string): void {
  if (!state.callerContext?.channelArtifact || !state.channelId || !state.tenantId) return;

  const sessionService = getSessionService();
  if (!sessionService.isDistributed()) {
    return;
  }

  const sessionStore = sessionService.store;
  registerResolutionKey(sessionStore, {
    tenantId: state.tenantId,
    channelId: state.channelId,
    artifactHash: state.callerContext.channelArtifact,
    sessionId,
  }).catch((err) => {
    log.warn('Failed to register resolution key', {
      error: err instanceof Error ? err.message : String(err),
      sessionId: state.sessionId,
    });
  });
}

// =============================================================================
// CONTACT LINKING HELPERS
// =============================================================================

/**
 * Fire-and-forget contact resolution and linking for tier 2+ SDK users.
 * Runs asynchronously after session creation — does not block initialization.
 */
function resolveAndLinkContactIfEligible(state: SDKClientState, sessionId: string): void {
  // Quick guard: skip if not tier 2+
  if (!state.callerContext || state.callerContext.identityTier < 2) return;
  if (!state.tenantId) return;

  const deps = getContactLinkingDeps();
  if (!deps) return;

  resolveAndLinkContact(state, sessionId, deps)
    .then(async (result) => {
      if (!result || !state.callerContext) return;
      const { contactId, displayName } = result;
      // Store contactId and displayName on callerContext for downstream use (trace events, agent transfer, etc.)
      state.callerContext = { ...state.callerContext, contactId, contactDisplayName: displayName };
      const executor = getRuntimeExecutor();
      const session = executor.getSession(sessionId);
      if (session) {
        applyCallerContextToRuntimeSession(session, state.callerContext);
      }
      await syncDbSessionContactIdentity(state, state.dbSessionId);

      // Pre-populate cross-session contact context (non-critical)
      const tenantId = state.tenantId;
      if (!tenantId) return;
      try {
        const { getContactContextService } = await import('../services/contact-context-service.js');
        const svc = await getContactContextService();
        const contactCtx = await svc.get(tenantId, contactId);
        if (contactCtx) {
          state.callerContext = {
            ...state.callerContext,
            contactContext: contactCtx.dataValues,
            contactPreferences: contactCtx.preferences,
          };
          // Seed session data.values with contact context (non-overwriting)
          if (session) {
            for (const [key, value] of Object.entries(contactCtx.dataValues)) {
              if (session.data.values[key] === undefined) {
                session.data.values[key] = value;
              }
            }
          }
        }
      } catch (err) {
        log.warn('Contact context pre-population failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: state.sessionId,
        });
      }
    })
    .catch((err) => {
      log.warn('Contact linking fire-and-forget failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: state.sessionId,
      });
    });
}

// =============================================================================
// USER CONTEXT HELPERS
// =============================================================================

function resolveSdkBootstrapInteractionContext(
  state: SDKClientState,
): ExecuteMessageOptions['interactionContext'] | undefined {
  const attrs = state.userContext?.customAttributes;
  if (!attrs) {
    return undefined;
  }

  const topLevel = normalizeInteractionContextInput(attrs, 'sanitize');
  const nested =
    typeof attrs.interactionContext === 'object' && attrs.interactionContext !== null
      ? normalizeInteractionContextInput(attrs.interactionContext, 'sanitize')
      : undefined;

  return mergeInteractionContextInputs(
    topLevel.success ? topLevel.data : undefined,
    nested?.success ? nested.data : undefined,
  );
}

/**
 * Apply SDK user context (customAttributes) to a runtime session.
 * Only writes caller attributes — no mocks, no gather pre-fill.
 */
function applyUserContext(session: RuntimeSession, state: SDKClientState): void {
  if (!state.userContext?.customAttributes) return;

  const attrs = state.userContext.customAttributes;
  for (const [key, value] of Object.entries(attrs)) {
    session.data.values[key] = value;
  }

  // Validate and populate customDimensions for analytics extraction
  mergeSessionDimensions(session, attrs);

  // Auto-extract traceDimensions: project-configured session value keys → customDimensions.
  // Runs after customAttributes have populated session.data.values so the keys are available.
  if (session.traceDimensionKeys?.length) {
    const toExtract: Record<string, unknown> = {};
    for (const key of session.traceDimensionKeys) {
      const val = session.data.values[key];
      if (val !== undefined && val !== null) {
        toExtract[key] = val;
      }
    }
    if (Object.keys(toExtract).length > 0) {
      mergeSessionDimensions(session, toExtract);
    }
  }
}

// =============================================================================
// WARMUP HELPERS
// =============================================================================

function warmupLLM(executor: ReturnType<typeof getRuntimeExecutor>, sessionId: string): void {
  // Fire-and-forget: ensure LLM client is wired without triggering ON_START or sending messages
  executor
    .ensureLLMReady(sessionId)
    .then(() => log.debug('LLM warmup complete', { sessionId }))
    .catch((err) =>
      log.warn('LLM warmup failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
}

// =============================================================================
// ON_START — proactive greeting before user input
// =============================================================================

/**
 * Fire ON_START / first flow step so the agent can greet immediately.
 * Runs async (fire-and-forget from the connection handler) so session_start
 * reaches the client first, then the welcome message streams in.
 */
async function fireOnStart(ws: WebSocket, state: SDKClientState): Promise<void> {
  const runtimeSession = state.runtimeSession;
  if (!runtimeSession) return;

  // Only fire if the agent declares ON_START or has a flow entry point
  if (!runtimeSession.agentIR?.on_start && !runtimeSession.currentFlowStep) return;

  const executor = getRuntimeExecutor();
  const responseMessageId = crypto.randomUUID();
  const initExecutionId = `exec-${crypto.randomUUID()}`;
  const allChunks: string[] = [];
  let responseFrameOpen = false;

  // Accumulate metrics
  let turnTokensIn = 0;
  let turnTokensOut = 0;
  let turnCost = 0;
  let turnTraceCount = 0;
  let turnErrorCount = 0;
  let turnHandoffCount = 0;
  const responseProvenance = createResponseProvenanceAccumulator();

  try {
    const result = await executor.initializeSession(
      runtimeSession.id,
      (chunk: string) => {
        if (!responseFrameOpen) {
          send(
            ws,
            ServerMessages.responseStart(state.sessionId, responseMessageId, initExecutionId),
          );
          responseFrameOpen = true;
        }
        allChunks.push(chunk);
        send(ws, ServerMessages.responseChunk(state.sessionId, responseMessageId, chunk));
      },
      (event: { type: string; data: Record<string, unknown> }) => {
        if (event.type === 'llm_call' && event.data) {
          const metrics = extractLlmTraceMetrics(event.data);
          turnTokensIn += metrics.tokensIn;
          turnTokensOut += metrics.tokensOut;
          turnCost += metrics.cost;
          accumulateResponseProvenance(responseProvenance, event);
        }
        turnTraceCount++;
        if (event.type === 'error') turnErrorCount++;
        if (event.type === 'handoff') turnHandoffCount++;

        // Forward trace through Tracer for span context enrichment
        if (runtimeSession.tracer) {
          runtimeSession.tracer.emit({ type: event.type, data: event.data });
        }
      },
    );

    if (!result) {
      return;
    }

    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      result,
      streamedText: allChunks.length > 0 ? allChunks.join('') : undefined,
      session: executor.getSession(runtimeSession.id) ?? runtimeSession,
    });
    const onStartStructuredContent = buildPersistedAssistantStructuredContent(outcome);
    const responseMetadata = withAgentNameMetadata(
      outcome.responseMetadata ??
        result.responseMetadata ??
        buildResponseMessageMetadata(responseProvenance),
      runtimeSession.agentName,
    );

    if (!responseFrameOpen) {
      send(ws, ServerMessages.responseStart(state.sessionId, responseMessageId, initExecutionId));
      responseFrameOpen = true;
    }

    if (responseFrameOpen) {
      send(
        ws,
        ServerMessages.responseEnd(
          state.sessionId,
          responseMessageId,
          outcome.responseText,
          outcome.voiceConfig || undefined,
          outcome.richContent || undefined,
          outcome.actions || undefined,
          initExecutionId,
          responseMetadata,
          outcome.localization,
        ),
      );

      // Persist the ON_START message to DB
      if (state.dbSessionId && hasRenderableChannelOutcome(outcome)) {
        let scopedPersistence: ProductionExecutionScope | null = null;
        try {
          scopedPersistence = buildSdkPersistenceScope(state);
        } catch (err) {
          log.warn('Skipping ON_START scoped persistence due to invalid execution scope', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: getBoundSessionId(state) ?? state.sessionId,
          });
        }
        if (scopedPersistence) {
          persistScopedMessage({
            scope: scopedPersistence,
            message: {
              dbSessionId: state.dbSessionId,
              role: 'assistant',
              content: outcome.responseText,
              structuredContent: onStartStructuredContent,
              channel: 'web_chat',
              metadata: responseMetadata,
              messageId: responseMessageId,
              agentName: runtimeSession.agentName,
            },
          }).catch((err: unknown) => log.warn('ON_START persist failed', { error: err }));
          persistScopedTurnMetrics({
            scope: scopedPersistence,
            metrics: {
              dbSessionId: state.dbSessionId,
              tokensIn: turnTokensIn,
              tokensOut: turnTokensOut,
              cost: turnCost,
              traceEventCount: turnTraceCount,
              errorCount: turnErrorCount,
              handoffCount: turnHandoffCount,
            },
          }).catch((err: unknown) => log.warn('ON_START metrics persist failed', { error: err }));
        } else if (shouldUseLegacySdkPersistence(state)) {
          persistMessageRecord({
            dbSessionId: state.dbSessionId,
            role: 'assistant',
            content: outcome.responseText,
            channel: 'web_chat',
            tenantId: state.tenantId,
            contactId: state.callerContext?.contactId,
            projectId: state.projectId,
            structuredContent: onStartStructuredContent,
            metadata: responseMetadata as unknown as Partial<MessageMetadata>,
            messageId: responseMessageId,
            agentName: runtimeSession.agentName,
          }).catch((err: unknown) => log.warn('ON_START persist failed', { error: err }));
          persistTurnMetrics({
            dbSessionId: state.dbSessionId,
            tenantId: state.tenantId,
            tokensIn: turnTokensIn,
            tokensOut: turnTokensOut,
            cost: turnCost,
            traceEventCount: turnTraceCount,
            errorCount: turnErrorCount,
            handoffCount: turnHandoffCount,
          }).catch((err: unknown) => log.warn('ON_START metrics persist failed', { error: err }));
        } else {
          log.warn(
            'Skipping legacy ON_START persistence because canonical execution scope is required',
            {
              sessionId: getBoundSessionId(state) ?? state.sessionId,
            },
          );
        }
      }
    }

    if (result) {
      send(
        ws,
        ServerMessages.action(
          state.sessionId,
          result.action as import('../types/index.js').ConstructAction,
        ),
      );
    }

    log.info('ON_START fired', { sessionId: state.sessionId, hasResponse: responseFrameOpen });
  } catch (error) {
    log.error('ON_START failed', { error, sessionId: state.sessionId });
    if (!responseFrameOpen) {
      send(ws, ServerMessages.responseStart(state.sessionId, responseMessageId, initExecutionId));
    }
    send(
      ws,
      ServerMessages.responseEnd(
        state.sessionId,
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

async function deliverPendingSdkResults(ws: WebSocket, state: SDKClientState): Promise<void> {
  const effectiveSessionId = getBoundSessionId(state) ?? state.sessionId;
  const asyncInfra = (getRuntimeExecutor() as unknown as { _asyncInfra?: unknown })._asyncInfra as
    | {
        pendingDeliveryStore?: {
          retrieve(sessionId: string): Promise<
            Array<{
              executionId?: string;
              result?: {
                executionId?: string;
                response?: string;
                richContent?: Record<string, unknown>;
                actions?: unknown;
                voiceConfig?: import('@abl/compiler').VoiceConfigIR;
                responseMetadata?: ResponseMessageMetadata;
                localization?: import('../services/session/persisted-message-content.js').PersistedMessageLocalizationOwnershipV1;
              };
            }>
          >;
          remove(sessionId: string): Promise<void>;
        };
      }
    | undefined;

  if (!asyncInfra?.pendingDeliveryStore) {
    return;
  }

  try {
    const pending = await asyncInfra.pendingDeliveryStore.retrieve(effectiveSessionId);
    if (pending.length === 0) {
      return;
    }

    for (const entry of pending) {
      const messageId = crypto.randomUUID();
      const executionId =
        entry.executionId ?? entry.result?.executionId ?? `exec-${crypto.randomUUID()}`;
      send(ws, ServerMessages.responseStart(state.sessionId, messageId, executionId));

      if (entry.result?.response) {
        send(
          ws,
          ServerMessages.responseChunk(
            state.sessionId,
            messageId,
            entry.result.response,
            entry.result.richContent as import('@abl/compiler').RichContentIR | undefined,
            entry.result.actions as import('@abl/compiler').ActionSetIR | undefined,
          ),
        );
      }

      send(
        ws,
        ServerMessages.responseEnd(
          state.sessionId,
          messageId,
          entry.result?.response ?? '',
          entry.result?.voiceConfig,
          entry.result?.richContent,
          entry.result?.actions as import('@abl/compiler').ActionSetIR | undefined,
          executionId,
          entry.result?.responseMetadata,
          entry.result?.localization,
        ),
      );
    }

    await asyncInfra.pendingDeliveryStore.remove(effectiveSessionId);
    log.info('Delivered pending SDK result(s)', {
      sessionId: effectiveSessionId,
      count: pending.length,
    });
  } catch (err) {
    log.warn('Failed to deliver pending SDK results', {
      sessionId: effectiveSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// =============================================================================
// AGENT INITIALIZATION
// =============================================================================

async function initializeProjectAgent(ws: WebSocket, state: SDKClientState): Promise<void> {
  let sessionSlotClaimed = false;
  try {
    const dbAvailable = isDatabaseAvailable();

    await ensureSdkContactForRequiredProductionScope(state);

    let entryAgentName = 'sdk_agent';
    let combinedDSL: string | null = null;

    // =====================================================================
    // SESSION RESOLUTION: Check if an existing session can be resumed
    // =====================================================================
    const sessionService = getSessionService();
    if (
      sessionService.isDistributed() &&
      state.callerContext?.channelArtifact &&
      state.channelId &&
      state.tenantId
    ) {
      try {
        const sessionStore = sessionService.store;
        const resolution = await resolveSession(sessionStore, {
          tenantId: state.tenantId,
          channelId: state.channelId,
          callerContext: state.callerContext,
        });

        // Emit trace event for session resolution outcome
        // TODO: Route through tracer once session is available at this point
        const resolutionTraceEvent: TraceEventWithId = {
          id: crypto.randomUUID(),
          sessionId: state.sessionId,
          type: 'session_resolution' as TraceEventType,
          timestamp: new Date(),
          data: {
            outcome: resolution.outcome,
            reason: resolution.reason,
            resolvedSessionId: resolution.sessionId,
            tenantId: state.tenantId,
            channelId: state.channelId,
            identityTier: state.callerContext?.identityTier,
          },
        };
        getTraceStore().addEvent(state.sessionId, resolutionTraceEvent);

        if (resolution.outcome === 'existing' && resolution.sessionId) {
          const executor = getRuntimeExecutor();
          // Try to rehydrate the existing session
          let existingSession = executor.getSession(resolution.sessionId);
          if (existingSession) {
            bindJitAuthCallbacksToSession(ws, existingSession);
          }
          if (!existingSession) {
            const existingLocator = buildSdkSessionLocator(state, resolution.sessionId);
            existingSession =
              (await executor.rehydrateSession(
                resolution.sessionId,
                existingLocator ? { locator: existingLocator } : undefined,
              )) ?? undefined;
            if (existingSession) {
              bindJitAuthCallbacksToSession(ws, existingSession);
            }
          }

          if (existingSession) {
            bindRuntimeSession(state, existingSession);

            log.info('Session resumed via artifact resolution', {
              sessionId: state.sessionId,
              channelId: state.channelId,
            });

            // Warm up LLM for the resumed session
            warmupLLM(getRuntimeExecutor(), existingSession.id);

            // Refresh resolution key TTL (fire-and-forget)
            registerResolutionKeyIfArtifact(state, existingSession.id);

            // Resumed sessions may need a durable DB record for session-scoped HTTP APIs.
            state.pendingDbSession = {
              channel: 'web_chat',
              agentName: existingSession.agentName,
              agentVersion: '1.0',
              environment: (existingSession.versionInfo?.environment as Environment) || 'dev',
              entryAgentName: existingSession.agentName,
              deploymentId: state.deploymentId,
            };

            return; // Session resumed — skip creation
          }
        }
      } catch (err) {
        log.warn('Session resolution failed, proceeding with new session', {
          error: err instanceof Error ? err.message : String(err),
          channelId: state.channelId,
        });
      }
    }

    // Pre-flight quota check: verify tenant has session capacity before creating
    if (state.tenantId) {
      try {
        await getRuntimeExecutor().checkSessionQuota(
          state.tenantId,
          state.projectId,
          state.sessionId,
        );
        sessionSlotClaimed = true;
      } catch (err) {
        if ((err as any)?.statusCode === 429) {
          send(ws, ServerMessages.error('Concurrent session limit exceeded'));
          ws.close(4029, 'Session limit exceeded');
          return;
        }
        // Non-fatal — allow session creation if quota check itself fails
      }
    }

    if (dbAvailable) {
      // =====================================================================
      // DEPLOYMENT-AWARE PATH: Use DeploymentResolver when deploymentId exists
      // =====================================================================
      if ((state.deploymentId || state.environment) && state.tenantId) {
        try {
          const executor = getRuntimeExecutor();
          const bootstrapInteractionContext = resolveSdkBootstrapInteractionContext(state);
          const sessionScope = buildSdkPersistenceScope(state);
          const sessionResult = await createRuntimeSession({
            projectId: state.projectId,
            tenantId: state.tenantId,
            deploymentId: state.deploymentId,
            environment: state.environment,
            sessionId: state.sessionId,
            userId: state.userId,
            authToken: state.authToken,
            channelType: RUNTIME_CHANNEL.WEB_CHAT,
            callerContext: state.callerContext,
            callerData: state.userContext?.customAttributes,
            interactionContext: bootstrapInteractionContext,
            ...(sessionScope ? { scope: sessionScope } : {}),
          });
          const runtimeSession = sessionResult.runtimeSession;
          const resolved = sessionResult.resolved;

          if (!resolved) {
            throw new Error('Deployment-resolved SDK session missing resolved payload');
          }

          sessionSlotClaimed = false; // slot now owned by the session
          bindRuntimeSession(state, runtimeSession);
          bindJitAuthCallbacksToSession(ws, runtimeSession);

          log.info('Agent initialized (deployment-resolved)', {
            sessionId: state.sessionId,
            deploymentId: state.deploymentId,
            environment: resolved.versionInfo.environment,
            entryAgent: resolved.entryAgent,
            versions: resolved.versionInfo.versions,
          });

          warmupLLM(executor, runtimeSession.id);

          // Register resolution key for session continuity (fire-and-forget)
          registerResolutionKeyIfArtifact(state, runtimeSession.id);

          // Resolve/create contact for tier 2+ users (fire-and-forget)
          resolveAndLinkContactIfEligible(state, runtimeSession.id);

          // Keep the metadata required to materialize or recover the durable DB session.
          const envMap: Record<string, 'dev' | 'staging' | 'production'> = {
            dev: 'dev',
            development: 'dev',
            staging: 'staging',
            production: 'production',
            prod: 'production',
          };
          state.pendingDbSession = {
            channel: 'web_chat',
            agentName: resolved.entryAgent,
            agentVersion: resolvePersistedAgentVersion(resolved.versionInfo, resolved.entryAgent),
            environment:
              envMap[resolved.versionInfo.environment] || resolved.versionInfo.environment,
            entryAgentName: resolved.entryAgent,
            deploymentId: state.deploymentId,
          };

          return;
        } catch (err) {
          if (sessionSlotClaimed && state.tenantId) {
            await getRuntimeExecutor().releaseSessionSlot(state.tenantId, state.sessionId);
            sessionSlotClaimed = false;
          }
          const statusCode = (err as any).statusCode;
          if (statusCode === 410) {
            send(ws, ServerMessages.error('Deployment is retired'));
            ws.close(4010, 'Deployment retired');
            return;
          }
          // deploymentId/environment was explicitly requested — do not fall through to legacy path
          log.error('Deployment-scoped session creation failed', {
            error: err instanceof Error ? err.message : String(err),
            deploymentId: state.deploymentId,
          });
          send(ws, ServerMessages.error('Failed to resolve deployment'));
          ws.close(4010, 'Deployment resolution failed');
          return;
        }
      }

      // =====================================================================
      // LEGACY PATH: Load from ProjectAgent.dslContent and compile fresh
      // =====================================================================

      // Load project with ALL agents (needed for supervisor/multi-agent setups)
      const project = await findProjectWithAgents(state.projectId, state.tenantId || '');

      if (project) {
        // Tenant isolation: verify token's tenantId matches the project's tenant
        if (state.tenantId && project.tenantId && state.tenantId !== project.tenantId) {
          log.warn('Tenant mismatch: token tenant does not match project tenant', {
            tokenTenantId: state.tenantId,
            projectTenantId: project.tenantId,
            projectId: state.projectId,
          });
          if (sessionSlotClaimed && state.tenantId) {
            await getRuntimeExecutor().releaseSessionSlot(state.tenantId, state.sessionId);
            sessionSlotClaimed = false;
          }
          send(ws, ServerMessages.error('Project does not belong to your tenant'));
          ws.close(4003, 'Tenant mismatch');
          return;
        }
        state.tenantId = state.tenantId || project.tenantId || undefined;
      }

      if (project && project.agents.length > 0) {
        const readiness = await evaluateProjectExecutionReadiness({
          agents: project.agents,
          tenantId: state.tenantId || project.tenantId || '',
          projectId: state.projectId,
          runtimeConfig: await findProjectRuntimeConfig(
            state.projectId,
            state.tenantId || project.tenantId || '',
          ),
          lazyBackfill: true,
        });
        if (readiness.hasBlockingErrors) {
          log.warn('SDK legacy path refused project with invalid DSL', {
            projectId: state.projectId,
            tenantId: state.tenantId,
            blockedAgents: readiness.blockedAgents,
            issueKinds: readiness.issues.map((issue) => issue.kind),
          });
          if (sessionSlotClaimed && state.tenantId) {
            await getRuntimeExecutor().releaseSessionSlot(state.tenantId, state.sessionId);
            sessionSlotClaimed = false;
          }
          send(ws, ServerMessages.error(buildProjectDslReadinessError()));
          ws.close(4010, 'Project DSL validation failed');
          return;
        }

        const agentsWithDsl = readiness.executableAgents;

        if (agentsWithDsl.length > 0) {
          // Use project's configured entry agent, falling back to first agent by creation date
          entryAgentName = resolveProjectEntryAgentName(project);

          log.info('Loading project agents', {
            projectId: state.projectId,
            entryAgent: entryAgentName,
            totalAgents: agentsWithDsl.length,
          });

          const executor = getRuntimeExecutor();
          const bootstrapInteractionContext = resolveSdkBootstrapInteractionContext(state);
          const sessionScope = buildSdkPersistenceScope(state);
          const sessionResult = await createRuntimeSession({
            projectId: state.projectId,
            tenantId: state.tenantId,
            sessionId: state.sessionId,
            userId: state.userId,
            authToken: state.authToken,
            channelType: 'sdk_websocket',
            callerContext: state.callerContext,
            callerData: state.userContext?.customAttributes,
            interactionContext: bootstrapInteractionContext,
            ...(sessionScope ? { scope: sessionScope } : {}),
          });
          const runtimeSession = sessionResult.runtimeSession;
          entryAgentName = sessionResult.entryAgentName;

          sessionSlotClaimed = false; // slot now owned by the session
          bindRuntimeSession(state, runtimeSession);
          bindJitAuthCallbacksToSession(ws, runtimeSession);

          log.info('Agent initialized (multi-agent)', {
            sessionId: state.sessionId,
            entryAgent: entryAgentName,
            totalAgents: agentsWithDsl.length,
          });

          // Pre-warm LLM connection in background (reduces first response latency)
          warmupLLM(executor, runtimeSession.id);

          // Register resolution key for session continuity (fire-and-forget)
          registerResolutionKeyIfArtifact(state, runtimeSession.id);

          // Resolve/create contact for tier 2+ users (fire-and-forget)
          resolveAndLinkContactIfEligible(state, runtimeSession.id);

          // Keep the metadata required to materialize or recover the durable DB session.
          state.pendingDbSession = {
            channel: 'web_chat',
            agentName: entryAgentName,
            agentVersion: '1.0',
            environment: 'dev',
            entryAgentName,
          };

          return; // Early return - session created successfully
        }
      }
    }

    // Fallback: Create runtime session with default agent
    const executor = getRuntimeExecutor();

    if (executor.isConfigured()) {
      // Use default agent DSL
      const defaultAgentDSL = `
agent sdk_agent {
  name: "SDK Agent"
  description: "Default agent for SDK"

  reasoning {
    tools: []

    constraints {
      max_turns: 20
    }

    on_start {
      respond("Hello! How can I help you today?")
    }
  }
}
`;

      // Default agent has no tools, but resolve for consistency
      const fallbackTools =
        state.tenantId && state.projectId
          ? await resolveProjectTools(state.tenantId, state.projectId, [defaultAgentDSL])
          : undefined;

      const fallbackResolved = compileToResolvedAgent(
        [defaultAgentDSL],
        entryAgentName,
        undefined,
        fallbackTools,
        'dev',
      );
      const fallbackSessionTimeouts = await resolveSessionTimeouts(
        state.tenantId,
        state.projectId,
        getResolvedAgentLifecycle(fallbackResolved),
      );
      const bootstrapInteractionContext = resolveSdkBootstrapInteractionContext(state);
      const fallbackScope = buildSdkPersistenceScope(state);
      const runtimeSession = executor.createSessionFromResolved(fallbackResolved, {
        sessionId: state.sessionId,
        tenantId: state.tenantId,
        projectId: state.projectId,
        authToken: state.authToken,
        userId: state.userId,
        channelType: 'sdk_websocket',
        callerContext: state.callerContext,
        callerData: state.userContext?.customAttributes,
        interactionContext: bootstrapInteractionContext,
        ...(fallbackScope ? { scope: fallbackScope } : {}),
        ...fallbackSessionTimeouts,
      });
      sessionSlotClaimed = false; // slot now owned by the session
      bindRuntimeSession(state, runtimeSession);
      bindJitAuthCallbacksToSession(ws, runtimeSession);

      // Resolve/create contact for tier 2+ users (fire-and-forget)
      resolveAndLinkContactIfEligible(state, runtimeSession.id);

      log.info('Agent initialized', {
        sessionId: state.sessionId,
        entryAgent: entryAgentName,
      });

      state.pendingDbSession = {
        channel: 'web_chat',
        agentName: entryAgentName,
        agentVersion: '1.0',
        environment: (state.runtimeSession?.versionInfo?.environment as Environment) || 'dev',
        entryAgentName,
        deploymentId: state.deploymentId,
      };
    }

    // Safety net: if we claimed a slot but never created a session (e.g. executor
    // not configured, all code paths fell through), release the slot now.
    if (sessionSlotClaimed && state.tenantId) {
      await getRuntimeExecutor().releaseSessionSlot(state.tenantId, state.sessionId);
      sessionSlotClaimed = false;
    }
  } catch (error) {
    if (sessionSlotClaimed && state.tenantId) {
      await getRuntimeExecutor().releaseSessionSlot(state.tenantId, state.sessionId);
    }
    if (error instanceof ScopeValidationError) {
      log.warn('Rejected SDK session initialization due to invalid execution scope', {
        error: error.message,
        code: error.code,
        sessionId: state.sessionId,
      });
      send(ws, ServerMessages.error('Invalid production session scope.'));
      ws.close(4008, 'Invalid session scope');
      return;
    }
    log.error('Failed to initialize agent', { error, sessionId: state.sessionId });
    send(ws, ServerMessages.error('Failed to initialize agent'));
  }
}

// =============================================================================
// MESSAGE HANDLING
// =============================================================================

async function handleSDKMessage(
  ws: WebSocket,
  data: string,
  executionContext?: SDKMessageExecutionContext,
): Promise<void> {
  const state = sdkClients.get(ws);
  if (!state) {
    send(ws, ServerMessages.error('Session not found'));
    return;
  }

  let message: SDKIncomingMessage;
  try {
    message = JSON.parse(data) as SDKIncomingMessage;
  } catch {
    send(ws, ServerMessages.error('Invalid message format'));
    return;
  }

  if (!message.type) {
    send(ws, ServerMessages.error('Missing message type'));
    return;
  }

  // Compatibility shim for older published SDK bundles that still send
  // application-level ping heartbeats after session_start.
  if (message.type === 'ping') {
    sendLegacyPong(ws);
    return;
  }

  log.debug('SDK message received', { type: message.type, sessionId: state.sessionId });

  switch (message.type) {
    case 'chat_message':
      // Preserve the raw parsed payload as unknown here. handleChatMessage() is the
      // validation boundary and normalizes per-message metadata before execution.
      const rawMessageMetadata: unknown = message.metadata;
      await handleChatMessage(
        ws,
        state,
        {
          text: message.text as string,
          messageId: message.messageId as string,
          attachmentIds: message.attachmentIds as string[] | undefined,
          metadata: rawMessageMetadata,
          interactionContext: message.interactionContext,
        },
        executionContext,
      );
      break;

    case 'voice_token_request':
      await handleVoiceTokenRequest(ws, state, executionContext);
      break;

    case 'voice_start':
      await handleVoiceStart(ws, state, executionContext);
      break;

    case 'voice_audio':
      await handleVoiceAudio(ws, state, message.audio as string);
      break;

    case 'voice_stop':
      await handleVoiceStop(ws, state, executionContext);
      break;

    case 'barge_in':
      // User started speaking during playback - cancel audio
      handleBargeIn(ws, state);
      break;

    case 'end_session':
      await handleEndSession(ws, state);
      break;

    case 'consent_satisfy':
      handleConsentSatisfy(ws, state, message);
      break;

    case 'cancel_execution':
      await handleSDKCancelExecution(ws, state, message);
      break;

    case 'action_submit':
      await handleActionSubmit(
        ws,
        state,
        {
          actionId: message.actionId,
          value: message.value,
          renderId: message.renderId,
          ...(Object.prototype.hasOwnProperty.call(message, 'formData')
            ? { formData: message.formData }
            : {}),
        },
        executionContext,
      );
      break;

    case 'feedback.submit':
      await handleFeedbackSubmit(ws, state, message);
      break;

    case 'auth_response': {
      const toolCallId = message.toolCallId as string;
      const status = message.status as string;
      if (typeof toolCallId !== 'string' || !toolCallId) break;
      const store = getPausedExecutionStore();

      // Validate session ownership — prevent cross-session auth_response spoofing
      const clientSessionId = getBoundSessionId(state);
      const pausedData = store.get(toolCallId);
      if (pausedData && clientSessionId && pausedData.sessionId !== clientSessionId) {
        log.warn('SDK auth response rejected — session ownership mismatch', {
          toolCallId,
          expectedSessionId: pausedData.sessionId,
          actualSessionId: clientSessionId,
        });
        break;
      }

      const sessionId = clientSessionId ?? pausedData?.sessionId;
      if (!sessionId) {
        log.warn('SDK auth response rejected — session context missing', { toolCallId, status });
        break;
      }

      const result =
        status === 'completed'
          ? await store.resolveDistributed(sessionId, toolCallId)
          : await store.rejectDistributed(sessionId, toolCallId, 'cancelled');

      if (result === 'missing') {
        log.warn('SDK auth response rejected — paused execution not found', {
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
        break;
      }

      if (result === 'delivery_failed' || result === 'unavailable') {
        log.warn('SDK auth response could not be delivered to paused execution owner', {
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
        break;
      }
      log.info('SDK auth response received', { toolCallId, status });
      break;
    }

    // =====================================================================
    // OMNICHANNEL LIVE SESSION HANDLERS
    // =====================================================================

    case 'discover_live_session':
      await handleDiscoverLiveSession(ws, state, message);
      break;

    case 'join_live_session':
      await handleJoinLiveSession(ws, state, message);
      break;

    case 'typed_interrupt':
      await handleTypedInterrupt(ws, state, message);
      break;

    default:
      log.warn('Unknown SDK message type', { type: message.type });
  }
}

async function handleChatMessage(
  ws: WebSocket,
  state: SDKClientState,
  message: {
    text: string;
    messageId?: string;
    attachmentIds?: string[];
    metadata?: unknown;
    interactionContext?: unknown;
  },
  executionContext?: SDKMessageExecutionContext,
): Promise<void> {
  // Capture arrival time immediately — before any async validation or rate-limit work.
  const messageArrivalTime = Date.now();

  if (!state.permissions.chat) {
    send(ws, ServerMessages.error('Chat not enabled for this key'));
    return;
  }

  const { text, attachmentIds } = message;
  const clientMessageId =
    typeof message.messageId === 'string' && message.messageId.length > 0
      ? message.messageId
      : crypto.randomUUID();
  const metadataResult = normalizeSdkMessageMetadata(message.metadata);
  if (!metadataResult.success) {
    const firstIssue = metadataResult.error.issues[0];
    send(
      ws,
      ServerMessages.error(
        firstIssue
          ? `${metadataResult.error.message}: ${firstIssue}`
          : metadataResult.error.message,
      ),
    );
    return;
  }
  const messageMetadata = metadataResult.data;
  const interactionContextResult = normalizeInteractionContextInput(
    message.interactionContext,
    'strict',
  );
  if (!interactionContextResult.success) {
    const firstIssue = interactionContextResult.error.issues[0];
    send(
      ws,
      ServerMessages.error(
        firstIssue
          ? `${interactionContextResult.error.message}: ${firstIssue}`
          : interactionContextResult.error.message,
      ),
    );
    return;
  }
  const requestInteractionContext = interactionContextResult.data;

  // Queue messages behind auth gate if active
  const runtimeSidForGate = getBoundSessionId(state);
  if (runtimeSidForGate && state.runtimeSession) {
    let gateActive = false;
    try {
      gateActive = await hasActiveAuthGateAsync(runtimeSidForGate);
      if (!gateActive) {
        gateActive = await activateAuthGateIfRequired(
          ws,
          runtimeSidForGate,
          state.runtimeSession,
          state.userId,
          state.authScope,
        );
      }
    } catch (err) {
      log.warn('Auth preflight re-check failed for SDK session; blocking message execution', {
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
        await queueMessageBehindAuthGateAsync(
          runtimeSidForGate,
          text,
          attachmentIds,
          messageMetadata,
          requestInteractionContext,
        );
        send(ws, ServerMessages.messageQueued(state.sessionId, 'auth_gate_active'));
        emitAuthLifecycleTrace(ws, {
          sessionId: runtimeSidForGate,
          decision: 'message_queued',
          reason: 'auth_gate_active',
          attachmentCount: attachmentIds?.length ?? 0,
          textLength: text.length,
          traceId: state.traceId,
          agentName: state.runtimeSession.agentName,
        });
      } catch (err) {
        send(ws, ServerMessages.error(err instanceof Error ? err.message : String(err)));
      }
      return;
    }
  }

  const responseMessageId = crypto.randomUUID();
  const messageStartTime = Date.now();

  // Per-session message rate limiting (matches HTTP chat endpoint limits)
  const runtimeSid = getBoundSessionId(state);
  if (runtimeSid) {
    const msgRate = await checkSessionMessageRate(runtimeSid);
    if (!msgRate.allowed) {
      send(
        ws,
        ServerMessages.error(
          'Session message rate limit exceeded',
          undefined,
          msgRate.retryAfterMs,
        ),
      );
      return;
    }
  }

  // Ensure the durable DB session exists before message-side persistence.
  await ensureDbSession(state);
  if (executionContext?.signal.aborted) {
    return;
  }

  // Signal response start
  const turnExecutionId = `exec-${crypto.randomUUID()}`;
  send(ws, ServerMessages.responseStart(state.sessionId, responseMessageId, turnExecutionId));

  const executor = getRuntimeExecutor();
  const sessionId = getBoundSessionId(state);

  if (!sessionId || !executor.isConfigured()) {
    const fallbackText = PLATFORM_MESSAGES.SDK_DEMO_MODE;

    // Stream response
    for (const chunk of chunkText(fallbackText, 20)) {
      if (executionContext?.signal.aborted) {
        log.warn('Suppressing timed-out SDK demo response', {
          sessionId: sessionId ?? state.sessionId,
        });
        return;
      }
      send(ws, ServerMessages.responseChunk(state.sessionId, responseMessageId, chunk));
      await sleep(30);
    }

    if (executionContext?.signal.aborted) {
      return;
    }
    send(
      ws,
      ServerMessages.responseEnd(
        state.sessionId,
        responseMessageId,
        fallbackText,
        undefined,
        undefined,
        undefined,
        turnExecutionId,
      ),
    );
    return;
  }

  try {
    const allChunks: string[] = [];
    let lastChunkTime = 0;
    const onChunk = (chunk: string) => {
      lastChunkTime = Date.now();
      allChunks.push(chunk);
      send(ws, ServerMessages.responseChunk(state.sessionId, responseMessageId, chunk));
    };
    // Accumulate token usage from trace events
    let turnTokensIn = 0;
    let turnTokensOut = 0;
    let turnCost = 0;
    let turnTraceCount = 0;
    let turnErrorCount = 0;
    let turnHandoffCount = 0;
    let turnToolCallCount = 0;
    let lastModelId = '';
    let lastProvider = '';
    const responseProvenance = createResponseProvenanceAccumulator();
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'llm_call' && event.data) {
        const metrics = extractLlmTraceMetrics(event.data);
        turnTokensIn += metrics.tokensIn;
        turnTokensOut += metrics.tokensOut;
        // lastModelId/provider updated after callCost resolved below (Gap 3 fix)
        if (metrics.model && metrics.model !== 'unknown') lastModelId = metrics.model;
        if (metrics.provider) lastProvider = metrics.provider;
        accumulateResponseProvenance(responseProvenance, event);

        // Write one row per LLM call — gives accurate call counts and per-call latency
        if (metrics.tokensIn > 0 || metrics.tokensOut > 0) {
          const callModelId = metrics.model && metrics.model !== 'unknown' ? metrics.model : '';
          const callDurationMs =
            typeof event.data.durationMs === 'number' ? event.data.durationMs : 0;
          const callToolCount =
            typeof event.data.toolCallCount === 'number' ? event.data.toolCallCount : 0;
          let callCost: number | null = metrics.cost || null;
          if (!callCost && callModelId && hasKnownPricing(callModelId)) {
            try {
              const caps = getModelCapabilities(callModelId);
              callCost = calculateCost(
                caps.inputCostPer1k,
                caps.outputCostPer1k,
                metrics.tokensIn,
                metrics.tokensOut,
              );
            } catch {
              // non-fatal
            }
          }
          // Gap 2: accumulate the resolved callCost (incl. fallback) for turn aggregate
          turnCost += callCost || 0;
          const chTenantId = state.tenantId || 'default';
          const chSessionId = state.dbSessionId || state.sessionId;
          getClickHouseMetricsStore(chTenantId)
            .then(async (store) => {
              await store.record({
                sessionId: chSessionId,
                projectId: state.projectId,
                userId: state.userId || undefined,
                modelId: callModelId,
                provider: metrics.provider || '',
                inputTokens: metrics.tokensIn,
                outputTokens: metrics.tokensOut,
                totalTokens: metrics.tokensIn + metrics.tokensOut,
                estimatedCost: callCost,
                latencyMs: callDurationMs,
                streamingUsed: event.data.streaming === true,
                toolCallCount: callToolCount,
                // Gap 1: field_validation uses 'purpose', not 'operationType'
                operationType: String(
                  event.data.operationType || event.data.purpose || 'response_gen',
                ),
                agentName: String(event.data.agent || ''),
                knownSource: state.runtimeSession?.knownSource ?? 'production',
              });
            })
            .catch((err) => {
              log.error('Failed to persist llm call metrics to ClickHouse', {
                error: err instanceof Error ? err.message : String(err),
                sessionId: state.sessionId,
              });
            });
        }
      }
      if (event.type === 'tool_call') turnToolCallCount++;
      turnTraceCount++;
      if (event.type === 'error') turnErrorCount++;
      if (event.type === 'handoff') turnHandoffCount++;
      const traceSessionId = getBoundSessionId(state) ?? state.sessionId;
      const traceEvent: TraceEventWithId = {
        id: crypto.randomUUID(),
        sessionId: traceSessionId,
        type: event.type as TraceEventType,
        timestamp: new Date(),
        data: event.data,
        ...(state.traceId && { traceId: state.traceId }),
      };
      send(ws, ServerMessages.traceEvent(traceSessionId, traceEvent));
      // NOTE: TraceStore and ClickHouse persistence are now centralized in
      // RuntimeExecutor.createCentralizedTraceHandler() — no per-handler storage needed.
    };

    // Route through ExecutionCoordinator when available (handles dedup, concurrency, queueing).
    // Falls back to direct executor/queue paths when coordinator is not initialized.
    // Wrap in observability context so downstream code can read getCurrentTraceId()
    const sdkTraceId = state.traceId || crypto.randomUUID().replace(/-/g, '');
    const sdkSpanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any;
    const sdkChannelMetadata: ExecuteMessageOptions['channelMetadata'] = {
      channel: 'sdk',
      contentLength: text.length,
      hasAttachments: !!attachmentIds?.length,
      attachmentCount: attachmentIds?.length || 0,
    };
    const executeInContext = () => {
      const sessionLocator = buildSdkSessionLocator(state, sessionId);
      if (isCoordinatorAvailable()) {
        const coordinator = getExecutionCoordinator();
        return coordinator
          .submit(sessionId, text, {
            tenantId: state.tenantId || 'default',
            dedupKey: `sdk:${clientMessageId}`,
            executionId: turnExecutionId,
            attachmentIds,
            messageMetadata,
            interactionContext: requestInteractionContext,
            sessionLocator: sessionLocator ?? undefined,
            onChunk,
            onTraceEvent,
            signal: executionContext?.signal,
            channelMetadata: sdkChannelMetadata,
          })
          .then((execution) => {
            // The coordinator stashes the full ExecutionResult on execution.resultData.
            const execResult = execution.resultData as typeof result | undefined;
            return (
              execResult ?? {
                response: execution.response || '',
                action: { type: 'continue' as const },
                stateUpdates: undefined,
                voiceConfig: undefined,
                richContent: undefined,
                actions: undefined,
                metadata: undefined,
              }
            );
          });
      } else if (isLLMQueueEnabled()) {
        return enqueueLLMRequest(
          sessionId,
          text,
          onChunk,
          onTraceEvent,
          state.tenantId,
          buildExecuteMessageOptions({
            attachmentIds,
            messageMetadata,
            interactionContext: requestInteractionContext,
            sessionLocator: sessionLocator ?? undefined,
            signal: executionContext?.signal,
            channelMetadata: sdkChannelMetadata,
          }),
        );
      } else {
        const execOptions = buildExecuteMessageOptions({
          attachmentIds,
          messageMetadata,
          interactionContext: requestInteractionContext,
          sessionLocator: sessionLocator ?? undefined,
          signal: executionContext?.signal,
          channelMetadata: sdkChannelMetadata,
        });
        return executor.executeMessage(sessionId, text, onChunk, onTraceEvent, execOptions);
      }
    };
    const turnStartTime = Date.now();
    result = await runWithObservabilityContext(
      { traceId: sdkTraceId, spanId: sdkSpanId },
      executeInContext,
    );
    const turnLatencyMs = Date.now() - turnStartTime;

    if (executionContext?.signal.aborted) {
      log.warn('Suppressing timed-out SDK chat completion', {
        sessionId: sessionId ?? state.sessionId,
      });
      return;
    }

    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      result,
      streamedText: allChunks.length > 0 ? allChunks.join('') : undefined,
      session: executor.getSession(sessionId) ?? state.runtimeSession,
    });
    const responseMetadata = withAgentNameMetadata(
      outcome.responseMetadata ??
        result.responseMetadata ??
        buildResponseMessageMetadata(responseProvenance),
      state.runtimeSession?.agentName,
    );
    const assistantPersistenceMessages = buildAssistantPersistenceMessages({
      outcome,
      responseMetadata,
      responseMessageId,
      agentName: state.runtimeSession?.agentName,
      messageTimestamp: lastChunkTime || Date.now(),
    });

    send(
      ws,
      ServerMessages.responseEnd(
        state.sessionId,
        responseMessageId,
        outcome.responseText,
        outcome.voiceConfig || undefined,
        outcome.richContent || undefined,
        outcome.actions || undefined,
        turnExecutionId,
        responseMetadata,
        outcome.localization,
      ),
    );

    emitChannelResponseSent(state.sessionId, 'sdk-ws', Date.now() - messageStartTime, {
      tenantId: state.tenantId,
      projectId: state.projectId,
      configHash: state.runtimeSession?.configHash,
      knownSource: state.runtimeSession?.knownSource,
    });

    // Persist messages and metrics to MongoDB via batched queue
    if (state.dbSessionId) {
      const contactId = state.callerContext?.contactId;
      let scopedPersistence: ProductionExecutionScope | null = null;
      try {
        scopedPersistence = buildSdkPersistenceScope(state);
      } catch (err) {
        log.warn('Skipping SDK scoped persistence due to invalid execution scope', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: getBoundSessionId(state) ?? state.sessionId,
        });
      }
      if (scopedPersistence) {
        persistScopedMessage({
          scope: scopedPersistence,
          message: {
            dbSessionId: state.dbSessionId,
            role: 'user',
            content: text,
            channel: 'web_chat',
            messageTimestamp: messageArrivalTime,
          },
        }).catch((err: unknown) => log.warn('SDK user message persist failed', { err }));
        if (hasRenderableChannelOutcome(outcome)) {
          for (const assistantMessage of assistantPersistenceMessages) {
            persistScopedMessage({
              scope: scopedPersistence,
              message: {
                dbSessionId: state.dbSessionId,
                role: 'assistant',
                content: assistantMessage.content,
                structuredContent: assistantMessage.structuredContent,
                channel: 'web_chat',
                messageTimestamp: assistantMessage.messageTimestamp,
                metadata: assistantMessage.metadata as ResponseMessageMetadata | undefined,
                messageId: assistantMessage.messageId,
                agentName: assistantMessage.agentName,
              },
            }).catch((err: unknown) => log.warn('SDK assistant message persist failed', { err }));
          }
        }
        persistScopedTurnMetrics({
          scope: scopedPersistence,
          metrics: {
            dbSessionId: state.dbSessionId,
            tokensIn: turnTokensIn,
            tokensOut: turnTokensOut,
            cost: turnCost,
            traceEventCount: turnTraceCount,
            errorCount: turnErrorCount,
            handoffCount: turnHandoffCount,
          },
        }).catch((err: unknown) => log.warn('SDK metrics persist failed', { err }));
      } else if (shouldUseLegacySdkPersistence(state)) {
        persistMessage(
          state.dbSessionId,
          'user',
          text,
          'web_chat',
          state.tenantId,
          undefined,
          contactId,
          state.projectId,
          messageArrivalTime,
        ).catch((err: unknown) => log.warn('SDK user message persist failed', { err }));
        if (hasRenderableChannelOutcome(outcome)) {
          for (const assistantMessage of assistantPersistenceMessages) {
            persistMessageRecord({
              dbSessionId: state.dbSessionId,
              role: 'assistant',
              content: assistantMessage.content,
              channel: 'web_chat',
              tenantId: state.tenantId,
              contactId,
              projectId: state.projectId,
              messageTimestamp: assistantMessage.messageTimestamp,
              structuredContent: assistantMessage.structuredContent,
              metadata: assistantMessage.metadata as Partial<MessageMetadata> | undefined,
              messageId: assistantMessage.messageId,
              agentName: assistantMessage.agentName,
            }).catch((err: unknown) => log.warn('SDK assistant message persist failed', { err }));
          }
        }
        persistTurnMetrics({
          dbSessionId: state.dbSessionId,
          tenantId: state.tenantId,
          tokensIn: turnTokensIn,
          tokensOut: turnTokensOut,
          cost: turnCost,
          traceEventCount: turnTraceCount,
          errorCount: turnErrorCount,
          handoffCount: turnHandoffCount,
        }).catch((err: unknown) => log.warn('SDK metrics persist failed', { err }));
      } else {
        log.warn('Skipping legacy SDK persistence because canonical execution scope is required', {
          sessionId: getBoundSessionId(state) ?? state.sessionId,
        });
      }

      // Omnichannel: fan out transcript items to all live session participants
      // Fire-and-forget — sequence allocation + fan-out must not block the response
      if (state.tenantId && contactId) {
        const liveSid = getBoundSessionId(state);
        if (liveSid) {
          (async () => {
            try {
              const isLive = await liveSessionService.isLiveSyncActive(
                state.tenantId!,
                state.projectId,
                contactId!,
                liveSid,
              );
              if (!isLive) return;

              // Allocate sequence for user message
              let userSeq: number | null = null;
              try {
                userSeq = await participantRegistry.nextSequence(liveSid);
              } catch {
                // Non-fatal
              }

              fanOutTranscriptItem(liveSid, {
                ...normalizeTranscriptItem({
                  id: crypto.randomUUID(),
                  sessionId: liveSid,
                  role: 'user',
                  content: text,
                  channel: 'text',
                  sourceChannel: 'text',
                  inputMode: 'typed',
                  sequence: userSeq,
                  timestamp: new Date(messageArrivalTime),
                }),
              });

              // Fan out assistant response messages
              for (const assistantMessage of assistantPersistenceMessages) {
                if (!assistantMessage.content) continue;
                let assistantSeq: number | null = null;
                try {
                  assistantSeq = await participantRegistry.nextSequence(liveSid);
                } catch {
                  // Non-fatal
                }

                fanOutTranscriptItem(liveSid, {
                  ...normalizeTranscriptItem({
                    id: assistantMessage.messageId ?? crypto.randomUUID(),
                    sessionId: liveSid,
                    role: 'assistant',
                    content: assistantMessage.content,
                    channel: 'text',
                    sourceChannel: 'text',
                    inputMode: 'system',
                    sequence: assistantSeq,
                    timestamp: new Date(assistantMessage.messageTimestamp ?? Date.now()),
                  }),
                });
              }
            } catch (err) {
              log.warn('Omnichannel transcript fan-out failed', {
                error: err instanceof Error ? err.message : String(err),
                sessionId: state.sessionId,
              });
            }
          })();
        }
      }
    }

    // Per-call llm_metrics rows are written inside onTraceEvent above.
    // Write one turn-aggregate row capturing the full turn's e2e latency and totals.
    if (turnTokensIn > 0 || turnTokensOut > 0) {
      const chTenantId = state.tenantId || 'default';
      const chSessionId = state.dbSessionId || state.sessionId;
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
      getClickHouseMetricsStore(chTenantId)
        .then(async (store) => {
          await store.record({
            sessionId: chSessionId,
            projectId: state.projectId,
            userId: state.userId || undefined,
            modelId: lastModelId,
            provider: lastProvider,
            inputTokens: turnTokensIn,
            outputTokens: turnTokensOut,
            totalTokens: turnTokensIn + turnTokensOut,
            estimatedCost: turnCostFinal,
            latencyMs: turnLatencyMs,
            streamingUsed: true,
            toolCallCount: turnToolCallCount,
            operationType: 'turn_aggregate',
            knownSource: state.runtimeSession?.knownSource ?? 'production',
          });
        })
        .catch((err) => {
          log.error('Failed to persist turn aggregate metrics to ClickHouse', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: state.sessionId,
          });
        });
    }
    // NOTE: ClickHouse message writes are handled by DualWriteMessageStore.
  } catch (error) {
    if (executionContext?.signal.aborted) {
      log.warn('SDK chat execution aborted after timeout', {
        sessionId: sessionId ?? state.sessionId,
      });
      return;
    }
    // Handle backpressure from LLM queue
    if (error instanceof BackpressureError) {
      send(
        ws,
        ServerMessages.responseEnd(
          state.sessionId,
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

    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    log.error('Chat execution error', {
      error: errorMessage,
      stack: errorStack,
      sessionId: state.sessionId,
    });

    // Surface classified LLM errors with their contextual message;
    // fall back to a generic message for non-LLM errors.
    const userFacingMessage = isLlmError(error) ? error.message : 'Failed to process message';
    send(
      ws,
      ServerMessages.responseEnd(
        state.sessionId,
        responseMessageId,
        '',
        undefined,
        undefined,
        undefined,
        turnExecutionId,
      ),
    );
    send(ws, ServerMessages.error(userFacingMessage));
  }
}

/**
 * Handle an action_submit message — the SDK client clicked a button or selected
 * an option from an ACTIONS or CAROUSEL element.  Routes through the same
 * executeMessage path as chat_message but with an empty text and an actionEvent.
 */
async function handleActionSubmit(
  ws: WebSocket,
  state: SDKClientState,
  message: {
    actionId: unknown;
    value?: unknown;
    formData?: unknown;
    renderId?: unknown;
  },
  executionContext?: SDKMessageExecutionContext,
): Promise<void> {
  if (!state.permissions.chat) {
    send(ws, ServerMessages.error('Chat not enabled for this key'));
    return;
  }

  if (!message.actionId || typeof message.actionId !== 'string') {
    send(ws, ServerMessages.error('Missing actionId in action_submit'));
    return;
  }

  // Feedback short-circuit (ABLP-1068 / LLD D-2): rich-template `actionId='feedback'`
  // clicks are NOT user turns — route them straight into the feedback service and
  // return BEFORE the executeMessage path so the agent does not respond to the click.
  if (isFeedbackActionId(message.actionId)) {
    await handleActionSubmitFeedback(ws, state, message);
    return;
  }

  const hasExplicitFormData = Object.prototype.hasOwnProperty.call(message, 'formData');
  const legacyFormData =
    !hasExplicitFormData && typeof message.value === 'string'
      ? tryParseLegacyActionFormData(message.value)
      : undefined;
  const actionEnvelope = validateActionSubmitEnvelope({
    actionId: message.actionId,
    value: message.value,
    formData: hasExplicitFormData ? message.formData : legacyFormData,
    formDataPresent: hasExplicitFormData || legacyFormData !== undefined,
    renderId: message.renderId,
  });
  if (!actionEnvelope.ok) {
    send(ws, ServerMessages.error(actionEnvelope.message));
    return;
  }

  const { actionId, value, formData, renderId } = actionEnvelope.value;
  const responseMessageId = crypto.randomUUID();

  // Rate limit
  const runtimeSid = getBoundSessionId(state);
  if (runtimeSid) {
    const msgRate = await checkSessionMessageRate(runtimeSid);
    if (!msgRate.allowed) {
      send(
        ws,
        ServerMessages.error(
          'Session message rate limit exceeded',
          undefined,
          msgRate.retryAfterMs,
        ),
      );
      return;
    }
  }

  await ensureDbSession(state);
  if (executionContext?.signal.aborted) {
    return;
  }
  const actionExecutionId = `exec-${crypto.randomUUID()}`;
  send(ws, ServerMessages.responseStart(state.sessionId, responseMessageId, actionExecutionId));

  const executor = getRuntimeExecutor();
  const sessionId = getBoundSessionId(state);

  if (!sessionId || !executor.isConfigured()) {
    send(
      ws,
      ServerMessages.responseEnd(
        state.sessionId,
        responseMessageId,
        'Action received but no agent is loaded.',
        undefined,
        undefined,
        undefined,
        actionExecutionId,
      ),
    );
    return;
  }

  try {
    const allChunks: string[] = [];
    const responseProvenance = createResponseProvenanceAccumulator();
    const onChunk = (chunk: string) => {
      allChunks.push(chunk);
      send(ws, ServerMessages.responseChunk(state.sessionId, responseMessageId, chunk));
    };
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'llm_call' && event.data) {
        accumulateResponseProvenance(responseProvenance, event);
      }
    };

    const actionTraceId = state.traceId || crypto.randomUUID().replace(/-/g, '');
    const actionSpanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const result = await runWithObservabilityContext(
      { traceId: actionTraceId, spanId: actionSpanId },
      () =>
        executor.executeMessage(
          sessionId,
          '',
          onChunk,
          onTraceEvent,
          buildExecuteMessageOptions({
            actionEvent: { actionId, value, formData, renderId, source: 'sdk' },
            sessionLocator: buildSdkSessionLocator(state, sessionId) ?? undefined,
            signal: executionContext?.signal,
            channelMetadata: { channel: 'sdk' },
          }),
        ),
    );

    if (executionContext?.signal.aborted) {
      log.warn('Suppressing timed-out SDK action completion', {
        sessionId: sessionId ?? state.sessionId,
        actionId,
      });
      return;
    }

    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      result,
      streamedText: allChunks.length > 0 ? allChunks.join('') : undefined,
      session: executor.getSession(sessionId) ?? state.runtimeSession,
    });
    const responseMetadata = withAgentNameMetadata(
      outcome.responseMetadata ??
        result.responseMetadata ??
        buildResponseMessageMetadata(responseProvenance),
      state.runtimeSession?.agentName,
    );
    const assistantPersistenceMessages = buildAssistantPersistenceMessages({
      outcome,
      responseMetadata,
      responseMessageId,
      agentName: state.runtimeSession?.agentName,
      messageTimestamp: Date.now(),
    });

    send(
      ws,
      ServerMessages.responseEnd(
        state.sessionId,
        responseMessageId,
        outcome.responseText,
        outcome.voiceConfig || undefined,
        outcome.richContent || undefined,
        outcome.actions || undefined,
        actionExecutionId,
        responseMetadata,
        outcome.localization,
      ),
    );

    const actionDbSessionId = state.dbSessionId ?? (await ensureDbSession(state));
    if (actionDbSessionId && hasRenderableChannelOutcome(outcome)) {
      const contactId = state.callerContext?.contactId;
      let scopedPersistence: ProductionExecutionScope | null = null;
      try {
        scopedPersistence = buildSdkPersistenceScope(state);
      } catch (err) {
        log.warn('Skipping SDK action scoped persistence due to invalid execution scope', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: getBoundSessionId(state) ?? state.sessionId,
        });
      }

      if (scopedPersistence) {
        for (const assistantMessage of assistantPersistenceMessages) {
          persistScopedMessage({
            scope: scopedPersistence,
            message: {
              dbSessionId: actionDbSessionId,
              role: 'assistant',
              content: assistantMessage.content,
              structuredContent: assistantMessage.structuredContent,
              channel: 'web_chat',
              messageTimestamp: assistantMessage.messageTimestamp,
              metadata: assistantMessage.metadata as ResponseMessageMetadata | undefined,
              messageId: assistantMessage.messageId,
              agentName: assistantMessage.agentName,
            },
          }).catch((err: unknown) => log.warn('SDK action message persist failed', { err }));
        }
      } else if (shouldUseLegacySdkPersistence(state)) {
        for (const assistantMessage of assistantPersistenceMessages) {
          persistMessageRecord({
            dbSessionId: actionDbSessionId,
            role: 'assistant',
            content: assistantMessage.content,
            channel: 'web_chat',
            tenantId: state.tenantId,
            contactId,
            projectId: state.projectId,
            messageTimestamp: assistantMessage.messageTimestamp,
            structuredContent: assistantMessage.structuredContent,
            metadata: assistantMessage.metadata as Partial<MessageMetadata> | undefined,
            messageId: assistantMessage.messageId,
            agentName: assistantMessage.agentName,
          }).catch((err: unknown) => log.warn('SDK action message persist failed', { err }));
        }
      } else {
        log.warn(
          'Skipping legacy SDK action persistence because canonical execution scope is required',
          {
            sessionId: getBoundSessionId(state) ?? state.sessionId,
          },
        );
      }
    }
  } catch (error) {
    if (executionContext?.signal.aborted) {
      log.warn('SDK action execution aborted after timeout', {
        sessionId: state.sessionId,
        actionId,
      });
      return;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Action submit execution error', {
      error: errorMessage,
      sessionId: state.sessionId,
      actionId,
    });
    send(
      ws,
      ServerMessages.responseEnd(
        state.sessionId,
        responseMessageId,
        '',
        undefined,
        undefined,
        undefined,
        actionExecutionId,
      ),
    );
    send(ws, ServerMessages.error('Failed to process action'));
  }
}

// =============================================================================
// FEEDBACK CAPTURE (ABLP-1068)
// =============================================================================

interface FeedbackEnvelope {
  messageId: string;
  actionRenderId?: string;
  submission: FeedbackSubmission;
}

function resolveFeedbackContext(state: SDKClientState):
  | {
      ok: true;
      tenantId: string;
      projectId: string;
      sessionId: string;
      userId: string;
    }
  | { ok: false; reason: string } {
  if (!state.tenantId) return { ok: false, reason: 'Missing tenant context' };
  if (!state.projectId) return { ok: false, reason: 'Missing project context' };
  const boundSessionId = getBoundSessionId(state) ?? state.dbSessionId;
  if (!boundSessionId) return { ok: false, reason: 'Missing session context' };
  // Session-derived user identity: prefer contact > customer > anonymous; fall back
  // to the authContext userId when present (anonymous-but-authed WS clients).
  const authContext = state.authContext as { userId?: unknown } | undefined;
  const authUserId = typeof authContext?.userId === 'string' ? authContext.userId : '';
  const userId =
    state.callerContext?.contactId ||
    state.callerContext?.customerId ||
    state.callerContext?.anonymousId ||
    authUserId ||
    '';
  return {
    ok: true,
    tenantId: state.tenantId,
    projectId: state.projectId,
    sessionId: boundSessionId,
    userId,
  };
}

async function persistFeedbackEnvelope(
  ws: WebSocket,
  state: SDKClientState,
  envelope: FeedbackEnvelope,
): Promise<void> {
  if (!state.permissions.chat) {
    send(
      ws,
      ServerMessages.feedbackAck(envelope.messageId, envelope.actionRenderId, {
        ok: false,
        code: 'INVALID_INPUT',
        message: 'Chat not enabled for this key',
      }),
    );
    return;
  }
  const ctx = resolveFeedbackContext(state);
  if (!ctx.ok) {
    send(
      ws,
      ServerMessages.feedbackAck(envelope.messageId, envelope.actionRenderId, {
        ok: false,
        code: 'INVALID_INPUT',
        message: ctx.reason,
      }),
    );
    return;
  }
  try {
    const service = getFeedbackService();
    const result = await service.submit({
      ...envelope.submission,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      channel: 'web_chat',
    });
    send(ws, ServerMessages.feedbackAck(envelope.messageId, envelope.actionRenderId, result));
  } catch (err) {
    log.error('Feedback submission failed unexpectedly', {
      sessionId: state.sessionId,
      messageId: envelope.messageId,
      error: err instanceof Error ? err.message : String(err),
    });
    send(
      ws,
      ServerMessages.feedbackAck(envelope.messageId, envelope.actionRenderId, {
        ok: false,
        code: 'STORAGE_FAILURE',
        message: 'Failed to persist feedback',
      }),
    );
  }
}

// Exported for integration tests that need to exercise the WS ingress
// without standing up a real WebSocket server. Production callers MUST
// route through the dispatcher in handleSDKMessage.
export async function handleFeedbackSubmit(
  ws: WebSocket,
  state: SDKClientState,
  message: Record<string, unknown>,
): Promise<void> {
  log.info('Feedback frame received', {
    sessionId: state.sessionId,
    messageId: typeof message.messageId === 'string' ? message.messageId : undefined,
    ratingType: typeof message.ratingType === 'string' ? message.ratingType : undefined,
    ratingValue: typeof message.ratingValue === 'number' ? message.ratingValue : undefined,
    hasText: typeof message.feedbackText === 'string' && message.feedbackText.length > 0,
  });
  const parsed = FeedbackSubmitSchema.safeParse(message);
  if (!parsed.success) {
    const messageId = typeof message.messageId === 'string' ? message.messageId : '';
    const renderId =
      typeof message.actionRenderId === 'string' ? message.actionRenderId : undefined;
    send(
      ws,
      ServerMessages.feedbackAck(messageId, renderId, {
        ok: false,
        code: 'INVALID_INPUT',
        message: parsed.error.issues[0]?.message ?? 'Invalid feedback payload',
      }),
    );
    return;
  }
  const submission = normaliseFeedbackSubmit(parsed.data);
  await persistFeedbackEnvelope(ws, state, {
    messageId: submission.messageId,
    actionRenderId: submission.actionRenderId,
    submission,
  });
}

// Exported for integration tests — same rationale as handleFeedbackSubmit.
export async function handleActionSubmitFeedback(
  ws: WebSocket,
  state: SDKClientState,
  message: {
    actionId: unknown;
    value?: unknown;
    formData?: unknown;
    renderId?: unknown;
  },
): Promise<void> {
  log.info('Feedback action_submit frame received', {
    sessionId: state.sessionId,
    actionId: typeof message.actionId === 'string' ? message.actionId : undefined,
    value: typeof message.value === 'string' ? message.value : undefined,
  });
  const normalised = normaliseActionSubmit({
    actionId: 'feedback',
    value: message.value,
    formData: message.formData,
    renderId: message.renderId,
  });
  if (!normalised.ok) {
    // No messageId available unless formData carried one — best-effort echo.
    const formMessageId =
      typeof message.formData === 'object' && message.formData !== null
        ? (message.formData as Record<string, unknown>).messageId
        : undefined;
    const renderId = typeof message.renderId === 'string' ? message.renderId : undefined;
    send(
      ws,
      ServerMessages.feedbackAck(typeof formMessageId === 'string' ? formMessageId : '', renderId, {
        ok: false,
        code: normalised.code,
        message: normalised.message,
      }),
    );
    return;
  }
  await persistFeedbackEnvelope(ws, state, {
    messageId: normalised.submission.messageId,
    actionRenderId: normalised.submission.actionRenderId,
    submission: normalised.submission,
  });
}

async function handleSDKCancelExecution(
  ws: WebSocket,
  state: SDKClientState,
  message: Record<string, unknown>,
): Promise<void> {
  if (!isCoordinatorAvailable()) {
    send(ws, ServerMessages.error('Execution coordinator not available'));
    return;
  }

  const coordinator = getExecutionCoordinator();
  const executionId = message.executionId as string | undefined;
  const sessionId = getBoundSessionId(state);

  if (executionId) {
    const cancelled = await coordinator.cancel(executionId);
    log.info('SDK cancel execution request', { executionId, cancelled });
  } else if (sessionId) {
    await coordinator.cancelSession(sessionId);
    log.info('SDK cancel all executions for session', { sessionId: state.sessionId });
  } else {
    send(ws, ServerMessages.error('No active session to cancel'));
  }
}

function applyVoiceSessionChannelState(state: SDKClientState): void {
  // Mark pending session as voice channel (DB session will be created lazily on first turn)
  if (state.pendingDbSession) {
    state.pendingDbSession.channel = 'voice';
  }

  // If chat already materialized the DB session, reflect the channel switch there too so
  // reporting and cleanup operate on the durable session's real channel history.
  if (state.dbSessionId && isDatabaseAvailable()) {
    getConversationStore()
      .updateSession(state.dbSessionId, { channel: 'voice' })
      .catch((err: unknown) =>
        log.warn('Failed to update SDK DB session channel to voice', {
          error: err instanceof Error ? err.message : String(err),
          dbSessionId: state.dbSessionId,
          sessionId: state.sessionId,
        }),
      );
  }

  // Update RuntimeSession channel so isVoiceChannel() returns true for
  // downstream prompt building and onChunk stripping.
  // Top-level channelType survives handoffs (data.values.session gets replaced).
  if (state.runtimeSession) {
    state.runtimeSession.channelType = 'voice';
    // Also set data store for backward compat (may be lost on handoff)
    const sessionMeta = state.runtimeSession.data?.values?.session as
      | Record<string, unknown>
      | undefined;
    if (sessionMeta) {
      sessionMeta.channel = 'voice';
    } else if (state.runtimeSession.data?.values) {
      // Merge instead of overwrite to preserve sessionId, tenantId etc.
      state.runtimeSession.data.values.session = {
        ...(state.runtimeSession.data.values.session as Record<string, unknown> | undefined),
        channel: 'voice',
      };
    }
  }
}

async function stopTimedOutVoiceExecutor(
  executor: NonNullable<SDKClientState['realtimeExecutor']>,
  state: SDKClientState,
): Promise<void> {
  try {
    await executor.stop();
  } catch (err) {
    log.warn('Failed to stop timed-out SDK realtime voice executor', {
      error: err instanceof Error ? err.message : String(err),
      sessionId: state.sessionId,
    });
  }
}

async function handleVoiceTokenRequest(
  ws: WebSocket,
  state: SDKClientState,
  executionContext?: SDKMessageExecutionContext,
): Promise<void> {
  if (!state.permissions.voice) {
    send(ws, ServerMessages.error('Voice not enabled for this key'));
    return;
  }

  if (executionContext?.signal.aborted) {
    return;
  }

  try {
    // Load the global factory lazily so SDK auth/transport code can be imported
    // without pulling in the full server bootstrap during tests or worker startup.
    const { app } = await import('../server.js');
    if (executionContext?.signal.aborted) {
      log.warn('Suppressing timed-out SDK voice token request before token generation', {
        sessionId: state.sessionId,
      });
      return;
    }
    const voiceFactory = app.locals.voiceServiceFactory as VoiceServiceFactory | undefined;
    const twilio =
      state.tenantId && voiceFactory
        ? await voiceFactory.getTwilioService(state.tenantId)
        : (await import('../services/voice/twilio-service.js')).getTwilioService();

    if (executionContext?.signal.aborted) {
      log.warn('Suppressing timed-out SDK voice token request after provider lookup', {
        sessionId: state.sessionId,
      });
      return;
    }

    if (!twilio || !twilio.isConfigured()) {
      send(ws, ServerMessages.error('Voice service not configured'));
      return;
    }

    const identity = `sdk_${state.sessionId}`;
    const token = await twilio.generateAccessToken({
      identity,
      sessionId: state.sessionId,
      ttl: 3600,
    });

    if (executionContext?.signal.aborted) {
      log.warn('Suppressing timed-out SDK voice token response', {
        sessionId: state.sessionId,
      });
      return;
    }
    send(ws, ServerMessages.voiceToken(token, identity));
  } catch (error) {
    if (executionContext?.signal.aborted) {
      log.warn('SDK voice token request aborted after timeout', {
        sessionId: state.sessionId,
      });
      return;
    }
    log.error('Voice token error', { error, sessionId: state.sessionId });
    send(ws, ServerMessages.error('Failed to generate voice token'));
  }
}

// =============================================================================
// VOICE STREAMING (Realtime only — LiveKit handles STT+TTS pipeline)
// =============================================================================

async function handleVoiceStart(
  ws: WebSocket,
  state: SDKClientState,
  executionContext?: SDKMessageExecutionContext,
): Promise<void> {
  if (!state.permissions.voice) {
    send(ws, ServerMessages.error('Voice not enabled for this key'));
    return;
  }

  if (executionContext?.signal.aborted) {
    return;
  }

  const isAborted = () => executionContext?.signal.aborted === true;

  // =========================================================================
  // OMNICHANNEL: Activate live sync on voice start for verified users
  // =========================================================================
  if (
    state.callerContext?.identityTier !== undefined &&
    state.callerContext.identityTier >= 2 &&
    state.callerContext.contactId &&
    state.tenantId
  ) {
    const runtimeSidForLiveSync = getBoundSessionId(state);
    if (runtimeSidForLiveSync) {
      liveSessionService
        .activateLiveSync(
          runtimeSidForLiveSync,
          state.callerContext.contactId,
          state.tenantId,
          state.projectId,
        )
        .then(() => {
          // Register voice participant
          const voiceParticipant: Participant = createParticipant({
            participantId: `voice:${state.sessionId}`,
            sessionId: runtimeSidForLiveSync,
            contactId: state.callerContext!.contactId!,
            surface: 'voice',
          });
          return participantRegistry.addParticipant(runtimeSidForLiveSync, voiceParticipant);
        })
        .catch((err) => {
          log.warn('Failed to activate live sync on voice start', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: state.sessionId,
          });
        });
    }
  }

  // =========================================================================
  // RESOLVE VOICE MODE (centralized — pipeline vs realtime)
  // =========================================================================
  try {
    const { resolveVoiceSession } = await import('../services/voice/voice-session-resolver.js');
    const toolExecutor =
      getBoundSessionId(state) || state.runtimeSession
        ? async (toolName: string, input: Record<string, unknown>, voiceSessionId: string) => {
            const runtimeSessionId = getBoundSessionId(state) ?? voiceSessionId;
            const runtimeExecutor = getRuntimeExecutor();
            const activeRuntimeSession =
              runtimeExecutor.getSession(runtimeSessionId) ?? state.runtimeSession;
            if (!activeRuntimeSession) {
              throw new Error('Voice runtime session is no longer available.');
            }
            const toolResult = await executeLiveVoiceToolCall({
              runtimeExecutor,
              runtimeSession: activeRuntimeSession,
              toolName,
              input,
              tenantId: state.tenantId,
              projectId: state.projectId,
            });
            return {
              result: toolResult.serializedResult,
              activeAgentName: toolResult.activeAgentName,
              activeAgentIR: toolResult.activeAgentIR,
            };
          }
        : undefined;
    const voiceTurnExecutor =
      getBoundSessionId(state) || state.runtimeSession
        ? async (utterance: string, voiceSessionId: string) => {
            const runtimeSessionId = getBoundSessionId(state) ?? voiceSessionId;
            const runtimeExecutor = getRuntimeExecutor();
            const activeRuntimeSession =
              runtimeExecutor.getSession(runtimeSessionId) ?? state.runtimeSession;
            if (!activeRuntimeSession) {
              throw new Error('Voice runtime session is no longer available.');
            }
            const turnResult = await executeLiveVoiceSemanticTurn({
              channelType: 'voice_realtime',
              runtimeExecutor,
              runtimeSession: activeRuntimeSession,
              utterance,
              timeoutMs: WS_MESSAGE_TIMEOUT_MS,
              promptProfile: 'realtime',
              tenantId: state.tenantId,
              projectId: state.projectId,
              channelMetadata: {
                channel: 'voice_realtime',
                contentLength: utterance.length,
              },
            });

            return {
              result: turnResult.serializedResult,
              activeAgentName: turnResult.activeAgentName,
              activeAgentIR: turnResult.activeAgentIR,
            };
          }
        : undefined;
    const resolved = await resolveVoiceSession({
      tenantId: state.tenantId,
      projectId: state.projectId,
      channelId: state.channelId,
      deploymentId: state.deploymentId,
      agentIR: state.runtimeSession?.agentIR ?? undefined,
      runtimeSession: state.runtimeSession,
      audioFormat: 'pcm16',
      sampleRate: 24000,
      sessionId: state.sessionId,
      toolExecutor,
      voiceTurnExecutor,
      semanticFamily: 'sdk_voice_realtime',
    });

    if (isAborted()) {
      log.warn('Suppressing timed-out SDK voice start before startup completed', {
        sessionId: state.sessionId,
      });
      return;
    }

    // Explicit realtime requested but can't be fulfilled — surface the error
    // (Resolution details already logged by the resolver)
    if (resolved.error) {
      if (isAborted()) {
        return;
      }
      send(ws, ServerMessages.voiceError(resolved.error));
      return;
    }

    if (resolved.mode === 'realtime' && resolved.executor) {
      // Configure callbacks before starting
      const executor = resolved.executor;
      const origConfig = (executor as any)
        .config as import('../services/voice/realtime-voice-executor.js').RealtimeVoiceExecutorConfig;
      origConfig.onAudio = (audio: Buffer) => {
        if (isAborted()) {
          return;
        }
        send(ws, ServerMessages.voiceRealtimeAudio(audio.toString('base64'), 'pcm16'));
      };

      // Track per-turn transcripts for persistence (reset after each turn)
      let turnUserTranscript = '';
      let turnAssistantTranscript = '';

      origConfig.onTranscript = (entry) => {
        if (isAborted()) {
          return;
        }
        send(ws, ServerMessages.voiceRealtimeTranscript(entry.text, entry.isFinal, entry.role));

        // Capture final transcripts for message persistence
        if (entry.isFinal && entry.role === 'user') {
          turnUserTranscript = entry.text;
        } else if (entry.isFinal && entry.role === 'assistant') {
          turnAssistantTranscript = entry.text;
        }
      };
      origConfig.onTurnEnd = async (metrics) => {
        if (isAborted()) {
          return;
        }
        const eventData: Record<string, unknown> = {
          ...metrics,
          promptProfile: executor.getPromptProfileDiagnostics(),
        };

        // If timing breakdown is available, use the structured event format
        if (metrics.timingBreakdown) {
          eventData.timing = {
            turnLatency: metrics.timingBreakdown.turnLatency,
            totalDuration: metrics.timingBreakdown.totalDuration,
            toolCallOverhead: metrics.timingBreakdown.toolCallOverhead,
          };
        }

        const realtimeTurnEvent: TraceEventWithId = {
          id: crypto.randomUUID(),
          sessionId: getBoundSessionId(state) ?? state.sessionId,
          type: 'voice_realtime_turn_end' as TraceEventType,
          timestamp: new Date(),
          data: eventData,
          ...(metrics.traceId && { traceId: metrics.traceId }),
          ...(metrics.spanId && { spanId: metrics.spanId }),
        };
        send(ws, ServerMessages.traceEvent(realtimeTurnEvent.sessionId, realtimeTurnEvent));
        const traceStoreSessionId = getBoundSessionId(state);
        if (state.runtimeSession?.tracer) {
          state.runtimeSession.tracer.emit({
            type: 'voice_realtime_turn_end',
            data: eventData,
            durationMs: metrics.timingBreakdown?.totalDuration,
          });
        } else if (traceStoreSessionId) {
          // Tracer not available — fall back to direct addEvent
          getTraceStore().addEvent(traceStoreSessionId, realtimeTurnEvent);
        }

        if (isAborted()) {
          return;
        }

        // Lazily create DB session on first actual voice turn (not on voice_start)
        if (!state.dbSessionId) {
          await ensureDbSession(state, 'voice');
        }
        if (isAborted()) {
          return;
        }
        // Persist user + assistant messages from this turn
        if (state.dbSessionId) {
          const rtContactId = state.callerContext?.contactId;
          if (turnUserTranscript) {
            persistMessage(
              state.dbSessionId,
              'user',
              turnUserTranscript,
              'voice',
              state.tenantId,
              metrics.traceId,
              rtContactId,
              state.projectId,
            ).catch((err: unknown) => log.warn('Realtime user message persist failed', { err }));
          }
          if (turnAssistantTranscript) {
            persistMessage(
              state.dbSessionId,
              'assistant',
              turnAssistantTranscript,
              'voice',
              state.tenantId,
              metrics.traceId,
              rtContactId,
              state.projectId,
            ).catch((err: unknown) =>
              log.warn('Realtime assistant message persist failed', { err }),
            );
          }

          // Persist turn metrics (token usage)
          persistTurnMetrics({
            dbSessionId: state.dbSessionId,
            tenantId: state.tenantId,
            tokensIn: metrics.inputTokens || 0,
            tokensOut: metrics.outputTokens || 0,
            cost: 0,
            traceEventCount: 1,
            errorCount: 0,
            handoffCount: 0,
          }).catch((err: unknown) => log.warn('Realtime metrics persist failed', { err }));
        }

        // Reset per-turn state for next turn
        turnUserTranscript = '';
        turnAssistantTranscript = '';
      };
      origConfig.onError = (error: Error) => {
        if (isAborted()) {
          log.warn('Suppressing timed-out SDK realtime voice error', {
            error: error.message,
            sessionId: state.sessionId,
          });
          return;
        }
        log.error('Realtime voice error', { error: error.message, sessionId: state.sessionId });
        send(ws, ServerMessages.voiceError('Realtime voice error: ' + error.message));
      };

      await executor.start();

      if (isAborted()) {
        log.warn('Stopping timed-out SDK voice session after late startup completion', {
          sessionId: state.sessionId,
        });
        await stopTimedOutVoiceExecutor(executor, state);
        return;
      }

      applyVoiceSessionChannelState(state);
      state.voiceMode = 'realtime';
      state.realtimeExecutor = executor;
      registerSdkRealtimeInterruptionTarget(ws, state);
      send(
        ws,
        ServerMessages.voiceStarted(state.sessionId, 'realtime', SDK_REALTIME_VOICE_CAPABILITIES),
      );
      return;
    }

    // No realtime executor available — voice mode not supported via SDK without realtime
    if (isAborted()) {
      return;
    }
    send(
      ws,
      ServerMessages.voiceError(
        'Voice not available — realtime voice not configured for this deployment',
      ),
    );
  } catch (err) {
    if (executionContext?.signal.aborted) {
      log.warn('SDK voice start aborted after timeout', {
        sessionId: state.sessionId,
      });
      return;
    }
    log.error('Voice session resolution failed', {
      error: err instanceof Error ? err.message : String(err),
      sessionId: state.sessionId,
    });
    send(ws, ServerMessages.voiceError('Failed to start voice session'));
  }
}

async function handleVoiceAudio(
  ws: WebSocket,
  state: SDKClientState,
  audioBase64: string,
): Promise<void> {
  if (state.voiceMode === 'realtime' && state.realtimeExecutor) {
    try {
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      state.realtimeExecutor.sendAudio(audioBuffer);
    } catch (error) {
      log.error('Error forwarding realtime audio', { error, sessionId: state.sessionId });
    }
  }
}

async function handleVoiceStop(
  ws: WebSocket,
  state: SDKClientState,
  executionContext?: SDKMessageExecutionContext,
): Promise<void> {
  if (executionContext?.signal.aborted) {
    return;
  }

  if (state.realtimeExecutor) {
    unregisterSdkRealtimeInterruptionTarget(state);
    try {
      await state.realtimeExecutor.stop();
    } catch (err) {
      log.warn('Error stopping realtime executor', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: state.sessionId,
      });
    }
    state.realtimeExecutor = undefined;
    state.voiceMode = undefined;
  }

  if (executionContext?.signal.aborted) {
    log.warn('Suppressing timed-out SDK voice stop completion', {
      sessionId: state.sessionId,
    });
    return;
  }
  send(ws, ServerMessages.voiceStopped(state.sessionId));
  log.info('Voice session stopped', { sessionId: state.sessionId });

  // Omnichannel: detach voice participant, end live sync if no others remain
  const runtimeSidForVoiceEnd = getBoundSessionId(state);
  if (runtimeSidForVoiceEnd && state.tenantId && state.callerContext?.contactId) {
    const voiceParticipantId = `voice:${state.sessionId}`;

    liveSessionService
      .detachParticipant(runtimeSidForVoiceEnd, voiceParticipantId, state.tenantId, state.projectId)
      .then(async () => {
        // Fan out detach event
        fanOutParticipantEvent(
          runtimeSidForVoiceEnd,
          'participant_detached',
          createParticipant({
            participantId: voiceParticipantId,
            sessionId: runtimeSidForVoiceEnd,
            contactId: state.callerContext!.contactId!,
            surface: 'voice',
            interactive: false,
          }),
        );

        // Check if any participants remain
        const remaining = await participantRegistry.getParticipants(runtimeSidForVoiceEnd);
        if (remaining.length === 0) {
          await liveSessionService.endLiveSync(
            runtimeSidForVoiceEnd,
            state.tenantId,
            state.projectId,
            state.callerContext!.contactId!,
          );
        }
      })
      .catch((err) => {
        log.warn('Failed to handle voice end for live sync', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: state.sessionId,
        });
      });
  }
}

function handleBargeIn(ws: WebSocket, state: SDKClientState): void {
  log.info('Barge-in detected', { sessionId: state.sessionId });

  const targetSessionId = state.joinedLiveSessionId ?? getBoundSessionId(state) ?? state.sessionId;
  const { interrupted, acknowledgements } = interruptRealtimeVoiceSessions(targetSessionId, {
    tenantId: state.tenantId,
    reason: 'barge_in',
  });

  if (interrupted === 0 || acknowledgements === 0) {
    send(ws, ServerMessages.voiceBargeInAck());
  }
}

/**
 * Handle explicit session end request from the client.
 * When terminalization is enabled, runs the canonical terminalization path
 * before the socket closes so respond hooks can still write to the live
 * transport. Legacy close-handler cleanup remains as the fallback path.
 */
async function handleEndSession(ws: WebSocket, state: SDKClientState): Promise<void> {
  log.info('SDK client requested session end', {
    sessionId: state.sessionId,
    dbSessionId: state.dbSessionId,
  });
  state.disconnectLifecycleOverride = {
    disconnectBehavior: 'end',
    disposition: 'completed',
  };
  state.terminalSourceOverride = 'sdk_end_session';

  if (!state.explicitTerminalizationInFlight) {
    state.explicitTerminalizationInFlight = true;

    const runtimeId = state.runtimeSession?.id;
    const executor = getRuntimeExecutor();
    const runtimeSession =
      (runtimeId ? executor.getSession(runtimeId) : undefined) ?? state.runtimeSession;
    const capturedDataValues = capturePromotableSessionDataValues(runtimeSession);

    if (runtimeSession) {
      try {
        await executor.saveSessionSnapshot(runtimeSession);
      } catch (err) {
        log.warn('Failed to save SDK session snapshot before explicit end', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: runtimeSession.id,
        });
      }
    }

    state.explicitTerminalizationHandled = await terminalizeSdkConversationSession({
      state,
      runtimeSession,
      disposition: 'completed',
      source: 'sdk_end_session',
      capturedDataValues,
      sendHookResponse: async (message) => sendSdkEndHookResponse(ws, state, message),
    });
  }

  send(ws, ServerMessages.sessionEnded(state.sessionId));
  ws.close(1000, 'Session ended by client');
}

/**
 * Handle consent_satisfy: mark a connector as authorized, update auth gate,
 * and replay queued messages when all connectors are satisfied.
 */
function handleConsentSatisfy(
  ws: WebSocket,
  state: SDKClientState,
  message: SDKIncomingMessage,
): void {
  const authProfileRef = message.authProfileRef as string;
  const requirementKey =
    typeof message.requirementKey === 'string' ? (message.requirementKey as string) : undefined;
  const runtimeSid = getBoundSessionId(state);
  if (!authProfileRef || !runtimeSid) {
    send(ws, ServerMessages.error('Missing authProfileRef or session'));
    return;
  }

  // H-2: Validate session ownership — the WS connection must own the session
  if (message.sessionId && message.sessionId !== state.sessionId) {
    log.warn('consent_satisfy session ownership violation', {
      requestedSessionId: message.sessionId,
      ownedSessionId: state.sessionId,
    });
    send(ws, ServerMessages.error('Session ownership validation failed'));
    return;
  }

  const runtimeSession = state.runtimeSession ?? getRuntimeExecutor().getSession(runtimeSid);
  if (!runtimeSession?.compilationOutput) {
    send(ws, ServerMessages.error('No auth gate found for this session'));
    return;
  }

  const tokenLookups = createTokenLookups(
    runtimeSession.tenantId,
    runtimeSession.projectId,
    runtimeSession.versionInfo?.environment,
    {
      authScope: state.authScope,
      ...(state.authScope === 'session' && state.userId ? { sessionPrincipal: state.userId } : {}),
    },
  );

  void evaluateAuthPreflightFromIR(
    runtimeSession.compilationOutput,
    {
      sessionId: runtimeSid,
      userId: runtimeSession.userId ?? state.userId,
      tenantId: runtimeSession.tenantId,
      projectId: runtimeSession.projectId,
      environment: runtimeSession.versionInfo?.environment,
      authScope: state.authScope,
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
        send(ws, ServerMessages.authGateSatisfied(state.sessionId));
        emitAuthLifecycleTrace(ws, {
          sessionId: runtimeSid,
          decision: 'gate_satisfied',
          queuedMessageCount: result.queuedMessages.length,
          traceId: state.traceId,
          agentName: runtimeSession.agentName,
        });
        try {
          await deliverPendingSdkResults(ws, state);
          await fireOnStart(ws, state);
        } catch (err) {
          log.error('Failed to run ON_START before replaying queued SDK messages', {
            sessionId: state.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        for (const queued of result.queuedMessages) {
          try {
            await handleChatMessage(ws, state, {
              text: queued.text,
              messageId: crypto.randomUUID(),
              attachmentIds: queued.attachmentIds,
              metadata: queued.messageMetadata,
              interactionContext: queued.interactionContext,
            });
          } catch (err) {
            log.error('Failed to replay queued message after auth gate satisfied', {
              error: err instanceof Error ? err.message : String(err),
              sessionId: state.sessionId,
            });
          }
        }
        return;
      }

      send(
        ws,
        ServerMessages.authGateUpdated(
          state.sessionId,
          result.state.pending,
          result.state.satisfied,
        ),
      );
      emitAuthLifecycleTrace(ws, {
        sessionId: runtimeSid,
        decision: 'gate_updated',
        pending: result.state.pending,
        satisfied: result.state.satisfied,
        traceId: state.traceId,
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
      log.warn('Failed to re-evaluate auth gate after SDK consent signal', {
        sessionId: runtimeSid,
        authProfileRef,
        error: err instanceof Error ? err.message : String(err),
      });
      send(ws, ServerMessages.error('Failed to verify updated authorization state'));
    });
}

// =============================================================================
// OMNICHANNEL LIVE SESSION HANDLERS
// =============================================================================

/**
 * Handle discover_live_session: find an active voice session for the contact.
 */
async function handleDiscoverLiveSession(
  ws: WebSocket,
  state: SDKClientState,
  message: SDKIncomingMessage,
): Promise<void> {
  // Use authenticated contactId from session state; fall back to message for backward compat
  const contactId = state.callerContext?.contactId || (message.contactId as string);
  if (!contactId || !state.tenantId) {
    send(ws, ServerMessages.liveSessionNotFound());
    return;
  }

  const identityTier = state.callerContext?.identityTier ?? 0;

  try {
    const result = await liveSessionService.discoverLiveSession(
      state.tenantId,
      state.projectId,
      contactId,
      identityTier,
    );

    if (result) {
      send(ws, ServerMessages.liveSessionDiscovered(result));
    } else {
      send(ws, ServerMessages.liveSessionNotFound());
    }
  } catch (err) {
    log.error('Live session discovery failed', {
      error: err instanceof Error ? err.message : String(err),
      sessionId: state.sessionId,
    });
    send(ws, ServerMessages.liveSessionNotFound());
  }
}

/**
 * Handle join_live_session: attach to an existing live session.
 * Registers the participant, sends backfill, and notifies existing participants.
 */
async function handleJoinLiveSession(
  ws: WebSocket,
  state: SDKClientState,
  message: SDKIncomingMessage,
): Promise<void> {
  // SDK sends targetSessionId; also accept sessionId for backward compat
  const targetSessionId = (message.targetSessionId as string) || (message.sessionId as string);
  // Use authenticated contactId from session state; fall back to message for backward compat
  const contactId = state.callerContext?.contactId || (message.contactId as string);
  const surface = (message.surface as ParticipantSurface) || 'web';
  const joinToken = message.joinToken as string | undefined;

  if (!targetSessionId || !contactId || !state.tenantId) {
    send(
      ws,
      ServerMessages.liveSessionJoinError({
        code: 'INVALID_PARAMS',
        message: 'Missing required parameters',
      }),
    );
    return;
  }

  const identityTier = state.callerContext?.identityTier ?? 0;
  const participantId = `ws:${state.sessionId}:${crypto.randomUUID().slice(0, 8)}`;

  const participant: Participant = createParticipant({
    participantId,
    sessionId: targetSessionId,
    contactId,
    surface,
    label: state.userContext?.userId ?? undefined,
  });

  try {
    const result = await liveSessionService.joinLiveSession(
      state.tenantId,
      state.projectId,
      targetSessionId,
      participant,
      contactId,
      identityTier,
      joinToken,
    );

    if (!result.success) {
      send(
        ws,
        ServerMessages.liveSessionJoinError(
          result.error ?? { code: 'UNKNOWN', message: 'Join failed' },
        ),
      );
      return;
    }

    state.joinedLiveSessionId = targetSessionId;
    state.liveSessionParticipantId = participantId;
    state.liveSessionContactId = contactId;
    syncJoinedLiveSessionRegistry(ws, state, targetSessionId);

    send(ws, ServerMessages.liveSessionJoined(targetSessionId, participantId, result));

    // Fan out participant_attached to all existing connections
    fanOutParticipantEvent(targetSessionId, 'participant_attached', participant);
  } catch (err) {
    log.error('Join live session failed', {
      error: err instanceof Error ? err.message : String(err),
      sessionId: state.sessionId,
    });
    send(
      ws,
      ServerMessages.liveSessionJoinError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to join live session',
      }),
    );
  }
}

/**
 * Handle typed_interrupt: inject typed input into the shared session.
 * Fans out the input to all participants as a transcript item.
 */
async function handleTypedInterrupt(
  ws: WebSocket,
  state: SDKClientState,
  message: SDKIncomingMessage,
): Promise<void> {
  const targetSessionId = message.sessionId as string;
  const clientMessageId =
    typeof message.messageId === 'string' && message.messageId.length > 0
      ? message.messageId
      : crypto.randomUUID();
  const text = message.text as string;

  if (!targetSessionId || !text || !state.tenantId) {
    send(ws, ServerMessages.error('Missing sessionId or text for typed_interrupt'));
    return;
  }

  // Input size limit to prevent payload abuse
  if (typeof text !== 'string' || text.length > 4096) {
    send(ws, ServerMessages.error('Text exceeds maximum length (4096 characters)'));
    return;
  }

  // Verify caller is a participant of the target session
  const callerContactId = state.callerContext?.contactId;
  if (!callerContactId) {
    send(ws, ServerMessages.error('No verified identity for typed interrupt'));
    return;
  }
  try {
    const participants = await participantRegistry.getParticipants(targetSessionId);
    const isParticipant = participants.some((p) => p.contactId === callerContactId);
    if (!isParticipant) {
      send(ws, ServerMessages.error('Not a participant of this session'));
      return;
    }
  } catch {
    // Redis unavailable — fail closed
    send(ws, ServerMessages.error('Unable to verify session membership'));
    return;
  }

  interruptRealtimeVoiceSessions(targetSessionId, {
    tenantId: state.tenantId,
    reason: 'typed_interrupt',
  });

  let interruptResponseMessageId: string | undefined;
  let interruptExecutionId: string | undefined;

  try {
    const boundSessionId = getBoundSessionId(state);
    const executionSessionId = targetSessionId;
    const targetDbSessionId = !isDatabaseAvailable()
      ? undefined
      : targetSessionId === boundSessionId && state.dbSessionId
        ? state.dbSessionId
        : (await getConversationStore().getSession(targetSessionId))?.id;

    // Allocate sequence number
    let sequence: number | null = null;
    try {
      sequence = await participantRegistry.nextSequence(targetSessionId);
    } catch {
      // Non-fatal: proceed without sequence
    }

    // Create a transcript item for the typed input
    const item: TranscriptItem = {
      ...normalizeTranscriptItem({
        id: clientMessageId,
        sessionId: targetSessionId,
        role: 'user',
        content: text,
        channel: 'text',
        sourceChannel: 'text',
        inputMode: 'typed',
        sequence,
        timestamp: new Date(),
      }),
    };

    // Fan out to all participants
    fanOutTranscriptItem(targetSessionId, item);

    // Persist the typed input as a user message
    if (targetDbSessionId) {
      persistMessage(
        targetDbSessionId,
        'user',
        text,
        'web_chat',
        state.tenantId,
        undefined,
        state.callerContext?.contactId,
        state.projectId,
        Date.now(),
      ).catch((err: unknown) =>
        log.warn('Typed interrupt persist failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // Emit audit event
    const { emitOmnichannelAudit } = await import('../services/omnichannel/omnichannel-audit.js');
    emitOmnichannelAudit({
      eventType: 'typed_input_interrupted_tts',
      tenantId: state.tenantId,
      projectId: state.projectId,
      sessionId: targetSessionId,
      data: { participantSessionId: state.sessionId },
    });

    // Execute the message through the agent runtime
    const executor = getRuntimeExecutor();
    if (executor.isConfigured()) {
      interruptResponseMessageId = crypto.randomUUID();
      interruptExecutionId = `exec-${crypto.randomUUID()}`;

      send(
        ws,
        ServerMessages.responseStart(
          state.sessionId,
          interruptResponseMessageId,
          interruptExecutionId,
        ),
      );

      const allChunks: string[] = [];
      const responseProvenance = createResponseProvenanceAccumulator();
      const result = await executor.executeMessage(
        executionSessionId,
        text,
        (chunk: string) => {
          allChunks.push(chunk);
          send(
            ws,
            ServerMessages.responseChunk(state.sessionId, interruptResponseMessageId!, chunk),
          );
        },
        (event: { type: string; data: Record<string, unknown> }) => {
          accumulateResponseProvenance(responseProvenance, event);
        },
        {
          sessionLocator: buildSdkSessionLocator(state, executionSessionId) ?? undefined,
          channelMetadata: { channel: 'sdk_inbound', contentLength: text.length },
        },
      );

      const outcome = buildExecutionOutcome({
        channelType: 'web_chat',
        result,
        streamedText: allChunks.length > 0 ? allChunks.join('') : undefined,
        session:
          executor.getSession(executionSessionId) ??
          (executionSessionId === boundSessionId ? state.runtimeSession : undefined),
      });
      const responseText = outcome.responseText;
      const typedInterruptStructuredContent = buildPersistedAssistantStructuredContent(outcome);
      const responseMetadata = withAgentNameMetadata(
        outcome.responseMetadata ??
          result.responseMetadata ??
          buildResponseMessageMetadata(responseProvenance),
        state.runtimeSession?.agentName,
      );
      send(
        ws,
        ServerMessages.responseEnd(
          state.sessionId,
          interruptResponseMessageId,
          responseText,
          outcome.voiceConfig || undefined,
          outcome.richContent || undefined,
          outcome.actions || undefined,
          interruptExecutionId,
          responseMetadata,
          outcome.localization,
        ),
      );

      // Fan out the assistant response to all participants
      if (responseText) {
        let respSequence: number | null = null;
        try {
          respSequence = await participantRegistry.nextSequence(targetSessionId);
        } catch {
          // Non-fatal
        }

        const responseItem: TranscriptItem = {
          ...normalizeTranscriptItem({
            id: crypto.randomUUID(),
            sessionId: targetSessionId,
            role: 'assistant',
            content: responseText,
            channel: 'text',
            sourceChannel: 'text',
            inputMode: 'system',
            sequence: respSequence,
            timestamp: new Date(),
            metadata: responseMetadata,
          }),
        };
        fanOutTranscriptItem(targetSessionId, responseItem);

        // Persist the assistant response
        if (targetDbSessionId) {
          persistMessageRecord({
            dbSessionId: targetDbSessionId,
            role: 'assistant',
            content: responseText,
            channel: 'web_chat',
            tenantId: state.tenantId,
            contactId: state.callerContext?.contactId,
            projectId: state.projectId,
            messageTimestamp: Date.now(),
            structuredContent: typedInterruptStructuredContent,
            metadata: responseMetadata as unknown as Partial<MessageMetadata>,
            messageId: interruptResponseMessageId,
            agentName: state.runtimeSession?.agentName,
          }).catch((err: unknown) =>
            log.warn('Typed interrupt response persist failed', {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    }
  } catch (err) {
    log.error('Typed interrupt failed', {
      error: err instanceof Error ? err.message : String(err),
      sessionId: state.sessionId,
    });
    if (interruptResponseMessageId && interruptExecutionId) {
      send(
        ws,
        ServerMessages.responseEnd(
          state.sessionId,
          interruptResponseMessageId,
          '',
          undefined,
          undefined,
          undefined,
          interruptExecutionId,
        ),
      );
      send(ws, ServerMessages.error('Failed to process typed interrupt'));
      return;
    }
    send(ws, ServerMessages.error('Failed to process typed interrupt'));
  }
}

// =============================================================================
// UTILITIES
// =============================================================================

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(serializeServerMessage(message));
  }
}

function sendLegacyPong(ws: WebSocket): void {
  if (ws.readyState === ws.OPEN) {
    ws.send('{"type":"pong"}');
  }
}

function chunkText(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { sdkClients };
