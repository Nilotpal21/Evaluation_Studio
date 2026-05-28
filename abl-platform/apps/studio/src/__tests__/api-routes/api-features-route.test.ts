import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockEnsureDb = vi.fn();
const mockTenantFindOne = vi.fn();
const mockDealFind = vi.fn();
const mockSubscriptionFindOne = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: (...args: unknown[]) => mockEnsureDb(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  Tenant: {
    findOne: (...args: unknown[]) => mockTenantFindOne(...args),
  },
  Deal: {
    find: (...args: unknown[]) => mockDealFind(...args),
  },
  Subscription: {
    findOne: (...args: unknown[]) => mockSubscriptionFindOne(...args),
  },
}));

function leanExec<T>(value: T) {
  return {
    lean: () => ({
      exec: () => Promise.resolve(value),
    }),
  };
}

function makeRequest(tenantId: string) {
  mockRequireTenantAuth.mockResolvedValue({
    id: 'user-1',
    tenantId,
    email: 'user@example.com',
  });
  return new NextRequest(`http://localhost:5173/api/features?tenant=${tenantId}`);
}

describe('GET /api/features', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAuthError.mockReturnValue(false);
    mockEnsureDb.mockResolvedValue(undefined);
  });

  it('uses tenant.organizationId when resolving deal-backed governance visibility', async () => {
    mockTenantFindOne.mockReturnValue(
      leanExec({
        _id: 'tenant-org-backed',
        organizationId: 'org-123',
        settings: { codeToolsEnabled: false },
      }),
    );
    mockDealFind.mockReturnValue(leanExec([{ features: ['governance'] }]));
    mockSubscriptionFindOne.mockReturnValue(leanExec({ planTier: 'FREE', entitlements: [] }));

    const { GET } = await import('@/app/api/features/route');
    const response = await GET(makeRequest('tenant-org-backed'));
    const json = await response.json();

    expect(mockDealFind).toHaveBeenCalledWith({
      organizationId: 'org-123',
      status: 'active',
    });
    expect(json.data.governance).toBe(true);
  });
});
