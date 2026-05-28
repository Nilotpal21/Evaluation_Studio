// REGRESSION: ABLP-1058
// When a reasoning loop iteration returns both text and tool_use (e.g. __set_context__),
// the assistant message pushed for the NEXT iteration must include the text content.
// The text block is a proxy for the reasoning item that OpenAI requires.

import { describe, it, expect } from 'vitest';
import { ReasoningExecutor } from '../reasoning-executor.js';
import type { LLMClient, LLMToolDefinition, LLMToolUseResult } from '../../types.js';

/**
 * Creates a fake LLM client that records the messages it receives on each call.
 * On call N (0-indexed), it returns the corresponding entry from `responses`.
 */
function createRecordingLLMClient(responses: LLMToolUseResult[]): {
  client: LLMClient;
  recordedCalls: Array<{
    systemPrompt: string;
    messages: Array<{
      role: string;
      content: string | Array<{ type: string; [key: string]: unknown }>;
    }>;
  }>;
} {
  const recordedCalls: Array<{
    systemPrompt: string;
    messages: Array<{
      role: string;
      content: string | Array<{ type: string; [key: string]: unknown }>;
    }>;
  }> = [];
  let callIndex = 0;

  const client: LLMClient = {
    async chatWithTools(systemPrompt, messages, _tools, _options) {
      recordedCalls.push({ systemPrompt, messages: JSON.parse(JSON.stringify(messages)) });
      const response = responses[callIndex] ?? { text: '', toolCalls: [], stopReason: 'end_turn' };
      callIndex++;
      return response;
    },
    async chat(_systemPrompt, _messages, _options) {
      return '';
    },
    async extractJson(_systemPrompt, _messages, _schema, _options) {
      return {};
    },
  };

  return { client, recordedCalls };
}

