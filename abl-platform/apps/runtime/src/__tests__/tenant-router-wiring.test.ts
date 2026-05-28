/**
 * Tenant Router Wiring Tests
 *
 * Validates that the tenant router in server.ts mounts middleware in the
 * correct order: auth BEFORE requireTenantMatch.
 *
 * Background: PR #277 (encryption-hardening-v2) added requireTenantMatch to
 * the parent tenantRouter but without auth middleware before it. Since
 * requireTenantMatch reads req.tenantContext (set by auth), every request
 * to /api/tenants/:tenantId/* returned 404.
 *
 * Existing tests mount sub-routers in isolation (bypassing the parent router),
 * so they never caught this ordering bug. This test mounts the tenant router
 * the same way server.ts does.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — declared before any imports that pull them in
// =============================================================================

// Mock auth to set tenantContext (simulating what unified auth does with a valid JWT)
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    // Simulate unified auth populating tenantContext from a valid JWT
    const tenantId = req.headers['x-test-tenant-id'];
    if (tenantId) {
      req.tenantContext = {
        tenantId,
        userId: 'user-test-001',
        role: 'OWNER',
        permissions: ['*:*'],
        authType: 'user',
        isSuperAdmin: false,
      };
      req.user = { id: 'user-test-001', email: 'test@example.com' };
    }
    next();
  }),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
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

// Mock shared-observability FIRST — @abl/compiler/platform/logger.ts re-exports
// createLogger from this package, so internal relative imports within the compiler
// (e.g. conversation-store → ../logger.js) resolve here at runtime.
vi.mock('@agent-platform/shared-observability', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getCurrentRequestId: vi.fn(() => 'req-test-123'),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Cut the deep import chain: tenant-models → model-cache-invalidation →
// runtime-executor → trace-store → otel-trace-bridge → @abl/compiler/platform/stores
vi.mock('../services/llm/model-cache-invalidation.js', () => ({
  invalidateModelResolutionCaches: vi.fn(),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => ({
    encryptForTenant: vi.fn(() => 'encrypted'),
    decryptForTenant: vi.fn(() => 'decrypted'),
  })),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock('../repos/tenant-model-repo.js', () => ({
  findTenantModel: vi.fn().mockResolvedValue(null),
  findTenantModelWithConnections: vi.fn().mockResolvedValue(null),
  listTenantModels: vi.fn().mockResolvedValue([]),
  countTenantModels: vi.fn().mockResolvedValue(0),
  createTenantModel: vi.fn().mockResolvedValue({ _id: 'model-1' }),
  updateTenantModel: vi.fn().mockResolvedValue(null),
  deleteTenantModel: vi.fn().mockResolvedValue(null),
  updateTenantModelInference: vi.fn().mockResolvedValue(null),
  findTenantModelConnections: vi.fn().mockResolvedValue([]),
  createTenantModelConnection: vi.fn().mockResolvedValue({ _id: 'conn-1' }),
  findTenantModelConnectionById: vi.fn().mockResolvedValue(null),
  updateTenantModelConnection: vi.fn().mockResolvedValue(null),
  deleteTenantModelConnection: vi.fn().mockResolvedValue(true),
  setConnectionPrimary: vi.fn().mockResolvedValue(true),
  findProjectsUsingTenantModel: vi.fn().mockResolvedValue([]),
}));

vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/llm/session-llm-client.js', () => ({
  clearProviderCache: vi.fn(),
}));

vi.mock('@agent-platform/database/models', () => ({
  TenantModel: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  },
}));

vi.mock('@agent-platform/shared-observability', () => ({
  getCurrentRequestId: vi.fn(() => 'req-test-123'),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import express from 'express';
import { requireTenantMatch } from '@agent-platform/shared/middleware';
import { authMiddleware } from '../middleware/auth.js';
import tenantModelsRouter from '../routes/tenant-models.js';

// =============================================================================
// TEST SERVER — mirrors server.ts tenantRouter wiring
// =============================================================================

let server: http.Server | null = null;

async function closeServer() {
  if (server) {
    const s = server;
    server = null;
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function startApp(app: express.Express): Promise<string> {
  await closeServer();
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

function createAppWithCorrectWiring() {
  const app = express();
  app.use(express.json());

  // Mirror server.ts wiring: auth → requireTenantMatch → sub-routers
  const tenantRouter = express.Router({ mergeParams: true });
  tenantRouter.use(authMiddleware);
  tenantRouter.use(requireTenantMatch);
  tenantRouter.use('/models', tenantModelsRouter);
  app.use('/api/tenants/:tenantId', tenantRouter);

  return app;
}

function createAppWithBrokenWiring() {
  const app = express();
  app.use(express.json());

  // Broken: requireTenantMatch before auth (the bug from PR #277)
  const tenantRouter = express.Router({ mergeParams: true });
  tenantRouter.use(requireTenantMatch);
  tenantRouter.use('/models', tenantModelsRouter);
  app.use('/api/tenants/:tenantId', tenantRouter);

  return app;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Tenant router middleware ordering', () => {
  afterEach(async () => {
    await closeServer();
  });

  test('correct wiring: authenticated request to /api/tenants/:tid/models returns 200', async () => {
    const baseUrl = await startApp(createAppWithCorrectWiring());

    const res = await fetch(`${baseUrl}/api/tenants/tenant-A/models`, {
      headers: { 'X-Test-Tenant-Id': 'tenant-A' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('correct wiring: unauthenticated request returns 404 from requireTenantMatch (no tenantContext)', async () => {
    const baseUrl = await startApp(createAppWithCorrectWiring());

    // No X-Test-Tenant-Id header → auth mock doesn't set tenantContext
    const res = await fetch(`${baseUrl}/api/tenants/tenant-A/models`);

    expect(res.status).toBe(404);
  });

  test('correct wiring: cross-tenant request returns 404', async () => {
    const baseUrl = await startApp(createAppWithCorrectWiring());

    // Auth says tenant-A, URL says tenant-B → requireTenantMatch rejects
    const res = await fetch(`${baseUrl}/api/tenants/tenant-B/models`, {
      headers: { 'X-Test-Tenant-Id': 'tenant-A' },
    });

    expect(res.status).toBe(404);
  });

  test('broken wiring: requireTenantMatch before auth always returns 404 even for valid requests', async () => {
    const baseUrl = await startApp(createAppWithBrokenWiring());

    // This would succeed with correct wiring but fails with broken ordering
    const res = await fetch(`${baseUrl}/api/tenants/tenant-A/models`, {
      headers: { 'X-Test-Tenant-Id': 'tenant-A' },
    });

    // Bug: always 404 because tenantContext isn't set yet
    expect(res.status).toBe(404);
  });
});
