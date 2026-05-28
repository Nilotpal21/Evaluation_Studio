/**
 * Contacts Route — Authorization Enforcement Tests
 *
 * Verifies that `requirePermissionInline` enforces the `agent:execute`
 * permission on every write endpoint in the contacts router, and that
 * read endpoints (which have no RBAC gate) are accessible to all
 * authenticated roles.
 *
 * The real `requirePermissionInline` + `hasPermission` execute; everything
 * else (auth middleware, rate limiter, stores, repos) is mocked to isolate
 * the permission check.
 *
 * Write endpoints under test (all require `agent:execute`):
 *   POST   /                     — create contact
 *   PUT    /:id                  — update contact
 *   DELETE /:id                  — soft delete contact
 *   POST   /:id/link-session     — link contact to session
 *
 * Read endpoints (no RBAC — only require tenantContext):
 *   GET    /                     — query contacts
 *
 * Roles tested:
 *   OWNER    — *:*              → all pass
 *   ADMIN    — agent:*          → all pass
 *   OPERATOR — agent:execute    → all pass
 *   MEMBER   — agent:execute    → all pass
 *   VIEWER   — no agent:execute → GETs pass, writes 403
 *   Unauthenticated             → all 401
 */

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'http';

// =============================================================================
// MOCKS — declared before any import that transitively pulls in the modules
// =============================================================================

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  };
});

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

vi.mock('@abl/compiler/platform/core/types', () => ({
  IdentityType: {
    ANONYMOUS: 'anonymous',
    AUTHENTICATED: 'authenticated',
    IDENTIFIED: 'identified',
  },
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    contact: {
      create: vi.fn().mockResolvedValue({ id: 'contact-1', tenantId: 'tenant-A' }),
      getById: vi.fn().mockResolvedValue(null),
      findByIdentity: vi.fn().mockResolvedValue(null),
      query: vi.fn().mockResolvedValue({ contacts: [], total: 0 }),
      update: vi.fn().mockResolvedValue(null),
      softDelete: vi.fn().mockResolvedValue(null),
      touchLastSeen: vi.fn().mockResolvedValue(null),
    },
    conversation: {
      findById: vi.fn().mockResolvedValue(null),
      linkContact: vi.fn().mockResolvedValue(null),
    },
  })),
}));

vi.mock('../../repos/session-repo.js', () => ({
  unlinkContactFromSessions: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../validation/contact-validation.js', () => ({
  validateCreateContact: vi.fn(() => []),
  validateUpdateContact: vi.fn(() => []),
}));

vi.mock('../../services/audit-helpers.js', () => ({
  auditContactCreated: vi.fn().mockResolvedValue(undefined),
  auditContactUpdated: vi.fn().mockResolvedValue(undefined),
  auditContactDeleted: vi.fn().mockResolvedValue(undefined),
  auditContactLinked: vi.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const CONTACTS_BASE = '/api/contacts';
const { default: contactsRouter } = await import('../../routes/contacts.js');

async function sendRequest(
  server: http.Server,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts?: { body?: any },
) {
  let req = request(server)
    [method.toLowerCase() as 'get' | 'post' | 'put' | 'delete'](path)
    .set('Content-Type', 'application/json');

  if (opts?.body !== undefined) {
    req = req.send(opts.body);
  }

  const res = await req;
  return { status: res.status, body: res.body };
}

/**
 * Creates a test Express app with the contacts router mounted,
 * injecting the given role's tenant context into every request.
 */
async function createServerForRole(role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER') {
  const app = express();
  app.use(express.json());

  const ctx = makeTenantContext('tenant-A', 'user-1', role);
  app.use(injectTenantContext(ctx));

  app.use('/api/contacts', contactsRouter);

  return new Promise<{ server: http.Server }>((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({ server });
    });
  });
}

/**
 * Creates a test Express app with NO tenant context (unauthenticated).
 */
async function createUnauthenticatedServer() {
  const app = express();
  app.use(express.json());
  // Deliberately do NOT inject tenantContext

  app.use('/api/contacts', contactsRouter);

  return new Promise<{ server: http.Server }>((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({ server });
    });
  });
}

