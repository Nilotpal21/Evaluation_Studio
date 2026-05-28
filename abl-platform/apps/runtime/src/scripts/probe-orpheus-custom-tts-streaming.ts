import { createLogger } from '@abl/compiler/platform';
import { WebSocket } from 'ws';

const log = createLogger('probe-orpheus-custom-tts-streaming');

interface ProbeConfig {
  wsUrl: string;
  authToken: string;
  voice: string;
  language: string;
  sampleRate: number;
  text: string;
  timeoutMs: number;
}

function getConfig(): ProbeConfig {
  const wsUrl = process.env.ORPHEUS_TTS_PROBE_URL?.trim();
  const authToken = process.env.ORPHEUS_TTS_AUTH_TOKEN?.trim();

  if (!wsUrl) {
    throw new Error('ORPHEUS_TTS_PROBE_URL is required');
  }
  if (!authToken) {
    throw new Error('ORPHEUS_TTS_AUTH_TOKEN is required');
  }

  return {
    wsUrl,
    authToken,
    voice: process.env.ORPHEUS_TTS_PROBE_VOICE?.trim() || 'austin',
    language: process.env.ORPHEUS_TTS_PROBE_LANGUAGE?.trim() || 'en',
    sampleRate: Number(process.env.ORPHEUS_TTS_PROBE_SAMPLE_RATE || 8000),
    text:
      process.env.ORPHEUS_TTS_PROBE_TEXT?.trim() ||
      '[warm] I understand how frustrating that feels. [pause] Let me help with that right now.',
    timeoutMs: Number(process.env.ORPHEUS_TTS_PROBE_TIMEOUT_MS || 15000),
  };
}

function rawMessageToBuffer(
  data: Parameters<WebSocket['on']>[1] extends never ? never : unknown,
): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((entry) => Buffer.from(entry)));
  }
  return Buffer.from(String(data));
}

async function run(): Promise<void> {
  const config = getConfig();
  const url = new URL(config.wsUrl);
  url.searchParams.set('voice', config.voice);
  url.searchParams.set('language', config.language);
  url.searchParams.set('sampleRate', String(config.sampleRate));
  url.searchParams.set('call_sid', 'probe-call');

  const startedAt = Date.now();
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${config.authToken}`,
      },
    });

    const timer = setTimeout(() => {
      ws.close();
      reject(
        new Error(`Timed out after ${config.timeoutMs}ms waiting for Orpheus streaming probe`),
      );
    }, config.timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ command: 'connect' }));
      ws.send(JSON.stringify({ command: 'send', text: config.text }));
      ws.send(JSON.stringify({ command: 'flush' }));
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        return;
      }
      chunks.push(rawMessageToBuffer(data));
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (chunks.length === 0) {
        reject(new Error('Probe completed without receiving any binary audio frames'));
        return;
      }
      const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      log.info('Orpheus custom TTS streaming probe passed', {
        wsUrl: url.toString(),
        frames: chunks.length,
        totalBytes,
        elapsedMs: Date.now() - startedAt,
      });
      resolve();
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

run().catch((err) => {
  log.error('Orpheus custom TTS streaming probe failed', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
