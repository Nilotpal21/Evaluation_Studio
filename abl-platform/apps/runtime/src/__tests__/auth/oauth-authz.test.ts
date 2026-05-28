/**
 * OAuth Route Authorization Tests
 *
 * Verifies that `requirePermission` middleware enforces granular permissions
 * on every authenticated endpoint in the OAuth router. The real RBAC logic
 * (`requirePermission` + `hasPermission` from @agent-platform/shared) executes
 * -- only external deps (auth middleware, repos, services, DB) are mocked.
 *
 * Permission matrix under test:
 *   POST   /authorize/:provider  -- credential:write
 *   GET    /tokens               -- credential:read
 *   DELETE /tokens/:provider     -- credential:delete
 *   GET    /callback/:provider   -- unifiedAuth only, no permission (skipped)
 *
 * Roles tested:
 *   OWNER    -- *:*              -> all pass
 *   ADMIN    -- credential:*     -> all pass
 *   OPERATOR -- credential:read  -> GET tokens pass, POST authorize 403, DELETE 403
 *   MEMBER   -- credential:read  -> same as OPERATOR
 *   VIEWER   -- credential:read  -> same as OPERATOR
 *   Unauthenticated              -> all 401
 */

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS -- must be declared before any import that transitively pulls them in
// =============================================================================

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
  unifiedAuth: vi.fn((_req: any, _res: any, next: any) => next()),
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

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => ({
    encryptForTenant: vi.fn(() => 'encrypted'),
    decryptForTenant: vi.fn(() => 'decrypted'),
  })),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => false),
}));

vi.mock('../../repos/security-repo.js', () => ({
  findEndUserOAuthTokens: vi.fn().mockResolvedValue([]),
  countEndUserOAuthTokens: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    oauth: { providers: {} },
    server: { publicUrl: 'http://localhost:3112' },
    security: { oauthAllowedRedirectOrigins: ['http://localhost:3000'] },
  })),
}));

vi.mock('@agent-platform/config', () => ({
  DEFAULT_LOCAL_ORIGINS: ['http://localhost:3000'],
}));

// =============================================================================
// IMPORTS -- after mocks
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const OAUTH_BASE = '/api/v1/oauth';

