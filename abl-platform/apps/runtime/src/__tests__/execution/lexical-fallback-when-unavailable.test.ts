import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { generateText } from 'ai';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';

const mockGenerateText = vi.mocked(generateText);

const UNUSED_ROUTE_AGENT = `
AGENT: UnusedRouteAgent

GOAL: "Unused route target"

FLOW:
  entry_point: respond_unused
  steps:
    - respond_unused

respond_unused:
  REASONING: false
  RESPOND: "Unused route target."
  THEN: COMPLETE
`;

const WHEN_UNAVAILABLE_POLICY_AGENT = `
AGENT: GatherInterruptWhenUnavailablePolicy

GOAL: "Collect the user's request"

INTENTS:
  LEXICAL_FALLBACK: when_unavailable
  unused_route

HANDOFF:
  - TO: UnusedRouteAgent
    WHEN: intent.category == "unused_route"

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

const NEVER_POLICY_AGENT = `
AGENT: GatherInterruptNeverPolicy

GOAL: "Collect the user's request"

INTENTS:
  LEXICAL_FALLBACK: never
  unused_route

HANDOFF:
  - TO: UnusedRouteAgent
    WHEN: intent.category == "unused_route"

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

function getClassifierPrompts(): string[] {
  return mockGenerateText.mock.calls
    .map(([parameters]) => ((parameters as { prompt?: string } | undefined)?.prompt ?? '').trim())
    .filter((prompt) => prompt.startsWith('You are an intent classifier.'));
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
  overrides: Record<string, unknown> = {},
) {
  const activeThread = session.threads[session.activeThreadIndex];
  const activeIR = activeThread.agentIR ?? session.agentIR;
  if (!activeIR) {
    throw new Error('Expected active agent IR to exist');
  }

  activeIR.execution = {
    ...(activeIR.execution ?? {}),
    pipeline: createPipelineConfig(overrides),
  } as typeof activeIR.execution;

  activeThread.agentIR = activeIR;
  activeThread.llmClient = llmClient as never;
  session.agentIR = activeIR;
  session.llmClient = llmClient as never;
}

function disableActiveFlowPipeline(
  session: ReturnType<RuntimeExecutor['createSessionFromResolved']>,
) {
  const activeThread = session.threads[session.activeThreadIndex];
  const activeIR = activeThread.agentIR ?? session.agentIR;
  if (!activeIR) {
    throw new Error('Expected active agent IR to exist');
  }

  activeIR.execution = {
    ...(activeIR.execution ?? {}),
    pipeline: createPipelineConfig({ enabled: false }),
  } as typeof activeIR.execution;

  activeThread.agentIR = activeIR;
  session.agentIR = activeIR;
}

function configureNoopExtraction(mockClient: MockLLMClient) {
  mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
    const usesExtraction = (tools as Array<{ name?: string }>).some(
      (tool) => tool.name === '_extract_entities',
    );
    if (!usesExtraction) {
      return buildMockChatResponse('Default response.');
    }

    return buildMockChatResponse('{}');
  });
}

describe('lexical fallback when unavailable', () => {
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

  it('rescues a lexical gather digression after the pipeline becomes unavailable mid-session', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [WHEN_UNAVAILABLE_POLICY_AGENT, UNUSED_ROUTE_AGENT],
        'GatherInterruptWhenUnavailablePolicy',
      ),
    );

    configureActiveFlowPipeline(session, mockClient);
    configureNoopExtraction(mockClient);
    await executor.initializeSession(session.id);

    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: null,
            confidence: 0.12,
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

    const firstTurnTraces = createTraceCollector();
    const firstTurnResult = await executor.executeMessage(
      session.id,
      'price breakdowns please',
      undefined,
      firstTurnTraces.callback,
    );

    expect(getClassifierPrompts().length).toBeGreaterThanOrEqual(1);
    expect(firstTurnResult.action?.type).not.toBe('digression');
    expect(firstTurnTraces.traces.some((event) => event.type === 'digression')).toBe(false);
    expect(session.currentFlowStep).toBe('collect_request');
    expect(session.data.values.request).toBeUndefined();
    expect(session.isComplete).not.toBe(true);

    mockGenerateText.mockClear();
    disableActiveFlowPipeline(session);

    const chunks: string[] = [];
    const outageTurnTraces = createTraceCollector();
    const outageTurnResult = await executor.executeMessage(
      session.id,
      'price breakdowns please',
      (chunk) => chunks.push(chunk),
      outageTurnTraces.callback,
    );

    expect(getClassifierPrompts()).toHaveLength(0);
    expect(outageTurnResult.action?.type).toBe('collect');
    expect(chunks.join('')).toContain('pricing breakdown');
    expect(session.currentFlowStep).toBe('collect_request');
    expect(session.data.values.request).toBeUndefined();
    expect(session.isComplete).not.toBe(true);
    expect(outageTurnTraces.traces).toContainEqual(
      expect.objectContaining({
        type: 'digression',
        data: expect.objectContaining({
          intent: 'price_breakdown_request',
          detectionMode: 'lexical',
          lexicalMatchType: 'normalized',
          policyApplied: 'when_unavailable',
        }),
      }),
    );
  });

  it('keeps gather ownership through an outage when the policy is never', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [NEVER_POLICY_AGENT, UNUSED_ROUTE_AGENT],
        'GatherInterruptNeverPolicy',
      ),
    );

    configureActiveFlowPipeline(session, mockClient);
    configureNoopExtraction(mockClient);
    await executor.initializeSession(session.id);

    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: null,
            confidence: 0.12,
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

    const firstTurnTraces = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'price breakdowns please',
      undefined,
      firstTurnTraces.callback,
    );

    expect(getClassifierPrompts().length).toBeGreaterThanOrEqual(1);
    expect(firstTurnTraces.traces.some((event) => event.type === 'digression')).toBe(false);
    expect(session.currentFlowStep).toBe('collect_request');
    expect(session.data.values.request).toBeUndefined();
    expect(session.isComplete).not.toBe(true);

    mockGenerateText.mockClear();
    disableActiveFlowPipeline(session);

    const promptsBeforeOutage = getClassifierPrompts().length;
    const outageTurnTraces = createTraceCollector();
    const outageTurnResult = await executor.executeMessage(
      session.id,
      'price breakdowns please',
      undefined,
      outageTurnTraces.callback,
    );

    expect(outageTurnResult.action?.type).not.toBe('digression');
    expect(outageTurnTraces.traces.some((event) => event.type === 'digression')).toBe(false);
    expect(session.currentFlowStep).toBe('collect_request');
    expect(session.data.values.request).toBeUndefined();
    expect(session.isComplete).not.toBe(true);
    expect(getClassifierPrompts().length).toBe(promptsBeforeOutage);
  });
});
