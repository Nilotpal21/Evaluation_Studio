/**
 * Tests for the agent-assist-proxy shared helper.
 *
 * Uses a real http.createServer as the "mock runtime" — no vi.mock.
 * Tests header forwarding, body forwarding, SSE streaming, body size limits,
 * and missing x-api-key rejection.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import {
  redactApiKey,
  extractForwardHeaders,
  buildRuntimeUrl,
  proxyToRuntime,
} from '../../lib/agent-assist-proxy';

// ─── Pure function tests ─────────────────────────────────────────────────

describe('redactApiKey', () => {
  it('redacts long keys to first 8 chars', () => {
    expect(redactApiKey('abl_abc123def456')).toBe('abl_abc1...');
  });

  it('keeps short keys as-is', () => {
    expect(redactApiKey('short')).toBe('short');
  });

  it('keeps exactly 8-char keys as-is', () => {
    expect(redactApiKey('12345678')).toBe('12345678');
  });
});

describe('extractForwardHeaders', () => {
  it('forwards x-api-key and content-type', () => {
    const h = new Headers({
      'x-api-key': 'abl_test',
      'content-type': 'application/json',
      authorization: 'Bearer secret',
    });
    const result = extractForwardHeaders(h);
    expect(result['x-api-key']).toBe('abl_test');
    expect(result['content-type']).toBe('application/json');
    // authorization is NOT in the forward list
    expect(result['authorization']).toBeUndefined();
  });

  it('forwards kore-traceid', () => {
    const h = new Headers({ 'kore-traceid': 'abc123' });
    const result = extractForwardHeaders(h);
    expect(result['kore-traceid']).toBe('abc123');
  });

  it('forwards accept and user-agent', () => {
    const h = new Headers({
      accept: 'text/event-stream',
      'user-agent': 'KoreBot/1.0',
    });
    const result = extractForwardHeaders(h);
    expect(result['accept']).toBe('text/event-stream');
    expect(result['user-agent']).toBe('KoreBot/1.0');
  });
});

describe('buildRuntimeUrl', () => {
  it('concatenates base and path', () => {
    const url = buildRuntimeUrl('/api/v2/apps/test/environments/dev/runs/execute');
    expect(url).toContain('/api/v2/apps/test/environments/dev/runs/execute');
  });
});

// ─── Integration: real HTTP server simulating runtime ─────────────────────

describe('proxy integration with mock runtime', () => {
  let mockRuntimeServer: http.Server;
  let savedRuntimeUrl: string | undefined;

  beforeAll(async () => {
    savedRuntimeUrl = process.env.RUNTIME_URL;

    await new Promise<void>((resolve) => {
      mockRuntimeServer = http.createServer((req, res) => {
        const url = req.url ?? '';
        const acceptHeader = req.headers['accept'] ?? '';

        // ─── SSE endpoint ────────────────────────────────────────
        if (url.includes('/runs/execute') && acceptHeader.includes('text/event-stream')) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write('data: {"type":"delta","text":"Hello"}\n\n');
          res.write('data: {"type":"final","text":"Hello World"}\n\n');
          res.end();
          return;
        }

        // ─── Sync JSON execute ───────────────────────────────────
        if (url.includes('/runs/execute')) {
          let body = '';
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                output: [{ type: 'text', content: 'response' }],
                forwarded_api_key: req.headers['x-api-key'],
                forwarded_content_type: req.headers['content-type'],
                forwarded_body: body,
              }),
            );
          });
          return;
        }

        // ─── Sessions terminate (must be before /sessions) ───────
        if (url.includes('/sessions/terminate')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sessionId: 'sess-1', status: 'terminated' }));
          return;
        }

        // ─── Sessions create ─────────────────────────────────────
        if (url.includes('/sessions')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ session: { sessionId: 'sess-1' } }));
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
      });

      mockRuntimeServer.listen(0, '127.0.0.1', () => {
        const addr = mockRuntimeServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        process.env.RUNTIME_URL = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (savedRuntimeUrl !== undefined) {
      process.env.RUNTIME_URL = savedRuntimeUrl;
    } else {
      delete process.env.RUNTIME_URL;
    }
    await new Promise<void>((resolve) => {
      mockRuntimeServer.close(() => resolve());
    });
  });

  it('rejects request without x-api-key', async () => {
    const request = new Request('http://localhost/api/v2/apps/app1/environments/dev/runs/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: [] }),
    });

    const res = await proxyToRuntime(
      request as any,
      '/api/v2/apps/app1/environments/dev/runs/execute',
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('API_KEY_REQUIRED');
  });

  it('forwards body and headers for sync JSON execute', async () => {
    const payload = JSON.stringify({ input: [{ type: 'text', content: 'hello' }] });
    const request = new Request('http://localhost/api/v2/apps/app1/environments/dev/runs/execute', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'abl_test123',
        'kore-traceid': 'trace-42',
      },
      body: payload,
    });

    const res = await proxyToRuntime(
      request as any,
      '/api/v2/apps/app1/environments/dev/runs/execute',
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.forwarded_api_key).toBe('abl_test123');
    expect(body.forwarded_content_type).toBe('application/json');
    expect(body.forwarded_body).toBe(payload);
  });

  it('forwards session create request', async () => {
    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'abl_key',
      },
      body: JSON.stringify({ sessionIdentity: [{ type: 'sessionReference', value: 'ref-1' }] }),
    });

    const res = await proxyToRuntime(request as any, '/api/v2/apps/app1/environments/dev/sessions');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.sessionId).toBe('sess-1');
  });

  it('forwards session terminate request', async () => {
    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'abl_key',
      },
      body: JSON.stringify({ sessionIdentity: [{ type: 'sessionId', value: 'sess-1' }] }),
    });

    const res = await proxyToRuntime(
      request as any,
      '/api/v2/apps/app1/environments/dev/sessions/terminate',
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('terminated');
  });

  it('rejects oversized body via content-length header', async () => {
    const largeBody = 'x'.repeat(513 * 1024);
    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'abl_key',
        'content-length': String(largeBody.length),
      },
      body: largeBody,
    });

    const res = await proxyToRuntime(
      request as any,
      '/api/v2/apps/app1/environments/dev/runs/execute',
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('handles SSE streaming response', async () => {
    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'abl_key',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ stream: { enable: true } }),
    });

    const res = await proxyToRuntime(
      request as any,
      '/api/v2/apps/app1/environments/dev/runs/execute',
      { supportsSSE: true },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    // Read the stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (result.value) {
        text += decoder.decode(result.value, { stream: !done });
      }
    }
    expect(text).toContain('delta');
    expect(text).toContain('Hello');
    expect(text).toContain('final');
  });
});
