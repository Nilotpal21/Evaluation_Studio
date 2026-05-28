import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildInProjectToolsMock,
  applyModificationExecuteMock,
  dismissProposalExecuteMock,
  readTopologyExecuteMock,
  createProductionTurnEngineMock,
  journalAppendMock,
  journalLinkToProjectMock,
  appendMessageMock,
  setPendingInteractionMock,
  setToolResultMock,
  setPendingMutationMock,
  setPendingPlanMock,
  transitionStateMock,
  resolveTurnPlanMock,
  runTurnMock,
  toolRegistrySubsetMock,
  computePlanStateFingerprintsMock,
  getActiveFilesMock,
  buildServiceBagForTurnMock,
} = vi.hoisted(() => ({
  buildInProjectToolsMock: vi.fn(),
  applyModificationExecuteMock: vi.fn(),
  dismissProposalExecuteMock: vi.fn(),
  readTopologyExecuteMock: vi.fn(),
  createProductionTurnEngineMock: vi.fn(),
  journalAppendMock: vi.fn(),
  journalLinkToProjectMock: vi.fn(),
  appendMessageMock: vi.fn(),
  setPendingInteractionMock: vi.fn(),
  setToolResultMock: vi.fn(),
  setPendingMutationMock: vi.fn(),
  setPendingPlanMock: vi.fn(),
  transitionStateMock: vi.fn(),
  resolveTurnPlanMock: vi.fn(),
  runTurnMock: vi.fn(),
  toolRegistrySubsetMock: vi.fn(),
  computePlanStateFingerprintsMock: vi.fn(),
  getActiveFilesMock: vi.fn(),
  buildServiceBagForTurnMock: vi.fn(),
}));

vi.mock('@agent-platform/arch-ai/engine', async () => {
  const actual = await vi.importActual<typeof import('@agent-platform/arch-ai/engine')>(
    '@agent-platform/arch-ai/engine',
  );
  return {
    ...actual,
    resolveTurnPlan: (...args: unknown[]) => resolveTurnPlanMock(...args),
  };
});

vi.mock('@/lib/arch-ai/tools/in-project-tools', () => ({
  buildInProjectTools: buildInProjectToolsMock,
  computePlanStateFingerprints: (...args: unknown[]) => computePlanStateFingerprintsMock(...args),
}));

vi.mock('@/lib/arch-ai/engine-factory', () => ({
  createProductionTurnEngine: createProductionTurnEngineMock,
  buildServiceBagForTurn: buildServiceBagForTurnMock,
}));

vi.mock('@/lib/arch-ai/message-services', () => ({
  journalService: {
    append: journalAppendMock,
    linkToProject: journalLinkToProjectMock,
  },
  sessionService: {
    appendMessage: appendMessageMock,
    setPendingInteraction: setPendingInteractionMock,
    setToolResult: setToolResultMock,
    setPendingMutation: setPendingMutationMock,
    setPendingPlan: setPendingPlanMock,
    transitionState: transitionStateMock,
  },
  fileStoreService: {
    getActiveFiles: getActiveFilesMock,
  },
}));

import {
  processInProjectMessage,
  resolveServerBoundPageContext,
} from '@/lib/arch-ai/processors/process-in-project';

const ctx = { tenantId: 'tenant-1', userId: 'user-1', permissions: ['agent:write'] };
const nowIso = new Date().toISOString();

function makeSession(
  pendingMutationOverrides: Record<string, unknown> = {},
  pendingInteractionOverrides: Record<string, unknown> = {},
) {
  return {
    id: 'session-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'ACTIVE',
    metadata: {
      phase: 'INTERVIEW',
      mode: 'IN_PROJECT',
      specification: {},
      pendingInteraction: {
        kind: 'widget',
        id: 'tool-1',
        payload: {
          widgetType: 'Confirmation',
          question: 'Apply these changes?',
          confirmLabel: 'Apply',
          denyLabel: 'Discard',
          ...pendingInteractionOverrides,
        },
        createdAt: nowIso,
      },
      pendingMutation: {
        tool: 'apply_modification',
        target: 'LeadIntake',
        scope: 'SMALL',
        before: 'old',
        after: 'updated',
        changeSummary: 'Tighten goal and persona',
        impact: {
          summary: 'No topology or tool link changes.',
          topology: {
            addedEdges: [],
            removedEdges: [],
          },
          nextActions: ['Run run_test against the changed agent after apply.'],
        },
        ...pendingMutationOverrides,
      },
      messages: [],
      projectId: 'project-1',
    },
    createdAt: nowIso,
    updatedAt: nowIso,
  } as never;
}

