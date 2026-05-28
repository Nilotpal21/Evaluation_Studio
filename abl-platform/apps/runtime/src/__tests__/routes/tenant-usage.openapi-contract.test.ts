import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequirePermission = vi.fn();
const mockGetClickHouseClient = vi.fn();
const mockGetTenantUsage = vi.fn();
const mockGetTenantCostBreakdown = vi.fn();
const mockGetTenantDailyUsage = vi.fn();
const mockGetTenantProjectUsage = vi.fn();
const mockClickHouseMetricsStoreConstructor = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.tenantContext = {
      tenantId: 'tenant-1',
      authType: 'session',
      permissions: ['credential:read'],
    };
    next();
  }),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('@agent-platform/shared-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared-auth')>();
  return {
    ...actual,
    requirePermission: (permission: string) => (req: unknown, res: unknown, next: () => void) =>
      mockRequirePermission(permission, req, res, next),
  };
});

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: (...args: unknown[]) => mockGetClickHouseClient(...args),
}));

vi.mock('../../services/stores/clickhouse-metrics-store.js', () => ({
  ClickHouseMetricsStore: class ClickHouseMetricsStore {
    constructor(...args: unknown[]) {
      mockClickHouseMetricsStoreConstructor(...args);
    }

    getTenantUsage(...args: unknown[]) {
      return mockGetTenantUsage(...args);
    }

    getTenantCostBreakdown(...args: unknown[]) {
      return mockGetTenantCostBreakdown(...args);
    }

    getTenantDailyUsage(...args: unknown[]) {
      return mockGetTenantDailyUsage(...args);
    }

    getTenantProjectUsage(...args: unknown[]) {
      return mockGetTenantProjectUsage(...args);
    }
  },
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import tenantUsageRouter from '../../routes/tenant-usage.js';

function createApp() {
  const app = express();
  app.use('/api/tenants/:tenantId/usage', tenantUsageRouter);
  return app;
}

describe('Tenant usage route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequirePermission.mockImplementation(
      (_permission: string, _req: unknown, _res: unknown, next: () => void) => next(),
    );
    mockGetClickHouseClient.mockReturnValue({ kind: 'clickhouse-client' });
    mockGetTenantUsage.mockResolvedValue({
      totalRequests: 5,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      estimatedCost: 1.25,
      avgLatencyMs: 42,
    });
    mockGetTenantCostBreakdown.mockResolvedValue([
      {
        modelId: 'gpt-5.4',
        provider: 'openai',
        requests: 5,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        estimatedCost: 1.25,
      },
    ]);
    mockGetTenantDailyUsage.mockResolvedValue([
      {
        date: '2026-03-30',
        totalRequests: 5,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        estimatedCost: 1.25,
      },
    ]);
    mockGetTenantProjectUsage.mockResolvedValue([
      {
        projectId: 'project-1',
        projectName: 'Project One',
        totalRequests: 5,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        estimatedCost: 1.25,
      },
    ]);
  });

  it('returns the existing success envelope and forwards normalized query params to the metrics store', async () => {
    const app = createApp();

    await request(app)
      .get('/api/tenants/tenant-1/usage')
      .query({
        projectId: 'project-1',
        startDate: '2026-03-01T00:00:00.000Z',
        endDate: '2026-03-31T23:59:59.999Z',
      })
      .expect(200, {
        success: true,
        summary: {
          totalRequests: 5,
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          estimatedCost: 1.25,
          avgLatencyMs: 42,
        },
        breakdown: [
          {
            modelId: 'gpt-5.4',
            provider: 'openai',
            requests: 5,
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            estimatedCost: 1.25,
          },
        ],
        daily: [
          {
            date: '2026-03-30',
            totalRequests: 5,
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            estimatedCost: 1.25,
          },
        ],
        projects: [
          {
            projectId: 'project-1',
            projectName: 'Project One',
            totalRequests: 5,
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            estimatedCost: 1.25,
          },
        ],
      });

    expect(mockClickHouseMetricsStoreConstructor).toHaveBeenCalledWith(
      { type: 'clickhouse' },
      {
        client: { kind: 'clickhouse-client' },
        tenantId: 'tenant-1',
      },
    );
    expect(mockRequirePermission).toHaveBeenCalledWith(
      'credential:read',
      expect.anything(),
      expect.anything(),
      expect.any(Function),
    );

    const usageParams = mockGetTenantUsage.mock.calls[0]?.[0];
    expect(usageParams).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      startDate: expect.any(Date),
      endDate: expect.any(Date),
    });
    expect(usageParams.startDate.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(usageParams.endDate.toISOString()).toBe('2026-03-31T23:59:59.999Z');
    expect(mockGetTenantCostBreakdown).toHaveBeenCalledWith(usageParams);
    expect(mockGetTenantDailyUsage).toHaveBeenCalledWith(usageParams);
    expect(mockGetTenantProjectUsage).toHaveBeenCalledWith(usageParams);
  });

  it('preserves the invalid-query envelope for malformed query parameters', async () => {
    const app = createApp();

    await request(app)
      .get('/api/tenants/tenant-1/usage')
      .query({ projectId: ['project-1', 'project-2'] })
      .expect(400, {
        success: false,
        error: 'Invalid query parameters',
      });

    expect(mockClickHouseMetricsStoreConstructor).not.toHaveBeenCalled();
  });

  it('returns 503 with the current envelope when ClickHouse is unavailable', async () => {
    const app = createApp();
    mockGetClickHouseClient.mockImplementation(() => {
      throw new Error('clickhouse unavailable');
    });

    await request(app).get('/api/tenants/tenant-1/usage').expect(503, {
      success: false,
      error: 'Analytics not available',
    });

    expect(mockGetTenantUsage).not.toHaveBeenCalled();
  });

  it('returns 500 with the current failure envelope when a usage query fails', async () => {
    const app = createApp();
    mockGetTenantDailyUsage.mockRejectedValue(new Error('query failed'));

    await request(app).get('/api/tenants/tenant-1/usage').expect(500, {
      success: false,
      error: 'Failed to fetch usage analytics',
    });
  });

  it('stops before store initialization when permission middleware denies access', async () => {
    const app = createApp();
    mockRequirePermission.mockImplementation(
      (_permission: string, _req: unknown, res: any, _next: () => void) => {
        res.status(403).json({
          success: false,
          error: { code: 'PERMISSION_REQUIRED', message: 'Forbidden' },
          required: 'credential:read',
          authType: 'session',
        });
      },
    );

    await request(app)
      .get('/api/tenants/tenant-1/usage')
      .expect(403, {
        success: false,
        error: { code: 'PERMISSION_REQUIRED', message: 'Forbidden' },
        required: 'credential:read',
        authType: 'session',
      });

    expect(mockClickHouseMetricsStoreConstructor).not.toHaveBeenCalled();
  });
});
