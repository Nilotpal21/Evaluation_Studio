/**
 * Whisper (faster-whisper) HTTP Server Stub
 *
 * A minimal HTTP server that mimics the faster-whisper HTTP server's
 * POST /asr endpoint for testing purposes. Allows tests to verify the
 * WhisperTranscriber's HTTP integration without requiring Docker or a
 * real Whisper server.
 *
 * Protocol (matches faster-whisper server):
 * - POST /asr?output=json&language=auto: Accepts multipart form data with
 *   audio_file field, returns JSON transcription result
 * - GET /health: Health check endpoint, returns 200
 *
 * The stub returns configurable transcription responses.
 */

import * as http from 'http';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default transcription response for valid audio. */
const DEFAULT_TRANSCRIPTION = {
  text: 'Hello, this is a test transcription.',
  segments: [
    { start: 0.0, end: 2.5, text: 'Hello, this is' },
    { start: 2.5, end: 5.0, text: 'a test transcription.' },
  ],
  language: 'en',
  duration: 5.0,
};

// =============================================================================
// TYPES
// =============================================================================

export interface WhisperTranscriptionResponse {
  text: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  language: string;
  duration: number;
}

export interface WhisperStubOptions {
  /**
   * The transcription response to return for valid requests.
   * Defaults to a standard test transcription.
   */
  transcription?: WhisperTranscriptionResponse;

  /**
   * If set, the server will delay responses by this many milliseconds.
   * Useful for testing timeout handling.
   */
  responseDelayMs?: number;

  /**
   * If true, the server will respond with 500 to all POST requests.
   * Useful for testing server error handling.
   */
  simulateServerError?: boolean;

  /**
   * MIME types that should trigger a 400 Bad Request response.
   * Useful for testing invalid audio format handling.
   * Note: The WhisperTranscriber validates MIME types client-side before
   * sending, so this is mainly for edge-case testing.
   */
  rejectedMimeTypes?: string[];
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class WhisperStub {
  private server: http.Server | null = null;
  private readonly transcription: WhisperTranscriptionResponse;
  private responseDelayMs: number;
  private simulateServerError: boolean;
  private readonly rejectedMimeTypes: Set<string>;

  /** The port the stub is listening on. Only valid after `start()` resolves. */
  port = 0;

  constructor(options?: WhisperStubOptions) {
    this.transcription = options?.transcription ?? DEFAULT_TRANSCRIPTION;
    this.responseDelayMs = options?.responseDelayMs ?? 0;
    this.simulateServerError = options?.simulateServerError ?? false;
    this.rejectedMimeTypes = new Set(options?.rejectedMimeTypes ?? []);
  }

  /**
   * Start the HTTP server on a random available port.
   * Resolves once the server is listening.
   */
  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (err) => {
        reject(err);
      });

      // Listen on port 0 for OS-assigned random port
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (addr && typeof addr !== 'string') {
          this.port = addr.port;
        }
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server.
   */
  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Set response delay at runtime (for mid-test timeout scenarios).
   */
  setResponseDelayMs(delayMs: number): void {
    this.responseDelayMs = delayMs;
  }

  /**
   * Toggle server error simulation at runtime.
   */
  setSimulateServerError(value: boolean): void {
    this.simulateServerError = value;
  }

  /**
   * Get the base URL the stub is listening on.
   */
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsedUrl = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const method = req.method ?? 'GET';

    // GET /health — health check
    if (method === 'GET' && parsedUrl.pathname === '/health') {
      this.maybeDelay(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
      return;
    }

    // POST /asr — transcription
    if (method === 'POST' && parsedUrl.pathname === '/asr') {
      this.handlePostAsr(req, res);
      return;
    }

    // Anything else — 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private handlePostAsr(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Collect the request body to consume it (multipart form data)
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));

    req.on('end', () => {
      this.maybeDelay(() => {
        // Simulate server error
        if (this.simulateServerError) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
          return;
        }

        // Check if the content type in the multipart body matches a rejected type
        // We inspect the raw body for the MIME type boundary
        const body = Buffer.concat(chunks);
        const bodyStr = body.toString('utf-8');

        for (const rejectedType of this.rejectedMimeTypes) {
          if (bodyStr.includes(rejectedType)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Unsupported audio format: ${rejectedType}` }));
            return;
          }
        }

        // Return the configured transcription response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.transcription));
      });
    });

    req.on('error', () => {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
    });
  }

  /**
   * Execute a callback with optional delay.
   */
  private maybeDelay(fn: () => void): void {
    if (this.responseDelayMs > 0) {
      setTimeout(fn, this.responseDelayMs);
    } else {
      fn();
    }
  }
}
