import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';

/**
 * Mock BrowserPool to avoid requiring Playwright/Chromium in test environment.
 * The HTTP transport tests only exercise the HTTP layer, not browser automation.
 */
vi.mock('../browser/pool.js', () => {
  class MockBrowserPool {
    initialize = vi.fn().mockResolvedValue(undefined);
    getPage = vi.fn().mockResolvedValue({});
    closeAll = vi.fn().mockResolvedValue(undefined);
  }
  return { BrowserPool: MockBrowserPool };
});

// Import after mock setup
const { CrawlerMCPServer } = await import('../server.js');

/**
 * Helper to make HTTP requests to the test server.
 */
function request(
  port: number,
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const method = options.method ?? 'GET';
    const bodyStr = options.body ? JSON.stringify(options.body) : undefined;
    const headers: Record<string, string> = {
      ...(options.headers ?? {}),
    };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );

    req.on('error', reject);
    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

describe('HTTP Transport', () => {
  let server: InstanceType<typeof CrawlerMCPServer>;
  let port: number;

  beforeAll(async () => {
    server = new CrawlerMCPServer();
    // Use port 0 to get a random available port
    await server.startHttp(0);
    port = server.getHttpPort()!;
    expect(port).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await server.close();
  });

  it('HT-1: HTTP server starts on configured port', () => {
    // If we reached here, the server started successfully in beforeAll
    expect(port).toBeGreaterThan(0);
  });

  it('HT-2: GET /health returns 200 { status: ok }', async () => {
    const res = await request(port, '/health');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ status: 'ok' });
  });

  it('HT-3: POST /mcp returns a valid response (not 404)', async () => {
    // Send an MCP initialize request
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: {
          name: 'test-client',
          version: '1.0.0',
        },
      },
    };

    const res = await request(port, '/mcp', {
      method: 'POST',
      body: initRequest,
      headers: {
        Accept: 'application/json, text/event-stream',
      },
    });

    // Should not be 404 — the route exists and handles MCP
    expect(res.status).not.toBe(404);
    // MCP initialize should return 200 with a result, or an SSE stream
    // The response is either JSON or SSE depending on the SDK version
    expect([200, 202]).toContain(res.status);
  });

  it('HT-4: Server closes cleanly without errors', async () => {
    // Create a separate server instance for this test
    const server2 = new CrawlerMCPServer();
    await server2.startHttp(0);
    const port2 = server2.getHttpPort();
    expect(port2).toBeGreaterThan(0);

    // Close should not throw
    await expect(server2.close()).resolves.toBeUndefined();

    // After close, the port should no longer accept connections
    await expect(request(port2!, '/health')).rejects.toThrow();
  });
});
