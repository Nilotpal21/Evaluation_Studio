import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { generateText } from 'ai';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';
import { createThread } from '../../services/execution/types.js';

const mockGenerateText = vi.mocked(generateText);

const STEP_DIGRESSION_AGENT = `
AGENT: StepDigressionClassifierFirst

GOAL: "Collect the user's request"

FLOW:
  entry_point: collect_request
  steps:
    - collect_request

collect_request:
  REASONING: false
  GATHER:
    - request: required
  DIGRESSIONS:
    - INTENT: price_breakdown_request
      KEYWORDS: [price breakdown]
      RESPOND: "Here is the pricing breakdown."
      RESUME: true
  THEN: COMPLETE
`;

const SUB_INTENT_AGENT = `
AGENT: SubIntentClassifierFirst

GOAL: "Collect the user's lodging choice"

FLOW:
  entry_point: collect_lodging
  steps:
    - collect_lodging

collect_lodging:
  REASONING: false
  GATHER:
    - lodging: required
  SUB_INTENTS:
    - INTENT: "prefer luxury"
      SET: preference = luxury
      RESPOND: "Luxury preference saved."
  THEN: COMPLETE
`;

const RETURN_CHILD_SUPERVISOR = `
SUPERVISOR: FollowupSupportSupervisor

GOAL: "Route card-help and database-search requests"

PERSONA: "A follow-up routing supervisor"

INTENTS:
  LEXICAL_FALLBACK: when_unavailable
  card_help: "Card payment and card support requests"
  database_search: "Database search requests for invoices and records"

HANDOFF:
  - TO: CardGatherChild
    WHEN: intent.category == "card_help"
    RETURN: true

  - TO: DatabaseSearchChild
    WHEN: intent.category == "database_search"
    RETURN: true
`;

const CARD_GATHER_CHILD = `
AGENT: CardGatherChild

GOAL: "Collect the last four digits of the caller card"

FLOW:
  entry_point: collect_card
  steps:
    - collect_card

collect_card:
  REASONING: false
  GATHER:
    - card_last4: required
  THEN: COMPLETE
`;

const DATABASE_SEARCH_CHILD = `
AGENT: DatabaseSearchChild

GOAL: "Answer database search requests"

FLOW:
  entry_point: respond
  steps:
    - respond

respond:
  REASONING: false
  RESPOND: "DatabaseSearchChild looked up the invoice."
  THEN: COMPLETE
`;

const LEAVE_ROUTE_SUPERVISOR = `
AGENT: LeaveRouteSupervisor

GOAL: "Route leave requests to the correct leave specialist"

PERSONA: "Leave routing supervisor"

HANDOFF:
  - TO: LeaveApplicationChild
    WHEN: true
    RETURN: true

  - TO: LeaveBalanceChild
    WHEN: true
    RETURN: true
`;

const LEAVE_APPLICATION_CHILD = `
AGENT: LeaveApplicationChild

GOAL: "Collect leave application details"

FLOW:
  entry_point: collect_reason
  steps:
    - collect_reason

collect_reason:
  REASONING: false
  GATHER:
    - leave_reason: required
      prompt: "What is the reason for the leave application?"
  THEN: COMPLETE
`;

const LEAVE_BALANCE_CHILD = `
AGENT: LeaveBalanceChild

GOAL: "Answer leave balance questions"

FLOW:
  entry_point: respond_balance
  steps:
    - respond_balance

respond_balance:
  REASONING: false
  RESPOND: "LeaveBalanceChild checked the user's leave balance."
  THEN: COMPLETE
`;

function createPipelineConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    mode: 'sequential',
    modelSource: 'default',
    shortCircuit: { enabled: false, confidenceThreshold: 0.85 },
    toolFilter: { enabled: false, maxTools: 6 },
    keywordVeto: { enabled: false, keywords: [] },
    intentBridge: {
      enabled: false,
      programmaticThreshold: 0.85,
      guidedThreshold: 0.5,
      outOfScopeDecline: true,
      multiIntentSignal: true,
    },
    ...overrides,
  };
}

function createTraceCollector(): {
  traces: Array<{ type: string; data: Record<string, unknown> }>;
  callback: (event: { type: string; data: Record<string, unknown> }) => void;
} {
  const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    traces,
    callback: (event) => traces.push(event),
  };
}

type MockChatMessage = {
  role: string;
  content: unknown;
};

type MockChatResponse = {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason: string;
  rawContent: Array<{ type: string; [key: string]: unknown }>;
};

class MockLLMClient {
  private responseHandler: (
    systemPrompt: string,
    messages: MockChatMessage[],
    tools: unknown[],
  ) => MockChatResponse;

  constructor() {
    this.responseHandler = () => buildMockChatResponse('Default response.');
  }

