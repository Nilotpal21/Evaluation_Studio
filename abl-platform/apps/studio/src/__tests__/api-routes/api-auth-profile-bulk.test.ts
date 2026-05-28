/**
 * Auth Profile Bulk Actions Tests (Tasks 3.3-3.5)
 *
 * Covers:
 *   - Bulk delete with cascade check per profile
 *   - Bulk revoke active profiles
 *   - Bulk activate revoked profiles
 *   - Tenant isolation (cross-tenant → 404)
 *   - Validation: >50 → 400, 0 → 400
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockRequireAuth } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
}));

vi.mock('../../lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: (r: unknown) => r instanceof NextResponse,
}));

vi.mock('../../lib/project-access', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({
    project: { id: 'proj-1', tenantId: 'tenant-1' },
  }),
  isAccessError: (r: unknown) => r instanceof NextResponse,
}));

vi.mock('@agent-platform/shared/validation', () => ({
  parseInput: vi.fn((_schema: any, data: any) => ({ success: true, data })),
}));

// Mock ensureDb
vi.mock('../../lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

// Track mock models
const mockFindOne = vi.fn();
const mockFindOneAndDelete = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockCountDocuments = vi.fn();

vi.mock('@agent-platform/database/models', () => {
  const modelProxy = {
    findOne: (...args: any[]) => ({ lean: () => mockFindOne(...args) }),
    findOneAndDelete: (...args: any[]) => mockFindOneAndDelete(...args),
    findOneAndUpdate: (...args: any[]) => mockFindOneAndUpdate(...args),
    countDocuments: (...args: any[]) => mockCountDocuments(...args),
    aggregate: vi.fn().mockResolvedValue([]),
  };
  return {
    AuthProfile: modelProxy,
    EndUserOAuthToken: modelProxy,
    ChannelConnection: modelProxy,
    ProjectSettings: modelProxy,
    TenantModel: modelProxy,
    ConnectorConfig: modelProxy,
    ConnectorConnection: modelProxy,
    MCPServerConfig: modelProxy,
    ServiceNode: modelProxy,
    TenantGuardrailProviderConfig: modelProxy,
    GuardrailPolicy: modelProxy,
    GitIntegration: modelProxy,
    SDKChannel: modelProxy,
    WebhookSubscription: modelProxy,
    WebhookSubscriptionConnector: modelProxy,
    ModelConfig: modelProxy,
    TenantServiceInstance: modelProxy,
    OrgProxyConfig: modelProxy,
    ArchWorkspaceConfig: modelProxy,
    TriggerRegistration: modelProxy,
    ProjectTool: modelProxy,
  };
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { rateLimiter } from '../../lib/rate-limiter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(perms: string[] = [], id = 'user-1', tenantId = 'tenant-1') {
  return {
    id,
    email: `${id}@test.com`,
    name: 'Test',
    tenantId,
    role: 'editor',
    permissions: perms,
  };
}

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/auth-profiles/bulk', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeRouteCtx(params: Record<string, string> = {}) {
  return { params: Promise.resolve(params) };
}

let postHandler: (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
  rateLimiter.clear();
  // Reset mock implementations
  mockFindOne.mockReset();
  mockFindOneAndDelete.mockReset();
  mockFindOneAndUpdate.mockReset();
  mockCountDocuments.mockReset();
});

beforeAll(async () => {
  const mod = await import('../../app/api/auth-profiles/bulk/route.js');
  postHandler = mod.POST;
}, 60_000);

// ---------------------------------------------------------------------------
// Tests — Bulk Actions Validation
// ---------------------------------------------------------------------------

describe('Bulk actions validation', () => {
  it('rejects >50 profile IDs with 400', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:write', 'auth-profile:delete']));

    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    const res = await postHandler(
      makeRequest({ action: 'delete', profileIds: ids }),
      makeRouteCtx(),
    );

    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
  });

  it('rejects 0 profile IDs with 400', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:write', 'auth-profile:delete']));
    const res = await postHandler(
      makeRequest({ action: 'delete', profileIds: [] }),
      makeRouteCtx(),
    );

    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — Bulk Delete
// ---------------------------------------------------------------------------

describe('Bulk delete', () => {
  it('deletes profiles with 0 consumers each', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:write', 'auth-profile:delete']));

    // Each findOne returns a profile for the right tenant
    mockFindOne
      .mockResolvedValueOnce({
        _id: 'p1',
        tenantId: 'tenant-1',
        status: 'active',
        authType: 'api_key',
      })
      .mockResolvedValueOnce({
        _id: 'p2',
        tenantId: 'tenant-1',
        status: 'active',
        authType: 'api_key',
      })
      .mockResolvedValueOnce({
        _id: 'p3',
        tenantId: 'tenant-1',
        status: 'active',
        authType: 'api_key',
      });

    // All consumer checks return 0
    mockCountDocuments.mockResolvedValue(0);
    mockFindOneAndDelete.mockResolvedValue({ _id: 'deleted' });

    const res = await postHandler(
      makeRequest({ action: 'delete', profileIds: ['p1', 'p2', 'p3'] }),
      makeRouteCtx(),
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.results).toHaveLength(3);
    expect(json.data.results.every((r: any) => r.status === 'ok')).toBe(true);
  });

  it('returns 404 for cross-tenant profile', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:write', 'auth-profile:delete']));

    // p1 found, p2 not found (cross-tenant)
    mockFindOne
      .mockResolvedValueOnce({
        _id: 'p1',
        tenantId: 'tenant-1',
        status: 'active',
        authType: 'api_key',
      })
      .mockResolvedValueOnce(null); // cross-tenant → not found

    mockCountDocuments.mockResolvedValue(0);
    mockFindOneAndDelete.mockResolvedValue({ _id: 'deleted' });

    const res = await postHandler(
      makeRequest({ action: 'delete', profileIds: ['p1', 'p2'] }),
      makeRouteCtx(),
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.results[0].status).toBe('ok');
    expect(json.data.results[1].status).toBe('error');
    expect(json.data.results[1].error).toContain('not found');
  });

  it('does not expose another user’s personal profile through bulk actions', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:write', 'auth-profile:delete']));

    mockFindOne.mockResolvedValueOnce({
      _id: 'p1',
      tenantId: 'tenant-1',
      projectId: null,
      scope: 'tenant',
      visibility: 'personal',
      createdBy: 'other-user',
      status: 'active',
      authType: 'api_key',
    });

    const res = await postHandler(
      makeRequest({ action: 'delete', profileIds: ['p1'] }),
      makeRouteCtx(),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.results).toEqual([{ id: 'p1', status: 'error', error: 'Profile not found' }]);
    expect(mockFindOneAndDelete).not.toHaveBeenCalled();
  });

  it('counts ServiceNode consumers with an explicit tenantId filter', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:write', 'auth-profile:delete']));

    mockFindOne.mockResolvedValueOnce({
      _id: 'p1',
      tenantId: 'tenant-1',
      projectId: null,
      scope: 'tenant',
      visibility: 'shared',
      createdBy: 'user-1',
      status: 'active',
      authType: 'api_key',
    });
    mockCountDocuments.mockResolvedValue(0);
    mockFindOneAndDelete.mockResolvedValue({ _id: 'deleted' });

    const res = await postHandler(
      makeRequest({ action: 'delete', profileIds: ['p1'] }),
      makeRouteCtx(),
    );
    expect(res.status).toBe(200);
    expect(
      mockCountDocuments.mock.calls.some(
        ([filter]) => filter.authProfileId === 'p1' && filter.tenantId === 'tenant-1',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — Bulk Revoke / Activate
// ---------------------------------------------------------------------------

describe('Bulk revoke and activate', () => {
  it('revokes active profiles', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:write']));

    mockFindOne
      .mockResolvedValueOnce({
        _id: 'p1',
        tenantId: 'tenant-1',
        status: 'active',
        authType: 'api_key',
      })
      .mockResolvedValueOnce({
        _id: 'p2',
        tenantId: 'tenant-1',
        status: 'active',
        authType: 'bearer',
      });

    mockFindOneAndUpdate.mockResolvedValue({ _id: 'updated' });

    const res = await postHandler(
      makeRequest({ action: 'revoke', profileIds: ['p1', 'p2'] }),
      makeRouteCtx(),
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.results).toHaveLength(2);
    expect(json.data.results.every((r: any) => r.status === 'ok')).toBe(true);
  });

  it('activates revoked profiles', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:write']));

    mockFindOne
      .mockResolvedValueOnce({
        _id: 'p1',
        tenantId: 'tenant-1',
        status: 'revoked',
        authType: 'api_key',
      })
      .mockResolvedValueOnce({
        _id: 'p2',
        tenantId: 'tenant-1',
        status: 'revoked',
        authType: 'bearer',
      });

    mockFindOneAndUpdate.mockResolvedValue({ _id: 'updated' });

    const res = await postHandler(
      makeRequest({ action: 'activate', profileIds: ['p1', 'p2'] }),
      makeRouteCtx(),
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.results.every((r: any) => r.status === 'ok')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — Cascade Check on Bulk Delete (Task 3.5)
// ---------------------------------------------------------------------------

describe('Bulk delete with cascade check', () => {
  it('returns per-profile error for profiles with consumers', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:write', 'auth-profile:delete']));

    // p1: no consumers, p2: has consumers
    mockFindOne
      .mockResolvedValueOnce({
        _id: 'p1',
        tenantId: 'tenant-1',
        status: 'active',
        authType: 'api_key',
      })
      .mockResolvedValueOnce({
        _id: 'p2',
        tenantId: 'tenant-1',
        status: 'active',
        authType: 'api_key',
      });

    // For p1: all consumer counts = 0
    // For p2: ServiceNode has 2 consumers
    mockCountDocuments.mockImplementation((filter: Record<string, unknown>) =>
      Promise.resolve(filter.authProfileId === 'p2' ? 2 : 0),
    );

    mockFindOneAndDelete.mockResolvedValue({ _id: 'deleted' });

    const res = await postHandler(
      makeRequest({ action: 'delete', profileIds: ['p1', 'p2'] }),
      makeRouteCtx(),
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.results[0].status).toBe('ok');
    expect(json.data.results[1].status).toBe('error');
    expect(json.data.results[1].error).toContain('referenced');
  });
});
