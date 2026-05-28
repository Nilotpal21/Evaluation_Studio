/**
 * LiveKit Routes
 *
 * Token generation and capabilities for LiveKit-based voice preview.
 *
 * Security:
 * - authMiddleware required on all routes (JWT / SDK token / API key)
 * - tenantRateLimit on token generation (prevents room flooding)
 * - Tenant-scoped room names (prevents cross-tenant collision)
 * - Input validation on all request body fields
 * - Scoped LiveKit permissions (minimal grants for participants)
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { createLogger } from '@abl/compiler/platform';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { getConfig } from '../config/index.js';
import crypto from 'crypto';
import { buildCallerContext } from '../services/identity/artifact-hasher.js';
import { buildStoredSessionCallerContext } from '../services/identity/stored-session-caller-context.js';
import {
  activeRoomCount,
  spawnAgentForRoom,
  isLiveKitWorkerRunning,
} from '../services/voice/livekit/worker-entry.js';
import { isValidId, isValidAgentName } from '../services/voice/livekit/validation.js';
import type { VoiceServiceFactory } from '../services/voice/voice-service-factory.js';
import { z } from 'zod';
import { resolveProjectSessionAccess } from '../middleware/session-access.js';
import { resolveRequiredContactProductionScope } from '../services/session/production-contact-scope.js';
import { ScopeValidationError } from '../services/session/scope-policy.js';
import {
  toAuthContext,
  type CallerContext,
  type TenantContextData,
} from '@agent-platform/shared-auth';
import { sessionMetadataSchema } from '../services/session-metadata.js';

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/v1/livekit',
  tags: ['LiveKit'],
});
const router: RouterType = openapi.router;
const log = createLogger('livekit-routes');

interface LiveKitStoredSessionIdentitySource {
  tenantId?: unknown;
  channel?: unknown;
  customerId?: unknown;
  anonymousId?: unknown;
  contactId?: unknown;
  channelArtifact?: unknown;
  channelId?: unknown;
  identityTier?: unknown;
  verificationMethod?: unknown;
}

export function buildLiveKitCallerContext(params: {
  tenantId: string;
  sessionId: string;
  tenantContext: TenantContextData | undefined;
  session?: LiveKitStoredSessionIdentitySource;
}): CallerContext {
  const storedCallerContext = params.session
    ? buildStoredSessionCallerContext(params.session, params.tenantId)
    : undefined;

  if (storedCallerContext) {
    return {
      ...storedCallerContext,
      channel: 'voice_livekit',
    };
  }

  if (params.tenantContext?.authType !== 'sdk_session') {
    return buildCallerContext({
      tenantId: params.tenantId,
      channel: 'voice_livekit',
      anonymousId: `livekit:${params.sessionId}`,
      initiatedById: params.tenantContext?.userId,
      identityTier: 0,
      verificationMethod: 'none',
    });
  }

  const authContext = toAuthContext(params.tenantContext);
  if (authContext.authType !== 'sdk_session') {
    return buildCallerContext({
      tenantId: params.tenantId,
      channel: 'voice_livekit',
      anonymousId: `livekit:${params.sessionId}`,
      initiatedById: params.tenantContext.userId,
      identityTier: 0,
      verificationMethod: 'none',
    });
  }

  const callerIdentity = authContext.callerIdentity;
  const callerContext = buildCallerContext({
    tenantId: params.tenantId,
    channel: 'voice_livekit',
    channelId: authContext.channelId,
    customerId: callerIdentity.customerId,
    anonymousId:
      callerIdentity.sessionPrincipalId ||
      callerIdentity.anonymousId ||
      `livekit:${params.sessionId}`,
    contactId: callerIdentity.contactId,
    initiatedById: params.tenantContext.userId,
    identityTier: callerIdentity.identityTier,
    verificationMethod: callerIdentity.verificationMethod,
  });

  return {
    ...callerContext,
    ...(callerIdentity.channelArtifact ? { channelArtifact: callerIdentity.channelArtifact } : {}),
    ...(callerIdentity.sessionPrincipalId
      ? { sessionPrincipalId: callerIdentity.sessionPrincipalId }
      : {}),
    ...(callerIdentity.authScope ? { authScope: callerIdentity.authScope } : {}),
  };
}

// Auth + rate limiting on all LiveKit endpoints
router.use(authMiddleware);
router.use(tenantRateLimit('request'));

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const LiveKitCapabilitiesResponse = z.object({
  enabled: z.boolean().describe('Whether LiveKit is enabled'),
  configured: z.boolean().describe('Whether LiveKit is fully configured'),
});

const LiveKitTokenRequest = z.object({
  sessionId: z.string().describe('Session ID (alphanumeric, max 128 chars)'),
  projectId: z.string().describe('Project ID (alphanumeric, max 128 chars)'),
  agentName: z.string().optional().describe('Agent name (optional, alphanumeric, max 64 chars)'),
  deploymentId: z
    .string()
    .optional()
    .describe('Deployment ID (optional, alphanumeric, max 128 chars)'),
  sessionMetadata: sessionMetadataSchema.describe(
    'Optional session-level metadata stored under session.data.values._metadata',
  ),
});

const LiveKitTokenResponse = z.object({
  token: z.string().describe('LiveKit access token'),
  roomName: z.string().describe('Tenant-scoped room name'),
  url: z.string().describe('LiveKit server URL'),
  identity: z.string().describe('User identity for the token'),
});

const LiveKitErrorResponse = z.object({
  error: z.string().describe('Error message'),
});

const LiveKitScopeErrorResponse = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.enum(['INVALID_SESSION_SCOPE', 'UNSUPPORTED_SCOPE_KIND']),
    message: z.string(),
  }),
});

// =============================================================================
// LAZY SDK IMPORT
// =============================================================================

async function getLivekitSDK(): Promise<any> {
  try {
    return await (import('livekit-server-sdk' as string) as Promise<any>);
  } catch {
    return null;
  }
}

function sendLiveKitScopeValidationError(res: Response, err: ScopeValidationError): void {
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

// =============================================================================
// ROUTES
// =============================================================================

/**
 * GET /api/v1/livekit/capabilities
 * Check whether LiveKit is configured and available.
 * Does NOT expose the LiveKit server URL (infrastructure detail).
 */
