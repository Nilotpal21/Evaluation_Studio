/**
 * ReasoningExecutor Reason Fallback Tests
 *
 * Tests for:
 * - 2-U24: enableThinking: false, reason emitted as tool_thought with thought: null
 * - 2-U25: enableThinking: true, both thought and reason emitted
 * - 2-U26: enableThinking: false, no reason field → no tool_thought event
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
} from '../../services/runtime-executor';

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
// ABL FIXTURES
// =============================================================================

const REASONING_AGENT_WITH_TOOL = `
AGENT: TestAgent

GOAL: "Test agent for reason fallback testing"

PERSONA: "Helpful test assistant"

TOOLS:
  search(query: string) -> {results: array}
    description: "Search for information"
`;

// =============================================================================
// TESTS
// =============================================================================

describe('ReasoningExecutor Reason Fallback', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  // ===========================================================================
  // 2-U24: enableThinking: false, reason emitted as tool_thought with thought: null
  // ===========================================================================

  test('should emit tool_thought with thought:null and reasoning when enableThinking is false and reason exists on system tool', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // Ensure enableThinking is off (default — no thinking parameter injected)
    session.resolvedEnableThinking = false;

    session.toolExecutor = {
      execute: async () => ({ results: ['item1'] }),
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler(() => {
      callCount++;
      if (callCount === 1) {
        // First call: LLM returns a system tool call with reason but no thought
        return {
          text: '',
          toolCalls: [
            {
              id: 'tc-1',
              name: '__complete__',
              input: { reason: 'User request is fully answered' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'tc-1',
              name: '__complete__',
              input: { reason: 'User request is fully answered' },
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

    const toolThoughts = filterTraces(traces, 'tool_thought');
    expect(toolThoughts.length).toBeGreaterThanOrEqual(1);

    const reasonFallback = toolThoughts.find(
      (t) => t.data.thought === null && t.data.reasoning !== undefined,
    );
    expect(reasonFallback).toBeDefined();
    expect(reasonFallback!.data.thought).toBeNull();
    expect(reasonFallback!.data.reasoning).toBe('User request is fully answered');
    expect(reasonFallback!.data.toolName).toBe('__complete__');
    expect(reasonFallback!.data.agent).toBe('TestAgent');
  });

  // ===========================================================================
  // 2-U25: enableThinking: true, both thought and reason emitted
  // ===========================================================================

  test('should emit tool_thought with both thought and reason when enableThinking is true', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // Enable thinking — the prompt builder adds the thought parameter
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
                thought: 'I have fully answered the question',
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
                thought: 'I have fully answered the question',
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

    const toolThoughts = filterTraces(traces, 'tool_thought');
    expect(toolThoughts.length).toBeGreaterThanOrEqual(1);

    // When thought is present, it should appear with reasoning
    const thoughtWithReason = toolThoughts.find((t) => t.data.thought !== null);
    expect(thoughtWithReason).toBeDefined();
    expect(thoughtWithReason!.data.thought).toBe('I have fully answered the question');
    expect(thoughtWithReason!.data.reasoning).toBe('User request is fully answered');
  });

  // ===========================================================================
  // 2-U26: enableThinking: false, no reason field → no tool_thought event
  // ===========================================================================

  test('should not emit tool_thought when enableThinking is false and no reason field', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    session.resolvedEnableThinking = false;

    session.toolExecutor = {
      execute: async () => ({ results: ['item1'] }),
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler(() => {
      callCount++;
      if (callCount === 1) {
        // System tool call with neither thought nor reason
        return {
          text: '',
          toolCalls: [
            {
              id: 'tc-1',
              name: '__complete__',
              input: {},
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'tc-1',
              name: '__complete__',
              input: {},
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

    const toolThoughts = filterTraces(traces, 'tool_thought');
    expect(toolThoughts.length).toBe(0);
  });

  // ===========================================================================
  // 2-U24b: Reason fallback also works for regular (user) tools
  // ===========================================================================

  test('should emit tool_thought with thought:null for regular tool when enableThinking is false and reason exists', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    session.resolvedEnableThinking = false;

    session.toolExecutor = {
      execute: async () => ({ results: ['item1'] }),
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler(() => {
      callCount++;
      if (callCount === 1) {
        // Regular tool with reason but no thought
        return {
          text: '',
          toolCalls: [
            {
              id: 'tc-1',
              name: 'search',
              input: { query: 'test', reason: 'Need to look up info' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'tc-1',
              name: 'search',
              input: { query: 'test', reason: 'Need to look up info' },
            },
          ],
        };
      }
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

    const toolThoughts = filterTraces(traces, 'tool_thought');
    expect(toolThoughts.length).toBeGreaterThanOrEqual(1);

    const reasonFallback = toolThoughts.find(
      (t) => t.data.thought === null && t.data.reasoning !== undefined,
    );
    expect(reasonFallback).toBeDefined();
    expect(reasonFallback!.data.thought).toBeNull();
    expect(reasonFallback!.data.reasoning).toBe('Need to look up info');
    expect(reasonFallback!.data.toolName).toBe('search');
  });
});
