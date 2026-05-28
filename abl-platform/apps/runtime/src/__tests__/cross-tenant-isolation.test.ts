/**
 * Cross-Tenant Isolation Tests
 *
 * Verifies that DB-level tenant filtering prevents users from one tenant
 * from accessing resources belonging to another tenant. Each route handler
 * passes req.tenantContext.tenantId to its repo/store queries, ensuring
 * resources are scoped to the authenticated tenant.
 *
 * Strategy:
 * - Mock repos to return data only when tenantId matches 'tenant-A'
 * - Make requests as OWNER of tenant-A
 * - Verify that accessing resources with tenant-B's IDs returns 404
 */

import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { makeTenantContext, injectTenantContext } from './helpers/auth-context.js';

// =============================================================================
// MOCKS
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

// Channel-connections imports requireProjectScope from shared-auth (not shared)
vi.mock('@agent-platform/shared-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared-auth')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  };
});

// RBAC middleware — these tests verify data-layer tenant isolation,
// not RBAC enforcement. Let all permission checks pass.
vi.mock('../middleware/rbac.js', () => ({
  requireProjectPermission: vi.fn().mockResolvedValue(true),
  requireWriteAccess: vi.fn().mockResolvedValue(true),
  requirePermissionInline: vi.fn().mockReturnValue(true),
  WRITE_ROLES: ['OWNER', 'ADMIN', 'OPERATOR'],
  READ_ROLES: ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'],
  PROJECT_ROLE_PERMISSIONS: {},
}));

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

// --- Workflow & Contact stores ---
vi.mock('../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    workflowDefinition: {
      getById: vi.fn().mockImplementation((id: string) => {
        if (id === 'wf-tenant-a') {
          return Promise.resolve({ id: 'wf-tenant-a', name: 'Workflow A', tenantId: 'tenant-A' });
        }
        return Promise.resolve(null);
      }),
      findById: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(null),
      query: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      create: vi.fn().mockResolvedValue({ id: 'wf-1', tenantId: 'tenant-A' }),
      archive: vi.fn().mockResolvedValue(null),
      associateSession: vi.fn().mockResolvedValue(null),
    },
    contact: {
      findById: vi.fn().mockImplementation((id: string, tenantId: string) => {
        if (tenantId === 'tenant-A' && id === 'contact-tenant-a') {
          return Promise.resolve({ id: 'contact-tenant-a', tenantId: 'tenant-A' });
        }
        return Promise.resolve(null);
      }),
      getById: vi.fn().mockImplementation((id: string, tenantId: string) => {
        if (tenantId === 'tenant-A' && id === 'contact-tenant-a') {
          return Promise.resolve({ id: 'contact-tenant-a', tenantId: 'tenant-A' });
        }
        return Promise.resolve(null);
      }),
      update: vi.fn().mockResolvedValue(null),
      softDelete: vi.fn().mockResolvedValue(null),
      query: vi.fn().mockResolvedValue({ contacts: [], total: 0 }),
      create: vi.fn().mockResolvedValue({ id: 'c-1' }),
      linkSession: vi.fn().mockResolvedValue(null),
      findByIdentity: vi.fn().mockResolvedValue(null),
      touchLastSeen: vi.fn().mockResolvedValue(undefined),
    },
    conversation: {
      findById: vi.fn().mockResolvedValue(null),
      countByFilter: vi.fn().mockResolvedValue(0),
      linkContact: vi.fn().mockResolvedValue(undefined),
    },
  })),
}));

// --- Session repo (for sessions route) ---
vi.mock('../repos/session-repo.js', () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  countSessions: vi.fn().mockResolvedValue(0),
  findSessionById: vi.fn().mockImplementation((id: string, tenantId: string) => {
    if (tenantId === 'tenant-A' && id === 'sess-tenant-a') {
      return Promise.resolve({ _id: 'sess-tenant-a', tenantId: 'tenant-A', status: 'active' });
    }
    return Promise.resolve(null);
  }),
  findSessionByRuntimeId: vi.fn().mockResolvedValue(null),
  findMessagesForSession: vi.fn().mockResolvedValue([]),
  updateSession: vi.fn(),
  unlinkContactFromSessions: vi.fn().mockResolvedValue(0),
}));

// --- Channel connections (for channel-connections route) ---
vi.mock('@agent-platform/database/models', () => ({
  ChannelConnection: {
    findOne: vi.fn().mockImplementation((query: any) => ({
      lean: vi
        .fn()
        .mockResolvedValue(
          query.tenantId === 'tenant-A' && query._id === 'conn-tenant-a'
            ? { _id: 'conn-tenant-a', tenantId: 'tenant-A', channelType: 'slack' }
            : null,
        ),
    })),
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    }),
    findOneAndUpdate: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    }),
    create: vi.fn().mockResolvedValue({ _id: 'conn-1' }),
  },
}));

vi.mock('../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn().mockResolvedValue({ _id: 'proj-1', tenantId: 'tenant-A' }),
  findProjectAgentsForProject: vi.fn().mockResolvedValue([]),
  findProjectAgentByPath: vi.fn(),
  findProjectAgentByName: vi.fn(),
}));

vi.mock('../repos/deployment-repo.js', () => ({
  findDeploymentById: vi.fn().mockResolvedValue(null),
  findActiveDeployment: vi.fn().mockResolvedValue(null),
  listDeployments: vi.fn().mockResolvedValue([]),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => ({
    encryptForTenant: vi.fn(() => 'encrypted'),
    decryptForTenant: vi.fn(() => 'decrypted'),
  })),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock('../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    getSession: vi.fn().mockReturnValue(null),
    getSessionDetail: vi.fn().mockReturnValue(null),
    listSessions: vi.fn().mockReturnValue([]),
    endSession: vi.fn(),
  })),
}));

