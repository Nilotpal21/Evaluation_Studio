/**
 * KMS Admin Route -- Authorization Enforcement Tests
 *
 * Verifies that `requirePermission('kms:admin')` correctly gates all
 * endpoints on the KMS admin router. The real RBAC logic
 * (`requirePermission` + `hasPermission`) executes -- only external deps
 * (auth middleware, rate-limiter, database, KMS provider) are mocked.
 *
 * Permission matrix under test:
 *   GET  /config         -- kms:admin
 *   PUT  /config         -- kms:admin
 *   GET  /health         -- kms:admin
 *
 * Roles tested:
 *   OWNER    -- *:* (superuser wildcard)  -> all pass
 *   ADMIN    -- kms:admin                 -> all pass
 *   OPERATOR -- no kms:admin              -> all 403
 *   VIEWER   -- no kms:admin              -> all 403
 *   Unauthenticated (no tenantContext)    -> all 401
 */

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS -- declared before any import that transitively pulls in the modules
// =============================================================================

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/feature-gate.js', () => ({
  requireFeature: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// DO NOT mock @agent-platform/shared -- use real requirePermission

vi.mock('@agent-platform/database/models', () => ({
  TenantKMSConfig: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    findOneAndUpdate: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  },
  DEKEntry: {
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    }),
    countDocuments: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: vi.fn(() => null),
  toClickHouseDateTime: (input: Date | string) => {
    const d = typeof input === 'string' ? new Date(input) : input;
    return d.toISOString().replace('T', ' ').replace('Z', '');
  },
  toClickHouseDateTimeSec: (input: Date | string) => {
    const d = typeof input === 'string' ? new Date(input) : input;
    return d
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
  },
}));

vi.mock('@agent-platform/database/kms', () => ({
  getPlatformKMSProvider: vi.fn(() => ({
    getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
  })),
  isPlatformKMSAvailable: vi.fn(() => true),
}));

vi.mock('@agent-platform/shared-encryption', () => ({
  getEncryptionFacade: vi.fn(() => null),
}));

vi.mock('../../services/redis/redis-client.js', () => ({
  isRedisAvailable: vi.fn(() => false),
  getRedisHandle: () => null,
}));

// =============================================================================
// IMPORTS -- after mocks
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const KMS_BASE = '/api/kms';

