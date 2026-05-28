/**
 * AI4W Channel Route Handler
 *
 * POST /api/v1/channels/ai4w/:connectionId/message    Inbound message (sync, SSE, async)
 * GET  /api/v1/channels/ai4w/:connectionId/info       Connection metadata + live deployment
 *
 * All endpoints use dual-layer auth (HMAC + JWT). The `/info` endpoint also
 * doubles as a "Test & Continue" health check — callers verify the auth
 * chain and get back the metadata needed to render a linked-app banner in
 * one round-trip.
 */

import crypto from 'node:crypto';
import { Router, type Router as RouterType } from 'express';
import express from 'express';
import { createLogger } from '@abl/compiler/platform';
import { errorToResponse } from '@agent-platform/shared-kernel';
import {
  checkAuthBlock,
  recordAuthFailure,
  verifyHmac,
  validateTimestamp,
  checkReplay,
  verifyAI4WJWT,
  enforceAccountIdBinding,
  timingSafeDummyHmac,
  AI4WAuthError,
  isInfraAuthError,
} from '../channels/adapters/ai4w-auth.js';
import { z } from 'zod';
import {
  AI4WMessageSchema,
  AI4WResponseModeSchema,
  buildAI4WSessionKey,
} from '../channels/adapters/ai4w-types.js';
import { AI4WAdapter } from '../channels/adapters/ai4w-adapter.js';
import { classifyStreamError } from '../channels/adapters/ai4w-error-classifier.js';
import { resolveConnectionByConnectionId } from '../channels/connection-resolver.js';
import {
  assertAllowedCallbackUrl,
  CallbackUrlError,
} from '../channels/security/callback-url-policy.js';
import { resolveAttachmentConfig } from '../attachments/attachment-config-resolver.js';
import { getHybridRateLimiter } from '../services/resilience/hybrid-rate-limiter.js';
import { getRedisClient, isRedisAvailable } from '../services/redis/redis-client.js';
import { acquireSessionLock, releaseSessionLock } from '../services/queues/session-lock.js';
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
import {
  buildResponseMessageMetadata,
  createResponseProvenanceAccumulator,
  type ResponseMessageMetadata,
} from '../services/channel/response-provenance.js';
import { buildProductionSessionLocator } from '../services/session/execution-scope.js';
import { WS_MESSAGE_TIMEOUT_MS } from '../services/channel/constants.js';
import {
  createTokenLookups,
  evaluateAuthPreflightFromIR,
} from '../services/auth-profile/auth-preflight.js';
import type { RuntimeSession } from '../services/execution/types.js';
import { isSessionMetadataValidationError } from '../services/session-metadata.js';

const log = createLogger('ai4w-channel');

const router: RouterType = Router();
const adapter = new AI4WAdapter();

function recordOutcomeTrace(params: {
  sessionId: string;
  session?: Pick<RuntimeSession, 'tracer'> | undefined;
  outcome: ChannelOutcome;
}): void {
  if (params.outcome.status === 'ok') return;
  recordSyntheticTraceEvent({
    sessionId: params.sessionId,
    session: params.session,
    event: buildOutcomeTraceEvent(params.outcome),
  });
}

function respondWithSessionMetadataValidationJson(res: express.Response, error: unknown): boolean {
  if (!isSessionMetadataValidationError(error)) return false;
  const { statusCode, body } = errorToResponse(error);
  res.status(statusCode).json(body);
  return true;
}

function resolveAi4wResponseMetadata(outcome: ChannelOutcome): ResponseMessageMetadata {
  return (
    outcome.responseMetadata ?? buildResponseMessageMetadata(createResponseProvenanceAccumulator())
  );
}

/** Validates connectionId format: ai4w_c_ prefix + 32 hex chars */
const ConnectionIdSchema = z.string().regex(/^ai4w_c_[0-9a-f]{32}$/);

/**
 * Sentinel key for per-IP (not per-connection) auth-failure counting. Used on
 * the "connection not found" and "malformed connectionId" paths so an attacker
 * walking the connectionId keyspace is rate-limited and blocked on
 * (sourceIp, UNKNOWN_CONNECTION_SENTINEL) — cannot bypass the block counter by
 * rotating through random connectionIds.
 */
const UNKNOWN_CONNECTION_SENTINEL = 'unknown';

/** Uniform 401 response — all auth failures return the same shape */
const UNIFORM_401 = {
  success: false,
  error: { code: 'UNAUTHORIZED', message: 'Authentication failed' },
} as const;

