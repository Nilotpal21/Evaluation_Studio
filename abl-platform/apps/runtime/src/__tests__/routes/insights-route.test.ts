import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { injectTenantContext, makeTenantContext } from '../helpers/auth-context.js';

const {
  mockClickHouseQuery,
  mockRequireProjectPermission,
  mockRequireProjectScope,
  mockRequireProjectWideAnalyticsAccess,
} = vi.hoisted(() => ({
  mockClickHouseQuery: vi.fn(),
  mockRequireProjectPermission: vi.fn(),
  mockRequireProjectScope: vi.fn((_paramName: string, _opts?: unknown) => {
    return (_req: any, _res: any, next: any) => next();
  }),
  mockRequireProjectWideAnalyticsAccess: vi.fn(),
}));

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
  requireProjectScope: (...args: unknown[]) => mockRequireProjectScope(...args),
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
  requireProjectPermission: (...args: unknown[]) => mockRequireProjectPermission(...args),
  requireProjectWideAnalyticsAccess: (...args: unknown[]) =>
    mockRequireProjectWideAnalyticsAccess(...args),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: vi.fn(() => ({
    query: (...args: unknown[]) => mockClickHouseQuery(...args),
  })),
}));

const BASE = '/api/projects/proj-1/insights';

async function createTestServer() {
  const app = express();
  app.use(express.json());
  app.use(injectTenantContext(makeTenantContext('tenant-1', 'user-1', 'OWNER')));

  const routerModule = await import('../../routes/insights.js');
  app.use('/api/projects/:projectId/insights', routerModule.default);

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
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

describe('Insights Route', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    ({ baseUrl, server } = await createTestServer());
  });

  afterAll(() => server?.close());

  beforeEach(() => {
    mockClickHouseQuery.mockClear();
    mockRequireProjectPermission.mockClear();
    mockRequireProjectWideAnalyticsAccess.mockClear();
    mockRequireProjectWideAnalyticsAccess.mockResolvedValue(true);
    mockClickHouseQuery.mockResolvedValue({
      json: vi.fn().mockResolvedValue([]),
    });
  });

  test('conceals out-of-scope project access at the project-scope middleware layer', () => {
    expect(mockRequireProjectScope).toHaveBeenCalledWith('projectId', {
      concealOutOfScope: true,
    });
  });

  test.each([`${BASE}/timeseries?days=7`, `${BASE}/outcomes?days=7`])(
    'requires project-wide analytics access for %s',
    async (path) => {
      const { status } = await request(baseUrl, path);

      expect(status).toBe(200);
      expect(mockRequireProjectPermission).not.toHaveBeenCalled();
      expect(mockRequireProjectWideAnalyticsAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ projectId: 'proj-1' }),
        }),
        expect.anything(),
      );
    },
  );

  test('does not query ClickHouse when analytics access is denied', async () => {
    mockRequireProjectWideAnalyticsAccess.mockImplementationOnce((_req, res) => {
      res.status(404).json({ success: false, error: 'Not found' });
      return Promise.resolve(false);
    });

    const { status, body } = await request(baseUrl, `${BASE}/timeseries?days=7`);

    expect(status).toBe(404);
    expect(body).toEqual({ success: false, error: 'Not found' });
    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });

  test('dedupes latest per-session analytics rows before timeseries aggregation', async () => {
    const { status } = await request(baseUrl, `${BASE}/timeseries?days=7`);

    expect(status).toBe(200);
    const queries = mockClickHouseQuery.mock.calls.map((call) => String(call[0].query));
    expect(queries[0]).toContain('argMax(avg_sentiment, processed_at) AS avg_sentiment');
    expect(queries[0]).toContain('GROUP BY session_id');
    expect(queries[1]).toContain('argMax(overall_score, processed_at) AS overall_score');
    expect(queries[1]).toContain('GROUP BY session_id');
    expect(queries[2]).toContain('argMax(outcome, processed_at) AS outcome');
    expect(queries[2]).toContain('GROUP BY session_id');
  });

  test('dedupes latest per-session outcomes before outcome totals', async () => {
    const { status } = await request(baseUrl, `${BASE}/outcomes?days=7`);

    expect(status).toBe(200);
    const query = String(mockClickHouseQuery.mock.calls[0][0].query);
    expect(query).toContain('argMax(outcome, processed_at) AS outcome');
    expect(query).toContain('GROUP BY session_id');
    expect(query).toContain('GROUP BY outcome');
  });
});
