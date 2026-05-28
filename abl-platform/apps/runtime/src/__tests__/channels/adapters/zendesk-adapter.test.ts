/**
 * Zendesk Adapter Tests
 *
 * Tests for the Zendesk Sunshine Conversations (Smooch API v2) channel adapter.
 * Covers: shouldProcess(), extractExternalIdentifier(), extractEventId(),
 * buildNormalizedMessage(), verifyRequest(), transformOutput(), sendResponse().
 */

import crypto from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ZendeskAdapter } from '../../../channels/adapters/zendesk-adapter.js';
import type { ActionSetIR } from '@abl/compiler';

const DELIVERY_FAILED_CUSTOMER_MESSAGE =
  "I'm having trouble delivering that response. Please try again.";
const DELIVERY_CONFIGURATION_CUSTOMER_MESSAGE =
  'This channel is not fully configured for response delivery. Please contact support.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWebhookPayload(overrides?: {
  appId?: string;
  eventId?: string;
  eventType?: string;
  messageContent?: Record<string, unknown>;
  authorType?: string;
  conversationId?: string;
  postback?: { payload: string; text: string };
  userId?: string;
}) {
  const eventType = overrides?.eventType ?? 'conversation:message';
  const isPostback = eventType === 'conversation:postback';

  const payload: Record<string, unknown> = isPostback
    ? {
        postback: overrides?.postback ?? { payload: 'btn_yes', text: 'Yes' },
        conversation: { id: overrides?.conversationId ?? 'conv123', type: 'personal' },
        user: { id: overrides?.userId ?? 'user456' },
      }
    : {
        message: {
          id: 'msg001',
          received: '2024-01-01T00:00:00.000Z',
          author: {
            type: overrides?.authorType ?? 'user',
            userId: overrides?.userId ?? 'user456',
            displayName: 'John Doe',
          },
          content: overrides?.messageContent ?? { type: 'text', text: 'Hello from Zendesk' },
        },
        conversation: { id: overrides?.conversationId ?? 'conv123', type: 'personal' },
      };

  return {
    app: { id: overrides?.appId ?? 'app789' },
    webhook: { id: 'wh001', version: 'v2' },
    events: [
      {
        id: overrides?.eventId ?? 'evt001',
        type: eventType,
        createdAt: '2024-01-01T00:00:00.000Z',
        payload,
      },
    ],
  };
}

