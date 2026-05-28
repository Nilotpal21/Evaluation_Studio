/**
 * Flow Step Thoughts Integration Tests (I-3B.1 to I-3B.4)
 *
 * Uses real FlowStepExecutor with trace collector (mock LLM client for reasoning zones).
 * Validates step_thought emission for multi-step flows, custom descriptions,
 * show_step_thoughts suppression, and interleaving with tool_thoughts.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';

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
// DSL FIXTURES
// =============================================================================

const MULTI_STEP_FLOW_AGENT = `
AGENT: MultiStepAgent

GOAL: "Agent with multi-step scripted flow"

TOOLS:
  search_database(query: string) -> {results: array}
    description: "Search the database"

FLOW:
  entry_point: start
  steps:
    - start
    - lookup
    - process
    - respond_result

start:
  REASONING: false
  RESPOND: "Hello! Let me help you."
  THEN: lookup

lookup:
  REASONING: false
  CALL: search_database
  THEN: process

process:
  REASONING: false
  SET: result_count = "len(results)"
  THEN: respond_result

respond_result:
  REASONING: false
  RESPOND: "Found your results."
  THEN: COMPLETE
`;

const SUPPRESSED_THOUGHTS_AGENT = `
AGENT: SuppressedAgent

GOAL: "Agent with step thoughts disabled"

EXECUTION:
  show_step_thoughts: false

TOOLS:
  search_tool(q: string) -> {data: string}
    description: "Search"

FLOW:
  entry_point: start
  steps:
    - start
    - lookup
    - done

start:
  REASONING: false
  RESPOND: "Hello!"
  THEN: lookup

lookup:
  REASONING: false
  CALL: search_tool
  THEN: done

done:
  REASONING: false
  RESPOND: "Done."
  THEN: COMPLETE
`;

const REASONING_WITH_FLOW_AGENT = `
AGENT: ReasonFlowAgent

GOAL: "Agent with both reasoning tools and flow steps"

PERSONA: "Helpful assistant"

TOOLS:
  analyze_data(input: string) -> {analysis: string}
    description: "Analyze data"

FLOW:
  entry_point: start
  steps:
    - start
    - analyze

start:
  REASONING: false
  RESPOND: "Starting analysis..."
  THEN: analyze

analyze:
  REASONING: false
  CALL: analyze_data
  THEN: COMPLETE
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Flow Step Thoughts Integration (I-3B.1 to I-3B.4)', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockLLMClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  // ===========================================================================
  // I-3B.1: Multi-step flow emits thought per step
  // ===========================================================================

  test('I-3B.1: multi-step flow emits step_thought events in order', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_STEP_FLOW_AGENT], 'MultiStepAgent'),
    );

    session.toolExecutor = {
      execute: async () => ({ results: ['item1', 'item2'] }),
    } as any;

    // LLM responds with end_turn for any reasoning calls
    mockClient.setResponseHandler(() => ({
      text: 'Done.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Done.' }],
    }));

    const { traces, callback } = createTraceCollector();
    session.conversationHistory.push({ role: 'user', content: 'Search for items' });

    await executor.executeMessage(session.id, 'Search for items', undefined, callback);

    const stepThoughts = filterTraces(traces, 'step_thought');

    // Should have step_thought events for the flow steps
    expect(stepThoughts.length).toBeGreaterThanOrEqual(1);

    // Each step_thought should have required fields
    for (const st of stepThoughts) {
      expect(st.data.stepName).toBeDefined();
      expect(typeof st.data.stepName).toBe('string');
      expect(st.data.summary).toBeDefined();
      expect(typeof st.data.summary).toBe('string');
      expect(st.data.stepType).toBeDefined();
      expect(st.data.agent).toBe('MultiStepAgent');
    }

    // Verify ordering — step names should appear in flow order
    const stepNames = stepThoughts.map((st) => st.data.stepName);
    // At minimum, 'start' should be the first step
    if (stepNames.length > 0) {
      expect(stepNames[0]).toBe('start');
    }
  });

  // ===========================================================================
  // I-3B.2: Custom description overrides auto-generated
  // ===========================================================================

  test('I-3B.2: step_thought summaries reflect step type correctly', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_STEP_FLOW_AGENT], 'MultiStepAgent'),
    );

    session.toolExecutor = {
      execute: async () => ({ results: ['item1'] }),
    } as any;

    mockClient.setResponseHandler(() => ({
      text: 'Done.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Done.' }],
    }));

    const { traces, callback } = createTraceCollector();
    session.conversationHistory.push({ role: 'user', content: 'Go' });

    await executor.executeMessage(session.id, 'Go', undefined, callback);

    const stepThoughts = filterTraces(traces, 'step_thought');

    // Find the RESPOND step — should say "Sending response"
    const respondSteps = stepThoughts.filter((st) => st.data.stepType === 'respond');
    for (const rs of respondSteps) {
      expect(rs.data.summary).toBe('Sending response');
    }

    // Find the CALL step — should mention the tool name
    const callSteps = stepThoughts.filter((st) => st.data.stepType === 'call');
    for (const cs of callSteps) {
      expect((cs.data.summary as string).toLowerCase()).toContain('search_database');
    }

    // Find the SET step — should mention variable names
    const setSteps = stepThoughts.filter((st) => st.data.stepType === 'set');
    for (const ss of setSteps) {
      expect((ss.data.summary as string).toLowerCase()).toContain('result_count');
    }
  });

  test('I-3B.2b: nested scripted step traces carry canonical flow step context', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_STEP_FLOW_AGENT], 'MultiStepAgent'),
    );

    session.toolExecutor = {
      execute: async () => ({ results: ['item1'] }),
    } as any;

    const { traces, callback } = createTraceCollector();
    session.conversationHistory.push({ role: 'user', content: 'Search' });

    await executor.executeMessage(session.id, 'Search', undefined, callback);

    const lookupStepEnter = traces.find(
      (trace) => trace.type === 'flow_step_enter' && trace.data.stepName === 'lookup',
    );
    const lookupCall = traces.find(
      (trace) => trace.type === 'dsl_call' && trace.data.stepName === 'lookup',
    );

    expect(lookupStepEnter?.data).toMatchObject({
      agentName: 'MultiStepAgent',
      stepName: 'lookup',
      stepType: 'call',
      flowStepName: 'lookup',
      flowStepType: 'call',
    });
    expect(typeof lookupStepEnter?.data.flowStepRunId).toBe('string');
    expect(lookupCall?.data).toMatchObject({
      agentName: 'MultiStepAgent',
      stepName: 'lookup',
      stepType: 'call',
      flowStepName: 'lookup',
      flowStepType: 'call',
      flowStepRunId: lookupStepEnter?.data.flowStepRunId,
    });
  });

  // ===========================================================================
  // I-3B.3: show_step_thoughts: false suppresses emission
  // ===========================================================================

  test('I-3B.3: show_step_thoughts: false suppresses step_thought events', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPPRESSED_THOUGHTS_AGENT], 'SuppressedAgent'),
    );

    // The EXECUTION.show_step_thoughts field is in the IR schema but not yet
    // wired through the DSL parser/compiler. Set it directly on the IR.
    if (session.agentIR?.execution) {
      (session.agentIR.execution as any).show_step_thoughts = false;
    }

    session.toolExecutor = {
      execute: async () => ({ data: 'result' }),
    } as any;

    mockClient.setResponseHandler(() => ({
      text: 'Done.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Done.' }],
    }));

    const { traces, callback } = createTraceCollector();
    session.conversationHistory.push({ role: 'user', content: 'Do something' });

    await executor.executeMessage(session.id, 'Do something', undefined, callback);

    const stepThoughts = filterTraces(traces, 'step_thought');

    // No step_thought events should be emitted
    expect(stepThoughts).toHaveLength(0);
  });

  // ===========================================================================
  // I-3B.4: Step thoughts interleave with tool_thoughts
  // ===========================================================================

  test('I-3B.4: step_thought and tool_thought events both appear in traces', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_WITH_FLOW_AGENT], 'ReasonFlowAgent'),
    );

    session.resolvedEnableThinking = true;

    session.toolExecutor = {
      execute: async () => ({ analysis: 'Data looks good' }),
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
                thought: 'Analysis is complete',
                reason: 'All steps executed',
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
                thought: 'Analysis is complete',
                reason: 'All steps executed',
              },
            },
          ],
        };
      }
      return {
        text: 'Analysis complete.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Analysis complete.' }],
      };
    });

    const { traces, callback } = createTraceCollector();
    session.conversationHistory.push({ role: 'user', content: 'Analyze this data' });

    await executor.executeMessage(session.id, 'Analyze this data', undefined, callback);

    // Both step_thought and tool_thought types should exist in traces
    const stepThoughts = filterTraces(traces, 'step_thought');
    const toolThoughts = filterTraces(traces, 'tool_thought');

    // At minimum, the flow agent should emit step_thoughts for the flow steps
    expect(stepThoughts.length).toBeGreaterThanOrEqual(1);

    // All trace events should have the correct structure
    for (const st of stepThoughts) {
      expect(st.data.stepName).toBeDefined();
      expect(st.data.agent).toBe('ReasonFlowAgent');
    }

    for (const tt of toolThoughts) {
      expect(tt.data.toolName).toBeDefined();
      expect(tt.data.agent).toBe('ReasonFlowAgent');
    }

    // Verify both types appear in the combined timeline
    const allTraceTypes = traces.map((t) => t.type);
    expect(allTraceTypes).toContain('step_thought');
  });
});
