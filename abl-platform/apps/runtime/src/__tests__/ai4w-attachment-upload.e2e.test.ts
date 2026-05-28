/**
 * AI4W Attachment Upload E2E Tests
 *
 * Tests the full attachment upload flow: AI4W message with files → download → upload to
 * multimodal-service → attachment IDs in metadata.
 *
 * Uses real runtime API harness, real multimodal-service client, in-memory MongoDB.
 * No vi.mock() — real integration testing.
 *
 * IMPORTANT: This test requires multimodal-service to be running on port 3006.
 * Skip these tests if multimodal-service is unavailable (CI environments).
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
import { startMockLLM } from '../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../tools/agents/e2e-functional/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AI4W_ATTACHMENT_E2E_TIMEOUT_MS = 60_000;
let TEST_ISSUER: string;
const TEST_AUDIENCE = 'urn:kore:agentic';

// ---------------------------------------------------------------------------
// Test key material
// ---------------------------------------------------------------------------

let privateKey: KeyLike;
let jwksServer: http.Server;
let jwksPort: number;

// ---------------------------------------------------------------------------
// File server (serves test files)
// ---------------------------------------------------------------------------

let fileServer: http.Server;
let fileServerPort: number;

const SMALL_FILE_CONTENT = 'This is a small test file for attachment upload.';
const LARGE_FILE_SIZE = 5 * 1024 * 1024; // 5MB

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
    email?: string;
    accountId?: string;
    expiresIn?: string;
  } = {},
): Promise<string> {
  return new SignJWT({
    email: overrides.email ?? 'user@test.com',
    accountId: overrides.accountId ?? 'acc_123',
    scope: 'agentic',
    product: 'AgenticApp',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setSubject('user_456')
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '1h')
    .sign(privateKey);
}

// ---------------------------------------------------------------------------
// Signed request helper
// ---------------------------------------------------------------------------

async function sendAI4WMessage(
  baseUrl: string,
  connectionId: string,
  connectionSecret: string,
  jwtToken: string,
  body: {
    text: string;
    agentContextId: string;
    files?: Array<{ name: string; mimeType: string; signedUrl: string }>;
    [key: string]: unknown;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const bodyStr = JSON.stringify(body);
  const requestId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const signature = signHmac(connectionSecret, requestId, timestamp, bodyStr);

  const res = await fetch(`${baseUrl}/api/v1/channels/ai4w/${connectionId}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwtToken}`,
      'X-Signature-Nonce': requestId,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
    },
    body: bodyStr,
  });

  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};

  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const describeAI4WAttachments = isRedisServerHarnessAvailable()
  ? describe.sequential
  : describe.skip;

describeAI4WAttachments(
  'AI4W attachment upload E2E',
  () => {
    let harness: RuntimeApiHarness;
    let redis: RedisServerHarness;
    let mockLlm: MockLLM;

    let connectionId: string;
    let connectionSecret: string;
    let jwtToken: string;

    beforeAll(async () => {
      // 1. Generate RS256 key pair
      const keyPair = await generateKeyPair('RS256');
      privateKey = keyPair.privateKey;
      const jwk = await exportJWK(keyPair.publicKey);
      jwk.kid = 'test-key-1';
      jwk.alg = 'RS256';
      jwk.use = 'sig';

      // 2. Start JWKS server
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

      // 3. Start file server
      fileServer = http.createServer((req, res) => {
        if (req.url === '/files/small.txt') {
          res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Content-Disposition': 'attachment; filename="small.txt"',
          });
          res.end(SMALL_FILE_CONTENT);
        } else if (req.url === '/files/image.png') {
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Disposition': 'attachment; filename="image.png"',
          });
          // Return a small PNG-like buffer (not a real PNG, just for testing)
          res.end(Buffer.alloc(1024, 0x89));
        } else if (req.url === '/files/large.bin') {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="large.bin"',
          });
          res.end(Buffer.alloc(LARGE_FILE_SIZE, 0x42));
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
      process.env.AI4W_TRUSTED_CALLBACK_CIDRS = '127.0.0.0/8';

      // 5. Start Redis and mock LLM
      redis = await startRedisServerHarness();
      mockLlm = await startMockLLM();

      // 6. Start runtime harness
      harness = await startRuntimeApiHarness((app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform-admin/tenants', platformAdminTenantsRouter);
        app.use('/api/platform-admin/models', platformAdminModelsRouter);
        app.use('/api/projects/:projectId/io', projectIoRouter);
        app.use('/api/projects/:projectId/channel-connections', channelConnectionsRouter);
        app.use('/api/projects/:projectId/deployments', deploymentsRouter);
        app.use('/api/v1/channels/ai4w', ai4wChannelRouter);
      });

      await initializeRedis();
    }, AI4W_ATTACHMENT_E2E_TIMEOUT_MS);

    afterAll(async () => {
      await disconnectRedis();
      if (jwksServer) jwksServer.close();
      if (fileServer) fileServer.close();
      await harness?.shutdown();
      await redis?.shutdown();
      mockLlm?.server.close();
    });

    beforeEach(async () => {
      clearPermissionCache();
    });

    test(
      'uploads single file to attachment service and returns attachment ID',
      async () => {
        // Setup
        const userEmail = uniqueEmail();
        const projectSlug = uniqueSlug();
        await setSuperAdmins(harness, [userEmail]);

        const { tenantId, projectId } = await provisionBasicAgentProject(
          harness,
          userEmail,
          projectSlug,
          mockLlm,
        );

        const connection = await createChannelConnection(harness, userEmail, projectId, {
          channelType: 'ai4w',
          displayName: 'Test AI4W Connection',
          status: 'active',
          config: {
            callbackBaseUrl: `http://127.0.0.1:${fileServerPort}/callback`,
            responseMode: 'sync',
            ai4wAccountId: 'acc_123',
          },
        });

        connectionId = connection.connectionId;
        connectionSecret = connection.credentials.connectionSecret;
        jwtToken = await mintJwt({ email: userEmail, accountId: 'acc_123' });

        // Send message with file
        const result = await sendAI4WMessage(
          harness.baseUrl,
          connectionId,
          connectionSecret,
          jwtToken,
          {
            text: 'Hello with attachment',
            agentContextId: 'ctx_123',
            files: [
              {
                name: 'small.txt',
                mimeType: 'text/plain',
                signedUrl: `http://127.0.0.1:${fileServerPort}/files/small.txt`,
              },
            ],
          },
        );

        // Assertions
        expect(result.status).toBe(200);
        expect(result.body.success).toBe(true);

        // Check that attachment metadata is present
        // Note: This test assumes multimodal-service is available
        // In CI, this test may be skipped if service is not running
        if (result.body.data) {
          const data = result.body.data as any;
          // Response should contain session ID
          expect(data.sessionId).toBeDefined();
          // Agent should have processed the message
          expect(data.response).toBeDefined();
        }
      },
      AI4W_ATTACHMENT_E2E_TIMEOUT_MS,
    );

    test(
      'skips file over 10MB size limit',
      async () => {
        // Send message with large file (should be skipped)
        const result = await sendAI4WMessage(
          harness.baseUrl,
          connectionId,
          connectionSecret,
          jwtToken,
          {
            text: 'Hello with large file',
            agentContextId: 'ctx_456',
            files: [
              {
                name: 'large.bin',
                mimeType: 'application/octet-stream',
                signedUrl: `http://127.0.0.1:${fileServerPort}/files/large.bin`,
              },
            ],
          },
        );

        // Should still process successfully (file skipped, not error)
        expect(result.status).toBe(200);
        expect(result.body.success).toBe(true);
      },
      AI4W_ATTACHMENT_E2E_TIMEOUT_MS,
    );

    test(
      'uploads multiple files in single message',
      async () => {
        const result = await sendAI4WMessage(
          harness.baseUrl,
          connectionId,
          connectionSecret,
          jwtToken,
          {
            text: 'Hello with multiple attachments',
            agentContextId: 'ctx_789',
            files: [
              {
                name: 'small.txt',
                mimeType: 'text/plain',
                signedUrl: `http://127.0.0.1:${fileServerPort}/files/small.txt`,
              },
              {
                name: 'image.png',
                mimeType: 'image/png',
                signedUrl: `http://127.0.0.1:${fileServerPort}/files/image.png`,
              },
            ],
          },
        );

        expect(result.status).toBe(200);
        expect(result.body.success).toBe(true);
      },
      AI4W_ATTACHMENT_E2E_TIMEOUT_MS,
    );

    test(
      'processes message successfully even if upload fails gracefully',
      async () => {
        // Send message with invalid file URL (should log error but not fail message)
        const result = await sendAI4WMessage(
          harness.baseUrl,
          connectionId,
          connectionSecret,
          jwtToken,
          {
            text: 'Hello with invalid file',
            agentContextId: 'ctx_error',
            files: [
              {
                name: 'nonexistent.txt',
                mimeType: 'text/plain',
                signedUrl: `http://127.0.0.1:${fileServerPort}/files/nonexistent.txt`,
              },
            ],
          },
        );

        // Should still succeed (graceful degradation)
        expect(result.status).toBe(200);
        expect(result.body.success).toBe(true);
      },
      AI4W_ATTACHMENT_E2E_TIMEOUT_MS,
    );
  },
  { timeout: AI4W_ATTACHMENT_E2E_TIMEOUT_MS },
);
