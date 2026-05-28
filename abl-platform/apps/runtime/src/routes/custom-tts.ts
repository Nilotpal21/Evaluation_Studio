import express, { type Router as RouterType, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import {
  ORPHEUS_DEFAULT_MODEL,
  ORPHEUS_DEFAULT_VOICE,
  ORPHEUS_TELEPHONY_SAMPLE_RATE,
  buildPcm16MonoWav,
  resamplePcm16Mono,
  synthesizeOrpheusPcm,
  synthesizeOrpheusSpeechStream,
} from '../services/voice/orpheus-tts.js';
import { resolveOrpheusServiceConfig } from '../services/voice/orpheus-service-instance-resolver.js';
import { sendBinaryResponse } from './response-utils.js';

const log = createLogger('custom-tts-routes');
const router: RouterType = express.Router();
const DEV_ORPHEUS_TTS_BASE_URL = 'https://agents-dev.kore.ai';
const DEFAULT_PROXY_CAPTURE_DIR = '../../logs/orpheus-proxy';

router.use(express.urlencoded({ extended: false }));
router.use(express.json());

const orpheusRequestSchema = z.object({
  text: z.string().min(1),
  voice: z.string().min(1).optional(),
  language: z.string().optional(),
  type: z.string().optional(),
  model: z.string().min(1).optional(),
  call_sid: z.string().min(1).optional(),
  callSid: z.string().min(1).optional(),
});

function resolveOrpheusRouteSecret(): string | null {
  const value = process.env.ORPHEUS_TTS_AUTH_TOKEN?.trim();
  return value && value.length > 0 ? value : null;
}

function shouldUseProgressiveOrpheus(): boolean {
  return process.env.ORPHEUS_TTS_PROGRESSIVE?.trim().toLowerCase() === 'true';
}

function parseOptionalQueryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveOrpheusTestOverrideText(): string | null {
  const value = process.env.ORPHEUS_TTS_TEST_OVERRIDE_TEXT?.trim();
  return value && value.length > 0 ? value : null;
}

function isAuthorized(req: Request, expected: string | null): boolean {
  if (!expected) {
    return false;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return false;
  }

  const match = /^Bearer (.+)$/.exec(authHeader);
  return Boolean(match?.[1] && match[1] === expected);
}

function parseWavMetadata(audio: Buffer): {
  format: string;
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataBytes: number | null;
} | null {
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') {
    return null;
  }

  const format = audio.toString('ascii', 8, 12);
  if (format !== 'WAVE') {
    return null;
  }

  let offset = 12;
  let fmt: {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    byteRate: number;
    blockAlign: number;
    bitsPerSample: number;
  } | null = null;
  let dataBytes: number | null = null;

  while (offset + 8 <= audio.length) {
    const chunkId = audio.toString('ascii', offset, offset + 4);
    const chunkSize = audio.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkDataOffset + chunkSize > audio.length) {
      break;
    }

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      fmt = {
        audioFormat: audio.readUInt16LE(chunkDataOffset),
        channels: audio.readUInt16LE(chunkDataOffset + 2),
        sampleRate: audio.readUInt32LE(chunkDataOffset + 4),
        byteRate: audio.readUInt32LE(chunkDataOffset + 8),
        blockAlign: audio.readUInt16LE(chunkDataOffset + 12),
        bitsPerSample: audio.readUInt16LE(chunkDataOffset + 14),
      };
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!fmt) {
    return null;
  }

  return {
    format,
    ...fmt,
    dataBytes,
  };
}

function resolveProxyCaptureDir(): string {
  return path.resolve(
    process.cwd(),
    process.env.ORPHEUS_TTS_PROXY_CAPTURE_DIR || DEFAULT_PROXY_CAPTURE_DIR,
  );
}

