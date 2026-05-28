import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { injectTenantContext, makeTenantContext } from '../helpers/auth-context.js';
import { enrichBlankAgentRows } from '../../routes/pipeline-analytics.js';

const mockRequireProjectPermission = vi.fn();
const mockRequireProjectWideAnalyticsAccess = vi.fn();
const mockResolveProjectSessionAccess = vi.fn();
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();
const mockClickHouseQuery = vi.fn();
const mockSessionFind = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@agent-platform/shared-auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireAuth: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  getRequestAccessDeniedReporter: vi.fn(() => vi.fn()),
  requireProjectScope: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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

vi.mock('@agent-platform/pipeline-engine', () => ({
  AnalyticsCache: class AnalyticsCache {
    constructor(_client: unknown) {}

    get(...args: any[]) {
      return mockCacheGet(...args);
    }

    set(...args: any[]) {
      return mockCacheSet(...args);
    }
  },
}));

vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: vi.fn(() => null),
  getRedisHandle: () => null,
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: vi.fn(() => ({
    query: (...args: any[]) => mockClickHouseQuery(...args),
  })),
}));

vi.mock('@agent-platform/database/models', () => ({
  Session: {
    find: (...args: any[]) => mockSessionFind(...args),
  },
}));

const BASE = '/api/projects/proj-1/pipeline-analytics';

