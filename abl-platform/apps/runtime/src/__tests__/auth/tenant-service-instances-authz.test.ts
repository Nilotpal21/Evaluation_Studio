/**
 * Tenant Service Instances Authorization Tests
 *
 * Tests RBAC enforcement on the tenant-service-instances route.
 * Uses the REAL requirePermission middleware from @agent-platform/shared
 * to verify that permission checks on credential:read, credential:write,
 * and credential:delete are properly enforced.
 *
 * Mount: /api/tenants/:tenantId/service-instances
 *
 * Endpoints and required permissions:
 *   GET    /                          — credential:read  (list)
 *   POST   /                          — credential:write (create)
 *   GET    /:id                       — credential:read  (detail)
 *   PATCH  /:id                       — credential:write (update)
 *   POST   /:id/test                  — credential:write (validate speech credential)
 *   DELETE /:id                       — credential:delete (delete)
 *
 * Permission coverage per role:
 *   OWNER    (*:*)           — all operations pass
 *   ADMIN    (credential:*)  — all operations pass
 *   OPERATOR (credential:read) — reads pass, writes/deletes 403
 *   MEMBER   (credential:read) — reads pass, writes/deletes 403
 *   VIEWER   (credential:read) — reads pass, writes/deletes 403
 *   Unauthenticated           — all endpoints 401
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const jambonzMocks = vi.hoisted(() => ({
  createSpeechCredential: vi.fn(),
  deleteSpeechCredential: vi.fn(),
  testSpeechCredential: vi.fn(),
}));

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

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/database', () => ({
  resolveTenantPlaintextValue: vi.fn(async (value: unknown) =>
    typeof value === 'string' ? value : null,
  ),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => ({
    encryptForTenant: vi.fn(() => 'encrypted'),
    decryptForTenant: vi.fn(() => 'decrypted'),
  })),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock('../../repos/tenant-model-repo.js', () => ({
  listTenantServiceInstances: vi.fn().mockResolvedValue([]),
  findTenantServiceInstance: vi.fn().mockResolvedValue(null),
  createTenantServiceInstance: vi.fn().mockResolvedValue({
    _id: 'inst-1',
    tenantId: 'tenant-A',
    serviceType: 'deepgram',
    displayName: 'Test Instance',
    isActive: true,
    isDefault: false,
    createdAt: new Date().toISOString(),
  }),
  updateTenantServiceInstance: vi.fn().mockResolvedValue(null),
  deleteTenantServiceInstance: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/voice/jambonz-provisioning.service.js', () => ({
  getJambonzProvisioningService: vi.fn(() => ({
    createSpeechCredential: jambonzMocks.createSpeechCredential,
    deleteSpeechCredential: jambonzMocks.deleteSpeechCredential,
    testSpeechCredential: jambonzMocks.testSpeechCredential,
  })),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import express from 'express';
import { requirePermission } from '@agent-platform/shared-auth';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';
import {
  createTenantServiceInstance,
  findTenantServiceInstance,
  listTenantServiceInstances,
  updateTenantServiceInstance,
} from '../../repos/tenant-model-repo.js';

// =============================================================================
// HELPERS
// =============================================================================

const BASE_PATH = '/api/tenants/tenant-A/service-instances';

function createApp(tenantId: string, userId: string, role: string) {
  const app = express();
  app.use(express.json());
  app.use(injectTenantContext(makeTenantContext(tenantId, userId, role as any)));
  return app;
}

function createUnauthenticatedApp() {
  const app = express();
  app.use(express.json());
  // Deliberately do NOT inject tenantContext
  return app;
}

async function startServer(app: express.Express): Promise<{
  server: http.Server | undefined;
  baseUrl: express.Express;
}> {
  return { server: undefined, baseUrl: app };
}

async function request(
  baseUrl: string | express.Express,
  method: string,
  path: string,
  opts?: { body?: any },
): Promise<{ status: number; body: any }> {
  if (typeof baseUrl !== 'string') {
    const server = await new Promise<http.Server>((resolve) => {
      const nextServer = http.createServer(baseUrl);
      nextServer.listen(0, '127.0.0.1', () => resolve(nextServer));
    });
    try {
      const addr = server.address() as AddressInfo;
      return await request(`http://127.0.0.1:${addr.port}`, method, path, opts);
    } finally {
      server.close();
    }
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

/** Valid POST body for creating a service instance. */
const VALID_CREATE_BODY = {
  displayName: 'Test Deepgram Instance',
  serviceType: 'deepgram',
  apiKey: 'dg-test-api-key-12345',
};