  async resolveLanguageModel(_operationType: string) {
    return { modelId: 'pipeline-model' };
  }

  setResponseHandler(handler: typeof this.responseHandler) {
    this.responseHandler = handler;
  }

  async chatWithToolUse(systemPrompt: string, messages: MockChatMessage[], tools: unknown[]) {
    return this.responseHandler(systemPrompt, messages, tools);
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: MockChatMessage[],
    tools: unknown[],
    _operationType?: string,
    _onChunk?: (chunk: string) => void,
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools);
  }
}

function buildMockChatResponse(text: string): MockChatResponse {
  return {
    text,
    toolCalls: [],
    stopReason: 'end_turn',
    rawContent: [{ type: 'text', text }],
  };
}

function injectMockClient(executor: RuntimeExecutor): MockLLMClient {
  const mockClient = new MockLLMClient();
  (
    executor as unknown as {
      llmWiring: {
        wireLLMClient: (session: unknown) => Promise<void>;
        ensureSessionLLMClient: (session: unknown) => Promise<void>;
      };
    }
  ).llmWiring.wireLLMClient = async (session) => {
    (session as { llmClient?: MockLLMClient }).llmClient = mockClient;
  };
  (
    executor as unknown as {
      llmWiring: {
        wireLLMClient: (session: unknown) => Promise<void>;
        ensureSessionLLMClient: (session: unknown) => Promise<void>;
      };
    }
  ).llmWiring.ensureSessionLLMClient = async (session) => {
    const mutableSession = session as { llmClient?: MockLLMClient };
    if (!mutableSession.llmClient) {
      mutableSession.llmClient = mockClient;
    }
  };
  return mockClient;
}

function configureActiveFlowPipeline(
  session: ReturnType<RuntimeExecutor['createSessionFromResolved']>,
  llmClient: MockLLMClient,
) {
  const activeThread = session.threads[session.activeThreadIndex];
  const activeIR = activeThread.agentIR ?? session.agentIR;
  if (!activeIR) {
    throw new Error('Expected active agent IR to exist');
  }

  activeIR.execution = {
    ...(activeIR.execution ?? {}),
    pipeline: createPipelineConfig(),
  } as typeof activeIR.execution;

  activeThread.agentIR = activeIR;
  activeThread.llmClient = llmClient as never;
  session.agentIR = activeIR;
  session.llmClient = llmClient as never;
}

function configurePipelineOnThread(
  thread: {
    agentIR?: ReturnType<RuntimeExecutor['createSessionFromResolved']>['agentIR'];
    llmClient?: MockLLMClient;
  },
  llmClient: MockLLMClient,
) {
  if (!thread.agentIR) {
    throw new Error('Expected thread agent IR to exist');
  }

  thread.agentIR = {
    ...thread.agentIR,
    execution: {
      ...(thread.agentIR.execution ?? {}),
      pipeline: createPipelineConfig(),
    },
  };
  thread.llmClient = llmClient;
}

function configureExtraction(mockClient: MockLLMClient, field: string) {
  mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
    const usesExtraction = (tools as Array<{ name?: string }>).some(
      (tool) => tool.name === '_extract_entities',
    );
    if (!usesExtraction) {
      return buildMockChatResponse('Default response.');
    }

    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === 'user' && typeof message.content === 'string');
    const extractedValue =
      typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';

    return buildMockChatResponse(
      JSON.stringify({
        [field]: extractedValue,
      }),
    );
  });
}

