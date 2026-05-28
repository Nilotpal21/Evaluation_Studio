/**
 * Instagram Adapter Tests
 *
 * Tests transformOutput() for Instagram quick replies and generic templates,
 * buildNormalizedMessage() for inbound events, shouldProcess() for event
 * filtering, verifyRequest() for HMAC signature verification,
 * handleWebhookVerification() for Meta GET verification, and extraction helpers.
 */

import crypto from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { InstagramAdapter } from '../../../channels/adapters/instagram-adapter.js';
import type { ActionSetIR, RichContentIR } from '@abl/compiler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWebhookPayload(event: Record<string, unknown>) {
  return {
    object: 'instagram',
    entry: [
      {
        id: 'ig_account_123',
        time: Date.now(),
        messaging: [
          {
            sender: { id: 'user456' },
            recipient: { id: 'ig_account_123' },
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

describe('InstagramAdapter.shouldProcess', () => {
  const adapter = new InstagramAdapter();

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

  it('accepts old events (no stale cutoff — dedup handles replays)', () => {
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    const body = {
      object: 'instagram',
      entry: [
        {
          id: 'ig_account_123',
          time: tenMinutesAgo,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'ig_account_123' },
              timestamp: tenMinutesAgo,
              message: { mid: 'mid.old', text: 'Old message' },
            },
          ],
        },
      ],
    };
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns false for non-processable attachment-only events (share, like_heart, reel)', () => {
    const body = makeWebhookPayload({
      message: {
        mid: 'mid.share',
        attachments: [{ type: 'share', payload: { url: 'https://instagram.com/p/123' } }],
      },
    });
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns false for like_heart-only events', () => {
    const body = makeWebhookPayload({
      message: {
        mid: 'mid.heart',
        attachments: [{ type: 'like_heart' }],
      },
    });
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns false for empty messaging array', () => {
    const body = { object: 'instagram', entry: [{ id: 'ig', time: 1, messaging: [] }] };
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns false for read receipts (no text, no postback)', () => {
    const body = makeWebhookPayload({
      read: { watermark: 1234 },
    });
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns true for attachment-only messages', () => {
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
});

// ---------------------------------------------------------------------------
// verifyRequest
// ---------------------------------------------------------------------------

describe('InstagramAdapter.verifyRequest', () => {
  const adapter = new InstagramAdapter();
  const APP_SECRET = 'test_app_secret_123';

  afterEach(() => {
    delete process.env.INSTAGRAM_APP_SECRET;
  });

  it('returns true for valid HMAC-SHA256 signature', async () => {
    const bodyStr = '{"object":"instagram"}';
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
    const bodyStr = '{"object":"instagram"}';

    const result = await adapter.verifyRequest(
      { 'x-hub-signature-256': 'sha256=invalid' },
      JSON.parse(bodyStr),
      Buffer.from(bodyStr),
      { credentials: { app_secret: APP_SECRET } } as any,
    );
    expect(result).toBe(false);
  });

  it('returns false when signature header is missing', async () => {
    const result = await adapter.verifyRequest({}, { object: 'instagram' }, Buffer.from('{}'), {
      credentials: { app_secret: APP_SECRET },
    } as any);
    expect(result).toBe(false);
  });

  it('falls back to process.env.INSTAGRAM_APP_SECRET when no connection credentials', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET;
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

describe('InstagramAdapter.handleWebhookVerification', () => {
  const adapter = new InstagramAdapter();

  it('returns challenge when token matches (hub.mode=subscribe)', () => {
    const result = adapter.handleWebhookVerification(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'my_token', 'hub.challenge': 'abc123' },
      { credentials: { verify_token: 'my_token' } },
    );
    expect(result).toBe('abc123');
  });

  it('returns null when no connection', () => {
    const result = adapter.handleWebhookVerification(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'some_token', 'hub.challenge': 'abc' },
      null,
    );
    expect(result).toBeNull();
  });

  it('returns null when token mismatch', () => {
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
});

// ---------------------------------------------------------------------------
// extractExternalIdentifier
// ---------------------------------------------------------------------------

describe('InstagramAdapter.extractExternalIdentifier', () => {
  const adapter = new InstagramAdapter();

  it('extracts IG account ID from entry[0].id', () => {
    const body = makeWebhookPayload({ message: { mid: 'mid.1', text: 'Hi' } });
    expect(adapter.extractExternalIdentifier(body)).toBe('ig_account_123');
  });

  it('falls back to messaging[0].recipient.id', () => {
    const body = {
      object: 'instagram',
      entry: [
        {
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'u1' },
              recipient: { id: 'ig456' },
              timestamp: Date.now(),
              message: { mid: 'mid.1', text: 'hi' },
            },
          ],
        },
      ],
    };
    expect(adapter.extractExternalIdentifier(body)).toBe('ig456');
  });

  it('returns null for empty entry', () => {
    const body = { object: 'instagram', entry: [] };
    expect(adapter.extractExternalIdentifier(body)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractEventId
// ---------------------------------------------------------------------------

describe('InstagramAdapter.extractEventId', () => {
  const adapter = new InstagramAdapter();

  it('extracts message mid', () => {
    const body = makeWebhookPayload({ message: { mid: 'mid.abc', text: 'Hi' } });
    expect(adapter.extractEventId(body)).toBe('mid.abc');
  });

  it('generates synthetic ID for postback (postback:senderId:payload:timestamp)', () => {
    const body = makeWebhookPayload({ postback: { title: 'Go', payload: 'go' } });
    const eventId = adapter.extractEventId(body);
    expect(eventId).toMatch(/^postback:user456:go:\d+$/);
  });

  it('returns null when no message or postback', () => {
    const body = makeWebhookPayload({ read: { watermark: 1234 } });
    expect(adapter.extractEventId(body)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildNormalizedMessage
// ---------------------------------------------------------------------------

describe('InstagramAdapter.buildNormalizedMessage', () => {
  const adapter = new InstagramAdapter();

  it('normalizes text message (externalSessionKey: instagram:{igAccountId}:{senderId})', () => {
    const body = {
      object: 'instagram',
      entry: [
        {
          id: 'ig_account_123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'ig_account_123' },
              timestamp: 1700000000000,
              message: { mid: 'mid.123', text: 'Hello bot' },
            },
          ],
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Hello bot');
    expect(msg.externalSessionKey).toBe('instagram:ig_account_123:user456');
    expect(msg.actionEvent).toBeUndefined();
    expect(msg.metadata).toHaveProperty('instagramAccountId', 'ig_account_123');
    expect(msg.metadata).toHaveProperty('instagramSenderId', 'user456');
  });

  it('normalizes postback as ActionEvent (source: instagram)', () => {
    const body = {
      object: 'instagram',
      entry: [
        {
          id: 'ig_account_123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'ig_account_123' },
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
    expect(msg.actionEvent!.source).toBe('instagram');
  });

  it('rejects malformed postback action envelopes at ingress', () => {
    const body = {
      object: 'instagram',
      entry: [
        {
          id: 'ig_account_123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'ig_account_123' },
              timestamp: 1700000000000,
              postback: { title: 'Buy', payload: 'x'.repeat(300) },
            },
          ],
        },
      ],
    };

    expect(() => adapter.buildNormalizedMessage(body)).toThrow(/Invalid actionId in action_submit/);
  });

  it('normalizes quick_reply as ActionEvent (source: instagram)', () => {
    const body = {
      object: 'instagram',
      entry: [
        {
          id: 'ig_account_123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'ig_account_123' },
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
    expect(msg.actionEvent!.source).toBe('instagram');
  });

  it('throws on malformed payload', () => {
    const body = {
      object: 'instagram',
      entry: [{ id: 'ig_account_123', time: Date.now(), messaging: [] }],
    };
    expect(() => adapter.buildNormalizedMessage(body)).toThrow('missing messaging event');
  });

  it('extracts instagramMediaReferences from image attachment', () => {
    const body = {
      object: 'instagram',
      entry: [
        {
          id: 'ig_account_123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'ig_account_123' },
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
    expect(msg.metadata).toHaveProperty('instagramMediaReferences');
    const refs = msg.metadata!.instagramMediaReferences as Array<{
      type: string;
      url: string;
    }>;
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe('image');
    expect(refs[0].url).toBe('https://scontent.xx.fbcdn.net/photo.jpg?oh=abc');
  });

  it('skips sticker/share/like_heart/reel attachments', () => {
    const body = {
      object: 'instagram',
      entry: [
        {
          id: 'ig_account_123',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user456' },
              recipient: { id: 'ig_account_123' },
              timestamp: 1700000000000,
              message: {
                mid: 'mid.mixed',
                attachments: [
                  {
                    type: 'share',
                    payload: { url: 'https://instagram.com/p/abc' },
                  },
                  {
                    type: 'story_mention',
                    payload: { url: 'https://instagram.com/stories/abc' },
                  },
                  {
                    type: 'like_heart',
                    payload: {},
                  },
                  {
                    type: 'reel',
                    payload: { url: 'https://instagram.com/reel/abc' },
                  },
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
    const refs = msg.metadata!.instagramMediaReferences as Array<{
      type: string;
      url: string;
    }>;
    // Only the image should be included
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe('image');
  });
});

// ---------------------------------------------------------------------------
// transformOutput
// ---------------------------------------------------------------------------

describe('InstagramAdapter.transformOutput', () => {
  const adapter = new InstagramAdapter();

  it('returns text-only when no actions', () => {
    const result = adapter.transformOutput('Hello');
    expect(result).toEqual({ kind: 'text', text: 'Hello' });
  });

  it('transforms buttons into quick replies (instagram_template kind)', () => {
    const actions: ActionSetIR = {
      elements: [
        { id: 'buy', type: 'button', label: 'Buy Now' },
        { id: 'later', type: 'button', label: 'Later' },
      ],
    };

    const result = adapter.transformOutput('Ready to purchase?', actions);
    expect(result.kind).toBe('instagram_template');
    if (result.kind !== 'instagram_template') return;

    const msg = result.message as any;
    expect(msg.text).toBe('Ready to purchase?');
    expect(msg.quick_replies).toHaveLength(2);
    expect(msg.quick_replies[0].content_type).toBe('text');
    expect(msg.quick_replies[0].title).toBe('Buy Now');
    expect(msg.quick_replies[0].payload).toBe('buy');
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
    expect(result.kind).toBe('instagram_template');
    if (result.kind !== 'instagram_template') return;

    const msg = result.message as any;
    expect(msg.quick_replies).toHaveLength(13);
  });

  it('truncates titles to 20 chars', () => {
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
    expect(result.kind).toBe('instagram_template');
    if (result.kind !== 'instagram_template') return;

    const msg = result.message as any;
    expect(msg.quick_replies[0].title).toHaveLength(20);
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
    expect(result.kind).toBe('instagram_template');
    if (result.kind !== 'instagram_template') return;

    const msg = result.message as any;
    expect(msg.quick_replies).toHaveLength(2);
    expect(msg.quick_replies[0].title).toBe('Red');
    expect(msg.quick_replies[0].payload).toBe('red');
  });

  it('transforms RichContentIR cards into generic template (carousel)', () => {
    const actions: ActionSetIR = { elements: [] };
    const richContent: RichContentIR = {
      markdown: JSON.stringify({
        cards: [
          {
            title: 'Product A',
            subtitle: 'Best seller',
            image_url: 'https://example.com/a.jpg',
            buttons: [{ title: 'Buy', payload: 'buy_a' }],
          },
          {
            title: 'Product B',
            subtitle: 'New arrival',
            image_url: 'https://example.com/b.jpg',
            buttons: [{ title: 'Buy', payload: 'buy_b' }],
          },
        ],
      }),
    };

    const result = adapter.transformOutput('Check these out:', actions, richContent);
    expect(result.kind).toBe('instagram_template');
    if (result.kind !== 'instagram_template') return;

    const msg = result.message as any;
    expect(msg.attachment.type).toBe('template');
    expect(msg.attachment.payload.template_type).toBe('generic');
    expect(msg.attachment.payload.elements).toHaveLength(2);
    expect(msg.attachment.payload.elements[0].title).toBe('Product A');
    expect(msg.attachment.payload.elements[0].subtitle).toBe('Best seller');
    expect(msg.attachment.payload.elements[0].image_url).toBe('https://example.com/a.jpg');
    expect(msg.attachment.payload.elements[0].buttons[0].type).toBe('postback');
    expect(msg.attachment.payload.elements[0].buttons[0].title).toBe('Buy');
    expect(msg.attachment.payload.elements[0].buttons[0].payload).toBe('buy_a');
  });
});