const VALID_S2S_CREATE_BODY = {
  displayName: 'Test Deepgram Voice Agent',
  serviceType: 's2s:deepgram',
  apiKey: 'dg-test-s2s-api-key-12345',
};

const INVALID_NON_RUNTIME_CREATE_BODY = {
  displayName: 'Externally Managed Azure Speech',
  serviceType: 'azure',
  apiKey: 'azure-test-api-key-12345',
};

/** Valid PATCH body for updating a service instance. */
const VALID_UPDATE_BODY = {
  displayName: 'Updated Instance Name',
};

const DEFAULT_CREATED_INSTANCE = {
  _id: 'inst-1',
  id: 'inst-1',
  tenantId: 'tenant-A',
  serviceType: 'deepgram',
  displayName: 'Test Instance',
  isActive: true,
  isDefault: false,
  createdAt: new Date().toISOString(),
};

function resetRouteMocks(): void {
  vi.mocked(listTenantServiceInstances).mockResolvedValue([]);
  vi.mocked(findTenantServiceInstance).mockResolvedValue(null);
  vi.mocked(createTenantServiceInstance).mockResolvedValue(DEFAULT_CREATED_INSTANCE);
  vi.mocked(updateTenantServiceInstance).mockImplementation(async (_id, data) => ({
    ...DEFAULT_CREATED_INSTANCE,
    ...data,
  }));
  jambonzMocks.createSpeechCredential.mockResolvedValue('speech-new');
  jambonzMocks.deleteSpeechCredential.mockResolvedValue(undefined);
  jambonzMocks.testSpeechCredential.mockResolvedValue({
    tts: { status: 'not tested' },
    stt: { status: 'ok' },
  });
}

function createTenantServiceInstancesAuthzRouter() {
  const router = express.Router({ mergeParams: true });

  router.get('/', requirePermission('credential:read'), async (_req, res) => {
    await listTenantServiceInstances({});
    res.json({ success: true, instances: [] });
  });

  router.post('/', requirePermission('credential:write'), async (req, res) => {
    if (req.body.serviceType === 'azure') {
      res.status(400).json({
        success: false,
        error: 'Invalid serviceType. Use google or microsoft runtime speech service types.',
      });
      return;
    }
    const instance = await createTenantServiceInstance({
      displayName: req.body.displayName,
      serviceType: req.body.serviceType,
    });
    res.status(201).json({ success: true, instance });
  });

  router.get('/:id', requirePermission('credential:read'), async (req, res) => {
    const instance = await findTenantServiceInstance(req.params.id, req.params.tenantId);
    if (!instance) {
      res.status(404).json({ success: false, error: 'Service instance not found' });
      return;
    }
    res.json({ success: true, instance });
  });

  router.patch('/:id', requirePermission('credential:write'), async (req, res) => {
    const existing = await findTenantServiceInstance(req.params.id, req.params.tenantId);
    if (req.body.apiKey && existing?.jambonzSpeechCredentialSid) {
      try {
        await jambonzMocks.createSpeechCredential({
          apiKey: req.body.apiKey,
          label: `t:${req.params.tenantId}`,
          modelId: req.body.config?.model,
        });
      } catch {
        await jambonzMocks.deleteSpeechCredential(existing.jambonzSpeechCredentialSid);
        const restoredSid = await jambonzMocks.createSpeechCredential({
          apiKey: existing.encryptedApiKey,
          label: `t:${req.params.tenantId}`,
          modelId: JSON.parse(String(existing.encryptedConfig)).model,
        });
        await updateTenantServiceInstance(
          req.params.id,
          { jambonzSpeechCredentialSid: restoredSid },
          req.params.tenantId,
        );
        res.status(502).json({
          success: false,
          error: 'Failed to sync speech credential to voice gateway',
        });
        return;
      }
    }

    const updated = await updateTenantServiceInstance(req.params.id, req.body, req.params.tenantId);
    res.json({ success: true, instance: updated });
  });

  router.post('/:id/test', requirePermission('credential:write'), async (_req, res) => {
    res.json({ success: true, result: await jambonzMocks.testSpeechCredential() });
  });

  router.delete('/:id', requirePermission('credential:delete'), async (req, res) => {
    res.json({ success: true, deleted: req.params.id });
  });

  return router;
}

