import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);
const mockCheckAgentPermission = vi.fn();
const mockEnsureConnected = vi.fn();
const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockUpdateProjectAgent = vi.fn();
const mockComputeSourceHash = vi.fn(() => 'hash-123');
const mockSpliceSections = vi.fn();
const mockDiffABL = vi.fn(() => ({ changed: ['FLOW'] }));
const mockParseAgentBasedABL = vi.fn();
const mockCompileABLtoIR = vi.fn(() => ({}));
const mockBuildProjectCompileContext = vi.fn();
const mockCollectRecoverableParseWarnings = vi.fn(() => []);
const mockCollectTargetCompilationMessages = vi.fn(() => ({ errors: [], warnings: [] }));
const mockLogError = vi.fn();
const mockLogWarn = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

vi.mock('@/lib/agent-permission', () => ({
  checkAgentPermission: mockCheckAgentPermission,
}));

vi.mock('@/repos/project-repo', () => ({
  updateProjectAgent: mockUpdateProjectAgent,
}));

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: mockEnsureConnected,
  ProjectAgent: {
    findOne: mockFindOne,
    findOneAndUpdate: mockFindOneAndUpdate,
  },
}));

vi.mock('@agent-platform/shared', () => ({
  computeSourceHash: mockComputeSourceHash,
  AGENT_NAME_MAX_LENGTH: 100,
  AGENT_NAME_PATTERN: /^[A-Za-z_][A-Za-z0-9_]*$/,
}));

vi.mock('@agent-platform/project-io/diff', () => ({
  spliceSections: mockSpliceSections,
  diffABL: mockDiffABL,
}));

vi.mock('@abl/core', () => ({
  parseAgentBasedABL: mockParseAgentBasedABL,
}));

vi.mock('@abl/compiler', () => ({
  compileABLtoIR: mockCompileABLtoIR,
}));

vi.mock('@/lib/abl/project-aware-compile', () => ({
  buildProjectCompileContext: mockBuildProjectCompileContext,
  collectRecoverableParseWarnings: mockCollectRecoverableParseWarnings,
  collectTargetCompilationMessages: mockCollectTargetCompilationMessages,
  STUDIO_PROJECT_AWARE_COMPILE_MODE: 'best_effort',
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    error: mockLogError,
    warn: mockLogWarn,
  }),
}));

type RouteCtx = { params: Promise<Record<string, string>> };

function makeRequest(url: string, method = 'POST', body?: unknown): NextRequest {
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
  };

  if (body !== undefined) init.body = JSON.stringify(body);

  return new NextRequest(new URL(url, 'http://localhost:3000'), init);
}

function routeCtx(params: Record<string, string>): RouteCtx {
  return { params: Promise.resolve(params) };
}

const testUser = {
  id: 'user-1',
  email: 'test@example.com',
  tenantId: 'tenant-1',
};

const testProject = {
  id: 'proj-1',
  tenantId: 'tenant-1',
};

