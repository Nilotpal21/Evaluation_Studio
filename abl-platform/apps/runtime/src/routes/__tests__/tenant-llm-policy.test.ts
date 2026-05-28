import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.tenantContext = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'ADMIN',
      permissions: ['credential:*'],
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

vi.mock('@agent-platform/shared-observability', () => ({
  getCurrentRequestId: vi.fn(() => 'req-tenant-policy-test'),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

const mockFindLLMPolicyOrDefaults = vi.fn();
const mockUpsertLLMPolicy = vi.fn();
vi.mock('../../repos/tenant-llm-policy-repo.js', () => ({
  findLLMPolicyOrDefaults: (...args: any[]) => mockFindLLMPolicyOrDefaults(...args),
  upsertLLMPolicy: (...args: any[]) => mockUpsertLLMPolicy(...args),
}));

const mockWriteAuditLog = vi.fn();
vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: (...args: any[]) => mockWriteAuditLog(...args),
}));

const mockInvalidateModelResolutionCaches = vi.fn();
vi.mock('../../services/llm/model-cache-invalidation.js', () => ({
  invalidateModelResolutionCaches: (...args: any[]) => mockInvalidateModelResolutionCaches(...args),
}));

async function createTestApp() {
  const { default: router } = await import('../tenant-llm-policy.js');
  const app = express();
  app.use(express.json());
  app.use('/api/tenants/:tenantId/llm-policy', router);
  return app;
}

describe('Tenant LLM policy route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('invalidates model-resolution caches after a successful policy update', async () => {
    const app = await createTestApp();
    mockUpsertLLMPolicy.mockResolvedValue({
      credentialPolicy: 'org_first',
      allowedProviders: ['openai'],
      allowProjectCredentials: true,
      platformDemoEnabled: false,
      monthlyTokenBudget: 1_000_000,
      dailyTokenBudget: 50_000,
      maxRequestsPerMinute: 120,
      defaultModel: null,
      defaultFastModel: null,
      defaultVoiceModel: null,
    });

    const res = await request(app)
      .put('/api/tenants/tenant-1/llm-policy')
      .send({
        credentialPolicy: 'org_first',
        allowedProviders: ['openai'],
      });

    expect(res.status).toBe(200);
    expect(mockUpsertLLMPolicy).toHaveBeenCalledWith('tenant-1', {
      credentialPolicy: 'org_first',
      allowedProviders: ['openai'],
    });
    expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-1');
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant-llm-policy:update',
        tenantId: 'tenant-1',
        userId: 'user-1',
      }),
    );
  });

  test('fails closed on tenant mismatch without updating policy or invalidating caches', async () => {
    const app = await createTestApp();

    const res = await request(app)
      .put('/api/tenants/tenant-2/llm-policy')
      .send({
        credentialPolicy: 'org_first',
        allowedProviders: ['openai'],
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Tenant access denied' });
    expect(mockUpsertLLMPolicy).not.toHaveBeenCalled();
    expect(mockInvalidateModelResolutionCaches).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });
});
