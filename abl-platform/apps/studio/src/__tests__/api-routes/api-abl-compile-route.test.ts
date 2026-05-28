import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('server-only', () => ({}));

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);
const mockCheckRateLimit = vi.fn();
const mockParseAgentBasedABL = vi.fn();
const mockCompileABLtoIR = vi.fn();
const mockFindConfigVariablesByProject = vi.fn();
const mockBuildProjectCompileContext = vi.fn();
const mockBuildStudioCompilerOptions = vi.fn();
const mockCollectRecoverableParseWarnings = vi.fn();
const mockCollectTargetCompilationMessages = vi.fn();
const mockPickTargetIR = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('@abl/core', () => ({
  parseAgentBasedABL: mockParseAgentBasedABL,
}));

vi.mock('@abl/compiler', () => ({
  compileABLtoIR: mockCompileABLtoIR,
}));

vi.mock('@/repos/config-variable-repo', () => ({
  findConfigVariablesByProject: mockFindConfigVariablesByProject,
}));

vi.mock('@/lib/abl/project-aware-compile', () => ({
  buildProjectCompileContext: mockBuildProjectCompileContext,
  buildStudioCompilerOptions: mockBuildStudioCompilerOptions,
  collectRecoverableParseWarnings: mockCollectRecoverableParseWarnings,
  collectTargetCompilationMessages: mockCollectTargetCompilationMessages,
  pickTargetIR: mockPickTargetIR,
  STUDIO_PROJECT_AWARE_COMPILE_MODE: 'best_effort',
}));

function makeRequest(path: string, body: unknown): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost:3000'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/abl/compile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'test@example.com',
    });
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({
      project: {
        id: 'proj-1',
        tenantId: 'tenant-1',
      },
    });
    mockIsAccessError.mockReturnValue(false);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0 });
    mockFindConfigVariablesByProject.mockResolvedValue([]);
    mockBuildStudioCompilerOptions.mockResolvedValue({
      compilerOptions: {},
      warnings: [],
      errors: [],
    });
    mockCollectRecoverableParseWarnings.mockReturnValue([]);
  });

  it('uses project-aware compile context only when the edited agent name is provided', async () => {
    mockParseAgentBasedABL.mockReturnValue({
      document: { name: 'booking_agent', tools: [] },
      errors: [],
      warnings: [],
    });
    mockCollectRecoverableParseWarnings.mockReturnValue(['Line 4: recoverable parse warning']);
    mockBuildProjectCompileContext.mockResolvedValue({
      allDocs: [{ name: 'booking_agent' }],
      compilerOptions: { mode: 'preview' },
      errors: [],
      warnings: ['W901: project context warning'],
    });
    mockCompileABLtoIR.mockReturnValue({
      agents: {
        booking_agent: {
          metadata: { name: 'booking_agent' },
        },
      },
      resolved_config_variables: { API_BASE: 'https://example.com' },
    });
    mockCollectTargetCompilationMessages.mockReturnValue({
      errors: [],
      warnings: ['booking_agent: W721: compile warning'],
    });
    mockPickTargetIR.mockReturnValue({
      metadata: { name: 'booking_agent' },
    });

    const { POST } = await import('@/app/api/abl/compile/route');

    const response = await POST(
      makeRequest('/api/abl/compile', {
        dsl: 'AGENT: booking_agent\nGOAL: "Help customers"',
        projectId: 'proj-1',
        agentName: 'booking_agent',
      }),
    );

    expect(mockRequireProjectAccess).toHaveBeenCalledWith('proj-1', {
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'test@example.com',
    });
    expect(mockBuildProjectCompileContext).toHaveBeenCalledWith({
      agentName: 'booking_agent',
      mode: 'best_effort',
      projectId: 'proj-1',
      targetDocument: { name: 'booking_agent', tools: [] },
      tenantId: 'tenant-1',
    });
    expect(mockCompileABLtoIR).toHaveBeenCalledWith([{ name: 'booking_agent' }], {
      mode: 'preview',
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      ir: { metadata: { name: 'booking_agent' } },
      errors: [],
      warnings: [
        'Line 4: recoverable parse warning',
        'W901: project context warning',
        'booking_agent: W721: compile warning',
      ],
      resolved_config_variables: { API_BASE: 'https://example.com' },
    });
  });

  it('keeps projectId-only compiles scoped to the edited document instead of pulling in siblings', async () => {
    mockParseAgentBasedABL.mockReturnValue({
      document: { name: 'scratch_agent', tools: [] },
      errors: [],
      warnings: [],
    });
    mockCompileABLtoIR.mockReturnValue({
      agents: {
        scratch_agent: {
          metadata: { name: 'scratch_agent' },
        },
      },
      compilation_errors: [],
    });

    const { POST } = await import('@/app/api/abl/compile/route');

    const response = await POST(
      makeRequest('/api/abl/compile', {
        dsl: 'AGENT: scratch_agent\nGOAL: "Draft something"',
        projectId: 'proj-1',
      }),
    );

    expect(mockRequireProjectAccess).toHaveBeenCalledWith('proj-1', {
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'test@example.com',
    });
    expect(mockBuildProjectCompileContext).not.toHaveBeenCalled();
    expect(mockBuildStudioCompilerOptions).toHaveBeenCalledWith({
      documents: [{ name: 'scratch_agent', tools: [] }],
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      configVariables: undefined,
    });
    expect(mockCompileABLtoIR).toHaveBeenCalledWith(
      [{ name: 'scratch_agent', tools: [] }],
      undefined,
    );
    await expect(response.json()).resolves.toEqual({
      success: true,
      ir: { metadata: { name: 'scratch_agent' } },
      errors: [],
      warnings: [],
    });
  });

  it('rejects project-scoped compile before loading project context when access fails', async () => {
    const notFound = NextResponse.json(
      { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } },
      { status: 404 },
    );
    mockRequireProjectAccess.mockResolvedValue(notFound);
    mockIsAccessError.mockImplementation((value) => value === notFound);
    mockParseAgentBasedABL.mockReturnValue({
      document: { name: 'booking_agent', tools: [] },
      errors: [],
      warnings: [],
    });

    const { POST } = await import('@/app/api/abl/compile/route');

    const response = await POST(
      makeRequest('/api/abl/compile', {
        dsl: 'AGENT: booking_agent\nGOAL: "Help customers"',
        projectId: 'proj-locked',
        agentName: 'booking_agent',
      }),
    );

    expect(response.status).toBe(404);
    expect(mockRequireProjectAccess).toHaveBeenCalledWith('proj-locked', {
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'test@example.com',
    });
    expect(mockBuildProjectCompileContext).not.toHaveBeenCalled();
    expect(mockFindConfigVariablesByProject).not.toHaveBeenCalled();
    expect(mockBuildStudioCompilerOptions).not.toHaveBeenCalled();
    expect(mockCompileABLtoIR).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });
});
