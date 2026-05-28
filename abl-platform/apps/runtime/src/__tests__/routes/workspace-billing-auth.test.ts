import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BILLING_READ_PERMISSION } from '@agent-platform/shared-auth';
import { injectTenantContext, makeTenantContext } from '../helpers/auth-context.js';

const mockTenantFindOne = vi.fn();
const mockDealFind = vi.fn();
const mockCreditLedgerFind = vi.fn();
const mockSubscriptionFindOne = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../../middleware/feature-gate.js', () => ({
  PLAN_FEATURES: {
    FREE: [],
    PRO: ['sso'],
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/database/models', () => ({
  Tenant: {
    findOne: (...args: unknown[]) => mockTenantFindOne(...args),
  },
  Deal: {
    find: (...args: unknown[]) => mockDealFind(...args),
  },
  CreditLedger: {
    find: (...args: unknown[]) => mockCreditLedgerFind(...args),
  },
  Subscription: {
    findOne: (...args: unknown[]) => mockSubscriptionFindOne(...args),
  },
}));

import workspaceBillingRouter from '../../routes/workspace-billing.js';

type BillingRole = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER';

function queryResult<T>(value: T) {
  const query = {
    sort: vi.fn(() => query),
    lean: vi.fn(() => query),
    exec: vi.fn().mockResolvedValue(value),
  };

  return query;
}

function createApp(role?: BillingRole) {
  const app = express();
  app.use(express.json());

  if (role) {
    const tenantContext = makeTenantContext('tenant-1', 'user-1', role);
    app.use(injectTenantContext(tenantContext));
  }

  app.use('/api/tenants/:tenantId/billing', workspaceBillingRouter);
  return app;
}

describe('Workspace billing route authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTenantFindOne.mockImplementation(() =>
      queryResult({ _id: 'tenant-1', organizationId: 'org-1' }),
    );
    mockDealFind.mockImplementation(() => queryResult([{ _id: 'deal-1', status: 'active' }]));
    mockCreditLedgerFind.mockImplementation(() => queryResult([]));
    mockSubscriptionFindOne.mockImplementation(() =>
      queryResult({ _id: 'subscription-1', planTier: 'PRO', status: 'active' }),
    );
  });

  it.each(['OWNER', 'ADMIN'] as const)(
    'allows %s to access billing data and submit upgrade requests',
    async (role) => {
      const app = createApp(role);

      await request(app)
        .get('/api/tenants/tenant-1/billing/deals')
        .expect(200, {
          success: true,
          deals: [{ _id: 'deal-1', status: 'active' }],
        });

      await request(app)
        .post('/api/tenants/tenant-1/billing/upgrade')
        .send({ targetPlan: 'ENTERPRISE' })
        .expect(200, {
          success: true,
          message: 'Upgrade request received',
          redirectUrl: null,
        });
    },
  );

  it.each(['OPERATOR', 'MEMBER', 'VIEWER'] as const)(
    'returns 403 for %s on billing read and upgrade endpoints',
    async (role) => {
      const app = createApp(role);

      const readResponse = await request(app)
        .get('/api/tenants/tenant-1/billing/deals')
        .expect(403);
      expect(readResponse.body).toMatchObject({
        success: false,
        error: { code: 'PERMISSION_REQUIRED', message: 'Forbidden' },
        required: BILLING_READ_PERMISSION,
      });
      expect(mockTenantFindOne).not.toHaveBeenCalled();

      const upgradeResponse = await request(app)
        .post('/api/tenants/tenant-1/billing/upgrade')
        .send({ targetPlan: 'ENTERPRISE' })
        .expect(403);
      expect(upgradeResponse.body).toMatchObject({
        success: false,
        error: { code: 'PERMISSION_REQUIRED', message: 'Forbidden' },
        required: BILLING_READ_PERMISSION,
      });
    },
  );

  it('denies the remaining billing endpoints for non-admin workspace roles', async () => {
    const app = createApp('OPERATOR');

    const responseChecks = [
      request(app).get('/api/tenants/tenant-1/billing/credits').expect(403),
      request(app)
        .post('/api/tenants/tenant-1/billing/credits/topup')
        .send({ amount: 10 })
        .expect(403),
      request(app).get('/api/tenants/tenant-1/billing/features').expect(403),
    ];

    const responses = await Promise.all(responseChecks);
    for (const response of responses) {
      expect(response.body.required).toBe(BILLING_READ_PERMISSION);
    }
    expect(mockTenantFindOne).not.toHaveBeenCalled();
  });

  it('returns 401 when billing endpoints are called without authentication', async () => {
    const app = createApp();

    await request(app)
      .get('/api/tenants/tenant-1/billing/deals')
      .expect(401, {
        success: false,
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' },
      });
  });
});
