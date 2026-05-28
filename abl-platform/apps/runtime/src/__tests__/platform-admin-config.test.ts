/**
 * Platform Admin Config API Tests
 *
 * Verifies CRUD endpoints for managing per-tenant and per-project
 * configuration overrides through the platform admin API.
 *
 * Covers:
 * 1. GET /plans — returns all plan defaults
 * 2. GET /:tenantId — returns resolved config with overrides and plan defaults
 * 3. PUT /:tenantId/overrides — writes overrides and invalidates cache
 * 4. PUT /:tenantId/overrides — validates input (rejects non-numeric, unknown keys)
 * 5. DELETE /:tenantId/overrides — clears overrides and invalidates cache
 * 6. PUT /:tenantId/projects/:projectId/overrides — writes project overrides
 * 7. DELETE /:tenantId/projects/:projectId/overrides — clears project overrides
 * 8. Auth: rejects non-admin users
 * 9. Audit logging: verify writeAuditLog called with correct action prefixes
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// =============================================================================
// MOCKS — declared before any import that transitively pulls in the modules
// =============================================================================

// Mock auth middleware — inject admin context by default
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => {
    _req.tenantContext = {
      userId: 'admin-user-1',
      tenantId: 'admin-tenant',
      isSuperAdmin: true,
      permissions: [],
    };
    next();
  },
  platformAdminAuthMiddleware: (_req: any, _res: any, next: any) => {
    _req.tenantContext = {
      userId: 'admin-user-1',
      tenantId: 'admin-tenant',
      isSuperAdmin: true,
      permissions: [],
    };
    next();
  },
}));

// Mock permission guards
vi.mock('@agent-platform/shared', async () => {
  const actual = await vi.importActual('@agent-platform/shared');
  return {
    ...actual,
    requirePlatformAdmin: () => (_req: any, _res: any, next: any) => next(),
    requirePlatformAdminIp: () => (_req: any, _res: any, next: any) => next(),
    getCurrentRequestId: () => 'test-req-id',
  };
});

// Mock config
vi.mock('../config/index.js', () => ({
  getConfig: () => ({ security: { platformAdminAllowedIps: [] } }),
}));

// Mock rate limiter
vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Mock logger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock audit log
const mockWriteAuditLog = vi.fn();
vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: (...args: any[]) => mockWriteAuditLog(...args),
}));

// Mock TenantConfigService
const mockGetConfigAsync = vi.fn();
const mockInvalidateCache = vi.fn();
const mockGetPlanDefaults = vi.fn();
const mockGetAllPlanDefaults = vi.fn();

vi.mock('../services/tenant-config.js', () => {
  const FREE_LIMITS = {
    maxConcurrentSessions: 10,
    maxServiceTimeoutMs: 10_000,
    maxResponseBodyBytes: 524_288,
    maxConcurrentServiceCalls: 3,
    maxPendingTimers: 100,
    maxAgentsPerProject: 3,
    maxEventTypesPerApp: 10,
    maxProjectsPerOrg: 3,
    requestsPerMinute: 60,
    tokensPerMinute: 50_000,
    messagesPerMonth: 1_000,
    traceRetentionDays: 7,
    sessionRetentionDays: 7,
    auditLogRetentionDays: 30,
  };

  return {
    PLAN_LIMITS: {
      FREE: { ...FREE_LIMITS },
      TEAM: { ...FREE_LIMITS, maxConcurrentSessions: 50 },
      BUSINESS: { ...FREE_LIMITS, maxConcurrentSessions: 500 },
      ENTERPRISE: { ...FREE_LIMITS, maxConcurrentSessions: -1 },
    },
    getTenantConfigService: () => ({
      getConfigAsync: mockGetConfigAsync,
      invalidateCache: mockInvalidateCache,
      getPlanDefaults: mockGetPlanDefaults,
      getAllPlanDefaults: mockGetAllPlanDefaults,
    }),
  };
});

// Mock Subscription model
const mockSubscriptionFindOne = vi.fn();
const mockSubscriptionFindOneAndUpdate = vi.fn();
const mockSubscriptionFind = vi.fn();
const mockSubscriptionCountDocuments = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Subscription: {
    findOne: (...args: any[]) => mockSubscriptionFindOne(...args),
    findOneAndUpdate: (...args: any[]) => mockSubscriptionFindOneAndUpdate(...args),
    find: (...args: any[]) => mockSubscriptionFind(...args),
    countDocuments: (...args: any[]) => mockSubscriptionCountDocuments(...args),
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import platformAdminConfigRouter from '../routes/platform-admin-config.js';

// =============================================================================
// HELPERS
// =============================================================================

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/platform/admin/tenant-config', platformAdminConfigRouter);
  return app;
}

const TENANT_ID = 'tenant-abc';
const PROJECT_ID = 'project-xyz';

function buildTenantConfig(tenantId: string) {
  return {
    tenantId,
    plan: 'TEAM',
    limits: {
      maxConcurrentSessions: 50,
      maxServiceTimeoutMs: 30_000,
      maxResponseBodyBytes: 2_097_152,
      maxConcurrentServiceCalls: 10,
      maxPendingTimers: 1_000,
      maxAgentsPerProject: 20,
      maxEventTypesPerApp: 50,
      maxProjectsPerOrg: 20,
      requestsPerMinute: 300,
      tokensPerMinute: 200_000,
      messagesPerMonth: 50_000,
      traceRetentionDays: 30,
      sessionRetentionDays: 30,
      auditLogRetentionDays: 90,
    },
    features: { customModels: true },
    security: { allowedServiceDomains: ['*'] },
  };
}

/** Helper to build a chainable Mongoose query mock. */
function chainable(resolvedValue: any) {
  const chain: any = {
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(resolvedValue),
  };
  return chain;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Platform Admin Config API', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();

    // Default mock return values
    mockGetConfigAsync.mockResolvedValue(buildTenantConfig(TENANT_ID));
    mockInvalidateCache.mockResolvedValue(undefined);
    mockGetPlanDefaults.mockReturnValue({
      limits: buildTenantConfig(TENANT_ID).limits,
      features: buildTenantConfig(TENANT_ID).features,
    });
    mockGetAllPlanDefaults.mockReturnValue({
      FREE: { limits: {}, features: {} },
      TEAM: { limits: {}, features: {} },
      BUSINESS: { limits: {}, features: {} },
      ENTERPRISE: { limits: {}, features: {} },
    });
  });

  // ─── GET /plans ──────────────────────────────────────────────────────────

  describe('GET /plans', () => {
    test('returns all plan defaults', async () => {
      const res = await request(app).get('/api/platform/admin/tenant-config/plans');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.plans).toBeDefined();
      expect(mockGetAllPlanDefaults).toHaveBeenCalled();
    });
  });

  // ─── GET /:tenantId ─────────────────────────────────────────────────────

  describe('GET /:tenantId', () => {
    test('returns resolved config with overrides and plan defaults', async () => {
      const overrides = { maxConcurrentSessions: 100 };
      const chain = chainable({
        tenantId: TENANT_ID,
        planTier: 'TEAM',
        tenantQuotas: [{ tenantId: TENANT_ID, allocatedLimits: overrides }],
      });
      mockSubscriptionFindOne.mockReturnValue(chain);

      const res = await request(app).get(`/api/platform/admin/tenant-config/${TENANT_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.config).toBeDefined();
      expect(res.body.config.tenantId).toBe(TENANT_ID);
      expect(res.body.planDefaults).toBeDefined();
      expect(res.body.overrides).toEqual(overrides);
      expect(mockGetConfigAsync).toHaveBeenCalledWith(TENANT_ID);
    });

    test('returns empty overrides when no subscription exists', async () => {
      const chain = chainable(null);
      mockSubscriptionFindOne.mockReturnValue(chain);

      const res = await request(app).get(`/api/platform/admin/tenant-config/${TENANT_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.overrides).toEqual({});
    });
  });

  // ─── PUT /:tenantId/overrides ───────────────────────────────────────────

  describe('PUT /:tenantId/overrides', () => {
    test('writes overrides and invalidates cache', async () => {
      const overrides = { maxConcurrentSessions: 200, requestsPerMinute: 1000 };
      const updatedSub = { _id: 'sub-1', tenantId: TENANT_ID };

      // First findOneAndUpdate: update existing quota — returns result
      mockSubscriptionFindOneAndUpdate.mockReturnValue({
        exec: vi.fn().mockResolvedValue(updatedSub),
      });

      const res = await request(app)
        .put(`/api/platform/admin/tenant-config/${TENANT_ID}/overrides`)
        .send(overrides);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.overrides).toEqual(overrides);

      // Verify cache invalidation
      expect(mockInvalidateCache).toHaveBeenCalledWith(TENANT_ID);

      // Verify audit log
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:set-tenant-overrides',
          userId: 'admin-user-1',
          tenantId: TENANT_ID,
        }),
      );
    });

    test('creates tenantQuota entry when none exists', async () => {
      // First findOneAndUpdate (match existing tenantQuota) returns null
      mockSubscriptionFindOneAndUpdate
        .mockReturnValueOnce({
          exec: vi.fn().mockResolvedValue(null),
        })
        // Second findOneAndUpdate (atomic $push with $ne guard) succeeds
        .mockReturnValueOnce({
          exec: vi.fn().mockResolvedValue({ _id: 'sub-1', tenantId: TENANT_ID }),
        });

      const res = await request(app)
        .put(`/api/platform/admin/tenant-config/${TENANT_ID}/overrides`)
        .send({ requestsPerMinute: 500 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockInvalidateCache).toHaveBeenCalledWith(TENANT_ID);
    });

    test('returns 404 when no active subscription exists', async () => {
      // All findOneAndUpdate calls return null (no subscription matches)
      mockSubscriptionFindOneAndUpdate.mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      });

      const res = await request(app)
        .put(`/api/platform/admin/tenant-config/${TENANT_ID}/overrides`)
        .send({ requestsPerMinute: 500 });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('rejects non-numeric override values', async () => {
      const res = await request(app)
        .put(`/api/platform/admin/tenant-config/${TENANT_ID}/overrides`)
        .send({ maxConcurrentSessions: 'not-a-number' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.details).toBeDefined();
    });

    test('rejects unknown limit keys', async () => {
      const res = await request(app)
        .put(`/api/platform/admin/tenant-config/${TENANT_ID}/overrides`)
        .send({ unknownKey: 100, anotherBadKey: 200 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.details).toBeDefined();
    });

    test('rejects empty override object', async () => {
      const res = await request(app)
        .put(`/api/platform/admin/tenant-config/${TENANT_ID}/overrides`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('No overrides provided');
    });
  });

  // ─── DELETE /:tenantId/overrides ────────────────────────────────────────

  describe('DELETE /:tenantId/overrides', () => {
    test('clears overrides and invalidates cache', async () => {
      mockSubscriptionFindOneAndUpdate.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: 'sub-1', tenantId: TENANT_ID }),
      });

      const res = await request(app).delete(
        `/api/platform/admin/tenant-config/${TENANT_ID}/overrides`,
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Tenant overrides cleared');

      // Verify cache invalidation
      expect(mockInvalidateCache).toHaveBeenCalledWith(TENANT_ID);

      // Verify audit log
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:clear-tenant-overrides',
          userId: 'admin-user-1',
          tenantId: TENANT_ID,
        }),
      );
    });

    test('returns 404 when no subscription or tenant quota found', async () => {
      mockSubscriptionFindOneAndUpdate.mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      });

      const res = await request(app).delete(
        `/api/platform/admin/tenant-config/${TENANT_ID}/overrides`,
      );

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ─── PUT /:tenantId/projects/:projectId/overrides ──────────────────────

  describe('PUT /:tenantId/projects/:projectId/overrides', () => {
    test('writes project overrides for existing project quota', async () => {
      const overrides = { maxAgentsPerProject: 50 };

      // findOne returns subscription with existing project quota
      mockSubscriptionFindOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: 'sub-1',
          tenantId: TENANT_ID,
          tenantQuotas: [
            {
              tenantId: TENANT_ID,
              projectQuotas: [
                { projectId: PROJECT_ID, allocatedLimits: { maxAgentsPerProject: 10 } },
              ],
            },
          ],
        }),
      });

      mockSubscriptionFindOneAndUpdate.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: 'sub-1' }),
      });

      const res = await request(app)
        .put(`/api/platform/admin/tenant-config/${TENANT_ID}/projects/${PROJECT_ID}/overrides`)
        .send(overrides);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.projectId).toBe(PROJECT_ID);
      expect(res.body.overrides).toEqual(overrides);
      expect(mockInvalidateCache).toHaveBeenCalledWith(TENANT_ID);

      // Verify audit log
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:set-project-overrides',
          metadata: expect.objectContaining({ projectId: PROJECT_ID }),
        }),
      );
    });

    test('creates new project quota when none exists', async () => {
      const overrides = { maxAgentsPerProject: 50 };

      // findOne returns subscription without project quota
      mockSubscriptionFindOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: 'sub-1',
          tenantId: TENANT_ID,
          tenantQuotas: [
            {
              tenantId: TENANT_ID,
              projectQuotas: [],
            },
          ],
        }),
      });

      mockSubscriptionFindOneAndUpdate.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: 'sub-1' }),
      });

      const res = await request(app)
        .put(`/api/platform/admin/tenant-config/${TENANT_ID}/projects/${PROJECT_ID}/overrides`)
        .send(overrides);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockInvalidateCache).toHaveBeenCalledWith(TENANT_ID);
    });

    test('returns 404 when no subscription or tenant quota found', async () => {
      mockSubscriptionFindOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      });

      const res = await request(app)
        .put(`/api/platform/admin/tenant-config/${TENANT_ID}/projects/${PROJECT_ID}/overrides`)
        .send({ maxAgentsPerProject: 50 });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('rejects invalid override keys', async () => {
      const res = await request(app)
        .put(`/api/platform/admin/tenant-config/${TENANT_ID}/projects/${PROJECT_ID}/overrides`)
        .send({ badKey: 100 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    test('rejects empty override object', async () => {
      const res = await request(app)
        .put(`/api/platform/admin/tenant-config/${TENANT_ID}/projects/${PROJECT_ID}/overrides`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No overrides provided');
    });
  });

  // ─── DELETE /:tenantId/projects/:projectId/overrides ───────────────────

  describe('DELETE /:tenantId/projects/:projectId/overrides', () => {
    test('clears project overrides and invalidates cache', async () => {
      mockSubscriptionFindOneAndUpdate.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: 'sub-1', tenantId: TENANT_ID }),
      });

      const res = await request(app).delete(
        `/api/platform/admin/tenant-config/${TENANT_ID}/projects/${PROJECT_ID}/overrides`,
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Project overrides cleared');
      expect(mockInvalidateCache).toHaveBeenCalledWith(TENANT_ID);

      // Verify audit log
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:clear-project-overrides',
          metadata: expect.objectContaining({ projectId: PROJECT_ID }),
        }),
      );
    });

    test('returns 404 when no subscription or tenant quota found', async () => {
      mockSubscriptionFindOneAndUpdate.mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      });

      const res = await request(app).delete(
        `/api/platform/admin/tenant-config/${TENANT_ID}/projects/${PROJECT_ID}/overrides`,
      );

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ─── GET / — List tenant configs ───────────────────────────────────────

  describe('GET / (list)', () => {
    test('returns resolved config when tenantId filter is provided', async () => {
      const res = await request(app).get(`/api/platform/admin/tenant-config?tenantId=${TENANT_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.configs).toHaveLength(1);
      expect(res.body.configs[0].tenantId).toBe(TENANT_ID);
      expect(mockGetConfigAsync).toHaveBeenCalledWith(TENANT_ID);
    });

    test('returns paginated list of subscriptions with overrides', async () => {
      const subscriptions = [
        {
          tenantId: 'tenant-1',
          planTier: 'TEAM',
          tenantQuotas: [
            {
              tenantId: 'tenant-1',
              allocatedLimits: { maxConcurrentSessions: 100 },
              projectQuotas: [],
            },
          ],
        },
        {
          tenantId: 'tenant-2',
          planTier: 'BUSINESS',
          tenantQuotas: [
            { tenantId: 'tenant-2', allocatedLimits: {}, projectQuotas: [{ projectId: 'p-1' }] },
          ],
        },
      ];

      mockSubscriptionFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          skip: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              lean: vi.fn().mockReturnValue({
                exec: vi.fn().mockResolvedValue(subscriptions),
              }),
            }),
          }),
        }),
      });

      mockSubscriptionCountDocuments.mockReturnValue({
        exec: vi.fn().mockResolvedValue(2),
      });

      const res = await request(app).get('/api/platform/admin/tenant-config?page=1&limit=10');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.configs).toHaveLength(2);
      expect(res.body.configs[0].tenantId).toBe('tenant-1');
      expect(res.body.configs[0].hasOverrides).toBe(true);
      expect(res.body.configs[1].tenantId).toBe('tenant-2');
      expect(res.body.configs[1].hasOverrides).toBe(false);
      expect(res.body.configs[1].projectQuotaCount).toBe(1);
      expect(res.body.pagination.total).toBe(2);
    });
  });

  // ─── Audit Logging ─────────────────────────────────────────────────────

  describe('Audit Logging', () => {
    test('all mutation endpoints log with platform-admin: prefix', async () => {
      // PUT tenant overrides
      mockSubscriptionFindOneAndUpdate.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: 'sub-1', tenantId: TENANT_ID }),
      });

      await request(app)
        .put(`/api/platform/admin/tenant-config/${TENANT_ID}/overrides`)
        .send({ maxConcurrentSessions: 200 });

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringMatching(/^platform-admin:/),
        }),
      );

      mockWriteAuditLog.mockClear();

      // DELETE tenant overrides
      await request(app).delete(`/api/platform/admin/tenant-config/${TENANT_ID}/overrides`);

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringMatching(/^platform-admin:/),
        }),
      );

      mockWriteAuditLog.mockClear();

      // PUT project overrides
      mockSubscriptionFindOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: 'sub-1',
          tenantId: TENANT_ID,
          tenantQuotas: [{ tenantId: TENANT_ID, projectQuotas: [] }],
        }),
      });

      await request(app)
        .put(`/api/platform/admin/tenant-config/${TENANT_ID}/projects/${PROJECT_ID}/overrides`)
        .send({ maxAgentsPerProject: 50 });

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringMatching(/^platform-admin:/),
        }),
      );

      mockWriteAuditLog.mockClear();

      // DELETE project overrides
      await request(app).delete(
        `/api/platform/admin/tenant-config/${TENANT_ID}/projects/${PROJECT_ID}/overrides`,
      );

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringMatching(/^platform-admin:/),
        }),
      );
    });
  });

  // ─── Auth: Non-admin rejection ─────────────────────────────────────────

  describe('Auth (non-admin rejection)', () => {
    test('rejects requests when isSuperAdmin is false', async () => {
      // Create a separate app that uses the real requirePlatformAdmin middleware
      // but with isSuperAdmin: false
      const nonAdminApp = express();
      nonAdminApp.use(express.json());

      // Override auth middleware to set isSuperAdmin: false
      nonAdminApp.use((_req: any, _res: any, next: any) => {
        _req.tenantContext = {
          userId: 'regular-user',
          tenantId: 'some-tenant',
          isSuperAdmin: false,
          permissions: [],
        };
        next();
      });

      // Import the real requirePlatformAdmin from the actual module
      const shared =
        await vi.importActual<typeof import('@agent-platform/shared')>('@agent-platform/shared');

      const restrictedRouter = express.Router();
      restrictedRouter.use(shared.requirePlatformAdmin());
      restrictedRouter.get('/test', (_req, res) => {
        res.json({ success: true });
      });

      nonAdminApp.use('/admin', restrictedRouter);

      const res = await request(nonAdminApp).get('/admin/test');

      expect(res.status).toBe(403);
    });
  });
});