async function createTestServer() {
  const app = express();
  app.use(express.json());

  const ctx = makeTenantContext('tenant-1', 'user-1', 'OWNER');
  app.use(injectTenantContext(ctx));

  const routerModule = await import('../../routes/pipeline-analytics.js');
  app.use('/api/projects/:projectId/pipeline-analytics', routerModule.default);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

async function request(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

describe('Pipeline Analytics Route', () => {
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
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockClickHouseQuery
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ total_conversations: 1, avg_sentiment: 0.4 }]),
      })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ total: 1 }]),
      })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ session_id: 'sess-1', avg_sentiment: 0.4 }]),
      });
  });

  test.each([
    `${BASE}/sentiment_analysis/summary`,
    `${BASE}/sentiment_analysis/breakdown`,
    `${BASE}/sentiment_analysis/conversations`,
    `${BASE}/sentiment_analysis/timeseries`,
  ])('requires project-wide analytics access for %s', async (path) => {
    const { status } = await request(baseUrl, path);

    expect(status).toBe(200);
    expect(mockRequireProjectPermission).not.toHaveBeenCalled();
    expect(mockRequireProjectWideAnalyticsAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ projectId: 'proj-1' }),
      }),
      expect.anything(),
    );
  });

  test('uses exact-session access for single conversation detail', async () => {
    const { status } = await request(baseUrl, `${BASE}/sentiment_analysis/conversation/sess-1`);

    expect(status).toBe(200);
    expect(mockResolveProjectSessionAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          projectId: 'proj-1',
          sessionId: 'sess-1',
        }),
      }),
      {
        sessionId: 'sess-1',
        projectId: 'proj-1',
        requiredPermission: 'session:read',
      },
    );
    expect(mockRequireProjectWideAnalyticsAccess).not.toHaveBeenCalled();
  });

  // ── ClickHouse JSON format handling (summary) ──────────────────────────

  describe('summary endpoint — ClickHouse JSON response formats', () => {
    test('handles ClickHouse object-wrapped format { meta, data: [...] }', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({
          meta: [{ name: 'total_conversations', type: 'UInt64' }],
          data: [{ total_conversations: 42, avg_overall_score: 3.8 }],
          rows: 1,
          statistics: { elapsed: 0.001 },
        }),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/quality_evaluation/summary?period=7d`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({ total_conversations: 42, avg_overall_score: 3.8 });
    });

    test('handles raw array format from ClickHouse', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ total_conversations: 10, avg_overall_score: 2.5 }]),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/quality_evaluation/summary?period=7d`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({ total_conversations: 10, avg_overall_score: 2.5 });
    });

    test('dedupes ReplacingMergeTree rows before quality summary aggregation', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ total_conversations: 10, avg_overall_score: 2.5 }]),
      });

      const { status } = await request(baseUrl, `${BASE}/quality_evaluation/summary?period=7d`);

      expect(status).toBe(200);
      const query = mockClickHouseQuery.mock.calls[0][0].query;
      expect(query).toContain('argMax(overall_score, processed_at) AS overall_score');
      expect(query).toContain('argMax(custom_dimensions, processed_at) AS custom_dimensions');
      expect(query).toContain('GROUP BY session_id');
      expect(query).toContain('avg(overall_score)');
      expect(query).toContain("JSONExtractKeysAndValues(custom_dimensions, 'Float64')");
      expect(query).toContain('_custom_dim_sums');
      expect(query).toContain('_custom_dim_counts');
      expect(query).not.toContain('SELECT toJSONString');
    });

    test('returns empty object when ClickHouse data array is empty', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({
          meta: [],
          data: [],
          rows: 0,
        }),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/quality_evaluation/summary?period=7d`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({});
    });

    test('deduplicates sentiment summary by latest row per session and caps period', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ total_conversations: 2, avg_sentiment: 0.3 }]),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/sentiment_analysis/summary?period=365d`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockClickHouseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('argMax(avg_sentiment, processed_at)'),
          query_params: expect.objectContaining({ days: 90 }),
        }),
      );
    });

    test('deduplicates intent summary metrics by latest row per session', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ total_conversations: 2, unique_intents: 2 }]),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/intent_classification/summary?period=30d`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockClickHouseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('argMax(intent, processed_at) AS intent'),
          query_params: expect.objectContaining({ days: 30 }),
        }),
      );
      expect(mockClickHouseQuery.mock.calls[0][0].query).toContain(
        "countIf(resolution_status != '') AS evaluated_count",
      );
    });
  });

  describe('breakdown endpoint — intent latest-row aggregation', () => {
    test('deduplicates intent breakdown by latest row per session', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ intent: 'billing', conversation_count: 2 }]),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/intent_classification/breakdown?period=30d&dimension=intent`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockClickHouseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('argMax(intent, processed_at) AS intent'),
          query_params: expect.objectContaining({ days: 30 }),
        }),
      );
      expect(mockClickHouseQuery.mock.calls[0][0].query).toContain('GROUP BY session_id');
      expect(mockClickHouseQuery.mock.calls[0][0].query).toContain('GROUP BY intent');
    });
  });

  // ── ClickHouse JSON format handling (timeseries) ───────────────────────

  describe('timeseries endpoint — ClickHouse JSON response formats', () => {
    test('handles ClickHouse object-wrapped format for timeseries', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({
          meta: [{ name: 'day', type: 'Date' }],
          data: [
            { day: '2024-01-01', conversation_count: 10, avg_overall_score: 3.5, flagged_count: 1 },
            { day: '2024-01-02', conversation_count: 15, avg_overall_score: 4.0, flagged_count: 0 },
          ],
          rows: 2,
        }),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/quality_evaluation/timeseries?period=7d`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0]).toEqual({
        day: '2024-01-01',
        conversation_count: 10,
        avg_overall_score: 3.5,
        flagged_count: 1,
      });

      const query = mockClickHouseQuery.mock.calls[0][0].query as string;
      expect(query).not.toContain('mv_daily_quality_scores');
      expect(query).toContain('FROM abl_platform.quality_evaluations FINAL');
      expect(query).toContain("AND (source = 'batch' OR source = '')");
    });

    test('handles raw array format for timeseries', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi
          .fn()
          .mockResolvedValue([
            { day: '2024-01-01', conversation_count: 5, avg_overall_score: 3.0, flagged_count: 2 },
          ]),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/quality_evaluation/timeseries?period=7d`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
    });

    test('returns empty array when no timeseries data', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({ meta: [], data: [], rows: 0 }),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/quality_evaluation/timeseries?period=7d`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    test('uses latest per-session raw sentiment rows for sentiment timeseries', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          {
            day: '2024-01-01',
            conversation_count: 2,
            avg_sentiment: 0.25,
            frustrated_count: 1,
          },
        ]),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/sentiment_analysis/timeseries?period=30d`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(mockClickHouseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('argMax(frustration_detected, processed_at)'),
          query_params: expect.objectContaining({ days: 30 }),
        }),
      );
      expect(mockClickHouseQuery.mock.calls[0][0].query).not.toContain('mv_daily_sentiment');
    });

    test('deduplicates intent timeseries by latest row per session', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          {
            day: '2024-01-01',
            conversation_count: 2,
            avg_confidence: 0.9,
            unique_intents: 2,
          },
        ]),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/intent_classification/timeseries?period=30d`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(mockClickHouseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('argMax(confidence, processed_at) AS confidence'),
          query_params: expect.objectContaining({ days: 30 }),
        }),
      );
      expect(mockClickHouseQuery.mock.calls[0][0].query).toContain('GROUP BY session_id');
      expect(mockClickHouseQuery.mock.calls[0][0].query).not.toContain(
        'mv_daily_intent_distribution',
      );
    });
  });

  describe('breakdown and conversations dedupe', () => {
    test('scopes raw quality-dimension timeseries to batch/session rows', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ day: '2024-01-01', conversation_count: 1 }]),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/hallucination_detection/timeseries?period=7d`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      const query = mockClickHouseQuery.mock.calls[0][0].query as string;
      expect(query).toContain("AND (source = 'batch' OR source = '')");
    });

    test('dedupes latest quality rows before agent breakdown aggregation', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ agent_name: 'Agent A', conversation_count: 1 }]),
      });

      const { status } = await request(
        baseUrl,
        `${BASE}/quality_evaluation/breakdown?period=7d&dimension=agent_name`,
      );

      expect(status).toBe(200);
      const query = mockClickHouseQuery.mock.calls[0][0].query;
      expect(query).toContain('argMax(agent_name, processed_at) AS agent_name');
      expect(query).toContain('GROUP BY session_id');
      expect(query).toContain('GROUP BY agent_name');
    });

    test('dedupes latest quality rows before paginated conversations and filters after dedupe', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: 1 }]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([{ session_id: 'sess-1', overall_score: 2.5 }]),
        });

      const { status } = await request(
        baseUrl,
        `${BASE}/quality_evaluation/conversations?period=7d&filter=flagged:true`,
      );

      expect(status).toBe(200);
      const countQuery = mockClickHouseQuery.mock.calls[0][0].query;
      const dataQuery = mockClickHouseQuery.mock.calls[1][0].query;
      expect(countQuery).toContain('argMax(flagged, processed_at) AS flagged');
      expect(countQuery).toContain('GROUP BY session_id');
      expect(countQuery).toContain('WHERE flagged = {filterFlagged:UInt8}');
      expect(mockClickHouseQuery.mock.calls[0][0].query_params.filterFlagged).toBe(1);
      expect(dataQuery).toContain('ORDER BY session_started_at DESC');
    });
  });

  describe('conversations endpoint — quality monitor flagged filters', () => {
    test('applies flagged filter and returns flag reasons for non-quality dimensions', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([{ total: 1 }]),
        })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            {
              session_id: 'sess-h',
              overall_score: 0.4,
              flagged: 1,
              flag_reasons: ['hallucination'],
            },
          ]),
        });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/hallucination_detection/conversations?period=30d&filter=flagged:true`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.conversations[0].flag_reasons).toEqual(['hallucination']);

      const countQuery = mockClickHouseQuery.mock.calls[0][0].query as string;
      const dataQuery = mockClickHouseQuery.mock.calls[1][0].query as string;
      expect(countQuery).toContain("AND (source = 'batch' OR source = '')");
      expect(dataQuery).toContain("AND (source = 'batch' OR source = '')");
      expect(countQuery).toContain('AND flagged = {filterFlagged:UInt8}');
      expect(dataQuery).toContain('flag_reasons');
      expect(mockClickHouseQuery.mock.calls[0][0].query_params.filterFlagged).toBe(1);
      expect(mockClickHouseQuery.mock.calls[1][0].query_params.filterFlagged).toBe(1);
    });

    test('selects custom quality rubric dimensions for quality conversations', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([{ total: 1 }]),
        })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            {
              session_id: 'sess-quality',
              overall_score: 2.1,
              custom_dimensions: '{"empathy":4}',
              flagged: 1,
            },
          ]),
        });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/quality_evaluation/conversations?period=30d&filter=flagged:true`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.conversations[0].custom_dimensions).toBe('{"empathy":4}');

      const dataQuery = mockClickHouseQuery.mock.calls[1][0].query as string;
      expect(dataQuery).toContain('professionalism');
      expect(dataQuery).toContain('instruction_following');
      expect(dataQuery).toContain('custom_dimensions');
    });

    test('scopes quality-dimension summaries to batch/session rows', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ total_evaluations: 1, avg_score: 0.8 }]),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/guardrail_analysis/summary?period=30d`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      const query = mockClickHouseQuery.mock.calls[0][0].query as string;
      expect(query).toContain("AND (source = 'batch' OR source = '')");
    });
  });

  describe('breakdown endpoint — Agent Performance fields', () => {
    test('knowledge_gap breakdown returns gap_count for UI gap totals', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({
          data: [
            {
              agent_name: 'Bot1',
              conversation_count: 10,
              avg_overall_score: 0.7,
              gap_count: 2,
              flagged_count: 9,
            },
          ],
        }),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/knowledge_gap/breakdown?period=7d&dimension=agent_name`,
      );

      expect(status).toBe(200);
      expect(body.data[0].gap_count).toBe(2);
      expect(mockClickHouseQuery.mock.calls[0][0].query).toContain(
        'sum(gap_detected) AS gap_count',
      );
    });

    test('Agent Performance breakdown reads deduped batch session rows', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({ data: [] }),
      });

      const { status } = await request(
        baseUrl,
        `${BASE}/hallucination_detection/breakdown?period=7d&dimension=agent_name`,
      );

      expect(status).toBe(200);
      expect(mockClickHouseQuery.mock.calls[0][0].query).toContain(
        'FROM abl_platform.hallucination_evaluations FINAL',
      );
      expect(mockClickHouseQuery.mock.calls[0][0].query).toContain(
        "AND (source = 'batch' OR source = '')",
      );
    });

    test('guardrail breakdown counts false positives as safety failures', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({ data: [] }),
      });

      const { status } = await request(
        baseUrl,
        `${BASE}/guardrail_analysis/breakdown?period=7d&dimension=agent_name`,
      );

      expect(status).toBe(200);
      expect(mockClickHouseQuery.mock.calls[0][0].query).toContain(
        'countIf((flagged = 1 OR false_positive_score > 0.5 OR false_negative_score > 0.5 OR bypass_detected = 1)) AS flagged_count',
      );
    });
  });

  describe('summary endpoint — previous window support', () => {
    test('passes offsetDays through to ClickHouse date-window params', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ total_conversations: 1 }]),
      });

      const { status } = await request(
        baseUrl,
        `${BASE}/quality_evaluation/summary?period=7d&offsetDays=7`,
      );

      expect(status).toBe(200);
      expect(mockClickHouseQuery.mock.calls[0][0].query).toContain(
        'session_started_at < now() - INTERVAL {offsetDays:UInt32} DAY',
      );
      expect(mockClickHouseQuery.mock.calls[0][0].query_params).toMatchObject({
        windowStartDays: 14,
        offsetDays: 7,
      });
    });
  });

  describe('timeseries endpoint — Agent Performance source', () => {
    test('quality timeseries uses raw FINAL table instead of duplicate-prone MV', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({ data: [] }),
      });

      const { status } = await request(baseUrl, `${BASE}/quality_evaluation/timeseries?period=7d`);

      expect(status).toBe(200);
      const query = mockClickHouseQuery.mock.calls[0][0].query;
      expect(query).toContain('FROM abl_platform.quality_evaluations FINAL');
      expect(query).toContain("AND (source = 'batch' OR source = '')");
      expect(query).not.toContain('mv_daily_quality_scores');
    });

    test('guardrail timeseries counts raw safety failures instead of stored flagged only', async () => {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({ data: [] }),
      });

      const { status } = await request(baseUrl, `${BASE}/guardrail_analysis/timeseries?period=7d`);

      expect(status).toBe(200);
      expect(mockClickHouseQuery.mock.calls[0][0].query).toContain(
        'countIf((flagged = 1 OR false_positive_score > 0.5 OR false_negative_score > 0.5 OR bypass_detected = 1)) AS flagged_count',
      );
    });
  });

  // ── Conversations endpoint — MongoDB agent_name enrichment ─────────────────

  describe('conversations endpoint — blank agent_name enrichment', () => {
    function resetConversationMocks() {
      mockClickHouseQuery.mockReset();
      mockCacheGet.mockReset();
      mockCacheSet.mockReset();
      mockSessionFind.mockReset();
      mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
    }

    test('enriches blank agent_name rows from MongoDB using entryAgentName', async () => {
      resetConversationMocks();
      mockClickHouseQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: 2 }]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            { session_id: 'sess-1', agent_name: 'KnownAgent', overall_score: 4.0 },
            { session_id: 'sess-2', agent_name: '', overall_score: 3.5 },
          ]),
        });
      mockSessionFind.mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          {
            _id: 'sess-2',
            entryAgentName: 'LoanApplicationAgent',
            currentAgent: 'LoanApplicationAgent',
          },
        ]),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/quality_evaluation/conversations?period=30d`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      // Row with known agent untouched
      expect(body.data.conversations[0].agent_name).toBe('KnownAgent');
      // Row with blank agent_name enriched from MongoDB entryAgentName
      expect(body.data.conversations[1].agent_name).toBe('LoanApplicationAgent');
      expect(mockSessionFind).toHaveBeenCalledWith(
        { _id: { $in: ['sess-2'] }, tenantId: 'tenant-1' },
        { entryAgentName: 1, currentAgent: 1 },
      );
    });

    test('falls back to currentAgent when entryAgentName is absent', async () => {
      resetConversationMocks();
      mockClickHouseQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: 1 }]) })
        .mockResolvedValueOnce({
          json: vi
            .fn()
            .mockResolvedValue([{ session_id: 'sess-3', agent_name: '', overall_score: 2.0 }]),
        });
      mockSessionFind.mockReturnValue({
        lean: vi
          .fn()
          .mockResolvedValue([
            { _id: 'sess-3', entryAgentName: null, currentAgent: 'SupportAgent' },
          ]),
      });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/quality_evaluation/conversations?period=30d`,
      );

      expect(status).toBe(200);
      expect(body.data.conversations[0].agent_name).toBe('SupportAgent');
    });

    test('leaves agent_name blank when MongoDB returns no matching session', async () => {
      resetConversationMocks();
      mockClickHouseQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: 1 }]) })
        .mockResolvedValueOnce({
          json: vi
            .fn()
            .mockResolvedValue([{ session_id: 'sess-gone', agent_name: '', overall_score: 1.0 }]),
        });
      mockSessionFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/quality_evaluation/conversations?period=30d`,
      );

      expect(status).toBe(200);
      expect(body.data.conversations[0].agent_name).toBe('');
    });

    test('skips MongoDB lookup when all rows already have agent_name', async () => {
      resetConversationMocks();
      mockClickHouseQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: 1 }]) })
        .mockResolvedValueOnce({
          json: vi
            .fn()
            .mockResolvedValue([
              { session_id: 'sess-ok', agent_name: 'MyAgent', overall_score: 5.0 },
            ]),
        });

      const { status, body } = await request(
        baseUrl,
        `${BASE}/quality_evaluation/conversations?period=30d`,
      );

      expect(status).toBe(200);
      expect(body.data.conversations[0].agent_name).toBe('MyAgent');
      expect(mockSessionFind).not.toHaveBeenCalled();
    });
  });
});

// ── enrichBlankAgentRows unit tests (no module mocks needed) ──────────────────

describe('enrichBlankAgentRows', () => {
  test('enriches blank rows using entryAgentName', async () => {
    const rows = [
      { session_id: 'sess-1', agent_name: 'KnownAgent' },
      { session_id: 'sess-2', agent_name: '' },
    ];
    await enrichBlankAgentRows(rows, 'tenant-1', async () => [
      {
        _id: 'sess-2',
        entryAgentName: 'LoanApplicationAgent',
        currentAgent: 'LoanApplicationAgent',
      },
    ]);
    expect(rows[0].agent_name).toBe('KnownAgent');
    expect(rows[1].agent_name).toBe('LoanApplicationAgent');
  });

  test('falls back to currentAgent when entryAgentName is absent', async () => {
    const rows = [{ session_id: 'sess-3', agent_name: '' }];
    await enrichBlankAgentRows(rows, 'tenant-1', async () => [
      { _id: 'sess-3', entryAgentName: null, currentAgent: 'SupportAgent' },
    ]);
    expect(rows[0].agent_name).toBe('SupportAgent');
  });

  test('leaves agent_name blank when lookup returns no matching session', async () => {
    const rows = [{ session_id: 'sess-gone', agent_name: '' }];
    await enrichBlankAgentRows(rows, 'tenant-1', async () => []);
    expect(rows[0].agent_name).toBe('');
  });

  test('skips lookup entirely when all rows already have agent_name', async () => {
    const rows = [{ session_id: 'sess-ok', agent_name: 'MyAgent' }];
    const lookup = vi.fn().mockResolvedValue([]);
    await enrichBlankAgentRows(rows, 'tenant-1', lookup);
    expect(rows[0].agent_name).toBe('MyAgent');
    expect(lookup).not.toHaveBeenCalled();
  });

  test('only passes blank session_ids to the lookup function', async () => {
    const rows = [
      { session_id: 'sess-1', agent_name: 'HasAgent' },
      { session_id: 'sess-2', agent_name: '' },
      { session_id: 'sess-3', agent_name: '' },
    ];
    const lookup = vi.fn().mockResolvedValue([]);
    await enrichBlankAgentRows(rows, 'tenant-1', lookup);
    expect(lookup).toHaveBeenCalledWith(['sess-2', 'sess-3'], 'tenant-1');
  });
});
