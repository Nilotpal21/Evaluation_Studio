import { beforeEach, describe, expect, test } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor.js';
import { resolveMultiIntentConfig } from '../services/execution/routing-executor.js';
import { createIntentQueue, enqueueIntents } from '../services/execution/intent-queue.js';

class MockLLMClient {
  calls: Array<{
    systemPrompt: string;
    messages: Array<{ role: string; content: unknown }>;
    tools: unknown[];
    options?: { disableParallelToolUse?: boolean };
  }> = [];

  private responseHandler: (
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    options?: { disableParallelToolUse?: boolean },
  ) => {
    text: string;
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stopReason: string;
    rawContent: Array<{ type: string; [key: string]: unknown }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    resolvedModel?: { modelId: string; provider: string; source: string };
  };

  constructor() {
    this.responseHandler = () => ({
      text: 'Default response.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Default response.' }],
    });
  }

  setResponseHandler(handler: typeof this.responseHandler) {
    this.responseHandler = handler;
  }

  async chatWithToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    options?: { disableParallelToolUse?: boolean },
  ) {
    this.calls.push({ systemPrompt, messages, tools, options });
    return this.responseHandler(systemPrompt, messages, tools, options);
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    _operationType?: string,
    _onChunk?: (chunk: string) => void,
    options?: { disableParallelToolUse?: boolean },
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools, options);
  }
}

function injectMockClient(executor: RuntimeExecutor): MockLLMClient {
  const mock = new MockLLMClient();
  const llmWiring = (executor as { llmWiring: Record<string, unknown> }).llmWiring as {
    wireLLMClient: (session: { llmClient?: unknown }) => Promise<void>;
    ensureSessionLLMClient: (session: { llmClient?: unknown }) => Promise<void>;
  };
  llmWiring.wireLLMClient = async (session: { llmClient?: unknown }) => {
    session.llmClient = mock;
  };
  llmWiring.ensureSessionLLMClient = async (session: { llmClient?: unknown }) => {
    if (!session.llmClient) {
      session.llmClient = mock;
    }
  };
  return mock;
}

const PARENT_AGENT_DSL = `
AGENT: Parent_Agent

GOAL: "Route work to child agents"

PERSONA: "Routing parent"
`;

const NON_COMPLETING_CHILD_DSL = `
AGENT: Child_Agent

GOAL: "Handle a routed request"

PERSONA: "Child specialist"
`;

const MULTI_TOOL_AGENT_DSL = `
AGENT: MultiToolAgent

GOAL: "Run multiple independent tools"

PERSONA: "Helpful assistant"

TOOLS:
  search(query: string) -> { results: array }
    description: "Search for information"

  lookup(id: string) -> { item: object }
    description: "Lookup an item by ID"
`;

const SUPERVISOR_DSL = `
SUPERVISOR: Bank_Supervisor

GOAL: "Route banking requests"

PERSONA: "Banking supervisor"

HANDOFF:
  - TO: Account_Inquiry
    WHEN: intent.category == "balance"
    RETURN: true
`;

const RESPONSE_ONLY_CHILD_DSL = `
AGENT: Account_Inquiry

GOAL: "Answer balance questions"

PERSONA: "Account specialist"
`;

const ROUTING_CHILD_SUPERVISOR_DSL = `
SUPERVISOR: Routing_Bank_Supervisor

GOAL: "Route banking requests"

PERSONA: "Banking supervisor"

HANDOFF:
  - TO: Account_Router
    WHEN: intent.category == "balance"
    RETURN: true
`;

const ROUTING_CHILD_DSL = `
AGENT: Account_Router

GOAL: "Answer balance questions and route transfer requests"

PERSONA: "Routing account specialist"

HANDOFF:
  - TO: Transfer_Specialist
    WHEN: intent.category == "transfer"
`;

const TRANSFER_SPECIALIST_DSL = `
AGENT: Transfer_Specialist

GOAL: "Handle money transfers"

PERSONA: "Transfer specialist"
`;

const LAZY_ON_START_AGENT_DSL = `
AGENT: Lazy_On_Start_Agent

GOAL: "Handle first user messages after startup"

PERSONA: "Helpful assistant"

ON_START:
  set: started = true
  RESPOND: "Welcome! How can I help?"
`;

const LAZY_ON_START_FLOW_AGENT_DSL = `
AGENT: Lazy_On_Start_Flow_Agent

GOAL: "Handle first user messages in a scripted flow after startup"

ON_START:
  set: started = true
  RESPOND: "Welcome! How can I help?"

FLOW:
  entry_point: detect
  steps:
    - detect
    - order
    - fallback

detect:
  REASONING: false
  ON_INPUT:
    - IF: input contains "order"
      THEN: order
    - ELSE:
      THEN: fallback

order:
  REASONING: false
  RESPOND: "Order flow handled."
  THEN: COMPLETE

fallback:
  REASONING: false
  RESPOND: "Fallback flow handled."
  THEN: COMPLETE
`;

const MULTI_INTENT_MULTI_TURN_DSL = `
AGENT: Travel_Helper

GOAL: "Handle booking and cancellation requests"

FLOW:
  entry_point: intro
  steps:
    - intro
    - detect
    - booking
    - cancellation

intro:
  REASONING: false
  RESPOND: "Tell me what you need help with."
  THEN: detect

detect:
  REASONING: false
  ON_INPUT:
    - IF: input contains "book"
      SET: handled_intent = "booking"
      THEN: booking
    - IF: input contains "cancel"
      SET: handled_intent = "cancellation"
      THEN: cancellation
    - ELSE:
      RESPOND: "Please ask me to book or cancel."
      THEN: COMPLETE

booking:
  REASONING: false
  RESPOND: "Booking complete."
  THEN: COMPLETE

cancellation:
  REASONING: false
  RESPOND: "Cancellation complete."
  THEN: COMPLETE
`;

const PROMPTLESS_MULTI_INTENT_DSL = `
AGENT: Support_Scripted_Multi_Intent_Agent

GOAL: "Handle billing, shipping, and cancellation requests in a scripted flow"
PERSONA: "A deterministic support workflow that can queue or disambiguate requests"

FLOW:
  entry_point: detect
  steps:
    - detect
    - billing
    - shipping
    - cancellation

detect:
  REASONING: false
  ON_INPUT:
    - IF: input contains "bill"
      SET: handled_intent = "billing"
      THEN: billing
    - IF: input contains "ship"
      SET: handled_intent = "shipping"
      THEN: shipping
    - IF: input contains "cancel"
      SET: handled_intent = "cancellation"
      THEN: cancellation
    - ELSE:
      RESPOND: "Please ask me about billing, shipping, or cancellation."
      THEN: COMPLETE

billing:
  REASONING: false
  RESPOND: "Billing specialist corrected the invoice."
  THEN: COMPLETE

shipping:
  REASONING: false
  RESPOND: "Shipping specialist confirmed the package is on schedule."
  THEN: COMPLETE

cancellation:
  REASONING: false
  RESPOND: "Cancellation specialist closed the request."
  THEN: COMPLETE
`;

const FLOW_COMPLETING_CHILD_DSL = `
AGENT: Flow_Completer

GOAL: "Answer and complete via flow"

PERSONA: "Flow specialist"

FLOW:
  entry_point: respond
  steps:
    - respond

respond:
  REASONING: false
  RESPOND: "Flow child done."
  THEN: COMPLETE
`;

const FLOW_CHILD_SUPERVISOR_DSL = `
SUPERVISOR: FlowChild_Supervisor

GOAL: "Route requests to flow child"

PERSONA: "Flow child supervisor"

HANDOFF:
  - TO: Flow_Completer
    WHEN: intent.category == "lookup"
    RETURN: true
`;

