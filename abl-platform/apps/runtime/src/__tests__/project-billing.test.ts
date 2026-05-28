import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockRequireProjectPermission, mockGetUsageReport } = vi.hoisted(() => ({
  mockRequireProjectPermission: vi.fn(async () => true),
  mockGetUsageReport: vi.fn(),
}));

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
    requireProjectScope: () => (_req: any, _res: any, next: any) => next(),
  };
});

vi.mock('../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: (...args: unknown[]) => mockRequireProjectPermission(...args),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: any, ...handlers: any[]) => {
        const lastHandler = handlers[handlers.length - 1];
        const middlewares = handlers.slice(0, -1);
        (router as any)[method](path, ...middlewares, lastHandler);
      },
    };
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

import projectBillingRouter from '../routes/project-billing.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/projects/:projectId/billing', projectBillingRouter);
  return app;
}

function buildUsageReport() {
  return {
    tenantId: 'tenant-123',
    projectId: 'project-123',
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
    projectBreakdown: [
      {
        projectId: 'project-123',
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
    ],
    channelBreakdown: [],
  };
}

describe('Project Billing Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectPermission.mockResolvedValue(true);
    mockGetUsageReport.mockResolvedValue(buildUsageReport());
  });

  test('GET /usage returns the project-scoped usage report', async () => {
    const app = createApp();
    const res = await request(app).get('/api/projects/project-123/billing/usage?granularity=day');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.projectId).toBe('project-123');
    expect(mockGetUsageReport).toHaveBeenCalledWith({
      tenantId: 'tenant-123',
      projectId: 'project-123',
      windowStart: undefined,
      windowEnd: undefined,
      granularity: 'day',
    });
  });

  test('GET /usage stops when project permission is denied', async () => {
    mockRequireProjectPermission.mockImplementationOnce(async (_req: any, res: any) => {
      res.status(404).json({ success: false, error: 'Not found' });
      return false;
    });

    const app = createApp();
    const res = await request(app).get('/api/projects/project-123/billing/usage');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(mockGetUsageReport).not.toHaveBeenCalled();
  });
});
