import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { injectTenantContext, makeTenantContext } from '../helpers/auth-context.js';

const mockRequireProjectPermission = vi.fn();
const mockClickHouseQuery = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@agent-platform/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireProjectScope: () => (_req: any, _res: any, next: any) => next(),
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
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: vi.fn(() => ({
    query: (...args: any[]) => mockClickHouseQuery(...args),
  })),
}));

const BASE = '/api/projects/proj-1/voice-analytics';

async function createTestServer() {
  const app = express();
  app.use(express.json());

  const ctx = makeTenantContext('tenant-1', 'user-1', 'OWNER');
  app.use(injectTenantContext(ctx));

  const routerModule = await import('../../routes/voice-analytics.js');
  app.use('/api/projects/:projectId/voice-analytics', routerModule.default);

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

describe('Voice Analytics Route', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    ({ baseUrl, server } = await createTestServer());
  });

  afterAll(() => server?.close());

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectPermission.mockResolvedValue(true);
  });

  // ── Auth middleware is wired into the route ────────────────────────────

  test('auth middleware is invoked on summary endpoint', async () => {
    const { authMiddleware } = await import('../../middleware/auth.js');

    mockClickHouseQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([{ total_calls: 1 }]),
    });

    await request(baseUrl, `${BASE}/summary`);

    expect(authMiddleware).toHaveBeenCalled();
  });

  // ── Query structure verification ─────────────────────────────────────

  test('hourly query includes LIMIT 500', async () => {
    mockClickHouseQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([]),
    });

    await request(baseUrl, `${BASE}/hourly`);

    expect(mockClickHouseQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockClickHouseQuery.mock.calls[0][0];
    expect(callArgs.query).toContain('LIMIT 500');
  });

  test('summary query computes weighted averages from sums and counts', async () => {
    mockClickHouseQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([{ total_calls: 10 }]),
    });

    await request(baseUrl, `${BASE}/summary`);

    const callArgs = mockClickHouseQuery.mock.calls[0][0];
    // Verify the SQL contains weighted average formula for MOS
    expect(callArgs.query).toContain('sum(sum_inbound_mos) / sum(mos_sample_count)');
    // Verify tenant isolation in WHERE clause
    expect(callArgs.query).toContain('tenant_id = {tenantId:String}');
    expect(callArgs.query).toContain('project_id = {projectId:String}');
  });

  // ── 1. Summary endpoint returns aggregated metrics ────────────────────

  test('summary endpoint returns aggregated metrics with success:true', async () => {
    const summaryRow = {
      total_calls: 150,
      total_errors: 3,
      avg_call_duration_ms: 45000,
      overall_avg_inbound_mos: 4.1,
      overall_avg_outbound_mos: 3.9,
      overall_avg_inbound_jitter_ms: 12.5,
      overall_avg_latency_ms: 200,
      overall_barge_in_rate: 0.05,
      overall_dtmf_fallback_rate: 0.02,
      overall_asr_score: 0.92,
      total_turns: 800,
      total_barge_in_count: 7,
      total_dtmf_turn_count: 4,
    };

    mockClickHouseQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([summaryRow]),
    });

    const { status, body } = await request(baseUrl, `${BASE}/summary`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(summaryRow);
  });

  // ── 2. Hourly endpoint returns per-hour breakdowns ────────────────────

  test('hourly endpoint returns per-hour breakdowns', async () => {
    const hourlyRows = [
      {
        hour: '2026-04-09T10:00:00',
        session_count: 20,
        error_count: 1,
        avg_call_duration_ms: 30000,
        avg_inbound_mos: 4.2,
        avg_outbound_mos: 4.0,
      },
      {
        hour: '2026-04-09T09:00:00',
        session_count: 15,
        error_count: 0,
        avg_call_duration_ms: 25000,
        avg_inbound_mos: 4.3,
        avg_outbound_mos: 4.1,
      },
    ];

    mockClickHouseQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue(hourlyRows),
    });

    const { status, body } = await request(baseUrl, `${BASE}/hourly`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].hour).toBe('2026-04-09T10:00:00');
    expect(body.data[1].session_count).toBe(15);
  });

  // ── 3. Summary returns 400 when tenantId missing ──────────────────────

  test('summary returns 400 when tenantId is missing', async () => {
    // Create a separate server without tenantContext
    const app = express();
    app.use(express.json());
    // Inject context without tenantId
    app.use((req: any, _res: any, next: any) => {
      req.tenantContext = { tenantId: undefined };
      req.user = { id: 'user-1' };
      next();
    });

    const routerModule = await import('../../routes/voice-analytics.js');
    app.use('/api/projects/:projectId/voice-analytics', routerModule.default);

    const noTenantServer = http.createServer(app);
    const noTenantBaseUrl = await new Promise<string>((resolve) => {
      noTenantServer.listen(0, '127.0.0.1', () => {
        const addr = noTenantServer.address() as AddressInfo;
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });

    try {
      mockRequireProjectPermission.mockResolvedValue(true);

      const { status, body } = await request(noTenantBaseUrl, `${BASE}/summary`);

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Missing projectId or tenantId');
    } finally {
      noTenantServer.close();
    }
  });

  // ── 4. Hourly returns 400 when tenantId missing ───────────────────────

  test('hourly returns 400 when tenantId is missing', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.tenantContext = { tenantId: undefined };
      req.user = { id: 'user-1' };
      next();
    });

    const routerModule = await import('../../routes/voice-analytics.js');
    app.use('/api/projects/:projectId/voice-analytics', routerModule.default);

    const noTenantServer = http.createServer(app);
    const noTenantBaseUrl = await new Promise<string>((resolve) => {
      noTenantServer.listen(0, '127.0.0.1', () => {
        const addr = noTenantServer.address() as AddressInfo;
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });

    try {
      mockRequireProjectPermission.mockResolvedValue(true);

      const { status, body } = await request(noTenantBaseUrl, `${BASE}/hourly`);

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Missing projectId or tenantId');
    } finally {
      noTenantServer.close();
    }
  });

  // ── 5. Summary returns 503 when ClickHouse client is null ─────────────

  test('summary returns 503 when ClickHouse client is null', async () => {
    // Override the getClickHouseClient mock to return null
    const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
    (getClickHouseClient as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

    const { status, body } = await request(baseUrl, `${BASE}/summary`);

    expect(status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Analytics service unavailable');
  });

  // ── 6. Default hours parameter (168 for summary) ──────────────────────

  test('summary uses default hours=168 when not specified', async () => {
    mockClickHouseQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([{ total_calls: 10 }]),
    });

    await request(baseUrl, `${BASE}/summary`);

    expect(mockClickHouseQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockClickHouseQuery.mock.calls[0][0];
    expect(callArgs.query_params.hoursBack).toBe(168);
  });

  // ── 7. Custom hours parameter filtering ───────────────────────────────

  test('hourly respects custom hours query parameter', async () => {
    mockClickHouseQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([]),
    });

    await request(baseUrl, `${BASE}/hourly?hours=24`);

    expect(mockClickHouseQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockClickHouseQuery.mock.calls[0][0];
    expect(callArgs.query_params.hoursBack).toBe(24);
  });

  // ── 8. Response format contract ───────────────────────────────────────

  test('response envelope has success:true and data field', async () => {
    mockClickHouseQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([{ total_calls: 5 }]),
    });

    const { status, body } = await request(baseUrl, `${BASE}/summary`);

    expect(status).toBe(200);
    expect(body).toHaveProperty('success', true);
    expect(body).toHaveProperty('data');
    expect(typeof body.data).toBe('object');
  });

  // ── 9. Summary extracts first row from ClickHouse result ──────────────

  test('summary extracts first row from ClickHouse result array', async () => {
    const firstRow = { total_calls: 100, total_errors: 2 };
    const secondRow = { total_calls: 200, total_errors: 5 };

    mockClickHouseQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([firstRow, secondRow]),
    });

    const { status, body } = await request(baseUrl, `${BASE}/summary`);

    expect(status).toBe(200);
    expect(body.data).toEqual(firstRow);
    // Should NOT include the second row — summary takes rows[0]
    expect(body.data).not.toEqual(secondRow);
  });

  // ── 10. Hourly returns full array from ClickHouse ─────────────────────

  test('hourly returns complete array from ClickHouse result', async () => {
    const rows = [
      { hour: '2026-04-09T10:00:00', session_count: 10 },
      { hour: '2026-04-09T09:00:00', session_count: 8 },
      { hour: '2026-04-09T08:00:00', session_count: 12 },
    ];

    mockClickHouseQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue(rows),
    });

    const { status, body } = await request(baseUrl, `${BASE}/hourly`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(rows);
    expect(body.data).toHaveLength(3);
  });

  // ── Bonus: default hours for hourly ───────────────────────────────────

  test('hourly uses default hours=168 when not specified', async () => {
    mockClickHouseQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([]),
    });

    await request(baseUrl, `${BASE}/hourly`);

    expect(mockClickHouseQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockClickHouseQuery.mock.calls[0][0];
    expect(callArgs.query_params.hoursBack).toBe(168);
  });

  // ── Bonus: summary returns empty object when no rows ──────────────────

  test('summary returns empty object when ClickHouse returns empty array', async () => {
    mockClickHouseQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([]),
    });

    const { status, body } = await request(baseUrl, `${BASE}/summary`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({});
  });

  // ── Bonus: ClickHouse query error returns 500 ─────────────────────────

  test('returns 500 when ClickHouse query throws', async () => {
    mockClickHouseQuery.mockRejectedValueOnce(new Error('ClickHouse connection timeout'));

    const { status, body } = await request(baseUrl, `${BASE}/summary`);

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to fetch voice summary');
  });

  test('hourly returns 500 when ClickHouse query throws', async () => {
    mockClickHouseQuery.mockRejectedValueOnce(new Error('ClickHouse connection timeout'));

    const { status, body } = await request(baseUrl, `${BASE}/hourly`);

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to fetch voice analytics');
  });

  // ── Bonus: query passes correct projectId and tenantId ────────────────

  test('passes projectId and tenantId from context to ClickHouse query', async () => {
    mockClickHouseQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([{ total_calls: 1 }]),
    });

    await request(baseUrl, `${BASE}/summary`);

    expect(mockClickHouseQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockClickHouseQuery.mock.calls[0][0];
    expect(callArgs.query_params.tenantId).toBe('tenant-1');
    expect(callArgs.query_params.projectId).toBe('proj-1');
  });
});
