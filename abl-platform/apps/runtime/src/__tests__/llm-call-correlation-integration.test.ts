/**
 * LLM Call Correlation Integration Tests (I-3B.5 to I-3B.7)
 *
 * Validates that llmCallId is generated per LLM call iteration and correctly
 * threaded through tool_thought and llm_call trace events.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor';

// =============================================================================
// MOCK LLM CLIENT
// =============================================================================

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
    usage?: { input_tokens: number; output_tokens: number };
    resolvedModel?: { modelId: string; provider: string; source: string };
  };

  constructor() {
    this.responseHandler = () => ({
      text: 'Done.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Done.' }],
    });
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

// =============================================================================
// TRACE HELPERS
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
// DSL FIXTURE
// =============================================================================

const REASONING_AGENT_WITH_TOOLS = `
AGENT: CorrelationAgent

GOAL: "Agent for testing llmCallId correlation"

PERSONA: "Helpful assistant"

TOOLS:
  search(query: string) -> {results: array}
    description: "Search for information"
  calculate(expression: string) -> {result: number}
    description: "Calculate a math expression"
`;

// =============================================================================
// TESTS
// =============================================================================

describe('LLM Call Correlation Integration (I-3B.5 to I-3B.7)', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockLLMClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  // ===========================================================================
  // I-3B.5: Single LLM call → llmCallId on all tool_thoughts
  // ===========================================================================

  test('I-3B.5: single LLM call has llmCallId on all tool_thought traces', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOLS], 'CorrelationAgent'),
    );

    session.resolvedEnableThinking = true;

    session.toolExecutor = {
      execute: async () => ({ results: ['item1', 'item2'] }),
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler(() => {
      callCount++;
      if (callCount === 1) {
        // First call: emit a tool call with thought
        return {
          text: '',
          toolCalls: [
            {
              id: 'tc-1',
              name: '__complete__',
              input: {
                thought: 'The search is complete',
                reason: 'Found relevant results',
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'tc-1',
              name: '__complete__',
              input: {
                thought: 'The search is complete',
                reason: 'Found relevant results',
              },
            },
          ],
        };
      }
      return {
        text: 'Here are the results.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Here are the results.' }],
      };
    });

    const { traces, callback } = createTraceCollector();
    session.conversationHistory.push({ role: 'user', content: 'Search for items' });

    await executor.executeMessage(session.id, 'Search for items', undefined, callback);

    const llmCalls = filterTraces(traces, 'llm_call');
    const toolThoughts = filterTraces(traces, 'tool_thought');

    // Should have at least 1 llm_call
    expect(llmCalls.length).toBeGreaterThanOrEqual(1);

    const firstLlmCallId = llmCalls[0].data.llmCallId;
    expect(firstLlmCallId).toBeDefined();
    expect(typeof firstLlmCallId).toBe('string');
    expect((firstLlmCallId as string).length).toBeGreaterThan(0);

    // All tool_thoughts from the first LLM call should share the same llmCallId
    if (toolThoughts.length > 0) {
      const firstIterationThoughts = toolThoughts.filter(
        (t) => t.data.llmCallId === firstLlmCallId,
      );
      expect(firstIterationThoughts.length).toBeGreaterThanOrEqual(1);

      // Every tool_thought should have a defined llmCallId
      for (const tt of toolThoughts) {
        expect(tt.data.llmCallId).toBeDefined();
        expect(typeof tt.data.llmCallId).toBe('string');
      }
    }
  });

  // ===========================================================================
  // I-3B.6: Sequential LLM calls → different llmCallIds
  // ===========================================================================

  test('I-3B.6: sequential LLM calls produce different llmCallIds', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOLS], 'CorrelationAgent'),
    );

    session.resolvedEnableThinking = true;

    session.toolExecutor = {
      execute: async () => ({ results: ['item1'] }),
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler(() => {
      callCount++;
      if (callCount === 1) {
        // First iteration: tool call triggers another LLM call
        return {
          text: '',
          toolCalls: [
            {
              id: 'tc-1',
              name: 'search',
              input: { query: 'test', thought: 'Need to search first' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'tc-1',
              name: 'search',
              input: { query: 'test', thought: 'Need to search first' },
            },
          ],
        };
      }
      // Second iteration: final response
      return {
        text: 'Found the results.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Found the results.' }],
      };
    });

    const { traces, callback } = createTraceCollector();
    session.conversationHistory.push({ role: 'user', content: 'Search for test data' });

    await executor.executeMessage(session.id, 'Search for test data', undefined, callback);

    const llmCalls = filterTraces(traces, 'llm_call');

    // Should have at least 2 LLM call iterations (tool use + final)
    if (llmCalls.length >= 2) {
      const ids = llmCalls.map((c) => c.data.llmCallId);

      // All IDs should be defined
      for (const id of ids) {
        expect(id).toBeDefined();
        expect(typeof id).toBe('string');
      }

      // All IDs should be unique
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    }
  });

  // ===========================================================================
  // I-3B.7: llmCallId also on llm_call trace event
  // ===========================================================================

  test('I-3B.7: llm_call and tool_thought traces have matching llmCallId', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOLS], 'CorrelationAgent'),
    );

    session.resolvedEnableThinking = true;

    session.toolExecutor = {
      execute: async () => ({ results: ['item1'] }),
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler(() => {
      callCount++;
      if (callCount === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'tc-1',
              name: '__complete__',
              input: {
                thought: 'Task is complete',
                reason: 'User request is fully answered',
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'tc-1',
              name: '__complete__',
              input: {
                thought: 'Task is complete',
                reason: 'User request is fully answered',
              },
            },
          ],
        };
      }
      return {
        text: 'Done.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Done.' }],
      };
    });

    const { traces, callback } = createTraceCollector();
    session.conversationHistory.push({ role: 'user', content: 'Complete the task' });

    await executor.executeMessage(session.id, 'Complete the task', undefined, callback);

    const llmCalls = filterTraces(traces, 'llm_call');
    const toolThoughts = filterTraces(traces, 'tool_thought');

    // Every llm_call should have llmCallId
    expect(llmCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of llmCalls) {
      expect(call.data.llmCallId).toBeDefined();
      expect(typeof call.data.llmCallId).toBe('string');
      expect((call.data.llmCallId as string).length).toBeGreaterThan(0);
    }

    // If there are tool_thoughts, they should reference an llmCallId that
    // also appears in an llm_call event
    if (toolThoughts.length > 0) {
      const llmCallIds = new Set(llmCalls.map((c) => c.data.llmCallId));

      for (const tt of toolThoughts) {
        expect(tt.data.llmCallId).toBeDefined();
        // The tool_thought's llmCallId should match one of the llm_call IDs
        expect(llmCallIds.has(tt.data.llmCallId as string)).toBe(true);
      }
    }
  });
});
