/**
 * Apache Tika HTTP Server Stub
 *
 * A minimal HTTP server that mimics the Apache Tika server's PUT /tika endpoint
 * for testing purposes. Allows tests to verify the TikaParser's HTTP
 * integration without requiring Docker or a real Tika server.
 *
 * Protocol (matches real Tika server):
 * - PUT /tika: Accepts file body with Content-Type header, returns plain text
 * - GET /tika: Health check endpoint, returns 200 with server info
 *
 * The stub returns configurable text responses based on MIME type.
 */

import * as http from 'http';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default extracted text for known MIME types. */
const DEFAULT_RESPONSES: Record<string, string> = {
  'application/pdf': 'Extracted text from PDF document.\nPage 1 content here.',
  'application/msword': 'Extracted text from Word document.',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'Extracted text from DOCX document.',
  'text/plain': '', // For text/plain, Tika returns the content as-is
  'text/html': 'Extracted text from HTML page.',
  'text/csv': 'col1,col2\nval1,val2',
};

/** MIME types that Tika considers unsupported (returns 422). */
const UNSUPPORTED_TYPES = new Set([
  'application/octet-stream',
  'application/x-executable',
  'application/x-sharedlib',
]);

// =============================================================================
// TYPES
// =============================================================================

export interface TikaStubOptions {
  /**
   * Map of MIME type to extracted text response.
   * Overrides/extends the defaults.
   */
  responses?: Record<string, string>;

  /**
   * If set, the server will delay responses by this many milliseconds.
   * Useful for testing timeout handling.
   */
  responseDelayMs?: number;

  /**
   * If true, the server will respond with 500 to all PUT requests.
   * Useful for testing server error handling.
   */
  simulateServerError?: boolean;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class TikaStub {
  private server: http.Server | null = null;
  private readonly responses: Record<string, string>;
  private responseDelayMs: number;
  private simulateServerError: boolean;

  /** The port the stub is listening on. Only valid after `start()` resolves. */
  port = 0;

  constructor(options?: TikaStubOptions) {
    this.responses = { ...DEFAULT_RESPONSES, ...options?.responses };
    this.responseDelayMs = options?.responseDelayMs ?? 0;
    this.simulateServerError = options?.simulateServerError ?? false;
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
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // GET /tika — health check
    if (method === 'GET' && url === '/tika') {
      this.maybeDelay(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('This is Tika Server (stub). Please PUT\n');
      });
      return;
    }

    // PUT /tika — document parsing
    if (method === 'PUT' && url === '/tika') {
      this.handlePutTika(req, res);
      return;
    }

    // Anything else — 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private handlePutTika(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Collect the request body (we don't use it for generating response,
    // but we must consume it to avoid hanging)
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

        const contentType = req.headers['content-type'] ?? 'application/octet-stream';

        // Check for unsupported MIME types
        if (UNSUPPORTED_TYPES.has(contentType)) {
          res.writeHead(422, { 'Content-Type': 'text/plain' });
          res.end(`Unprocessable Entity: unsupported media type ${contentType}`);
          return;
        }

        // For text/plain, return the body as-is (Tika behavior)
        if (contentType === 'text/plain') {
          const body = Buffer.concat(chunks).toString('utf-8');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(body);
          return;
        }

        // Look up the configured response for this MIME type
        const responseText = this.responses[contentType];
        if (responseText !== undefined) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(responseText);
          return;
        }

        // Unknown but not explicitly unsupported — return empty text (Tika behavior)
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('');
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
