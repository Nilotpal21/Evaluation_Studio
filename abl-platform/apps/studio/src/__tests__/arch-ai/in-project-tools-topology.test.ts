import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function compileABLtoIRForTest(documents: Array<Record<string, unknown>>) {
  const agents: Record<string, Record<string, unknown>> = {};
  for (const doc of documents) {
    const meta = (doc.meta ?? {}) as Record<string, unknown>;
    const name = String(doc.name ?? meta.name ?? 'UnknownAgent');
    const memory = (doc.memory ?? {}) as Record<string, unknown>;
    const handoffs = Array.isArray(doc.handoff) ? doc.handoff : [];
    const delegates = Array.isArray(doc.delegate) ? doc.delegate : [];
    const complete = Array.isArray(doc.complete) ? doc.complete : [];
    agents[name] = {
      ir_version: '1.0',
      metadata: { name, description: '', tags: [], version: '1.0.0' },
      execution: { hints: {}, timeouts: {} },
      identity: { goal: '', persona: '', limitations: [], system_prompt: '' },
      tools: [],
      gather: { fields: Array.isArray(doc.gather) ? doc.gather : [] },
      memory: {
        session: Array.isArray(memory.session) ? memory.session : [],
        persistent: Array.isArray(memory.persistent) ? memory.persistent : [],
      },
      constraints: { constraints: [], guardrails: [] },
      coordination: {
        handoffs: handoffs.map((entry) => {
          const handoff = entry as Record<string, unknown>;
          return {
            to: String(handoff.to ?? ''),
            return: handoff.return === true,
            context: handoff.context ?? { pass: [] },
            condition: typeof handoff.when === 'string' ? handoff.when : 'true',
          };
        }),
        delegates: delegates.map((entry) => {
          const delegate = entry as Record<string, unknown>;
          return {
            to: String(delegate.agent ?? delegate.to ?? ''),
            return: delegate.return === true,
            context: delegate.context ?? { pass: [] },
            condition: typeof delegate.when === 'string' ? delegate.when : 'true',
          };
        }),
      },
      completion: { conditions: complete },
      error_handling: { handlers: [], default_handler: { action: 'respond' } },
    };
  }
  return {
    version: '1.0',
    compiled_at: new Date().toISOString(),
    agents,
    deployment: {},
    compilation_errors: [],
    compilation_warnings: [],
  } as never;
}

const {
  projectAgentFindMock,
  projectAgentFindOneMock,
  resolveToolImplementationsMock,
  findMcpServerConfigsByProjectMock,
  sessionGetByIdMock,
  setPendingMutationMock,
  archiveAgentEditorSessionsForAgentMock,
  archBlueprintFindOneMock,
  archSessionFindOneMock,
  projectConfigVariableFindMock,
  projectConfigVariableDeleteManyMock,
  projectConfigVariableFindOneAndUpdateMock,
  getSourceArchitectureContractFromMetadataMock,
  renderArchManagedBehaviorProfilesMock,
  renderProjectFromBlueprintMock,
  refreshProjectAgentDraftMetadataForConfigMutationMock,
  resolveArchModelPolicyDefaultsForProjectMock,
  invalidateProjectCachesMock,
} = vi.hoisted(() => ({
  projectAgentFindMock: vi.fn(),
  projectAgentFindOneMock: vi.fn(),
  resolveToolImplementationsMock: vi.fn(),
  findMcpServerConfigsByProjectMock: vi.fn(),
  sessionGetByIdMock: vi.fn(),
  setPendingMutationMock: vi.fn(),
  archiveAgentEditorSessionsForAgentMock: vi.fn(),
  archBlueprintFindOneMock: vi.fn(),
  archSessionFindOneMock: vi.fn(),
  projectConfigVariableFindMock: vi.fn(),
  projectConfigVariableDeleteManyMock: vi.fn(),
  projectConfigVariableFindOneAndUpdateMock: vi.fn(),
  getSourceArchitectureContractFromMetadataMock: vi.fn(() => null),
  renderArchManagedBehaviorProfilesMock: vi.fn(),
  renderProjectFromBlueprintMock: vi.fn(),
  refreshProjectAgentDraftMetadataForConfigMutationMock: vi.fn(),
  resolveArchModelPolicyDefaultsForProjectMock: vi.fn(),
  invalidateProjectCachesMock: vi.fn(),
}));

