/**
 * Analytics Routes Tests
 *
 * Unit tests for mapping coverage analytics endpoint.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

// ─── Hoisted Mocks ─────────────────────────────────────────────────────────

const { mockFieldMapping, mockConnectorConfig, mockRedisClient } = vi.hoisted(() => ({
  mockFieldMapping: {
    aggregate: vi.fn(),
  },
  mockConnectorConfig: {
    find: vi.fn(),
  },
  mockRedisClient: {
    get: vi.fn(),
    setex: vi.fn(),
    on: vi.fn(),
    disconnect: vi.fn(),
  },
}));

// ─── Module Mocks ───────────────────────────────────────────────────────────

vi.mock('../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'FieldMapping') return mockFieldMapping;
    if (name === 'ConnectorConfig') return mockConnectorConfig;
    return {};
  },
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('ioredis', () => {
  const MockIORedis = vi.fn().mockImplementation(function () {
    return mockRedisClient;
  });
  return { default: MockIORedis };
});

vi.mock('../../workers/shared.js', () => ({
  getSharedRedisClient: vi.fn().mockReturnValue(mockRedisClient),
  getRedisConnection: vi.fn().mockReturnValue({ host: 'localhost', port: 6379 }),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

import analyticsRouter from '../analytics.js';

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('Analytics Routes - Mapping Coverage', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.tenantContext = {
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'admin',
        permissions: ['admin:analytics:read'],
        authType: 'jwt_user',
        isSuperAdmin: false,
      };
      next();
    });
    app.use('/api/search-ai/analytics', analyticsRouter);
    vi.clearAllMocks();

    // Default: no Redis cache
    mockRedisClient.get.mockResolvedValue(null);
    mockRedisClient.setex.mockResolvedValue('OK');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Aggregation Tests ──────────────────────────────────────────────────

  test('returns aggregated counts grouped by connectorId', async () => {
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue([
        { _id: { connectorId: 'conn-1', suggestedBy: 'rules' }, count: 5 },
        { _id: { connectorId: 'conn-1', suggestedBy: 'llm' }, count: 3 },
        { _id: { connectorId: 'conn-1', suggestedBy: 'user' }, count: 2 },
        { _id: { connectorId: 'conn-2', suggestedBy: 'rules' }, count: 8 },
      ]),
    });

    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue([
        { _id: { connectorId: 'conn-1', status: 'active' }, count: 7 },
        { _id: { connectorId: 'conn-1', status: 'suggested' }, count: 3 },
        { _id: { connectorId: 'conn-2', status: 'active' }, count: 8 },
      ]),
    });

    mockConnectorConfig.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          { _id: 'conn-1', connectorType: 'jira' },
          { _id: 'conn-2', connectorType: 'sharepoint' },
        ]),
      }),
    });

    const res = await request(app).get('/api/search-ai/analytics/mapping-coverage');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.coverage).toHaveLength(2);

    const conn1 = res.body.data.coverage.find((c: any) => c.connectorId === 'conn-1');
    expect(conn1).toBeDefined();
    expect(conn1.totalMappings).toBe(10);
    expect(conn1.ruleBasedCount).toBe(5);
    expect(conn1.llmCount).toBe(3);
    expect(conn1.manualCount).toBe(2);
    expect(conn1.connectorType).toBe('jira');

    const conn2 = res.body.data.coverage.find((c: any) => c.connectorId === 'conn-2');
    expect(conn2).toBeDefined();
    expect(conn2.totalMappings).toBe(8);
    expect(conn2.ruleBasedCount).toBe(8);
    expect(conn2.connectorType).toBe('sharepoint');
  });

  test('correctly counts suggestedBy=rules as ruleBasedCount', async () => {
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi
        .fn()
        .mockResolvedValue([{ _id: { connectorId: 'conn-1', suggestedBy: 'rules' }, count: 12 }]),
    });
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue([]),
    });
    mockConnectorConfig.find.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    });

    const res = await request(app).get('/api/search-ai/analytics/mapping-coverage');

    expect(res.status).toBe(200);
    const coverage = res.body.data.coverage[0];
    expect(coverage.ruleBasedCount).toBe(12);
    expect(coverage.llmCount).toBe(0);
    expect(coverage.manualCount).toBe(0);
  });

  test('correctly counts suggestedBy=llm as llmCount', async () => {
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi
        .fn()
        .mockResolvedValue([{ _id: { connectorId: 'conn-1', suggestedBy: 'llm' }, count: 7 }]),
    });
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue([]),
    });
    mockConnectorConfig.find.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    });

    const res = await request(app).get('/api/search-ai/analytics/mapping-coverage');

    expect(res.status).toBe(200);
    expect(res.body.data.coverage[0].llmCount).toBe(7);
  });

  test('correctly counts suggestedBy=user as manualCount', async () => {
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi
        .fn()
        .mockResolvedValue([{ _id: { connectorId: 'conn-1', suggestedBy: 'user' }, count: 4 }]),
    });
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue([]),
    });
    mockConnectorConfig.find.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    });

    const res = await request(app).get('/api/search-ai/analytics/mapping-coverage');

    expect(res.status).toBe(200);
    expect(res.body.data.coverage[0].manualCount).toBe(4);
  });

  test('computes ruleBasedPercentage correctly', async () => {
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue([
        { _id: { connectorId: 'conn-1', suggestedBy: 'rules' }, count: 7 },
        { _id: { connectorId: 'conn-1', suggestedBy: 'llm' }, count: 2 },
        { _id: { connectorId: 'conn-1', suggestedBy: 'user' }, count: 1 },
      ]),
    });
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue([]),
    });
    mockConnectorConfig.find.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    });

    const res = await request(app).get('/api/search-ai/analytics/mapping-coverage');

    expect(res.status).toBe(200);
    // 7/10 * 100 = 70
    expect(res.body.data.coverage[0].ruleBasedPercentage).toBe(70);
  });

  // ─── Tenant Scoping ─────────────────────────────────────────────────────

  test('scopes queries to requesting tenant', async () => {
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue([]),
    });
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue([]),
    });

    await request(app).get('/api/search-ai/analytics/mapping-coverage');

    // Verify the aggregation pipeline includes tenantId in $match
    const firstCall = mockFieldMapping.aggregate.mock.calls[0][0];
    expect(firstCall[0].$match.tenantId).toBe('tenant-1');

    const secondCall = mockFieldMapping.aggregate.mock.calls[1][0];
    expect(secondCall[0].$match.tenantId).toBe('tenant-1');
  });

  // ─── canonicalSchemaId Filter ───────────────────────────────────────────

  test('filters by canonicalSchemaId when provided', async () => {
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue([]),
    });
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue([]),
    });

    await request(app).get(
      '/api/search-ai/analytics/mapping-coverage?canonicalSchemaId=schema-123',
    );

    const firstCall = mockFieldMapping.aggregate.mock.calls[0][0];
    expect(firstCall[0].$match.canonicalSchemaId).toBe('schema-123');
  });

  // ─── Redis Caching ──────────────────────────────────────────────────────

  test('returns cached result on second call', async () => {
    const cachedData = {
      coverage: [
        {
          connectorId: 'conn-1',
          connectorType: 'jira',
          totalMappings: 10,
          ruleBasedCount: 5,
          llmCount: 3,
          manualCount: 2,
          ruleBasedPercentage: 50,
          statusBreakdown: { active: 7, suggested: 3, rejected: 0 },
        },
      ],
    };

    mockRedisClient.get.mockResolvedValue(JSON.stringify(cachedData));

    const res = await request(app).get('/api/search-ai/analytics/mapping-coverage');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.coverage).toHaveLength(1);
    expect(res.body.data.coverage[0].connectorId).toBe('conn-1');

    // Aggregation should NOT have been called — cache hit
    expect(mockFieldMapping.aggregate).not.toHaveBeenCalled();
  });

  test('falls back to MongoDB if Redis unavailable', async () => {
    mockRedisClient.get.mockRejectedValue(new Error('Redis connection refused'));
    mockRedisClient.setex.mockRejectedValue(new Error('Redis connection refused'));

    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi
        .fn()
        .mockResolvedValue([{ _id: { connectorId: 'conn-1', suggestedBy: 'rules' }, count: 3 }]),
    });
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi
        .fn()
        .mockResolvedValue([{ _id: { connectorId: 'conn-1', status: 'active' }, count: 3 }]),
    });
    mockConnectorConfig.find.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    });

    const res = await request(app).get('/api/search-ai/analytics/mapping-coverage');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.coverage).toHaveLength(1);
    // MongoDB was called despite Redis failure
    expect(mockFieldMapping.aggregate).toHaveBeenCalledTimes(2);
  });

  // ─── Empty Results ──────────────────────────────────────────────────────

  test('returns empty array if no mappings exist', async () => {
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue([]),
    });
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue([]),
    });

    const res = await request(app).get('/api/search-ai/analytics/mapping-coverage');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.coverage).toEqual([]);
  });

  // ─── Status Breakdown ──────────────────────────────────────────────────

  test('includes status breakdown per connector', async () => {
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi
        .fn()
        .mockResolvedValue([{ _id: { connectorId: 'conn-1', suggestedBy: 'rules' }, count: 10 }]),
    });
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue([
        { _id: { connectorId: 'conn-1', status: 'active' }, count: 5 },
        { _id: { connectorId: 'conn-1', status: 'suggested' }, count: 3 },
        { _id: { connectorId: 'conn-1', status: 'rejected' }, count: 2 },
      ]),
    });
    mockConnectorConfig.find.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    });

    const res = await request(app).get('/api/search-ai/analytics/mapping-coverage');

    expect(res.status).toBe(200);
    const breakdown = res.body.data.coverage[0].statusBreakdown;
    expect(breakdown.active).toBe(5);
    expect(breakdown.suggested).toBe(3);
    expect(breakdown.rejected).toBe(2);
  });

  // ─── Error Handling ─────────────────────────────────────────────────────

  test('returns 500 with error code on aggregation failure', async () => {
    mockRedisClient.get.mockResolvedValue(null);
    mockFieldMapping.aggregate.mockReturnValueOnce({
      exec: vi.fn().mockRejectedValue(new Error('MongoDB aggregation failed')),
    });

    const res = await request(app).get('/api/search-ai/analytics/mapping-coverage');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('ANALYTICS_FAILED');
    expect(res.body.error.message).toBe('Failed to compute mapping coverage');
  });
});
