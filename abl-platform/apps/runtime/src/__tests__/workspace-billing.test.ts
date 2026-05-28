import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockGetUsageReport } = vi.hoisted(() => ({
  mockGetUsageReport: vi.fn(),
}));

const mockRequireConcealedProjectPermission = vi.fn(async () => true);

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.tenantContext = {
      tenantId: 'tenant-123',
      userId: 'user-1',
      permissions: [],
    };
    next();
  },
}));

vi.mock('@agent-platform/shared-auth', async () => {
  const actual = await vi.importActual('@agent-platform/shared-auth');
  return {
    ...actual,
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
  };
});

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireConcealedProjectPermission: (...args: unknown[]) =>
    mockRequireConcealedProjectPermission(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../services/billing/billing-usage-report-service.js', () => ({
  BILLING_USAGE_REPORT_GRANULARITY_VALUES: ['hour', 'day', 'week', 'month'],
  BillingUsageReportError: class BillingUsageReportError extends Error {
    code: string;
    details: Record<string, unknown> | undefined;

    constructor(code: string, message: string, details?: Record<string, unknown>) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
  BillingUsageReportService: class BillingUsageReportService {
    getUsageReport = mockGetUsageReport;
  },
}));

import workspaceBillingRouter from '../routes/workspace-billing.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tenants/:tenantId/billing', workspaceBillingRouter);
  return app;
}

function buildUsageReport() {
  return {
    tenantId: 'tenant-123',
    projectId: null,
    granularity: 'day' as const,
    range: {
      windowStart: '2026-03-30T00:00:00.000Z',
      windowEnd: '2026-03-31T00:00:00.000Z',
      timeZone: 'UTC' as const,
    },
    totals: {
      examinedSessionCount: 1,
      includedSessionCount: 1,
      excludedSessionCount: 0,
      durationSeconds: 1200,
      userMessageCount: 2,
      assistantMessageCount: 2,
      toolMessageCount: 1,
      interactiveTurnCount: 5,
      engagedSeconds: 900,
      llmCallCount: 3,
      toolCallCount: 1,
      baseUnits: 2,
      llmAddonUnits: 3,
      toolAddonUnits: 1,
      totalUnits: 6,
    },
    windows: [],
    projectBreakdown: [],
    channelBreakdown: [],
  };
}

describe('Workspace Billing Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireConcealedProjectPermission.mockResolvedValue(true);
    mockGetUsageReport.mockResolvedValue(buildUsageReport());
  });

  test('GET /usage returns the tenant-scoped usage report', async () => {
    const app = createApp();
    const res = await request(app).get(
      '/api/tenants/tenant-123/billing/usage?projectId=project-123&granularity=day',
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tenantId).toBe('tenant-123');
    expect(res.body.totals.totalUnits).toBe(6);
    expect(mockGetUsageReport).toHaveBeenCalledWith({
      tenantId: 'tenant-123',
      projectId: 'project-123',
      windowStart: undefined,
      windowEnd: undefined,
      granularity: 'day',
    });
    expect(mockRequireConcealedProjectPermission).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      'session:read',
      'project-123',
    );
  });

  test('GET /usage returns 404 for cross-tenant access', async () => {
    const app = createApp();
    const res = await request(app).get('/api/tenants/other-tenant/billing/usage');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(mockGetUsageReport).not.toHaveBeenCalled();
  });

  test('GET /usage returns 404 when filtered project is outside the caller project scope', async () => {
    mockRequireConcealedProjectPermission.mockImplementationOnce(async (_req: any, res: any) => {
      res.status(404).json({ success: false, error: { code: 'PROJECT_NOT_FOUND' } });
      return false;
    });

    const app = createApp();
    const res = await request(app).get(
      '/api/tenants/tenant-123/billing/usage?projectId=project-hidden&granularity=day',
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(mockGetUsageReport).not.toHaveBeenCalled();
  });
});
