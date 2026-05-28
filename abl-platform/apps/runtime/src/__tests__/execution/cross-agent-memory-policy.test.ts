import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { AgentIR } from '@abl/compiler';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';
import type { RuntimeSession } from '../../services/execution/types.js';
import { assertSessionHistoryIntegrity } from '../helpers/history-validation';

const MOCK_POLICY = {
  disabledGuardrails: ['small-talk'],
  additionalGuardrails: [{ name: 'billing-safe' }],
  settings: { failMode: 'closed' as const },
} satisfies NonNullable<RuntimeSession['_guardrailPolicy']>;

vi.mock('../../services/execution/session-policy.js', () => {
  return {
    getSessionPolicy: vi.fn(async (session: RuntimeSession) => {
      session._guardrailPolicy = MOCK_POLICY;
      session._guardrailPolicyScopeKey = 'test-guardrail-scope';
      return MOCK_POLICY;
    }),
    getSessionGuardrailCacheScopeKey: vi.fn().mockReturnValue('test-guardrail-scope'),
    getSessionStreamingConfig: vi.fn().mockReturnValue(undefined),
    toStreamingEvalConfig: vi.fn().mockReturnValue(undefined),
  };
});

class MockAnthropicClient {
  calls: Array<{
    systemPrompt: string;
    messages: Array<{ role: string; content: unknown }>;
    tools: unknown[];
  }> = [];

  async chatWithToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) {
    this.calls.push({ systemPrompt, messages, tools });

    const extractTool = tools.find(
      (tool): tool is { name: string; input_schema?: { properties?: Record<string, unknown> } } =>
        typeof tool === 'object' &&
        tool !== null &&
        'name' in tool &&
        (tool as { name?: unknown }).name === '_extract_entities',
    );
    if (extractTool) {
      const lastUserMessage = messages.findLast((message) => message.role === 'user');
      const messageText =
        typeof lastUserMessage?.content === 'string'
          ? lastUserMessage.content
          : Array.isArray(lastUserMessage?.content)
            ? lastUserMessage.content
                .filter(
                  (
                    block,
                  ): block is {
                    type: 'text';
                    text: string;
                  } =>
                    typeof block === 'object' &&
                    block !== null &&
                    'type' in block &&
                    block.type === 'text' &&
                    'text' in block &&
                    typeof block.text === 'string',
                )
                .map((block) => block.text)
                .join('\n')
            : '';
      const firstField = Object.keys(extractTool.input_schema?.properties ?? {}).find(
        (name) => !name.startsWith('_'),
      );

      return {
        text: '',
        toolCalls: firstField
          ? [
              {
                id: 'extract-1',
                name: '_extract_entities',
                input: { [firstField]: messageText },
              },
            ]
          : [],
        stopReason: 'tool-calls',
        rawContent: firstField
          ? [
              {
                type: 'tool_use',
                id: 'extract-1',
                name: '_extract_entities',
                input: { [firstField]: messageText },
              },
            ]
          : [],
      };
    }

    return {
      text: 'Billing help ready.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Billing help ready.' }],
    };
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
  const runtimeWithLLMWiring = executor as RuntimeExecutor & {
    llmWiring: {
      wireLLMClient: (
        session: RuntimeSession,
        agentIR: AgentIR,
        tenantId?: string,
        projectId?: string,
        userId?: string,
      ) => Promise<void>;
      ensureSessionLLMClient: (session: RuntimeSession) => Promise<void>;
    };
  };

  runtimeWithLLMWiring.llmWiring.wireLLMClient = async (session: RuntimeSession) => {
    session.llmClient = mock as RuntimeSession['llmClient'];
  };
  runtimeWithLLMWiring.llmWiring.ensureSessionLLMClient = async (session: RuntimeSession) => {
    if (!session.llmClient) {
      session.llmClient = mock as RuntimeSession['llmClient'];
    }
  };
  return mock;
}