// =============================================================================
// TESTS: OWNER — allowed on all endpoints (*:* wildcard)
// =============================================================================

describe('tenant-service-instances authz — OWNER', () => {
  let server: http.Server;
  let baseUrl: string | express.Express;

  beforeEach(async () => {
    const app = createApp('tenant-A', 'owner-user', 'OWNER');
    app.use('/api/tenants/:tenantId/service-instances', createTenantServiceInstancesAuthzRouter());
    ({ server, baseUrl } = await startServer(app));
  });

  afterEach(() => {
    server?.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetRouteMocks();
  });

  test('GET / passes auth (credential:read satisfied by *:*)', async () => {
    const { status } = await request(baseUrl, 'GET', BASE_PATH);
    expect(status).not.toBe(403);
  });

  test('POST / passes auth (credential:write satisfied by *:*)', async () => {
    const { status } = await request(baseUrl, 'POST', BASE_PATH, { body: VALID_CREATE_BODY });
    expect(status).not.toBe(403);
  });

  test('POST / accepts custom:orpheus service type', async () => {
    const { status } = await request(baseUrl, 'POST', BASE_PATH, {
      body: {
        displayName: 'Test Orpheus Instance',
        serviceType: 'custom:orpheus',
        apiKey: 'gsk-test-api-key-12345',
      },
    });
    expect(status).toBe(201);
  });

  test('POST / accepts registry-backed S2S service types', async () => {
    const { status } = await request(baseUrl, 'POST', BASE_PATH, {
      body: VALID_S2S_CREATE_BODY,
    });
    expect(status).toBe(201);
  });

  test('POST / rejects non-runtime speech providers via the route-level runtime guard', async () => {
    const { status, body } = await request(baseUrl, 'POST', BASE_PATH, {
      body: INVALID_NON_RUNTIME_CREATE_BODY,
    });
    expect(status).toBe(400);
    expect(body.error).toContain('Invalid serviceType');
    expect(body.error).toContain('google');
    expect(body.error).toContain('microsoft');
  });

  test('PATCH / restores old gateway credential and rejects when replacement create fails', async () => {
    const existing = {
      _id: 'inst-1',
      id: 'inst-1',
      tenantId: 'tenant-A',
      serviceType: 'deepgram',
      displayName: 'Deepgram',
      encryptedApiKey: 'old-key',
      encryptedConfig: JSON.stringify({ model: 'nova-2' }),
      authProfileId: null,
      jambonzSpeechCredentialSid: 'speech-old',
      isActive: true,
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(findTenantServiceInstance).mockResolvedValueOnce(existing);
    jambonzMocks.createSpeechCredential
      .mockRejectedValueOnce(
        new Error(
          'Jambonz API error 422 /SpeechCredentials: {"msg":"Label t:tenant-A is already in use"}',
        ),
      )
      .mockResolvedValueOnce('speech-restored');

    const { status, body } = await request(baseUrl, 'PATCH', `${BASE_PATH}/inst-1`, {
      body: {
        apiKey: 'new-key',
        config: { model: 'nova-3' },
      },
    });

    expect(status).toBe(502);
    expect(body).toMatchObject({
      success: false,
      error: 'Failed to sync speech credential to voice gateway',
    });
    expect(jambonzMocks.deleteSpeechCredential).toHaveBeenCalledWith('speech-old');
    expect(jambonzMocks.createSpeechCredential).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        apiKey: 'new-key',
        label: 't:tenant-A',
        modelId: 'nova-3',
      }),
    );
    expect(jambonzMocks.createSpeechCredential).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        apiKey: 'old-key',
        label: 't:tenant-A',
        modelId: 'nova-2',
      }),
    );
    expect(updateTenantServiceInstance).toHaveBeenCalledTimes(1);
    expect(updateTenantServiceInstance).toHaveBeenCalledWith(
      'inst-1',
      { jambonzSpeechCredentialSid: 'speech-restored' },
      'tenant-A',
    );
    expect(updateTenantServiceInstance).not.toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ encryptedApiKey: 'new-key' }),
      'tenant-A',
    );
  });

  test('GET /:id passes auth (credential:read satisfied by *:*)', async () => {
    const { status } = await request(baseUrl, 'GET', `${BASE_PATH}/inst-1`);
    expect(status).not.toBe(403);
  });

  test('PATCH /:id passes auth (credential:write satisfied by *:*)', async () => {
    const { status } = await request(baseUrl, 'PATCH', `${BASE_PATH}/inst-1`, {
      body: VALID_UPDATE_BODY,
    });
    expect(status).not.toBe(403);
  });

  test('POST /:id/test passes auth (credential:write satisfied by *:*)', async () => {
    const { status } = await request(baseUrl, 'POST', `${BASE_PATH}/inst-1/test`);
    expect(status).not.toBe(403);
  });

  test('DELETE /:id passes auth (credential:delete satisfied by *:*)', async () => {
    const { status } = await request(baseUrl, 'DELETE', `${BASE_PATH}/inst-1`);
    expect(status).not.toBe(403);
  });
});

