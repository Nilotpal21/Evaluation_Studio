/**
 * Proxy Config Authorization Tests
 *
 * Tests RBAC enforcement on the proxy-config route.
 * Uses the REAL requirePermission middleware from @agent-platform/shared
 * to verify that permission checks on proxy:read, proxy:write,
 * and proxy:delete are properly enforced.
 *
 * Permission coverage:
 * - OWNER (*:*): all operations
 * - ADMIN (proxy:*): all operations
 * - OPERATOR (proxy:read): reads only, 403 on writes/deletes
 * - MEMBER (no proxy:*): all 403
 * - VIEWER (no proxy:*): all 403
 * - Unauthenticated: all 401
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

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/shared-kernel/security', () => ({
  assertUrlSafeForSSRF: vi.fn(),
  getDevSSRFOptions: vi.fn(() => ({})),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => ({
    encryptForTenant: vi.fn(() => 'encrypted'),
    decryptForTenant: vi.fn(() => 'decrypted'),
  })),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock('@agent-platform/shared/repos', () => ({
  createOrgProxyConfig: vi.fn().mockResolvedValue({
    id: 'proxy-1',
    tenantId: 'tenant-A',
    name: 'test-proxy',
    proxyUrl: 'https://proxy.example.com',
    proxyAuthType: 'none',
    urlPatterns: '*',
    bypassPatterns: null,
    environment: 'dev',
    priority: 0,
    enabled: true,
    encryptedCaCertificate: null,
    encryptedClientCert: null,
    createdBy: 'owner-user',
    createdAt: new Date().toISOString(),
  }),
  findOrgProxyConfigs: vi.fn().mockResolvedValue([]),
  countOrgProxyConfigs: vi.fn().mockResolvedValue(0),
  findOrgProxyConfigById: vi.fn().mockResolvedValue(null),
  updateOrgProxyConfig: vi.fn().mockResolvedValue(null),
  deleteOrgProxyConfig: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

let server: http.Server;
let baseUrl: string;

function createApp(tenantId: string, userId: string, role: string) {
  const app = express();
  app.use(express.json());
  app.use(injectTenantContext(makeTenantContext(tenantId, userId, role as any)));
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

// Valid POST body for creating a proxy config
const VALID_POST_BODY = {
  name: 'test-proxy',
  proxyUrl: 'https://proxy.example.com',
  proxyAuthType: 'none',
};

// Valid PUT body for updating a proxy config
const VALID_PUT_BODY = {
  name: 'updated-proxy',
};

// =============================================================================
// TESTS: OWNER — allowed on all endpoints (*:* matches everything)
// =============================================================================

describe('proxy-config authz — OWNER', () => {
  beforeAll(async () => {
    const app = createApp('tenant-A', 'owner-user', 'OWNER');
    const router = (await import('../../routes/proxy-config.js')).default;
    app.use('/api/proxy-configs', router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET / returns 200 (proxy:read satisfied by *:*)', async () => {
    const { status, body } = await request('GET', '/api/proxy-configs');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('POST / returns 201 (proxy:write satisfied by *:*)', async () => {
    const { status, body } = await request('POST', '/api/proxy-configs', {
      body: VALID_POST_BODY,
    });
    expect(status).toBe(201);
    expect(body.success).toBe(true);
  });

  test('PUT /:id returns 404 (permission passes, record not found)', async () => {
    const { status, body } = await request('PUT', '/api/proxy-configs/proxy-1', {
      body: VALID_PUT_BODY,
    });
    // findOrgProxyConfigById mock returns null → 404, but the permission check passed
    expect(status).toBe(404);
    expect(body.error).toBe('Proxy config not found');
  });

  test('DELETE /:id returns 404 (permission passes, record not found)', async () => {
    const { status, body } = await request('DELETE', '/api/proxy-configs/proxy-1');
    // findOrgProxyConfigById mock returns null → 404, but the permission check passed
    expect(status).toBe(404);
    expect(body.error).toBe('Proxy config not found');
  });
});

// =============================================================================
// TESTS: ADMIN — allowed on all endpoints (proxy:* matches all proxy perms)
// =============================================================================

describe('proxy-config authz — ADMIN', () => {
  beforeAll(async () => {
    const app = createApp('tenant-A', 'admin-user', 'ADMIN');
    const router = (await import('../../routes/proxy-config.js')).default;
    app.use('/api/proxy-configs', router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET / returns 200 (ADMIN has proxy:*)', async () => {
    const { status, body } = await request('GET', '/api/proxy-configs');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('POST / returns 201 (ADMIN has proxy:*)', async () => {
    const { status, body } = await request('POST', '/api/proxy-configs', {
      body: VALID_POST_BODY,
    });
    expect(status).toBe(201);
    expect(body.success).toBe(true);
  });

  test('PUT /:id returns 404 (permission passes, record not found)', async () => {
    const { status, body } = await request('PUT', '/api/proxy-configs/proxy-1', {
      body: VALID_PUT_BODY,
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Proxy config not found');
  });

  test('DELETE /:id returns 404 (permission passes, record not found)', async () => {
    const { status, body } = await request('DELETE', '/api/proxy-configs/proxy-1');
    expect(status).toBe(404);
    expect(body.error).toBe('Proxy config not found');
  });
});

// =============================================================================
// TESTS: OPERATOR — reads pass (proxy:read), writes/deletes denied
// =============================================================================

describe('proxy-config authz — OPERATOR', () => {
  beforeAll(async () => {
    const app = createApp('tenant-A', 'operator-user', 'OPERATOR');
    const router = (await import('../../routes/proxy-config.js')).default;
    app.use('/api/proxy-configs', router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET / returns 200 (OPERATOR has proxy:read)', async () => {
    const { status, body } = await request('GET', '/api/proxy-configs');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('POST / returns 403 (OPERATOR lacks proxy:write)', async () => {
    const { status, body } = await request('POST', '/api/proxy-configs', {
      body: VALID_POST_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('proxy:write');
  });

  test('PUT /:id returns 403 (OPERATOR lacks proxy:write)', async () => {
    const { status, body } = await request('PUT', '/api/proxy-configs/proxy-1', {
      body: VALID_PUT_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('proxy:write');
  });

  test('DELETE /:id returns 403 (OPERATOR lacks proxy:delete)', async () => {
    const { status, body } = await request('DELETE', '/api/proxy-configs/proxy-1');
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('proxy:delete');
  });
});

// =============================================================================
// TESTS: MEMBER — all 403 (no proxy permissions at all)
// =============================================================================

describe('proxy-config authz — MEMBER', () => {
  beforeAll(async () => {
    const app = createApp('tenant-A', 'member-user', 'MEMBER');
    const router = (await import('../../routes/proxy-config.js')).default;
    app.use('/api/proxy-configs', router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET / returns 403 (MEMBER lacks proxy:read)', async () => {
    const { status, body } = await request('GET', '/api/proxy-configs');
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('proxy:read');
  });

  test('POST / returns 403 (MEMBER lacks proxy:write)', async () => {
    const { status, body } = await request('POST', '/api/proxy-configs', {
      body: VALID_POST_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('proxy:write');
  });

  test('PUT /:id returns 403 (MEMBER lacks proxy:write)', async () => {
    const { status, body } = await request('PUT', '/api/proxy-configs/proxy-1', {
      body: VALID_PUT_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('proxy:write');
  });

  test('DELETE /:id returns 403 (MEMBER lacks proxy:delete)', async () => {
    const { status, body } = await request('DELETE', '/api/proxy-configs/proxy-1');
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('proxy:delete');
  });
});

// =============================================================================
// TESTS: VIEWER — all 403 (no proxy permissions at all)
// =============================================================================

describe('proxy-config authz — VIEWER', () => {
  beforeAll(async () => {
    const app = createApp('tenant-A', 'viewer-user', 'VIEWER');
    const router = (await import('../../routes/proxy-config.js')).default;
    app.use('/api/proxy-configs', router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET / returns 403 (VIEWER lacks proxy:read)', async () => {
    const { status, body } = await request('GET', '/api/proxy-configs');
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('proxy:read');
  });

  test('POST / returns 403 (VIEWER lacks proxy:write)', async () => {
    const { status, body } = await request('POST', '/api/proxy-configs', {
      body: VALID_POST_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('proxy:write');
  });

  test('PUT /:id returns 403 (VIEWER lacks proxy:write)', async () => {
    const { status, body } = await request('PUT', '/api/proxy-configs/proxy-1', {
      body: VALID_PUT_BODY,
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('proxy:write');
  });

  test('DELETE /:id returns 403 (VIEWER lacks proxy:delete)', async () => {
    const { status, body } = await request('DELETE', '/api/proxy-configs/proxy-1');
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ message: 'Forbidden' });
    expect(body.required).toBe('proxy:delete');
  });
});

// =============================================================================
// TESTS: No tenant context at all (middleware skipped) — all 401
// =============================================================================

describe('proxy-config authz — missing tenant context', () => {
  beforeAll(async () => {
    // No injectTenantContext middleware — simulates unauthenticated request
    const app = express();
    app.use(express.json());
    const router = (await import('../../routes/proxy-config.js')).default;
    app.use('/api/proxy-configs', router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  test('GET / returns 401 when tenantContext is absent', async () => {
    const { status, body } = await request('GET', '/api/proxy-configs');
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('POST / returns 401 when tenantContext is absent', async () => {
    const { status, body } = await request('POST', '/api/proxy-configs', {
      body: VALID_POST_BODY,
    });
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('PUT /:id returns 401 when tenantContext is absent', async () => {
    const { status, body } = await request('PUT', '/api/proxy-configs/proxy-1', {
      body: VALID_PUT_BODY,
    });
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });

  test('DELETE /:id returns 401 when tenantContext is absent', async () => {
    const { status, body } = await request('DELETE', '/api/proxy-configs/proxy-1');
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
  });
});
