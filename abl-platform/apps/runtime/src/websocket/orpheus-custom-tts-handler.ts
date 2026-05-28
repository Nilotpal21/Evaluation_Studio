import type { IncomingMessage } from 'node:http';
import { createLogger } from '@abl/compiler/platform';
import { WebSocket } from 'ws';
import {
  ORPHEUS_DEFAULT_MODEL,
  ORPHEUS_DEFAULT_VOICE,
  synthesizeOrpheusPcmStream,
  synthesizeOrpheusPcm,
  type OrpheusPcmSynthesisResult,
  type OrpheusPcmStreamingChunk,
} from '../services/voice/orpheus-tts.js';
import { resolveOrpheusServiceConfig } from '../services/voice/orpheus-service-instance-resolver.js';

const log = createLogger('orpheus-custom-tts-ws');
const DEFAULT_SAMPLE_RATE = 8000;
const PCM_BITS_PER_SAMPLE = 16;
const ORPHEUS_STREAMING_PCM_SAMPLE_RATE = 24_000;

interface StreamingQueryContext {
  voice: string;
  language: string;
  sampleRate: number;
  tenantId?: string;
  serviceInstanceId?: string;
  model?: string;
  callSid?: string;
}

interface ParsedCommand {
  command: 'connect' | 'stream' | 'flush' | 'clear' | 'stop';
  text?: string;
}

interface StreamSessionState {
  context: StreamingQueryContext;
  orpheus: {
    apiKey: string;
    voice: string;
    model: string;
    serviceInstanceId?: string;
    source: 'tenant' | 'environment';
  };
  textBuffer: string[];
  generation: number;
  observedMessages: number;
  activeFlushGeneration: number | null;
  stopRequested: boolean;
}

export interface OrpheusCustomTtsStreamingDependencies {
  synthesize?: (input: {
    apiKey: string;
    text: string;
    voice?: string;
    model?: string;
  }) => Promise<OrpheusPcmSynthesisResult>;
  synthesizeStream?: (input: {
    apiKey: string;
    text: string;
    voice?: string;
    model?: string;
  }) => AsyncIterable<OrpheusPcmStreamingChunk>;
}

function resolveRouteSecret(): string | null {
  const value = process.env.ORPHEUS_TTS_AUTH_TOKEN?.trim();
  return value && value.length > 0 ? value : null;
}

function extractBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return null;
  }

  const match = /^Bearer\s*(.+)$/i.exec(authHeader.trim());
  return match?.[1] ?? null;
}

function isAuthorized(req: IncomingMessage, expected: string | null): boolean {
  if (!expected) {
    return false;
  }
  const actual = extractBearerToken(req);
  return actual === expected;
}

function parseSampleRate(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SAMPLE_RATE;
  }
  return Math.round(parsed);
}

function parseQueryContext(req: IncomingMessage): StreamingQueryContext {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  return {
    voice:
      url.searchParams.get('voice') ||
      url.searchParams.get('voiceId') ||
      process.env.ORPHEUS_TTS_VOICE ||
      ORPHEUS_DEFAULT_VOICE,
    language:
      url.searchParams.get('language') ||
      url.searchParams.get('lang') ||
      process.env.ORPHEUS_TTS_LANGUAGE ||
      'en',
    sampleRate: parseSampleRate(
      url.searchParams.get('sampleRate') || url.searchParams.get('sample_rate'),
    ),
    tenantId: url.searchParams.get('tenantId') || undefined,
    serviceInstanceId: url.searchParams.get('serviceInstanceId') || undefined,
    model: url.searchParams.get('model') || undefined,
    callSid: url.searchParams.get('call_sid') || url.searchParams.get('callSid') || undefined,
  };
}

function parseStringPayload(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((part) => typeof part === 'string').join(' ');
  }
  return undefined;
}

function normalizeCommandName(value: unknown): ParsedCommand['command'] | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'connect' ||
    normalized === 'stream' ||
    normalized === 'flush' ||
    normalized === 'clear' ||
    normalized === 'stop'
  ) {
    return normalized;
  }

  return null;
}

