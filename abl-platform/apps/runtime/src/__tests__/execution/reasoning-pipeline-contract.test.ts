import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TOOL_RETURN_TO_PARENT } from '@abl/compiler';

const mockGetConfigAsync = vi.fn();

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

vi.mock('../../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: mockGetConfigAsync,
  }),
}));

vi.mock('../../services/guardrails/pipeline-factory.js', () => ({
  createGuardrailPipeline: vi.fn().mockReturnValue({
    execute: vi.fn().mockResolvedValue({ passed: true }),
  }),
  createLLMEvalFromClient: vi.fn(() => undefined),
  ensureTenantProvidersLoaded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/execution/session-policy.js', () => ({
  getSessionPolicy: vi.fn().mockResolvedValue(null),
  getSessionGuardrailCacheScopeKey: vi.fn().mockReturnValue('test-guardrail-scope'),
  getSessionStreamingConfig: vi.fn().mockReturnValue(undefined),
  toStreamingEvalConfig: vi.fn().mockReturnValue(undefined),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectRuntimeConfig: {
    findOne: vi.fn(() => ({
      lean: vi.fn().mockResolvedValue(null),
    })),
  },
}));

import { generateText } from 'ai';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';
import { buildSystemPrompt, buildTools } from '../../services/execution/prompt-builder.js';
import * as classifierModule from '../../services/pipeline/classifier.js';

const mockGenerateText = vi.mocked(generateText);
const CLASSIFIER_PROMPT_PREFIX = 'You are an intent classifier.';
const FILLER_PROMPT_PREFIX = 'Generate a single brief status message';

function getGenerateTextPrompts(): string[] {
  return mockGenerateText.mock.calls.map(([parameters]) =>
    ((parameters as { prompt?: string } | undefined)?.prompt ?? '').trim(),
  );
}

function getClassifierPrompts(): string[] {
  return getGenerateTextPrompts().filter((prompt) => prompt.startsWith(CLASSIFIER_PROMPT_PREFIX));
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

async function executeFlowStepDirectly(
  runtimeExecutor: RuntimeExecutor,
  session: ReturnType<RuntimeExecutor['createSessionFromResolved']>,
  message: string,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): Promise<{ response?: string; action?: Record<string, unknown> }> {
  return (
    runtimeExecutor as unknown as {
      flowStep: {
        executeFlowStep: (
          runtimeSession: ReturnType<RuntimeExecutor['createSessionFromResolved']>,
          userMessage: string,
          onChunk?: (chunk: string) => void,
          onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
        ) => Promise<{ response?: string; action?: Record<string, unknown> }>;
      };
    }
  ).flowStep.executeFlowStep(session, message, undefined, onTraceEvent);
}

class MockLLMClient {
  calls: Array<{
    systemPrompt: string;
    messages: Array<{ role: string; content: unknown }>;
    tools: unknown[];
  }> = [];

  private responseHandler: (
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) => {
    text: string;
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stopReason: string;
    rawContent: Array<{ type: string; [key: string]: unknown }>;
  };

  constructor() {
    this.responseHandler = () => ({
      text: 'Default response.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Default response.' }],
    });
  }

  async resolveLanguageModel(_operationType: string) {
    return { modelId: 'pipeline-model' } as any;
  }

  getLastResolvedModel() {
    return { modelId: 'pipeline-model', provider: 'test', source: 'test' };
  }

  setResponseHandler(handler: typeof this.responseHandler) {
    this.responseHandler = handler;
  }

  async chatWithToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) {
    this.calls.push({ systemPrompt, messages, tools });
    return this.responseHandler(systemPrompt, messages, tools);
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    _operationType?: string,
    _onChunk?: (chunk: string) => void,
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools);
  }
}

function injectMockClient(executor: RuntimeExecutor): MockLLMClient {
  const mock = new MockLLMClient();
  (executor as any).llmWiring.wireLLMClient = async (session: any) => {
    session.llmClient = mock;
  };
  (executor as any).llmWiring.ensureSessionLLMClient = async (session: any) => {
    if (!session.llmClient) {
      session.llmClient = mock;
    }
  };
  return mock;
}

function createPipelineConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    mode: 'sequential',
    modelSource: 'default',
    shortCircuit: { enabled: false, confidenceThreshold: 0.85 },
    toolFilter: { enabled: false, maxTools: 6 },
    keywordVeto: { enabled: true, keywords: [] },
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

function createIntentBridgeEnabledPipelineConfig(overrides: Record<string, unknown> = {}) {
  return createPipelineConfig({
    intentBridge: {
      enabled: true,
      programmaticThreshold: 0.85,
      guidedThreshold: 0.5,
      outOfScopeDecline: true,
      multiIntentSignal: true,
    },
    ...overrides,
  });
}

const STANDALONE_SPECIALIST = `
AGENT: StandaloneSpecialist

GOAL: "Handle standalone specialist requests"

PERSONA: "Standalone specialist"
`;

const FLOW_REASONING_OPTIONAL_GATHER_TOOL_AGENT = `
AGENT: OptionalGatherToolAgent

GOAL: "Route order status requests"

PERSONA: "Order intake specialist"

TOOLS:
  route_request_analysis(message_text: string, order_identifier: string, channel: string) -> { route: string }

GATHER:
  order_identifier:
    type: string
    required: false
    prompt: "What is the order number?"
  channel:
    type: string
    required: false
    prompt: "Are you using web chat or voice?"

FLOW:
  steps:
    - collect_order_context
    - done
  collect_order_context:
    REASONING: true
    GATHER:
      - order_identifier
      - channel
    available_tools:
      - route_request_analysis
    THEN: done
  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

const LIMITED_STANDALONE_SPECIALIST = `
AGENT: LimitedStandaloneSpecialist

GOAL: "Handle billing questions only"

PERSONA: "Billing-only specialist"

LIMITATIONS:
  - "Only help with billing questions"
`;

const ROUTING_SPECIALIST = `
AGENT: RoutingSpecialist

GOAL: "Route billing questions when appropriate"

PERSONA: "Routing specialist"

HANDOFF:
  - TO: BillingAgent
    WHEN: intent.category == "billing"
`;

const BILLING_AGENT = `
AGENT: BillingAgent

GOAL: "Handle billing requests"

PERSONA: "Billing specialist"
`;

const RETURNING_SUPERVISOR = `
SUPERVISOR: SupportSupervisor

GOAL: "Route support requests"

PERSONA: "Support routing supervisor"

HANDOFF:
  - TO: BillingChild
    WHEN: intent.category == "billing"
    RETURN: true
`;

const BILLING_CHILD = `
AGENT: BillingChild

GOAL: "Handle billing questions"

PERSONA: "Billing specialist"

GATHER:
  charge_description:
    prompt: "Which charge looks incorrect?"
    type: string
    required: true
`;

const RETURNING_BANKING_SUPERVISOR = `
SUPERVISOR: BankingAdvisor

GOAL: "Route banking requests"

PERSONA: "Banking routing supervisor"

HANDOFF:
  - TO: PaymentFlowChild
    WHEN: intent.category == "payment"
    RETURN: true

  - TO: BalanceInfoChild
    WHEN: intent.category == "balance"
    RETURN: true
`;

const PAYMENT_FLOW_CHILD = `
AGENT: PaymentFlowChild

GOAL: "Collect payment references"

FLOW:
  entry_point: collect_reference
  steps:
    - collect_reference

collect_reference:
  REASONING: false
  GATHER:
    - payment_reference: required
  THEN: COMPLETE
`;

const BALANCE_INFO_CHILD = `
AGENT: BalanceInfoChild

