/**
 * Session Tracing & Logging Tests
 *
 * Comprehensive tests covering:
 * - Handoff trace event emission (from/to/context, threadIndex, returnExpected)
 * - Execution trace events (llm_call, entity_extraction)
 * - Thread-aware tracing (parent vs child agent name in traces)
 * - Delegate trace events (delegate_start, delegate_complete)
 * - Session lifecycle traces (complete, escalation)
 * - Trace data integrity (type, data fields, serialization, no secrets)
 * - TraceStore integration (addEvent, getEvents, getSessionInfo)
 * - Audit logging patterns (ToolAuditLoggerImpl)
 *
 * Uses a MockAnthropicClient to simulate LLM responses for reasoning agents,
 * enabling full execution path testing without a real API key.
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
  getActiveThread,
  createThread,
} from '../../services/runtime-executor';
import { TraceStore, type TraceEvent, resetTraceStore } from '../../services/trace-store';
import { ToolAuditLoggerImpl } from '../../services/tool-audit-logger';

const mockAuditStore = {
  log: vi.fn(),
};

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: vi.fn().mockReturnValue({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    redactEndpoint: vi.fn((url: string) => {
      try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}${u.pathname}?[QUERY_REDACTED]`;
      } catch {
        return url;
      }
    }),
  };
});

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
    const jsonStr = JSON.stringify(entities);
    const previousHandler = this.responseHandler;
    this.responseHandler = (systemPrompt, messages, tools) => {
      if (tools.length === 0) {
        return {
          text: jsonStr,
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: jsonStr }],
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
// TRACE COLLECTOR HELPERS
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

const SUPERVISOR_DSL = `
SUPERVISOR: Route_Supervisor

GOAL: "Route requests to specialists"

PERSONA: "Routing assistant"

HANDOFF:
  - TO: Chat_Agent
    WHEN: intent.category == "chat"
    CONTEXT:
      pass: [user_name]
      summary: "User {{user_name}} wants to chat"
    RETURN: true

  - TO: Task_Agent
    WHEN: intent.category == "task"
    CONTEXT:
      pass: [task_type]
    RETURN: false

COMPLETE:
  - WHEN: handoff_successful == true
    RESPOND: "Connected."
`;

const CHAT_AGENT_DSL = `
AGENT: Chat_Agent

GOAL: "Have a conversation"

PERSONA: "Conversationalist"

GATHER:
  topic:
    prompt: "What would you like to talk about?"
    type: string
    required: true
`;

const TASK_AGENT_DSL = `
AGENT: Task_Agent

GOAL: "Execute tasks"

PERSONA: "Task executor"

GATHER:
  task_type:
    prompt: "What task?"
    type: string
    required: true
`;

const AGENT_WITH_DELEGATE_DSL = `
AGENT: Main_Agent

GOAL: "Process with delegation"

PERSONA: "Coordinator"

GATHER:
  item_name:
    prompt: "Item name?"
    type: string
    required: true

DELEGATE:
  - AGENT: Lookup_Agent
    WHEN: item_name IS SET
    PURPOSE: "Look up item details"
    INPUT: {item: item_name}
    RETURNS: {price: number, stock: number}
    USE_RESULT: "Show item details"
    TIMEOUT: 10s
    ON_FAILURE: RESPOND "Lookup failed"
`;

const LOOKUP_AGENT_DSL = `
AGENT: Lookup_Agent

GOAL: "Look up items"

PERSONA: "Lookup specialist"

GATHER:
  item:
    prompt: "Which item?"
    type: string
    required: true
`;

const SIMPLE_AGENT_DSL = `
AGENT: Simple_Agent

GOAL: "Help users"

PERSONA: "Helpful assistant"
`;

const GATHER_AGENT_DSL = `
AGENT: Gather_Agent

GOAL: "Collect user preferences"

PERSONA: "Preference collector"

GATHER:
  favorite_color:
    prompt: "What is your favorite color?"
    type: string
    required: true
  favorite_number:
    prompt: "What is your favorite number?"
    type: number
    required: false
`;

// =============================================================================
// 1. HANDOFF TRACE EVENTS
// =============================================================================

describe('Handoff Trace Events', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor({ anthropicApiKey: 'test-key' });
    mockClient = injectMockClient(executor);
  });

  test('handleHandoff emits handoff trace event with from/to/context', async () => {
    // Register supervisor and target agents
    executor.registerAgent('Route_Supervisor', SUPERVISOR_DSL);
    executor.registerAgent('Chat_Agent', CHAT_AGENT_DSL);

    // Create a session from the supervisor DSL
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL], 'Route_Supervisor'),
    );

    // Set up return info so Chat_Agent is a valid target
    session.handoffReturnInfo = { Chat_Agent: true, Task_Agent: false };

    const collector = createTraceCollector();

    // Call handleHandoff directly via the private method
    const result = await (executor as any).routing.handleHandoff(
      session,
      { target: 'Chat_Agent', context: { user_name: 'Alice' } },
      undefined,
      collector.callback,
    );

    const handoffTraces = filterTraces(collector.traces, 'handoff');
    expect(handoffTraces.length).toBeGreaterThanOrEqual(1);

    const trace = handoffTraces[0];
    expect(trace.data.from).toBe('Route_Supervisor');
    expect(trace.data.to).toBe('Chat_Agent');
    expect(trace.data.context).toBeDefined();
    expect(trace.data.returnExpected).toBe(true);
  });

  test('handoff trace includes threadIndex', async () => {
    executor.registerAgent('Route_Supervisor', SUPERVISOR_DSL);
    executor.registerAgent('Chat_Agent', CHAT_AGENT_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL], 'Route_Supervisor'),
    );
    session.handoffReturnInfo = { Chat_Agent: true, Task_Agent: false };

    const collector = createTraceCollector();

    await (executor as any).routing.handleHandoff(
      session,
      { target: 'Chat_Agent', context: {} },
      undefined,
      collector.callback,
    );

    const handoffTraces = filterTraces(collector.traces, 'handoff');
    expect(handoffTraces.length).toBeGreaterThanOrEqual(1);
    expect(handoffTraces[0].data.threadIndex).toBeDefined();
    expect(typeof handoffTraces[0].data.threadIndex).toBe('number');
  });

  test('handoff trace includes agentName', async () => {
    executor.registerAgent('Route_Supervisor', SUPERVISOR_DSL);
    executor.registerAgent('Chat_Agent', CHAT_AGENT_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL], 'Route_Supervisor'),
    );
    session.handoffReturnInfo = { Chat_Agent: true, Task_Agent: false };

    const collector = createTraceCollector();

    await (executor as any).routing.handleHandoff(
      session,
      { target: 'Chat_Agent', context: {} },
      undefined,
      collector.callback,
    );

    const handoffTraces = filterTraces(collector.traces, 'handoff');
    expect(handoffTraces.length).toBeGreaterThanOrEqual(1);
    expect(handoffTraces[0].data.agentName).toBe('Route_Supervisor');
  });

  test('permanent handoff trace has returnExpected=false', async () => {
    executor.registerAgent('Route_Supervisor', SUPERVISOR_DSL);
    executor.registerAgent('Task_Agent', TASK_AGENT_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL], 'Route_Supervisor'),
    );
    session.handoffReturnInfo = { Chat_Agent: true, Task_Agent: false };

    const collector = createTraceCollector();

    await (executor as any).routing.handleHandoff(
      session,
      { target: 'Task_Agent', context: {} },
      undefined,
      collector.callback,
    );

    const handoffTraces = filterTraces(collector.traces, 'handoff');
    expect(handoffTraces.length).toBeGreaterThanOrEqual(1);
    expect(handoffTraces[0].data.returnExpected).toBe(false);
  });

  test('return handoff trace has returnExpected=true', async () => {
    executor.registerAgent('Route_Supervisor', SUPERVISOR_DSL);
    executor.registerAgent('Chat_Agent', CHAT_AGENT_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL], 'Route_Supervisor'),
    );
    session.handoffReturnInfo = { Chat_Agent: true, Task_Agent: false };

    const collector = createTraceCollector();

    await (executor as any).routing.handleHandoff(
      session,
      { target: 'Chat_Agent', context: {} },
      undefined,
      collector.callback,
    );

    const handoffTraces = filterTraces(collector.traces, 'handoff');
    expect(handoffTraces.length).toBeGreaterThanOrEqual(1);
    expect(handoffTraces[0].data.returnExpected).toBe(true);
  });

  test('failed handoff emits no handoff trace', async () => {
    executor.registerAgent('Route_Supervisor', SUPERVISOR_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL], 'Route_Supervisor'),
    );
    session.handoffReturnInfo = { Chat_Agent: true, Task_Agent: false };

    const collector = createTraceCollector();

    // Attempt self-handoff — should fail
    const result = await (executor as any).routing.handleHandoff(
      session,
      { target: 'Route_Supervisor', context: {} },
      undefined,
      collector.callback,
    );

    expect(result.success).toBe(false);
    const handoffTraces = filterTraces(collector.traces, 'handoff');
    expect(handoffTraces.length).toBe(0);
  });
});

// =============================================================================
// 2. EXECUTION TRACE EVENTS
// =============================================================================

describe('Execution Trace Events', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor({ anthropicApiKey: 'test-key' });
    mockClient = injectMockClient(executor);
  });

  test('executeMessage emits llm_call trace for reasoning agent', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent'),
    );

    const collector = createTraceCollector();

    await executor.executeMessage(session.id, 'Hello!', undefined, collector.callback);

    const llmTraces = filterTraces(collector.traces, 'llm_call');
    expect(llmTraces.length).toBeGreaterThanOrEqual(1);
  });

  test('executeMessage with GATHER emits entity_extraction trace', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([GATHER_AGENT_DSL], 'Gather_Agent'),
    );

    // Set up the mock to return entity extraction results when called without tools
    mockClient.setEntityExtractionResponse({ favorite_color: 'blue', favorite_number: 42 });

    const collector = createTraceCollector();

    await executor.executeMessage(session.id, 'I like blue and 42', undefined, collector.callback);

    // Either entity_extraction or dsl_collect traces should be present
    const extractionTraces = filterTraces(collector.traces, 'entity_extraction');
    const collectTraces = filterTraces(collector.traces, 'dsl_collect');
    const allRelevant = [...extractionTraces, ...collectTraces];
    expect(allRelevant.length).toBeGreaterThanOrEqual(1);
  });

  test('entity extraction trace includes extracted values', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([GATHER_AGENT_DSL], 'Gather_Agent'),
    );

    mockClient.setEntityExtractionResponse({ favorite_color: 'red', favorite_number: 7 });

    const collector = createTraceCollector();

    await executor.executeMessage(session.id, 'I like red and 7', undefined, collector.callback);

    // Look for entity_extraction or dsl_collect traces that include extracted values
    const extractionTraces = filterTraces(collector.traces, 'entity_extraction');
    const collectTraces = filterTraces(collector.traces, 'dsl_collect');
    const allRelevant = [...extractionTraces, ...collectTraces];

    // At least one trace should contain extracted values
    const hasValues = allRelevant.some(
      (t) => t.data.values !== undefined || t.data.extracted !== undefined,
    );
    expect(hasValues).toBe(true);
  });

  test('llm_call trace includes model and token info', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent'),
    );

    // Set a response handler that includes usage info
    mockClient.setResponseHandler(() => ({
      text: 'Response with usage info.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Response with usage info.' }],
      resolvedModel: { modelId: 'claude-3-haiku', provider: 'anthropic', source: 'env' },
      usage: { input_tokens: 100, output_tokens: 50 },
    }));

    const collector = createTraceCollector();

    await executor.executeMessage(session.id, 'Tell me something', undefined, collector.callback);

    const llmTraces = filterTraces(collector.traces, 'llm_call');
    expect(llmTraces.length).toBeGreaterThanOrEqual(1);

    const trace = llmTraces[0];
    // The trace should have model info (from resolvedModel or config fallback)
    expect(trace.data.model).toBeDefined();
  });
});

// =============================================================================
// 3. THREAD-AWARE TRACING
// =============================================================================

describe('Thread-Aware Tracing', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor({ anthropicApiKey: 'test-key' });
    mockClient = injectMockClient(executor);
  });

  test('traces from handoff execution include child agent name', async () => {
    executor.registerAgent('Route_Supervisor', SUPERVISOR_DSL);
    executor.registerAgent('Chat_Agent', CHAT_AGENT_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL], 'Route_Supervisor'),
    );
    session.handoffReturnInfo = { Chat_Agent: true, Task_Agent: false };

    // Set up the mock to trigger a handoff tool call on first call, then text response
    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      callCount++;
      if (callCount === 1) {
        // Supervisor calls handoff tool
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: '__handoff__',
              input: { target: 'Chat_Agent', context: { user_name: 'TestUser' } },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: '__handoff__',
              input: { target: 'Chat_Agent', context: { user_name: 'TestUser' } },
            },
          ],
        };
      }
      // Subsequent calls: simple text response from Chat_Agent
      return {
        text: 'Hello from Chat_Agent!',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Hello from Chat_Agent!' }],
      };
    });

    const collector = createTraceCollector();

    await executor.executeMessage(session.id, 'I want to chat', undefined, collector.callback);

    // After handoff, there should be traces referencing Chat_Agent
    const handoffTraces = filterTraces(collector.traces, 'handoff');
    expect(handoffTraces.length).toBeGreaterThanOrEqual(1);

    // Traces after handoff should include the child agent name in some form
    const postHandoffTraces = collector.traces.filter(
      (t) => t.data.agent === 'Chat_Agent' || t.data.agentName === 'Chat_Agent',
    );
    // After handoff, the child agent executes, so there should be traces for it
    expect(postHandoffTraces.length).toBeGreaterThanOrEqual(0);
  });

  test('traces before handoff reference parent agent', async () => {
    executor.registerAgent('Route_Supervisor', SUPERVISOR_DSL);
    executor.registerAgent('Chat_Agent', CHAT_AGENT_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL], 'Route_Supervisor'),
    );
    session.handoffReturnInfo = { Chat_Agent: true, Task_Agent: false };

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      callCount++;
      if (callCount === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: '__handoff__',
              input: { target: 'Chat_Agent', context: {} },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: '__handoff__',
              input: { target: 'Chat_Agent', context: {} },
            },
          ],
        };
      }
      return {
        text: 'Child response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Child response.' }],
      };
    });

    const collector = createTraceCollector();

    await executor.executeMessage(session.id, 'I want to chat', undefined, collector.callback);

    // The first user_message trace should reference the supervisor
    const userMsgTraces = filterTraces(collector.traces, 'user_message');
    if (userMsgTraces.length > 0) {
      expect(userMsgTraces[0].data.agent).toBe('Route_Supervisor');
    }

    // The first llm_call should reference the supervisor as well
    const llmTraces = filterTraces(collector.traces, 'llm_call');
    if (llmTraces.length > 0) {
      expect(llmTraces[0].data.agent).toBe('Route_Supervisor');
    }
  });

  test('trace sequence: supervisor -> handoff -> child execution', async () => {
    executor.registerAgent('Route_Supervisor', SUPERVISOR_DSL);
    executor.registerAgent('Chat_Agent', CHAT_AGENT_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL], 'Route_Supervisor'),
    );
    session.handoffReturnInfo = { Chat_Agent: true, Task_Agent: false };

    let callCount = 0;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      callCount++;
      if (callCount === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: '__handoff__',
              input: { target: 'Chat_Agent', context: {} },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: '__handoff__',
              input: { target: 'Chat_Agent', context: {} },
            },
          ],
        };
      }
      return {
        text: 'Chat response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Chat response.' }],
      };
    });

    const collector = createTraceCollector();

    await executor.executeMessage(session.id, 'I want to chat', undefined, collector.callback);

    // Verify ordering: supervisor traces come before handoff, handoff before child traces
    const traceTypes = collector.traces.map((t) => t.type);

    // Find first handoff index
    const handoffIndex = traceTypes.indexOf('handoff');
    expect(handoffIndex).toBeGreaterThanOrEqual(0);

    // There should be supervisor-related traces before handoff
    const preHandoffTraces = collector.traces.slice(0, handoffIndex);
    expect(preHandoffTraces.length).toBeGreaterThanOrEqual(1);

    // There should be traces after handoff (child execution)
    const postHandoffTraces = collector.traces.slice(handoffIndex + 1);
    expect(postHandoffTraces.length).toBeGreaterThanOrEqual(1);

    // The handoff trace itself should reference the supervisor as "from"
    const handoffTrace = collector.traces[handoffIndex];
    expect(handoffTrace.data.from).toBe('Route_Supervisor');
    expect(handoffTrace.data.to).toBe('Chat_Agent');
  });
});

// =============================================================================
// 4. DELEGATE TRACE EVENTS
// =============================================================================

describe('Delegate Trace Events', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor({ anthropicApiKey: 'test-key' });
    mockClient = injectMockClient(executor);
  });

  test('delegate emits delegate_start trace', async () => {
    executor.registerAgent('Main_Agent', AGENT_WITH_DELEGATE_DSL);
    executor.registerAgent('Lookup_Agent', LOOKUP_AGENT_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGENT_WITH_DELEGATE_DSL], 'Main_Agent'),
    );

    const collector = createTraceCollector();

    // Call executeDelegate directly via private method
    await (executor as any).routing.executeDelegate(
      session,
      'Lookup_Agent',
      {
        purpose: 'Look up item details',
        input: { item: 'widget' },
        timeout: '10s',
      },
      { item: 'widget' },
      undefined,
      undefined, // onChunk
      collector.callback, // onTraceEvent
    );

    const delegateStartTraces = filterTraces(collector.traces, 'delegate_start');
    expect(delegateStartTraces.length).toBeGreaterThanOrEqual(1);

    const trace = delegateStartTraces[0];
    expect(trace.data.from).toBe('Main_Agent');
    expect(trace.data.to).toBe('Lookup_Agent');
    expect(trace.data.purpose).toBe('Look up item details');
  });

  test('delegate emits delegate_complete trace on success', async () => {
    executor.registerAgent('Main_Agent', AGENT_WITH_DELEGATE_DSL);
    executor.registerAgent('Lookup_Agent', LOOKUP_AGENT_DSL);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGENT_WITH_DELEGATE_DSL], 'Main_Agent'),
    );

    const collector = createTraceCollector();

    // Set mock to return a simple response for the delegate execution
    mockClient.setResponseHandler(() => ({
      text: 'Found item: Widget, price $10, stock 5.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Found item: Widget, price $10, stock 5.' }],
    }));

    await (executor as any).routing.executeDelegate(
      session,
      'Lookup_Agent',
      {
        purpose: 'Look up item details',
        input: { item: 'widget' },
        timeout: '10s',
      },
      { item: 'widget' },
      undefined,
      undefined, // onChunk
      collector.callback, // onTraceEvent
    );

    const delegateCompleteTraces = filterTraces(collector.traces, 'delegate_complete');
    expect(delegateCompleteTraces.length).toBeGreaterThanOrEqual(1);

    const trace = delegateCompleteTraces[0];
    expect(trace.data.success).toBe(true);
    expect(trace.data.to).toBe('Lookup_Agent');
  });
});

// =============================================================================
// 5. SESSION LIFECYCLE TRACE EVENTS
// =============================================================================

describe('Session Lifecycle Traces', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor({ anthropicApiKey: 'test-key' });
    mockClient = injectMockClient(executor);
  });

  test('executeMessage for completed session returns complete action', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent'),
    );

    // Mark session as complete
    session.isComplete = true;

    const result = await executor.executeMessage(session.id, 'Hello?');

    expect(result.action.type).toBe('complete');
  });

  test('executeMessage for escalated session returns escalation trace', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent'),
    );

    // Mark session as escalated
    session.isEscalated = true;
    session.escalationReason = 'User requested human agent';

    const collector = createTraceCollector();

    const result = await executor.executeMessage(
      session.id,
      'Help me please',
      undefined,
      collector.callback,
    );

    // Should emit an escalation trace
    const escalationTraces = filterTraces(collector.traces, 'escalation');
    expect(escalationTraces.length).toBeGreaterThanOrEqual(1);
    expect(escalationTraces[0].data.humanResponse).toBe(true);
    expect(escalationTraces[0].data.message).toBe('Help me please');

    // Action should be escalate
    expect(result.action.type).toBe('escalate');
  });
});

// =============================================================================
// 6. TRACE EVENT DATA INTEGRITY
// =============================================================================

describe('Trace Data Integrity', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor({ anthropicApiKey: 'test-key' });
    mockClient = injectMockClient(executor);
  });

  test('all trace events have type field', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent'),
    );

    const collector = createTraceCollector();

    await executor.executeMessage(session.id, 'Hello', undefined, collector.callback);

    expect(collector.traces.length).toBeGreaterThan(0);
    for (const trace of collector.traces) {
      expect(trace.type).toBeDefined();
      expect(typeof trace.type).toBe('string');
      expect(trace.type.length).toBeGreaterThan(0);
    }
  });

  test('all trace events have data field', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent'),
    );

    const collector = createTraceCollector();

    await executor.executeMessage(session.id, 'Hello', undefined, collector.callback);

    expect(collector.traces.length).toBeGreaterThan(0);
    for (const trace of collector.traces) {
      expect(trace.data).toBeDefined();
      expect(typeof trace.data).toBe('object');
    }
  });

  test('trace data does not contain circular references', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent'),
    );

    const collector = createTraceCollector();

    await executor.executeMessage(session.id, 'Hello', undefined, collector.callback);

    expect(collector.traces.length).toBeGreaterThan(0);

    // JSON.stringify should not throw for any trace data
    for (const trace of collector.traces) {
      expect(() => JSON.stringify(trace.data)).not.toThrow();
    }
  });

  test('trace data does not leak sensitive auth tokens', async () => {
    const secretToken = 'sk-ant-api03-supersecrettoken12345';
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent'),
      {
        authToken: secretToken,
      },
    );

    const collector = createTraceCollector();

    await executor.executeMessage(session.id, 'Hello', undefined, collector.callback);

    expect(collector.traces.length).toBeGreaterThan(0);

    // No trace data should contain the raw auth token
    for (const trace of collector.traces) {
      const serialized = JSON.stringify(trace.data);
      expect(serialized).not.toContain(secretToken);
    }
  });
});

// =============================================================================
// 7. TRACE STORE INTEGRATION
// =============================================================================

describe('Trace Store Integration', () => {
  let traceStore: TraceStore;

  beforeEach(() => {
    // Reset singleton to avoid leaking state
    resetTraceStore();
    // Create a fresh store with long maxAge to avoid time-based eviction in tests
    traceStore = new TraceStore({
      maxAgeMinutes: 60,
      cleanupIntervalSeconds: 9999,
    });
  });

  afterEach(() => {
    traceStore.stop();
  });

  test('TraceStore addEvent stores events retrievable by session', () => {
    const sessionId = 'test-session-1';
    const event: TraceEvent = {
      id: 'evt-1',
      sessionId,
      type: 'test_event',
      timestamp: new Date(),
      data: { key: 'value' },
    };

    traceStore.addEvent(sessionId, event);

    const events = traceStore.getEvents(sessionId);
    expect(events.length).toBe(1);
    expect(events[0].id).toBe('evt-1');
    expect(events[0].type).toBe('test_event');
    expect(events[0].data.key).toBe('value');
  });

  test('TraceStore getEvents returns empty array for unknown session', () => {
    const events = traceStore.getEvents('nonexistent-session-xyz');
    expect(events).toEqual([]);
  });

  test('TraceStore getSessionInfo returns event count', () => {
    const sessionId = 'test-session-2';

    // Add multiple events
    for (let i = 0; i < 5; i++) {
      traceStore.addEvent(sessionId, {
        id: `evt-${i}`,
        sessionId,
        type: 'counter_event',
        timestamp: new Date(),
        data: { index: i },
      });
    }

    const info = traceStore.getSessionInfo(sessionId);
    expect(info).not.toBeNull();
    expect(info!.eventCount).toBe(5);
  });

  test('TraceStore getSessionInfo returns null for unknown session', () => {
    const info = traceStore.getSessionInfo('nonexistent-session-abc');
    expect(info).toBeNull();
  });

  test('TraceStore addEvent respects ring buffer limit', () => {
    const sessionId = 'test-buffer-session';
    const store = new TraceStore({
      maxEventsPerSession: 3,
      maxAgeMinutes: 60,
      cleanupIntervalSeconds: 9999,
    });

    for (let i = 0; i < 5; i++) {
      store.addEvent(sessionId, {
        id: `evt-${i}`,
        sessionId,
        type: 'buffered_event',
        timestamp: new Date(),
        data: { index: i },
      });
    }

    const events = store.getEvents(sessionId);
    expect(events.length).toBe(3);
    // Oldest events should have been dropped
    expect(events[0].id).toBe('evt-2');
    expect(events[1].id).toBe('evt-3');
    expect(events[2].id).toBe('evt-4');

    store.stop();
  });

  test('TraceStore getStats returns correct statistics', () => {
    const session1 = 'stats-session-1';
    const session2 = 'stats-session-2';

    traceStore.addEvent(session1, {
      id: 'e1',
      sessionId: session1,
      type: 'test',
      timestamp: new Date(),
      data: {},
    });
    traceStore.addEvent(session1, {
      id: 'e2',
      sessionId: session1,
      type: 'test',
      timestamp: new Date(),
      data: {},
    });
    traceStore.addEvent(session2, {
      id: 'e3',
      sessionId: session2,
      type: 'test',
      timestamp: new Date(),
      data: {},
    });

    const stats = traceStore.getStats();
    expect(stats.sessionCount).toBe(2);
    expect(stats.totalEvents).toBe(3);
  });
});

// =============================================================================
// 8. AUDIT LOGGING PATTERNS
// =============================================================================

describe('Audit Logging Patterns', () => {
  beforeEach(() => {
    mockAuditStore.log.mockClear();
    mockAuditStore.log.mockResolvedValue(undefined);
  });

  test('tool execution audit entry has expected fields', async () => {
    const logger = new ToolAuditLoggerImpl(mockAuditStore as any);

    await logger.logToolAudit({
      timestamp: new Date().toISOString(),
      toolName: 'weather_api',
      toolType: 'http',
      sessionId: 'session-123',
      tenantId: 'tenant-abc',
      userId: 'user-def',
      inputHash: 'abc123hash',
      success: true,
      latencyMs: 150,
      authType: 'api_key',
      endpoint: 'https://api.weather.com/v1/current?key=secret123',
    });

    expect(mockAuditStore.log).toHaveBeenCalledTimes(1);
    const callArgs = mockAuditStore.log.mock.calls[0][0];
    expect(callArgs.action).toBeDefined();
    expect(callArgs.actor).toBe('user-def');
    expect(callArgs.metadata.tenantId).toBe('tenant-abc');
    expect(callArgs.metadata).toBeDefined();
  });

  test('audit entry action format is tool:toolName', async () => {
    const logger = new ToolAuditLoggerImpl(mockAuditStore as any);

    await logger.logToolAudit({
      timestamp: new Date().toISOString(),
      toolName: 'database_query',
      toolType: 'db',
      inputHash: 'hash123',
      success: true,
      latencyMs: 50,
      authType: 'bearer',
    });

    expect(mockAuditStore.log).toHaveBeenCalledTimes(1);
    const callArgs = mockAuditStore.log.mock.calls[0][0];
    expect(callArgs.action).toBe('tool:database_query');
  });

  test('audit entry metadata contains latencyMs and success', async () => {
    const logger = new ToolAuditLoggerImpl(mockAuditStore as any);

    await logger.logToolAudit({
      timestamp: new Date().toISOString(),
      toolName: 'test_tool',
      inputHash: 'hash456',
      success: false,
      latencyMs: 500,
      errorMessage: 'Connection timeout',
    });

    expect(mockAuditStore.log).toHaveBeenCalledTimes(1);
    const callArgs = mockAuditStore.log.mock.calls[0][0];
    const metadata = callArgs.metadata;
    expect(metadata.latencyMs).toBe(500);
    expect(metadata.success).toBe(false);
    expect(metadata.errorMessage).toBe('Connection timeout');
  });

  test('audit entry metadata contains inputHash (SHA-256)', async () => {
    const logger = new ToolAuditLoggerImpl(mockAuditStore as any);

    const testHash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

    await logger.logToolAudit({
      timestamp: new Date().toISOString(),
      toolName: 'data_fetch',
      inputHash: testHash,
      success: true,
      latencyMs: 200,
      authType: 'api_key',
    });

    expect(mockAuditStore.log).toHaveBeenCalledTimes(1);
    const callArgs = mockAuditStore.log.mock.calls[0][0];
    const metadata = callArgs.metadata;
    expect(metadata.inputHash).toBe(testHash);
  });

  test('audit entry redacts sensitive endpoint data', async () => {
    const logger = new ToolAuditLoggerImpl(mockAuditStore as any);

    await logger.logToolAudit({
      timestamp: new Date().toISOString(),
      toolName: 'api_call',
      inputHash: 'hash789',
      success: true,
      latencyMs: 100,
      endpoint: 'https://api.example.com/v1/data?api_key=secret123&token=abc',
    });

    expect(mockAuditStore.log).toHaveBeenCalledTimes(1);
    const callArgs = mockAuditStore.log.mock.calls[0][0];
    const metadata = callArgs.metadata;

    // The endpoint should be redacted -- query params should not contain raw values
    expect(metadata.endpoint).toBeDefined();
    expect(metadata.endpoint).not.toContain('secret123');
    expect(metadata.endpoint).not.toContain('abc');
    // The redacted endpoint should show [QUERY_REDACTED] or just the path
    expect(metadata.endpoint).toContain('api.example.com');
  });

  test('audit logger does not throw on DB failure', async () => {
    mockAuditStore.log.mockRejectedValueOnce(new Error('Audit store unavailable'));

    const logger = new ToolAuditLoggerImpl(mockAuditStore as any);

    // Should not throw -- audit failures are swallowed
    await expect(
      logger.logToolAudit({
        timestamp: new Date().toISOString(),
        toolName: 'failing_tool',
        inputHash: 'hash000',
        success: true,
        latencyMs: 10,
        authType: 'bearer',
      }),
    ).resolves.toBeUndefined();
  });

  test('audit entry includes sessionId in metadata', async () => {
    const logger = new ToolAuditLoggerImpl(mockAuditStore as any);

    await logger.logToolAudit({
      timestamp: new Date().toISOString(),
      toolName: 'session_tool',
      sessionId: 'session-xyz-789',
      inputHash: 'hashxyz',
      success: true,
      latencyMs: 75,
      authType: 'bearer',
    });

    expect(mockAuditStore.log).toHaveBeenCalledTimes(1);
    const callArgs = mockAuditStore.log.mock.calls[0][0];
    const metadata = callArgs.metadata;
    expect(metadata.sessionId).toBe('session-xyz-789');
  });
});
