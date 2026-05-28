import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const mockResolveOrpheusServiceConfig = vi.fn();
const mockSynthesizeOrpheusPcm = vi.fn();

vi.mock('../../services/voice/orpheus-service-instance-resolver.js', () => ({
  resolveOrpheusServiceConfig: (...args: unknown[]) => mockResolveOrpheusServiceConfig(...args),
}));

vi.mock('../../services/voice/orpheus-tts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/voice/orpheus-tts.js')>();
  return {
    ...actual,
    synthesizeOrpheusPcm: (...args: unknown[]) => mockSynthesizeOrpheusPcm(...args),
  };
});

function createSinePcm(
  sampleRate: number,
  frequencyHz: number,
  durationMs: number,
  amplitude = 12_000,
): Buffer {
  const sampleCount = Math.round((sampleRate * durationMs) / 1000);
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(
      amplitude * Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate),
    );
    pcm.writeInt16LE(value, index * 2);
  }
  return pcm;
}

function parseWavHeader(audio: Buffer): {
  riff: string;
  format: string;
  channels: number;
  sampleRate: number;
  byteRate: number;
  bitsPerSample: number;
  dataSize: number;
} {
  return {
    riff: audio.toString('ascii', 0, 4),
    format: audio.toString('ascii', 8, 12),
    channels: audio.readUInt16LE(22),
    sampleRate: audio.readUInt32LE(24),
    byteRate: audio.readUInt32LE(28),
    bitsPerSample: audio.readUInt16LE(34),
    dataSize: audio.readUInt32LE(40),
  };
}

async function createTestServer() {
  const app = express();
  app.use(express.json());

  const routerModule = await import('../../routes/custom-tts.js');
  app.use('/api/v1/voice/custom-tts', routerModule.default);

  return await new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${address.port}`, server });
    });
  });
}

describe('custom-tts Orpheus route', () => {
  const originalEnv = { ...process.env };
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    ({ baseUrl, server } = await createTestServer());
  });

  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, ORPHEUS_TTS_AUTH_TOKEN: 'route-token' };
    mockResolveOrpheusServiceConfig.mockResolvedValue({
      apiKey: 'groq-key',
      model: 'canopylabs/orpheus-v1-english',
      voice: 'hannah',
      source: 'environment',
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects unauthorized buffered requests', async () => {
    const response = await fetch(`${baseUrl}/api/v1/voice/custom-tts/orpheus`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'Hello there' }),
    });

    expect(response.status).toBe(403);
    expect(mockSynthesizeOrpheusPcm).not.toHaveBeenCalled();
  });

  it('returns an 8k telephony-safe WAV for buffered Orpheus responses', async () => {
    mockSynthesizeOrpheusPcm.mockResolvedValue({
      pcmData: createSinePcm(24_000, 1_000, 100),
      sampleRate: 24_000,
      bitsPerSample: 16,
      channels: 1,
      normalizedText: 'Welcome. I am Elena.',
      chunks: ['Welcome. I am Elena.'],
    });

    const response = await fetch(`${baseUrl}/api/v1/voice/custom-tts/orpheus`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer route-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: 'Welcome. I am Elena.',
        voice: 'hannah',
        call_sid: 'call-1',
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('audio/wav');
    expect(response.headers.get('x-orpheus-mode')).toBe('buffered');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');

    const audio = Buffer.from(await response.arrayBuffer());
    expect(audio.length).toBeGreaterThan(44);

    const header = parseWavHeader(audio);
    expect(header.riff).toBe('RIFF');
    expect(header.format).toBe('WAVE');
    expect(header.channels).toBe(1);
    expect(header.sampleRate).toBe(8_000);
    expect(header.byteRate).toBe(16_000);
    expect(header.bitsPerSample).toBe(16);
    expect(header.dataSize).toBe(audio.length - 44);
  });
});
