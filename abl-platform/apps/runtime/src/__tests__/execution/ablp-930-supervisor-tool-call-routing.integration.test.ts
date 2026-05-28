import { beforeEach, describe, expect, test } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';

const LEAVE_REQUEST = 'I want to apply for leave and not check leave balance';

const LEAVE_SUPERVISOR_DSL = `
SUPERVISOR: LeaveSupervisor

GOAL: "Route leave requests to the correct leave specialist"

PERSONA: "A leave routing supervisor"

INTENTS:
  LEXICAL_FALLBACK: when_unavailable
  leave_application: "Apply for leave or submit a leave application"
  leave_balance: "Check available leave balance"

HANDOFF:
  - TO: LeaveApplicationChild
    WHEN: intent.category == "leave_application"
    RETURN: true

  - TO: LeaveBalanceChild
    WHEN: intent.category == "leave_balance"
    RETURN: true
`;

const LEAVE_APPLICATION_CHILD_DSL = `
AGENT: LeaveApplicationChild

GOAL: "Collect leave application details"

FLOW:
  entry_point: collect_reason
  steps:
    - collect_reason

collect_reason:
  REASONING: false
  GATHER:
    - leave_reason:
        prompt: "What is the reason for the leave application?"
        required: true
  THEN: COMPLETE
`;

const LEAVE_BALANCE_CHILD_DSL = `
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
  async resolveLanguageModel(_operationType: string) {
    return { modelId: 'ablp-930-integration-model' };
  }

  async chatWithToolUse(
    _systemPrompt: string,
    _messages: MockChatMessage[],
    tools: Array<{ name?: string }>,
  ): Promise<MockChatResponse> {
    if (tools.some((tool) => tool.name === 'handoff_to_LeaveApplicationChild')) {
      return {
        text: '',
        toolCalls: [
          {
            id: 'leave-application-handoff',
            name: 'handoff_to_LeaveApplicationChild',
            input: {
              reason: 'The user wants to apply for leave.',
              message:
                'Transfer user to agent LeaveApplicationChild before checking LeaveBalanceChild',
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
              reason: 'The user wants to apply for leave.',
              message:
                'Transfer user to agent LeaveApplicationChild before checking LeaveBalanceChild',
            },
          },
        ],
      };
    }

    return {
      text: 'Default integration response.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Default integration response.' }],
    };
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: MockChatMessage[],
    tools: Array<{ name?: string }>,
    _operationType?: string,
    _onChunk?: (chunk: string) => void,
  ): Promise<MockChatResponse> {
    return this.chatWithToolUse(systemPrompt, messages, tools);
  }
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

describe('ABLP-930 supervisor tool-call routing integration', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    injectMockClient(executor);
  });

  test('does not downgrade a supervisor-selected child route through sibling keyword matches', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [LEAVE_SUPERVISOR_DSL, LEAVE_APPLICATION_CHILD_DSL, LEAVE_BALANCE_CHILD_DSL],
        'LeaveSupervisor',
      ),
      {
        tenantId: 'tenant-ablp-930',
        projectId: 'project-ablp-930',
      },
    );
    session.handoffReturnInfo = { LeaveApplicationChild: true, LeaveBalanceChild: true };

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = await executor.executeMessage(session.id, LEAVE_REQUEST, undefined, (event) =>
      traceEvents.push(event),
    );

    expect(session.agentName).toBe('LeaveApplicationChild');
    expect(result.response).toContain('What is the reason for the leave application?');
    expect(result.response).not.toContain("LeaveBalanceChild checked the user's leave balance.");
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'handoff',
          data: expect.objectContaining({
            to: 'LeaveApplicationChild',
          }),
        }),
      ]),
    );
    expect(traceEvents).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'handoff',
          data: expect.objectContaining({
            to: 'LeaveBalanceChild',
          }),
        }),
        expect.objectContaining({
          type: 'return_to_parent',
          data: expect.objectContaining({
            from: 'LeaveApplicationChild',
            to: 'LeaveSupervisor',
          }),
        }),
      ]),
    );
  });
});