function signPayload(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ---------------------------------------------------------------------------
// shouldProcess
// ---------------------------------------------------------------------------

describe('ZendeskAdapter.shouldProcess', () => {
  const adapter = new ZendeskAdapter();

  it('returns true for user messages', () => {
    const body = makeWebhookPayload({ authorType: 'user' });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns true for postback events', () => {
    const body = makeWebhookPayload({ eventType: 'conversation:postback' });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns false for business (bot) messages', () => {
    const body = makeWebhookPayload({ authorType: 'business' });
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns false for empty events array', () => {
    const body = {
      app: { id: 'app789' },
      webhook: { id: 'wh001', version: 'v2' },
      events: [],
    };
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns false for unknown event types', () => {
    const body = makeWebhookPayload({ eventType: 'conversation:read' });
    expect(adapter.shouldProcess(body)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractExternalIdentifier
// ---------------------------------------------------------------------------

describe('ZendeskAdapter.extractExternalIdentifier', () => {
  const adapter = new ZendeskAdapter();

  it('extracts appId from payload', () => {
    const body = makeWebhookPayload({ appId: 'myapp123' });
    expect(adapter.extractExternalIdentifier(body)).toBe('myapp123');
  });

  it('returns null when app is missing', () => {
    const body = { webhook: { id: 'wh001' }, events: [] };
    expect(adapter.extractExternalIdentifier(body)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractEventId
// ---------------------------------------------------------------------------

describe('ZendeskAdapter.extractEventId', () => {
  const adapter = new ZendeskAdapter();

  it('extracts event ID from first event', () => {
    const body = makeWebhookPayload({ eventId: 'evt_abc' });
    expect(adapter.extractEventId(body)).toBe('evt_abc');
  });

  it('returns null when events array is empty', () => {
    const body = {
      app: { id: 'app789' },
      webhook: { id: 'wh001', version: 'v2' },
      events: [],
    };
    expect(adapter.extractEventId(body)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildNormalizedMessage
// ---------------------------------------------------------------------------

describe('ZendeskAdapter.buildNormalizedMessage', () => {
  const adapter = new ZendeskAdapter();

  it('normalizes text messages', () => {
    const body = makeWebhookPayload({
      appId: 'app1',
      conversationId: 'conv1',
      userId: 'usr1',
    });

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Hello from Zendesk');
    expect(msg.externalMessageId).toBe('msg001');
    expect(msg.externalSessionKey).toBe('zendesk:app1:conv1');
    expect(msg.metadata?.zendeskAppId).toBe('app1');
    expect(msg.metadata?.zendeskConversationId).toBe('conv1');
    expect(msg.metadata?.zendeskAuthorId).toBe('usr1');
    expect(msg.actionEvent).toBeUndefined();
  });

  it('filters HTML tags from text content', () => {
    const body = makeWebhookPayload({
      messageContent: {
        type: 'text',
        text: 'Hello <b>world</b>, visit <a href="https://example.com">here</a> or email <a href="mailto:test@example.com">test@example.com</a>',
      },
    });

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Hello world, visit here or email test@example.com');
  });

  it('converts <br> tags to newlines', () => {
    const body = makeWebhookPayload({
      messageContent: { type: 'text', text: 'Line 1<br>Line 2<br/>Line 3' },
    });

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Line 1\nLine 2\nLine 3');
  });

  it('decodes HTML entities', () => {
    const body = makeWebhookPayload({
      messageContent: {
        type: 'text',
        text: '5 &gt; 3 &amp; 2 &lt; 4 &quot;yes&quot; &#39;ok&#39;',
      },
    });

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('5 > 3 & 2 < 4 "yes" \'ok\'');
  });

  it('normalizes postback events as ActionEvent', () => {
    const body = makeWebhookPayload({
      eventType: 'conversation:postback',
      postback: { payload: 'action_confirm', text: 'Confirm' },
      appId: 'app2',
      conversationId: 'conv2',
      userId: 'usr2',
    });

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('');
    expect(msg.actionEvent).toBeDefined();
    expect(msg.actionEvent!.type).toBe('action_event');
    expect(msg.actionEvent!.actionId).toBe('action_confirm');
    expect(msg.actionEvent!.value).toBe('action_confirm');
    expect(msg.actionEvent!.source).toBe('zendesk');
    expect(msg.externalSessionKey).toBe('zendesk:app2:conv2');
  });

  it('rejects malformed postback action envelopes at ingress', () => {
    const body = makeWebhookPayload({
      eventType: 'conversation:postback',
      postback: { payload: 'x'.repeat(300), text: 'Invalid' },
    });

    expect(() => adapter.buildNormalizedMessage(body)).toThrow('Invalid actionId in action_submit');
  });

  it('extracts mailto address from anchor tags', () => {
    const body = makeWebhookPayload({
      messageContent: {
        type: 'text',
        text: 'Email us at <a href="mailto:support@example.com">support@example.com</a>',
      },
    });

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Email us at support@example.com');
  });
});

// ---------------------------------------------------------------------------
// verifyRequest
// ---------------------------------------------------------------------------

describe('ZendeskAdapter.verifyRequest', () => {
  const adapter = new ZendeskAdapter();
  const WEBHOOK_SECRET = 'test_zendesk_secret_123';

  it('returns true for valid HMAC signature', async () => {
    const bodyStr = '{"app":{"id":"app1"}}';
    const signature = signPayload(bodyStr, WEBHOOK_SECRET);

    const result = await adapter.verifyRequest(
      { 'x-api-key': signature },
      JSON.parse(bodyStr),
      Buffer.from(bodyStr),
      { credentials: { webhook_secret: WEBHOOK_SECRET } } as any,
    );
    expect(result).toBe(true);
  });

  it('returns false for invalid signature', async () => {
    const bodyStr = '{"app":{"id":"app1"}}';

    const result = await adapter.verifyRequest(
      { 'x-api-key': 'invalidsig' },
      JSON.parse(bodyStr),
      Buffer.from(bodyStr),
      { credentials: { webhook_secret: WEBHOOK_SECRET } } as any,
    );
    expect(result).toBe(false);
  });

  it('returns true when no webhook_secret is configured (skip verification)', async () => {
    const result = await adapter.verifyRequest({}, { app: { id: 'app1' } }, undefined, {
      credentials: {},
    } as any);
    expect(result).toBe(true);
  });

  it('returns true when connection has no credentials', async () => {
    const result = await adapter.verifyRequest({}, { app: { id: 'app1' } }, undefined, null);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// transformOutput
// ---------------------------------------------------------------------------

describe('ZendeskAdapter.transformOutput', () => {
  const adapter = new ZendeskAdapter();

  it('returns plain text when no actions', () => {
    const result = adapter.transformOutput('Hello there');
    expect(result).toEqual({ kind: 'text', text: 'Hello there' });
  });

  it('transforms buttons into zendesk_actions', () => {
    const actions: ActionSetIR = {
      elements: [
        { id: 'yes', type: 'button', label: 'Yes' },
        { id: 'no', type: 'button', label: 'No' },
      ],
    };

    const result = adapter.transformOutput('Confirm?', actions);
    expect(result.kind).toBe('zendesk_actions');
    if (result.kind !== 'zendesk_actions') return;

    expect(result.content.type).toBe('text');
    expect(result.content.text).toBe('Confirm?');
    expect(result.content.actions).toHaveLength(2);
    expect(result.content.actions[0]).toEqual({
      type: 'reply',
      text: 'Yes',
      payload: 'yes',
    });
    expect(result.content.actions[1]).toEqual({
      type: 'reply',
      text: 'No',
      payload: 'no',
    });
  });

  it('returns plain text when actions array is empty', () => {
    const actions: ActionSetIR = { elements: [] };
    const result = adapter.transformOutput('Hello', actions);
    expect(result).toEqual({ kind: 'text', text: 'Hello' });
  });
});

// ---------------------------------------------------------------------------
// sendResponse
// ---------------------------------------------------------------------------

describe('ZendeskAdapter.sendResponse', () => {
  const adapter = new ZendeskAdapter();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends text message to Sunshine API with Basic Auth', async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ messages: [{ id: 'resp1' }] }) };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

    const result = await adapter.sendResponse(
      {
        sessionId: 'sess1',
        text: 'Hello!',
        eventType: 'agent.response',
        metadata: {
          zendeskAppId: 'app1',
          zendeskConversationId: 'conv1',
        },
      },
      {
        id: 'conn1',
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        channelType: 'zendesk',
        externalIdentifier: 'app1',
        credentials: { key_id: 'myKeyId', key_secret: 'myKeySecret' },
        config: {},
        status: 'active',
      },
    );

    expect(result.success).toBe(true);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.smooch.io/v2/apps/app1/conversations/conv1/messages');

    const headers = fetchCall[1]?.headers as Record<string, string>;
    const expectedAuth = Buffer.from('myKeyId:myKeySecret').toString('base64');
    expect(headers['Authorization']).toBe(`Basic ${expectedAuth}`);

    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.author.type).toBe('business');
    expect(body.content.type).toBe('text');
    expect(body.content.text).toBe('Hello!');
  });

  it('sends zendesk_actions content when channelOutput is present', async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ messages: [{ id: 'resp2' }] }) };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

    const channelOutput = {
      kind: 'zendesk_actions' as const,
      content: {
        type: 'text',
        text: 'Choose:',
        actions: [{ type: 'reply', text: 'Yes', payload: 'yes' }],
      },
      text: 'Choose:',
    };

    const result = await adapter.sendResponse(
      {
        sessionId: 'sess1',
        text: 'Choose:',
        eventType: 'agent.response',
        metadata: {
          zendeskAppId: 'app1',
          zendeskConversationId: 'conv1',
          channelOutput,
        },
      },
      {
        id: 'conn1',
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        channelType: 'zendesk',
        externalIdentifier: 'app1',
        credentials: { key_id: 'myKeyId', key_secret: 'myKeySecret' },
        config: {},
        status: 'active',
      },
    );

    expect(result.success).toBe(true);

    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body as string);
    expect(body.content.type).toBe('text');
    expect(body.content.text).toBe('Choose:');
    expect(body.content.actions).toHaveLength(1);
  });

  it('returns error when credentials are missing', async () => {
    const result = await adapter.sendResponse(
      {
        sessionId: 'sess1',
        text: 'Hello',
        eventType: 'agent.response',
        metadata: {
          zendeskAppId: 'app1',
          zendeskConversationId: 'conv1',
        },
      },
      {
        id: 'conn1',
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        channelType: 'zendesk',
        externalIdentifier: 'app1',
        credentials: null,
        config: {},
        status: 'active',
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(DELIVERY_CONFIGURATION_CUSTOMER_MESSAGE);
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      category: 'configuration',
      code: 'CHANNEL_DELIVERY_CONFIGURATION',
      provider: 'zendesk',
    });
  });

  it('returns error when conversation ID is missing', async () => {
    const result = await adapter.sendResponse(
      {
        sessionId: 'sess1',
        text: 'Hello',
        eventType: 'agent.response',
        metadata: {
          zendeskAppId: 'app1',
        },
      },
      {
        id: 'conn1',
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        channelType: 'zendesk',
        externalIdentifier: 'app1',
        credentials: { key_id: 'k', key_secret: 's' },
        config: {},
        status: 'active',
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(DELIVERY_FAILED_CUSTOMER_MESSAGE);
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      category: 'metadata',
      code: 'CHANNEL_DELIVERY_METADATA',
      provider: 'zendesk',
    });
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      message: expect.stringContaining('conversation ID'),
    });
  });

  it('handles API errors gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    } as any);

    const result = await adapter.sendResponse(
      {
        sessionId: 'sess1',
        text: 'Hello',
        eventType: 'agent.response',
        metadata: {
          zendeskAppId: 'app1',
          zendeskConversationId: 'conv1',
        },
      },
      {
        id: 'conn1',
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        channelType: 'zendesk',
        externalIdentifier: 'app1',
        credentials: { key_id: 'k', key_secret: 's' },
        config: {},
        status: 'active',
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(DELIVERY_FAILED_CUSTOMER_MESSAGE);
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      category: 'provider',
      code: 'CHANNEL_PROVIDER_REJECTED',
      httpStatus: 500,
      provider: 'zendesk',
    });
  });
});