/** Max concurrent SSE connections per tenant (default 50) */
function getAI4WMaxSSEConnectionsPerTenant(): number {
  const parsed = parseInt(process.env.AI4W_MAX_SSE_CONNECTIONS_PER_TENANT || '50', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

/** SSE heartbeat interval in ms */
const SSE_HEARTBEAT_INTERVAL_MS = 15000;

/** TTL for SSE connection counter key in Redis (seconds) */
const SSE_COUNTER_TTL_S = 180;

/** Max requests per tenant per window (default 100) */
const AI4W_RATE_LIMIT_MAX_REQUESTS = parseInt(
  process.env.AI4W_RATE_LIMIT_MAX_REQUESTS || '100',
  10,
);

/** Rate limit window in ms (default 60s) */
const AI4W_RATE_LIMIT_WINDOW_MS = parseInt(process.env.AI4W_RATE_LIMIT_WINDOW_MS || '60000', 10);

/** Write an SSE event to the response */
function writeSSE(res: express.Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Raw body preservation for HMAC verification
router.use(
  express.json({
    limit: '1mb',
    verify: (req: express.Request, _res, buf) => {
      // Store raw body for HMAC signature verification
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

/**
 * GET /:connectionId/info
 *
 * Connection metadata for AI4W — also serves as the "Test & Continue" health
 * check. Uses the same HMAC + JWT + accountId-binding auth chain as `/message`
 * so callers that hold the connection credentials (not the internal service
 * token) can read their own connection's metadata directly.
 *
 * Side-effect profile:
 *   - full auth chain (HMAC, timestamp, replay, JWT, accountId binding)
 *   - no session resolution, no agent execution, no trace writes
 *   - no tenant-rate-limit consumption
 *   - auth-failure counter still increments on failure
 *
 * HMAC input:
 *   "inbound:" + nonce + "." + timestamp + "." + ""   (empty body on GET)
 *   where `nonce` is read from the X-Signature-Nonce header.
 *
 * Response body: tenant/project meta, pinning, live-resolved currentDeployment.
 * `connectionSecret` is never returned.
 */
router.get(
  '/:connectionId/info',
  async (req: express.Request, res: express.Response): Promise<void> => {
    const sourceIp = req.ip || 'unknown';

    const connIdResult = ConnectionIdSchema.safeParse(req.params.connectionId);
    if (!connIdResult.success) {
      timingSafeDummyHmac();
      await recordAuthFailure(sourceIp, UNKNOWN_CONNECTION_SENTINEL);
      res.status(401).json(UNIFORM_401);
      return;
    }
    const connectionId = connIdResult.data;

    try {
      // IP-wide block (unknown-connection probe throttle) + per-connection block.
      // Either being set shuts the requester out — protects against attackers
      // rotating random connectionIds to evade the per-(IP,conn) counter.
      if (
        (await checkAuthBlock(sourceIp, UNKNOWN_CONNECTION_SENTINEL)) ||
        (await checkAuthBlock(sourceIp, connectionId))
      ) {
        res.status(401).json(UNIFORM_401);
        return;
      }

      const connection = await resolveConnectionByConnectionId(connectionId, 'ai4w');
      if (!connection) {
        timingSafeDummyHmac();
        // Key on UNKNOWN so probing the connectionId keyspace trips the IP-wide
        // block; keying on the probed id would let an attacker rotate IDs forever.
        await recordAuthFailure(sourceIp, UNKNOWN_CONNECTION_SENTINEL);
        res.status(401).json(UNIFORM_401);
        return;
      }

      const connectionSecret = connection.credentials?.connectionSecret as string | undefined;
      if (!connectionSecret) {
        timingSafeDummyHmac();
        await recordAuthFailure(sourceIp, connectionId);
        res.status(401).json(UNIFORM_401);
        return;
      }

      // X-Signature-Nonce is the dedicated HMAC nonce header. We do NOT read
      // X-Request-Id here because intermediaries (ingress-nginx, service meshes,
      // APIMs) routinely overwrite that tracing-namespace header, which would
      // silently corrupt the HMAC payload.
      const nonce = req.headers['x-signature-nonce'] as string | undefined;
      const timestamp = req.headers['x-timestamp'] as string | undefined;
      const signature = req.headers['x-signature'] as string | undefined;

      if (!nonce || !timestamp || !signature) {
        await recordAuthFailure(sourceIp, connectionId);
        res.status(401).json(UNIFORM_401);
        return;
      }

      if (!validateTimestamp(timestamp)) {
        await recordAuthFailure(sourceIp, connectionId);
        res.status(401).json(UNIFORM_401);
        return;
      }

      // GET has no request body — sign over an empty buffer. express.json's
      // `verify` callback doesn't run for bodyless GETs so rawBody is undefined.
      const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
      const bodyBuffer = rawBody ?? Buffer.alloc(0);

      if (!verifyHmac(bodyBuffer, connectionSecret, nonce, timestamp, signature)) {
        await recordAuthFailure(sourceIp, connectionId);
        res.status(401).json(UNIFORM_401);
        return;
      }

      // Replay protection — distinct nonce namespace from /message.
      const infoNonceKey = `info:${nonce}`;
      if (!(await checkReplay(connectionId, infoNonceKey))) {
        res.status(409).json({
          success: false,
          error: { code: 'REPLAY_DETECTED', message: 'Duplicate request' },
        });
        return;
      }

      const authHeader = req.headers['authorization'] as string | undefined;
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
      if (!bearerToken) {
        await recordAuthFailure(sourceIp, connectionId);
        res.status(401).json(UNIFORM_401);
        return;
      }

      let claims;
      try {
        claims = await verifyAI4WJWT(bearerToken);
      } catch (err: unknown) {
        // Don't count upstream-OIDC outages as client auth failures —
        // legitimate clients must not be auth-blocked when work-dev is down.
        if (!isInfraAuthError(err)) {
          await recordAuthFailure(sourceIp, connectionId);
        }
        res.status(401).json(UNIFORM_401);
        return;
      }

      const currentAccountId = (connection.config?.ai4wAccountId as string) || null;
      const bindingResult = await enforceAccountIdBinding(
        connection.id,
        connection.tenantId,
        currentAccountId,
        claims.accountId,
      );
      if (bindingResult === 'mismatch') {
        await recordAuthFailure(sourceIp, connectionId);
        res.status(401).json(UNIFORM_401);
        return;
      }

      // Fetch tenant/project meta + connection displayName + live-resolve current deployment.
      //   deploymentId pinned → exactly that deployment (peer-channel semantics —
      //                         admin explicitly chose it, honored regardless of
      //                         current status; matches `DeploymentResolver.resolveByDeployment`)
      //   environment pinned  → latest status='active' deployment in that environment,
      //                         createdAt desc (matches `DeploymentResolver.resolveByEnvironment`)
      //   neither             → null (working-copy dev mode at runtime; info shows null)
      const { ChannelConnection, Tenant, Project, ProjectAgent, Deployment } =
        await import('@agent-platform/database/models');

      const [tenant, project, agentCount, connMeta, attachmentConfig] = await Promise.all([
        Tenant.findOne({ _id: connection.tenantId }).select('_id name').lean(),
        Project.findOne({ _id: connection.projectId, tenantId: connection.tenantId })
          .select('_id name description')
          .lean(),
        ProjectAgent.countDocuments({
          tenantId: connection.tenantId,
          projectId: connection.projectId,
        }),
        ChannelConnection.findOne({ connectionId, channelType: 'ai4w' })
          .select('displayName')
          .lean(),
        resolveAttachmentConfig(connection.tenantId, connection.projectId),
      ]);

      const pinnedDeploymentId = connection.deploymentId ?? null;
      const pinnedEnvironment = connection.environment ?? null;

      let currentDeploymentDoc: {
        _id: string;
        entryAgentName: string;
        label: string | null;
        createdAt: Date;
      } | null = null;

      if (pinnedDeploymentId) {
        currentDeploymentDoc = await Deployment.findOne({
          _id: pinnedDeploymentId,
          tenantId: connection.tenantId,
        })
          .select('_id entryAgentName label createdAt')
          .lean();
      } else if (pinnedEnvironment) {
        currentDeploymentDoc = await Deployment.findOne({
          tenantId: connection.tenantId,
          projectId: connection.projectId,
          environment: pinnedEnvironment,
          status: 'active',
        })
          .select('_id entryAgentName label createdAt')
          .sort({ createdAt: -1 })
          .lean();
      }

      res.json({
        success: true,
        data: {
          connectionId,
          channelType: 'ai4w' as const,
          status: connection.status,
          displayName: connMeta?.displayName ?? null,
          tenantId: connection.tenantId,
          tenantName: tenant?.name ?? null,
          projectId: connection.projectId,
          projectName: project?.name ?? null,
          projectDescription: project?.description ?? null,
          agentCount,
          config: {
            callbackBaseUrl: (connection.config?.callbackBaseUrl as string) ?? null,
            responseMode: (connection.config?.responseMode as string) ?? 'stream',
          },
          pinning: {
            deploymentId: pinnedDeploymentId,
            environment: pinnedEnvironment,
          },
          currentDeployment: currentDeploymentDoc
            ? {
                deploymentId: currentDeploymentDoc._id,
                entryAgentName: currentDeploymentDoc.entryAgentName,
                label: currentDeploymentDoc.label ?? null,
                createdAt: currentDeploymentDoc.createdAt.toISOString(),
              }
            : null,
          attachmentSettings: {
            enabled: attachmentConfig.enabled,
            allowedMimeTypes: attachmentConfig.allowedMimeTypes,
            maxFileSizeBytes: attachmentConfig.maxFileSizeBytes,
            maxFilesPerSession: attachmentConfig.maxFilesPerSession,
          },
        },
      });
    } catch (err) {
      log.error('AI4W info unexpected error', {
        connectionId,
        sourceIp,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(401).json(UNIFORM_401);
    }
  },
);

/**
 * POST /:connectionId/message
 *
 * Inbound message from AI4W platform.
 * Auth flow: block check -> HMAC -> timestamp -> replay -> JWT -> accountId binding
 */
router.post(
  '/:connectionId/message',
  async (req: express.Request, res: express.Response): Promise<void> => {
    const sourceIp = req.ip || 'unknown';

    // 0. Validate connectionId format (prevents Redis key injection)
    const connIdResult = ConnectionIdSchema.safeParse(req.params.connectionId);
    if (!connIdResult.success) {
      timingSafeDummyHmac();
      await recordAuthFailure(sourceIp, UNKNOWN_CONNECTION_SENTINEL);
      res.status(401).json(UNIFORM_401);
      return;
    }
    const connectionId = connIdResult.data;

    try {
      // 1. Check auth block (IP-wide probe throttle + per-connection throttle).
      // Either being set blocks the request; the IP-wide sentinel catches an
      // attacker rotating through random connectionIds.
      const ipBlocked = await checkAuthBlock(sourceIp, UNKNOWN_CONNECTION_SENTINEL);
      const connBlocked = await checkAuthBlock(sourceIp, connectionId);
      if (ipBlocked || connBlocked) {
        log.warn('Auth blocked for AI4W request', {
          connectionId,
          sourceIp,
          ipBlocked,
          connBlocked,
        });
        res.status(401).json(UNIFORM_401);
        return;
      }

      // 2. Lookup connection
      const connection = await resolveConnectionByConnectionId(connectionId, 'ai4w');
      if (!connection) {
        // Perform dummy HMAC to prevent timing side-channel
        timingSafeDummyHmac();
        // Key on UNKNOWN sentinel so probing the connectionId keyspace trips
        // the IP-wide block; keying on the probed id would let an attacker
        // rotate IDs indefinitely without ever exceeding the per-pair threshold.
        await recordAuthFailure(sourceIp, UNKNOWN_CONNECTION_SENTINEL);
        log.warn('AI4W connection not found', { connectionId, sourceIp });
        res.status(401).json(UNIFORM_401);
        return;
      }

      // 3. Extract and validate credentials
      const connectionSecret = connection.credentials?.connectionSecret as string | undefined;
      if (!connectionSecret) {
        timingSafeDummyHmac();
        await recordAuthFailure(sourceIp, connectionId);
        log.warn('AI4W connection missing connectionSecret', { connectionId });
        res.status(401).json(UNIFORM_401);
        return;
      }

      // 4. Extract and validate HMAC headers
      // X-Signature-Nonce (not X-Request-Id) — see /info handler comment for why.
      const nonce = req.headers['x-signature-nonce'] as string | undefined;
      const timestamp = req.headers['x-timestamp'] as string | undefined;
      const signature = req.headers['x-signature'] as string | undefined;

      if (!nonce || !timestamp || !signature) {
        log.warn('AI4W missing HMAC headers', {
          connectionId,
          sourceIp,
          hasNonce: !!nonce,
          hasTimestamp: !!timestamp,
          hasSignature: !!signature,
        });
        await recordAuthFailure(sourceIp, connectionId);
        res.status(401).json(UNIFORM_401);
        return;
      }

      // 5. Validate timestamp (cheap check before HMAC computation)
      if (!validateTimestamp(timestamp)) {
        log.warn('AI4W timestamp outside tolerance', { connectionId, sourceIp });
        await recordAuthFailure(sourceIp, connectionId);
        res.status(401).json(UNIFORM_401);
        return;
      }

      // 6. Verify HMAC signature
      const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
      const bodyBuffer = rawBody || Buffer.from(JSON.stringify(req.body));

      const hmacValid = verifyHmac(bodyBuffer, connectionSecret, nonce, timestamp, signature);
      if (!hmacValid) {
        log.warn('AI4W HMAC verification failed', { connectionId, sourceIp });
        await recordAuthFailure(sourceIp, connectionId);
        res.status(401).json(UNIFORM_401);
        return;
      }

      // 7. Check replay (after HMAC to avoid nonce pollution from unauthenticated requests)
      const isNew = await checkReplay(connectionId, nonce);
      if (!isNew) {
        log.warn('AI4W replay detected', { connectionId, sourceIp, nonce });
        res.status(409).json({
          success: false,
          error: { code: 'REPLAY_DETECTED', message: 'Duplicate request' },
        });
        return;
      }

      // 8. Verify JWT
      const authHeader = req.headers['authorization'] as string | undefined;
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

      if (!bearerToken) {
        log.warn('AI4W missing Bearer token', { connectionId, sourceIp });
        await recordAuthFailure(sourceIp, connectionId);
        res.status(401).json(UNIFORM_401);
        return;
      }

      let claims;
      try {
        claims = await verifyAI4WJWT(bearerToken);
      } catch (err: unknown) {
        if (err instanceof AI4WAuthError) {
          log.warn('AI4W JWT verification failed', {
            connectionId,
            sourceIp,
            code: err.code,
            detail: err.message,
          });
        } else {
          log.warn('AI4W JWT verification failed', {
            connectionId,
            sourceIp,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        // Don't count upstream-OIDC outages as client auth failures —
        // legitimate clients must not be auth-blocked when work-dev is down.
        if (!isInfraAuthError(err)) {
          await recordAuthFailure(sourceIp, connectionId);
        }
        res.status(401).json(UNIFORM_401);
        return;
      }

      // 9. Enforce accountId binding
      const currentAccountId = (connection.config?.ai4wAccountId as string) || null;
      const bindingResult = await enforceAccountIdBinding(
        connection.id,
        connection.tenantId,
        currentAccountId,
        claims.accountId,
      );
      if (bindingResult === 'mismatch') {
        log.warn('AI4W accountId mismatch', {
          connectionId,
          sourceIp,
          expected: currentAccountId,
          received: claims.accountId,
        });
        await recordAuthFailure(sourceIp, connectionId);
        res.status(401).json(UNIFORM_401);
        return;
      }

      // 10. Validate request body
      const parseResult = AI4WMessageSchema.safeParse(req.body);

      // Log incoming files for debugging
      if (req.body.files && Array.isArray(req.body.files)) {
        log.info('AI4W incoming request with files', {
          connectionId,
          fileCount: req.body.files.length,
          files: req.body.files.map((f: any) => ({
            name: f.name,
            mimeType: f.mimeType,
            urlLength: f.url?.length,
            urlPreview: f.url?.substring(0, 80) + '...',
          })),
        });
      }

      if (!parseResult.success) {
        log.warn('AI4W invalid message body', {
          connectionId,
          errors: parseResult.error.issues.map((i) => i.message),
        });
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid message format' },
        });
        return;
      }
      const body = parseResult.data;

      // 11. Rate limit (before file download to avoid resource consumption on throttled requests)
      const rateLimitResult = await getHybridRateLimiter().check(
        connection.tenantId,
        'request',
        AI4W_RATE_LIMIT_MAX_REQUESTS,
        AI4W_RATE_LIMIT_WINDOW_MS,
      );
      if (!rateLimitResult.allowed) {
        log.warn('AI4W rate limit exceeded', {
          connectionId,
          tenantId: connection.tenantId,
          remaining: rateLimitResult.remaining,
          resetMs: rateLimitResult.resetMs,
        });
        res.setHeader('Retry-After', String(Math.ceil(rateLimitResult.resetMs / 1000)));
        res.status(429).json({
          success: false,
          error: { code: 'RATE_LIMITED', message: 'Too many requests' },
        });
        return;
      }

      // 11.5. Resolve attachment config and download files (only when files are present)
      let attachmentConfig: Awaited<ReturnType<typeof resolveAttachmentConfig>> | undefined;
      let downloadedFiles: Array<{
        buffer: Buffer;
        contentType: string;
        filename: string;
      }> = [];
      if (body.files && body.files.length > 0) {
        attachmentConfig = await resolveAttachmentConfig(connection.tenantId, connection.projectId);

        if (!attachmentConfig.enabled) {
          log.warn('AI4W attachments disabled for tenant', {
            connectionId,
            tenantId: connection.tenantId,
          });
        } else {
          const filesToDownload = body.files.slice(0, attachmentConfig.maxFilesPerSession);
          if (body.files.length > attachmentConfig.maxFilesPerSession) {
            log.warn('AI4W file count exceeds maxFilesPerSession, truncating', {
              connectionId,
              requested: body.files.length,
              limit: attachmentConfig.maxFilesPerSession,
            });
          }
          downloadedFiles = await adapter.downloadIncomingFiles(filesToDownload, {
            maxFileSizeBytes: attachmentConfig.maxFileSizeBytes,
            allowedMimeTypes: attachmentConfig.allowedMimeTypes,
          });
          log.info('AI4W files downloaded', {
            connectionId,
            requested: filesToDownload.length,
            downloaded: downloadedFiles.length,
          });
        }
      }

      // 13. Build normalized message via adapter
      let normalizedMsg;
      try {
        normalizedMsg = adapter.buildNormalizedMessage(
          body,
          connectionId,
          claims.email,
          downloadedFiles.length > 0 ? downloadedFiles : undefined,
        );
      } catch (error) {
        if (respondWithSessionMetadataValidationJson(res, error)) {
          log.warn('Rejected AI4W session metadata at ingress boundary', {
            connectionId,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        throw error;
      }

      // 14. Determine response mode
      const requestedMode = req.headers['x-response-mode'];
      const requestedModeValue = Array.isArray(requestedMode) ? requestedMode[0] : requestedMode;
      const requestedModeParseResult = AI4WResponseModeSchema.safeParse(requestedModeValue);
      const configModeParseResult = AI4WResponseModeSchema.safeParse(
        connection.config?.responseMode,
      );
      const responseMode = requestedModeParseResult.success
        ? requestedModeParseResult.data
        : configModeParseResult.success
          ? configModeParseResult.data
          : 'stream';

      log.info('AI4W inbound message authenticated', {
        connectionId,
        tenantId: connection.tenantId,
        projectId: connection.projectId,
        userEmail: claims.email,
        agentContextId: body.agentContextId,
        sessionKey: normalizedMsg.externalSessionKey,
        responseMode,
      });

      // 15. Resolve session
      const { resolveSession } = await import('../channels/session-resolver.js');
      const session = await resolveSession(connection, normalizedMsg);

      log.info('AI4W session resolved', {
        sessionId: session.sessionId,
        isNew: session.isNew,
        connectionId,
        agentContextId: body.agentContextId,
      });

      // 16. Upload downloaded files to attachment service
      let uploadedAttachmentIds: string[] = [];
      if (downloadedFiles.length > 0 && attachmentConfig) {
        try {
          const { buildMultimodalUploadConfig } =
            await import('../attachments/multimodal-upload-config.js');
          const uploadConfig = buildMultimodalUploadConfig(attachmentConfig);

          const uploadedAttachments = await adapter.uploadDownloadedFilesToAttachmentService(
            downloadedFiles,
            {
              tenantId: connection.tenantId,
              projectId: connection.projectId,
              sessionId: session.sessionId,
              messageId: body.metadata?.messageId as string | undefined,
            },
            uploadConfig,
          );

          if (uploadedAttachments.length > 0) {
            uploadedAttachmentIds = uploadedAttachments.map((a) => a.attachmentId);
            normalizedMsg.metadata = normalizedMsg.metadata || {};
            normalizedMsg.metadata.attachments = uploadedAttachments;
            log.info('AI4W files uploaded to attachment service', {
              connectionId,
              sessionId: session.sessionId,
              count: uploadedAttachments.length,
              attachmentIds: uploadedAttachmentIds,
            });
          }
        } catch (uploadError) {
          log.error('AI4W attachment upload failed', {
            connectionId,
            sessionId: session.sessionId,
            error: uploadError instanceof Error ? uploadError.message : String(uploadError),
          });
        }
      }

      // 17. Acquire per-session lock
      const lockKey = `channel:lock:${session.sessionId}`;
      const lockId = `ai4w-${connectionId}-${Date.now()}`;
      const lockAcquired = await acquireSessionLock(lockKey, lockId);

      if (!lockAcquired) {
        log.error('Session lock timeout for AI4W conversation', { connectionId });
        res.status(503).json({
          success: false,
          error: { code: 'BUSY', message: 'The system is busy. Please try again.' },
        });
        return;
      }

      try {
        // 18. Prepare execution
        const startTime = Date.now();
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

        // 19. Auth preflight check
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
                channelType: 'ai4w',
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
              channelType: 'ai4w',
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

        // 20. Branch by response mode
        switch (responseMode) {
          case 'stream': {
            // Track concurrent SSE connections per tenant
            const sseCounterKey = `ai4w:sse:count:${connection.tenantId}`;
            let sseCountIncremented = false;

            if (isRedisAvailable()) {
              const redis = getRedisClient();
              if (redis) {
                const currentCount = await redis.incr(sseCounterKey);
                sseCountIncremented = true;
                await redis.expire(sseCounterKey, SSE_COUNTER_TTL_S);
                const sseLimit = getAI4WMaxSSEConnectionsPerTenant();

                if (currentCount > sseLimit) {
                  await redis.decr(sseCounterKey);
                  sseCountIncremented = false;
                  log.warn('AI4W SSE connection limit exceeded', {
                    connectionId,
                    tenantId: connection.tenantId,
                    currentCount,
                    limit: sseLimit,
                  });
                  res.status(503).json({
                    success: false,
                    error: {
                      code: 'SERVICE_UNAVAILABLE',
                      message: 'Too many concurrent streaming connections',
                    },
                  });
                  return;
                }
              }
            }

            // Set SSE headers
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('X-Response-Mode-Used', 'stream');

            // Heartbeat to keep connection alive
            const heartbeat = setInterval(() => {
              res.write(': heartbeat\n\n');
            }, SSE_HEARTBEAT_INTERVAL_MS);

            // Clean up on client disconnect
            res.on('close', () => {
              clearInterval(heartbeat);
              if (sseCountIncremented && isRedisAvailable()) {
                const redis = getRedisClient();
                if (redis) {
                  redis.decr(sseCounterKey).catch((decErr: unknown) => {
                    log.warn('Failed to decrement SSE counter', {
                      tenantId: connection.tenantId,
                      error: decErr instanceof Error ? decErr.message : String(decErr),
                    });
                  });
                }
              }
            });

            try {
              // If auth preflight already produced an outcome, send it as SSE
              if (outcome) {
                const responseMetadata = resolveAi4wResponseMetadata(outcome);
                writeSSE(res, 'chunk', {
                  text: outcome.responseText,
                  sessionId: session.sessionId,
                });
                writeSSE(res, 'done', {
                  sessionId: session.sessionId,
                  outcomeStatus: outcome.status,
                  responseMetadata,
                });
              } else {
                // Stream execution — send chunks as SSE events
                const execOptions = {
                  ...(normalizedMsg.interactionContext
                    ? { interactionContext: normalizedMsg.interactionContext }
                    : {}),
                  ...(uploadedAttachmentIds.length > 0
                    ? { attachmentIds: uploadedAttachmentIds }
                    : {}),
                  channelMetadata: {
                    channel: 'ai4w' as const,
                    contentLength: userText.length,
                    ...(uploadedAttachmentIds.length > 0
                      ? { hasAttachments: true, attachmentCount: uploadedAttachmentIds.length }
                      : {}),
                  },
                };

                const execResult = await runWithExecutionTimeout(
                  (signal) =>
                    executor.executeMessage(
                      session.sessionId,
                      userText,
                      (chunk: string) => {
                        writeSSE(res, 'chunk', { text: chunk, sessionId: session.sessionId });
                      },
                      undefined,
                      { ...execOptions, signal },
                    ),
                  WS_MESSAGE_TIMEOUT_MS,
                );

                outcome = buildExecutionOutcome({
                  channelType: 'ai4w',
                  result: execResult,
                  session: executor.getSession(session.sessionId) ?? runtimeSession ?? undefined,
                });
                recordOutcomeTrace({
                  sessionId: session.sessionId,
                  session: executor.getSession(session.sessionId) ?? runtimeSession ?? undefined,
                  outcome,
                });

                // Send rich content / actions as a final SSE event if present
                if (outcome.actions || outcome.richContent) {
                  const richOutput = adapter.transformOutput(
                    '',
                    outcome.actions,
                    outcome.richContent,
                  );
                  const richText = 'text' in richOutput ? richOutput.text : '';
                  if (richText) {
                    writeSSE(res, 'chunk', {
                      text: richText,
                      sessionId: session.sessionId,
                    });
                  }
                }

                const donePayload: Record<string, unknown> = {
                  sessionId: session.sessionId,
                  outcomeStatus: outcome.status,
                  responseMetadata: resolveAi4wResponseMetadata(outcome),
                };
                if (outcome.status !== 'ok') {
                  const classified = classifyStreamError(undefined, outcome);
                  donePayload.errorCode = classified.errorCode;
                  donePayload.errorMessage = classified.message;
                  donePayload.retryable = classified.retryable;
                }
                writeSSE(res, 'done', donePayload);
              }
            } catch (streamErr: unknown) {
              log.error('AI4W SSE stream error', {
                connectionId,
                error: streamErr instanceof Error ? streamErr.message : String(streamErr),
              });
              if (!outcome) {
                outcome = buildErrorOutcome({
                  channelType: 'ai4w',
                  error: streamErr,
                  session: runtimeSession ?? undefined,
                });
                recordOutcomeTrace({
                  sessionId: session.sessionId,
                  session: runtimeSession ?? undefined,
                  outcome,
                });
              }
              const classified = classifyStreamError(streamErr, outcome);
              writeSSE(res, 'error', {
                errorCode: classified.errorCode,
                message: classified.message,
                retryable: classified.retryable,
              });
            } finally {
              clearInterval(heartbeat);
              res.end();
              emitChannelResponseSent(session.sessionId, 'ai4w', Date.now() - startTime, {
                tenantId: connection.tenantId,
                projectId: connection.projectId,
                configHash: executor.getSession(session.sessionId)?.configHash,
                knownSource: executor.getSession(session.sessionId)?.knownSource,
              });
            }
            break;
          }

          case 'async': {
            const asyncRequestId = crypto.randomUUID();

            res.setHeader('X-Response-Mode-Used', 'async');
            res.status(202).json({
              success: true,
              data: { requestId: asyncRequestId, sessionId: session.sessionId },
            });

            // Execute in background after sending 202
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            (async () => {
              const asyncStartTime = Date.now();
              try {
                if (!outcome) {
                  const chunks: string[] = [];
                  const execOptions = {
                    ...(normalizedMsg.interactionContext
                      ? { interactionContext: normalizedMsg.interactionContext }
                      : {}),
                    ...(uploadedAttachmentIds.length > 0
                      ? { attachmentIds: uploadedAttachmentIds }
                      : {}),
                    channelMetadata: {
                      channel: 'ai4w' as const,
                      contentLength: userText.length,
                      ...(uploadedAttachmentIds.length > 0
                        ? { hasAttachments: true, attachmentCount: uploadedAttachmentIds.length }
                        : {}),
                    },
                  };

                  const execResult = await runWithExecutionTimeout(
                    (signal) =>
                      executor.executeMessage(
                        session.sessionId,
                        userText,
                        (chunk: string) => {
                          chunks.push(chunk);
                        },
                        undefined,
                        { ...execOptions, signal },
                      ),
                    WS_MESSAGE_TIMEOUT_MS,
                  );

                  outcome = buildExecutionOutcome({
                    channelType: 'ai4w',
                    result: execResult,
                    streamedText: chunks.length > 0 ? chunks.join('') : undefined,
                    session: executor.getSession(session.sessionId) ?? runtimeSession ?? undefined,
                  });
                  recordOutcomeTrace({
                    sessionId: session.sessionId,
                    session: executor.getSession(session.sessionId) ?? runtimeSession ?? undefined,
                    outcome,
                  });
                }

                // Transform through content transformer for rich content + actions
                const asyncOutput = adapter.transformOutput(
                  outcome.responseText,
                  outcome.actions,
                  outcome.richContent,
                );
                const asyncText = 'text' in asyncOutput ? asyncOutput.text : outcome.responseText;
                const responseMetadata = resolveAi4wResponseMetadata(outcome);

                // Deliver result via HMAC-signed callback
                const sendResult = await adapter.sendResponse(
                  {
                    sessionId: session.sessionId,
                    text: asyncText,
                    eventType: 'agent.response',
                    responseMetadata,
                    metadata: {
                      requestId: asyncRequestId,
                      connectionId,
                      outcomeStatus: outcome.status,
                      responseMode: 'async',
                    },
                  },
                  connection,
                );

                if (sendResult.success && sendResult.metadata?.callbackUrl) {
                  const callbackUrl = sendResult.metadata.callbackUrl as string;
                  const callbackBody = sendResult.metadata.body as string;
                  const signatureHeaders = sendResult.metadata.signatureHeaders as Record<
                    string,
                    string
                  >;

                  // Re-validate the callback URL at delivery time — the URL
                  // was checked at provision, but config edits or DNS rebinding
                  // could have changed the effective destination since then.
                  try {
                    const isProduction = process.env.NODE_ENV === 'production';
                    await assertAllowedCallbackUrl(callbackUrl, isProduction);
                  } catch (ssrfErr) {
                    if (ssrfErr instanceof CallbackUrlError) {
                      log.warn('AI4W async callback blocked by SSRF policy', {
                        connectionId,
                        asyncRequestId,
                        reason: ssrfErr.message,
                      });
                    } else {
                      log.error('AI4W async callback SSRF check raised unexpected error', {
                        connectionId,
                        asyncRequestId,
                        error: ssrfErr instanceof Error ? ssrfErr.message : String(ssrfErr),
                      });
                    }
                    return;
                  }

                  const callbackRes = await fetch(callbackUrl, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      ...signatureHeaders,
                    },
                    body: callbackBody,
                    signal: AbortSignal.timeout(30_000),
                  });

                  if (!callbackRes.ok) {
                    log.warn('AI4W async callback delivery failed', {
                      connectionId,
                      statusCode: callbackRes.status,
                      asyncRequestId,
                    });
                  } else {
                    log.info('AI4W async callback delivered', {
                      connectionId,
                      asyncRequestId,
                    });
                  }
                }

                emitChannelResponseSent(session.sessionId, 'ai4w', Date.now() - asyncStartTime, {
                  tenantId: connection.tenantId,
                  projectId: connection.projectId,
                  configHash: executor.getSession(session.sessionId)?.configHash,
                  knownSource: executor.getSession(session.sessionId)?.knownSource,
                });
              } catch (asyncErr: unknown) {
                log.error('AI4W async execution failed', {
                  connectionId,
                  asyncRequestId,
                  error: asyncErr instanceof Error ? asyncErr.message : String(asyncErr),
                });
              } finally {
                await releaseSessionLock(lockKey, lockId);
              }
            })().catch((asyncErr) => {
              // Guard against unhandled rejections from the detached IIFE —
              // anything that escapes the try/catch above (for example, a
              // rejection before the first `try` runs) ends up here.
              log.error('AI4W async delivery IIFE crashed', {
                connectionId,
                asyncRequestId,
                error: asyncErr instanceof Error ? asyncErr.message : String(asyncErr),
              });
            });
            // For async: lock is released in the background task, skip the
            // outer finally's releaseSessionLock by returning early.
            return;
          }

          default: {
            // Sync path — collect all chunks, return complete response
            if (!outcome) {
              const chunks: string[] = [];
              const execOptions = {
                ...(normalizedMsg.interactionContext
                  ? { interactionContext: normalizedMsg.interactionContext }
                  : {}),
                ...(uploadedAttachmentIds.length > 0
                  ? { attachmentIds: uploadedAttachmentIds }
                  : {}),
                channelMetadata: {
                  channel: 'ai4w' as const,
                  contentLength: userText.length,
                  ...(uploadedAttachmentIds.length > 0
                    ? { hasAttachments: true, attachmentCount: uploadedAttachmentIds.length }
                    : {}),
                },
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
                      { ...execOptions, signal },
                    ),
                  WS_MESSAGE_TIMEOUT_MS,
                );

                outcome = buildExecutionOutcome({
                  channelType: 'ai4w',
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
                  channelType: 'ai4w',
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

            // Transform through content transformer for rich content + actions
            const syncOutput = adapter.transformOutput(
              outcome.responseText,
              outcome.actions,
              outcome.richContent,
            );
            const syncText = 'text' in syncOutput ? syncOutput.text : outcome.responseText;
            const downloadedFileSummaries = Array.isArray(normalizedMsg.metadata?.downloadedFiles)
              ? normalizedMsg.metadata.downloadedFiles
              : undefined;
            const responseMetadata = resolveAi4wResponseMetadata(outcome);

            res.setHeader('X-Response-Mode-Used', 'sync');
            const syncErrorInfo =
              outcome.status !== 'ok' ? classifyStreamError(undefined, outcome) : undefined;
            res.json({
              success: true,
              data: {
                response: syncText,
                sessionId: session.sessionId,
                outcomeStatus: outcome.status,
                responseMetadata,
                ...(syncErrorInfo
                  ? {
                      errorCode: syncErrorInfo.errorCode,
                      errorMessage: syncErrorInfo.message,
                      retryable: syncErrorInfo.retryable,
                    }
                  : {}),
                ...(downloadedFileSummaries ? { files: downloadedFileSummaries } : {}),
              },
            });
            emitChannelResponseSent(session.sessionId, 'ai4w', Date.now() - startTime, {
              tenantId: connection.tenantId,
              projectId: connection.projectId,
              configHash: executor.getSession(session.sessionId)?.configHash,
              knownSource: executor.getSession(session.sessionId)?.knownSource,
            });
            break;
          }
        }
      } finally {
        await releaseSessionLock(lockKey, lockId);
      }
    } catch (err: unknown) {
      if (respondWithSessionMetadataValidationJson(res, err)) {
        log.warn('Rejected AI4W session metadata during message processing', {
          connectionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      log.error('AI4W channel handler error', {
        connectionId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        const classified = classifyStreamError(err);
        res.status(500).json({
          success: false,
          error: {
            code: classified.errorCode,
            message: classified.message,
            retryable: classified.retryable,
          },
        });
      }
    }
  },
);

export default router;
