import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chunkOrpheusInput,
  ORPHEUS_DEFAULT_MODEL,
  ORPHEUS_DEFAULT_VOICE,
  ORPHEUS_TELEPHONY_SAMPLE_RATE,
  prepareOrpheusInputText,
  resamplePcm16Mono,
  synthesizeOrpheusPcm,
  synthesizeOrpheusSpeech,
  synthesizeOrpheusSpeechStream,
} from '../../services/voice/orpheus-tts.js';

function createPcmWav(pcmBytes: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmBytes.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmBytes.length, 40);
  return Buffer.concat([header, pcmBytes]);
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

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

function calculateRmsPcm(buffer: Buffer): number {
  const samples = buffer.length / 2;
  let sumSquares = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = buffer.readInt16LE(index * 2);
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares / Math.max(1, samples));
}

describe('orpheus-tts helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prepares Cartesia-style tagged text for Orpheus', () => {
    const prepared = prepareOrpheusInputText(
      '<emotion value="excited" />The St. Regis package is $14,200. <break time="600ms" /> <speed ratio="0.92" />One moment...',
    );

    expect(prepared).toContain('[excited]');
    expect(prepared).toContain('Saint Regis');
    expect(prepared).toContain('fourteen thousand two hundred dollars');
    expect(prepared).toContain('[slowly]');
    expect(prepared).not.toContain('<break');
  });

  it('chunks long text for Orpheus within the 200-character limit', () => {
    const prepared = prepareOrpheusInputText(
      'This is the first sentence. This is the second sentence with a bit more detail. This is the third sentence with even more detail so the total response definitely exceeds the maximum Groq Orpheus input limit for a single request.',
    );

    const chunks = chunkOrpheusInput(prepared);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
  });

  it('stitches multiple Orpheus WAV segments into one WAV response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => toArrayBuffer(createPcmWav(Buffer.from([1, 2, 3, 4]))),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => toArrayBuffer(createPcmWav(Buffer.from([5, 6, 7, 8]))),
      });
    vi.stubGlobal('fetch', fetchMock);

    const inputText = 'First chunk sentence. '.repeat(12);
    const result = await synthesizeOrpheusSpeech({
      apiKey: 'groq-key',
      voice: ORPHEUS_DEFAULT_VOICE,
      model: ORPHEUS_DEFAULT_MODEL,
      text: inputText,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.chunks).toHaveLength(2);
    expect(result.audio.toString('ascii', 0, 4)).toBe('RIFF');
    expect(result.audio.readUInt32LE(40)).toBe(8);
  });

  it('stitches multiple Orpheus WAV segments into one PCM payload with 24k metadata', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => toArrayBuffer(createPcmWav(Buffer.from([1, 2, 3, 4]))),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => toArrayBuffer(createPcmWav(Buffer.from([5, 6, 7, 8]))),
      });
    vi.stubGlobal('fetch', fetchMock);

    const inputText = 'First chunk sentence. '.repeat(12);
    const result = await synthesizeOrpheusPcm({
      apiKey: 'groq-key',
      voice: ORPHEUS_DEFAULT_VOICE,
      model: ORPHEUS_DEFAULT_MODEL,
      text: inputText,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.chunks).toHaveLength(2);
    expect(result.sampleRate).toBe(24_000);
    expect(result.bitsPerSample).toBe(16);
    expect(result.channels).toBe(1);
    expect(result.pcmData).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it('downsamples Orpheus PCM to telephony rate while preserving in-band audio', () => {
    const inBandPcm = createSinePcm(24_000, 1_000, 120);
    const downsampled = resamplePcm16Mono(inBandPcm, 24_000, ORPHEUS_TELEPHONY_SAMPLE_RATE);

    expect(downsampled.length).toBe(Math.round(inBandPcm.length / 3));
    expect(calculateRmsPcm(downsampled)).toBeGreaterThan(4_000);
  });

  it('attenuates above-nyquist audio while downsampling to telephony rate', () => {
    const aliasedInput = createSinePcm(24_000, 6_000, 120);
    const downsampled = resamplePcm16Mono(aliasedInput, 24_000, ORPHEUS_TELEPHONY_SAMPLE_RATE);

    expect(calculateRmsPcm(downsampled)).toBeLessThan(2_000);
  });

  it('streams a single Orpheus WAV segment progressively when the text fits one request', async () => {
    const wav = createPcmWav(Buffer.from([1, 2, 3, 4]));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': String(wav.length) }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(wav));
          controller.close();
        },
      }),
      arrayBuffer: async () => toArrayBuffer(wav),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await synthesizeOrpheusSpeechStream({
      apiKey: 'groq-key',
      voice: ORPHEUS_DEFAULT_VOICE,
      model: ORPHEUS_DEFAULT_MODEL,
      text: 'Short enough to stay in a single request.',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result?.chunks).toHaveLength(1);
    expect(result?.contentLength).toBe(wav.length);

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      result?.stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      result?.stream.on('end', () => resolve());
      result?.stream.on('error', reject);
    });

    expect(Buffer.concat(chunks)).toEqual(wav);
  });

  it('streams multiple Orpheus WAV segments as one progressive WAV response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => toArrayBuffer(createPcmWav(Buffer.from([1, 2, 3, 4]))),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => toArrayBuffer(createPcmWav(Buffer.from([5, 6, 7, 8]))),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await synthesizeOrpheusSpeechStream({
      apiKey: 'groq-key',
      voice: ORPHEUS_DEFAULT_VOICE,
      model: ORPHEUS_DEFAULT_MODEL,
      text: 'First chunk sentence. '.repeat(12),
    });

    expect(result.chunks).toHaveLength(2);
    expect(result.contentLength).toBeUndefined();

    const streamedChunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      result.stream.on('data', (chunk) => streamedChunks.push(Buffer.from(chunk)));
      result.stream.on('end', () => resolve());
      result.stream.on('error', reject);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const streamedWav = Buffer.concat(streamedChunks);
    expect(streamedWav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(streamedWav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(streamedWav.readUInt16LE(22)).toBe(1);
    expect(streamedWav.readUInt32LE(24)).toBe(24_000);
    expect(streamedWav.subarray(44)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  });
});
