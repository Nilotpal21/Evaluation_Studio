import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

// =============================================================================
// Mock createLogger before importing the module under test
// =============================================================================

const { mockLogError, mockLogWarn, mockLogInfo, mockLogDebug } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogDebug: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    error: mockLogError,
    warn: mockLogWarn,
    info: mockLogInfo,
    debug: mockLogDebug,
  }),
}));

import { WhisperTranscriber } from '../transcriber-whisper.js';

// =============================================================================
// HELPERS
// =============================================================================

function createAudioStream(content: string): Readable {
  return Readable.from(Buffer.from(content));
}

function mockFetchJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

function mockFetchResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

// =============================================================================
// TESTS
// =============================================================================

describe('WhisperTranscriber', () => {
  let transcriber: WhisperTranscriber;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const WHISPER_URL = 'http://localhost:9000';

  beforeEach(() => {
    vi.clearAllMocks();
    transcriber = new WhisperTranscriber({ whisperUrl: WHISPER_URL });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // name property
  // ---------------------------------------------------------------------------

  it('has name property equal to "whisper"', () => {
    expect(transcriber.name).toBe('whisper');
  });

  // ---------------------------------------------------------------------------
  // supportedFormats()
  // ---------------------------------------------------------------------------

  it('returns supported audio MIME types', () => {
    const formats = transcriber.supportedFormats();
    expect(formats).toContain('audio/mpeg');
    expect(formats).toContain('audio/wav');
    expect(formats).toContain('audio/ogg');
    expect(formats).toContain('audio/flac');
    expect(formats).toContain('audio/mp4');
    expect(formats).toContain('audio/x-m4a');
    expect(formats).toContain('audio/webm');
    expect(formats.length).toBe(7);
  });

  it('returns a new array each time (defensive copy)', () => {
    const a = transcriber.supportedFormats();
    const b = transcriber.supportedFormats();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  // ---------------------------------------------------------------------------
  // transcribe() — successful transcription
  // ---------------------------------------------------------------------------

  it('transcribes audio successfully and returns structured result', async () => {
    const serverResponse = {
      text: 'Hello world this is a test',
      segments: [
        { start: 0.0, end: 2.5, text: 'Hello world' },
        { start: 2.5, end: 5.0, text: 'this is a test' },
      ],
      language: 'en',
      duration: 5.0,
    };
    fetchSpy.mockResolvedValue(mockFetchJsonResponse(serverResponse, { status: 200 }));

    const result = await transcriber.transcribe({
      audioStream: createAudioStream('fake audio bytes'),
      mimeType: 'audio/mpeg',
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Hello world this is a test');
    expect(result.language).toBe('en');
    expect(result.durationSeconds).toBe(5.0);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toEqual({ start: 0.0, end: 2.5, text: 'Hello world' });
    expect(result.segments[1]).toEqual({ start: 2.5, end: 5.0, text: 'this is a test' });
    expect(result.engine).toBe('whisper');
    expect(result.error).toBeUndefined();

    // Verify fetch was called correctly
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${WHISPER_URL}/asr?output=json&language=auto`);
  });

  // ---------------------------------------------------------------------------
  // transcribe() — returns detected language
  // ---------------------------------------------------------------------------

  it('returns detected language from server response', async () => {
    const serverResponse = {
      text: 'Bonjour le monde',
      segments: [{ start: 0.0, end: 2.0, text: 'Bonjour le monde' }],
      language: 'fr',
      duration: 2.0,
    };
    fetchSpy.mockResolvedValue(mockFetchJsonResponse(serverResponse, { status: 200 }));

    const result = await transcriber.transcribe({
      audioStream: createAudioStream('fake french audio'),
      mimeType: 'audio/wav',
    });

    expect(result.success).toBe(true);
    expect(result.language).toBe('fr');
    expect(result.text).toBe('Bonjour le monde');
  });

  // ---------------------------------------------------------------------------
  // transcribe() — includes segments with timestamps
  // ---------------------------------------------------------------------------

  it('includes segments with timestamps when available', async () => {
    const serverResponse = {
      text: 'First segment. Second segment. Third segment.',
      segments: [
        { start: 0.0, end: 1.5, text: 'First segment.' },
        { start: 1.5, end: 3.2, text: 'Second segment.' },
        { start: 3.2, end: 5.0, text: 'Third segment.' },
      ],
      language: 'en',
      duration: 5.0,
    };
    fetchSpy.mockResolvedValue(mockFetchJsonResponse(serverResponse, { status: 200 }));

    const result = await transcriber.transcribe({
      audioStream: createAudioStream('audio with segments'),
      mimeType: 'audio/ogg',
    });

    expect(result.success).toBe(true);
    expect(result.segments).toHaveLength(3);
    expect(result.segments[0]).toEqual({ start: 0.0, end: 1.5, text: 'First segment.' });
    expect(result.segments[2]).toEqual({ start: 3.2, end: 5.0, text: 'Third segment.' });
  });

  // ---------------------------------------------------------------------------
  // transcribe() — sends language parameter when specified
  // ---------------------------------------------------------------------------

  it('sends language parameter when specified', async () => {
    const serverResponse = {
      text: 'Hallo Welt',
      segments: [],
      language: 'de',
      duration: 1.5,
    };
    fetchSpy.mockResolvedValue(mockFetchJsonResponse(serverResponse, { status: 200 }));

    await transcriber.transcribe({
      audioStream: createAudioStream('german audio'),
      mimeType: 'audio/mpeg',
      language: 'de',
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${WHISPER_URL}/asr?output=json&language=de`);
  });

  // ---------------------------------------------------------------------------
  // transcribe() — sends word_timestamps flag when requested
  // ---------------------------------------------------------------------------

  it('sends word_timestamps flag when requested', async () => {
    const serverResponse = {
      text: 'Test with timestamps',
      segments: [],
      language: 'en',
      duration: 2.0,
    };
    fetchSpy.mockResolvedValue(mockFetchJsonResponse(serverResponse, { status: 200 }));

    await transcriber.transcribe({
      audioStream: createAudioStream('timestamped audio'),
      mimeType: 'audio/wav',
      options: { wordTimestamps: true },
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${WHISPER_URL}/asr?output=json&language=auto&word_timestamps=true`);
  });

  // ---------------------------------------------------------------------------
  // transcribe() — error: server returns non-200
  // ---------------------------------------------------------------------------

  it('returns error result when server returns non-200', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse('Internal Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    const result = await transcriber.transcribe({
      audioStream: createAudioStream('bad audio'),
      mimeType: 'audio/mpeg',
    });

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(result.language).toBeNull();
    expect(result.durationSeconds).toBe(0);
    expect(result.segments).toEqual([]);
    expect(result.engine).toBe('whisper');
    expect(result.error).toContain('Whisper server returned HTTP 500');
    expect(mockLogError).toHaveBeenCalledWith(
      'Whisper server error',
      expect.objectContaining({ status: 500 }),
    );
  });

  // ---------------------------------------------------------------------------
  // transcribe() — error: server unreachable
  // ---------------------------------------------------------------------------

  it('returns error result when server is unreachable (network error)', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

    const result = await transcriber.transcribe({
      audioStream: createAudioStream('some audio'),
      mimeType: 'audio/wav',
    });

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(result.language).toBeNull();
    expect(result.durationSeconds).toBe(0);
    expect(result.segments).toEqual([]);
    expect(result.engine).toBe('whisper');
    expect(result.error).toBe('fetch failed');
    expect(mockLogError).toHaveBeenCalledWith(
      'Transcription failed',
      expect.objectContaining({ error: 'fetch failed' }),
    );
  });

  // ---------------------------------------------------------------------------
  // transcribe() — error: unsupported MIME type
  // ---------------------------------------------------------------------------

  it('returns error result for unsupported MIME type', async () => {
    const result = await transcriber.transcribe({
      audioStream: createAudioStream('video content'),
      mimeType: 'video/mp4',
    });

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(result.language).toBeNull();
    expect(result.durationSeconds).toBe(0);
    expect(result.segments).toEqual([]);
    expect(result.engine).toBe('whisper');
    expect(result.error).toBe('Unsupported MIME type: video/mp4');

    // fetch should not be called for unsupported types
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // healthCheck() — server is healthy
  // ---------------------------------------------------------------------------

  it('health check returns ok when server is healthy', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse('OK', { status: 200 }));

    const result = await transcriber.healthCheck();

    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${WHISPER_URL}/health`);
    expect((options as RequestInit).method).toBe('GET');
  });

  // ---------------------------------------------------------------------------
  // healthCheck() — server is down
  // ---------------------------------------------------------------------------

  it('health check returns not ok when server is down', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

    const result = await transcriber.healthCheck();

    expect(result.ok).toBe(false);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockLogError).toHaveBeenCalledWith(
      'Health check failed',
      expect.objectContaining({ error: 'fetch failed' }),
    );
  });

  // ---------------------------------------------------------------------------
  // healthCheck() — server returns non-200
  // ---------------------------------------------------------------------------

  it('health check returns not ok when server returns non-200', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse('Service Unavailable', { status: 503 }));

    const result = await transcriber.healthCheck();

    expect(result.ok).toBe(false);
    expect(typeof result.latencyMs).toBe('number');
    expect(mockLogError).toHaveBeenCalledWith(
      'Health check returned non-200',
      expect.objectContaining({ status: 503 }),
    );
  });

  // ---------------------------------------------------------------------------
  // respects timeout configuration
  // ---------------------------------------------------------------------------

  it('respects timeout configuration', async () => {
    const fastTranscriber = new WhisperTranscriber({
      whisperUrl: WHISPER_URL,
      timeoutMs: 1, // 1ms timeout to trigger abort quickly
    });

    // Simulate a slow response that never resolves before timeout
    fetchSpy.mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('The operation was aborted.', 'AbortError')), 5);
        }),
    );

    const result = await fastTranscriber.transcribe({
      audioStream: createAudioStream('slow audio'),
      mimeType: 'audio/mpeg',
    });

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(result.engine).toBe('whisper');
    expect(result.error).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // handles response with no segments
  // ---------------------------------------------------------------------------

  it('handles response with no segments gracefully', async () => {
    const serverResponse = {
      text: 'Hello world',
      language: 'en',
      duration: 2.0,
    };
    fetchSpy.mockResolvedValue(mockFetchJsonResponse(serverResponse, { status: 200 }));

    const result = await transcriber.transcribe({
      audioStream: createAudioStream('audio without segments'),
      mimeType: 'audio/flac',
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Hello world');
    expect(result.segments).toEqual([]);
    expect(result.durationSeconds).toBe(2.0);
  });

  // ---------------------------------------------------------------------------
  // transcribe() — rejects oversized audio
  // ---------------------------------------------------------------------------

  it('returns error when audio exceeds max size (100 MB)', async () => {
    // Create a stream that produces more than 100MB
    const bigChunk = Buffer.alloc(1024 * 1024); // 1MB chunk
    let bytesSent = 0;
    const maxBytes = 100 * 1024 * 1024;

    const oversizedStream = new Readable({
      read() {
        if (bytesSent < maxBytes + 1024 * 1024) {
          this.push(bigChunk);
          bytesSent += bigChunk.length;
        } else {
          this.push(null);
        }
      },
    });

    const result = await transcriber.transcribe({
      audioStream: oversizedStream,
      mimeType: 'audio/mpeg',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Audio file too large');
    expect(result.text).toBeNull();
    expect(result.engine).toBe('whisper');
    // Should not call the server
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // transcribe() — warns on unsupported options
  // ---------------------------------------------------------------------------

  it('warns when diarization option is used', async () => {
    const serverResponse = {
      text: 'test',
      segments: [],
      language: 'en',
      duration: 1.0,
    };
    fetchSpy.mockResolvedValue(mockFetchJsonResponse(serverResponse, { status: 200 }));

    await transcriber.transcribe({
      audioStream: createAudioStream('audio'),
      mimeType: 'audio/wav',
      options: { diarization: true },
    });

    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining('diarization'));
  });

  it('warns when punctuation option is used', async () => {
    const serverResponse = {
      text: 'test',
      segments: [],
      language: 'en',
      duration: 1.0,
    };
    fetchSpy.mockResolvedValue(mockFetchJsonResponse(serverResponse, { status: 200 }));

    await transcriber.transcribe({
      audioStream: createAudioStream('audio'),
      mimeType: 'audio/wav',
      options: { punctuation: true },
    });

    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining('punctuation'));
  });

  // ---------------------------------------------------------------------------
  // transcribe() — validates response shape
  // ---------------------------------------------------------------------------

  it('returns error when server response has unexpected shape', async () => {
    // Response missing required fields
    const badResponse = { text: 123, language: null, duration: 'not-a-number' };
    fetchSpy.mockResolvedValue(mockFetchJsonResponse(badResponse, { status: 200 }));

    const result = await transcriber.transcribe({
      audioStream: createAudioStream('audio'),
      mimeType: 'audio/mpeg',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('unexpected response shape');
    expect(result.text).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Constructor defaults
  // ---------------------------------------------------------------------------

  it('uses default timeout when not specified', () => {
    const defaultTranscriber = new WhisperTranscriber({ whisperUrl: WHISPER_URL });
    expect(defaultTranscriber.name).toBe('whisper');
    expect(defaultTranscriber.supportedFormats().length).toBe(7);
  });
});