async function closeServer(server: http.Server | undefined) {
  if (!server) {
    return;
  }

  server.closeIdleConnections?.();
  server.closeAllConnections?.();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

// Minimal valid body for POST / (create contact)
const createBody = { type: 'customer', identity: 'test@example.com', identityType: 'email' };

// Minimal valid body for PUT /:id (update contact)
const updateBody = { displayName: 'Updated Name' };

// Minimal valid body for POST /:id/link-session
const linkSessionBody = { sessionId: 'session-1' };

// =============================================================================
// TESTS
// =============================================================================

describe('Contacts Route — Authorization Enforcement', () => {
  // ---------------------------------------------------------------------------
  // OWNER — *:* (superuser) → all endpoints pass
  // ---------------------------------------------------------------------------
  describe('OWNER role (*:* superuser)', () => {
    let server: http.Server;

    beforeAll(async () => {
      ({ server } = await createServerForRole('OWNER'));
    });
    afterAll(async () => closeServer(server));

    test('POST / (create) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'POST', CONTACTS_BASE, { body: createBody });
      expect(status).not.toBe(403);
    });

    test('GET / (query) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'GET', CONTACTS_BASE);
      expect(status).not.toBe(403);
    });

    test('PUT /:id (update) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'PUT', `${CONTACTS_BASE}/contact-1`, {
        body: updateBody,
      });
      expect(status).not.toBe(403);
    });

    test('DELETE /:id (soft delete) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'DELETE', `${CONTACTS_BASE}/contact-1`);
      expect(status).not.toBe(403);
    });

    test('POST /:id/link-session passes auth (not 403)', async () => {
      const { status } = await sendRequest(
        server,
        'POST',
        `${CONTACTS_BASE}/contact-1/link-session`,
        {
          body: linkSessionBody,
        },
      );
      expect(status).not.toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // ADMIN — agent:* wildcard → all endpoints pass
  // ---------------------------------------------------------------------------
  describe('ADMIN role (agent:* wildcard)', () => {
    let server: http.Server;

    beforeAll(async () => {
      ({ server } = await createServerForRole('ADMIN'));
    });
    afterAll(async () => closeServer(server));

    test('POST / (create) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'POST', CONTACTS_BASE, { body: createBody });
      expect(status).not.toBe(403);
    });

    test('GET / (query) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'GET', CONTACTS_BASE);
      expect(status).not.toBe(403);
    });

    test('PUT /:id (update) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'PUT', `${CONTACTS_BASE}/contact-1`, {
        body: updateBody,
      });
      expect(status).not.toBe(403);
    });

    test('DELETE /:id (soft delete) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'DELETE', `${CONTACTS_BASE}/contact-1`);
      expect(status).not.toBe(403);
    });

    test('POST /:id/link-session passes auth (not 403)', async () => {
      const { status } = await sendRequest(
        server,
        'POST',
        `${CONTACTS_BASE}/contact-1/link-session`,
        {
          body: linkSessionBody,
        },
      );
      expect(status).not.toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // OPERATOR — agent:execute → all endpoints pass
  // ---------------------------------------------------------------------------
  describe('OPERATOR role (agent:execute)', () => {
    let server: http.Server;

    beforeAll(async () => {
      ({ server } = await createServerForRole('OPERATOR'));
    });
    afterAll(async () => closeServer(server));

    test('POST / (create) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'POST', CONTACTS_BASE, { body: createBody });
      expect(status).not.toBe(403);
    });

    test('GET / (query) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'GET', CONTACTS_BASE);
      expect(status).not.toBe(403);
    });

    test('PUT /:id (update) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'PUT', `${CONTACTS_BASE}/contact-1`, {
        body: updateBody,
      });
      expect(status).not.toBe(403);
    });

    test('DELETE /:id (soft delete) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'DELETE', `${CONTACTS_BASE}/contact-1`);
      expect(status).not.toBe(403);
    });

    test('POST /:id/link-session passes auth (not 403)', async () => {
      const { status } = await sendRequest(
        server,
        'POST',
        `${CONTACTS_BASE}/contact-1/link-session`,
        {
          body: linkSessionBody,
        },
      );
      expect(status).not.toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // MEMBER — agent:execute → all endpoints pass
  // ---------------------------------------------------------------------------
  describe('MEMBER role (agent:execute)', () => {
    let server: http.Server;

    beforeAll(async () => {
      ({ server } = await createServerForRole('MEMBER'));
    });
    afterAll(async () => closeServer(server));

    test('POST / (create) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'POST', CONTACTS_BASE, { body: createBody });
      expect(status).not.toBe(403);
    });

    test('GET / (query) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'GET', CONTACTS_BASE);
      expect(status).not.toBe(403);
    });

    test('PUT /:id (update) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'PUT', `${CONTACTS_BASE}/contact-1`, {
        body: updateBody,
      });
      expect(status).not.toBe(403);
    });

    test('DELETE /:id (soft delete) passes auth (not 403)', async () => {
      const { status } = await sendRequest(server, 'DELETE', `${CONTACTS_BASE}/contact-1`);
      expect(status).not.toBe(403);
    });

    test('POST /:id/link-session passes auth (not 403)', async () => {
      const { status } = await sendRequest(
        server,
        'POST',
        `${CONTACTS_BASE}/contact-1/link-session`,
        {
          body: linkSessionBody,
        },
      );
      expect(status).not.toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // VIEWER — no agent:execute → writes 403, reads pass
  // ---------------------------------------------------------------------------
  describe('VIEWER role (no agent:execute)', () => {
    let server: http.Server;

    beforeAll(async () => {
      ({ server } = await createServerForRole('VIEWER'));
    });
    afterAll(async () => closeServer(server));

    test('POST / (create) returns 403', async () => {
      const { status, body } = await sendRequest(server, 'POST', CONTACTS_BASE, {
        body: createBody,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.required).toBe('agent:execute');
    });

    test('GET / (query) passes — no RBAC on reads', async () => {
      const { status } = await sendRequest(server, 'GET', CONTACTS_BASE);
      expect(status).not.toBe(403);
    });

    test('PUT /:id (update) returns 403', async () => {
      const { status, body } = await sendRequest(server, 'PUT', `${CONTACTS_BASE}/contact-1`, {
        body: updateBody,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.required).toBe('agent:execute');
    });

    test('DELETE /:id (soft delete) returns 403', async () => {
      const { status, body } = await sendRequest(server, 'DELETE', `${CONTACTS_BASE}/contact-1`);
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.required).toBe('agent:execute');
    });

    test('POST /:id/link-session returns 403', async () => {
      const { status, body } = await sendRequest(
        server,
        'POST',
        `${CONTACTS_BASE}/contact-1/link-session`,
        { body: linkSessionBody },
      );
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.required).toBe('agent:execute');
    });
  });

  // ---------------------------------------------------------------------------
  // Unauthenticated — no tenantContext → all 401
  // ---------------------------------------------------------------------------
  describe('Unauthenticated requests (no tenantContext)', () => {
    let server: http.Server;

    beforeAll(async () => {
      ({ server } = await createUnauthenticatedServer());
    });
    afterAll(async () => closeServer(server));

    test('POST / (create) returns 401', async () => {
      const { status, body } = await sendRequest(server, 'POST', CONTACTS_BASE, {
        body: createBody,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET / (query) returns 401', async () => {
      const { status, body } = await sendRequest(server, 'GET', CONTACTS_BASE);
      expect(status).toBe(401);
      // GET / uses inline tenantContext check that returns plain string error
      expect(body.error).toBe('Authentication required');
    });

    test('PUT /:id (update) returns 401', async () => {
      const { status, body } = await sendRequest(server, 'PUT', `${CONTACTS_BASE}/contact-1`, {
        body: updateBody,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('DELETE /:id (soft delete) returns 401', async () => {
      const { status, body } = await sendRequest(server, 'DELETE', `${CONTACTS_BASE}/contact-1`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST /:id/link-session returns 401', async () => {
      const { status, body } = await sendRequest(
        server,
        'POST',
        `${CONTACTS_BASE}/contact-1/link-session`,
        { body: linkSessionBody },
      );
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });
  });
});
