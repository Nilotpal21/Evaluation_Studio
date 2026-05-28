import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { PIPELINE_OBSERVABILITY_CONTRACT } from '@agent-platform/shared';
import { injectTenantContext, makeTenantContext } from '../helpers/auth-context.js';

const mockRequireProjectWideAnalyticsAccess = vi.fn();
const mockListProjectRuns = vi.fn();
const mockGetProjectRunHealth = vi.fn();
const mockResolveRunSessionId = vi.fn();
const mockResolveOutputSchema = vi.fn();
const mockBuildPipelineDataQuery = vi.fn();
const mockListPreviewablePipelines = vi.fn();
const mockClickHouseQuery = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('@agent-platform/shared-auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireProjectScope: () => (_req: unknown, _res: unknown, next: () => void) => next(),
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
  requireProjectWideAnalyticsAccess: (...args: unknown[]) =>
    mockRequireProjectWideAnalyticsAccess(...args),
}));

vi.mock('../../services/pipeline-observability/runs-service.js', () => ({
  listProjectRuns: (...args: unknown[]) => mockListProjectRuns(...args),
  getProjectRunHealth: (...args: unknown[]) => mockGetProjectRunHealth(...args),
  resolveRunSessionId: (...args: unknown[]) => mockResolveRunSessionId(...args),
}));

