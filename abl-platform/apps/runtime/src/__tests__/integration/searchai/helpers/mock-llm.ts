/**
 * Mock LLM Client for SearchAI E2E Tests
 *
 * Simulates the LLM making tool calls and synthesizing responses.
 * Follows the same pattern as agent-search-e2e.test.ts MockAnthropicClient.
 */

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  rawContent: Array<{ type: string; [key: string]: unknown }>;
}

export type ResponseHandler = (
  systemPrompt: string,
  messages: Array<{ role: string; content: unknown }>,
  tools: unknown[],
) => LLMResponse;

/**
 * Mock Anthropic client that returns scripted responses.
 */
export class MockAnthropicClient {
  calls: Array<{
    systemPrompt: string;
    messages: Array<{ role: string; content: unknown }>;
    tools: unknown[];
  }> = [];

  private responseQueue: ResponseHandler[] = [];
  private defaultHandler: ResponseHandler;

  constructor() {
    this.defaultHandler = () => ({
      text: 'I can help you with that.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I can help you with that.' }],
    });
  }

  /**
   * Queue a response handler. Handlers are consumed in order.
   * After all queued handlers are consumed, the default handler is used.
   */
  queueResponse(handler: ResponseHandler): void {
    this.responseQueue.push(handler);
  }

  /**
   * Set the default response handler (used when queue is empty).
   */
  setDefaultHandler(handler: ResponseHandler): void {
    this.defaultHandler = handler;
  }

  async chatWithToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) {
    this.calls.push({ systemPrompt, messages, tools });
    const handler = this.responseQueue.shift() ?? this.defaultHandler;
    return handler(systemPrompt, messages, tools);
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

// ─── Response Builders ───────────────────────────────────────────────────

/**
 * Build a response that calls a search tool.
 */
export function toolCallResponse(toolName: string, input: Record<string, unknown>): LLMResponse {
  const callId = `call_${Date.now()}`;
  return {
    text: '',
    toolCalls: [{ id: callId, name: toolName, input }],
    stopReason: 'tool_use',
    rawContent: [{ type: 'tool_use', id: callId, name: toolName, input }],
  };
}

/**
 * Build a text-only response (synthesis/answer).
 */
export function textResponse(text: string): LLMResponse {
  return {
    text,
    toolCalls: [],
    stopReason: 'end_turn',
    rawContent: [{ type: 'text', text }],
  };
}

/**
 * Build a response with multiple parallel tool calls.
 */
export function parallelToolCallResponse(
  calls: Array<{ name: string; input: Record<string, unknown> }>,
): LLMResponse {
  const toolCalls = calls.map((c, i) => ({
    id: `call_${Date.now()}_${i}`,
    name: c.name,
    input: c.input,
  }));
  return {
    text: '',
    toolCalls,
    stopReason: 'tool_use',
    rawContent: toolCalls.map((tc) => ({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: tc.input,
    })),
  };
}
