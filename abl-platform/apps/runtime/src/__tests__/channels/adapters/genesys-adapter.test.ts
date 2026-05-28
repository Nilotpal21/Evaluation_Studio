/**
 * Genesys Bot Connector Adapter Tests
 *
 * Tests for buildNormalizedMessage() and buildGenesysResponse().
 */

import { describe, it, expect } from 'vitest';
import { GenesysAdapter } from '../../../channels/adapters/genesys-adapter.js';
import type {
  GenesysWebhookRequest,
  GenesysResponse,
} from '../../../channels/adapters/genesys-adapter.js';
import type { ActionSetIR } from '@abl/compiler';

const adapter = new GenesysAdapter();

// ---------------------------------------------------------------------------
// buildNormalizedMessage
// ---------------------------------------------------------------------------

describe('GenesysAdapter.buildNormalizedMessage', () => {
  it('normalizes a Text message', () => {
    const body: GenesysWebhookRequest = {
      genesysConversationId: 'conv-1',
      inputMessage: { type: 'Text', text: 'Hello' },
      channelSource: 'genesys',
    };

    const msg = adapter.buildNormalizedMessage(body);

    expect(msg.text).toBe('Hello');
    expect(msg.externalSessionKey).toBe('genesys:conv-1');
    expect(msg.externalMessageId).toMatch(/^conv-1-\d+$/);
    expect(msg.metadata?.genesysConversationId).toBe('conv-1');
    expect(msg.metadata?.channelSource).toBe('genesys');
    expect(msg.metadata?.originalMessage).toEqual({ type: 'Text', text: 'Hello' });
    expect(msg.actionEvent).toBeUndefined();
  });

  it('normalizes a Structured (button) message', () => {
    const body: GenesysWebhookRequest = {
      genesysConversationId: 'conv-2',
      inputMessage: {
        type: 'Structured',
        buttonResponse: { payload: 'option_a' },
      },
    };

    const msg = adapter.buildNormalizedMessage(body);

    expect(msg.text).toBe('option_a');
    expect(msg.actionEvent).toBeDefined();
    expect(msg.actionEvent!.type).toBe('action_event');
    expect(msg.actionEvent!.actionId).toBe('option_a');
    expect(msg.actionEvent!.value).toBe('option_a');
  });

  it('rejects malformed Structured buttonResponse action envelopes at ingress', () => {
    expect(() =>
      adapter.buildNormalizedMessage({
        genesysConversationId: 'conv-invalid',
        inputMessage: {
          type: 'Structured',
          buttonResponse: { payload: 'x'.repeat(300) },
        },
      }),
    ).toThrow('Invalid actionId in action_submit');
  });

  it('handles missing text gracefully', () => {
    const body: GenesysWebhookRequest = {
      genesysConversationId: 'conv-3',
      inputMessage: { type: 'Text' },
    };

    const msg = adapter.buildNormalizedMessage(body);

    expect(msg.text).toBe('');
  });

  it('handles Structured without buttonResponse payload', () => {
    const body: GenesysWebhookRequest = {
      genesysConversationId: 'conv-4',
      inputMessage: { type: 'Structured' },
    };

    const msg = adapter.buildNormalizedMessage(body);

    // Falls through to text extraction path since no payload
    expect(msg.text).toBe('');
    expect(msg.actionEvent).toBeUndefined();
  });

  it('handles unknown message type', () => {
    const body: GenesysWebhookRequest = {
      genesysConversationId: 'conv-5',
      inputMessage: { type: 'Event', text: 'typing' },
    };

    const msg = adapter.buildNormalizedMessage(body);

    expect(msg.text).toBe('typing');
    expect(msg.actionEvent).toBeUndefined();
  });

  it('sets timestamp to a Date', () => {
    const body: GenesysWebhookRequest = {
      genesysConversationId: 'conv-6',
      inputMessage: { type: 'Text', text: 'test' },
    };

    const msg = adapter.buildNormalizedMessage(body);

    expect(msg.timestamp).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// buildGenesysResponse
// ---------------------------------------------------------------------------

describe('GenesysAdapter.buildGenesysResponse', () => {
  it('returns a Text reply for plain text', () => {
    const resp = adapter.buildGenesysResponse('Hello there');

    expect(resp.replymessages).toHaveLength(1);
    expect(resp.replymessages[0].type).toBe('Text');
    expect(resp.replymessages[0].text).toBe('Hello there');
    expect(resp.botState).toBe('MOREDATA');
    expect(resp.intent).toBe('Default Kore VA Intent');
    expect(resp.endOfTask).toBe(false);
  });

  it('returns a Text reply when actions has no button elements', () => {
    const actions: ActionSetIR = { elements: [] };
    const resp = adapter.buildGenesysResponse('No buttons', actions);

    expect(resp.replymessages).toHaveLength(1);
    expect(resp.replymessages[0].type).toBe('Text');
  });

  it('returns a Structured reply with QuickReplies for button actions', () => {
    const actions: ActionSetIR = {
      elements: [
        { type: 'button', id: 'btn1', label: 'Yes', value: 'yes' },
        { type: 'button', id: 'btn2', label: 'No', value: 'no' },
      ],
    };

    const resp = adapter.buildGenesysResponse('Choose one:', actions);

    expect(resp.replymessages).toHaveLength(1);
    const msg = resp.replymessages[0];
    expect(msg.type).toBe('Structured');
    expect(msg.text).toBe('Choose one:');
    expect(msg.content).toHaveLength(2);
    expect(msg.content![0]).toEqual({
      contentType: 'QuickReply',
      quickReply: { text: 'Yes', payload: 'yes' },
    });
    expect(msg.content![1]).toEqual({
      contentType: 'QuickReply',
      quickReply: { text: 'No', payload: 'no' },
    });
  });

  it('uses button id as payload fallback when value is missing', () => {
    const actions: ActionSetIR = {
      elements: [{ type: 'button', id: 'fallback_id', label: 'Click me' }],
    };

    const resp = adapter.buildGenesysResponse('Test', actions);

    expect(resp.replymessages[0].content![0].quickReply.payload).toBe('fallback_id');
  });

  it('ignores non-button elements in actions', () => {
    const actions: ActionSetIR = {
      elements: [
        { type: 'link', id: 'lnk1', label: 'Visit', url: 'https://example.com' } as any,
        { type: 'button', id: 'btn1', label: 'OK', value: 'ok' },
      ],
    };

    const resp = adapter.buildGenesysResponse('Mixed', actions);

    expect(resp.replymessages[0].content).toHaveLength(1);
    expect(resp.replymessages[0].content![0].quickReply.text).toBe('OK');
  });

  it('returns Text when actions is undefined', () => {
    const resp = adapter.buildGenesysResponse('No actions', undefined);

    expect(resp.replymessages[0].type).toBe('Text');
  });
});
