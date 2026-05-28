import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContextData } from '@agent-platform/shared';

const mockRequireProjectPermission = vi.fn();
const mockGetClickHouseClient = vi.fn();
const mockClickHouseQuery = vi.fn();
const mockRequireProjectScopeMiddleware = vi.fn(
  (_req: Request, _res: Response, next: NextFunction) => next(),
);

let currentTenantContext: TenantContextData | undefined;

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req: Request, _res: Response, next: NextFunction) => {
    req.tenantContext = currentTenantContext;
    next();
  }),
}));

vi.mock('../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: (...args: unknown[]) => mockRequireProjectPermission(...args),
}));

vi.mock('@agent-platform/shared', () => ({
  requireProjectScope: vi.fn(
    () => (req: Request, res: Response, next: NextFunction) =>
      mockRequireProjectScopeMiddleware(req, res, next),
  ),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: (...args: unknown[]) => mockGetClickHouseClient(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import voiceAnalyticsRouter from '../../routes/voice-analytics.js';

function createApp() {
  const app = express();
  app.use('/api/projects/:projectId/voice-analytics', voiceAnalyticsRouter);
  return app;
}

function queueClickHouseRows(rows: unknown[]) {
  const json = vi.fn().mockResolvedValue(rows);
  mockClickHouseQuery.mockResolvedValueOnce({ json });
}

describe('Voice analytics route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    currentTenantContext = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'ADMIN',
      permissions: ['session:read'],
      authType: 'user',
      isSuperAdmin: false,
      projectId: 'project-1',
    };

    mockRequireProjectPermission.mockResolvedValue(true);
    mockGetClickHouseClient.mockReturnValue({
      query: (...args: unknown[]) => mockClickHouseQuery(...args),
    });
  });

  it('returns the existing hourly success envelope and forwards default hours to ClickHouse', async () => {
    const app = createApp();
    queueClickHouseRows([
      {
        hour: '2026-03-30T12:00:00.000Z',
        session_count: 12,
        error_count: 1,
        avg_call_duration_ms: 4200,
      },
    ]);

    await request(app)
      .get('/api/projects/project-1/voice-analytics/hourly')
      .expect(200, {
        success: true,
        data: [
          {
            hour: '2026-03-30T12:00:00.000Z',
            session_count: 12,
            error_count: 1,
            avg_call_duration_ms: 4200,
          },
        ],
      });

    expect(mockRequireProjectPermission).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'session:read',
    );

    const queryArgs = mockClickHouseQuery.mock.calls[0]?.[0];
    expect(queryArgs.query).toContain('FROM abl_platform.platform_events_voice_hourly_dest');
    expect(queryArgs.format).toBe('JSONEachRow');
    expect(queryArgs.query_params).toEqual({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      hoursBack: 168,
    });
  });

  it('returns the existing summary envelope and respects hours overrides', async () => {
    const app = createApp();
    queueClickHouseRows([
      {
        total_calls: 44,
        total_errors: 3,
        avg_call_duration_ms: 3100,
      },
    ]);

    await request(app)
      .get('/api/projects/project-1/voice-analytics/summary')
      .query({ hours: '24' })
      .expect(200, {
        success: true,
        data: {
          total_calls: 44,
          total_errors: 3,
          avg_call_duration_ms: 3100,
        },
      });

    const queryArgs = mockClickHouseQuery.mock.calls[0]?.[0];
    expect(queryArgs.query).toContain('sum(session_count) AS total_calls');
    expect(queryArgs.query_params).toEqual({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      hoursBack: 24,
    });
  });

  it('returns 400 when tenant context is missing before querying ClickHouse', async () => {
    const app = createApp();
    currentTenantContext = undefined;

    await request(app).get('/api/projects/project-1/voice-analytics/hourly').expect(400, {
      success: false,
      error: 'Missing projectId or tenantId',
    });

    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });

  it('returns 503 when the ClickHouse client is unavailable', async () => {
    const app = createApp();
    mockGetClickHouseClient.mockReturnValue(undefined);

    await request(app).get('/api/projects/project-1/voice-analytics/summary').expect(503, {
      success: false,
      error: 'Analytics service unavailable',
    });

    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });

  it('returns 500 when the hourly query throws', async () => {
    const app = createApp();
    mockClickHouseQuery.mockRejectedValueOnce(new Error('clickhouse blew up'));

    await request(app).get('/api/projects/project-1/voice-analytics/hourly').expect(500, {
      success: false,
      error: 'Failed to fetch voice analytics',
    });
  });

  it('returns 400 for malformed query shapes before ClickHouse runs', async () => {
    const app = createApp();

    await request(app)
      .get('/api/projects/project-1/voice-analytics/hourly?hours[bad]=value')
      .expect(400, {
        success: false,
        error: 'Invalid query parameters',
      });

    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });

  it('short-circuits before ClickHouse when project permission is denied', async () => {
    const app = createApp();
    mockRequireProjectPermission.mockImplementationOnce(
      async (_req: Request, res: Response, _permission: string) => {
        res.status(403).json({
          success: false,
          error: { code: 'PERMISSION_REQUIRED', message: 'Forbidden' },
        });
        return false;
      },
    );

    await request(app)
      .get('/api/projects/project-1/voice-analytics/summary')
      .expect(403, {
        success: false,
        error: { code: 'PERMISSION_REQUIRED', message: 'Forbidden' },
      });

    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });
});