function createFindQuery(result: unknown[]) {
  const promise = Promise.resolve(result);
  return {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    lean: vi.fn().mockResolvedValue(result),
  };
}

function createSelectLeanQuery(result: unknown[]) {
  return {
    select: vi.fn(() => ({
      lean: vi.fn().mockResolvedValue(result),
    })),
  };
}

function createLeanQuery(result: unknown) {
  return {
    lean: vi.fn().mockResolvedValue(result),
  };
}

vi.mock('@/lib/arch-ai/message-services', () => ({
  sessionService: {
    getById: sessionGetByIdMock,
    setPendingMutation: setPendingMutationMock,
    archiveAgentEditorSessionsForAgent: archiveAgentEditorSessionsForAgentMock,
  },
  journalService: {},
  projectMemoryService: {},
}));

vi.mock('@/lib/arch-ai/tools/build-tools', () => ({
  buildBuildTools: vi.fn(() => ({})),
}));

vi.mock('@agent-platform/arch-ai/planning', () => ({
  computeArchitecturePlans: vi.fn(() => []),
}));

vi.mock('@agent-platform/arch-ai/knowledge', () => ({
  getCelGrammar: vi.fn(() => null),
  getConstructSpec: vi.fn(() => null),
  listValidCombinations: vi.fn(() => []),
  listFeasibilityChecks: vi.fn(() => []),
  lookupValidationCode: vi.fn(() => null),
}));

vi.mock('@agent-platform/arch-ai/constructs', () => ({
  renderKnownConstructsHint: vi.fn(() => ''),
}));

vi.mock('@agent-platform/database/models', () => ({
  ArchBlueprint: {
    findOne: archBlueprintFindOneMock,
  },
  ArchSession: {
    findOne: archSessionFindOneMock,
  },
  ProjectConfigVariable: {
    deleteMany: projectConfigVariableDeleteManyMock,
    find: projectConfigVariableFindMock,
    findOneAndUpdate: projectConfigVariableFindOneAndUpdateMock,
  },
}));

vi.mock('@agent-platform/arch-ai/blueprint', () => ({
  getSourceArchitectureContractFromMetadata: getSourceArchitectureContractFromMetadataMock,
  renderArchManagedBehaviorProfiles: renderArchManagedBehaviorProfilesMock,
  renderProjectFromBlueprint: renderProjectFromBlueprintMock,
}));

vi.mock('@/lib/project-config-draft-invalidation', () => ({
  refreshProjectAgentDraftMetadataForConfigMutation:
    refreshProjectAgentDraftMetadataForConfigMutationMock,
}));

vi.mock('@/lib/arch-ai/model-policy-defaults', () => ({
  resolveArchModelPolicyDefaultsForProject: resolveArchModelPolicyDefaultsForProjectMock,
}));

vi.mock('@/lib/arch-ai/tools/cache-invalidation', () => ({
  invalidateProjectCaches: invalidateProjectCachesMock,
  registerProjectConfigCache: vi.fn(),
}));

import {
  __setInProjectToolTestDeps,
  buildInProjectTools,
} from '@/lib/arch-ai/tools/in-project-tools';
import { behaviorProfileNameToConfigKey } from '@agent-platform/project-io';

const CURRENT_ROUTER_DSL = `AGENT: RouterAgent
GOAL: "Handle customer routing"
`;

