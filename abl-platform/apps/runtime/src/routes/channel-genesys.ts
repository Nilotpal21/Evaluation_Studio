/**
 * Genesys Bot Connector Channel Route — Synchronous Webhook
 *
 * POST /api/v1/channels/genesys/hooks/:streamId
 *
 * Like VXML, this is a synchronous channel — Genesys sends customer messages
 * via HTTP POST and expects the bot's response in the same HTTP response.
 *
 * Flow:
 *   Genesys POST → validate body
 *     → resolve connection (streamId = externalIdentifier)
 *     → verify bearer token against connection.credentials.client_secret
 *     → build normalized message
 *     → resolve/create session (genesysConversationId → sessionId)
 *     → acquire session lock
 *     → executeMessage(sessionId, text)
 *     → build Genesys Bot Connector JSON response
 *     → return Content-Type: application/json
 *     → release session lock
 */

import { Router, type Router as RouterType } from 'express';
import express from 'express';
import { createLogger } from '@abl/compiler/platform';
import { errorToResponse } from '@agent-platform/shared-kernel';
import { acquireSessionLock, releaseSessionLock } from '../services/queues/session-lock.js';
import { GenesysAdapter } from '../channels/adapters/genesys-adapter.js';
import type { GenesysWebhookRequest } from '../channels/adapters/genesys-adapter.js';
import { extractIngressToken, tokensMatch } from '@agent-platform/shared-kernel/security';
import {
  emitChannelResponseSent,
  recordSyntheticTraceEvent,
} from '../services/channel-trace-utils.js';
import {
  buildAuthRequiredOutcome,
  buildErrorOutcome,
  buildExecutionOutcome,
  buildOutcomeTraceEvent,
  runWithExecutionTimeout,
  type ChannelOutcome,
} from '../services/channel/outcome.js';
import { buildProductionSessionLocator } from '../services/session/execution-scope.js';
import { WS_MESSAGE_TIMEOUT_MS } from '../services/channel/constants.js';
import {
  createTokenLookups,
  evaluateAuthPreflightFromIR,
} from '../services/auth-profile/auth-preflight.js';
import type { RuntimeSession } from '../services/execution/types.js';
import { isSessionMetadataValidationError } from '../services/session-metadata.js';

const router: RouterType = Router();
const log = createLogger('channel-genesys');
const adapter = new GenesysAdapter();

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

router.use(express.json());

// =============================================================================
// POST /hooks/:streamId — Main Genesys webhook (synchronous)
// =============================================================================

