import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildBuildToolsMock,
  buildBlueprintToolsMock,
  buildInterviewToolsMock,
  buildInProjectToolsMock,
  buildCompileAblExecuteMock,
  buildGenerateAgentExecuteMock,
  buildProceedToNextPhaseExecuteMock,
  buildSaveToolDslExecuteMock,
  blueprintGenerateTopologyExecuteMock,
  blueprintProceedToNextPhaseExecuteMock,
  healthCheckExecuteMock,
  interviewProceedToNextPhaseExecuteMock,
  interviewUpdateSpecificationExecuteMock,
  kbManageExecuteMock,
  proposeModificationExecuteMock,
  readTopologyExecuteMock,
  recommendModelExecuteMock,
  analyzeConstraintsExecuteMock,
  sessionOpsExecuteMock,
  sessionServiceGetByIdMock,
  toolsOpsExecuteMock,
  validateAgentExecuteMock,
  validateProjectAgentCodeMock,
} = vi.hoisted(() => ({
  buildBuildToolsMock: vi.fn(),
  buildBlueprintToolsMock: vi.fn(),
  buildInterviewToolsMock: vi.fn(),
  buildInProjectToolsMock: vi.fn(),
  buildCompileAblExecuteMock: vi.fn(),
  buildGenerateAgentExecuteMock: vi.fn(),
  buildProceedToNextPhaseExecuteMock: vi.fn(),
  buildSaveToolDslExecuteMock: vi.fn(),
  blueprintGenerateTopologyExecuteMock: vi.fn(),
  blueprintProceedToNextPhaseExecuteMock: vi.fn(),
  healthCheckExecuteMock: vi.fn(),
  interviewProceedToNextPhaseExecuteMock: vi.fn(),
  interviewUpdateSpecificationExecuteMock: vi.fn(),
  kbManageExecuteMock: vi.fn(),
  proposeModificationExecuteMock: vi.fn(),
  readTopologyExecuteMock: vi.fn(),
  recommendModelExecuteMock: vi.fn(),
  analyzeConstraintsExecuteMock: vi.fn(),
  sessionOpsExecuteMock: vi.fn(),
  sessionServiceGetByIdMock: vi.fn(),
  toolsOpsExecuteMock: vi.fn(),
  validateAgentExecuteMock: vi.fn(),
  validateProjectAgentCodeMock: vi.fn(),
}));

vi.mock('@/lib/arch-ai/message-services', () => ({
  sessionService: {
    getById: sessionServiceGetByIdMock,
  },
}));
vi.mock('@/lib/arch-ai/tools/interview-tools', () => ({
  buildInterviewTools: buildInterviewToolsMock,
}));
vi.mock('@/lib/arch-ai/tools/blueprint-tools', () => ({
  buildBlueprintTools: buildBlueprintToolsMock,
}));
vi.mock('@/lib/arch-ai/tools/build-tools', () => ({
  buildBuildTools: buildBuildToolsMock,
}));
vi.mock('@/lib/arch-ai/tools/in-project-tools', () => ({
  buildInProjectTools: buildInProjectToolsMock,
  validateProjectAgentCode: validateProjectAgentCodeMock,
}));

import { buildV1CoreRefs } from '@/lib/arch-ai/compat/v1-core-refs';

