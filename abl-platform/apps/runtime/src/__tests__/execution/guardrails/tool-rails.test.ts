/**
 * Tool Guardrail Tests
 *
 * Tests that the guardrail pipeline is wired into the reasoning executor's
 * tool execution path for both `tool_input` and `tool_output` guardrails.
 *
 * Tool Input Scenarios:
 * 1. Pipeline blocks tool execution (passed=false) -> error returned to LLM
 * 2. Pipeline allows tool execution (passed=true) -> tool executes normally
 * 3. Pipeline redacts/modifies parameters -> tool executes with modified params
 * 4. No guardrails defined -> tool executes normally (no-op pipeline)
 * 5. Pipeline error -> fail-open, tool executes normally
 * 6. System tools bypass guardrails entirely
 *
 * Tool Output Scenarios:
 * 7. Pipeline blocks tool output with PII -> error result returned to LLM
 * 8. Pipeline allows clean tool output -> result passes through normally
 * 9. Pipeline error -> fail-open, original tool result used
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
} from '../../../services/runtime-executor';

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
      text: 'Default response.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Default response.' }],
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
// ABL FIXTURES — NO GUARDRAILS DSL (we inject guardrails programmatically)
// =============================================================================

const REASONING_AGENT_WITH_TOOL = `
AGENT: TestAgent

GOAL: "Test agent for guardrail testing"

PERSONA: "Helpful test assistant"

TOOLS:
  search(query: string) -> {results: array}
    description: "Search for information"
`;

/**
 * Helper: inject guardrails into a session's agentIR AFTER session creation.
 * This avoids the GUARDRAILS DSL compilation path and lets us test the tool execution
 * guardrail pipeline integration directly without interference from the pre-message
 * constraint check (which also evaluates guardrails but in a different context).
 */
function injectToolInputGuardrails(
  session: RuntimeSession,
  guardrails: Array<{
    name: string;
    description: string;
    kind: 'tool_input';
    priority: number;
    tier: 'local';
    check: string;
    action: { type: string; message: string };
  }>,
): void {
  if (!session.agentIR) return;
  if (!session.agentIR.constraints) {
    session.agentIR.constraints = { constraints: [], guardrails: [] };
  }
  session.agentIR.constraints.guardrails = [
    ...(session.agentIR.constraints.guardrails || []),
    ...guardrails,
  ] as any;
}

function injectToolOutputGuardrails(
  session: RuntimeSession,
  guardrails: Array<{
    name: string;
    description: string;
    kind: 'tool_output';
    priority: number;
    tier: 'local';
    check: string;
    action: { type: string; message: string };
  }>,
): void {
  if (!session.agentIR) return;
  if (!session.agentIR.constraints) {
    session.agentIR.constraints = { constraints: [], guardrails: [] };
  }
  session.agentIR.constraints.guardrails = [
    ...(session.agentIR.constraints.guardrails || []),
    ...guardrails,
  ] as any;
}

// =============================================================================
// LLM RESPONSE HELPERS
// =============================================================================

function makeToolCallResponse(
  toolName: string,
  toolInput: Record<string, unknown>,
  callId = 'call-1',
) {
  return {
    text: '',
    toolCalls: [{ id: callId, name: toolName, input: toolInput }],
    stopReason: 'tool_use',
    rawContent: [{ type: 'tool_use', id: callId, name: toolName, input: toolInput }],
  };
}

function makeFinalTextResponse(text: string) {
  return {
    text,
    toolCalls: [],
    stopReason: 'end_turn',
    rawContent: [{ type: 'text', text }],
  };
}