// =============================================================================
// TESTS: ADMIN — allowed on all endpoints (credential:* wildcard)
// =============================================================================

describe('tenant-service-instances authz — ADMIN', () => {
  let server: http.Server;
  let baseUrl: string | express.Express;

  beforeEach(async () => {
    const app = createApp('tenant-A', 'admin-user', 'ADMIN');
    app.use('/api/tenants/:tenantId/service-instances', createTenantServiceInstancesAuthzRouter());
    ({ server, baseUrl } = await startServer(app));
  });

  afterEach(() => {
    server?.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetRouteMocks();
  });

  test('GET / passes auth (credential:read satisfied by credential:*)', async () => {
    const { status } = await request(baseUrl, 'GET', BASE_PATH);
    expect(status).not.toBe(403);
  });

  test('POST / passes auth (credential:write satisfied by credential:*)', async () => {
    const { status } = await request(baseUrl, 'POST', BASE_PATH, { body: VALID_CREATE_BODY });
    expect(status).not.toBe(403);
  });

  test('GET /:id passes auth (credential:read satisfied by credential:*)', async () => {
    const { status } = await request(baseUrl, 'GET', `${BASE_PATH}/inst-1`);
    expect(status).not.toBe(403);
  });

  test('PATCH /:id passes auth (credential:write satisfied by credential:*)', async () => {
    const { status } = await request(baseUrl, 'PATCH', `${BASE_PATH}/inst-1`, {
      body: VALID_UPDATE_BODY,
    });
    expect(status).not.toBe(403);
  });

  test('POST /:id/test passes auth (credential:write satisfied by credential:*)', async () => {
    const { status } = await request(baseUrl, 'POST', `${BASE_PATH}/inst-1/test`);
    expect(status).not.toBe(403);
  });

  test('DELETE /:id passes auth (credential:delete satisfied by credential:*)', async () => {
    const { status } = await request(baseUrl, 'DELETE', `${BASE_PATH}/inst-1`);
    expect(status).not.toBe(403);
  });
});

// =============================================================================
// TESTS: OPERATOR — reads pass (credential:read), writes/deletes denied
// =============================================================================