describe('flow-step executor classifier-first gather routing', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockLLMClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    executor.stopStaleReaper();
  });

  it('uses the classifier-first gather digression lane for semantic paraphrases', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([STEP_DIGRESSION_AGENT], 'StepDigressionClassifierFirst'),
    );

    configureActiveFlowPipeline(session, mockClient);
    configureExtraction(mockClient, 'request');
    await executor.initializeSession(session.id);

    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: 'price_breakdown_request',
            confidence: 0.93,
            summary: 'user wants a cost summary',
          },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 18,
        outputTokens: 8,
      },
    } as never);

    const chunks: string[] = [];
    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'Could you explain the full cost summary?',
      (chunk) => chunks.push(chunk),
      traceCollector.callback,
    );

    expect(chunks.join('')).toContain('pricing breakdown');
    expect(session.currentFlowStep).toBe('collect_request');
    expect(session.data.values.request).toBeUndefined();
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'digression',
        data: expect.objectContaining({
          intent: 'price_breakdown_request',
          detectionMode: 'pipeline',
          matched: 'user wants a cost summary',
          candidateSurface: expect.objectContaining({
            kind: 'digression',
            candidates: ['price_breakdown_request'],
          }),
        }),
      }),
    );
  });

  it('keeps gather ownership when the classifier rejects a lexical sub-intent candidate', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUB_INTENT_AGENT], 'SubIntentClassifierFirst'),
    );

    configureActiveFlowPipeline(session, mockClient);
    configureExtraction(mockClient, 'lodging');
    await executor.initializeSession(session.id);

    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: null,
            confidence: 0.16,
            summary: 'plain gather input',
          },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 16,
        outputTokens: 7,
      },
    } as never);

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'prefer luxury',
      undefined,
      traceCollector.callback,
    );

    expect(result.action?.type).not.toBe('digression');
    expect(session.data.values.lodging).toBe('prefer luxury');
    expect(session.data.values.preference).toBeUndefined();
    expect(traceCollector.traces.some((event) => event.type === 'sub_intent')).toBe(false);
  });

  it('keeps gather ownership when the parent supervisor classifier rejects a lexical reroute candidate', async () => {
    const resolved = compileToResolvedAgent(
      [RETURN_CHILD_SUPERVISOR, CARD_GATHER_CHILD, DATABASE_SEARCH_CHILD],
      'FollowupSupportSupervisor',
    );
    const session = executor.createSessionFromResolved(resolved, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });

    const parentThread = session.threads[0];
    parentThread.status = 'waiting';
    parentThread.conversationHistory.push({
      role: 'user',
      content: 'i need help with my card payment',
    });
    configurePipelineOnThread(parentThread, mockClient);

    const childAgentIR = resolved.agents.CardGatherChild ?? null;
    const childThread = createThread(session, 'CardGatherChild', childAgentIR, {
      handoffFrom: 'FollowupSupportSupervisor',
      returnExpected: true,
    });
    childThread.currentFlowStep = 'collect_card';
    childThread.waitingForInput = ['card_last4'];
    childThread.status = 'active';
    childThread.llmClient = mockClient as never;

    session.handoffReturnInfo = { CardGatherChild: true, DatabaseSearchChild: true };
    session.activeThreadIndex = 1;
    session.threadStack = [0];
    session.agentName = 'CardGatherChild';
    session.agentIR = childAgentIR;
    session.currentFlowStep = 'collect_card';
    session.waitingForInput = ['card_last4'];
    session.llmClient = mockClient as never;

    configureExtraction(mockClient, 'card_last4');
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [{ category: null, confidence: 0.18, summary: 'plain gather input' }],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 17,
        outputTokens: 6,
      },
    } as never);

    const traceCollector = createTraceCollector();
    const result = await (
      executor as unknown as {
        flowStep: {
          executeFlowStep: (
            runtimeSession: ReturnType<RuntimeExecutor['createSessionFromResolved']>,
            userMessage: string,
            onChunk?: (chunk: string) => void,
            onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
          ) => Promise<{ action?: { type?: string } }>;
        };
      }
    ).flowStep.executeFlowStep(
      session,
      'search the database for invoice 42',
      undefined,
      traceCollector.callback,
    );

    expect(result.action?.type).not.toBe('return_to_parent');
    expect(session.data.values.card_last4).toBe('search the database for invoice 42');
    expect(session.waitingForInput).toBeUndefined();
    expect(
      traceCollector.traces.some(
        (event) => event.type === 'digression' && event.data.action === 'return_to_parent',
      ),
    ).toBe(false);
  });

  it('keeps supervisor tool-call leave application handoff on the resolved child target', async () => {
    const resolved = compileToResolvedAgent(
      [LEAVE_ROUTE_SUPERVISOR, LEAVE_APPLICATION_CHILD, LEAVE_BALANCE_CHILD],
      'LeaveRouteSupervisor',
    );
    const session = executor.createSessionFromResolved(resolved, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
    session.handoffReturnInfo = { LeaveApplicationChild: true, LeaveBalanceChild: true };

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      if (
        (tools as Array<{ name?: string }>).some(
          (tool) => tool.name === 'handoff_to_LeaveApplicationChild',
        )
      ) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'leave-application-handoff',
              name: 'handoff_to_LeaveApplicationChild',
              input: {
                reason: 'User wants to apply for leave',
                message: 'Transfer user to agent LeaveApplicationChild',
              },
            },
          ],
          stopReason: 'tool-calls',
          rawContent: [
            {
              type: 'tool_use',
              id: 'leave-application-handoff',
              name: 'handoff_to_LeaveApplicationChild',
              input: {
                reason: 'User wants to apply for leave',
                message: 'Transfer user to agent LeaveApplicationChild',
              },
            },
          ],
        };
      }

      return buildMockChatResponse('Leave route supervisor default response.');
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'I want to apply for leave',
      undefined,
      traceCollector.callback,
    );

    expect(session.agentName).toBe('LeaveApplicationChild');
    expect(result.response).not.toContain('LeaveBalanceChild checked');
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'handoff',
        data: expect.objectContaining({
          to: 'LeaveApplicationChild',
        }),
      }),
    );
  });
});