router.post('/hooks/:streamId', async (req, res) => {
  const startTime = Date.now();
  const { streamId } = req.params;
  const body: GenesysWebhookRequest = req.body;

  log.info('Genesys webhook received', {
    streamId,
    genesysConversationId: body.genesysConversationId,
    inputMessageType: body.inputMessage?.type,
  });

  // 1. Validate required fields
  if (!body.genesysConversationId) {
    log.warn('Missing genesysConversationId in Genesys request', { streamId });
    return res.status(400).json({
      error: { code: 'MISSING_CONVERSATION_ID', message: 'Missing genesysConversationId.' },
    });
  }

  if (!body.inputMessage?.type) {
    log.warn('Missing inputMessage.type in Genesys request', { streamId });
    return res.status(400).json({
      error: { code: 'MISSING_INPUT_TYPE', message: 'Missing inputMessage.type.' },
    });
  }

  try {
    // 2. Resolve connection by streamId (externalIdentifier)
    const { resolveChannelConnection } = await import('../channels/connection-resolver.js');
    const connection = await resolveChannelConnection('genesys', streamId);

    if (!connection) {
      log.warn('No Genesys connection found', { streamId });
      return res.status(404).json({
        error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not configured.' },
      });
    }

    // 3. Verify bearer token
    const expectedToken = (connection.credentials?.client_secret as string)?.trim() || null;
    const providedToken = extractIngressToken(req.headers);

    if (!expectedToken) {
      log.error('Genesys ingress secret is not configured', { streamId });
      return res.status(503).json({
        error: { code: 'NOT_CONFIGURED', message: 'Channel ingress is not configured.' },
      });
    } else if (!tokensMatch(providedToken, expectedToken)) {
      log.warn('Genesys ingress authentication failed', {
        streamId,
        hasToken: !!providedToken,
      });
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized request.' },
      });
    }

    // 4. Build normalized message and resolve session
    let normalizedMsg: ReturnType<GenesysAdapter['buildNormalizedMessage']>;
    try {
      normalizedMsg = adapter.buildNormalizedMessage(body);
    } catch (error) {
      if (respondWithSessionMetadataValidationJson(res, error)) {
        log.warn('Rejected Genesys session metadata at ingress boundary', {
          streamId,
          genesysConversationId: body.genesysConversationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      throw error;
    }
    const { resolveSession } = await import('../channels/session-resolver.js');
    // TODO(channel-hardening): Acquire a first-turn external session key lock before
    // resolveSession() so concurrent initial Genesys callbacks for the same conversation
    // cannot race channel-session creation before the per-session lock exists.
    const session = await resolveSession(connection, normalizedMsg);

    log.info('Genesys session resolved', {
      sessionId: session.sessionId,
      isNew: session.isNew,
      genesysConversationId: body.genesysConversationId,
    });

    // 5. Acquire per-session lock (same pattern as VXML / inbound-worker)
    const lockKey = `channel:lock:${session.sessionId}`;
    const lockId = `genesys-${body.genesysConversationId}-${Date.now()}`;
    const lockAcquired = await acquireSessionLock(lockKey, lockId);

    if (!lockAcquired) {
      log.error('Session lock timeout for Genesys conversation', {
        genesysConversationId: body.genesysConversationId,
      });
      return res.status(503).json({
        error: { code: 'BUSY', message: 'The system is busy. Please try again.' },
      });
    }

    try {
      // 6. Execute message through runtime
      // Use the normalized text — for Structured messages (button clicks),
      // the adapter extracts the payload; body.inputMessage.text would be undefined.
      const userText = normalizedMsg.text || 'hi';
      const { getRuntimeExecutor } = await import('../services/runtime-executor.js');
      const executor = getRuntimeExecutor();
      const sessionLocator = buildProductionSessionLocator({
        tenantId: connection.tenantId,
        projectId: connection.projectId,
        sessionId: session.sessionId,
      });
      const runtimeSession =
        executor.getSession(session.sessionId) ??
        (await executor.rehydrateSession(
          session.sessionId,
          sessionLocator ? { locator: sessionLocator } : undefined,
        ));
      const environment =
        connection.environment || runtimeSession?.versionInfo?.environment || undefined;
      let outcome: ChannelOutcome | undefined;

      if (runtimeSession?.compilationOutput) {
        try {
          const preflight = await evaluateAuthPreflightFromIR(
            runtimeSession.compilationOutput,
            {
              userId: runtimeSession.userId,
              tenantId: connection.tenantId,
              projectId: connection.projectId,
              environment,
            },
            createTokenLookups(connection.tenantId, connection.projectId, environment),
            runtimeSession.agentName ? { agentNames: [runtimeSession.agentName] } : undefined,
          );

          if (preflight) {
            outcome = buildAuthRequiredOutcome({
              channelType: 'genesys',
              pending: preflight.pending,
              satisfied: preflight.satisfied,
              session: runtimeSession,
            });
            recordOutcomeTrace({
              sessionId: session.sessionId,
              session: runtimeSession ?? undefined,
              outcome,
            });
          }
        } catch (error) {
          outcome = buildErrorOutcome({
            channelType: 'genesys',
            error,
            session: runtimeSession,
          });
          recordOutcomeTrace({
            sessionId: session.sessionId,
            session: runtimeSession ?? undefined,
            outcome,
          });
        }
      }

      if (!outcome) {
        const chunks: string[] = [];
        const genesysChannelMetadata = {
          channel: 'genesys' as const,
          contentLength: userText.length,
        };
        const execOptions = {
          ...(normalizedMsg.actionEvent
            ? {
                actionEvent: normalizedMsg.actionEvent,
              }
            : {}),
          ...(normalizedMsg.interactionContext
            ? { interactionContext: normalizedMsg.interactionContext }
            : {}),
          channelMetadata: genesysChannelMetadata,
        };
        try {
          const execResult = await runWithExecutionTimeout(
            (signal) =>
              executor.executeMessage(
                session.sessionId,
                userText,
                (chunk: string) => {
                  chunks.push(chunk);
                },
                undefined,
                {
                  ...execOptions,
                  signal,
                },
              ),
            WS_MESSAGE_TIMEOUT_MS,
          );

          outcome = buildExecutionOutcome({
            channelType: 'genesys',
            result: execResult,
            streamedText: chunks.length > 0 ? chunks.join('') : undefined,
            session: executor.getSession(session.sessionId) ?? runtimeSession ?? undefined,
          });
          recordOutcomeTrace({
            sessionId: session.sessionId,
            session: executor.getSession(session.sessionId) ?? runtimeSession ?? undefined,
            outcome,
          });
        } catch (error) {
          outcome = buildErrorOutcome({
            channelType: 'genesys',
            error,
            session: runtimeSession ?? undefined,
          });
          recordOutcomeTrace({
            sessionId: session.sessionId,
            session: runtimeSession ?? undefined,
            outcome,
          });
        }
      }

      // 7. Build and return Genesys Bot Connector response
      const genesysResponse = adapter.buildGenesysResponse(outcome.responseText, outcome.actions);

      log.info('Genesys response sent', {
        genesysConversationId: body.genesysConversationId,
        sessionId: session.sessionId,
        responseLength: outcome.responseText.length,
        outcomeStatus: outcome.status,
      });

      res.json(genesysResponse);
      emitChannelResponseSent(session.sessionId, 'genesys', Date.now() - startTime, {
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
    if (respondWithSessionMetadataValidationJson(res, error)) {
      log.warn('Rejected Genesys session metadata during webhook processing', {
        streamId,
        genesysConversationId: body.genesysConversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    log.error('Genesys webhook processing failed', {
      streamId,
      genesysConversationId: body.genesysConversationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An error occurred. Please try again later.',
      },
    });
  }
});

export default router;
