/**
 * Shared test helpers for conversation history integrity validation.
 *
 * These helpers enforce the same structural rules as the real Anthropic API:
 * - No empty user messages
 * - No consecutive same-role messages (user-user or assistant-assistant)
 * - Correct alternation of user/assistant roles
 *
 * Also includes a ValidatingMockAnthropicClient that rejects malformed messages.
 */

import { expect } from 'vitest';
import type { RuntimeSession, AgentThread } from '../../services/runtime-executor';

// =============================================================================
// TYPES
// =============================================================================

export interface HistoryMessage {
  role: string;
  content: string;
}

export interface CapturedTrace {
  type: string;
  data: Record<string, unknown>;
}

export interface LLMCall {
  systemPrompt: string;
  messages: Array<{ role: string; content: unknown }>;
  tools: unknown[];
  operationType?: string;
  options?: Record<string, unknown>;
}

// =============================================================================
// HISTORY VALIDATION HELPERS
// =============================================================================

/**
 * Assert that a conversation history has no empty user messages.
 * This is the exact rule the Anthropic API enforces that caused the 400 error.
 */
export function assertNoEmptyUserMessages(
  history: HistoryMessage[],
  label: string = 'history',
): void {
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === 'user') {
      expect(
        msg.content && msg.content.trim() !== '',
        `Empty user message at index ${i} in ${label}: content="${msg.content}"`,
      ).toBe(true);
    }
  }
}

/**
 * Assert that a conversation history has no consecutive same-role messages.
 * The Anthropic API requires alternating user/assistant roles (with tool_result exceptions).
 */
export function assertNoConsecutiveSameRole(
  history: HistoryMessage[],
  label: string = 'history',
): void {
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const curr = history[i];
    // Allow consecutive messages if they involve tool_result role
    if (prev.role === curr.role && curr.role !== 'tool_result') {
      throw new Error(
        `Consecutive ${curr.role} messages at indices ${i - 1} and ${i} in ${label}:\n` +
          `  [${i - 1}] ${prev.content?.substring(0, 80)}\n` +
          `  [${i}] ${curr.content?.substring(0, 80)}`,
      );
    }
  }
}

/**
 * Assert that a conversation history has no empty messages of any role.
 */
export function assertNoEmptyMessages(history: HistoryMessage[], label: string = 'history'): void {
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    expect(
      msg.content !== undefined && msg.content !== null && msg.content !== '',
      `Empty ${msg.role} message at index ${i} in ${label}`,
    ).toBe(true);
  }
}

/**
 * Full history integrity check — combines all validations.
 * Call this on any conversation history to verify it would be accepted by the Anthropic API.
 */
export function assertHistoryIntegrity(history: HistoryMessage[], label: string = 'history'): void {
  assertNoEmptyUserMessages(history, label);
  assertNoEmptyMessages(history, label);
  assertNoConsecutiveSameRole(history, label);
}

/**
 * Assert history integrity across all threads in a session.
 */
export function assertSessionHistoryIntegrity(session: RuntimeSession): void {
  // Check session-level history
  assertHistoryIntegrity(session.conversationHistory, 'session.conversationHistory');

  // Check each thread's history
  for (let i = 0; i < session.threads.length; i++) {
    const thread = session.threads[i];
    assertHistoryIntegrity(thread.conversationHistory, `Thread[${i}] (${thread.agentName})`);
  }
}

/**
 * Assert exact message count in history.
 * Use instead of toBeGreaterThanOrEqual to catch duplicate message bugs.
 */
export function assertExactMessageCount(
  history: HistoryMessage[],
  expected: number,
  label: string = 'history',
): void {
  expect(
    history.length,
    `Expected ${expected} messages in ${label}, got ${history.length}:\n` +
      history.map((m, i) => `  [${i}] ${m.role}: ${m.content?.substring(0, 60)}`).join('\n'),
  ).toBe(expected);
}

/**
 * Assert exact user message count in history.
 */
export function assertUserMessageCount(
  history: HistoryMessage[],
  expected: number,
  label: string = 'history',
): void {
  const userMsgs = history.filter((m) => m.role === 'user');
  expect(
    userMsgs.length,
    `Expected ${expected} user messages in ${label}, got ${userMsgs.length}:\n` +
      history.map((m, i) => `  [${i}] ${m.role}: ${m.content?.substring(0, 60)}`).join('\n'),
  ).toBe(expected);
}

/**
 * Assert exact assistant message count in history.
 */
export function assertAssistantMessageCount(
  history: HistoryMessage[],
  expected: number,
  label: string = 'history',
): void {
  const asstMsgs = history.filter((m) => m.role === 'assistant');
  expect(
    asstMsgs.length,
    `Expected ${expected} assistant messages in ${label}, got ${asstMsgs.length}:\n` +
      history.map((m, i) => `  [${i}] ${m.role}: ${m.content?.substring(0, 60)}`).join('\n'),
  ).toBe(expected);
}

// =============================================================================
// LLM INPUT VALIDATION
// =============================================================================

/**
 * Validate that messages sent to the LLM conform to Anthropic API rules.
 * Call this on mockClient.calls to verify the executor builds valid LLM payloads.
 */