const UPDATED_ROUTER_DSL = `AGENT: RouterAgent
GOAL: "Handle customer routing"

DELEGATE:
  - AGENT: SpecialistAgent
    WHEN: true
    PURPOSE: "Delegate specialist work"

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

const SPECIALIST_DSL = `AGENT: SpecialistAgent
GOAL: "Handle specialist work"
`;

describe('in-project-tools topology parity', () => {
  let restoreDeps: (() => void) | null = null;

  beforeEach(() => {
    restoreDeps?.();
    vi.clearAllMocks();
    restoreDeps = __setInProjectToolTestDeps({
      projectAgentModel: {
        find: projectAgentFindMock,
        findOne: projectAgentFindOneMock,
        updateOne: vi.fn(),
      },
      resolveToolImplementations: resolveToolImplementationsMock,
      findMcpServerConfigsByProject: findMcpServerConfigsByProjectMock,
      compileABLtoIR: compileABLtoIRForTest,
      runProjectDiagnostics: async () => [],
      withTransaction: async (callback: (session?: unknown) => Promise<unknown>) =>
        callback(undefined),
    });
    resolveToolImplementationsMock.mockResolvedValue({
      resolvedByAgent: new Map(),
      errors: [],
      warnings: [],
      snapshotEntries: [],
      timings: {
        dbQueryMs: 0,
        redisCacheLookupMs: 0,
        redisCacheHits: 0,
        redisCacheMisses: 0,
        compilationMs: 0,
        redisCacheWriteMs: 0,
        totalMs: 0,
      },
    });
    findMcpServerConfigsByProjectMock.mockResolvedValue([]);
    sessionGetByIdMock.mockResolvedValue({ metadata: {} });
    setPendingMutationMock.mockResolvedValue(undefined);
    archBlueprintFindOneMock.mockReturnValue(createLeanQuery(null));
    archSessionFindOneMock.mockReturnValue(createSelectLeanQuery(null));
    projectConfigVariableFindMock.mockReturnValue(createSelectLeanQuery([]));
    projectConfigVariableDeleteManyMock.mockResolvedValue({});
    projectConfigVariableFindOneAndUpdateMock.mockResolvedValue({});
    getSourceArchitectureContractFromMetadataMock.mockReturnValue(null);
    renderArchManagedBehaviorProfilesMock.mockReturnValue([]);
    renderProjectFromBlueprintMock.mockReturnValue({ agents: [], behaviorProfiles: [] });
    refreshProjectAgentDraftMetadataForConfigMutationMock.mockResolvedValue(undefined);
    resolveArchModelPolicyDefaultsForProjectMock.mockResolvedValue({});
    invalidateProjectCachesMock.mockReset();
    process.env.ARCH_MUTATION_LOCK_REDIS_OPTIONAL = 'true';
  });

  afterEach(() => {
    delete process.env.ARCH_MUTATION_LOCK_REDIS_OPTIONAL;
  });

  it('includes action-handler routing edges in read_topology', async () => {
    projectAgentFindMock.mockReturnValue(
      createFindQuery([
        {
          name: 'RouterAgent',
          description: 'Routes users',
          dslContent: `AGENT: RouterAgent
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
        - DELEGATE: StepDelegate
          RETURN: true