openapi.route(
  'get',
  '/capabilities',
  {
    summary: 'Get LiveKit capabilities',
    description: 'Check whether LiveKit is configured and available for the current environment',
    response: LiveKitCapabilitiesResponse,
  },
  async (req: Request, res: Response) => {
    const config = getConfig();
    const lk = config.voice.livekit;
    const enabled = config.features.livekitEnabled;
    const configured = enabled && !!lk.url && !!lk.apiKey && !!lk.apiSecret;

    log.debug('LiveKit capabilities check', {
      requestId: (req as any).id,
      tenantId: req.tenantContext?.tenantId,
      configured,
    });

    res.json({
      enabled,
      configured,
      // Do NOT expose lk.url — infrastructure topology detail (S7)
    });
  },
);

/**
 * POST /api/v1/livekit/token
 * Generate a LiveKit access token so the browser can join a room.
 *
 * Body: { sessionId, projectId, agentName?, deploymentId? }
 * Returns: { token, roomName, url, identity }
 */
openapi.route(
  'post',
  '/token',
  {
    summary: 'Generate LiveKit token',
    description:
      'Generate a LiveKit access token for joining a voice room. Requires valid sessionId and projectId.',
    body: LiveKitTokenRequest,
    response: z.union([LiveKitTokenResponse, LiveKitErrorResponse, LiveKitScopeErrorResponse]),
  },
  async (req: Request, res: Response) => {
    const config = getConfig();
    const lk = config.voice.livekit;

    if (!config.features.livekitEnabled || !lk.url || !lk.apiKey || !lk.apiSecret) {
      res.status(503).json({ error: 'LiveKit not configured' });
      return;
    }

    // --- Input validation (S5) ---
    const { sessionId, projectId, agentName, deploymentId, sessionMetadata } = req.body;

    if (!isValidId(sessionId)) {
      res.status(400).json({ error: 'Missing or invalid sessionId (alphanumeric, max 128 chars)' });
      return;
    }

    if (!isValidId(projectId)) {
      res.status(400).json({ error: 'Missing or invalid projectId (alphanumeric, max 128 chars)' });
      return;
    }

    if (agentName !== undefined && !isValidAgentName(agentName)) {
      res.status(400).json({ error: 'Invalid agentName (alphanumeric, max 64 chars)' });
      return;
    }

    if (deploymentId !== undefined && !isValidId(deploymentId)) {
      res.status(400).json({ error: 'Invalid deploymentId (alphanumeric, max 128 chars)' });
      return;
    }

    // --- Concurrency limit (P1, E7) ---
    const maxRooms = lk.maxConcurrentRooms;
    if (activeRoomCount() >= maxRooms) {
      log.warn('LiveKit room limit reached', {
        requestId: (req as any).id,
        activeRooms: activeRoomCount(),
        maxRooms,
      });
      res.status(429).json({ error: 'Maximum concurrent voice sessions reached' });
      return;
    }

    const sdk = await getLivekitSDK();
    if (!sdk) {
      res.status(503).json({ error: 'livekit-server-sdk not installed' });
      return;
    }

    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      res.status(403).json({ error: 'Tenant context required for voice sessions' });
      return;
    }
    const userId = req.tenantContext?.userId;
    const requiredPermission =
      req.tenantContext?.authType === 'sdk_session' ? 'session:voice' : 'session:execute';
    const sessionAccess = await resolveProjectSessionAccess(req, {
      sessionId,
      projectId,
      requiredPermission,
      resourceType: 'voice_session',
    });
    if ('denial' in sessionAccess) {
      const body: Record<string, unknown> = {
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: sessionAccess.denial.publicError,
        },
      };
      if (sessionAccess.denial.publicMessage) {
        body.message = sessionAccess.denial.publicMessage;
      }
      res.status(sessionAccess.denial.statusCode).json(body);
      return;
    }

    const callerContext = buildLiveKitCallerContext({
      tenantId,
      sessionId,
      tenantContext: req.tenantContext,
      session: sessionAccess.session,
    });
    let scopedCallerContext = callerContext;

    // --- Pre-flight: verify voice credentials exist for this tenant ---
    const voiceFactory = req.app.locals.voiceServiceFactory as VoiceServiceFactory | undefined;
    if (voiceFactory) {
      try {
        const creds = await voiceFactory.resolveVoiceCredentials(tenantId);
        if (!creds.stt || !creds.tts) {
          res.status(422).json({
            error: 'Voice credentials not configured',
            details: {
              stt: !creds.stt ? 'Deepgram STT credentials missing' : 'ok',
              tts: !creds.tts ? 'ElevenLabs TTS credentials missing' : 'ok',
            },
            hint: 'Configure voice service credentials in Workspace Settings > Voice Services',
          });
          return;
        }
      } catch (err) {
        log.warn('Pre-flight credential check failed', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Non-fatal: proceed with token generation; agent-worker will fail with clear error
      }
    }

    try {
      const scopeInput = await resolveRequiredContactProductionScope({
        tenantId,
        projectId,
        sessionId,
        channelId: callerContext.channelId ?? 'voice_livekit',
        environment: deploymentId ? 'unknown' : 'dev',
        source: 'livekit_voice',
        authType: 'livekit_room',
        callerContext,
        channelType: callerContext.channel,
        fallbackAnonymousId: `livekit:${sessionId}`,
      });
      scopedCallerContext = scopeInput.callerContext;
    } catch (err) {
      if (err instanceof ScopeValidationError) {
        sendLiveKitScopeValidationError(res, err);
        return;
      }
      throw err;
    }

    try {
      // Tenant-scoped room name (E5: prevents cross-tenant collision)
      const roomName = `voice_${tenantId}_${projectId}_${sessionId}`;
      const identity = `user_${crypto.randomUUID().slice(0, 8)}`;

      // Configurable TTL (E6)
      const ttlSeconds = lk.tokenTtlSeconds;

      const at = new sdk.AccessToken(lk.apiKey, lk.apiSecret, {
        identity,
        ttl: `${ttlSeconds}s`,
        metadata: JSON.stringify({
          sessionId,
          projectId,
          agentName: agentName || 'default',
          tenantId,
          deploymentId: deploymentId || undefined,
          sessionMetadata,
        }),
      });

      // Scoped permissions — users only need audio pub/sub (E8)
      at.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: false, // Users don't need data channel publish
      });

      const token = await at.toJwt();

      // Audit log (A3)
      log.info('LiveKit token generated', {
        requestId: (req as any).id,
        tenantId,
        userId,
        sessionId,
        projectId,
        roomName,
        identity,
        ttlSeconds,
      });

      res.json({
        token,
        roomName,
        url: lk.url,
        identity,
      });

      // Spawn agent in background (fire-and-forget — don't block the token response)
      if (isLiveKitWorkerRunning()) {
        spawnAgentForRoom(roomName, {
          sessionId,
          projectId,
          agentName: agentName || 'default',
          tenantId,
          deploymentId: deploymentId || undefined,
          callerContext: scopedCallerContext,
          sessionMetadata,
        }).catch((err) => {
          log.error('Failed to spawn agent for room', {
            roomName,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (error) {
      log.error('Failed to generate LiveKit token', {
        requestId: (req as any).id,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
        sessionId,
        projectId,
      });
      res.status(500).json({ error: 'Failed to generate token' });
    }
  },
);

export default openapi.router;
