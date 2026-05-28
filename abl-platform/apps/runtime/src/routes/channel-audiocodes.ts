/**
 * AudioCodes VoiceAI Connect Bot API Route
 *
 * Implements the AudioCodes Bot API (HTTP mode with WebSocket for responses).
 *
 * Endpoints:
 *   POST /api/v1/channels/audiocodes/webhook/:identifier
 *       — Conversation creation (AudioCodes sends { conversation: "id" })
 *   POST /api/v1/channels/audiocodes/webhook/:identifier/conversation/:conversationId/activities
 *       — Inbound activities (speech, DTMF, events)
 *   POST /api/v1/channels/audiocodes/webhook/:identifier/conversation/:conversationId/refresh
 *       — Keep-alive / session refresh
 *   POST /api/v1/channels/audiocodes/webhook/:identifier/conversation/:conversationId/disconnect
 *       — Call end / cleanup
 *
 * WebSocket (handled in server.ts upgrade):
 *   /ws/audiocodes/:identifier/conversation/:conversationId
 *       — Bot sends response activities to AudioCodes over this connection
 *
 * Flow:
 *   1. AudioCodes POSTs to botURL (our webhook/:identifier)
 *   2. We create session, return activitiesURL + websocketURL + refreshURL + disconnectURL
 *   3. AudioCodes opens WebSocket to websocketURL
 *   4. AudioCodes POSTs user speech/events to activitiesURL
 *   5. We process async (queue → runtime → response)
 *   6. We send response activities over WebSocket
 *   7. On call end, AudioCodes POSTs to disconnectURL
 */

import { Router, type Router as RouterType } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { errorToResponse } from '@agent-platform/shared-kernel';
import { extractIngressToken, tokensMatch } from '@agent-platform/shared-kernel/security';
import { acquireSessionLock, releaseSessionLock } from '../services/queues/session-lock.js';
import {
  AudioCodesAdapter,
  buildMessageActivity,
  buildHangupActivity,
  buildConfigActivity,
} from '../channels/adapters/audiocodes-adapter.js';
import { buildProductionSessionLocator } from '../services/session/execution-scope.js';
import type {
  AudioCodesConversationRequest,
  AudioCodesActivitiesPayload,
  AudioCodesDisconnectPayload,
  AudioCodesChannelConfig,
} from '../channels/adapters/audiocodes-adapter.js';
import { sendActivities, removeConnection } from '../channels/audiocodes/ws-manager.js';
import {
  emitChannelResponseSent,
  recordSyntheticTraceEvent,
} from '../services/channel-trace-utils.js';
import { getChannelAdapterRegistry } from '../services/channel/channel-adapter.js';
import { buildOutcomeTraceEvent, type ChannelOutcome } from '../services/channel/outcome.js';
import { WS_MESSAGE_TIMEOUT_MS } from '../services/channel/constants.js';
import type { RuntimeSession } from '../services/execution/types.js';
import { handleDisconnect } from '../channels/pipeline/lifecycle-manager.js';
import { isSessionMetadataValidationError } from '../services/session-metadata.js';
import { executeVoiceTurn } from '../services/voice/voice-turn-coordinator.js';
import { resolveConversationBehaviorVoiceRuntimeConfig } from '../services/execution/conversation-behavior-resolver.js';

const router: RouterType = Router();
const log = createLogger('channel-audiocodes');
const adapter = new AudioCodesAdapter();

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

// ---------------------------------------------------------------------------
// Auth helper: verify token from header or query param
// ---------------------------------------------------------------------------