export function assertValidLLMMessages(calls: LLMCall[], label: string = 'LLM calls'): void {
  for (let c = 0; c < calls.length; c++) {
    const call = calls[c];
    const msgs = call.messages;
    const callLabel = `${label}[${c}]`;

    // No empty user messages
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      if (msg.role === 'user') {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        expect(
          content && content.trim() !== '' && content !== '""',
          `Empty user message sent to LLM at ${callLabel} messages[${i}]`,
        ).toBe(true);
      }
    }

    // No consecutive same-role (except tool_use/tool_result sequences)
    for (let i = 1; i < msgs.length; i++) {
      const prev = msgs[i - 1];
      const curr = msgs[i];
      if (prev.role === curr.role && curr.role !== 'tool' && curr.role !== 'tool_result') {
        throw new Error(
          `Consecutive ${curr.role} messages in ${callLabel} at indices ${i - 1} and ${i}:\n` +
            `  [${i - 1}] ${String(prev.content).substring(0, 80)}\n` +
            `  [${i}] ${String(curr.content).substring(0, 80)}`,
        );
      }
    }
  }
}

// =============================================================================
// VALIDATING MOCK LLM CLIENT
// =============================================================================

/**
 * MockAnthropicClient that validates message format like the real Anthropic API.
 * Throws descriptive errors when receiving malformed messages, catching bugs that
 * would otherwise only surface with real API calls.
 */
export class ValidatingMockAnthropicClient {
  /** Track all chatWithToolUse calls for assertions */
  calls: LLMCall[] = [];

  /** Configurable response handler - override per test */
  private responseHandler: (
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    operationType?: string,
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

  /**
   * Set entity extraction response (calls with no tools).
   */
  setEntityExtractionResponse(entities: Record<string, unknown>) {
    const jsonStr = JSON.stringify(entities);
    const previousHandler = this.responseHandler;
    this.responseHandler = (systemPrompt, messages, tools, operationType) => {
      if (operationType === 'extraction') {
        return {
          text: jsonStr,
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: jsonStr }],
        };
      }
      return previousHandler(systemPrompt, messages, tools, operationType);
    };
  }

  /**
   * Set entity extraction + text response for reasoning call.
   */
  setExtractAndRespond(entities: Record<string, unknown>, responseText: string) {
    this.setResponseHandler((sys, msgs, tools, operationType) => {
      if (operationType === 'extraction') {
        const json = JSON.stringify(entities);
        return {
          text: json,
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: json }],
        };
      }
      return {
        text: responseText,
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: responseText }],
      };
    });
  }

  /**
   * Set handoff response (supervisor uses __handoff__ tool).
   */
  setHandoffResponse(target: string, callId: string, text: string) {
    this.setResponseHandler((sys, msgs, tools, operationType) => {
      if (operationType === 'extraction') {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      return {
        text,
        toolCalls: [{ id: callId, name: '__handoff__', input: { target, context: {} } }],
        stopReason: 'tool_use',
        rawContent: [
          { type: 'text', text },
          { type: 'tool_use', id: callId, name: '__handoff__', input: { target, context: {} } },
        ],
      };
    });
  }

  /**
   * Set complete tool response.
   */
  setCompleteResponse(callId: string, reason: string, text: string) {
    this.setResponseHandler((sys, msgs, tools, operationType) => {
      if (operationType === 'extraction') {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      return {
        text,
        toolCalls: [{ id: callId, name: '__complete__', input: { reason } }],
        stopReason: 'tool_use',
        rawContent: [
          { type: 'text', text },
          { type: 'tool_use', id: callId, name: '__complete__', input: { reason } },
        ],
      };
    });
  }

  async chatWithToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    operationType?: string,
    options?: Record<string, unknown>,
  ) {
    // VALIDATE: Reject empty user messages (like the real Anthropic API)
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'user') {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        if (!content || content.trim() === '') {
          throw new Error(
            `Anthropic API validation error: messages[${i}]: user messages must have non-empty content. ` +
              `Got: "${content}". Full message list:\n` +
              messages
                .map((m, j) => `  [${j}] ${m.role}: ${String(m.content).substring(0, 80)}`)
                .join('\n'),
          );
        }
      }
    }

    // VALIDATE: Reject consecutive same-role messages
    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1];
      const curr = messages[i];
      if (prev.role === curr.role && curr.role !== 'tool' && curr.role !== 'tool_result') {
        throw new Error(
          `Anthropic API validation error: consecutive ${curr.role} messages at indices ${i - 1} and ${i}.\n` +
            messages
              .map((m, j) => `  [${j}] ${m.role}: ${String(m.content).substring(0, 80)}`)
              .join('\n'),
        );
      }
    }

    this.calls.push({ systemPrompt, messages, tools, operationType, options });
    return this.responseHandler(systemPrompt, messages, tools, operationType);
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    operationType?: string,
    _onChunk?: (chunk: string) => void,
    options?: Record<string, unknown>,
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools, operationType, options);
  }
}

/**
 * Inject a ValidatingMockAnthropicClient into RuntimeExecutor sessions.
 */
export function injectValidatingMockClient(executor: unknown): ValidatingMockAnthropicClient {
  const mock = new ValidatingMockAnthropicClient();
  const wiring = (executor as any).llmWiring;
  wiring.wireLLMClient = async (session: any) => {
    session.llmClient = mock;
  };
  wiring.ensureSessionLLMClient = async (session: any) => {
    if (!session.llmClient) {
      session.llmClient = mock;
    }
  };
  return mock;
}

// =============================================================================
// TRACE HELPERS
// =============================================================================

export function createTraceCollector() {
  const traces: CapturedTrace[] = [];
  return {
    traces,
    callback: (event: { type: string; data: Record<string, unknown> }) =>
      traces.push({ type: event.type, data: event.data }),
  };
}

export function filterTraces(traces: CapturedTrace[], type: string): CapturedTrace[] {
  return traces.filter((t) => t.type === type);
}
