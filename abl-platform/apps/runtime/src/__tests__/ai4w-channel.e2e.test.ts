/**
 * AI4W Channel E2E Tests
 *
 * Exercises the full AI4W inbound message flow through the real route handler
 * with dual-layer auth (HMAC + JWT), body validation, and session key generation.
 *
 * Uses a real runtime API harness with in-memory MongoDB and an in-process JWKS
 * server for JWT verification.
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
  requestJson,
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
  options?: {
    requestId?: string;
    timestamp?: string;
    signature?: string;
    omitHeaders?: string[];
  },
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const bodyStr = JSON.stringify(body);
  const requestId = options?.requestId ?? crypto.randomUUID();
  const timestamp = options?.timestamp ?? new Date().toISOString();
  const signature = options?.signature ?? signHmac(connectionSecret, requestId, timestamp, bodyStr);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwtToken}`,
    'X-Signature-Nonce': requestId,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
  };

  // Allow tests to omit specific headers
  if (options?.omitHeaders) {
    for (const h of options.omitHeaders) {
      delete headers[h];
    }
  }

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

const describeAI4WE2E = isRedisServerHarnessAvailable() ? describe.sequential : describe.skip;

describeAI4WE2E('AI4W channel E2E', () => {
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

    // 3. Set AI4W env vars BEFORE importing modules via harness
    process.env.AI4W_TRUSTED_ISSUERS = TEST_ISSUER;
    process.env.AI4W_JWT_AUDIENCE = TEST_AUDIENCE;
    process.env.AI4W_ALLOW_HTTP_ISSUERS = 'true';
    process.env.AI4W_HMAC_TIMESTAMP_TOLERANCE_MS = '30000';

    // 4. Start Redis
    redis = await startRedisServerHarness();
    mockLlm = await startMockLLM();

    // 5. Start runtime harness
    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
        app.use('/api/projects/:projectId/project-io', projectIoRouter);
        app.use('/api/projects/:projectId/deployments', deploymentsRouter);
        app.use('/api/projects/:projectId/channel-connections', channelConnectionsRouter);
        // Mount the AI4W channel route — the router includes its own JSON body parser
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
      uniqueEmail('ai4w-admin'),
      uniqueSlug('tenant-ai4w'),
      uniqueSlug('project-ai4w'),
    );

    await provisionBasicAgentProject(
      harness,
      admin.token,
      admin.tenantId,
      admin.projectId,
      mockLlm.url,
    );

    // Create channel connection via API
    const connection = await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'ai4w',
      display_name: 'AI4W Test Connection',
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
    delete process.env.AI4W_TRUSTED_ISSUERS;
    delete process.env.AI4W_JWT_AUDIENCE;
    delete process.env.AI4W_ALLOW_HTTP_ISSUERS;
    delete process.env.AI4W_HMAC_TIMESTAMP_TOLERANCE_MS;
  }, AI4W_E2E_TIMEOUT_MS);

  // =========================================================================
  // HAPPY PATH
  // =========================================================================

  test(
    'sync message round-trip returns 200 with expected shape',
    async () => {
      const jwt = await mintJwt({});
      const res = await sendAI4WMessage(harness.baseUrl, connectionId, connectionSecret, jwt, {
        text: 'Hello from AI4W',
        agentContextId: 'ctx_test_1',
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          sessionId: expect.any(String),
        }),
      });
      expect(res.headers.get('x-response-mode-used')).toBe('sync');
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'sync message round-trip includes response provenance metadata',
    async () => {
      const jwt = await mintJwt({});
      const res = await sendAI4WMessage(harness.baseUrl, connectionId, connectionSecret, jwt, {
        text: 'Hello from AI4W provenance',
        agentContextId: 'ctx_test_provenance_sync',
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          responseMetadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
        }),
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // HMAC FAILURES
  // =========================================================================

  test(
    'wrong connection secret returns 401',
    async () => {
      const jwt = await mintJwt({});
      const res = await sendAI4WMessage(harness.baseUrl, connectionId, 'wrong-secret-value', jwt, {
        text: 'Hello',
        agentContextId: 'ctx_test',
      });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'tampered body returns 401',
    async () => {
      const jwt = await mintJwt({});
      const bodyStr = JSON.stringify({ text: 'Hello', agentContextId: 'ctx_test' });
      const requestId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const signature = signHmac(connectionSecret, requestId, timestamp, bodyStr);

      // Send a different body than what was signed
      const tamperedBody = JSON.stringify({ text: 'Tampered!', agentContextId: 'ctx_test' });

      const res = await fetch(`${harness.baseUrl}/api/v1/channels/ai4w/${connectionId}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'X-Signature-Nonce': requestId,
          'X-Timestamp': timestamp,
          'X-Signature': signature,
        },
        body: tamperedBody,
      });

      expect(res.status).toBe(401);
      const resBody = (await res.json()) as Record<string, unknown>;
      expect(resBody).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // JWT FAILURES
  // =========================================================================

  test(
    'expired JWT returns 401',
    async () => {
      const jwt = await mintJwt({ expiresIn: '-1s' });
      const res = await sendAI4WMessage(harness.baseUrl, connectionId, connectionSecret, jwt, {
        text: 'Hello',
        agentContextId: 'ctx_test',
      });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'wrong JWT audience returns 401',
    async () => {
      const jwt = await mintJwt({ audience: 'urn:wrong:audience' });
      const res = await sendAI4WMessage(harness.baseUrl, connectionId, connectionSecret, jwt, {
        text: 'Hello',
        agentContextId: 'ctx_test',
      });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // REPLAY PROTECTION
  // =========================================================================

  test(
    'duplicate X-Signature-Nonce returns 409',
    async () => {
      const jwt = await mintJwt({});
      const requestId = crypto.randomUUID();

      // First request should succeed
      const res1 = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        jwt,
        { text: 'Hello', agentContextId: 'ctx_test' },
        { requestId },
      );
      expect(res1.status).toBe(200);

      // Second request with same requestId should be rejected as replay
      const res2 = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        jwt,
        { text: 'Hello again', agentContextId: 'ctx_test' },
        { requestId },
      );
      expect(res2.status).toBe(409);
      expect(res2.body).toMatchObject({
        success: false,
        error: { code: 'REPLAY_DETECTED' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // TIMESTAMP VALIDATION
  // =========================================================================

  test(
    'timestamp outside window returns 401',
    async () => {
      const jwt = await mintJwt({});
      const staleTimestamp = new Date(Date.now() - 60_000).toISOString(); // 60s ago

      const res = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        jwt,
        { text: 'Hello', agentContextId: 'ctx_test' },
        { timestamp: staleTimestamp },
      );

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // CONNECTION NOT FOUND
  // =========================================================================

  test(
    'non-existent connectionId returns 401 (not 404)',
    async () => {
      const jwt = await mintJwt({});
      const res = await sendAI4WMessage(
        harness.baseUrl,
        'ai4w_c_nonexistent0000000000000000',
        connectionSecret,
        jwt,
        { text: 'Hello', agentContextId: 'ctx_test' },
      );

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // SESSION ISOLATION
  // =========================================================================

  test(
    'different emails produce different session keys',
    async () => {
      const jwtA = await mintJwt({ email: 'alice@test.com' });
      const jwtB = await mintJwt({ email: 'bob@test.com' });

      const resA = await sendAI4WMessage(harness.baseUrl, connectionId, connectionSecret, jwtA, {
        text: 'Hello from Alice',
        agentContextId: 'ctx_shared',
      });
      expect(resA.status).toBe(200);

      const resB = await sendAI4WMessage(harness.baseUrl, connectionId, connectionSecret, jwtB, {
        text: 'Hello from Bob',
        agentContextId: 'ctx_shared',
      });
      expect(resB.status).toBe(200);

      const sessionA = (resA.body as { data?: { sessionId?: string } }).data?.sessionId;
      const sessionB = (resB.body as { data?: { sessionId?: string } }).data?.sessionId;

      expect(sessionA).toBeTruthy();
      expect(sessionB).toBeTruthy();
      expect(sessionA).not.toBe(sessionB);
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // BODY VALIDATION
  // =========================================================================

  test(
    'invalid body (missing required fields) returns 400',
    async () => {
      const jwt = await mintJwt({});
      // Send a body missing the required `agentContextId` field
      const bodyStr = JSON.stringify({ text: 'Hello' });
      const requestId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const signature = signHmac(connectionSecret, requestId, timestamp, bodyStr);

      const res = await fetch(`${harness.baseUrl}/api/v1/channels/ai4w/${connectionId}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'X-Signature-Nonce': requestId,
          'X-Timestamp': timestamp,
          'X-Signature': signature,
        },
        body: bodyStr,
      });

      expect(res.status).toBe(400);
      const resBody = (await res.json()) as Record<string, unknown>;
      expect(resBody).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'empty text returns 400',
    async () => {
      const jwt = await mintJwt({});
      // text must be min 1 char per schema
      const bodyStr = JSON.stringify({ text: '', agentContextId: 'ctx_test' });
      const requestId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const signature = signHmac(connectionSecret, requestId, timestamp, bodyStr);

      const res = await fetch(`${harness.baseUrl}/api/v1/channels/ai4w/${connectionId}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'X-Signature-Nonce': requestId,
          'X-Timestamp': timestamp,
          'X-Signature': signature,
        },
        body: bodyStr,
      });

      expect(res.status).toBe(400);
      const resBody = (await res.json()) as Record<string, unknown>;
      expect(resBody).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // MISSING HMAC HEADERS
  // =========================================================================

  test(
    'missing X-Signature header returns 401',
    async () => {
      const jwt = await mintJwt({});
      const bodyStr = JSON.stringify({ text: 'Hello', agentContextId: 'ctx_test' });
      const requestId = crypto.randomUUID();
      const timestamp = new Date().toISOString();

      const res = await fetch(`${harness.baseUrl}/api/v1/channels/ai4w/${connectionId}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'X-Signature-Nonce': requestId,
          'X-Timestamp': timestamp,
          // X-Signature intentionally omitted
        },
        body: bodyStr,
      });

      expect(res.status).toBe(401);
      const resBody = (await res.json()) as Record<string, unknown>;
      expect(resBody).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // MALFORMED BEARER TOKEN
  // =========================================================================

  test(
    'malformed Bearer token returns 401',
    async () => {
      const res = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        'invalid-token-not-a-jwt',
        { text: 'Hello', agentContextId: 'ctx_test' },
      );

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'missing Authorization header returns 401',
    async () => {
      const bodyStr = JSON.stringify({ text: 'Hello', agentContextId: 'ctx_test' });
      const requestId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const signature = signHmac(connectionSecret, requestId, timestamp, bodyStr);

      const res = await fetch(`${harness.baseUrl}/api/v1/channels/ai4w/${connectionId}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-Nonce': requestId,
          'X-Timestamp': timestamp,
          'X-Signature': signature,
          // Authorization intentionally omitted
        },
        body: bodyStr,
      });

      expect(res.status).toBe(401);
      const resBody = (await res.json()) as Record<string, unknown>;
      expect(resBody).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // ACCOUNT ID BINDING
  // =========================================================================

  test(
    'accountId mismatch after binding returns 401',
    async () => {
      // First request binds accountId 'acc_first' to this connection
      const jwtFirst = await mintJwt({ accountId: 'acc_first' });
      const resFirst = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        jwtFirst,
        { text: 'Bind account', agentContextId: 'ctx_bind' },
      );
      expect(resFirst.status).toBe(200);

      // Second request with different accountId should be rejected
      const jwtSecond = await mintJwt({ accountId: 'acc_different' });
      const resSecond = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        jwtSecond,
        { text: 'Wrong account', agentContextId: 'ctx_bind' },
      );
      expect(resSecond.status).toBe(401);
      expect(resSecond.body).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // GET /info — HMAC+JWT auth, doubles as health check
  // =========================================================================

  async function sendAI4WInfo(
    baseUrl: string,
    connId: string,
    connSecret: string,
    jwtToken: string,
    options?: { requestId?: string; timestamp?: string; signature?: string },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const requestId = options?.requestId ?? crypto.randomUUID();
    const timestamp = options?.timestamp ?? new Date().toISOString();
    // GET has no body — sign over the empty string
    const signature = options?.signature ?? signHmac(connSecret, requestId, timestamp, '');

    const res = await fetch(`${baseUrl}/api/v1/channels/ai4w/${connId}/info`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'X-Signature-Nonce': requestId,
        'X-Timestamp': timestamp,
        'X-Signature': signature,
      },
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text.length ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
  }

  test(
    '/info returns meta + pinning + currentDeployment with valid HMAC+JWT',
    async () => {
      const jwt = await mintJwt({});
      const res = await sendAI4WInfo(harness.baseUrl, connectionId, connectionSecret, jwt);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          connectionId,
          channelType: 'ai4w',
          status: 'active',
          tenantId: expect.any(String),
          projectId: expect.any(String),
          agentCount: expect.any(Number),
          config: expect.objectContaining({
            callbackBaseUrl: expect.any(String),
            responseMode: expect.any(String),
          }),
          pinning: expect.objectContaining({
            deploymentId: expect.any(String),
            environment: 'production',
          }),
          currentDeployment: expect.objectContaining({
            deploymentId: expect.any(String),
            entryAgentName: 'ai4w_test_agent',
            createdAt: expect.any(String),
          }),
        }),
      });

      // Never leaks the secret
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('connectionSecret');
      expect(bodyStr).not.toContain(connectionSecret);
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    '/info with wrong HMAC returns uniform 401',
    async () => {
      const jwt = await mintJwt({});
      const res = await sendAI4WInfo(harness.baseUrl, connectionId, connectionSecret, jwt, {
        signature: 'sha256=deadbeef',
      });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    '/info on unknown connectionId returns uniform 401 (no existence oracle)',
    async () => {
      const jwt = await mintJwt({});
      const fakeConnId = 'ai4w_c_' + '0'.repeat(32);
      const res = await sendAI4WInfo(harness.baseUrl, fakeConnId, connectionSecret, jwt);
      expect(res.status).toBe(401);
    },
    AI4W_E2E_TIMEOUT_MS,
  );
});
