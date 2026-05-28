/**
 * Provider Action Server Harness for Testing
 *
 * An HTTP server that mimics a connector action API endpoint. Uses Node's
 * built-in http module (no Express dependency in this package). Listens on
 * a random port and records all incoming requests. Supports configurable
 * per-path responses and artificial delay for timeout testing.
 */

import http from 'http';

export interface ProviderServerHarness {
  readonly baseUrl: string;
  getRequests(): Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }>;
  setResponse(path: string, response: { status: number; body: unknown }): void;
  setDefaultDelay(ms: number): void;
  reset(): void;
  close(): Promise<void>;
}

export async function startProviderServerHarness(): Promise<ProviderServerHarness> {
  let requests: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  let customResponses = new Map<string, { status: number; body: unknown }>();
  let defaultDelayMs = 0;

  function sendResponse(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedBody: unknown,
  ): void {
    const path = req.url ?? '/';
    const method = req.method ?? 'GET';

    // Flatten headers to Record<string, string>
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ');
      }
    }

    // Record the request
    requests.push({ method, path, headers, body: parsedBody });

    const respond = () => {
      // Check for custom response for this path
      const custom = customResponses.get(path);
      if (custom) {
        sendResponse(res, custom.status, custom.body);
        return;
      }

      // Built-in routes
      if (path === '/echo' && method === 'POST') {
        sendResponse(res, 200, {
          echo: parsedBody,
          authHeader: headers.authorization ?? null,
        });
      } else if (path === '/error' && method === 'POST') {
        sendResponse(res, 500, { error: 'test-error' });
      } else {
        sendResponse(res, 404, { error: 'not_found' });
      }
    };

    if (defaultDelayMs > 0) {
      setTimeout(respond, defaultDelayMs);
    } else {
      respond();
    }
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      let parsedBody: unknown = null;
      const contentType = req.headers['content-type'] ?? '';
      if (body.length > 0 && contentType.includes('application/json')) {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          parsedBody = body;
        }
      } else if (body.length > 0) {
        parsedBody = body;
      }
      handleRequest(req, res, parsedBody);
    });
  });

  // Start listening on a random port
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const baseUrl = `http://localhost:${port}`;

  return {
    get baseUrl() {
      return baseUrl;
    },

    getRequests() {
      return [...requests];
    },

    setResponse(path, response) {
      customResponses.set(path, response);
    },

    setDefaultDelay(ms) {
      defaultDelayMs = ms;
    },

    reset() {
      requests = [];
      customResponses = new Map();
      defaultDelayMs = 0;
    },

    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
