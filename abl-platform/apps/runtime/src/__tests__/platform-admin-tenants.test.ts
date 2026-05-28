/**
 * Platform Admin Tenants API Tests
 *
 * Verifies endpoints for listing, viewing, and managing tenants
 * through the platform admin API.
 *
 * Covers:
 * 1. GET / — returns paginated tenant list with subscription planTier and member count
 * 2. GET / — supports status filter, planTier filter, and search (name) filter
 * 3. GET /:tenantId — returns tenant detail with subscription and member count
 * 4. GET /:tenantId — returns 404 for unknown tenant
 * 5. PATCH /:tenantId/status — changes status and writes audit log
 * 6. PATCH /:tenantId/status — returns 400 for invalid status value
 * 7. Auth: standard middleware chain test
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

vi.mock('../services/tenant-config.js', () => ({
  getTenantConfigService: vi.fn(() => ({
    invalidateCache: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@agent-platform/shared/repos', () => ({
  withTransaction: vi.fn(async (fn: (session: null) => Promise<unknown>) => fn(null)),
}));

// Mock database models
const mockTenantFind = vi.fn();
const mockTenantFindOne = vi.fn();
const mockTenantFindOneAndUpdate = vi.fn();
const mockTenantCountDocuments = vi.fn();
const mockTenantCreate = vi.fn();

const mockSubscriptionFind = vi.fn();
const mockSubscriptionFindOne = vi.fn();
const mockSubscriptionFindOneAndUpdate = vi.fn();
const mockSubscriptionCreate = vi.fn();

const mockTenantMemberCountDocuments = vi.fn();
const mockTenantMemberAggregate = vi.fn();
const mockTenantMemberCreate = vi.fn();
const mockSeedTenantBootstrapDefaults = vi.fn();
const mockSeedTenantPipelineConfigs = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Tenant: {
    find: (...args: any[]) => mockTenantFind(...args),
    findOne: (...args: any[]) => mockTenantFindOne(...args),
    findOneAndUpdate: (...args: any[]) => mockTenantFindOneAndUpdate(...args),
    countDocuments: (...args: any[]) => mockTenantCountDocuments(...args),
    create: (...args: any[]) => mockTenantCreate(...args),
  },
  Subscription: {
    find: (...args: any[]) => mockSubscriptionFind(...args),
    findOne: (...args: any[]) => mockSubscriptionFindOne(...args),
    findOneAndUpdate: (...args: any[]) => mockSubscriptionFindOneAndUpdate(...args),
    create: (...args: any[]) => mockSubscriptionCreate(...args),
  },
  TenantMember: {
    countDocuments: (...args: any[]) => mockTenantMemberCountDocuments(...args),
    aggregate: (...args: any[]) => mockTenantMemberAggregate(...args),
    create: (...args: any[]) => mockTenantMemberCreate(...args),
  },
}));

vi.mock('@agent-platform/database', () => ({
  seedTenantBootstrapDefaults: (...args: any[]) => mockSeedTenantBootstrapDefaults(...args),
}));

vi.mock('@agent-platform/pipeline-engine', () => ({
  seedTenantPipelineConfigs: (...args: any[]) => mockSeedTenantPipelineConfigs(...args),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';

// =============================================================================
// HELPERS
// =============================================================================

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
  return app;
}

const TENANT_ID = 'tenant-abc';

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

function buildTenant(id: string, overrides: Record<string, any> = {}) {
  return {
    _id: id,
    name: `Tenant ${id}`,
    slug: `tenant-${id}`,
    organizationId: null,
    ownerId: 'owner-1',
    retentionDays: 7,
    settings: null,
    status: 'active',
    llmPolicy: null,
    _v: 1,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Platform Admin Tenants API', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockSeedTenantBootstrapDefaults.mockResolvedValue({ roleCount: 5, policyEnsured: true });
    mockSeedTenantPipelineConfigs.mockResolvedValue(9);
  });

  // ─── GET / — List tenants ─────────────────────────────────────────────

  describe('GET / (list)', () => {
    test('returns paginated tenant list with subscription planTier and member count', async () => {
      const tenants = [buildTenant('tenant-1'), buildTenant('tenant-2', { name: 'Second Tenant' })];

      // Tenant.find
      mockTenantFind.mockReturnValue(chainable(tenants));
      // Tenant.countDocuments
      mockTenantCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(2) });

      // Subscription.find for enrichment
      mockSubscriptionFind.mockReturnValue(
        chainable([
          { tenantId: 'tenant-1', planTier: 'TEAM' },
          { tenantId: 'tenant-2', planTier: 'BUSINESS' },
        ]),
      );

      // TenantMember.aggregate for member counts
      mockTenantMemberAggregate.mockReturnValue({
        exec: vi.fn().mockResolvedValue([
          { _id: 'tenant-1', count: 5 },
          { _id: 'tenant-2', count: 12 },
        ]),
      });

      const res = await request(app).get('/api/platform/admin/tenants');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.tenants).toHaveLength(2);
      expect(res.body.tenants[0]._id).toBe('tenant-1');
      expect(res.body.tenants[0].planTier).toBe('TEAM');
      expect(res.body.tenants[0].memberCount).toBe(5);
      expect(res.body.tenants[1]._id).toBe('tenant-2');
      expect(res.body.tenants[1].planTier).toBe('BUSINESS');
      expect(res.body.tenants[1].memberCount).toBe(12);
      expect(res.body.pagination).toEqual({
        page: 1,
        limit: 25,
        total: 2,
        totalPages: 1,
      });
    });

    test('supports status filter', async () => {
      mockTenantFind.mockReturnValue(chainable([buildTenant('tenant-1', { status: 'suspended' })]));
      mockTenantCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(1) });
      mockSubscriptionFind.mockReturnValue(chainable([]));
      mockTenantMemberAggregate.mockReturnValue({ exec: vi.fn().mockResolvedValue([]) });

      const res = await request(app).get('/api/platform/admin/tenants?status=suspended');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Verify the filter was passed to Tenant.find
      expect(mockTenantFind).toHaveBeenCalledWith(expect.objectContaining({ status: 'suspended' }));
    });

    test('supports planTier filter', async () => {
      const tenants = [buildTenant('tenant-1'), buildTenant('tenant-2')];

      mockTenantFind.mockReturnValue(chainable(tenants));
      mockTenantCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(2) });
      mockSubscriptionFind.mockReturnValue(
        chainable([
          { tenantId: 'tenant-1', planTier: 'TEAM' },
          { tenantId: 'tenant-2', planTier: 'BUSINESS' },
        ]),
      );
      mockTenantMemberAggregate.mockReturnValue({ exec: vi.fn().mockResolvedValue([]) });

      const res = await request(app).get('/api/platform/admin/tenants?planTier=TEAM');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Only TEAM tenant should be returned after post-query filter
      expect(res.body.tenants).toHaveLength(1);
      expect(res.body.tenants[0]._id).toBe('tenant-1');
      expect(res.body.tenants[0].planTier).toBe('TEAM');
    });

    test('supports search (name) filter', async () => {
      mockTenantFind.mockReturnValue(chainable([buildTenant('tenant-1', { name: 'Acme Corp' })]));
      mockTenantCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(1) });
      mockSubscriptionFind.mockReturnValue(chainable([]));
      mockTenantMemberAggregate.mockReturnValue({ exec: vi.fn().mockResolvedValue([]) });

      const res = await request(app).get('/api/platform/admin/tenants?search=Acme');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Verify the name regex filter was passed to Tenant.find
      expect(mockTenantFind).toHaveBeenCalledWith(
        expect.objectContaining({
          name: { $regex: 'Acme', $options: 'i' },
        }),
      );
    });

    test('returns null planTier and 0 memberCount when no subscription or members', async () => {
      mockTenantFind.mockReturnValue(chainable([buildTenant('tenant-1')]));
      mockTenantCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(1) });
      mockSubscriptionFind.mockReturnValue(chainable([]));
      mockTenantMemberAggregate.mockReturnValue({ exec: vi.fn().mockResolvedValue([]) });

      const res = await request(app).get('/api/platform/admin/tenants');

      expect(res.status).toBe(200);
      expect(res.body.tenants[0].planTier).toBeNull();
      expect(res.body.tenants[0].memberCount).toBe(0);
    });
  });

  describe('POST / (create)', () => {
    test('creates tenant, subscription, and tenant operational defaults', async () => {
      mockTenantFindOne.mockReturnValue(chainable(null));
      mockTenantCreate.mockResolvedValue([
        {
          _id: 'tenant-created-1',
          toObject: () =>
            buildTenant('tenant-created-1', { slug: 'new-tenant', name: 'New Tenant' }),
        },
      ]);
      mockTenantMemberCreate.mockResolvedValue([{ _id: 'member-1' }]);
      mockSubscriptionCreate.mockResolvedValue([{ _id: 'sub-1' }]);

      const res = await request(app).post('/api/platform/admin/tenants').send({
        name: 'New Tenant',
        slug: 'new-tenant',
        planTier: 'TEAM',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.tenant._id).toBe('tenant-created-1');
      expect(res.body.tenant.planTier).toBe('TEAM');
      expect(mockSeedTenantBootstrapDefaults).toHaveBeenCalledWith({
        tenantId: 'tenant-created-1',
        createdBy: 'admin-user-1',
        session: null,
      });
      expect(mockSeedTenantPipelineConfigs).toHaveBeenCalledWith({
        tenantId: 'tenant-created-1',
        createdBy: 'admin-user-1',
        session: null,
      });
    });

    test('returns 409 when slug already exists', async () => {
      mockTenantFindOne.mockReturnValue(
        chainable(buildTenant('tenant-existing', { slug: 'existing-tenant' })),
      );

      const res = await request(app).post('/api/platform/admin/tenants').send({
        name: 'Existing Tenant',
        slug: 'existing-tenant',
        planTier: 'FREE',
      });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(mockTenantCreate).not.toHaveBeenCalled();
      expect(mockSeedTenantBootstrapDefaults).not.toHaveBeenCalled();
      expect(mockSeedTenantPipelineConfigs).not.toHaveBeenCalled();
    });
  });

  // ─── GET /:tenantId — Tenant detail ───────────────────────────────────

  describe('GET /:tenantId', () => {
    test('returns tenant detail with subscription and member count', async () => {
      const tenant = buildTenant(TENANT_ID);
      const subscription = {
        planTier: 'TEAM',
        tenantId: TENANT_ID,
        billingCycle: 'monthly',
        billingStartDate: new Date('2026-01-01'),
        billingEndDate: null,
        entitlements: ['custom-models'],
      };

      mockTenantFindOne.mockReturnValue(chainable(tenant));
      mockSubscriptionFindOne.mockReturnValue(chainable(subscription));
      mockTenantMemberCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(8) });

      const res = await request(app).get(`/api/platform/admin/tenants/${TENANT_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.tenant._id).toBe(TENANT_ID);
      expect(res.body.subscription.planTier).toBe('TEAM');
      expect(res.body.memberCount).toBe(8);
    });

    test('returns 404 for unknown tenant', async () => {
      mockTenantFindOne.mockReturnValue(chainable(null));
      mockSubscriptionFindOne.mockReturnValue(chainable(null));
      mockTenantMemberCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(0) });

      const res = await request(app).get('/api/platform/admin/tenants/unknown-tenant');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Tenant not found');
    });

    test('returns null subscription when no active subscription exists', async () => {
      mockTenantFindOne.mockReturnValue(chainable(buildTenant(TENANT_ID)));
      mockSubscriptionFindOne.mockReturnValue(chainable(null));
      mockTenantMemberCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(0) });

      const res = await request(app).get(`/api/platform/admin/tenants/${TENANT_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.subscription).toBeNull();
      expect(res.body.memberCount).toBe(0);
    });
  });

  // ─── PATCH /:tenantId/status ──────────────────────────────────────────

  describe('PATCH /:tenantId/status', () => {
    test('changes status and writes audit log', async () => {
      const updatedTenant = buildTenant(TENANT_ID, { status: 'suspended' });
      mockTenantFindOneAndUpdate.mockReturnValue(chainable(updatedTenant));

      const res = await request(app)
        .patch(`/api/platform/admin/tenants/${TENANT_ID}/status`)
        .send({ status: 'suspended' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.tenant.status).toBe('suspended');

      // Verify findOneAndUpdate called with correct args
      expect(mockTenantFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: TENANT_ID },
        { status: 'suspended' },
        { new: true },
      );

      // Verify audit log
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:change-tenant-status',
          userId: 'admin-user-1',
          tenantId: TENANT_ID,
          metadata: expect.objectContaining({ status: 'suspended' }),
        }),
      );
    });

    test('returns 400 for invalid status value', async () => {
      const res = await request(app)
        .patch(`/api/platform/admin/tenants/${TENANT_ID}/status`)
        .send({ status: 'invalid-status' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid status value');
      expect(res.body.details).toBeDefined();
    });

    test('returns 400 when status field is missing', async () => {
      const res = await request(app)
        .patch(`/api/platform/admin/tenants/${TENANT_ID}/status`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    test('returns 404 when tenant not found', async () => {
      mockTenantFindOneAndUpdate.mockReturnValue(chainable(null));

      const res = await request(app)
        .patch('/api/platform/admin/tenants/unknown-tenant/status')
        .send({ status: 'archived' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Tenant not found');
    });

    test('accepts all valid status values', async () => {
      for (const status of ['active', 'suspended', 'archived']) {
        vi.clearAllMocks();
        mockTenantFindOneAndUpdate.mockReturnValue(chainable(buildTenant(TENANT_ID, { status })));

        const res = await request(app)
          .patch(`/api/platform/admin/tenants/${TENANT_ID}/status`)
          .send({ status });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.tenant.status).toBe(status);
      }
    });
  });

  // ─── PATCH /:tenantId/subscription ───────────────────────────────────

  describe('PATCH /:tenantId/subscription', () => {
    test('creates subscription when none exists (upsert) and writes audit log', async () => {
      const subscription = {
        _id: 'sub-1',
        tenantId: TENANT_ID,
        planTier: 'ENTERPRISE',
        status: 'active',
        billingCycle: 'monthly',
      };

      mockTenantFindOne.mockReturnValue(chainable(buildTenant(TENANT_ID)));
      mockSubscriptionFindOneAndUpdate.mockReturnValue(chainable(subscription));

      const res = await request(app)
        .patch(`/api/platform/admin/tenants/${TENANT_ID}/subscription`)
        .send({ planTier: 'ENTERPRISE' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.subscription.planTier).toBe('ENTERPRISE');

      // Verify upsert call
      expect(mockSubscriptionFindOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: TENANT_ID, status: 'active' },
        expect.objectContaining({
          $set: expect.objectContaining({ planTier: 'ENTERPRISE' }),
          $setOnInsert: expect.objectContaining({ tenantId: TENANT_ID, status: 'active' }),
        }),
        { upsert: true, new: true },
      );

      // Verify audit log
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:change-subscription',
          userId: 'admin-user-1',
          tenantId: TENANT_ID,
          metadata: expect.objectContaining({ planTier: 'ENTERPRISE' }),
        }),
      );
    });

    test('updates existing subscription planTier', async () => {
      const subscription = {
        _id: 'sub-1',
        tenantId: TENANT_ID,
        planTier: 'FREE',
        status: 'active',
      };

      mockTenantFindOne.mockReturnValue(chainable(buildTenant(TENANT_ID)));
      mockSubscriptionFindOneAndUpdate.mockReturnValue(chainable(subscription));

      const res = await request(app)
        .patch(`/api/platform/admin/tenants/${TENANT_ID}/subscription`)
        .send({ planTier: 'FREE' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.subscription.planTier).toBe('FREE');
    });

    test('returns 400 for invalid plan tier', async () => {
      const res = await request(app)
        .patch(`/api/platform/admin/tenants/${TENANT_ID}/subscription`)
        .send({ planTier: 'INVALID' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid plan tier');
      expect(res.body.details).toBeDefined();
    });

    test('returns 400 when planTier field is missing', async () => {
      const res = await request(app)
        .patch(`/api/platform/admin/tenants/${TENANT_ID}/subscription`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    test('returns 404 when tenant not found', async () => {
      mockTenantFindOne.mockReturnValue(chainable(null));

      const res = await request(app)
        .patch(`/api/platform/admin/tenants/${TENANT_ID}/subscription`)
        .send({ planTier: 'TEAM' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Tenant not found');
    });

    test('accepts all valid plan tier values', async () => {
      for (const planTier of ['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE']) {
        vi.clearAllMocks();
        mockTenantFindOne.mockReturnValue(chainable(buildTenant(TENANT_ID)));
        mockSubscriptionFindOneAndUpdate.mockReturnValue(
          chainable({ _id: 'sub-1', tenantId: TENANT_ID, planTier, status: 'active' }),
        );

        const res = await request(app)
          .patch(`/api/platform/admin/tenants/${TENANT_ID}/subscription`)
          .send({ planTier });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.subscription.planTier).toBe(planTier);
      }
    });
  });

  // ─── Audit Logging ────────────────────────────────────────────────────

  describe('Audit Logging', () => {
    test('mutation endpoints log with platform-admin: prefix', async () => {
      mockTenantFindOneAndUpdate.mockReturnValue(
        chainable(buildTenant(TENANT_ID, { status: 'suspended' })),
      );

      await request(app)
        .patch(`/api/platform/admin/tenants/${TENANT_ID}/status`)
        .send({ status: 'suspended' });

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringMatching(/^platform-admin:/),
        }),
      );
    });
  });

  // ─── Auth: Non-admin rejection ────────────────────────────────────────

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
