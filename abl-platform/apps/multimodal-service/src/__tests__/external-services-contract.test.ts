/**
 * External Services Contract Tests
 *
 * Verifies that each test double (ClamAV, Tika, Whisper, FFmpeg) faithfully
 * implements the protocol contract expected by the corresponding production
 * client. Tests start real stub servers, connect the real service client code
 * to them, and verify end-to-end interaction.
 *
 * - ClamAV: TCP stub tested via raw TCP client (same INSTREAM protocol
 *   that the `clamscan` npm package uses)
 * - Tika: HTTP stub tested via the real `TikaParser` class
 * - Whisper: HTTP stub tested via the real `WhisperTranscriber` class
 * - FFmpeg: Test double tested via the `VideoProcessor` interface
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Readable } from 'stream';
import * as net from 'net';

import { ClamAVStub } from './helpers/clamav-stub.js';
import { TikaStub } from './helpers/tika-stub.js';
import { WhisperStub } from './helpers/whisper-stub.js';
import { FFmpegTestDouble } from './helpers/ffmpeg-test-double.js';
import { TikaParser } from '../processing/document-parser-tika.js';
import { WhisperTranscriber } from '../processing/transcriber-whisper.js';

// =============================================================================
// HELPERS
// =============================================================================

function createReadableStream(content: string | Buffer): Readable {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  return Readable.from(buf);
}

/**
 * Send data to a ClamAV daemon using the INSTREAM protocol over raw TCP.
 * This mimics what the `clamscan` npm package does internally.
 *
 * Protocol:
 * 1. Send `zINSTREAM\0`
 * 2. Send data chunks: [4-byte big-endian length][data]
 * 3. Send terminator: `\x00\x00\x00\x00`
 * 4. Read response line
 */
function sendClamAVInstream(host: string, port: number, data: Buffer): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = new net.Socket();
    let response = '';

    socket.connect(port, host, () => {
      // 1. Send INSTREAM command
      socket.write('zINSTREAM\0');

      // 2. Send data chunk with 4-byte big-endian length prefix
      const lengthBuf = Buffer.alloc(4);
      lengthBuf.writeUInt32BE(data.length, 0);
      socket.write(lengthBuf);
      socket.write(data);

      // 3. Send zero-length terminator
      const terminator = Buffer.alloc(4, 0);
      socket.write(terminator);
    });

    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf-8');
    });

    socket.on('end', () => {
      resolve(response);
    });

    socket.on('error', (err) => {
      reject(err);
    });

    // Safety timeout
    socket.setTimeout(5000, () => {
      socket.destroy(new Error('ClamAV client timed out'));
    });
  });
}

// =============================================================================
// ClamAV Contract Tests
// =============================================================================

describe('ClamAV Stub Contract', () => {
  let stub: ClamAVStub;

  beforeAll(async () => {
    stub = new ClamAVStub();
    await stub.start();
  });

  afterAll(async () => {
    await stub.stop();
  });

  it('returns OK for clean file content', async () => {
    const data = Buffer.from('This is a perfectly safe file content.');
    const response = await sendClamAVInstream('127.0.0.1', stub.port, data);

    // ClamAV protocol: "stream: OK\0" for clean files
    expect(response).toContain('stream: OK');
  });

  it('returns FOUND for content matching the EICAR test signature', async () => {
    // EICAR test string (standard antivirus test pattern)
    const eicarContent = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    const response = await sendClamAVInstream('127.0.0.1', stub.port, eicarContent);

    // ClamAV protocol: "stream: <virus_name> FOUND\0" for infected files
    expect(response).toContain('FOUND');
    expect(response).toContain('Eicar-Signature');
  });

  it('handles connection error gracefully when stub simulates errors', async () => {
    const errorStub = new ClamAVStub({ simulateConnectionError: true });
    await errorStub.start();

    try {
      // The stub will destroy connections immediately, causing an error
      await expect(
        sendClamAVInstream('127.0.0.1', errorStub.port, Buffer.from('test')),
      ).rejects.toThrow();
    } finally {
      await errorStub.stop();
    }
  });
});

