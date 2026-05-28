/**
 * Trace Event Fixture Factory
 *
 * Creates realistic trace event fixtures for integration tests.
 * Ensures token data is in the correct schema location (data.usage.inputTokens),
 * matching the actual Runtime emission structure.
 */

import type { ExtendedTraceEvent, ExtendedTraceEventType } from '../../types';

/**
 * Base fixture builder with fluent API for readability
 */
interface TraceEventBuilder {
  type(type: ExtendedTraceEventType): TraceEventBuilder;
  sessionId(id: string): TraceEventBuilder;
  agentName(name: string): TraceEventBuilder;
  data(data: Record<string, unknown>): TraceEventBuilder;
  timestamp(ts: Date): TraceEventBuilder;
  build(): ExtendedTraceEvent;
}

/**
 * Create a base trace event with required fields
 */
export function createTraceEvent(overrides?: Partial<ExtendedTraceEvent>): ExtendedTraceEvent {
  const now = new Date();
  return {
    id: `evt_${Math.random().toString(36).substr(2, 9)}`,
    type: 'user_message',
    timestamp: now,
    traceId: `trace_${Math.random().toString(36).substr(2, 9)}`,
    spanId: `span_${Math.random().toString(36).substr(2, 9)}`,
    sessionId: 'test_session_001',
    agentName: 'test-agent',
    data: {},
    metadata: {},
    ...overrides,
  };
}

/**
 * Fluent builder for creating trace events with readable chaining
 */
export function traceEvent(): TraceEventBuilder {
  let event: Partial<ExtendedTraceEvent> = {
    type: 'user_message',
    sessionId: 'test_session_001',
    agentName: 'test-agent',
    data: {},
  };

  const builder: TraceEventBuilder = {
    type(type: ExtendedTraceEventType) {
      event.type = type;
      return builder;
    },
    sessionId(id: string) {
      event.sessionId = id;
      return builder;
    },
    agentName(name: string) {
      event.agentName = name;
      return builder;
    },
    data(data: Record<string, unknown>) {
      event.data = data;
      return builder;
    },
    timestamp(ts: Date) {
      event.timestamp = ts;
      return builder;
    },
    build() {
      return createTraceEvent(event);
    },
  };

  return builder;
}

/**
 * Create a user_message event
 */
export function createUserMessageEvent(
  content: string = 'Test user message',
  overrides?: Partial<ExtendedTraceEvent>,
): ExtendedTraceEvent {
  return createTraceEvent({
    type: 'user_message',
    data: {
      content,
      role: 'user',
    },
    ...overrides,
  });
}

/**
 * Create an llm_call event with correct token schema
 *
 * CRITICAL: Token data MUST be in data.usage.{inputTokens,outputTokens},
 * matching actual Runtime emission structure. Fallback fields included
 * for backward compatibility testing.
 */
export function createLLMCallEvent(options: {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  contextWindowSize?: number;
  prompt?: string;
  response?: string;
  overrides?: Partial<ExtendedTraceEvent>;
}): ExtendedTraceEvent {
  const {
    model = 'gpt-4',
    inputTokens = 100,
    outputTokens = 50,
    cost = 0.003,
    contextWindowSize = 8192,
    prompt = 'Test prompt',
    response = 'Test response',
    overrides,
  } = options;

  return createTraceEvent({
    type: 'llm_call',
    data: {
      model,
      prompt,
      response,
      cost,
      contextWindowSize,
      // PRIMARY: Token data in data.usage (actual Runtime schema)
      usage: {
        inputTokens,
        outputTokens,
        contextWindowSize,
      },
      // FALLBACK: Legacy field for backward compatibility testing
      tokensIn: inputTokens,
      promptTokens: inputTokens,
      tokensOut: outputTokens,
      completionTokens: outputTokens,
    },
    ...overrides,
  });
}

/**
 * Create a tool_call event
 */
export function createToolCallEvent(options: {
  tool?: string;
  input?: unknown;
  result?: unknown;
  status?: 'success' | 'failed';
  error?: string;
  latencyMs?: number;
  startTime?: Date;
  endTime?: Date;
  overrides?: Partial<ExtendedTraceEvent>;
}): ExtendedTraceEvent {
  const {
    tool = 'test-tool',
    input = { query: 'test' },
    result = { data: 'test result' },
    status = 'success',
    error,
    latencyMs = 250,
    startTime,
    endTime,
    overrides,
  } = options;

  const data: Record<string, unknown> = {
    tool,
    toolName: tool,
    input,
    result,
    success: status === 'success',
    error,
    latencyMs,
  };

  if (startTime) data.startTime = startTime.toISOString();
  if (endTime) data.endTime = endTime.toISOString();

  return createTraceEvent({
    type: 'tool_call',
    data,
    ...overrides,
  });
}

/**
 * Create an agent_response event
 */
