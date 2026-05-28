import { describe, expect, it } from 'vitest';
import type { LLMMessage } from '@agent-platform/arch-ai/engine';

import { toV2VercelMessages } from '@/lib/arch-ai/vercel-message-adapter';

describe('toV2VercelMessages', () => {
  it('converts internal tool loop messages into the AI SDK ModelMessage shape', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: 'AppointmentBooker',
      },
      {
        role: 'assistant',
        content: 'Updating specification...',
        toolCalls: [
          {
            id: 'tool-call-1',
            name: 'update_specification',
            args: {
              field: 'projectName',
              value: 'AppointmentBooker',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: JSON.stringify({
          updated: true,
          field: 'projectName',
          value: 'AppointmentBooker',
        }),
        toolCallId: 'tool-call-1',
      },
    ];

    expect(toV2VercelMessages(messages)).toEqual([
      {
        role: 'user',
        content: 'AppointmentBooker',
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Updating specification...' },
          {
            type: 'tool-call',
            toolCallId: 'tool-call-1',
            toolName: 'update_specification',
            input: {
              field: 'projectName',
              value: 'AppointmentBooker',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-call-1',
            toolName: 'update_specification',
            output: {
              type: 'json',
              value: {
                updated: true,
                field: 'projectName',
                value: 'AppointmentBooker',
              },
            },
          },
        ],
      },
    ]);
  });

  it('falls back to text output when a tool result is not JSON', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'tool-call-2',
            name: 'compile_abl',
            args: { agentName: 'scheduler' },
          },
        ],
      },
      {
        role: 'tool',
        content: 'compiler unavailable',
        toolCallId: 'tool-call-2',
      },
    ];

    expect(toV2VercelMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-call-2',
            toolName: 'compile_abl',
            input: { agentName: 'scheduler' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-call-2',
            toolName: 'compile_abl',
            output: {
              type: 'text',
              value: 'compiler unavailable',
            },
          },
        ],
      },
    ]);
  });

  it('normalizes undefined tool results into a valid null payload', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'tool-call-3',
            name: 'read_topology',
            args: {},
          },
        ],
      },
      {
        role: 'tool',
        content: undefined as unknown as string,
        toolCallId: 'tool-call-3',
      },
    ];

    expect(toV2VercelMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-call-3',
            toolName: 'read_topology',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-call-3',
            toolName: 'read_topology',
            output: {
              type: 'json',
              value: null,
            },
          },
        ],
      },
    ]);
  });

  it('converts provider content blocks into AI SDK message parts', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please review this project brief.' },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/diagram.png' },
          },
        ],
      },
    ];

    expect(toV2VercelMessages(messages)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please review this project brief.' },
          { type: 'image', image: 'https://example.com/diagram.png' },
        ],
      },
    ]);
  });

  it('keeps assistant text and multiple tool calls in a single assistant message', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: 'Checking both tools...',
        toolCalls: [
          {
            id: 'tool-call-3',
            name: 'update_specification',
            args: { field: 'objective', value: 'Book appointments' },
          },
          {
            id: 'tool-call-4',
            name: 'platform_context',
            args: { topic: 'scheduling' },
          },
        ],
      },
    ];

    expect(toV2VercelMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking both tools...' },
          {
            type: 'tool-call',
            toolCallId: 'tool-call-3',
            toolName: 'update_specification',
            input: { field: 'objective', value: 'Book appointments' },
          },
          {
            type: 'tool-call',
            toolCallId: 'tool-call-4',
            toolName: 'platform_context',
            input: { topic: 'scheduling' },
          },
        ],
      },
    ]);
  });
});
