import { describe, expect, it, vi } from 'vitest';
import type {
  ArchSession,
  PendingMutation,
  PendingPlan,
  StoredMessage,
} from '@agent-platform/arch-ai/types';
import { prepareTurnHistory } from '@/lib/arch-ai/helpers/build-llm-messages';

function makeSpecification() {
  return {
    version: 1,
    projectName: 'BookingHub',
    description: 'AI booking assistant',
    channels: ['web'],
    language: 'English',
    uploadedFiles: [],
    conversationNotes: [],
  };
}

function makeMessage(
  partial: Partial<StoredMessage> & Pick<StoredMessage, 'id' | 'role' | 'content'>,
): StoredMessage {
  return {
    timestamp: '2026-04-20T08:00:00.000Z',
    phase: 'INTERVIEW',
    ...partial,
  };
}

function makeFileStore() {
  return {
    getActiveFiles: vi.fn().mockResolvedValue([]),
    getByBlobId: vi.fn(),
    markFailed: vi.fn(),
  };
}

function makePendingMutation(): PendingMutation {
  return {
    tool: 'apply_modification',
    target: 'LeadIntake',
    scope: 'SMALL',
    before: 'old',
    after: 'new',
    changeSummary: 'Tighten goal and persona',
    reviewStatus: 'pending',
  };
}

function makePendingPlan(status: PendingPlan['status'] = 'proposed'): PendingPlan {
  return {
    id: 'plan-1',
    projectId: 'project-1',
    status,
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
    createdAt: '2026-04-20T08:00:00.000Z',
    updatedAt: '2026-04-20T08:00:00.000Z',
  };
}

function makeSession(
  messages: StoredMessage[],
  overrides: Partial<ArchSession['metadata']> = {},
): ArchSession {
  return {
    id: 'session-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'ACTIVE',
    metadata: {
      phase: 'INTERVIEW',
      mode: 'ONBOARDING',
      specification: makeSpecification(),
      pendingInteraction: {
        kind: 'widget',
        id: 'pending-widget-1',
        payload: {
          widgetType: 'ShortText',
          question: 'What should we call the project?',
        },
        createdAt: '2026-04-20T08:00:03.000Z',
      },
      pendingMutation: null,
      messages,
      ...overrides,
    },
    createdAt: '2026-04-20T08:00:00.000Z',
    updatedAt: '2026-04-20T08:00:00.000Z',
  };
}

