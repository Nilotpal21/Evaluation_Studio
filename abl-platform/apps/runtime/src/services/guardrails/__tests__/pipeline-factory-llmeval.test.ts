import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLLMEvalFromClient } from '../pipeline-factory.js';

describe('createLLMEvalFromClient', () => {
  it('creates an LLMEvalFunction adapter from a SessionLLMClient', async () => {
    const mockClient = {
      chatWithToolUse: vi.fn().mockResolvedValue({
        text: 'SAFE',
        toolCalls: [],
        rawContent: [{ type: 'text', text: 'SAFE' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    };

    const evalFn = createLLMEvalFromClient(mockClient as any);
    const result = await evalFn('Is this content safe? Content: "Hello world"');

    expect(result).toBe('SAFE');
    expect(mockClient.chatWithToolUse).toHaveBeenCalledWith(
      '', // empty system prompt
      [{ role: 'user', content: 'Is this content safe? Content: "Hello world"' }],
      [], // no tools
      'validation',
    );
  });

  it('returns empty string when LLM returns no text', async () => {
    const mockClient = {
      chatWithToolUse: vi.fn().mockResolvedValue({
        text: '',
        toolCalls: [],
        rawContent: [],
        stopReason: 'end_turn',
      }),
    };

    const evalFn = createLLMEvalFromClient(mockClient as any);
    const result = await evalFn('test prompt');

    expect(result).toBe('');
  });

  it('propagates errors from the LLM client', async () => {
    const mockClient = {
      chatWithToolUse: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    };

    const evalFn = createLLMEvalFromClient(mockClient as any);
    await expect(evalFn('test prompt')).rejects.toThrow('LLM unavailable');
  });
});
