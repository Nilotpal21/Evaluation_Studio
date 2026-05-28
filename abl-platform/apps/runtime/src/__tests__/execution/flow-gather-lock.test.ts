import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';

class MockLLMClient {
  calls: Array<{ toolNames: string[] }> = [];

  async chatWithToolUse(
    _systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: Array<{ name?: string }>,
  ) {
    const toolNames = tools.map((tool) => tool.name ?? '');
    this.calls.push({ toolNames });

    if (toolNames.includes('_extract_entities')) {
      const lastUserMessage = [...messages]
        .reverse()
        .find((message) => message.role === 'user' && typeof message.content === 'string')?.content;
      const text = typeof lastUserMessage === 'string' ? lastUserMessage : '';

      const extraction: Record<string, unknown> = {};
      const memberIdMatch = text.match(/\b(\d{5})\b/);
      if (memberIdMatch) {
        extraction.member_id = memberIdMatch[1];
      }
      if (/jan(?:uary)?\s+2\s+1980/i.test(text) || /\b01\/02\/1980\b/.test(text)) {
        extraction.dob = '1980-01-02';
      }

      return {
        text: '',
        toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: extraction }],
        stopReason: 'tool_use',
        rawContent: [],
      };
    }

    return {
      text: 'Reasoning zone response.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Reasoning zone response.' }],
    };
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: Array<{ name?: string }>,
    _operationType?: string,
    _onChunk?: (chunk: string) => void,
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools);
  }
}

function injectMockClient(executor: RuntimeExecutor): MockLLMClient {
  const mock = new MockLLMClient();

  (
    executor as unknown as { llmWiring: { wireLLMClient: (session: unknown) => Promise<void> } }
  ).llmWiring.wireLLMClient = async (session) => {
    (session as { llmClient?: MockLLMClient }).llmClient = mock;
  };

  (
    executor as unknown as {
      llmWiring: { ensureSessionLLMClient: (session: unknown) => Promise<void> };
    }
  ).llmWiring.ensureSessionLLMClient = async (session) => {
    const mutableSession = session as { llmClient?: MockLLMClient };
    if (!mutableSession.llmClient) {
      mutableSession.llmClient = mock;
    }
  };

  return mock;
}

const GATHER_LOCK_WITH_HANDOFF = `
AGENT: Gather_Lock_With_Handoff

GOAL: "Collect identity before doing anything else"

HANDOFF:
  - TO: specialist_agent
    WHEN: intent.category == "specialist_request"

FLOW:
  entry_point: collect_identity
  steps:
    - collect_identity
    - done

collect_identity:
  REASONING: true
  GOAL: "Collect member identity"
  GATHER:
    - member_id: required
    - dob: required
  THEN: done

done:
  REASONING: false
  RESPOND: "Identity collected."
  THEN: COMPLETE
`;

const SPECIALIST_AGENT = `
AGENT: specialist_agent

GOAL: "Handle specialist requests"
`;

const GATHER_LOCK_WITH_QUEUED_BRANCH = `
AGENT: Gather_Lock_With_Queue

GOAL: "Collect identity and queue extra requests"

FLOW:
  entry_point: collect_identity
  steps:
    - collect_identity
    - authenticated
    - order_status

collect_identity:
  REASONING: true
  GOAL: "Collect member identity"
  GATHER:
    - member_id: required
    - dob: required
  ON_INPUT:
    - IF: input contains "order status"
      THEN: order_status
  THEN: authenticated

authenticated:
  REASONING: false
  RESPOND: "Identity collected for {{member_id}}."
  THEN: COMPLETE

order_status:
  REASONING: false
  RESPOND: "Checking order status."
  THEN: COMPLETE
`;

const GATHER_LOCK_WITH_TOOLLESS_REASONING = `
AGENT: Gather_Lock_With_Toolless_Reasoning

GOAL: "Collect identity conversationally"

FLOW:
  entry_point: collect_identity
  steps:
    - collect_identity

collect_identity:
  REASONING: true
  GOAL: "Collect member identity"
  RESPOND: "Thank the customer and summarize what you collected."
  GATHER:
    - member_id: required
    - dob: required
  THEN: COMPLETE
`;

const GATHER_LOCK_WITH_RESPONDING_DIGRESSION = `
AGENT: Gather_Lock_With_Responding_Digression

GOAL: "Collect identity and answer price breakdown digressions"

FLOW:
  entry_point: collect_identity
  steps:
    - collect_identity

collect_identity:
  REASONING: false
  GATHER:
    - member_id: required
    - dob: required
  DIGRESSIONS:
    - INTENT: price_breakdown_request
      KEYWORDS: [price breakdown]
      RESPOND: "Here is the pricing breakdown."
      RESUME: true
  THEN: COMPLETE
`;