async function verifyAndResolveConnection(
  identifier: string,
  req: import('express').Request,
  res: import('express').Response,
): Promise<import('../channels/types.js').ResolvedConnection | null> {
  const { resolveChannelConnection } = await import('../channels/connection-resolver.js');
  const connection = await resolveChannelConnection('audiocodes', identifier);

  if (!connection) {
    log.warn('No AudioCodes connection found', { identifier });
    res.status(404).json({ error: 'Channel not configured' });
    return null;
  }

  const config = (connection.config || {}) as AudioCodesChannelConfig;
  const expectedToken = resolveAudioCodesIngressToken(connection);
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  // TODO(auth-consolidation): Remove query-token fallback after all supported
  // AudioCodes ingress deployments send the secret via headers instead of the URL.
  const providedToken = extractIngressToken(req.headers, queryToken, {
    allowQueryTokenFor: 'audiocodes_http',
  });

  if (!expectedToken) {
    log.error('AudioCodes ingress token not configured', { identifier });
    res.status(503).json({ error: 'Channel not fully configured' });
    return null;
  } else if (!tokensMatch(providedToken, expectedToken)) {
    log.warn('AudioCodes token verification failed', { identifier, hasToken: !!providedToken });
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  return connection;
}

function resolveAudioCodesIngressToken(
  connection: import('../channels/types.js').ResolvedConnection,
): string | null {
  const config = (connection.config || {}) as AudioCodesChannelConfig;
  const creds = (connection.credentials || {}) as Record<string, string>;
  // Token may come from credentials (user-provided via Studio UI) or config (API/migration)
  return creds.inboundAuthToken?.trim() || config.inboundAuthToken?.trim() || null;
}

function appendLegacyQueryToken(url: string, token: string | null): string {
  if (!token) {
    return url;
  }

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

function respondWithSessionMetadataValidationJson(
  res: import('express').Response,
  error: unknown,
): boolean {
  if (!isSessionMetadataValidationError(error)) {
    return false;
  }

  const { statusCode, body } = errorToResponse(error);
  res.status(statusCode).json(body);
  return true;
}

// ---------------------------------------------------------------------------
// Helper: resolve public base URL for generating callback URLs
// ---------------------------------------------------------------------------

function resolvePublicBaseUrl(req: import('express').Request): string {
  const envUrl = process.env.RUNTIME_PUBLIC_BASE_URL || process.env.RUNTIME_BASE_URL;
  if (envUrl) {
    return envUrl.replace(/\/$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

// =============================================================================
// GET /webhook/:identifier — Health Check (AudioCodes bot availability probe)
// =============================================================================

router.get('/webhook/:identifier', (_req, res) => {
  res.status(200).json({ type: 'ac-bot-api', success: true });
});

// =============================================================================
// POST /webhook/:identifier — Conversation Creation
// =============================================================================

router.post('/webhook/:identifier', async (req, res) => {
  const { identifier } = req.params;
  const body = req.body as AudioCodesConversationRequest;

  if (!body.conversation) {
    return res.status(400).json({ error: 'Missing conversation ID' });
  }

  log.info('AudioCodes conversation init', {
    identifier,
    conversationId: body.conversation,
  });

  const connection = await verifyAndResolveConnection(identifier, req, res);
  if (!connection) return; // response already sent

  const config = (connection.config || {}) as AudioCodesChannelConfig;
  const baseUrl = resolvePublicBaseUrl(req);
  const encodedId = encodeURIComponent(identifier);
  const convId = encodeURIComponent(body.conversation);
  const basePath = `/api/v1/channels/audiocodes/webhook/${encodedId}/conversation/${convId}`;
  const expectedToken = resolveAudioCodesIngressToken(connection);

  // Build the welcome message as initial activity via session creation
  // (actual session creation happens on first activities POST with 'start' event)

  const expiresSeconds = config.expiresSeconds ?? 120;

  // Build WebSocket URL (ws:// or wss:// depending on protocol)
  const wsProtocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
  const wsHost = baseUrl.replace(/^https?:\/\//, '');
  // TODO(auth-consolidation): Remove URL token provisioning once AudioCodes can
  // consistently send ingress secrets via headers for both HTTP and WebSocket flows.
  const websocketURL = appendLegacyQueryToken(
    `${wsProtocol}://${wsHost}/ws/audiocodes/${encodedId}/conversation/${convId}`,
    expectedToken,
  );

  res.status(200).json({
    activitiesURL: appendLegacyQueryToken(`${basePath}/activities`, expectedToken),
    refreshURL: appendLegacyQueryToken(`${basePath}/refresh`, expectedToken),
    disconnectURL: appendLegacyQueryToken(`${basePath}/disconnect`, expectedToken),
    websocketURL,
    expiresSeconds,
  });
});

// =============================================================================
// POST /webhook/:identifier/conversation/:conversationId/activities
// =============================================================================

router.post('/webhook/:identifier/conversation/:conversationId/activities', async (req, res) => {
  const startTime = Date.now();
  const { identifier, conversationId } = req.params;
  const body = req.body as AudioCodesActivitiesPayload;

  if (!body.activities || !Array.isArray(body.activities)) {
    return res.status(400).json({ error: 'Missing activities array' });
  }

  log.info('AudioCodes activities received', {
    identifier,
    conversationId,
    activityCount: body.activities.length,
    eventNames: body.activities.map((a) => a.name || a.type).join(','),
  });

  const connection = await verifyAndResolveConnection(identifier, req, res);
  if (!connection) return;

  const config = (connection.config || {}) as AudioCodesChannelConfig;

  // Normalize the AudioCodes activities into our internal message format
  let normalizedMsg: ReturnType<AudioCodesAdapter['buildNormalizedMessage']>;
  try {
    normalizedMsg = adapter.buildNormalizedMessage(conversationId, body.activities);
  } catch (error) {
    if (respondWithSessionMetadataValidationJson(res, error)) {
      log.warn('Rejected AudioCodes session metadata at ingress boundary', {
        identifier,
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    throw error;
  }

  const { resolveSession } = await import('../channels/session-resolver.js');
  let session: Awaited<ReturnType<typeof resolveSession>>;
  try {
    session = await resolveSession(connection, normalizedMsg);
  } catch (error) {
    if (respondWithSessionMetadataValidationJson(res, error)) {
      log.warn('Rejected AudioCodes session metadata during session resolution', {
        identifier,
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    throw error;
  }
  if (!normalizedMsg.interactionContext && typeof config.language === 'string') {
    normalizedMsg.interactionContext = { language: config.language };
  }

  const isNewCall = normalizedMsg.metadata?.isNewCall === true;
  const isNoInput = normalizedMsg.metadata?.isNoInput === true;

  // Return 200 immediately — we process async and respond via WebSocket
  res.status(200).json({ activities: [] });

  // Process in background
  try {
    log.info('AudioCodes session resolved', {
      conversationId,
      sessionId: session.sessionId,
      isNew: session.isNew,
    });

    // Acquire per-session lock
    const lockKey = `channel:lock:${session.sessionId}`;
    const lockId = `audiocodes-${conversationId}-${Date.now()}`;
    const lockAcquired = await acquireSessionLock(lockKey, lockId);

    if (!lockAcquired) {
      log.error('Session lock timeout for AudioCodes call', { conversationId });
      sendActivities(conversationId, [
        buildMessageActivity('The system is busy. Please try again.'),
        buildHangupActivity('SystemBusy'),
      ]);
      return;
    }

    try {
      // For new calls with no speech text, use welcome trigger
      const userText = normalizedMsg.text || (isNewCall ? 'hi' : '');

      if (!userText && isNoInput) {
        // No input event — send a prompt
        sendActivities(conversationId, [
          buildMessageActivity('Are you still there? Please say something or press a key.'),
        ]);
        return;
      }

      if (!userText) {
        // No meaningful input — skip execution
        return;
      }

      // Execute through runtime
      const { getRuntimeExecutor } = await import('../services/runtime-executor.js');
      const executor = getRuntimeExecutor();
      const sessionLocator = buildProductionSessionLocator({
        tenantId: connection.tenantId,
        projectId: connection.projectId,
        sessionId: session.sessionId,
      });
      const coordinatorResult = await executeVoiceTurn({
        channelType: 'audiocodes',
        executor,
        sessionId: session.sessionId,
        utterance: userText,
        timeoutMs: WS_MESSAGE_TIMEOUT_MS,
        promptProfile: 'pipeline',
        onTraceEvent: (event) => {
          // Forward filler status messages to AudioCodes as mid-turn message activities.
          // AudioCodes will TTS them immediately, preventing dead-air during long operations.
          if (event.type === 'status_update' && typeof event.data.text === 'string') {
            sendActivities(conversationId, [buildMessageActivity(event.data.text)]);
          }
        },
        executeOptions: {
          ...(sessionLocator ? { sessionLocator } : {}),
          ...(normalizedMsg.interactionContext
            ? { interactionContext: normalizedMsg.interactionContext }
            : {}),
          channelMetadata: { channel: 'audiocodes', contentLength: userText.length },
        },
      });
      const outcome = coordinatorResult.outcome;
      const runtimeSession = coordinatorResult.runtimeSession;
      recordOutcomeTrace({
        sessionId: session.sessionId,
        session: runtimeSession ?? undefined,
        outcome,
      });

      // Build and send response activities over WebSocket
      const voiceText = getChannelAdapterRegistry().resolve(
        { text: outcome.responseText, voiceConfig: outcome.voiceConfig },
        { channelType: 'audiocodes' },
      );
      const responseActivities = [buildMessageActivity(voiceText)];
      const behaviorVoiceConfig = resolveConversationBehaviorVoiceRuntimeConfig(
        runtimeSession?._effectiveConfig?.conversationBehavior,
      );

      // Send config on first message if needed
      if (
        (isNewCall ||
          behaviorVoiceConfig.bargeIn !== undefined ||
          behaviorVoiceConfig.pauseTimeoutMs !== undefined) &&
        (config.bargeIn !== undefined ||
          behaviorVoiceConfig.bargeIn !== undefined ||
          behaviorVoiceConfig.pauseTimeoutMs !== undefined ||
          config.language)
      ) {
        const sessionParams: Record<string, unknown> = {};
        if (behaviorVoiceConfig.bargeIn !== undefined) {
          sessionParams.bargeIn = behaviorVoiceConfig.bargeIn;
        } else if (config.bargeIn !== undefined) {
          sessionParams.bargeIn = config.bargeIn;
        }
        if (config.language) sessionParams.language = config.language;
        if (config.voiceName) sessionParams.voiceName = config.voiceName;
        if (behaviorVoiceConfig.pauseTimeoutMs !== undefined) {
          sessionParams.endOfSpeechTimeoutMs = behaviorVoiceConfig.pauseTimeoutMs;
        }
        if (config.userNoInputTimeoutMs)
          sessionParams.userNoInputTimeoutMS = config.userNoInputTimeoutMs;
        if (config.userNoInputRetries) sessionParams.userNoInputRetries = config.userNoInputRetries;
        responseActivities.unshift(buildConfigActivity(sessionParams));
      }

      const sent = sendActivities(conversationId, responseActivities);
      if (!sent) {
        log.warn('Failed to send response — no WebSocket connection', { conversationId });
      } else {
        emitChannelResponseSent(session.sessionId, 'audiocodes', Date.now() - startTime, {
          tenantId: connection.tenantId,
          projectId: connection.projectId,
          configHash: executor.getSession(session.sessionId)?.configHash,
          knownSource: executor.getSession(session.sessionId)?.knownSource,
        });
      }
    } finally {
      await releaseSessionLock(lockKey, lockId);
    }
  } catch (error) {
    if (!res.headersSent && respondWithSessionMetadataValidationJson(res, error)) {
      return;
    }

    log.error('AudioCodes activity processing failed', {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    sendActivities(conversationId, [
      buildMessageActivity('Sorry, an error occurred. Please try again.'),
    ]);
  }
});

// =============================================================================
// POST /webhook/:identifier/conversation/:conversationId/refresh
// =============================================================================

router.post('/webhook/:identifier/conversation/:conversationId/refresh', async (req, res) => {
  const { identifier, conversationId } = req.params;

  log.debug('AudioCodes session refresh', { identifier, conversationId });

  const connection = await verifyAndResolveConnection(identifier, req, res);
  if (!connection) return;

  // Acknowledge — session TTL is managed by MongoDB/Redis
  // The session-resolver refreshes lastMessageAt on each message
  res.status(200).json({ ok: true });
});

// =============================================================================
// POST /webhook/:identifier/conversation/:conversationId/disconnect
// =============================================================================

router.post('/webhook/:identifier/conversation/:conversationId/disconnect', async (req, res) => {
  const { identifier, conversationId } = req.params;
  const body = req.body as AudioCodesDisconnectPayload;

  log.info('AudioCodes disconnect', {
    identifier,
    conversationId,
    reason: body.reason,
    reasonCode: body.reasonCode,
  });

  const connection = await verifyAndResolveConnection(identifier, req, res);
  if (!connection) return;

  // Clean up WebSocket connection
  removeConnection(conversationId);

  // Mark channel session as ended and close the shared runtime/db session
  try {
    const { ChannelSession } = await import('@agent-platform/database/models');
    const channelSession = await ChannelSession.findOne({
      tenantId: connection.tenantId,
      channelConnectionId: connection.id,
      externalSessionKey: `audiocodes:${conversationId}`,
      status: 'active',
    });

    if (channelSession?.sessionId) {
      // Channel-created DB sessions use the canonical sessionId as the DB id.
      await handleDisconnect({
        channel: 'voice',
        sessionId: channelSession.sessionId,
        dbSessionId: channelSession.sessionId,
        tenantId: connection.tenantId,
      });
    }

    await ChannelSession.updateOne(
      {
        tenantId: connection.tenantId,
        channelConnectionId: connection.id,
        externalSessionKey: `audiocodes:${conversationId}`,
        status: 'active',
      },
      { $set: { status: 'ended' } },
    );
  } catch (err) {
    log.error('Failed to update channel session on disconnect', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  res.status(200).json({ ok: true });
});

export default router;