router.post('/orpheus-dev-proxy', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const tenantId = parseOptionalQueryString(req.query.tenantId);
  const serviceInstanceId = parseOptionalQueryString(req.query.serviceInstanceId);
  const upstreamUrl = new URL('/api/v1/voice/custom-tts/orpheus', DEV_ORPHEUS_TTS_BASE_URL);
  if (tenantId) upstreamUrl.searchParams.set('tenantId', tenantId);
  if (serviceInstanceId) upstreamUrl.searchParams.set('serviceInstanceId', serviceInstanceId);

  const authHeader = req.headers.authorization;
  const body = orpheusRequestSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: body.error.issues[0]?.message || 'Invalid Orpheus TTS proxy request payload',
    });
    return;
  }

  if (!authHeader) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  try {
    log.info('Proxying Orpheus TTS request to dev', {
      requestId,
      tenantId,
      serviceInstanceId,
      voice: body.data.voice,
      inputChars: body.data.text.length,
    });

    const upstreamStartedAt = Date.now();
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        Accept: 'audio/wav, application/json',
      },
      body: JSON.stringify(body.data),
    });
    const upstreamElapsedMs = Date.now() - upstreamStartedAt;
    const upstreamContentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const audio = Buffer.from(await upstream.arrayBuffer());

    if (!upstream.ok) {
      log.warn('Dev Orpheus TTS proxy upstream failed', {
        requestId,
        statusCode: upstream.status,
        contentType: upstreamContentType,
        bytes: audio.length,
        upstreamElapsedMs,
      });
      sendBinaryResponse(res, audio, {
        status: upstream.status,
        contentType: upstreamContentType,
      });
      return;
    }

    const wav = parseWavMetadata(audio);
    const captureDir = resolveProxyCaptureDir();
    await mkdir(captureDir, { recursive: true });
    const capturePath = path.join(captureDir, `${Date.now()}-${requestId}.wav`);
    await writeFile(capturePath, audio);

    log.info('Dev Orpheus TTS proxy audio captured', {
      requestId,
      statusCode: upstream.status,
      contentType: upstreamContentType,
      bytes: audio.length,
      upstreamElapsedMs,
      totalElapsedMs: Date.now() - startedAt,
      capturePath,
      wav,
    });

    sendBinaryResponse(res, audio, {
      status: upstream.status,
      contentType: upstreamContentType,
      headers: {
        'X-Orpheus-Proxy': 'dev',
        'X-Orpheus-Proxy-Request-Id': requestId,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Dev Orpheus TTS proxy failed', {
      requestId,
      error: message,
      elapsedMs: Date.now() - startedAt,
    });
    res.status(502).json({ error: 'Failed to proxy Orpheus speech from dev' });
  }
});

