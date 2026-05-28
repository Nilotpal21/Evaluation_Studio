import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);
const mockGetDiagnostics = vi.fn();
const mockParseAgentBasedABL = vi.fn();
const mockCompileABLtoIR = vi.fn();
const mockBuildProjectCompileContext = vi.fn();
const mockCollectTargetCompilationMessages = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

vi.mock('@abl/language-service', () => ({
  getDiagnostics: (...args: unknown[]) => mockGetDiagnostics(...args),
}));

vi.mock('@abl/core', () => ({
  parseAgentBasedABL: mockParseAgentBasedABL,
}));

vi.mock('@abl/compiler', () => ({
  compileABLtoIR: mockCompileABLtoIR,
}));

vi.mock('@/lib/abl/project-aware-compile', () => ({
  buildProjectCompileContext: mockBuildProjectCompileContext,
  collectTargetCompilationMessages: mockCollectTargetCompilationMessages,
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

describe('POST /api/abl/diagnostics', () => {
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
    mockGetDiagnostics.mockReturnValue([]);
  });

  it('surfaces project-aware duplicate-name errors and skips full compile', async () => {
    mockParseAgentBasedABL.mockReturnValue({
      document: { name: 'travel_agent' },
      errors: [],
      warnings: [],
    });
    mockBuildProjectCompileContext.mockResolvedValue({
      allDocs: [{ name: 'travel_agent' }],
      compilerOptions: {},
      errors: [
        'Agent name "travel_agent" is already used by edited agent "booking_agent" and project agent "travel_agent". Rename one of the agents before compiling.',
      ],
      warnings: ['W901: Tool resolution warning'],
    });
    mockCompileABLtoIR.mockReturnValue({ agents: {} });
    mockCollectTargetCompilationMessages.mockReturnValue({ errors: [], warnings: [] });

    const { POST } = await import('@/app/api/abl/diagnostics/route');

    const response = await POST(
      makeRequest('/api/abl/diagnostics', {
        dsl: 'AGENT: travel_agent\nGOAL: "Help customers"',
        tier: 3,
        projectId: 'proj-1',
        agentName: 'booking_agent',
      }),
    );

    expect(mockCompileABLtoIR).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: false,
      diagnostics: [
        {
          severity: 'warning',
          message: 'W901: Tool resolution warning',
          line: 1,
          column: 1,
          source: 'compile',
        },
        {
          severity: 'error',
          message:
            'Agent name "travel_agent" is already used by edited agent "booking_agent" and project agent "travel_agent". Rename one of the agents before compiling.',
          line: 1,
          column: 1,
          source: 'compile',
        },
      ],
    });
  });
});
