/**
 * Whisper Transcription Provider
 *
 * Sends audio to a self-hosted faster-whisper HTTP service via POST request
 * to the `/asr` endpoint, receives structured transcription results.
 *
 * Key guarantees:
 * - `transcribe()` never throws — all errors are returned as `{ success: false, error }`
 * - `healthCheck()` never throws — connection failures return `{ ok: false }`
 * - All errors are logged with the `[WhisperTranscriber]` prefix
 */

import type { Readable } from 'stream';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('whisper-transcriber');

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_TIMEOUT_MS = 120_000;
const ENGINE_NAME = 'whisper';

/** Maximum audio file size in bytes before rejecting (100 MB). */
const MAX_AUDIO_SIZE_BYTES = 100 * 1024 * 1024;

// =============================================================================
// TYPES
// =============================================================================

export interface TranscriptionResult {
  /** Whether transcription succeeded */
  success: boolean;
  /** Transcribed text content */
  text: string | null;
  /** Detected or specified language (ISO 639-1) */
  language: string | null;
  /** Duration of the audio in seconds */
  durationSeconds: number;
  /** Timed segments of the transcription */
  segments: Array<{
    start: number;
    end: number;
    text: string;
    speaker?: string;
  }>;
  /** The transcription engine used */
  engine: string;
  /** Error message if transcription failed */
  error?: string;
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(params: {
    audioStream: Readable;
    mimeType: string;
    language?: string;
    options?: {
      diarization?: boolean;
      punctuation?: boolean;
      wordTimestamps?: boolean;
    };
  }): Promise<TranscriptionResult>;
  supportedFormats(): string[];
  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}

export interface WhisperTranscriberOptions {
  /** Whisper server URL (default from env WHISPER_URL or 'http://localhost:9000') */
  whisperUrl: string;
  /** Request timeout in ms (default 120000) */
  timeoutMs?: number;
}

/** Shape of the JSON response from the faster-whisper HTTP server */
interface WhisperServerResponse {
  text: string;
  segments?: Array<{
    start: number;
    end: number;
    text: string;
  }>;
  language: string;
  duration: number;
}

// =============================================================================
// SUPPORTED FORMATS
// =============================================================================

const SUPPORTED_FORMATS: readonly string[] = [
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'audio/x-m4a',
  'audio/webm',
] as const;

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class WhisperTranscriber implements TranscriptionProvider {
  readonly name = ENGINE_NAME;
  private readonly whisperUrl: string;
  private readonly timeoutMs: number;

  constructor(options: WhisperTranscriberOptions) {
    this.whisperUrl = options.whisperUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Transcribe audio by sending it to the faster-whisper HTTP server.
   *
   * Collects the readable stream into a buffer, sends a POST request
   * to `{whisperUrl}/asr` with form data, and returns the structured
   * transcription result.
   *
   * @returns Structured transcription result — never throws.
   */
  async transcribe(params: {
    audioStream: Readable;
    mimeType: string;
    language?: string;
    options?: {
      diarization?: boolean;
      punctuation?: boolean;
      wordTimestamps?: boolean;
    };
  }): Promise<TranscriptionResult> {
    const { audioStream, mimeType, language, options } = params;

    // 1. Check if MIME type is supported
    if (!this.isMimeTypeSupported(mimeType)) {
      return {
        success: false,
        text: null,
        language: null,
        durationSeconds: 0,
        segments: [],
        engine: ENGINE_NAME,
        error: `Unsupported MIME type: ${mimeType}`,
      };
    }

    // Log warnings for unsupported options
    if (options?.diarization) {
      log.warn('diarization option is not supported by faster-whisper provider');
    }
    if (options?.punctuation) {
      log.warn('punctuation option is not supported by faster-whisper provider');
    }

    try {
      // 2. Collect stream into buffer (needed for fetch body)
      const buffer = await this.collectStream(audioStream);

      // 2a. Validate payload size
      if (buffer.length > MAX_AUDIO_SIZE_BYTES) {
        return {
          success: false,
          text: null,
          language: null,
          durationSeconds: 0,
          segments: [],
          engine: ENGINE_NAME,
          error: `Audio file too large: ${buffer.length} bytes (max ${MAX_AUDIO_SIZE_BYTES})`,
        };
      }

      // 3. Build query parameters
      const queryParams = new URLSearchParams();
      queryParams.set('output', 'json');
      queryParams.set('language', language ?? 'auto');
      if (options?.wordTimestamps) {
        queryParams.set('word_timestamps', 'true');
      }

      // 4. Build form data with audio file
      const formData = new FormData();
      formData.append('audio_file', new Blob([buffer], { type: mimeType }));

      // 5. Send POST request to Whisper server
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      let response: Response;
      try {
        response = await fetch(`${this.whisperUrl}/asr?${queryParams.toString()}`, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      // 6. Check for server errors
      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown');
        const message = `Whisper server returned HTTP ${response.status}: ${errorBody}`;
        log.error('Whisper server error', { status: response.status, body: errorBody });
        return {
          success: false,
          text: null,
          language: null,
          durationSeconds: 0,
          segments: [],
          engine: ENGINE_NAME,
          error: message,
        };
      }

      // 7. Parse JSON response and validate shape
      const data = (await response.json()) as WhisperServerResponse;

      if (
        typeof data.text !== 'string' ||
        typeof data.language !== 'string' ||
        typeof data.duration !== 'number'
      ) {
        const message = 'Whisper server returned unexpected response shape';
        log.error(message, { responsePreview: JSON.stringify(data).slice(0, 200) });
        return {
          success: false,
          text: null,
          language: null,
          durationSeconds: 0,
          segments: [],
          engine: ENGINE_NAME,
          error: message,
        };
      }

      // 8. Map segments from server response
      const segments = Array.isArray(data.segments)
        ? data.segments.map((seg) => ({
            start: seg.start,
            end: seg.end,
            text: seg.text,
          }))
        : [];

      return {
        success: true,
        text: data.text,
        language: data.language,
        durationSeconds: data.duration,
        segments,
        engine: ENGINE_NAME,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Transcription failed', { error: message });

      return {
        success: false,
        text: null,
        language: null,
        durationSeconds: 0,
        segments: [],
        engine: ENGINE_NAME,
        error: message,
      };
    }
  }

  /**
   * Returns the list of audio MIME types supported by this transcriber.
   */
  supportedFormats(): string[] {
    return [...SUPPORTED_FORMATS];
  }

  /**
   * Check if the Whisper server is reachable by issuing a GET to `/health`.
   *
   * @returns Health status with latency — never throws.
   */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.whisperUrl}/health`, {
          method: 'GET',
          signal: controller.signal,
        });

        if (!response.ok) {
          log.error('Health check returned non-200', { status: response.status });
          return { ok: false, latencyMs: Date.now() - start };
        }

        return { ok: true, latencyMs: Date.now() - start };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Health check failed', { error: message });
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  /**
   * Check if a MIME type is in the supported list.
   */
  private isMimeTypeSupported(mimeType: string): boolean {
    return SUPPORTED_FORMATS.includes(mimeType);
  }

  /**
   * Collect a Readable stream into a single Buffer.
   */
  private collectStream(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err) => {
        stream.destroy();
        reject(err);
      });
    });
  }
}