ACTION_HANDLERS:
  escalate_btn:
    DO:
      - HANDOFF: GlobalEscalation`,
        },
      ]),
    );

    const tools = buildInProjectTools(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'session-1',
      'project-1',
    );

    const result = await tools.read_topology.execute!({});

    expect(result).toMatchObject({
      edges: expect.arrayContaining([
        { from: 'RouterAgent', to: 'StepDelegate', type: 'delegate' },
        { from: 'RouterAgent', to: 'GlobalEscalation', type: 'handoff' },
      ]),
    });
  });

  it('treats action-handler routing changes as topology impact in propose_modification', async () => {
    projectAgentFindMock.mockReturnValue(
      createFindQuery([
        { name: 'RouterAgent', dslContent: CURRENT_ROUTER_DSL },
        { name: 'SpecialistAgent', dslContent: SPECIALIST_DSL },
      ]),
    );
    projectAgentFindOneMock.mockResolvedValue({
      name: 'RouterAgent',
      dslContent: CURRENT_ROUTER_DSL,
    });

    const tools = buildInProjectTools(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'session-1',
      'project-1',
    );

    const result = await tools.propose_modification.execute!({
      agentName: 'RouterAgent',
      change: 'Add action-handler delegate routing',
      updatedCode: UPDATED_ROUTER_DSL,
    });

    expect(result).toMatchObject({
      success: true,
      proposal: {
        impact: {
          summary: expect.stringContaining('1 topology edge(s) added'),
          topology: {
            addedEdges: expect.arrayContaining([
              { from: 'RouterAgent', to: 'SpecialistAgent', type: 'delegate' },
            ]),
          },
        },
      },
    });
  });

  it('rejects editor-mode proposals targeting a different agent', async () => {
    const tools = buildInProjectTools(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'session-1',
      'project-1',
      undefined,
      undefined,
      {
        pageContext: {
          surface: 'agent-editor',
          area: 'agents',
          page: 'editor',
          entity: { type: 'agent', id: 'router-agent', name: 'RouterAgent' },
        },
      },
    );

    const result = await tools.propose_modification.execute!({
      agentName: 'SpecialistAgent',
      change: 'Edit the specialist from the router editor',
      updatedCode: SPECIALIST_DSL,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'EDITOR_SCOPE_ESCALATION_REQUIRED',
        message: expect.stringContaining('currently open'),
      },
    });
    expect(projectAgentFindOneMock).not.toHaveBeenCalled();
    expect(setPendingMutationMock).not.toHaveBeenCalled();
  });

  it('rejects editor-mode proposals that change topology for the current agent', async () => {
    projectAgentFindMock.mockReturnValue(
      createFindQuery([
        { name: 'RouterAgent', dslContent: CURRENT_ROUTER_DSL },
        { name: 'SpecialistAgent', dslContent: SPECIALIST_DSL },
      ]),
    );
    projectAgentFindOneMock.mockResolvedValue({
      name: 'RouterAgent',
      dslContent: CURRENT_ROUTER_DSL,
    });

    const tools = buildInProjectTools(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'session-1',
      'project-1',
      undefined,
      undefined,
      {
        pageContext: {
          surface: 'agent-editor',
          area: 'agents',
          page: 'editor',
          entity: { type: 'agent', id: 'router-agent', name: 'RouterAgent' },
        },
      },
    );

    const result = await tools.propose_modification.execute!({
      agentName: 'RouterAgent',
      change: 'Add action-handler delegate routing',
      updatedCode: UPDATED_ROUTER_DSL,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'EDITOR_SCOPE_ESCALATION_REQUIRED',
        message: expect.stringContaining('topology'),
      },
    });
    expect(setPendingMutationMock).not.toHaveBeenCalled();
  });

  it('explains rename cascade impact before apply', async () => {
    const bookingBefore = `AGENT: Booking
GOAL: "Book appointments"
PERSONA: "Booking specialist"
COMPLETE:
  - WHEN: true
    RESPOND: "Booked"
`;
    const bookingAfter = `AGENT: BookingV2
GOAL: "Book appointments"
PERSONA: "Booking specialist"
COMPLETE:
  - WHEN: true
    RESPOND: "Booked"
`;
    const routerDsl = `SUPERVISOR: SupportRouter
GOAL: "Route customers"
PERSONA: "Router"
HANDOFF:
  - TO: Booking
    WHEN: true
    CONTEXT:
      pass: []
      summary: "Booking help."
    RETURN: true
COMPLETE:
  - WHEN: true
    RESPOND: "Done"
