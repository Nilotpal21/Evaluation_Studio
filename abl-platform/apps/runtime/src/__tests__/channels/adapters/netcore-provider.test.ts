/**
 * Netcore Provider Tests
 *
 * Tests inbound message handling: shouldProcess(), buildNormalizedMessage(),
 * extractExternalIdentifier(), extractEventId(), and verifyRequest().
 * Tests outbound methods: transformOutput(), sendResponse().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NetcoreProvider } from '../../../channels/adapters/whatsapp-providers/netcore-provider.js';

const DELIVERY_FAILED_CUSTOMER_MESSAGE =
  "I'm having trouble delivering that response. Please try again.";
const DELIVERY_CONFIGURATION_CUSTOMER_MESSAGE =
  'This channel is not fully configured for response delivery. Please contact support.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNetcorePayload(
  messageOverrides?: Partial<{
    message_type: string;
    text_type: Array<{ text: string }>;
    image_type: { id: string; filename?: string; mime_type?: string };
    video_type: { id: string; filename?: string; mime_type?: string };
    document_type: { id: string; filename?: string; mime_type?: string };
    audio_type: { id: string; filename?: string; mime_type?: string };
    location_type: { latitude: number; longitude: number; address?: string };
    interactive_type: {
      type: string;
      button_reply?: { id: string; title?: string };
      list_reply?: { id: string; title?: string };
    };
  }>,
  resultOverrides?: Partial<{
    from: string;
    to: string;
  }>,
) {
  return {
    incoming_message: [
      {
        from: resultOverrides?.from ?? '919876543210',
        to: resultOverrides?.to ?? '918888888888',
        message_type: 'TEXT',
        text_type: [{ text: 'Hello' }],
        ...messageOverrides,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// shouldProcess
// ---------------------------------------------------------------------------

describe('NetcoreProvider', () => {
  const provider = new NetcoreProvider();

  describe('shouldProcess', () => {
    it('returns true for valid Netcore payload with TEXT message', () => {
      const payload = makeNetcorePayload({ message_type: 'TEXT' });
      expect(provider.shouldProcess(payload)).toBe(true);
    });

    it('returns true for IMAGE message', () => {
      const payload = makeNetcorePayload({
        message_type: 'IMAGE',
        image_type: { id: 'media123', mime_type: 'image/jpeg' },
      });
      expect(provider.shouldProcess(payload)).toBe(true);
    });

    it('returns true for VIDEO message', () => {
      const payload = makeNetcorePayload({
        message_type: 'VIDEO',
        video_type: { id: 'vid456', mime_type: 'video/mp4' },
      });
      expect(provider.shouldProcess(payload)).toBe(true);
    });

    it('returns true for DOCUMENT message', () => {
      const payload = makeNetcorePayload({
        message_type: 'DOCUMENT',
        document_type: { id: 'doc789', mime_type: 'application/pdf', filename: 'report.pdf' },
      });
      expect(provider.shouldProcess(payload)).toBe(true);
    });

    it('returns true for AUDIO message', () => {
      const payload = makeNetcorePayload({
        message_type: 'AUDIO',
        audio_type: { id: 'aud000', mime_type: 'audio/ogg' },
      });
      expect(provider.shouldProcess(payload)).toBe(true);
    });

    it('returns true for LOCATION message', () => {
      const payload = makeNetcorePayload({
        message_type: 'LOCATION',
        location_type: { latitude: 28.6139, longitude: 77.209 },
      });
      expect(provider.shouldProcess(payload)).toBe(true);
    });

    it('returns true for INTERACTIVE message', () => {
      const payload = makeNetcorePayload({
        message_type: 'INTERACTIVE',
        interactive_type: {
          type: 'button_reply',
          button_reply: { id: 'btn_yes' },
        },
      });
      expect(provider.shouldProcess(payload)).toBe(true);
    });

    it('returns false for empty incoming_message array', () => {
      const payload = { incoming_message: [] };
      expect(provider.shouldProcess(payload)).toBe(false);
    });

    it('returns false for missing incoming_message', () => {
      const payload = {};
      expect(provider.shouldProcess(payload)).toBe(false);
    });

    it('returns false for unknown message type', () => {
      const payload = makeNetcorePayload({ message_type: 'STICKER' });
      expect(provider.shouldProcess(payload)).toBe(false);
    });

    it('returns false for missing message type', () => {
      const payload = {
        incoming_message: [
          {
            from: '919876543210',
            to: '918888888888',
          },
        ],
      };
      expect(provider.shouldProcess(payload)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // buildNormalizedMessage
  // ---------------------------------------------------------------------------

  describe('buildNormalizedMessage', () => {
    it('maps TEXT message correctly', () => {
      const payload = makeNetcorePayload({
        message_type: 'TEXT',
        text_type: [{ text: 'Hello' }],
      });
      const result = provider.buildNormalizedMessage(payload);

      expect(result.text).toBe('Hello');
      expect(result.externalMessageId).toMatch(/^netcore-[0-9a-f]{16}$/);
      expect(result.externalSessionKey).toBe('whatsapp:918888888888:919876543210');
      expect(result.metadata?.whatsappFrom).toBe('919876543210');
      expect(result.metadata?.whatsappPhoneNumberId).toBe('918888888888');
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('maps IMAGE message with media reference', () => {
      const payload = makeNetcorePayload({
        message_type: 'IMAGE',
        image_type: { id: 'media123', filename: 'img.jpg', mime_type: 'image/jpeg' },
      });
      const result = provider.buildNormalizedMessage(payload);

      expect(result.text).toBe('');

      const mediaRefs = result.metadata?.whatsappMediaReferences as Array<{
        mediaId: string;
        mimeType: string;
        mediaType: string;
        filename?: string;
      }>;
      expect(mediaRefs).toHaveLength(1);
      expect(mediaRefs[0]).toEqual({
        mediaId: 'media123',
        mimeType: 'image/jpeg',
        mediaType: 'image',
        filename: 'img.jpg',
      });
    });

    it('maps VIDEO message with media reference', () => {
      const payload = makeNetcorePayload({
        message_type: 'VIDEO',
        video_type: { id: 'vid456', mime_type: 'video/mp4' },
      });
      const result = provider.buildNormalizedMessage(payload);

      const mediaRefs = result.metadata?.whatsappMediaReferences as Array<{
        mediaType: string;
      }>;
      expect(mediaRefs[0].mediaType).toBe('video');
    });

    it('maps DOCUMENT message with media reference', () => {
      const payload = makeNetcorePayload({
        message_type: 'DOCUMENT',
        document_type: { id: 'doc789', filename: 'report.pdf', mime_type: 'application/pdf' },
      });
      const result = provider.buildNormalizedMessage(payload);

      const mediaRefs = result.metadata?.whatsappMediaReferences as Array<{
        mediaId: string;
        mediaType: string;
        filename?: string;
      }>;
      expect(mediaRefs[0].mediaType).toBe('document');
      expect(mediaRefs[0].filename).toBe('report.pdf');
    });

    it('maps AUDIO message with media reference', () => {
      const payload = makeNetcorePayload({
        message_type: 'AUDIO',
        audio_type: { id: 'aud000', mime_type: 'audio/ogg' },
      });
      const result = provider.buildNormalizedMessage(payload);

      const mediaRefs = result.metadata?.whatsappMediaReferences as Array<{
        mediaType: string;
      }>;
      expect(mediaRefs[0].mediaType).toBe('audio');
    });

    it('maps LOCATION message coordinates to text', () => {
      const payload = makeNetcorePayload({
        message_type: 'LOCATION',
        location_type: { latitude: 28.6139, longitude: 77.209 },
      });
      const result = provider.buildNormalizedMessage(payload);

      expect(result.text).toBe('28.6139,77.209');
    });

    it('maps INTERACTIVE button_reply to actionEvent', () => {
      const payload = makeNetcorePayload({
        message_type: 'INTERACTIVE',
        interactive_type: {
          type: 'button_reply',
          button_reply: { id: 'btn_yes' },
        },
      });
      const result = provider.buildNormalizedMessage(payload);

      expect(result.text).toBe('');
      expect(result.actionEvent).toEqual({
        type: 'action_event',
        actionId: 'btn_yes',
        value: 'btn_yes',
        source: 'whatsapp',
      });
    });

    it('maps INTERACTIVE list_reply to actionEvent', () => {
      const payload = makeNetcorePayload({
        message_type: 'INTERACTIVE',
        interactive_type: {
          type: 'list_reply',
          list_reply: { id: 'list_option_1' },
        },
      });
      const result = provider.buildNormalizedMessage(payload);

      expect(result.text).toBe('');
      expect(result.actionEvent).toEqual({
        type: 'action_event',
        actionId: 'list_option_1',
        value: 'list_option_1',
        source: 'whatsapp',
      });
    });

    it('rejects malformed interactive replies at provider ingress', () => {
      const payload = makeNetcorePayload({
        message_type: 'INTERACTIVE',
        interactive_type: {
          type: 'button_reply',
          button_reply: { id: '' },
        },
      });

      expect(() => provider.buildNormalizedMessage(payload)).toThrow(
        /Invalid actionId in action_submit/,
      );
    });

    it('throws for missing incoming_message', () => {
      expect(() => provider.buildNormalizedMessage({})).toThrow(
        'Invalid Netcore payload: missing incoming_message',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // extractExternalIdentifier
  // ---------------------------------------------------------------------------

  describe('extractExternalIdentifier', () => {
    it('reads incoming_message[0].to', () => {
      const payload = makeNetcorePayload(undefined, { to: '918888888888' });
      expect(provider.extractExternalIdentifier(payload)).toBe('918888888888');
    });

    it('returns null for missing incoming_message', () => {
      expect(provider.extractExternalIdentifier({})).toBeNull();
    });

    it('returns null for empty incoming_message array', () => {
      expect(provider.extractExternalIdentifier({ incoming_message: [] })).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // extractEventId
  // ---------------------------------------------------------------------------

  describe('extractEventId', () => {
    it('returns truthy string for valid payload', () => {
      const payload = makeNetcorePayload(undefined, {
        from: '919876543210',
        to: '918888888888',
      });
      const eventId = provider.extractEventId(payload);
      expect(eventId).toBeTruthy();
      expect(typeof eventId).toBe('string');
      expect(eventId).toMatch(/^netcore-[0-9a-f]{16}$/);
    });

    it('returns same ID for identical payloads (deterministic)', () => {
      const payload = makeNetcorePayload();
      const id1 = provider.extractEventId(payload);
      const id2 = provider.extractEventId(payload);
      expect(id1).toBe(id2);
    });

    it('returns null for missing incoming_message', () => {
      expect(provider.extractEventId({})).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // verifyRequest
  // ---------------------------------------------------------------------------

  describe('verifyRequest', () => {
    it('returns true (no Netcore signature verification)', async () => {
      const result = await provider.verifyRequest({}, {});
      expect(result).toBe(true);
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

    it('empty actions returns { kind: "text", text }', () => {
      const result = provider.transformOutput('Hello', { elements: [] });
      expect(result).toEqual({ kind: 'text', text: 'Hello' });
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

    it('5 buttons returns whatsapp_interactive with list type', () => {
      const elements = Array.from({ length: 5 }, (_, i) => ({
        type: 'button' as const,
        id: `btn_${i}`,
        label: `Option ${i}`,
      }));
      const result = provider.transformOutput('Choose', { elements });
      expect(result.kind).toBe('whatsapp_interactive');
      const interactive = (result as { kind: 'whatsapp_interactive'; interactive: any })
        .interactive;
      expect(interactive.type).toBe('list');
      expect(interactive.action.sections[0].rows).toHaveLength(5);
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
      externalIdentifier: '918888888888',
      credentials: {
        api_key: 'test-netcore-api-key',
      },
      config: {},
      status: 'active',
    };

    const baseMessage = {
      sessionId: 'sess1',
      text: 'Hello!',
      eventType: 'agent.response' as const,
      metadata: {
        whatsappFrom: '919876543210',
      },
    };

    beforeEach(() => {
      fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('text message sends correct payload to default Netcore URL with Bearer auth', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: { status: 'success' } }),
      });

      const result = await provider.sendResponse(baseMessage, baseConnection);

      expect(result.success).toBe(true);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://cpaaswa.netcorecloud.net/api/v2/message/nc');
      expect(opts.headers.Authorization).toBe('Bearer test-netcore-api-key');
      expect(opts.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        message: [
          {
            recipient_type: 'individual',
            message_type: 'text',
            type_text: [{ preview_url: 'false', content: 'Hello!' }],
            recipient_whatsapp: '919876543210',
            source: '918888888888',
          },
        ],
      });
    });

    it('uses custom base_url when configured', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: { status: 'success' } }),
      });

      const customConnection = {
        ...baseConnection,
        credentials: {
          api_key: 'test-netcore-api-key',
          base_url: 'https://custom.netcore.api/v2/message',
        },
      };

      await provider.sendResponse(baseMessage, customConnection);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://custom.netcore.api/v2/message');
    });

    it('interactive message sends message_type "interactive" with type_interactive', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: { status: 'success' } }),
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
      const body = JSON.parse(opts.body);
      expect(body.message[0].message_type).toBe('interactive');
      expect(body.message[0].type_interactive).toEqual({
        type: 'button',
        body: { text: 'Pick one' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'btn_yes', title: 'Yes' } },
            { type: 'reply', reply: { id: 'btn_no', title: 'No' } },
          ],
        },
      });
    });

    it('template message sends with message_type template', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: { status: 'success' } }),
      });

      const templateMessage = {
        ...baseMessage,
        metadata: {
          ...baseMessage.metadata,
          channelOutput: {
            kind: 'whatsapp_template' as const,
            text: 'Fallback text',
            template: {
              name: 'order_confirm',
              language: { code: 'en_US' },
              components: [{ type: 'body', parameters: [{ type: 'text', text: 'John' }] }],
            },
          },
        },
      };

      const result = await provider.sendResponse(templateMessage, baseConnection);
      expect(result.success).toBe(true);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.message[0].message_type).toBe('template');
      expect(body.message[0].type_template.name).toBe('order_confirm');
      expect(body.message[0].type_template.language.code).toBe('en_US');
    });

    it('returns { success: false } on HTTP error', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const result = await provider.sendResponse(baseMessage, baseConnection);
      expect(result.success).toBe(false);
      expect(result.error).toBe(DELIVERY_FAILED_CUSTOMER_MESSAGE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        category: 'provider',
        code: 'CHANNEL_PROVIDER_REJECTED',
        httpStatus: 401,
        provider: 'netcore',
      });
    });

    it('returns { success: false } when API response status is "error"', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: { status: 'error', details: 'Invalid number' } }),
      });

      const result = await provider.sendResponse(baseMessage, baseConnection);
      expect(result.success).toBe(false);
      expect(result.error).toBe(DELIVERY_FAILED_CUSTOMER_MESSAGE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        category: 'provider',
        code: 'CHANNEL_PROVIDER_REJECTED',
        provider: 'netcore',
        providerErrorCode: 'error',
      });
    });

    it('returns { success: false } when no API key configured', async () => {
      const noKeyConnection = {
        ...baseConnection,
        credentials: {},
      };

      const result = await provider.sendResponse(baseMessage, noKeyConnection);
      expect(result.success).toBe(false);
      expect(result.error).toBe(DELIVERY_CONFIGURATION_CUSTOMER_MESSAGE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        provider: 'netcore',
      });
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        message: expect.stringContaining('No Netcore API key'),
      });
    });

    it('returns { success: false } when no recipient phone number', async () => {
      const noRecipientMessage = {
        ...baseMessage,
        metadata: {},
      };

      const result = await provider.sendResponse(noRecipientMessage, baseConnection);
      expect(result.success).toBe(false);
      expect(result.error).toBe(DELIVERY_FAILED_CUSTOMER_MESSAGE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        provider: 'netcore',
      });
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        message: expect.stringContaining('No WhatsApp recipient phone number'),
      });
    });

    it('returns { success: false } on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network failure'));
      const result = await provider.sendResponse(baseMessage, baseConnection);
      expect(result.success).toBe(false);
      expect(result.error).toBe(DELIVERY_FAILED_CUSTOMER_MESSAGE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        category: 'network',
        code: 'CHANNEL_DELIVERY_FAILED',
        provider: 'netcore',
      });
    });
  });
});