describe('ReasoningExecutor — ABLP-1058: text/reasoning preservation after __set_context__', () => {
  const setContextTool: LLMToolDefinition = {
    name: '__set_context__',
    description: 'Store context variables',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string' },
        end_date: { type: 'string' },
      },
    },
  };

  it('should preserve text content in assistant message when tool_use is also present (iteration N+1 receives full content from iteration N)', async () => {
    // Iteration 1: LLM returns BOTH text AND a __set_context__ tool call.
    // This simulates reasoning models that produce reasoning/thinking text
    // alongside the function call.
    const iteration1Response: LLMToolUseResult = {
      text: 'I understand you want leave from next Monday to Friday. Let me set those dates.',
      toolCalls: [
        {
          id: 'call_1',
          name: '__set_context__',
          input: { start_date: '2026-05-18', end_date: '2026-05-22' },
        },
      ],
      stopReason: 'tool_use',
    };

    // Iteration 2: LLM returns final text (no more tool calls).
    const iteration2Response: LLMToolUseResult = {
      text: 'I have set your leave dates to May 18-22, 2026.',
      toolCalls: [],
      stopReason: 'end_turn',
    };

    const { client, recordedCalls } = createRecordingLLMClient([
      iteration1Response,
      iteration2Response,
    ]);

    const executor = new ReasoningExecutor();
    await executor.execute(
      {
        systemPrompt: 'You are a leave assistant.',
        messages: [{ role: 'user', content: 'I want annual leave next Monday to Friday' }],
        tools: [setContextTool],
        maxIterations: 5,
      },
      client,
      async (_toolName, _input) => ({ success: true }),
    );

    // The second LLM call (index 1) should have the assistant message from iteration 1.
    // That assistant message MUST include the text content — not just tool_use blocks.
    expect(recordedCalls.length).toBe(2);

    const secondCallMessages = recordedCalls[1].messages;

    // Find the assistant message that was added after iteration 1
    const assistantMessages = secondCallMessages.filter((m) => m.role === 'assistant');
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

    const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
    expect(Array.isArray(lastAssistantMsg.content)).toBe(true);

    const contentBlocks = lastAssistantMsg.content as Array<{
      type: string;
      [key: string]: unknown;
    }>;

    // CRITICAL ASSERTION: The assistant message must contain a text block
    // preserving the LLM's text output from iteration 1.
    const textBlocks = contentBlocks.filter((b) => b.type === 'text');
    expect(textBlocks.length).toBeGreaterThanOrEqual(1);
    expect(textBlocks[0].text).toBe(
      'I understand you want leave from next Monday to Friday. Let me set those dates.',
    );

    // Also verify tool_use blocks are present
    const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('__set_context__');
  });

  it('should still work correctly when LLM returns only tool_use (no text)', async () => {
    // Some models return only tool_use without accompanying text
    const iteration1Response: LLMToolUseResult = {
      text: undefined,
      toolCalls: [
        {
          id: 'call_1',
          name: '__set_context__',
          input: { start_date: '2026-05-18', end_date: '2026-05-22' },
        },
      ],
      stopReason: 'tool_use',
    };

    const iteration2Response: LLMToolUseResult = {
      text: 'Dates set.',
      toolCalls: [],
      stopReason: 'end_turn',
    };

    const { client, recordedCalls } = createRecordingLLMClient([
      iteration1Response,
      iteration2Response,
    ]);

    const executor = new ReasoningExecutor();
    const result = await executor.execute(
      {
        systemPrompt: 'You are a leave assistant.',
        messages: [{ role: 'user', content: 'Set dates to next week' }],
        tools: [setContextTool],
        maxIterations: 5,
      },
      client,
      async (_toolName, _input) => ({ success: true }),
    );

    expect(result.response).toBe('Dates set.');
    expect(recordedCalls.length).toBe(2);

    // When no text is present, assistant message should still have tool_use blocks
    const secondCallMessages = recordedCalls[1].messages;
    const assistantMessages = secondCallMessages.filter((m) => m.role === 'assistant');
    const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
    const contentBlocks = lastAssistantMsg.content as Array<{
      type: string;
      [key: string]: unknown;
    }>;
    const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(1);
  });

  it('should preserve provider rawContent when reasoning metadata is supplied', async () => {
    const iteration1Response: LLMToolUseResult = {
      text: 'Fallback text should not replace provider content',
      rawContent: [
        {
          type: 'reasoning',
          text: '',
          providerMetadata: {
            openai: { itemId: 'rs_1', reasoningEncryptedContent: 'encrypted-reasoning' },
          },
        },
        {
          type: 'tool_use',
          id: 'call_1',
          name: '__set_context__',
          input: { start_date: '2026-05-18', end_date: '2026-05-22' },
          providerMetadata: { openai: { itemId: 'fc_1' } },
        },
      ],
      toolCalls: [
        {
          id: 'call_1',
          name: '__set_context__',
          input: { start_date: '2026-05-18', end_date: '2026-05-22' },
        },
      ],
      stopReason: 'tool_use',
    };

    const iteration2Response: LLMToolUseResult = {
      text: 'Dates set.',
      toolCalls: [],
      stopReason: 'end_turn',
    };

    const { client, recordedCalls } = createRecordingLLMClient([
      iteration1Response,
      iteration2Response,
    ]);

    const executor = new ReasoningExecutor();
    await executor.execute(
      {
        systemPrompt: 'You are a leave assistant.',
        messages: [{ role: 'user', content: 'Set dates to next week' }],
        tools: [setContextTool],
        maxIterations: 5,
      },
      client,
      async (_toolName, _input) => ({ success: true }),
    );

    const secondCallMessages = recordedCalls[1].messages;
    const assistantMessages = secondCallMessages.filter((m) => m.role === 'assistant');
    const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];

    expect(lastAssistantMsg.content).toEqual(iteration1Response.rawContent);
  });

  it('should append missing tool_use blocks when provider rawContent is partial', async () => {
    const iteration1Response: LLMToolUseResult = {
      rawContent: [
        {
          type: 'reasoning',
          text: '',
          providerMetadata: {
            openai: { itemId: 'rs_1', reasoningEncryptedContent: 'encrypted-reasoning' },
          },
        },
      ],
      toolCalls: [
        {
          id: 'call_1',
          name: '__set_context__',
          input: { start_date: '2026-05-18', end_date: '2026-05-22' },
        },
      ],
      stopReason: 'tool_use',
    };

    const iteration2Response: LLMToolUseResult = {
      text: 'Dates set.',
      toolCalls: [],
      stopReason: 'end_turn',
    };

    const { client, recordedCalls } = createRecordingLLMClient([
      iteration1Response,
      iteration2Response,
    ]);

    const executor = new ReasoningExecutor();
    await executor.execute(
      {
        systemPrompt: 'You are a leave assistant.',
        messages: [{ role: 'user', content: 'Set dates to next week' }],
        tools: [setContextTool],
        maxIterations: 5,
      },
      client,
      async (_toolName, _input) => ({ success: true }),
    );

    const secondCallMessages = recordedCalls[1].messages;
    const assistantMessages = secondCallMessages.filter((m) => m.role === 'assistant');
    const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
    const contentBlocks = lastAssistantMsg.content as Array<{
      type: string;
      [key: string]: unknown;
    }>;

    expect(contentBlocks.map((block) => block.type)).toEqual(['reasoning', 'tool_use']);
    expect(contentBlocks[1]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: '__set_context__',
      input: { start_date: '2026-05-18', end_date: '2026-05-22' },
    });
  });

  it('should backfill text when partial rawContent only includes tool_use blocks', async () => {
    const iteration1Response: LLMToolUseResult = {
      text: 'I will set those dates now.',
      rawContent: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: '__set_context__',
          input: { start_date: '2026-05-18', end_date: '2026-05-22' },
        },
      ],
      toolCalls: [
        {
          id: 'call_1',
          name: '__set_context__',
          input: { start_date: '2026-05-18', end_date: '2026-05-22' },
        },
      ],
      stopReason: 'tool_use',
    };

    const iteration2Response: LLMToolUseResult = {
      text: 'Dates set.',
      toolCalls: [],
      stopReason: 'end_turn',
    };

    const { client, recordedCalls } = createRecordingLLMClient([
      iteration1Response,
      iteration2Response,
    ]);

    const executor = new ReasoningExecutor();
    await executor.execute(
      {
        systemPrompt: 'You are a leave assistant.',
        messages: [{ role: 'user', content: 'Set dates to next week' }],
        tools: [setContextTool],
        maxIterations: 5,
      },
      client,
      async (_toolName, _input) => ({ success: true }),
    );

    const secondCallMessages = recordedCalls[1].messages;
    const assistantMessages = secondCallMessages.filter((m) => m.role === 'assistant');
    const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
    const contentBlocks = lastAssistantMsg.content as Array<{
      type: string;
      [key: string]: unknown;
    }>;

    expect(contentBlocks.map((block) => block.type)).toEqual(['text', 'tool_use']);
    expect(contentBlocks[0]).toEqual({
      type: 'text',
      text: 'I will set those dates now.',
    });
  });
});
