/**
 * Platform Admin Deals API Tests
 *
 * Verifies endpoints for managing deals, credit ledgers, and billing
 * line items through the platform admin API.
 *
 * Covers:
 * 1. GET / — returns paginated deal list with filters
 * 2. POST / — creates a deal with validation
 * 3. GET /:id — returns deal detail
 * 4. GET /:id — returns 404 for unknown deal
 * 5. PATCH /:id — updates deal fields
 * 6. POST /:id/assign — assigns deal to organization
 * 7. GET /:id/credits — gets or creates credit ledger
 * 8. POST /:id/credits/topup — applies credit top-up
 * 9. GET /:id/line-items — lists billing line items
 * 10. POST /:id/line-items — creates billing line item
 * 11. Validation errors for missing required fields
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

// Mock database models
const mockDealFind = vi.fn();
const mockDealFindOne = vi.fn();
const mockDealFindOneAndUpdate = vi.fn();
const mockDealCountDocuments = vi.fn();
const mockDealCreate = vi.fn();

const mockCreditLedgerFindOne = vi.fn();
const mockCreditLedgerFindOneAndUpdate = vi.fn();
const mockCreditLedgerCreate = vi.fn();

const mockBillingLineItemFind = vi.fn();
const mockBillingLineItemCountDocuments = vi.fn();
const mockBillingLineItemCreate = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Deal: {
    find: (...args: any[]) => mockDealFind(...args),
    findOne: (...args: any[]) => mockDealFindOne(...args),
    findOneAndUpdate: (...args: any[]) => mockDealFindOneAndUpdate(...args),
    countDocuments: (...args: any[]) => mockDealCountDocuments(...args),
    create: (...args: any[]) => mockDealCreate(...args),
  },
  CreditLedger: {
    findOne: (...args: any[]) => mockCreditLedgerFindOne(...args),
    findOneAndUpdate: (...args: any[]) => mockCreditLedgerFindOneAndUpdate(...args),
    create: (...args: any[]) => mockCreditLedgerCreate(...args),
  },
  BillingLineItem: {
    find: (...args: any[]) => mockBillingLineItemFind(...args),
    countDocuments: (...args: any[]) => mockBillingLineItemCountDocuments(...args),
    create: (...args: any[]) => mockBillingLineItemCreate(...args),
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import platformAdminDealsRouter from '../routes/platform-admin-deals.js';

// =============================================================================
// HELPERS
// =============================================================================

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/platform/admin/deals', platformAdminDealsRouter);
  return app;
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

const SAMPLE_CREDIT_ALLOTMENT = {
  totalCredits: 10000,
  sharedPoolCredits: 5000,
  featureCredits: { llm: 3000, search: 2000 },
  rolloverPolicy: 'none' as const,
};

function buildDeal(id: string, overrides: Record<string, any> = {}) {
  return {
    _id: id,
    organizationId: 'org-1',
    name: `Deal ${id}`,
    status: 'active',
    scope: 'organization',
    aggregationMode: 'additive',
    phases: [],
    overagePolicy: 'hard_stop',
    overageAlertThresholds: [80, 90],
    creditAllotment: SAMPLE_CREDIT_ALLOTMENT,
    features: ['llm', 'search'],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function buildCreateDealPayload(overrides: Record<string, any> = {}) {
  return {
    organizationId: 'org-1',
    name: 'Enterprise Deal',
    status: 'active',
    scope: 'organization',
    aggregationMode: 'additive',
    overagePolicy: 'hard_stop',
    creditAllotment: SAMPLE_CREDIT_ALLOTMENT,
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Platform Admin Deals API', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  // ─── GET / — List deals ─────────────────────────────────────────────────

  describe('GET / (list)', () => {
    test('returns paginated deal list', async () => {
      const deals = [buildDeal('deal-1'), buildDeal('deal-2', { name: 'Second Deal' })];

      mockDealFind.mockReturnValue(chainable(deals));
      mockDealCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(2) });

      const res = await request(app).get('/api/platform/admin/deals');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deals).toHaveLength(2);
      expect(res.body.deals[0]._id).toBe('deal-1');
      expect(res.body.pagination).toEqual({
        page: 1,
        limit: 25,
        total: 2,
        totalPages: 1,
      });
    });

    test('supports organizationId filter', async () => {
      mockDealFind.mockReturnValue(chainable([buildDeal('deal-1')]));
      mockDealCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(1) });

      const res = await request(app).get('/api/platform/admin/deals?organizationId=org-1');

      expect(res.status).toBe(200);
      expect(mockDealFind).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-1' }),
      );
    });

    test('supports status filter', async () => {
      mockDealFind.mockReturnValue(chainable([]));
      mockDealCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(0) });

      const res = await request(app).get('/api/platform/admin/deals?status=paused');

      expect(res.status).toBe(200);
      expect(mockDealFind).toHaveBeenCalledWith(expect.objectContaining({ status: 'paused' }));
    });

    test('supports scope filter', async () => {
      mockDealFind.mockReturnValue(chainable([]));
      mockDealCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(0) });

      const res = await request(app).get('/api/platform/admin/deals?scope=project');

      expect(res.status).toBe(200);
      expect(mockDealFind).toHaveBeenCalledWith(expect.objectContaining({ scope: 'project' }));
    });
  });

  // ─── POST / — Create deal ──────────────────────────────────────────────

  describe('POST / (create)', () => {
    test('creates a deal with valid data', async () => {
      const payload = buildCreateDealPayload();
      const createdDeal = buildDeal('deal-new', { name: payload.name });

      mockDealCreate.mockResolvedValue(createdDeal);

      const res = await request(app).post('/api/platform/admin/deals').send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.deal._id).toBe('deal-new');
      expect(mockDealCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Enterprise Deal' }),
      );
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'platform-admin:create-deal' }),
      );
    });

    test('returns 400 for missing required fields', async () => {
      const res = await request(app).post('/api/platform/admin/deals').send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid deal data');
      expect(res.body.details).toBeDefined();
    });

    test('returns 400 for invalid status value', async () => {
      const payload = buildCreateDealPayload({ status: 'invalid_status' });

      const res = await request(app).post('/api/platform/admin/deals').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ─── GET /:id — Deal detail ────────────────────────────────────────────

  describe('GET /:id (detail)', () => {
    test('returns deal detail', async () => {
      const deal = buildDeal('deal-1');
      mockDealFindOne.mockReturnValue(chainable(deal));

      const res = await request(app).get('/api/platform/admin/deals/deal-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deal._id).toBe('deal-1');
    });

    test('returns 404 for unknown deal', async () => {
      mockDealFindOne.mockReturnValue(chainable(null));

      const res = await request(app).get('/api/platform/admin/deals/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Deal not found');
    });
  });

  // ─── PATCH /:id — Update deal ──────────────────────────────────────────

  describe('PATCH /:id (update)', () => {
    test('updates deal fields', async () => {
      const updatedDeal = buildDeal('deal-1', { status: 'paused' });
      mockDealFindOneAndUpdate.mockReturnValue(chainable(updatedDeal));

      const res = await request(app)
        .patch('/api/platform/admin/deals/deal-1')
        .send({ status: 'paused' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deal.status).toBe('paused');
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'platform-admin:update-deal' }),
      );
    });

    test('returns 404 for unknown deal', async () => {
      mockDealFindOneAndUpdate.mockReturnValue(chainable(null));

      const res = await request(app)
        .patch('/api/platform/admin/deals/nonexistent')
        .send({ status: 'paused' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('returns 400 for invalid update data', async () => {
      const res = await request(app)
        .patch('/api/platform/admin/deals/deal-1')
        .send({ status: 'totally_invalid' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid update data');
    });
  });

  // ─── POST /:id/assign — Assign deal ────────────────────────────────────

  describe('POST /:id/assign', () => {
    test('assigns deal to organization', async () => {
      const assignedDeal = buildDeal('deal-1', { organizationId: 'org-new' });
      mockDealFindOneAndUpdate.mockReturnValue(chainable(assignedDeal));

      const res = await request(app)
        .post('/api/platform/admin/deals/deal-1/assign')
        .send({ organizationId: 'org-new' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deal.organizationId).toBe('org-new');
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'platform-admin:assign-deal' }),
      );
    });

    test('returns 404 for unknown deal', async () => {
      mockDealFindOneAndUpdate.mockReturnValue(chainable(null));

      const res = await request(app)
        .post('/api/platform/admin/deals/nonexistent/assign')
        .send({ organizationId: 'org-1' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('returns 400 for missing organizationId', async () => {
      const res = await request(app).post('/api/platform/admin/deals/deal-1/assign').send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid assignment data');
    });
  });

  // ─── GET /:id/credits — Credit ledger ──────────────────────────────────

  describe('GET /:id/credits', () => {
    test('returns existing credit ledger', async () => {
      const deal = buildDeal('deal-1');
      const ledger = {
        _id: 'ledger-1',
        dealId: 'deal-1',
        organizationId: 'org-1',
        totalAllocated: 10000,
        totalConsumed: 2000,
        entries: [],
      };

      mockDealFindOne.mockReturnValue(chainable(deal));
      mockCreditLedgerFindOne.mockReturnValue(chainable(ledger));

      const res = await request(app).get('/api/platform/admin/deals/deal-1/credits');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.ledger.dealId).toBe('deal-1');
      expect(res.body.ledger.totalAllocated).toBe(10000);
    });

    test('creates ledger if none exists for current period', async () => {
      const deal = buildDeal('deal-1');
      const createdLedger = {
        _id: 'ledger-new',
        dealId: 'deal-1',
        organizationId: 'org-1',
        totalAllocated: 10000,
        totalConsumed: 0,
        entries: [],
        toObject: function () {
          return { ...this, toObject: undefined };
        },
      };

      mockDealFindOne.mockReturnValue(chainable(deal));
      mockCreditLedgerFindOne.mockReturnValue(chainable(null));
      mockCreditLedgerCreate.mockResolvedValue(createdLedger);

      const res = await request(app).get('/api/platform/admin/deals/deal-1/credits');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockCreditLedgerCreate).toHaveBeenCalled();
    });

    test('returns 404 if deal not found', async () => {
      mockDealFindOne.mockReturnValue(chainable(null));

      const res = await request(app).get('/api/platform/admin/deals/nonexistent/credits');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ─── POST /:id/credits/topup — Credit top-up ──────────────────────────

  describe('POST /:id/credits/topup', () => {
    test('applies credit top-up', async () => {
      const deal = buildDeal('deal-1');
      const updatedLedger = {
        _id: 'ledger-1',
        dealId: 'deal-1',
        totalAllocated: 11000,
        entries: [{ feature: 'llm', credits: 1000, source: 'topup' }],
      };

      mockDealFindOne.mockReturnValue(chainable(deal));
      mockCreditLedgerFindOneAndUpdate.mockReturnValue(chainable(updatedLedger));
      mockBillingLineItemCreate.mockResolvedValue({ _id: 'li-1', category: 'credit_topup' });

      const res = await request(app)
        .post('/api/platform/admin/deals/deal-1/credits/topup')
        .send({ feature: 'llm', credits: 1000 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.ledger.totalAllocated).toBe(11000);
      expect(mockBillingLineItemCreate).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'credit_topup' }),
      );
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'platform-admin:credit-topup' }),
      );
    });

    test('returns 404 if deal not found', async () => {
      mockDealFindOne.mockReturnValue(chainable(null));

      const res = await request(app)
        .post('/api/platform/admin/deals/nonexistent/credits/topup')
        .send({ feature: 'llm', credits: 1000 });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('returns 400 for invalid top-up data', async () => {
      const res = await request(app)
        .post('/api/platform/admin/deals/deal-1/credits/topup')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid top-up data');
    });

    test('returns 400 for negative credits', async () => {
      const res = await request(app)
        .post('/api/platform/admin/deals/deal-1/credits/topup')
        .send({ feature: 'llm', credits: -100 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ─── GET /:id/line-items — List line items ─────────────────────────────

  describe('GET /:id/line-items', () => {
    test('returns paginated line items', async () => {
      const deal = buildDeal('deal-1');
      const lineItems = [
        { _id: 'li-1', dealId: 'deal-1', category: 'base', totalAmount: 500 },
        { _id: 'li-2', dealId: 'deal-1', category: 'overage', totalAmount: 200 },
      ];

      mockDealFindOne.mockReturnValue(chainable(deal));
      mockBillingLineItemFind.mockReturnValue(chainable(lineItems));
      mockBillingLineItemCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(2) });

      const res = await request(app).get('/api/platform/admin/deals/deal-1/line-items');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.lineItems).toHaveLength(2);
      expect(res.body.pagination.total).toBe(2);
    });

    test('supports periodLabel filter', async () => {
      const deal = buildDeal('deal-1');
      mockDealFindOne.mockReturnValue(chainable(deal));
      mockBillingLineItemFind.mockReturnValue(chainable([]));
      mockBillingLineItemCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(0) });

      const res = await request(app).get(
        '/api/platform/admin/deals/deal-1/line-items?periodLabel=2026-03',
      );

      expect(res.status).toBe(200);
      expect(mockBillingLineItemFind).toHaveBeenCalledWith(
        expect.objectContaining({ periodLabel: '2026-03' }),
      );
    });

    test('supports category filter', async () => {
      const deal = buildDeal('deal-1');
      mockDealFindOne.mockReturnValue(chainable(deal));
      mockBillingLineItemFind.mockReturnValue(chainable([]));
      mockBillingLineItemCountDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(0) });

      const res = await request(app).get(
        '/api/platform/admin/deals/deal-1/line-items?category=overage',
      );

      expect(res.status).toBe(200);
      expect(mockBillingLineItemFind).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'overage' }),
      );
    });

    test('returns 404 if deal not found', async () => {
      mockDealFindOne.mockReturnValue(chainable(null));

      const res = await request(app).get('/api/platform/admin/deals/nonexistent/line-items');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ─── POST /:id/line-items — Create line item ──────────────────────────

  describe('POST /:id/line-items', () => {
    test('creates a billing line item', async () => {
      const deal = buildDeal('deal-1');
      const createdItem = {
        _id: 'li-new',
        dealId: 'deal-1',
        periodLabel: '2026-03',
        description: 'Monthly base fee',
        quantity: 1,
        unitPrice: 500,
        totalAmount: 500,
        category: 'base',
        invoiced: false,
      };

      mockDealFindOne.mockReturnValue(chainable(deal));
      mockBillingLineItemCreate.mockResolvedValue(createdItem);

      const res = await request(app).post('/api/platform/admin/deals/deal-1/line-items').send({
        periodLabel: '2026-03',
        description: 'Monthly base fee',
        quantity: 1,
        unitPrice: 500,
        totalAmount: 500,
        category: 'base',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.lineItem._id).toBe('li-new');
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'platform-admin:create-line-item' }),
      );
    });

    test('returns 404 if deal not found', async () => {
      mockDealFindOne.mockReturnValue(chainable(null));

      const res = await request(app).post('/api/platform/admin/deals/nonexistent/line-items').send({
        periodLabel: '2026-03',
        description: 'Test',
        quantity: 1,
        unitPrice: 100,
        totalAmount: 100,
        category: 'base',
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('returns 400 for missing required fields', async () => {
      const res = await request(app).post('/api/platform/admin/deals/deal-1/line-items').send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid line item data');
    });

    test('returns 400 for invalid category', async () => {
      const res = await request(app).post('/api/platform/admin/deals/deal-1/line-items').send({
        periodLabel: '2026-03',
        description: 'Test',
        quantity: 1,
        unitPrice: 100,
        totalAmount: 100,
        category: 'invalid_category',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