describe('buildV1CoreRefs', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    sessionServiceGetByIdMock.mockResolvedValue({
      metadata: {
        phase: 'BUILD',
      },
    });
    interviewUpdateSpecificationExecuteMock.mockResolvedValue('Updated projectName');
    interviewProceedToNextPhaseExecuteMock.mockResolvedValue({
      success: true,
      phase: 'BLUEPRINT',
    });
    blueprintGenerateTopologyExecuteMock.mockResolvedValue('Topology generated');
    blueprintProceedToNextPhaseExecuteMock.mockResolvedValue({
      success: true,
      phase: 'BUILD',
    });
    buildGenerateAgentExecuteMock.mockResolvedValue('Agent LeadIntake generated');
    buildCompileAblExecuteMock.mockResolvedValue({
      status: 'pass',
      warnings: [],
      errors: [],
    });
    buildProceedToNextPhaseExecuteMock.mockResolvedValue({
      success: true,
      phase: 'CREATE',
    });
    buildSaveToolDslExecuteMock.mockResolvedValue('Saved tool DSL');

    buildInterviewToolsMock.mockImplementation(() => ({
      update_specification: { execute: interviewUpdateSpecificationExecuteMock },
      proceed_to_next_phase: { execute: interviewProceedToNextPhaseExecuteMock },
    }));
    buildBlueprintToolsMock.mockImplementation(() => ({
      generate_topology: { execute: blueprintGenerateTopologyExecuteMock },
      proceed_to_next_phase: { execute: blueprintProceedToNextPhaseExecuteMock },
    }));
    buildBuildToolsMock.mockImplementation(() => ({
      generate_agent: { execute: buildGenerateAgentExecuteMock },
      compile_abl: { execute: buildCompileAblExecuteMock },
      proceed_to_next_phase: { execute: buildProceedToNextPhaseExecuteMock },
      save_tool_dsl: { execute: buildSaveToolDslExecuteMock },
    }));

    readTopologyExecuteMock.mockResolvedValue({ agentCount: 0, edgeCount: 0 });
    healthCheckExecuteMock.mockResolvedValue({
      overall: 'healthy',
      agents: [{ name: 'LeadIntake', status: 'healthy' }],
      summary: { healthy: 1, warnings: 0, errors: 0 },
    });
    recommendModelExecuteMock.mockResolvedValue({
      primary: { modelId: 'gpt-4.1', provider: 'openai' },
      recommendations: [{ modelId: 'gpt-4.1', provider: 'openai', score: 0.98 }],
    });
    analyzeConstraintsExecuteMock.mockResolvedValue({
      coverage: [
        { constraint: 'Keep answers concise', covered: true, evidence: 'Present in GOAL' },
      ],
    });
    sessionOpsExecuteMock.mockResolvedValue({
      success: true,
      data: { sessions: [{ id: 'runtime-session-1' }] },
    });
    proposeModificationExecuteMock.mockResolvedValue({
      success: true,
      proposal: {
        agentName: 'LeadIntake',
        reviewStatus: 'pending',
        changes: [
          {
            construct: 'FULL',
            before: 'AGENT: LeadIntake\nGOAL: "Capture leads"',
            after: 'AGENT: LeadIntake\nGOAL: "Qualify leads quickly"',
            rationale: 'Tighten the lead handling goal.',
          },
        ],
      },
    });
    toolsOpsExecuteMock.mockResolvedValue({ tools: [] });
    validateAgentExecuteMock.mockResolvedValue({ success: true, findings: [] });
    validateProjectAgentCodeMock.mockResolvedValue({
      valid: true,
      warnings: [],
      agentsInScope: 2,
    });

    buildInProjectToolsMock.mockImplementation(
      (_ctx, _sessionId, _projectId, _authToken, onCardEmit?: (event: unknown) => void) => ({
        propose_modification: { execute: proposeModificationExecuteMock },
        read_topology: { execute: readTopologyExecuteMock },
        session_ops: { execute: sessionOpsExecuteMock },
        tools_ops: { execute: toolsOpsExecuteMock },
        validate_agent: { execute: validateAgentExecuteMock },
        health_check: { execute: healthCheckExecuteMock },
        recommend_model: { execute: recommendModelExecuteMock },
        analyze_constraints: { execute: analyzeConstraintsExecuteMock },
        kb_manage: {
          execute: async (input: Record<string, unknown>) => {
            kbManageExecuteMock(input);
            onCardEmit?.({
              type: 'kb_status_card',
              kbId: 'kb-1',
              kbName: 'SupportDocs',
              status: 'ready',
              stats: {
                documentCount: 12,
                chunkCount: 120,
                sourceCount: 3,
                connectorCount: 1,
              },
              actions: [],
            });
            return { success: true, data: { knowledgeBase: { _id: 'kb-1' } } };
          },
        },
      }),
    );
  });

  it('routes interview compat refs through v4-local interview builders', async () => {
    sessionServiceGetByIdMock.mockResolvedValue({
      metadata: {
        phase: 'INTERVIEW',
      },
    });

    const refs = await buildV1CoreRefs();
    const ctx = {
      tenantId: 'tenant-interview',
      userId: 'user-interview',
      sessionId: 'ctx-session',
      projectId: 'project-interview',
      signal: new AbortController().signal,
      emit: vi.fn(),
      services: {
        authToken: 'token-interview',
      },
    };

    await expect(
      refs.updateSpecification(ctx, 'session-interview', 'projectName', 'Acme CRM'),
    ).resolves.toEqual('Updated projectName');
    await expect(refs.proceedToNextPhase(ctx, 'session-interview', 'Looks good')).resolves.toEqual({
      success: true,
      phase: 'BLUEPRINT',
    });

    expect(sessionServiceGetByIdMock).toHaveBeenNthCalledWith(
      1,
      { tenantId: 'tenant-interview', userId: 'user-interview' },
      'session-interview',
    );
    expect(sessionServiceGetByIdMock).toHaveBeenNthCalledWith(
      2,
      { tenantId: 'tenant-interview', userId: 'user-interview' },
      'session-interview',
    );
    expect(buildInterviewToolsMock).toHaveBeenNthCalledWith(
      1,
      { tenantId: 'tenant-interview', userId: 'user-interview' },
      'session-interview',
      { metadata: { phase: 'INTERVIEW' } },
      undefined,
      'token-interview',
      { includeCollectFile: false },
    );
    expect(buildInterviewToolsMock).toHaveBeenNthCalledWith(
      2,
      { tenantId: 'tenant-interview', userId: 'user-interview' },
      'session-interview',
      { metadata: { phase: 'INTERVIEW' } },
      undefined,
      'token-interview',
      { includeCollectFile: false },
    );
    expect(interviewUpdateSpecificationExecuteMock).toHaveBeenCalledWith({
      field: 'projectName',
      value: 'Acme CRM',
    });
    expect(interviewProceedToNextPhaseExecuteMock).toHaveBeenCalledWith({
      reason: 'Looks good',
    });
    expect(buildBlueprintToolsMock).not.toHaveBeenCalled();
    expect(buildBuildToolsMock).not.toHaveBeenCalled();
  });

  it('routes blueprint compat refs through v4-local blueprint builders', async () => {
    sessionServiceGetByIdMock.mockResolvedValue({
      metadata: {
        phase: 'BLUEPRINT',
      },
    });

    const refs = await buildV1CoreRefs();
    const ctx = {
      tenantId: 'tenant-blueprint',
      userId: 'user-blueprint',
      sessionId: 'ctx-session',
      projectId: 'project-blueprint',
      signal: new AbortController().signal,
      emit: vi.fn(),
      services: {
        authToken: 'token-blueprint',
      },
    };
    const topology = {
      agents: [
        {
          name: 'LeadIntake',
          role: 'Triage inbound leads',
          executionMode: 'reasoning',
          description: 'Qualify leads before routing them onward',
        },
      ],
      edges: [],
      entryPoint: 'LeadIntake',
    };

    await expect(refs.generateTopology(ctx, 'session-blueprint', topology)).resolves.toEqual(
      'Topology generated',
    );
    await expect(
      refs.proceedToNextPhase(ctx, 'session-blueprint', 'Approve the blueprint'),
    ).resolves.toEqual({
      success: true,
      phase: 'BUILD',
    });

    expect(buildBlueprintToolsMock).toHaveBeenNthCalledWith(
      1,
      { tenantId: 'tenant-blueprint', userId: 'user-blueprint' },
      'session-blueprint',
      { metadata: { phase: 'BLUEPRINT' } },
      undefined,
      'token-blueprint',
      { includeCollectFile: false },
    );
    expect(buildBlueprintToolsMock).toHaveBeenNthCalledWith(
      2,
      { tenantId: 'tenant-blueprint', userId: 'user-blueprint' },
      'session-blueprint',
      { metadata: { phase: 'BLUEPRINT' } },
      undefined,
      'token-blueprint',
      { includeCollectFile: false },
    );
    expect(blueprintGenerateTopologyExecuteMock).toHaveBeenCalledWith(topology);
    expect(blueprintProceedToNextPhaseExecuteMock).toHaveBeenCalledWith({
      reason: 'Approve the blueprint',
    });
    expect(buildInterviewToolsMock).not.toHaveBeenCalled();
  });

  it('routes build compat refs through v4-local build builders', async () => {
    sessionServiceGetByIdMock.mockResolvedValue({
      metadata: {
        phase: 'BUILD',
      },
    });

    const refs = await buildV1CoreRefs();
    const ctx = {
      tenantId: 'tenant-build',
      userId: 'user-build',
      sessionId: 'ctx-session',
      projectId: 'project-build',
      signal: new AbortController().signal,
      emit: vi.fn(),
      services: {
        authToken: 'token-build',
      },
    };

    await expect(
      refs.generateAgent(ctx, 'session-build', 'LeadIntake', 'AGENT: LeadIntake\nGOAL: Qualify'),
    ).resolves.toEqual('Agent LeadIntake generated');
    await expect(
      refs.compileAbl(ctx, 'session-build', 'AGENT: LeadIntake\nGOAL: Qualify', 'LeadIntake'),
    ).resolves.toEqual({
      status: 'pass',
      warnings: [],
      errors: [],
    });
    await expect(
      refs.saveToolDsl(
        ctx,
        'session-build',
        'check_order',
        'check_order(orderId: string) -> order\nDESCRIPTION: Reads order details',
      ),
    ).resolves.toEqual('Saved tool DSL');
    await expect(
      refs.proceedToNextPhase(ctx, 'session-build', 'Create the project'),
    ).resolves.toEqual({
      success: true,
      phase: 'CREATE',
    });

    expect(buildBuildToolsMock).toHaveBeenNthCalledWith(
      1,
      { tenantId: 'tenant-build', userId: 'user-build' },
      'session-build',
      undefined,
      undefined,
      { includeCollectFile: false },
    );
    expect(buildBuildToolsMock).toHaveBeenNthCalledWith(
      2,
      { tenantId: 'tenant-build', userId: 'user-build' },
      'session-build',
      undefined,
      undefined,
      { includeCollectFile: false },
    );
    expect(buildBuildToolsMock).toHaveBeenNthCalledWith(
      3,
      { tenantId: 'tenant-build', userId: 'user-build' },
      'session-build',
      undefined,
      'TOOLS',
      { includeCollectFile: false },
    );
    expect(buildBuildToolsMock).toHaveBeenNthCalledWith(
      4,
      { tenantId: 'tenant-build', userId: 'user-build' },
      'session-build',
      undefined,
      undefined,
      { includeCollectFile: false },
    );
    expect(buildGenerateAgentExecuteMock).toHaveBeenCalledWith({
      agentName: 'LeadIntake',
      code: 'AGENT: LeadIntake\nGOAL: Qualify',
    });
    expect(buildCompileAblExecuteMock).toHaveBeenCalledWith({
      code: 'AGENT: LeadIntake\nGOAL: Qualify',
      agentName: 'LeadIntake',
    });
    expect(buildSaveToolDslExecuteMock).toHaveBeenCalledWith({
      toolName: 'check_order',
      dslContent: 'check_order(orderId: string) -> order\nDESCRIPTION: Reads order details',
    });
    expect(buildProceedToNextPhaseExecuteMock).toHaveBeenCalledWith({
      reason: 'Create the project',
    });
    expect(buildInterviewToolsMock).not.toHaveBeenCalled();
    expect(buildBlueprintToolsMock).not.toHaveBeenCalled();
  });

  it('forwards in-project refs through v4-local tools with permissions and auth token', async () => {
    const refs = await buildV1CoreRefs();
    const emit = vi.fn();
    const ctx = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      signal: new AbortController().signal,
      emit,
      services: {
        permissions: ['tool:read'],
        authToken: 'token-123',
      },
    };

    await expect(refs.readTopology(ctx, 'project-1')).resolves.toEqual({
      agentCount: 0,
      edgeCount: 0,
    });
    await expect(refs.toolsOps(ctx, 'project-1', { action: 'list' })).resolves.toEqual({
      tools: [],
    });
    await expect(refs.sessionOps(ctx, 'project-1', { action: 'list', limit: 5 })).resolves.toEqual({
      success: true,
      data: { sessions: [{ id: 'runtime-session-1' }] },
    });

    expect(buildInProjectToolsMock).toHaveBeenNthCalledWith(
      1,
      {
        tenantId: 'tenant-1',
        userId: 'user-1',
        permissions: ['tool:read'],
      },
      'session-1',
      'project-1',
      'token-123',
      expect.any(Function),
      {
        pageContext: undefined,
      },
    );
    expect(readTopologyExecuteMock).toHaveBeenCalledWith({});
    expect(toolsOpsExecuteMock).toHaveBeenCalledWith({ action: 'list' });
    expect(sessionOpsExecuteMock).toHaveBeenCalledWith({ action: 'list', limit: 5 });
  });

  it('uses code-aware project validation when validateAgent receives draft code', async () => {
    const refs = await buildV1CoreRefs();
    const ctx = {
      tenantId: 'tenant-2',
      userId: 'user-2',
      sessionId: 'session-2',
      projectId: 'project-2',
      signal: new AbortController().signal,
      emit: vi.fn(),
      services: {
        permissions: ['agent:read'],
      },
    };

    await expect(
      refs.validateAgent(ctx, 'project-2', 'Planner', 'AGENT: Planner\nGOAL: help'),
    ).resolves.toEqual({
      valid: true,
      warnings: [],
      agentsInScope: 2,
    });

    expect(validateProjectAgentCodeMock).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-2',
        userId: 'user-2',
        permissions: ['agent:read'],
      },
      'project-2',
      'Planner',
      'AGENT: Planner\nGOAL: help',
    );
    expect(validateAgentExecuteMock).not.toHaveBeenCalled();
  });

  it('forwards validateAgent depth when validating stored project code', async () => {
    const refs = await buildV1CoreRefs();
    const ctx = {
      tenantId: 'tenant-2',
      userId: 'user-2',
      sessionId: 'session-2',
      projectId: 'project-2',
      signal: new AbortController().signal,
      emit: vi.fn(),
      services: {
        permissions: ['agent:read'],
      },
    };

    await expect(
      refs.validateAgent(ctx, 'project-2', 'Planner', undefined, 'deep'),
    ).resolves.toEqual({
      success: true,
      findings: [],
    });

    expect(validateAgentExecuteMock).toHaveBeenCalledWith({
      agentName: 'Planner',
      depth: 'deep',
    });
  });

  it('routes proposeModification through the v4-local in-project tool set', async () => {
    const refs = await buildV1CoreRefs();
    const ctx = {
      tenantId: 'tenant-3',
      userId: 'user-3',
      sessionId: 'session-3',
      projectId: 'project-3',
      signal: new AbortController().signal,
      emit: vi.fn(),
      services: {
        permissions: ['agent:write'],
        authToken: 'token-xyz',
      },
    };

    const input = {
      agentName: 'LeadIntake',
      change: 'Qualify leads and sound more professional',
      sections: [
        {
          construct: 'GOAL',
          content: 'GOAL: "Capture and qualify new leads"',
        },
      ],
    };

    await expect(refs.proposeModification(ctx, 'project-3', input)).resolves.toEqual({
      success: true,
      proposal: {
        agentName: 'LeadIntake',
        reviewStatus: 'pending',
        changes: [
          {
            construct: 'FULL',
            before: 'AGENT: LeadIntake\nGOAL: "Capture leads"',
            after: 'AGENT: LeadIntake\nGOAL: "Qualify leads quickly"',
            rationale: 'Tighten the lead handling goal.',
          },
        ],
      },
    });

    expect(buildInProjectToolsMock).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-3',
        userId: 'user-3',
        permissions: ['agent:write'],
      },
      'session-3',
      'project-3',
      'token-xyz',
      expect.any(Function),
      {
        pageContext: undefined,
      },
    );
    expect(proposeModificationExecuteMock).toHaveBeenCalledWith(input);
    expect(ctx.emit).toHaveBeenCalledWith({
      artifact: 'diff',
      diffId: 'LeadIntake',
      status: 'pending',
      payload: {
        agentName: 'LeadIntake',
        reviewStatus: 'pending',
        changes: [
          {
            construct: 'FULL',
            before: 'AGENT: LeadIntake\nGOAL: "Capture leads"',
            after: 'AGENT: LeadIntake\nGOAL: "Qualify leads quickly"',
            rationale: 'Tighten the lead handling goal.',
          },
        ],
      },
    });
  });

  it('emits the topology artifact through the compat seam when readTopology returns a graph', async () => {
    readTopologyExecuteMock.mockResolvedValueOnce({
      agents: [
        {
          name: 'LeadIntake',
          mode: 'reasoning',
          description: 'Qualify and route inbound leads',
          tools: [],
        },
        {
          name: 'DemoScheduler',
          mode: 'scripted',
          description: 'Book sales demos',
          tools: [],
        },
      ],
      edges: [
        {
          from: 'LeadIntake',
          to: 'DemoScheduler',
          type: 'delegate',
        },
      ],
      entryPoint: 'LeadIntake',
      agentCount: 2,
      edgeCount: 1,
    });

    const refs = await buildV1CoreRefs();
    const emit = vi.fn();
    const ctx = {
      tenantId: 'tenant-5',
      userId: 'user-5',
      sessionId: 'session-5',
      projectId: 'project-5',
      signal: new AbortController().signal,
      emit,
      services: {
        permissions: ['agent:read'],
        authToken: 'token-topology',
      },
    };

    await expect(refs.readTopology(ctx, 'project-5')).resolves.toEqual({
      agents: [
        {
          name: 'LeadIntake',
          mode: 'reasoning',
          description: 'Qualify and route inbound leads',
          tools: [],
        },
        {
          name: 'DemoScheduler',
          mode: 'scripted',
          description: 'Book sales demos',
          tools: [],
        },
      ],
      edges: [
        {
          from: 'LeadIntake',
          to: 'DemoScheduler',
          type: 'delegate',
        },
      ],
      entryPoint: 'LeadIntake',
      agentCount: 2,
      edgeCount: 1,
    });

    expect(readTopologyExecuteMock).toHaveBeenCalledWith({});
    expect(emit).toHaveBeenCalledWith({
      artifact: 'topology',
      payload: {
        agents: [
          {
            name: 'LeadIntake',
            mode: 'reasoning',
            description: 'Qualify and route inbound leads',
            tools: [],
          },
          {
            name: 'DemoScheduler',
            mode: 'scripted',
            description: 'Book sales demos',
            tools: [],
          },
        ],
        edges: [
          {
            from: 'LeadIntake',
            to: 'DemoScheduler',
            type: 'delegate',
          },
        ],
        entryPoint: 'LeadIntake',
        agentCount: 2,
        edgeCount: 1,
      },
    });
  });

  it('emits health, widget, and KB card artifacts from the compat seam', async () => {
    const refs = await buildV1CoreRefs();
    const emit = vi.fn();
    const ctx = {
      tenantId: 'tenant-4',
      userId: 'user-4',
      sessionId: 'session-4',
      projectId: 'project-4',
      signal: new AbortController().signal,
      emit,
      services: {
        permissions: ['agent:write'],
        authToken: 'token-kb',
      },
    };

    await refs.healthCheck(ctx, 'project-4');
    await refs.recommendModel(ctx, 'project-4', 'LeadIntake');
    await refs.analyzeConstraints(ctx, 'project-4', 'LeadIntake');
    await refs.kbManage(ctx, 'project-4', { action: 'get', kbId: 'kb-1' });

    expect(healthCheckExecuteMock).toHaveBeenCalledWith({});
    expect(recommendModelExecuteMock).toHaveBeenCalledWith({ agentName: 'LeadIntake' });
    expect(analyzeConstraintsExecuteMock).toHaveBeenCalledWith({ agentName: 'LeadIntake' });
    expect(kbManageExecuteMock).toHaveBeenCalledWith({ action: 'get', kbId: 'kb-1' });

    expect(emit).toHaveBeenCalledWith({
      artifact: 'health',
      payload: {
        overall: 'healthy',
        agents: [{ name: 'LeadIntake', status: 'healthy' }],
        summary: { healthy: 1, warnings: 0, errors: 0 },
      },
    });
    expect(emit).toHaveBeenCalledWith({
      artifact: 'widget',
      variant: 'model_comparison',
      payload: {
        primary: { modelId: 'gpt-4.1', provider: 'openai' },
        recommendations: [{ modelId: 'gpt-4.1', provider: 'openai', score: 0.98 }],
      },
    });
    expect(emit).toHaveBeenCalledWith({
      artifact: 'widget',
      variant: 'constraint_coverage',
      payload: {
        coverage: [
          { constraint: 'Keep answers concise', covered: true, evidence: 'Present in GOAL' },
        ],
      },
    });
    expect(emit).toHaveBeenCalledWith({
      artifact: 'widget',
      variant: 'kb_status_card',
      payload: {
        type: 'kb_status_card',
        kbId: 'kb-1',
        kbName: 'SupportDocs',
        status: 'ready',
        stats: {
          documentCount: 12,
          chunkCount: 120,
          sourceCount: 3,
          connectorCount: 1,
        },
        actions: [],
      },
    });
  });
});
