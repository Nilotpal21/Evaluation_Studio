/**
 * Flow Child Agent Resume Intent Tests
 *
 * Validates that when a multi-turn scripted (flow-based) child agent completes
 * across multiple user messages and returns to a reasoning parent, the parent's
 * ON_RETURN: resume_intent fires correctly — re-executing the parent with the
 * original user intent so the parent can continue without the user repeating.
 *
 * Bug: The resume_intent dispatch only existed in the reasoning executor path.
 * Multi-turn flow agents complete inside the flow executor path (executeFlowStep),
 * which returned directly without checking for thread returns. The parent agent
 * would sit idle, producing an empty response.
 *
 * Fix: Added post-flow resume_intent dispatch in runtime-executor.ts after
 * executeFlowStep returns.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';

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

// =============================================================================
// ABL FIXTURES
// =============================================================================

/**
 * Parent reasoning agent that hands off to a scripted child with
 * RETURN: true and ON_RETURN: resume_intent.
 */
const PARENT_SUPERVISOR = `
AGENT: Supervisor

GOAL: "Route requests to specialist agents. After authentication completes, call get_data tool with customer_id."

PERSONA: "Professional routing assistant"

TOOLS:
  get_data(customer_id: string) -> object
    type: sandbox
    description: "Retrieve data for an authenticated customer"

HANDOFF:
  - TO: AuthAgent
    WHEN: is_authenticated != "true" AND is_authenticated != true
    CONTEXT:
      pass: [request_type]
      summary: "User needs authentication"
    RETURN: true
    ON_RETURN:
      ACTION: resume_intent
      MAP: { is_authenticated: is_authenticated, customer_id: customer_id }

MEMORY:
  session:
    - is_authenticated
      TYPE: boolean
      DESCRIPTION: "Whether user is authenticated"
    - customer_id
      TYPE: string
      DESCRIPTION: "Authenticated customer ID"
    - request_type
      TYPE: string
      DESCRIPTION: "What the user originally requested"
`;

/**
 * Multi-turn scripted child agent that requires two user messages:
 * 1. Collect username
 * 2. Collect passcode
 * Then completes with is_authenticated and customer_id set.
 */
const AUTH_AGENT_FLOW = `
AGENT: AuthAgent
LANGUAGE: "en-US"
VERSION: "3.0"
DESCRIPTION: "Multi-turn scripted authentication requiring username and passcode"

PERSONA: "Authentication specialist"

GOAL: "Authenticate user via username and passcode"

EXECUTION:
  model: claude-sonnet-4-5
  temperature: 0.1
  max_tokens: 200
  inline_gather: true

MEMORY:
  session:
    - customer_id
      TYPE: string
      DESCRIPTION: "Customer ID after auth"
    - is_authenticated
      TYPE: boolean
      DESCRIPTION: "Auth status"

FLOW:
  entry_point: ask_username
  steps:
    - ask_username
    - ask_passcode
    - auth_complete

ask_username:
  REASONING: false
  GATHER:
    - username: required
      prompt: "Please enter your username."
      type: string
  THEN: ask_passcode

ask_passcode:
  REASONING: false
  GATHER:
    - passcode: required
      prompt: "Please enter your passcode."
      type: string
      sensitive: true
  THEN: auth_complete

auth_complete:
  REASONING: false
  SET: is_authenticated = true
  SET: customer_id = cust-123
  RESPOND: "You are now authenticated."
  THEN: complete

COMPLETE:
  - WHEN: is_authenticated == "true" OR is_authenticated == true
    RESPOND: "Authentication successful."
`;

const LEAVE_SUPERVISOR = `
AGENT: LeaveSupervisor

GOAL: "Route leave-related requests to the correct specialist."

PERSONA: "Leave request supervisor"

HANDOFF:
  - TO: LeaveApplication
    WHEN: true
    RETURN: true

  - TO: LeaveBalance
    WHEN: true
    RETURN: true
`;

const LEAVE_APPLICATION_FLOW = `
AGENT: LeaveApplication

GOAL: "Collect leave application details"

FLOW:
  entry_point: collect_leave_reason
  steps:
    - collect_leave_reason

collect_leave_reason:
  REASONING: false
  GATHER:
    - leave_reason: required
      prompt: "What is the reason for your leave application?"
      type: string
  THEN: COMPLETE
`;

