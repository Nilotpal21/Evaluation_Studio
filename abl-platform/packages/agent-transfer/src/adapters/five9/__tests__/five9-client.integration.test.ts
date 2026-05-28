/**
 * Five9Client Integration Tests
 *
 * Tests the Five9Client against a real mock HTTP server (node:http on random port).
 * No mocking of codebase components - only the external Five9 API is simulated
 * via a real HTTP server and the client's fetchFn DI parameter.
 *
 * The SSRF guard runs against a public test-net IP literal (203.0.113.10),
 * so validation is deterministic without DNS dependency in CI/pre-push runs.
 * The fetchFn then rewrites the URL to hit our local mock server.
 *
 * INT-1: Anonymous auth
 * INT-2: Supervisor auth
 * INT-3: Auth failure returns structured error
 * INT-4: Metadata discovery resolves targetHost
 * INT-5: Conversation creation
 * INT-6: SSRF guard rejects private IPs
 * INT-12: Unexpected HTTP status codes (429, 500, 503, malformed JSON)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Five9Client } from '../five9-client.js';
import { assertAllowedUrl } from '../../../security/ssrf-guard.js';
import type { Five9Credentials } from '../types.js';

let mockServer: http.Server;
let mockPort: number;

/**
 * Parse JSON body from an incoming HTTP request.
 */
function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString();
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send a JSON response from the mock server.
 */
function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Build a mock Five9 HTTP server using raw node:http.
 */
function buildMockFive9Server(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // Anonymous auth
    if (method === 'POST' && pathname === '/appsvcs/rs/svc/auth/anon') {
      if (!url.searchParams.get('cookieless')) {
        return sendJson(res, 400, { error: 'cookieless param required' });
      }
      const body = await parseBody(req);
      if (!body.tenantName) {
        return sendJson(res, 400, { error: 'tenantName required' });
      }
      return sendJson(res, 200, {
        tokenId: 'anon-token-abc',
        orgId: 'org-anon-1',
        context: { farmId: 'farm-anon-1' },
      });
    }

    // Supervisor auth
    if (method === 'POST' && pathname === '/appsvcs/rs/svc/auth/login') {
      const body = await parseBody(req);
      if (!body.tenantName || !body.username || !body.password) {
        return sendJson(res, 401, { error: 'Invalid credentials' });
      }
      if (body.password === 'wrong-password') {
        return sendJson(res, 401, { error: 'Authentication failed' });
      }
      return sendJson(res, 200, {
        tokenId: 'sup-token-xyz',
        orgId: 'org-sup-1',
        context: { farmId: 'farm-sup-1' },
      });
    }

    // Metadata discovery
    if (method === 'GET' && pathname === '/appsvcs/rs/svc/auth/metadata') {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }
      return sendJson(res, 200, {
        orgId: 'org-meta-1',
        context: { farmId: 'farm-meta-1' },
        metadata: {
          dataCenters: [
            {
              name: 'us-west',
              active: true,
              uiUrls: [{ host: 'app-us-west.five9.com', port: '443' }],
              apiUrls: [{ host: 'api-us-west.five9.com', port: '443' }],
              loginUrls: [{ host: 'login-us-west.five9.com', port: '443' }],
            },
          ],
        },
      });
    }

    // Create conversation
    if (method === 'POST' && pathname === '/appsvcs/rs/svc/conversations') {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }
      const body = await parseBody(req);
      if (!body.campaignName || !body.tenantName) {
        return sendJson(res, 400, { error: 'Missing required fields' });
      }
      return sendJson(res, 200, { conversationId: 'conv-int-123' });
    }

    // Send message (matches /appsvcs/rs/svc/conversations/XXX/messages)
    if (
      method === 'POST' &&
      pathname.match(/\/appsvcs\/rs\/svc\/conversations\/[^/]+\/messages$/)
    ) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }
      return sendJson(res, 200, { success: true });
    }

    // End conversation (DELETE /appsvcs/rs/svc/conversations/XXX)
    if (method === 'DELETE' && pathname.match(/\/appsvcs\/rs\/svc\/conversations\/[^/]+$/)) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }
      return sendJson(res, 200, { success: true });
    }

    // Fallback
    sendJson(res, 404, { error: 'Not found' });
  });
}

/**
 * Create credentials that use a public TEST-NET-3 host IP.
 * Using an IP literal avoids DNS lookups inside assertAllowedUrl().
 */
function makeCredentials(overrides: Partial<Five9Credentials> = {}): Five9Credentials {
  return {
    tenantName: 'test-tenant',
    campaignName: 'test-campaign',
    host: '203.0.113.10',
    authMode: 'anonymous',
    ...overrides,
  };
}

beforeAll(async () => {
  mockServer = buildMockFive9Server();
  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = mockServer.address() as AddressInfo;
  mockPort = addr.port;
});

