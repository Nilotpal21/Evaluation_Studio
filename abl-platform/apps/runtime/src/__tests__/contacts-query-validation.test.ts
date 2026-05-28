/**
 * Contacts Route — Query Parameter Validation Tests
 *
 * Verifies that GET /api/contacts validates query parameters:
 *   - type: must be one of ['employee', 'customer', 'anonymous']
 *   - limit: must be a positive integer ≤ 1000
 *   - offset: must be a non-negative integer
 */

import { describe, test, expect, vi, afterAll, beforeAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — declared before any import that transitively pulls in the modules
// =============================================================================

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  };
});

vi.mock('../openapi/registry.js', () => ({
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

vi.mock('@abl/compiler/platform/core/types', () => ({
  IdentityType: {
    ANONYMOUS: 'anonymous',
    AUTHENTICATED: 'authenticated',
    IDENTIFIED: 'identified',
  },
}));

const mockQuery = vi.fn().mockResolvedValue({ contacts: [], total: 0 });

vi.mock('../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    contact: {
      create: vi.fn().mockResolvedValue({ id: 'contact-1', tenantId: 'tenant-A' }),
      getById: vi.fn().mockResolvedValue(null),
      findByIdentity: vi.fn().mockResolvedValue(null),
      query: mockQuery,
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

vi.mock('../repos/session-repo.js', () => ({
  unlinkContactFromSessions: vi.fn().mockResolvedValue(0),
}));

vi.mock('../validation/contact-validation.js', () => ({
  validateCreateContact: vi.fn(() => []),
  validateUpdateContact: vi.fn(() => []),
}));

vi.mock('../services/audit-helpers.js', () => ({
  auditContactCreated: vi.fn().mockResolvedValue(undefined),
  auditContactUpdated: vi.fn().mockResolvedValue(undefined),
  auditContactDeleted: vi.fn().mockResolvedValue(undefined),
  auditContactLinked: vi.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from './helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

let baseUrl: string;
let server: http.Server;

async function createServer() {
  const app = express();
  app.use(express.json());

  const ctx = makeTenantContext('tenant-A', 'user-1', 'ADMIN');
  app.use(injectTenantContext(ctx));

  const contactsRouter = (await import('../routes/contacts.js')).default;
  app.use('/api/contacts', contactsRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server: s });
    });
  });
}

async function queryContacts(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${baseUrl}/api/contacts?${qs}`);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// =============================================================================
// SETUP / TEARDOWN
// =============================================================================

beforeAll(async () => {
  const result = await createServer();
  baseUrl = result.baseUrl;
  server = result.server;
});

afterAll(() => {
  server?.close();
});

// =============================================================================
// TESTS
// =============================================================================

describe('GET /api/contacts — query parameter validation', () => {
  describe('type parameter', () => {
    test('accepts valid type "employee"', async () => {
      const res = await queryContacts({ type: 'employee' });
      expect(res.status).toBe(200);
    });

    test('accepts valid type "customer"', async () => {
      const res = await queryContacts({ type: 'customer' });
      expect(res.status).toBe(200);
    });

    test('accepts valid type "anonymous"', async () => {
      const res = await queryContacts({ type: 'anonymous' });
      expect(res.status).toBe(200);
    });

    test('rejects invalid type', async () => {
      const res = await queryContacts({ type: 'hacker' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(res.body.error.message).toContain('type must be one of');
    });

    test('omitted type is allowed', async () => {
      const res = await queryContacts({});
      expect(res.status).toBe(200);
    });
  });

  describe('limit parameter', () => {
    test('accepts valid limit', async () => {
      const res = await queryContacts({ limit: '50' });
      expect(res.status).toBe(200);
    });

    test('accepts limit of 1', async () => {
      const res = await queryContacts({ limit: '1' });
      expect(res.status).toBe(200);
    });

    test('accepts limit of 1000', async () => {
      const res = await queryContacts({ limit: '1000' });
      expect(res.status).toBe(200);
    });

    test('rejects limit of 0', async () => {
      const res = await queryContacts({ limit: '0' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(res.body.error.message).toContain('limit must be an integer between 1 and 1000');
    });

    test('rejects limit > 1000', async () => {
      const res = await queryContacts({ limit: '1001' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });

    test('rejects negative limit', async () => {
      const res = await queryContacts({ limit: '-5' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });

    test('rejects non-numeric limit', async () => {
      const res = await queryContacts({ limit: 'abc' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });
  });

  describe('offset parameter', () => {
    test('accepts valid offset', async () => {
      const res = await queryContacts({ offset: '10' });
      expect(res.status).toBe(200);
    });

    test('accepts offset of 0', async () => {
      const res = await queryContacts({ offset: '0' });
      expect(res.status).toBe(200);
    });

    test('rejects negative offset', async () => {
      const res = await queryContacts({ offset: '-1' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(res.body.error.message).toContain('offset must be a non-negative integer');
    });

    test('rejects non-numeric offset', async () => {
      const res = await queryContacts({ offset: 'xyz' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });
  });

  describe('combined parameters', () => {
    test('valid type + limit + offset passes', async () => {
      const res = await queryContacts({ type: 'customer', limit: '20', offset: '40' });
      expect(res.status).toBe(200);
    });

    test('invalid type short-circuits before limit check', async () => {
      const res = await queryContacts({ type: 'invalid', limit: '20' });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('type must be one of');
    });
  });
});
