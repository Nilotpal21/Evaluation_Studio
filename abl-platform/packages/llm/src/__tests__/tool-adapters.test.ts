import { describe, expect, it } from 'vitest';
import type { Message } from '@abl/compiler/platform/llm/types.js';
import {
  convertMessages,
  extractOpenAIResponsesPreviousResponseId,
  findOpenAIResponsesPreviousResponse,
} from '../tool-adapters.js';

describe('extractOpenAIResponsesPreviousResponseId', () => {
  it('returns the newest OpenAI Responses response id from assistant metadata', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_old',
            name: 'lookup',
            input: {},
            providerMetadata: { openai: { responseId: 'resp_old' } },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_old', content: '{"ok":true}' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Continuing',
            providerMetadata: { openai: { responseId: 'resp_new' } },
          },
        ],
      },
    ];

    expect(extractOpenAIResponsesPreviousResponseId(messages)).toBe('resp_new');
    expect(findOpenAIResponsesPreviousResponse(messages)).toEqual({
      responseId: 'resp_new',
      messageIndex: 2,
      blockIndex: 0,
    });
  });

  it('ignores non-OpenAI provider metadata and string-only content', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_google',
            name: 'lookup',
            input: {},
            providerMetadata: { google: { thoughtSignature: 'sig' } },
          },
        ],
      },
    ];

    expect(extractOpenAIResponsesPreviousResponseId(messages)).toBeUndefined();
  });
});

describe('convertMessages', () => {
  it('can resolve tool_result names from full history when request history is pruned', () => {
    const fullHistory: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_lookup',
            name: 'get_order',
            input: {},
            providerMetadata: { openai: { responseId: 'resp_previous' } },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_lookup', content: '{"ok":true}' }],
      },
    ];

    expect(convertMessages(fullHistory.slice(1), { toolNameSourceMessages: fullHistory })).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_lookup',
            toolName: 'get_order',
            output: { type: 'json', value: { ok: true } },
          },
        ],
      },
    ]);
  });
});
