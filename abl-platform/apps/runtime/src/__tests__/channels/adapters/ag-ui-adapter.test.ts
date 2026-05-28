/**
 * AG-UI Adapter Tests
 *
 * Tests transformOutput() for AG-UI SSE event sequences:
 * TEXT_MESSAGE_START/CONTENT/END for text,
 * TOOL_CALL_START/ARGS/END for each action element.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgUiAdapter } from '../../../channels/adapters/ag-ui-adapter.js';
import type { ActionSetIR, RichContentIR } from '@abl/compiler';

// Mock crypto.randomUUID for deterministic test output
vi.stubGlobal('crypto', {
  ...globalThis.crypto,
  randomUUID: () => 'test-uuid-1234',
});

describe('AgUiAdapter.transformOutput', () => {
  const adapter = new AgUiAdapter();

  it('returns text-only when no actions and no text', () => {
    const result = adapter.transformOutput('');
    expect(result).toEqual({ kind: 'text', text: '' });
  });

  it('emits authored AG-UI rich content as a structured event', () => {
    const richContent: RichContentIR = {
      ag_ui: '{"type":"card","title":"Loading account"}',
    };

    const result = adapter.transformOutput('', undefined, richContent);

    expect(result.kind).toBe('ag_ui_events');
    if (result.kind !== 'ag_ui_events') return;

    expect(result.events).toEqual([
      {
        type: 'RICH_CONTENT',
        data: {
          channel: 'ag_ui',
          payload: { type: 'card', title: 'Loading account' },
        },
      },
    ]);
  });

  it('returns text-only when no actions provided', () => {
    const result = adapter.transformOutput('Hello');
    expect(result.kind).toBe('ag_ui_events');
    if (result.kind !== 'ag_ui_events') return;

    // Should produce 3 text events
    expect(result.events).toHaveLength(3);
    expect(result.events[0].type).toBe('TEXT_MESSAGE_START');
    expect(result.events[1].type).toBe('TEXT_MESSAGE_CONTENT');
    expect((result.events[1].data as any).content).toBe('Hello');
    expect(result.events[2].type).toBe('TEXT_MESSAGE_END');
  });

  it('produces text event sequence for text only', () => {
    const result = adapter.transformOutput('Agent response');
    expect(result.kind).toBe('ag_ui_events');
    if (result.kind !== 'ag_ui_events') return;

    expect(result.events[0]).toEqual({
      type: 'TEXT_MESSAGE_START',
      data: { messageId: expect.any(String) },
    });
    expect(result.events[1]).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      data: { content: 'Agent response' },
    });
    expect(result.events[2]).toEqual({
      type: 'TEXT_MESSAGE_END',
      data: {},
    });
  });

  it('produces tool call events for button actions', () => {
    const actions: ActionSetIR = {
      elements: [{ id: 'buy', type: 'button', label: 'Buy Now', value: 'purchase' }],
    };

    const result = adapter.transformOutput('', actions);
    expect(result.kind).toBe('ag_ui_events');
    if (result.kind !== 'ag_ui_events') return;

    // No text → no text events; 1 action → 3 tool events
    expect(result.events).toHaveLength(3);
    expect(result.events[0].type).toBe('TOOL_CALL_START');
    expect((result.events[0].data as any).toolCallId).toBe('action_buy');
    expect((result.events[0].data as any).toolName).toBe('ui_button');

    expect(result.events[1].type).toBe('TOOL_CALL_ARGS');
    const args = JSON.parse((result.events[1].data as any).args);
    expect(args.id).toBe('buy');
    expect(args.type).toBe('button');
    expect(args.label).toBe('Buy Now');
    expect(args.value).toBe('purchase');

    expect(result.events[2].type).toBe('TOOL_CALL_END');
    expect((result.events[2].data as any).toolCallId).toBe('action_buy');
  });

  it('produces text + tool call events together', () => {
    const actions: ActionSetIR = {
      elements: [
        { id: 'yes', type: 'button', label: 'Yes' },
        { id: 'no', type: 'button', label: 'No' },
      ],
    };

    const result = adapter.transformOutput('Confirm?', actions);
    expect(result.kind).toBe('ag_ui_events');
    if (result.kind !== 'ag_ui_events') return;

    // 3 text events + 2 * 3 tool events = 9
    expect(result.events).toHaveLength(9);
    expect(result.events[0].type).toBe('TEXT_MESSAGE_START');
    expect(result.events[2].type).toBe('TEXT_MESSAGE_END');
    expect(result.events[3].type).toBe('TOOL_CALL_START');
    expect(result.events[6].type).toBe('TOOL_CALL_START');
  });

  it('produces tool call events for select actions', () => {
    const actions: ActionSetIR = {
      elements: [
        {
          id: 'color',
          type: 'select',
          label: 'Pick color',
          options: [
            { id: 'red', label: 'Red' },
            { id: 'blue', label: 'Blue' },
          ],
        },
      ],
    };

    const result = adapter.transformOutput('', actions);
    expect(result.kind).toBe('ag_ui_events');
    if (result.kind !== 'ag_ui_events') return;

    expect(result.events).toHaveLength(3);
    expect((result.events[0].data as any).toolName).toBe('ui_select');
    const args = JSON.parse((result.events[1].data as any).args);
    expect(args.options).toHaveLength(2);
    expect(args.options[0].id).toBe('red');
  });

  it('produces tool call events for input actions', () => {
    const actions: ActionSetIR = {
      elements: [
        {
          id: 'name',
          type: 'input',
          label: 'Your name',
          placeholder: 'Enter name',
          required: true,
        },
      ],
    };

    const result = adapter.transformOutput('', actions);
    expect(result.kind).toBe('ag_ui_events');
    if (result.kind !== 'ag_ui_events') return;

    expect(result.events).toHaveLength(3);
    expect((result.events[0].data as any).toolName).toBe('ui_input');
    const args = JSON.parse((result.events[1].data as any).args);
    expect(args.placeholder).toBe('Enter name');
    expect(args.required).toBe(true);
  });

  it('returns text-only for empty elements array', () => {
    const result = adapter.transformOutput('Hello', { elements: [] });
    expect(result.kind).toBe('ag_ui_events');
    if (result.kind !== 'ag_ui_events') return;

    // Only text events, no tool calls
    expect(result.events).toHaveLength(3);
    expect(result.events.every((e) => e.type.startsWith('TEXT_'))).toBe(true);
  });
});

describe('AgUiAdapter.sendResponse', () => {
  const adapter = new AgUiAdapter();

  it('throws error since AG-UI uses SSE transport', async () => {
    await expect(
      adapter.sendResponse(
        { sessionId: 's1', text: 'hi', eventType: 'agent.response' },
        {
          id: 'c1',
          tenantId: 't1',
          projectId: 'p1',
          agentId: null,
          channelType: 'ag_ui',
          externalIdentifier: '',
          credentials: null,
          config: {},
          status: 'active',
        },
      ),
    ).rejects.toThrow('does not support direct sendResponse');
  });
});
