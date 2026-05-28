/**
 * Apache Tika Document Parser
 *
 * Sends files to an Apache Tika server running in HTTP mode via PUT request
 * to the `/tika` endpoint, receives extracted plain text.
 *
 * Key guarantees:
 * - `parse()` never throws — all errors are returned as `{ success: false, error }`
 * - `healthCheck()` never throws — connection failures return `{ ok: false }`
 * - All errors are logged with the `[TikaParser]` prefix
 */

import type { Readable } from 'stream';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('tika-parser');

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONTENT_LENGTH = 10_485_760; // 10MB of text
const ENGINE_NAME = 'tika';

// =============================================================================
// TYPES
// =============================================================================

export interface DocumentParseResult {
  /** Whether parsing succeeded */
  success: boolean;
  /** Extracted text content */
  text: string | null;
  /** Number of characters extracted */
  characterCount: number;
  /** The parsing engine used */
  engine: string;
  /** Error message if parsing failed */
  error?: string;
}

export interface DocumentParser {
  readonly name: string;
  parse(params: {
    fileStream: Readable;
    mimeType: string;
    filename: string;
    sizeBytes: number;
  }): Promise<DocumentParseResult>;
  supportedMimeTypes(): string[];
  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}

export interface TikaParserOptions {
  /** Tika server URL (default from env TIKA_URL or 'http://localhost:9998') */
  tikaUrl: string;
  /** Request timeout in ms (default 30000) */
  timeoutMs?: number;
  /** Maximum content length to accept (default 10MB of text) */
  maxContentLength?: number;
}

// =============================================================================
// SUPPORTED MIME TYPES
// =============================================================================

const SUPPORTED_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/rtf',
  'text/plain',
  'text/html',
  'text/csv',
  'text/markdown',
] as const;

const LOCAL_TEXT_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv']);

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class TikaParser implements DocumentParser {
  readonly name = ENGINE_NAME;
  private readonly tikaUrl: string;
  private readonly timeoutMs: number;
  private readonly maxContentLength: number;

  constructor(options: TikaParserOptions) {
    this.tikaUrl = options.tikaUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxContentLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
  }

  /**
   * Parse a document by sending it to the Tika HTTP server.
   *
   * Collects the readable stream into a buffer, sends a PUT request
   * to `{tikaUrl}/tika`, and returns the extracted plain text.
   *
   * @returns Structured parse result — never throws.
   */
  async parse(params: {
    fileStream: Readable;
    mimeType: string;
    filename: string;
    sizeBytes: number;
  }): Promise<DocumentParseResult> {
    const { fileStream, mimeType, filename } = params;

    // 1. Check if MIME type is supported
    if (!this.isMimeTypeSupported(mimeType)) {
      return {
        success: false,
        text: null,
        characterCount: 0,
        engine: ENGINE_NAME,
        error: `Unsupported MIME type: ${mimeType}`,
      };
    }

    try {
      // 2. Collect stream into buffer (needed for fetch body and local text extraction)
      const buffer = await this.collectStream(fileStream);

      if (LOCAL_TEXT_MIME_TYPES.has(mimeType)) {
        let text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
        if (text.length > this.maxContentLength) {
          text = text.slice(0, this.maxContentLength);
        }

        return {
          success: true,
          text,
          characterCount: text.length,
          engine: ENGINE_NAME,
        };
      }

      // 3. Send PUT request to Tika
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      let response: Response;
      try {
        response = await fetch(`${this.tikaUrl}/tika`, {
          method: 'PUT',
          headers: {
            'Content-Type': mimeType,
            Accept: 'text/plain',
          },
          body: buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength,
          ) as ArrayBuffer,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      // 4. Check for server errors
      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown');
        const message = `Tika server returned HTTP ${response.status} for "${filename}": ${errorBody}`;
        log.error('Tika server error', { status: response.status, filename, body: errorBody });
        return {
          success: false,
          text: null,
          characterCount: 0,
          engine: ENGINE_NAME,
          error: message,
        };
      }

      // 5. Read response text
      let text = await response.text();

      // 6. Truncate to maxContentLength if needed
      if (text.length > this.maxContentLength) {
        text = text.slice(0, this.maxContentLength);
      }

      return {
        success: true,
        text,
        characterCount: text.length,
        engine: ENGINE_NAME,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Parse failed', { filename, error: message });

      return {
        success: false,
        text: null,
        characterCount: 0,
        engine: ENGINE_NAME,
        error: message,
      };
    }
  }

  /**
   * Returns the list of MIME types supported by this parser.
   */
  supportedMimeTypes(): string[] {
    return [...SUPPORTED_MIME_TYPES];
  }

  /**
   * Check if the Tika server is reachable by issuing a GET to `/tika`.
   *
   * @returns Health status with latency — never throws.
   */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.tikaUrl}/tika`, {
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
    return SUPPORTED_MIME_TYPES.includes(mimeType);
  }

  /**
   * Collect a Readable stream into a single Buffer.
   */
  private collectStream(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }
}