const LEAVE_BALANCE_FLOW = `
AGENT: LeaveBalance

GOAL: "Answer leave balance questions"

FLOW:
  entry_point: respond_balance
  steps:
    - respond_balance

respond_balance:
  REASONING: false
  RESPOND: "LeaveBalance checked the available leave balance."
  THEN: COMPLETE
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Flow Child Agent Resume Intent', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  test('parent resumes with original intent after multi-turn flow child completes', async () => {
    // Setup: parent reasoning agent + child flow agent
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([PARENT_SUPERVISOR], 'Supervisor'),
    );
    executor.registerAgent('AuthAgent', AUTH_AGENT_FLOW);
    session.handoffReturnInfo = { AuthAgent: true };

    let callCount = 0;
    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      callCount++;

      // Entity extraction calls — extract the value from user message
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        const lastUserMsg = _messages.filter((m: any) => m.role === 'user').pop();
        const userText =
          typeof lastUserMsg?.content === 'string'
            ? lastUserMsg.content
            : Array.isArray(lastUserMsg?.content)
              ? (lastUserMsg.content as any[]).find((c: any) => c.type === 'text')?.text || ''
              : '';

        const extractTool = tools.find((t: any) => t.name === '_extract_entities') as any;
        const props = extractTool?.input_schema?.properties || {};
        const fieldName = Object.keys(props).find(
          (k) => k !== '_thinking' && k !== '_clarification',
        );

        if (fieldName) {
          return {
            text: '',
            toolCalls: [
              {
                id: `extract-${callCount}`,
                name: '_extract_entities',
                input: { [fieldName]: userText },
              },
            ],
            stopReason: 'tool-calls',
            rawContent: [
              {
                type: 'tool_use',
                id: `extract-${callCount}`,
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

      // If the handoff tool is available, the parent still needs auth.
      if (tools.some((tool: any) => tool.name === 'handoff_to_AuthAgent')) {
        return {
          text: '',
          toolCalls: [
            {
              id: `handoff-${callCount}`,
              name: 'handoff_to_AuthAgent',
              input: { reason: 'User needs authentication', message: 'get my data' },
            },
          ],
          stopReason: 'tool-calls',
          rawContent: [
            {
              type: 'tool_use',
              id: `handoff-${callCount}`,
              name: 'handoff_to_AuthAgent',
              input: { reason: 'User needs authentication', message: 'get my data' },
            },
          ],
        };
      }

      // Once auth is satisfied, the parent only sees its business tools.
      return {
        text: 'Here is your data: account balance $5,000.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Here is your data: account balance $5,000.' }],
      };
    });

    const traceCollector = createTraceCollector();

    // Message 1: "get my data" — parent hands off to AuthAgent, AuthAgent asks for username
    const result1 = await executor.executeMessage(
      session.id,
      'get my data',
      undefined,
      traceCollector.callback,
    );

    // Should be waiting for username input
    expect(session.agentName).toBe('AuthAgent');

    // Message 2: provide username — AuthAgent collects it, asks for passcode
    const result2 = await executor.executeMessage(
      session.id,
      'john_doe',
      undefined,
      traceCollector.callback,
    );

    // Should be waiting for passcode input
    expect(session.agentName).toBe('AuthAgent');

    // Message 3: provide passcode — AuthAgent completes, should trigger resume_intent
    const result3 = await executor.executeMessage(
      session.id,
      'secret123',
      undefined,
      traceCollector.callback,
    );

    // Verify resume_intent was dispatched
    const resumeTraces = filterTraces(traceCollector.traces, 'resume_intent');
    expect(resumeTraces.length).toBeGreaterThanOrEqual(1);
    expect(resumeTraces[0].data.from).toBe('AuthAgent');
    expect(resumeTraces[0].data.parentAgent).toBe('Supervisor');
    expect(resumeTraces[0].data.source).toBe('flow_thread_return');

    // Verify thread_return happened
    const returnTraces = filterTraces(traceCollector.traces, 'thread_return');
    expect(returnTraces.length).toBeGreaterThanOrEqual(1);
    expect(returnTraces[0].data.from).toBe('AuthAgent');
    expect(returnTraces[0].data.to).toBe('Supervisor');

    // Verify parent agent is now active (not AuthAgent)
    expect(session.agentName).toBe('Supervisor');

    // Verify the final response comes from the parent (not empty)
    expect(result3.response).toBeTruthy();
    expect(result3.response).toContain('Here is your data: account balance $5,000.');
    expect(result3.response).not.toContain('unable to complete');
  });

  test('no resume_intent when flow child does not complete (still collecting)', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([PARENT_SUPERVISOR], 'Supervisor'),
    );
    executor.registerAgent('AuthAgent', AUTH_AGENT_FLOW);
    session.handoffReturnInfo = { AuthAgent: true };

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        const extractTool = tools.find((t: any) => t.name === '_extract_entities') as any;
        const props = extractTool?.input_schema?.properties || {};
        const fieldName = Object.keys(props).find(
          (k) => k !== '_thinking' && k !== '_clarification',
        );
        const lastUserMsg = _messages.filter((m: any) => m.role === 'user').pop();
        const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
        if (fieldName) {
          return {
            text: '',
            toolCalls: [
              { id: 'ext-1', name: '_extract_entities', input: { [fieldName]: userText } },
            ],
            stopReason: 'tool-calls',
            rawContent: [
              {
                type: 'tool_use',
                id: 'ext-1',
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

      // Supervisor: hand off to AuthAgent
      return {
        text: '',
        toolCalls: [
          {
            id: 'h-1',
            name: 'handoff_to_AuthAgent',
            input: { reason: 'auth needed', message: 'get data' },
          },
        ],
        stopReason: 'tool-calls',
        rawContent: [
          {
            type: 'tool_use',
            id: 'h-1',
            name: 'handoff_to_AuthAgent',
            input: { reason: 'auth needed', message: 'get data' },
          },
        ],
      };
    });

    const traceCollector = createTraceCollector();

    // Message 1: triggers handoff to AuthAgent
    await executor.executeMessage(session.id, 'get data', undefined, traceCollector.callback);

    // Message 2: provide username only — AuthAgent should still be collecting
    await executor.executeMessage(session.id, 'john', undefined, traceCollector.callback);

    // AuthAgent should still be active (waiting for passcode)
    expect(session.agentName).toBe('AuthAgent');

    // No resume_intent should have fired — child hasn't completed yet
    const resumeTraces = filterTraces(traceCollector.traces, 'resume_intent');
    expect(resumeTraces.length).toBe(0);

    // No thread_return either
    const returnTraces = filterTraces(traceCollector.traces, 'thread_return');
    expect(returnTraces.length).toBe(0);
  });

  test('supervisor tool-call route to leave application does not switch to leave balance sibling', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([LEAVE_SUPERVISOR], 'LeaveSupervisor'),
    );
    executor.registerAgent('LeaveApplication', LEAVE_APPLICATION_FLOW);
    executor.registerAgent('LeaveBalance', LEAVE_BALANCE_FLOW);
    session.handoffReturnInfo = { LeaveApplication: true, LeaveBalance: true };

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      if (tools.some((tool: any) => tool.name === 'handoff_to_LeaveApplication')) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'leave-application-handoff',
              name: 'handoff_to_LeaveApplication',
              input: {
                reason: 'User wants to apply for leave',
                message: 'Transfer user to agent LeaveApplication',
              },
            },
          ],
          stopReason: 'tool-calls',
          rawContent: [
            {
              type: 'tool_use',
              id: 'leave-application-handoff',
              name: 'handoff_to_LeaveApplication',
              input: {
                reason: 'User wants to apply for leave',
                message: 'Transfer user to agent LeaveApplication',
              },
            },
          ],
        };
      }

      return {
        text: 'Leave supervisor default response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Leave supervisor default response.' }],
      };
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'I want to apply for leave',
      undefined,
      traceCollector.callback,
    );

    const handoffTraces = filterTraces(traceCollector.traces, 'handoff');
    expect(handoffTraces).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          to: 'LeaveApplication',
        }),
      }),
    );
    expect(session.agentName).toBe('LeaveApplication');
    expect(result.response).not.toContain('LeaveBalance checked');
  });

  test('is_authenticated string "true" is handled by handoff conditions', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([PARENT_SUPERVISOR], 'Supervisor'),
    );
    executor.registerAgent('AuthAgent', AUTH_AGENT_FLOW);
    session.handoffReturnInfo = { AuthAgent: true };

    // Pre-populate is_authenticated as string "true" (simulating interpolateTemplate behavior)
    session.data.values.is_authenticated = 'true';
    session.data.values.customer_id = 'cust-123';

    mockClient.setResponseHandler(() => ({
      text: 'Here is your data.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Here is your data.' }],
    }));

    const traceCollector = createTraceCollector();

    const result = await executor.executeMessage(
      session.id,
      'get data',
      undefined,
      traceCollector.callback,
    );

    // With is_authenticated = "true" (string), the HANDOFF WHEN condition
    // (is_authenticated != "true" AND is_authenticated != true) should NOT match.
    // The parent should NOT hand off to AuthAgent — it should respond directly.
    const handoffTraces = filterTraces(traceCollector.traces, 'handoff');
    const authHandoffs = handoffTraces.filter((t) => t.data.to === 'AuthAgent');
    expect(authHandoffs.length).toBe(0);

    // Should get a direct response
    expect(result.response).toBeTruthy();
  });
});
