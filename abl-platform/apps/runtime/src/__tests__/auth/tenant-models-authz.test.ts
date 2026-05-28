/**
 * Tenant Models Authorization Tests
 *
 * Tests RBAC enforcement on the tenant-models route.
 * Uses the REAL requirePermission middleware from @agent-platform/shared
 * to verify that permission checks on credential:read, credential:write,
 * and credential:delete are properly enforced.
 *
 * Permission matrix under test:
 *   GET    /                             — credential:read
 *   POST   /                             — credential:write
 *   PATCH  /:id                          — credential:write
 *   DELETE /:id                          — credential:delete
 *   POST   /:modelId/connections         — credential:write
 *
 * Roles tested:
 *   OWNER    (*:*):             all pass
 *   ADMIN    (credential:*):    all pass
 *   OPERATOR (credential:read): reads pass, writes/deletes 403
 *   VIEWER   (credential:read): reads pass, writes/deletes 403
 *   Unauthenticated:            all 401
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — must be declared before importing the router
// =============================================================================

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: any, ...handlers: any[]) => {
        const lastHandler = handlers[handlers.length - 1];
        const middlewares = handlers.slice(0, -1);
        (router as any)[method](path, ...middlewares, lastHandler);
      },
    };
  }),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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

vi.mock('../../repos/tenant-model-repo.js', () => ({
  findTenantModel: vi.fn().mockResolvedValue(null),
  findTenantModelWithConnections: vi.fn().mockResolvedValue(null),
  listTenantModels: vi.fn().mockResolvedValue([]),
  countTenantModels: vi.fn().mockResolvedValue(0),
  createTenantModel: vi.fn().mockResolvedValue({ _id: 'model-1', tenantId: 'tenant-A' }),
  updateTenantModel: vi.fn().mockResolvedValue(null),
  updateTenantModelInference: vi.fn().mockResolvedValue(null),
  findTenantModelConnections: vi.fn().mockResolvedValue([]),
  createTenantModelConnection: vi.fn().mockResolvedValue({ _id: 'conn-1' }),
  findTenantModelConnectionById: vi.fn().mockResolvedValue(null),
  updateTenantModelConnection: vi.fn().mockResolvedValue(null),
  deleteTenantModelConnection: vi.fn().mockResolvedValue(true),
  setConnectionPrimary: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/llm/session-llm-client.js', () => ({
  clearProviderCache: vi.fn(),
}));

vi.mock('@agent-platform/database/models', () => ({
  TenantModel: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const MODELS_BASE = '/api/tenants/tenant-A/models';

function createApp(tenantId: string, userId: string, role: string) {
  const app = express();
  app.use(express.json());
  app.use(injectTenantContext(makeTenantContext(tenantId, userId, role as any)));
  return app;
}

let server: http.Server;
let baseUrl: string;

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

// Valid POST body for creating a tenant model
const CREATE_MODEL_BODY = {
  displayName: 'Test Model',
  integrationType: 'easy',
  modelId: 'gpt-4o',
  provider: 'openai',
};

// Valid PATCH body for updating a tenant model
const UPDATE_MODEL_BODY = {
  displayName: 'Updated Model',
};

// Valid POST body for creating a connection
const CREATE_CONNECTION_BODY = {
  connectionName: 'Test Connection',
  authType: 'api_key',
};

// =============================================================================
// TESTS: OWNER — all endpoints pass (*:* wildcard)
// =============================================================================

describe('tenant-models authz — OWNER', () => {
  beforeAll(async () => {
    const app = createApp('tenant-A', 'owner-user', 'OWNER');
    const router = (await import('../../routes/tenant-models.js')).default;
    app.use('/api/tenants/:tenantId/models', router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET / passes auth (credential:read satisfied by *:*)', async () => {
    const { status } = await request('GET', MODELS_BASE);
    expect(status).not.toBe(403);
  });

  test('POST / passes auth (credential:write satisfied by *:*)', async () => {
    const { status } = await request('POST', MODELS_BASE, { body: CREATE_MODEL_BODY });
    expect(status).not.toBe(403);
  });

  test('PATCH /:id passes auth (credential:write satisfied by *:*)', async () => {
    const { status } = await request('PATCH', `${MODELS_BASE}/model-1`, {
      body: UPDATE_MODEL_BODY,
    });
    // 404 because findTenantModel returns null, but NOT 403
    expect(status).not.toBe(403);
  });

  test('DELETE /:id passes auth (credential:delete satisfied by *:*)', async () => {
    const { status } = await request('DELETE', `${MODELS_BASE}/model-1`);
    // 404 because findTenantModelWithConnections returns null, but NOT 403
    expect(status).not.toBe(403);
  });

  test('POST /:modelId/connections passes auth (credential:write satisfied by *:*)', async () => {
    const { status } = await request('POST', `${MODELS_BASE}/model-1/connections`, {
      body: CREATE_CONNECTION_BODY,
    });
    // 404 because findTenantModel returns null, but NOT 403
    expect(status).not.toBe(403);
  });
});

// =============================================================================
// TESTS: ADMIN — all endpoints pass (credential:* wildcard)
// =============================================================================

describe('tenant-models authz — ADMIN', () => {
  beforeAll(async () => {
    const app = createApp('tenant-A', 'admin-user', 'ADMIN');
    const router = (await import('../../routes/tenant-models.js')).default;
    app.use('/api/tenants/:tenantId/models', router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET / passes auth (credential:read satisfied by credential:*)', async () => {
    const { status } = await request('GET', MODELS_BASE);
    expect(status).not.toBe(403);
  });

  test('POST / passes auth (credential:write satisfied by credential:*)', async () => {
    const { status } = await request('POST', MODELS_BASE, { body: CREATE_MODEL_BODY });
    expect(status).not.toBe(403);
  });

  test('PATCH /:id passes auth (credential:write satisfied by credential:*)', async () => {
    const { status } = await request('PATCH', `${MODELS_BASE}/model-1`, {
      body: UPDATE_MODEL_BODY,
    });
    expect(status).not.toBe(403);
  });

  test('DELETE /:id passes auth (credential:delete satisfied by credential:*)', async () => {
    const { status } = await request('DELETE', `${MODELS_BASE}/model-1`);
    expect(status).not.toBe(403);
  });

  test('POST /:modelId/connections passes auth (credential:write satisfied by credential:*)', async () => {
    const { status } = await request('POST', `${MODELS_BASE}/model-1/connections`, {
      body: CREATE_CONNECTION_BODY,
    });
    expect(status).not.toBe(403);
  });
});

// =============================================================================
// TESTS: OPERATOR — reads pass (credential:read), writes/deletes 403
// =============================================================================

describe('tenant-models authz — OPERATOR', () => {
  beforeAll(async () => {
    const app = createApp('tenant-A', 'operator-user', 'OPERATOR');
    const router = (await import('../../routes/tenant-models.js')).default;
    app.use('/api/tenants/:tenantId/models', router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET / passes auth (OPERATOR has credential:read)', async () => {
    const { status } = await request('GET', MODELS_BASE);
    expect(status).not.toBe(403);
  });

  test('POST / returns 403 (OPERATOR lacks credential:write)', async () => {
    const { status, body } = await request('POST', MODELS_BASE, { body: CREATE_MODEL_BODY });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });

  test('PATCH /:id returns 403 (OPERATOR lacks credential:write)', async () => {
    const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1`, {
      body: UPDATE_MODEL_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });

  test('DELETE /:id returns 403 (OPERATOR lacks credential:delete)', async () => {
    const { status, body } = await request('DELETE', `${MODELS_BASE}/model-1`);
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:delete');
  });

  test('POST /:modelId/connections returns 403 (OPERATOR lacks credential:write)', async () => {
    const { status, body } = await request('POST', `${MODELS_BASE}/model-1/connections`, {
      body: CREATE_CONNECTION_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });
});

// =============================================================================
// TESTS: VIEWER — reads pass (credential:read), writes/deletes 403
// =============================================================================

describe('tenant-models authz — VIEWER', () => {
  beforeAll(async () => {
    const app = createApp('tenant-A', 'viewer-user', 'VIEWER');
    const router = (await import('../../routes/tenant-models.js')).default;
    app.use('/api/tenants/:tenantId/models', router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET / passes auth (VIEWER has credential:read)', async () => {
    const { status } = await request('GET', MODELS_BASE);
    expect(status).not.toBe(403);
  });

  test('POST / returns 403 (VIEWER lacks credential:write)', async () => {
    const { status, body } = await request('POST', MODELS_BASE, { body: CREATE_MODEL_BODY });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });

  test('PATCH /:id returns 403 (VIEWER lacks credential:write)', async () => {
    const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1`, {
      body: UPDATE_MODEL_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });

  test('DELETE /:id returns 403 (VIEWER lacks credential:delete)', async () => {
    const { status, body } = await request('DELETE', `${MODELS_BASE}/model-1`);
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:delete');
  });

  test('POST /:modelId/connections returns 403 (VIEWER lacks credential:write)', async () => {
    const { status, body } = await request('POST', `${MODELS_BASE}/model-1/connections`, {
      body: CREATE_CONNECTION_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });
});

// =============================================================================
// TESTS: Unauthenticated — all endpoints return 401
// =============================================================================

describe('tenant-models authz — Unauthenticated', () => {
  beforeAll(async () => {
    // No injectTenantContext middleware — simulates unauthenticated request
    const app = express();
    app.use(express.json());
    const router = (await import('../../routes/tenant-models.js')).default;
    app.use('/api/tenants/:tenantId/models', router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  test('GET / returns 401 when tenantContext is absent', async () => {
    const { status, body } = await request('GET', MODELS_BASE);
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('POST / returns 401 when tenantContext is absent', async () => {
    const { status, body } = await request('POST', MODELS_BASE, { body: CREATE_MODEL_BODY });
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('PATCH /:id returns 401 when tenantContext is absent', async () => {
    const { status, body } = await request('PATCH', `${MODELS_BASE}/model-1`, {
      body: UPDATE_MODEL_BODY,
    });
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('DELETE /:id returns 401 when tenantContext is absent', async () => {
    const { status, body } = await request('DELETE', `${MODELS_BASE}/model-1`);
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('POST /:modelId/connections returns 401 when tenantContext is absent', async () => {
    const { status, body } = await request('POST', `${MODELS_BASE}/model-1/connections`, {
      body: CREATE_CONNECTION_BODY,
    });
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });
});
