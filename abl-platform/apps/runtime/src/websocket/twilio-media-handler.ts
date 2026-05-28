/**
 * Twilio Media Stream WebSocket Handler
 *
 * Handles real-time audio streaming from Twilio Voice calls.
 * Integrates Deepgram (STT) → Agent Runtime → ElevenLabs (TTS)
 *
 * Session lifecycle:
 * 1. Twilio opens media stream WebSocket with custom parameters
 * 2. handleStreamStart() creates runtime session + DB session from project context
 * 3. Audio flows: Twilio → Deepgram STT → processUtterance → RuntimeExecutor → ElevenLabs TTS → Twilio
 * 4. On stream stop/close, session cleanup runs
 */

import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import { getCurrentTraceId } from '@abl/compiler/platform/observability';
import {
  getDeepgramService,
  type DeepgramConnection,
  type TranscriptionResult,
} from '../services/voice/deepgram-service.js';
import { getElevenLabsService } from '../services/voice/elevenlabs-service.js';
import { getRuntimeExecutor } from '../services/runtime-executor.js';
import { getTwilioService } from '../services/voice/twilio-service.js';
import { isDatabaseAvailable } from '../db/index.js';
import type { VoiceServiceFactory } from '../services/voice/voice-service-factory.js';
import { app } from '../server.js';
import {
  RUNTIME_CHANNEL,
  PLATFORM_MESSAGES,
  MAX_MEDIA_SESSIONS,
  MEDIA_SESSION_TTL_MS,
  WS_MESSAGE_TIMEOUT_MS,
} from '../services/channel/constants.js';
import { getChannelAdapterRegistry } from '../services/channel/channel-adapter.js';
import { buildOutcomeTraceEvent, type ChannelOutcome } from '../services/channel/outcome.js';
import {
  createRuntimeSession,
  createAndLinkDBSession,
  resolveEnvironmentLabel,
  handleDisconnect,
} from '../channels/pipeline/index.js';
import { buildCallerContext } from '../services/identity/artifact-hasher.js';
import { getContactLinkingDeps } from '../services/identity/contact-linking-deps.js';
import { resolveProviderVerification } from '../services/identity/provider-verification-policy.js';
import { resolveCanonicalContactForProductionScope } from '../services/identity/production-contact-resolution.js';
import { buildStoredSessionCallerContext } from '../services/identity/stored-session-caller-context.js';
import {
  linkResolvedContactToSession,
  resolveContactIdFromChannelIdentity,
} from '../services/identity/channel-contact-linking.js';
import {
  buildRequiredContactProductionExecutionScope,
  requiresCanonicalContactProductionScope,
} from '../services/session/execution-scope-factory.js';
import { buildProductionSessionLocator } from '../services/session/execution-scope.js';
import { ScopeValidationError } from '../services/session/scope-policy.js';
import {
  emitChannelResponseSent,
  recordSyntheticTraceEvent,
} from '../services/channel-trace-utils.js';
import { coerceSessionMetadata } from '../services/session-metadata.js';
import type { RuntimeSession } from '../services/execution/types.js';
import { resolvePersistedAgentVersion } from '../services/execution/agent-version-utils.js';
import type { CallerContext, ChannelArtifactType } from '@agent-platform/shared-auth';
import { findSessionById } from '../repos/session-repo.js';
import {
  registerRealtimeInterruptionTarget,
  unregisterRealtimeInterruptionTarget,
} from '../services/voice/realtime-interruption-coordinator.js';
import {
  executeLiveVoiceSemanticTurn,
  executeLiveVoiceToolCall,
} from '../services/voice/live-voice-runtime-bridge.js';
import { executeVoiceTurn } from '../services/voice/voice-turn-coordinator.js';

const log = createLogger('twilio-media');

function normalizeVoiceArtifact(
  raw: string | undefined,
): { channelArtifact: string; channelArtifactType: ChannelArtifactType } | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^sips?:/i.test(trimmed)) {
    return { channelArtifact: trimmed.toLowerCase(), channelArtifactType: 'sip_uri' };
  }

  const digitsOnly = trimmed.replace(/[\s\-().]/g, '');
  if (/^\+?\d{7,15}$/.test(digitsOnly)) {
    return {
      channelArtifact: digitsOnly.startsWith('+') ? digitsOnly : `+${digitsOnly}`,
      channelArtifactType: 'caller_id',
    };
  }

  return { channelArtifact: trimmed, channelArtifactType: 'caller_id' };
}

function buildTwilioCallerContext(params: {
  tenantId: string;
  caller?: string;
  called?: string;
  channelId?: string;
  providerVerificationStrength?: string;
}): CallerContext {
  const normalizedVoiceArtifact = normalizeVoiceArtifact(params.caller);
  const providerVerification = resolveProviderVerification({
    providerVerified: normalizedVoiceArtifact != null,
    metadata: params.providerVerificationStrength
      ? { providerVerificationStrength: params.providerVerificationStrength }
      : undefined,
  });

  return buildCallerContext({
    tenantId: params.tenantId,
    channel: 'voice_twilio',
    channelId: params.channelId || params.called,
    anonymousId: params.caller?.trim(),
    identityTier: providerVerification.identityTier,
    verificationMethod: providerVerification.providerVerified ? 'provider' : 'none',
    rawArtifact: normalizedVoiceArtifact?.channelArtifact,
    channelArtifactType: normalizedVoiceArtifact?.channelArtifactType,
  });
}

