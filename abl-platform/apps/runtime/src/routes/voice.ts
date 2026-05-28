/**
 * Voice Routes (Runtime)
 *
 * Voice endpoints: Twilio webhooks, token generation, and status.
 *
 * GET  /capabilities      Check what voice services are configured
 * POST /token             Generate Twilio access token for browser-based voice
 * POST /connect           Twilio webhook when call connects - returns TwiML to stream media
 * POST /status            Twilio status callback for call events
 */

import express, {
  type Router as RouterType,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { getTwilioService } from '../services/voice/twilio-service.js';
import { getDeepgramService } from '../services/voice/deepgram-service.js';
import { getElevenLabsService } from '../services/voice/elevenlabs-service.js';
import { ORPHEUS_DEFAULT_VOICE } from '../services/voice/orpheus-tts.js';
import { createLogger } from '@abl/compiler/platform';
import crypto from 'crypto';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireFeature } from '../middleware/feature-gate.js';
import { getJambonzProvisioningService } from '../services/voice/jambonz-provisioning.service.js';
import type { CallDisposition } from '@abl/compiler/platform/core/types';
import { getStores } from '../services/stores/store-factory.js';
import { sessionMetadataSchema } from '../services/session-metadata.js';
import { sendBinaryResponse, sendXmlResponse } from './response-utils.js';

const log = createLogger('voice-routes');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/v1/voice',
  tags: ['Voice'],
});
const router: RouterType = openapi.router;

// Parse URL-encoded bodies (Twilio sends webhooks as application/x-www-form-urlencoded)
router.use(express.urlencoded({ extended: false }));

// =============================================================================
// TWILIO WEBHOOK SIGNATURE VALIDATION
// =============================================================================

/**
 * Middleware that validates the X-Twilio-Signature header against the request
 * body using the configured Twilio auth token. Rejects forged webhooks with 403.
 * If Twilio is not configured, skips validation — the route handler's own
 * isConfigured() check will return 503.
 */
async function validateTwilioSignature(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const twilio = getTwilioService();

  // If Twilio is not configured, skip validation — the route's own 503 check handles this
  if (!twilio.isConfigured()) {
    next();
    return;
  }

  const signature = req.headers['x-twilio-signature'] as string | undefined;
  if (!signature) {
    log.warn('Twilio webhook missing X-Twilio-Signature header', {
      path: req.path,
      ip: req.ip,
    });
    res.status(403).json({ error: 'Missing X-Twilio-Signature header' });
    return;
  }

  // Build the full URL from a trusted config-derived base — never from untrusted
  // forwarded headers (X-Forwarded-Host/Proto) which an attacker can forge to
  // compute a valid signature for a URL they control.
  const baseUrl = (
    process.env.RUNTIME_PUBLIC_BASE_URL ||
    process.env.RUNTIME_BASE_URL ||
    'http://localhost:3112'
  ).replace(/\/+$/, '');
  const fullUrl = `${baseUrl}${req.originalUrl}`;

  try {
    const isValid = await twilio.validateWebhookSignature(signature, fullUrl, req.body || {});

    if (!isValid) {
      log.warn('Twilio webhook signature validation failed', {
        path: req.path,
        ip: req.ip,
      });
      res.status(403).json({ error: 'Invalid Twilio webhook signature' });
      return;
    }

    next();
  } catch (err) {
    log.error('Twilio webhook signature validation error', {
      error: err instanceof Error ? err.message : String(err),
      path: req.path,
    });
    res.status(403).json({ error: 'Webhook signature validation failed' });
  }
}

// =============================================================================
// SCHEMAS
// =============================================================================

const capabilitiesResponseSchema = z.object({
  twilio: z.boolean().describe('Whether Twilio service is configured'),
  deepgram: z.boolean().describe('Whether Deepgram service is configured'),
  elevenlabs: z.boolean().describe('Whether ElevenLabs service is configured'),
  fullVoice: z.boolean().describe('Whether all voice services are configured'),
});

const tokenRequestSchema = z.object({
  sessionId: z.string().min(1).describe('Session ID for the voice call'),
  projectId: z.string().optional().describe('Optional project ID'),
});

