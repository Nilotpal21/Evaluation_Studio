/**
 * VXML/IVR Channel Route — Synchronous Voice Application Server
 *
 * POST /api/v1/channels/vxml/hooks/:streamId
 *
 * Unlike async channels that queue to BullMQ and respond later, VXML requires
 * an immediate XML response — the telephony platform (Genesys, Avaya, Cisco)
 * holds the call open waiting for the VXML document.
 *
 * Flow:
 *   Telephony POST → parse callId + message
 *     → resolve connection (streamId = externalIdentifier)
 *     → resolve/create session (callId → sessionId)
 *     → acquire session lock (same pattern as inbound-worker)
 *     → executeMessage(sessionId, text)
 *     → build VXML from response
 *     → return Content-Type: text/xml
 *     → release session lock
 */

import { Router, type Router as RouterType, type Request } from 'express';
import express from 'express';
import { createLogger } from '@abl/compiler/platform';
import { errorToResponse } from '@agent-platform/shared-kernel';
import { acquireSessionLock, releaseSessionLock } from '../services/queues/session-lock.js';
import { VxmlAdapter, buildErrorVxml } from '../channels/adapters/vxml-adapter.js';
import type { VxmlWebhookRequest, VxmlChannelConfig } from '../channels/adapters/vxml-adapter.js';
import { extractIngressToken, tokensMatch } from '@agent-platform/shared-kernel/security';
import {
  emitChannelResponseSent,
  recordSyntheticTraceEvent,
} from '../services/channel-trace-utils.js';
import { getChannelAdapterRegistry } from '../services/channel/channel-adapter.js';
import { buildOutcomeTraceEvent, type ChannelOutcome } from '../services/channel/outcome.js';
import { WS_MESSAGE_TIMEOUT_MS } from '../services/channel/constants.js';
import { buildProductionSessionLocator } from '../services/session/execution-scope.js';
import type { RuntimeSession } from '../services/execution/types.js';
import { handleDisconnect } from '../channels/pipeline/lifecycle-manager.js';
import { isSessionMetadataValidationError } from '../services/session-metadata.js';
import { executeVoiceTurn } from '../services/voice/voice-turn-coordinator.js';
import { resolveConversationBehaviorVoiceRuntimeConfig } from '../services/execution/conversation-behavior-resolver.js';

const router: RouterType = Router();
const log = createLogger('channel-vxml');
const adapter = new VxmlAdapter();
const VXML_DISCONNECT_MESSAGE = 'Goodbye.';
const MS_PER_SECOND = 1000;

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function resolveVxmlPublicBaseUrl(req: Request, channelConfig: VxmlChannelConfig): string | null {
  const channelBaseUrl = normalizeBaseUrl(channelConfig.publicBaseUrl);
  if (channelBaseUrl) return channelBaseUrl;

  const envBaseUrl = normalizeBaseUrl(
    process.env.RUNTIME_PUBLIC_BASE_URL || process.env.RUNTIME_BASE_URL,
  );
  if (envBaseUrl) return envBaseUrl;

  // For local development only, allow host-header derived URL.
  if (process.env.NODE_ENV !== 'production') {
    return `${req.protocol}://${req.get('host')}`;
  }

  return null;
}

