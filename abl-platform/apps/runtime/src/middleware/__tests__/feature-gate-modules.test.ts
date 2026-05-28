/**
 * Feature Gate — Module Feature Gate Tests
 *
 * Tests for middleware/feature-gate.ts focusing on:
 * - PLAN_FEATURES constant: which tiers include 'reusable_modules'
 * - createModuleFeatureGate(): happy path (BUSINESS/ENTERPRISE plan, active deal)
 * - createModuleFeatureGate(): denial (FREE plan, no tenant context)
 * - createModuleFeatureGate(): fail-closed behavior (503 on DB error)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// HOISTED MOCKS
// =============================================================================

const { mockDealFind, mockSubscriptionFindOne, mockTenantFindOne } = vi.hoisted(() => ({
  mockDealFind: vi.fn(),
  mockSubscriptionFindOne: vi.fn(),
  mockTenantFindOne: vi.fn(),
}));

// =============================================================================
// MOCK: @agent-platform/database/models
// =============================================================================

vi.mock('@agent-platform/database/models', () => ({
  Deal: {
    find: (...args: any[]) => mockDealFind(...args),
  },
  Subscription: {
    findOne: (...args: any[]) => mockSubscriptionFindOne(...args),
  },
  Tenant: {
    findOne: (...args: any[]) => mockTenantFindOne(...args),
  },
}));

// =============================================================================
// MOCK: @abl/compiler/platform (suppress log output)
// =============================================================================

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// =============================================================================
// IMPORT UNDER TEST
// =============================================================================

import { PLAN_FEATURES, createModuleFeatureGate } from '../feature-gate.js';

// =============================================================================
// HELPERS
// =============================================================================

function mockReq(tenantId?: string) {
  return {
    tenantContext: tenantId ? { tenantId } : undefined,
  } as any;
}

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

/** Configure mocks for a subscription-based plan check (no active deals). */
function setupPlanMocks(planTier: string) {
  // Deal.find → no active deals
  mockDealFind.mockReturnValue({
    lean: () => ({ exec: () => Promise.resolve([]) }),
  });
  // Subscription.findOne → subscription with given planTier
  mockSubscriptionFindOne.mockReturnValue({
    lean: () => ({ exec: () => Promise.resolve({ planTier }) }),
  });
  // Tenant.findOne → tenant with matching org
  mockTenantFindOne.mockReturnValue({
    lean: () => ({ exec: () => Promise.resolve({ _id: 'tenant-1', organizationId: 'org-1' }) }),
  });
}

/** Configure mocks for an active deal with given features. */
function setupDealMocks(features: string[]) {
  mockDealFind.mockReturnValue({
    lean: () => ({
      exec: () => Promise.resolve([{ organizationId: 'org-1', status: 'active', features }]),
    }),
  });
  // Subscription doesn't matter — deal takes precedence
  mockSubscriptionFindOne.mockReturnValue({
    lean: () => ({ exec: () => Promise.resolve(null) }),
  });
  mockTenantFindOne.mockReturnValue({
    lean: () => ({ exec: () => Promise.resolve({ _id: 'tenant-1', organizationId: 'org-1' }) }),
  });
}

// =============================================================================
// TESTS
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PLAN_FEATURES', () => {
  test('BUSINESS tier includes reusable_modules', () => {
    expect(PLAN_FEATURES.BUSINESS).toContain('reusable_modules');
  });

  test('ENTERPRISE tier includes reusable_modules', () => {
    expect(PLAN_FEATURES.ENTERPRISE).toContain('reusable_modules');
  });

  test('FREE tier does NOT include reusable_modules', () => {
    expect(PLAN_FEATURES.FREE).not.toContain('reusable_modules');
  });

  test('TEAM tier does NOT include reusable_modules', () => {
    expect(PLAN_FEATURES.TEAM).not.toContain('reusable_modules');
  });

  test('governance is off for every default plan', () => {
    for (const features of Object.values(PLAN_FEATURES)) {
      expect(features).not.toContain('governance');
    }
  });
});

describe('createModuleFeatureGate — happy path', () => {
  test('allows request when tenant has BUSINESS plan with active subscription', async () => {
    setupPlanMocks('BUSINESS');
    const middleware = createModuleFeatureGate();
    const req = mockReq('tenant-1');
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('allows request when tenant has ENTERPRISE plan', async () => {
    setupPlanMocks('ENTERPRISE');
    const middleware = createModuleFeatureGate();
    const req = mockReq('tenant-1');
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('allows request when tenant has active deal with reusable_modules feature', async () => {
    setupDealMocks(['reusable_modules', 'custom_models']);
    const middleware = createModuleFeatureGate();
    const req = mockReq('tenant-1');
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('createModuleFeatureGate — denial', () => {
  test('returns 403 with FEATURE_DISABLED code when tenant has FREE plan', async () => {
    setupPlanMocks('FREE');
    const middleware = createModuleFeatureGate();
    const req = mockReq('tenant-1');
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'FEATURE_DISABLED',
        message: "Feature 'reusable_modules' is not available on your current plan",
      },
    });
  });

  test('returns 403 when no tenant context on request', async () => {
    const middleware = createModuleFeatureGate();
    const req = mockReq(); // no tenantId
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'FEATURE_DISABLED',
        message: 'No tenant context',
      },
    });
  });
});

describe('createModuleFeatureGate — fail closed', () => {
  test('returns 503 with SERVICE_UNAVAILABLE when DB throws error', async () => {
    // Make Deal.find throw
    mockDealFind.mockReturnValue({
      lean: () => ({
        exec: () => Promise.reject(new Error('MongoDB connection lost')),
      }),
    });
    mockTenantFindOne.mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve({ _id: 'tenant-1', organizationId: 'org-1' }) }),
    });

    const middleware = createModuleFeatureGate();
    const req = mockReq('tenant-1');
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Feature check unavailable',
      },
    });
  });

  test('does NOT call next() on error (unlike requireFeature which fails open)', async () => {
    // Make Subscription.findOne throw after Deal.find succeeds
    mockDealFind.mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve([]) }),
    });
    mockSubscriptionFindOne.mockReturnValue({
      lean: () => ({
        exec: () => Promise.reject(new Error('Subscription lookup failed')),
      }),
    });
    mockTenantFindOne.mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve({ _id: 'tenant-1', organizationId: 'org-1' }) }),
    });

    const middleware = createModuleFeatureGate();
    const req = mockReq('tenant-1');
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    // Crucially: next() must NOT be called — fail closed
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