export function createAgentResponseEvent(
  content: string = 'Test agent response',
  overrides?: Partial<ExtendedTraceEvent>,
): ExtendedTraceEvent {
  return createTraceEvent({
    type: 'agent_response',
    data: {
      content,
      role: 'assistant',
      contentLength: content.length,
    },
    ...overrides,
  });
}

/**
 * Create a guardrail_check event
 */
export function createGuardrailEvent(options: {
  checkType?: 'pii' | 'prompt_injection' | 'hallucination' | 'policy';
  status?: 'pass' | 'warn' | 'fail';
  confidence?: number;
  findings?: string[];
  overrides?: Partial<ExtendedTraceEvent>;
}): ExtendedTraceEvent {
  const {
    checkType = 'pii',
    status = 'pass',
    confidence = 0.95,
    findings = [],
    overrides,
  } = options;

  return createTraceEvent({
    type: 'guardrail_check',
    data: {
      checkType,
      status,
      confidence,
      findings,
      passed: status === 'pass',
    },
    ...overrides,
  });
}

/**
 * Create agent_enter event
 */
export function createAgentEnterEvent(
  agentName: string = 'test-agent',
  mode: 'reasoning' | 'scripted' = 'reasoning',
  overrides?: Partial<ExtendedTraceEvent>,
): ExtendedTraceEvent {
  return createTraceEvent({
    type: 'agent_enter',
    agentName,
    data: {
      agent: agentName,
      mode,
    },
    ...overrides,
  });
}

/**
 * Create agent_exit event
 */
export function createAgentExitEvent(
  agentName: string = 'test-agent',
  reason?: string,
  overrides?: Partial<ExtendedTraceEvent>,
): ExtendedTraceEvent {
  return createTraceEvent({
    type: 'agent_exit',
    agentName,
    data: {
      agent: agentName,
      reason,
    },
    ...overrides,
  });
}

/**
 * Create delegate_start event
 */
export function createDelegateStartEvent(
  fromAgent: string,
  toAgent: string,
  reason?: string,
  overrides?: Partial<ExtendedTraceEvent>,
): ExtendedTraceEvent {
  return createTraceEvent({
    type: 'delegate_start',
    agentName: fromAgent,
    data: {
      from: fromAgent,
      to: toAgent,
      toAgent,
      reason,
    },
    ...overrides,
  });
}

/**
 * Create delegate_complete event
 */
export function createDelegateCompleteEvent(
  fromAgent: string,
  toAgent: string,
  overrides?: Partial<ExtendedTraceEvent>,
): ExtendedTraceEvent {
  return createTraceEvent({
    type: 'delegate_complete',
    agentName: fromAgent,
    data: {
      from: fromAgent,
      to: toAgent,
      toAgent,
    },
    ...overrides,
  });
}

/**
 * Create a context mutation event (for memory diff tests)
 */
export function createContextMutationEvent(options: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  operation?: 'set' | 'merge' | 'delete';
  overrides?: Partial<ExtendedTraceEvent>;
}): ExtendedTraceEvent {
  const { before, after, operation = 'merge', overrides } = options;

  return createTraceEvent({
    type: 'data_stored',
    data: {
      operation,
      context: {
        before,
        after,
      },
    },
    ...overrides,
  });
}

/**
 * Create a complete interaction fixture (user message + processing + response)
 */
export function createInteractionFixture(options: {
  userMessage?: string;
  agentResponse?: string;
  includeLLMCall?: boolean;
  includeToolCall?: boolean;
  sessionId?: string;
  agentName?: string;
  baseTimestamp?: Date;
}): ExtendedTraceEvent[] {
  const {
    userMessage = 'Test user message',
    agentResponse = 'Test agent response',
    includeLLMCall = true,
    includeToolCall = false,
    sessionId = 'test_session_001',
    agentName = 'test-agent',
    baseTimestamp = new Date(),
  } = options;

  const events: ExtendedTraceEvent[] = [];

  // User message (t=0)
  events.push(
    createUserMessageEvent(userMessage, {
      sessionId,
      agentName,
      timestamp: baseTimestamp,
    }),
  );

  // Optional LLM call (t=100ms)
  if (includeLLMCall) {
    events.push(
      createLLMCallEvent({
        model: 'gpt-4',
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.003,
        overrides: {
          sessionId,
          agentName,
          timestamp: new Date(baseTimestamp.getTime() + 100),
        },
      }),
    );
  }

  // Optional tool call (t=200ms)
  if (includeToolCall) {
    events.push(
      createToolCallEvent({
        tool: 'search',
        input: { query: userMessage },
        result: { results: [] },
        status: 'success',
        latencyMs: 150,
        overrides: {
          sessionId,
          agentName,
          timestamp: new Date(baseTimestamp.getTime() + 200),
        },
      }),
    );
  }

  // Agent response (t=500ms)
  events.push(
    createAgentResponseEvent(agentResponse, {
      sessionId,
      agentName,
      timestamp: new Date(baseTimestamp.getTime() + 500),
    }),
  );

  return events;
}