describe('Cross-agent memory and policy composition', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  test('auth handoff writes execution_tree memory, resumes intent, and the billing child sees granted memory plus policy', async () => {
    const supervisorDsl = `
AGENT: Billing_Supervisor

GOAL: "Authenticate billing requests and route them with workflow-scoped context"

MEMORY:
  session:
    - route
  persistent:
    - PATH: workflow.auth_token
      SCOPE: execution_tree
      ACCESS: readwrite
      TYPE: string

FLOW:
  entry_point: classify
  steps:
    - classify

  classify:
    REASONING: false
    GATHER:
      - request: required
    ON_INPUT:
      - IF: input contains "billing"
        SET: route = "auth"
        THEN: COMPLETE
      - ELSE:
        THEN: COMPLETE

HANDOFF:
  - TO: Auth_Agent
    WHEN: route == "auth"
    CONTEXT:
      pass: [route]
      summary: "Authenticate the customer before billing support"
      memory_grants:
        - path: workflow.auth_token
          access: readwrite
    RETURN: true
    ON_RETURN:
      ACTION: resume_intent
      MAP:
        route: route

  - TO: Billing_Agent
    WHEN: route == "billing_ready"
    CONTEXT:
      pass: [route]
      summary: "Authenticated billing request"
      memory_grants:
        - path: workflow.auth_token
          access: read
    RETURN: false
`;

    const authDsl = `
AGENT: Auth_Agent

GOAL: "Verify the customer before billing support continues"

FLOW:
  entry_point: verify
  steps:
    - verify

  verify:
    REASONING: false
    SET: route = "billing_ready"
    SET: granted_memory.workflow.auth_token = "verified-token"
    RESPOND: "Verified customer."
    THEN: COMPLETE
`;

    const billingDsl = `
AGENT: Billing_Agent

GOAL: "Help authenticated customers with billing questions"
`;

    executor.registerAgent('Auth_Agent', authDsl);
    executor.registerAgent('Billing_Agent', billingDsl);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([supervisorDsl, authDsl, billingDsl], 'Billing_Supervisor'),
    );

    await executor.initializeSession(session.id);

    const firstTurnChunks: string[] = [];
    const firstTurnTraces: Array<{ type: string; data: Record<string, unknown> }> = [];
    await executor.executeMessage(
      session.id,
      'I need help with billing',
      (chunk) => firstTurnChunks.push(chunk),
      (trace) => firstTurnTraces.push(trace),
    );

    expect(firstTurnChunks.join('')).toContain('Verified customer.');
    expect(
      firstTurnTraces.find(
        (trace) =>
          trace.type === 'resume_intent' &&
          trace.data.from === 'Auth_Agent' &&
          trace.data.parentAgent === 'Billing_Supervisor',
      ),
    ).toBeDefined();
    expect(session.agentName).toBe('Billing_Supervisor');
    expect(session.executionTreeValues).toEqual({
      'workflow.auth_token': 'verified-token',
    });

    const handleHandoff = (
      executor as RuntimeExecutor & {
        routing: {
          handleHandoff: (
            runtimeSession: RuntimeSession,
            input: { target: string; message: string },
            onChunk?: (chunk: string) => void,
            onTraceEvent?: (trace: { type: string; data: Record<string, unknown> }) => void,
          ) => Promise<{ success: boolean; response?: string }>;
        };
      }
    ).routing.handleHandoff.bind((executor as RuntimeExecutor & { routing: unknown }).routing);

    const billingChunks: string[] = [];
    const billingTraces: Array<{ type: string; data: Record<string, unknown> }> = [];
    const billingResult = await handleHandoff(
      session,
      { target: 'Billing_Agent', message: 'continue please' },
      (chunk) => billingChunks.push(chunk),
      (trace) => billingTraces.push(trace),
    );

    expect(billingResult.success).toBe(true);
    const billingOutput = billingChunks.join('') || billingResult.response || '';
    expect(billingOutput).toContain('Billing help ready.');
    expect(
      billingTraces.find(
        (trace) =>
          trace.type === 'handoff' &&
          trace.data.from === 'Billing_Supervisor' &&
          trace.data.to === 'Billing_Agent',
      ),
    ).toBeDefined();

    expect(session.agentName).toBe('Billing_Agent');
    expect(session.threads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentName: 'Auth_Agent', status: 'completed' }),
        expect.objectContaining({ agentName: 'Billing_Agent', status: 'active' }),
      ]),
    );
    expect(session.executionTreeValues).toEqual({
      'workflow.auth_token': 'verified-token',
    });
    expect(session.data.values._granted_memory).toEqual({
      'workflow.auth_token': 'verified-token',
    });

    const prompt = mockClient.calls.at(-1)?.systemPrompt ?? '';
    expect(prompt).toContain('## Granted Memory');
    expect(prompt).toContain('"workflow.auth_token": "verified-token"');
    expect(prompt).toContain('## Current Policy');
    expect(prompt).toContain('"failMode": "closed"');
    expect(prompt).toContain('"additionalGuardrailCount": 1');

    assertSessionHistoryIntegrity(session);
  });
});
