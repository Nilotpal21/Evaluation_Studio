import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);
const mockFindProjectAgent = vi.fn();
const mockParseAgentBasedABL = vi.fn();
const mockCompileABLtoIR = vi.fn();
const mockBuildProjectCompileContext = vi.fn();
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

vi.mock('@/repos/project-repo', () => ({
  findProjectAgent: mockFindProjectAgent,
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
  pickTargetIR: mockPickTargetIR,
  STUDIO_PROJECT_AWARE_COMPILE_MODE: 'best_effort',
}));

type RouteCtx = { params: Promise<Record<string, string>> };

function makeRequest(path: string, body?: unknown): NextRequest {
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  return new NextRequest(new URL(path, 'http://localhost:3000'), init);
}

function routeCtx(params: Record<string, string>): RouteCtx {
  return { params: Promise.resolve(params) };
}

describe('POST /api/projects/:id/agents/:agentId/compile', () => {
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
  });

  it('keeps warning-only compiles out of the errors array', async () => {
    mockFindProjectAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'booking_agent',
      dslContent: 'AGENT: booking_agent\nGOAL: "Help customers"',
    });
    mockParseAgentBasedABL.mockReturnValue({
      document: { name: 'booking_agent' },
      errors: [],
      warnings: [],
    });
    mockCollectRecoverableParseWarnings.mockReturnValue([]);
    mockBuildProjectCompileContext.mockResolvedValue({
      allDocs: [{ name: 'booking_agent' }],
      compilerOptions: {},
      errors: [],
      warnings: ['W901: Tool resolution warning'],
    });
    mockCompileABLtoIR.mockReturnValue({
      agents: {
        booking_agent: {
          metadata: { name: 'booking_agent' },
        },
      },
    });
    mockCollectTargetCompilationMessages.mockReturnValue({
      errors: [],
      warnings: ['booking_agent: W721: Tool "lookup" signature differs'],
    });
    mockPickTargetIR.mockReturnValue({
      metadata: { name: 'booking_agent' },
    });

    const { POST } = await import('@/app/api/projects/[id]/agents/[agentId]/compile/route');

    const response = await POST(
      makeRequest('/api/projects/proj-1/agents/booking_agent/compile', {
        dsl: 'AGENT: booking_agent\nGOAL: "Help customers"',
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      ir: { metadata: { name: 'booking_agent' } },
      errors: [],
      warnings: [
        'W901: Tool resolution warning',
        'booking_agent: W721: Tool "lookup" signature differs',
      ],
    });
  });

  it('fails before full compilation when project-aware context finds duplicate agent names', async () => {
    mockFindProjectAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'booking_agent',
      dslContent: 'AGENT: travel_agent\nGOAL: "Help customers"',
    });
    mockParseAgentBasedABL.mockReturnValue({
      document: { name: 'travel_agent' },
      errors: [],
      warnings: [],
    });
    mockCollectRecoverableParseWarnings.mockReturnValue([]);
    mockBuildProjectCompileContext.mockResolvedValue({
      allDocs: [{ name: 'travel_agent' }],
      compilerOptions: {},
      errors: [
        'Agent name "travel_agent" is already used by edited agent "booking_agent" and project agent "travel_agent". Rename one of the agents before compiling.',
      ],
      warnings: ['W901: Tool resolution warning'],
    });

    const { POST } = await import('@/app/api/projects/[id]/agents/[agentId]/compile/route');

    const response = await POST(
      makeRequest('/api/projects/proj-1/agents/booking_agent/compile', {
        dsl: 'AGENT: travel_agent\nGOAL: "Help customers"',
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );

    expect(mockCompileABLtoIR).not.toHaveBeenCalled();
    expect(mockCollectTargetCompilationMessages).not.toHaveBeenCalled();
    expect(mockPickTargetIR).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: false,
      ir: null,
      errors: [
        'Agent name "travel_agent" is already used by edited agent "booking_agent" and project agent "travel_agent". Rename one of the agents before compiling.',
      ],
      warnings: ['W901: Tool resolution warning'],
    });
  });

  it('fails closed when the target IR is missing from an otherwise clean compile', async () => {
    mockFindProjectAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'booking_agent',
      dslContent: 'AGENT: booking_agent\nGOAL: "Help customers"',
    });
    mockParseAgentBasedABL.mockReturnValue({
      document: { name: 'booking_agent' },
      errors: [],
      warnings: [],
    });
    mockCollectRecoverableParseWarnings.mockReturnValue([]);
    mockBuildProjectCompileContext.mockResolvedValue({
      allDocs: [{ name: 'booking_agent' }],
      compilerOptions: {},
      errors: [],
      warnings: [],
    });
    mockCompileABLtoIR.mockReturnValue({
      agents: {},
    });
    mockCollectTargetCompilationMessages.mockReturnValue({
      errors: [],
      warnings: [],
    });
    mockPickTargetIR.mockReturnValue(null);

    const { POST } = await import('@/app/api/projects/[id]/agents/[agentId]/compile/route');

    const response = await POST(
      makeRequest('/api/projects/proj-1/agents/booking_agent/compile', {
        dsl: 'AGENT: booking_agent\nGOAL: "Help customers"',
      }),
      routeCtx({ id: 'proj-1', agentId: 'booking_agent' }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: false,
      ir: null,
      errors: ['Compiled project output did not include agent "booking_agent".'],
      warnings: [],
    });
  });
});
