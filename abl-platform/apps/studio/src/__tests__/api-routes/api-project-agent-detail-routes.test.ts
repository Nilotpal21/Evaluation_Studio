/**
 * Tests for Studio project-agent detail routes.
 *
 * Covers:
 *   GET    /api/projects/:id/agents/:agentId - Get agent detail by name
 *   PATCH  /api/projects/:id/agents/:agentId - Update agent resolved from route name
 *   DELETE /api/projects/:id/agents/:agentId - Delete agent resolved from route name
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);
const mockCheckAgentPermission = vi.fn();
const mockFindProjectAgent = vi.fn();
const mockUpdateProjectAgent = vi.fn();
const mockUpdateAgent = vi.fn();
const mockRemoveAgentFromProject = vi.fn();
const mockUpdateProject = vi.fn();
const mockLogAuditEvent = vi.fn();
const mockParseAgentBasedABL = vi.fn();
const mockCompileABLtoIR = vi.fn();
const mockBuildProjectCompileContext = vi.fn();
const mockResolvePromptLibraryRefOnDocument = vi.fn();
const mockRefreshPersistedStudioProjectAgentDraftMetadata = vi.fn();

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
  findProjectAgent: mockFindProjectAgent,
  updateProjectAgent: mockUpdateProjectAgent,
}));

vi.mock('@/services/project-service', () => ({
  updateAgent: mockUpdateAgent,
  removeAgentFromProject: mockRemoveAgentFromProject,
  updateProject: mockUpdateProject,
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: mockLogAuditEvent,
  AuditActions: {
    AGENT_UPDATED: 'AGENT_UPDATED',
    AGENT_DSL_UPDATED: 'AGENT_DSL_UPDATED',
    AGENT_REMOVED: 'AGENT_REMOVED',
  },
}));

vi.mock('@abl/core', () => ({
  parseAgentBasedABL: mockParseAgentBasedABL,
}));

vi.mock('@abl/compiler', () => ({
  compileABLtoIR: mockCompileABLtoIR,
}));

vi.mock('@/lib/abl/project-aware-compile', () => ({
  buildProjectCompileContext: mockBuildProjectCompileContext,
  collectRecoverableParseWarnings: () => [],
  collectTargetCompilationMessages: () => ({ errors: [], warnings: [] }),
  STUDIO_PROJECT_AWARE_COMPILE_MODE: 'best_effort',
}));

vi.mock('@agent-platform/shared/prompts', () => ({
  resolvePromptLibraryRefOnDocument: (...args: unknown[]) =>
    mockResolvePromptLibraryRefOnDocument(...args),
}));

vi.mock('@/lib/abl/project-agent-draft-metadata', () => ({
  refreshPersistedStudioProjectAgentDraftMetadata: (...args: unknown[]) =>
    mockRefreshPersistedStudioProjectAgentDraftMetadata(...args),
}));

type RouteCtx = { params: Promise<Record<string, string>> };

function makeRequest(url: string, method = 'GET', body?: unknown): NextRequest {
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
  entryAgentName: 'booking_agent',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockResolvedValue({ project: testProject });
  mockIsAccessError.mockReturnValue(false);
  mockCheckAgentPermission.mockResolvedValue({ allowed: true });
  mockParseAgentBasedABL.mockImplementation((dslContent: string) => {
    if (dslContent.startsWith('GOAL:')) {
      return {
        document: null,
        errors: [{ line: 1, message: 'Missing required agent name.' }],
        warnings: [],
      };
    }

    return {
      document: {
        name: dslContent.includes('AGENT: travel_agent') ? 'travel_agent' : 'booking_agent',
      },
      errors: [],
      warnings: [],
    };
  });
  mockCompileABLtoIR.mockReturnValue({
    agents: {
      booking_agent: {
        metadata: { name: 'booking_agent' },
      },
    },
  });
  mockBuildProjectCompileContext.mockImplementation(
    async ({ targetDocument }: { targetDocument: unknown }) => ({
      allDocs: [targetDocument],
      compilerOptions: {},
      errors: [],
      warnings: [],
    }),
  );
  mockResolvePromptLibraryRefOnDocument.mockImplementation(async (document) => {
    const doc = document as {
      systemPromptLibraryRef?: { resolvedHash?: string };
    };
    if (doc.systemPromptLibraryRef && !doc.systemPromptLibraryRef.resolvedHash) {
      doc.systemPromptLibraryRef.resolvedHash = 'resolved-prompt-hash';
    }
  });
  mockRefreshPersistedStudioProjectAgentDraftMetadata.mockResolvedValue(new Map());
});

describe('PUT /api/projects/:id/agents/:agentId/dsl', () => {
  it('saves DSL through repo-owned companion-aware hashing and returns the persisted hash', async () => {
    const dslContent = 'AGENT: booking_agent\nGOAL: "Help users"\nPERSONA: "Helpful"';
    mockFindProjectAgent.mockResolvedValue({
      id: 'agent-db-1',
      projectId: 'proj-1',
      name: 'booking_agent',
      systemPromptLibraryRef: {
        promptId: 'prompt-1',
        versionId: 'version-1',
      },
    });
    mockUpdateProjectAgent.mockResolvedValue({
      id: 'agent-db-1',
      updatedAt: '2026-05-02T00:00:00.000Z',
      sourceHash: 'companion-aware-hash',
    });

    const { PUT } = await import('@/app/api/projects/[id]/agents/[agentId]/dsl/route');

    const response = await PUT(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/booking_agent/dsl', 'PUT', {
        dslContent,
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );

    expect(response.status).toBe(200);
    expect(mockFindProjectAgent).toHaveBeenCalledWith('proj-1', 'booking_agent', 'tenant-1');
    const updatePayload = mockUpdateProjectAgent.mock.calls[0]?.[1];
    expect(updatePayload).toMatchObject({
      dslContent,
      lastEditedBy: 'user-1',
      lastEditedAt: expect.any(Date),
      dslValidationStatus: 'valid',
      dslDiagnostics: [],
    });
    expect(updatePayload).not.toHaveProperty('sourceHash');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'AGENT_DSL_UPDATED',
        metadata: expect.objectContaining({
          projectId: 'proj-1',
          resourceType: 'agent',
          resourceId: 'agent-db-1',
          agentId: 'agent-db-1',
          agentName: 'booking_agent',
          validationStatus: 'valid',
          errorCount: 0,
          warningCount: 0,
          sourceHash: 'companion-aware-hash',
        }),
      }),
    );
    expect(await response.json()).toEqual({
      success: true,
      sourceHash: 'companion-aware-hash',
      diagnostics: { status: 'valid', errors: [], warnings: [] },
      updatedAt: '2026-05-02T00:00:00.000Z',
    });
  });

  it('keeps invalid DSL as a draft and returns save-time diagnostics', async () => {
    const dslContent = 'GOAL: "Missing agent header"';
    mockFindProjectAgent.mockResolvedValue({
      id: 'agent-db-1',
      projectId: 'proj-1',
      name: 'booking_agent',
    });
    mockUpdateProjectAgent.mockResolvedValue({
      id: 'agent-db-1',
      updatedAt: '2026-05-02T00:00:00.000Z',
    });

    const { PUT } = await import('@/app/api/projects/[id]/agents/[agentId]/dsl/route');

    const response = await PUT(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/booking_agent/dsl', 'PUT', {
        dslContent,
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.diagnostics.status).toBe('error');
    expect(json.diagnostics.errors.length).toBeGreaterThan(0);
    expect(mockUpdateProjectAgent).toHaveBeenCalledWith(
      'agent-db-1',
      expect.objectContaining({
        dslContent,
        dslValidationStatus: 'error',
        dslDiagnostics: expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            source: 'studio-save',
          }),
        ]),
      }),
      'tenant-1',
    );
  });

  it('rejects a raw DSL save that renames the persisted agent header', async () => {
    const dslContent = 'AGENT: travel_agent\nGOAL: "Renamed in raw editor"';
    mockFindProjectAgent.mockResolvedValue({
      id: 'agent-db-1',
      projectId: 'proj-1',
      name: 'booking_agent',
    });

    const { PUT } = await import('@/app/api/projects/[id]/agents/[agentId]/dsl/route');

    const response = await PUT(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/booking_agent/dsl', 'PUT', {
        dslContent,
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json).toMatchObject({
      error:
        'Agent DSL declares "travel_agent" but this record is "booking_agent". Use the rename flow to change agent identity.',
      code: 'AGENT_DSL_NAME_MISMATCH',
      declaredName: 'travel_agent',
      recordName: 'booking_agent',
    });
    expect(mockUpdateProjectAgent).not.toHaveBeenCalled();
  });

  it('preserves a draft when project-aware validation is unavailable', async () => {
    const dslContent = 'AGENT: booking_agent\nGOAL: "Help users"\nPERSONA: "Helpful"';
    mockBuildProjectCompileContext.mockRejectedValue(new Error('project context unavailable'));
    mockFindProjectAgent.mockResolvedValue({
      id: 'agent-db-1',
      projectId: 'proj-1',
      name: 'booking_agent',
    });
    mockUpdateProjectAgent.mockResolvedValue({
      id: 'agent-db-1',
      updatedAt: '2026-05-02T00:00:00.000Z',
    });

    const { PUT } = await import('@/app/api/projects/[id]/agents/[agentId]/dsl/route');

    const response = await PUT(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/booking_agent/dsl', 'PUT', {
        dslContent,
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.diagnostics.status).toBe('error');
    expect(json.diagnostics.errors[0]).toContain('Draft saved, but validation could not complete');
    expect(mockUpdateProjectAgent).toHaveBeenCalledWith(
      'agent-db-1',
      expect.objectContaining({
        dslContent,
        dslValidationStatus: 'error',
      }),
      'tenant-1',
    );
  });
});

describe('PATCH /api/projects/:id/agents/:agentId', () => {
  it('resolves the agent by route name and updates by DB id', async () => {
    mockFindProjectAgent.mockResolvedValue({
      id: 'agent-db-1',
      projectId: 'proj-1',
      name: 'booking_agent',
    });
    mockUpdateAgent.mockResolvedValue({
      id: 'agent-db-1',
      name: 'booking_agent',
      description: 'Updated description',
    });

    const { PATCH } = await import('@/app/api/projects/[id]/agents/[agentId]/route');

    const response = await PATCH(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/booking_agent', 'PATCH', {
        description: 'Updated description',
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );

    expect(mockFindProjectAgent).toHaveBeenCalledWith('proj-1', 'booking_agent', 'tenant-1');
    expect(mockUpdateAgent).toHaveBeenCalledWith(
      'agent-db-1',
      { description: 'Updated description' },
      'tenant-1',
    );
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'AGENT_UPDATED',
        metadata: expect.objectContaining({
          projectId: 'proj-1',
          resourceType: 'agent',
          resourceId: 'agent-db-1',
          agentId: 'agent-db-1',
          previousAgentName: 'booking_agent',
          agentName: 'booking_agent',
          changes: { description: 'Updated description' },
        }),
      }),
    );
    expect(await response.json()).toEqual({
      id: 'agent-db-1',
      name: 'booking_agent',
      description: 'Updated description',
    });
  });

  it('preserves prompt companion metadata fields when updating prompt refs', async () => {
    mockFindProjectAgent.mockResolvedValue({
      id: 'agent-db-1',
      projectId: 'proj-1',
      name: 'booking_agent',
    });
    mockUpdateAgent.mockResolvedValue({
      id: 'agent-db-1',
      name: 'booking_agent',
      systemPromptLibraryRef: {
        promptId: 'prompt-1',
        versionId: 'version-1',
        resolvedHash: 'prompt-hash-1',
        origin: 'module-import',
      },
    });

    const { PATCH } = await import('@/app/api/projects/[id]/agents/[agentId]/route');

    const response = await PATCH(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/booking_agent', 'PATCH', {
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
          resolvedHash: 'prompt-hash-1',
          origin: 'module-import',
        },
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );

    expect(mockUpdateAgent).toHaveBeenCalledWith(
      'agent-db-1',
      {
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
          resolvedHash: 'prompt-hash-1',
          origin: 'module-import',
        },
      },
      'tenant-1',
    );
    expect(mockResolvePromptLibraryRefOnDocument).toHaveBeenCalledWith(
      {
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
          resolvedHash: 'prompt-hash-1',
          origin: 'module-import',
        },
      },
      { tenantId: 'tenant-1', projectId: 'proj-1' },
    );
    expect(mockRefreshPersistedStudioProjectAgentDraftMetadata).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(await response.json()).toEqual({
      id: 'agent-db-1',
      name: 'booking_agent',
      systemPromptLibraryRef: {
        promptId: 'prompt-1',
        versionId: 'version-1',
        resolvedHash: 'prompt-hash-1',
        origin: 'module-import',
      },
    });
  });

  it('rejects unavailable prompt refs before updating the agent', async () => {
    mockFindProjectAgent.mockResolvedValue({
      id: 'agent-db-1',
      projectId: 'proj-1',
      name: 'booking_agent',
    });
    const { AppError } = await import('@agent-platform/shared/errors');
    mockResolvePromptLibraryRefOnDocument.mockRejectedValueOnce(
      new AppError('Referenced prompt library version is not available for compilation', {
        code: 'PROMPT_LIBRARY_VERSION_NOT_FOUND',
        statusCode: 400,
      }),
    );

    const { PATCH } = await import('@/app/api/projects/[id]/agents/[agentId]/route');

    const response = await PATCH(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/booking_agent', 'PATCH', {
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'missing-version',
        },
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );

    expect(response.status).toBe(400);
    expect(mockUpdateAgent).not.toHaveBeenCalled();
    expect(mockRefreshPersistedStudioProjectAgentDraftMetadata).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: 'Referenced prompt library version is not available for compilation',
      code: 'PROMPT_LIBRARY_VERSION_NOT_FOUND',
    });
  });

  it('persists resolved prompt hashes and refreshes draft metadata after prompt ref updates', async () => {
    mockFindProjectAgent.mockResolvedValue({
      id: 'agent-db-1',
      projectId: 'proj-1',
      name: 'booking_agent',
      dslContent: 'AGENT: booking_agent\nGOAL: "Help users"',
    });
    mockUpdateAgent.mockResolvedValue({
      id: 'agent-db-1',
      name: 'booking_agent',
      systemPromptLibraryRef: {
        promptId: 'prompt-1',
        versionId: 'version-1',
        resolvedHash: 'resolved-prompt-hash',
      },
    });

    const { PATCH } = await import('@/app/api/projects/[id]/agents/[agentId]/route');

    const response = await PATCH(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/booking_agent', 'PATCH', {
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
        },
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );

    expect(response.status).toBe(200);
    expect(mockUpdateAgent).toHaveBeenCalledWith(
      'agent-db-1',
      {
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
          resolvedHash: 'resolved-prompt-hash',
        },
      },
      'tenant-1',
    );
    expect(mockRefreshPersistedStudioProjectAgentDraftMetadata).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });

  it('rejects agentPath updates because paths are server-derived', async () => {
    mockFindProjectAgent.mockResolvedValue({
      id: 'agent-db-1',
      projectId: 'proj-1',
      name: 'booking_agent',
    });

    const { PATCH } = await import('@/app/api/projects/[id]/agents/[agentId]/route');

    const response = await PATCH(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/booking_agent', 'PATCH', {
        agentPath: 'proj-1/default/other_path',
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );

    expect(response.status).toBe(400);
    expect(mockUpdateAgent).not.toHaveBeenCalled();
  });

  it('rejects invalid rename values before they can rewrite DSL identity', async () => {
    mockFindProjectAgent.mockResolvedValue({
      id: 'agent-db-1',
      projectId: 'proj-1',
      name: 'booking_agent',
    });

    const { PATCH } = await import('@/app/api/projects/[id]/agents/[agentId]/route');

    const response = await PATCH(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/booking_agent', 'PATCH', {
        name: 'bad agent/name',
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );

    expect(response.status).toBe(400);
    expect(mockUpdateAgent).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/projects/:id/agents/:agentId', () => {
  it('resolves the agent by route name and deletes by DB id', async () => {
    mockFindProjectAgent.mockResolvedValue({
      id: 'agent-db-1',
      projectId: 'proj-1',
      name: 'booking_agent',
    });

    const { DELETE } = await import('@/app/api/projects/[id]/agents/[agentId]/route');

    const response = await DELETE(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/booking_agent', 'DELETE'),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );

    expect(mockFindProjectAgent).toHaveBeenCalledWith('proj-1', 'booking_agent', 'tenant-1');
    expect(mockUpdateProject).toHaveBeenCalledWith('proj-1', { entryAgentName: null }, 'tenant-1');
    expect(mockRemoveAgentFromProject).toHaveBeenCalledWith('agent-db-1', 'tenant-1');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'AGENT_REMOVED',
        metadata: {
          projectId: 'proj-1',
          resourceType: 'agent',
          resourceId: 'agent-db-1',
          agentId: 'agent-db-1',
          agentName: 'booking_agent',
        },
      }),
    );
    expect(await response.json()).toEqual({ success: true });
  });

  it('returns 404 when the agent route name does not resolve', async () => {
    mockFindProjectAgent.mockResolvedValue(null);

    const { DELETE } = await import('@/app/api/projects/[id]/agents/[agentId]/route');

    const response = await DELETE(
      makeRequest('http://localhost:3000/api/projects/proj-1/agents/missing_agent', 'DELETE'),
      routeCtx({ id: 'proj-1', agentId: 'missing_agent' }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Agent not found' });
    expect(mockRemoveAgentFromProject).not.toHaveBeenCalled();
  });
});
