/**
 * WhatsApp Adapter Tests
 *
 * Tests transformOutput() for WhatsApp interactive buttons and lists,
 * buildNormalizedMessage() for inbound events, shouldProcess() for event
 * filtering, verifyRequest() for HMAC signature verification,
 * handleWebhookVerification() for Meta GET verification, and extraction helpers.
 */

import crypto from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { WhatsAppAdapter } from '../../../channels/adapters/whatsapp-adapter.js';
import type { ActionSetIR } from '@abl/compiler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWebhookPayload(
  msg: Record<string, unknown>,
  overrides?: { phoneNumberId?: string; from?: string; timestamp?: string },
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba123',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+15551234567',
                phone_number_id: overrides?.phoneNumberId || 'phone123',
              },
              contacts: [{ profile: { name: 'John' }, wa_id: overrides?.from || '5551234' }],
              messages: [
                {
                  id: 'wamid.test123',
                  from: overrides?.from || '5551234',
                  timestamp: overrides?.timestamp || String(Math.floor(Date.now() / 1000)),
                  ...msg,
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

function signPayload(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ---------------------------------------------------------------------------
// shouldProcess
// ---------------------------------------------------------------------------

describe('WhatsAppAdapter.shouldProcess', () => {
  const adapter = new WhatsAppAdapter();

  it('returns true for text messages', () => {
    const body = makeWebhookPayload({ type: 'text', text: { body: 'Hello' } });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns true for interactive button reply', () => {
    const body = makeWebhookPayload({
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes' } },
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns true for interactive list reply', () => {
    const body = makeWebhookPayload({
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'opt1', title: 'Option 1' } },
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns false for status-only webhooks (no messages)', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba123',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+1234', phone_number_id: 'phone123' },
                statuses: [{ id: 'wamid.1', status: 'delivered', timestamp: '1700000000' }],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns false for stale events', () => {
    const tenMinutesAgo = Math.floor((Date.now() - 10 * 60 * 1000) / 1000);
    const body = makeWebhookPayload(
      { type: 'text', text: { body: 'Old message' } },
      { timestamp: String(tenMinutesAgo) },
    );
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns false for future timestamps (clock skew > 1 min)', () => {
    const tenMinutesFromNow = Math.floor((Date.now() + 10 * 60 * 1000) / 1000);
    const body = makeWebhookPayload(
      { type: 'text', text: { body: 'Future message' } },
      { timestamp: String(tenMinutesFromNow) },
    );
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns false for non-numeric timestamp', () => {
    const body = makeWebhookPayload(
      { type: 'text', text: { body: 'Bad timestamp' } },
      { timestamp: 'not-a-number' },
    );
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns true for recent message within 5-minute window', () => {
    const fourMinutesAgo = Math.floor((Date.now() - 4 * 60 * 1000) / 1000);
    const body = makeWebhookPayload(
      { type: 'text', text: { body: 'Recent message' } },
      { timestamp: String(fourMinutesAgo) },
    );
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns true for reaction messages', () => {
    const body = makeWebhookPayload({
      type: 'reaction',
      reaction: { message_id: 'wamid.orig123', emoji: '👍' },
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns true for contacts messages', () => {
    const body = makeWebhookPayload({
      type: 'contacts',
      contacts: [{ name: { formatted_name: 'Alice' }, phones: [{ phone: '+1555' }] }],
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns true for location messages', () => {
    const body = makeWebhookPayload({
      type: 'location',
      location: { latitude: 37.7749, longitude: -122.4194 },
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns true for template button callback (type: button)', () => {
    const body = makeWebhookPayload({
      type: 'button',
      button: { text: 'Confirm', payload: 'confirm_booking' },
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns true for media message types (image)', () => {
    const body = makeWebhookPayload({
      type: 'image',
      image: { id: 'img1', mime_type: 'image/jpeg' },
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns false for empty messages array', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba123',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+1234', phone_number_id: 'phone123' },
                messages: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
    expect(adapter.shouldProcess(body)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyRequest
// ---------------------------------------------------------------------------

describe('WhatsAppAdapter.verifyRequest', () => {
  const adapter = new WhatsAppAdapter();
  const APP_SECRET = 'test_whatsapp_secret_123';

  afterEach(() => {
    delete process.env.WHATSAPP_APP_SECRET;
  });

  it('returns true for valid HMAC signature', async () => {
    const bodyStr = '{"object":"whatsapp_business_account"}';
    const signature = signPayload(bodyStr, APP_SECRET);

    const result = await adapter.verifyRequest(
      { 'x-hub-signature-256': signature },
      JSON.parse(bodyStr),
      Buffer.from(bodyStr),
      { credentials: { app_secret: APP_SECRET } } as any,
    );
    expect(result).toBe(true);
  });

  it('returns false for invalid signature', async () => {
    const bodyStr = '{"object":"whatsapp_business_account"}';

    const result = await adapter.verifyRequest(
      { 'x-hub-signature-256': 'sha256=invalid' },
      JSON.parse(bodyStr),
      Buffer.from(bodyStr),
      { credentials: { app_secret: APP_SECRET } } as any,
    );
    expect(result).toBe(false);
  });

  it('returns false when signature header is missing', async () => {
    const result = await adapter.verifyRequest(
      {},
      { object: 'whatsapp_business_account' },
      Buffer.from('{}'),
      { credentials: { app_secret: APP_SECRET } } as any,
    );
    expect(result).toBe(false);
  });

  it('falls back to env var when no connection credentials', async () => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    const bodyStr = '{"test":true}';
    const signature = signPayload(bodyStr, APP_SECRET);

    const result = await adapter.verifyRequest(
      { 'x-hub-signature-256': signature },
      JSON.parse(bodyStr),
      Buffer.from(bodyStr),
      null,
    );
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleWebhookVerification
// ---------------------------------------------------------------------------

describe('WhatsAppAdapter.handleWebhookVerification', () => {
  const adapter = new WhatsAppAdapter();

  it('returns challenge when token matches connection credential', () => {
    const result = adapter.handleWebhookVerification(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'my_token', 'hub.challenge': 'abc123' },
      { credentials: { verify_token: 'my_token' } },
    );
    expect(result).toBe('abc123');
  });

  it('returns null when no connection is provided', () => {
    const result = adapter.handleWebhookVerification(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'some_token', 'hub.challenge': 'abc' },
      null,
    );
    expect(result).toBeNull();
  });

  it('returns null when token does not match connection credential', () => {
    const result = adapter.handleWebhookVerification(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'abc' },
      { credentials: { verify_token: 'correct' } },
    );
    expect(result).toBeNull();
  });

  it('returns null when mode is not subscribe', () => {
    const result = adapter.handleWebhookVerification(
      { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'token', 'hub.challenge': 'abc' },
      { credentials: { verify_token: 'token' } },
    );
    expect(result).toBeNull();
  });

  it('returns null when challenge is missing', () => {
    const result = adapter.handleWebhookVerification(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'token' },
      { credentials: { verify_token: 'token' } },
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractEventId
// ---------------------------------------------------------------------------

describe('WhatsAppAdapter.extractEventId', () => {
  const adapter = new WhatsAppAdapter();

  it('extracts message ID', () => {
    const body = makeWebhookPayload({ type: 'text', text: { body: 'Hi' } });
    expect(adapter.extractEventId(body)).toBe('wamid.test123');
  });

  it('returns null when no messages', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba123',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+1234', phone_number_id: 'phone123' },
                statuses: [{ id: 'wamid.1', status: 'read' }],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
    expect(adapter.extractEventId(body)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractExternalIdentifier
// ---------------------------------------------------------------------------

describe('WhatsAppAdapter.extractExternalIdentifier', () => {
  const adapter = new WhatsAppAdapter();

  it('extracts phone_number_id from metadata', () => {
    const body = makeWebhookPayload({ type: 'text', text: { body: 'Hi' } });
    expect(adapter.extractExternalIdentifier(body)).toBe('phone123');
  });

  it('returns null for empty entry', () => {
    const body = { object: 'whatsapp_business_account', entry: [] };
    expect(adapter.extractExternalIdentifier(body)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// transformOutput (existing tests preserved)
// ---------------------------------------------------------------------------

describe('WhatsAppAdapter.transformOutput', () => {
  const adapter = new WhatsAppAdapter();

  it('returns text-only when no actions', () => {
    const result = adapter.transformOutput('Hello');
    expect(result).toEqual({ kind: 'text', text: 'Hello' });
  });

  it('transforms ≤3 buttons into interactive reply buttons', () => {
    const actions: ActionSetIR = {
      elements: [
        { id: 'yes', type: 'button', label: 'Yes' },
        { id: 'no', type: 'button', label: 'No' },
      ],
    };

    const result = adapter.transformOutput('Confirm?', actions);
    expect(result.kind).toBe('whatsapp_interactive');
    if (result.kind !== 'whatsapp_interactive') return;

    const interactive = result.interactive as any;
    expect(interactive.type).toBe('button');
    expect(interactive.body.text).toBe('Confirm?');
    expect(interactive.action.buttons).toHaveLength(2);
    expect(interactive.action.buttons[0].reply.id).toBe('yes');
    expect(interactive.action.buttons[0].reply.title).toBe('Yes');
    expect(interactive.action.buttons[1].reply.id).toBe('no');
  });

  it('falls back to list when >3 buttons', () => {
    const actions: ActionSetIR = {
      elements: Array.from({ length: 5 }, (_, i) => ({
        id: `opt${i}`,
        type: 'button' as const,
        label: `Option ${i}`,
      })),
    };

    const result = adapter.transformOutput('Many options:', actions);
    expect(result.kind).toBe('whatsapp_interactive');
    if (result.kind !== 'whatsapp_interactive') return;

    const interactive = result.interactive as any;
    expect(interactive.type).toBe('list');
    expect(interactive.action.sections[0].rows).toHaveLength(5);
  });

  it('transforms select options into list rows', () => {
    const actions: ActionSetIR = {
      elements: [
        {
          id: 'size',
          type: 'select',
          label: 'Size',
          options: [
            { id: 'sm', label: 'Small' },
            { id: 'md', label: 'Medium' },
            { id: 'lg', label: 'Large' },
          ],
        },
      ],
    };

    const result = adapter.transformOutput('Pick size:', actions);
    expect(result.kind).toBe('whatsapp_interactive');
    if (result.kind !== 'whatsapp_interactive') return;

    const interactive = result.interactive as any;
    expect(interactive.type).toBe('list');
    expect(interactive.action.sections[0].rows).toHaveLength(3);
    expect(interactive.action.sections[0].rows[0].id).toBe('sm');
    expect(interactive.action.sections[0].rows[0].title).toBe('Small');
  });

  it('truncates button labels to 20 chars', () => {
    const actions: ActionSetIR = {
      elements: [
        {
          id: 'btn',
          type: 'button',
          label: 'This is a very long button label that exceeds the limit',
        },
      ],
    };

    const result = adapter.transformOutput('', actions);
    expect(result.kind).toBe('whatsapp_interactive');
    if (result.kind !== 'whatsapp_interactive') return;

    const interactive = result.interactive as any;
    expect(interactive.action.buttons[0].reply.title).toHaveLength(20);
  });

  it('limits list rows to 10', () => {
    const actions: ActionSetIR = {
      elements: Array.from({ length: 15 }, (_, i) => ({
        id: `opt${i}`,
        type: 'button' as const,
        label: `Option ${i}`,
      })),
    };

    const result = adapter.transformOutput('Choose:', actions);
    expect(result.kind).toBe('whatsapp_interactive');
    if (result.kind !== 'whatsapp_interactive') return;

    const interactive = result.interactive as any;
    expect(interactive.action.sections[0].rows).toHaveLength(10);
  });

  it('uses submit_label as list button text', () => {
    const actions: ActionSetIR = {
      elements: [
        { id: 'a', type: 'button', label: 'A' },
        { id: 'b', type: 'button', label: 'B' },
        { id: 'c', type: 'button', label: 'C' },
        { id: 'd', type: 'button', label: 'D' },
      ],
      submit_label: 'Show Menu',
      submit_id: 'menu',
    };

    const result = adapter.transformOutput('', actions);
    expect(result.kind).toBe('whatsapp_interactive');
    if (result.kind !== 'whatsapp_interactive') return;

    const interactive = result.interactive as any;
    expect(interactive.type).toBe('list');
    expect(interactive.action.button).toBe('Show Menu');
  });
});

// ---------------------------------------------------------------------------
// transformOutput — WhatsApp message templates via richContent
// ---------------------------------------------------------------------------

describe('WhatsAppAdapter.transformOutput (templates)', () => {
  const adapter = new WhatsAppAdapter();

  it('returns whatsapp_template when richContent.whatsapp has valid template JSON', () => {
    const richContent = {
      whatsapp: JSON.stringify({
        template_name: 'booking_confirm',
        language: 'en_US',
      }),
    };
    const result = adapter.transformOutput('Booking confirmed', undefined, richContent);
    expect(result.kind).toBe('whatsapp_template');
    if (result.kind !== 'whatsapp_template') return;
    expect(result.template.name).toBe('booking_confirm');
    expect(result.template.language.code).toBe('en_US');
    expect(result.text).toBe('Booking confirmed');
  });

  it('returns whatsapp_template with body parameters', () => {
    const richContent = {
      whatsapp: JSON.stringify({
        template_name: 'order_update',
        language: 'en',
        parameters: {
          body: [
            { type: 'text', text: 'John' },
            { type: 'text', text: '$29.99' },
          ],
        },
      }),
    };
    const result = adapter.transformOutput('Order update', undefined, richContent);
    expect(result.kind).toBe('whatsapp_template');
    if (result.kind !== 'whatsapp_template') return;
    expect(result.template.components).toHaveLength(1);
    expect(result.template.components![0].type).toBe('body');
    expect(result.template.components![0].parameters).toHaveLength(2);
    expect(result.template.components![0].parameters![0].text).toBe('John');
  });

  it('returns whatsapp_template with header, body, and button components', () => {
    const richContent = {
      whatsapp: JSON.stringify({
        template_name: 'promo_sale',
        language: 'en_US',
        parameters: {
          header: [{ type: 'image', image: { link: 'https://example.com/img.jpg' } }],
          body: [{ type: 'text', text: 'Lucy' }],
          buttons: [
            {
              type: 'quick_reply',
              index: 0,
              parameters: [{ type: 'payload', payload: 'shop_now' }],
            },
          ],
        },
      }),
    };
    const result = adapter.transformOutput('Sale!', undefined, richContent);
    expect(result.kind).toBe('whatsapp_template');
    if (result.kind !== 'whatsapp_template') return;
    expect(result.template.components).toHaveLength(3);
    expect(result.template.components![0].type).toBe('header');
    expect(result.template.components![1].type).toBe('body');
    expect(result.template.components![2].type).toBe('button');
    expect(result.template.components![2].sub_type).toBe('quick_reply');
    expect(result.template.components![2].index).toBe(0);
  });

  it('falls back to text when richContent.whatsapp is not valid JSON', () => {
    const richContent = { whatsapp: 'not valid json{{{' };
    const result = adapter.transformOutput('Hello', undefined, richContent);
    expect(result.kind).toBe('text');
  });

  it('falls back to text when richContent.whatsapp lacks template_name', () => {
    const richContent = { whatsapp: JSON.stringify({ language: 'en_US' }) };
    const result = adapter.transformOutput('Hello', undefined, richContent);
    expect(result.kind).toBe('text');
  });

  it('uses existing interactive logic when richContent has no whatsapp field', () => {
    const richContent = { markdown: '**Hello**' };
    const actions: ActionSetIR = {
      elements: [
        { id: 'yes', type: 'button', label: 'Yes' },
        { id: 'no', type: 'button', label: 'No' },
      ],
    };
    const result = adapter.transformOutput('Confirm?', actions, richContent);
    expect(result.kind).toBe('whatsapp_interactive');
  });

  it('template takes priority over actions', () => {
    const richContent = {
      whatsapp: JSON.stringify({ template_name: 'my_template', language: 'en' }),
    };
    const actions: ActionSetIR = {
      elements: [{ id: 'btn1', type: 'button', label: 'Click' }],
    };
    const result = adapter.transformOutput('Hello', actions, richContent);
    expect(result.kind).toBe('whatsapp_template');
  });

  it('defaults language to en_US when not specified', () => {
    const richContent = {
      whatsapp: JSON.stringify({ template_name: 'greeting' }),
    };
    const result = adapter.transformOutput('Hi', undefined, richContent);
    expect(result.kind).toBe('whatsapp_template');
    if (result.kind !== 'whatsapp_template') return;
    expect(result.template.language.code).toBe('en_US');
  });

  it('handles single parameter object (not array) for body', () => {
    const richContent = {
      whatsapp: JSON.stringify({
        template_name: 'simple',
        parameters: { body: { type: 'text', text: 'value' } },
      }),
    };
    const result = adapter.transformOutput('Test', undefined, richContent);
    expect(result.kind).toBe('whatsapp_template');
    if (result.kind !== 'whatsapp_template') return;
    expect(result.template.components![0].parameters).toHaveLength(1);
    expect(result.template.components![0].parameters![0].text).toBe('value');
  });
});

// ---------------------------------------------------------------------------
// buildNormalizedMessage (existing tests preserved + new)
// ---------------------------------------------------------------------------

describe('WhatsAppAdapter.buildNormalizedMessage', () => {
  const adapter = new WhatsAppAdapter();

  it('normalizes text message', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry1',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+1234', phone_number_id: 'phone123' },
                contacts: [{ profile: { name: 'John' }, wa_id: '5551234' }],
                messages: [
                  {
                    id: 'msg1',
                    from: '5551234',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'Hello agent' },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Hello agent');
    expect(msg.externalSessionKey).toBe('whatsapp:phone123:5551234');
    expect(msg.metadata?.whatsappContactName).toBe('John');
    expect(msg.actionEvent).toBeUndefined();
  });

  it('normalizes button_reply as ActionEvent', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry1',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+1234', phone_number_id: 'phone123' },
                messages: [
                  {
                    id: 'msg2',
                    from: '5551234',
                    timestamp: '1700000000',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: { id: 'yes', title: 'Yes' },
                    },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('');
    expect(msg.actionEvent).toBeDefined();
    expect(msg.actionEvent!.actionId).toBe('yes');
    expect(msg.actionEvent!.source).toBe('whatsapp');
  });

  it('rejects malformed button_reply action envelopes at ingress', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry1',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+1234', phone_number_id: 'phone123' },
                messages: [
                  {
                    id: 'msg2',
                    from: '5551234',
                    timestamp: '1700000000',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: { id: 'x'.repeat(300), title: 'Yes' },
                    },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    expect(() => adapter.buildNormalizedMessage(body)).toThrow(/Invalid actionId in action_submit/);
  });

  it('normalizes list_reply as ActionEvent', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry1',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+1234', phone_number_id: 'phone123' },
                messages: [
                  {
                    id: 'msg3',
                    from: '5551234',
                    timestamp: '1700000000',
                    type: 'interactive',
                    interactive: {
                      type: 'list_reply',
                      list_reply: { id: 'opt2', title: 'Option 2' },
                    },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.actionEvent).toBeDefined();
    expect(msg.actionEvent!.actionId).toBe('opt2');
  });

  it('throws on malformed payload (no messages)', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry1',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+1234', phone_number_id: 'phone123' },
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
    expect(() => adapter.buildNormalizedMessage(body)).toThrow('missing message data');
  });

  it('normalizes template button callback as ActionEvent', () => {
    const body = makeWebhookPayload({
      type: 'button',
      button: { text: 'Confirm', payload: 'confirm_booking' },
    });

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('');
    expect(msg.actionEvent).toBeDefined();
    expect(msg.actionEvent!.actionId).toBe('confirm_booking');
    expect(msg.actionEvent!.value).toBe('confirm_booking');
    expect(msg.actionEvent!.source).toBe('whatsapp');
    expect(msg.metadata?.whatsappInteractionType).toBe('template_quick_reply');
  });

  it('normalizes reaction message with emoji', () => {
    const body = makeWebhookPayload({
      type: 'reaction',
      reaction: { message_id: 'wamid.orig123', emoji: '👍' },
    });
    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('👍');
    expect(msg.metadata?.isReaction).toBe(true);
    expect(msg.metadata?.reactionMessageId).toBe('wamid.orig123');
  });

  it('normalizes reaction removal (empty emoji)', () => {
    const body = makeWebhookPayload({
      type: 'reaction',
      reaction: { message_id: 'wamid.orig123', emoji: '' },
    });
    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('');
    expect(msg.metadata?.isReaction).toBe(true);
    expect(msg.metadata?.reactionRemoved).toBe(true);
  });

  it('normalizes single contact card', () => {
    const body = makeWebhookPayload({
      type: 'contacts',
      contacts: [
        {
          name: { formatted_name: 'John Doe', first_name: 'John', last_name: 'Doe' },
          phones: [{ phone: '+1555987654', type: 'CELL' }],
          emails: [{ email: 'john@example.com', type: 'WORK' }],
        },
      ],
    });
    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Shared contact: John Doe (+1555987654, john@example.com)');
    expect(msg.metadata?.contacts).toHaveLength(1);
  });

  it('normalizes multiple contact cards', () => {
    const body = makeWebhookPayload({
      type: 'contacts',
      contacts: [
        { name: { formatted_name: 'Alice' }, phones: [{ phone: '+111' }] },
        { name: { formatted_name: 'Bob' }, phones: [{ phone: '+222' }] },
      ],
    });
    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Shared contact: Alice (+111)\nShared contact: Bob (+222)');
  });

  it('normalizes contact with name only (no phone, no email)', () => {
    const body = makeWebhookPayload({
      type: 'contacts',
      contacts: [{ name: { formatted_name: 'Jane' } }],
    });
    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Shared contact: Jane');
  });

  it('normalizes location with name', () => {
    const body = makeWebhookPayload({
      type: 'location',
      location: {
        latitude: 37.7749,
        longitude: -122.4194,
        name: 'San Francisco',
        address: 'San Francisco, CA, USA',
      },
    });
    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Location: San Francisco (37.7749, -122.4194)');
    expect(msg.metadata?.location).toEqual({
      latitude: 37.7749,
      longitude: -122.4194,
      name: 'San Francisco',
      address: 'San Francisco, CA, USA',
    });
  });

  it('normalizes location without name', () => {
    const body = makeWebhookPayload({
      type: 'location',
      location: { latitude: 37.7749, longitude: -122.4194 },
    });
    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Location: 37.7749, -122.4194');
  });

  it('converts WhatsApp timestamp (seconds) to Date correctly', () => {
    const body = makeWebhookPayload(
      { type: 'text', text: { body: 'Hi' } },
      { timestamp: '1700000000' },
    );
    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.timestamp).toEqual(new Date(1700000000 * 1000));
  });
});