`;
    projectAgentFindMock.mockReturnValue(
      createFindQuery([
        { name: 'SupportRouter', dslContent: routerDsl },
        { name: 'Booking', dslContent: bookingBefore },
      ]),
    );
    projectAgentFindOneMock.mockResolvedValue({
      name: 'Booking',
      dslContent: bookingBefore,
    });

    const tools = buildInProjectTools(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'session-1',
      'project-1',
    );

    const result = await tools.propose_modification.execute!({
      agentName: 'Booking',
      change: 'Rename Booking to BookingV2',
      updatedCode: bookingAfter,
    });

    expect(result).toMatchObject({
      success: true,
      proposal: {
        impact: {
          summary: expect.stringContaining('handoff rename updates'),
          rename: {
            from: 'Booking',
            to: 'BookingV2',
            cascadeAgents: ['SupportRouter'],
            referenceUpdates: [
              {
                agent: 'SupportRouter',
                from: 'Booking',
                to: 'BookingV2',
                count: 1,
              },
            ],
          },
          topology: {
            addedEdges: expect.arrayContaining([
              { from: 'SupportRouter', to: 'BookingV2', type: 'handoff' },
            ]),
            removedEdges: expect.arrayContaining([
              { from: 'SupportRouter', to: 'Booking', type: 'handoff' },
            ]),
          },
        },
      },
    });
    expect(setPendingMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      expect.objectContaining({
        target: 'Booking',
        after: bookingAfter,
        impact: expect.objectContaining({
          rename: expect.objectContaining({
            cascadeAgents: ['SupportRouter'],
          }),
        }),
      }),
    );
  });

  it('proposes edits with unresolved tools as not runtime-ready instead of blocking', async () => {
    resolveToolImplementationsMock.mockResolvedValue({
      resolvedByAgent: new Map(),
      errors: [
        {
          code: 'E721',
          message:
            "Tool 'lookup_customer' not found in project. Create it in the Tool Library first.",
        },
      ],
      warnings: [],
      snapshotEntries: [],
      timings: {
        dbQueryMs: 0,
        redisCacheLookupMs: 0,
        redisCacheHits: 0,
        redisCacheMisses: 0,
        compilationMs: 0,
        redisCacheWriteMs: 0,
        totalMs: 0,
      },
    });
    const beforeDsl = `AGENT: SupportAgent
GOAL: "Help customers"
PERSONA: "Helpful"
`;
    const afterDsl = `AGENT: SupportAgent
GOAL: "Help customers"
PERSONA: "Helpful"
TOOLS:
  lookup_customer(customer_id: string) -> object
    description: "Look up customer details"
COMPLETE:
  - WHEN: true
    RESPOND: "Done"
`;
    projectAgentFindMock.mockReturnValue(
      createFindQuery([{ name: 'SupportAgent', dslContent: beforeDsl }]),
    );
    projectAgentFindOneMock.mockResolvedValue({
      name: 'SupportAgent',
      dslContent: beforeDsl,
    });

    const tools = buildInProjectTools(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'session-1',
      'project-1',
    );

    const result = await tools.propose_modification.execute!({
      agentName: 'SupportAgent',
      change: 'Add lookup tool call',
      updatedCode: afterDsl,
    });

    expect(result).toMatchObject({
      success: true,
      proposal: {
        validation: {
          valid: true,
          warnings: expect.arrayContaining([
            expect.objectContaining({ message: expect.stringContaining('[E721]') }),
          ]),
        },
        impact: {
          runtimeReady: false,
          summary: expect.stringContaining('unresolved tool implementation'),
          tools: {
            unresolved: ['lookup_customer'],
          },
          nextActions: expect.arrayContaining([
            expect.stringContaining('Create or link ProjectTool implementation'),
          ]),
        },
      },
    });
  });

  it('persists rendered behavior profiles when rebuilding from a locked blueprint', async () => {
    const profileDsl = `BEHAVIOR_PROFILE: shared_voice_handoff
WHEN: true
INSTRUCTIONS: |
  Continue naturally as the same customer-facing assistant.