async function request(baseUrl: string, method: string, path: string, opts?: { body?: any }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

/**
 * Creates a test Express app with the OAuth router mounted,
 * injecting the given role's tenant context into every request.
 */
async function createServerForRole(role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER') {
  const app = express();
  app.use(express.json());

  const ctx = makeTenantContext('tenant-1', 'user-1', role);
  app.use(injectTenantContext(ctx));

  const oauthRouter = (await import('../../routes/oauth.js')).default;
  app.use('/api/v1/oauth', oauthRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

/**
 * Creates a test Express app with the OAuth router mounted
 * but WITHOUT tenant context (unauthenticated).
 */
async function createServerUnauthenticated() {
  const app = express();
  app.use(express.json());
  // Deliberately do NOT inject tenantContext

  const oauthRouter = (await import('../../routes/oauth.js')).default;
  app.use('/api/v1/oauth', oauthRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

// Minimal valid body for POST /authorize/:provider
const authorizeBody = {
  redirectUri: 'http://localhost:3000/callback',
  scopes: ['read'],
};

// =============================================================================
// TESTS
// =============================================================================

describe('OAuth route authorization', () => {
  // ---------------------------------------------------------------------------
  // OWNER -- *:* (superuser wildcard) -> all endpoints pass auth
  // ---------------------------------------------------------------------------
  describe('OWNER role', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForRole('OWNER'));
    });

    afterAll(() => {
      server?.close();
    });

    test('POST /authorize/:provider -> passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'POST', `${OAUTH_BASE}/authorize/google`, {
        body: authorizeBody,
      });
      // May fail on service not configured (503), but must NOT be 403
      expect(status).not.toBe(403);
    });

    test('GET /tokens -> passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'GET', `${OAUTH_BASE}/tokens`);
      // May return 503 (DB unavailable), but must NOT be 403
      expect(status).not.toBe(403);
    });

    test('DELETE /tokens/:provider -> passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${OAUTH_BASE}/tokens/google`);
      // May fail on service not configured (503), but must NOT be 403
      expect(status).not.toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // ADMIN -- credential:* -> all endpoints pass auth
  // ---------------------------------------------------------------------------
  describe('ADMIN role', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForRole('ADMIN'));
    });

    afterAll(() => {
      server?.close();
    });

    test('POST /authorize/:provider -> passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'POST', `${OAUTH_BASE}/authorize/google`, {
        body: authorizeBody,
      });
      expect(status).not.toBe(403);
    });

    test('GET /tokens -> passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'GET', `${OAUTH_BASE}/tokens`);
      expect(status).not.toBe(403);
    });

    test('DELETE /tokens/:provider -> passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${OAUTH_BASE}/tokens/google`);
      expect(status).not.toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // OPERATOR -- credential:read only -> GET tokens pass, POST/DELETE 403
  // ---------------------------------------------------------------------------
  describe('OPERATOR role', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForRole('OPERATOR'));
    });

    afterAll(() => {
      server?.close();
    });

    test('POST /authorize/:provider -> 403 (no credential:write)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${OAUTH_BASE}/authorize/google`, {
        body: authorizeBody,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.required).toBe('credential:write');
    });

    test('GET /tokens -> passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'GET', `${OAUTH_BASE}/tokens`);
      expect(status).not.toBe(403);
    });

    test('DELETE /tokens/:provider -> 403 (no credential:delete)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${OAUTH_BASE}/tokens/google`);
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.required).toBe('credential:delete');
    });
  });

  // ---------------------------------------------------------------------------
  // MEMBER -- credential:read only -> GET tokens pass, POST/DELETE 403
  // ---------------------------------------------------------------------------
  describe('MEMBER role', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForRole('MEMBER'));
    });

    afterAll(() => {
      server?.close();
    });

    test('POST /authorize/:provider -> 403 (no credential:write)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${OAUTH_BASE}/authorize/google`, {
        body: authorizeBody,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.required).toBe('credential:write');
    });

    test('GET /tokens -> passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'GET', `${OAUTH_BASE}/tokens`);
      expect(status).not.toBe(403);
    });

    test('DELETE /tokens/:provider -> 403 (no credential:delete)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${OAUTH_BASE}/tokens/google`);
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.required).toBe('credential:delete');
    });
  });

  // ---------------------------------------------------------------------------
  // VIEWER -- credential:read only -> GET tokens pass, POST/DELETE 403
  // ---------------------------------------------------------------------------
  describe('VIEWER role', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForRole('VIEWER'));
    });

    afterAll(() => {
      server?.close();
    });

    test('POST /authorize/:provider -> 403 (no credential:write)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${OAUTH_BASE}/authorize/google`, {
        body: authorizeBody,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.required).toBe('credential:write');
    });

    test('GET /tokens -> passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'GET', `${OAUTH_BASE}/tokens`);
      expect(status).not.toBe(403);
    });

    test('DELETE /tokens/:provider -> 403 (no credential:delete)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${OAUTH_BASE}/tokens/google`);
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.required).toBe('credential:delete');
    });
  });

  // ---------------------------------------------------------------------------
  // Unauthenticated -- no tenant context -> all 401
  // ---------------------------------------------------------------------------
  describe('Unauthenticated requests', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerUnauthenticated());
    });

    afterAll(() => {
      server?.close();
    });

    test('POST /authorize/:provider -> 401 without tenantContext', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${OAUTH_BASE}/authorize/google`, {
        body: authorizeBody,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /tokens -> 401 without tenantContext', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${OAUTH_BASE}/tokens`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('DELETE /tokens/:provider -> 401 without tenantContext', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${OAUTH_BASE}/tokens/google`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });
  });
});
