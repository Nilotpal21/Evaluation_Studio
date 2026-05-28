/**
 * AI4W Channel Streaming & Async E2E Tests
 *
 * Exercises SSE streaming, async response mode, mode fallback/default,
 * SSE concurrent connection limits, and X-Response-Mode-Used header
 * through the real AI4W route handler with dual-layer auth.
 *
 * Uses the same runtime API harness as ai4w-channel.e2e.test.ts.
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
  updateChannelConnection,
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
// Signed request helper (fetch-based for sync/async)
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
    responseMode?: string;
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

  if (options?.responseMode) {
    headers['X-Response-Mode'] = options.responseMode;
  }

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
// SSE request helper using raw node http
// ---------------------------------------------------------------------------

interface SSEEvent {
  event: string;
  data: string;
}

function sendSSERequest(
  baseUrl: string,
  connectionId: string,
  connectionSecret: string,
  jwtToken: string,
  body: { text: string; agentContextId: string; [key: string]: unknown },
  options?: {
    requestId?: string;
    timestamp?: string;
  },
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  events: SSEEvent[];
  rawBody: string;
}> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const requestId = options?.requestId ?? crypto.randomUUID();
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const signature = signHmac(connectionSecret, requestId, timestamp, bodyStr);

    const url = new URL(`${baseUrl}/api/v1/channels/ai4w/${connectionId}/message`);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwtToken}`,
          'X-Signature-Nonce': requestId,
          'X-Timestamp': timestamp,
          'X-Signature': signature,
          'X-Response-Mode': 'stream',
          Accept: 'text/event-stream',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          const events = parseSSEEvents(rawBody);
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            events,
            rawBody,
          });
        });
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function parseSSEEvents(raw: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  let currentEvent = '';
  let currentData = '';

  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6).trim();
    } else if (line.trim() === '' && currentEvent) {
      events.push({ event: currentEvent, data: currentData });
      currentEvent = '';
      currentData = '';
    }
  }

  // Handle final event if stream doesn't end with double newline
  if (currentEvent && currentData) {
    events.push({ event: currentEvent, data: currentData });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Test suite — requires Redis for replay protection and SSE limits
// ---------------------------------------------------------------------------

const describeAI4WStreaming = isRedisServerHarnessAvailable() ? describe.sequential : describe.skip;

describeAI4WStreaming('AI4W channel streaming & async E2E', () => {
  let harness: RuntimeApiHarness;
  let redis: RedisServerHarness;
  let mockLlm: MockLLM;
  let adminToken: string;
  let adminProjectId: string;

  // Per-test channel state
  let channelConnectionRecordId: string;
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

    // Populate the trusted-issuer registry now that env vars are set.
    // The harness loads the runtime module but doesn't run startServer(), so
    // we call the init path explicitly to mirror production startup.
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
      uniqueEmail('ai4w-stream'),
      uniqueSlug('tenant-stream'),
      uniqueSlug('project-stream'),
    );
    adminToken = admin.token;
    adminProjectId = admin.projectId;

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
      display_name: 'AI4W Stream Test Connection',
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
    channelConnectionRecordId = connection.id;
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
  // SSE STREAMING
  // =========================================================================

  test(
    'SSE stream returns text/event-stream with chunk and done events',
    async () => {
      const jwt = await mintJwt({});
      const result = await sendSSERequest(harness.baseUrl, connectionId, connectionSecret, jwt, {
        text: 'Hello streaming',
        agentContextId: 'ctx_stream_1',
      });

      expect(result.statusCode).toBe(200);
      expect(result.headers['content-type']).toContain('text/event-stream');

      // Should have at least one chunk event and one done event
      const chunkEvents = result.events.filter((e) => e.event === 'chunk');
      const doneEvents = result.events.filter((e) => e.event === 'done');

      expect(chunkEvents.length).toBeGreaterThanOrEqual(1);
      expect(doneEvents.length).toBe(1);

      // Verify chunk event data is valid JSON with sessionId
      const chunkData = JSON.parse(chunkEvents[0].data) as Record<string, unknown>;
      expect(chunkData).toHaveProperty('sessionId');
      expect(chunkData.sessionId).toEqual(expect.any(String));

      // Verify done event data is valid JSON with sessionId
      const doneData = JSON.parse(doneEvents[0].data) as Record<string, unknown>;
      expect(doneData).toHaveProperty('sessionId');
      expect(doneData).toMatchObject({
        outcomeStatus: 'ok',
        responseMetadata: {
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'SSE stream sets X-Response-Mode-Used: stream header',
    async () => {
      const jwt = await mintJwt({});
      const result = await sendSSERequest(harness.baseUrl, connectionId, connectionSecret, jwt, {
        text: 'Hello streaming header',
        agentContextId: 'ctx_stream_header',
      });

      expect(result.statusCode).toBe(200);
      expect(result.headers['x-response-mode-used']).toBe('stream');
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'SSE stream chunk events arrive before done event',
    async () => {
      const jwt = await mintJwt({});
      const result = await sendSSERequest(harness.baseUrl, connectionId, connectionSecret, jwt, {
        text: 'Order test',
        agentContextId: 'ctx_order',
      });

      expect(result.statusCode).toBe(200);
      expect(result.events.length).toBeGreaterThanOrEqual(2);

      // done event should be the last event
      const lastEvent = result.events[result.events.length - 1];
      expect(lastEvent.event).toBe('done');

      // All events before the last should be chunk events
      for (let i = 0; i < result.events.length - 1; i++) {
        expect(result.events[i].event).toBe('chunk');
      }
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // ASYNC MODE
  // =========================================================================

  test(
    'async mode returns 202 with requestId',
    async () => {
      const jwt = await mintJwt({});
      const res = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        jwt,
        { text: 'Hello async', agentContextId: 'ctx_async_1' },
        { responseMode: 'async' },
      );

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          requestId: expect.any(String),
        }),
      });

      // requestId should be a valid UUID
      const requestId = (res.body as { data?: { requestId?: string } }).data?.requestId;
      expect(requestId).toBeTruthy();
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'async mode sets X-Response-Mode-Used: async header',
    async () => {
      const jwt = await mintJwt({});
      const res = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        jwt,
        { text: 'Hello async header', agentContextId: 'ctx_async_header' },
        { responseMode: 'async' },
      );

      expect(res.status).toBe(202);
      expect(res.headers.get('x-response-mode-used')).toBe('async');
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'async callback payload includes response provenance metadata',
    async () => {
      let resolveCallback:
        | ((value: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }) => void)
        | null = null;
      const callbackReceived = new Promise<{
        headers: http.IncomingHttpHeaders;
        body: Record<string, unknown>;
      }>((resolve) => {
        resolveCallback = resolve;
      });

      const callbackServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          resolveCallback?.({
            headers: req.headers,
            body: JSON.parse(rawBody) as Record<string, unknown>,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });

      await new Promise<void>((resolve) => callbackServer.listen(0, '127.0.0.1', () => resolve()));
      const callbackPort = (callbackServer.address() as AddressInfo).port;
      const callbackUrl = `http://127.0.0.1:${callbackPort}/callback`;

      try {
        await updateChannelConnection(
          harness,
          adminToken,
          adminProjectId,
          channelConnectionRecordId,
          {
            config: {
              callbackBaseUrl: callbackUrl,
              responseMode: 'async',
              ai4wAccountId: null,
              provisionedBy: 'manual',
              lastUsedAt: null,
            },
          },
        );

        const jwt = await mintJwt({});
        const res = await sendAI4WMessage(
          harness.baseUrl,
          connectionId,
          connectionSecret,
          jwt,
          { text: 'Hello async provenance', agentContextId: 'ctx_async_provenance' },
          { responseMode: 'async' },
        );

        expect(res.status).toBe(202);
        const requestId = (res.body as { data?: { requestId?: string } }).data?.requestId;
        expect(requestId).toEqual(expect.any(String));

        const callback = await Promise.race([
          callbackReceived,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Timed out waiting for AI4W callback')), 15000),
          ),
        ]);

        expect(callback.headers['x-signature']).toEqual(expect.any(String));
        expect(callback.body).toMatchObject({
          eventType: 'agent.response',
          responseMetadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
          metadata: {
            requestId,
            connectionId,
            outcomeStatus: 'ok',
          },
        });
      } finally {
        await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
      }
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // MODE FALLBACK / DEFAULT
  // =========================================================================

  test(
    'no X-Response-Mode header defaults to sync',
    async () => {
      const jwt = await mintJwt({});
      const res = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        jwt,
        { text: 'Hello default mode', agentContextId: 'ctx_default' },
        // No responseMode set
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('x-response-mode-used')).toBe('sync');
      expect(res.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          sessionId: expect.any(String),
        }),
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'invalid X-Response-Mode falls back to sync',
    async () => {
      const jwt = await mintJwt({});
      const res = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        jwt,
        { text: 'Hello invalid mode', agentContextId: 'ctx_invalid_mode' },
        { responseMode: 'websocket' },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('x-response-mode-used')).toBe('sync');
      expect(res.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          sessionId: expect.any(String),
        }),
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'explicit X-Response-Mode: sync works correctly',
    async () => {
      const jwt = await mintJwt({});
      const res = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        jwt,
        { text: 'Hello explicit sync', agentContextId: 'ctx_explicit_sync' },
        { responseMode: 'sync' },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('x-response-mode-used')).toBe('sync');
      expect(res.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          sessionId: expect.any(String),
        }),
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // X-Response-Mode-Used HEADER VERIFICATION
  // =========================================================================

  test(
    'X-Response-Mode-Used is set for all three modes',
    async () => {
      // Sync
      const jwtSync = await mintJwt({});
      const syncRes = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        jwtSync,
        { text: 'Mode check sync', agentContextId: 'ctx_mode_sync' },
        { responseMode: 'sync' },
      );
      expect(syncRes.headers.get('x-response-mode-used')).toBe('sync');

      // Async
      const jwtAsync = await mintJwt({});
      const asyncRes = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        jwtAsync,
        { text: 'Mode check async', agentContextId: 'ctx_mode_async' },
        { responseMode: 'async' },
      );
      expect(asyncRes.headers.get('x-response-mode-used')).toBe('async');

      // Stream (via raw HTTP to verify header on SSE response)
      const jwtStream = await mintJwt({});
      const streamRes = await sendSSERequest(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        jwtStream,
        { text: 'Mode check stream', agentContextId: 'ctx_mode_stream' },
      );
      expect(streamRes.headers['x-response-mode-used']).toBe('stream');
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // SSE CONCURRENT CONNECTION LIMIT
  // =========================================================================

  test(
    'exceeding SSE connection limit returns 503',
    async () => {
      // Set a low SSE limit for testing
      const originalLimit = process.env.AI4W_MAX_SSE_CONNECTIONS_PER_TENANT;
      process.env.AI4W_MAX_SSE_CONNECTIONS_PER_TENANT = '2';

      try {
        // We need to saturate the SSE counter in Redis directly since our
        // placeholder SSE connections complete immediately (they send chunk+done
        // and close). Instead, set the counter to the limit in Redis.
        const Redis = (await import('ioredis')).default;
        const redisClient = new Redis(redis.url, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
        });
        await redisClient.connect();

        // Find the tenantId by sending a sync request first
        const jwtForDiscovery = await mintJwt({});
        const discoveryRes = await sendAI4WMessage(
          harness.baseUrl,
          connectionId,
          connectionSecret,
          jwtForDiscovery,
          { text: 'Discovery', agentContextId: 'ctx_discovery' },
          { responseMode: 'sync' },
        );
        expect(discoveryRes.status).toBe(200);

        // Look up the connection's tenantId from the channel connection model
        const { ChannelConnection } = await import('@agent-platform/database/models');
        const conn = await ChannelConnection.findOne({ connectionId });
        expect(conn).toBeTruthy();
        const tenantId = conn!.tenantId;

        // Set the SSE counter just at the limit (2), so the next incr will be 3 > 2
        const sseCounterKey = `ai4w:sse:count:${tenantId}`;
        await redisClient.set(sseCounterKey, '2');
        await redisClient.expire(sseCounterKey, 180);

        // Now a stream request should exceed the limit (incr to 3 > 2)
        const jwtStream = await mintJwt({});
        const bodyStr = JSON.stringify({ text: 'Over limit', agentContextId: 'ctx_limit' });
        const requestId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        const signature = signHmac(connectionSecret, requestId, timestamp, bodyStr);

        const res = await fetch(`${harness.baseUrl}/api/v1/channels/ai4w/${connectionId}/message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwtStream}`,
            'X-Signature-Nonce': requestId,
            'X-Timestamp': timestamp,
            'X-Signature': signature,
            'X-Response-Mode': 'stream',
          },
          body: bodyStr,
        });

        expect(res.status).toBe(503);
        const resBody = (await res.json()) as Record<string, unknown>;
        expect(resBody).toMatchObject({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE' },
        });

        await redisClient.quit();
      } finally {
        if (originalLimit === undefined) {
          delete process.env.AI4W_MAX_SSE_CONNECTIONS_PER_TENANT;
        } else {
          process.env.AI4W_MAX_SSE_CONNECTIONS_PER_TENANT = originalLimit;
        }
      }
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // SSE STREAM — AUTH FAILURES STILL RETURN JSON, NOT SSE
  // =========================================================================

  test(
    'SSE stream with invalid HMAC returns 401 JSON, not SSE',
    async () => {
      const jwt = await mintJwt({});
      const res = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        'wrong-secret-for-stream',
        jwt,
        { text: 'Bad HMAC stream', agentContextId: 'ctx_bad_hmac_stream' },
        { responseMode: 'stream' },
      );

      // Auth failures happen before mode branching — should be normal JSON 401
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // ASYNC MODE — UNIQUE REQUEST IDS
  // =========================================================================

  test(
    'multiple async requests return unique requestIds',
    async () => {
      const requestIds = new Set<string>();

      for (let i = 0; i < 3; i++) {
        const jwt = await mintJwt({});
        const res = await sendAI4WMessage(
          harness.baseUrl,
          connectionId,
          connectionSecret,
          jwt,
          { text: `Async request ${i}`, agentContextId: `ctx_multi_async_${i}` },
          { responseMode: 'async' },
        );

        expect(res.status).toBe(202);
        const data = res.body as { data?: { requestId?: string } };
        expect(data.data?.requestId).toBeTruthy();
        requestIds.add(data.data!.requestId!);
      }

      // All 3 requests should have unique requestIds
      expect(requestIds.size).toBe(3);
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // STRUCTURED ERROR HANDLING IN SSE
  // =========================================================================

  test(
    'SSE done event includes outcomeStatus and errorCode on non-ok outcomes',
    async () => {
      const jwt = await mintJwt({});
      const sseResult = await sendSSERequest(harness.baseUrl, connectionId, connectionSecret, jwt, {
        text: 'Hello from error test',
        agentContextId: 'ctx_error_test_001',
      });

      expect(sseResult.statusCode).toBe(200);
      expect(sseResult.headers['content-type']).toContain('text/event-stream');

      const doneEvent = sseResult.events.find((e) => e.event === 'done');
      expect(doneEvent).toBeDefined();

      const doneData = JSON.parse(doneEvent!.data);
      expect(doneData.sessionId).toBeTruthy();
      expect(doneData.outcomeStatus).toBeTruthy();
      // If outcome is ok, no errorCode should be present
      // If outcome is not ok, errorCode must be a valid AI4W error code
      if (doneData.outcomeStatus !== 'ok') {
        expect(doneData.errorCode).toMatch(
          /^(NO_ACTIVE_DEPLOYMENT|AGENT_CONFIG_CHANGED|MODEL_CREDENTIAL_MISSING|EXECUTION_TIMEOUT|COMPILATION_ERROR|EMPTY_RESPONSE|SESSION_BUSY|INTERNAL_ERROR)$/,
        );
        expect(doneData.errorMessage).toBeTruthy();
        expect(typeof doneData.retryable).toBe('boolean');
      }
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'sync response includes errorCode and errorMessage on non-ok outcome',
    async () => {
      const jwt = await mintJwt({});
      const res = await sendAI4WMessage(
        harness.baseUrl,
        connectionId,
        connectionSecret,
        jwt,
        { text: 'Hello sync error test', agentContextId: 'ctx_sync_error_001' },
        { responseMode: 'sync' },
      );

      expect(res.status).toBe(200);
      const data = res.body as {
        success: boolean;
        data?: {
          response: string;
          sessionId: string;
          outcomeStatus: string;
          errorCode?: string;
          errorMessage?: string;
          retryable?: boolean;
        };
      };
      expect(data.success).toBe(true);
      expect(data.data?.sessionId).toBeTruthy();
      expect(data.data?.outcomeStatus).toBeTruthy();
      // If outcome is not ok, structured error fields must be present
      if (data.data?.outcomeStatus !== 'ok') {
        expect(data.data?.errorCode).toMatch(
          /^(NO_ACTIVE_DEPLOYMENT|AGENT_CONFIG_CHANGED|MODEL_CREDENTIAL_MISSING|EXECUTION_TIMEOUT|COMPILATION_ERROR|EMPTY_RESPONSE|SESSION_BUSY|INTERNAL_ERROR)$/,
        );
        expect(data.data?.errorMessage).toBeTruthy();
        expect(typeof data.data?.retryable).toBe('boolean');
      }
    },
    AI4W_E2E_TIMEOUT_MS,
  );

  test(
    'SSE done event error fields match expected AI4W error code format',
    async () => {
      // Use the standard connection — the outcome may be ok or error depending
      // on agent compilation. Either way, verify the error field contract:
      // if outcomeStatus !== 'ok', errorCode/errorMessage/retryable must exist.
      const jwt = await mintJwt({});
      const sseResult = await sendSSERequest(harness.baseUrl, connectionId, connectionSecret, jwt, {
        text: 'Verify error format',
        agentContextId: 'ctx_error_format_001',
      });

      expect(sseResult.statusCode).toBe(200);
      const doneEvent = sseResult.events.find((e) => e.event === 'done');
      expect(doneEvent).toBeDefined();

      const doneData = JSON.parse(doneEvent!.data);
      expect(doneData.sessionId).toBeTruthy();
      expect(doneData.outcomeStatus).toBeTruthy();

      if (doneData.outcomeStatus !== 'ok') {
        // Structured error contract: all three fields must be present
        expect(doneData.errorCode).toMatch(
          /^(NO_ACTIVE_DEPLOYMENT|AGENT_CONFIG_CHANGED|MODEL_CREDENTIAL_MISSING|EXECUTION_TIMEOUT|COMPILATION_ERROR|EMPTY_RESPONSE|SESSION_BUSY|INTERNAL_ERROR)$/,
        );
        expect(typeof doneData.errorMessage).toBe('string');
        expect(doneData.errorMessage.length).toBeGreaterThan(0);
        expect(typeof doneData.retryable).toBe('boolean');
      } else {
        // When ok, no error fields should be present
        expect(doneData.errorCode).toBeUndefined();
      }
    },
    AI4W_E2E_TIMEOUT_MS,
  );
});
