import express, { type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPlatformAdminAuthMiddleware = vi.fn((_req: unknown, _res: unknown, next: () => void) =>
  next(),
);
const mockRequirePlatformAdminMiddleware = vi.fn((_req: unknown, _res: unknown, next: () => void) =>
  next(),
);
const mockRequirePlatformAdminIpMiddleware = vi.fn(
  (_req: unknown, _res: unknown, next: () => void) => next(),
);
const mockGetConfig = vi.fn();
const mockGetCurrentRequestId = vi.fn();
const mockAggregate = vi.fn();
const mockTenantFind = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  platformAdminAuthMiddleware: (...args: unknown[]) => mockPlatformAdminAuthMiddleware(...args),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requirePlatformAdmin: vi.fn(
    () =>
      (...args: unknown[]) =>
        mockRequirePlatformAdminMiddleware(...args),
  ),
  requirePlatformAdminIp: vi.fn(
    () =>
      (...args: unknown[]) =>
        mockRequirePlatformAdminIpMiddleware(...args),
  ),
}));

vi.mock('@agent-platform/shared-observability', () => ({
  getCurrentRequestId: (...args: unknown[]) => mockGetCurrentRequestId(...args),
}));

vi.mock('../../config/index.js', () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  LLMUsageMetric: {
    aggregate: (...args: unknown[]) => mockAggregate(...args),
  },
  Tenant: {
    find: (...args: unknown[]) => mockTenantFind(...args),
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import platformAdminUsageRouter from '../../routes/platform-admin-usage.js';

const NOW = new Date('2026-03-30T12:00:00.000Z');

function createApp() {
  const app = express();
  app.use('/api/platform/admin/usage-summary', platformAdminUsageRouter);
  return app;
}

function queueAggregateResults(results: unknown[]) {
  mockAggregate.mockReset();
  for (const result of results) {
    const exec = vi.fn().mockResolvedValue(result);
    mockAggregate.mockImplementationOnce(() => ({ exec }));
  }
}

function queueAggregateFailure(error: Error) {
  mockAggregate.mockReset();
  const exec = vi.fn().mockRejectedValue(error);
  mockAggregate.mockImplementation(() => ({ exec }));
}

function queueTenantLookup(result: unknown, options?: { reject?: boolean }) {
  const exec = options?.reject
    ? vi.fn().mockRejectedValue(result)
    : vi.fn().mockResolvedValue(result);
  const lean = vi.fn(() => ({ exec }));
  mockTenantFind.mockReturnValue({ lean });
}

describe('Platform admin usage route contract', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();

    mockGetConfig.mockReturnValue({
      security: {
        platformAdminAllowedIps: ['127.0.0.1'],
      },
    });
    mockGetCurrentRequestId.mockReturnValue('req-usage-1');

    queueAggregateResults([
      [
        {
          totalTokens: 4000,
          totalCost: 1.23456,
          sessionIds: ['s1', 's2'],
          tenantIds: ['tenant-1', 'tenant-2'],
        },
      ],
      [{ period: '2026-03-30', tokens: 4000, cost: 1.2346, sessions: 2 }],
      [
        { _id: 'tenant-1', cost: 1.23456, tokens: 3000 },
        { _id: 'tenant-2', cost: 0.5, tokens: 1000 },
      ],
      [
        { _id: 'openai', tokens: 3000, cost: 1.0 },
        { _id: 'anthropic', tokens: 1000, cost: 0.5 },
      ],
    ]);
    queueTenantLookup([{ _id: 'tenant-1', name: 'Tenant One' }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the existing usage summary envelope with default date range and day grouping', async () => {
    const app = createApp();

    const response = await request(app).get('/api/platform/admin/usage-summary').expect(200);

    expect(response.body).toEqual({
      success: true,
      summary: {
        totalTokens: 4000,
        totalCost: 1.2346,
        sessionCount: 2,
        activeTenants: 2,
      },
      timeSeries: [{ period: '2026-03-30', tokens: 4000, cost: 1.2346, sessions: 2 }],
      topTenants: [
        {
          tenantId: 'tenant-1',
          tenantName: 'Tenant One',
          cost: 1.2346,
          tokens: 3000,
        },
        {
          tenantId: 'tenant-2',
          tenantName: 'tenant-2',
          cost: 0.5,
          tokens: 1000,
        },
      ],
      providerBreakdown: [
        { provider: 'openai', tokens: 3000, cost: 1, percentage: 75 },
        { provider: 'anthropic', tokens: 1000, cost: 0.5, percentage: 25 },
      ],
    });

    const summaryPipeline = mockAggregate.mock.calls[0]?.[0];
    const dateMatch = summaryPipeline?.[0]?.$match;
    expect(dateMatch.tenantId).toBeUndefined();
    expect(dateMatch.createdAt.$gte.toISOString()).toBe('2026-02-28T12:00:00.000Z');
    expect(dateMatch.createdAt.$lte.toISOString()).toBe('2026-03-30T12:00:00.000Z');

    const timeSeriesPipeline = mockAggregate.mock.calls[1]?.[0];
    expect(timeSeriesPipeline?.[1]?.$group?._id?.$dateToString?.format).toBe('%Y-%m-%d');

    const topTenantsPipeline = mockAggregate.mock.calls[2]?.[0];
    expect(topTenantsPipeline?.[2]).toEqual({ $sort: { cost: -1 } });
    expect(topTenantsPipeline?.[3]).toEqual({ $limit: 10 });
  });

  it('respects query filters for from, to, groupBy, and tenantId', async () => {
    const app = createApp();

    await request(app)
      .get('/api/platform/admin/usage-summary')
      .query({
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-03-15T00:00:00.000Z',
        groupBy: 'hour',
        tenantId: 'tenant-99',
      })
      .expect(200);

    const summaryPipeline = mockAggregate.mock.calls[0]?.[0];
    const dateMatch = summaryPipeline?.[0]?.$match;
    expect(dateMatch.tenantId).toBe('tenant-99');
    expect(dateMatch.createdAt.$gte.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(dateMatch.createdAt.$lte.toISOString()).toBe('2026-03-15T00:00:00.000Z');

    const timeSeriesPipeline = mockAggregate.mock.calls[1]?.[0];
    expect(timeSeriesPipeline?.[1]?.$group?._id?.$dateToString?.format).toBe('%Y-%m-%dT%H:00:00Z');
  });

  it('falls back to tenant IDs when tenant-name enrichment fails', async () => {
    const app = createApp();
    queueTenantLookup(new Error('tenant lookup failed'), { reject: true });

    const response = await request(app).get('/api/platform/admin/usage-summary').expect(200);

    expect(response.body.topTenants).toEqual([
      {
        tenantId: 'tenant-1',
        tenantName: 'tenant-1',
        cost: 1.2346,
        tokens: 3000,
      },
      {
        tenantId: 'tenant-2',
        tenantName: 'tenant-2',
        cost: 0.5,
        tokens: 1000,
      },
    ]);
  });

  it('returns 500 when aggregation fails', async () => {
    const app = createApp();
    queueAggregateFailure(new Error('aggregation failed'));

    await request(app).get('/api/platform/admin/usage-summary').expect(500, {
      success: false,
      error: 'Failed to aggregate usage data',
    });
  });

  it('returns 400 for malformed query shapes before aggregation runs', async () => {
    const app = createApp();

    await request(app).get('/api/platform/admin/usage-summary?from[bad]=value').expect(400, {
      success: false,
      error: 'Invalid query parameters',
    });

    expect(mockAggregate).not.toHaveBeenCalled();
  });

  it('short-circuits before aggregation when platform-admin middleware denies access', async () => {
    const app = createApp();
    mockRequirePlatformAdminMiddleware.mockImplementationOnce((_req, res: Response) => {
      res.status(403).json({
        success: false,
        error: 'Forbidden',
      });
    });

    await request(app).get('/api/platform/admin/usage-summary').expect(403, {
      success: false,
      error: 'Forbidden',
    });

    expect(mockAggregate).not.toHaveBeenCalled();
  });
});
