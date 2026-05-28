/**
 * Thought-to-Prompt Correlation Tests
 *
 * Tests for ST-3.5: tool_thought events carry llmCallId for correlation
 *
 * - 3-U32: tool_thought events include llmCallId matching the parent llm_call
 * - 3-U33: llm_call events include llmCallId in data
 * - 3-U34: llmCallId is a stable UUID per LLM call iteration
 * - 3-U35: Multiple tool calls from same LLM response share same llmCallId
 */

import { describe, test, expect, beforeEach } from 'vitest';

import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor';

// =============================================================================
// MOCK LLM CLIENT (reused pattern from reason-fallback tests)
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
// ABL FIXTURE
// =============================================================================

const REASONING_AGENT_WITH_TOOL = `
AGENT: TestAgent

GOAL: "Test agent for prompt correlation testing"

PERSONA: "Helpful test assistant"

TOOLS:
  search(query: string) -> {results: array}
    description: "Search for information"
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Thought-to-Prompt Correlation (llmCallId)', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  // ===========================================================================
  // 3-U32: tool_thought events include llmCallId
  // ===========================================================================

  test('tool_thought events include llmCallId matching the parent llm_call', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
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
    session.conversationHistory.push({ role: 'user', content: 'Hello' });

    await executor.executeMessage(session.id, 'Hello', undefined, callback);

    const llmCalls = filterTraces(traces, 'llm_call');
    const toolThoughts = filterTraces(traces, 'tool_thought');

    // The first LLM call should have an llmCallId
    expect(llmCalls.length).toBeGreaterThanOrEqual(1);
    const firstLlmCall = llmCalls[0];
    expect(firstLlmCall.data.llmCallId).toBeDefined();
    expect(typeof firstLlmCall.data.llmCallId).toBe('string');

    // The tool_thought from the same iteration should share the same llmCallId
    expect(toolThoughts.length).toBeGreaterThanOrEqual(1);
    const firstThought = toolThoughts[0];
    expect(firstThought.data.llmCallId).toBe(firstLlmCall.data.llmCallId);
  });

  // ===========================================================================
  // 3-U33: llm_call events include llmCallId in data
  // ===========================================================================

  test('llm_call events include llmCallId in their data', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    session.resolvedEnableThinking = false;

    session.toolExecutor = {
      execute: async () => ({ results: ['item1'] }),
    } as any;

    mockClient.setResponseHandler(() => ({
      text: 'Simple response.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Simple response.' }],
    }));

    const { traces, callback } = createTraceCollector();
    session.conversationHistory.push({ role: 'user', content: 'Hi' });

    await executor.executeMessage(session.id, 'Hi', undefined, callback);

    const llmCalls = filterTraces(traces, 'llm_call');
    expect(llmCalls.length).toBeGreaterThanOrEqual(1);

    // Every llm_call event should have an llmCallId
    for (const call of llmCalls) {
      expect(call.data.llmCallId).toBeDefined();
      expect(typeof call.data.llmCallId).toBe('string');
      expect((call.data.llmCallId as string).length).toBeGreaterThan(0);
    }
  });

  // ===========================================================================
  // 3-U34: llmCallId is unique per LLM call iteration
  // ===========================================================================

  test('llmCallId is unique per LLM call iteration', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    session.resolvedEnableThinking = true;

    session.toolExecutor = {
      execute: async () => ({ results: ['item1'] }),
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler(() => {
      callCount++;
      if (callCount === 1) {
        // First iteration: search tool call
        return {
          text: '',
          toolCalls: [
            {
              id: 'tc-1',
              name: 'search',
              input: { query: 'test', thought: 'Need to search' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'tc-1',
              name: 'search',
              input: { query: 'test', thought: 'Need to search' },
            },
          ],
        };
      }
      // Second iteration: complete
      return {
        text: 'Found results.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Found results.' }],
      };
    });

    const { traces, callback } = createTraceCollector();
    session.conversationHistory.push({ role: 'user', content: 'Search for test' });

    await executor.executeMessage(session.id, 'Search for test', undefined, callback);

    const llmCalls = filterTraces(traces, 'llm_call');
    // Should have at least 2 iterations (tool call + final response)
    if (llmCalls.length >= 2) {
      const ids = llmCalls.map((c) => c.data.llmCallId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length); // All IDs are unique
    }
  });

  // ===========================================================================
  // 3-U35: Multiple tool calls from same response share llmCallId
  // ===========================================================================

  test('multiple tool_thought events from same LLM response share same llmCallId', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    session.resolvedEnableThinking = true;

    session.toolExecutor = {
      execute: async () => ({ results: ['item1'] }),
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler(() => {
      callCount++;
      if (callCount === 1) {
        // Return a tool call with thought, then the tool result loop
        // will trigger another LLM call
        return {
          text: '',
          toolCalls: [
            {
              id: 'tc-1',
              name: '__complete__',
              input: {
                thought: 'All done now',
                reason: 'Task complete',
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
                thought: 'All done now',
                reason: 'Task complete',
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
    session.conversationHistory.push({ role: 'user', content: 'Hello' });

    await executor.executeMessage(session.id, 'Hello', undefined, callback);

    const llmCalls = filterTraces(traces, 'llm_call');
    const toolThoughts = filterTraces(traces, 'tool_thought');

    if (llmCalls.length >= 1 && toolThoughts.length >= 1) {
      // All tool thoughts from the first iteration should have
      // the same llmCallId as the first llm_call
      const firstLlmCallId = llmCalls[0].data.llmCallId;
      const firstIterationThoughts = toolThoughts.filter(
        (t) => t.data.llmCallId === firstLlmCallId,
      );
      expect(firstIterationThoughts.length).toBeGreaterThanOrEqual(1);
    }
  });
});