const tokenResponseSchema = z.object({
  token: z.string().describe('Twilio access token'),
  identity: z.string().describe('Twilio identity for the session'),
  sessionId: z.string().describe('Session ID'),
});

const connectRequestSchema = z.object({
  customParameters: z
    .record(z.string())
    .optional()
    .describe('Custom parameters from Twilio Device'),
  sessionId: z.string().optional().describe('Optional session ID'),
  tenantId: z.string().optional().describe('Optional tenant ID'),
  projectId: z.string().optional().describe('Optional project ID'),
  deploymentId: z.string().optional().describe('Optional deployment ID'),
  agentName: z.string().optional().describe('Optional agent name'),
  channelId: z.string().optional().describe('Optional channel identifier for continuity'),
  caller: z.string().optional().describe('Optional caller identity'),
  called: z.string().optional().describe('Optional called identity'),
  providerVerificationStrength: z
    .enum(['weak', 'strong'])
    .optional()
    .describe('Optional trust level for provider-verified caller identity'),
  sessionMetadata: sessionMetadataSchema.describe(
    'Optional session-level metadata stored under session.data.values._metadata',
  ),
  From: z.string().optional().describe('Twilio caller phone number'),
  To: z.string().optional().describe('Twilio called phone number'),
});

const statusRequestSchema = z.object({
  CallSid: z.string().describe('Twilio call ID'),
  CallStatus: z
    .string()
    .describe(
      'Call status (initiated, ringing, in-progress, completed, failed, busy, no-answer, canceled)',
    ),
  Duration: z.string().optional().describe('Call duration in seconds'),
});

const errorResponseSchema = z.object({
  error: z.string().describe('Error message'),
});

function mapTwilioCallStatusToDisposition(status: string): CallDisposition | null {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'busy':
    case 'no-answer':
    case 'canceled':
      return 'abandoned';
    default:
      return null;
  }
}

const phoneNumberSchema = z.object({
  sid: z.string(),
  phoneNumber: z.string(),
  friendlyName: z.string(),
});

const phoneNumbersResponseSchema = z.object({
  phoneNumbers: z.array(phoneNumberSchema),
});

const availablePhoneNumberSchema = z.object({
  phoneNumber: z.string(),
  friendlyName: z.string(),
  region: z.string(),
  isoCountry: z.string(),
});

const availableNumbersResponseSchema = z.object({
  numbers: z.array(availablePhoneNumberSchema),
});

const purchaseNumberRequestSchema = z.object({
  phoneNumber: z.string().min(1).describe('E.164 phone number to purchase'),
});

const purchaseNumberResponseSchema = z.object({
  phoneNumber: phoneNumberSchema,
});

const speechOptionsQuerySchema = z.object({
  vendor: z.string().min(1).describe('Speech vendor name (e.g., deepgram, elevenlabs)'),
});

const LABEL_SCOPED_SPEECH_OPTION_VENDORS = new Set(['elevenlabs', 'microsoft']);

function getSpeechOptionsLabel(vendor: string, tenantId?: string): string | undefined {
  return LABEL_SCOPED_SPEECH_OPTION_VENDORS.has(vendor.toLowerCase()) && tenantId
    ? `t:${tenantId}`
    : undefined;
}

const speechOptionsResponseSchema = z.object({
  tts: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      voices: z.array(z.object({ value: z.string(), name: z.string() })),
    }),
  ),
  stt: z.array(z.object({ code: z.string(), name: z.string() })),
});

const e2eCallerAudioQuerySchema = z.object({
  text: z.string().min(1).max(500).optional(),
  voiceId: z.string().min(1).max(128).optional(),
});

const DEFAULT_E2E_CALLER_TEXT =
  'Hello. Please tell me who you are and what you can help me with today.';
const DEFAULT_E2E_CALLER_AUDIO_FORMAT = 'mp3_22050_32' as const;
const e2eCallerAudioCache = new Map<string, Buffer>();

// =============================================================================
// ENDPOINTS
// =============================================================================

