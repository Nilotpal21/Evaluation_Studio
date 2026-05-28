/**
 * Messenger Adapter Tests
 *
 * Tests transformOutput() for Messenger button templates and quick replies,
 * buildNormalizedMessage() for inbound events, shouldProcess() for event
 * filtering, verifyRequest() for HMAC signature verification,
 * handleWebhookVerification() for Meta GET verification, and extraction helpers.
 */

import crypto from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { MessengerAdapter } from '../../../channels/adapters/messenger-adapter.js';
import type { ActionSetIR, RichContentIR } from '@abl/compiler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWebhookPayload(event: Record<string, unknown>) {
  return {
    object: 'page',
    entry: [
      {
        id: 'page123',
        time: Date.now(),
        messaging: [
          {
            sender: { id: 'user456' },
            recipient: { id: 'page123' },
            timestamp: Date.now(),
            ...event,
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

describe('MessengerAdapter.shouldProcess', () => {
  const adapter = new MessengerAdapter();

  it('returns true for text messages', () => {
    const body = makeWebhookPayload({ message: { mid: 'mid.1', text: 'Hello' } });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns true for postback events', () => {
    const body = makeWebhookPayload({ postback: { title: 'Buy', payload: 'buy' } });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns false for echo messages', () => {
    const body = makeWebhookPayload({
      message: { mid: 'mid.echo', text: 'Bot reply', is_echo: true },
    });
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns false for stale events', () => {
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    const body = {
      object: 'page',
      entry: [
        {
          id: 'page123',
          time: tenMinutesAgo,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'page123' },
              timestamp: tenMinutesAgo,
              message: { mid: 'mid.old', text: 'Old message' },
            },
          ],
        },
      ],
    };
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns false for empty messaging array', () => {
    const body = { object: 'page', entry: [{ id: 'p', time: 1, messaging: [] }] };
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns false for delivery notification (no text, no postback)', () => {
    const body = makeWebhookPayload({
      delivery: { mids: ['mid.1'], watermark: 1234 },
    });
    // delivery events have no message.text or postback
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns true for attachment-only messages (no text)', () => {
    const body = makeWebhookPayload({
      message: {
        mid: 'mid.att1',
        attachments: [
          { type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/photo.jpg' } },
        ],
      },
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns true for messages with both text and attachments', () => {
    const body = makeWebhookPayload({
      message: {
        mid: 'mid.att2',
        text: 'Check this out',
        attachments: [
          { type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/photo.jpg' } },
        ],
      },
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyRequest
// ---------------------------------------------------------------------------

describe('MessengerAdapter.verifyRequest', () => {
  const adapter = new MessengerAdapter();
  const APP_SECRET = 'test_app_secret_123';

  afterEach(() => {
    delete process.env.MESSENGER_APP_SECRET;
  });

  it('returns true for valid HMAC signature', async () => {
    const bodyStr = '{"object":"page"}';
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
    const bodyStr = '{"object":"page"}';

    const result = await adapter.verifyRequest(
      { 'x-hub-signature-256': 'sha256=invalid' },
      JSON.parse(bodyStr),
      Buffer.from(bodyStr),
      { credentials: { app_secret: APP_SECRET } } as any,
    );
    expect(result).toBe(false);
  });

  it('returns false when signature header is missing', async () => {
    const result = await adapter.verifyRequest({}, { object: 'page' }, Buffer.from('{}'), {
      credentials: { app_secret: APP_SECRET },
    } as any);
    expect(result).toBe(false);
  });

  it('falls back to env var when no connection credentials', async () => {
    process.env.MESSENGER_APP_SECRET = APP_SECRET;
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

describe('MessengerAdapter.handleWebhookVerification', () => {
  const adapter = new MessengerAdapter();

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

describe('MessengerAdapter.extractEventId', () => {
  const adapter = new MessengerAdapter();

  it('extracts message mid', () => {
    const body = makeWebhookPayload({ message: { mid: 'mid.abc', text: 'Hi' } });
    expect(adapter.extractEventId(body)).toBe('mid.abc');
  });

  it('generates synthetic ID for postback', () => {
    const body = makeWebhookPayload({ postback: { title: 'Go', payload: 'go' } });
    const eventId = adapter.extractEventId(body);
    expect(eventId).toMatch(/^postback:user456:go:\d+$/);
  });

  it('returns null when no message or postback', () => {
    const body = makeWebhookPayload({ delivery: { mids: ['mid.1'], watermark: 1234 } });
    expect(adapter.extractEventId(body)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractExternalIdentifier
// ---------------------------------------------------------------------------

describe('MessengerAdapter.extractExternalIdentifier', () => {
  const adapter = new MessengerAdapter();

  it('extracts page ID from entry[0].id', () => {
    const body = makeWebhookPayload({ message: { mid: 'mid.1', text: 'Hi' } });
    expect(adapter.extractExternalIdentifier(body)).toBe('page123');
  });

  it('falls back to messaging[0].recipient.id when entry.id is missing', () => {
    const body = {
      object: 'page',
      entry: [
        {
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'u1' },
              recipient: { id: 'pg456' },
              timestamp: Date.now(),
              message: { mid: 'mid.1', text: 'hi' },
            },
          ],
        },
      ],
    };
    expect(adapter.extractExternalIdentifier(body)).toBe('pg456');
  });

  it('returns null for empty entry', () => {
    const body = { object: 'page', entry: [] };
    expect(adapter.extractExternalIdentifier(body)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// transformOutput (existing tests preserved)
// ---------------------------------------------------------------------------

describe('MessengerAdapter.transformOutput', () => {
  const adapter = new MessengerAdapter();

  it('returns text-only when no actions', () => {
    const result = adapter.transformOutput('Hello');
    expect(result).toEqual({ kind: 'text', text: 'Hello' });
  });

  it('transforms ≤3 buttons into button template', () => {
    const actions: ActionSetIR = {
      elements: [
        { id: 'buy', type: 'button', label: 'Buy Now' },
        { id: 'later', type: 'button', label: 'Later' },
      ],
    };

    const result = adapter.transformOutput('Ready to purchase?', actions);
    expect(result.kind).toBe('messenger_template');
    if (result.kind !== 'messenger_template') return;

    const msg = result.message as any;
    expect(msg.attachment.type).toBe('template');
    expect(msg.attachment.payload.template_type).toBe('button');
    expect(msg.attachment.payload.text).toBe('Ready to purchase?');
    expect(msg.attachment.payload.buttons).toHaveLength(2);
    expect(msg.attachment.payload.buttons[0].type).toBe('postback');
    expect(msg.attachment.payload.buttons[0].title).toBe('Buy Now');
    expect(msg.attachment.payload.buttons[0].payload).toBe('buy');
  });

  it('falls back to quick replies when >3 buttons', () => {
    const actions: ActionSetIR = {
      elements: Array.from({ length: 5 }, (_, i) => ({
        id: `opt${i}`,
        type: 'button' as const,
        label: `Option ${i}`,
      })),
    };

    const result = adapter.transformOutput('Choose:', actions);
    expect(result.kind).toBe('messenger_template');
    if (result.kind !== 'messenger_template') return;

    const msg = result.message as any;
    expect(msg.quick_replies).toHaveLength(5);
    expect(msg.quick_replies[0].content_type).toBe('text');
    expect(msg.quick_replies[0].payload).toBe('opt0');
  });

  it('transforms select options into quick replies', () => {
    const actions: ActionSetIR = {
      elements: [
        {
          id: 'color',
          type: 'select',
          label: 'Color',
          options: [
            { id: 'red', label: 'Red' },
            { id: 'blue', label: 'Blue' },
          ],
        },
      ],
    };

    const result = adapter.transformOutput('Pick color:', actions);
    expect(result.kind).toBe('messenger_template');
    if (result.kind !== 'messenger_template') return;

    const msg = result.message as any;
    expect(msg.quick_replies).toHaveLength(2);
    expect(msg.quick_replies[0].title).toBe('Red');
    expect(msg.quick_replies[0].payload).toBe('red');
  });

  it('limits quick replies to 13', () => {
    const actions: ActionSetIR = {
      elements: Array.from({ length: 20 }, (_, i) => ({
        id: `opt${i}`,
        type: 'button' as const,
        label: `Opt ${i}`,
      })),
    };

    const result = adapter.transformOutput('', actions);
    expect(result.kind).toBe('messenger_template');
    if (result.kind !== 'messenger_template') return;

    const msg = result.message as any;
    expect(msg.quick_replies).toHaveLength(13);
  });

  it('truncates button titles to 20 chars', () => {
    const actions: ActionSetIR = {
      elements: [
        {
          id: 'btn',
          type: 'button',
          label: 'This is a very long button title',
        },
      ],
    };

    const result = adapter.transformOutput('', actions);
    expect(result.kind).toBe('messenger_template');
    if (result.kind !== 'messenger_template') return;

    const msg = result.message as any;
    expect(msg.attachment.payload.buttons[0].title).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// buildNormalizedMessage (existing tests preserved)
// ---------------------------------------------------------------------------

describe('MessengerAdapter.buildNormalizedMessage', () => {
  const adapter = new MessengerAdapter();

  it('normalizes text message', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'page123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'page123' },
              timestamp: 1700000000000,
              message: { mid: 'mid.123', text: 'Hello bot' },
            },
          ],
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Hello bot');
    expect(msg.externalSessionKey).toBe('messenger:page123:user456');
    expect(msg.actionEvent).toBeUndefined();
  });

  it('normalizes postback as ActionEvent', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'page123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'page123' },
              timestamp: 1700000000000,
              postback: { title: 'Buy', payload: 'buy_action' },
            },
          ],
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('');
    expect(msg.externalMessageId).toBe('postback:user456:1700000000000');
    expect(msg.actionEvent).toBeDefined();
    expect(msg.actionEvent!.actionId).toBe('buy_action');
    expect(msg.actionEvent!.value).toBe('buy_action');
    expect(msg.actionEvent!.source).toBe('messenger');
  });

  it('rejects malformed postback action envelopes at ingress', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'page123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'page123' },
              timestamp: 1700000000000,
              postback: { title: 'Buy', payload: 'x'.repeat(300) },
            },
          ],
        },
      ],
    };

    expect(() => adapter.buildNormalizedMessage(body)).toThrow(/Invalid actionId in action_submit/);
  });

  it('normalizes quick_reply as ActionEvent', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'page123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'page123' },
              timestamp: 1700000000000,
              message: { mid: 'mid.789', text: 'Red', quick_reply: { payload: 'color_red' } },
            },
          ],
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.actionEvent).toBeDefined();
    expect(msg.actionEvent!.actionId).toBe('color_red');
    expect(msg.actionEvent!.source).toBe('messenger');
  });

  it('throws on malformed payload (empty messaging)', () => {
    const body = { object: 'page', entry: [{ id: 'page123', time: Date.now(), messaging: [] }] };
    expect(() => adapter.buildNormalizedMessage(body)).toThrow('missing messaging event');
  });

  it('extracts messengerMediaReferences from image attachment', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'page123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'page123' },
              timestamp: 1700000000000,
              message: {
                mid: 'mid.img1',
                attachments: [
                  {
                    type: 'image',
                    payload: { url: 'https://scontent.xx.fbcdn.net/photo.jpg?oh=abc' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('');
    expect(msg.metadata).toHaveProperty('messengerMediaReferences');
    const refs = msg.metadata!.messengerMediaReferences as Array<{
      type: string;
      url: string;
    }>;
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe('image');
    expect(refs[0].url).toBe('https://scontent.xx.fbcdn.net/photo.jpg?oh=abc');
  });

  it('extracts multiple attachment types', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'page123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'page123' },
              timestamp: 1700000000000,
              message: {
                mid: 'mid.multi',
                text: 'Here are files',
                attachments: [
                  {
                    type: 'image',
                    payload: { url: 'https://scontent.xx.fbcdn.net/photo.jpg' },
                  },
                  {
                    type: 'video',
                    payload: { url: 'https://video.xx.fbcdn.net/video.mp4' },
                  },
                  {
                    type: 'file',
                    payload: { url: 'https://cdn.fbsbx.com/doc.pdf' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Here are files');
    const refs = msg.metadata!.messengerMediaReferences as Array<{
      type: string;
      url: string;
    }>;
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.type)).toEqual(['image', 'video', 'file']);
  });

  it('skips sticker, location, and fallback attachments', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'page123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'page123' },
              timestamp: 1700000000000,
              message: {
                mid: 'mid.mixed',
                attachments: [
                  {
                    type: 'sticker',
                    payload: {
                      url: 'https://scontent.xx.fbcdn.net/sticker.png',
                      sticker_id: 298592933654239,
                    },
                  },
                  {
                    type: 'location',
                    payload: { coordinates: { lat: 17.43, long: 78.39 } },
                  },
                  { type: 'fallback', payload: null },
                  {
                    type: 'image',
                    payload: { url: 'https://scontent.xx.fbcdn.net/real-photo.jpg' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    const refs = msg.metadata!.messengerMediaReferences as Array<{
      type: string;
      url: string;
    }>;
    // Only the image should be included
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe('image');
  });

  it('does not include messengerMediaReferences when no processable attachments', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'page123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'page123' },
              timestamp: 1700000000000,
              message: {
                mid: 'mid.sticker',
                attachments: [
                  {
                    type: 'sticker',
                    payload: { url: 'https://scontent.xx.fbcdn.net/sticker.png', sticker_id: 123 },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.metadata).not.toHaveProperty('messengerMediaReferences');
  });

  it('skips attachments with missing payload URL', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'page123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'page123' },
              timestamp: 1700000000000,
              message: {
                mid: 'mid.nopayload',
                attachments: [{ type: 'image', payload: {} }, { type: 'file' }],
              },
            },
          ],
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.metadata).not.toHaveProperty('messengerMediaReferences');
  });
});

// ---------------------------------------------------------------------------
// transformOutput — carousel
// ---------------------------------------------------------------------------

describe('MessengerAdapter.transformOutput — carousel', () => {
  const adapter = new MessengerAdapter();

  it('transforms carousel to generic_template', () => {
    const richContent: RichContentIR = {
      carousel: {
        cards: [
          {
            title: 'Product A',
            subtitle: 'Best seller - $9.99',
            image_url: 'https://example.com/a.jpg',
            buttons: [
              { id: 'buy_a', type: 'button', label: 'Buy Now' },
              { id: 'details_a', type: 'button', label: 'Details', value: 'https://example.com/a' },
            ],
          },
          {
            title: 'Product B',
            subtitle: '$14.99',
            buttons: [{ id: 'buy_b', type: 'button', label: 'Buy' }],
          },
        ],
      },
    };

    const output = adapter.transformOutput('Our products', undefined, richContent);
    expect(output.kind).toBe('messenger_template');
    if (output.kind !== 'messenger_template') throw new Error('wrong kind');

    const payload = output.message as any;
    expect(payload.attachment.type).toBe('template');
    expect(payload.attachment.payload.template_type).toBe('generic');
    expect(payload.attachment.payload.elements).toHaveLength(2);

    const el0 = payload.attachment.payload.elements[0];
    expect(el0.title).toBe('Product A');
    expect(el0.subtitle).toBe('Best seller - $9.99');
    expect(el0.image_url).toBe('https://example.com/a.jpg');
    expect(el0.buttons).toHaveLength(2);
    expect(el0.buttons[0]).toEqual({ type: 'postback', title: 'Buy Now', payload: 'buy_a' });
    expect(el0.buttons[1]).toEqual({
      type: 'web_url',
      title: 'Details',
      url: 'https://example.com/a',
    });
  });

  it('truncates title to 80 chars', () => {
    const richContent: RichContentIR = {
      carousel: {
        cards: [{ title: 'A'.repeat(100) }],
      },
    };
    const output = adapter.transformOutput('Test', undefined, richContent);
    if (output.kind !== 'messenger_template') throw new Error('wrong kind');
    const el = (output.message as any).attachment.payload.elements[0];
    expect(el.title).toHaveLength(80);
  });

  it('limits to 10 cards', () => {
    const richContent: RichContentIR = {
      carousel: {
        cards: Array.from({ length: 15 }, (_, i) => ({ title: `Card ${i}` })),
      },
    };
    const output = adapter.transformOutput('Test', undefined, richContent);
    if (output.kind !== 'messenger_template') throw new Error('wrong kind');
    const elements = (output.message as any).attachment.payload.elements;
    expect(elements).toHaveLength(10);
  });

  it('limits to 3 buttons per card', () => {
    const richContent: RichContentIR = {
      carousel: {
        cards: [
          {
            title: 'Card',
            buttons: Array.from({ length: 5 }, (_, i) => ({
              id: `btn_${i}`,
              type: 'button' as const,
              label: `Button ${i}`,
            })),
          },
        ],
      },
    };
    const output = adapter.transformOutput('Test', undefined, richContent);
    if (output.kind !== 'messenger_template') throw new Error('wrong kind');
    const el = (output.message as any).attachment.payload.elements[0];
    expect(el.buttons).toHaveLength(3);
  });

  it('includes default_action when default_action_url is set', () => {
    const richContent: RichContentIR = {
      carousel: {
        cards: [
          {
            title: 'Clickable Card',
            default_action_url: 'https://example.com/card',
          },
        ],
      },
    };
    const output = adapter.transformOutput('Test', undefined, richContent);
    if (output.kind !== 'messenger_template') throw new Error('wrong kind');
    const el = (output.message as any).attachment.payload.elements[0];
    expect(el.default_action).toEqual({ type: 'web_url', url: 'https://example.com/card' });
  });

  it('falls back to actions when carousel is empty', () => {
    const richContent: RichContentIR = {
      carousel: { cards: [] },
    };
    const actions: ActionSetIR = {
      elements: [{ id: 'btn1', type: 'button', label: 'Click' }],
    };
    const output = adapter.transformOutput('Fallback', actions, richContent);
    expect(output.kind).toBe('messenger_template');
    if (output.kind !== 'messenger_template') throw new Error('wrong kind');
    const msg = output.message as any;
    // Should use button template, not generic_template
    expect(msg.attachment.payload.template_type).toBe('button');
  });
});
