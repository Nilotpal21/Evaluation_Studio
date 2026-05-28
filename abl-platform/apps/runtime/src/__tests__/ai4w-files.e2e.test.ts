/**
 * AI4W File Exchange E2E Tests
 *
 * Tests SSRF validation, file download from signed URLs, and content transformation.
 * Uses a real runtime API harness with in-memory MongoDB, in-process JWKS server,
 * and local HTTP file server.
 *
 * No vi.mock() — real servers, real middleware.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from 'jose';
import authRouter from '../routes/auth.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import platformAdminModelsRouter from '../routes/platform-admin-models.js';
import projectIoRouter from '../routes/project-io.js';
import channelConnectionsRouter from '../routes/channel-connections.js';
import deploymentsRouter from '../routes/deployments.js';
import ai4wChannelRouter from '../routes/ai4w-channel.js';
import { clearPermissionCache } from '../services/permission-resolution.js';
import {
  isRedisAvailable,
  initializeRedis,
  disconnectRedis,
} from '../services/redis/redis-client.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  createChannelConnection,
  provisionBasicAgentProject,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from './helpers/channel-e2e-bootstrap.js';
import {
  isRedisServerHarnessAvailable,
  startRedisServerHarness,
  type RedisServerHarness,
} from './helpers/redis-server-harness.js';
import { validateResolvedIP, SSRFError } from '../channels/adapters/ai4w-ssrf.js';
import { transformAI4WOutput } from '../channels/adapters/ai4w-content-transformer.js';
import { startMockLLM } from '../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../tools/agents/e2e-functional/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AI4W_E2E_TIMEOUT_MS = 60_000;
let TEST_ISSUER: string; // set to http://127.0.0.1:{jwksPort} after listen
const TEST_AUDIENCE = 'urn:kore:agentic';

// ---------------------------------------------------------------------------
// Test key material
// ---------------------------------------------------------------------------

let privateKey: KeyLike;
let jwksServer: http.Server;
let jwksPort: number;

// ---------------------------------------------------------------------------
// Local file server (serves test files for download)
// ---------------------------------------------------------------------------

let fileServer: http.Server;
let fileServerPort: number;

const TEST_FILE_CONTENT = 'Hello, this is a test file for AI4W file exchange.';
const TEST_FILE_NAME = 'test-document.txt';
const TEST_FILE_MIME = 'text/plain';

// ---------------------------------------------------------------------------
// HMAC helper
// ---------------------------------------------------------------------------

function signHmac(secret: string, requestId: string, timestamp: string, body: string): string {
  const input = `inbound:${requestId}.${timestamp}.${body}`;
  return 'sha256=' + crypto.createHmac('sha256', secret).update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// JWT helper
// ---------------------------------------------------------------------------

async function mintJwt(
  overrides: {
    subject?: string;
    issuer?: string;
    audience?: string;
    email?: string;
    accountId?: string;
    expiresIn?: string;
    kid?: string;
    signingKey?: KeyLike;
  } = {},
): Promise<string> {
  const builder = new SignJWT({
    email: overrides.email ?? 'user@test.com',
    accountId: overrides.accountId ?? 'acc_123',
    scope: 'agentic',
    product: 'AgenticApp',
  })
    .setProtectedHeader({
      alg: 'RS256',
      kid: overrides.kid ?? 'test-key-1',
    })
    .setSubject(overrides.subject ?? 'user_456')
    .setIssuer(overrides.issuer ?? TEST_ISSUER)
    .setAudience(overrides.audience ?? TEST_AUDIENCE)
    .setIssuedAt();

  if (overrides.expiresIn) {
    builder.setExpirationTime(overrides.expiresIn);
  } else {
    builder.setExpirationTime('1h');
  }

  return builder.sign(overrides.signingKey ?? privateKey);
}

// ---------------------------------------------------------------------------
// Signed request helper
// ---------------------------------------------------------------------------

async function sendAI4WMessage(
  baseUrl: string,
  connectionId: string,
  connectionSecret: string,
  jwtToken: string,
  body: { text: string; agentContextId: string; [key: string]: unknown },
  options?: { requestId?: string },
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const bodyStr = JSON.stringify(body);
  const requestId = options?.requestId ?? crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const signature = signHmac(connectionSecret, requestId, timestamp, bodyStr);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwtToken}`,
    'X-Signature-Nonce': requestId,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
  };

  const res = await fetch(`${baseUrl}/api/v1/channels/ai4w/${connectionId}/message`, {
    method: 'POST',
    headers,
    body: bodyStr,
  });

  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};

  return { status: res.status, body: parsed, headers: res.headers };
}

// ---------------------------------------------------------------------------
// Test suite — requires Redis for replay protection
// ---------------------------------------------------------------------------

const describeAI4WFiles = isRedisServerHarnessAvailable() ? describe.sequential : describe.skip;

describeAI4WFiles('AI4W file exchange E2E', () => {
  let harness: RuntimeApiHarness;
  let redis: RedisServerHarness;
  let mockLlm: MockLLM;

  // Per-test channel state
  let connectionId: string;
  let connectionSecret: string;

  beforeAll(async () => {
    // 1. Generate RS256 key pair for JWT signing
    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey;
    const jwk = await exportJWK(keyPair.publicKey);
    jwk.kid = 'test-key-1';
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    // 2. Start in-process server that serves BOTH JWKS and OIDC discovery
    jwksServer = http.createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: TEST_ISSUER,
            jwks_uri: `${TEST_ISSUER}/.well-known/jwks.json`,
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => {
      jwksServer.listen(0, '127.0.0.1', () => resolve());
    });
    jwksPort = (jwksServer.address() as AddressInfo).port;
    TEST_ISSUER = `http://127.0.0.1:${jwksPort}`;

    // 3. Start local file server (serves test files for download tests)
    fileServer = http.createServer((req, res) => {
      if (req.url === '/files/test-document.txt') {
        res.writeHead(200, {
          'Content-Type': TEST_FILE_MIME,
          'Content-Disposition': `attachment; filename="${TEST_FILE_NAME}"`,
        });
        res.end(TEST_FILE_CONTENT);
      } else if (req.url === '/files/large-file.bin') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="large-file.bin"',
        });
        // Return a 1KB test file
        res.end(Buffer.alloc(1024, 0x42));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    await new Promise<void>((resolve) => {
      fileServer.listen(0, '127.0.0.1', () => resolve());
    });
    fileServerPort = (fileServer.address() as AddressInfo).port;

    // 4. Set AI4W env vars
    process.env.AI4W_TRUSTED_ISSUERS = TEST_ISSUER;
    process.env.AI4W_JWT_AUDIENCE = TEST_AUDIENCE;
    process.env.AI4W_ALLOW_HTTP_ISSUERS = 'true';
    process.env.AI4W_HMAC_TIMESTAMP_TOLERANCE_MS = '30000';
    // Trust the loopback range for file download tests (since file server is on 127.0.0.1)
    process.env.AI4W_TRUSTED_CALLBACK_CIDRS = '127.0.0.0/8';

    // 5. Start Redis
    redis = await startRedisServerHarness();
    mockLlm = await startMockLLM();

    // 6. Start runtime harness
    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
        app.use('/api/projects/:projectId/project-io', projectIoRouter);
        app.use('/api/projects/:projectId/deployments', deploymentsRouter);
        app.use('/api/projects/:projectId/channel-connections', channelConnectionsRouter);
        app.use('/api/v1/channels/ai4w', ai4wChannelRouter);
      },
      {
        REDIS_ENABLED: 'true',
        REDIS_URL: redis.url,
      },
    );

    await initializeRedis();

    // Populate the trusted-issuer registry (server.ts does this in
    // startServer(), but the harness loads the module without starting).
    const { __resetAI4WAuthForTests, initAI4WAuth } =
      await import('../channels/adapters/ai4w-auth.js');
    __resetAI4WAuthForTests();
    await initAI4WAuth();
  }, AI4W_E2E_TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await redis.clear();
    await setSuperAdmins([]);
    mockLlm.reset();

    // Bootstrap a fresh project + channel connection for each test
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('ai4w-files'),
      uniqueSlug('tenant-ai4w-files'),
      uniqueSlug('project-ai4w-files'),
    );

    await provisionBasicAgentProject(
      harness,
      admin.token,
      admin.tenantId,
      admin.projectId,
      mockLlm.url,
    );

    const connection = await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'ai4w',
      display_name: 'AI4W Files Test Connection',
      external_identifier: 'ignored-for-ai4w',
      environment: 'production',
      config: {
        callbackBaseUrl: 'http://localhost:9999',
        responseMode: 'sync',
        ai4wAccountId: null,
        provisionedBy: 'manual',
        lastUsedAt: null,
      },
    });

    expect(connection.ai4w).toBeDefined();
    connectionId = connection.ai4w!.connectionId;
    connectionSecret = connection.ai4w!.connectionSecret;
  });

  afterAll(async () => {
    await disconnectRedis();
    if (harness) await harness.close();
    if (mockLlm) await mockLlm.close();
    if (redis) await redis.close();
    if (jwksServer) {
      await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
    }
    if (fileServer) {
      await new Promise<void>((resolve) => fileServer.close(() => resolve()));
    }
    delete process.env.AI4W_TRUSTED_ISSUERS;
    delete process.env.AI4W_JWT_AUDIENCE;
    delete process.env.AI4W_ALLOW_HTTP_ISSUERS;
    delete process.env.AI4W_HMAC_TIMESTAMP_TOLERANCE_MS;
    delete process.env.AI4W_TRUSTED_CALLBACK_CIDRS;
  }, AI4W_E2E_TIMEOUT_MS);

  // =========================================================================
  // SSRF VALIDATION — Unit-level checks (no mocks, pure function)
  // =========================================================================

  describe('SSRF IP validation', () => {
    // NOTE: In this test env, AI4W_TRUSTED_CALLBACK_CIDRS=127.0.0.0/8
    // so 127.x addresses are allowed (needed for the local file server).
    // We test other private ranges to verify blocking behavior.

    test('blocks 10.x.x.x private range', () => {
      expect(validateResolvedIP('10.0.0.1')).toBe(false);
      expect(validateResolvedIP('10.255.255.255')).toBe(false);
    });

    test('blocks 172.16-31.x.x private range', () => {
      expect(validateResolvedIP('172.16.0.1')).toBe(false);
      expect(validateResolvedIP('172.31.255.255')).toBe(false);
      // 172.32.x.x should be allowed (not in private range)
      expect(validateResolvedIP('172.32.0.1')).toBe(true);
    });

    test('blocks 192.168.x.x private range', () => {
      expect(validateResolvedIP('192.168.0.1')).toBe(false);
      expect(validateResolvedIP('192.168.1.100')).toBe(false);
    });

    test('blocks 169.254.x.x link-local', () => {
      expect(validateResolvedIP('169.254.0.1')).toBe(false);
      expect(validateResolvedIP('169.254.169.254')).toBe(false);
    });

    test('blocks IPv6 link-local fe80::', () => {
      expect(validateResolvedIP('fe80::1')).toBe(false);
    });

    test('allows public IPs', () => {
      expect(validateResolvedIP('8.8.8.8')).toBe(true);
      expect(validateResolvedIP('1.1.1.1')).toBe(true);
      expect(validateResolvedIP('203.0.113.1')).toBe(true);
    });

    test('allows trusted CIDR IPs (127.0.0.0/8 is trusted in test env)', () => {
      // AI4W_TRUSTED_CALLBACK_CIDRS=127.0.0.0/8 is set in beforeAll
      // validateResolvedIP checks trusted CIDRs before private IP check
      expect(validateResolvedIP('127.0.0.1')).toBe(true);
      expect(validateResolvedIP('127.255.255.255')).toBe(true);
    });
  });

  // =========================================================================
  // FILE DOWNLOAD VIA SIGNED URL (real HTTP, local file server)
  // =========================================================================

  test(
    'message with valid signed URL file downloads successfully',
    async () => {
      const jwt = await mintJwt({});
      const fileUrl = `http://127.0.0.1:${fileServerPort}/files/test-document.txt`;

      const res = await sendAI4WMessage(harness.baseUrl, connectionId, connectionSecret, jwt, {
        text: 'Please process this file',
        agentContextId: 'ctx_file_test',
        files: [
          {
            name: TEST_FILE_NAME,
            mimeType: TEST_FILE_MIME,
            signedUrl: fileUrl,
          },
        ],
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          sessionId: expect.any(String),
        }),
      });

      // Verify file metadata is included in the response
      const data = res.body.data as Record<string, unknown>;
      const files = data.files as Array<{
        filename: string;
        contentType: string;
        sizeBytes: number;
      }>;
      expect(files).toBeDefined();
      expect(files).toHaveLength(1);
      expect(files[0].filename).toBe(TEST_FILE_NAME);
      expect(files[0].contentType).toBe(TEST_FILE_MIME);
      expect(files[0].sizeBytes).toBe(TEST_FILE_CONTENT.length);
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'message with invalid file URL (404) succeeds with empty files',
    async () => {
      const jwt = await mintJwt({});
      const fileUrl = `http://127.0.0.1:${fileServerPort}/files/nonexistent.txt`;

      const res = await sendAI4WMessage(harness.baseUrl, connectionId, connectionSecret, jwt, {
        text: 'Process this missing file',
        agentContextId: 'ctx_missing_file',
        files: [
          {
            name: 'nonexistent.txt',
            mimeType: 'text/plain',
            signedUrl: fileUrl,
          },
        ],
      });

      // Request should still succeed — file download failure is non-fatal
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          sessionId: expect.any(String),
        }),
      });

      // No files should be in the response since the download failed
      const data = res.body.data as Record<string, unknown>;
      expect(data.files).toBeUndefined();
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'message with SSRF-blocked URL (private IP) skips that file',
    async () => {
      const jwt = await mintJwt({});
      // Use 10.0.0.1 which is blocked by SSRF policy and not in trusted CIDRs
      // This will fail at DNS resolution since 10.0.0.1 is not a real host,
      // but the SSRF validation should catch it if it were to resolve
      const fileUrl = 'http://10.0.0.1:8080/secret-file.txt';

      const res = await sendAI4WMessage(harness.baseUrl, connectionId, connectionSecret, jwt, {
        text: 'Try to access internal file',
        agentContextId: 'ctx_ssrf_test',
        files: [
          {
            name: 'secret-file.txt',
            mimeType: 'text/plain',
            signedUrl: fileUrl,
          },
        ],
      });

      // Request should still succeed — SSRF-blocked file is skipped
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          sessionId: expect.any(String),
        }),
      });

      // No files in response
      const data = res.body.data as Record<string, unknown>;
      expect(data.files).toBeUndefined();
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'message with multiple files filters disallowed MIME types before download',
    async () => {
      const jwt = await mintJwt({});
      const validUrl = `http://127.0.0.1:${fileServerPort}/files/test-document.txt`;
      const largeUrl = `http://127.0.0.1:${fileServerPort}/files/large-file.bin`;

      const res = await sendAI4WMessage(harness.baseUrl, connectionId, connectionSecret, jwt, {
        text: 'Process multiple files',
        agentContextId: 'ctx_multi_file',
        files: [
          {
            name: TEST_FILE_NAME,
            mimeType: TEST_FILE_MIME,
            signedUrl: validUrl,
          },
          {
            name: 'large-file.bin',
            mimeType: 'application/octet-stream',
            signedUrl: largeUrl,
          },
        ],
      });

      expect(res.status).toBe(200);
      const data = res.body.data as Record<string, unknown>;
      const files = data.files as Array<{
        filename: string;
        contentType: string;
        sizeBytes: number;
      }>;
      // application/octet-stream is not in the default allowedMimeTypes,
      // so only the text/plain file passes the pre-download MIME filter
      expect(files).toHaveLength(1);
      expect(files[0].filename).toBe(TEST_FILE_NAME);
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'message without files succeeds normally',
    async () => {
      const jwt = await mintJwt({});

      const res = await sendAI4WMessage(harness.baseUrl, connectionId, connectionSecret, jwt, {
        text: 'Hello without files',
        agentContextId: 'ctx_no_files',
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          sessionId: expect.any(String),
        }),
      });

      // No files field when no files were sent
      const data = res.body.data as Record<string, unknown>;
      expect(data.files).toBeUndefined();
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // CONTENT TRANSFORMER — Pure function tests
  // =========================================================================

  describe('content transformer', () => {
    test('plain text passthrough', () => {
      const output = transformAI4WOutput('Hello world');
      expect(output).toEqual({ kind: 'text', text: 'Hello world' });
    });

    test('rich content with markdown passes through', () => {
      const output = transformAI4WOutput('Intro text', undefined, {
        markdown: '## Heading\n\nSome **bold** text.',
      });
      expect(output.kind).toBe('text');
      expect(output.text).toContain('Intro text');
      expect(output.text).toContain('## Heading');
      expect(output.text).toContain('**bold**');
    });

    test('carousel renders as markdown cards', () => {
      const output = transformAI4WOutput('Choose a product:', undefined, {
        carousel: {
          cards: [
            {
              title: 'Product A',
              subtitle: 'Best seller',
              image_url: 'https://example.com/a.png',
              buttons: [{ id: 'buy_a', type: 'button', label: 'Buy Now', value: 'buy_a' }],
            },
            {
              title: 'Product B',
              subtitle: 'New arrival',
            },
          ],
        },
      });
      expect(output.kind).toBe('text');
      expect(output.text).toContain('### Product A');
      expect(output.text).toContain('Best seller');
      expect(output.text).toContain('![Product A](https://example.com/a.png)');
      expect(output.text).toContain('**Buy Now**');
      expect(output.text).toContain('### Product B');
    });

    test('table renders as markdown table', () => {
      const output = transformAI4WOutput('Results:', undefined, {
        table: {
          columns: [
            { key: 'name', header: 'Name' },
            { key: 'score', header: 'Score' },
          ],
          rows: [
            { name: 'Alice', score: 95 },
            { name: 'Bob', score: 87 },
          ],
        },
      });
      expect(output.kind).toBe('text');
      expect(output.text).toContain('| Name | Score |');
      expect(output.text).toContain('| --- | --- |');
      expect(output.text).toContain('| Alice | 95 |');
      expect(output.text).toContain('| Bob | 87 |');
    });

    test('actions render as markdown links', () => {
      const output = transformAI4WOutput('Choose an option:', {
        elements: [
          { id: 'opt1', type: 'button', label: 'Option 1', value: 'val1' },
          { id: 'opt2', type: 'button', label: 'Option 2', value: 'val2' },
        ],
      });
      expect(output.kind).toBe('text');
      expect(output.text).toContain('Choose an option:');
      expect(output.text).toContain('[Option 1]');
      expect(output.text).toContain('[Option 2]');
    });

    test('KPI renders label, value, and trend', () => {
      const output = transformAI4WOutput('Metric:', undefined, {
        kpi: { label: 'Revenue', value: 50000, unit: 'USD', trend: 'up' },
      });
      expect(output.kind).toBe('text');
      expect(output.text).toContain('**Revenue**: 50000 USD');
      expect(output.text).toContain('↑');
    });

    test('progress renders as percentage', () => {
      const output = transformAI4WOutput('Status:', undefined, {
        progress: { value: 75, max: 100, label: 'Upload' },
      });
      expect(output.kind).toBe('text');
      expect(output.text).toContain('**Upload**: 75%');
    });

    test('image renders as markdown image', () => {
      const output = transformAI4WOutput('Here is the image:', undefined, {
        image: { url: 'https://example.com/photo.png', alt: 'Photo', caption: 'A nice photo' },
      });
      expect(output.kind).toBe('text');
      expect(output.text).toContain('![Photo](https://example.com/photo.png)');
      expect(output.text).toContain('*A nice photo*');
    });

    test('file renders as markdown link', () => {
      const output = transformAI4WOutput('Download:', undefined, {
        file: {
          url: 'https://example.com/doc.pdf',
          filename: 'report.pdf',
          mime_type: 'application/pdf',
        },
      });
      expect(output.kind).toBe('text');
      expect(output.text).toContain('[report.pdf](https://example.com/doc.pdf)');
      expect(output.text).toContain('(application/pdf)');
    });
  });
});
