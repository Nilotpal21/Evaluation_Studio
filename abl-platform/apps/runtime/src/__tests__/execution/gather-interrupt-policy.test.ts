import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { generateText } from 'ai';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';
import {
  resolveGatherInterruptLexicalFallbackPolicy,
  shouldAllowGatherInterruptLexicalFallback,
} from '../../services/pipeline/routing-resolver.js';

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

const ALWAYS_POLICY_AGENT = `
AGENT: GatherInterruptAlwaysPolicy

GOAL: "Collect the user's request"

INTENTS:
  LEXICAL_FALLBACK: always
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

function getClassifierPrompts(): string[] {
  return mockGenerateText.mock.calls
    .map(([parameters]) => ((parameters as { prompt?: string } | undefined)?.prompt ?? '').trim())
    .filter((prompt) => prompt.startsWith('You are an intent classifier.'));
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

function configureExtraction(mockClient: MockLLMClient) {
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
        request: extractedValue,
      }),
    );
  });
}

describe('gather interrupt lexical fallback policy', () => {
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

  it('defaults missing policy to when_unavailable and blocks semantic rescue by default', () => {
    const policy = resolveGatherInterruptLexicalFallbackPolicy(undefined);

    expect(policy).toBe('when_unavailable');
    expect(shouldAllowGatherInterruptLexicalFallback(policy, 'unavailable')).toBe(true);
    expect(shouldAllowGatherInterruptLexicalFallback(policy, 'semantic_rejection')).toBe(false);
  });

  it('allows semantic lexical rescue only when the policy is always', () => {
    expect(shouldAllowGatherInterruptLexicalFallback('always', 'semantic_rejection')).toBe(true);
    expect(shouldAllowGatherInterruptLexicalFallback('never', 'semantic_rejection')).toBe(false);
    expect(shouldAllowGatherInterruptLexicalFallback('never', 'unavailable')).toBe(false);
  });

  it('rescues a lexical digression after semantic rejection when policy is always', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [ALWAYS_POLICY_AGENT, UNUSED_ROUTE_AGENT],
        'GatherInterruptAlwaysPolicy',
      ),
    );

    configureActiveFlowPipeline(session, mockClient);
    configureExtraction(mockClient);
    await executor.initializeSession(session.id);

    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: null,
            confidence: 0.11,
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

    const chunks: string[] = [];
    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'price breakdowns please',
      (chunk) => chunks.push(chunk),
      traceCollector.callback,
    );

    expect(chunks.join('')).toContain('pricing breakdown');
    expect(session.data.values.request).toBeUndefined();
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'digression',
        data: expect.objectContaining({
          intent: 'price_breakdown_request',
          detectionMode: 'lexical',
          lexicalMatchType: 'normalized',
          policyApplied: 'always',
        }),
      }),
    );
  });

  it('suppresses lexical fallback during unavailability when policy is never', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [NEVER_POLICY_AGENT, UNUSED_ROUTE_AGENT],
        'GatherInterruptNeverPolicy',
      ),
    );

    configureActiveFlowPipeline(session, mockClient, { enabled: false });
    configureExtraction(mockClient);
    await executor.initializeSession(session.id);

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'price breakdowns please',
      undefined,
      traceCollector.callback,
    );

    expect(getClassifierPrompts()).toHaveLength(0);
    expect(result.action?.type).not.toBe('digression');
    expect(session.data.values.request).toBe('price breakdowns please');
    expect(traceCollector.traces.some((event) => event.type === 'digression')).toBe(false);
  });
});
