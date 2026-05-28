/**
 * Handoff Return Propagation Regression Tests
 *
 * Validates the fix from PR #381 (fix/handoff-return-propagation):
 *
 * Problem: In multi-agent workflows with 3-level handoff chains
 * (supervisor → specialist → auth), after the auth agent completes
 * across multiple turns, the system returns to the supervisor instead
 * of resuming the specialist (account_inquiry) that initiated the auth handoff.
 *
 * Root cause: resume_intent dispatch in handleHandoff only fires on the
 * first message that triggers a handoff. Multi-turn child agents that complete
 * via tryThreadReturn (inside reasoning.execute) bypass handleHandoff entirely,
 * so the resume_intent re-routing never fires.
 *
 * Fix: post-turn detection in runtime-executor.executeMessage detects thread
 * return (session.agentName changed) and replays the original intent.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { SYSTEM_TOOL_RETURN_TO_PARENT } from '@abl/compiler';
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

// =============================================================================
// ABL FIXTURES — 3-level handoff chain: Supervisor → Account_Inquiry → Auth
// =============================================================================

/**
 * Bank supervisor routes "account balance" requests to Account_Inquiry.
 * ON_RETURN: resume_intent ensures that after Account_Inquiry completes,
 * the original user message is re-processed for further routing.
 */
const BANK_SUPERVISOR = `
SUPERVISOR: Bank_Supervisor

GOAL: "Route banking requests to specialist agents"

PERSONA: "Professional banking assistant"

HANDOFF:
  - TO: Account_Inquiry
    WHEN: intent.category == "balance"
    CONTEXT:
      pass: [customer_id]
      summary: "User wants account balance"
    RETURN: true
    ON_RETURN:
      ACTION: resume_intent
`;

/**
 * Account_Inquiry handles balance lookups. It hands off to Auth_Agent
 * for identity verification before providing the balance.
 * RETURN: true means Auth_Agent will return here after completing.
 */
const ACCOUNT_INQUIRY = `
AGENT: Account_Inquiry

GOAL: "Provide account balance after authentication"

PERSONA: "Account specialist"

GATHER:
  authenticated:
    prompt: "Verifying identity..."
    type: string
    required: true

HANDOFF:
  - TO: Auth_Agent
    WHEN: authenticated IS NOT SET
    CONTEXT:
      pass: []
      summary: "Verify customer identity"
    RETURN: true

COMPLETE:
  - WHEN: authenticated == "yes"
    RESPOND: "Your account balance is $5,000."
`;

const ACCOUNT_INQUIRY_AUTOCOMPLETE_ONLY = `
AGENT: Account_Inquiry

GOAL: "Provide account balance after authentication"

PERSONA: "Account specialist"

GATHER:
  authenticated:
    prompt: "Verifying identity..."
    type: string
    required: true

COMPLETE:
  - WHEN: authenticated == "yes"
    RESPOND: "Your account balance is $5,000."
`;

const ACCOUNT_INQUIRY_MANUAL_HANDOFF = `
AGENT: Account_Inquiry

GOAL: "Provide account balance after authentication"

PERSONA: "Account specialist"

HANDOFF:
  - TO: Auth_Agent
    WHEN: input contains "verify"
    CONTEXT:
      pass: []
      summary: "Verify customer identity"
    RETURN: true
`;

/**
 * Auth_Agent verifies user identity. This is a multi-turn agent —
 * it asks for a PIN and then verifies it across two user turns.
 */
const AUTH_AGENT = `
AGENT: Auth_Agent

GOAL: "Verify customer identity by asking for PIN"

PERSONA: "Security verification specialist"

GATHER:
  pin:
    prompt: "Please enter your 4-digit PIN for verification."
    type: string
    required: true

COMPLETE:
  - WHEN: pin IS SET
    RESPOND: "Identity verified successfully."
`;