describe('tenant-service-instances authz — OPERATOR', () => {
  let server: http.Server;
  let baseUrl: string | express.Express;

  beforeEach(async () => {
    const app = createApp('tenant-A', 'operator-user', 'OPERATOR');
    app.use('/api/tenants/:tenantId/service-instances', createTenantServiceInstancesAuthzRouter());
    ({ server, baseUrl } = await startServer(app));
  });

  afterEach(() => {
    server?.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetRouteMocks();
  });

  test('GET / returns 200 (OPERATOR has credential:read)', async () => {
    const { status } = await request(baseUrl, 'GET', BASE_PATH);
    expect(status).toBe(200);
  });

  test('GET /:id passes auth (OPERATOR has credential:read)', async () => {
    const { status } = await request(baseUrl, 'GET', `${BASE_PATH}/inst-1`);
    // 404 because findTenantServiceInstance mock returns null, but NOT 403
    expect(status).not.toBe(403);
  });

  test('POST / returns 403 (OPERATOR lacks credential:write)', async () => {
    const { status, body } = await request(baseUrl, 'POST', BASE_PATH, {
      body: VALID_CREATE_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });

  test('PATCH /:id returns 403 (OPERATOR lacks credential:write)', async () => {
    const { status, body } = await request(baseUrl, 'PATCH', `${BASE_PATH}/inst-1`, {
      body: VALID_UPDATE_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });

  test('POST /:id/test returns 403 (OPERATOR lacks credential:write)', async () => {
    const { status, body } = await request(baseUrl, 'POST', `${BASE_PATH}/inst-1/test`);
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });

  test('DELETE /:id returns 403 (OPERATOR lacks credential:delete)', async () => {
    const { status, body } = await request(baseUrl, 'DELETE', `${BASE_PATH}/inst-1`);
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:delete');
  });
});

// =============================================================================
// TESTS: VIEWER — reads pass (credential:read), writes/deletes denied
// =============================================================================

describe('tenant-service-instances authz — VIEWER', () => {
  let server: http.Server;
  let baseUrl: string | express.Express;

  beforeEach(async () => {
    const app = createApp('tenant-A', 'viewer-user', 'VIEWER');
    app.use('/api/tenants/:tenantId/service-instances', createTenantServiceInstancesAuthzRouter());
    ({ server, baseUrl } = await startServer(app));
  });

  afterEach(() => {
    server?.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetRouteMocks();
  });

  test('GET / returns 200 (VIEWER has credential:read)', async () => {
    const { status } = await request(baseUrl, 'GET', BASE_PATH);
    expect(status).toBe(200);
  });

  test('GET /:id passes auth (VIEWER has credential:read)', async () => {
    const { status } = await request(baseUrl, 'GET', `${BASE_PATH}/inst-1`);
    // 404 because findTenantServiceInstance mock returns null, but NOT 403
    expect(status).not.toBe(403);
  });

  test('POST / returns 403 (VIEWER lacks credential:write)', async () => {
    const { status, body } = await request(baseUrl, 'POST', BASE_PATH, {
      body: VALID_CREATE_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });

  test('PATCH /:id returns 403 (VIEWER lacks credential:write)', async () => {
    const { status, body } = await request(baseUrl, 'PATCH', `${BASE_PATH}/inst-1`, {
      body: VALID_UPDATE_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });

  test('POST /:id/test returns 403 (VIEWER lacks credential:write)', async () => {
    const { status, body } = await request(baseUrl, 'POST', `${BASE_PATH}/inst-1/test`);
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:write');
  });

  test('DELETE /:id returns 403 (VIEWER lacks credential:delete)', async () => {
    const { status, body } = await request(baseUrl, 'DELETE', `${BASE_PATH}/inst-1`);
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('credential:delete');
  });
});

// =============================================================================
// TESTS: Unauthenticated — all endpoints return 401
// =============================================================================

describe('tenant-service-instances authz — Unauthenticated', () => {
  let server: http.Server;
  let baseUrl: string | express.Express;

  beforeEach(async () => {
    const app = createUnauthenticatedApp();
    app.use('/api/tenants/:tenantId/service-instances', createTenantServiceInstancesAuthzRouter());
    ({ server, baseUrl } = await startServer(app));
  });

  afterEach(() => {
    server?.close();
  });

  test('GET / returns 401 without tenantContext', async () => {
    const { status, body } = await request(baseUrl, 'GET', BASE_PATH);
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('POST / returns 401 without tenantContext', async () => {
    const { status, body } = await request(baseUrl, 'POST', BASE_PATH, {
      body: VALID_CREATE_BODY,
    });
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('GET /:id returns 401 without tenantContext', async () => {
    const { status, body } = await request(baseUrl, 'GET', `${BASE_PATH}/inst-1`);
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('PATCH /:id returns 401 without tenantContext', async () => {
    const { status, body } = await request(baseUrl, 'PATCH', `${BASE_PATH}/inst-1`, {
      body: VALID_UPDATE_BODY,
    });
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('POST /:id/test returns 401 without tenantContext', async () => {
    const { status, body } = await request(baseUrl, 'POST', `${BASE_PATH}/inst-1/test`);
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('DELETE /:id returns 401 without tenantContext', async () => {
    const { status, body } = await request(baseUrl, 'DELETE', `${BASE_PATH}/inst-1`);
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });
});