function parseCommand(raw: unknown): ParsedCommand | null {
  if (Buffer.isBuffer(raw)) {
    const text = raw.toString('utf8').trim();
    if (!text) {
      return null;
    }
    return parseCommand(text);
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return parseCommand(JSON.parse(trimmed));
    } catch {
      const maybeCommand = normalizeCommandName(trimmed);
      return maybeCommand ? { command: maybeCommand } : null;
    }
  }

  if (raw instanceof ArrayBuffer) {
    return parseCommand(Buffer.from(raw));
  }

  if (Array.isArray(raw)) {
    const [first, second, third] = raw;
    const command = normalizeCommandName(second) || normalizeCommandName(first);
    if (!command) {
      return null;
    }
    return {
      command,
      text: command === 'stream' ? parseStringPayload(third ?? first) : undefined,
    };
  }

  if (raw && typeof raw === 'object') {
    const payload = raw as Record<string, unknown>;
    const command =
      normalizeCommandName(payload.command) ||
      normalizeCommandName(payload.type) ||
      normalizeCommandName(payload.event) ||
      normalizeCommandName(payload.action);

    if (!command) {
      return null;
    }

    return {
      command,
      text:
        command === 'stream'
          ? parseStringPayload(payload.text) ||
            parseStringPayload(payload.tokens) ||
            parseStringPayload(payload.payload) ||
            parseStringPayload(payload.data)
          : undefined,
    };
  }

  return null;
}

function describeRawPayload(raw: WebSocket.RawData): Record<string, unknown> {
  if (Buffer.isBuffer(raw)) {
    const utf8Preview = raw.toString('utf8', 0, Math.min(raw.length, 120));
    return {
      rawType: 'buffer',
      byteLength: raw.length,
      utf8Preview,
      hexPreview: raw.subarray(0, Math.min(raw.length, 24)).toString('hex'),
    };
  }

  if (raw instanceof ArrayBuffer) {
    const buffer = Buffer.from(raw);
    return {
      rawType: 'arraybuffer',
      byteLength: buffer.length,
      utf8Preview: buffer.toString('utf8', 0, Math.min(buffer.length, 120)),
      hexPreview: buffer.subarray(0, Math.min(buffer.length, 24)).toString('hex'),
    };
  }

  if (Array.isArray(raw)) {
    const buffer = Buffer.concat(raw.map((part) => Buffer.from(part)));
    return {
      rawType: 'buffer[]',
      byteLength: buffer.length,
      utf8Preview: buffer.toString('utf8', 0, Math.min(buffer.length, 120)),
      hexPreview: buffer.subarray(0, Math.min(buffer.length, 24)).toString('hex'),
    };
  }

  const stringValue = String(raw);
  return {
    rawType: typeof raw,
    byteLength: stringValue.length,
    utf8Preview: stringValue.slice(0, 120),
  };
}