const REENTRY_SUPERVISOR = `
SUPERVISOR: Reentry_Supervisor

GOAL: "Route verification requests to the account inquiry child"

PERSONA: "Verification routing supervisor"

HANDOFF:
  - TO: Account_Inquiry
    WHEN: intent.category == "verify"
    CONTEXT:
      pass: []
      summary: "User needs verification"
    RETURN: true
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Handoff Return Propagation Regression (PR #381)', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  /**
   * REGRESSION TEST: Multi-turn auth in 3-level chain
   *
   * Flow:
   *   Setup: bank_supervisor → Account_Inquiry → Auth_Agent (via handleHandoff)
   *   Turn: User provides PIN "1234"
   *     → Auth_Agent extracts pin, auto-completes
   *     → tryThreadReturn fires: Auth_Agent → Account_Inquiry (pops one level)
   *     → session.agentName should be Account_Inquiry, NOT Bank_Supervisor
   *
   * Without the fix: tryThreadReturn may not properly restore the mid-level
   * agent, or the resume_intent dispatch skips the mid-level entirely.
   */
  test('after multi-turn auth completes, control returns to Account_Inquiry (not supervisor)', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([BANK_SUPERVISOR], 'Bank_Supervisor'),
    );
    executor.registerAgent('Account_Inquiry', ACCOUNT_INQUIRY);
    executor.registerAgent('Auth_Agent', AUTH_AGENT);
    session.handoffReturnInfo = { Account_Inquiry: true };

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      // Entity extraction: extract pin when user provides digits
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
        const content = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
        const pinMatch = content.match(/\b(\d{4})\b/);

        if (pinMatch) {
          // Return extracted pin via tool call
          return {
            text: '',
            toolCalls: [
              {
                id: 'extract-1',
                name: '_extract_entities',
                input: { pin: pinMatch[1] },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'extract-1',
                name: '_extract_entities',
                input: { pin: pinMatch[1] },
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

      // Account_Inquiry — respond about balance
      if (systemPrompt.includes('Account specialist') || systemPrompt.includes('account balance')) {
        return {
          text: 'Let me verify your identity first.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Let me verify your identity first.' }],
        };
      }

      // Auth_Agent — ask for PIN or confirm verification
      if (
        systemPrompt.includes('Security verification') ||
        systemPrompt.includes('Verify customer')
      ) {
        return {
          text: 'Identity verified successfully.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Identity verified successfully.' }],
        };
      }

      // Bank_Supervisor fallback
      return {
        text: 'How can I help you today?',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'How can I help you today?' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const traceCollector = createTraceCollector();

    // --- Setup: Build the 3-level chain via explicit handleHandoff calls ---

    // Step 1: Supervisor → Account_Inquiry (RETURN: true)
    session.conversationHistory.push({ role: 'user', content: 'get account balance' });
    await handleHandoff(
      session,
      { target: 'Account_Inquiry', message: 'get account balance' },
      undefined,
      traceCollector.callback,
    );

    // Verify supervisor is waiting, Account_Inquiry is active
    expect(session.threads.length).toBeGreaterThanOrEqual(2);
    const supervisorThread = session.threads.find((t: any) => t.agentName === 'Bank_Supervisor');
    expect(supervisorThread?.status).toBe('waiting');

    // Step 2: Account_Inquiry → Auth_Agent (RETURN: true)
    session.handoffReturnInfo = { Auth_Agent: true };
    await handleHandoff(
      session,
      { target: 'Auth_Agent', message: 'verify identity' },
      undefined,
      traceCollector.callback,
    );

    // Verify 3-level chain: supervisor(waiting) → Account_Inquiry(waiting) → Auth_Agent(active)
    const accountThread = session.threads.find((t: any) => t.agentName === 'Account_Inquiry');
    expect(supervisorThread?.status).toBe('waiting');
    expect(accountThread?.status).toBe('waiting');
    expect(session.agentName).toBe('Auth_Agent');
    expect(session.threadStack.length).toBe(2);

    // --- Turn: User provides PIN → Auth_Agent should complete → return to Account_Inquiry ---
    const result = await executor.executeMessage(
      session.id,
      '1234',
      undefined,
      traceCollector.callback,
    );

    // CRITICAL ASSERTION: After auth completes, control should return to Account_Inquiry
    // NOT to Bank_Supervisor. The threadStack should have popped exactly one level.
    expect(session.agentName).not.toBe('Bank_Supervisor');
    expect(session.agentName).toBe('Account_Inquiry');
    expect(session.threadStack.length).toBe(1);
  });

  test('nested later-turn auth completion removes only Auth_Agent from handoffStack', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([BANK_SUPERVISOR], 'Bank_Supervisor'),
    );
    executor.registerAgent('Account_Inquiry', ACCOUNT_INQUIRY);
    executor.registerAgent('Auth_Agent', AUTH_AGENT);
    session.handoffReturnInfo = { Account_Inquiry: true };

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
        const content = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
        const pinMatch = content.match(/\b(\d{4})\b/);

        if (pinMatch) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'extract-1',
                name: '_extract_entities',
                input: { pin: pinMatch[1] },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'extract-1',
                name: '_extract_entities',
                input: { pin: pinMatch[1] },
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
        text: 'Identity verified successfully.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Identity verified successfully.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);

    session.conversationHistory.push({ role: 'user', content: 'get account balance' });
    await handleHandoff(session, {
      target: 'Account_Inquiry',
      message: 'get account balance',
    });

    session.handoffReturnInfo = { Auth_Agent: true };
    await handleHandoff(session, { target: 'Auth_Agent', message: 'verify identity' });

    expect(session.handoffStack).toEqual(['Bank_Supervisor', 'Account_Inquiry', 'Auth_Agent']);

    await executor.executeMessage(session.id, '1234');

    expect(session.agentName).toBe('Account_Inquiry');
    expect(session.threadStack.length).toBe(1);
    expect(session.handoffStack).toEqual(['Bank_Supervisor', 'Account_Inquiry']);
  });

  /**
   * Test that resume_intent dispatch fires in executeMessage after tryThreadReturn.
   *
   * Uses a simpler 2-level chain (supervisor → gate agent) to isolate the
   * post-turn resume_intent detection in runtime-executor.ts.
   */
  test('post-turn resume_intent dispatch fires when child auto-completes via tryThreadReturn', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([BANK_SUPERVISOR], 'Bank_Supervisor'),
    );
    executor.registerAgent('Account_Inquiry', ACCOUNT_INQUIRY_AUTOCOMPLETE_ONLY);
    session.handoffReturnInfo = { Account_Inquiry: true };

    // Track LLM calls to verify which agents execute
    const agentCalls: string[] = [];

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      // Entity extraction: extract 'authenticated' when user says "yes"
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
        const content = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';

        if (content.includes('yes') || content.includes('verified')) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'extract-1',
                name: '_extract_entities',
                input: { authenticated: 'yes' },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'extract-1',
                name: '_extract_entities',
                input: { authenticated: 'yes' },
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

      // Account_Inquiry
      if (systemPrompt.includes('Account specialist') || systemPrompt.includes('account balance')) {
        agentCalls.push('Account_Inquiry');
        return {
          text: 'Checking your balance...',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Checking your balance...' }],
        };
      }

      // Bank_Supervisor
      if (systemPrompt.includes('banking')) {
        agentCalls.push('Bank_Supervisor');
        return {
          text: 'How can I help?',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'How can I help?' }],
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

    // Setup: Supervisor → Account_Inquiry with RETURN: true + ON_RETURN: resume_intent
    session.conversationHistory.push({ role: 'user', content: 'get account balance' });
    await handleHandoff(
      session,
      { target: 'Account_Inquiry', message: 'get account balance' },
      undefined,
      traceCollector.callback,
    );
    expect(session.agentName).toBe('Account_Inquiry');

    // Clear call tracking for the actual test turn
    agentCalls.length = 0;

    // User confirms auth → Account_Inquiry extracts authenticated="yes" → auto-completes
    // → tryThreadReturn fires → returns to Bank_Supervisor
    // → resume_intent dispatch should replay "get account balance"
    await executor.executeMessage(session.id, 'yes verified', undefined, traceCollector.callback);

    // Check that resume_intent trace was emitted (the fix adds this detection)
    const resumeTraces = traceCollector.traces.filter((t) => t.type === 'resume_intent');

    // With the fix: resume_intent should fire after Account_Inquiry completes and
    // returns to Bank_Supervisor, re-processing the original "get account balance" message
    expect(resumeTraces.length).toBeGreaterThanOrEqual(1);
    if (resumeTraces.length > 0) {
      expect(resumeTraces[0].data.from).toBe('Account_Inquiry');
      expect(resumeTraces[0].data.parentAgent).toBe('Bank_Supervisor');
    }
  });

  test('post-turn reasoning auto-complete trims the completed child from handoffStack', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REENTRY_SUPERVISOR], 'Reentry_Supervisor'),
    );
    executor.registerAgent('Account_Inquiry', ACCOUNT_INQUIRY_AUTOCOMPLETE_ONLY);
    session.handoffReturnInfo = { Account_Inquiry: true };
    session.conversationHistory.push({ role: 'user', content: 'start verify' });

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
        const content = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';

        if (content.includes('yes') || content.includes('verified')) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'extract-1',
                name: '_extract_entities',
                input: { authenticated: 'yes' },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'extract-1',
                name: '_extract_entities',
                input: { authenticated: 'yes' },
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

      if (systemPrompt.includes('Account specialist') || systemPrompt.includes('account balance')) {
        return {
          text: 'Checking your balance...',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Checking your balance...' }],
        };
      }

      return {
        text: 'How can I help?',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'How can I help?' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);

    const initialHandoff = await handleHandoff(session, {
      target: 'Account_Inquiry',
      message: 'start verify',
    });

    expect(initialHandoff.success).toBe(true);
    expect(session.agentName).toBe('Account_Inquiry');
    expect(session.handoffStack).toEqual(['Reentry_Supervisor', 'Account_Inquiry']);

    await executor.executeMessage(session.id, 'yes verified');

    expect(session.agentName).toBe('Reentry_Supervisor');
    expect(session.activeThreadIndex).toBe(0);
    expect(session.threads[1].status).toBe('completed');
    expect(session.threads[1].data.values.authenticated).toBe('yes');
    expect(session.handoffStack).toEqual(['Reentry_Supervisor']);
  });

  test('post-turn reasoning auto-complete allows a fresh handoff to the same child', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REENTRY_SUPERVISOR], 'Reentry_Supervisor'),
    );
    executor.registerAgent('Account_Inquiry', ACCOUNT_INQUIRY_AUTOCOMPLETE_ONLY);
    session.handoffReturnInfo = { Account_Inquiry: true };
    session.conversationHistory.push({ role: 'user', content: 'start verify' });

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
        const content = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';

        if (content.includes('yes') || content.includes('verified')) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'extract-1',
                name: '_extract_entities',
                input: { authenticated: 'yes' },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'extract-1',
                name: '_extract_entities',
                input: { authenticated: 'yes' },
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
        text: 'Checking your balance...',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Checking your balance...' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);

    await handleHandoff(session, {
      target: 'Account_Inquiry',
      message: 'start verify',
    });
    await executor.executeMessage(session.id, 'yes verified');

    const secondHandoff = await handleHandoff(session, {
      target: 'Account_Inquiry',
      message: 'start verify again',
    });

    expect(secondHandoff.success).toBe(true);
    expect(secondHandoff.error).toBeUndefined();
    expect(session.threads).toHaveLength(3);
    expect(session.activeThreadIndex).toBe(2);
    expect(session.threads[2].agentName).toBe('Account_Inquiry');
    expect(session.threads[2].status).toBe('active');
  });

  /**
   * Test with single-turn scripted agents (deterministic, no LLM).
   * Validates that ON_RETURN: resume_intent fires via routing-executor
   * (the non-regressed path) for baseline coverage.
   */
  test('ON_RETURN: resume_intent fires for single-turn child (scripted baseline)', async () => {
    const supervisorDsl = `
