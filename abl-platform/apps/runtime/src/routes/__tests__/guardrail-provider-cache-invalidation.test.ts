import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createProviderMock = vi.fn();
const findOneMock = vi.fn();
const findOneAndUpdateMock = vi.fn();
const findOneAndDeleteMock = vi.fn();
const invalidateTenantProviderCacheMock = vi.fn();
const invalidateGuardrailEvalCacheMock = vi.fn();
type MockRequest = { tenantContext?: { tenantId: string; userId: string } };
type Next = () => void;

vi.mock('@agent-platform/database/models', () => ({
  TenantGuardrailProviderConfig: {
    create: (...args: unknown[]) => createProviderMock(...args),
    findOneAndUpdate: (...args: unknown[]) => findOneAndUpdateMock(...args),
    find: vi.fn(),
    findOne: (...args: unknown[]) => findOneMock(...args),
    findOneAndDelete: (...args: unknown[]) => findOneAndDeleteMock(...args),
  },
  AuthProfile: {
    findOne: vi.fn(),
  },
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: MockRequest, _res: unknown, next: Next) => {
    req.tenantContext = { tenantId: 'tenant-1', userId: 'user-1' };
    next();
  },
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: () => (_req: unknown, _res: unknown, next: Next) => next(),
}));

vi.mock('../../middleware/feature-gate.js', () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: Next) => next(),
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: Next) => next(),
}));

vi.mock('@agent-platform/shared-observability', () => ({
  getCurrentRequestId: () => 'req-test',
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock('../../services/guardrails/pipeline-factory.js', () => ({
  createGuardrailProviderFromConfig: vi.fn(),
  invalidateTenantProviderCache: (...args: unknown[]) => invalidateTenantProviderCacheMock(...args),
  invalidateGuardrailEvalCache: (...args: unknown[]) => invalidateGuardrailEvalCacheMock(...args),
}));

const validPayload = {
  name: 'my-guard',
  displayName: 'My Custom HTTP Guard',
  adapterType: 'custom_http',
  endpoint: 'https://guardrail.example.com/evaluate',
  model: 'content-safety-v1',
  hosting: 'cloud_api',
  defaultCategory: 'content_safety',
  defaultThreshold: 0.8,
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000, failMode: 'open' },
  retry: { maxRetries: 2, backoffBaseMs: 500 },
};

async function buildApp() {
  const { default: guardrailProviderRouter } = await import('../guardrail-providers.js');
  const app = express();
  app.use(express.json());
  app.use('/api/tenants/:tenantId/guardrail-providers', guardrailProviderRouter);
  return app;
}

describe('guardrail provider route cache invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createProviderMock.mockResolvedValue({
      _id: 'provider-1',
      ...validPayload,
      tenantId: 'tenant-1',
    });
    findOneMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'provider-1',
        ...validPayload,
        tenantId: 'tenant-1',
      }),
    });
    findOneAndUpdateMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'provider-1',
        ...validPayload,
        displayName: 'Updated',
        tenantId: 'tenant-1',
      }),
    });
    findOneAndDeleteMock.mockResolvedValue({
      _id: 'provider-1',
      ...validPayload,
      tenantId: 'tenant-1',
    });
  });

  it('invalidates provider registry and exact-match evaluation cache after create', async () => {
    const app = await buildApp();

    const res = await request(app)
      .post('/api/tenants/tenant-1/guardrail-providers')
      .send(validPayload);

    expect(res.status).toBe(201);
    expect(invalidateTenantProviderCacheMock).toHaveBeenCalledWith('tenant-1');
    expect(invalidateGuardrailEvalCacheMock).toHaveBeenCalledWith('tenant-1');
  });

  it('invalidates provider registry and exact-match evaluation cache after update', async () => {
    const app = await buildApp();

    const res = await request(app)
      .put('/api/tenants/tenant-1/guardrail-providers/provider-1')
      .send({ displayName: 'Updated' });

    expect(res.status).toBe(200);
    expect(invalidateTenantProviderCacheMock).toHaveBeenCalledWith('tenant-1');
    expect(invalidateGuardrailEvalCacheMock).toHaveBeenCalledWith('tenant-1');
  });

  it('invalidates provider registry and exact-match evaluation cache after delete', async () => {
    const app = await buildApp();

    const res = await request(app).delete('/api/tenants/tenant-1/guardrail-providers/provider-1');

    expect(res.status).toBe(200);
    expect(invalidateTenantProviderCacheMock).toHaveBeenCalledWith('tenant-1');
    expect(invalidateGuardrailEvalCacheMock).toHaveBeenCalledWith('tenant-1');
  });
});
