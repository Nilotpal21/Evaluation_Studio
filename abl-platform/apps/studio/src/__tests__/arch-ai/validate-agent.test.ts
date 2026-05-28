import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkToolPermissionMock = vi.fn();
const getProjectAgentsMock = vi.fn();
const compileProjectAgentsForDiagnosticsMock = vi.fn();
const runDiagnosticsMock = vi.fn();

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/lib/arch-ai/tools/guards', () => ({
  checkToolPermission: (...args: unknown[]) => checkToolPermissionMock(...args),
}));

vi.mock('@/services/project-service', () => ({
  getProjectAgents: (...args: unknown[]) => getProjectAgentsMock(...args),
}));

vi.mock('@/lib/abl/project-aware-compile', () => ({
  compileProjectAgentsForDiagnostics: (...args: unknown[]) =>
    compileProjectAgentsForDiagnosticsMock(...args),
}));

vi.mock('@agent-platform/arch-ai', () => ({
  runDiagnostics: (...args: unknown[]) => runDiagnosticsMock(...args),
}));

import { executeValidateAgent } from '@/lib/arch-ai/tools/validate-agent';

describe('executeValidateAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkToolPermissionMock.mockResolvedValue({ allowed: true });
    getProjectAgentsMock.mockResolvedValue([
      {
        name: 'RouterAgent',
        dslContent: 'AGENT: RouterAgent\nGOAL: "Route work"\n',
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
        },
      },
    ]);
    compileProjectAgentsForDiagnosticsMock.mockResolvedValue({
      compiled: {
        version: '1.0',
        compiled_at: '2026-05-02T00:00:00.000Z',
        agents: { RouterAgent: {} },
        compilation_errors: [],
        compilation_warnings: [],
      },
      errors: [
        'Project-aware compile could not resolve project agent "RouterAgent" prompt library reference: missing prompt version',
      ],
      warnings: [],
      parseErrors: [],
    });
    runDiagnosticsMock.mockReturnValue({
      sections: [],
      topIssues: [],
      summary: { errors: 0, warnings: 0, infos: 0, total: 0 },
    });
  });

  it('uses project-aware diagnostics compilation and surfaces companion context findings', async () => {
    const result = await executeValidateAgent(
      { agentName: 'RouterAgent', depth: 'deep' },
      {
        projectId: 'proj-1',
        user: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          permissions: ['agent:read'],
        },
      },
    );

    expect(compileProjectAgentsForDiagnosticsMock).toHaveBeenCalledWith({
      agents: [
        {
          name: 'RouterAgent',
          dslContent: 'AGENT: RouterAgent\nGOAL: "Route work"\n',
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        },
      ],
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      topIssues: [
        expect.objectContaining({
          code: 'STUDIO-PROJECT-AWARE',
          severity: 'error',
          message: expect.stringContaining('prompt library reference'),
        }),
      ],
      summary: expect.objectContaining({
        errors: 1,
      }),
    });
  });
});