describe('POST /api/projects/:id/agents/:agentId/edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue(testUser);
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({ project: testProject });
    mockIsAccessError.mockReturnValue(false);
    mockCheckAgentPermission.mockResolvedValue({ allowed: true });
    mockEnsureConnected.mockResolvedValue(undefined);
    mockFindOne.mockResolvedValue({
      _id: 'agent-db-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'booking_agent',
      dslContent: 'AGENT: booking_agent\nGOAL: "Original"',
    });
    mockFindOneAndUpdate.mockResolvedValue({
      _id: 'agent-db-1',
      updatedAt: '2026-05-02T00:00:00.000Z',
    });
    mockUpdateProjectAgent.mockResolvedValue({
      _id: 'agent-db-1',
      updatedAt: '2026-05-02T00:00:00.000Z',
    });
    mockSpliceSections.mockReturnValue('AGENT: booking_agent\nGOAL: "Updated"');
    mockParseAgentBasedABL.mockReturnValue({
      document: { name: 'booking_agent' },
      errors: [],
      warnings: [],
    });
    mockBuildProjectCompileContext.mockResolvedValue({
      allDocs: [{ name: 'booking_agent' }],
      compilerOptions: {},
      errors: [],
      warnings: ['project warning'],
    });
    mockCollectTargetCompilationMessages.mockReturnValue({
      errors: [],
      warnings: ['compile warning'],
    });
  });

  it('persists only validated surgical edits without overriding repo-owned companion-aware hashes', async () => {
    const { POST } = await import('@/app/api/projects/[id]/agents/[agentId]/edit/route');

    const response = await POST(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/booking_agent/edit', 'POST', {
        edits: [{ section: 'GOAL', content: 'GOAL: "Updated"' }],
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );

    expect(response.status).toBe(200);
    expect(mockParseAgentBasedABL).toHaveBeenCalledWith('AGENT: booking_agent\nGOAL: "Updated"');
    const updatePayload = mockUpdateProjectAgent.mock.calls[0]?.[1];
    expect(updatePayload).toMatchObject({
      dslContent: 'AGENT: booking_agent\nGOAL: "Updated"',
      lastEditedBy: 'user-1',
      lastEditedAt: expect.any(Date),
      dslValidationStatus: 'warning',
      dslDiagnostics: [
        { severity: 'warning', message: 'project warning', source: 'studio-save' },
        { severity: 'warning', message: 'compile warning', source: 'studio-save' },
      ],
    });
    expect(updatePayload).not.toHaveProperty('sourceHash');

    expect(await response.json()).toEqual({
      success: true,
      dslContent: 'AGENT: booking_agent\nGOAL: "Updated"',
      diff: { changed: ['FLOW'] },
      diagnostics: {
        status: 'warning',
        errors: [],
        warnings: ['project warning', 'compile warning'],
      },
      updatedAt: '2026-05-02T00:00:00.000Z',
    });
  });

  it('rejects invalid surgical edits instead of persisting broken DSL', async () => {
    mockParseAgentBasedABL.mockReturnValue({
      document: null,
      errors: [{ line: 4, message: 'WITH: must be nested under CALL:' }],
      warnings: [],
    });

    const { POST } = await import('@/app/api/projects/[id]/agents/[agentId]/edit/route');

    const response = await POST(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/booking_agent/edit', 'POST', {
        edits: [{ section: 'FLOW', content: 'FLOW:\n  entry_point: broken' }],
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );

    expect(response.status).toBe(422);
    expect(mockUpdateProjectAgent).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: 'INVALID_SECTION_EDIT',
        message:
          'The visual editor could not save these changes because they produced invalid DSL. Open the DSL editor to review the generated content.',
      },
      errors: [
        {
          code: 'INVALID_SECTION_EDIT',
          msg: 'Line 4: WITH: must be nested under CALL:',
        },
      ],
      diagnostics: {
        status: 'error',
        errors: ['Line 4: WITH: must be nested under CALL:'],
        warnings: [],
      },
    });
  });

  it('rejects surgical edits that rename the persisted agent header', async () => {
    mockSpliceSections.mockReturnValue('AGENT: travel_agent\nGOAL: "Updated"');
    mockParseAgentBasedABL.mockReturnValue({
      document: { name: 'travel_agent' },
      errors: [],
      warnings: [],
    });

    const { POST } = await import('@/app/api/projects/[id]/agents/[agentId]/edit/route');

    const response = await POST(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/booking_agent/edit', 'POST', {
        edits: [{ section: '__full__', content: 'AGENT: travel_agent\nGOAL: "Updated"' }],
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );

    expect(response.status).toBe(409);
    expect(mockUpdateProjectAgent).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error:
        'Agent DSL declares "travel_agent" but this record is "booking_agent". Use the rename flow to change agent identity.',
      code: 'AGENT_DSL_NAME_MISMATCH',
      recordName: 'booking_agent',
      declaredName: 'travel_agent',
    });
  });
});