describe('prepareTurnHistory', () => {
  it('compacts older messages into historySummary while keeping recent context, tool outcomes, and pending widgets raw', async () => {
    const messages: StoredMessage[] = [
      makeMessage({
        id: 'm1',
        role: 'assistant',
        content: 'Draft topology ready.',
        toolCalls: [
          {
            toolCallId: 'tool-topology-1',
            toolName: 'generate_topology',
            input: { summary: 'initial draft' },
            result: { summary: 'Topology with 4 agents', truncated: true },
          },
        ],
      }),
      makeMessage({
        id: 'm2',
        role: 'user',
        content: 'We need WhatsApp support for the assistant.',
        timestamp: '2026-04-20T08:00:01.000Z',
      }),
      makeMessage({
        id: 'm3',
        role: 'assistant',
        content: '',
        timestamp: '2026-04-20T08:00:02.000Z',
        toolCalls: [
          {
            toolCallId: 'pending-widget-1',
            toolName: 'ask_user',
            input: {
              widgetType: 'ShortText',
              question: 'What should we call the project?',
            },
          },
        ],
      }),
      makeMessage({
        id: 'm4',
        role: 'assistant',
        content: 'We should keep the booking flow lightweight.',
        timestamp: '2026-04-20T08:00:03.000Z',
      }),
      ...Array.from({ length: 12 }, (_, index) =>
        makeMessage({
          id: `tail-${index + 1}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content:
            index % 2 === 0
              ? `Recent user turn ${index + 1}`
              : `Recent assistant turn ${index + 1}`,
          timestamp: `2026-04-20T08:00:${String(index + 4).padStart(2, '0')}.000Z`,
        }),
      ),
    ];

    const persistHistorySummary = vi.fn();
    const result = await prepareTurnHistory({
      session: makeSession(messages),
      fileStore: makeFileStore(),
      ctx: { tenantId: 'tenant-1', userId: 'user-1' },
      sessionId: 'session-1',
      persistHistorySummary,
    });

    expect(persistHistorySummary).toHaveBeenCalledOnce();
    expect(result.historySummary).toMatchObject({
      compactedThroughMessageId: 'm4',
    });
    expect(result.historySummary?.openThreads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: 'We need WhatsApp support for the assistant.',
        }),
      ]),
    );

    expect(result.history[0]).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('Earlier conversation summary'),
    });
    const toolOutcomeHistory = result.history.find(
      (message) =>
        message.role === 'assistant' &&
        typeof message.content === 'string' &&
        message.content.includes('generate_topology: Topology with 4 agents'),
    );
    expect(toolOutcomeHistory).toBeDefined();
    expect(String(toolOutcomeHistory?.content)).not.toContain('"truncated"');
    expect(result.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('generate_topology'),
        }),
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('What should we call the project?'),
        }),
      ]),
    );
    expect(result.historySummary?.capturedAnswers).toHaveLength(0);
  });

  it('continues the turn with an in-memory summary when historySummary persistence fails', async () => {
    const messages: StoredMessage[] = Array.from({ length: 13 }, (_, index) =>
      makeMessage({
        id: `msg-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${index + 1}`,
        timestamp: `2026-04-20T08:00:${String(index).padStart(2, '0')}.000Z`,
      }),
    );

    const persistHistorySummary = vi.fn().mockRejectedValue(new Error('write failed'));

    const result = await prepareTurnHistory({
      session: makeSession(messages, { pendingInteraction: null }),
      fileStore: makeFileStore(),
      ctx: { tenantId: 'tenant-1', userId: 'user-1' },
      sessionId: 'session-1',
      persistHistorySummary,
    });

    expect(persistHistorySummary).toHaveBeenCalledOnce();
    expect(result.historySummary).not.toBeNull();
    expect(result.history[0]).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('Earlier conversation summary'),
    });
  });

  it('injects pending mutation context into turn history when proposal state is older than the raw tail', async () => {
    const messages: StoredMessage[] = [
      makeMessage({
        id: 'proposal-user-1',
        role: 'user',
        content: 'Please tighten the LeadIntake agent so it books demos faster.',
      }),
      makeMessage({
        id: 'proposal-assistant-1',
        role: 'assistant',
        content: 'I prepared a focused LeadIntake update proposal for review.',
        timestamp: '2026-04-20T08:00:01.000Z',
      }),
      ...Array.from({ length: 12 }, (_, index) =>
        makeMessage({
          id: `tail-pending-${index + 1}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `Recent turn ${index + 1}`,
          timestamp: `2026-04-20T08:00:${String(index + 2).padStart(2, '0')}.000Z`,
        }),
      ),
    ];

    const result = await prepareTurnHistory({
      session: makeSession(messages, {
        mode: 'IN_PROJECT',
        pendingInteraction: null,
        pendingMutation: makePendingMutation(),
      }),
      fileStore: makeFileStore(),
      ctx: { tenantId: 'tenant-1', userId: 'user-1' },
      sessionId: 'session-1',
      persistHistorySummary: vi.fn(),
    });

    const pendingMutationHistory = result.history.find(
      (message) =>
        message.role === 'assistant' &&
        typeof message.content === 'string' &&
        message.content.includes('Pending mutation awaiting review'),
    );

    expect(pendingMutationHistory).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('LeadIntake'),
    });
    expect(String(pendingMutationHistory?.content)).toContain('Tighten goal and persona');
  });

  it('injects pending plan context so side-chat remains aware of the active review', async () => {
    const messages: StoredMessage[] = [
      makeMessage({
        id: 'plan-user-1',
        role: 'user',
        content: 'Add a feedback agent to resolved paths.',
      }),
      makeMessage({
        id: 'plan-assistant-1',
        role: 'assistant',
        content: 'I prepared a plan for review.',
        timestamp: '2026-04-20T08:00:01.000Z',
      }),
      ...Array.from({ length: 12 }, (_, index) =>
        makeMessage({
          id: `tail-plan-${index + 1}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `Recent turn ${index + 1}`,
          timestamp: `2026-04-20T08:00:${String(index + 2).padStart(2, '0')}.000Z`,
        }),
      ),
    ];

    const result = await prepareTurnHistory({
      session: makeSession(messages, {
        mode: 'IN_PROJECT',
        pendingInteraction: null,
        pendingPlan: makePendingPlan('proposed'),
      }),
      fileStore: makeFileStore(),
      ctx: { tenantId: 'tenant-1', userId: 'user-1' },
      sessionId: 'session-1',
      persistHistorySummary: vi.fn(),
    });

    const pendingPlanHistory = result.history.find(
      (message) =>
        message.role === 'assistant' &&
        typeof message.content === 'string' &&
        message.content.includes('Current in-project plan review state'),
    );

    expect(pendingPlanHistory).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('Add FeedbackAgent'),
    });
    expect(String(pendingPlanHistory?.content)).toContain('User can approve, refine, or cancel');
  });

  it('does not double-count deterministic tool-answer echoes as open user threads', async () => {
    const messages: StoredMessage[] = [
      makeMessage({
        id: 'assistant-question-1',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            toolCallId: 'tool-name-1',
            toolName: 'ask_user',
            input: {
              widgetType: 'ShortText',
              question: 'What should we call the project?',
            },
            result: 'BookingHub',
          },
        ],
      }),
      makeMessage({
        id: 'user-answer-echo-1',
        role: 'user',
        content: 'Answer to "What should we call the project?": BookingHub',
        timestamp: '2026-04-20T08:00:01.000Z',
        messageMetadata: {
          source: 'deterministic_tool_answer',
          toolCallId: 'tool-name-1',
        },
      }),
      ...Array.from({ length: 12 }, (_, index) =>
        makeMessage({
          id: `tail-answer-${index + 1}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `Recent turn ${index + 1}`,
          timestamp: `2026-04-20T08:00:${String(index + 2).padStart(2, '0')}.000Z`,
        }),
      ),
    ];

    const result = await prepareTurnHistory({
      session: makeSession(messages, { pendingInteraction: null }),
      fileStore: makeFileStore(),
      ctx: { tenantId: 'tenant-1', userId: 'user-1' },
      sessionId: 'session-1',
      persistHistorySummary: vi.fn(),
    });

    expect(result.historySummary?.capturedAnswers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          prompt: 'What should we call the project?',
          answer: 'BookingHub',
        }),
      ]),
    );
    expect(result.historySummary?.openThreads).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: expect.stringContaining('BookingHub'),
        }),
      ]),
    );
  });
});