describe('FLOW-step gather lock', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  afterEach(() => {
    executor.stopStaleReaper();
  });

  it('keeps reasoning-zone handoff tools out of active gather collection turns', async () => {
    const mockClient = injectMockClient(executor);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [GATHER_LOCK_WITH_HANDOFF, SPECIALIST_AGENT],
        'Gather_Lock_With_Handoff',
      ),
    );

    await executor.initializeSession(session.id);

    const firstTurnChunks: string[] = [];
    await executor.executeMessage(session.id, 'hello', (chunk) => firstTurnChunks.push(chunk));

    expect(session.waitingForInput).toEqual(['member_id', 'dob']);
    expect(
      mockClient.calls.every((call) =>
        call.toolNames.every((name) => name === '_extract_entities'),
      ),
    ).toBe(true);
    expect(
      mockClient.calls.some((call) => call.toolNames.includes('handoff_to_specialist_agent')),
    ).toBe(false);
    const callsAfterGreeting = mockClient.calls.length;

    const secondTurnChunks: string[] = [];
    await executor.executeMessage(session.id, 'my member id is 12345', (chunk) =>
      secondTurnChunks.push(chunk),
    );

    expect(session.waitingForInput).toEqual(['dob']);
    expect(secondTurnChunks.join('')).toContain('dob');
    expect(mockClient.calls.length).toBeGreaterThan(callsAfterGreeting);
    expect(
      mockClient.calls.every((call) =>
        call.toolNames.every((name) => name === '_extract_entities'),
      ),
    ).toBe(true);
    expect(
      mockClient.calls.some((call) => call.toolNames.includes('handoff_to_specialist_agent')),
    ).toBe(false);
  });

  it('executes matched same-step ON_INPUT work immediately when a gather reply also contains an extra request', async () => {
    const mockClient = injectMockClient(executor);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([GATHER_LOCK_WITH_QUEUED_BRANCH], 'Gather_Lock_With_Queue'),
    );

    await executor.initializeSession(session.id);

    await executor.executeMessage(session.id, 'hello');
    expect(session.waitingForInput).toEqual(['member_id', 'dob']);

    const chunks: string[] = [];
    await executor.executeMessage(
      session.id,
      'my member id is 12345 and dob is Jan 2 1980 and I need my order status',
      (chunk) => chunks.push(chunk),
    );

    expect(session.data.values.member_id).toBe('12345');
    expect(session.data.values.dob).toBe('1980-01-02');
    expect(session.intentQueue?.pending ?? []).toHaveLength(0);
    expect(session.waitingForInput).toBeUndefined();
    expect(chunks.join('')).toContain('Checking order status.');
    expect(chunks.join('')).not.toContain('Identity collected for 12345.');
    expect(
      mockClient.calls.every((call) =>
        call.toolNames.every((name) => name === '_extract_entities'),
      ),
    ).toBe(true);
  });

  it('still runs the reasoning zone after gather completion even with an empty tool surface', async () => {
    const mockClient = injectMockClient(executor);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [GATHER_LOCK_WITH_TOOLLESS_REASONING],
        'Gather_Lock_With_Toolless_Reasoning',
      ),
    );

    await executor.initializeSession(session.id);

    await executor.executeMessage(session.id, 'hello');
    expect(session.waitingForInput).toEqual(['member_id', 'dob']);

    const chunks: string[] = [];
    await executor.executeMessage(
      session.id,
      'my member id is 12345 and dob is Jan 2 1980',
      (chunk) => chunks.push(chunk),
    );

    expect(chunks.join('')).toContain('Reasoning zone response.');
    expect(mockClient.calls.some((call) => call.toolNames.includes('_extract_entities'))).toBe(
      true,
    );
    expect(mockClient.calls.some((call) => call.toolNames.length === 0)).toBe(true);
  });

  it('executes RESPOND/RESUME digressions immediately even when a gather reply also extracts fields', async () => {
    const mockClient = injectMockClient(executor);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [GATHER_LOCK_WITH_RESPONDING_DIGRESSION],
        'Gather_Lock_With_Responding_Digression',
      ),
    );

    await executor.initializeSession(session.id);

    await executor.executeMessage(session.id, 'hello');
    expect(session.waitingForInput).toEqual(['member_id', 'dob']);

    const chunks: string[] = [];
    await executor.executeMessage(
      session.id,
      'my member id is 12345 and can I get a price breakdown?',
      (chunk) => chunks.push(chunk),
    );

    expect(session.data.values.member_id).toBe('12345');
    expect(session.waitingForInput).toEqual(['dob']);
    expect(session.intentQueue?.pending ?? []).toHaveLength(0);
    expect(chunks.join('')).toContain('Here is the pricing breakdown.');
    expect(chunks.join('')).toContain('dob');
    expect(
      mockClient.calls.every((call) =>
        call.toolNames.every((name) => name === '_extract_entities'),
      ),
    ).toBe(true);
  });
});
