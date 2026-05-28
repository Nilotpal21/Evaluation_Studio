import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getProjectAgentsMock,
  projectToolFindMock,
  agentModelConfigFindOneMock,
  modelConfigFindOneMock,
  tenantModelFindOneMock,
  findProjectByIdAndTenantMock,
  buildStudioConnectorToolResolverMock,
  runDiagnosticsMock,
  compileABLtoIRMock,
  compileProjectAgentsForDiagnosticsMock,
} = vi.hoisted(() => ({
  getProjectAgentsMock: vi.fn(),
  projectToolFindMock: vi.fn(),
  agentModelConfigFindOneMock: vi.fn(),
  modelConfigFindOneMock: vi.fn(),
  tenantModelFindOneMock: vi.fn(),
  findProjectByIdAndTenantMock: vi.fn(),
  buildStudioConnectorToolResolverMock: vi.fn(),
  runDiagnosticsMock: vi.fn(),
  compileABLtoIRMock: vi.fn(),
  compileProjectAgentsForDiagnosticsMock: vi.fn(),
}));

function createSelectableLeanQuery(result: unknown[]) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(result),
    }),
  };
}

function createLeanQuery(result: unknown) {
  return {
    lean: vi.fn().mockResolvedValue(result),
  };
}

function createSortedLeanQuery(result: unknown) {
  return {
    sort: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(result),
    }),
  };
}

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@abl/compiler', () => ({
  compileABLtoIR: compileABLtoIRMock,
}));

vi.mock('@/lib/abl/project-aware-compile', () => ({
  compileProjectAgentsForDiagnostics: (...args: unknown[]) =>
    compileProjectAgentsForDiagnosticsMock(...args),
}));

vi.mock('@agent-platform/arch-ai', () => ({
  runDiagnostics: runDiagnosticsMock,
}));

vi.mock('../../lib/arch-ai/guards', () => ({
  checkToolPermission: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@/services/project-service', () => ({
  getProjectAgents: getProjectAgentsMock,
}));

vi.mock('@/repos/project-repo', () => ({
  findProjectByIdAndTenant: findProjectByIdAndTenantMock,
}));

vi.mock('@/lib/connection-service', () => ({
  buildStudioConnectorToolResolver: buildStudioConnectorToolResolverMock,
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectTool: {
    find: projectToolFindMock,
  },
  AgentModelConfig: {
    findOne: agentModelConfigFindOneMock,
  },
  ModelConfig: {
    findOne: modelConfigFindOneMock,
  },
  TenantModel: {
    findOne: tenantModelFindOneMock,
  },
}));

import { executeHealthCheck } from '@/lib/arch-ai/tools/health-check';

const ROUTER_WITH_ACTION_HANDLER_DELEGATE = `AGENT: RouterAgent
GOAL: "Handle action-based routing"

FLOW:
  entry_point: choose
  steps:
    - choose

choose:
  REASONING: false
  RESPOND: "Choose a route"
    ACTIONS:
      - BUTTON: "Delegate" -> delegate_btn
  ON_ACTION:
    delegate_btn:
      DO:
        - DELEGATE: SpecialistAgent
          RETURN: true
`;

const ROUTER_WITH_MISSING_ACTION_HANDLER_DELEGATE = ROUTER_WITH_ACTION_HANDLER_DELEGATE.replace(
  'SpecialistAgent',
  'MissingAgent',
);

const SPECIALIST_DSL = `AGENT: SpecialistAgent
GOAL: "Handle specialist work"
`;

function dslWithGuardrails(agentName: string): string {
  return `AGENT: ${agentName}
GOAL: "Handle ${agentName} work"

GUARDRAILS:
  content_safety:
    kind: input
    check: detect_prompt_injection(input) == false
    action: block
    message: "Please keep the conversation respectful."
`;
}

