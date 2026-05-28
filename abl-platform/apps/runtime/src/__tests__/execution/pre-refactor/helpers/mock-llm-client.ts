/**
 * Shared MockAnthropicClient for pre-refactor parity tests.
 *
 * Extracted from the inline definitions that were copy-pasted across 10 test files.
 * Provides a configurable mock LLM client and an injection function that
 * patches the RuntimeExecutor's LLM wiring to use the mock.
 */

import type { RuntimeExecutor } from '../../../../services/runtime-executor';

export type LLMResponseHandler = (
  systemPrompt: string,
  messages: unknown[],
  tools: unknown[],
) => {
  kind?: 'success' | 'provider_error';
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason: string;
  rawContent: Array<Record<string, unknown>>;
  providerError?: {
    code: 'LLM_PROVIDER_STOP_REASON_ERROR';
    message: string;
    stopReason: string;
    provider?: string;
    modelId?: string;
    retryable: boolean;
  };
  resolvedModel?: {
    modelId: string;
    provider: string;
    source: string;
  };
};

export class MockAnthropicClient {
  calls: Array<{ systemPrompt: string; messages: unknown[]; tools: unknown[] }> = [];
  private responseHandler: LLMResponseHandler = (_s, _m, _t) => ({
    text: 'Mock response.',
    toolCalls: [],
    stopReason: 'end_turn',
    rawContent: [{ type: 'text', text: 'Mock response.' }],
  });

  setResponseHandler(handler: LLMResponseHandler) {
    this.responseHandler = handler;
  }

  /**
   * Convenience: set a handler that returns entity extraction tool calls
   * when the LLM is invoked with an `_extract_entities` tool.
   */
  setEntityExtractionResponse(entities: Record<string, unknown>) {
    const prev = this.responseHandler;
    this.responseHandler = (s, m, tools) => {
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
      return prev(s, m, tools);
    };
  }

  async chatWithToolUse(systemPrompt: string, messages: unknown[], tools: unknown[]) {
    this.calls.push({ systemPrompt, messages, tools });
    return this.responseHandler(systemPrompt, messages, tools);
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: unknown[],
    tools: unknown[],
    _operationType?: string,
    _onChunk?: (chunk: string) => void,
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools);
  }
}

/**
 * Injects a MockAnthropicClient into the executor's LLM wiring,
 * so all sessions created from this executor use the mock.
 */
export function injectMockClient(executor: RuntimeExecutor): MockAnthropicClient {
  const mock = new MockAnthropicClient();
  (executor as any).llmWiring.wireLLMClient = async (session: any) => {
    session.llmClient = mock;
  };
  (executor as any).llmWiring.ensureSessionLLMClient = async (session: any) => {
    if (!session.llmClient) session.llmClient = mock;
  };
  return mock;
}
