/**
 * Gupshup Provider Tests
 *
 * Tests inbound message handling: providerId, shouldProcess(), buildNormalizedMessage(),
 * extractExternalIdentifier(), extractEventId(), verifyRequest(), and transformOutput().
 * Tests outbound methods: transformOutput(), sendResponse().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { signFeedbackToken, signGupshupWebhookToken } from '@agent-platform/shared-auth';
import { GupshupProvider } from '../../../channels/adapters/whatsapp-providers/gupshup-provider.js';

const DELIVERY_FAILED_CUSTOMER_MESSAGE =
  "I'm having trouble delivering that response. Please try again.";
const DELIVERY_CONFIGURATION_CUSTOMER_MESSAGE =
  'This channel is not fully configured for response delivery. Please contact support.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGupshupBody(overrides?: Record<string, unknown>) {
  return {
    mobile: '919876543210',
    waNumber: '918888888888',
    type: 'text',
    text: 'Hello from Gupshup',
    name: 'Test User',
    messageId: 'gBEGkYiEB1VXAglK1ZEqA1YKPRu',
    timestamp: '1609459200',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// providerId
// ---------------------------------------------------------------------------

describe('GupshupProvider', () => {
  const provider = new GupshupProvider();

  describe('providerId', () => {
    it('equals "gupshup"', () => {
      expect(provider.providerId).toBe('gupshup');
    });
  });

  // ---------------------------------------------------------------------------
  // extractExternalIdentifier
  // ---------------------------------------------------------------------------

  describe('extractExternalIdentifier', () => {
    it('reads body.waNumber', () => {
      const body = makeGupshupBody({ waNumber: '918888888888' });
      expect(provider.extractExternalIdentifier(body)).toBe('918888888888');
    });

    it('returns null for missing waNumber', () => {
      const body = makeGupshupBody({ waNumber: undefined });
      expect(provider.extractExternalIdentifier(body)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // extractEventId
  // ---------------------------------------------------------------------------

  describe('extractEventId', () => {
    it('reads body.messageId if present', () => {
      const body = makeGupshupBody({ messageId: 'gBEGkYiEB1VXAglK1ZEqA1YKPRu' });
      expect(provider.extractEventId(body)).toBe('gBEGkYiEB1VXAglK1ZEqA1YKPRu');
    });

    it('falls back to gupshup:${mobile}:${timestamp} when messageId is missing', () => {
      const body = makeGupshupBody({ messageId: undefined });
      expect(provider.extractEventId(body)).toBe('gupshup:919876543210:1609459200');
    });

    it('returns null for empty body', () => {
      expect(provider.extractEventId({})).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // shouldProcess
  // ---------------------------------------------------------------------------

  describe('shouldProcess', () => {
    const validTypes = [
      'text',
      'image',
      'video',
      'document',
      'audio',
      'voice',
      'location',
      'interactive',
      'button',
      'contacts',
    ];

    for (const type of validTypes) {
      it(`returns true for type="${type}"`, () => {
        const body = makeGupshupBody({ type });
        expect(provider.shouldProcess(body)).toBe(true);
      });
    }

    it('returns false for unknown type', () => {
      const body = makeGupshupBody({ type: 'sticker' });
      expect(provider.shouldProcess(body)).toBe(false);
    });

    it('returns false for missing type', () => {
      const body = makeGupshupBody({ type: undefined });
      expect(provider.shouldProcess(body)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // buildNormalizedMessage
  // ---------------------------------------------------------------------------

  describe('buildNormalizedMessage', () => {
    it('maps text message correctly', () => {
      const body = makeGupshupBody();
      const result = provider.buildNormalizedMessage(body);

      expect(result.text).toBe('Hello from Gupshup');
      expect(result.externalMessageId).toBe('gBEGkYiEB1VXAglK1ZEqA1YKPRu');
      expect(result.externalSessionKey).toBe('whatsapp:918888888888:919876543210');
      expect(result.metadata?.whatsappFrom).toBe('919876543210');
      expect(result.metadata?.whatsappPhoneNumberId).toBe('918888888888');
      expect(result.metadata?.whatsappContactName).toBe('Test User');
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('maps image message with media reference', () => {
      const body = makeGupshupBody({
        type: 'image',
        text: undefined,
        image: JSON.stringify({
          url: 'https://example.com/photo.jpg',
          mime_type: 'image/jpeg',
          caption: 'A nice photo',
        }),
      });
      const result = provider.buildNormalizedMessage(body);

      expect(result.text).toBe('A nice photo');
      const mediaRefs = result.metadata?.whatsappMediaReferences as Array<{
        mediaId: string;
        mimeType: string;
        mediaType: string;
        url: string;
      }>;
      expect(mediaRefs).toHaveLength(1);
      expect(mediaRefs[0]).toEqual({
        mediaId: 'gupshup-direct',
        mimeType: 'image/jpeg',
        mediaType: 'image',
        url: 'https://example.com/photo.jpg',
      });
    });

    it('maps video message with media reference', () => {
      const body = makeGupshupBody({
        type: 'video',
        text: undefined,
        video: JSON.stringify({
          url: 'https://example.com/clip.mp4',
          mime_type: 'video/mp4',
        }),
      });
      const result = provider.buildNormalizedMessage(body);

      const mediaRefs = result.metadata?.whatsappMediaReferences as Array<{
        mediaType: string;
      }>;
      expect(mediaRefs[0].mediaType).toBe('video');
    });

    it('maps document message with media reference', () => {
      const body = makeGupshupBody({
        type: 'document',
        text: undefined,
        document: JSON.stringify({
          url: 'https://example.com/file.pdf',
          mime_type: 'application/pdf',
          caption: 'My doc',
        }),
      });
      const result = provider.buildNormalizedMessage(body);

      expect(result.text).toBe('My doc');
      const mediaRefs = result.metadata?.whatsappMediaReferences as Array<{
        mediaType: string;
      }>;
      expect(mediaRefs[0].mediaType).toBe('document');
    });

    it('maps audio message with media reference', () => {
      const body = makeGupshupBody({
        type: 'audio',
        text: undefined,
        audio: JSON.stringify({
          url: 'https://example.com/audio.ogg',
          mime_type: 'audio/ogg',
        }),
      });
      const result = provider.buildNormalizedMessage(body);

      const mediaRefs = result.metadata?.whatsappMediaReferences as Array<{
        mediaType: string;
      }>;
      expect(mediaRefs[0].mediaType).toBe('audio');
    });

    it('maps voice message: concatenates url + signature, mediaType = audio', () => {
      const body = makeGupshupBody({
        type: 'voice',
        text: undefined,
        voice: JSON.stringify({
          url: 'https://example.com/voice.ogg?token=abc',
          signature: '&sig=xyz123',
        }),
      });
      const result = provider.buildNormalizedMessage(body);

      const mediaRefs = result.metadata?.whatsappMediaReferences as Array<{
        mediaId: string;
        mimeType: string;
        mediaType: string;
        url: string;
      }>;
      expect(mediaRefs).toHaveLength(1);
      expect(mediaRefs[0]).toEqual({
        mediaId: 'gupshup-direct',
        mimeType: 'audio/ogg',
        mediaType: 'audio',
        url: 'https://example.com/voice.ogg?token=abc&sig=xyz123',
      });
    });

    it('maps location with address: text = address', () => {
      const body = makeGupshupBody({
        type: 'location',
        text: undefined,
        location: JSON.stringify({
          latitude: 12.9716,
          longitude: 77.5946,
          address: '100 Main Street, Bangalore',
        }),
      });
      const result = provider.buildNormalizedMessage(body);

      expect(result.text).toBe('100 Main Street, Bangalore');
    });

    it('maps location without address: text = lat,lng', () => {
      const body = makeGupshupBody({
        type: 'location',
        text: undefined,
        location: JSON.stringify({
          latitude: 12.9716,
          longitude: 77.5946,
        }),
      });
      const result = provider.buildNormalizedMessage(body);

      expect(result.text).toBe('12.9716,77.5946');
    });

    it('maps interactive button_reply to actionEvent', () => {
      const body = makeGupshupBody({
        type: 'interactive',
        text: undefined,
        interactive: JSON.stringify({
          type: 'button_reply',
          button_reply: { id: 'btn_confirm' },
        }),
      });
      const result = provider.buildNormalizedMessage(body);

      expect(result.text).toBe('');
      expect(result.actionEvent).toEqual({
        type: 'action_event',
        actionId: 'btn_confirm',
        value: 'btn_confirm',
        source: 'whatsapp',
      });
    });

    it('maps interactive list_reply to actionEvent', () => {
      const body = makeGupshupBody({
        type: 'interactive',
        text: undefined,
        interactive: JSON.stringify({
          type: 'list_reply',
          list_reply: { id: 'list_option_2' },
        }),
      });
      const result = provider.buildNormalizedMessage(body);

      expect(result.text).toBe('');
      expect(result.actionEvent).toEqual({
        type: 'action_event',
        actionId: 'list_option_2',
        value: 'list_option_2',
        source: 'whatsapp',
      });
    });

    it('rejects malformed interactive replies at provider ingress', () => {
      const body = makeGupshupBody({
        type: 'interactive',
        text: undefined,
        interactive: JSON.stringify({
          type: 'button_reply',
          button_reply: { id: '' },
        }),
      });

      expect(() => provider.buildNormalizedMessage(body)).toThrow(
        /Invalid actionId in action_submit/,
      );
    });

    it('maps button type: text = button.text', () => {
      const body = makeGupshupBody({
        type: 'button',
        text: undefined,
        button: JSON.stringify({ text: 'Quick Reply Text' }),
      });
      const result = provider.buildNormalizedMessage(body);

      expect(result.text).toBe('Quick Reply Text');
    });

    it('maps contacts: formats contact as readable text', () => {
      const body = makeGupshupBody({
        type: 'contacts',
        text: undefined,
        contacts: JSON.stringify([
          {
            name: { formatted_name: 'Alice Smith' },
            phones: [{ phone: '+1234567890' }],
            emails: [{ email: 'alice@example.com' }],
          },
        ]),
      });
      const result = provider.buildNormalizedMessage(body);
      expect(result.text).toBe('Shared contact: Alice Smith (+1234567890, alice@example.com)');
      expect(result.metadata?.contacts).toHaveLength(1);
    });

    it('maps contacts with invalid JSON: falls back to raw string', () => {
      const body = makeGupshupBody({
        type: 'contacts',
        text: undefined,
        contacts: 'not-valid-json',
      });
      const result = provider.buildNormalizedMessage(body);
      expect(result.text).toBe('not-valid-json');
    });

    it('maps contacts with name only', () => {
      const body = makeGupshupBody({
        type: 'contacts',
        text: undefined,
        contacts: JSON.stringify([{ name: { formatted_name: 'Bob' } }]),
      });
      const result = provider.buildNormalizedMessage(body);
      expect(result.text).toBe('Shared contact: Bob');
    });
  });

  // ---------------------------------------------------------------------------
  // verifyRequest
  // ---------------------------------------------------------------------------

  describe('verifyRequest', () => {
    it('returns true when no webhook_secret configured (no connection)', async () => {
      const result = await provider.verifyRequest({}, {}, undefined, null);
      expect(result).toBe(true);
    });

    it('returns true when no webhook_secret in credentials', async () => {
      const connection = {
        id: 'conn1',
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        channelType: 'whatsapp' as const,
        externalIdentifier: '918888888888',
        credentials: { api_key: 'some-key' },
        config: {},
        status: 'active',
      };
      const result = await provider.verifyRequest({}, {}, undefined, connection);
      expect(result).toBe(true);
    });

    it('returns true for valid HS256 JWT', async () => {
      const secret = 'my-webhook-secret';
      const token = jwt.sign({ payload: 'test' }, secret, { algorithm: 'HS256' });
      const connection = {
        id: 'conn1',
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        channelType: 'whatsapp' as const,
        externalIdentifier: '918888888888',
        credentials: { webhook_secret: secret },
        config: {},
        status: 'active',
      };
      const headers = { authorization: `Bearer ${token}` };
      const result = await provider.verifyRequest(headers, {}, undefined, connection);
      expect(result).toBe(true);
    });

    it('returns true for platform-purpose Gupshup webhook JWTs', async () => {
      const secret = 'my-webhook-secret';
      const token = signGupshupWebhookToken({ payload: 'test' }, secret);
      const connection = {
        id: 'conn1',
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        channelType: 'whatsapp' as const,
        externalIdentifier: '918888888888',
        credentials: { webhook_secret: secret },
        config: {},
        status: 'active',
      };
      const headers = { authorization: `Bearer ${token}` };
      const result = await provider.verifyRequest(headers, {}, undefined, connection);
      expect(result).toBe(true);
    });

    it('returns false for a feedback token signed with the same secret', async () => {
      const secret = 'my-webhook-secret';
      const token = signFeedbackToken(
        {
          tenantId: 't1',
          projectId: 'p1',
          sessionId: 's1',
          messageId: 'm1',
          connectionId: 'c1',
        },
        secret,
        { expiresIn: '1h' },
      );
      const connection = {
        id: 'conn1',
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        channelType: 'whatsapp' as const,
        externalIdentifier: '918888888888',
        credentials: { webhook_secret: secret },
        config: {},
        status: 'active',
      };
      const result = await provider.verifyRequest(
        { authorization: `Bearer ${token}` },
        {},
        undefined,
        connection,
      );
      expect(result).toBe(false);
    });

    it('returns false for invalid JWT when secret is configured', async () => {
      const connection = {
        id: 'conn1',
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        channelType: 'whatsapp' as const,
        externalIdentifier: '918888888888',
        credentials: { webhook_secret: 'correct-secret' },
        config: {},
        status: 'active',
      };
      const headers = { authorization: 'Bearer invalid.jwt.token' };
      const result = await provider.verifyRequest(headers, {}, undefined, connection);
      expect(result).toBe(false);
    });

    it('returns false for missing Authorization header when secret is configured', async () => {
      const connection = {
        id: 'conn1',
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        channelType: 'whatsapp' as const,
        externalIdentifier: '918888888888',
        credentials: { webhook_secret: 'some-secret' },
        config: {},
        status: 'active',
      };
      const result = await provider.verifyRequest({}, {}, undefined, connection);
      expect(result).toBe(false);
    });

    it('returns false for unsupported JWT algorithm', async () => {
      const secret = 'test-secret-key';
      const token = jwt.sign({ sub: 'gupshup' }, secret, { algorithm: 'HS256' });
      const connection = {
        id: 'conn1',
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        channelType: 'whatsapp' as const,
        externalIdentifier: '918888888888',
        credentials: { webhook_secret: secret },
        config: { webhookAlgorithm: 'none' },
        status: 'active',
      };
      const result = await provider.verifyRequest(
        { authorization: `Bearer ${token}` },
        {},
        undefined,
        connection,
      );
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // transformOutput
  // ---------------------------------------------------------------------------

  describe('transformOutput', () => {
    it('plain text returns { kind: "text", text }', () => {
      const result = provider.transformOutput('Hello world');
      expect(result).toEqual({ kind: 'text', text: 'Hello world' });
    });

    it('2 buttons returns whatsapp_interactive with button type', () => {
      const result = provider.transformOutput('Pick one', {
        elements: [
          { type: 'button', id: 'btn_yes', label: 'Yes' },
          { type: 'button', id: 'btn_no', label: 'No' },
        ],
      });
      expect(result.kind).toBe('whatsapp_interactive');
      const interactive = (result as { kind: 'whatsapp_interactive'; interactive: any })
        .interactive;
      expect(interactive.type).toBe('button');
      expect(interactive.body.text).toBe('Pick one');
      expect(interactive.action.buttons).toHaveLength(2);
      expect(interactive.action.buttons[0]).toEqual({
        type: 'reply',
        reply: { id: 'btn_yes', title: 'Yes' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // sendResponse
  // ---------------------------------------------------------------------------

  describe('sendResponse', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    const baseConnection = {
      id: 'conn1',
      tenantId: 't1',
      projectId: 'p1',
      agentId: 'a1',
      channelType: 'whatsapp' as const,
      externalIdentifier: '917012345678',
      credentials: { username: 'gupshup_user', password: 'gupshup_pass' },
      config: { provider: 'gupshup' },
      status: 'active',
    };

    const baseMessage = {
      sessionId: 'sess1',
      text: 'Hello!',
      eventType: 'agent.response' as const,
      metadata: { whatsappFrom: '919876543210' },
    };

    beforeEach(() => {
      fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('text message sends form-encoded POST with correct fields', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { status: 'success', id: 'gup-msg-001' },
        }),
      });

      const result = await provider.sendResponse(baseMessage, baseConnection);

      expect(result.success).toBe(true);
      expect(result.deliveryId).toBe('gup-msg-001');

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://media.smsgupshup.com/GatewayAPI/rest');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const params = new URLSearchParams(opts.body);
      expect(params.get('method')).toBe('SendMessage');
      expect(params.get('msg_type')).toBe('Text');
      expect(params.get('msg')).toBe('Hello!');
      expect(params.get('send_to')).toBe('919876543210');
      expect(params.get('userid')).toBe('gupshup_user');
      expect(params.get('password')).toBe('gupshup_pass');
      expect(params.get('auth_scheme')).toBe('plain');
      expect(params.get('v')).toBe('1.1');
      expect(params.get('format')).toBe('json');
    });

    it('interactive buttons sends dr_button with action JSON', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { status: 'success', id: 'gup-msg-002' },
        }),
      });

      const interactiveMessage = {
        ...baseMessage,
        metadata: {
          ...baseMessage.metadata,
          channelOutput: {
            kind: 'whatsapp_interactive' as const,
            text: 'Pick one',
            interactive: {
              type: 'button',
              body: { text: 'Pick one' },
              action: {
                buttons: [
                  { type: 'reply', reply: { id: 'btn_yes', title: 'Yes' } },
                  { type: 'reply', reply: { id: 'btn_no', title: 'No' } },
                ],
              },
            },
          },
        },
      };

      const result = await provider.sendResponse(interactiveMessage, baseConnection);
      expect(result.success).toBe(true);

      const [, opts] = fetchSpy.mock.calls[0];
      const params = new URLSearchParams(opts.body);
      expect(params.get('interactive_type')).toBe('dr_button');
      expect(params.get('msg')).toBe('Pick one');
      const action = JSON.parse(params.get('action')!);
      expect(action.buttons).toHaveLength(2);
    });

    it('interactive list sends list type', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { status: 'success', id: 'gup-msg-003' },
        }),
      });

      const listMessage = {
        ...baseMessage,
        metadata: {
          ...baseMessage.metadata,
          channelOutput: {
            kind: 'whatsapp_interactive' as const,
            text: 'Choose option',
            interactive: {
              type: 'list',
              body: { text: 'Choose option' },
              action: {
                button: 'Options',
                sections: [
                  {
                    title: 'Options',
                    rows: [
                      { id: 'opt_1', title: 'Option 1', description: 'First' },
                      { id: 'opt_2', title: 'Option 2' },
                    ],
                  },
                ],
              },
            },
          },
        },
      };

      const result = await provider.sendResponse(listMessage, baseConnection);
      expect(result.success).toBe(true);

      const [, opts] = fetchSpy.mock.calls[0];
      const params = new URLSearchParams(opts.body);
      expect(params.get('interactive_type')).toBe('list');
      expect(params.get('msg')).toBe('Choose option');
    });

    it('template sends dr_button with template action JSON', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { status: 'success', id: 'gup-msg-004' },
        }),
      });

      const templateMessage = {
        ...baseMessage,
        metadata: {
          ...baseMessage.metadata,
          channelOutput: {
            kind: 'whatsapp_template' as const,
            text: '',
            template: {
              name: 'order_update',
              language: { code: 'en' },
              components: [
                {
                  type: 'body' as const,
                  parameters: [{ type: 'text' as const, text: 'Order #123' }],
                },
              ],
            },
          },
        },
      };

      const result = await provider.sendResponse(templateMessage, baseConnection);
      expect(result.success).toBe(true);

      const [, opts] = fetchSpy.mock.calls[0];
      const params = new URLSearchParams(opts.body);
      expect(params.get('interactive_type')).toBe('dr_button');
      const action = JSON.parse(params.get('action')!);
      expect(action.name).toBe('order_update');
      expect(action.language.code).toBe('en');
    });

    it('returns error when Gupshup responds with status "error" on HTTP 200', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: {
            status: 'error',
            details: 'Invalid phone number format',
          },
        }),
      });

      const result = await provider.sendResponse(baseMessage, baseConnection);
      expect(result.success).toBe(false);
      expect(result.error).toBe(DELIVERY_FAILED_CUSTOMER_MESSAGE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        category: 'provider',
        code: 'CHANNEL_PROVIDER_REJECTED',
        provider: 'gupshup',
        providerErrorCode: 'error',
      });
    });

    it('returns error on HTTP error status', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      });

      const result = await provider.sendResponse(baseMessage, baseConnection);
      expect(result.success).toBe(false);
      expect(result.error).toBe(DELIVERY_FAILED_CUSTOMER_MESSAGE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        category: 'provider',
        code: 'CHANNEL_PROVIDER_REJECTED',
        httpStatus: 503,
        provider: 'gupshup',
      });
    });

    it('returns error when credentials are missing', async () => {
      const noCredConn = {
        ...baseConnection,
        credentials: null as any,
      };

      const result = await provider.sendResponse(baseMessage, noCredConn);
      expect(result.success).toBe(false);
      expect(result.error).toBe(DELIVERY_CONFIGURATION_CUSTOMER_MESSAGE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        provider: 'gupshup',
      });
    });
  });
});