describe('health-check routing parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectToolFindMock.mockReturnValue(createSelectableLeanQuery([]));
    agentModelConfigFindOneMock.mockReturnValue(createLeanQuery(null));
    modelConfigFindOneMock.mockReturnValue(createSortedLeanQuery(null));
    tenantModelFindOneMock.mockReturnValue(createLeanQuery(null));
    findProjectByIdAndTenantMock.mockResolvedValue({ entryAgentName: 'RouterAgent' });
    buildStudioConnectorToolResolverMock.mockResolvedValue(undefined);
    compileABLtoIRMock.mockReturnValue({ compilation_errors: [], agents: {} });
    compileProjectAgentsForDiagnosticsMock.mockResolvedValue({
      compiled: {
        version: '1.0',
        compiled_at: '2026-05-02T00:00:00.000Z',
        agents: {},
        compilation_errors: [],
        compilation_warnings: [],
      },
      errors: [],
      warnings: [],
      parseErrors: [],
    });
    runDiagnosticsMock.mockReturnValue({ topIssues: [] });
  });

  it('fails missing action-handler routing targets', async () => {
    getProjectAgentsMock.mockResolvedValue([
      {
        name: 'RouterAgent',
        dslContent: ROUTER_WITH_MISSING_ACTION_HANDLER_DELEGATE,
      },
    ]);

    const result = await executeHealthCheck(
      { action: 'run_check' },
      {
        projectId: 'project-1',
        user: {
          permissions: ['agent:read'],
          tenantId: 'tenant-1',
          userId: 'user-1',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      overall: 'Critical',
      agents: [
        expect.objectContaining({
          agentName: 'RouterAgent',
          checks: expect.objectContaining({
            handoffs: 'FAIL',
          }),
          details: expect.arrayContaining([
            expect.objectContaining({
              check: 'handoffs',
              message: expect.stringContaining('MissingAgent'),
            }),
          ]),
        }),
      ],
    });
  });

  it('uses action-handler delegate routes for reachability checks', async () => {
    getProjectAgentsMock.mockResolvedValue([
      {
        name: 'RouterAgent',
        dslContent: ROUTER_WITH_ACTION_HANDLER_DELEGATE,
      },
      {
        name: 'SpecialistAgent',
        dslContent: SPECIALIST_DSL,
      },
    ]);

    const result = await executeHealthCheck(
      { action: 'run_check' },
      {
        projectId: 'project-1',
        user: {
          permissions: ['agent:read'],
          tenantId: 'tenant-1',
          userId: 'user-1',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      crossAgentFindings: [],
    });
  });

  it('surfaces project-aware semantic findings when companion context cannot be resolved', async () => {
    getProjectAgentsMock.mockResolvedValue([
      {
        name: 'RouterAgent',
        dslContent: ROUTER_WITH_ACTION_HANDLER_DELEGATE,
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
        },
      },
    ]);
    compileProjectAgentsForDiagnosticsMock.mockResolvedValue({
      compiled: null,
      errors: [
        'Project-aware compile could not resolve project agent "RouterAgent" prompt library reference: missing prompt version',
      ],
      warnings: [],
      parseErrors: [],
    });

    const result = await executeHealthCheck(
      { action: 'run_check' },
      {
        projectId: 'project-1',
        user: {
          permissions: ['agent:read'],
          tenantId: 'tenant-1',
          userId: 'user-1',
        },
      },
    );

    expect(compileProjectAgentsForDiagnosticsMock).toHaveBeenCalledWith({
      agents: [
        {
          name: 'RouterAgent',
          dslContent: ROUTER_WITH_ACTION_HANDLER_DELEGATE,
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        },
      ],
      projectId: 'project-1',
      tenantId: 'tenant-1',
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      overall: 'Critical',
      semanticFindings: [
        expect.objectContaining({
          code: 'STUDIO-PROJECT-AWARE',
          severity: 'error',
          message: expect.stringContaining('prompt library reference'),
        }),
      ],
    });
  });

  it('counts cross-agent warnings toward the overall status', async () => {
    modelConfigFindOneMock.mockReturnValue(createSortedLeanQuery({ _id: 'model-config-1' }));
    getProjectAgentsMock.mockResolvedValue([
      {
        name: 'RouterAgent',
        dslContent: dslWithGuardrails('RouterAgent'),
      },
      {
        name: 'OrphanAgent',
        dslContent: dslWithGuardrails('OrphanAgent'),
      },
    ]);

    const result = await executeHealthCheck(
      { action: 'run_check' },
      {
        projectId: 'project-1',
        user: {
          permissions: ['agent:read'],
          tenantId: 'tenant-1',
          userId: 'user-1',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      overall: 'Warning',
      crossAgentFindings: [
        expect.objectContaining({
          code: 'CROSS-02',
          severity: 'warning',
        }),
      ],
    });
  });

  it('uses the full project graph when per-agent checks are capped', async () => {
    const agents = Array.from({ length: 21 }, (_, index) => {
      const agentNumber = String(index + 1).padStart(2, '0');
      const name = `Agent${agentNumber}`;
      return {
        name,
        dslContent:
          name === 'Agent01'
            ? `AGENT: Agent01
GOAL: "Route to a capped-out specialist"

HANDOFF:
  - TO: Agent21
    WHEN: user.needs_specialist
    EXPECT_RETURN: true
`
            : `AGENT: ${name}
GOAL: "Handle ${name} work"
`,
      };
    });
    getProjectAgentsMock.mockResolvedValue(agents);
    findProjectByIdAndTenantMock.mockResolvedValue({ entryAgentName: 'Agent01' });

    const result = await executeHealthCheck(
      { action: 'run_check' },
      {
        projectId: 'project-1',
        user: {
          permissions: ['agent:read'],
          tenantId: 'tenant-1',
          userId: 'user-1',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({
          agentName: 'Agent01',
          checks: expect.objectContaining({
            handoffs: 'PASS',
          }),
          details: expect.arrayContaining([
            expect.objectContaining({
              check: 'handoffs',
              status: 'PASS',
              message: expect.stringContaining('All 1 routing target'),
            }),
          ]),
        }),
      ]),
    });
    expect(JSON.stringify(result.data)).not.toContain('Missing routing targets: Agent21');
  });

  it('passes model config when the agent inherits a project default', async () => {
    modelConfigFindOneMock.mockReturnValue(createSortedLeanQuery({ _id: 'project-model-1' }));
    getProjectAgentsMock.mockResolvedValue([
      {
        name: 'RouterAgent',
        dslContent: dslWithGuardrails('RouterAgent'),
      },
    ]);

    const result = await executeHealthCheck(
      { action: 'run_check' },
      {
        projectId: 'project-1',
        user: {
          permissions: ['agent:read'],
          tenantId: 'tenant-1',
          userId: 'user-1',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      agents: [
        expect.objectContaining({
          agentName: 'RouterAgent',
          checks: expect.objectContaining({
            modelConfig: 'PASS',
          }),
          details: expect.arrayContaining([
            expect.objectContaining({
              check: 'modelConfig',
              status: 'PASS',
              message: 'Agent inherits project model configuration',
            }),
          ]),
        }),
      ],
    });
  });
});