`;
    archBlueprintFindOneMock.mockReturnValue(
      createLeanQuery({
        output: { agents: [], topology: { edges: [] } },
      }),
    );
    projectAgentFindMock.mockReturnValue(createFindQuery([]));
    projectConfigVariableFindMock.mockReturnValue(createSelectLeanQuery([]));
    renderProjectFromBlueprintMock.mockReturnValue({
      agents: [],
      behaviorProfiles: [
        {
          name: 'shared_voice_handoff',
          dslContent: profileDsl,
          sourceHash: 'profile-hash-1',
        },
      ],
    });

    const tools = buildInProjectTools(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'session-1',
      'project-1',
    );

    const result = await tools.rebuild_agents_from_blueprint.execute!({ fromVersion: 3 });

    const profileKey = behaviorProfileNameToConfigKey('shared_voice_handoff');
    expect(result).toMatchObject({ success: true, results: [] });
    expect(archBlueprintFindOneMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      version: 3,
      state: { $in: ['locked', 'linked'] },
    });
    expect(projectConfigVariableFindMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      key: { $in: [profileKey] },
    });
    expect(projectConfigVariableFindOneAndUpdateMock).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        key: profileKey,
      },
      {
        $set: {
          value: profileDsl,
          updatedBy: 'user-1',
        },
        $setOnInsert: {
          tenantId: 'tenant-1',
          projectId: 'project-1',
          key: profileKey,
          description: null,
          createdBy: 'user-1',
        },
      },
      { upsert: true },
    );
    expect(refreshProjectAgentDraftMetadataForConfigMutationMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
    expect(invalidateProjectCachesMock).toHaveBeenCalledWith('tenant-1', 'project-1');
  });

  it('passes source architecture contract into blueprint rebuild rendering', async () => {
    const sourceContract = {
      sourceFiles: ['voltmart-sop.md'],
      declaredAgents: [{ name: 'Alex', role: 'Orders', tools: [], memoryVariables: [] }],
    };
    const sourceMetadata = { sourceArchitectureContract: sourceContract };
    archBlueprintFindOneMock.mockReturnValue(
      createLeanQuery({
        sessionId: 'source-session-1',
        output: { agents: [], topology: { edges: [] } },
      }),
    );
    archSessionFindOneMock.mockReturnValue(
      createSelectLeanQuery({
        metadata: sourceMetadata,
      }),
    );
    getSourceArchitectureContractFromMetadataMock.mockReturnValue(sourceContract);
    projectAgentFindMock.mockReturnValue(createFindQuery([]));
    projectConfigVariableFindMock.mockReturnValue(createSelectLeanQuery([]));
    renderProjectFromBlueprintMock.mockReturnValue({ agents: [], behaviorProfiles: [] });

    const tools = buildInProjectTools(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'session-1',
      'project-1',
    );

    await tools.rebuild_agents_from_blueprint.execute!({ fromVersion: 3 });

    expect(archSessionFindOneMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      _id: 'source-session-1',
      'metadata.projectId': 'project-1',
    });
    expect(getSourceArchitectureContractFromMetadataMock).toHaveBeenCalledWith(sourceMetadata);
    expect(renderProjectFromBlueprintMock).toHaveBeenCalledWith(
      { agents: [], topology: { edges: [] } },
      { modelDefaults: {}, sourceContract },
    );
  });

  it('removes stale Arch-managed behavior profiles when rebuild no longer renders them', async () => {
    const profileDsl = `BEHAVIOR_PROFILE: shared_voice_handoff
WHEN: true
INSTRUCTIONS: |
  Continue naturally as the same customer-facing assistant.
`;
    archBlueprintFindOneMock.mockReturnValue(
      createLeanQuery({
        output: { agents: [], topology: { edges: [] } },
      }),
    );
    projectAgentFindMock.mockReturnValue(createFindQuery([]));
    projectConfigVariableFindMock.mockReturnValue(
      createSelectLeanQuery([
        {
          key: behaviorProfileNameToConfigKey('shared_voice_handoff'),
          value: profileDsl,
        },
      ]),
    );
    renderArchManagedBehaviorProfilesMock.mockReturnValue([
      {
        name: 'shared_voice_handoff',
        dslContent: profileDsl,
        sourceHash: 'managed-profile-hash-1',
      },
    ]);
    renderProjectFromBlueprintMock.mockReturnValue({
      agents: [],
      behaviorProfiles: [],
    });

    const tools = buildInProjectTools(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'session-1',
      'project-1',
    );

    const result = await tools.rebuild_agents_from_blueprint.execute!({ fromVersion: 3 });

    const profileKey = behaviorProfileNameToConfigKey('shared_voice_handoff');
    expect(result).toMatchObject({ success: true, results: [] });
    expect(projectConfigVariableDeleteManyMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      key: { $in: [profileKey] },
    });
    expect(refreshProjectAgentDraftMetadataForConfigMutationMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
    expect(invalidateProjectCachesMock).toHaveBeenCalledWith('tenant-1', 'project-1');
  });

  it('requires overwrite confirmation before deleting edited managed behavior profiles', async () => {
    const canonicalProfileDsl = `BEHAVIOR_PROFILE: shared_voice_handoff
