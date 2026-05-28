import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { injectTenantContext, makeTenantContext } from '../helpers/auth-context.js';

const mockRequireProjectPermission = vi.fn();
const mockRequireProjectWideAnalyticsAccess = vi.fn();
const mockResolveProjectSessionAccess = vi.fn();
const mockQuery = vi.fn();
const mockAggregate = vi.fn();
const mockCount = vi.fn();
const mockGetCostBreakdown = vi.fn();
const mockGetSessionMetrics = vi.fn();
const mockGetEventCounts = vi.fn();
const mockClickHouseQuery = vi.fn();
const mockListRuntimeSessions = vi.fn();
const mockGetRuntimeSession = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requireAuth: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  getRequestAccessDeniedReporter: vi.fn(() => vi.fn()),
  requireProjectScope: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: (...args: any[]) => mockRequireProjectPermission(...args),
  requireProjectWideAnalyticsAccess: (...args: any[]) =>
    mockRequireProjectWideAnalyticsAccess(...args),
}));

vi.mock('../../middleware/session-access.js', () => ({
  resolveProjectSessionAccess: (...args: any[]) => mockResolveProjectSessionAccess(...args),
}));

vi.mock('../../services/eventstore-singleton.js', () => ({
  getEventStore: vi.fn(() => ({
    queryService: {
      query: (...args: any[]) => mockQuery(...args),
      aggregate: (...args: any[]) => mockAggregate(...args),
      count: (...args: any[]) => mockCount(...args),
      getCostBreakdown: (...args: any[]) => mockGetCostBreakdown(...args),
      getSessionMetrics: (...args: any[]) => mockGetSessionMetrics(...args),
      getEventCounts: (...args: any[]) => mockGetEventCounts(...args),
    },
  })),
}));

vi.mock('@agent-platform/database/clickhouse', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getClickHouseClient: vi.fn(() => ({
    query: (...args: any[]) => mockClickHouseQuery(...args),
  })),
  toClickHouseDateTime: (date: Date) => date.toISOString().replace('T', ' ').replace('Z', ''),
}));

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: () => ({
    listSessions: (...args: any[]) => mockListRuntimeSessions(...args),
    getSession: (...args: any[]) => mockGetRuntimeSession(...args),
  }),
}));

vi.mock('../../services/stores/clickhouse-encryption-singleton.js', () => ({
  getClickHouseEncryptionInterceptor: vi.fn(() => null),
}));

const BASE = '/api/projects/proj-1/analytics';

