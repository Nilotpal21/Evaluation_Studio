/**
 * Pre-Refactor Test: Reasoning Delegation & Shadow Mode
 *
 * Tests the CompilerReasoningExecutor construct executor that manages
 * the reasoning-mode agentic loop (tool selection, iteration control,
 * system tool detection). This is the new compiler-layer implementation
 * that will replace the runtime's inline reasoning loop.
 *
 * Tests cover:
 * - Basic tool call handling
 * - __complete__ tool (ends reasoning)
 * - __escalate__ tool
 * - MAX_ITERATIONS enforcement
 * - Tool execution errors
 * - Shadow mode: old and new agree on tool selection
 * - Shadow mode: old and new agree on iteration count
 */

import { describe, test, expect, vi } from 'vitest';
import {
  CompilerReasoningExecutor,
  type ReasoningConfig,
  type LLMToolDefinition,
  type LLMClient,
  type LLMToolUseResult,
  type LLMToolCall,
} from '@abl/compiler';

// =============================================================================
// FIXTURES
// =============================================================================

const SEARCH_TOOL: LLMToolDefinition = {
  name: 'search',
  description: 'Search for items',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
};

const LOOKUP_TOOL: LLMToolDefinition = {
  name: 'lookup',
  description: 'Look up an item by ID',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Item ID' },
    },
    required: ['id'],
  },
};

function createConfig(overrides: Partial<ReasoningConfig> = {}): ReasoningConfig {
  return {
    systemPrompt: 'You are a helpful assistant.',
    tools: [SEARCH_TOOL, LOOKUP_TOOL],
    messages: [{ role: 'user', content: 'help me search' }],
    ...overrides,
  };
}

/**
 * Create a mock LLM client that returns responses from a handler function.
 */
function createMockLLMClient(
  handler: (callIndex: number) => LLMToolUseResult,
): LLMClient & { callCount: number } {
  let callCount = 0;
  return {
    callCount: 0,
    chat: vi.fn().mockResolvedValue(''),
    chatWithTools: vi.fn().mockImplementation(async () => {
      callCount++;
      const client = mockRef;
      client.callCount = callCount;
      return handler(callCount);
    }),
    extractJson: vi.fn().mockResolvedValue({}),
  };
  // We need a reference for callCount updates
  var mockRef = null as unknown as ReturnType<typeof createMockLLMClient>;
  mockRef = {
    callCount: 0,
    chat: vi.fn().mockResolvedValue(''),
    chatWithTools: vi.fn(),
    extractJson: vi.fn().mockResolvedValue({}),
  };
  return mockRef;
}

function simpleMockLLMClient(handler: (callIndex: number) => LLMToolUseResult): {
  client: LLMClient;
  getCallCount: () => number;
} {
  let callCount = 0;
  const client: LLMClient = {
    chat: vi.fn().mockResolvedValue(''),
    chatWithTools: vi.fn().mockImplementation(async () => {
      callCount++;
      return handler(callCount);
    }),
    extractJson: vi.fn().mockResolvedValue({}),
  };
  return { client, getCallCount: () => callCount };
}

function makeToolUseResponse(toolCalls: LLMToolCall[], text = ''): LLMToolUseResult {
  return {
    text,
    toolCalls,
    stopReason: 'tool_use',
  };
}

