/**
 * Thread Resume & Return-to-Parent Integration Tests
 *
 * Full round-trip tests exercising the RuntimeExecutor path:
 *   Supervisor → CreditCardAgent (RETURN:true) → user digression →
 *   parent supervisor pre-routes the external digression when possible →
 *   AccountInfoAgent responds → next user message → supervisor re-routes →
 *   CreditCardAgent thread resumed with prior context
 *
 * Uses MockAnthropicClient for deterministic LLM responses.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { SYSTEM_TOOL_HANDOFF, SYSTEM_TOOL_RETURN_TO_PARENT } from '@abl/compiler';

vi.mock('../../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: vi.fn(async () => ({
      security: { scrubPII: true },
      features: {
        codeToolsEnabled: false,
        advancedNlu: false,
      },
    })),
    getProjectConfig: vi.fn(async () => null),
  }),
}));

vi.mock('../../services/guardrails/pipeline-factory.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../services/guardrails/pipeline-factory.js')
  >('../../services/guardrails/pipeline-factory.js');
  return {
    ...actual,
    resolveGuardrailPolicy: vi.fn(async () => undefined),
  };
});

import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';

// =============================================================================
// MOCK LLM CLIENT
// =============================================================================

class MockAnthropicClient {
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

  setResponseHandler(
    handler: (
      systemPrompt: string,
      messages: Array<{ role: string; content: unknown }>,
      tools: unknown[],
    ) => {
      text: string;
      toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      stopReason: string;
      rawContent: Array<{ type: string; [key: string]: unknown }>;
    },
  ) {
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

function injectMockClient(executor: RuntimeExecutor): MockAnthropicClient {
  const mock = new MockAnthropicClient();
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

// =============================================================================
// HELPERS
// =============================================================================

interface CapturedTrace {
  type: string;
  data: Record<string, unknown>;
}

function createTraceCollector(): {
  traces: CapturedTrace[];
  callback: (event: { type: string; data: Record<string, unknown> }) => void;
} {
  const traces: CapturedTrace[] = [];
  return {
    traces,
    callback: (event) => traces.push({ type: event.type, data: event.data }),
  };
}

function filterTraces(traces: CapturedTrace[], type: string): CapturedTrace[] {
  return traces.filter((t) => t.type === type);
}

const THREAD_RESUME_SCOPE = {
  tenantId: 'tenant-thread-resume',
  projectId: 'project-thread-resume',
} as const;

function createBankingSupervisorSession(executor: RuntimeExecutor, ...additionalAgents: string[]) {
  return executor.createSessionFromResolved(
    compileToResolvedAgent([BANKING_SUPERVISOR, ...additionalAgents], 'BankingAdvisor'),
    THREAD_RESUME_SCOPE,
  );
}

function setEntityExtractionHandler(
  mockClient: MockAnthropicClient,
  shouldExtract: (userText: string) => boolean,
): void {
  mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
    if (tools.some((t: any) => t.name === '_extract_entities')) {
      const extractTool = tools.find((t: any) => t.name === '_extract_entities') as any;
      const props = extractTool?.input_schema?.properties || {};
      const fieldName = Object.keys(props).find(
        (key) => key !== '_thinking' && key !== '_clarification',
      );
      const lastUserMsg = messages.filter((message: any) => message.role === 'user').pop();
      const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';

      if (fieldName && shouldExtract(userText)) {
        return {
          text: '',
          toolCalls: [
            {
              id: `extract-${fieldName}`,
              name: '_extract_entities',
              input: { [fieldName]: userText },
            },
          ],
          stopReason: 'tool-calls',
          rawContent: [
            {
              type: 'tool_use',
              id: `extract-${fieldName}`,
              name: '_extract_entities',
              input: { [fieldName]: userText },
            },
          ],
        };
      }

      return {
        text: '{}',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: '{}' }],
      };
    }

    return {
      text: 'OK.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'OK.' }],
    };
  });
}

// =============================================================================
// ABL FIXTURES
// =============================================================================

const BANKING_SUPERVISOR = `
SUPERVISOR: BankingAdvisor

GOAL: "Route banking requests to specialist agents"

PERSONA: "Professional banking routing assistant"

HANDOFF:
  - TO: CreditCardAgent
    WHEN: intent.category == "payment"
    CONTEXT:
      pass: [customer_id]
      summary: "User wants to make a credit card payment"
    RETURN: true

  - TO: AccountInfoAgent
    WHEN: intent.category == "balance"
    CONTEXT:
      pass: [customer_id]
      summary: "User wants account balance info"
    RETURN: true

COMPLETE:
  - WHEN: all_done == true
    RESPOND: "Thank you for banking with us."
`;

const CREDIT_CARD_AGENT = `
AGENT: CreditCardAgent

GOAL: "Help users make credit card payments"

PERSONA: "Payment processing specialist"

GATHER:
  card_number:
    prompt: "What card would you like to use?"
    type: string
    required: true

  amount:
    prompt: "How much would you like to pay?"
    type: string
    required: true

  confirmation:
    prompt: "Please confirm the payment"
    type: string
    required: true
`;

const ACCOUNT_INFO_AGENT = `
AGENT: AccountInfoAgent

GOAL: "Provide account balance and information"

PERSONA: "Account information specialist"

GATHER:
  account_type:
    prompt: "Which account - checking or savings?"
    type: string
    required: false

  balance_provided:
    prompt: "Balance check complete"
    type: string
    required: false

COMPLETE:
  - WHEN: balance_provided == "yes"
    RESPOND: "Balance check complete."
`;

const FLOW_CREDIT_CARD_AGENT = `
AGENT: CreditCardAgent

GOAL: "Collect the phone number needed for a payment flow"

FLOW:
  entry_point: collect_phone
  steps:
    - collect_phone

collect_phone:
  REASONING: false
  GATHER:
    - phone: required
  THEN: COMPLETE
`;

const FLOW_ACCOUNT_INFO_AGENT = `
AGENT: AccountInfoAgent

GOAL: "Handle balance inquiries after the supervisor reroutes the user"

FLOW:
  entry_point: share_balance
  steps:
    - share_balance

share_balance:
  REASONING: false
  RESPOND: "I can help with your balance."
  THEN: COMPLETE
`;

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('Integration: Return-to-Parent with Reasoning Agents', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  test('child agent receives __return_to_parent__ tool when invoked via RETURN:true handoff', async () => {
    const session = createBankingSupervisorSession(executor, CREDIT_CARD_AGENT);
    executor.registerAgent('CreditCardAgent', CREDIT_CARD_AGENT);
    session.handoffReturnInfo = { CreditCardAgent: true, AccountInfoAgent: true };
    session.conversationHistory.push({ role: 'user', content: 'pay my credit card' });

    // Track what tools the child agent sees
    let childTools: unknown[] = [];
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      // Entity extraction call — return empty
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      // Child reasoning agent call — capture tools and respond
      if (systemPrompt.includes('Payment processing')) {
        childTools = tools;
        return {
          text: 'What card would you like to use?',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'What card would you like to use?' }],
        };
      }
      return {
        text: 'Default.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Default.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay my credit card' },
      undefined,
      undefined,
    );

    // Verify child agent received __return_to_parent__ tool
    const returnTool = (childTools as any[]).find((t) => t.name === SYSTEM_TOOL_RETURN_TO_PARENT);
    expect(returnTool).toBeDefined();
    expect(returnTool.description).toContain('BankingAdvisor');
  });

  test('__return_to_parent__ returns control to supervisor with forwarded message', async () => {
    const session = createBankingSupervisorSession(executor, CREDIT_CARD_AGENT);
    executor.registerAgent('CreditCardAgent', CREDIT_CARD_AGENT);
    session.handoffReturnInfo = { CreditCardAgent: true, AccountInfoAgent: true };
    session.conversationHistory.push({ role: 'user', content: 'pay my credit card' });

    // Call sequence counter to vary responses
    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      callCount++;

      // Entity extraction — return empty
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }

      // Child CreditCardAgent: first call gathers card, second call hits digression
      if (systemPrompt.includes('Payment processing')) {
        const hasReturnTool = tools.some((t: any) => t.name === SYSTEM_TOOL_RETURN_TO_PARENT);

        // Check if the last user message is about balance (digression)
        const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
        const content = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';

        if (hasReturnTool && content.includes('balance')) {
          // Child calls __return_to_parent__
          return {
            text: '',
            toolCalls: [
              {
                id: 'return-1',
                name: SYSTEM_TOOL_RETURN_TO_PARENT,
                input: {
                  reason: 'Balance inquiry is outside my scope',
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
                  reason: 'Balance inquiry is outside my scope',
                  message: "what's my balance?",
                },
              },
            ],
          };
        }

        // Normal child response
        return {
          text: 'What card would you like to use for the payment?',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'What card would you like to use for the payment?' }],
        };
      }

      return {
        text: 'Default.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Default.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const traceCollector = createTraceCollector();

    // Step 1: Supervisor handoff to CreditCardAgent (RETURN: true)
    const result1 = await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay my credit card' },
      undefined,
      traceCollector.callback,
    );
    expect(result1.success).toBe(true);

    // After initial handoff, child responded and control stayed with child (RETURN: true, not yet returned)
    // Parent thread is at index 0 (waiting), child at index 1 (active)
    expect(session.threads.length).toBe(2);
    expect(session.threads[0].agentName).toBe('BankingAdvisor');
    expect(session.threads[1].agentName).toBe('CreditCardAgent');

    // Now simulate the child receiving a digression message via executeMessage
    // The child is active, so executeMessage routes to it
    const result2 = await executor.executeMessage(
      session.id,
      "what's my balance?",
      undefined,
      traceCollector.callback,
    );

    // After return_to_parent:
    // - Child thread should be waiting (paused, not completed)
    // - Parent thread should be reactivated
    // - Forwarded message should be in parent conversation
    const returnTraces = filterTraces(traceCollector.traces, 'return_to_parent');
    expect(returnTraces.length).toBe(1);
    expect(returnTraces[0].data.from).toBe('CreditCardAgent');
    expect(returnTraces[0].data.to).toBe('BankingAdvisor');
    expect(returnTraces[0].data.forwardedMessage).toBe("what's my balance?");

    // Child thread should be in waiting status (resumable)
    expect(session.threads[1].status).toBe('waiting');

    // Parent should be reactivated
    expect(session.threads[0].status).toBe('active');
    expect(session.activeThreadIndex).toBe(0);
    expect(session.agentName).toBe('BankingAdvisor');

    // Forwarded message should be in parent's conversation
    const parentHistory = session.threads[0].conversationHistory;
    const forwardedMsg = parentHistory.find(
      (m) => m.role === 'user' && m.content === "what's my balance?",
    );
    expect(forwardedMsg).toBeDefined();
  });

  test('thread resume: parent pre-routes digression and prior child context is preserved', async () => {
    const session = createBankingSupervisorSession(executor, CREDIT_CARD_AGENT, ACCOUNT_INFO_AGENT);
    executor.registerAgent('CreditCardAgent', CREDIT_CARD_AGENT);
    executor.registerAgent('AccountInfoAgent', ACCOUNT_INFO_AGENT);
    session.handoffReturnInfo = {
      CreditCardAgent: true,
      AccountInfoAgent: true,
    };
    session.conversationHistory.push({
      role: 'user',
      content: 'pay my credit card',
    });

    // Phase tracking: which agent is being called
    let phase: 'initial_handoff' | 'digression' | 'account_info' | 'resume' = 'initial_handoff';

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      // Entity extraction — always return empty
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }

      // CreditCardAgent
      if (systemPrompt.includes('Payment processing')) {
        const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
        const content = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';

        if (
          content.includes('balance') &&
          tools.some((t: any) => t.name === SYSTEM_TOOL_RETURN_TO_PARENT)
        ) {
          phase = 'digression';
          return {
            text: '',
            toolCalls: [
              {
                id: 'return-1',
                name: SYSTEM_TOOL_RETURN_TO_PARENT,
                input: {
                  reason: 'Balance inquiry is outside my scope',
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
                  reason: 'Balance inquiry is outside my scope',
                  message: "what's my balance?",
                },
              },
            ],
          };
        }

        // Normal CreditCardAgent response (initial or resume)
        return {
          text: 'Processing your payment. Card ending 4242, amount $500.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            {
              type: 'text',
              text: 'Processing your payment. Card ending 4242, amount $500.',
            },
          ],
        };
      }

      // AccountInfoAgent
      if (systemPrompt.includes('Account information')) {
        phase = 'account_info';
        return {
          text: 'Your checking balance is $5,000.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Your checking balance is $5,000.' }],
        };
      }

      return {
        text: 'Default.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Default.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const traceCollector = createTraceCollector();

    // --- Step 1: Supervisor → CreditCardAgent (RETURN: true) ---
    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay my credit card' },
      undefined,
      traceCollector.callback,
    );

    // Child gathered some data during initial interaction
    const childThread = session.threads[1];
    childThread.data.values.card_number = '4242';
    childThread.data.values.amount = '500';
    childThread.data.gatheredKeys.add('card_number');
    childThread.data.gatheredKeys.add('amount');

    expect(session.threads.length).toBe(2);
    expect(session.threads[1].agentName).toBe('CreditCardAgent');

    // --- Step 2: User sends digression "what's my balance?" ---
    await executor.executeMessage(
      session.id,
      "what's my balance?",
      undefined,
      traceCollector.callback,
    );

    // The external follow-up is classified by the parent before the active child
    // consumes it, so the runtime returns to the supervisor and immediately
    // routes the digression to AccountInfoAgent.
    expect(session.threads[1].status).toBe('waiting');
    expect(session.threads.length).toBe(3); // supervisor + credit card (waiting) + account info
    expect(session.threads[2].agentName).toBe('AccountInfoAgent');
    expect(session.activeThreadIndex).toBe(2);
    expect(phase).toBe('account_info');

    // --- Step 3: AccountInfoAgent completes and returns to supervisor ---
    // Simulate AccountInfoAgent completing (in real flow, auto-completion or __complete__ would fire)
    // Set balance_provided to trigger COMPLETE condition, then manually complete the thread
    session.threads[2].data.values.balance_provided = 'yes';
    session.threads[2].status = 'completed';
    session.threads[2].endedAt = Date.now();
    // Return to supervisor
    const parentIdx = session.threadStack.pop()!;
    session.handoffStack = session.handoffStack.slice(0, -1);
    session.threads[parentIdx].status = 'active';
    session.activeThreadIndex = parentIdx;
    // Sync session to supervisor thread
    session.agentName = session.threads[parentIdx].agentName;
    session.agentIR = session.threads[parentIdx].agentIR;
    session.conversationHistory = session.threads[parentIdx].conversationHistory;
    session.llmClient = undefined;

    expect(session.activeThreadIndex).toBe(0); // Back at supervisor

    // --- Step 4: Supervisor re-routes to CreditCardAgent (THREAD RESUME) ---
    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'continue with payment' },
      undefined,
      traceCollector.callback,
    );

    // Verify thread resume trace
    const resumeTraces = filterTraces(traceCollector.traces, 'thread_resume');
    expect(resumeTraces.length).toBe(1);
    expect(resumeTraces[0].data.agentName).toBe('CreditCardAgent');

    // Verify the resumed thread is the SAME thread (index 1), not a new one
    expect(session.threads.length).toBe(3); // No new thread created
    expect(session.activeThreadIndex).toBe(1); // Back to original CreditCardAgent thread
    expect(session.threads[1].status).toBe('active'); // Reactivated

    // --- KEY ASSERTION: Prior context is preserved ---
    const resumedThread = session.threads[1];
    expect(resumedThread.data.values.card_number).toBe('4242');
    expect(resumedThread.data.values.amount).toBe('500');
    expect(resumedThread.data.gatheredKeys.has('card_number')).toBe(true);
    expect(resumedThread.data.gatheredKeys.has('amount')).toBe(true);

    // Conversation history from before the digression is intact
    expect(resumedThread.conversationHistory.length).toBeGreaterThanOrEqual(2);
  });

  test('handoff stack is correctly managed across return and resume', async () => {
    const session = createBankingSupervisorSession(executor, CREDIT_CARD_AGENT, ACCOUNT_INFO_AGENT);
    executor.registerAgent('CreditCardAgent', CREDIT_CARD_AGENT);
    executor.registerAgent('AccountInfoAgent', ACCOUNT_INFO_AGENT);
    session.handoffReturnInfo = {
      CreditCardAgent: true,
      AccountInfoAgent: true,
    };
    session.conversationHistory.push({
      role: 'user',
      content: 'pay my card',
    });

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      if (
        systemPrompt.includes('Payment processing') &&
        tools.some((t: any) => t.name === SYSTEM_TOOL_RETURN_TO_PARENT)
      ) {
        const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
        const content = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
        if (content.includes('balance')) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'r1',
                name: SYSTEM_TOOL_RETURN_TO_PARENT,
                input: {
                  reason: 'out of scope',
                  message: "what's my balance?",
                },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'r1',
                name: SYSTEM_TOOL_RETURN_TO_PARENT,
                input: {
                  reason: 'out of scope',
                  message: "what's my balance?",
                },
              },
            ],
          };
        }
      }
      return {
        text: 'Agent response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Agent response.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);

    // Step 1: handoff to CreditCardAgent
    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay my card' },
      undefined,
      undefined,
    );
    // CreditCardAgent was added to handoffStack during handoff, then popped on return (RETURN:true completes)
    // After normal completion with return, handoffStack is trimmed
    // But if child just responds (end_turn, not complete), control stays with child
    // In our case child responded with text, thread is still active

    // Step 2: digression
    await executor.executeMessage(session.id, "what's my balance?", undefined, undefined);

    // After return_to_parent, handoffStack should be trimmed (CreditCardAgent removed)
    expect(session.handoffStack).not.toContain('CreditCardAgent');

    expect(session.handoffStack).toContain('AccountInfoAgent');

    // Complete the auto-routed AccountInfoAgent turn and return to the supervisor.
    session.threads[2].status = 'completed';
    session.threads[2].endedAt = Date.now();
    const parentIdx = session.threadStack.pop()!;
    session.handoffStack = session.handoffStack.slice(0, -1);
    session.threads[parentIdx].status = 'active';
    session.activeThreadIndex = parentIdx;
    session.agentName = session.threads[parentIdx].agentName;
    session.agentIR = session.threads[parentIdx].agentIR;
    session.conversationHistory = session.threads[parentIdx].conversationHistory;
    session.llmClient = undefined;

    // Step 3: re-route to CreditCardAgent (resume)
    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'continue payment' },
      undefined,
      undefined,
    );

    // CreditCardAgent is back on the handoff stack
    expect(session.handoffStack).toContain('CreditCardAgent');

    // No cycle detection error — CreditCardAgent was properly removed from stack before re-route
    expect(session.threads[1].status).toBe('active');
  });

  test('no resume when target agent has no waiting thread (fresh handoff)', async () => {
    const session = createBankingSupervisorSession(executor, ACCOUNT_INFO_AGENT);
    executor.registerAgent('AccountInfoAgent', ACCOUNT_INFO_AGENT);
    session.handoffReturnInfo = { AccountInfoAgent: true };
    session.conversationHistory.push({
      role: 'user',
      content: 'check balance',
    });

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      return {
        text: 'Your balance is $5,000.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Your balance is $5,000.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const traceCollector = createTraceCollector();

    // First handoff — no waiting thread, should create new
    await handleHandoff(
      session,
      { target: 'AccountInfoAgent', message: 'check balance' },
      undefined,
      traceCollector.callback,
    );

    // No thread_resume trace should be emitted
    const resumeTraces = filterTraces(traceCollector.traces, 'thread_resume');
    expect(resumeTraces.length).toBe(0);

    // Normal new thread creation
    expect(session.threads.length).toBe(2);
    expect(session.threads[1].agentName).toBe('AccountInfoAgent');
    expect(session.threads[1].conversationHistory.length).toBeGreaterThanOrEqual(1);
  });

  test('return_to_parent trace includes correct metadata', async () => {
    const session = createBankingSupervisorSession(executor, CREDIT_CARD_AGENT);
    executor.registerAgent('CreditCardAgent', CREDIT_CARD_AGENT);
    session.handoffReturnInfo = { CreditCardAgent: true };
    session.conversationHistory.push({
      role: 'user',
      content: 'pay card',
    });

    let callNum = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      callNum++;
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }

      // First reasoning call: normal response
      // Second reasoning call (digression): return_to_parent
      if (systemPrompt.includes('Payment processing')) {
        const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
        const content = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
        if (content.includes('weather')) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'ret-1',
                name: SYSTEM_TOOL_RETURN_TO_PARENT,
                input: {
                  reason: 'Weather questions are outside payment scope',
                  message: "what's the weather like?",
                },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'ret-1',
                name: SYSTEM_TOOL_RETURN_TO_PARENT,
                input: {
                  reason: 'Weather questions are outside payment scope',
                  message: "what's the weather like?",
                },
              },
            ],
          };
        }
      }

      return {
        text: 'Processing payment.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Processing payment.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const traceCollector = createTraceCollector();

    // Initial handoff
    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay card' },
      undefined,
      traceCollector.callback,
    );

    // Digression
    await executor.executeMessage(
      session.id,
      "what's the weather like?",
      undefined,
      traceCollector.callback,
    );

    // Verify return_to_parent trace
    const returnTraces = filterTraces(traceCollector.traces, 'return_to_parent');
    expect(returnTraces.length).toBe(1);
    expect(returnTraces[0].data).toEqual({
      from: 'CreditCardAgent',
      to: 'BankingAdvisor',
      reason: 'Weather questions are outside payment scope',
      forwardedMessage: "what's the weather like?",
    });
  });
});

// =============================================================================
// NEGATIVE / EDGE CASE TESTS
// =============================================================================

describe('Negative: return-to-parent edge cases', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  test('__return_to_parent__ tool is NOT available for permanent handoff (RETURN: false)', async () => {
    const permanentSupervisor = `
SUPERVISOR: PermRouter

GOAL: "Route requests permanently"

PERSONA: "Permanent routing supervisor"

HANDOFF:
  - TO: PermanentChild
    WHEN: intent.category == "help"
    CONTEXT:
      pass: []
      summary: "User needs help"
    RETURN: false
`;

    const permanentChild = `
AGENT: PermanentChild

GOAL: "Help user permanently"

PERSONA: "Permanent helper"

GATHER:
  question:
    prompt: "What do you need?"
    type: string
    required: true
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([permanentSupervisor], 'PermRouter'),
    );
    executor.registerAgent('PermanentChild', permanentChild);
    session.handoffReturnInfo = { PermanentChild: false };
    session.conversationHistory.push({ role: 'user', content: 'help me' });

    let childTools: unknown[] = [];
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      if (systemPrompt.includes('Permanent helper')) {
        childTools = tools;
      }
      return {
        text: 'How can I help?',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'How can I help?' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    await handleHandoff(
      session,
      { target: 'PermanentChild', message: 'help me' },
      undefined,
      undefined,
    );

    // Child should NOT have __return_to_parent__ since RETURN: false
    const returnTool = (childTools as any[]).find((t) => t.name === SYSTEM_TOOL_RETURN_TO_PARENT);
    expect(returnTool).toBeUndefined();

    // Parent thread should be completed (permanent handoff), not waiting
    expect(session.threads[0].status).toBe('completed');
    expect(session.threadStack.length).toBe(0);
  });

  test('__return_to_parent__ fails gracefully if child has no parent on threadStack', async () => {
    // Scenario: somehow the threadStack is empty but child calls return_to_parent
    const session = createBankingSupervisorSession(executor, CREDIT_CARD_AGENT);
    executor.registerAgent('CreditCardAgent', CREDIT_CARD_AGENT);
    session.handoffReturnInfo = { CreditCardAgent: true };
    session.conversationHistory.push({ role: 'user', content: 'pay card' });

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      return {
        text: 'Processing.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Processing.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay card' },
      undefined,
      undefined,
    );

    // Corrupt state: clear the threadStack so return has no parent
    session.threadStack = [];

    // Call handleReturnToParent directly
    const routing = (executor as any).routing;
    const result = routing.handleReturnToParent(
      session,
      { reason: 'out of scope', message: 'test' },
      undefined,
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('No parent to return to.');
  });

  test('return_to_parent on standalone agent (not a handoff child) does nothing', async () => {
    // Standalone agent — not invoked via handoff, no returnExpected, no handoffFrom
    const standaloneAgent = `
AGENT: StandaloneBot

GOAL: "Help users directly"

PERSONA: "Direct helper"

GATHER:
  query:
    prompt: "What do you need?"
    type: string
    required: true
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([standaloneAgent], 'StandaloneBot'),
    );
    await executor.initializeSession(session.id);

    // Verify the standalone agent has no __return_to_parent__ tool
    const { buildTools } = await import('../../services/execution/prompt-builder.js');
    const tools = buildTools(session);
    const returnTool = tools.find((t) => t.name === SYSTEM_TOOL_RETURN_TO_PARENT);
    expect(returnTool).toBeUndefined();

    // Verify handleReturnToParent returns error for standalone agent
    const routing = (executor as any).routing;
    const result = routing.handleReturnToParent(
      session,
      { reason: 'test', message: 'test' },
      undefined,
    );
    expect(result.success).toBe(false);
  });

  test('thread resume does not match completed threads (only waiting)', async () => {
    const session = createBankingSupervisorSession(executor, CREDIT_CARD_AGENT);
    executor.registerAgent('CreditCardAgent', CREDIT_CARD_AGENT);
    session.handoffReturnInfo = { CreditCardAgent: true };
    session.conversationHistory.push({ role: 'user', content: 'pay' });

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      return {
        text: 'Done.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Done.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const traceCollector = createTraceCollector();

    // First handoff — child responds normally
    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay' },
      undefined,
      traceCollector.callback,
    );

    // Manually mark child as completed (simulating normal completion, not waiting)
    session.threads[1].status = 'completed';
    session.threads[1].endedAt = Date.now();
    // Return to supervisor manually
    session.threadStack.pop();
    session.handoffStack = session.handoffStack.slice(0, -1);
    session.threads[0].status = 'active';
    session.activeThreadIndex = 0;
    session.agentName = 'BankingAdvisor';
    session.agentIR = session.threads[0].agentIR;
    session.llmClient = undefined;

    // Second handoff to same agent — should create NEW thread (not resume completed one)
    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay again' },
      undefined,
      traceCollector.callback,
    );

    // No thread_resume trace — completed threads are not resumable
    const resumeTraces = filterTraces(traceCollector.traces, 'thread_resume');
    expect(resumeTraces.length).toBe(0);

    // New thread created (total 3: supervisor + completed child + new child)
    expect(session.threads.length).toBe(3);
    expect(session.threads[2].agentName).toBe('CreditCardAgent');
    expect(session.threads[2].status).toBe('active');
    // A completed thread is not resumed in place; a distinct replacement thread is created.
    expect(session.threads[2]).not.toBe(session.threads[1]);
    expect(session.threads[2].endedAt).toBeUndefined();
    expect(session.activeThreadIndex).toBe(2);
  });

  test('double return_to_parent does not corrupt state', async () => {
    const session = createBankingSupervisorSession(executor, CREDIT_CARD_AGENT);
    executor.registerAgent('CreditCardAgent', CREDIT_CARD_AGENT);
    session.handoffReturnInfo = { CreditCardAgent: true };
    session.conversationHistory.push({ role: 'user', content: 'pay' });

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      return {
        text: 'Processing.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Processing.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay' },
      undefined,
      undefined,
    );

    const routing = (executor as any).routing;

    // First return — should succeed
    const result1 = routing.handleReturnToParent(
      session,
      { reason: 'out of scope', message: 'balance?' },
      undefined,
    );
    expect(result1.success).toBe(true);
    expect(session.threads[1].status).toBe('waiting');

    // Second return on the same already-waiting thread — should fail
    // because threadStack was NOT popped by handleReturnToParent (it's done by the caller)
    // But the thread is already waiting, so calling it again should still "succeed"
    // since the guard checks returnExpected && threadStack.length > 0
    // The important thing is it doesn't throw or corrupt state
    const result2 = routing.handleReturnToParent(
      session,
      { reason: 'still out of scope', message: 'another question' },
      undefined,
    );
    // Still succeeds (idempotent — thread stays waiting, forwarded message updated)
    expect(result2.success).toBe(true);
    expect(session.threads[1].status).toBe('waiting');
    // Forwarded message is overwritten (last write wins)
    expect(session.threads[1].data.values._forwarded_message).toBe('another question');
  });

  test('return_to_parent with empty message still returns successfully', async () => {
    const session = createBankingSupervisorSession(executor, CREDIT_CARD_AGENT);
    executor.registerAgent('CreditCardAgent', CREDIT_CARD_AGENT);
    session.handoffReturnInfo = { CreditCardAgent: true };
    session.conversationHistory.push({ role: 'user', content: 'pay' });

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      return {
        text: 'OK.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'OK.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay' },
      undefined,
      undefined,
    );

    const routing = (executor as any).routing;
    const result = routing.handleReturnToParent(
      session,
      { reason: 'cannot handle', message: '' },
      undefined,
    );

    expect(result.success).toBe(true);
    expect(result.forwardedMessage).toBe('');
    // Empty forwarded message stored but won't be injected into parent conversation
    // (the forwarding code checks `typeof forwardedMsg === 'string'` — empty string is truthy for typeof check)
    expect(session.threads[1].data.values._forwarded_message).toBe('');
  });

  test('scripted flow child auto-routes a gather digression back through the parent supervisor', async () => {
    const session = createBankingSupervisorSession(
      executor,
      FLOW_CREDIT_CARD_AGENT,
      FLOW_ACCOUNT_INFO_AGENT,
    );
    executor.registerAgent('CreditCardAgent', FLOW_CREDIT_CARD_AGENT);
    executor.registerAgent('AccountInfoAgent', FLOW_ACCOUNT_INFO_AGENT);
    session.handoffReturnInfo = { CreditCardAgent: true, AccountInfoAgent: true };
    session.conversationHistory.push({ role: 'user', content: 'pay my card' });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const traceCollector = createTraceCollector();

    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay my card' },
      undefined,
      traceCollector.callback,
    );

    expect(session.agentName).toBe('CreditCardAgent');
    expect(session.waitingForInput).toEqual(['phone']);

    const result = await executor.executeMessage(
      session.id,
      "what's my balance?",
      undefined,
      traceCollector.callback,
    );

    expect(result.action?.type).toBe('handoff');
    expect(result.action?.target).toBe('AccountInfoAgent');
    expect(result.response).toContain('I can help with your balance.');

    expect(session.threads).toHaveLength(3);
    expect(session.agentName).toBe('BankingAdvisor');
    expect(session.activeThreadIndex).toBe(0);

    expect(session.threads[1].agentName).toBe('CreditCardAgent');
    expect(session.threads[1].status).toBe('waiting');
    expect(session.threads[1].data.values.phone).toBeUndefined();

    expect(session.threads[2].agentName).toBe('AccountInfoAgent');
    expect(session.threads[2].status).toBe('completed');

    const returnTraces = filterTraces(traceCollector.traces, 'return_to_parent');
    expect(returnTraces).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          from: 'CreditCardAgent',
          to: 'BankingAdvisor',
          forwardedMessage: "what's my balance?",
        }),
      }),
    );
  });

  test('scripted flow child surfaces a reroute setup error instead of silently collecting when scope is missing', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [BANKING_SUPERVISOR, FLOW_CREDIT_CARD_AGENT, FLOW_ACCOUNT_INFO_AGENT],
        'BankingAdvisor',
      ),
    );
    executor.registerAgent('CreditCardAgent', FLOW_CREDIT_CARD_AGENT);
    executor.registerAgent('AccountInfoAgent', FLOW_ACCOUNT_INFO_AGENT);
    session.handoffReturnInfo = { CreditCardAgent: true, AccountInfoAgent: true };
    session.conversationHistory.push({ role: 'user', content: 'pay my card' });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const traceCollector = createTraceCollector();

    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay my card' },
      undefined,
      traceCollector.callback,
    );

    const result = await executor.executeMessage(
      session.id,
      "what's my balance?",
      undefined,
      traceCollector.callback,
    );

    expect(result.action?.type).toBe('error');
    expect(result.response).toContain('tenantId');
    expect(result.response).toContain('projectId');
    expect(session.agentName).toBe('BankingAdvisor');
    expect(session.activeThreadIndex).toBe(0);
    expect(session.threads).toHaveLength(2);
    expect(session.threads[1].status).toBe('waiting');
  });

  test('scripted flow child later-turn completion trims the completed child from handoffStack', async () => {
    const session = createBankingSupervisorSession(executor, FLOW_CREDIT_CARD_AGENT);
    executor.registerAgent('CreditCardAgent', FLOW_CREDIT_CARD_AGENT);
    session.handoffReturnInfo = { CreditCardAgent: true };
    session.conversationHistory.push({ role: 'user', content: 'pay my card' });
    setEntityExtractionHandler(mockClient, (userText) => /^\d{10}$/.test(userText));

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const traceCollector = createTraceCollector();

    const initialHandoff = await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay my card' },
      undefined,
      traceCollector.callback,
    );

    expect(initialHandoff.success).toBe(true);
    expect(session.agentName).toBe('CreditCardAgent');
    expect(session.waitingForInput).toEqual(['phone']);
    expect(session.handoffStack).toEqual(['BankingAdvisor', 'CreditCardAgent']);

    await executor.executeMessage(session.id, '5551112222', undefined, traceCollector.callback);

    const returnTraces = filterTraces(traceCollector.traces, 'thread_return');
    expect(returnTraces).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          from: 'CreditCardAgent',
          to: 'BankingAdvisor',
        }),
      }),
    );

    expect(session.agentName).toBe('BankingAdvisor');
    expect(session.activeThreadIndex).toBe(0);
    expect(session.threads[1].status).toBe('completed');
    expect(session.threads[1].data.values.phone).toBe('5551112222');
    expect(session.handoffStack).toEqual(['BankingAdvisor']);
  });

  test('scripted flow child later-turn completion allows a fresh handoff to the same child', async () => {
    const session = createBankingSupervisorSession(executor, FLOW_CREDIT_CARD_AGENT);
    executor.registerAgent('CreditCardAgent', FLOW_CREDIT_CARD_AGENT);
    session.handoffReturnInfo = { CreditCardAgent: true };
    session.conversationHistory.push({ role: 'user', content: 'pay my card' });
    setEntityExtractionHandler(mockClient, (userText) => /^\d{10}$/.test(userText));

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const traceCollector = createTraceCollector();

    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay my card' },
      undefined,
      traceCollector.callback,
    );
    await executor.executeMessage(session.id, '5551112222', undefined, traceCollector.callback);

    const secondHandoff = await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay another card' },
      undefined,
      traceCollector.callback,
    );

    expect(secondHandoff.success).toBe(true);
    expect(secondHandoff.error).toBeUndefined();
    expect(session.threads).toHaveLength(3);
    expect(session.activeThreadIndex).toBe(2);
    expect(session.threads[2].agentName).toBe('CreditCardAgent');
    expect(session.threads[2].status).toBe('active');
    expect(session.waitingForInput).toEqual(['phone']);
  });

  test('scripted flow child surfaces lexical sibling reroute failures instead of returning fake handoff success', async () => {
    const session = createBankingSupervisorSession(executor, FLOW_CREDIT_CARD_AGENT);
    executor.registerAgent('CreditCardAgent', FLOW_CREDIT_CARD_AGENT);
    session.handoffReturnInfo = { CreditCardAgent: true, AccountInfoAgent: true };
    session.conversationHistory.push({ role: 'user', content: 'pay my card' });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const traceCollector = createTraceCollector();

    await handleHandoff(
      session,
      { target: 'CreditCardAgent', message: 'pay my card' },
      undefined,
      traceCollector.callback,
    );

    expect(session.agentName).toBe('CreditCardAgent');
    expect(session.waitingForInput).toEqual(['phone']);

    const result = await executor.executeMessage(
      session.id,
      "what's my balance?",
      undefined,
      traceCollector.callback,
    );

    expect(result.action?.type).toBe('error');
    expect(result.response).toContain('Agent not found: AccountInfoAgent');
    expect(session.threads).toHaveLength(2);
    expect(session.agentName).toBe('BankingAdvisor');
    expect(session.activeThreadIndex).toBe(0);
    expect(session.threads[1].agentName).toBe('CreditCardAgent');
    expect(session.threads[1].status).toBe('waiting');
    expect(
      session.threads[0].conversationHistory.some(
        (message) =>
          message.role === 'assistant' &&
          String(message.content).includes('Agent not found: AccountInfoAgent'),
      ),
    ).toBe(true);

    const returnTraces = filterTraces(traceCollector.traces, 'return_to_parent');
    expect(returnTraces).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          from: 'CreditCardAgent',
          to: 'BankingAdvisor',
          forwardedMessage: "what's my balance?",
        }),
      }),
    );
  });
});

// =============================================================================
// ABLP-690 FIXTURES
// =============================================================================

const DIGRESSION_SUPERVISOR = `
SUPERVISOR: DigressionSupervisor

GOAL: "Route requests to specialist agents"

PERSONA: "Routing supervisor"

HANDOFF:
  - TO: MoneyTransferAgent
    WHEN: intent.category == "transfer"
    RETURN: true
    ON_RETURN:
      action: resume_intent

  - TO: CreditCardAgent
    WHEN: intent.category == "credit_card"
    RETURN: true
`;

const DIGRESSION_SUPERVISOR_NO_LEXICAL = `
SUPERVISOR: DigressionSupervisor

GOAL: "Route requests to specialist agents"

PERSONA: "Routing supervisor"

INTENTS:
  LEXICAL_FALLBACK: never

HANDOFF:
  - TO: MoneyTransferAgent
    WHEN: intent.category == "transfer"
    RETURN: true
    ON_RETURN:
      action: resume_intent

  - TO: CreditCardAgent
    WHEN: intent.category == "credit_card"
    RETURN: true
`;

const MONEY_TRANSFER_AGENT_DSL = `
AGENT: MoneyTransferAgent

GOAL: "Help customers transfer money. Use __return_to_parent__ for out-of-scope requests."

PERSONA: "Transfer specialist"

GATHER:
  transfer_amount:
    prompt: "How much would you like to transfer?"
    type: string
    required: true
`;

const CREDIT_CARD_AGENT_DSL = `
AGENT: CreditCardAgent

GOAL: "Help customers with credit card payments"

PERSONA: "Credit card specialist"
`;

// =============================================================================
// ABLP-690: user_message trace event regression tests
// =============================================================================

describe('ABLP-690: user_message trace event for child-agent digression turns', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  test('pre-routing path: user_message emitted exactly once when lexical match intercepts digression', async () => {
    // Bug: when handleActiveReasoningChildParentReroute returned early (pre-routing),
    // user_message was never emitted. Fix: user_message is emitted BEFORE the pre-routing check.
    const scope = { tenantId: 'tenant-ablp690-pre', projectId: 'project-ablp690-pre' };
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [DIGRESSION_SUPERVISOR, MONEY_TRANSFER_AGENT_DSL, CREDIT_CARD_AGENT_DSL],
        'DigressionSupervisor',
      ),
      scope,
    );
    executor.registerAgent('MoneyTransferAgent', MONEY_TRANSFER_AGENT_DSL);
    executor.registerAgent('CreditCardAgent', CREDIT_CARD_AGENT_DSL);
    session.handoffReturnInfo = { MoneyTransferAgent: true, CreditCardAgent: true };

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      if ((tools as any[]).some((t) => t.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      return {
        text: 'How can I assist you?',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'How can I assist you?' }],
      };
    });

    // Turn 1: handoff to MoneyTransferAgent so it becomes the active child
    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    await handleHandoff(
      session,
      { target: 'MoneyTransferAgent', message: 'I want to transfer money' },
      undefined,
      undefined,
    );
    expect(session.agentName).toBe('MoneyTransferAgent');

    // Turn 2: user says something that lexically matches the credit_card category
    // ("credit" and "card" are tokens from category "credit_card").
    // handleActiveReasoningChildParentReroute fires and returns early — the ABLP-690 bug path.
    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'I need to pay my credit card bill',
      undefined,
      traceCollector.callback,
    );

    // ABLP-690 regression: user_message must be emitted exactly once even when
    // pre-routing intercepts the turn and returns before any child LLM call.
    const userMessageTraces = filterTraces(traceCollector.traces, 'user_message');
    expect(userMessageTraces).toHaveLength(1);
    expect(userMessageTraces[0].data.message).toBe('I need to pay my credit card bill');
  });

  test('resume_intent path: user_message emitted exactly once when child calls __return_to_parent__ with ON_RETURN: resume_intent', async () => {
    // LEXICAL_FALLBACK: never disables pre-routing, forcing the child LLM to run.
    // When the child calls __return_to_parent__ and the supervisor has ON_RETURN: resume_intent,
    // an inner executeMessage fires with { resumeIntentReplay: true }.
    // That inner call must NOT emit a second user_message trace.
    const scope = { tenantId: 'tenant-ablp690-resume', projectId: 'project-ablp690-resume' };
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [DIGRESSION_SUPERVISOR_NO_LEXICAL, MONEY_TRANSFER_AGENT_DSL, CREDIT_CARD_AGENT_DSL],
        'DigressionSupervisor',
      ),
      scope,
    );
    executor.registerAgent('MoneyTransferAgent', MONEY_TRANSFER_AGENT_DSL);
    executor.registerAgent('CreditCardAgent', CREDIT_CARD_AGENT_DSL);
    session.handoffReturnInfo = { MoneyTransferAgent: true, CreditCardAgent: true };

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const toolNames = (tools as any[]).map((t) => t.name);

      // Entity extraction: always return empty
      if (toolNames.includes('_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }

      // MoneyTransferAgent sees out-of-scope request: call __return_to_parent__.
      // Guard on message content so Turn 1 ("transfer money") gets a normal response
      // while Turn 2 ("credit card help") triggers the return-to-parent.
      if (toolNames.includes(SYSTEM_TOOL_RETURN_TO_PARENT)) {
        const lastUser = (messages as any[]).filter((m) => m.role === 'user').pop();
        const content = typeof lastUser?.content === 'string' ? lastUser.content : '';
        if (content.includes('credit card')) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'return-ablp690',
                name: SYSTEM_TOOL_RETURN_TO_PARENT,
                input: {
                  reason: 'Credit card requests are outside my scope',
                  message: 'I want credit card help',
                },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'return-ablp690',
                name: SYSTEM_TOOL_RETURN_TO_PARENT,
                input: {
                  reason: 'Credit card requests are outside my scope',
                  message: 'I want credit card help',
                },
              },
            ],
          };
        }
        // Turn 1: normal response, agent keeps gathering
        return {
          text: 'How much would you like to transfer?',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'How much would you like to transfer?' }],
        };
      }

      // Supervisor inner resume_intent call: route to CreditCardAgent
      if (toolNames.includes(SYSTEM_TOOL_HANDOFF)) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'handoff-ablp690',
              name: SYSTEM_TOOL_HANDOFF,
              input: { target: 'CreditCardAgent', message: 'I want credit card help' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'handoff-ablp690',
              name: SYSTEM_TOOL_HANDOFF,
              input: { target: 'CreditCardAgent', message: 'I want credit card help' },
            },
          ],
        };
      }

      // Default: CreditCardAgent response
      return {
        text: 'I can help with your credit card.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'I can help with your credit card.' }],
      };
    });

    // Turn 1: handoff to MoneyTransferAgent so it becomes the active child
    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    await handleHandoff(
      session,
      { target: 'MoneyTransferAgent', message: 'I want to transfer money' },
      undefined,
      undefined,
    );
    expect(session.agentName).toBe('MoneyTransferAgent');

    // Turn 2: user sends an out-of-scope message.
    // LEXICAL_FALLBACK: never → no pre-routing → MoneyTransferAgent LLM runs →
    // calls __return_to_parent__ → supervisor resumes with ON_RETURN: resume_intent →
    // inner executeMessage fires with { resumeIntentReplay: true }.
    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'I want credit card help',
      undefined,
      traceCollector.callback,
    );

    // ABLP-690 regression: user_message must be emitted exactly once.
    // The inner resume_intent executeMessage must NOT emit a second user_message.
    const userMessageTraces = filterTraces(traceCollector.traces, 'user_message');
    expect(userMessageTraces).toHaveLength(1);
    expect(userMessageTraces[0].data.message).toBe('I want credit card help');

    // The resume_intent trace must be emitted exactly once with the correct attribution.
    const resumeIntentTraces = filterTraces(traceCollector.traces, 'resume_intent');
    expect(resumeIntentTraces).toHaveLength(1);
    expect(resumeIntentTraces[0].data.from).toBe('MoneyTransferAgent');
  });
});