async function createTestServer() {
  const app = express();
  app.use(express.json());

  const ctx = makeTenantContext('tenant-1', 'user-1', 'OWNER');
  app.use(injectTenantContext(ctx));

  const routerModule = await import('../../routes/analytics.js');
  app.use('/api/projects/:projectId/analytics', routerModule.default);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  opts?: { body?: Record<string, unknown> },
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

describe('Analytics Route', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    ({ baseUrl, server } = await createTestServer());
  });

  afterAll(() => server?.close());

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectPermission.mockResolvedValue(true);
    mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
    mockResolveProjectSessionAccess.mockResolvedValue({ session: { id: 'sess-1' } });
    mockQuery.mockResolvedValue({ events: [], total: 0, hasMore: false });
    mockAggregate.mockResolvedValue({ buckets: [] });
    mockCount.mockResolvedValue({ counts: [] });
    mockGetCostBreakdown.mockResolvedValue([]);
    mockGetSessionMetrics.mockResolvedValue({
      totalSessions: 0,
      completedSessions: 0,
      completionRate: 0,
      avgDurationMs: 0,
      avgCost: 0,
    });
    mockGetEventCounts.mockResolvedValue({ counts: [] });
    mockClickHouseQuery.mockImplementation((args: { format?: string }) => {
      if (args.format === 'JSONCompactEachRowWithNames') {
        return {
          text: vi.fn().mockResolvedValue('["event_type"]\n["session.started"]\n'),
        };
      }

      return {
        json: vi.fn().mockResolvedValue([]),
      };
    });
    mockListRuntimeSessions.mockReturnValue([]);
    mockGetRuntimeSession.mockReturnValue(undefined);
  });

  test('POST /query uses exact-session access for session-scoped queries', async () => {
    const { status, body } = await request(baseUrl, 'POST', `${BASE}/query`, {
      body: {
        timeRange: {
          from: '2026-03-20T00:00:00.000Z',
          to: '2026-03-21T00:00:00.000Z',
        },
        sessionId: 'sess-1',
        limit: 25,
        offset: 5,
      },
    });

    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { events: [], total: 0, hasMore: false },
    });
    expect(mockResolveProjectSessionAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ projectId: 'proj-1' }),
      }),
      {
        sessionId: 'sess-1',
        projectId: 'proj-1',
        requiredPermission: 'session:read',
      },
    );
    expect(mockRequireProjectPermission).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        sessionId: 'sess-1',
        limit: 25,
        offset: 5,
      }),
    );
  });

  test('POST /query returns the concealment envelope when session access is denied', async () => {
    mockResolveProjectSessionAccess.mockResolvedValueOnce({
      denial: {
        statusCode: 404,
        publicError: 'Session not found',
      },
    });

    const { status, body } = await request(baseUrl, 'POST', `${BASE}/query`, {
      body: {
        timeRange: {
          from: '2026-03-20T00:00:00.000Z',
          to: '2026-03-21T00:00:00.000Z',
        },
        sessionId: 'sess-foreign',
      },
    });

    expect(status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: { code: 'ACCESS_DENIED', message: 'Session not found' },
    });
    expect(mockRequireProjectPermission).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('POST /query requires project-wide analytics access when no sessionId is supplied', async () => {
    const { status } = await request(baseUrl, 'POST', `${BASE}/query`, {
      body: {
        timeRange: {
          from: '2026-03-20T00:00:00.000Z',
          to: '2026-03-21T00:00:00.000Z',
        },
        category: 'session',
      },
    });

    expect(status).toBe(200);
    expect(mockResolveProjectSessionAccess).not.toHaveBeenCalled();
    expect(mockRequireProjectPermission).not.toHaveBeenCalled();
    expect(mockRequireProjectWideAnalyticsAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ projectId: 'proj-1' }),
      }),
      expect.anything(),
    );
  });

  test('GET /events requires project-wide analytics access when no sessionId is supplied', async () => {
    const { status } = await request(baseUrl, 'GET', `${BASE}/events`);

    expect(status).toBe(200);
    expect(mockResolveProjectSessionAccess).not.toHaveBeenCalled();
    expect(mockRequireProjectPermission).not.toHaveBeenCalled();
    expect(mockRequireProjectWideAnalyticsAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ projectId: 'proj-1' }),
      }),
      expect.anything(),
    );
  });

  test.each([
    ['GET', `${BASE}/metrics`],
    ['GET', `${BASE}/sessions`],
    ['GET', `${BASE}/generations`],
    ['GET', `${BASE}/flush-status`],
    ['GET', `${BASE}/agents/agent-1`],
    ['GET', `${BASE}/cost-breakdown`],
    ['GET', `${BASE}/session-metrics`],
    ['GET', `${BASE}/event-counts`],
  ])('%s %s requires project-wide analytics access', async (method: string, path: string) => {
    const { status } = await request(baseUrl, method, path);

    expect(status).toBe(200);
    expect(mockRequireProjectPermission).not.toHaveBeenCalled();
    expect(mockRequireProjectWideAnalyticsAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ projectId: 'proj-1' }),
      }),
      expect.anything(),
    );
  });

  test('GET /metrics rejects unsupported groupBy dimensions before aggregation', async () => {
    const { status, body } = await request(baseUrl, 'GET', `${BASE}/metrics?groupBy=category,foo`);

    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid groupBy parameter' },
    });
    expect(mockAggregate).not.toHaveBeenCalled();
  });

  test('GET /metrics rejects unsupported metric names before aggregation', async () => {
    const { status, body } = await request(baseUrl, 'GET', `${BASE}/metrics?metrics=count,raw_sql`);

    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid metrics parameter' },
    });
    expect(mockAggregate).not.toHaveBeenCalled();
  });

  test('GET /metrics accepts typed data dimensions and categories', async () => {
    const { status } = await request(
      baseUrl,
      'GET',
      `${BASE}/metrics?groupBy=data_model,data_provider&metrics=count,sum_tokens&category=billing`,
    );

    expect(status).toBe(200);
    expect(mockAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        groupBy: ['data_model', 'data_provider'],
        metrics: ['count', 'sum_tokens'],
        filters: { category: 'billing' },
      }),
    );
  });

  test('POST /aggregate requires project-wide analytics access', async () => {
    const { status } = await request(baseUrl, 'POST', `${BASE}/aggregate`, {
      body: {
        timeRange: {
          from: '2026-03-20T00:00:00.000Z',
          to: '2026-03-21T00:00:00.000Z',
        },
        groupBy: ['category'],
        metrics: ['count'],
      },
    });

    expect(status).toBe(200);
    expect(mockRequireProjectPermission).not.toHaveBeenCalled();
    expect(mockRequireProjectWideAnalyticsAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ projectId: 'proj-1' }),
      }),
      expect.anything(),
    );
  });

  test('GET /metrics uses llm_metrics for LLM latency time series', async () => {
    mockClickHouseQuery.mockImplementation((args: { query: string }) => {
      if (args.query.includes('FROM abl_platform.llm_metrics')) {
        return {
          json: vi.fn().mockResolvedValue([
            {
              bucket: '2026-04-20 00:00:00.000',
              count: '4',
              avg_duration: '125.5',
              p95_duration: '250',
              sum_tokens: '420',
              sum_cost: '1.25',
            },
          ]),
        };
      }

      return { json: vi.fn().mockResolvedValue([]) };
    });

    const { status, body } = await request(
      baseUrl,
      'GET',
      `${BASE}/metrics?from=2026-04-20T00:00:00.000Z&to=2026-04-20T03:00:00.000Z&groupBy=hour&metrics=count,avg_duration,p95_duration,sum_tokens,sum_cost&category=llm`,
    );

    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        buckets: [
          {
            hour: '2026-04-20T00:00:00.000Z',
            count: 4,
            avg_duration: 125.5,
            p95_duration: 250,
            sum_tokens: 420,
            sum_cost: 1.25,
          },
        ],
      },
    });
    expect(mockAggregate).not.toHaveBeenCalled();
    const queryArg = mockClickHouseQuery.mock.calls[0]?.[0] as {
      query: string;
      query_params: Record<string, unknown>;
    };
    expect(queryArg.query).toContain('avg(latency_ms) AS avg_duration');
    expect(queryArg.query).toContain('quantile(0.95)(latency_ms) AS p95_duration');
    expect(queryArg.query_params).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        from: '2026-04-20 00:00:00.000',
        to: '2026-04-20 03:00:00.000',
      }),
    );
  });

  test('GET /cost-breakdown returns project-scoped ClickHouse llm_metrics aggregation', async () => {
    mockClickHouseQuery.mockImplementation((args: { query: string }) => {
      if (args.query.includes('model_id AS model') && args.query.includes('llm_metrics')) {
        return {
          json: vi.fn().mockResolvedValue([
            {
              model: 'gpt-5.4',
              provider: 'openai',
              callCount: '4',
              totalTokens: '420',
              totalCost: '1.25',
            },
          ]),
        };
      }

      return { json: vi.fn().mockResolvedValue([]) };
    });

    const { status, body } = await request(
      baseUrl,
      'GET',
      `${BASE}/cost-breakdown?from=2026-04-20T00:00:00.000Z&to=2026-04-20T03:00:00.000Z`,
    );

    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: [
        {
          model: 'gpt-5.4',
          provider: 'openai',
          callCount: 4,
          totalTokens: 420,
          totalCost: 1.25,
        },
      ],
    });
    expect(mockGetCostBreakdown).not.toHaveBeenCalled();
    const queryArg = mockClickHouseQuery.mock.calls[0]?.[0] as {
      query: string;
      query_params: Record<string, unknown>;
    };
    expect(queryArg.query).toContain('FROM abl_platform.llm_metrics');
    expect(queryArg.query).toContain('tenant_id = {tenantId:String}');
    expect(queryArg.query).toContain('project_id = {projectId:String}');
    expect(queryArg.query_params).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        from: '2026-04-20 00:00:00.000',
        to: '2026-04-20 03:00:00.000',
      }),
    );
  });

  test('GET /metrics propagates project-wide analytics denials', async () => {
    mockRequireProjectWideAnalyticsAccess.mockImplementationOnce((_req, res) => {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return Promise.resolve(false);
    });

    const { status, body } = await request(baseUrl, 'GET', `${BASE}/metrics`);

    expect(status).toBe(403);
    expect(body).toEqual({ success: false, error: 'Forbidden' });
  });

  test('POST /sql-query rejects queries that omit the project_id filter', async () => {
    const { status, body } = await request(baseUrl, 'POST', `${BASE}/sql-query`, {
      body: {
        sql: `SELECT event_type FROM abl_platform.platform_events WHERE tenant_id = {tenantId:String}`,
      },
    });

    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('project_id') },
    });
    expect(mockRequireProjectWideAnalyticsAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ projectId: 'proj-1' }),
      }),
      expect.anything(),
    );
    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });

  test('POST /sql-query rejects project filter tokens hidden inside comments', async () => {
    const { status, body } = await request(baseUrl, 'POST', `${BASE}/sql-query`, {
      body: {
        sql: `SELECT event_type FROM abl_platform.platform_events /* tenant_id = {tenantId:String} AND project_id = {projectId:String} */`,
      },
    });

    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('comments') },
    });
    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });

  test('POST /sql-query rejects queries that reference additional tables via joins', async () => {
    const { status, body } = await request(baseUrl, 'POST', `${BASE}/sql-query`, {
      body: {
        sql: `SELECT s.name FROM system.tables AS s CROSS JOIN abl_platform.platform_events AS e WHERE e.tenant_id = {tenantId:String} AND e.project_id = {projectId:String}`,
      },
    });

    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('single analytics table'),
      },
    });
    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });

  test.each([
    'abl_platform.llm_metrics',
    'abl_platform.llm_metrics_hourly_dest',
    'abl_platform.llm_metrics_daily_dest',
    'abl_platform.platform_events_by_session',
    'abl_platform.platform_events_agent_hourly_dest',
    'abl_platform.platform_events_tool_daily_dest',
    'abl_platform.platform_events_error_hourly_dest',
    'abl_platform.platform_events_voice_hourly_dest',
    'abl_platform.audit_events',
    'abl_platform.search_queries',
    'abl_platform.spatial_trace_records',
    'abl_platform.insight_results',
    'abl_platform.custom_pipeline_results',
    'abl_platform.messages',
  ])('POST /sql-query accepts the extended analytics allowlist: %s', async (table: string) => {
    const { status } = await request(baseUrl, 'POST', `${BASE}/sql-query`, {
      body: {
        sql: `SELECT count() AS cnt FROM ${table} WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String}`,
      },
    });

    expect(status).toBe(200);
    expect(mockClickHouseQuery).toHaveBeenCalledTimes(1);
    const queryArg = mockClickHouseQuery.mock.calls[0]?.[0] as { query: string };
    expect(queryArg.query).toContain(`FROM ${table}`);
  });

  test('POST /sql-query still rejects tables outside the allowlist', async () => {
    const { status, body } = await request(baseUrl, 'POST', `${BASE}/sql-query`, {
      body: {
        sql: `SELECT * FROM abl_platform.kms_audit_log WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String}`,
      },
    });

    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('single analytics table'),
      },
    });
    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });

  test('GET /tables includes messages and custom_pipeline_results in allowlist', async () => {
    const { status, body } = await request(baseUrl, 'GET', `${BASE}/tables`);

    expect(status).toBe(200);
    const tableNames: string[] = body.data.tables.map((t: { name: string }) => t.name);
    expect(tableNames).toContain('abl_platform.messages');
    expect(tableNames).toContain('abl_platform.custom_pipeline_results');
  });

  test('POST /sql-query accepts messages table with project_id filter', async () => {
    const { status } = await request(baseUrl, 'POST', `${BASE}/sql-query`, {
      body: {
        sql: `SELECT created_at, role, content FROM abl_platform.messages WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String} LIMIT 50`,
      },
    });

    expect(status).toBe(200);
    expect(mockClickHouseQuery).toHaveBeenCalledTimes(1);
    const queryArg = mockClickHouseQuery.mock.calls[0]?.[0] as { query: string };
    expect(queryArg.query).toContain('FROM abl_platform.messages');
  });

  test('POST /sql-query accepts custom_pipeline_results table', async () => {
    const { status } = await request(baseUrl, 'POST', `${BASE}/sql-query`, {
      body: {
        sql: `SELECT pipeline_name, score_name, score_value FROM abl_platform.custom_pipeline_results WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String} LIMIT 50`,
      },
    });

    expect(status).toBe(200);
    expect(mockClickHouseQuery).toHaveBeenCalledTimes(1);
    const queryArg = mockClickHouseQuery.mock.calls[0]?.[0] as { query: string };
    expect(queryArg.query).toContain('FROM abl_platform.custom_pipeline_results');
  });

  test('POST /sql-query clamps a user-supplied LIMIT above the row cap', async () => {
    const { status } = await request(baseUrl, 'POST', `${BASE}/sql-query`, {
      body: {
        sql: `SELECT event_type FROM abl_platform.platform_events WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String} LIMIT 999999`,
      },
    });

    expect(status).toBe(200);
    expect(mockClickHouseQuery).toHaveBeenCalledTimes(1);
    const queryArg = mockClickHouseQuery.mock.calls[0]?.[0] as { query: string };
    expect(queryArg.query).toMatch(/LIMIT\s+1000\b/);
    expect(queryArg.query).not.toMatch(/LIMIT\s+999999/);
  });

  test('POST /sql-query preserves a user-supplied LIMIT below the row cap', async () => {
    const { status } = await request(baseUrl, 'POST', `${BASE}/sql-query`, {
      body: {
        sql: `SELECT event_type FROM abl_platform.platform_events WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String} LIMIT 50`,
      },
    });

    expect(status).toBe(200);
    const queryArg = mockClickHouseQuery.mock.calls[0]?.[0] as { query: string };
    expect(queryArg.query).toMatch(/LIMIT\s+50\b/);
  });

  test('POST /sql-query injects the row cap when the user omits LIMIT', async () => {
    const { status } = await request(baseUrl, 'POST', `${BASE}/sql-query`, {
      body: {
        sql: `SELECT event_type FROM abl_platform.platform_events WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String}`,
      },
    });

    expect(status).toBe(200);
    const queryArg = mockClickHouseQuery.mock.calls[0]?.[0] as { query: string };
    expect(queryArg.query).toMatch(/LIMIT\s+1000\b/);
  });

  test('POST /sql-query always attaches the max_result_rows safety net', async () => {
    await request(baseUrl, 'POST', `${BASE}/sql-query`, {
      body: {
        sql: `SELECT event_type FROM abl_platform.platform_events WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String} LIMIT 10`,
      },
    });

    const queryArg = mockClickHouseQuery.mock.calls[0]?.[0] as { query: string };
    expect(queryArg.query).toMatch(/max_result_rows\s*=\s*1000/);
    expect(queryArg.query).toMatch(/result_overflow_mode\s*=\s*'break'/);
    expect(queryArg.query).toMatch(/max_execution_time\s*=\s*10/);
  });

  test('POST /sql-query binds the selected analytics time range for query placeholders', async () => {
    const { status } = await request(baseUrl, 'POST', `${BASE}/sql-query`, {
      body: {
        sql: `SELECT event_type FROM abl_platform.platform_events WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String} AND timestamp >= {from:DateTime64(3)} AND timestamp <= {to:DateTime64(3)} LIMIT 10`,
        timeRange: {
          from: '2026-04-20T00:00:00.000Z',
          to: '2026-04-20T03:00:00.000Z',
        },
      },
    });

    expect(status).toBe(200);
    expect(mockClickHouseQuery).toHaveBeenCalledTimes(1);
    const queryArg = mockClickHouseQuery.mock.calls[0]?.[0] as {
      query_params: Record<string, unknown>;
    };
    expect(queryArg.query_params).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        from: '2026-04-20 00:00:00.000',
        to: '2026-04-20 03:00:00.000',
      }),
    );
  });

  test('POST /sql-query rejects invalid selected time ranges before execution', async () => {
    const { status, body } = await request(baseUrl, 'POST', `${BASE}/sql-query`, {
      body: {
        sql: `SELECT event_type FROM abl_platform.platform_events WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String} LIMIT 10`,
        timeRange: {
          from: '2026-04-20T03:00:00.000Z',
          to: '2026-04-20T03:00:00.000Z',
        },
      },
    });

    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid query time range' },
    });
    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });

  test('GET /tables returns the analytics allowlist with the row cap', async () => {
    const { status, body } = await request(baseUrl, 'GET', `${BASE}/tables`);

    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        tables: expect.arrayContaining([
          expect.objectContaining({
            name: 'abl_platform.platform_events',
            description: expect.any(String),
          }),
          expect.objectContaining({
            name: 'abl_platform.llm_metrics',
            description: expect.any(String),
          }),
          expect.objectContaining({
            name: 'abl_platform.audit_events',
            description: expect.any(String),
          }),
        ]),
        maxRows: 1000,
      },
    });
    expect(mockRequireProjectWideAnalyticsAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ projectId: 'proj-1' }),
      }),
      expect.anything(),
    );
  });

  test('GET /tables enforces project-wide analytics access', async () => {
    mockRequireProjectWideAnalyticsAccess.mockImplementationOnce((_req, res) => {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return Promise.resolve(false);
    });

    const { status } = await request(baseUrl, 'GET', `${BASE}/tables`);

    expect(status).toBe(403);
  });

  test('GET /sessions returns ClickHouse-backed session summaries', async () => {
    mockClickHouseQuery.mockImplementation((args: { query: string }) => {
      if (args.query.includes('uniqExact(session_id) AS total')) {
        return { json: vi.fn().mockResolvedValue([{ total: '2' }]) };
      }

      if (
        args.query.includes("countIf(category = 'message' OR event_type = 'voice.turn.completed')")
      ) {
        return {
          json: vi.fn().mockResolvedValue([
            {
              sessionId: 'sess-active',
              firstSeenAt: '2026-04-20 09:00:00.000',
              lastSeenAt: '2026-04-20 09:02:00.000',
              traceEventCount: '6',
              messageCount: '3',
              errorCount: '0',
              latestAgentName: 'Planner',
              latestChannel: 'web_chat',
              latestDeploymentId: 'dep-1',
            },
            {
              sessionId: 'sess-ended',
              firstSeenAt: '2026-04-20 08:00:00.000',
              lastSeenAt: '2026-04-20 08:10:00.000',
              traceEventCount: '9',
              messageCount: '4',
              errorCount: '1',
              latestAgentName: 'Escalator',
              latestChannel: 'voice',
              latestDeploymentId: 'dep-2',
            },
          ]),
        };
      }

      if (args.query.includes('event_type IN ({eventTypes:Array(String)})')) {
        return {
          json: vi.fn().mockResolvedValue([
            {
              tenant_id: 'tenant-1',
              sessionId: 'sess-active',
              eventType: 'session.started',
              timestamp: '2026-04-20 09:00:00.000',
              agentName: 'Planner',
              channel: 'web_chat',
              deploymentId: 'dep-1',
              data: JSON.stringify({ agentName: 'Planner', channel: 'web_chat' }),
            },
            {
              tenant_id: 'tenant-1',
              sessionId: 'sess-ended',
              eventType: 'session.started',
              timestamp: '2026-04-20 08:00:00.000',
              agentName: 'Escalator',
              channel: 'voice',
              deploymentId: 'dep-2',
              data: JSON.stringify({ agentName: 'Escalator', channel: 'voice' }),
            },
            {
              tenant_id: 'tenant-1',
              sessionId: 'sess-ended',
              eventType: 'session.ended',
              timestamp: '2026-04-20 08:10:00.000',
              agentName: 'Escalator',
              channel: 'voice',
              deploymentId: 'dep-2',
              data: JSON.stringify({
                status: 'escalated',
                disposition: 'transferred',
                totalDurationMs: 2400,
              }),
            },
          ]),
        };
      }

      if (args.query.includes('sum(input_tokens) AS inputTokens')) {
        return {
          json: vi.fn().mockResolvedValue([
            {
              sessionId: 'sess-active',
              inputTokens: '12',
              outputTokens: '8',
              tokenCount: '20',
              estimatedCost: '0.5',
            },
            {
              sessionId: 'sess-ended',
              inputTokens: '30',
              outputTokens: '12',
              tokenCount: '42',
              estimatedCost: '1.25',
            },
          ]),
        };
      }

      return { json: vi.fn().mockResolvedValue([]) };
    });

    const { status, body } = await request(
      baseUrl,
      'GET',
      `${BASE}/sessions?from=2026-04-20T00:00:00.000Z&to=2026-04-21T00:00:00.000Z`,
    );

    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        total: 2,
        limit: 1000,
        offset: 0,
        sessions: [
          {
            id: 'sess-active',
            agentId: 'Planner',
            agentName: 'Planner',
            status: 'active',
            durationMs: 120000,
            messageCount: 3,
            traceEventCount: 6,
            tokenCount: 20,
            estimatedCost: 0.5,
            errorCount: 0,
            disposition: null,
            channel: 'web_chat',
            channelType: 'web_chat',
            createdAt: '2026-04-20T09:00:00.000Z',
            lastActivityAt: '2026-04-20T09:02:00.000Z',
            inputTokens: 12,
            outputTokens: 8,
            source: 'clickhouse',
          },
          {
            id: 'sess-ended',
            agentId: 'Escalator',
            agentName: 'Escalator',
            status: 'escalated',
            durationMs: 2400,
            messageCount: 4,
            traceEventCount: 9,
            tokenCount: 42,
            estimatedCost: 1.25,
            errorCount: 1,
            disposition: 'transferred',
            channel: 'voice',
            channelType: 'voice',
            createdAt: '2026-04-20T08:00:00.000Z',
            lastActivityAt: '2026-04-20T08:10:00.000Z',
            inputTokens: 30,
            outputTokens: 12,
            source: 'clickhouse',
          },
        ],
      },
    });
    expect(mockRequireProjectPermission).not.toHaveBeenCalled();
  });

  test.each([
    {
      knownSource: 'production',
      expectedSql: "AND known_source = 'production'",
      expectedParams: {},
    },
    {
      knownSource: 'eval',
      expectedSql: 'AND known_source IN ({ks_0:String})',
      expectedParams: { ks_0: 'eval' },
    },
    {
      knownSource: 'synthetic',
      expectedSql: 'AND known_source IN ({ks_0:String})',
      expectedParams: { ks_0: 'synthetic' },
    },
  ])(
    'GET /sessions aggregates $knownSource sessions through known_source column',
    async ({ knownSource, expectedSql, expectedParams }) => {
      mockClickHouseQuery.mockImplementation((args: { query: string }) => {
        if (args.query.includes('uniqExact(session_id) AS total')) {
          return { json: vi.fn().mockResolvedValue([{ total: '1' }]) };
        }

        if (
          args.query.includes(
            "countIf(category = 'message' OR event_type = 'voice.turn.completed')",
          )
        ) {
          return {
            json: vi.fn().mockResolvedValue([
              {
                sessionId: `sess-${knownSource}`,
                firstSeenAt: '2026-05-11 09:00:00.000',
                lastSeenAt: '2026-05-11 09:02:00.000',
                traceEventCount: '5',
                messageCount: '2',
                errorCount: '0',
                latestAgentName: 'Planner',
                latestChannel: 'web_chat',
                latestDeploymentId: 'dep-1',
              },
            ]),
          };
        }

        if (args.query.includes('event_type IN ({eventTypes:Array(String)})')) {
          return {
            json: vi.fn().mockResolvedValue([
              {
                tenant_id: 'tenant-1',
                sessionId: `sess-${knownSource}`,
                eventType: 'session.started',
                timestamp: '2026-05-11 09:00:00.000',
                agentName: 'Planner',
                channel: 'web_chat',
                deploymentId: 'dep-1',
                data: JSON.stringify({ agentName: 'Planner', channel: 'web_chat' }),
              },
            ]),
          };
        }

        if (args.query.includes('sum(input_tokens) AS inputTokens')) {
          return {
            json: vi.fn().mockResolvedValue([
              {
                sessionId: `sess-${knownSource}`,
                inputTokens: '10',
                outputTokens: '7',
                tokenCount: '17',
                estimatedCost: '0.25',
              },
            ]),
          };
        }

        return { json: vi.fn().mockResolvedValue([]) };
      });

      const { status, body } = await request(
        baseUrl,
        'GET',
        `${BASE}/sessions?knownSource=${knownSource}&from=2026-05-11T00:00:00.000Z&to=2026-05-12T00:00:00.000Z`,
      );

      expect(status).toBe(200);
      expect(body.data.total).toBe(1);
      expect(body.data.sessions[0]).toMatchObject({
        id: `sess-${knownSource}`,
        messageCount: 2,
        traceEventCount: 5,
        tokenCount: 17,
        estimatedCost: 0.25,
      });

      const sessionAggregationQueries = mockClickHouseQuery.mock.calls
        .map(([args]) => args as { query: string; query_params?: Record<string, unknown> })
        .filter((args) => args.query.includes('FROM abl_platform.platform_events_by_session'))
        .filter(
          (args) =>
            args.query.includes('uniqExact(session_id) AS total') ||
            args.query.includes(
              "countIf(category = 'message' OR event_type = 'voice.turn.completed')",
            ),
        );

      expect(sessionAggregationQueries).toHaveLength(2);
      for (const args of sessionAggregationQueries) {
        expect(args.query).toContain(expectedSql);
        expect(args.query).not.toContain("custom_dimensions['known_source']");
        expect(args.query_params).toMatchObject(expectedParams);
      }
    },
  );

  test('GET /generations returns ClickHouse-backed llm_metrics rows', async () => {
    mockClickHouseQuery.mockImplementation((args: { query: string }) => {
      if (args.query.includes('SELECT count() AS total') && args.query.includes('llm_metrics')) {
        return { json: vi.fn().mockResolvedValue([{ total: '1' }]) };
      }

      if (args.query.includes('operation_type AS operationType')) {
        return {
          json: vi.fn().mockResolvedValue([
            {
              sessionId: 'sess-1',
              modelId: 'gpt-5.4',
              provider: 'openai',
              operationType: 'chat_completion',
              agentName: '',
              inputTokens: '120',
              outputTokens: '45',
              totalTokens: '165',
              estimatedCost: '0.18',
              latencyMs: '820',
              timestamp: '2026-04-20 12:00:00.000',
            },
          ]),
        };
      }

      return { json: vi.fn().mockResolvedValue([]) };
    });

    const { status, body } = await request(
      baseUrl,
      'GET',
      `${BASE}/generations?from=2026-04-20T00:00:00.000Z&to=2026-04-21T00:00:00.000Z`,
    );

    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        total: 1,
        limit: 1000,
        offset: 0,
        generations: [
          {
            id: 'sess-1:2026-04-20T12:00:00.000Z:gpt-5.4:openai:120:45:820',
            model: 'gpt-5.4',
            name: 'chat_completion',
            provider: 'openai',
            tokensIn: 120,
            tokensOut: 45,
            totalTokens: 165,
            latencyMs: 820,
            cost: 0.18,
            timestamp: '2026-04-20T12:00:00.000Z',
            sessionId: 'sess-1',
          },
        ],
      },
    });
  });

  test('GET /cost-breakdown returns project-scoped ClickHouse llm_metrics aggregation', async () => {
    mockClickHouseQuery.mockImplementation((args: { query: string }) => {
      if (args.query.includes('model_id AS model') && args.query.includes('llm_metrics')) {
        return {
          json: vi.fn().mockResolvedValue([
            {
              model: 'gpt-5.4',
              provider: 'openai',
              callCount: '4',
              totalTokens: '420',
              totalCost: '1.25',
            },
          ]),
        };
      }

      return { json: vi.fn().mockResolvedValue([]) };
    });

    const { status, body } = await request(
      baseUrl,
      'GET',
      `${BASE}/cost-breakdown?from=2026-04-20T00:00:00.000Z&to=2026-04-20T03:00:00.000Z`,
    );

    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: [
        {
          model: 'gpt-5.4',
          provider: 'openai',
          callCount: 4,
          totalTokens: 420,
          totalCost: 1.25,
        },
      ],
    });
    const queryArg = mockClickHouseQuery.mock.calls[0]?.[0] as {
      query: string;
      query_params: Record<string, unknown>;
    };
    expect(queryArg.query).toContain('FROM abl_platform.llm_metrics');
    expect(queryArg.query).toContain('tenant_id = {tenantId:String}');
    expect(queryArg.query).toContain('project_id = {projectId:String}');
    expect(queryArg.query_params).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        from: '2026-04-20 00:00:00.000',
        to: '2026-04-20 03:00:00.000',
      }),
    );
  });

  test('GET /flush-status reports live sessions that are not yet visible in ClickHouse', async () => {
    mockListRuntimeSessions.mockReturnValue([
      {
        id: 'live-visible',
        agentName: 'Planner',
        messageCount: 2,
        createdAt: '2026-04-20T12:00:00.000Z',
        lastActivityAt: '2026-04-20T12:01:00.000Z',
        activeAgent: 'Planner',
        threadCount: 1,
      },
      {
        id: 'live-pending',
        agentName: 'Escalator',
        messageCount: 1,
        createdAt: '2026-04-20T12:02:00.000Z',
        lastActivityAt: '2026-04-20T12:03:00.000Z',
        activeAgent: 'Escalator',
        threadCount: 1,
      },
    ]);
    mockGetRuntimeSession.mockImplementation((id: string) => ({
      id,
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    }));
    mockClickHouseQuery.mockImplementation((args: { query: string }) => {
      if (args.query.includes('DISTINCT session_id AS sessionId')) {
        return {
          json: vi.fn().mockResolvedValue([{ sessionId: 'live-visible' }]),
        };
      }

      return { json: vi.fn().mockResolvedValue([]) };
    });

    const { status, body } = await request(baseUrl, 'GET', `${BASE}/flush-status`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.liveSessionCount).toBe(2);
    expect(body.data.visibleLiveSessionCount).toBe(1);
    expect(body.data.unflushedLiveSessionCount).toBe(1);
    expect(body.data.pendingSessionIds).toEqual(['live-pending']);
  });
});