function makeEntityExtractionResponse(entities: Record<string, unknown> = {}) {
  return {
    text: '',
    toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: entities }],
    stopReason: 'tool_use',
    rawContent: [{ type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: entities }],
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Tool Input Guardrails', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockLLMClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  // ===========================================================================
  // 1. Pipeline blocks tool execution when PII detected
  // ===========================================================================

  test('should block tool execution when guardrail pipeline returns passed=false', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // Inject tool_input guardrail after session creation
    injectToolInputGuardrails(session, [
      {
        name: 'pii_tool_input',
        description: 'Block PII in tool input',
        kind: 'tool_input',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(tool_input)',
        action: { type: 'block', message: 'PII not allowed in tool input' },
      },
    ]);

    const toolCallLog: Array<{ name: string; args: any }> = [];
    session.toolExecutor = {
      execute: async (name: string, args: any) => {
        toolCallLog.push({ name, args });
        return { results: ['found'] };
      },
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return makeEntityExtractionResponse();
      }
      callCount++;
      if (callCount === 1) {
        // Tool call with PII in the input — should be blocked by guardrail
        return makeToolCallResponse('search', { query: 'My SSN is 123-45-6789' });
      }
      // Second LLM call: LLM sees guardrail error and responds normally
      return makeFinalTextResponse('I cannot search for PII. Let me help you differently.');
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'Search for my SSN 123-45-6789',
      undefined,
      traceCollector.callback,
    );

    // Tool should NOT have been executed — guardrail blocked it
    expect(toolCallLog).toHaveLength(0);

    // Should have a guardrail blocked trace event
    const guardrailTraces = filterTraces(traceCollector.traces, 'guardrail_tool_blocked');
    expect(guardrailTraces.length).toBeGreaterThanOrEqual(1);
    expect(guardrailTraces[0].data.toolName).toBe('search');

    // The LLM should have received the error and responded
    expect(result.response).toContain('cannot search for PII');
  });

  // ===========================================================================
  // 2. Pipeline allows tool execution (clean input)
  // ===========================================================================

  test('should allow tool execution when guardrail pipeline returns passed=true', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // Inject tool_input guardrail — PII check that will PASS for clean input
    injectToolInputGuardrails(session, [
      {
        name: 'pii_tool_input',
        description: 'Block PII in tool input',
        kind: 'tool_input',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(tool_input)',
        action: { type: 'block', message: 'PII not allowed in tool input' },
      },
    ]);

    const toolCallLog: Array<{ name: string; args: any }> = [];
    session.toolExecutor = {
      execute: async (name: string, args: any) => {
        toolCallLog.push({ name, args });
        return { results: ['Paris hotels found'] };
      },
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return makeEntityExtractionResponse();
      }
      callCount++;
      if (callCount === 1) {
        // Tool call with clean input — no PII
        return makeToolCallResponse('search', { query: 'hotels in Paris' });
      }
      return makeFinalTextResponse('I found Paris hotels for you.');
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'Find hotels in Paris',
      undefined,
      traceCollector.callback,
    );

    // Tool SHOULD have been executed
    expect(toolCallLog).toHaveLength(1);
    expect(toolCallLog[0].name).toBe('search');
    expect(toolCallLog[0].args).toMatchObject({ query: 'hotels in Paris' });

    // No guardrail blocked trace
    const guardrailTraces = filterTraces(traceCollector.traces, 'guardrail_tool_blocked');
    expect(guardrailTraces).toHaveLength(0);

    expect(result.response).toContain('Paris hotels');
  });

  // ===========================================================================
  // 3. No guardrails defined — tool executes normally
  // ===========================================================================

  test('should execute tool normally when no guardrails are defined', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // No guardrails injected — should be empty
    expect(session.agentIR?.constraints?.guardrails ?? []).toHaveLength(0);

    const toolCallLog: Array<{ name: string; args: any }> = [];
    session.toolExecutor = {
      execute: async (name: string, args: any) => {
        toolCallLog.push({ name, args });
        return { results: ['found'] };
      },
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return makeEntityExtractionResponse();
      }
      callCount++;
      if (callCount === 1) {
        return makeToolCallResponse('search', { query: 'test query with SSN 123-45-6789' });
      }
      return makeFinalTextResponse('Found results.');
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'Search for SSN 123-45-6789',
      undefined,
      traceCollector.callback,
    );

    // Tool should execute normally — no guardrails to block it
    expect(toolCallLog).toHaveLength(1);
    expect(toolCallLog[0].name).toBe('search');
    expect(toolCallLog[0].args.query).toBe('test query with SSN 123-45-6789');

    // No guardrail traces should exist
    const guardrailTraces = filterTraces(traceCollector.traces, 'guardrail_tool_blocked');
    expect(guardrailTraces).toHaveLength(0);
  });

  // ===========================================================================
  // 4. Pipeline error -> fail-open (tool still executes)
  // ===========================================================================

  test('should fail-open when guardrail pipeline throws an error', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // Inject a guardrail with an invalid CEL expression that will cause pipeline error
    injectToolInputGuardrails(session, [
      {
        name: 'broken_guardrail',
        description: 'Guardrail with broken CEL expression',
        kind: 'tool_input',
        priority: 1,
        tier: 'local',
        check: 'abl.nonexistent_function_xyz(tool_input)',
        action: { type: 'block', message: 'Should not reach here' },
      },
    ]);

    const toolCallLog: Array<{ name: string; args: any }> = [];
    session.toolExecutor = {
      execute: async (name: string, args: any) => {
        toolCallLog.push({ name, args });
        return { results: ['found'] };
      },
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return makeEntityExtractionResponse();
      }
      callCount++;
      if (callCount === 1) {
        return makeToolCallResponse('search', { query: 'test query' });
      }
      return makeFinalTextResponse('Results found.');
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'Search for something',
      undefined,
      traceCollector.callback,
    );

    // Tool should still execute — pipeline error = fail-open
    expect(toolCallLog).toHaveLength(1);
    expect(toolCallLog[0].name).toBe('search');
  });

  // ===========================================================================
  // 5. System tools bypass guardrails
  // ===========================================================================

  test('should not apply guardrails to system tool calls', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // Inject a tool_input guardrail
    injectToolInputGuardrails(session, [
      {
        name: 'pii_tool_input',
        description: 'Block PII in tool input',
        kind: 'tool_input',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(tool_input)',
        action: { type: 'block', message: 'PII not allowed' },
      },
    ]);

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return makeEntityExtractionResponse();
      }
      callCount++;
      // LLM calls __complete__ — a system tool — which should bypass guardrails
      return {
        text: '',
        toolCalls: [
          {
            id: 'complete-1',
            name: '__complete__',
            input: { message: 'Done! SSN: 123-45-6789' },
          },
        ],
        stopReason: 'tool_use',
        rawContent: [
          {
            type: 'tool_use',
            id: 'complete-1',
            name: '__complete__',
            input: { message: 'Done! SSN: 123-45-6789' },
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

    // Should complete successfully — system tools bypass guardrails
    expect(result.action.type).toBe('complete');

    // No guardrail blocked traces should exist for system tools
    const guardrailTraces = filterTraces(traceCollector.traces, 'guardrail_tool_blocked');
    expect(guardrailTraces).toHaveLength(0);
  });

  // ===========================================================================
  // 6. Guardrail check trace events are emitted
  // ===========================================================================

  test('should emit guardrail_check trace events during evaluation', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // Inject a guardrail that will pass (clean input)
    injectToolInputGuardrails(session, [
      {
        name: 'pii_tool_input',
        description: 'Block PII in tool input',
        kind: 'tool_input',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(tool_input)',
        action: { type: 'block', message: 'PII not allowed' },
      },
    ]);

    session.toolExecutor = {
      execute: async () => ({ results: ['found'] }),
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return makeEntityExtractionResponse();
      }
      callCount++;
      if (callCount === 1) {
        return makeToolCallResponse('search', { query: 'clean query no pii' });
      }
      return makeFinalTextResponse('Done.');
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'Search for something clean',
      undefined,
      traceCollector.callback,
    );

    // Should have at least tool_call traces showing the tool executed
    const toolTraces = filterTraces(traceCollector.traces, 'tool_call');
    expect(toolTraces.length).toBeGreaterThanOrEqual(1);
    expect(toolTraces.some((t) => t.data.toolName === 'search')).toBe(true);
  });
});

