import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('server-only', () => ({}));

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockRequireProjectAccess = vi.fn();
const mockFindAccessibleProjectIds = vi.fn();
const mockIsAccessError = vi.fn(() => false);
const mockFindProjectAgentByName = vi.fn();
const mockGetProjectAgents = vi.fn();
const mockCompileProjectAgentsForDiagnostics = vi.fn();
const mockPickTargetIR = vi.fn();
const mockFindProjectAgentsByTenantId = vi.fn();
const mockFindUserTenantMemberships = vi.fn();
const mockFindOne = vi.fn();
const mockFind = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  findAccessibleProjectIds: mockFindAccessibleProjectIds,
  isAccessError: mockIsAccessError,
}));

vi.mock('@/repos/project-repo', () => ({
  findProjectAgentByName: mockFindProjectAgentByName,
  findProjectAgentsByTenantId: mockFindProjectAgentsByTenantId,
}));

vi.mock('@/services/project-service', () => ({
  getProjectAgents: mockGetProjectAgents,
}));

vi.mock('@/lib/abl/project-aware-compile', () => ({
  compileProjectAgentsForDiagnostics: mockCompileProjectAgentsForDiagnostics,
  pickTargetIR: mockPickTargetIR,
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserTenantMemberships: mockFindUserTenantMemberships,
}));

vi.mock('@agent-platform/database/models', () => ({
  Project: {
    findOne: mockFindOne,
  },
  ProjectAgent: {
    find: mockFind,
  },
}));

vi.mock('@abl/core', () => ({
  parseAgentBasedABL: vi.fn(() => ({ document: { name: 'support_agent' }, errors: [] })),
}));

vi.mock('@abl/compiler', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  compileABLtoIR: vi.fn(() => ({ entry_agent: 'support_agent', agents: { support_agent: {} } })),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    headers: {
      Authorization: 'Bearer test-token',
    },
  });
}

const testUser = {
  id: 'user-1',
  email: 'test@example.com',
  tenantId: 'tenant-1',
};

const accessDenied = NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });

describe('legacy Studio agent read routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue(testUser);
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1', name: 'Project 1' },
    });
    mockFindAccessibleProjectIds.mockResolvedValue(['proj-1']);
    mockFindUserTenantMemberships.mockResolvedValue([{ tenantId: 'tenant-1' }]);
    mockIsAccessError.mockReturnValue(false);
    mockFindProjectAgentByName.mockResolvedValue({
      name: 'support_agent',
      dslContent: 'AGENT: support_agent\nGOAL: "Help"',
    });
    mockGetProjectAgents.mockResolvedValue([
      {
        name: 'support_agent',
        dslContent: 'AGENT: support_agent\nGOAL: "Help"',
      },
    ]);
    mockCompileProjectAgentsForDiagnostics.mockResolvedValue({
      compiled: { agents: { support_agent: { metadata: { name: 'support_agent' } } } },
      errors: [],
      warnings: [],
      parseErrors: [],
    });
    mockPickTargetIR.mockReturnValue({ metadata: { name: 'support_agent' } });
    mockFindProjectAgentsByTenantId.mockResolvedValue([
      {
        name: 'support_agent',
        projectId: 'proj-1',
        project: { id: 'proj-1', name: 'Project 1' },
        dslContent: 'AGENT: support_agent\nGOAL: "Help"',
      },
    ]);
    mockFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'proj-1', name: 'Project 1' }),
    });
    mockFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          {
            name: 'support_agent',
            dslContent: 'AGENT: support_agent\nGOAL: "Help"',
          },
        ]),
      }),
    });
  });

  it('requires project access before loading an agent by name', async () => {
    mockRequireProjectAccess.mockResolvedValue(accessDenied);
    mockIsAccessError.mockReturnValue(true);

    const { GET } = await import('@/app/api/agents/[name]/route');
    const response = await GET(makeRequest('/api/agents/support_agent?projectId=proj-1'), {
      params: Promise.resolve({ name: 'support_agent' }),
    });

    expect(response.status).toBe(404);
    expect(mockRequireProjectAccess).toHaveBeenCalledWith('proj-1', testUser);
    expect(mockFindProjectAgentByName).not.toHaveBeenCalled();
  });

  it('uses project-aware compilation for legacy agent detail IR', async () => {
    const { GET } = await import('@/app/api/agents/[name]/route');
    const response = await GET(makeRequest('/api/agents/support_agent?projectId=proj-1'), {
      params: Promise.resolve({ name: 'support_agent' }),
    });

    expect(response.status).toBe(200);
    expect(mockCompileProjectAgentsForDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      }),
    );
    expect(mockPickTargetIR).toHaveBeenCalledWith(expect.any(Object), ['support_agent']);
  });

  it('requires project access before listing app agents', async () => {
    mockRequireProjectAccess.mockResolvedValue(accessDenied);
    mockIsAccessError.mockReturnValue(true);

    const { GET } = await import('@/app/api/agents/apps/[domain]/route');
    const response = await GET(makeRequest('/api/agents/apps/proj-1'), {
      params: Promise.resolve({ domain: 'proj-1' }),
    });

    expect(response.status).toBe(404);
    expect(mockRequireProjectAccess).toHaveBeenCalledWith('proj-1', testUser);
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('uses one project-aware compilation for legacy app agent IRs', async () => {
    const { GET } = await import('@/app/api/agents/apps/[domain]/route');
    const response = await GET(makeRequest('/api/agents/apps/proj-1'), {
      params: Promise.resolve({ domain: 'proj-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockCompileProjectAgentsForDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      }),
    );
    expect(mockPickTargetIR).toHaveBeenCalledWith(expect.any(Object), ['support_agent']);
  });

  it('scopes the tenant-wide legacy agent list to accessible projects', async () => {
    const { GET } = await import('@/app/api/agents/route');
    const response = await GET(makeRequest('/api/agents'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockFindAccessibleProjectIds).toHaveBeenCalledWith(testUser);
    expect(mockFindProjectAgentsByTenantId).toHaveBeenCalledWith('tenant-1', ['proj-1']);
    expect(body.total).toBe(1);
    expect(body.agents[0]).toMatchObject({
      name: 'support_agent',
      projectId: 'proj-1',
      projectName: 'Project 1',
    });
  });

  it('scopes the legacy app inventory to accessible projects', async () => {
    const { GET } = await import('@/app/api/agents/apps/route');
    const response = await GET(makeRequest('/api/agents/apps'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockFindAccessibleProjectIds).toHaveBeenCalledWith(testUser);
    expect(mockFindProjectAgentsByTenantId).toHaveBeenCalledWith('tenant-1', ['proj-1']);
    expect(body.total).toBe(1);
    expect(body.apps[0]).toMatchObject({
      name: 'Project 1',
      domain: 'proj-1',
      entryAgent: 'support_agent',
    });
  });
});