afterAll(async () => {
  if (mockServer) {
    await new Promise<void>((resolve, reject) => {
      mockServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

/**
 * Custom fetchFn that intercepts requests to the configured host and redirects
 * them to the local mock HTTP server.
 */
function createMockFetch(): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Rewrite to hit our local mock server
    url = url.replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${mockPort}`);
    return fetch(url, init);
  };
}

describe('Five9Client Integration Tests', () => {
  describe('INT-1: Anonymous auth against mock HTTP server', () => {
    it('authenticates with anonymous mode and returns auth result', async () => {
      const creds = makeCredentials({ authMode: 'anonymous' });
      const client = new Five9Client(creds, createMockFetch());

      const result = await client.authenticate();

      expect(result.tokenId).toBe('anon-token-abc');
      expect(result.orgId).toBe('org-anon-1');
      expect(result.farmId).toBe('farm-anon-1');
      // targetHost is the original credentials host
      expect(result.targetHost).toBe('203.0.113.10');
    });
  });

  describe('INT-2: Supervisor auth against mock HTTP server', () => {
    it('authenticates with supervisor mode and returns auth result', async () => {
      const creds = makeCredentials({
        authMode: 'supervisor',
        username: 'admin@test.com',
        password: 's3cret',
      });
      const client = new Five9Client(creds, createMockFetch());

      const result = await client.authenticate();

      expect(result.tokenId).toBe('sup-token-xyz');
      expect(result.orgId).toBe('org-sup-1');
      expect(result.farmId).toBe('farm-sup-1');
    });
  });

  describe('INT-3: Auth failure returns structured error', () => {
    it('throws structured error on authentication failure', async () => {
      const creds = makeCredentials({
        authMode: 'supervisor',
        username: 'admin@test.com',
        password: 'wrong-password',
      });
      const client = new Five9Client(creds, createMockFetch());

      await expect(client.authenticate()).rejects.toEqual(
        expect.objectContaining({
          code: 'FIVE9_AUTH_FAILED',
          message: expect.stringContaining('401'),
        }),
      );
    });

    it('throws structured error when supervisor creds missing', async () => {
      const creds = makeCredentials({
        authMode: 'supervisor',
        // no username/password
      });
      const client = new Five9Client(creds, createMockFetch());

      await expect(client.authenticate()).rejects.toEqual(
        expect.objectContaining({
          code: 'FIVE9_AUTH_CONFIG_ERROR',
        }),
      );
    });
  });

  describe('INT-4: Metadata discovery resolves targetHost', () => {
    it('discovers metadata and resolves targetHost from dataCenters', async () => {
      const creds = makeCredentials();
      const client = new Five9Client(creds, createMockFetch());

      const result = await client.discoverMetadata('app.five9.com', 'test-token');

      expect(result.orgId).toBe('org-meta-1');
      expect(result.farmId).toBe('farm-meta-1');
      expect(result.targetHost).toBe('api-us-west.five9.com');
      expect(result.tokenId).toBe('test-token');
    });
  });

  describe('INT-5: Conversation creation', () => {
    it('creates a conversation and returns conversationId', async () => {
      const creds = makeCredentials();
      const client = new Five9Client(creds, createMockFetch());

      const result = await client.createConversation('app.five9.com', 'test-token', {
        campaignName: 'test-campaign',
        tenantName: 'test-tenant',
      });

      expect(result.conversationId).toBe('conv-int-123');
    });

    it('sends message to conversation', async () => {
      const creds = makeCredentials();
      const client = new Five9Client(creds, createMockFetch());

      await expect(
        client.sendMessage('app.five9.com', 'conv-int-123', 'test-token', 'Hello', 'farm-1'),
      ).resolves.not.toThrow();
    });

    it('ends conversation', async () => {
      const creds = makeCredentials();
      const client = new Five9Client(creds, createMockFetch());

      await expect(
        client.endConversation('app.five9.com', 'conv-int-123', 'test-token'),
      ).resolves.not.toThrow();
    });
  });

  describe('INT-6: SSRF guard rejects private IPs', () => {
    it('rejects localhost URLs via SSRF guard', async () => {
      await expect(assertAllowedUrl('https://localhost/api')).rejects.toThrow('SSRF blocked');
    });

    it('rejects 10.x.x.x private range', async () => {
      await expect(assertAllowedUrl('https://10.0.0.1/api')).rejects.toThrow('SSRF blocked');
    });

    it('rejects 192.168.x.x private range', async () => {
      await expect(assertAllowedUrl('https://192.168.1.1/api')).rejects.toThrow('SSRF blocked');
    });

    it('rejects 169.254.x.x link-local range', async () => {
      await expect(assertAllowedUrl('https://169.254.169.254/api')).rejects.toThrow('SSRF blocked');
    });

    it('rejects 127.0.0.1 loopback', async () => {
      await expect(assertAllowedUrl('https://127.0.0.1/api')).rejects.toThrow('SSRF blocked');
    });
  });

  describe('INT-12: Unexpected HTTP status codes', () => {
    it('handles 429 rate limiting with structured error', async () => {
      const creds = makeCredentials();
      const rateLimitFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ error: 'Rate limited' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const client = new Five9Client(creds, rateLimitFetch);

      await expect(client.authenticate()).rejects.toEqual(
        expect.objectContaining({
          code: 'FIVE9_AUTH_FAILED',
          message: expect.stringContaining('429'),
        }),
      );
    });

    it('handles 500 internal server error', async () => {
      const creds = makeCredentials();
      const errorFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ error: 'Internal error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const client = new Five9Client(creds, errorFetch);

      await expect(client.authenticate()).rejects.toEqual(
        expect.objectContaining({
          code: 'FIVE9_AUTH_FAILED',
          message: expect.stringContaining('500'),
        }),
      );
    });

    it('handles 503 service unavailable', async () => {
      const creds = makeCredentials();
      const errorFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ error: 'Unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const client = new Five9Client(creds, errorFetch);

      await expect(client.authenticate()).rejects.toEqual(
        expect.objectContaining({
          code: 'FIVE9_AUTH_FAILED',
          message: expect.stringContaining('503'),
        }),
      );
    });

    it('handles malformed JSON response', async () => {
      const creds = makeCredentials();
      const errorFetch: typeof fetch = async () => {
        return new Response('not valid json{{{', {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const client = new Five9Client(creds, errorFetch);

      // The response will be ok=true but json() will throw because it's malformed
      await expect(client.authenticate()).rejects.toThrow();
    });
  });
});