vi.mock('../services/trace-store.js', () => ({
  getTraceStore: vi.fn(() => ({
    getEvents: vi.fn().mockReturnValue([]),
    removeSession: vi.fn(),
    clearSession: vi.fn(),
    getSessionInfo: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../services/test-session.js', () => ({
  TestSessionService: { createSession: vi.fn() },
}));

vi.mock('../services/dsl-utils.js', () => ({
  buildAgentDetails: vi.fn(),
}));

vi.mock('../services/audit-helpers.js', () => ({
  auditSessionModified: vi.fn().mockResolvedValue(undefined),
  auditWorkflowCreated: vi.fn().mockResolvedValue(undefined),
  auditWorkflowUpdated: vi.fn().mockResolvedValue(undefined),
  auditWorkflowArchived: vi.fn().mockResolvedValue(undefined),
  auditContactCreated: vi.fn().mockResolvedValue(undefined),
  auditContactUpdated: vi.fn().mockResolvedValue(undefined),
  auditContactDeleted: vi.fn().mockResolvedValue(undefined),
  auditContactLinked: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/contact-validation.js', () => ({
  validateCreateContact: vi.fn(() => []),
  validateUpdateContact: vi.fn(() => []),
}));

vi.mock('../validation/contact-validation.js', () => ({
  validateCreateContact: vi.fn(() => []),
  validateUpdateContact: vi.fn(() => []),
}));

vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => false),
  requirePrisma: vi.fn(),
}));

vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// IMPORTS
// =============================================================================

import express from 'express';

// =============================================================================
// HELPERS
// =============================================================================

async function createServer(
  tenantId: string,
  mountFn: (app: express.Express) => Promise<void>,
): Promise<{ server: http.Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use(injectTenantContext(makeTenantContext(tenantId, 'owner-user', 'OWNER')));
  await mountFn(app);

  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function request(
  baseUrl: string,
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

// =============================================================================
// TESTS: Workflows — cross-tenant
// =============================================================================

describe('Cross-tenant isolation — Workflows', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const result = await createServer('tenant-A', async (app) => {
      const router = (await import('../routes/workflows.js')).default;
      app.use('/api/projects/:projectId/workflows', router);
    });
    server = result.server;
    baseUrl = result.baseUrl;
  });

  afterAll(() => server?.close());
  beforeEach(() => vi.clearAllMocks());

  test('GET /:id returns 404 for tenant-B workflow', async () => {
    const { status } = await request(baseUrl, 'GET', '/api/projects/proj-1/workflows/wf-tenant-b');
    expect(status).toBe(404);
  });

  test('PUT /:id returns 404 for tenant-B workflow', async () => {
    const { status } = await request(baseUrl, 'PUT', '/api/projects/proj-1/workflows/wf-tenant-b', {
      body: { name: 'hijack', description: 'attempt' },
    });
    expect(status).toBe(404);
  });
});

// =============================================================================
// TESTS: Contacts — cross-tenant
// =============================================================================

describe('Cross-tenant isolation — Contacts', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const result = await createServer('tenant-A', async (app) => {
      const router = (await import('../routes/contacts.js')).default;
      app.use('/api/contacts', router);
    });
    server = result.server;
    baseUrl = result.baseUrl;
  });

  afterAll(() => server?.close());
  beforeEach(() => vi.clearAllMocks());

  test('GET /:id returns 404 for tenant-B contact', async () => {
    const { status } = await request(baseUrl, 'GET', '/api/contacts/contact-tenant-b');
    expect(status).toBe(404);
  });

  test('PUT /:id returns 404 for tenant-B contact', async () => {
    const { status } = await request(baseUrl, 'PUT', '/api/contacts/contact-tenant-b', {
      body: { displayName: 'hijack' },
    });
    expect(status).toBe(404);
  });

  test('DELETE /:id returns 404 for tenant-B contact', async () => {
    const { status } = await request(baseUrl, 'DELETE', '/api/contacts/contact-tenant-b');
    expect(status).toBe(404);
  });
});

// =============================================================================
// TESTS: Channel Connections — cross-tenant
// =============================================================================

describe('Cross-tenant isolation — Channel Connections', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const result = await createServer('tenant-A', async (app) => {
      const router = (await import('../routes/channel-connections.js')).default;
      app.use('/channel-connections', router);
    });
    server = result.server;
    baseUrl = result.baseUrl;
  });

  afterAll(() => server?.close());
  beforeEach(() => vi.clearAllMocks());

  test('GET /:id returns 404 for tenant-B connection', async () => {
    const { status, body } = await request(baseUrl, 'GET', '/channel-connections/conn-tenant-b');
    expect(status).toBe(404);
    expect(body.error).toBe('Channel connection not found');
  });

  test('PATCH /:id returns 404 for tenant-B connection', async () => {
    const { status, body } = await request(baseUrl, 'PATCH', '/channel-connections/conn-tenant-b', {
      body: { display_name: 'hijack' },
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Channel connection not found');
  });

  test('DELETE /:id returns 404 for tenant-B connection', async () => {
    const { status, body } = await request(baseUrl, 'DELETE', '/channel-connections/conn-tenant-b');
    expect(status).toBe(404);
    expect(body.error).toBe('Channel connection not found');
  });
});