GOAL: "Share balance information"

FLOW:
  entry_point: respond_balance
  steps:
    - respond_balance

respond_balance:
  REASONING: false
  RESPOND: "I can help with your balance."
  THEN: COMPLETE
`;

const CONTRACT_TRIAGE_SUPERVISOR = `
SUPERVISOR: ContractTriage

GOAL: "Route contract metadata and document-content requests"

PERSONA: "Contract routing supervisor"

EXECUTION:
  pipeline:
    enabled: false

INTENTS:
  LEXICAL_FALLBACK: when_unavailable
  metadata_expiry: "expiry dates, expiring, statuses, values"
  document_terms: "legal terms, clauses, obligations, summaries, document content, renewal language"

HANDOFF:
  - TO: DatabaseQueryAgent
    WHEN: intent.category == "metadata_expiry"
    RETURN: true

  - TO: DocumentSearchAgent
    WHEN: intent.category == "document_terms"
    RETURN: true
`;

const CONTRACT_DATABASE_QUERY_AGENT = `
AGENT: DatabaseQueryAgent

GOAL: "Answer structured contract metadata questions only"

PERSONA: "Contract metadata specialist"

TOOLS:
  query_contracts(query: string) -> {results: array}
    description: "Query structured contract metadata"
`;

const CONTRACT_DOCUMENT_SEARCH_AGENT = `
AGENT: DocumentSearchAgent

GOAL: "Answer contract document content questions only"

PERSONA: "Contract document search specialist"

TOOLS:
  search_contracts(query: string) -> {results: array}
    description: "Search contract document content"
`;

const CONTRACT_TRIAGE_FREE_TEXT_SUPERVISOR = `
SUPERVISOR: ContractTriage

GOAL: "Route contract metadata and document-content requests"

PERSONA: "Contract free-text routing supervisor"

EXECUTION:
  pipeline:
    enabled: false

HANDOFF:
  - TO: DocumentSearchAgent
    WHEN: user asks about content inside a contract document, clauses, terms, obligations, summaries, or document language
    CONTEXT:
      summary: "Search contract document content for clauses, terms, obligations, or summaries."
    RETURN: true

  - TO: DatabaseQueryAgent
    WHEN: user asks only about structured metadata, counts, contract IDs, effective dates, expiry dates, renewal dates, party names, values, or statuses
    CONTEXT:
      summary: "Query structured contract metadata only, including expiry dates, parties, values, statuses, and counts."
    RETURN: true
`;

const LOCATION_ROUTING_SUPERVISOR = `
SUPERVISOR: OceanFirstSupervisor

GOAL: "Route banking requests during authentication"

PERSONA: "Ocean First routing supervisor"

INTENTS:
  auth: "Authentication and phone ID verification"
  atm_locator: "Users asking for ATM or branch locations"
  branch_locator: "Users asking for branch locations"

HANDOFF:
  - TO: AuthenticationFlowChild
    WHEN: intent.category == "auth"
    RETURN: true

  - TO: BranchLocatorChild
    WHEN: intent.category == "atm_locator" || intent.category == "branch_locator"
    RETURN: true
`;

const STRICT_LOCATION_ROUTING_SUPERVISOR = `
SUPERVISOR: StrictOceanFirstSupervisor

GOAL: "Route banking requests during authentication"

PERSONA: "Ocean First routing supervisor"

INTENTS:
  LEXICAL_FALLBACK: never
  auth: "Authentication and phone ID verification"
  atm_locator: "Users asking for ATM or branch locations"
  branch_locator: "Users asking for branch locations"

HANDOFF:
  - TO: AuthenticationFlowChild
    WHEN: intent.category == "auth"
    RETURN: true

  - TO: BranchLocatorChild
    WHEN: intent.category == "atm_locator" || intent.category == "branch_locator"
    RETURN: true
`;

const AUTHENTICATION_FLOW_CHILD = `
AGENT: AuthenticationFlowChild

GOAL: "Collect the caller phone ID"

FLOW:
  entry_point: ask_phone_id
  steps:
    - ask_phone_id

ask_phone_id:
  REASONING: false
  GATHER:
    - phone_id: required
  THEN: COMPLETE
`;

const BRANCH_LOCATOR_CHILD = `
AGENT: BranchLocatorChild

GOAL: "Help find nearby ATMs and branches"

FLOW:
  entry_point: respond_location
  steps:
    - respond_location

respond_location:
  REASONING: false
  RESPOND: "I can help locate nearby ATMs and branches."
  THEN: COMPLETE
`;

const GLOBAL_FLOW_DIGRESSION_AGENT = `
AGENT: GlobalFlowDigressionAgent

GOAL: "Collect customer requests"

FLOW:
  entry_point: collect_request
  steps:
    - collect_request

  global_digressions:
    - INTENT: cancel_request
      KEYWORDS: [cancel]
      RESPOND: "Cancelling now."
      RESUME: true

collect_request:
  REASONING: false
  GATHER:
    - request: required
  THEN: COMPLETE
`;

const GLOBAL_CONDITION_DIGRESSION_AGENT = `
AGENT: GlobalConditionDigressionAgent

GOAL: "Collect customer requests"

FLOW:
  entry_point: collect_request
  steps:
    - collect_request

  global_digressions:
    - INTENT: help_request
      KEYWORDS: [help]
      CONDITION: support_mode == "enabled"
      RESPOND: "Support is available."
      RESUME: true

collect_request:
  REASONING: false
  GATHER:
    - request: required
  THEN: COMPLETE
`;

const STEP_FLOW_DIGRESSION_AGENT = `
AGENT: StepFlowDigressionAgent

GOAL: "Collect customer requests"

FLOW:
  entry_point: collect_request
  steps:
    - collect_request

collect_request:
  REASONING: false
  GATHER:
    - request: required
  DIGRESSIONS:
    - INTENT: pricing_breakdown
      KEYWORDS: [price breakdown]
      RESPOND: "Here is the price breakdown."
      RESUME: true
  THEN: COMPLETE
`;

const SUB_INTENT_PIPELINE_AGENT = `
AGENT: SubIntentPipelineAgent

GOAL: "Collect lodging preferences"

FLOW:
  entry_point: collect_lodging
  steps:
    - collect_lodging

collect_lodging:
  REASONING: false
  GATHER:
    - lodging: required
  SUB_INTENTS:
    - INTENT: prefer_luxury
      SET: preference = luxury
      RESPOND: "Noted, luxury preference saved."
  THEN: COMPLETE
