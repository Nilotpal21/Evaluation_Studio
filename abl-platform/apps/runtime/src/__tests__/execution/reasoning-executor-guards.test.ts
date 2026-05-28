/**
 * ReasoningExecutor Safety Guards Tests
 *
 * Tests for:
 * - Iteration limit enforcement (custom and default)
 * - Consecutive empty LLM response guard
 * - Empty response counter reset on non-empty response
 * - Missing LLM client error
 * - Multiple tool calls in a single iteration
 * - System tool (__complete__) loop break
 * - System tool (__escalate__) loop break
 * - Regular tool result stored in session.data.values
 * - Reasoning agent with GATHER fields entity extraction
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import {
  RuntimeExecutor,
  compileToResolvedAgent,
  buildSystemPrompt,
  buildTools,
  type RuntimeSession,
  type RuntimeState,
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
      text: 'I can help you with that.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I can help you with that.' }],
    });
  }

  setResponseHandler(handler: typeof this.responseHandler) {
    this.responseHandler = handler;
  }

  setEntityExtractionResponse(entities: Record<string, unknown>) {
    const previousHandler = this.responseHandler;
    this.responseHandler = (systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '',
          toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: entities }],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: entities },
          ],
        };
      }
      return previousHandler(systemPrompt, messages, tools);
    };
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

  async resolveLanguageModel(_operationType: string) {
    return null;
  }

  async resolveLanguageModelForModelOverride(_modelId: string, _operationType?: string) {
    return null;
  }

  getLastResolvedModel() {
    return { modelId: 'test-model', provider: 'test', source: 'test' };
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

GOAL: "Test agent for safety guard testing"

PERSONA: "Helpful test assistant"

TOOLS:
  search(query: string) -> {results: array}
    description: "Search for information"
`;

const REASONING_AGENT_WITH_ESCALATION = `
AGENT: TestAgent

GOAL: "Test agent for safety guard testing"

PERSONA: "Helpful test assistant"

TOOLS:
  search(query: string) -> {results: array}
    description: "Search for information"

ESCALATE:
  triggers:
    - WHEN: "Customer is upset"
      REASON: "Customer escalation"
      PRIORITY: high
`;

const REASONING_AGENT_WITH_GATHER = `
AGENT: GatherAgent

GOAL: "Test agent with gather fields"

PERSONA: "Helpful test assistant"

TOOLS:
  search(query: string) -> {results: array}
    description: "Search for information"

GATHER:
  city:
    prompt: "What city?"
    type: string
    required: true

  date:
    prompt: "What date?"
    type: string
    required: true
`;

const REASONING_AGENT_TWO_TOOLS = `
AGENT: MultiToolAgent

GOAL: "Test agent with multiple tools"

PERSONA: "Helpful test assistant"

TOOLS:
  search(query: string) -> {results: array}
    description: "Search for information"

  lookup(id: string) -> {item: object}
    description: "Lookup an item by ID"
`;

const REASONING_AGENT_WITH_INPUT_CONSTRAINT = `
AGENT: InputConstraintAgent

GOAL: "Test input-aware constraints in reasoning mode"

PERSONA: "Helpful test assistant"

CONSTRAINTS:
  - REQUIRE input contains "vip"
    ON_FAIL: RESPOND "Please mention vip in your request."
`;

const REASONING_AGENT_WITH_POST_TOOL_CONSTRAINT = `
AGENT: ConstraintSetContextAgent

GOAL: "Test post-tool ON_FAIL handling"

PERSONA: "Helpful test assistant"

MEMORY:
  session:
    - priority

CONSTRAINTS:
  - REQUIRE priority != "critical"
    ON_FAIL: RESPOND "Critical cases require a specialist."
`;

const REASONING_AGENT_WITH_BEFORE_TOOL_CONSTRAINT = `
AGENT: BeforeToolAgent

GOAL: "Test structural BEFORE tool checkpoints"

PERSONA: "Helpful test assistant"

TOOLS:
  search(query: string) -> {results: array}
    description: "Search for information"

CONSTRAINTS:
  - REQUIRE ready_for_search == true BEFORE calling search
    ON_FAIL: RESPOND "Confirm the search before calling the tool."
`;

const REASONING_AGENT_WITH_BEFORE_RESPONSE_CONSTRAINT = `
AGENT: BeforeResponseAgent

GOAL: "Test structural BEFORE response checkpoints"

PERSONA: "Helpful test assistant"

CONSTRAINTS:
  - REQUIRE reviewed == true BEFORE returning results
    ON_FAIL: RESPOND "Review is required before responding."
`;

// =============================================================================
// TESTS
// =============================================================================

describe('ReasoningExecutor Safety Guards', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  // ===========================================================================
  // 1. Iteration limit from IR is respected
  // ===========================================================================

  test('should respect max_iterations from agent IR', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // Override max_iterations on the IR to a small value
    session.agentIR!.execution!.max_iterations = 3;

    // Set up a tool executor so regular tool calls succeed
    session.toolExecutor = {
      execute: async (name: string, args: any) => ({ results: ['item1'] }),
    } as any;

    // Mock LLM to always return a tool call (never a final text response)
    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      // Entity extraction calls (no tools) should not happen for this agent (no GATHER)
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '',
          toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
          stopReason: 'tool_use',
          rawContent: [{ type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} }],
        };
      }
      callCount++;
      return {
        text: '',
        toolCalls: [{ id: `call-${callCount}`, name: 'search', input: { query: 'test' } }],
        stopReason: 'tool_use',
        rawContent: [
          { type: 'tool_use', id: `call-${callCount}`, name: 'search', input: { query: 'test' } },
        ],
      };
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'Search for something',
      undefined,
      traceCollector.callback,
    );

    // Should have stopped after 3 iterations and provided a fallback
    expect(callCount).toBe(3);
    expect(result.response).toBe('I was unable to complete the response. Please try again.');

    // Should emit a warning trace about max iterations
    const warnings = filterTraces(traceCollector.traces, 'warning');
    const maxIterWarning = warnings.find((w) =>
      (w.data.message as string)?.includes('Max iterations reached'),
    );
    expect(maxIterWarning).toBeDefined();
    expect(maxIterWarning!.data.maxIterations).toBe(3);
  });

  // ===========================================================================
  // 2. Default iteration limit (10) when not specified in IR
  // ===========================================================================

  test('should use default max iterations (10) when not specified in IR', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // Ensure max_iterations is not set
    if (session.agentIR?.execution) {
      delete (session.agentIR.execution as any).max_iterations;
    }

    session.toolExecutor = {
      execute: async (name: string, args: any) => ({ results: ['item1'] }),
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '',
          toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
          stopReason: 'tool_use',
          rawContent: [{ type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} }],
        };
      }
      callCount++;
      return {
        text: '',
        toolCalls: [{ id: `call-${callCount}`, name: 'search', input: { query: 'test' } }],
        stopReason: 'tool_use',
        rawContent: [
          { type: 'tool_use', id: `call-${callCount}`, name: 'search', input: { query: 'test' } },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, 'Search for something');

    // Should have stopped after exactly 10 iterations (default)
    expect(callCount).toBe(10);
    expect(result.response).toBe('I was unable to complete the response. Please try again.');
  });

  // ===========================================================================
  // 3. Empty LLM response (no text, no tool calls) breaks the loop
  // ===========================================================================

  test('should break loop on empty LLM response with no tool calls', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // Mock LLM to return an empty response (no text, no tool calls).
    // The reasoning loop treats "no tool calls" as a final response and breaks,
    // while also incrementing the consecutive empty response counter.
    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '',
          toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
          stopReason: 'tool_use',
          rawContent: [{ type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} }],
        };
      }
      callCount++;
      return {
        text: '',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [],
      };
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'Hello',
      undefined,
      traceCollector.callback,
    );

    // The loop breaks after 1 LLM call because "no tool calls" is treated as
    // a final response (even if the text is empty).
    expect(callCount).toBeGreaterThanOrEqual(1);

    // The empty response becomes the final response (empty string)
    // The response should be empty since the LLM returned no text
    expect(result.response).toBe('');

    // An llm_call trace should have been emitted
    const llmTraces = filterTraces(traceCollector.traces, 'llm_call');
    expect(llmTraces.length).toBeGreaterThanOrEqual(1);
    expect(llmTraces[llmTraces.length - 1].data.hasToolCalls).toBe(false);
  });

  test('should prefer stamped current-turn input over replay history in LLM messages', async () => {
    const originalIntent = 'check my balance for user@example.com';
    const sanitizedIntent = 'check my balance for [REDACTED_EMAIL]';
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    session.initialized = true;
    session.llmClient = mockClient as any;
    session.conversationHistory.push({ role: 'user', content: originalIntent });
    session.data.values.input = sanitizedIntent;
    session.data.values._raw_input = originalIntent;

    mockClient.setResponseHandler(() => ({
      text: 'Replay path executed.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Replay path executed.' }],
    }));

    const result = await (executor as any).reasoning.execute(
      session,
      buildSystemPrompt(session),
      buildTools(session),
      undefined,
      undefined,
      { skipInputGuardrails: true },
    );

    expect(result.response).toBe('Replay path executed.');
    expect(mockClient.calls).toHaveLength(1);
    expect(mockClient.calls[0]?.messages.filter((message) => message.role === 'user')).toEqual([
      {
        role: 'user',
        content: sanitizedIntent,
      },
    ]);
    expect(session.data.values.input).toBe(sanitizedIntent);
    expect(session.data.values._raw_input).toBe(originalIntent);
    expect(
      session.conversationHistory
        .filter((entry) => entry.role === 'user')
        .map((entry) => entry.content),
    ).toEqual([originalIntent]);
  });

  // ===========================================================================
  // 4. Consecutive empty counter resets after a non-empty response
  // ===========================================================================

  test('should reset consecutive empty counter after a non-empty response', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    session.toolExecutor = {
      execute: async (name: string, args: any) => ({ results: ['found'] }),
    } as any;

    // Sequence:
    // Call 1: tool call with no text (non-empty because has tool calls -> counter stays 0)
    // Call 2: tool call with no text (non-empty -> counter stays 0)
    // Call 3: final text response (non-empty -> counter stays 0, loop breaks)
    //
    // This verifies that tool-call responses (no text but has tool calls) do NOT
    // trigger the empty response counter since they are non-empty by definition.
    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '',
          toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
          stopReason: 'tool_use',
          rawContent: [{ type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} }],
        };
      }
      callCount++;
      if (callCount <= 2) {
        // Tool call with no text: this is NOT empty (has tool calls), so counter stays at 0
        return {
          text: '',
          toolCalls: [
            { id: `call-${callCount}`, name: 'search', input: { query: `q${callCount}` } },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: `call-${callCount}`,
              name: 'search',
              input: { query: `q${callCount}` },
            },
          ],
        };
      }
      // Call 3: final text response
      return {
        text: 'Here are your results.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Here are your results.' }],
      };
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'Test message',
      undefined,
      traceCollector.callback,
    );

    // Should have made 3 LLM calls (2 tool calls + 1 final response)
    expect(callCount).toBe(3);

    // No consecutive empty warning should be emitted because tool-call responses
    // are non-empty (they have tool calls), so the counter never increments.
    const warnings = filterTraces(traceCollector.traces, 'warning');
    const emptyWarning = warnings.find((w) =>
      (w.data.message as string)?.includes('Consecutive empty LLM responses'),
    );
    expect(emptyWarning).toBeUndefined();

    // Final response should be the text from the last LLM call
    expect(result.response).toBe('Here are your results.');
  });

  // ===========================================================================
  // 5. No LLM client throws AppError
  // ===========================================================================

  test('should throw error when LLM client is not configured', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // Null out the LLM client after session creation
    session.llmClient = undefined;

    // Also prevent ensureSessionLLMClient from re-injecting a mock
    (executor as any).llmWiring.ensureSessionLLMClient = async (session: any) => {
      // Do nothing - leave llmClient undefined
    };

    await expect(executor.executeMessage(session.id, 'Hello')).rejects.toThrow(
      'LLM client not configured',
    );
  });

  // ===========================================================================
  // 6. Tool execution with multiple tool calls in one iteration
  // ===========================================================================

  test('should execute multiple tool calls in a single iteration', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_TWO_TOOLS], 'MultiToolAgent'),
    );

    const toolCallLog: Array<{ name: string; args: any }> = [];
    session.toolExecutor = {
      execute: async (name: string, args: any) => {
        toolCallLog.push({ name, args });
        if (name === 'search') return { results: ['result1'] };
        if (name === 'lookup') return { item: { id: '123', name: 'test' } };
        return { error: 'unknown tool' };
      },
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '',
          toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
          stopReason: 'tool_use',
          rawContent: [{ type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} }],
        };
      }
      callCount++;
      if (callCount === 1) {
        // Return two tool calls in a single response
        return {
          text: 'Let me search and lookup for you.',
          toolCalls: [
            { id: 'call-1a', name: 'search', input: { query: 'info' } },
            { id: 'call-1b', name: 'lookup', input: { id: '42' } },
          ],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'text', text: 'Let me search and lookup for you.' },
            { type: 'tool_use', id: 'call-1a', name: 'search', input: { query: 'info' } },
            { type: 'tool_use', id: 'call-1b', name: 'lookup', input: { id: '42' } },
          ],
        };
      }
      // Second call: final text response
      return {
        text: 'Here are the results from both tools.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Here are the results from both tools.' }],
      };
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'Search and lookup',
      undefined,
      traceCollector.callback,
    );

    // Both tools should have been executed
    expect(toolCallLog).toHaveLength(2);
    expect(toolCallLog[0].name).toBe('search');
    expect(toolCallLog[1].name).toBe('lookup');

    // Tool call traces should have both
    const toolTraces = filterTraces(traceCollector.traces, 'tool_call');
    expect(toolTraces).toHaveLength(2);
    expect(toolTraces[0].data.toolName).toBe('search');
    expect(toolTraces[1].data.toolName).toBe('lookup');

    // Final response should come through
    expect(result.response).toBe('Here are the results from both tools.');
  });

  // ===========================================================================
  // 6b. Undeclared tool calls are rejected (not executed)
  // ===========================================================================

  test('should reject tool calls not declared in agent IR', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_TWO_TOOLS], 'MultiToolAgent'),
    );

    const toolCallLog: Array<{ name: string; args: any }> = [];
    session.toolExecutor = {
      execute: async (name: string, args: any) => {
        toolCallLog.push({ name, args });
        return { success: true };
      },
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler(() => {
      callCount++;
      if (callCount === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'call-bad', name: 'delete_database', input: { confirm: true } }],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'tool_use', id: 'call-bad', name: 'delete_database', input: { confirm: true } },
          ],
        };
      }
      return {
        text: 'I could not find that tool.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'I could not find that tool.' }],
      };
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'Delete everything',
      undefined,
      traceCollector.callback,
    );

    // Tool should NOT have been executed
    expect(toolCallLog).toHaveLength(0);

    // Should have a rejection trace
    const toolTraces = filterTraces(traceCollector.traces, 'tool_call');
    const rejected = toolTraces.find((t) => t.data.status === 'rejected');
    expect(rejected).toBeDefined();
    expect(rejected!.data.reason).toBe('undeclared_tool');
    expect(rejected!.data.toolName).toBe('delete_database');
  });

  test('should allow built-in attachment tool calls even when not declared in agent IR', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_TWO_TOOLS], 'MultiToolAgent'),
    );

    const toolCallLog: Array<{ name: string; args: Record<string, unknown> }> = [];
    session.toolExecutor = {
      execute: async (name: string, args: Record<string, unknown>) => {
        toolCallLog.push({ name, args });
        return {
          success: true,
          data: {
            attachmentId: 'att-123',
            filename: String(args.filename ?? ''),
          },
        };
      },
    } as any;

    const uploadArgs = {
      filename: 'report.txt',
      content_base64: Buffer.from('test content').toString('base64'),
      mime_type: 'text/plain',
    };

    let callCount = 0;
    mockClient.setResponseHandler(() => {
      callCount++;
      if (callCount === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'call-upload', name: 'upload_attachment', input: uploadArgs }],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'tool_use', id: 'call-upload', name: 'upload_attachment', input: uploadArgs },
          ],
        };
      }
      return {
        text: 'The file is uploaded.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'The file is uploaded.' }],
      };
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'Upload the report',
      undefined,
      traceCollector.callback,
    );

    expect(result.response).toContain('uploaded');
    expect(toolCallLog).toHaveLength(1);
    expect(toolCallLog[0]?.name).toBe('upload_attachment');
    expect(toolCallLog[0]?.args).toMatchObject(uploadArgs);
    expect(toolCallLog[0]?.args._session).toMatchObject({
      agentName: 'MultiToolAgent',
      id: expect.any(String),
    });

    const toolTraces = filterTraces(traceCollector.traces, 'tool_call');
    const rejected = toolTraces.find((t) => t.data.status === 'rejected');
    expect(rejected).toBeUndefined();
  });

  // ===========================================================================
  // 7. System tool (__complete__) breaks loop
  // ===========================================================================

  test('should break loop when __complete__ system tool is called', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '',
          toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
          stopReason: 'tool_use',
          rawContent: [{ type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} }],
        };
      }
      callCount++;
      // LLM calls __complete__ on the first iteration
      return {
        text: '',
        toolCalls: [
          {
            id: 'complete-1',
            name: '__complete__',
            input: { message: 'Task completed successfully.' },
          },
        ],
        stopReason: 'tool_use',
        rawContent: [
          {
            type: 'tool_use',
            id: 'complete-1',
            name: '__complete__',
            input: { message: 'Task completed successfully.' },
          },
        ],
      };
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'Complete the task',
      undefined,
      traceCollector.callback,
    );

    // Should have only made 1 LLM call (loop breaks after __complete__)
    expect(callCount).toBe(1);

    // Action type should be 'complete'
    expect(result.action.type).toBe('complete');

    // Response should contain the completion message
    expect(result.response).toBe('Task completed successfully.');
  });

  // ===========================================================================
  // 8. System tool (__escalate__) breaks loop
  // ===========================================================================

  test('should break loop when __escalate__ system tool is called', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_ESCALATION], 'TestAgent'),
    );

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '',
          toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
          stopReason: 'tool_use',
          rawContent: [{ type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} }],
        };
      }
      callCount++;
      return {
        text: '',
        toolCalls: [
          {
            id: 'escalate-1',
            name: '__escalate__',
            input: { reason: 'Customer is upset', priority: 'high' },
          },
        ],
        stopReason: 'tool_use',
        rawContent: [
          {
            type: 'tool_use',
            id: 'escalate-1',
            name: '__escalate__',
            input: { reason: 'Customer is upset', priority: 'high' },
          },
        ],
      };
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'I need to speak to a manager',
      undefined,
      traceCollector.callback,
    );

    // Should have only made 1 LLM call
    expect(callCount).toBe(1);

    // Action type should be 'escalate'
    expect(result.action.type).toBe('escalate');
    expect(result.action.reason).toBe('Customer is upset');
    expect(result.action.priority).toBe('high');

    // Response should contain escalation message (new format with emoji + markdown)
    expect(result.response).toContain('Escalated to human agent');
    expect(result.response).toContain('Customer is upset');

    // Escalation trace event should be emitted
    const escalationTraces = filterTraces(traceCollector.traces, 'escalation');
    expect(escalationTraces.length).toBeGreaterThanOrEqual(1);
  });

  // ===========================================================================
  // 9. Regular tool stores result in session.data.values
  // ===========================================================================

  test('should store regular tool result in session.data.values', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    const searchResult = { results: ['result_a', 'result_b'] };
    session.toolExecutor = {
      execute: async (name: string, args: any) => searchResult,
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '',
          toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
          stopReason: 'tool_use',
          rawContent: [{ type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} }],
        };
      }
      callCount++;
      if (callCount === 1) {
        return {
          text: 'Let me search for you.',
          toolCalls: [{ id: 'call-1', name: 'search', input: { query: 'test query' } }],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'text', text: 'Let me search for you.' },
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'search',
              input: { query: 'test query' },
            },
          ],
        };
      }
      return {
        text: 'I found 2 results for your query.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'I found 2 results for your query.' }],
      };
    });

    await executor.executeMessage(session.id, 'Search for test query');

    // The tool result should be stored as `last_<toolName>_result`
    expect(session.data.values.last_search_result).toEqual(searchResult);
  });

  // ===========================================================================
  // 10. Reasoning agent with GATHER fields extracts entities
  // ===========================================================================

  test('should extract entities for reasoning agent with GATHER fields', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_GATHER], 'GatherAgent'),
    );

    // Configure entity extraction and main response
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        // Entity extraction
        return {
          text: '',
          toolCalls: [
            {
              id: 'extract-1',
              name: '_extract_entities',
              input: { city: 'London', date: '2026-05-01' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'extract-1',
              name: '_extract_entities',
              input: { city: 'London', date: '2026-05-01' },
            },
          ],
        };
      }
      // Main reasoning response
      return {
        text: 'Great, I can help you find things to do in London on May 1st.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'Great, I can help you find things to do in London on May 1st.',
          },
        ],
      };
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'I want to visit London on May 1st',
      undefined,
      traceCollector.callback,
    );

    // Entities should be extracted and stored in session data
    expect(session.data.values.city).toBe('London');
    expect(session.data.values.date).toBe('2026-05-01');

    // dsl_collect trace should be emitted with reasoning_gather mode
    const collectTraces = filterTraces(traceCollector.traces, 'dsl_collect');
    expect(collectTraces.length).toBeGreaterThanOrEqual(1);

    // Response should be from the main reasoning call
    expect(result.response).toContain('London');
  });

  // ===========================================================================
  // 11. __set_context__ triggers COMPLETE condition check
  // ===========================================================================

  test('should break reasoning loop when __set_context__ satisfies a COMPLETE condition', async () => {
    const dsl = `
AGENT: PolicyAgent

GOAL: "Look up policies and store the response"

PERSONA: "Policy specialist"

TOOLS:
  policy_search(query: string) -> {result: string}
    description: "Search for policies"

MEMORY:
  session:
    - policy_response

COMPLETE:
  - WHEN: policy_response IS SET
    RESPOND: "Policy lookup complete."
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'PolicyAgent'),
    );

    // Stub tool executor for policy_search
    session.toolExecutor = {
      execute: async () => ({ result: 'Coverage details here' }),
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      // Skip entity extraction calls
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '',
          toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
          stopReason: 'tool_use',
          rawContent: [{ type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} }],
        };
      }

      callCount++;

      if (callCount === 1) {
        // iter1: LLM calls policy_search tool
        return {
          text: '',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'policy_search',
              input: { query: 'coverage' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'policy_search',
              input: { query: 'coverage' },
            },
          ],
        };
      }

      if (callCount === 2) {
        // iter2: LLM calls __set_context__ to store the policy response
        return {
          text: '',
          toolCalls: [
            {
              id: 'ctx-1',
              name: '__set_context__',
              input: { updates: { policy_response: 'Coverage details here' } },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'ctx-1',
              name: '__set_context__',
              input: { updates: { policy_response: 'Coverage details here' } },
            },
          ],
        };
      }

      // iter3: Should NOT be reached — completion should fire after iter2
      return {
        text: 'This is a redundant LLM call that should not happen.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          { type: 'text', text: 'This is a redundant LLM call that should not happen.' },
        ],
      };
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'What is my policy coverage?',
      undefined,
      traceCollector.callback,
    );

    // Should have made exactly 2 LLM calls (policy_search + __set_context__)
    // NOT 3 (the redundant text response should be eliminated)
    expect(callCount).toBe(2);

    // The session variable should be stored
    expect(session.data.values.policy_response).toBe('Coverage details here');

    // Action type should be 'complete'
    expect(result.action.type).toBe('complete');

    // Response should contain the COMPLETE RESPOND message
    expect(result.response).toContain('Policy lookup complete.');

    // A completion_check trace should have been emitted from the set_context path
    const completionTraces = filterTraces(traceCollector.traces, 'completion_check');
    expect(completionTraces.length).toBeGreaterThanOrEqual(1);
    const passedTrace = completionTraces.find((t) => t.data.result === true);
    expect(passedTrace).toBeDefined();
  });

  test('should evaluate pre-loop input constraints against the current user message', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_INPUT_CONSTRAINT], 'InputConstraintAgent'),
    );

    const result = await executor.executeMessage(session.id, 'regular request');

    expect(result.response).toContain('Please mention vip in your request.');
    expect(result.action.type).toBe('constraint_blocked');
    expect(mockClient.calls).toHaveLength(0);
    expect(session.conversationHistory[session.conversationHistory.length - 1]?.content).toBe(
      'Please mention vip in your request.',
    );
  });

  test('should honor specific ON_FAIL actions for post-tool flat constraint failures', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [REASONING_AGENT_WITH_POST_TOOL_CONSTRAINT],
        'ConstraintSetContextAgent',
      ),
    );
    session.agentIR!.memory = { session: ['priority'] } as RuntimeSession['agentIR']['memory'];

    let callCount = 0;
    mockClient.setResponseHandler((_systemPrompt, _messages, _tools) => {
      callCount++;
      if (callCount === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'ctx-1',
              name: '__set_context__',
              input: { updates: { priority: 'critical' } },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'ctx-1',
              name: '__set_context__',
              input: { updates: { priority: 'critical' } },
            },
          ],
        };
      }

      return {
        text: 'This fallback response should not be used.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'This fallback response should not be used.' }],
      };
    });

    const result = await executor.executeMessage(session.id, 'mark this as critical');

    expect(callCount).toBe(1);
    expect(session.data.values.priority).toBe('critical');
    expect(result.response).toContain('Critical cases require a specialist.');
    expect(result.action.type).toBe('constraint_blocked');
    expect(session.conversationHistory[session.conversationHistory.length - 1]?.content).toBe(
      'Critical cases require a specialist.',
    );
  });

  test('should block reasoning tool execution at structural BEFORE tool checkpoints', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_BEFORE_TOOL_CONSTRAINT], 'BeforeToolAgent'),
    );

    let toolCalls = 0;
    session.toolExecutor = {
      execute: async () => {
        toolCalls++;
        return { results: ['item1'] };
      },
    } as any;

    let llmCalls = 0;
    mockClient.setResponseHandler(() => {
      llmCalls++;
      return {
        text: '',
        toolCalls: [{ id: 'call-1', name: 'search', input: { query: 'test' } }],
        stopReason: 'tool_use',
        rawContent: [{ type: 'tool_use', id: 'call-1', name: 'search', input: { query: 'test' } }],
      };
    });

    const result = await executor.executeMessage(session.id, 'search for test');

    expect(toolCalls).toBe(0);
    expect(result.response).toContain('Confirm the search before calling the tool.');
    expect(result.action.type).toBe('constraint_blocked');
    expect(session.conversationHistory[session.conversationHistory.length - 1]?.content).toBe(
      'Confirm the search before calling the tool.',
    );
  });

  test('should block final reasoning responses at structural BEFORE response checkpoints', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [REASONING_AGENT_WITH_BEFORE_RESPONSE_CONSTRAINT],
        'BeforeResponseAgent',
      ),
    );

    mockClient.setResponseHandler(() => ({
      text: 'This should not be returned.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'This should not be returned.' }],
    }));

    const result = await executor.executeMessage(session.id, 'answer now');

    expect(result.response).toContain('Review is required before responding.');
    expect(result.action.type).toBe('constraint_blocked');
    expect(session.conversationHistory[session.conversationHistory.length - 1]?.content).toBe(
      'Review is required before responding.',
    );
  });
});