const NESTED_GRANDPARENT_DSL = `
SUPERVISOR: Grand_Supervisor

GOAL: "Route top-level requests"

PERSONA: "Grand supervisor"

HANDOFF:
  - TO: Mid_Supervisor
    WHEN: intent.category == "research"
    RETURN: true
`;

const NESTED_MID_SUPERVISOR_DSL = `
SUPERVISOR: Mid_Supervisor

GOAL: "Route mid-level requests"

PERSONA: "Mid supervisor"

HANDOFF:
  - TO: Flow_Completer
    WHEN: intent.category == "lookup"
    RETURN: true
`;

const PARALLEL_TOOL_SUPERVISOR_DSL = `
SUPERVISOR: Research_Supervisor

GOAL: "Route research requests"

PERSONA: "Research supervisor"

HANDOFF:
  - TO: Research_Specialist
    RETURN: true
`;

const PARALLEL_TOOL_CHILD_DSL = `
AGENT: Research_Specialist

GOAL: "Use tools to compare options"

PERSONA: "Research specialist"

TOOLS:
  search(query: string) -> { results: array }
    description: "Search for options"

  lookup(id: string) -> { item: object }
    description: "Lookup a specific option"
`;

const MULTI_ROUTE_SUPERVISOR_DSL = `
SUPERVISOR: Multi_Route_Supervisor

GOAL: "Route billing and shipping requests"

PERSONA: "Routing supervisor"

HANDOFF:
  - TO: Billing_Agent
    RETURN: true

  - TO: Shipping_Agent
    RETURN: true
`;

const BILLING_CHILD_DSL = `
AGENT: Billing_Agent

GOAL: "Handle billing requests"

PERSONA: "Billing specialist"
`;

const SHIPPING_CHILD_DSL = `
AGENT: Shipping_Agent

GOAL: "Handle shipping requests"

PERSONA: "Shipping specialist"
`;

function buildProjectRuntimeConfig(strategy: 'parallel' | 'auto' | 'primary_queue') {
  return {
    extraction_strategy: 'auto' as const,
    multi_intent: {
      enabled: true,
      strategy,
      max_intents: 3,
      confidence_threshold: 0.6,
      queue_max_age_ms: 300_000,
    },
    inference: {
      confidence: 0.8,
      confirm: true,
      model_tier: 'fast' as const,
      max_fields_per_pass: 3,
    },
    conversion: { currency_mode: 'static' as const },
    lookup_tables: [],
  };
}

function applyProjectRuntimeConfig(
  session: ReturnType<RuntimeExecutor['createSessionFromResolved']>,
  strategy: 'parallel' | 'auto' | 'primary_queue',
): void {
  const projectRuntimeConfig = buildProjectRuntimeConfig(strategy);
  session._projectRuntimeConfig = projectRuntimeConfig;
  if (session.agentIR) {
    session.agentIR.project_runtime_config = projectRuntimeConfig;
  }
}