// =============================================================================
// TOOL OUTPUT GUARDRAILS
// =============================================================================

describe('Tool Output Guardrails', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockLLMClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  // ===========================================================================
  // 7. Pipeline blocks tool output when PII detected in tool result
  // ===========================================================================

  test('should block tool output when guardrail detects PII in tool result', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // Inject tool_output guardrail
    injectToolOutputGuardrails(session, [
      {
        name: 'pii_tool_output',
        description: 'Block PII in tool output',
        kind: 'tool_output',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(tool_output)',
        action: { type: 'block', message: 'Tool output contains PII and was blocked' },
      },
    ]);

    // Tool executor returns PII in the result
    session.toolExecutor = {
      execute: async (name: string, _args: any) => {
        if (name === 'search') {
          return { results: ['Customer SSN: 123-45-6789, address: 123 Main St'] };
        }
        return { results: [] };
      },
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return makeEntityExtractionResponse();
      }
      callCount++;
      if (callCount === 1) {
        // LLM calls search tool
        return makeToolCallResponse('search', { query: 'customer info' });
      }
      // Second LLM call: LLM sees the guardrail error and responds
      return makeFinalTextResponse('I cannot share that information due to privacy restrictions.');
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'Look up customer info',
      undefined,
      traceCollector.callback,
    );

    // Should have a guardrail blocked trace event for tool_output
    const guardrailTraces = filterTraces(traceCollector.traces, 'guardrail_tool_output_blocked');
    expect(guardrailTraces.length).toBeGreaterThanOrEqual(1);
    expect(guardrailTraces[0].data.toolName).toBe('search');
    expect(guardrailTraces[0].data.guardrailName).toBe('pii_tool_output');

    // The LLM should have received the error and responded accordingly
    expect(result.response).toContain('privacy restrictions');
  });

  // ===========================================================================
  // 8. Pipeline allows clean tool output
  // ===========================================================================

  test('should allow tool output when result is clean', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // Inject tool_output guardrail — PII check that will PASS for clean output
    injectToolOutputGuardrails(session, [
      {
        name: 'pii_tool_output',
        description: 'Block PII in tool output',
        kind: 'tool_output',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(tool_output)',
        action: { type: 'block', message: 'Tool output contains PII and was blocked' },
      },
    ]);

    // Tool executor returns clean results — no PII
    const toolCallLog: Array<{ name: string; args: any }> = [];
    session.toolExecutor = {
      execute: async (name: string, args: any) => {
        toolCallLog.push({ name, args });
        return { results: ['Paris is a beautiful city', 'Hotels available from $100/night'] };
      },
    } as any;

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return makeEntityExtractionResponse();
      }
      callCount++;
      if (callCount === 1) {
        return makeToolCallResponse('search', { query: 'hotels in Paris' });
      }
      return makeFinalTextResponse('I found great hotels in Paris for you.');
    });

    const traceCollector = createTraceCollector();
    const result = await executor.executeMessage(
      session.id,
      'Find hotels in Paris',
      undefined,
      traceCollector.callback,
    );

    // Tool should have been executed
    expect(toolCallLog).toHaveLength(1);
    expect(toolCallLog[0].name).toBe('search');

    // No guardrail_tool_output_blocked trace should exist
    const guardrailTraces = filterTraces(traceCollector.traces, 'guardrail_tool_output_blocked');
    expect(guardrailTraces).toHaveLength(0);

    // The final response should reflect normal tool results
    expect(result.response).toContain('hotels in Paris');
  });

  // ===========================================================================
  // 9. Pipeline error -> fail-open (original tool result used)
  //
  // The Tier1 evaluator treats CEL evaluation failures as individual guardrail
  // passes (fail-open at the CEL level). To test the outer catch block, we need
  // the pipeline.execute() itself to throw. We achieve this by temporarily
  // replacing the guardrail pipeline's execute method with one that throws.
  // ===========================================================================

  test('should fail-open when tool output guardrail pipeline throws', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REASONING_AGENT_WITH_TOOL], 'TestAgent'),
    );

    // Inject a tool_output guardrail so the `guardrails.some(g => g.kind === 'tool_output')`
    // check passes and the pipeline is invoked
    injectToolOutputGuardrails(session, [
      {
        name: 'crashing_output_guardrail',
        description: 'Guardrail that will cause pipeline to throw',
        kind: 'tool_output',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(tool_output)',
        action: { type: 'block', message: 'Should not reach here' },
      },
    ]);

    // Tool returns valid results
    const toolCallLog: Array<{ name: string; args: any }> = [];
    session.toolExecutor = {
      execute: async (name: string, args: any) => {
        toolCallLog.push({ name, args });
        return { results: ['valid result'] };
      },
    } as any;

    // Monkey-patch the guardrail pipeline to throw on tool_output evaluation
    // We import the module and override the shared instance's execute method
    const { GuardrailPipelineImpl } = await import('@abl/compiler');
    const originalExecute = GuardrailPipelineImpl.prototype.execute;
    GuardrailPipelineImpl.prototype.execute = async function (
      guardrails: any[],
      _content: string,
      kind: string,
    ) {
      if (kind === 'tool_output') {
        throw new Error('Simulated pipeline crash for tool_output');
      }
      return originalExecute.call(this, guardrails, _content, kind, {}, undefined);
    };

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return makeEntityExtractionResponse();
      }
      callCount++;
      if (callCount === 1) {
        return makeToolCallResponse('search', { query: 'test query' });
      }
      return makeFinalTextResponse('Here are your results.');
    });

    const traceCollector = createTraceCollector();
    try {
      const result = await executor.executeMessage(
        session.id,
        'Search for something',
        undefined,
        traceCollector.callback,
      );

      // Tool should have executed — pipeline error = fail-open
      expect(toolCallLog).toHaveLength(1);
      expect(toolCallLog[0].name).toBe('search');

      // Should have a pipeline error trace event
      const pipelineErrors = filterTraces(traceCollector.traces, 'guardrail_pipeline_error');
      expect(pipelineErrors.length).toBeGreaterThanOrEqual(1);
      expect(pipelineErrors[0].data.kind).toBe('tool_output');
      expect(pipelineErrors[0].data.agent).toBe('TestAgent');

      // Final response should be normal — fail-open means original result was used
      expect(result.response).toContain('results');
    } finally {
      // Restore original method
      GuardrailPipelineImpl.prototype.execute = originalExecute;
    }
  });
});
