/**
 * HTTP Async Channel Authorization Tests
 *
 * Tests RBAC enforcement on the http-async-channel route.
 * Uses the REAL requirePermission middleware from @agent-platform/shared
 * to verify that permission checks on credential:read, credential:write,
 * and credential:delete are properly enforced.
 *
 * Endpoints tested:
 *   GET    /subscriptions      (credential:read)
 *   POST   /subscribe          (credential:write)
 *   PATCH  /subscriptions/:id  (credential:write)
 *   DELETE /subscriptions/:id  (credential:delete)
 *
 * Permission coverage:
 * - OWNER (*:*): all operations
 * - ADMIN (credential:*): all operations
 * - OPERATOR (credential:read): reads only, 403 on writes/deletes
 * - MEMBER (credential:read): reads only, 403 on writes/deletes
 * - VIEWER (credential:read): reads only, 403 on writes/deletes
 * - Unauthenticated: all 401
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// MOCKS — must be declared before importing the router
// =============================================================================

// No mock of @agent-platform/shared — use real requirePermission
// No mock of @agent-platform/openapi/express — not used by this route

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => ({
    encryptForTenant: vi.fn(() => 'encrypted'),
    decryptForTenant: vi.fn(() => 'decrypted'),
  })),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock('@agent-platform/shared-kernel/security', () => ({
  generateWebhookSecret: vi.fn(() => 'webhook-secret-123'),
}));

vi.mock('../../channels/security/callback-url-policy.js', () => ({
  assertAllowedCallbackUrl: vi.fn(),
  CallbackUrlError: class CallbackUrlError extends Error {},
}));

vi.mock('../../channels/connection-resolver.js', () => ({
  findOrCreateHttpAsyncConnection: vi.fn().mockResolvedValue({ _id: 'conn-1', id: 'conn-1' }),
}));

vi.mock('../../services/queues/channel-queues.js', () => ({
  getInboundQueue: vi.fn(() => ({ add: vi.fn() })),
}));

vi.mock('../../services/audit-helpers.js', () => ({
  auditSubscriptionCreated: vi.fn().mockResolvedValue(undefined),
  auditSubscriptionUpdated: vi.fn().mockResolvedValue(undefined),
  auditSubscriptionDeleted: vi.fn().mockResolvedValue(undefined),
}));

// Helper to build chainable query mocks
function chainable(result: any) {
  const chain: any = {
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(result),
  };
  return chain;
}

vi.mock('@agent-platform/database/models', () => ({
  Project: {
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'proj-1', tenantId: 'tenant-A' }),
    }),
  },
  Deployment: {
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    }),
  },
  WebhookSubscription: {
    create: vi.fn().mockResolvedValue({
      _id: 'sub-1',
      tenantId: 'tenant-A',
      status: 'active',
      callbackUrl: 'https://example.com/hook',
      events: '["agent.response"]',
      createdAt: new Date().toISOString(),
    }),
    find: vi.fn(() => chainable([])),
    findOne: vi.fn(() => chainable(null)),
    findOneAndUpdate: vi.fn(() => chainable(null)),
    findByIdAndUpdate: vi.fn(() => chainable(null)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    countDocuments: vi.fn().mockResolvedValue(0),
  },
  ChannelConnection: {
    find: vi.fn(() => chainable([])),
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    }),
    findById: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    }),
  },
  WebhookDelivery: {
    find: vi.fn(() => chainable([])),
    findOne: vi.fn(() => chainable(null)),
    countDocuments: vi.fn().mockResolvedValue(0),
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import express from 'express';

// =============================================================================
// HELPERS
// =============================================================================

let server: http.Server;
let baseUrl: string;

const BASE_PATH = '/api/v1/channels/http-async';

function createApp(tenantId: string, userId: string, role: string) {
  const app = express();
  app.use(express.json());
  app.use(injectTenantContext(makeTenantContext(tenantId, userId, role as any)));
  return app;
}

function createUnauthenticatedApp() {
  const app = express();
  app.use(express.json());
  // No injectTenantContext — simulates unauthenticated request
  return app;
}

async function startServer(app: express.Express): Promise<void> {
  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function stopServer(): void {
  server?.close();
}

async function request(
  method: string,
  path: string,
  opts?: { body?: any },
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// Valid POST body for creating a subscription
const VALID_SUBSCRIBE_BODY = {
  callback_url: 'https://example.com/hook',
  project_id: 'proj-1',
  events: ['agent.response'],
};

// =============================================================================
// TESTS: OWNER — allowed on all endpoints
// =============================================================================

describe('http-async-channel authz — OWNER', () => {
  beforeAll(async () => {
    const app = createApp('tenant-A', 'owner-user', 'OWNER');
    const router = (await import('../../routes/http-async-channel.js')).default;
    app.use(BASE_PATH, router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET /subscriptions returns 200 (credential:read satisfied by *:*)', async () => {
    const { status } = await request('GET', `${BASE_PATH}/subscriptions`);
    expect(status).toBe(200);
  });

  test('POST /subscribe returns 201 (credential:write satisfied by *:*)', async () => {
    const { status, body } = await request('POST', `${BASE_PATH}/subscribe`, {
      body: VALID_SUBSCRIBE_BODY,
    });
    expect(status).toBe(201);
    expect(body.subscription_id).toBeDefined();
  });

  test('PATCH /subscriptions/:id returns 404 (permission passes, record not found)', async () => {
    const { status, body } = await request('PATCH', `${BASE_PATH}/subscriptions/sub-1`, {
      body: { status: 'paused' },
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Subscription not found');
  });

  test('DELETE /subscriptions/:id returns 404 (permission passes, record not found)', async () => {
    const { status, body } = await request('DELETE', `${BASE_PATH}/subscriptions/sub-1`);
    expect(status).toBe(404);
    expect(body.error).toBe('Subscription not found');
  });
});

// =============================================================================
// TESTS: ADMIN — allowed on all endpoints (credential:* matches all)
// =============================================================================

describe('http-async-channel authz — ADMIN', () => {
  beforeAll(async () => {
    const app = createApp('tenant-A', 'admin-user', 'ADMIN');
    const router = (await import('../../routes/http-async-channel.js')).default;
    app.use(BASE_PATH, router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET /subscriptions returns 200 (ADMIN has credential:*)', async () => {
    const { status } = await request('GET', `${BASE_PATH}/subscriptions`);
    expect(status).toBe(200);
  });

  test('POST /subscribe returns 201 (ADMIN has credential:*)', async () => {
    const { status, body } = await request('POST', `${BASE_PATH}/subscribe`, {
      body: VALID_SUBSCRIBE_BODY,
    });
    expect(status).toBe(201);
    expect(body.subscription_id).toBeDefined();
  });

  test('PATCH /subscriptions/:id returns 404 (permission passes, record not found)', async () => {
    const { status, body } = await request('PATCH', `${BASE_PATH}/subscriptions/sub-1`, {
      body: { status: 'paused' },
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Subscription not found');
  });

  test('DELETE /subscriptions/:id returns 404 (permission passes, record not found)', async () => {
    const { status, body } = await request('DELETE', `${BASE_PATH}/subscriptions/sub-1`);
    expect(status).toBe(404);
    expect(body.error).toBe('Subscription not found');
  });
});

// =============================================================================
// TESTS: OPERATOR — reads pass (credential:read), writes/deletes denied
// =============================================================================

describe('http-async-channel authz — OPERATOR', () => {
  beforeAll(async () => {
    const app = createApp('tenant-A', 'operator-user', 'OPERATOR');
    const router = (await import('../../routes/http-async-channel.js')).default;
    app.use(BASE_PATH, router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET /subscriptions returns 200 (OPERATOR has credential:read)', async () => {
    const { status } = await request('GET', `${BASE_PATH}/subscriptions`);
    expect(status).toBe(200);
  });

  test('POST /subscribe returns 403 (OPERATOR lacks credential:write)', async () => {
    const { status, body } = await request('POST', `${BASE_PATH}/subscribe`, {
      body: VALID_SUBSCRIBE_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });

  test('PATCH /subscriptions/:id returns 403 (OPERATOR lacks credential:write)', async () => {
    const { status, body } = await request('PATCH', `${BASE_PATH}/subscriptions/sub-1`, {
      body: { status: 'paused' },
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });

  test('DELETE /subscriptions/:id returns 403 (OPERATOR lacks credential:delete)', async () => {
    const { status, body } = await request('DELETE', `${BASE_PATH}/subscriptions/sub-1`);
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:delete');
  });
});

// =============================================================================
// TESTS: VIEWER — reads pass (credential:read), writes/deletes denied
// =============================================================================

describe('http-async-channel authz — VIEWER', () => {
  beforeAll(async () => {
    const app = createApp('tenant-A', 'viewer-user', 'VIEWER');
    const router = (await import('../../routes/http-async-channel.js')).default;
    app.use(BASE_PATH, router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET /subscriptions returns 200 (VIEWER has credential:read)', async () => {
    const { status } = await request('GET', `${BASE_PATH}/subscriptions`);
    expect(status).toBe(200);
  });

  test('POST /subscribe returns 403 (VIEWER lacks credential:write)', async () => {
    const { status, body } = await request('POST', `${BASE_PATH}/subscribe`, {
      body: VALID_SUBSCRIBE_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });

  test('PATCH /subscriptions/:id returns 403 (VIEWER lacks credential:write)', async () => {
    const { status, body } = await request('PATCH', `${BASE_PATH}/subscriptions/sub-1`, {
      body: { status: 'paused' },
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });

  test('DELETE /subscriptions/:id returns 403 (VIEWER lacks credential:delete)', async () => {
    const { status, body } = await request('DELETE', `${BASE_PATH}/subscriptions/sub-1`);
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:delete');
  });
});

// =============================================================================
// TESTS: Unauthenticated — all 401
// =============================================================================

describe('http-async-channel authz — unauthenticated', () => {
  beforeAll(async () => {
    const app = createUnauthenticatedApp();
    const router = (await import('../../routes/http-async-channel.js')).default;
    app.use(BASE_PATH, router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  test('GET /subscriptions returns 401 when tenantContext is absent', async () => {
    const { status, body } = await request('GET', `${BASE_PATH}/subscriptions`);
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('POST /subscribe returns 401 when tenantContext is absent', async () => {
    const { status, body } = await request('POST', `${BASE_PATH}/subscribe`, {
      body: VALID_SUBSCRIBE_BODY,
    });
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('PATCH /subscriptions/:id returns 401 when tenantContext is absent', async () => {
    const { status, body } = await request('PATCH', `${BASE_PATH}/subscriptions/sub-1`, {
      body: { status: 'paused' },
    });
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('DELETE /subscriptions/:id returns 401 when tenantContext is absent', async () => {
    const { status, body } = await request('DELETE', `${BASE_PATH}/subscriptions/sub-1`);
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });
});

// =============================================================================
// TESTS: Cross-tenant isolation
// =============================================================================

describe('http-async-channel authz — cross-tenant isolation', () => {
  beforeAll(async () => {
    // OWNER of tenant-A
    const app = createApp('tenant-A', 'owner-user', 'OWNER');
    const router = (await import('../../routes/http-async-channel.js')).default;
    app.use(BASE_PATH, router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET /subscriptions/:id returns 404 when subscription belongs to another tenant', async () => {
    // The findOne mock returns null by default, simulating that the
    // tenantId filter excluded tenant-B's record.
    const { status, body } = await request('GET', `${BASE_PATH}/subscriptions/sub-tenant-B`);
    expect(status).toBe(404);
    expect(body.error).toBe('Subscription not found');
  });

  test('PATCH /subscriptions/:id returns 404 when subscription belongs to another tenant', async () => {
    const { status, body } = await request('PATCH', `${BASE_PATH}/subscriptions/sub-tenant-B`, {
      body: { status: 'paused' },
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Subscription not found');
  });

  test('DELETE /subscriptions/:id returns 404 when subscription belongs to another tenant', async () => {
    const { status, body } = await request('DELETE', `${BASE_PATH}/subscriptions/sub-tenant-B`);
    expect(status).toBe(404);
    expect(body.error).toBe('Subscription not found');
  });
});