async function jsonFetch(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/**
 * Spin up a one-off Express server with the KMS admin router and a specific
 * tenant context injected into every request.
 */
async function createServerForRole(role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER') {
  const app = express();
  app.use(express.json());

  const ctx = makeTenantContext('tenant-kms-test', 'user-kms-test', role);
  app.use(injectTenantContext(ctx));

  const kmsRouter = (await import('../../routes/kms-admin.js')).default;
  app.use(KMS_BASE, kmsRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

/**
 * Spin up a server with NO tenant context injected (unauthenticated).
 */
async function createUnauthenticatedServer() {
  const app = express();
  app.use(express.json());
  // Deliberately do NOT inject tenantContext

  const kmsRouter = (await import('../../routes/kms-admin.js')).default;
  app.use(KMS_BASE, kmsRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('KMS Admin Route -- Authorization Enforcement', () => {
  // ---------------------------------------------------------------------------
  // OWNER -- *:* (superuser wildcard) -- all endpoints should pass auth
  // ---------------------------------------------------------------------------
  describe('OWNER role (*:* superuser)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForRole('OWNER'));
    });
    afterAll(() => server?.close());

    test('GET /config passes authorization (not 403)', async () => {
      const { status } = await jsonFetch(baseUrl, 'GET', `${KMS_BASE}/config`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT /config passes authorization (not 403)', async () => {
      const { status } = await jsonFetch(baseUrl, 'PUT', `${KMS_BASE}/config`, {
        defaultProvider: { providerType: 'local' },
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /health passes authorization (not 403)', async () => {
      const { status } = await jsonFetch(baseUrl, 'GET', `${KMS_BASE}/health`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // ADMIN -- has kms:admin -- all endpoints should pass auth
  // ---------------------------------------------------------------------------
  describe('ADMIN role (kms:admin)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForRole('ADMIN'));
    });
    afterAll(() => server?.close());

    test('GET /config passes authorization (not 403)', async () => {
      const { status } = await jsonFetch(baseUrl, 'GET', `${KMS_BASE}/config`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT /config passes authorization (not 403)', async () => {
      const { status } = await jsonFetch(baseUrl, 'PUT', `${KMS_BASE}/config`, {
        defaultProvider: { providerType: 'local' },
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /health passes authorization (not 403)', async () => {
      const { status } = await jsonFetch(baseUrl, 'GET', `${KMS_BASE}/health`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // OPERATOR -- no kms:admin -- all endpoints should be 403
  // ---------------------------------------------------------------------------
  describe('OPERATOR role (no kms:admin)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForRole('OPERATOR'));
    });
    afterAll(() => server?.close());

    test('GET /config returns 403', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'GET', `${KMS_BASE}/config`);
      expect(status).toBe(403);
      expect(json.error).toEqual({ code: 'PERMISSION_REQUIRED', message: 'Forbidden' });
      expect(json.required).toBe('kms:admin');
    });

    test('PUT /config returns 403', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'PUT', `${KMS_BASE}/config`, {
        defaultProvider: { providerType: 'local' },
      });
      expect(status).toBe(403);
      expect(json.error).toEqual({ code: 'PERMISSION_REQUIRED', message: 'Forbidden' });
      expect(json.required).toBe('kms:admin');
    });

    test('GET /health returns 403', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'GET', `${KMS_BASE}/health`);
      expect(status).toBe(403);
      expect(json.error).toEqual({ code: 'PERMISSION_REQUIRED', message: 'Forbidden' });
      expect(json.required).toBe('kms:admin');
    });
  });

  // ---------------------------------------------------------------------------
  // VIEWER -- no kms:admin -- all endpoints should be 403
  // ---------------------------------------------------------------------------
  describe('VIEWER role (no kms:admin)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForRole('VIEWER'));
    });
    afterAll(() => server?.close());

    test('GET /config returns 403', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'GET', `${KMS_BASE}/config`);
      expect(status).toBe(403);
      expect(json.error).toEqual({ code: 'PERMISSION_REQUIRED', message: 'Forbidden' });
      expect(json.required).toBe('kms:admin');
    });

    test('PUT /config returns 403', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'PUT', `${KMS_BASE}/config`, {
        defaultProvider: { providerType: 'local' },
      });
      expect(status).toBe(403);
      expect(json.error).toEqual({ code: 'PERMISSION_REQUIRED', message: 'Forbidden' });
      expect(json.required).toBe('kms:admin');
    });

    test('GET /health returns 403', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'GET', `${KMS_BASE}/health`);
      expect(status).toBe(403);
      expect(json.error).toEqual({ code: 'PERMISSION_REQUIRED', message: 'Forbidden' });
      expect(json.required).toBe('kms:admin');
    });
  });

  // ---------------------------------------------------------------------------
  // Unauthenticated -- no tenantContext at all -- all endpoints should be 401
  // ---------------------------------------------------------------------------
  describe('Unauthenticated requests (no tenantContext)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createUnauthenticatedServer());
    });
    afterAll(() => server?.close());

    test('GET /config returns 401', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'GET', `${KMS_BASE}/config`);
      expect(status).toBe(401);
      expect(json.error).toMatchObject({ message: 'Authentication required' });
    });

    test('PUT /config returns 401', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'PUT', `${KMS_BASE}/config`, {
        defaultProvider: { providerType: 'local' },
      });
      expect(status).toBe(401);
      expect(json.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /health returns 401', async () => {
      const { status, json } = await jsonFetch(baseUrl, 'GET', `${KMS_BASE}/health`);
      expect(status).toBe(401);
      expect(json.error).toMatchObject({ message: 'Authentication required' });
    });
  });
});
