/**
 * Query History Routes Tests
 *
 * Tests for GET /api/indexes/:indexId/query-history endpoint.
 * Mocks ClickHouse client to avoid real DB dependency.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

// ─── Hoisted Mocks ─────────────────────────────────────────────────────────

const { mockChQuery, mockSearchIndexFindOne } = vi.hoisted(() => ({
  mockChQuery: vi.fn(),
  mockSearchIndexFindOne: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    if (modelName === 'SearchIndex') {
      return { findOne: mockSearchIndexFindOne };
    }
    return {};
  }),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    query: mockChQuery,
  }),
  parseClickHouseTimestamp: (ts: string) => new Date(ts),
  toClickHouseDateTime: (input: Date | string) => {
    const d = typeof input === 'string' ? new Date(input) : input;
    return d.toISOString().replace('T', ' ').replace('Z', '');
  },
  toClickHouseDateTimeSec: (input: Date | string) => {
    const d = typeof input === 'string' ? new Date(input) : input;
    return d
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
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

import queryHistoryRouter from '../query-history.js';

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('Query History Routes', () => {
  let app: Express;
  let tenantContext: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    tenantContext = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'admin',
      permissions: [],
      authType: 'jwt_user',
      isSuperAdmin: false,
    };
    mockSearchIndexFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'idx-1' }),
      }),
    });

    app = express();
    app.use(express.json());
    // Inject tenant context
    app.use((req: any, _res: any, next: any) => {
      req.tenantContext = tenantContext;
      next();
    });
    app.use('/api/indexes/:indexId/query-history', queryHistoryRouter);
  });

  test('returns paginated query history (happy path)', async () => {
    const mockRows = [
      {
        query_id: 'q-1',
        tenant_id: 'tenant-1',
        project_id: 'proj-1',
        session_id: '',
        index_id: 'idx-1',
        user_id: 'tenant-1',
        query_type: 'hybrid',
        query_text: 'test query',
        result_count: '5',
        total_latency_ms: '120',
        vocabulary_resolve_ms: '30',
        vector_search_ms: '60',
        structured_filter_ms: '10',
        rerank_ms: '20',
        cache_hit: '0',
        timestamp: '2026-03-18 10:00:00.000',
        filters: '',
        vocabulary_terms: '',
        top_k: '20',
        feedback_score: '0',
        click_position: '-1',
      },
    ];

    // First call: count query
    mockChQuery.mockResolvedValueOnce({
      json: () => Promise.resolve([{ cnt: '1' }]),
    });
    // Second call: paginated results
    mockChQuery.mockResolvedValueOnce({
      json: () => Promise.resolve(mockRows),
    });

    const res = await request(app)
      .get('/api/indexes/idx-1/query-history')
      .query({ limit: 10, offset: 0 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.queries).toHaveLength(1);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.queries[0].query_id).toBe('q-1');
  });

  test('returns empty results when no data exists', async () => {
    mockChQuery.mockResolvedValueOnce({
      json: () => Promise.resolve([{ cnt: '0' }]),
    });
    mockChQuery.mockResolvedValueOnce({
      json: () => Promise.resolve([]),
    });

    const res = await request(app)
      .get('/api/indexes/idx-1/query-history')
      .query({ limit: 20, offset: 0 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.queries).toHaveLength(0);
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.hasMore).toBe(false);
  });

  test('degrades gracefully when ClickHouse connection fails', async () => {
    mockChQuery.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await request(app)
      .get('/api/indexes/idx-1/query-history')
      .query({ limit: 20, offset: 0 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.queries).toHaveLength(0);
    expect(res.body.data.total).toBe(0);
  });

  test('returns 500 for non-connection ClickHouse errors', async () => {
    mockChQuery.mockRejectedValueOnce(new Error('Syntax error in SQL'));

    const res = await request(app)
      .get('/api/indexes/idx-1/query-history')
      .query({ limit: 20, offset: 0 });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('QUERY_HISTORY_ERROR');
  });

  test('returns 401 when tenant context is missing', async () => {
    // Create app without tenant context
    const noAuthApp = express();
    noAuthApp.use(express.json());
    noAuthApp.use('/api/indexes/:indexId/query-history', queryHistoryRouter);

    const res = await request(noAuthApp)
      .get('/api/indexes/idx-1/query-history')
      .query({ limit: 20 });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('returns 404 before ClickHouse access when index is outside project scope', async () => {
    tenantContext.projectScope = ['project-allowed'];
    mockSearchIndexFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    });

    const res = await request(app).get('/api/indexes/idx-cross/query-history').query({ limit: 20 });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INDEX_NOT_FOUND');
    expect(mockSearchIndexFindOne).toHaveBeenCalledWith({
      _id: 'idx-cross',
      tenantId: 'tenant-1',
      projectId: { $in: ['project-allowed'] },
    });
    expect(mockChQuery).not.toHaveBeenCalled();
  });

  test('validates limit bounds', async () => {
    const res = await request(app).get('/api/indexes/idx-1/query-history').query({ limit: 200 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('supports date range filtering via from/to', async () => {
    mockChQuery.mockResolvedValueOnce({
      json: () => Promise.resolve([{ cnt: '0' }]),
    });
    mockChQuery.mockResolvedValueOnce({
      json: () => Promise.resolve([]),
    });

    const res = await request(app).get('/api/indexes/idx-1/query-history').query({
      limit: 10,
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-18T23:59:59Z',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify the count query included date filters
    const countCall = mockChQuery.mock.calls[0];
    expect(countCall[0].query).toContain('timestamp >= {from:DateTime64(3)}');
    expect(countCall[0].query).toContain('timestamp <= {to:DateTime64(3)}');
  });

  test('computes hasMore correctly', async () => {
    mockChQuery.mockResolvedValueOnce({
      json: () => Promise.resolve([{ cnt: '25' }]),
    });
    mockChQuery.mockResolvedValueOnce({
      json: () => Promise.resolve(Array(10).fill({ query_id: 'q', query_text: 'test' })),
    });

    const res = await request(app)
      .get('/api/indexes/idx-1/query-history')
      .query({ limit: 10, offset: 0 });

    expect(res.status).toBe(200);
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.total).toBe(25);
  });
});
