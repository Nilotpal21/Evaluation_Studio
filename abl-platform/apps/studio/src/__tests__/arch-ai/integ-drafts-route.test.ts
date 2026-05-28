import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn();
const mockListNonArchivedIntegrationDrafts = vi.fn();
const mockHandleApiError = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

vi.mock('@/lib/arch-ai/integration-draft-service', () => ({
  listNonArchivedIntegrationDrafts: (...args: unknown[]) =>
    mockListNonArchivedIntegrationDrafts(...args),
}));

vi.mock('@/lib/api-response', () => ({
  successJson: (key: string, data: unknown, status = 200) =>
    NextResponse.json({ success: true, [key]: data }, { status }),
  handleApiError: (...args: unknown[]) => mockHandleApiError(...args),
}));

import { GET } from '@/app/api/arch-ai/projects/[projectId]/integration-drafts/route';

const authenticatedUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  tenantId: 't1',
};

function makeRequest() {
  return new NextRequest('http://localhost:3000/api/arch-ai/projects/p1/integration-drafts', {
    method: 'GET',
  });
}

describe('GET /api/arch-ai/projects/:projectId/integration-drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireTenantAuth.mockResolvedValue(authenticatedUser);
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'p1', tenantId: 't1' },
    });
    mockIsAccessError.mockReturnValue(false);
    mockHandleApiError.mockImplementation((error: unknown) =>
      NextResponse.json(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      ),
    );
  });

  test('returns drafts for the authenticated tenant + project', async () => {
    mockListNonArchivedIntegrationDrafts.mockResolvedValue([
      {
        id: 'd1',
        title: 'Slack',
        status: 'complete',
        source: 'in_project',
        providerKey: 'slack',
        toolIds: [],
        authProfileIds: [],
        envVarKeys: [],
        configVarKeys: [],
        variableNamespaceIds: [],
        targetAgentNames: [],
        pendingSteps: [],
        lastIntentSummary: null,
        connectionIds: [],
        lastTestStatus: null,
        lastTestAt: null,
        lastTestError: null,
        testHistory: [],
        createdAt: '2026-05-05T00:00:00.000Z',
        updatedAt: '2026-05-05T00:00:01.000Z',
      },
    ]);

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ projectId: 'p1' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].providerKey).toBe('slack');
    expect(mockListNonArchivedIntegrationDrafts).toHaveBeenCalledWith({
      tenantId: 't1',
      projectId: 'p1',
    });
  });

  test('returns the auth error response when authentication fails', async () => {
    const authError = NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    mockRequireTenantAuth.mockResolvedValue(authError);
    mockIsAuthError.mockImplementation((value: unknown) => value === authError);

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ projectId: 'p1' }),
    });

    expect(response.status).toBe(401);
    expect(mockListNonArchivedIntegrationDrafts).not.toHaveBeenCalled();
  });

  test('returns the access error response when the user has no project access', async () => {
    const notFound = NextResponse.json({ error: 'not_found' }, { status: 404 });
    mockRequireProjectAccess.mockResolvedValue(notFound);
    mockIsAccessError.mockImplementation((value: unknown) => value === notFound);

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ projectId: 'p1' }),
    });

    expect(response.status).toBe(404);
    expect(mockListNonArchivedIntegrationDrafts).not.toHaveBeenCalled();
  });

  test('returns an empty list when no drafts match', async () => {
    mockListNonArchivedIntegrationDrafts.mockResolvedValue([]);

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ projectId: 'p1' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.drafts).toEqual([]);
  });
});
