import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.tenantContext = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'ADMIN',
      permissions: ['model_config:*'],
    };
    next();
  },
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: unknown, _opts: unknown) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: unknown, ...handlers: any[]) => {
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

const mockWriteAuditLog = vi.fn();
vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

const mockInvalidateModelResolutionCaches = vi.fn();
vi.mock('../../services/llm/model-cache-invalidation.js', () => ({
  invalidateModelResolutionCaches: (...args: unknown[]) =>
    mockInvalidateModelResolutionCaches(...args),
}));

async function createTestApp() {
  const { default: router } = await import('../tenant-model-resolution-cache.js');
  const app = express();
  app.use(express.json());
  app.use('/api/tenants/:tenantId/model-resolution-cache', router);
  return app;
}

describe('tenant model-resolution cache route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('POST /invalidate clears model-resolution caches for the authenticated tenant', async () => {
    const app = await createTestApp();

    const res = await request(app).post('/api/tenants/tenant-1/model-resolution-cache/invalidate');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-1');
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'model-resolution-cache:invalidate',
        tenantId: 'tenant-1',
        userId: 'user-1',
      }),
    );
  });

  test('POST /invalidate rejects tenant mismatches', async () => {
    const app = await createTestApp();

    const res = await request(app).post('/api/tenants/tenant-2/model-resolution-cache/invalidate');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Tenant access denied' });
    expect(mockInvalidateModelResolutionCaches).not.toHaveBeenCalled();
  });
});