AGENT: Scripted_Supervisor

GOAL: "Route with resume_intent"

FLOW:
  entry_point: detect
  steps:
    - detect

detect:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "check"
      SET: intent = "check"
      THEN: COMPLETE
    - ELSE:
      THEN: COMPLETE

HANDOFF:
  - TO: Gate_Agent
    WHEN: intent == "check"
    CONTEXT:
      pass: [intent]
    RETURN: true
    ON_RETURN:
      ACTION: resume_intent
`;

    const gateDsl = `
AGENT: Gate_Agent

GOAL: "Gate then complete"

FLOW:
  entry_point: done
  steps:
    - done

done:
  RESPOND: "Gate passed."
  THEN: COMPLETE
`;

    executor.registerAgent('Gate_Agent', gateDsl);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([supervisorDsl, gateDsl], 'Scripted_Supervisor'),
    );
    await executor.initializeSession(session.id);

    const traceCollector = createTraceCollector();
    const chunks: string[] = [];

    await executor.executeMessage(
      session.id,
      'check status',
      (c) => chunks.push(c),
      traceCollector.callback,
    );

    // A resume_intent trace event should have been emitted
    const resumeTraces = traceCollector.traces.filter((t) => t.type === 'resume_intent');
    expect(resumeTraces.length).toBeGreaterThanOrEqual(1);
    expect(resumeTraces[0].data.from).toBe('Gate_Agent');
    expect(resumeTraces[0].data.parentAgent).toBe('Scripted_Supervisor');
  });

  /**
   * Verify threadStack is correctly maintained during 3-level handoff.
   * Tests the data structure invariants without relying on auto-completion.
   */
  test('threadStack has correct depth during 3-level handoff chain', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([BANK_SUPERVISOR], 'Bank_Supervisor'),
    );
    executor.registerAgent('Account_Inquiry', ACCOUNT_INQUIRY_MANUAL_HANDOFF);
    executor.registerAgent('Auth_Agent', AUTH_AGENT);
    session.handoffReturnInfo = { Account_Inquiry: true };

    // Stub LLM to return default responses (no entity extraction)
    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      return {
        text: 'Ok.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Ok.' }],
      };
    });

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);

    // Level 1: Supervisor → Account_Inquiry
    session.conversationHistory.push({ role: 'user', content: 'get account balance' });
    await handleHandoff(session, { target: 'Account_Inquiry', message: 'balance' });

    expect(session.threadStack.length).toBe(1);
    expect(session.agentName).toBe('Account_Inquiry');
    expect(session.threads[0].agentName).toBe('Bank_Supervisor');
    expect(session.threads[0].status).toBe('waiting');

    // Level 2: Account_Inquiry → Auth_Agent
    session.handoffReturnInfo = { Auth_Agent: true };
    await handleHandoff(session, { target: 'Auth_Agent', message: 'verify' });

    expect(session.threadStack.length).toBe(2);
    expect(session.agentName).toBe('Auth_Agent');

    // All three threads exist with correct statuses
    const threads = session.threads;
    const supervisor = threads.find((t: any) => t.agentName === 'Bank_Supervisor');
    const inquiry = threads.find((t: any) => t.agentName === 'Account_Inquiry');
    const auth = threads.find((t: any) => t.agentName === 'Auth_Agent');

    expect(supervisor?.status).toBe('waiting');
    expect(inquiry?.status).toBe('waiting');
    expect(auth?.status).not.toBe('waiting'); // active or completed
  });
});