router.post('/orpheus', async (req: Request, res: Response) => {
  const requestStartedAt = Date.now();
  const routeMode = shouldUseProgressiveOrpheus() ? 'progressive' : 'buffered';
  const headerCallSid =
    typeof req.headers['x-call-sid'] === 'string'
      ? req.headers['x-call-sid']
      : typeof req.headers['x-jambonz-call-sid'] === 'string'
        ? req.headers['x-jambonz-call-sid']
        : undefined;
  try {
    if (!isAuthorized(req, resolveOrpheusRouteSecret())) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const tenantId = parseOptionalQueryString(req.query.tenantId);
    const serviceInstanceId = parseOptionalQueryString(req.query.serviceInstanceId);
    const body = orpheusRequestSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: body.error.issues[0]?.message || 'Invalid Orpheus TTS request payload',
      });
      return;
    }

    const orpheusConfig = await resolveOrpheusServiceConfig({
      tenantId,
      serviceInstanceId,
      requestedModel: body.data.model,
      requestedVoice: body.data.voice,
    });
    if (!orpheusConfig.apiKey) {
      res.status(503).json({ error: 'Groq Orpheus API key is not configured' });
      return;
    }

    const overrideText = resolveOrpheusTestOverrideText();
    const synthesisInput = {
      apiKey: orpheusConfig.apiKey,
      text: overrideText || body.data.text,
      voice: orpheusConfig.voice || ORPHEUS_DEFAULT_VOICE,
      model: orpheusConfig.model || ORPHEUS_DEFAULT_MODEL,
    };
    const callSid = body.data.call_sid || body.data.callSid || headerCallSid;

    res.once('finish', () => {
      log.info('Completed Orpheus custom TTS HTTP response', {
        mode: routeMode,
        callSid,
        voice: synthesisInput.voice,
        statusCode: res.statusCode,
        elapsedMs: Date.now() - requestStartedAt,
      });
    });

    log.info('Received Orpheus custom TTS HTTP request', {
      mode: routeMode,
      callSid,
      voice: synthesisInput.voice,
      tenantId,
      serviceInstanceId: orpheusConfig.serviceInstanceId || serviceInstanceId,
      credentialSource: orpheusConfig.source,
      inputChars: synthesisInput.text.length,
      overrideTextEnabled: Boolean(overrideText),
    });

    if (shouldUseProgressiveOrpheus()) {
      const progressive = await synthesizeOrpheusSpeechStream(synthesisInput);
      if (progressive) {
        let firstChunkSent = false;
        res.status(200);
        res.setHeader('Content-Type', 'audio/wav');
        if (progressive.contentLength !== undefined) {
          res.setHeader('Content-Length', String(progressive.contentLength));
        } else {
          res.setHeader('Transfer-Encoding', 'chunked');
        }
        res.setHeader('X-Orpheus-Mode', 'progressive');
        res.setHeader('X-Orpheus-Chunks', String(progressive.chunks.length));
        res.setHeader('X-Orpheus-Normalized-Chars', String(progressive.normalizedText.length));

        progressive.stream.on('data', (chunk: Buffer) => {
          if (firstChunkSent) {
            return;
          }
          firstChunkSent = true;
          log.info('Sent first progressive Orpheus HTTP chunk', {
            callSid,
            voice: synthesisInput.voice,
            bytes: chunk.length,
            elapsedMs: Date.now() - requestStartedAt,
          });
        });
        progressive.stream.on('end', () => {
          log.info('Finished progressive Orpheus upstream stream', {
            callSid,
            voice: synthesisInput.voice,
            elapsedMs: Date.now() - requestStartedAt,
          });
        });
        progressive.stream.on('error', (err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.error('Progressive Orpheus stream failed', {
            callSid,
            error: message,
          });
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to stream Orpheus speech' });
          } else {
            res.end();
          }
        });
        progressive.stream.pipe(res);
        return;
      }
    }

    const { pcmData, sampleRate, bitsPerSample, channels, normalizedText, chunks } =
      await synthesizeOrpheusPcm(synthesisInput);
    const telephonyPcm =
      sampleRate === ORPHEUS_TELEPHONY_SAMPLE_RATE
        ? pcmData
        : resamplePcm16Mono(pcmData, sampleRate, ORPHEUS_TELEPHONY_SAMPLE_RATE);
    const bufferedAudio = buildPcm16MonoWav(
      telephonyPcm,
      ORPHEUS_TELEPHONY_SAMPLE_RATE,
      bitsPerSample,
      channels,
    );
    const bufferedContentType = 'audio/wav';
    log.info('Buffered Orpheus synthesis ready to send', {
      callSid,
      voice: synthesisInput.voice,
      bytes: bufferedAudio.length,
      pcmBytes: telephonyPcm.length,
      chunks: chunks.length,
      normalizedChars: normalizedText.length,
      sampleRate,
      outputSampleRate: ORPHEUS_TELEPHONY_SAMPLE_RATE,
      bitsPerSample,
      channels,
      contentType: bufferedContentType,
      elapsedMs: Date.now() - requestStartedAt,
    });

    sendBinaryResponse(res, bufferedAudio, {
      contentType: bufferedContentType,
      headers: {
        'X-Orpheus-Mode': 'buffered',
        'X-Orpheus-Chunks': String(chunks.length),
        'X-Orpheus-Normalized-Chars': String(normalizedText.length),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to synthesize Orpheus custom TTS', {
      error: message,
    });
    res.status(500).json({ error: 'Failed to synthesize Orpheus speech' });
  }
});

export default router;