function mergeTwilioCallerContext(
  baseCallerContext: CallerContext | undefined,
  existingCallerContext: CallerContext | undefined,
): CallerContext | undefined {
  if (!baseCallerContext) {
    return existingCallerContext;
  }

  if (!existingCallerContext) {
    return baseCallerContext;
  }

  const preferExistingIdentity =
    existingCallerContext.customerId != null ||
    existingCallerContext.contactId != null ||
    existingCallerContext.sessionPrincipalId != null ||
    existingCallerContext.authScope != null;
  const strongerIdentityTier =
    existingCallerContext.identityTier >= baseCallerContext.identityTier
      ? existingCallerContext.identityTier
      : baseCallerContext.identityTier;

  return {
    ...baseCallerContext,
    customerId: preferExistingIdentity
      ? (existingCallerContext.customerId ?? baseCallerContext.customerId)
      : baseCallerContext.customerId,
    contactId: existingCallerContext.contactId ?? baseCallerContext.contactId,
    sessionPrincipalId:
      existingCallerContext.sessionPrincipalId ?? baseCallerContext.sessionPrincipalId,
    anonymousId:
      existingCallerContext.sessionPrincipalId ??
      existingCallerContext.anonymousId ??
      baseCallerContext.anonymousId,
    identityTier: strongerIdentityTier,
    verificationMethod:
      strongerIdentityTier === existingCallerContext.identityTier
        ? existingCallerContext.verificationMethod
        : baseCallerContext.verificationMethod,
    authScope: existingCallerContext.authScope ?? baseCallerContext.authScope,
  };
}

function recordOutcomeTrace(params: {
  sessionId: string;
  session?: Pick<RuntimeSession, 'tracer'> | undefined;
  outcome: ChannelOutcome;
}): void {
  if (params.outcome.status === 'ok') {
    return;
  }

  recordSyntheticTraceEvent({
    sessionId: params.sessionId,
    session: params.session,
    event: buildOutcomeTraceEvent(params.outcome),
  });
}

/**
 * Lazily create a DB session on first voice utterance.
 * Dropped calls (no speech) never create a DB record.
 */
async function ensureVoiceDbSession(session: MediaSession): Promise<string | undefined> {
  if (session.dbSessionId) return session.dbSessionId;
  if (!session.pendingDbSession || !isDatabaseAvailable()) return undefined;
  if (!session.projectId) return undefined;

  try {
    const pending = session.pendingDbSession;
    const runtimeSess = getRuntimeExecutor().getSession(session.sessionId);
    const dbResult = await createAndLinkDBSession({
      channel: 'voice',
      agentName: pending.agentName,
      agentVersion: pending.agentVersion || '1.0',
      environment: resolveEnvironmentLabel(pending.environment),
      projectId: session.projectId,
      tenantId: session.tenantId,
      initiatedById: pending.callerContext?.initiatedById,
      deploymentId: pending.deploymentId,
      sessionId: session.sessionId,
      customerId: pending.callerContext?.customerId,
      anonymousId: pending.callerContext?.anonymousId,
      contactId: pending.callerContext?.contactId,
      channelArtifact: pending.callerContext?.channelArtifact,
      channelArtifactType: pending.callerContext?.channelArtifactType,
      identityTier: pending.callerContext?.identityTier,
      verificationMethod: pending.callerContext?.verificationMethod,
      channelId: pending.callerContext?.channelId,
      callerNumber: pending.callerNumber,
      experimentId: runtimeSess?.experimentId,
      experimentGroup: runtimeSess?.experimentGroup,
      metadata: {
        voiceMetadata: {
          provider: 'twilio',
          callSid: pending.callSid,
          ...(pending.calledNumber ? { called: pending.calledNumber } : {}),
        },
      },
    });
    session.dbSessionId = dbResult.dbSessionId;
    if (session.tenantId && pending.callerContext?.contactId) {
      await linkResolvedContactToSession({
        tenantId: session.tenantId,
        channelType: 'voice_twilio',
        channelId:
          pending.callerContext.channelId ??
          pending.calledNumber ??
          session.calledNumber ??
          'voice',
        sessionId: session.sessionId,
        contactId: pending.callerContext.contactId,
      });
    }
    session.pendingDbSession = undefined;
    return dbResult.dbSessionId;
  } catch (err) {
    log.warn('Failed to create DB session for voice call (lazy)', { err });
    return undefined;
  }
}

// =============================================================================
// TYPES
// =============================================================================

interface TwilioMessage {
  event: string;
  streamSid?: string;
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    customParameters?: Record<string, string>;
  };
  media?: {
    payload: string; // Base64 encoded audio (mulaw 8000Hz)
  };
  stop?: {
    accountSid: string;
    callSid: string;
  };
}