vi.mock('../../services/pipeline-observability/schema-resolver.js', () => ({
  resolveOutputSchema: (...args: unknown[]) => mockResolveOutputSchema(...args),
  OutputSchemaError: class OutputSchemaError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock('../../services/pipeline-observability/query-builder.js', () => ({
  buildPipelineDataQuery: (...args: unknown[]) => mockBuildPipelineDataQuery(...args),
  QueryBuilderError: class QueryBuilderError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock('../../services/pipeline-observability/previewable-pipelines-service.js', () => ({
  listPreviewablePipelines: (...args: unknown[]) => mockListPreviewablePipelines(...args),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: vi.fn(() => ({
    query: (...args: unknown[]) => mockClickHouseQuery(...args),
  })),
}));

async function createTestServer() {
  const app = express();
  app.use(express.json());
  app.use(injectTenantContext(makeTenantContext('tenant-1', 'user-1', 'OWNER')));

  const routerModule = await import('../../routes/pipeline-observability.js');
  app.use('/api/projects/:projectId/pipeline-observability', routerModule.default);

  return await new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${address.port}`, server });
    });
  });
}

async function requestJson(baseUrl: string, path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  return {
    status: response.status,
    body: await response.json(),
  };
}

describe('Pipeline observability route', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    ({ baseUrl, server } = await createTestServer());
  });

  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
    mockListProjectRuns.mockResolvedValue({
      data: [
        {
          runId: 'run-1',
          pipelineId: 'builtin:sentiment-analysis',
          pipelineName: 'Sentiment Analysis',
          pipelineKind: 'builtin',
          status: 'completed',
          trigger: { type: 'manual', triggerId: 'manual-1', executionMode: 'batch' },
          startedAt: '2026-04-20T10:00:00.000Z',
        },
      ],
      pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
    });
    mockGetProjectRunHealth.mockResolvedValue({
      total: 8,
      completed: 7,
      failed: 1,
      running: 0,
      cancelled: 0,
      successRate: 87.5,
      avgDurationMs: 1225,
      byPipeline: [
        {
          pipelineId: 'builtin:sentiment-analysis',
          total: 8,
          failed: 1,
          successRate: 0.875,
        },
      ],
    });
    mockResolveRunSessionId.mockResolvedValue('sess-1');
    mockResolveOutputSchema.mockResolvedValue({
      table: 'abl_platform.sentiment_scores',
      columns: [
        { name: 'tenant_id', type: 'String', filterable: true, exportable: false },
        { name: 'run_id', type: 'String', filterable: true, exportable: true },
        { name: 'score', type: 'Float64', filterable: true, exportable: true },
      ],
    });
    mockBuildPipelineDataQuery.mockReturnValue({
      sql: 'SELECT score FROM abl_platform.sentiment_scores',
      params: { tenantId: 'tenant-1', projectId: 'proj-1' },
    });
    mockListPreviewablePipelines.mockResolvedValue([
      { id: 'builtin:sentiment-analysis', name: 'Sentiment Analysis', kind: 'builtin' },
    ]);
    mockClickHouseQuery.mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ score: 0.91, run_id: 'run-1' }]),
    });
  });

  test('GET /runs returns the canonical observability contract metadata', async () => {
    const { status, body } = await requestJson(
      baseUrl,
      '/api/projects/proj-1/pipeline-observability/runs?limit=20&offset=0',
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.meta).toEqual({ contract: PIPELINE_OBSERVABILITY_CONTRACT });
    expect(body.data).toHaveLength(1);
    expect(body.data[0].pipelineId).toBe('sentiment_analysis');
    expect(mockRequireProjectWideAnalyticsAccess).toHaveBeenCalled();
  });

  test('GET /runs normalizes builtin pipeline slug filters before querying service', async () => {
    const { status } = await requestJson(
      baseUrl,
      '/api/projects/proj-1/pipeline-observability/runs?pipelineId=sentiment_analysis&limit=20&offset=0',
    );

    expect(status).toBe(200);
    expect(mockListProjectRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: 'builtin:sentiment-analysis',
      }),
    );
  });

  test('GET /runs/health returns the canonical observability contract metadata', async () => {
    const { status, body } = await requestJson(
      baseUrl,
      '/api/projects/proj-1/pipeline-observability/runs/health?window=24h',
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.meta).toEqual({ contract: PIPELINE_OBSERVABILITY_CONTRACT });
    expect(body.data.total).toBe(8);
    expect(body.data.byPipeline).toEqual([
      {
        pipelineId: 'sentiment_analysis',
        total: 8,
        failed: 1,
        successRate: 0.875,
      },
    ]);
  });

  test('POST /data/query returns metadata plus ClickHouse rows', async () => {
    const { status, body } = await requestJson(
      baseUrl,
      '/api/projects/proj-1/pipeline-observability/data/query',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pipelineId: 'sentiment_analysis',
          runId: 'run-1',
          timeRange: {
            from: '2026-04-20T00:00:00.000Z',
            to: '2026-04-20T23:59:59.999Z',
          },
          filters: [],
          limit: 50,
          offset: 0,
        }),
      },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.meta).toEqual({ contract: PIPELINE_OBSERVABILITY_CONTRACT });
    expect(body.data.rows).toEqual([{ score: 0.91, run_id: 'run-1' }]);
    expect(body.pagination.total).toBeNull();
    expect(mockResolveRunSessionId).toHaveBeenCalledWith('run-1', 'tenant-1');
    expect(mockResolveOutputSchema).toHaveBeenCalledWith('builtin:sentiment-analysis', 'tenant-1');
    expect(mockBuildPipelineDataQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: 'builtin:sentiment-analysis',
      }),
    );
  });

  test('GET /data/previewable-pipelines returns metadata plus previewable pipelines', async () => {
    const { status, body } = await requestJson(
      baseUrl,
      '/api/projects/proj-1/pipeline-observability/data/previewable-pipelines',
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.meta).toEqual({ contract: PIPELINE_OBSERVABILITY_CONTRACT });
    expect(body.data).toEqual([
      { id: 'builtin:sentiment-analysis', name: 'Sentiment Analysis', kind: 'builtin' },
    ]);
  });

  test('GET /pipelines/:pipelineId/output-schema returns metadata plus schema details', async () => {
    const { status, body } = await requestJson(
      baseUrl,
      '/api/projects/proj-1/pipeline-observability/pipelines/sentiment_analysis/output-schema',
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.meta).toEqual({ contract: PIPELINE_OBSERVABILITY_CONTRACT });
    expect(body.data.table).toBe('abl_platform.sentiment_scores');
    expect(body.data.columns).toHaveLength(3);
    expect(mockResolveOutputSchema).toHaveBeenCalledWith('builtin:sentiment-analysis', 'tenant-1');
  });
});