async function handleKorevgHook(req: Request, res: Response): Promise<void> {
  const { sessionId, hookName } = req.params;
  const { getVoiceSession } = await import('../services/voice/korevg/korevg-session.js');
  const session = getVoiceSession(sessionId);

  if (!session) {
    // Realtime (S2S) sessions don't create KorevgSession instances — check realtime registry.
    if (hookName === 'call-transcriptions') {
      const { getRealtimeVoiceSession } =
        await import('../services/voice/korevg/realtime-voice-session.js');
      const realtimeSession = getRealtimeVoiceSession(sessionId);
      if (realtimeSession) {
        const body =
          req.body && typeof req.body === 'object' && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
        try {
          await realtimeSession.handleBridgedCallTranscription(body);
        } catch (err) {
          log.error('Failed to process realtime call-transcriptions hook', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        res.json([]);
        return;
      }
    }

    log.warn('Ignoring KoreVG hook for unknown voice session', {
      sessionId,
      hookName,
    });
    res.json([]);
    return;
  }

  const body =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};

  const speechPayload =
    body.speech && typeof body.speech === 'object' && !Array.isArray(body.speech)
      ? (body.speech as {
          alternatives?: Array<{ transcript?: string; confidence?: number }>;
          is_final?: boolean;
          language_code?: string;
        })
      : undefined;
  const transcriptPreview = speechPayload?.alternatives?.[0]?.transcript?.trim();

  log.info('Received KoreVG HTTP hook', {
    sessionId,
    hookName: hookName || '(root)',
    hasSpeech: Boolean(transcriptPreview),
    transcriptPreview: transcriptPreview ? transcriptPreview.substring(0, 80) : undefined,
    hasDigits: typeof body.digits === 'string' && body.digits.length > 0,
    hasDialStatus: typeof body.dial_call_status === 'string',
    bodyKeys: Object.keys(body),
  });

  try {
    const verbs = await session.handleHttpHook(body, hookName);
    res.json(verbs);
  } catch (err) {
    log.error('Failed to process KoreVG HTTP hook', {
      sessionId,
      hookName,
      error: err instanceof Error ? err.message : String(err),
    });
    res.json([]);
  }
}

router.post(
  '/korevg/hook/:sessionId',
  express.json(),
  express.urlencoded({ extended: false }),
  handleKorevgHook,
);
router.post(
  '/korevg/hook/:sessionId/:hookName',
  express.json(),
  express.urlencoded({ extended: false }),
  handleKorevgHook,
);

/**
 * GET /api/v1/voice/capabilities
 * Check what voice services are configured.
 */
openapi.route(
  'get',
  '/capabilities',
  {
    summary: 'Get voice service capabilities',
    description: 'Check which voice services (Twilio, Deepgram, ElevenLabs) are configured',
    response: capabilitiesResponseSchema,
  },
  authMiddleware,
  requireFeature('voice_channels'),
  tenantRateLimit('request'),
  async (_req, res) => {
    try {
      const twilio = getTwilioService();
      const deepgram = getDeepgramService();
      const elevenlabs = getElevenLabsService();

      res.json({
        twilio: twilio.isConfigured(),
        deepgram: deepgram.isConfigured(),
        elevenlabs: elevenlabs.isConfigured(),
        fullVoice: twilio.isConfigured() && deepgram.isConfigured() && elevenlabs.isConfigured(),
      });
    } catch (err) {
      log.error('Failed to get voice capabilities', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to get capabilities' });
    }
  },
);

/**
 * GET /api/v1/voice/e2e/caller-audio
 * Generate or serve cached deterministic MP3 audio for live voice E2E callers.
 * Unauthenticated on purpose so Twilio can fetch it via public tunnel URL.
 */
openapi.route(
  'get',
  '/e2e/caller-audio',
  {
    summary: 'Get cached caller audio fixture for voice E2E',
    description:
      'Returns a deterministic MP3 audio fixture, synthesized via ElevenLabs and cached in memory.',
    query: e2eCallerAudioQuerySchema,
    response: z.any(),
  },
  async (req, res) => {
    try {
      const parsed = e2eCallerAudioQuerySchema.parse(req.query);
      const text = parsed.text?.trim() || DEFAULT_E2E_CALLER_TEXT;
      const voiceId = parsed.voiceId?.trim() || undefined;
      const cacheKey = JSON.stringify({ text, voiceId, format: DEFAULT_E2E_CALLER_AUDIO_FORMAT });

      let audio = e2eCallerAudioCache.get(cacheKey);
      if (!audio) {
        const elevenlabs = getElevenLabsService();
        if (!elevenlabs.isConfigured()) {
          res.status(503).json({ error: 'ElevenLabs is not configured for caller audio fixtures' });
          return;
        }

        audio = await elevenlabs.synthesize(text, {
          voiceId,
          outputFormat: DEFAULT_E2E_CALLER_AUDIO_FORMAT,
        });
        e2eCallerAudioCache.set(cacheKey, audio);

        log.info('Generated cached voice E2E caller audio fixture', {
          textLength: text.length,
          voiceId: voiceId || 'default',
          bytes: audio.length,
        });
      }

      sendBinaryResponse(res, audio, {
        contentType: 'audio/mpeg',
        headers: {
          'Cache-Control': 'public, max-age=86400, immutable',
        },
      });
    } catch (err) {
      log.error('Failed to serve voice E2E caller audio fixture', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to generate caller audio fixture' });
    }
  },
);

/**
 * POST /api/v1/voice/token
 * Generate Twilio access token for browser-based voice.
 */
openapi.route(
  'post',
  '/token',
  {
    summary: 'Generate Twilio access token',
    description: 'Generate a Twilio access token for browser-based voice communication',
    body: tokenRequestSchema,
    response: tokenResponseSchema,
  },
  authMiddleware,
  requireFeature('voice_channels'),
  tenantRateLimit('request'),
  async (req, res) => {
    try {
      const twilio = getTwilioService();

      if (!twilio.isConfigured()) {
        res.status(503).json({ error: 'Voice service not configured' });
        return;
      }

      const { sessionId, projectId } = req.body;

      const identity = `sdk_${sessionId}`;
      const token = await twilio.generateAccessToken({
        identity,
        sessionId,
        ttl: 3600,
      });

      log.info('Generated voice token', { sessionId, projectId });

      res.json({
        token,
        identity,
        sessionId,
      });
    } catch (error) {
      const { sessionId } = req.body;
      log.error('Failed to generate voice token', { error, sessionId });
      res.status(500).json({ error: 'Failed to generate token' });
    }
  },
);

/**
 * POST /api/v1/voice/connect
 * Twilio webhook when call connects - returns TwiML to stream media.
 */
openapi.route(
  'post',
  '/connect',
  {
    summary: 'Handle Twilio call connection',
    description:
      'Twilio webhook that handles when a call connects and returns TwiML to stream media to the runtime',
    body: connectRequestSchema,
    response: z.any().describe('TwiML XML response'),
  },
  validateTwilioSignature,
  async (req, res) => {
    try {
      const twilio = getTwilioService();

      if (!twilio.isConfigured()) {
        res.status(503).send('Voice service not configured');
        return;
      }

      // Get parameters from Twilio Device custom parameters or request body
      const requestBody = req.body as {
        customParameters?: Record<string, string>;
        sessionMetadata?: Record<string, unknown> | string;
        [key: string]: unknown;
      };
      const params = {
        ...requestBody,
        ...(requestBody.customParameters || {}),
      };
      const sessionId = params.sessionId || req.query.sessionId || crypto.randomUUID();

      // Determine WebSocket URL based on environment
      // For local dev, use ws://; for production with TLS, use wss://
      const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      // Include a short-lived HMAC connection token. Twilio media stream
      // WebSocket upgrades do not reliably carry a signature header, so this
      // token is the primary authentication boundary for `/voice/media`.
      const connectionToken = twilio.generateMediaStreamToken();
      const streamUrl = `${protocol}://${host}/voice/media?token=${encodeURIComponent(connectionToken)}`;

      // Forward project context through TwiML parameters so the media handler
      // can create a runtime session and DB session for the voice call
      const customParameters: Record<string, string> = {};
      if (params.tenantId) customParameters.tenantId = String(params.tenantId);
      if (params.projectId) customParameters.projectId = String(params.projectId);
      if (params.deploymentId) customParameters.deploymentId = String(params.deploymentId);
      if (params.agentName) customParameters.agentName = String(params.agentName);
      const caller = params.caller || params.From;
      const called = params.called || params.To;
      if (caller) customParameters.caller = String(caller);
      if (called) customParameters.called = String(called);
      if (params.channelId) customParameters.channelId = String(params.channelId);
      if (params.providerVerificationStrength) {
        customParameters.providerVerificationStrength = String(params.providerVerificationStrength);
      }
      if (typeof params.sessionMetadata === 'string' && params.sessionMetadata.trim().length > 0) {
        customParameters.sessionMetadata = params.sessionMetadata;
      } else if (params.sessionMetadata && typeof params.sessionMetadata === 'object') {
        customParameters.sessionMetadata = JSON.stringify(params.sessionMetadata);
      }

      const twiml = twilio.generateStreamTwiML({
        streamUrl,
        sessionId: sessionId as string,
        customParameters,
      });

      log.info('Voice call connected', { sessionId, streamUrl });

      sendXmlResponse(res, twiml);
    } catch (err) {
      log.error('Failed to handle voice connection', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).send('Failed to handle connection');
    }
  },
);

/**
 * GET /api/v1/voice/twilio/phone-numbers
 * List incoming phone numbers from the configured Twilio account.
 */
openapi.route(
  'get',
  '/twilio/phone-numbers',
  {
    summary: 'List Twilio incoming phone numbers',
    description: 'Retrieve all incoming phone numbers from the configured Twilio account',
    response: phoneNumbersResponseSchema,
  },
  authMiddleware,
  requireFeature('voice_channels'),
  tenantRateLimit('request'),
  async (_req, res) => {
    try {
      const twilio = getTwilioService();

      if (!twilio.isBasicConfigured()) {
        res.status(503).json({ error: 'Twilio account credentials not configured' });
        return;
      }

      const phoneNumbers = await twilio.listIncomingPhoneNumbers();
      res.json({ phoneNumbers });
    } catch (err) {
      log.error('Failed to list Twilio phone numbers', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to list phone numbers' });
    }
  },
);

/**
 * GET /api/v1/voice/twilio/available-numbers
 * Search available phone numbers from Twilio's inventory.
 */
openapi.route(
  'get',
  '/twilio/available-numbers',
  {
    summary: 'Search available Twilio phone numbers',
    description: "Search Twilio's available phone number inventory by country, type, and area code",
    response: availableNumbersResponseSchema,
  },
  authMiddleware,
  requireFeature('voice_channels'),
  tenantRateLimit('request'),
  async (req, res) => {
    try {
      const twilio = getTwilioService();

      if (!twilio.isBasicConfigured()) {
        res.status(503).json({ error: 'Twilio account credentials not configured' });
        return;
      }

      const countryCode = (req.query.countryCode as string) || 'US';
      const numberType = (req.query.numberType as 'local' | 'tollFree') || 'local';
      const areaCode = req.query.areaCode as string | undefined;

      const numbers = await twilio.searchAvailableNumbers({ countryCode, numberType, areaCode });
      res.json({ numbers });
    } catch (err) {
      log.error('Failed to search available Twilio phone numbers', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to search available numbers' });
    }
  },
);

/**
 * POST /api/v1/voice/twilio/purchase-number
 * Purchase a phone number from Twilio.
 */
openapi.route(
  'post',
  '/twilio/purchase-number',
  {
    summary: 'Purchase a Twilio phone number',
    description: 'Purchase a phone number from Twilio and add it to the account',
    body: purchaseNumberRequestSchema,
    response: purchaseNumberResponseSchema,
  },
  authMiddleware,
  requireFeature('voice_channels'),
  tenantRateLimit('request'),
  async (req, res) => {
    try {
      const twilio = getTwilioService();

      if (!twilio.isBasicConfigured()) {
        res.status(503).json({ error: 'Twilio account credentials not configured' });
        return;
      }

      const { phoneNumber } = req.body;
      const purchased = await twilio.purchasePhoneNumber(phoneNumber);
      res.json({ phoneNumber: purchased });
    } catch (err) {
      log.error('Failed to purchase Twilio phone number', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to purchase phone number' });
    }
  },
);

/**
 * GET /api/v1/voice/speech-options
 * Fetch supported languages and voices for a speech vendor from Jambonz.
 */
openapi.route(
  'get',
  '/speech-options',
  {
    summary: 'Get supported languages and voices for a vendor',
    description:
      'Fetches available languages and voices from Jambonz for the specified speech vendor',
    query: speechOptionsQuerySchema,
    response: speechOptionsResponseSchema,
  },
  authMiddleware,
  requireFeature('voice_channels'),
  tenantRateLimit('request'),
  async (req, res) => {
    try {
      const vendor = req.query.vendor as string;
      if (!vendor) {
        res.status(400).json({ error: 'vendor query parameter is required' });
        return;
      }

      if (vendor === 'custom:orpheus') {
        res.json({
          tts: [
            {
              code: 'en',
              name: 'English',
              voices: [
                { value: 'autumn', name: 'Autumn' },
                { value: 'diana', name: 'Diana' },
                { value: ORPHEUS_DEFAULT_VOICE, name: 'Hannah' },
                { value: 'austin', name: 'Austin' },
                { value: 'daniel', name: 'Daniel' },
                { value: 'troy', name: 'Troy' },
              ],
            },
          ],
          stt: [],
        });
        return;
      }

      const jambonz = getJambonzProvisioningService();
      const result = await jambonz.getSupportedLanguagesAndVoices(vendor, {
        label: getSpeechOptionsLabel(vendor, req.tenantContext?.tenantId),
      });
      res.json(result);
    } catch (err) {
      log.error('Failed to fetch speech options', {
        error: err instanceof Error ? err.message : String(err),
        vendor: req.query.vendor,
      });
      res.status(502).json({ error: 'Failed to fetch speech options from voice gateway' });
    }
  },
);

/**
 * POST /api/v1/voice/status
 * Twilio status callback for call events.
 */
openapi.route(
  'post',
  '/status',
  {
    summary: 'Handle Twilio call status updates',
    description:
      'Twilio status callback that logs call events (initiated, ringing, in-progress, completed, failed, etc.)',
    body: statusRequestSchema,
    response: z.any().describe('Empty response'),
  },
  validateTwilioSignature,
  async (req, res) => {
    try {
      const { CallSid, CallStatus, Duration } = req.body;

      log.info('Voice call status', { callSid: CallSid, status: CallStatus, duration: Duration });

      const disposition = mapTwilioCallStatusToDisposition(CallStatus);
      if (disposition) {
        const { Session: SessionModel } = await import('@agent-platform/database/models');
        const matchedSession = (await SessionModel.findOne({
          'metadata.voiceMetadata.callSid': CallSid,
        })
          .sort({ lastActivityAt: -1 })
          .select({ _id: 1, status: 1, disposition: 1 })
          .lean()) as { _id: string; status?: string; disposition?: CallDisposition } | null;

        if (matchedSession?._id) {
          if (matchedSession.status === 'active' || matchedSession.status === 'paused') {
            await getStores().conversation.endSession(String(matchedSession._id), disposition);
          } else if (matchedSession.disposition !== disposition) {
            await SessionModel.updateOne(
              { _id: matchedSession._id },
              {
                $set: {
                  disposition,
                  lastActivityAt: new Date(),
                },
              },
            );
          }
        }
      }

      res.status(200).end();
    } catch (err) {
      log.error('Failed to handle voice status', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).end();
    }
  },
);

// =============================================================================
// SOFTPHONE ENDPOINTS
// =============================================================================

const VOICE_CHANNEL_TYPES = ['korevg', 'voice_realtime', 'voice_pipeline', 'voice_twilio'] as const;

const softphoneConfigResponseSchema = z.object({
  sipDomain: z.string().describe('SIP realm from Jambonz account'),
  wsServers: z.array(z.string()).describe('WebSocket SBC URLs for WebRTC'),
  ready: z
    .boolean()
    .describe('Whether Jambonz account has device calling and registration configured'),
  warnings: z.array(z.string()).describe('Configuration warnings if not ready'),
});

const softphoneNumberSchema = z.object({
  number: z.string(),
  channelName: z.string(),
  connectionId: z.string(),
});

const softphoneNumbersResponseSchema = z.object({
  numbers: z.array(softphoneNumberSchema),
});

/**
 * GET /api/v1/voice/softphone-config
 * Returns the SIP domain and WebSocket SBC URLs needed for WebRTC softphone registration.
 */
openapi.route(
  'get',
  '/softphone-config',
  {
    summary: 'Get softphone connection config',
    description:
      'Returns the SIP domain (sip_realm) from Jambonz and the WebSocket SBC URLs for WebRTC registration',
    response: softphoneConfigResponseSchema,
  },
  authMiddleware,
  tenantRateLimit('request'),
  async (_req, res) => {
    try {
      const jambonz = getJambonzProvisioningService();
      const { getConfig: getCfg } = await import('../config/index.js');
      const jambonzCfg = getCfg().voice?.jambonz ?? {};

      const sbcWsAddress = jambonzCfg.sbcWsAddress;
      if (!sbcWsAddress) {
        res.status(503).json({
          error: 'Voice gateway SBC WebSocket address not configured (JAMBONZ_SBC_WS_ADDRESS)',
        });
        return;
      }

      const account = await jambonz.getAccount();

      const sbcWsPort = process.env.JAMBONZ_SBC_WS_PORT || '8443';

      const wsServers = sbcWsAddress
        .split(',')
        .map((addr: string) => addr.trim())
        .filter(Boolean)
        .map((addr: string) => {
          // If already a wss:// URL, use as-is; otherwise build wss://<addr>:<port>
          if (addr.startsWith('wss://')) return addr;
          // Strip any port suffix for clean URL construction
          const host = addr.includes(':') ? addr.split(':')[0] : addr;
          return `wss://${host}:${sbcWsPort}`;
        });

      // Check Jambonz account readiness for softphone
      const warnings: string[] = [];
      if (!account.device_calling_application_sid) {
        warnings.push('Device calling application not configured in Jambonz account');
      }
      if (
        !account.registration_hook ||
        typeof account.registration_hook !== 'object' ||
        !account.registration_hook.url
      ) {
        warnings.push('Registration hook not configured in Jambonz account');
      }

      res.json({
        sipDomain: account.sip_realm,
        wsServers,
        ready: warnings.length === 0,
        warnings,
      });
    } catch (err) {
      log.error('Failed to get softphone config', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to get softphone configuration' });
    }
  },
);

/**
 * GET /api/v1/voice/softphone-numbers/:projectId
 * Returns phone numbers from the project's active voice channel connections.
 */
openapi.route(
  'get',
  '/softphone-numbers/:projectId',
  {
    summary: 'List softphone-dialable phone numbers for a project',
    description:
      'Returns phone numbers from active voice channel connections in the specified project',
    response: softphoneNumbersResponseSchema,
  },
  authMiddleware,
  tenantRateLimit('request'),
  async (req, res) => {
    try {
      const { projectId } = req.params;
      const tenantId = req.tenantContext?.tenantId;
      if (!projectId) {
        res.status(400).json({ error: 'projectId is required' });
        return;
      }

      const { ChannelConnection } = await import('@agent-platform/database/models');
      const connections = await ChannelConnection.find({
        projectId,
        tenantId,
        status: 'active',
        channelType: { $in: VOICE_CHANNEL_TYPES },
      })
        .select({ _id: 1, name: 1, config: 1, channelType: 1 })
        .lean();

      const numbers = connections
        .filter((c: any) => c.config?.phoneNumber)
        .map((c: any) => ({
          number: String(c.config.phoneNumber),
          channelName: String(c.name || c.channelType),
          connectionId: String(c._id),
        }));

      res.json({ numbers });
    } catch (err) {
      log.error('Failed to list softphone numbers', {
        error: err instanceof Error ? err.message : String(err),
        projectId: req.params.projectId,
      });
      res.status(500).json({ error: 'Failed to list phone numbers' });
    }
  },
);

export default router;