describe('Reported runtime regressions', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockLLMClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  test('lazy ON_START setup does not consume the first inbound user message', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([LAZY_ON_START_AGENT_DSL], 'Lazy_On_Start_Agent'),
    );

    mockClient.setResponseHandler((_systemPrompt, messages) => {
      const sawFirstMessage = messages.some((message) =>
        JSON.stringify(message.content).includes('Where is my order'),
      );
      const text = sawFirstMessage ? 'I can help with that order.' : 'Wrong turn.';

      return {
        text,
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text }],
      };
    });

    const chunks: string[] = [];
    const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await executor.executeMessage(
      session.id,
      'Where is my order?',
      (chunk) => chunks.push(chunk),
      (event) => traces.push(event),
    );

    expect(result.response).toBe('I can help with that order.');
    expect(chunks.join('')).not.toContain('Welcome');
    expect(session.data.values.started).toBe(true);
    expect(mockClient.calls).toHaveLength(1);
    expect(
      session.conversationHistory.some(
        (entry) => entry.role === 'assistant' && String(entry.content).includes('Welcome'),
      ),
    ).toBe(false);
    expect(
      traces.some(
        (event) =>
          event.type === 'engine_decision' &&
          event.data.decision === 'lazy_on_start_response_suppressed',
      ),
    ).toBe(true);
  });

  test('lazy ON_START setup does not execute a flow entry step with empty input', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([LAZY_ON_START_FLOW_AGENT_DSL], 'Lazy_On_Start_Flow_Agent'),
    );

    const chunks: string[] = [];

    const result = await executor.executeMessage(session.id, 'I need order help', (chunk) =>
      chunks.push(chunk),
    );

    expect(result.response).toBe('Order flow handled.');
    expect(chunks.join('')).not.toContain('Welcome');
    expect(result.response).not.toBe('Fallback flow handled.');
    expect(session.data.values.started).toBe(true);
    expect(session.currentFlowStep).not.toBe('detect');
    expect(session.data.values.input).toContain('order');
  });

  test('multi-intent project config survives a real handoff IR switch', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([PARENT_AGENT_DSL], 'Parent_Agent'),
    );

    const projectRuntimeConfig = {
      extraction_strategy: 'auto' as const,
      multi_intent: {
        enabled: true,
        strategy: 'parallel' as const,
        max_intents: 4,
        confidence_threshold: 0.55,
        queue_max_age_ms: 300_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast' as const,
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' as const },
      lookup_tables: [],
    };

    session._projectRuntimeConfig = projectRuntimeConfig;
    if (session.agentIR) {
      session.agentIR.project_runtime_config = projectRuntimeConfig;
    }

    const childResolved = compileToResolvedAgent([NON_COMPLETING_CHILD_DSL], 'Child_Agent');
    session.agentIR = childResolved.agents[childResolved.entryAgent];
    session.agentName = childResolved.entryAgent;
    if (session._projectRuntimeConfig && session.agentIR) {
      session.agentIR.project_runtime_config = session._projectRuntimeConfig;
    }

    expect(session.agentIR?.project_runtime_config).toEqual(projectRuntimeConfig);

    const multiIntentConfig = resolveMultiIntentConfig(session.agentIR!);
    expect(multiIntentConfig.enabled).toBe(true);
    expect(multiIntentConfig.strategy).toBe('parallel');
    expect(multiIntentConfig.max_intents).toBe(4);
  });

  test.each(['parallel', 'auto'] as const)(
    'supervisor %s multi-intent strategy allows parallel routing tool calls',
    async (strategy) => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [MULTI_ROUTE_SUPERVISOR_DSL, BILLING_CHILD_DSL, SHIPPING_CHILD_DSL],
          'Multi_Route_Supervisor',
        ),
      );

      applyProjectRuntimeConfig(session, strategy);

      mockClient.setResponseHandler(() => ({
        text: 'Routing complete.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Routing complete.' }],
      }));

      await executor.executeMessage(session.id, 'Help with billing and shipping.');

      expect(mockClient.calls[0]?.options?.disableParallelToolUse).not.toBe(true);
    },
  );

  test('non-parallel supervisor strategy blocks fan-out batching even if provider returns parallel handoffs', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [MULTI_ROUTE_SUPERVISOR_DSL, BILLING_CHILD_DSL, SHIPPING_CHILD_DSL],
        'Multi_Route_Supervisor',
      ),
    );

    applyProjectRuntimeConfig(session, 'primary_queue');
    executor.registerAgent('Billing_Agent', BILLING_CHILD_DSL);
    executor.registerAgent('Shipping_Agent', SHIPPING_CHILD_DSL);

    mockClient.setResponseHandler((systemPrompt) => {
      if (systemPrompt.includes('Routing supervisor')) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'billing-handoff',
              name: 'handoff_to_Billing_Agent',
              input: { reason: 'billing request', message: 'Help with billing.' },
            },
            {
              id: 'shipping-handoff',
              name: 'handoff_to_Shipping_Agent',
              input: { reason: 'shipping request', message: 'Help with shipping.' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'billing-handoff',
              name: 'handoff_to_Billing_Agent',
              input: { reason: 'billing request', message: 'Help with billing.' },
            },
            {
              type: 'tool_use',
              id: 'shipping-handoff',
              name: 'handoff_to_Shipping_Agent',
              input: { reason: 'shipping request', message: 'Help with shipping.' },
            },
          ],
        };
      }

      if (systemPrompt.includes('Billing specialist')) {
        return {
          text: 'Billing handled.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Billing handled.' }],
        };
      }

      if (systemPrompt.includes('Shipping specialist')) {
        return {
          text: 'Shipping handled.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Shipping handled.' }],
        };
      }

      return {
        text: 'Unhandled route.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Unhandled route.' }],
      };
    });

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = await executor.executeMessage(
      session.id,
      'Help with billing and shipping.',
      undefined,
      (event) => traceEvents.push(event),
    );

    expect(mockClient.calls[0]?.options?.disableParallelToolUse).toBe(true);
    expect(result.response).toBe('Billing handled.');
    expect(
      traceEvents.some(
        (event) =>
          event.type === 'decision' &&
          event.data.decision === 'parallel_handoffs_blocked_by_strategy',
      ),
    ).toBe(true);
    expect(
      traceEvents.some(
        (event) =>
          event.type === 'decision' && event.data.decision === 'parallel_handoffs_to_fan_out',
      ),
    ).toBe(false);
  });

  test('parallel supervisor strategy converts parallel routing calls into fan-out synthesis', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [MULTI_ROUTE_SUPERVISOR_DSL, BILLING_CHILD_DSL, SHIPPING_CHILD_DSL],
        'Multi_Route_Supervisor',
      ),
    );

    applyProjectRuntimeConfig(session, 'parallel');
    executor.registerAgent('Billing_Agent', BILLING_CHILD_DSL);
    executor.registerAgent('Shipping_Agent', SHIPPING_CHILD_DSL);

    mockClient.setResponseHandler((systemPrompt, messages) => {
      if (systemPrompt.includes('Routing supervisor')) {
        const hasToolResults = messages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some(
              (block) =>
                typeof block === 'object' &&
                block !== null &&
                'type' in block &&
                block.type === 'tool_result',
            ),
        );

        if (!hasToolResults) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'billing-handoff',
                name: 'handoff_to_Billing_Agent',
                input: { reason: 'billing request', message: 'Help with billing.' },
              },
              {
                id: 'shipping-handoff',
                name: 'handoff_to_Shipping_Agent',
                input: { reason: 'shipping request', message: 'Help with shipping.' },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'billing-handoff',
                name: 'handoff_to_Billing_Agent',
                input: { reason: 'billing request', message: 'Help with billing.' },
              },
              {
                type: 'tool_use',
                id: 'shipping-handoff',
                name: 'handoff_to_Shipping_Agent',
                input: { reason: 'shipping request', message: 'Help with shipping.' },
              },
            ],
          };
        }

        return {
          text: 'Billing handled. Shipping handled.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Billing handled. Shipping handled.' }],
        };
      }

      if (systemPrompt.includes('Billing specialist')) {
        return {
          text: 'Billing handled.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Billing handled.' }],
        };
      }

      if (systemPrompt.includes('Shipping specialist')) {
        return {
          text: 'Shipping handled.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Shipping handled.' }],
        };
      }

      return {
        text: 'Unhandled route.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Unhandled route.' }],
      };
    });

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = await executor.executeMessage(
      session.id,
      'Help with billing and shipping.',
      undefined,
      (event) => traceEvents.push(event),
    );

    expect(mockClient.calls[0]?.options?.disableParallelToolUse).not.toBe(true);
    expect(result.response).toContain('Billing handled.');
    expect(result.response).toContain('Shipping handled.');
    expect(
      traceEvents.some(
        (event) =>
          event.type === 'decision' && event.data.decision === 'parallel_handoffs_to_fan_out',
      ),
    ).toBe(true);
  });

  test('multi-intent queued confirmation reroutes the accepted intent on the next turn', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_INTENT_MULTI_TURN_DSL], 'Travel_Helper'),
    );

    const projectRuntimeConfig = {
      extraction_strategy: 'auto' as const,
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue' as const,
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 300_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast' as const,
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' as const },
      lookup_tables: [],
    };

    session._projectRuntimeConfig = projectRuntimeConfig;
    if (session.agentIR) {
      session.agentIR.project_runtime_config = projectRuntimeConfig;
    }

    await executor.initializeSession(session.id);
    expect(session.currentFlowStep).toBe('detect');
    expect(session.waitingForInput).toBeUndefined();

    session.intentQueue = createIntentQueue();
    enqueueIntents(session.intentQueue, [
      {
        intent: 'cancellation',
        confidence: 0.82,
        original_message: 'Please book my condo and cancel my old reservation.',
      },
    ]);
    session.waitingForInput = ['_queued_intent_confirmation_'];
    session.isComplete = true;

    const secondTurnChunks: string[] = [];
    const secondTurnTraces: Array<{ type: string; data: Record<string, unknown> }> = [];
    const secondTurn = await executor.executeMessage(
      session.id,
      'yes',
      (chunk) => secondTurnChunks.push(chunk),
      (event) => secondTurnTraces.push(event),
    );

    const secondOutput = secondTurnChunks.join('');
    const secondVisibleText = secondOutput || secondTurn.response;
    expect(secondVisibleText).toContain('Cancellation complete.');
    expect(session.data.values.handled_intent).toBe('cancellation');
    expect(session.waitingForInput).toBeUndefined();
    expect(session.intentQueue?.pending ?? []).toHaveLength(0);
    expect(session._pinnedIntent).toBeUndefined();
    expect(secondTurnTraces.some((event) => event.type === 'multi_intent_queue_accepted')).toBe(
      true,
    );
  });

  test('prompt-less primary_queue follow-up replays from the original ON_INPUT step after completion', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([PROMPTLESS_MULTI_INTENT_DSL], 'Support_Scripted_Multi_Intent_Agent'),
    );

    const projectRuntimeConfig = {
      extraction_strategy: 'auto' as const,
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue' as const,
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 300_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast' as const,
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' as const },
      lookup_tables: [],
    };

    session._projectRuntimeConfig = projectRuntimeConfig;
    if (session.agentIR) {
      session.agentIR.project_runtime_config = projectRuntimeConfig;
    }

    await executor.initializeSession(session.id);

    const firstTurn = await executor.executeMessage(
      session.id,
      'Please fix my bill and also check the shipment.',
    );

    expect(firstTurn.response).toContain('Billing specialist corrected the invoice.');
    expect(firstTurn.response).toContain('Next: shipping.');
    expect(session.currentFlowStep).toBe('COMPLETE');

    const secondTurnTraces: Array<{ type: string; data: Record<string, unknown> }> = [];
    const secondTurn = await executor.executeMessage(session.id, 'yes', undefined, (event) =>
      secondTurnTraces.push(event),
    );

    expect(secondTurn.response).toContain(
      'Shipping specialist confirmed the package is on schedule.',
    );
    expect(secondTurn.response).not.toContain('This conversation has been completed.');
    expect(session.data.values.handled_intent).toBe('shipping');
    expect(secondTurnTraces.some((event) => event.type === 'multi_intent_queue_accepted')).toBe(
      true,
    );
  });

  test('prompt-less disambiguation choice executes the selected ON_INPUT branch directly', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([PROMPTLESS_MULTI_INTENT_DSL], 'Support_Scripted_Multi_Intent_Agent'),
    );

    const projectRuntimeConfig = {
      extraction_strategy: 'auto' as const,
      multi_intent: {
        enabled: true,
        strategy: 'disambiguate' as const,
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 300_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast' as const,
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' as const },
      lookup_tables: [],
    };

    session._projectRuntimeConfig = projectRuntimeConfig;
    if (session.agentIR) {
      session.agentIR.project_runtime_config = projectRuntimeConfig;
    }

    await executor.initializeSession(session.id);

    const firstTurn = await executor.executeMessage(
      session.id,
      'Please fix my bill and also check the shipment.',
    );

    expect(firstTurn.response).toContain('I noticed your message may contain multiple requests.');
    expect(firstTurn.response).toContain('1. billing');
    expect(firstTurn.response).toContain('2. shipping');
    expect(session.currentFlowStep).toBe('detect');

    const secondTurnTraces: Array<{ type: string; data: Record<string, unknown> }> = [];
    const secondTurn = await executor.executeMessage(session.id, '2', undefined, (event) =>
      secondTurnTraces.push(event),
    );

    expect(secondTurn.response).toContain(
      'Shipping specialist confirmed the package is on schedule.',
    );
    expect(session.data.values.handled_intent).toBe('shipping');
    expect(
      secondTurnTraces.some((event) => event.type === 'multi_intent_disambiguate_choice'),
    ).toBe(true);
  });

  test('parallel tool execution uses the real reasoning loop and overlaps regular tools', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_TOOL_AGENT_DSL], 'MultiToolAgent'),
    );

    const executionOrder: string[] = [];
    const startTimes = new Map<string, number>();
    const endTimes = new Map<string, number>();

    session.toolExecutor = {
      execute: async (name: string, _input: Record<string, unknown>, _timeoutMs?: number) => {
        executionOrder.push(`${name}-start`);
        startTimes.set(name, Date.now());
        await new Promise((resolve) => setTimeout(resolve, 120));
        endTimes.set(name, Date.now());
        executionOrder.push(`${name}-end`);

        if (name === 'search') {
          return { results: ['boardwalk result'] };
        }
        if (name === 'lookup') {
          return { item: { id: 'prop-123' } };
        }
        return {};
      },
    } as typeof session.toolExecutor;

    mockClient.setResponseHandler((_systemPrompt, messages) => {
      const hasToolResults = messages.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some(
            (block) =>
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'tool_result',
          ),
      );

      if (!hasToolResults) {
        return {
          text: '',
          toolCalls: [
            { id: 'tool-search', name: 'search', input: { query: 'boardwalk rentals' } },
            { id: 'tool-lookup', name: 'lookup', input: { id: 'prop-123' } },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'tool-search',
              name: 'search',
              input: { query: 'boardwalk rentals' },
            },
            {
              type: 'tool_use',
              id: 'tool-lookup',
              name: 'lookup',
              input: { id: 'prop-123' },
            },
          ],
        };
      }

      return {
        text: 'Search and lookup complete.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Search and lookup complete.' }],
      };
    });

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await executor.executeMessage(
      session.id,
      'Find boardwalk rentals and lookup prop-123.',
      undefined,
      (event) => traceEvents.push(event),
    );

    expect(result.response).toBe('Search and lookup complete.');
    expect(executionOrder).toContain('search-start');
    expect(executionOrder).toContain('lookup-start');

    const firstEndIndex = executionOrder.findIndex((step) => step.endsWith('-end'));
    expect(firstEndIndex).toBeGreaterThanOrEqual(2);

    const overlapMs =
      Math.min(endTimes.get('search')!, endTimes.get('lookup')!) -
      Math.max(startTimes.get('search')!, startTimes.get('lookup')!);
    expect(overlapMs).toBeGreaterThan(0);

    const toolCallTraces = traceEvents.filter((event) => event.type === 'tool_call');
    expect(toolCallTraces).toHaveLength(2);
  });

  test('RETURN: true child can run parallel tools across repeated handoff turns and restore the parent each time', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [PARALLEL_TOOL_SUPERVISOR_DSL, PARALLEL_TOOL_CHILD_DSL],
        'Research_Supervisor',
      ),
    );

    session.handoffReturnInfo = { Research_Specialist: true };

    const executionOrder: string[] = [];
    const startTimes = new Map<string, number>();
    const endTimes = new Map<string, number>();

    session.toolExecutor = {
      execute: async (name: string, input: Record<string, unknown>, _timeoutMs?: number) => {
        const roundLabel =
          name === 'search'
            ? String(input.query).match(/round-(\d+)/)?.[1]
            : String(input.id).match(/round-(\d+)/)?.[1];
        const label = `${name}-${roundLabel ?? 'unknown'}`;
        executionOrder.push(`${label}-start`);
        startTimes.set(label, Date.now());
        await new Promise((resolve) => setTimeout(resolve, 120));
        endTimes.set(label, Date.now());
        executionOrder.push(`${label}-end`);

        if (name === 'search') {
          return { results: [`result-${roundLabel}`] };
        }
        if (name === 'lookup') {
          return { item: { id: `item-${roundLabel}` } };
        }
        return {};
      },
    } as typeof session.toolExecutor;

    let researchRound = 0;
    mockClient.setResponseHandler((systemPrompt, messages) => {
      if (!systemPrompt.includes('Research specialist')) {
        return {
          text: 'Supervisor response.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Supervisor response.' }],
        };
      }

      const hasToolResults = messages.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some(
            (block) =>
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'tool_result',
          ),
      );

      if (!hasToolResults) {
        researchRound += 1;
        return {
          text: '',
          toolCalls: [
            {
              id: `tool-search-${researchRound}`,
              name: 'search',
              input: { query: `round-${researchRound} availability` },
            },
            {
              id: `tool-lookup-${researchRound}`,
              name: 'lookup',
              input: { id: `prop-round-${researchRound}` },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: `tool-search-${researchRound}`,
              name: 'search',
              input: { query: `round-${researchRound} availability` },
            },
            {
              type: 'tool_use',
              id: `tool-lookup-${researchRound}`,
              name: 'lookup',
              input: { id: `prop-round-${researchRound}` },
            },
          ],
        };
      }

      return {
        text: '',
        toolCalls: [
          {
            id: `tool-complete-${researchRound}`,
            name: '__complete__',
            input: { message: `Research round ${researchRound} complete.` },
          },
        ],
        stopReason: 'tool_use',
        rawContent: [
          {
            type: 'tool_use',
            id: `tool-complete-${researchRound}`,
            name: '__complete__',
            input: { message: `Research round ${researchRound} complete.` },
          },
        ],
      };
    });

    const handleHandoff = (
      executor as unknown as {
        routing: {
          handleHandoff: (
            sessionArg: typeof session,
            input: { target: string; message: string },
          ) => Promise<{ success: boolean; response?: string }>;
        };
      }
    ).routing.handleHandoff.bind((executor as unknown as { routing: unknown }).routing);

    session.conversationHistory.push({ role: 'user', content: 'Compare round one options.' });
    const firstTurn = await handleHandoff(session, {
      target: 'Research_Specialist',
      message: 'Compare round one options.',
    });

    expect(firstTurn.success).toBe(true);
    expect(firstTurn.response).toBe('Research round 1 complete.');
    expect(session.agentName).toBe('Research_Supervisor');
    expect(session.activeThreadIndex).toBe(0);

    session.conversationHistory.push({ role: 'user', content: 'Compare round two options.' });
    const secondTurn = await handleHandoff(session, {
      target: 'Research_Specialist',
      message: 'Compare round two options.',
    });

    expect(secondTurn.success).toBe(true);
    expect(secondTurn.response).toBe('Research round 2 complete.');
    expect(session.agentName).toBe('Research_Supervisor');
    expect(session.activeThreadIndex).toBe(0);

    for (const round of ['1', '2']) {
      const searchLabel = `search-${round}`;
      const lookupLabel = `lookup-${round}`;
      expect(executionOrder).toContain(`${searchLabel}-start`);
      expect(executionOrder).toContain(`${lookupLabel}-start`);

      const overlapMs =
        Math.min(endTimes.get(searchLabel)!, endTimes.get(lookupLabel)!) -
        Math.max(startTimes.get(searchLabel)!, startTimes.get(lookupLabel)!);
      expect(overlapMs).toBeGreaterThan(0);

      const firstRoundEndIndex = Math.min(
        executionOrder.indexOf(`${searchLabel}-end`),
        executionOrder.indexOf(`${lookupLabel}-end`),
      );
      expect(executionOrder.indexOf(`${searchLabel}-start`)).toBeLessThan(firstRoundEndIndex);
      expect(executionOrder.indexOf(`${lookupLabel}-start`)).toBeLessThan(firstRoundEndIndex);
    }
  });

  test('RETURN: true child control returns to the supervisor after a plain response turn', async () => {
    executor.registerAgent('Account_Inquiry', RESPONSE_ONLY_CHILD_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL, RESPONSE_ONLY_CHILD_DSL], 'Bank_Supervisor'),
    );

    session.handoffReturnInfo = { Account_Inquiry: true };
    session.conversationHistory.push({ role: 'user', content: 'Check my balance.' });

    mockClient.setResponseHandler((systemPrompt) => {
      if (systemPrompt.includes('Account specialist')) {
        return {
          text: 'Your balance is $5,000.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Your balance is $5,000.' }],
        };
      }

      return {
        text: 'How can I help you today?',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'How can I help you today?' }],
      };
    });

    const handleHandoff = (
      executor as unknown as {
        routing: {
          handleHandoff: (
            sessionArg: typeof session,
            input: { target: string; message: string },
          ) => Promise<{ success: boolean; response?: string }>;
        };
      }
    ).routing.handleHandoff.bind((executor as unknown as { routing: unknown }).routing);

    const result = await handleHandoff(session, {
      target: 'Account_Inquiry',
      message: 'Check my balance.',
    });

    expect(result.response).toBe('Your balance is $5,000.');
    expect(session.agentName).toBe('Bank_Supervisor');
    expect(session.activeThreadIndex).toBe(0);

    const childThread = session.threads.find((thread) => thread.agentName === 'Account_Inquiry');
    expect(childThread?.status).toBe('completed');
  });

  test('RETURN: true child with compiler-injected routing tools stays active after a plain response turn', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [ROUTING_CHILD_SUPERVISOR_DSL, ROUTING_CHILD_DSL, TRANSFER_SPECIALIST_DSL],
        'Routing_Bank_Supervisor',
      ),
    );

    session.handoffReturnInfo = { Account_Router: true };
    session.conversationHistory.push({ role: 'user', content: 'Check my balance.' });

    mockClient.setResponseHandler((systemPrompt, _messages, tools) => {
      if (systemPrompt.includes('Routing account specialist')) {
        const toolNames = (tools as Array<{ name?: string }>).map((tool) => tool.name);
        expect(toolNames).toContain('handoff_to_Transfer_Specialist');

        return {
          text: 'Your balance is $5,000.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Your balance is $5,000.' }],
        };
      }

      return {
        text: 'How can I help you today?',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'How can I help you today?' }],
      };
    });

    const handleHandoff = (
      executor as unknown as {
        routing: {
          handleHandoff: (
            sessionArg: typeof session,
            input: { target: string; message: string },
          ) => Promise<{ success: boolean; response?: string }>;
        };
      }
    ).routing.handleHandoff.bind((executor as unknown as { routing: unknown }).routing);

    const result = await handleHandoff(session, {
      target: 'Account_Router',
      message: 'Check my balance.',
    });

    expect(result.response).toBe('Your balance is $5,000.');
    expect(session.agentName).toBe('Account_Router');
    expect(session.activeThreadIndex).not.toBe(0);

    const childThread = session.threads.find((thread) => thread.agentName === 'Account_Router');
    expect(childThread?.status).toBe('active');
    expect(childThread?.agentIR?.tools?.some((tool) => tool.name === '__handoff__')).toBe(true);

    const childToolNames = (
      mockClient.calls.at(-1)?.tools as Array<{ name?: string }> | undefined
    )?.map((tool) => tool.name);
    expect(childToolNames).toContain('handoff_to_Transfer_Specialist');
  });

  test('multi-intent queued confirmation decline removes the front intent and completes', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_INTENT_MULTI_TURN_DSL], 'Travel_Helper'),
    );

    const projectRuntimeConfig = {
      extraction_strategy: 'auto' as const,
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue' as const,
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 300_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast' as const,
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' as const },
      lookup_tables: [],
    };

    session._projectRuntimeConfig = projectRuntimeConfig;
    if (session.agentIR) {
      session.agentIR.project_runtime_config = projectRuntimeConfig;
    }

    await executor.initializeSession(session.id);

    session.intentQueue = createIntentQueue();
    enqueueIntents(session.intentQueue, [
      {
        intent: 'cancellation',
        confidence: 0.82,
        original_message: 'Please book my condo and cancel my old reservation.',
      },
    ]);
    session.waitingForInput = ['_queued_intent_confirmation_'];
    session.isComplete = true;

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = await executor.executeMessage(session.id, 'no thanks', undefined, (event) =>
      traceEvents.push(event),
    );

    // The decline path should clear the queued intent and NOT short-circuit
    // with "conversation complete" — it should emit a decline trace event
    expect(traceEvents.some((event) => event.type === 'multi_intent_queue_declined')).toBe(true);
    expect(session.waitingForInput).toBeUndefined();
    expect(session.intentQueue?.pending ?? []).toHaveLength(0);
    // Should NOT return the "Session already complete" canned response
    expect(result.action?.message).not.toBe('Session already complete');
  });

  test('multi-intent decline with remaining intents surfaces the next one', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_INTENT_MULTI_TURN_DSL], 'Travel_Helper'),
    );

    const projectRuntimeConfig = {
      extraction_strategy: 'auto' as const,
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue' as const,
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 300_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast' as const,
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' as const },
      lookup_tables: [],
    };

    session._projectRuntimeConfig = projectRuntimeConfig;
    if (session.agentIR) {
      session.agentIR.project_runtime_config = projectRuntimeConfig;
    }

    await executor.initializeSession(session.id);

    // Enqueue two intents — decline the first, second should be surfaced
    session.intentQueue = createIntentQueue();
    enqueueIntents(session.intentQueue, [
      {
        intent: 'cancellation',
        confidence: 0.9,
        original_message: 'Book, cancel, and reschedule.',
      },
      {
        intent: 'booking',
        confidence: 0.85,
        original_message: 'Book, cancel, and reschedule.',
      },
    ]);
    session.waitingForInput = ['_queued_intent_confirmation_'];
    session.isComplete = true;

    const chunks: string[] = [];
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    await executor.executeMessage(
      session.id,
      'no',
      (chunk) => chunks.push(chunk),
      (event) => traceEvents.push(event),
    );

    // First intent declined
    expect(traceEvents.some((event) => event.type === 'multi_intent_queue_declined')).toBe(true);

    // Second intent should be surfaced — waitingForInput set again
    expect(session.waitingForInput).toEqual(['_queued_intent_confirmation_']);
    expect(session.intentQueue?.pending ?? []).toHaveLength(1);
    expect(session.intentQueue?.pending[0]?.intent).toBe('booking');

    // The surfaced notice should mention the next intent
    const output = chunks.join('');
    expect(output).toContain('booking');
    expect(output).toContain('Would you like me to help with that?');
  });

  test('isComplete=true without queued intent confirmation short-circuits normally', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_INTENT_MULTI_TURN_DSL], 'Travel_Helper'),
    );

    await executor.initializeSession(session.id);

    // Simulate a normally completed session — no queued intents
    session.isComplete = true;
    session.waitingForInput = undefined;

    const result = await executor.executeMessage(session.id, 'hello again');

    // Should get the standard "conversation complete" short-circuit
    expect(result.action?.type).toBe('complete');
    expect(result.action?.message).toBe('Session already complete');
  });

  test('isComplete=true with _queued_intent_confirmation_ but empty queue falls through gracefully', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_INTENT_MULTI_TURN_DSL], 'Travel_Helper'),
    );

    await executor.initializeSession(session.id);

    // Edge case: waitingForInput is set but the queue was emptied (e.g., by pruneExpired)
    session.isComplete = true;
    session.waitingForInput = ['_queued_intent_confirmation_'];
    session.intentQueue = createIntentQueue(); // empty queue

    const result = await executor.executeMessage(session.id, 'yes');

    // With empty queue AND isComplete=true, the queued intent handler's guard
    // (!session.intentQueue?.pending?.length) is false, so it should fall
    // through to the isComplete guard and return the completion message
    expect(result.action?.type).toBe('complete');
  });

  test('RETURN: false child with plain text does NOT return to supervisor', async () => {
    executor.registerAgent('Account_Inquiry', RESPONSE_ONLY_CHILD_DSL);

    const noReturnSupervisorDsl = `
SUPERVISOR: NoReturn_Supervisor

GOAL: "Route banking requests"

PERSONA: "Banking supervisor"

HANDOFF:
  - TO: Account_Inquiry
    WHEN: intent.category == "balance"
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [noReturnSupervisorDsl, RESPONSE_ONLY_CHILD_DSL],
        'NoReturn_Supervisor',
      ),
    );

    // Explicitly NOT setting RETURN: true
    session.handoffReturnInfo = { Account_Inquiry: false };
    session.conversationHistory.push({ role: 'user', content: 'Check my balance.' });

    mockClient.setResponseHandler((systemPrompt) => {
      if (systemPrompt.includes('Account specialist')) {
        return {
          text: 'Your balance is $5,000.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Your balance is $5,000.' }],
        };
      }
      return {
        text: 'How can I help you today?',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'How can I help you today?' }],
      };
    });

    const handleHandoff = (
      executor as unknown as {
        routing: {
          handleHandoff: (
            sessionArg: typeof session,
            input: { target: string; message: string },
          ) => Promise<{ success: boolean; response?: string }>;
        };
      }
    ).routing.handleHandoff.bind((executor as unknown as { routing: unknown }).routing);

    const result = await handleHandoff(session, {
      target: 'Account_Inquiry',
      message: 'Check my balance.',
    });

    expect(result.response).toBe('Your balance is $5,000.');
    // Should stay on the child — no return expected
    expect(session.agentName).toBe('Account_Inquiry');
    // Parent thread should not be reactivated
    expect(session.activeThreadIndex).not.toBe(0);
  });

  test('sequential RETURN: true handoffs to different children each return independently', async () => {
    const secondChildDsl = `
AGENT: Loan_Inquiry

GOAL: "Answer loan questions"

PERSONA: "Loan specialist"
`;

    executor.registerAgent('Account_Inquiry', RESPONSE_ONLY_CHILD_DSL);
    executor.registerAgent('Loan_Inquiry', secondChildDsl);

    const multiChildSupervisorDsl = `
SUPERVISOR: Multi_Supervisor

GOAL: "Route banking requests"

PERSONA: "Banking supervisor"

HANDOFF:
  - TO: Account_Inquiry
    WHEN: intent.category == "balance"
    RETURN: true
  - TO: Loan_Inquiry
    WHEN: intent.category == "loan"
    RETURN: true
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [multiChildSupervisorDsl, RESPONSE_ONLY_CHILD_DSL, secondChildDsl],
        'Multi_Supervisor',
      ),
    );

    session.handoffReturnInfo = { Account_Inquiry: true, Loan_Inquiry: true };
    session.conversationHistory.push({ role: 'user', content: 'Check my balance.' });

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt) => {
      callCount++;
      if (systemPrompt.includes('Account specialist')) {
        return {
          text: 'Your balance is $5,000.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Your balance is $5,000.' }],
        };
      }
      if (systemPrompt.includes('Loan specialist')) {
        return {
          text: 'Your loan rate is 4.5%.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Your loan rate is 4.5%.' }],
        };
      }
      return {
        text: 'How can I help you today?',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'How can I help you today?' }],
      };
    });

    const handleHandoff = (
      executor as unknown as {
        routing: {
          handleHandoff: (
            sessionArg: typeof session,
            input: { target: string; message: string },
          ) => Promise<{ success: boolean; response?: string }>;
        };
      }
    ).routing.handleHandoff.bind((executor as unknown as { routing: unknown }).routing);

    // First handoff to Account_Inquiry
    const firstResult = await handleHandoff(session, {
      target: 'Account_Inquiry',
      message: 'Check my balance.',
    });

    expect(firstResult.response).toBe('Your balance is $5,000.');
    expect(session.agentName).toBe('Multi_Supervisor');
    expect(session.activeThreadIndex).toBe(0);

    const accountThread = session.threads.find((t) => t.agentName === 'Account_Inquiry');
    expect(accountThread?.status).toBe('completed');

    // Second handoff to Loan_Inquiry
    session.conversationHistory.push({ role: 'user', content: 'What is my loan rate?' });
    const secondResult = await handleHandoff(session, {
      target: 'Loan_Inquiry',
      message: 'What is my loan rate?',
    });

    expect(secondResult.response).toBe('Your loan rate is 4.5%.');
    expect(session.agentName).toBe('Multi_Supervisor');
    expect(session.activeThreadIndex).toBe(0);

    const loanThread = session.threads.find((t) => t.agentName === 'Loan_Inquiry');
    expect(loanThread?.status).toBe('completed');
  });

  // ========================================================================
  // ADJACENT-AREA BUG HUNTS
  // These tests target structurally similar bugs in nearby code paths.
  // The two original bugs shared patterns:
  //   (1) Guards that short-circuit before downstream handlers run
  //   (2) Completion gates that miss implicit signals
  // ========================================================================

  test('isEscalated guard swallows queued intent confirmation (guard ordering bug)', async () => {
    // Bug pattern: The second isEscalated guard at runtime-executor.ts:2278
    // has NO bypass for _queued_intent_confirmation_, unlike the isComplete
    // guard which was patched. If a session is BOTH escalated AND waiting
    // for queued intent confirmation, the user's "yes" gets swallowed by
    // the mock human response handler.
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_INTENT_MULTI_TURN_DSL], 'Travel_Helper'),
    );

    const projectRuntimeConfig = {
      extraction_strategy: 'auto' as const,
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue' as const,
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 300_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast' as const,
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' as const },
      lookup_tables: [],
    };

    session._projectRuntimeConfig = projectRuntimeConfig;
    if (session.agentIR) {
      session.agentIR.project_runtime_config = projectRuntimeConfig;
    }

    await executor.initializeSession(session.id);

    // Dual state: escalated AND queued intent confirmation pending
    session.isEscalated = true;
    session.isComplete = true;
    session.intentQueue = createIntentQueue();
    enqueueIntents(session.intentQueue, [
      {
        intent: 'cancellation',
        confidence: 0.82,
        original_message: 'Please book and cancel.',
      },
    ]);
    session.waitingForInput = ['_queued_intent_confirmation_'];

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = await executor.executeMessage(session.id, 'yes', undefined, (event) =>
      traceEvents.push(event),
    );

    // The isEscalated guard should NOT consume the user's confirmation
    // when waitingForInput includes _queued_intent_confirmation_.
    // If the guard swallows it, result.response contains "[HUMAN AGENT]:"
    expect(result.response).not.toContain('[HUMAN AGENT]');
    expect(result.action?.type).not.toBe('escalate');
  });

  test('thread-completed guard does not block queued intent confirmation', async () => {
    // Bug pattern: The thread completion check at runtime-executor.ts:2198
    // returns early when activeThread.status === 'completed' — but has NO
    // bypass for _queued_intent_confirmation_, unlike the isComplete guard.
    // In multi-intent flows, the completion sync at routing-executor.ts:750
    // can set thread status to 'completed' while queued intents are pending.
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_INTENT_MULTI_TURN_DSL], 'Travel_Helper'),
    );

    const projectRuntimeConfig = {
      extraction_strategy: 'auto' as const,
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue' as const,
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 300_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast' as const,
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' as const },
      lookup_tables: [],
    };

    session._projectRuntimeConfig = projectRuntimeConfig;
    if (session.agentIR) {
      session.agentIR.project_runtime_config = projectRuntimeConfig;
    }

    await executor.initializeSession(session.id);

    // Simulate: active thread was marked completed by a handoff sync,
    // but there are still queued intents pending user confirmation.
    const activeThread = session.threads[session.activeThreadIndex];
    activeThread.status = 'completed';
    session.isComplete = true;
    session.intentQueue = createIntentQueue();
    enqueueIntents(session.intentQueue, [
      {
        intent: 'cancellation',
        confidence: 0.82,
        original_message: 'Book and cancel.',
      },
    ]);
    session.waitingForInput = ['_queued_intent_confirmation_'];

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = await executor.executeMessage(session.id, 'yes', undefined, (event) =>
      traceEvents.push(event),
    );

    // The thread-completed guard should not short-circuit when there's
    // a pending queued intent confirmation. The queued intent handler
    // in flow-step-executor should process the "yes".
    expect(result.action?.message).not.toBe('Session already complete');
  });

  test('queued intent confirmation survives completed-thread and escalated guards together', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_INTENT_MULTI_TURN_DSL], 'Travel_Helper'),
    );

    const projectRuntimeConfig = {
      extraction_strategy: 'auto' as const,
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue' as const,
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 300_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast' as const,
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' as const },
      lookup_tables: [],
    };

    session._projectRuntimeConfig = projectRuntimeConfig;
    if (session.agentIR) {
      session.agentIR.project_runtime_config = projectRuntimeConfig;
    }

    await executor.initializeSession(session.id);

    const activeThread = session.threads[session.activeThreadIndex];
    activeThread.status = 'completed';
    session.isEscalated = true;
    session.isComplete = true;
    session.intentQueue = createIntentQueue();
    enqueueIntents(session.intentQueue, [
      {
        intent: 'cancellation',
        confidence: 0.82,
        original_message: 'Please book and cancel.',
      },
    ]);
    session.waitingForInput = ['_queued_intent_confirmation_'];

    const result = await executor.executeMessage(session.id, 'yes');

    expect(result.response).toContain('Cancellation complete.');
    expect(result.response).not.toContain('[HUMAN AGENT]');
    expect(session.data.values.handled_intent).toBe('cancellation');
    expect(session.waitingForInput).toBeUndefined();
  });

  test('RETURN: true flow child completing via THEN: COMPLETE preserves parent threadStack entry', async () => {
    // Bug pattern: When a flow child reaches THEN: COMPLETE, tryThreadReturn()
    // (called inside flow-step-executor) pops threadStack. Then handleHandoff's
    // Gate 3 (routing-executor.ts:784) pops threadStack AGAIN. For a single-depth
    // handoff this is harmless (second pop returns undefined), but for nested
    // handoffs it destroys the grandparent's return path.
    //
    // This test sets up a two-depth scenario: Mid_Supervisor → Flow_Completer,
    // with Grand_Supervisor on the threadStack. After Flow_Completer completes
    // via THEN: COMPLETE, the grandparent's threadStack entry must survive.

    executor.registerAgent('Flow_Completer', FLOW_COMPLETING_CHILD_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [NESTED_GRANDPARENT_DSL, NESTED_MID_SUPERVISOR_DSL, FLOW_COMPLETING_CHILD_DSL],
        'Grand_Supervisor',
      ),
    );

    session.handoffReturnInfo = { Mid_Supervisor: true, Flow_Completer: true };

    // Simulate: Grand_Supervisor (thread 0) already handed off to Mid_Supervisor (thread 1).
    // Now Mid_Supervisor is about to hand off to Flow_Completer.

    // The initial thread (index 0) is Grand_Supervisor — created by createSessionFromResolved.
    // Set it to 'waiting' as if Grand handed off to Mid.
    session.threads[0].status = 'waiting';

    // Create a Mid_Supervisor thread (index 1) as if handleHandoff created it.
    const midResolvedAgent = compileToResolvedAgent(
      [NESTED_MID_SUPERVISOR_DSL, FLOW_COMPLETING_CHILD_DSL],
      'Mid_Supervisor',
    );
    const midIR = midResolvedAgent.agents[midResolvedAgent.entryAgent];
    session.threads.push({
      agentName: 'Mid_Supervisor',
      agentIR: midIR,
      conversationHistory: [{ role: 'user', content: 'Look up the details.' }],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: { session_id: session.id }, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
    } as (typeof session.threads)[number]);

    // Set session to Mid_Supervisor context
    session.activeThreadIndex = 1;
    session.agentName = 'Mid_Supervisor';
    session.agentIR = midIR;
    session.threadStack = [0]; // Grand is on the stack
    session.handoffStack = ['Grand_Supervisor', 'Mid_Supervisor'];
    session.conversationHistory = session.threads[1].conversationHistory;
    session.state = session.threads[1].state;
    session.data = session.threads[1].data;

    // Now call handleHandoff from Mid_Supervisor → Flow_Completer.
    // The flow child reaches THEN: COMPLETE → tryThreadReturn fires → pops threadStack.
    // Then handleHandoff Gate 3 fires → pops threadStack AGAIN.
    const handleHandoff = (
      executor as unknown as {
        routing: {
          handleHandoff: (
            sessionArg: typeof session,
            input: { target: string; message: string },
          ) => Promise<{ success: boolean; response?: string }>;
        };
      }
    ).routing.handleHandoff.bind((executor as unknown as { routing: unknown }).routing);

    session.conversationHistory.push({ role: 'user', content: 'Look up the details.' });
    const result = await handleHandoff(session, {
      target: 'Flow_Completer',
      message: 'Look up the details.',
    });

    expect(result.response).toBe('Flow child done.');

    // CRITICAL ASSERTION: After Flow_Completer returns, session should be
    // back at Mid_Supervisor (one level up), NOT at Grand_Supervisor.
    // The threadStack should still contain the grandparent's index [0]
    // so that Mid_Supervisor can later return to Grand_Supervisor.
    //
    // If the double-pop bug exists:
    //   - session.agentName === 'Grand_Supervisor' (jumped two levels)
    //   - threadStack is [] (grandparent entry consumed)
    //
    // Correct behavior:
    //   - session.agentName === 'Mid_Supervisor' (one level up)
    //   - threadStack is [0] (grandparent entry preserved)
    expect(session.agentName).toBe('Mid_Supervisor');
    expect(session.activeThreadIndex).toBe(1);
    expect(session.threadStack).toEqual([0]);
    expect(session.handoffStack).toEqual(['Grand_Supervisor', 'Mid_Supervisor']);
  });

  test('RETURN: true child isEscalated state does not leak from parent handoff context', async () => {
    // Bug pattern: handleHandoff at routing-executor.ts:615-627 syncs session
    // fields to the child thread but does NOT reset session.isEscalated.
    // The second isEscalated guard at runtime-executor.ts:2278 doesn't check
    // isRecursive, so a stale isEscalated=true from the parent session leaks
    // into the child's executeMessage and returns a mock human response instead
    // of executing the child.
    //
    // Scenario: handoff timeout triggered isEscalated on a prior child return,
    // and the flag persists into the next handoff.

    executor.registerAgent('Account_Inquiry', RESPONSE_ONLY_CHILD_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL, RESPONSE_ONLY_CHILD_DSL], 'Bank_Supervisor'),
    );

    session.handoffReturnInfo = { Account_Inquiry: true };
    session.conversationHistory.push({ role: 'user', content: 'Check my balance.' });

    // Simulate: a prior handoff timeout set isEscalated = true and it was
    // never cleared. Now a new handoff to Account_Inquiry is triggered.
    session.isEscalated = true;

    mockClient.setResponseHandler((systemPrompt) => {
      if (systemPrompt.includes('Account specialist')) {
        return {
          text: 'Your balance is $5,000.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Your balance is $5,000.' }],
        };
      }
      return {
        text: 'How can I help?',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'How can I help?' }],
      };
    });

    const handleHandoff = (
      executor as unknown as {
        routing: {
          handleHandoff: (
            sessionArg: typeof session,
            input: { target: string; message: string },
          ) => Promise<{ success: boolean; response?: string }>;
        };
      }
    ).routing.handleHandoff.bind((executor as unknown as { routing: unknown }).routing);

    const result = await handleHandoff(session, {
      target: 'Account_Inquiry',
      message: 'Check my balance.',
    });

    // The child should execute normally — parent's isEscalated should not
    // leak into the child's execution context.
    // If the bug exists: result.response contains "[HUMAN AGENT]:"
    expect(result.response).not.toContain('[HUMAN AGENT]');
    expect(result.response).toBe('Your balance is $5,000.');
    expect(session.isEscalated).toBe(false);
  });

  test('RETURN: true child execution does not inherit a stale parent completion flag', async () => {
    executor.registerAgent('Account_Inquiry', RESPONSE_ONLY_CHILD_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL, RESPONSE_ONLY_CHILD_DSL], 'Bank_Supervisor'),
    );

    session.handoffReturnInfo = { Account_Inquiry: true };
    session.conversationHistory.push({ role: 'user', content: 'Check my balance.' });
    session.isComplete = true;

    mockClient.setResponseHandler((systemPrompt) => {
      if (systemPrompt.includes('Account specialist')) {
        return {
          text: 'Your balance is $5,000.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Your balance is $5,000.' }],
        };
      }
      return {
        text: 'How can I help?',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'How can I help?' }],
      };
    });

    const handleHandoff = (
      executor as unknown as {
        routing: {
          handleHandoff: (
            sessionArg: typeof session,
            input: { target: string; message: string },
          ) => Promise<{ success: boolean; response?: string }>;
        };
      }
    ).routing.handleHandoff.bind((executor as unknown as { routing: unknown }).routing);

    const result = await handleHandoff(session, {
      target: 'Account_Inquiry',
      message: 'Check my balance.',
    });

    expect(result.response).toBe('Your balance is $5,000.');
    expect(session.agentName).toBe('Bank_Supervisor');
    expect(session.isComplete).toBe(false);
  });

  test('handoffStack and threadStack remain in sync after RETURN: true completion', async () => {
    // Structural invariant: threadStack and handoffStack should always have
    // consistent depths. tryThreadReturn (types.ts:723) pops threadStack but
    // NOT handoffStack, while handleHandoff Gate 3 (routing-executor.ts:790)
    // pops handoffStack. Verify they end up consistent.

    executor.registerAgent('Account_Inquiry', RESPONSE_ONLY_CHILD_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL, RESPONSE_ONLY_CHILD_DSL], 'Bank_Supervisor'),
    );

    session.handoffReturnInfo = { Account_Inquiry: true };
    session.conversationHistory.push({ role: 'user', content: 'Check my balance.' });

    // Record pre-handoff state
    const preHandoffThreadStack = [...session.threadStack];
    const preHandoffHandoffStack = [...session.handoffStack];

    mockClient.setResponseHandler((systemPrompt) => {
      if (systemPrompt.includes('Account specialist')) {
        return {
          text: 'Your balance is $5,000.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Your balance is $5,000.' }],
        };
      }
      return {
        text: 'How can I help?',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'How can I help?' }],
      };
    });

    const handleHandoff = (
      executor as unknown as {
        routing: {
          handleHandoff: (
            sessionArg: typeof session,
            input: { target: string; message: string },
          ) => Promise<{ success: boolean; response?: string }>;
        };
      }
    ).routing.handleHandoff.bind((executor as unknown as { routing: unknown }).routing);

    await handleHandoff(session, {
      target: 'Account_Inquiry',
      message: 'Check my balance.',
    });

    // After child returns: stacks should be back to pre-handoff lengths
    expect(session.threadStack.length).toBe(preHandoffThreadStack.length);
    expect(session.handoffStack.length).toBe(preHandoffHandoffStack.length);

    // Verify the stacks are NOT negative or contain stale entries
    expect(session.threadStack.length).toBeGreaterThanOrEqual(0);
    expect(session.handoffStack.length).toBeGreaterThanOrEqual(0);

    // The handoffStack should not contain the child agent anymore
    expect(session.handoffStack).not.toContain('Account_Inquiry');
  });

  test('RETURN: true flow child (THEN: COMPLETE) does not corrupt single-depth stack', async () => {
    // Verifies that the double-pop from tryThreadReturn + handleHandoff Gate 3
    // is harmless for single-depth handoffs. The flow child reaches THEN: COMPLETE,
    // tryThreadReturn pops threadStack, then Gate 3 pops again (gets undefined).
    // For single depth the second pop is a no-op.

    executor.registerAgent('Flow_Completer', FLOW_COMPLETING_CHILD_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [FLOW_CHILD_SUPERVISOR_DSL, FLOW_COMPLETING_CHILD_DSL],
        'FlowChild_Supervisor',
      ),
    );

    session.handoffReturnInfo = { Flow_Completer: true };
    session.conversationHistory.push({ role: 'user', content: 'Complete the task.' });

    const handleHandoff = (
      executor as unknown as {
        routing: {
          handleHandoff: (
            sessionArg: typeof session,
            input: { target: string; message: string },
          ) => Promise<{ success: boolean; response?: string }>;
        };
      }
    ).routing.handleHandoff.bind((executor as unknown as { routing: unknown }).routing);

    const result = await handleHandoff(session, {
      target: 'Flow_Completer',
      message: 'Complete the task.',
    });

    expect(result.response).toBe('Flow child done.');
    expect(session.agentName).toBe('FlowChild_Supervisor');
    expect(session.activeThreadIndex).toBe(0);
    expect(session.threadStack).toEqual([]);
    expect(session.handoffStack).not.toContain('Flow_Completer');

    const flowThread = session.threads.find((t) => t.agentName === 'Flow_Completer');
    expect(flowThread?.status).toBe('completed');
  });
});