function makePendingPlan() {
  return {
    id: 'plan-1',
    projectId: 'project-1',
    status: 'proposed',
    title: 'Add FeedbackAgent',
    summary: 'Add a terminal feedback agent after resolved interactions.',
    goal: 'Collect a rating after resolution.',
    architecturalPattern: 'Hub-spoke terminal leaf',
    evidence: ['Current topology has resolved paths.'],
    affectedAgents: ['FeedbackAgent', 'LeadIntake'],
    sectionsToChange: [],
    dependentsAnalysis: {
      summary: 'No dependent references yet.',
      referencesFound: [],
      affectedFields: [],
    },
    alternativesConsidered: [],
    citations: [],
    plannedMutations: [
      {
        sourceTool: 'propose_modification',
        sourceAction: 'propose',
        targetKind: 'agent_dsl',
        operation: 'create',
        agentName: 'FeedbackAgent',
        rationale: 'Create the new terminal feedback specialist.',
      },
    ],
    risks: [
      {
        severity: 'low',
        description: 'Extra terminal step.',
        mitigation: 'Route only after resolution.',
      },
    ],
    validationNotes: ['Run health_check after proposal.'],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function makePlanSession(
  pendingInteractionOverrides: Record<string, unknown> = {},
  pendingPlanOverrides: Record<string, unknown> = {},
) {
  const session = makeSession(
    {},
    {
      question: 'Approve this plan so I can draft the changes?',
      confirmLabel: 'Approve Plan',
      denyLabel: 'Revise Plan',
      ...pendingInteractionOverrides,
    },
  ) as unknown as {
    metadata: {
      pendingMutation: unknown;
      pendingPlan: unknown;
      messages: Array<Record<string, unknown>>;
    };
  };
  session.metadata.pendingMutation = null;
  session.metadata.messages = [
    {
      id: 'existing-user-message',
      role: 'user',
      content: 'Please add a feedback agent.',
      timestamp: nowIso,
      phase: 'INTERVIEW',
    },
  ];
  session.metadata.pendingPlan = {
    ...makePendingPlan(),
    ...pendingPlanOverrides,
  };
  return session as never;
}

describe('processInProjectMessage mutation confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyModificationExecuteMock.mockResolvedValue({
      success: true,
      agentName: 'LeadIntake',
      applied: true,
    });
    dismissProposalExecuteMock.mockResolvedValue({ dismissed: true });
    readTopologyExecuteMock.mockResolvedValue({
      agents: [{ name: 'LeadIntake', type: 'agent' }],
      edges: [],
      agentCount: 1,
      edgeCount: 0,
    });
    buildInProjectToolsMock.mockReturnValue({
      apply_modification: { execute: applyModificationExecuteMock },
      dismiss_proposal: { execute: dismissProposalExecuteMock },
      read_topology: { execute: readTopologyExecuteMock },
    });
    appendMessageMock.mockResolvedValue(undefined);
    setPendingInteractionMock.mockResolvedValue(undefined);
    setToolResultMock.mockResolvedValue(undefined);
    setPendingMutationMock.mockResolvedValue(undefined);
    setPendingPlanMock.mockResolvedValue(undefined);
    transitionStateMock.mockResolvedValue(undefined);
    computePlanStateFingerprintsMock.mockResolvedValue({ agent_FeedbackAgent: 'missing' });
    getActiveFilesMock.mockResolvedValue([]);
    resolveTurnPlanMock.mockResolvedValue({
      allowedTools: [],
      systemPrompt: 'Continue drafting the approved proposal.',
      specialist: 'in-project-architect',
      routing: {},
    });
    toolRegistrySubsetMock.mockReturnValue({});
    buildServiceBagForTurnMock.mockReturnValue({});
    runTurnMock.mockImplementation(async function* (input: { userInput: string }) {
      yield {
        type: 'text_delta',
        turnId: 'engine-turn-1',
        seq: 0,
        delta: `engine saw: ${input.userInput}`,
        specialist: 'in-project-architect',
      };
    });
    createProductionTurnEngineMock.mockResolvedValue({
      engine: { runTurn: runTurnMock },
      toolRegistry: { subset: toolRegistrySubsetMock },
    });
    journalAppendMock.mockResolvedValue({
      id: 'journal-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      type: 'mutation',
      content: {
        type: 'mutation',
        what: 'Updated agent: LeadIntake',
        to: 'Tighten goal and persona',
        reason: 'User approved the proposed in-project agent update',
      },
      specialist: 'abl-construct-expert',
      phase: 'IN_PROJECT',
      timestamp: nowIso,
      status: 'active',
      sequence: 1,
    });
    journalLinkToProjectMock.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies a confirmed pending mutation without re-entering the coordinator', async () => {
    const emit = vi.fn();
    const close = vi.fn();

    await processInProjectMessage(
      ctx,
      makeSession(),
      {
        sessionId: 'session-1',
        type: 'tool_answer',
        toolCallId: 'tool-1',
        answer: true,
      },
      emit,
      close,
      'token-123',
      new AbortController().signal,
    );

    expect(setPendingInteractionMock).toHaveBeenCalledWith(ctx, 'session-1', null);
    expect(setToolResultMock).toHaveBeenCalledWith(ctx, 'session-1', 'tool-1', true);
    expect(appendMessageMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      expect.objectContaining({
        role: 'user',
        phase: 'INTERVIEW',
        content: expect.stringContaining('Apply these changes?'),
        messageMetadata: {
          source: 'deterministic_tool_answer',
          toolCallId: 'tool-1',
        },
      }),
    );
    expect(buildInProjectToolsMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      'project-1',
      'token-123',
      undefined,
      { pageContext: undefined },
    );
    expect(applyModificationExecuteMock).toHaveBeenCalledWith({ agentName: 'LeadIntake' });
    expect(dismissProposalExecuteMock).not.toHaveBeenCalled();
    expect(createProductionTurnEngineMock).not.toHaveBeenCalled();
    expect(journalAppendMock).toHaveBeenCalledWith(ctx, {
      sessionId: 'session-1',
      type: 'mutation',
      content: {
        type: 'mutation',
        what: 'Updated agent: LeadIntake',
        to: 'Tighten goal and persona',
        reason: 'User approved the proposed in-project agent update',
        specialist: 'abl-construct-expert',
        requestedBy: 'user',
      },
      specialist: 'abl-construct-expert',
      phase: 'IN_PROJECT',
    });
    expect(journalLinkToProjectMock).toHaveBeenCalledWith(ctx, 'session-1', 'project-1', {
      unsafeProjectScope: true,
    });
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual([
      'turn_started',
      'status',
      'artifact_updated',
      'artifact_updated',
      'text_delta',
      'turn_committed',
      'turn_ended',
    ]);
    expect(emit.mock.calls[2]?.[0]).toMatchObject({
      type: 'artifact_updated',
      update: {
        artifact: 'journal',
      },
    });
    expect(emit.mock.calls[3]?.[0]).toMatchObject({
      type: 'artifact_updated',
      update: {
        artifact: 'diff',
        status: 'applied',
        payload: {
          agentName: 'LeadIntake',
          reviewStatus: 'applied',
          currentCode: 'old',
          proposedCode: 'updated',
          changes: [
            {
              construct: 'FULL',
              before: 'old',
              after: 'updated',
            },
          ],
        },
      },
    });
    expect(emit.mock.calls[4]?.[0]).toMatchObject({
      type: 'text_delta',
      delta: expect.stringContaining('Applied the approved changes to LeadIntake.'),
    });
    expect(emit.mock.calls[4]?.[0]).toMatchObject({
      delta: expect.stringContaining('Impact: No topology or tool link changes.'),
    });
    expect(emit.mock.calls[4]?.[0]).toMatchObject({
      delta: expect.stringContaining(
        'Review complete: closed the approved plan and changes artifacts.',
      ),
    });
    expect(appendMessageMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      expect.objectContaining({
        role: 'assistant',
        phase: 'INTERVIEW',
        specialist: 'abl-construct-expert',
        content: expect.stringContaining('Applied the approved changes to LeadIntake.'),
        messageMetadata: {
          source: 'deterministic_mutation_resolution',
          action: 'applied',
          targetAgent: 'LeadIntake',
          changeSummary: 'Tighten goal and persona',
          artifactsClosed: true,
          planCleared: true,
          topologyRefreshed: false,
        },
      }),
    );
    const assistantAppendOrder = appendMessageMock.mock.invocationCallOrder[1];
    const textDeltaOrder = emit.mock.invocationCallOrder[4];
    expect(assistantAppendOrder).toBeLessThan(textDeltaOrder);
    expect(readTopologyExecuteMock).not.toHaveBeenCalled();
    expect(setPendingPlanMock).toHaveBeenCalledWith(ctx, 'session-1', null);
    expect(close).toHaveBeenCalledOnce();
  });

  it('derives editor page context from session metadata instead of client input', () => {
    const session = makeSession() as {
      metadata: ReturnType<typeof makeSession>['metadata'] & {
        surface?: 'project' | 'agent-editor';
        agentName?: string | null;
      };
    };
    session.metadata.surface = 'agent-editor';
    session.metadata.agentName = 'LeadIntake';

    expect(
      resolveServerBoundPageContext(session as never, {
        surface: 'project',
        area: 'projects',
        page: 'overview',
      }),
    ).toMatchObject({
      surface: 'agent-editor',
      area: 'projects',
      page: 'overview',
      entity: {
        type: 'agent',
        id: 'LeadIntake',
        name: 'LeadIntake',
      },
    });
  });

  it('applies a pending mutation when a stale confirmation widget answer is submitted', async () => {
    const emit = vi.fn();
    const close = vi.fn();
    const session = makeSession() as {
      metadata: {
        pendingInteraction: unknown;
        messages: Array<Record<string, unknown>>;
      };
    };
    session.metadata.pendingInteraction = null;
    session.metadata.messages = [
      {
        id: 'assistant-confirm-1',
        role: 'assistant',
        content: 'Apply these changes?',
        timestamp: nowIso,
        phase: 'INTERVIEW',
        toolCalls: [
          {
            toolCallId: 'tool-stale-confirm-1',
            toolName: 'ask_user',
            input: {
              widgetType: 'Confirmation',
              question: 'Apply these changes?',
              confirmLabel: 'Apply Changes',
              denyLabel: 'Discard',
            },
          },
        ],
      },
    ];

    await processInProjectMessage(
      ctx,
      session as never,
      {
        sessionId: 'session-1',
        type: 'tool_answer',
        toolCallId: 'tool-stale-confirm-1',
        answer: true,
      },
      emit,
      close,
      'token-123',
      new AbortController().signal,
    );

    expect(appendMessageMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Apply these changes?'),
        messageMetadata: {
          source: 'deterministic_tool_answer',
          toolCallId: 'tool-stale-confirm-1',
        },
      }),
    );
    expect(applyModificationExecuteMock).toHaveBeenCalledWith({ agentName: 'LeadIntake' });
    expect(createProductionTurnEngineMock).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('applies a pending mutation from an affirmative message while confirmation is pending', async () => {
    const emit = vi.fn();
    const close = vi.fn();

    await processInProjectMessage(
      ctx,
      makeSession(),
      {
        sessionId: 'session-1',
        type: 'message',
        text: 'do it',
      },
      emit,
      close,
      'token-123',
      new AbortController().signal,
    );

    expect(appendMessageMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Apply these changes?'),
        messageMetadata: {
          source: 'deterministic_tool_answer',
          toolCallId: 'tool-1',
        },
      }),
    );
    expect(applyModificationExecuteMock).toHaveBeenCalledWith({ agentName: 'LeadIntake' });
    expect(createProductionTurnEngineMock).not.toHaveBeenCalled();
    expect(emit.mock.calls.map(([event]) => event.type)).toContain('text_delta');
    expect(close).toHaveBeenCalledOnce();
  });

  it('refreshes topology artifacts after applying topology-impacting mutations', async () => {
    const emit = vi.fn();
    const close = vi.fn();

    await processInProjectMessage(
      ctx,
      makeSession({
        scope: 'LARGE',
        impact: {
          summary: '1 topology edge(s) added, 2 agent(s) in impact radius',
          topology: {
            addedEdges: [{ from: 'LeadIntake', to: 'BillingAgent', type: 'handoff' }],
            removedEdges: [],
          },
          nextActions: ['Run health_check after apply.'],
        },
      }),
      {
        sessionId: 'session-1',
        type: 'tool_answer',
        toolCallId: 'tool-1',
        answer: true,
      },
      emit,
      close,
      'token-123',
      new AbortController().signal,
    );

    expect(readTopologyExecuteMock).toHaveBeenCalledWith({});
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual([
      'turn_started',
      'status',
      'artifact_updated',
      'artifact_updated',
      'artifact_updated',
      'text_delta',
      'turn_committed',
      'turn_ended',
    ]);
    expect(emit.mock.calls[3]?.[0]).toMatchObject({
      type: 'artifact_updated',
      update: {
        artifact: 'topology',
        payload: {
          agentCount: 1,
        },
      },
    });
    expect(emit.mock.calls[4]?.[0]).toMatchObject({
      type: 'artifact_updated',
      update: {
        artifact: 'diff',
        status: 'applied',
      },
    });
    expect(emit.mock.calls[5]?.[0]).toMatchObject({
      type: 'text_delta',
      delta: expect.stringContaining('Topology: refreshed the project topology artifact.'),
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('dismisses a denied pending mutation without re-entering the coordinator', async () => {
    const emit = vi.fn();
    const close = vi.fn();

    await processInProjectMessage(
      ctx,
      makeSession(),
      {
        sessionId: 'session-1',
        type: 'tool_answer',
        toolCallId: 'tool-1',
        answer: false,
      },
      emit,
      close,
      'token-123',
      new AbortController().signal,
    );

    expect(setPendingInteractionMock).toHaveBeenCalledWith(ctx, 'session-1', null);
    expect(setToolResultMock).toHaveBeenCalledWith(ctx, 'session-1', 'tool-1', false);
    expect(appendMessageMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      expect.objectContaining({
        role: 'user',
        phase: 'INTERVIEW',
        content: expect.stringContaining('Apply these changes?'),
        messageMetadata: {
          source: 'deterministic_tool_answer',
          toolCallId: 'tool-1',
        },
      }),
    );
    expect(dismissProposalExecuteMock).toHaveBeenCalledWith({});
    expect(applyModificationExecuteMock).not.toHaveBeenCalled();
    expect(createProductionTurnEngineMock).not.toHaveBeenCalled();
    expect(journalAppendMock).not.toHaveBeenCalled();
    expect(journalLinkToProjectMock).not.toHaveBeenCalled();
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual([
      'turn_started',
      'status',
      'artifact_updated',
      'text_delta',
      'turn_committed',
      'turn_ended',
    ]);
    expect(emit.mock.calls[2]?.[0]).toMatchObject({
      type: 'artifact_updated',
      update: {
        artifact: 'diff',
        status: 'rejected',
        payload: {
          agentName: 'LeadIntake',
          reviewStatus: 'rejected',
        },
      },
    });
    expect(emit.mock.calls[3]?.[0]).toMatchObject({
      type: 'text_delta',
      delta: expect.stringContaining('Discarded the proposed changes for LeadIntake.'),
    });
    expect(appendMessageMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      expect.objectContaining({
        role: 'assistant',
        phase: 'INTERVIEW',
        specialist: 'abl-construct-expert',
        content: expect.stringContaining('Discarded the proposed changes for LeadIntake.'),
      }),
    );
    expect(readTopologyExecuteMock).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('approves a pending plan from the chat confirmation widget and continues drafting', async () => {
    const emit = vi.fn();
    const close = vi.fn();

    await processInProjectMessage(
      ctx,
      makePlanSession(),
      {
        sessionId: 'session-1',
        type: 'tool_answer',
        toolCallId: 'tool-1',
        answer: true,
      },
      emit,
      close,
      'token-123',
      new AbortController().signal,
    );

    expect(setPendingInteractionMock).toHaveBeenCalledWith(ctx, 'session-1', null);
    expect(setToolResultMock).toHaveBeenCalledWith(ctx, 'session-1', 'tool-1', true);
    expect(appendMessageMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Approve this plan'),
        messageMetadata: {
          source: 'deterministic_tool_answer',
          toolCallId: 'tool-1',
        },
      }),
    );
    expect(setPendingPlanMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      expect.objectContaining({
        id: 'plan-1',
        status: 'approved',
        approvedAt: expect.any(String),
        stateFingerprintsAtApproval: expect.any(Object),
      }),
    );
    expect(createProductionTurnEngineMock).toHaveBeenCalled();
    expect(runTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userInput: 'Plan approved. Draft the proposal covered by this approved plan now.',
        suppressUserMessage: true,
        services: expect.objectContaining({
          archMutationGuard: expect.objectContaining({
            requireApprovedPlanForMutation: true,
            approvedPlan: expect.objectContaining({
              id: 'plan-1',
              status: 'approved',
            }),
          }),
        }),
      }),
    );
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual(
      expect.arrayContaining(['artifact_updated', 'plan_approved', 'status', 'text_delta']),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('marks a pending plan for refinement from a chat revise response without continuing', async () => {
    const emit = vi.fn();
    const close = vi.fn();

    await processInProjectMessage(
      ctx,
      makePlanSession(),
      {
        sessionId: 'session-1',
        type: 'tool_answer',
        toolCallId: 'tool-1',
        answer: false,
      },
      emit,
      close,
      'token-123',
      new AbortController().signal,
    );

    expect(setPendingPlanMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      expect.objectContaining({
        id: 'plan-1',
        status: 'refining',
      }),
    );
    expect(createProductionTurnEngineMock).not.toHaveBeenCalled();
    expect(emit.mock.calls.map(([event]) => event.type)).toContain('plan_refining');
    expect(close).toHaveBeenCalledOnce();
  });

  it('approves a pending plan from the artifact proposal action and continues drafting', async () => {
    const emit = vi.fn();
    const close = vi.fn();

    await processInProjectMessage(
      ctx,
      makePlanSession(),
      {
        sessionId: 'session-1',
        type: 'proposal_response',
        action: 'accept',
      },
      emit,
      close,
      'token-123',
      new AbortController().signal,
    );

    expect(setPendingPlanMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      expect.objectContaining({
        id: 'plan-1',
        status: 'approved',
      }),
    );
    expect(runTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userInput: 'Plan approved. Draft the proposal covered by this approved plan now.',
        suppressUserMessage: false,
      }),
    );
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual(
      expect.arrayContaining(['plan_approved', 'status', 'text_delta']),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('treats a simple yes message as approval when a plan is the active pending review', async () => {
    const emit = vi.fn();
    const close = vi.fn();

    await processInProjectMessage(
      ctx,
      makePlanSession({}, { title: 'Add rating-only FeedbackAgent' }),
      {
        sessionId: 'session-1',
        type: 'message',
        text: 'yes',
      },
      emit,
      close,
      'token-123',
      new AbortController().signal,
    );

    expect(setPendingPlanMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      expect.objectContaining({
        title: 'Add rating-only FeedbackAgent',
        status: 'approved',
      }),
    );
    expect(runTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userInput: 'Plan approved. Draft the proposal covered by this approved plan now.',
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