async function sendJsonFrame(ws: WebSocket, payload: Record<string, unknown>): Promise<void> {
  const message = JSON.stringify(payload);
  await new Promise<void>((resolve, reject) => {
    ws.send(message, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function isWsOpen(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.OPEN;
}

function buildConnectMessage(sampleRate: number) {
  return {
    type: 'connect',
    data: {
      sample_rate: sampleRate,
      base64_encoding: false,
    },
  } as const;
}

export class OrpheusCustomTtsStreamingHandler {
  private readonly synthesize: NonNullable<OrpheusCustomTtsStreamingDependencies['synthesize']>;
  private readonly synthesizeStream: NonNullable<
    OrpheusCustomTtsStreamingDependencies['synthesizeStream']
  >;
  constructor(deps: OrpheusCustomTtsStreamingDependencies = {}) {
    this.synthesize = deps.synthesize ?? synthesizeOrpheusPcm;
    this.synthesizeStream = deps.synthesizeStream ?? synthesizeOrpheusPcmStream;
  }

  handleConnection(ws: WebSocket, req: IncomingMessage): void {
    if (!isAuthorized(req, resolveRouteSecret())) {
      log.warn('Rejected Orpheus streaming WS connection due to invalid auth token');
      ws.close(1008, 'Forbidden');
      return;
    }

    void this.initializeConnection(ws, req);
  }

  private async initializeConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const context = parseQueryContext(req);
    const orpheusConfig = await resolveOrpheusServiceConfig({
      tenantId: context.tenantId,
      serviceInstanceId: context.serviceInstanceId,
      requestedModel: context.model,
      requestedVoice: context.voice,
    });

    if (!orpheusConfig.apiKey) {
      log.error('Rejected Orpheus streaming WS connection because Groq API key is missing', {
        tenantId: context.tenantId,
        serviceInstanceId: context.serviceInstanceId,
      });
      ws.close(1011, 'Orpheus API key missing');
      return;
    }

    context.voice = orpheusConfig.voice;

    const state: StreamSessionState = {
      context,
      orpheus: {
        apiKey: orpheusConfig.apiKey,
        voice: orpheusConfig.voice,
        model: orpheusConfig.model,
        serviceInstanceId: orpheusConfig.serviceInstanceId,
        source: orpheusConfig.source,
      },
      textBuffer: [],
      generation: 0,
      observedMessages: 0,
      activeFlushGeneration: null,
      stopRequested: false,
    };

    log.info('Accepted Orpheus streaming WS connection', {
      voice: state.orpheus.voice,
      language: state.context.language,
      sampleRate: state.context.sampleRate,
      tenantId: state.context.tenantId,
      serviceInstanceId: state.orpheus.serviceInstanceId || state.context.serviceInstanceId,
      credentialSource: state.orpheus.source,
      callSid: state.context.callSid,
    });

    await this.sendConnectAck(ws, state.context);

    ws.on('message', (raw) => {
      void this.handleMessage(ws, state, raw);
    });

    ws.on('close', () => {
      state.generation += 1;
      state.textBuffer = [];
      log.info('Closed Orpheus streaming WS connection', {
        callSid: state.context.callSid,
      });
    });

    ws.on('error', (err) => {
      log.error('Orpheus streaming WS connection error', {
        callSid: state.context.callSid,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async sendConnectAck(ws: WebSocket, context: StreamingQueryContext): Promise<void> {
    if (!isWsOpen(ws)) {
      return;
    }

    try {
      await sendJsonFrame(ws, buildConnectMessage(ORPHEUS_STREAMING_PCM_SAMPLE_RATE));
      log.info('Sent Orpheus streaming WS connect ack', {
        callSid: context.callSid,
        sampleRate: ORPHEUS_STREAMING_PCM_SAMPLE_RATE,
      });
    } catch (err) {
      log.warn('Failed to send Orpheus streaming WS connect ack', {
        callSid: context.callSid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleMessage(
    ws: WebSocket,
    state: StreamSessionState,
    raw: WebSocket.RawData,
  ): Promise<void> {
    state.observedMessages += 1;
    const payloadInfo = describeRawPayload(raw);

    if (state.observedMessages <= 5) {
      log.info('Observed raw Orpheus streaming WS payload', {
        callSid: state.context.callSid,
        messageIndex: state.observedMessages,
        ...payloadInfo,
      });
    }

    const parsed = parseCommand(raw);

    if (!parsed) {
      log.info('Ignoring unrecognized Orpheus streaming WS payload', {
        callSid: state.context.callSid,
        messageIndex: state.observedMessages,
        ...payloadInfo,
      });
      return;
    }

    log.info('Received Orpheus streaming WS command', {
      callSid: state.context.callSid,
      messageIndex: state.observedMessages,
      command: parsed.command,
      textLength: parsed.text?.length,
    });

    switch (parsed.command) {
      case 'connect':
        log.debug('Received Orpheus streaming connect command', {
          callSid: state.context.callSid,
        });
        return;
      case 'stream':
        if (parsed.text && parsed.text.trim().length > 0) {
          state.textBuffer.push(parsed.text);
        }
        return;
      case 'clear':
        state.generation += 1;
        state.textBuffer = [];
        return;
      case 'stop':
        state.textBuffer = [];
        if (state.activeFlushGeneration !== null) {
          state.stopRequested = true;
          return;
        }
        state.generation += 1;
        ws.close(1000, 'Stopped');
        return;
      case 'flush':
        await this.handleFlush(ws, state);
        return;
      default:
        return;
    }
  }

  private async handleFlush(ws: WebSocket, state: StreamSessionState): Promise<void> {
    const text = state.textBuffer.join('');
    state.textBuffer = [];

    if (!text.trim()) {
      return;
    }

    const generation = ++state.generation;
    state.activeFlushGeneration = generation;
    state.stopRequested = false;

    try {
      const pcmStream = this.synthesizeStream({
        apiKey: state.orpheus.apiKey,
        text,
        voice: state.orpheus.voice || ORPHEUS_DEFAULT_VOICE,
        model: state.orpheus.model || ORPHEUS_DEFAULT_MODEL,
      });
      let pendingPcm = Buffer.alloc(0);
      let sourceSampleRate = ORPHEUS_STREAMING_PCM_SAMPLE_RATE;
      let normalizedChars = 0;
      let chunkCount = 0;
      let frameCount = 0;

      const sendBufferedAudio = async (final = false) => {
        if (!isWsOpen(ws) || state.generation !== generation) {
          return;
        }

        const sendLength = final ? pendingPcm.length : pendingPcm.length - (pendingPcm.length % 2);

        if (sendLength <= 0) {
          return;
        }

        const chunk = Buffer.from(pendingPcm.subarray(0, sendLength));
        pendingPcm = pendingPcm.subarray(sendLength);
        frameCount += 1;
        await new Promise<void>((resolve, reject) => {
          ws.send(chunk, { binary: true }, (err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
      };

      for await (const pcm of pcmStream) {
        if (pcm.channels !== 1 || pcm.bitsPerSample !== PCM_BITS_PER_SAMPLE) {
          throw new Error(
            `Unsupported Orpheus PCM format for streaming: ${pcm.sampleRate}Hz/${pcm.bitsPerSample}bit/${pcm.channels}ch`,
          );
        }

        sourceSampleRate = pcm.sampleRate;
        normalizedChars = pcm.normalizedText.length;
        chunkCount = pcm.chunks.length;
        pendingPcm = Buffer.concat([pendingPcm, pcm.pcmData]);
        await sendBufferedAudio(false);
      }

      if (pendingPcm.length > 0 && pendingPcm.length % 2 !== 0) {
        pendingPcm = Buffer.concat([pendingPcm, Buffer.alloc(1, 0)]);
      }
      await sendBufferedAudio(true);

      log.info('Flushing Orpheus streaming WS audio', {
        callSid: state.context.callSid,
        voice: state.orpheus.voice,
        inputChars: text.length,
        normalizedChars,
        chunks: chunkCount,
        frames: frameCount,
        sourceSampleRate,
        targetSampleRate: state.context.sampleRate,
        transportSampleRate: sourceSampleRate,
      });
    } catch (err) {
      log.error('Failed to flush Orpheus streaming WS audio', {
        callSid: state.context.callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      if (isWsOpen(ws)) {
        ws.close(1011, 'Orpheus synthesis failed');
      }
    } finally {
      if (state.activeFlushGeneration === generation) {
        state.activeFlushGeneration = null;
      }
      if (state.stopRequested && isWsOpen(ws)) {
        state.stopRequested = false;
        state.generation += 1;
        ws.close(1000, 'Stopped');
      }
    }
  }

  private async *wrapBufferedSynthesisAsStream(input: {
    apiKey: string;
    text: string;
    voice?: string;
    model?: string;
  }): AsyncGenerator<OrpheusPcmStreamingChunk> {
    const pcm = await this.synthesize(input);
    yield {
      pcmData: pcm.pcmData,
      sampleRate: pcm.sampleRate,
      bitsPerSample: pcm.bitsPerSample,
      channels: pcm.channels,
      normalizedText: pcm.normalizedText,
      chunks: pcm.chunks,
    };
  }
}