`;

function buildMockChatResponse(text: string) {
  return {
    text,
    toolCalls: [],
    stopReason: 'end_turn',
    rawContent: [{ type: 'text', text }],
  };
}

function configureEchoExtraction(mockClient: MockLLMClient) {
  mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
    if (tools.some((tool: any) => tool.name === '_extract_entities')) {
      const lastUserMessage = [...messages]
        .reverse()
        .find((message) => message.role === 'user' && typeof message.content === 'string');
      const extractedValue =
        typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';
      return buildMockChatResponse(
        JSON.stringify({
          request: extractedValue,
          lodging: extractedValue,
        }),
      );
    }

    return buildMockChatResponse('Default response.');
  });
}

function configureActiveFlowPipeline(
  session: ReturnType<RuntimeExecutor['createSessionFromResolved']>,
  llmClient: MockLLMClient,
  overrides: Record<string, unknown> = {},
) {
  const activeThread = session.threads[session.activeThreadIndex];
  const activeIR = activeThread.agentIR ?? session.agentIR;
  if (!activeIR) {
    throw new Error('Expected active flow thread IR to exist');
  }

  activeIR.execution = {
    ...(activeIR.execution ?? {}),
    pipeline: createPipelineConfig({
      shortCircuit: {
        enabled: false,
        confidenceThreshold: 0.85,
      },
      toolFilter: {
        enabled: false,
        maxTools: 6,
      },
      keywordVeto: {
        enabled: false,
        keywords: [],
      },
      intentBridge: {
        enabled: false,
        programmaticThreshold: 0.85,
        guidedThreshold: 0.5,
        outOfScopeDecline: true,
        multiIntentSignal: true,
      },
      ...overrides,
    }),
  } as any;

  activeThread.agentIR = activeIR;
  session.agentIR = activeIR;
  session.llmClient = llmClient as any;
  activeThread.llmClient = llmClient as any;
}

function configureBankingSupervisorPipeline(
  session: ReturnType<RuntimeExecutor['createSessionFromResolved']>,
) {
  const parentThread = session.threads[0];
  const parentIR = parentThread.agentIR;
  if (!parentIR) {
    throw new Error('Expected BankingAdvisor parent thread IR to exist');
  }

  parentIR.execution = {
    ...(parentIR.execution ?? {}),
    pipeline: createPipelineConfig({
      shortCircuit: {
        enabled: true,
        confidenceThreshold: 0.85,
      },
      toolFilter: {
        enabled: false,
        maxTools: 6,
      },
      keywordVeto: {
        enabled: false,
        keywords: [],
      },
      intentBridge: {
        enabled: true,
        programmaticThreshold: 0.85,
        guidedThreshold: 0.5,
        outOfScopeDecline: true,
        multiIntentSignal: true,
      },
    }),
  } as any;
  parentIR.routing = {
    rules: [
      { to: 'PaymentFlowChild', when: 'intent.category == "payment"' },
      { to: 'BalanceInfoChild', when: 'intent.category == "balance"' },
    ],
    default_agent: 'PaymentFlowChild',
    intent_classification: {
      categories: [
        {
          name: 'payment',
          description: 'Users who want to make a payment or pay a credit card bill',
        },
        {
          name: 'balance',
          description: 'Users asking how much money they have available or their current balance',
        },
      ],
      min_confidence: 0.5,
      source: 'explicit',
    },
  } as any;

  session.agentIR = parentIR;
  session.llmClient = session.llmClient ?? parentThread.llmClient;
  parentThread.llmClient = session.llmClient;
  session.tenantId = session.tenantId ?? 'tenant-1';
  session.projectId = session.projectId ?? 'project-1';
}

function configureLocationSupervisorPipeline(
  session: ReturnType<RuntimeExecutor['createSessionFromResolved']>,
  overrides: Record<string, unknown> = {},
) {
  const parentThread = session.threads[0];
  const parentIR = parentThread.agentIR;
  if (!parentIR) {
    throw new Error('Expected OceanFirstSupervisor parent thread IR to exist');
  }

  parentIR.execution = {
    ...(parentIR.execution ?? {}),
    pipeline: createPipelineConfig({
      shortCircuit: {
        enabled: true,
        confidenceThreshold: 0.85,
      },
      toolFilter: {
        enabled: false,
        maxTools: 6,
      },
      keywordVeto: {
        enabled: false,
        keywords: [],
      },
      ...overrides,
    }),
  } as any;

  session.agentIR = parentIR;
  session.llmClient = session.llmClient ?? parentThread.llmClient;
  parentThread.llmClient = session.llmClient;
  session.tenantId = session.tenantId ?? 'tenant-1';
  session.projectId = session.projectId ?? 'project-1';
}

describe('Reasoning executor pipeline contract', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockLLMClient;

  beforeEach(() => {
    mockGetConfigAsync.mockReset();
    mockGetConfigAsync.mockResolvedValue({
      features: {
        advancedNlu: false,
        codeToolsEnabled: false,
      },
    });
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    executor.stopStaleReaper();
    vi.restoreAllMocks();
  });

  it('skips classifier when pipeline is enabled but no control-flow consumer can use it', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([STANDALONE_SPECIALIST], 'StandaloneSpecialist'),
    );

    session.agentIR!.execution.pipeline = createPipelineConfig({
      intentBridge: {
        enabled: false,
        programmaticThreshold: 0.85,
        guidedThreshold: 0.5,
        outOfScopeDecline: true,
        multiIntentSignal: true,
      },
    });
    session.agentIR!.routing = {
      rules: [],
      default_agent: 'FallbackAgent',
      intent_classification: {
        categories: [{ name: 'billing' }],
        min_confidence: 0.5,
        source: 'explicit',
      },
    } as any;

    mockGenerateText.mockImplementation(
      async () =>
        ({
          text: 'NONE',
          finishReason: 'stop',
          usage: {
            inputTokens: 8,
            outputTokens: 1,
          },
        }) as any,
    );

    mockClient.setResponseHandler(() => ({
      text: 'Handled in the normal reasoning loop.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Handled in the normal reasoning loop.' }],
    }));

    const result = await executor.executeMessage(session.id, 'Please help with this request.');

    expect(result.response).toBe('Handled in the normal reasoning loop.');
    expect(getGenerateTextPrompts().some((prompt) => prompt.startsWith(FILLER_PROMPT_PREFIX))).toBe(
      true,
    );
    expect(getClassifierPrompts()).toHaveLength(0);
    expect(mockClient.calls).toHaveLength(1);
  });

  it('hides same-step tools when optional FLOW gather parameters are still empty', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [FLOW_REASONING_OPTIONAL_GATHER_TOOL_AGENT],
        'OptionalGatherToolAgent',
      ),
    );

    await executor.initializeSession(session.id);

    const observedToolNames: string[][] = [];
    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      observedToolNames.push(tools.map((tool: { name: string }) => tool.name));
      return {
        text: 'Could you share the order number?',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Could you share the order number?' }],
      };
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'hi',
      undefined,
      traceCollector.callback,
    );

    expect(result.response).toContain('order number');
    expect(observedToolNames).toHaveLength(1);
    expect(observedToolNames[0]).not.toContain('route_request_analysis');
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'dsl_collect',
        data: expect.objectContaining({
          mode: 'gather_pre_reasoning',
          skipped: true,
          reason: 'trivial_input',
        }),
      }),
    );
  });

  it('runs classifier and bridges intent state when intent bridge is enabled without routing rules', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([STANDALONE_SPECIALIST], 'StandaloneSpecialist'),
    );

    session.agentIR!.execution.pipeline = createIntentBridgeEnabledPipelineConfig();
    session.agentIR!.routing = {
      rules: [],
      default_agent: 'FallbackAgent',
      intent_classification: {
        categories: [{ name: 'billing' }],
        min_confidence: 0.5,
        source: 'explicit',
      },
    } as any;

    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: 'billing',
            confidence: 0.81,
            summary: 'billing question',
            out_of_scope: false,
          },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 24,
        outputTokens: 8,
      },
    } as any);

    mockClient.setResponseHandler(() => ({
      text: 'Handled with classifier-seeded intent state.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Handled with classifier-seeded intent state.' }],
    }));

    const result = await executor.executeMessage(session.id, 'Can you help with my bill?');

    expect(result.response).toBe('Handled with classifier-seeded intent state.');
    expect(getClassifierPrompts()).toHaveLength(1);
    expect(session.data.values.intent).toMatchObject({
      category: 'billing',
      out_of_scope: false,
      intent_count: 1,
    });
    expect(mockClient.calls).toHaveLength(1);
  });

  it('declines out of scope when intent bridge is enabled without routing rules', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([LIMITED_STANDALONE_SPECIALIST], 'LimitedStandaloneSpecialist'),
    );

    session.agentIR!.execution.pipeline = createIntentBridgeEnabledPipelineConfig();
    session.agentIR!.routing = {
      rules: [],
      default_agent: 'FallbackAgent',
      intent_classification: {
        categories: [{ name: 'billing' }],
        min_confidence: 0.5,
        source: 'explicit',
      },
    } as any;

    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: null,
            confidence: 0.94,
            summary: 'travel booking request',
            out_of_scope: true,
          },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 24,
        outputTokens: 8,
      },
    } as any);

    mockClient.setResponseHandler(() => ({
      text: 'This should not be used.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'This should not be used.' }],
    }));

    const result = await executor.executeMessage(session.id, 'Can you book me a flight?');

    expect(getClassifierPrompts()).toHaveLength(1);
    expect(result.action?.type).toBe('decline');
    expect(result.response.length).toBeGreaterThan(0);
    expect(mockClient.calls).toHaveLength(0);
    expect(session.data.values.intent).toMatchObject({
      category: null,
      out_of_scope: true,
      intent_count: 1,
    });
  });

  it('passes bounded recent conversation context into the classifier when routing is actionable', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([ROUTING_SPECIALIST, BILLING_AGENT], 'RoutingSpecialist'),
    );

    session.agentIR!.execution.pipeline = createPipelineConfig({
      intentBridge: {
        enabled: false,
        programmaticThreshold: 0.85,
        guidedThreshold: 0.5,
        outOfScopeDecline: true,
        multiIntentSignal: true,
      },
    });

    session.conversationHistory.push(
      { role: 'user', content: 'Too old: hello' },
      { role: 'assistant', content: 'Too old: hi there' },
      { role: 'user', content: 'I need help with my bill' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Sure, which charge looks wrong?' }],
      },
      { role: 'user', content: 'The late fee' },
      { role: 'assistant', content: 'What about the late fee looks incorrect?' },
    );

    mockGenerateText.mockImplementation(async (parameters) => {
      const prompt = parameters.prompt.trim();
      if (prompt.startsWith(FILLER_PROMPT_PREFIX)) {
        return {
          text: 'NONE',
          finishReason: 'stop',
          usage: {
            inputTokens: 8,
            outputTokens: 1,
          },
        } as any;
      }

      return {
        text: JSON.stringify({
          intents: [{ category: 'billing', confidence: 0.4, summary: 'billing issue' }],
        }),
        finishReason: 'stop',
        usage: {
          inputTokens: 64,
          outputTokens: 8,
        },
      } as any;
    });

    mockClient.setResponseHandler(() => ({
      text: 'Let me look into that billing issue.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Let me look into that billing issue.' }],
    }));

    const result = await executor.executeMessage(session.id, 'It was charged twice.');

    expect(result.response).toBe('Let me look into that billing issue.');
    expect(getGenerateTextPrompts().some((prompt) => prompt.startsWith(FILLER_PROMPT_PREFIX))).toBe(
      true,
    );
    expect(getClassifierPrompts()).toHaveLength(1);

    const [prompt] = getClassifierPrompts();
    expect(prompt).toContain('Recent conversation context (oldest to newest):');
    expect(prompt).not.toContain('Too old: hello');
    expect(prompt).not.toContain('Too old: hi there');
    expect(prompt).toContain('- user: "I need help with my bill"');
    expect(prompt).toContain('- assistant: "Sure, which charge looks wrong?"');
    expect(prompt).toContain('- user: "The late fee"');
    expect(prompt).toContain('- assistant: "What about the late fee looks incorrect?"');
    expect(prompt).toContain('Current user message: "It was charged twice."');
  });

  it('refreshes the current handoff-child message before classifier prompting on later turns', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([RETURNING_SUPERVISOR], 'SupportSupervisor'),
    );
    executor.registerAgent('BillingChild', BILLING_CHILD);
    session.handoffReturnInfo = { BillingChild: true };
    session.conversationHistory.push({ role: 'user', content: 'I was charged twice.' });

    mockClient.setResponseHandler((systemPrompt, _messages, tools) => {
      if (tools.some((tool: any) => tool.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }

      if (systemPrompt.includes('Billing specialist')) {
        return {
          text: 'Which charge looks incorrect?',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Which charge looks incorrect?' }],
        };
      }

      return {
        text: 'Default response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Default response.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const initialResult = await handleHandoff(
      session,
      { target: 'BillingChild', message: 'I was charged twice.' },
      undefined,
      undefined,
    );

    expect(initialResult.success).toBe(true);
    expect(session.agentName).toBe('BillingChild');

    session.agentIR!.execution = {
      ...(session.agentIR!.execution ?? {}),
      pipeline: createPipelineConfig(),
    } as any;
    session.agentIR!.routing = {
      rules: [{ to: 'FallbackChild', when: 'intent.category == "billing"' }],
      default_agent: 'FallbackChild',
      intent_classification: {
        categories: [{ name: 'billing' }],
        min_confidence: 0.5,
        source: 'explicit',
      },
    } as any;
    session.data.values.input = 'User wants billing help';
    session.data.values._raw_input = 'User wants billing help';

    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(async (parameters) => {
      const prompt = parameters.prompt.trim();
      if (prompt.startsWith(FILLER_PROMPT_PREFIX)) {
        return {
          text: 'NONE',
          finishReason: 'stop',
          usage: {
            inputTokens: 8,
            outputTokens: 1,
          },
        } as any;
      }

      return {
        text: JSON.stringify({
          intents: [{ category: 'billing', confidence: 0.4, summary: 'billing issue' }],
        }),
        finishReason: 'stop',
        usage: {
          inputTokens: 64,
          outputTokens: 8,
        },
      } as any;
    });

    mockClient.setResponseHandler((systemPrompt, _messages, tools) => {
      if (tools.some((tool: any) => tool.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }

      if (systemPrompt.includes('Billing specialist')) {
        return {
          text: 'Let me check that request.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Let me check that request.' }],
        };
      }

      return {
        text: 'Default response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Default response.' }],
      };
    });

    const result = await executor.executeMessage(session.id, "what's my balance?");

    expect(result.response).toBe('Let me check that request.');
    expect(getClassifierPrompts()).toHaveLength(1);
    const [prompt] = getClassifierPrompts();
    expect(prompt).toContain('Current user message: "what\'s my balance?"');
    expect(prompt).not.toContain('Current user message: "User wants billing help"');
    expect(session.data.values.input).toBe("what's my balance?");
    expect(session.data.values._raw_input).toBe("what's my balance?");
  });

  it('prefers stamped current input over raw handoff input when a child pipeline classifier runs', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([RETURNING_SUPERVISOR], 'SupportSupervisor'),
    );
    executor.registerAgent('BillingChild', BILLING_CHILD);
    session.handoffReturnInfo = { BillingChild: true };
    session.conversationHistory.push({ role: 'user', content: 'I was charged twice.' });

    mockClient.setResponseHandler((systemPrompt, _messages, tools) => {
      if (tools.some((tool: any) => tool.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }

      if (systemPrompt.includes('Billing specialist')) {
        return {
          text: 'Which charge looks incorrect?',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Which charge looks incorrect?' }],
        };
      }

      return {
        text: 'Default response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Default response.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const initialResult = await handleHandoff(
      session,
      { target: 'BillingChild', message: 'I was charged twice.' },
      undefined,
      undefined,
    );

    expect(initialResult.success).toBe(true);
    expect(session.agentName).toBe('BillingChild');

    session.agentIR!.execution = {
      ...(session.agentIR!.execution ?? {}),
      pipeline: createPipelineConfig(),
    } as any;
    session.agentIR!.routing = {
      rules: [{ to: 'FallbackChild', when: 'intent.category == "billing"' }],
      default_agent: 'FallbackChild',
      intent_classification: {
        categories: [{ name: 'billing' }],
        min_confidence: 0.5,
        source: 'explicit',
      },
    } as any;
    session.data.values.input = "what's my balance for [REDACTED_EMAIL]?";
    session.data.values._raw_input = "what's my balance for user@example.com?";

    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(async (parameters) => {
      const prompt = parameters.prompt.trim();
      if (prompt.startsWith(FILLER_PROMPT_PREFIX)) {
        return {
          text: 'NONE',
          finishReason: 'stop',
          usage: {
            inputTokens: 8,
            outputTokens: 1,
          },
        } as any;
      }

      return {
        text: JSON.stringify({
          intents: [{ category: 'billing', confidence: 0.4, summary: 'billing issue' }],
        }),
        finishReason: 'stop',
        usage: {
          inputTokens: 64,
          outputTokens: 8,
        },
      } as any;
    });

    mockClient.setResponseHandler((systemPrompt, _messages, tools) => {
      if (tools.some((tool: any) => tool.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }

      if (systemPrompt.includes('Billing specialist')) {
        return {
          text: 'Let me check that request.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Let me check that request.' }],
        };
      }

      return {
        text: 'Default response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Default response.' }],
      };
    });

    const result = await (executor as any).reasoning.execute(
      session,
      buildSystemPrompt(session),
      buildTools(session),
    );

    expect(result.response).toBe('Let me check that request.');
    expect(getClassifierPrompts()).toHaveLength(1);
    const [prompt] = getClassifierPrompts();
    expect(prompt).toContain('Current user message: "what\'s my balance for [REDACTED_EMAIL]?"');
    expect(prompt).not.toContain(
      'Current user message: "what\'s my balance for user@example.com?"',
    );
    expect(session.data.values.input).toBe("what's my balance for [REDACTED_EMAIL]?");
    expect(session.data.values._raw_input).toBe("what's my balance for user@example.com?");
  });

  it('keeps return-to-parent reasoning-owned when classifier is skipped on a RETURN:true child', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([RETURNING_SUPERVISOR], 'SupportSupervisor'),
    );
    executor.registerAgent('BillingChild', BILLING_CHILD);
    session.handoffReturnInfo = { BillingChild: true };
    session.conversationHistory.push({ role: 'user', content: 'I was charged twice.' });

    let digressionTurnTools: unknown[] = [];
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((tool: any) => tool.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }

      if (systemPrompt.includes('Billing specialist')) {
        const lastUserMessage = messages.filter((message) => message.role === 'user').pop();
        const content = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';

        if (content.includes('balance')) {
          digressionTurnTools = tools;
          return {
            text: '',
            toolCalls: [
              {
                id: 'return-1',
                name: SYSTEM_TOOL_RETURN_TO_PARENT,
                input: {
                  reason: 'Balance requests belong with the supervisor',
                  message: "what's my balance?",
                },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'return-1',
                name: SYSTEM_TOOL_RETURN_TO_PARENT,
                input: {
                  reason: 'Balance requests belong with the supervisor',
                  message: "what's my balance?",
                },
              },
            ],
          };
        }

        return {
          text: 'Tell me which charge looks incorrect.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Tell me which charge looks incorrect.' }],
        };
      }

      return {
        text: 'Default response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Default response.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const initialResult = await handleHandoff(
      session,
      { target: 'BillingChild', message: 'I was charged twice.' },
      undefined,
      undefined,
    );

    expect(initialResult.success).toBe(true);
    expect(session.agentName).toBe('BillingChild');

    session.agentIR!.execution = {
      ...(session.agentIR!.execution ?? {}),
      pipeline: createPipelineConfig(),
    } as any;
    session.agentIR!.routing = {
      rules: [],
      default_agent: 'FallbackAgent',
      intent_classification: {
        categories: [{ name: 'billing' }],
        min_confidence: 0.5,
        source: 'explicit',
      },
    } as any;

    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(
      async () =>
        ({
          text: 'NONE',
          finishReason: 'stop',
          usage: {
            inputTokens: 8,
            outputTokens: 1,
          },
        }) as any,
    );

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      "what's my balance?",
      undefined,
      traceCollector.callback,
    );

    expect(result.action?.type).toBe('return_to_parent');
    expect(getGenerateTextPrompts().some((prompt) => prompt.startsWith(FILLER_PROMPT_PREFIX))).toBe(
      true,
    );
    expect(getClassifierPrompts()).toHaveLength(0);
    expect(
      (digressionTurnTools as Array<{ name: string }>).some(
        (tool) => tool.name === SYSTEM_TOOL_RETURN_TO_PARENT,
      ),
    ).toBe(true);
    expect(session.agentName).toBe('SupportSupervisor');
    expect(session.activeThreadIndex).toBe(0);
    expect(session.threads[1].status).toBe('waiting');
    expect(
      session.threads[0].conversationHistory.some(
        (message) => message.role === 'user' && message.content === "what's my balance?",
      ),
    ).toBe(true);
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'return_to_parent',
        data: expect.objectContaining({
          from: 'BillingChild',
          to: 'SupportSupervisor',
          forwardedMessage: "what's my balance?",
        }),
      }),
    );
  });

  it('uses the parent supervisor classifier to reroute scripted digressions on semantic paraphrases', async () => {
    const classifySpy = vi.spyOn(classifierModule, 'classify');
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [RETURNING_BANKING_SUPERVISOR, PAYMENT_FLOW_CHILD, BALANCE_INFO_CHILD],
        'BankingAdvisor',
      ),
    );
    session.handoffReturnInfo = { PaymentFlowChild: true, BalanceInfoChild: true };
    session.conversationHistory.push({ role: 'user', content: 'I need to make a payment.' });
    session.threads[0].llmClient = mockClient as any;
    session.llmClient = mockClient as any;
    configureBankingSupervisorPipeline(session);

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      if (tools.some((tool: any) => tool.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }

      return {
        text: 'Default response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Default response.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const initialResult = await handleHandoff(
      session,
      { target: 'PaymentFlowChild', message: 'I need to make a payment.' },
      undefined,
      undefined,
    );

    expect(initialResult.success).toBe(true);
    expect(session.agentName).toBe('PaymentFlowChild');
    expect(session.waitingForInput).toEqual(['payment_reference']);

    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: 'balance',
            confidence: 0.94,
            summary: 'current balance question',
          },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 24,
        outputTokens: 8,
      },
    } as any);

    const traceCollector = createTraceCollector();
    const result = await executeFlowStepDirectly(
      executor,
      session,
      'How much money do I have available right now?',
      traceCollector.callback,
    );

    expect(result.action?.type).toBe('return_to_parent');
    expect(result.action?.target).toBe('BalanceInfoChild');
    expect(result.action?.detectionMode).toBe('pipeline');
    expect(classifySpy).toHaveBeenCalledTimes(1);
    expect(classifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'pipeline-model' }),
      expect.objectContaining({
        mode: 'gather_scoped',
        userMessage: 'How much money do I have available right now?',
        categories: [
          expect.objectContaining({ name: 'payment' }),
          expect.objectContaining({ name: 'balance' }),
        ],
        candidateSurface: {
          kind: 'parent_supervisor_route',
          size: 2,
          candidates: ['payment', 'balance'],
        },
        agentScope: expect.objectContaining({
          goal: 'Route banking requests',
        }),
        recentConversation: expect.any(Array),
      }),
    );
    expect(
      getClassifierPrompts().some((prompt) =>
        prompt.includes('How much money do I have available right now?'),
      ),
    ).toBe(true);
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'digression',
        data: expect.objectContaining({
          action: 'return_to_parent',
          target: 'BalanceInfoChild',
          detectionMode: 'pipeline',
        }),
      }),
    );
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'return_to_parent',
        data: expect.objectContaining({
          from: 'PaymentFlowChild',
          to: 'BankingAdvisor',
          forwardedMessage: 'How much money do I have available right now?',
        }),
      }),
    );
  });

  it('reroutes fresh follow-up turns before an active RETURN:true reasoning child can answer out of scope', async () => {
    const firstMessage = 'List the contracts expiring in 2026';
    const followUpMessage = 'Can you check for any legal terms in the contract with Zenith?';
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [CONTRACT_TRIAGE_SUPERVISOR, CONTRACT_DATABASE_QUERY_AGENT, CONTRACT_DOCUMENT_SEARCH_AGENT],
        'ContractTriage',
      ),
      {
        tenantId: 'tenant-contract-reroute',
        projectId: 'project-contract-reroute',
      },
    );
    session.handoffReturnInfo = {
      DatabaseQueryAgent: true,
      DocumentSearchAgent: true,
    };
    session.threads[0].llmClient = mockClient as any;
    session.llmClient = mockClient as any;

    const databasePromptCalls: string[] = [];
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      const lastUserMessage = messages.filter((message) => message.role === 'user').pop();
      const userContent =
        typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';

      if (
        systemPrompt.includes('Contract routing supervisor') &&
        userContent.includes('expiring in 2026')
      ) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'handoff-database',
              name: 'handoff_to_DatabaseQueryAgent',
              input: {
                reason: 'Expiry-date questions are structured metadata.',
                message: firstMessage,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'handoff-database',
              name: 'handoff_to_DatabaseQueryAgent',
              input: {
                reason: 'Expiry-date questions are structured metadata.',
                message: firstMessage,
              },
            },
          ],
        };
      }

      if (systemPrompt.includes('Contract metadata specialist')) {
        databasePromptCalls.push(userContent);
        return buildMockChatResponse(
          userContent.includes('legal terms')
            ? 'I do not interpret, summarize, or analyze document content.'
            : 'Contracts expiring in 2026: Zenith Digital ends on 2026-08-12.',
        );
      }

      if (systemPrompt.includes('Contract document search specialist')) {
        return buildMockChatResponse('DocumentSearchAgent handled the legal terms for Zenith.');
      }

      return buildMockChatResponse('Default response.');
    });

    const firstTurn = await executor.executeMessage(session.id, firstMessage);

    expect(firstTurn.action).toMatchObject({
      type: 'handoff',
      target: 'DatabaseQueryAgent',
    });
    expect(firstTurn.response).toContain('Contracts expiring in 2026');
    expect(session.agentName).toBe('DatabaseQueryAgent');
    expect(databasePromptCalls).toEqual([firstMessage]);

    const traceCollector = createTraceCollector();
    const followUpTurn = await executor.executeMessage(
      session.id,
      followUpMessage,
      undefined,
      traceCollector.callback,
    );

    expect(followUpTurn.action).toMatchObject({
      type: 'handoff',
      target: 'DocumentSearchAgent',
    });
    expect(followUpTurn.response).toContain('DocumentSearchAgent handled the legal terms');
    expect(followUpTurn.response).not.toContain('I do not interpret');
    expect(databasePromptCalls).toEqual([firstMessage]);
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'digression',
        data: expect.objectContaining({
          action: 'return_to_parent',
          target: 'DocumentSearchAgent',
          detectionMode: 'lexical',
        }),
      }),
    );
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'return_to_parent',
        data: expect.objectContaining({
          from: 'DatabaseQueryAgent',
          to: 'ContractTriage',
          forwardedMessage: followUpMessage,
        }),
      }),
    );
  });

  it('retries a free-text routing supervisor when it returns no tool for an actionable request', async () => {
    const userMessage = 'find contracts expiring in 2026';
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [
          CONTRACT_TRIAGE_FREE_TEXT_SUPERVISOR,
          CONTRACT_DATABASE_QUERY_AGENT,
          CONTRACT_DOCUMENT_SEARCH_AGENT,
        ],
        'ContractTriage',
      ),
      {
        tenantId: 'tenant-contract-routing-repair',
        projectId: 'project-contract-routing-repair',
      },
    );
    session.threads[0].llmClient = mockClient as any;
    session.llmClient = mockClient as any;

    let supervisorCalls = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      const lastUserMessage = messages.filter((message) => message.role === 'user').pop();
      const userContent =
        typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';

      if (systemPrompt.includes('Contract free-text routing supervisor')) {
        supervisorCalls++;
        expect(tools.some((tool: any) => tool.name === 'handoff_to_DatabaseQueryAgent')).toBe(true);
        if (supervisorCalls === 1) {
          return buildMockChatResponse('This conversation has been completed.');
        }

        expect(systemPrompt).toContain('Routing correction');
        return {
          text: '',
          toolCalls: [
            {
              id: 'handoff-database-retry',
              name: 'handoff_to_DatabaseQueryAgent',
              input: {
                reason: 'Expiry-date questions are structured metadata.',
                message: userMessage,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'handoff-database-retry',
              name: 'handoff_to_DatabaseQueryAgent',
              input: {
                reason: 'Expiry-date questions are structured metadata.',
                message: userMessage,
              },
            },
          ],
        };
      }

      if (systemPrompt.includes('Contract metadata specialist')) {
        expect(userContent).toBe(userMessage);
        return buildMockChatResponse(
          'Contracts expiring in 2026: Zenith Digital ends on 2026-08-12.',
        );
      }

      return buildMockChatResponse('Default response.');
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      userMessage,
      undefined,
      traceCollector.callback,
    );

    expect(supervisorCalls).toBe(2);
    expect(result.action).toMatchObject({ type: 'handoff', target: 'DatabaseQueryAgent' });
    expect(result.response).toContain('Contracts expiring in 2026');
    expect(result.response).not.toContain('This conversation has been completed');
    expect(
      traceCollector.traces.find(
        (trace) =>
          trace.type === 'llm_call' &&
          trace.data.agent === 'ContractTriage' &&
          trace.data.response === 'This conversation has been completed.',
      )?.data,
    ).toMatchObject({
      responseContribution: 'internal_only',
      responseSuppressedReason: 'supervisor_routing_repair',
    });
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'llm_call',
        data: expect.objectContaining({
          agent: 'DatabaseQueryAgent',
          responseContribution: 'customer_visible',
          response: expect.stringContaining('Contracts expiring in 2026'),
        }),
      }),
    );
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'decision',
        data: expect.objectContaining({
          decision: 'supervisor_routing_repair_retry',
          agent: 'ContractTriage',
        }),
      }),
    );
  });

  it('falls back to clarification when a free-text routing supervisor repeats no-tool output', async () => {
    const userMessage = 'find contracts expiring in 2026';
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [
          CONTRACT_TRIAGE_FREE_TEXT_SUPERVISOR,
          CONTRACT_DATABASE_QUERY_AGENT,
          CONTRACT_DOCUMENT_SEARCH_AGENT,
        ],
        'ContractTriage',
      ),
      {
        tenantId: 'tenant-contract-routing-lexical',
        projectId: 'project-contract-routing-lexical',
      },
    );
    session.threads[0].llmClient = mockClient as any;
    session.llmClient = mockClient as any;

    let supervisorCalls = 0;
    mockClient.setResponseHandler((systemPrompt) => {
      if (systemPrompt.includes('Contract free-text routing supervisor')) {
        supervisorCalls++;
        return buildMockChatResponse('This conversation has been completed.');
      }

      return buildMockChatResponse('Default response.');
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      userMessage,
      undefined,
      traceCollector.callback,
    );

    expect(supervisorCalls).toBe(2);
    expect(result.action?.type).not.toBe('handoff');
    expect(result.response).toContain('I need a little more detail to route that.');
    expect(result.response).not.toContain('This conversation has been completed');
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'decision',
        data: expect.objectContaining({
          decision: 'supervisor_routing_clarification_fallback',
          agent: 'ContractTriage',
        }),
      }),
    );
  });

  it('does not auto-reroute scripted gather input when the parent classifier rejects a lexical token match', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [RETURNING_BANKING_SUPERVISOR, PAYMENT_FLOW_CHILD, BALANCE_INFO_CHILD],
        'BankingAdvisor',
      ),
    );
    session.handoffReturnInfo = { PaymentFlowChild: true, BalanceInfoChild: true };
    session.conversationHistory.push({ role: 'user', content: 'I need to make a payment.' });
    session.threads[0].llmClient = mockClient as any;
    session.llmClient = mockClient as any;
    configureBankingSupervisorPipeline(session);

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      if (tools.some((tool: any) => tool.name === '_extract_entities')) {
        return {
          text: JSON.stringify({
            payment_reference: 'balance transfer reference',
          }),
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            { type: 'text', text: '{"payment_reference":"balance transfer reference"}' },
          ],
        };
      }

      return {
        text: 'Default response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Default response.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const initialResult = await handleHandoff(
      session,
      { target: 'PaymentFlowChild', message: 'I need to make a payment.' },
      undefined,
      undefined,
    );

    expect(initialResult.success).toBe(true);
    expect(session.agentName).toBe('PaymentFlowChild');
    expect(session.waitingForInput).toEqual(['payment_reference']);

    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: null,
            confidence: 0.18,
            summary: 'payment reference input',
          },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 24,
        outputTokens: 8,
      },
    } as any);

    const traceCollector = createTraceCollector();
    const result = await executeFlowStepDirectly(
      executor,
      session,
      'balance transfer reference',
      traceCollector.callback,
    );

    expect(result.action?.type).not.toBe('return_to_parent');
    expect(
      getClassifierPrompts().some((prompt) => prompt.includes('balance transfer reference')),
    ).toBe(true);
    expect(session.threads[1].data.values.payment_reference).toBe('balance transfer reference');
    expect(traceCollector.traces.some((event) => event.type === 'return_to_parent')).toBe(false);
  });

  it('uses normalized lexical fallback for parent supervisor gather reroutes when classification is unavailable', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [LOCATION_ROUTING_SUPERVISOR, AUTHENTICATION_FLOW_CHILD, BRANCH_LOCATOR_CHILD],
        'OceanFirstSupervisor',
      ),
    );
    session.handoffReturnInfo = { AuthenticationFlowChild: true, BranchLocatorChild: true };
    session.conversationHistory.push({ role: 'user', content: 'check my balance' });
    session.threads[0].llmClient = mockClient as any;
    session.llmClient = mockClient as any;
    configureLocationSupervisorPipeline(session, { enabled: false });

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      if (tools.some((tool: any) => tool.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }

      return {
        text: 'Default response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Default response.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const initialResult = await handleHandoff(
      session,
      { target: 'AuthenticationFlowChild', message: 'check my balance' },
      undefined,
      undefined,
    );

    expect(initialResult.success).toBe(true);
    expect(session.agentName).toBe('AuthenticationFlowChild');
    expect(session.waitingForInput).toEqual(['phone_id']);

    mockGenerateText.mockReset();
    const traceCollector = createTraceCollector();
    const result = await executeFlowStepDirectly(
      executor,
      session,
      'get atms near me',
      traceCollector.callback,
    );

    expect(result.action?.type).toBe('return_to_parent');
    expect(result.action?.target).toBe('BranchLocatorChild');
    expect(result.action?.detectionMode).toBe('lexical');
    expect(getClassifierPrompts()).toHaveLength(0);
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'digression',
        data: expect.objectContaining({
          intent: 'atm_locator',
          detectionMode: 'lexical',
          lexicalMatchType: 'normalized',
          matched: 'atm',
          policyApplied: 'when_unavailable',
          target: 'BranchLocatorChild',
        }),
      }),
    );
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'return_to_parent',
        data: expect.objectContaining({
          from: 'AuthenticationFlowChild',
          to: 'OceanFirstSupervisor',
          forwardedMessage: 'get atms near me',
        }),
      }),
    );
  });

  it('keeps gather input in the child when the parent classifier rejects a normalized lexical variant', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [LOCATION_ROUTING_SUPERVISOR, AUTHENTICATION_FLOW_CHILD, BRANCH_LOCATOR_CHILD],
        'OceanFirstSupervisor',
      ),
    );
    session.handoffReturnInfo = { AuthenticationFlowChild: true, BranchLocatorChild: true };
    session.conversationHistory.push({ role: 'user', content: 'check my balance' });
    session.threads[0].llmClient = mockClient as any;
    session.llmClient = mockClient as any;
    configureLocationSupervisorPipeline(session);

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      if (tools.some((tool: any) => tool.name === '_extract_entities')) {
        return {
          text: JSON.stringify({
            phone_id: 'get atms near me',
          }),
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{"phone_id":"get atms near me"}' }],
        };
      }

      return {
        text: 'Default response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Default response.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const initialResult = await handleHandoff(
      session,
      { target: 'AuthenticationFlowChild', message: 'check my balance' },
      undefined,
      undefined,
    );

    expect(initialResult.success).toBe(true);
    expect(session.agentName).toBe('AuthenticationFlowChild');
    expect(session.waitingForInput).toEqual(['phone_id']);

    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: null,
            confidence: 0.19,
            summary: 'authentication input',
          },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 22,
        outputTokens: 8,
      },
    } as any);

    const traceCollector = createTraceCollector();
    const result = await executeFlowStepDirectly(
      executor,
      session,
      'get atms near me',
      traceCollector.callback,
    );

    expect(result.action?.type).not.toBe('return_to_parent');
    expect(getClassifierPrompts().some((prompt) => prompt.includes('get atms near me'))).toBe(true);
    expect(session.threads[1].data.values.phone_id).toBe('get atms near me');
    expect(traceCollector.traces.some((event) => event.type === 'digression')).toBe(false);
    expect(traceCollector.traces.some((event) => event.type === 'return_to_parent')).toBe(false);
  });

  it('honors supervisor lexical_fallback: never for gather reroutes', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [STRICT_LOCATION_ROUTING_SUPERVISOR, AUTHENTICATION_FLOW_CHILD, BRANCH_LOCATOR_CHILD],
        'StrictOceanFirstSupervisor',
      ),
    );
    session.handoffReturnInfo = { AuthenticationFlowChild: true, BranchLocatorChild: true };
    session.conversationHistory.push({ role: 'user', content: 'check my balance' });
    session.threads[0].llmClient = mockClient as any;
    session.llmClient = mockClient as any;
    configureLocationSupervisorPipeline(session, { enabled: false });

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      if (tools.some((tool: any) => tool.name === '_extract_entities')) {
        return {
          text: JSON.stringify({
            phone_id: 'get atms near me',
          }),
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{"phone_id":"get atms near me"}' }],
        };
      }

      return {
        text: 'Default response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Default response.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const initialResult = await handleHandoff(
      session,
      { target: 'AuthenticationFlowChild', message: 'check my balance' },
      undefined,
      undefined,
    );

    expect(initialResult.success).toBe(true);
    expect(session.agentName).toBe('AuthenticationFlowChild');
    expect(session.waitingForInput).toEqual(['phone_id']);

    mockGenerateText.mockReset();
    const traceCollector = createTraceCollector();
    const result = await executeFlowStepDirectly(
      executor,
      session,
      'get atms near me',
      traceCollector.callback,
    );

    expect(result.action?.type).not.toBe('return_to_parent');
    expect(getClassifierPrompts()).toHaveLength(0);
    expect(session.threads[1].data.values.phone_id).toBe('get atms near me');
    expect(traceCollector.traces.some((event) => event.type === 'return_to_parent')).toBe(false);
  });

  it('suppresses scripted sibling reroutes when the resolved parent target is not in scope', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([RETURNING_BANKING_SUPERVISOR, PAYMENT_FLOW_CHILD], 'BankingAdvisor'),
    );
    session.handoffReturnInfo = { PaymentFlowChild: true, BalanceInfoChild: true };
    session.conversationHistory.push({ role: 'user', content: 'I need to make a payment.' });
    session.threads[0].llmClient = mockClient as any;
    session.llmClient = mockClient as any;
    configureBankingSupervisorPipeline(session);

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      if (tools.some((tool: any) => tool.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }

      return {
        text: 'Default response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Default response.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const initialResult = await handleHandoff(
      session,
      { target: 'PaymentFlowChild', message: 'I need to make a payment.' },
      undefined,
      undefined,
    );

    expect(initialResult.success).toBe(true);
    expect(session.agentName).toBe('PaymentFlowChild');
    expect(session.waitingForInput).toEqual(['payment_reference']);

    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: 'balance',
            confidence: 0.93,
            summary: 'current balance question',
          },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 24,
        outputTokens: 8,
      },
    } as any);

    const traceCollector = createTraceCollector();
    const result = await executeFlowStepDirectly(
      executor,
      session,
      'What is my current balance?',
      traceCollector.callback,
    );

    expect(result.action?.type).not.toBe('return_to_parent');
    expect(session.agentName).toBe('PaymentFlowChild');
    expect(session.waitingForInput).toEqual(['payment_reference']);
    expect(session.threads[1].data.values.payment_reference).toBeUndefined();
    expect(traceCollector.traces.some((event) => event.type === 'return_to_parent')).toBe(false);
  });

  it('uses the classifier pipeline for semantic global digression paraphrases', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([GLOBAL_FLOW_DIGRESSION_AGENT], 'GlobalFlowDigressionAgent'),
    );
    configureActiveFlowPipeline(session, mockClient);
    configureEchoExtraction(mockClient);
    await executor.initializeSession(session.id);

    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: 'cancel_request',
            confidence: 0.94,
            summary: 'stop the current request',
          },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 18,
        outputTokens: 8,
      },
    } as any);

    const message = 'Please stop this request for now.';
    const chunks: string[] = [];
    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      message,
      (chunk) => chunks.push(chunk),
      traceCollector.callback,
    );

    expect(chunks.join('')).toContain('Cancelling now.');
    expect(getClassifierPrompts().some((prompt) => prompt.includes(message))).toBe(true);
    expect(session.currentFlowStep).toBe('collect_request');
    expect(session.isComplete).not.toBe(true);
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'digression',
        data: expect.objectContaining({
          intent: 'cancel_request',
          detectionMode: 'pipeline',
        }),
      }),
    );
  });

  it('uses the classifier pipeline for semantic sub-intent paraphrases', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUB_INTENT_PIPELINE_AGENT], 'SubIntentPipelineAgent'),
    );
    configureActiveFlowPipeline(session, mockClient);
    configureEchoExtraction(mockClient);
    await executor.initializeSession(session.id);

    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: 'prefer_luxury',
            confidence: 0.92,
            summary: 'user wants the fanciest lodging option',
          },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 20,
        outputTokens: 9,
      },
    } as any);

    const message = 'I want the fanciest room option you have.';
    const chunks: string[] = [];
    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      message,
      (chunk) => chunks.push(chunk),
      traceCollector.callback,
    );

    expect(chunks.join('')).toContain('luxury preference saved');
    expect(getClassifierPrompts().some((prompt) => prompt.includes(message))).toBe(true);
    expect(session.currentFlowStep).toBe('collect_lodging');
    expect(session.data.values.preference).toBe('luxury');
    expect(session.isComplete).not.toBe(true);
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'sub_intent',
        data: expect.objectContaining({
          intent: 'prefer_luxury',
          detectionMode: 'pipeline',
        }),
      }),
    );
  });

  it('does not fall back to lexical step digression matching when the classifier rejects keyword-bearing input', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([STEP_FLOW_DIGRESSION_AGENT], 'StepFlowDigressionAgent'),
    );
    configureActiveFlowPipeline(session, mockClient);
    configureEchoExtraction(mockClient);
    await executor.initializeSession(session.id);

    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: null,
            confidence: 0.14,
            summary: 'plain gather input',
          },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 16,
        outputTokens: 7,
      },
    } as any);

    const message = 'price breakdown request 42';
    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      message,
      undefined,
      traceCollector.callback,
    );

    expect(getClassifierPrompts().some((prompt) => prompt.includes(message))).toBe(true);
    expect(result.action?.type).not.toBe('digression');
    expect(session.data.values.request).toBe(message);
    expect(session.isComplete).toBe(true);
    expect(traceCollector.traces.some((event) => event.type === 'digression')).toBe(false);
  });

  it('falls back to lexical digression matching when the flow pipeline is unavailable', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([GLOBAL_FLOW_DIGRESSION_AGENT], 'GlobalFlowDigressionAgent'),
    );
    configureActiveFlowPipeline(session, mockClient, { enabled: false });
    configureEchoExtraction(mockClient);
    await executor.initializeSession(session.id);

    mockGenerateText.mockReset();
    const chunks: string[] = [];
    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'cancel this request',
      (chunk) => chunks.push(chunk),
      traceCollector.callback,
    );

    expect(chunks.join('')).toContain('Cancelling now.');
    expect(getClassifierPrompts()).toHaveLength(0);
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'digression',
        data: expect.objectContaining({
          intent: 'cancel_request',
          detectionMode: 'lexical',
        }),
      }),
    );
  });

  it('keeps condition-gated digressions in gather when the pipeline match fails the condition', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([GLOBAL_CONDITION_DIGRESSION_AGENT], 'GlobalConditionDigressionAgent'),
    );
    configureActiveFlowPipeline(session, mockClient);
    configureEchoExtraction(mockClient);
    await executor.initializeSession(session.id);
    session.data.values.support_mode = 'disabled';

    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: 'help_request',
            confidence: 0.93,
            summary: 'user is asking for assistance',
          },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 17,
        outputTokens: 8,
      },
    } as any);

    const message = 'I need some assistance with this.';
    const chunks: string[] = [];
    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      message,
      (chunk) => chunks.push(chunk),
      traceCollector.callback,
    );

    expect(chunks.join('')).not.toContain('Support is available.');
    expect(getClassifierPrompts().some((prompt) => prompt.includes(message))).toBe(true);
    expect(session.data.values.request).toBe(message);
    expect(session.isComplete).toBe(true);
    expect(traceCollector.traces.some((event) => event.type === 'digression')).toBe(false);
  });
});