WHEN: true
INSTRUCTIONS: |
  Continue naturally as the same customer-facing assistant.
`;
    archBlueprintFindOneMock.mockReturnValue(
      createLeanQuery({
        output: { agents: [], topology: { edges: [] } },
      }),
    );
    projectAgentFindMock.mockReturnValue(createFindQuery([]));
    projectConfigVariableFindMock.mockReturnValue(
      createSelectLeanQuery([
        {
          key: behaviorProfileNameToConfigKey('shared_voice_handoff'),
          value: `BEHAVIOR_PROFILE: shared_voice_handoff
WHEN: true
INSTRUCTIONS: |
  Locally edited voice rules.
`,
        },
      ]),
    );
    renderArchManagedBehaviorProfilesMock.mockReturnValue([
      {
        name: 'shared_voice_handoff',
        dslContent: canonicalProfileDsl,
        sourceHash: 'managed-profile-hash-1',
      },
    ]);
    renderProjectFromBlueprintMock.mockReturnValue({
      agents: [],
      behaviorProfiles: [],
    });

    const tools = buildInProjectTools(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'session-1',
      'project-1',
    );

    const result = await tools.rebuild_agents_from_blueprint.execute!({ fromVersion: 3 });

    expect(result).toMatchObject({
      success: false,
      needsConfirmation: true,
      conflicts: [
        {
          agentName: 'behavior_profile:shared_voice_handoff',
          currentHash: expect.any(String),
          blueprintHash: expect.any(String),
        },
      ],
    });
    expect(projectConfigVariableDeleteManyMock).not.toHaveBeenCalled();
    expect(refreshProjectAgentDraftMetadataForConfigMutationMock).not.toHaveBeenCalled();
    expect(invalidateProjectCachesMock).not.toHaveBeenCalled();
  });

  it('requires overwrite confirmation before replacing edited behavior profiles', async () => {
    const profileDsl = `BEHAVIOR_PROFILE: shared_voice_handoff
WHEN: true
INSTRUCTIONS: |
  Continue naturally as the same customer-facing assistant.
`;
    archBlueprintFindOneMock.mockReturnValue(
      createLeanQuery({
        output: { agents: [], topology: { edges: [] } },
      }),
    );
    projectAgentFindMock.mockReturnValue(createFindQuery([]));
    projectConfigVariableFindMock.mockReturnValue(
      createSelectLeanQuery([
        {
          key: behaviorProfileNameToConfigKey('shared_voice_handoff'),
          value: `BEHAVIOR_PROFILE: shared_voice_handoff
WHEN: true
INSTRUCTIONS: |
  Locally edited voice rules.
`,
        },
      ]),
    );
    renderProjectFromBlueprintMock.mockReturnValue({
      agents: [],
      behaviorProfiles: [
        {
          name: 'shared_voice_handoff',
          dslContent: profileDsl,
          sourceHash: 'profile-hash-1',
        },
      ],
    });

    const tools = buildInProjectTools(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'session-1',
      'project-1',
    );

    const result = await tools.rebuild_agents_from_blueprint.execute!({ fromVersion: 3 });

    expect(result).toMatchObject({
      success: false,
      needsConfirmation: true,
      conflicts: [
        {
          agentName: 'behavior_profile:shared_voice_handoff',
          currentHash: expect.any(String),
          blueprintHash: expect.any(String),
        },
      ],
    });
    expect(projectConfigVariableFindOneAndUpdateMock).not.toHaveBeenCalled();
    expect(refreshProjectAgentDraftMetadataForConfigMutationMock).not.toHaveBeenCalled();
    expect(invalidateProjectCachesMock).not.toHaveBeenCalled();
  });
});
