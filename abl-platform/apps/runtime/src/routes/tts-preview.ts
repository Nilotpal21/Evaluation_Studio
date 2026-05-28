/**
 * TTS Preview Route
 *
 * Generalized TTS preview endpoint that synthesizes sample text
 * using tenant-configured TTS provider credentials and returns
 * playable audio. Supports ElevenLabs and Orpheus (Groq) providers.
 */

import express, {
  type Router as RouterType,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import { authMiddleware } from '../middleware/auth.js';
import { applyRateLimitHeaders } from '../middleware/rate-limiter.js';
import { requirePermission } from '@agent-platform/shared-auth';
import { VoiceServiceFactory } from '../services/voice/voice-service-factory.js';
import { ElevenLabsService } from '../services/voice/elevenlabs-service.js';
import {
  synthesizeOrpheusSpeech,
  ORPHEUS_DEFAULT_VOICE,
  ORPHEUS_DEFAULT_MODEL,
} from '../services/voice/orpheus-tts.js';
import { isEncryptionAvailable, getEncryptionService } from '@agent-platform/shared/encryption';
import { getHybridRateLimiter } from '../services/resilience/hybrid-rate-limiter.js';
import { sendBinaryResponse } from './response-utils.js';

const log = createLogger('tts-preview');

const router: RouterType = express.Router();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function getMaxChars(): number {
  const raw = process.env.TTS_PREVIEW_MAX_CHARS;
  if (!raw) return 500;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 500 : parsed;
}

export function getRateLimit(): number {
  const raw = process.env.TTS_PREVIEW_RATE_LIMIT;
  if (!raw) return 20;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 20 : parsed;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ttsPreviewRequestSchema = z.object({
  text: z.string().min(1).max(getMaxChars()),
  serviceInstanceId: z.string().min(1),
  provider: z.enum(['elevenlabs', 'custom:orpheus']),
  voice: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  language: z.string().optional(),
  speed: z.number().min(0.7).max(1.2).optional(),
  stability: z.number().min(0).max(1).optional(),
  similarityBoost: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  useSpeakerBoost: z.boolean().optional(),
});

export type TtsPreviewRequest = z.infer<typeof ttsPreviewRequestSchema>;

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

async function ttsPreviewRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tenantId = req.tenantContext?.tenantId;

  if (!tenantId) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Tenant context is required' },
    });
    return;
  }

  const userId = req.tenantContext?.userId;
  const apiKeyId = req.tenantContext?.apiKeyId;
  const actorKeyPart = userId
    ? `user:${userId}`
    : apiKeyId
      ? `apiKey:${apiKeyId}`
      : req.ip
        ? `ip:${req.ip}`
        : 'anonymous';
  const limiterKey = `tenant:${tenantId}:${actorKeyPart}`;
  const limit = getRateLimit();
  const limiter = getHybridRateLimiter();
  const decision = await limiter.check(limiterKey, 'request', limit);

  applyRateLimitHeaders(res, {
    allowed: decision.allowed,
    remaining: decision.remaining,
    resetMs: decision.resetMs,
    limit,
  });

  if (!decision.allowed) {
    res.status(429).json({
      error: 'Rate limit exceeded',
      operation: 'request',
      limit,
      retryAfterMs: decision.resetMs,
    });
    return;
  }

  next();
}

router.post(
  '/',
  authMiddleware,
  requirePermission('credential:read'),
  ttsPreviewRateLimit,
  async (req: Request, res: Response): Promise<void> => {
    const startMs = Date.now();

    // Validate request body
    const parsed = ttsPreviewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message || 'Invalid request body',
          details: parsed.error.issues,
        },
      });
      return;
    }

    const {
      text,
      serviceInstanceId,
      provider,
      voice,
      model,
      speed,
      stability,
      similarityBoost,
      style,
      useSpeakerBoost,
    } = parsed.data;
    const tenantId = req.tenantContext?.tenantId;

    if (!tenantId) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Tenant context is required' },
      });
      return;
    }

    log.info('TTS preview request', {
      tenantId,
      provider,
      serviceInstanceId,
      textLength: text.length,
    });

    try {
      // Resolve credentials
      const encryption = isEncryptionAvailable() ? getEncryptionService() : null;
      const factory = new VoiceServiceFactory(encryption);
      const credentials = await factory.resolveServiceCredentials(tenantId, provider, {
        instanceId: serviceInstanceId,
      });

      if (!credentials) {
        res.status(404).json({
          success: false,
          error: {
            code: 'SERVICE_NOT_CONFIGURED',
            message: 'No active TTS service instance found for this tenant.',
          },
        });
        return;
      }

      // Synthesize audio based on provider
      let audioBuffer: Buffer;
      let contentType: string;

      if (provider === 'elevenlabs') {
        const service = ElevenLabsService.fromCredentials(credentials.apiKey, credentials.config);
        audioBuffer = await service.synthesize(text, {
          voiceId: voice || (credentials.config?.voiceId as string) || undefined,
          modelId: model || (credentials.config?.model as string) || undefined,
          outputFormat: 'mp3_44100_128',
          speed,
          stability,
          similarityBoost,
          style,
          useSpeakerBoost,
        });
        contentType = 'audio/mpeg';
      } else {
        // custom:orpheus
        const result = await synthesizeOrpheusSpeech({
          apiKey: credentials.apiKey,
          text,
          voice: voice || (credentials.config?.voiceId as string) || ORPHEUS_DEFAULT_VOICE,
          model: model || (credentials.config?.model as string) || ORPHEUS_DEFAULT_MODEL,
        });
        audioBuffer = result.audio;
        contentType = 'audio/wav';
      }

      const latencyMs = Date.now() - startMs;

      log.info('TTS preview success', {
        tenantId,
        provider,
        serviceInstanceId,
        textLength: text.length,
        audioBytes: audioBuffer.length,
        latencyMs,
      });

      sendBinaryResponse(res, audioBuffer, {
        contentType,
        headers: {
          'X-Synthesis-Latency-Ms': String(latencyMs),
        },
      });
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      const message = err instanceof Error ? err.message : String(err);

      log.error('TTS preview failed', {
        tenantId,
        provider,
        serviceInstanceId,
        error: message,
        latencyMs,
      });

      res.status(502).json({
        success: false,
        error: {
          code: 'PROVIDER_ERROR',
          message: `TTS synthesis failed — ${provider === 'elevenlabs' ? 'check your ElevenLabs API key in Voice Services' : 'check your Groq API key in Voice Services'}.`,
        },
      });
    }
  },
);

export default router;
