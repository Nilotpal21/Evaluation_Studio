import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '../types.js';

describe('ABLP-1058 provider content-block round trip', () => {
  it('preserves provider metadata on reasoning and tool-use blocks across JSON boundaries', () => {
    const original: ContentBlock[] = [
      {
        type: 'text',
        text: 'I need to set the dates before replying.',
        providerMetadata: {
          openai: { responseId: 'resp_1058' },
        },
      },
      {
        type: 'reasoning',
        text: 'The requested range maps to next Monday through Friday.',
        providerMetadata: {
          openai: {
            responseId: 'resp_1058',
            itemId: 'rs_1058',
          },
        },
      },
      {
        type: 'tool_use',
        id: 'call_1058',
        name: '__set_context__',
        input: {
          start_date: '2026-05-18',
          end_date: '2026-05-22',
        },
        providerMetadata: {
          openai: {
            responseId: 'resp_1058',
            itemId: 'fc_1058',
          },
        },
      },
    ];

    const replayed = JSON.parse(JSON.stringify(original)) as ContentBlock[];

    expect(replayed).toEqual(original);
    expect(replayed.map((block) => block.type)).toEqual(['text', 'reasoning', 'tool_use']);
    expect(replayed[1]).toMatchObject({
      providerMetadata: {
        openai: {
          responseId: 'resp_1058',
          itemId: 'rs_1058',
        },
      },
    });
    expect(replayed[2]).toMatchObject({
      providerMetadata: {
        openai: {
          responseId: 'resp_1058',
          itemId: 'fc_1058',
        },
      },
    });
  });
});