// =============================================================================
// Tika Contract Tests
// =============================================================================

describe('Tika Stub Contract', () => {
  let stub: TikaStub;
  let parser: TikaParser;

  beforeAll(async () => {
    stub = new TikaStub({
      responses: {
        'application/pdf': 'This is extracted PDF text from the stub.',
      },
    });
    await stub.start();
    parser = new TikaParser({
      tikaUrl: stub.url,
      timeoutMs: 5000,
    });
  });

  afterAll(async () => {
    await stub.stop();
  });

  afterEach(() => {
    stub.setSimulateServerError(false);
    stub.setResponseDelayMs(0);
  });

  it('parses a valid PDF document and returns extracted text', async () => {
    const result = await parser.parse({
      fileStream: createReadableStream('fake PDF binary content'),
      mimeType: 'application/pdf',
      filename: 'test.pdf',
      sizeBytes: 24,
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('This is extracted PDF text from the stub.');
    expect(result.characterCount).toBe(41);
    expect(result.engine).toBe('tika');
    expect(result.error).toBeUndefined();
  });

  it('returns error for unsupported MIME type without hitting the server', async () => {
    // TikaParser checks MIME types client-side before making the HTTP request.
    // 'application/x-sharedlib' is not in the SUPPORTED_MIME_TYPES list.
    const result = await parser.parse({
      fileStream: createReadableStream('binary content'),
      mimeType: 'application/x-sharedlib',
      filename: 'libtest.so',
      sizeBytes: 14,
    });

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(result.engine).toBe('tika');
    expect(result.error).toContain('Unsupported MIME type');
  });

  it('handles timeout by returning error result', async () => {
    // Set a response delay longer than the parser's timeout
    stub.setResponseDelayMs(10_000);

    const shortTimeoutParser = new TikaParser({
      tikaUrl: stub.url,
      timeoutMs: 100, // Very short timeout
    });

    const consoleSpy = await import('vitest').then(({ vi }) =>
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    );

    const result = await shortTimeoutParser.parse({
      fileStream: createReadableStream('slow content'),
      mimeType: 'application/pdf',
      filename: 'slow.pdf',
      sizeBytes: 12,
    });

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(result.engine).toBe('tika');
    expect(result.error).toBeDefined();

    consoleSpy.mockRestore();
    stub.setResponseDelayMs(0);
  });
});

// =============================================================================
// Whisper Contract Tests
// =============================================================================

describe('Whisper Stub Contract', () => {
  let stub: WhisperStub;
  let transcriber: WhisperTranscriber;

  beforeAll(async () => {
    stub = new WhisperStub({
      transcription: {
        text: 'Test transcription output.',
        segments: [
          { start: 0.0, end: 1.5, text: 'Test transcription' },
          { start: 1.5, end: 3.0, text: 'output.' },
        ],
        language: 'en',
        duration: 3.0,
      },
    });
    await stub.start();
    transcriber = new WhisperTranscriber({
      whisperUrl: stub.url,
      timeoutMs: 5000,
    });
  });

  afterAll(async () => {
    await stub.stop();
  });

  afterEach(() => {
    stub.setSimulateServerError(false);
    stub.setResponseDelayMs(0);
  });

  it('transcribes valid audio and returns structured result', async () => {
    const result = await transcriber.transcribe({
      audioStream: createReadableStream('fake audio WAV data'),
      mimeType: 'audio/wav',
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Test transcription output.');
    expect(result.language).toBe('en');
    expect(result.durationSeconds).toBe(3.0);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toEqual({ start: 0.0, end: 1.5, text: 'Test transcription' });
    expect(result.segments[1]).toEqual({ start: 1.5, end: 3.0, text: 'output.' });
    expect(result.engine).toBe('whisper');
    expect(result.error).toBeUndefined();
  });

  it('returns error for unsupported MIME type without hitting the server', async () => {
    // WhisperTranscriber checks MIME types client-side.
    // 'audio/x-custom' is not in the SUPPORTED_FORMATS list.
    const result = await transcriber.transcribe({
      audioStream: createReadableStream('invalid audio data'),
      mimeType: 'audio/x-custom',
    });

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(result.language).toBeNull();
    expect(result.durationSeconds).toBe(0);
    expect(result.segments).toEqual([]);
    expect(result.engine).toBe('whisper');
    expect(result.error).toContain('Unsupported MIME type');
  });

  it('handles timeout by returning error result', async () => {
    // Set a response delay longer than the transcriber's timeout
    stub.setResponseDelayMs(10_000);

    const shortTimeoutTranscriber = new WhisperTranscriber({
      whisperUrl: stub.url,
      timeoutMs: 100, // Very short timeout
    });

    const consoleSpy = await import('vitest').then(({ vi }) =>
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    );

    const result = await shortTimeoutTranscriber.transcribe({
      audioStream: createReadableStream('slow audio data'),
      mimeType: 'audio/wav',
    });

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(result.engine).toBe('whisper');
    expect(result.error).toBeDefined();

    consoleSpy.mockRestore();
    stub.setResponseDelayMs(0);
  });
});

// =============================================================================
// FFmpeg Contract Tests
// =============================================================================

describe('FFmpeg Test Double Contract', () => {
  let ffmpeg: FFmpegTestDouble;

  beforeAll(() => {
    ffmpeg = new FFmpegTestDouble({
      audioDurationSeconds: 15.0,
      frameCount: 5,
    });
  });

  afterEach(() => {
    ffmpeg.reset();
    ffmpeg.setExtractAudioError(undefined);
    ffmpeg.setExtractKeyFramesError(undefined);
  });

  it('extracts audio from a video stream with correct format and duration', async () => {
    const videoData = Buffer.from('fake video data for audio extraction');
    const result = await ffmpeg.extractAudio({
      videoStream: createReadableStream(videoData),
      outputFormat: 'wav',
    });

    expect(result.success).toBe(true);
    expect(result.format).toBe('wav');
    expect(result.durationSeconds).toBe(15.0);
    expect(result.audioStream).toBeDefined();
    expect(result.error).toBeUndefined();

    // Verify the audio stream is readable
    const chunks: Buffer[] = [];
    for await (const chunk of result.audioStream!) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const audioBuffer = Buffer.concat(chunks);
    expect(audioBuffer.length).toBeGreaterThan(0);

    // Verify the call was recorded
    expect(ffmpeg.extractAudioCalls).toHaveLength(1);
    expect(ffmpeg.extractAudioCalls[0].params.outputFormat).toBe('wav');
  });

  it('extracts key frames with correct count, timestamps, and PNG headers', async () => {
    const videoData = Buffer.from('fake video data for frame extraction');
    const result = await ffmpeg.extractKeyFrames({
      videoStream: createReadableStream(videoData),
      strategy: 'interval',
      maxFrames: 3,
      intervalSeconds: 2,
    });

    expect(result.success).toBe(true);
    expect(result.frames).toHaveLength(3);
    expect(result.timestamps).toHaveLength(3);
    expect(result.totalFramesExtracted).toBe(3);
    expect(result.error).toBeUndefined();

    // Verify timestamps are based on interval
    expect(result.timestamps).toEqual([0, 2, 4]);

    // Verify each frame starts with a valid PNG header
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const frame of result.frames) {
      expect(frame.subarray(0, 8)).toEqual(pngHeader);
    }

    // Verify the call was recorded
    expect(ffmpeg.extractKeyFramesCalls).toHaveLength(1);
    expect(ffmpeg.extractKeyFramesCalls[0].params.strategy).toBe('interval');
  });

  it('returns error result for invalid input parameters', async () => {
    // Test with invalid maxFrames (0)
    const videoData = Buffer.from('fake video data');
    const result = await ffmpeg.extractKeyFrames({
      videoStream: createReadableStream(videoData),
      strategy: 'interval',
      maxFrames: 0,
      intervalSeconds: 1,
    });

    expect(result.success).toBe(false);
    expect(result.frames).toEqual([]);
    expect(result.timestamps).toEqual([]);
    expect(result.totalFramesExtracted).toBe(0);
    expect(result.error).toContain('maxFrames must be positive');
  });
});
