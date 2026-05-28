import { describe, expect, test, it, vi } from 'vitest';
import { ReasoningExecutor } from '../../platform/constructs/executors/reasoning-executor.js';
import type { ReasoningConfig } from '../../platform/constructs/executors/reasoning-executor.js';
import { resolveReasoningZoneEmptyMessageGate } from '../../platform/constructs/executors/reasoning-zone-empty-message-gate.js';
import type {
  LLMClient,
  LLMToolCall,
  LLMToolDefinition,
  LLMToolUseResult,
} from '../../platform/constructs/types.js';

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

function createConfig(overrides: Partial<ReasoningConfig> = {}): ReasoningConfig {
  return {
    systemPrompt: 'You are a helpful assistant.',
    tools: [SEARCH_TOOL],
    messages: [{ role: 'user', content: 'help me route this' }],
    ...overrides,
  };
}

function createMockLLMClient(handler: (callIndex: number) => LLMToolUseResult): {
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

describe('ReasoningExecutor routing system-tool loop parity', () => {
  const executor = new ReasoningExecutor();

  test('handoff breaks only when the executed handoff returns a visible response', async () => {
    const { client, getCallCount } = createMockLLMClient(() =>
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
    expect(getCallCount()).toBe(1);
  });

  test('silent handoff continues the loop and resets action to continue', async () => {
    const { client, getCallCount } = createMockLLMClient((callIndex) => {
      if (callIndex === 1) {
        return makeToolUseResponse([
          { id: 'tc1', name: '__handoff__', input: { target: 'Sales' } },
        ]);
      }
      return makeTextResponse('Supervisor follow-up.');
    });

    const executeTool = vi.fn().mockResolvedValue({ success: true, response: '' });
    const result = await executor.execute(createConfig(), client, executeTool);

    expect(result.action).toEqual({ type: 'continue' });
    expect(result.response).toBe('Supervisor follow-up.');
    expect(result.iterations).toBe(2);
    expect(getCallCount()).toBe(2);
  });

  test('handoff with terminal disposition but no visible response still continues', async () => {
    const { client, getCallCount } = createMockLLMClient((callIndex) => {
      if (callIndex === 1) {
        return makeToolUseResponse([
          { id: 'tc1', name: '__handoff__', input: { target: 'Sales' } },
        ]);
      }
      return makeTextResponse('Supervisor handles the terminal outcome.');
    });

    const executeTool = vi.fn().mockResolvedValue({
      success: true,
      response: '',
      disposition: 'returned_to_parent',
    });
    const result = await executor.execute(createConfig(), client, executeTool);

    expect(result.action).toEqual({ type: 'continue' });
    expect(result.response).toBe('Supervisor handles the terminal outcome.');
    expect(result.iterations).toBe(2);
    expect(getCallCount()).toBe(2);
  });

  test('delegate continues so the LLM can synthesize a follow-up', async () => {
    const { client, getCallCount } = createMockLLMClient((callIndex) => {
      if (callIndex === 1) {
        return makeToolUseResponse([
          { id: 'tc1', name: '__delegate__', input: { target: 'Research' } },
        ]);
      }
      return makeTextResponse('Research complete.');
    });

    const executeTool = vi.fn().mockResolvedValue({ success: true, notes: 'done' });
    const result = await executor.execute(createConfig(), client, executeTool);

    expect(result.action).toEqual({ type: 'delegate', target: 'Research' });
    expect(result.response).toBe('Research complete.');
    expect(result.iterations).toBe(2);
    expect(getCallCount()).toBe(2);
  });

  test('fan_out continues so the LLM can synthesize branch results', async () => {
    const { client, getCallCount } = createMockLLMClient((callIndex) => {
      if (callIndex === 1) {
        return makeToolUseResponse([{ id: 'tc1', name: '__fan_out__', input: { tasks: [] } }]);
      }
      return makeTextResponse('Combined branch summary.');
    });

    const executeTool = vi.fn().mockResolvedValue({
      results: [{ target: 'Flight_Agent', status: 'completed', response: 'done' }],
    });
    const result = await executor.execute(createConfig(), client, executeTool);

    expect(result.action).toEqual({ type: 'fan_out' });
    expect(result.response).toBe('Combined branch summary.');
    expect(result.iterations).toBe(2);
    expect(getCallCount()).toBe(2);
  });

  test('return_to_parent remains terminal', async () => {
    const { client, getCallCount } = createMockLLMClient(() =>
      makeToolUseResponse([
        {
          id: 'tc1',
          name: '__return_to_parent__',
          input: { message: 'Need supervisor help' },
        },
      ]),
    );

    const executeTool = vi.fn();
    const result = await executor.execute(createConfig(), client, executeTool);

    expect(result.action).toEqual({ type: 'return_to_parent' });
    expect(result.iterations).toBe(1);
    expect(getCallCount()).toBe(1);
    expect(executeTool).not.toHaveBeenCalled();
  });
});

// ─── ABLP-986: auto-advance with empty user message ──────────────────────────
//
// When a REASONING step is entered via auto-advance from a scripted step,
// currentMessage is empty (consumed by the prior step). The compiler-level
// ReasoningExecutor must still drive the LLM from the GOAL/system prompt
// instead of bailing on an empty message; the runtime FlowStepExecutor gate
// is the corresponding guard that lets execution reach this code.

describe('ReasoningExecutor — ABLP-986: auto-advance with empty user message', () => {
  const setContextTool: LLMToolDefinition = {
    name: '__set_context__',
    description: 'Store context variables',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string' },
      },
    },
  };

  it(
    'should invoke LLM and produce a response even when entered with no user message ' +
      '(runtime FlowStepExecutor gate decides reachability separately)',
    async () => {
      const { client, getCallCount } = createMockLLMClient(() =>
        makeTextResponse(
          'What dates would you like for your annual leave? You can use natural language like "next Monday to Friday".',
        ),
      );

      const executor = new ReasoningExecutor();
      const result = await executor.execute(
        {
          systemPrompt:
            'Goal: Collect start_date and end_date for leave. Parse natural language dates.',
          // Empty messages array simulates auto-advance with no user input
          messages: [],
          tools: [setContextTool],
          maxIterations: 3,
        },
        client,
        async (_toolName, _input) => ({ success: true }),
      );

      expect(result.response).toBeTruthy();
      expect(result.response).toContain('dates');
      // Auto-advance with empty messages must hit the LLM exactly once — the
      // executor used to short-circuit before any call, or now must not loop.
      expect(getCallCount()).toBe(1);
    },
  );

  it('runtime gate executes reasoning from GOAL when auto-advance has no user text or PRESENT fallback', () => {
    const decision = resolveReasoningZoneEmptyMessageGate({
      hasReasoningZone: true,
      currentMessage: '',
      present: undefined,
      goal: 'Collect start and end dates',
    });

    expect(decision.mode).toBe('execute_reasoning_with_goal');
  });
});