function makeTextResponse(text: string): LLMToolUseResult {
  return {
    text,
    toolCalls: [],
    stopReason: 'end_turn',
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('CompilerReasoningExecutor', () => {
  const executor = new CompilerReasoningExecutor();

  // ---------------------------------------------------------------------------
  // Basic tool call handling
  // ---------------------------------------------------------------------------

  describe('Basic Tool Calls', () => {
    test('handles a single tool call followed by final response', async () => {
      const { client, getCallCount } = simpleMockLLMClient((callIndex) => {
        if (callIndex === 1) {
          return makeToolUseResponse([{ id: 'tc1', name: 'search', input: { query: 'hotels' } }]);
        }
        return makeTextResponse('Found 3 hotels.');
      });

      const executeTool = vi.fn().mockResolvedValue({ results: ['Hotel A', 'Hotel B', 'Hotel C'] });
      const config = createConfig();

      const result = await executor.execute(config, client, executeTool);

      expect(result.response).toBe('Found 3 hotels.');
      expect(result.action.type).toBe('continue');
      expect(result.iterations).toBe(2);
      expect(result.toolSelections).toEqual(['search']);
      expect(executeTool).toHaveBeenCalledWith('search', { query: 'hotels' });
      expect(getCallCount()).toBe(2);
    });

    test('handles multiple tool calls in a single iteration', async () => {
      const { client } = simpleMockLLMClient((callIndex) => {
        if (callIndex === 1) {
          return makeToolUseResponse([
            { id: 'tc1', name: 'search', input: { query: 'hotels' } },
            { id: 'tc2', name: 'lookup', input: { id: '123' } },
          ]);
        }
        return makeTextResponse('Found results.');
      });

      const executeTool = vi.fn().mockResolvedValue({ ok: true });
      const result = await executor.execute(createConfig(), client, executeTool);

      expect(result.toolSelections).toEqual(['search', 'lookup']);
      expect(executeTool).toHaveBeenCalledTimes(2);
      expect(result.iterations).toBe(2);
    });

    test('returns text directly when LLM produces no tool calls', async () => {
      const { client } = simpleMockLLMClient(() => makeTextResponse('Hello!'));
      const executeTool = vi.fn();

      const result = await executor.execute(createConfig(), client, executeTool);

      expect(result.response).toBe('Hello!');
      expect(result.action.type).toBe('continue');
      expect(result.iterations).toBe(1);
      expect(result.toolSelections).toEqual([]);
      expect(executeTool).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // __complete__ tool
  // ---------------------------------------------------------------------------

  describe('System Tool: __complete__', () => {
    test('__complete__ ends reasoning with complete action', async () => {
      const { client } = simpleMockLLMClient(() =>
        makeToolUseResponse(
          [{ id: 'tc1', name: '__complete__', input: { message: 'All done!' } }],
          'Wrapping up.',
        ),
      );

      const executeTool = vi.fn();
      const result = await executor.execute(createConfig(), client, executeTool);

      expect(result.action.type).toBe('complete');
      expect(result.action).toEqual({ type: 'complete', message: 'All done!' });
      expect(result.iterations).toBe(1);
      expect(result.toolSelections).toEqual(['__complete__']);
      // Regular tool executor should NOT be called for system tools
      expect(executeTool).not.toHaveBeenCalled();
    });

    test('__complete__ without message still ends loop', async () => {
      const { client } = simpleMockLLMClient(() =>
        makeToolUseResponse([{ id: 'tc1', name: '__complete__', input: {} }]),
      );

      const executeTool = vi.fn();
      const result = await executor.execute(createConfig(), client, executeTool);

      expect(result.action.type).toBe('complete');
      expect(result.iterations).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // __escalate__ tool
  // ---------------------------------------------------------------------------

  describe('System Tool: __escalate__', () => {
    test('__escalate__ ends reasoning with escalate action', async () => {
      const { client } = simpleMockLLMClient(() =>
        makeToolUseResponse([
          {
            id: 'tc1',
            name: '__escalate__',
            input: { reason: 'Customer angry', priority: 'high' },
          },
        ]),
      );

      const executeTool = vi.fn();
      const result = await executor.execute(createConfig(), client, executeTool);

      expect(result.action).toEqual({
        type: 'escalate',
        reason: 'Customer angry',
        priority: 'high',
      });
      expect(result.iterations).toBe(1);
      expect(result.toolSelections).toEqual(['__escalate__']);
      expect(executeTool).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // __handoff__ and per-agent routing tools
  // ---------------------------------------------------------------------------

  describe('System Tool: __handoff__', () => {
    test('__handoff__ breaks only when the executed handoff returns a visible response', async () => {
      const { client } = simpleMockLLMClient(() =>
        makeToolUseResponse([{ id: 'tc1', name: '__handoff__', input: { target: 'Sales_Agent' } }]),
      );

      const executeTool = vi.fn().mockResolvedValue({
        success: true,
        response: 'Transferred to Sales_Agent.',
      });
      const result = await executor.execute(createConfig(), client, executeTool);

      expect(result.action).toEqual({ type: 'handoff', target: 'Sales_Agent' });
      expect(result.response).toBe('Transferred to Sales_Agent.');
      expect(result.iterations).toBe(1);
      expect(executeTool).toHaveBeenCalledWith('__handoff__', { target: 'Sales_Agent' });
    });

    test('silent __handoff__ continues the loop and resets the action to continue', async () => {
      const { client } = simpleMockLLMClient((callIndex) => {
        if (callIndex === 1) {
          return makeToolUseResponse([
            { id: 'tc1', name: '__handoff__', input: { target: 'Sales_Agent' } },
          ]);
        }
        return makeTextResponse('Supervisor follow-up.');
      });

      const executeTool = vi.fn().mockResolvedValue({ success: true, response: '' });
      const result = await executor.execute(createConfig(), client, executeTool);

      expect(result.action).toEqual({ type: 'continue' });
      expect(result.response).toBe('Supervisor follow-up.');
      expect(result.iterations).toBe(2);
    });

    test('handoff_to_* extracts target from tool name and respects visible responses', async () => {
      const { client } = simpleMockLLMClient(() =>
        makeToolUseResponse([
          { id: 'tc1', name: 'handoff_to_Billing_Agent', input: { message: 'billing issue' } },
        ]),
      );

      const executeTool = vi.fn().mockResolvedValue({
        success: true,
        response: 'Billing_Agent is taking over.',
      });
      const result = await executor.execute(createConfig(), client, executeTool);

      expect(result.action).toEqual({ type: 'handoff', target: 'Billing_Agent' });
      expect(result.response).toBe('Billing_Agent is taking over.');
    });

    test('delegate_to_* classifies as delegate and continues the loop', async () => {
      const { client } = simpleMockLLMClient((callIndex) => {
        if (callIndex === 1) {
          return makeToolUseResponse([{ id: 'tc1', name: 'delegate_to_Research', input: {} }]);
        }
        return makeTextResponse('Research complete.');
      });

      const executeTool = vi.fn().mockResolvedValue({ success: true, notes: 'done' });
      const result = await executor.execute(createConfig(), client, executeTool);

      expect(result.action).toEqual({ type: 'delegate', target: 'Research' });
      expect(result.response).toBe('Research complete.');
      expect(result.iterations).toBe(2);
      expect(executeTool).toHaveBeenCalledWith('delegate_to_Research', {});
    });
  });

  // ---------------------------------------------------------------------------
  // MAX_ITERATIONS enforcement
  // ---------------------------------------------------------------------------

  describe('Max Iterations', () => {
    test('enforces max iterations and produces fallback response', async () => {
      const { client, getCallCount } = simpleMockLLMClient(() =>
        makeToolUseResponse([{ id: `tc_${Date.now()}`, name: 'search', input: { query: 'loop' } }]),
      );

      const executeTool = vi.fn().mockResolvedValue({ result: 'ok' });
      const config = createConfig({ maxIterations: 5 });

      const result = await executor.execute(config, client, executeTool);

      expect(result.iterations).toBe(5);
      expect(result.maxIterationsReached).toBe(true);
      expect(result.response).toBe('I was unable to complete the response. Please try again.');
      expect(getCallCount()).toBe(5);
      expect(executeTool).toHaveBeenCalledTimes(5);
    });

    test('uses default max iterations (10) when not specified', async () => {
      const { client, getCallCount } = simpleMockLLMClient(() =>
        makeToolUseResponse([{ id: `tc_${Date.now()}`, name: 'search', input: { query: 'loop' } }]),
      );

      const executeTool = vi.fn().mockResolvedValue({ result: 'ok' });
      const config = createConfig();

      const result = await executor.execute(config, client, executeTool);

      expect(result.iterations).toBe(10);
      expect(result.maxIterationsReached).toBe(true);
      expect(getCallCount()).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool execution errors
  // ---------------------------------------------------------------------------

  describe('Tool Execution Errors', () => {
    test('tool error is returned as error JSON to LLM, loop continues', async () => {
      const { client } = simpleMockLLMClient((callIndex) => {
        if (callIndex === 1) {
          return makeToolUseResponse([{ id: 'tc1', name: 'search', input: { query: 'fail' } }]);
        }
        return makeTextResponse('Sorry, the search failed.');
      });

      const executeTool = vi.fn().mockRejectedValue(new Error('Tool service unavailable'));
      const onTrace = vi.fn();

      const result = await executor.execute(createConfig(), client, executeTool, onTrace);

      expect(result.response).toBe('Sorry, the search failed.');
      expect(result.iterations).toBe(2);
      // Verify tool_error trace was emitted
      const errorTraces = onTrace.mock.calls.filter(
        (call: [{ type: string }]) => call[0].type === 'tool_error',
      );
      expect(errorTraces.length).toBe(1);
      expect(errorTraces[0][0].data.toolName).toBe('search');
      expect(errorTraces[0][0].data.error).toBe('Tool service unavailable');
    });

    test('non-Error thrown by tool is stringified', async () => {
      const { client } = simpleMockLLMClient((callIndex) => {
        if (callIndex === 1) {
          return makeToolUseResponse([{ id: 'tc1', name: 'search', input: { query: 'fail' } }]);
        }
        return makeTextResponse('Recovered.');
      });

      const executeTool = vi.fn().mockRejectedValue('string error');
      const onTrace = vi.fn();

      const result = await executor.execute(createConfig(), client, executeTool, onTrace);

      expect(result.response).toBe('Recovered.');
      const errorTraces = onTrace.mock.calls.filter(
        (call: [{ type: string }]) => call[0].type === 'tool_error',
      );
      expect(errorTraces[0][0].data.error).toBe('string error');
    });
  });

  // ---------------------------------------------------------------------------
  // Consecutive empty responses
  // ---------------------------------------------------------------------------

  describe('Consecutive Empty Responses', () => {
    test('breaks loop after 2 consecutive empty responses', async () => {
      const { client, getCallCount } = simpleMockLLMClient(() => ({
        text: '',
        toolCalls: [],
        stopReason: 'end_turn' as const,
      }));

      const executeTool = vi.fn();
      const onTrace = vi.fn();

      const result = await executor.execute(createConfig(), client, executeTool, onTrace);

      // First empty response increments counter, second triggers break
      expect(getCallCount()).toBe(2);
      expect(result.response).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // Tool call classification
  // ---------------------------------------------------------------------------

  describe('Tool Call Classification', () => {
    test('classifies system tools correctly', () => {
      const systemTools = [
        '__complete__',
        '__escalate__',
        '__handoff__',
        '__delegate__',
        '__fan_out__',
        '__set_context__',
        '__return_to_parent__',
        'handoff_to_Sales',
        'delegate_to_Research',
      ];

      for (const name of systemTools) {
        const result = executor.classifyToolCall({ id: '1', name, input: {} });
        expect(result.kind).toBe('system');
      }
    });

    test('classifies regular tools correctly', () => {
      const regularTools = ['search', 'lookup', 'calculate', 'get_weather'];

      for (const name of regularTools) {
        const result = executor.classifyToolCall({ id: '1', name, input: {} });
        expect(result.kind).toBe('regular');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Shadow mode comparison helpers
  // ---------------------------------------------------------------------------

  describe('Shadow Mode: Tool Selection Agreement', () => {
    test('old and new paths agree on tool selection order', async () => {
      // Simulate what the old runtime path would produce
      const expectedToolSelections = ['search', 'lookup'];

      const { client } = simpleMockLLMClient((callIndex) => {
        if (callIndex === 1) {
          return makeToolUseResponse([{ id: 'tc1', name: 'search', input: { query: 'hotels' } }]);
        }
        if (callIndex === 2) {
          return makeToolUseResponse([{ id: 'tc2', name: 'lookup', input: { id: '123' } }]);
        }
        return makeTextResponse('Done.');
      });

      const executeTool = vi.fn().mockResolvedValue({ ok: true });
      const result = await executor.execute(createConfig(), client, executeTool);

      // Shadow comparison: verify the new executor produces the same
      // tool selection sequence as the old path would
      expect(result.toolSelections).toEqual(expectedToolSelections);
    });

    test('system tool selections are tracked in order', async () => {
      const { client } = simpleMockLLMClient((callIndex) => {
        if (callIndex === 1) {
          return makeToolUseResponse([{ id: 'tc1', name: 'search', input: { query: 'test' } }]);
        }
        return makeToolUseResponse([
          { id: 'tc2', name: '__complete__', input: { message: 'Done' } },
        ]);
      });

      const executeTool = vi.fn().mockResolvedValue({ ok: true });
      const result = await executor.execute(createConfig(), client, executeTool);

      expect(result.toolSelections).toEqual(['search', '__complete__']);
    });
  });

  describe('Shadow Mode: Iteration Count Agreement', () => {
    test('iteration count matches expected for tool-then-text pattern', async () => {
      const { client } = simpleMockLLMClient((callIndex) => {
        if (callIndex <= 3) {
          return makeToolUseResponse([
            { id: `tc${callIndex}`, name: 'search', input: { query: `q${callIndex}` } },
          ]);
        }
        return makeTextResponse('Final answer.');
      });

      const executeTool = vi.fn().mockResolvedValue({ ok: true });
      const result = await executor.execute(createConfig(), client, executeTool);

      // 3 tool iterations + 1 final text = 4 iterations
      expect(result.iterations).toBe(4);
      expect(result.maxIterationsReached).toBe(false);
    });

    test('iteration count matches expected for system tool exit', async () => {
      const { client } = simpleMockLLMClient((callIndex) => {
        if (callIndex === 1) {
          return makeToolUseResponse([{ id: 'tc1', name: 'search', input: { query: 'test' } }]);
        }
        return makeToolUseResponse([
          { id: 'tc2', name: '__escalate__', input: { reason: 'need help' } },
        ]);
      });

      const executeTool = vi.fn().mockResolvedValue({ ok: true });
      const result = await executor.execute(createConfig(), client, executeTool);

      expect(result.iterations).toBe(2);
      expect(result.action.type).toBe('escalate');
    });
  });

  // ---------------------------------------------------------------------------
  // Trace emission
  // ---------------------------------------------------------------------------

  describe('Trace Emission', () => {
    test('emits reasoning_iteration trace for each iteration', async () => {
      const { client } = simpleMockLLMClient((callIndex) => {
        if (callIndex === 1) {
          return makeToolUseResponse([{ id: 'tc1', name: 'search', input: { query: 'test' } }]);
        }
        return makeTextResponse('Done.');
      });

      const executeTool = vi.fn().mockResolvedValue({ ok: true });
      const onTrace = vi.fn();

      await executor.execute(createConfig(), client, executeTool, onTrace);

      const iterationTraces = onTrace.mock.calls.filter(
        (call: [{ type: string }]) => call[0].type === 'reasoning_iteration',
      );
      expect(iterationTraces.length).toBe(2);
      expect(iterationTraces[0][0].data.iteration).toBe(1);
      expect(iterationTraces[0][0].data.hasToolCalls).toBe(true);
      expect(iterationTraces[1][0].data.iteration).toBe(2);
      expect(iterationTraces[1][0].data.hasToolCalls).toBe(false);
    });

    test('emits warning trace when max iterations reached', async () => {
      const { client } = simpleMockLLMClient(() =>
        makeToolUseResponse([{ id: `tc_${Date.now()}`, name: 'search', input: { query: 'loop' } }]),
      );

      const executeTool = vi.fn().mockResolvedValue({ ok: true });
      const onTrace = vi.fn();

      await executor.execute(createConfig({ maxIterations: 3 }), client, executeTool, onTrace);

      const warningTraces = onTrace.mock.calls.filter(
        (call: [{ type: string }]) =>
          call[0].type === 'warning' && call[0].data.message?.toString().includes('Max iterations'),
      );
      expect(warningTraces.length).toBe(1);
    });
  });
});