/** Info needed to lazily create a DB session on first voice utterance */
interface PendingVoiceDbSession {
  agentName: string;
  agentVersion?: string;
  environment?: string;
  entryAgentName?: string;
  deploymentId?: string;
  callerNumber?: string;
  calledNumber?: string;
  callSid?: string;
  callerContext?: CallerContext;
}

interface MediaSession {
  ws: WebSocket;
  streamSid: string;
  callSid: string;
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  dbSessionId?: string;
  /** Deferred DB session — only materialized on first utterance */
  pendingDbSession?: PendingVoiceDbSession;
  callerContext?: CallerContext;
  calledNumber?: string;
  deepgramConnection?: DeepgramConnection;
  currentTranscript: string;
  silenceTimer?: ReturnType<typeof setTimeout>;
  isProcessing: boolean;
  /** Timestamp for TTL-based eviction of stale sessions */
  createdAt: number;
  /** TTS engine resolved from tenant/channel config (for adapter resolution) */
  ttsEngine?: string;
  // Realtime voice support
  voiceMode?: 'pipeline' | 'realtime';
  realtimeExecutor?: import('../services/voice/realtime-voice-executor.js').RealtimeVoiceExecutor;
  realtimeInterruptionRegistrationId?: string;
  /** Guard flag to make handleStreamStop idempotent (stop event + ws close) */
  stopped?: boolean;
}

// =============================================================================
// STATE
// =============================================================================

const mediaSessions = new Map<string, MediaSession>();
const SILENCE_THRESHOLD_MS = 1500;

// Evict stale media sessions that never received a stop event (e.g. network partition)
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of mediaSessions) {
    if (session.createdAt && now - session.createdAt > MEDIA_SESSION_TTL_MS) {
      log.warn('Evicting stale media session', { streamSid: key, sessionId: session.sessionId });
      unregisterTwilioRealtimeInterruptionTarget(session);
      mediaSessions.delete(key);
    }
  }
}, 60_000).unref();

function unregisterTwilioRealtimeInterruptionTarget(session?: MediaSession): void {
  if (!session?.realtimeInterruptionRegistrationId) {
    return;
  }

  unregisterRealtimeInterruptionTarget(session.realtimeInterruptionRegistrationId);
  session.realtimeInterruptionRegistrationId = undefined;
}

function registerTwilioRealtimeInterruptionTarget(session: MediaSession): void {
  unregisterTwilioRealtimeInterruptionTarget(session);

  if (session.voiceMode !== 'realtime' || !session.realtimeExecutor) {
    return;
  }

  session.realtimeInterruptionRegistrationId = registerRealtimeInterruptionTarget({
    sessionIds: [session.sessionId],
    tenantId: session.tenantId,
    provider: 'twilio',
    interrupt: () => {
      session.realtimeExecutor?.cancelResponse();
    },
  });
}

// =============================================================================
// CONNECTION-LEVEL AUTHENTICATION
// =============================================================================

type ConnectionAuthResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'twilio_not_configured'
        | 'missing_connection_token'
        | 'invalid_connection_token'
        | 'invalid_signature'
        | 'signature_validation_error';
    };

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function buildTwilioUpgradeValidationUrl(req: IncomingMessage): string {
  const forwardedProto = getHeaderValue(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim();
  const forwardedHost = getHeaderValue(req.headers['x-forwarded-host'])?.split(',')[0]?.trim();
  const host = forwardedHost || getHeaderValue(req.headers.host)?.split(',')[0]?.trim();
  const protocol =
    forwardedProto === 'https'
      ? 'wss'
      : forwardedProto === 'http'
        ? 'ws'
        : (req.socket as { encrypted?: boolean }).encrypted
          ? 'wss'
          : 'ws';

  return new URL(req.url || '/voice/media', `${protocol}://${host || 'localhost'}`).toString();
}

/**
 * Validate the Twilio media WebSocket upgrade using the short-lived HMAC query
 * token emitted in TwiML. If an upstream also provides `X-Twilio-Signature`,
 * validate it as supplementary defense-in-depth.
 */
async function validateConnectionAuth(req: IncomingMessage): Promise<ConnectionAuthResult> {
  let twilio: ReturnType<typeof getTwilioService>;
  try {
    twilio = getTwilioService();
  } catch {
    return { ok: false, reason: 'twilio_not_configured' };
  }

  if (!twilio.isConfigured()) {
    return { ok: false, reason: 'twilio_not_configured' };
  }

  const token = new URL(req.url || '/voice/media', 'http://localhost').searchParams.get('token');
  if (!token) {
    return { ok: false, reason: 'missing_connection_token' };
  }

  if (!twilio.validateMediaStreamToken(token)) {
    return { ok: false, reason: 'invalid_connection_token' };
  }

  const signature = getHeaderValue(req.headers['x-twilio-signature']);
  if (!signature) {
    return { ok: true };
  }

  try {
    const isValidSignature = await twilio.validateWebhookSignature(
      signature,
      buildTwilioUpgradeValidationUrl(req),
      {},
    );
    if (!isValidSignature) {
      return { ok: false, reason: 'invalid_signature' };
    }
  } catch {
    return { ok: false, reason: 'signature_validation_error' };
  }

  return { ok: true };
}

// =============================================================================
// CONNECTION HANDLER
// =============================================================================

export async function handleTwilioMediaConnection(
  ws: WebSocket,
  req: IncomingMessage,
): Promise<void> {
  // Validate connection-level auth before processing any messages
  const authResult = await validateConnectionAuth(req);
  if (!authResult.ok) {
    log.warn('Twilio media: connection rejected — unauthorized upgrade request', {
      ip: req.socket?.remoteAddress,
      url: req.url,
      reason: authResult.reason,
    });
    ws.close(1008, 'Unauthorized');
    return;
  }

  log.info('Twilio media stream connecting');

  let session: MediaSession | null = null;

  ws.on('message', async (data) => {
    try {
      const message: TwilioMessage = JSON.parse(data.toString());

      switch (message.event) {
        case 'connected':
          log.debug('Twilio stream connected');
          break;

        case 'start':
          session = await handleStreamStart(ws, message);
          break;

        case 'media':
          if (session && message.media) {
            handleMediaPayload(session, message.media.payload);
          }
          break;

        case 'stop':
          if (session) {
            await handleStreamStop(session);
          }
          break;

        default:
          log.debug('Unknown Twilio event', { event: message.event });
      }
    } catch (error) {
      log.error('Error processing Twilio message', { error });
    }
  });

  ws.on('close', () => {
    // handleStreamStop is idempotent — safe to call even if the 'stop' event
    // already ran cleanup. This covers the case where Twilio closes without
    // sending a stop event (e.g. network partition).
    if (session) {
      handleStreamStop(session);
    }
    log.info('Twilio media stream closed');
  });

  ws.on('error', (error) => {
    log.error('Twilio media stream error', { error: error.message });
  });
}

// =============================================================================
// STREAM HANDLERS
// =============================================================================

async function handleStreamStart(ws: WebSocket, message: TwilioMessage): Promise<MediaSession> {
  const { streamSid, callSid, customParameters } = message.start!;
  const sessionId = customParameters?.sessionId || crypto.randomUUID();
  const tenantId = customParameters?.tenantId;
  const projectId = customParameters?.projectId;
  const deploymentId = customParameters?.deploymentId;
  const agentName = customParameters?.agentName;
  const caller = customParameters?.caller || customParameters?.from || undefined;
  const called = customParameters?.called || customParameters?.to || undefined;
  const channelId = customParameters?.channelId || called || undefined;
  const providerVerificationStrength = customParameters?.providerVerificationStrength;
  let sessionMetadata: Record<string, unknown> | undefined;

  try {
    sessionMetadata = coerceSessionMetadata(customParameters?.sessionMetadata);
  } catch (err) {
    log.warn('Twilio media: invalid sessionMetadata', {
      streamSid,
      callSid,
      error: err instanceof Error ? err.message : String(err),
    });
    ws.close(1008, 'Invalid session metadata');
    return {
      ws,
      streamSid,
      callSid,
      sessionId,
      tenantId,
      projectId,
      currentTranscript: '',
      isProcessing: false,
      createdAt: Date.now(),
    };
  }

  log.info('Twilio stream started', { streamSid, callSid, sessionId, tenantId, projectId });

  // Validate that required tenant/project context is provided
  if (!tenantId || !projectId) {
    log.warn('Twilio media: missing tenantId or projectId in customParameters', {
      streamSid,
      callSid,
    });
    ws.close(1008, 'Missing required parameters');
    return {
      ws,
      streamSid,
      callSid,
      sessionId,
      tenantId,
      projectId,
      currentTranscript: '',
      isProcessing: false,
      createdAt: Date.now(),
    };
  }

  // If a sessionId was provided, validate it exists and belongs to the claimed tenant
  if (customParameters?.sessionId) {
    const executor = getRuntimeExecutor();
    const existingSession = executor.getSession(sessionId);
    if (existingSession && existingSession.tenantId && existingSession.tenantId !== tenantId) {
      log.warn('Twilio media: session tenant mismatch', { sessionId, tenantId, streamSid });
      ws.close(1008, 'Session not found');
      return {
        ws,
        streamSid,
        callSid,
        sessionId,
        tenantId,
        projectId,
        currentTranscript: '',
        isProcessing: false,
        createdAt: Date.now(),
      };
    }
  }

  const baseCallerContext = tenantId
    ? buildTwilioCallerContext({
        tenantId,
        caller,
        called,
        channelId,
        providerVerificationStrength,
      })
    : undefined;

  let existingCallerContext: CallerContext | undefined;
  if (customParameters?.sessionId && tenantId) {
    const executor = getRuntimeExecutor();
    const existingSession =
      executor.getSession(sessionId) ?? (await executor.rehydrateSession?.(sessionId));
    existingCallerContext = existingSession?.callerContext;

    if (!existingCallerContext) {
      try {
        const storedSession = await findSessionById(sessionId, tenantId);
        existingCallerContext = storedSession
          ? buildStoredSessionCallerContext(storedSession, tenantId)
          : undefined;
      } catch (err) {
        log.warn('Failed to load stored caller context for Twilio session', {
          sessionId,
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Enforce max concurrent sessions to prevent unbounded memory growth
  if (mediaSessions.size >= MAX_MEDIA_SESSIONS) {
    log.error('Max media sessions reached, rejecting new connection', {
      current: mediaSessions.size,
      max: MAX_MEDIA_SESSIONS,
      streamSid,
    });
    ws.close();
    // Return a minimal session so callers don't crash; it won't be stored in the map
    return {
      ws,
      streamSid,
      callSid,
      sessionId,
      tenantId,
      projectId,
      currentTranscript: '',
      isProcessing: false,
      createdAt: Date.now(),
    };
  }

  let mergedCallerContext = mergeTwilioCallerContext(baseCallerContext, existingCallerContext);
  if (tenantId && caller && mergedCallerContext && !mergedCallerContext.contactId) {
    const resolvedContactId = await resolveContactIdFromChannelIdentity({
      tenantId,
      channelType: 'voice_twilio',
      rawArtifact: caller,
      artifactType: mergedCallerContext.channelArtifactType,
      verificationMethod: mergedCallerContext.verificationMethod,
      identityTier: mergedCallerContext.identityTier,
    });
    if (resolvedContactId) {
      mergedCallerContext = { ...mergedCallerContext, contactId: resolvedContactId };
    }
  }

  const session: MediaSession = {
    ws,
    streamSid,
    callSid,
    sessionId,
    tenantId,
    projectId,
    currentTranscript: '',
    isProcessing: false,
    createdAt: Date.now(),
    calledNumber: called,
    callerContext: mergedCallerContext,
  };

  mediaSessions.set(streamSid, session);

  // =========================================================================
  // CREATE RUNTIME SESSION (agent-backed voice)
  // =========================================================================
  if (projectId) {
    try {
      await createRuntimeSessionForVoice(session, {
        projectId,
        tenantId,
        deploymentId,
        environment: customParameters?.environment,
        agentName,
        callerNumber: caller,
        calledNumber: called,
        callerContext: session.callerContext,
        sessionMetadata,
      });
    } catch (err) {
      if (err instanceof ScopeValidationError) {
        log.warn('Failed to create runtime session for voice call: invalid session scope', {
          error: err.message,
          code: err.code,
          field: err.details.field,
          reason: err.details.reason,
          sessionId,
          projectId,
          tenantId,
        });
        mediaSessions.delete(streamSid);
        ws.close(1008, 'Invalid session scope');
        return {
          ws,
          streamSid,
          callSid,
          sessionId,
          tenantId,
          projectId,
          currentTranscript: '',
          isProcessing: false,
          createdAt: Date.now(),
          calledNumber: called,
          callerContext: session.callerContext,
        };
      }

      log.error('Failed to create runtime session for voice call', {
        error: err instanceof Error ? err.message : String(err),
        sessionId,
        projectId,
        tenantId,
      });
      // Continue without runtime session — fallback echo mode
    }
  }

  // =========================================================================
  // RESOLVE VOICE MODE (centralized — pipeline vs realtime)
  // =========================================================================
  try {
    const { resolveVoiceSession } = await import('../services/voice/voice-session-resolver.js');
    const runtimeExecutor = getRuntimeExecutor();
    const runtimeSession = runtimeExecutor.getSession(session.sessionId);
    const toolExecutor = runtimeSession
      ? async (toolName: string, input: Record<string, unknown>, voiceSessionId: string) => {
          const activeRuntimeSession =
            runtimeExecutor.getSession(runtimeSession.id || voiceSessionId) ?? runtimeSession;
          const toolResult = await executeLiveVoiceToolCall({
            runtimeExecutor,
            runtimeSession: activeRuntimeSession,
            toolName,
            input,
            tenantId: session.tenantId,
            projectId: session.projectId,
          });
          return {
            result: toolResult.serializedResult,
            activeAgentName: toolResult.activeAgentName,
            activeAgentIR: toolResult.activeAgentIR,
          };
        }
      : undefined;
    const voiceTurnExecutor = runtimeSession
      ? async (utterance: string, voiceSessionId: string) => {
          const activeRuntimeSession =
            runtimeExecutor.getSession(runtimeSession.id || voiceSessionId) ?? runtimeSession;
          const turnResult = await executeLiveVoiceSemanticTurn({
            channelType: 'voice_twilio',
            runtimeExecutor,
            runtimeSession: activeRuntimeSession,
            utterance,
            timeoutMs: WS_MESSAGE_TIMEOUT_MS,
            promptProfile: 'realtime',
            tenantId: session.tenantId,
            projectId: session.projectId,
            channelMetadata: {
              channel: 'twilio_voice',
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
      tenantId: session.tenantId,
      projectId: session.projectId,
      deploymentId,
      agentIR: runtimeSession?.agentIR ?? undefined,
      runtimeSession,
      audioFormat: 'g711_ulaw',
      sampleRate: 8000,
      sessionId: session.sessionId,
      toolExecutor,
      voiceTurnExecutor,
      semanticFamily: 'twilio_voice',
    });

    // Explicit realtime requested but can't be fulfilled — resolver already logged
    // the error. For Twilio we fall through to pipeline since we can't close a
    // phone call with a structured error.

    if (resolved.mode === 'realtime' && resolved.executor) {
      const executor = resolved.executor;
      const origConfig = (executor as any)
        .config as import('../services/voice/realtime-voice-executor.js').RealtimeVoiceExecutorConfig;

      // Wire audio output back to Twilio
      origConfig.onAudio = (audio: Buffer) => {
        sendAudioToTwilio(session, audio);
      };
      origConfig.onTurnEnd = (metrics) => {
        const realtimeRuntimeSession =
          runtimeExecutor.getSession(session.sessionId) ?? runtimeSession;
        recordSyntheticTraceEvent({
          sessionId: session.sessionId,
          session: realtimeRuntimeSession ?? undefined,
          tenantId: session.tenantId,
          projectId: session.projectId,
          event: {
            type: 'voice_realtime_turn_end',
            data: {
              ...metrics,
              promptProfile: executor.getPromptProfileDiagnostics(),
            },
          },
        });
      };
      origConfig.onError = (error: Error) => {
        log.error('Realtime voice error (Twilio)', {
          error: error.message,
          sessionId: session.sessionId,
        });
      };

      await executor.start();
      session.voiceMode = 'realtime';
      session.realtimeExecutor = executor;
      registerTwilioRealtimeInterruptionTarget(session);
      return session;
    }

    // Pipeline mode — fall through to Deepgram setup below
  } catch (err) {
    log.warn('voice session resolution failed, falling through to pipeline', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // =========================================================================
  // PIPELINE MODE: INITIALIZE DEEPGRAM STT
  // =========================================================================
  // Prefer tenant-scoped service, fall back to global
  const voiceFactory = app.locals.voiceServiceFactory as VoiceServiceFactory | undefined;
  const deepgram =
    session.tenantId && voiceFactory
      ? ((await voiceFactory.getSTTService(session.tenantId)) ?? getDeepgramService())
      : getDeepgramService();

  // Resolve TTS engine name for channel adapter resolution.
  // Defaults to 'elevenlabs' when no tenant-scoped config overrides.
  const ttsService =
    session.tenantId && voiceFactory ? await voiceFactory.getTTSService(session.tenantId) : null;
  session.ttsEngine = (ttsService as any)?.engineName ?? 'elevenlabs';
  if (deepgram.isConfigured()) {
    try {
      session.deepgramConnection = await deepgram.createConnection({
        model: 'nova-2',
        language: 'en',
        punctuate: true,
        smartFormat: true,
        interimResults: true,
        encoding: 'mulaw',
        sampleRate: 8000,
        channels: 1,
      });

      session.deepgramConnection.onTranscript((result) => {
        handleTranscription(session, result);
      });

      session.deepgramConnection.onError((error) => {
        log.error('Deepgram error', { error: error.message, sessionId });
      });

      log.debug('Deepgram connection established', { sessionId });
    } catch (error) {
      log.error('Failed to connect to Deepgram', { error, sessionId });
    }
  }

  // Send initial greeting
  await synthesizeAndSend(session, 'Hello! How can I help you today?');

  return session;
}

/**
 * Create a runtime session for the voice call using the shared pipeline.
 * Also creates and links a DB session for audit trail.
 */
async function createRuntimeSessionForVoice(
  session: MediaSession,
  opts: {
    projectId: string;
    tenantId?: string;
    deploymentId?: string;
    environment?: string;
    agentName?: string;
    callerNumber?: string;
    calledNumber?: string;
    callerContext?: CallerContext;
    sessionMetadata?: Record<string, unknown>;
  },
): Promise<void> {
  const executor = getRuntimeExecutor();
  if (!executor.isConfigured()) {
    log.warn('RuntimeExecutor not configured, voice will use fallback mode');
    return;
  }

  let callerContext = opts.callerContext;
  let shouldRequireScope = requiresCanonicalContactProductionScope({
    contactId: callerContext?.contactId,
    identityTier: callerContext?.identityTier,
    verificationMethod: callerContext?.verificationMethod,
  });
  if (shouldRequireScope && opts.tenantId && callerContext && !callerContext.contactId) {
    const deps = getContactLinkingDeps();
    if (deps) {
      const resolvedContact = await resolveCanonicalContactForProductionScope(
        {
          tenantId: opts.tenantId,
          callerContext,
          channelType: callerContext.channel,
          sessionId: session.sessionId,
        },
        deps,
      );
      if (resolvedContact) {
        callerContext = {
          ...callerContext,
          contactId: resolvedContact.contactId,
          ...(resolvedContact.displayName
            ? { contactDisplayName: resolvedContact.displayName }
            : {}),
        };
      }
    }
  }

  shouldRequireScope = requiresCanonicalContactProductionScope({
    contactId: callerContext?.contactId,
    identityTier: callerContext?.identityTier,
    verificationMethod: callerContext?.verificationMethod,
  });
  const scope = shouldRequireScope
    ? buildRequiredContactProductionExecutionScope({
        tenantId: opts.tenantId,
        projectId: opts.projectId,
        sessionId: session.sessionId,
        channelId: callerContext?.channelId ?? opts.calledNumber ?? session.calledNumber ?? 'voice',
        environment: opts.environment ?? (opts.deploymentId ? 'unknown' : 'dev'),
        source: 'twilio_voice',
        authType: 'twilio_media_stream',
        traceId: getCurrentTraceId() ?? crypto.randomUUID(),
        contactId: callerContext?.contactId,
        callerContext,
        identityTier: callerContext?.identityTier,
        verificationMethod: callerContext?.verificationMethod,
        channelArtifact: callerContext?.channelArtifact,
        channelArtifactType: callerContext?.channelArtifactType,
      })
    : undefined;
  session.callerContext = callerContext;

  // Use pipeline for session creation (handles deployment + legacy paths)
  const sessionResult = await createRuntimeSession({
    projectId: opts.projectId,
    tenantId: opts.tenantId,
    deploymentId: opts.deploymentId,
    environment: opts.environment,
    agentName: opts.agentName,
    sessionId: session.sessionId,
    channelType: 'voice_twilio',
    callerContext,
    metadata: opts.sessionMetadata,
    scope,
  });

  log.info('Voice runtime session created', {
    sessionId: sessionResult.runtimeSession.id,
    entryAgent: sessionResult.entryAgentName,
    deploymentId: opts.deploymentId,
  });

  // Defer DB session creation until first utterance
  // (dropped calls before speech never create a DB record)
  session.pendingDbSession = {
    agentName: sessionResult.entryAgentName || 'unknown',
    agentVersion: resolvePersistedAgentVersion(
      sessionResult.resolved?.versionInfo,
      sessionResult.entryAgentName || 'unknown',
    ),
    environment: sessionResult.resolved?.versionInfo?.environment,
    entryAgentName: sessionResult.entryAgentName,
    deploymentId: opts.deploymentId,
    callerNumber: opts.callerNumber,
    calledNumber: opts.calledNumber,
    callSid: session.callSid,
    callerContext,
  };
}

async function handleStreamStop(session: MediaSession): Promise<void> {
  // Idempotent guard: handleStreamStop may fire on both the Twilio 'stop'
  // event and the WebSocket 'close' event. Only run cleanup once.
  if (session.stopped) {
    return;
  }
  session.stopped = true;

  log.info('Twilio stream stopping', { sessionId: session.sessionId });

  // Clean up realtime executor if active
  if (session.realtimeExecutor) {
    unregisterTwilioRealtimeInterruptionTarget(session);
    try {
      await session.realtimeExecutor.stop();
    } catch (err) {
      log.warn('Error stopping realtime executor (Twilio)', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.sessionId,
      });
    }
    session.realtimeExecutor = undefined;
    session.voiceMode = undefined;
  }

  // Twilio-specific cleanup: silence timer + Deepgram connection
  if (session.silenceTimer) {
    clearTimeout(session.silenceTimer);
  }

  if (session.deepgramConnection) {
    session.deepgramConnection.close();
  }

  // Delegate lifecycle cleanup to shared pipeline
  await handleDisconnect({
    channel: 'voice',
    sessionId: session.sessionId,
    dbSessionId: session.dbSessionId,
    tenantId: session.tenantId,
    projectId: session.projectId,
    agentName: session.pendingDbSession?.agentName,
  });

  mediaSessions.delete(session.streamSid);
}

function handleMediaPayload(session: MediaSession, payload: string): void {
  // Realtime mode: forward audio directly to realtime session
  if (session.voiceMode === 'realtime' && session.realtimeExecutor) {
    const audioBuffer = Buffer.from(payload, 'base64');
    session.realtimeExecutor.sendAudio(audioBuffer);
    return;
  }

  // Pipeline mode: forward to Deepgram STT
  if (!session.deepgramConnection || session.isProcessing) {
    return;
  }

  // Decode base64 mulaw audio and send to Deepgram
  const audioBuffer = Buffer.from(payload, 'base64');
  session.deepgramConnection.send(audioBuffer);
}

// =============================================================================
// TRANSCRIPTION
// =============================================================================

function handleTranscription(session: MediaSession, result: TranscriptionResult): void {
  if (result.isFinal && result.text.trim()) {
    session.currentTranscript += ' ' + result.text.trim();

    // Reset silence timer
    if (session.silenceTimer) {
      clearTimeout(session.silenceTimer);
    }

    // Wait for silence before processing
    session.silenceTimer = setTimeout(() => {
      processUtterance(session);
    }, SILENCE_THRESHOLD_MS);
  }
}

async function processUtterance(session: MediaSession): Promise<void> {
  const utterance = session.currentTranscript.trim();
  session.currentTranscript = '';

  if (!utterance || session.isProcessing) {
    return;
  }

  // Lazily create DB session on first actual speech
  await ensureVoiceDbSession(session);

  session.isProcessing = true;
  log.debug('Processing utterance', { utterance, sessionId: session.sessionId });
  const startTime = Date.now();

  try {
    const executor = getRuntimeExecutor();

    if (!executor.isConfigured()) {
      await synthesizeAndSend(session, PLATFORM_MESSAGES.VOICE_RUNTIME_NOT_CONFIGURED);
      session.isProcessing = false;
      return;
    }

    // Chain filler TTS calls to prevent interleaving with the final response.
    // Each status_update extends the chain so fillers play sequentially, and
    // we await the chain before starting final response synthesis.
    let inFlightFiller: Promise<void> = Promise.resolve();

    const coordinatorResult = await executeVoiceTurn({
      channelType: 'voice_twilio',
      executor,
      sessionId: session.sessionId,
      utterance,
      timeoutMs: WS_MESSAGE_TIMEOUT_MS,
      promptProfile: 'pipeline',
      onTraceEvent: (event) => {
        // Synthesize filler messages as TTS audio mid-turn to prevent dead-air.
        if (event.type === 'status_update' && typeof event.data.text === 'string') {
          const fillerText = event.data.text;
          inFlightFiller = inFlightFiller
            .then(() => synthesizeAndSend(session, fillerText))
            .catch((err) => {
              log.debug('Twilio filler synthesis failed', {
                error: err instanceof Error ? err.message : String(err),
                sessionId: session.sessionId,
              });
            });
        }
      },
      executeOptions: {
        sessionLocator:
          buildProductionSessionLocator({
            tenantId: session.tenantId,
            projectId: session.projectId,
            sessionId: session.sessionId,
          }) ?? undefined,
        channelMetadata: { channel: 'twilio_voice', contentLength: utterance.length },
      },
    });
    const outcome = coordinatorResult.outcome;
    const runtimeSession = coordinatorResult.runtimeSession;
    recordOutcomeTrace({
      sessionId: session.sessionId,
      session: runtimeSession ?? undefined,
      outcome,
    });

    // Drain any in-flight filler synthesis before starting final response playback.
    // Prevents filler and final response audio from racing on the same WebSocket.
    await inFlightFiller;

    // Resolve voice-appropriate text via channel adapter.
    // Use the TTS engine resolved from tenant config (falls back to 'voice' channel type).
    const voiceText = getChannelAdapterRegistry().resolve(
      { text: outcome.responseText, voiceConfig: outcome.voiceConfig },
      { channelType: RUNTIME_CHANNEL.VOICE, engine: session.ttsEngine },
    );
    await synthesizeAndSend(session, voiceText);

    emitChannelResponseSent(session.sessionId, 'twilio_voice', Date.now() - startTime, {
      tenantId: session.tenantId,
      projectId: session.projectId,
      configHash: executor.getSession(session.sessionId)?.configHash,
      knownSource: executor.getSession(session.sessionId)?.knownSource,
    });
  } catch (error) {
    log.error('Utterance processing error', { error, sessionId: session.sessionId });
    await synthesizeAndSend(session, PLATFORM_MESSAGES.VOICE_PROCESSING_ERROR);
  }

  session.isProcessing = false;
}

// =============================================================================
// TTS & AUDIO STREAMING
// =============================================================================

async function synthesizeAndSend(session: MediaSession, text: string): Promise<void> {
  const voiceFactory2 = app.locals.voiceServiceFactory as VoiceServiceFactory | undefined;
  const elevenlabs =
    session.tenantId && voiceFactory2
      ? ((await voiceFactory2.getTTSService(session.tenantId)) ?? getElevenLabsService())
      : getElevenLabsService();

  if (!elevenlabs.isConfigured()) {
    log.warn('ElevenLabs not configured, cannot send audio');
    return;
  }

  try {
    log.debug('Synthesizing response', { textLength: text.length, sessionId: session.sessionId });

    // Synthesize to mulaw format for Twilio
    for await (const chunk of elevenlabs.synthesizeStream(text, {
      outputFormat: 'ulaw_8000', // Twilio format
    })) {
      sendAudioToTwilio(session, chunk);
    }

    // Send mark to indicate end of audio
    sendMark(session, 'response_complete');
  } catch (error) {
    log.error('TTS synthesis error', { error, sessionId: session.sessionId });
  }
}

function sendAudioToTwilio(session: MediaSession, audio: Uint8Array): void {
  if (session.ws.readyState !== session.ws.OPEN) {
    return;
  }

  const message = {
    event: 'media',
    streamSid: session.streamSid,
    media: {
      payload: Buffer.from(audio).toString('base64'),
    },
  };

  session.ws.send(JSON.stringify(message));
}

function sendMark(session: MediaSession, name: string): void {
  if (session.ws.readyState !== session.ws.OPEN) {
    return;
  }

  const message = {
    event: 'mark',
    streamSid: session.streamSid,
    mark: {
      name,
    },
  };

  session.ws.send(JSON.stringify(message));
}

// =============================================================================
// SESSION MANAGEMENT
// =============================================================================

export function getMediaSession(streamSid: string): MediaSession | undefined {
  return mediaSessions.get(streamSid);
}