function buildVxmlWebhookUrl(
  req: Request,
  channelConfig: VxmlChannelConfig,
  streamId: string,
  expectedToken: string | null,
): URL | null {
  const baseUrl = resolveVxmlPublicBaseUrl(req, channelConfig);
  if (!baseUrl) {
    return null;
  }

  const webhookUrl = new URL(
    `/api/v1/channels/vxml/hooks/${encodeURIComponent(streamId)}`,
    `${baseUrl}/`,
  );
  if (expectedToken) {
    webhookUrl.searchParams.set('token', expectedToken);
  }

  return webhookUrl;
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

function respondWithSessionMetadataValidationVxml(
  res: import('express').Response,
  error: unknown,
): boolean {
  if (!isSessionMetadataValidationError(error)) {
    return false;
  }

  const { statusCode } = errorToResponse(error);
  res.status(statusCode).type('text/xml').send(buildErrorVxml(error.message));
  return true;
}

// Parse URL-encoded bodies (VXML <submit> sends application/x-www-form-urlencoded)
router.use(express.urlencoded({ extended: true }));
// Also accept JSON for testing convenience
router.use(express.json());

// =============================================================================
// POST /hooks/:streamId — Main VXML webhook (synchronous)
// =============================================================================

router.post('/hooks/:streamId', async (req, res) => {
  const startTime = Date.now();
  const { streamId } = req.params;
  const body: VxmlWebhookRequest = req.body;

  log.info('VXML webhook received', {
    streamId,
    callId: body.callId,
    hasMessage: !!(body.message || body.userinput),
  });

  // 1. Validate required fields
  if (!body.callId) {
    log.warn('Missing callId in VXML request', { streamId });
    return res.status(400).type('text/xml').send(buildErrorVxml('Missing call identifier.'));
  }

  try {
    // 2. Resolve connection by streamId (externalIdentifier)
    const { resolveChannelConnection } = await import('../channels/connection-resolver.js');
    const connection = await resolveChannelConnection('voice_vxml', streamId);

    if (!connection) {
      log.warn('No VXML connection found', { streamId });
      return res.status(404).type('text/xml').send(buildErrorVxml('Channel not configured.'));
    }

    const config = (connection.config || {}) as VxmlChannelConfig;
    const expectedToken =
      config.inboundAuthToken?.trim() || process.env.VXML_SHARED_SECRET?.trim() || null;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
    // TODO(auth-consolidation): Remove query-token fallback after telephony
    // provisioning is updated to send ingress secrets via headers.
    const providedToken = extractIngressToken(req.headers, queryToken, {
      allowQueryTokenFor: 'vxml_http',
    });

    if (!expectedToken) {
      log.error('VXML ingress secret is not configured', { streamId });
      return res
        .status(503)
        .type('text/xml')
        .send(buildErrorVxml('Channel ingress is not configured.'));
    } else if (!tokensMatch(providedToken, expectedToken)) {
      log.warn('VXML ingress authentication failed', {
        streamId,
        hasToken: !!providedToken,
      });
      return res.status(401).type('text/xml').send(buildErrorVxml('Unauthorized request.'));
    }

    // 3. Handle telephony lifecycle/error callbacks before normal turn execution.
    let normalizedMsg: ReturnType<VxmlAdapter['buildNormalizedMessage']>;
    try {
      normalizedMsg = adapter.buildNormalizedMessage(body);
    } catch (error) {
      if (respondWithSessionMetadataValidationVxml(res, error)) {
        log.warn('Rejected VXML session metadata at ingress boundary', {
          streamId,
          callId: body.callId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      throw error;
    }
    if (adapter.isErrorEvent(body)) {
      log.info('VXML lifecycle event received', {
        streamId,
        callId: body.callId,
        event: body._event,
      });

      const { ChannelSession } = await import('@agent-platform/database/models');
      const channelSession = await ChannelSession.findOne({
        tenantId: connection.tenantId,
        channelConnectionId: connection.id,
        externalSessionKey: normalizedMsg.externalSessionKey,
        status: 'active',
      });

      if (channelSession?.sessionId) {
        const { getRuntimeExecutor } = await import('../services/runtime-executor.js');
        const runtimeSession = getRuntimeExecutor().getSession(channelSession.sessionId);
        await handleDisconnect({
          channel: 'voice',
          sessionId: channelSession.sessionId,
          dbSessionId: channelSession.sessionId,
          tenantId: connection.tenantId,
        });

        emitChannelResponseSent(channelSession.sessionId, 'vxml', Date.now() - startTime, {
          tenantId: connection.tenantId,
          projectId: connection.projectId,
          knownSource: runtimeSession?.knownSource,
        });
      }

      return res.type('text/xml').send(adapter.buildDisconnectVxml(VXML_DISCONNECT_MESSAGE));
    }

    // 4. Resolve/create session for a normal conversational turn.
    const { resolveSession } = await import('../channels/session-resolver.js');
    // TODO(channel-hardening): Acquire a first-turn external session key lock before
    // resolveSession() so concurrent initial VXML webhooks for the same call cannot race
    // channel-session creation before the per-session lock exists.
    const session = await resolveSession(connection, normalizedMsg);

    log.info('VXML session resolved', {
      sessionId: session.sessionId,
      isNew: session.isNew,
      callId: body.callId,
    });

    // 5. Acquire per-session lock (same pattern as inbound-worker)
    const lockKey = `channel:lock:${session.sessionId}`;
    const lockId = `vxml-${body.callId}-${Date.now()}`;
    const lockAcquired = await acquireSessionLock(lockKey, lockId);

    if (!lockAcquired) {
      log.error('Session lock timeout for VXML call', { callId: body.callId });
      return res
        .status(503)
        .type('text/xml')
        .send(buildErrorVxml('The system is busy. Please try again.'));
    }

    try {
      // 6. Execute message through runtime
      // New calls arrive without a message — send a greeting trigger so the
      // agent produces its welcome prompt. The LLM API rejects empty content.
      const userText = body.message || body.userinput || 'hi';
      const { getRuntimeExecutor } = await import('../services/runtime-executor.js');
      const executor = getRuntimeExecutor();
      const sessionLocator = buildProductionSessionLocator({
        tenantId: connection.tenantId,
        projectId: connection.projectId,
        sessionId: session.sessionId,
      });
      const coordinatorResult = await executeVoiceTurn({
        channelType: 'voice_vxml',
        executor,
        sessionId: session.sessionId,
        utterance: userText,
        timeoutMs: WS_MESSAGE_TIMEOUT_MS,
        promptProfile: 'pipeline',
        executeOptions: {
          ...(sessionLocator ? { sessionLocator } : {}),
          channelMetadata: { channel: 'vxml', contentLength: userText.length },
        },
      });
      const outcome = coordinatorResult.outcome;
      const runtimeSession = coordinatorResult.runtimeSession;
      recordOutcomeTrace({
        sessionId: session.sessionId,
        session: runtimeSession ?? undefined,
        outcome,
      });

      // 7. Build webhook URL for the next conversational turn
      const webhookUrl = buildVxmlWebhookUrl(req, config, streamId, expectedToken);
      if (!webhookUrl) {
        log.error('VXML public base URL missing in production', { streamId });
        return res
          .status(500)
          .type('text/xml')
          .send(buildErrorVxml('Voice channel is not fully configured.'));
      }

      // 8. Return VXML response
      const voiceText = getChannelAdapterRegistry().resolve(
        { text: outcome.responseText, voiceConfig: outcome.voiceConfig },
        { channelType: 'voice_vxml' },
      );
      const behaviorVoiceConfig = resolveConversationBehaviorVoiceRuntimeConfig(
        runtimeSession?._effectiveConfig?.conversationBehavior,
      );
      const responseConfig: VxmlChannelConfig = {
        ...config,
        ...(behaviorVoiceConfig.bargeIn !== undefined
          ? { bargeIn: behaviorVoiceConfig.bargeIn }
          : {}),
        ...(behaviorVoiceConfig.pauseTimeoutMs !== undefined
          ? { timeout: `${Math.ceil(behaviorVoiceConfig.pauseTimeoutMs / MS_PER_SECOND)}s` }
          : {}),
      };
      const vxml = adapter.buildVxmlResponse(
        voiceText,
        webhookUrl.toString(),
        body.callId,
        responseConfig,
      );

      log.info('VXML response sent', {
        callId: body.callId,
        sessionId: session.sessionId,
        responseLength: voiceText.length,
        outcomeStatus: outcome.status,
      });

      res.type('text/xml').send(vxml);
      emitChannelResponseSent(session.sessionId, 'vxml', Date.now() - startTime, {
        tenantId: connection.tenantId,
        projectId: connection.projectId,
        configHash: executor.getSession(session.sessionId)?.configHash,
        knownSource: executor.getSession(session.sessionId)?.knownSource,
      });
      return;
    } finally {
      await releaseSessionLock(lockKey, lockId);
    }
  } catch (error) {
    if (respondWithSessionMetadataValidationVxml(res, error)) {
      log.warn('Rejected VXML session metadata during webhook processing', {
        streamId,
        callId: body.callId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    log.error('VXML webhook processing failed', {
      streamId,
      callId: body.callId,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res
      .status(500)
      .type('text/xml')
      .send(buildErrorVxml('An error occurred. Please try again later.'));
  }
});

export default router;
