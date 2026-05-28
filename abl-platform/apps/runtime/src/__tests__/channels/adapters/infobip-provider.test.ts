/**
 * Infobip Provider Tests
 *
 * Tests inbound message handling: shouldProcess(), buildNormalizedMessage(),
 * extractExternalIdentifier(), extractEventId(), and verifyRequest().
 * Tests outbound methods: transformOutput(), sendResponse().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InfobipProvider } from '../../../channels/adapters/whatsapp-providers/infobip-provider.js';

const DELIVERY_FAILED_CUSTOMER_MESSAGE =
  "I'm having trouble delivering that response. Please try again.";
const DELIVERY_CONFIGURATION_CUSTOMER_MESSAGE =
  'This channel is not fully configured for response delivery. Please contact support.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInfobipPayload(
  messageOverrides?: Partial<{
    type: string;
    text: string;
    caption: string;
    url: string;
    id: string;
    latitude: number;
    longitude: number;
  }>,
  resultOverrides?: Partial<{
    from: string;
    to: string;
    messageId: string;
    receivedAt: string;
    contactName: string;
  }>,
) {
  return {
    results: [
      {
        from: resultOverrides?.from ?? '447415774332',
        to: resultOverrides?.to ?? '447860099299',
        integrationType: 'WHATSAPP',
        receivedAt: resultOverrides?.receivedAt ?? '2024-08-18T09:30:52.516+0000',
        messageId: resultOverrides?.messageId ?? 'ABEGRHQVd0QyAhCEOHQDx2_nQGlWh5eTJdht',
        message: { type: 'TEXT', text: 'Hello', ...messageOverrides },
        contact: { name: resultOverrides?.contactName ?? 'John Doe' },
      },
    ],
    messageCount: 1,
    pendingMessageCount: 0,
  };
}

// ---------------------------------------------------------------------------
// shouldProcess
// ---------------------------------------------------------------------------

describe('InfobipProvider', () => {
  const provider = new InfobipProvider();

  describe('shouldProcess', () => {
    it('returns true for valid Infobip payload with TEXT message', () => {
      const payload = makeInfobipPayload({ type: 'TEXT', text: 'Hello' });
      expect(provider.shouldProcess(payload)).toBe(true);
    });

    it('returns true for IMAGE message', () => {
      const payload = makeInfobipPayload({
        type: 'IMAGE',
        url: 'https://example.com/image.jpg',
      });
      expect(provider.shouldProcess(payload)).toBe(true);
    });

    it('returns true for INTERACTIVE_BUTTON_REPLY', () => {
      const payload = makeInfobipPayload({
        type: 'INTERACTIVE_BUTTON_REPLY',
        id: 'btn_yes',
      });
      expect(provider.shouldProcess(payload)).toBe(true);
    });

    it('returns true for INTERACTIVE_LIST_REPLY', () => {
      const payload = makeInfobipPayload({
        type: 'INTERACTIVE_LIST_REPLY',
        id: 'list_option_1',
      });
      expect(provider.shouldProcess(payload)).toBe(true);
    });

    it('returns true for LOCATION message', () => {
      const payload = makeInfobipPayload({
        type: 'LOCATION',
        latitude: 51.5074,
        longitude: -0.1278,
      });
      expect(provider.shouldProcess(payload)).toBe(true);
    });

    it('returns false for empty results array', () => {
      const payload = { results: [], messageCount: 0, pendingMessageCount: 0 };
      expect(provider.shouldProcess(payload)).toBe(false);
    });

    it('returns false for missing results', () => {
      const payload = { messageCount: 0, pendingMessageCount: 0 };
      expect(provider.shouldProcess(payload)).toBe(false);
    });

    it('returns false for unknown message type', () => {
      const payload = makeInfobipPayload({ type: 'STICKER' });
      expect(provider.shouldProcess(payload)).toBe(false);
    });

    it('returns true for CONTACT message', () => {
      const payload = makeInfobipPayload({ type: 'CONTACT' });
      expect(provider.shouldProcess(payload)).toBe(true);
    });

    it('returns false for missing message type', () => {
      const payload = {
        results: [
          {
            from: '447415774332',
            to: '447860099299',
            integrationType: 'WHATSAPP',
            receivedAt: '2024-08-18T09:30:52.516+0000',
            messageId: 'ABEGRHQVd0QyAhCEOHQDx2_nQGlWh5eTJdht',
            message: {},
            contact: { name: 'John Doe' },
          },
        ],
        messageCount: 1,
        pendingMessageCount: 0,
      };
      expect(provider.shouldProcess(payload)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // buildNormalizedMessage
  // ---------------------------------------------------------------------------

  describe('buildNormalizedMessage', () => {
    it('maps TEXT message correctly', () => {
      const payload = makeInfobipPayload({ type: 'TEXT', text: 'Hello' });
      const result = provider.buildNormalizedMessage(payload);

      expect(result.text).toBe('Hello');
      expect(result.externalMessageId).toBe('ABEGRHQVd0QyAhCEOHQDx2_nQGlWh5eTJdht');
      expect(result.externalSessionKey).toBe('whatsapp:447860099299:447415774332');
      expect(result.metadata?.whatsappFrom).toBe('447415774332');
      expect(result.metadata?.whatsappPhoneNumberId).toBe('447860099299');
      expect(result.metadata?.whatsappContactName).toBe('John Doe');
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('maps INTERACTIVE_BUTTON_REPLY to actionEvent', () => {
      const payload = makeInfobipPayload({
        type: 'INTERACTIVE_BUTTON_REPLY',
        id: 'btn_confirm',
      });
      const result = provider.buildNormalizedMessage(payload);

      expect(result.text).toBe('');
      expect(result.actionEvent).toEqual({
        type: 'action_event',
        actionId: 'btn_confirm',
        value: 'btn_confirm',
        source: 'whatsapp',
      });
    });

    it('maps INTERACTIVE_LIST_REPLY to actionEvent', () => {
      const payload = makeInfobipPayload({
        type: 'INTERACTIVE_LIST_REPLY',
        id: 'list_option_2',
      });
      const result = provider.buildNormalizedMessage(payload);

      expect(result.text).toBe('');
      expect(result.actionEvent).toEqual({
        type: 'action_event',
        actionId: 'list_option_2',
        value: 'list_option_2',
        source: 'whatsapp',
      });
    });

    it('rejects malformed interactive replies at provider ingress', () => {
      const payload = makeInfobipPayload({
        type: 'INTERACTIVE_BUTTON_REPLY',
        id: '',
      });

      expect(() => provider.buildNormalizedMessage(payload)).toThrow(
        /Invalid actionId in action_submit/,
      );
    });

    it('maps IMAGE message with media reference', () => {
      const payload = makeInfobipPayload({
        type: 'IMAGE',
        url: 'https://cdn.infobip.com/image123.jpg',
        caption: 'A photo',
      });
      const result = provider.buildNormalizedMessage(payload);

      expect(result.text).toBe('A photo');

      const mediaRefs = result.metadata?.whatsappMediaReferences as Array<{
        mediaId: string;
        mimeType: string;
        mediaType: string;
        url: string;
      }>;
      expect(mediaRefs).toHaveLength(1);
      expect(mediaRefs[0]).toEqual({
        mediaId: 'infobip-direct',
        mimeType: '',
        mediaType: 'image',
        url: 'https://cdn.infobip.com/image123.jpg',
      });
    });

    it('maps VIDEO message with media reference', () => {
      const payload = makeInfobipPayload({
        type: 'VIDEO',
        url: 'https://cdn.infobip.com/video.mp4',
      });
      const result = provider.buildNormalizedMessage(payload);

      const mediaRefs = result.metadata?.whatsappMediaReferences as Array<{
        mediaType: string;
      }>;
      expect(mediaRefs[0].mediaType).toBe('video');
    });

    it('maps AUDIO message with media reference', () => {
      const payload = makeInfobipPayload({
        type: 'AUDIO',
        url: 'https://cdn.infobip.com/audio.ogg',
      });
      const result = provider.buildNormalizedMessage(payload);

      const mediaRefs = result.metadata?.whatsappMediaReferences as Array<{
        mediaType: string;
      }>;
      expect(mediaRefs[0].mediaType).toBe('audio');
    });

    it('maps VOICE message with media reference (audio type)', () => {
      const payload = makeInfobipPayload({
        type: 'VOICE',
        url: 'https://cdn.infobip.com/voice.ogg',
      });
      const result = provider.buildNormalizedMessage(payload);

      const mediaRefs = result.metadata?.whatsappMediaReferences as Array<{
        mediaType: string;
      }>;
      expect(mediaRefs[0].mediaType).toBe('audio');
    });

    it('maps DOCUMENT message with media reference', () => {
      const payload = makeInfobipPayload({
        type: 'DOCUMENT',
        url: 'https://cdn.infobip.com/doc.pdf',
        caption: 'My document',
      });
      const result = provider.buildNormalizedMessage(payload);

      expect(result.text).toBe('My document');
      const mediaRefs = result.metadata?.whatsappMediaReferences as Array<{
        mediaType: string;
      }>;
      expect(mediaRefs[0].mediaType).toBe('document');
    });

    it('maps LOCATION message coordinates to text', () => {
      const payload = makeInfobipPayload({
        type: 'LOCATION',
        latitude: 51.5074,
        longitude: -0.1278,
      });
      const result = provider.buildNormalizedMessage(payload);

      expect(result.text).toBe('51.5074,-0.1278');
    });

    it('maps CONTACT message to formatted text', () => {
      const payload = {
        results: [
          {
            from: '447415774332',
            to: '447860099299',
            integrationType: 'WHATSAPP',
            receivedAt: '2024-08-18T09:30:52.516+0000',
            messageId: 'ABEGRHQVd0QyAhCEOHQDx2_nQGlWh5eTJdht',
            message: {
              type: 'CONTACT',
              contacts: [
                {
                  name: { formatted_name: 'John Doe', first_name: 'John', last_name: 'Doe' },
                  phones: [{ phone: '+1555987654', type: 'CELL' }],
                  emails: [{ email: 'john@example.com', type: 'WORK' }],
                },
              ],
            },
            contact: { name: 'Sender Name' },
          },
        ],
        messageCount: 1,
        pendingMessageCount: 0,
      };
      const result = provider.buildNormalizedMessage(payload);
      expect(result.text).toBe('Shared contact: John Doe (+1555987654, john@example.com)');
      expect(result.metadata?.contacts).toHaveLength(1);
    });

    it('maps CONTACT with name only', () => {
      const payload = {
        results: [
          {
            from: '447415774332',
            to: '447860099299',
            integrationType: 'WHATSAPP',
            receivedAt: '2024-08-18T09:30:52.516+0000',
            messageId: 'ABEGRHQVd0QyAhCEOHQDx2_test',
            message: {
              type: 'CONTACT',
              contacts: [{ name: { formatted_name: 'Jane' } }],
            },
            contact: { name: 'Sender' },
          },
        ],
        messageCount: 1,
        pendingMessageCount: 0,
      };
      const result = provider.buildNormalizedMessage(payload);
      expect(result.text).toBe('Shared contact: Jane');
    });

    it('throws for missing results', () => {
      expect(() => provider.buildNormalizedMessage({ messageCount: 0 })).toThrow(
        'Invalid Infobip payload: missing results',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // extractExternalIdentifier
  // ---------------------------------------------------------------------------

  describe('extractExternalIdentifier', () => {
    it('reads results[0].to', () => {
      const payload = makeInfobipPayload(undefined, {
        to: '447860099299',
      });
      expect(provider.extractExternalIdentifier(payload)).toBe('447860099299');
    });

    it('strips a leading plus from results[0].to for connection lookup', () => {
      const payload = makeInfobipPayload(undefined, {
        to: '+447860099299',
      });
      expect(provider.extractExternalIdentifier(payload)).toBe('447860099299');
    });

    it('returns null for malformed phone identifiers', () => {
      const payload = makeInfobipPayload(undefined, {
        to: '44 7860 099299',
      });
      expect(provider.extractExternalIdentifier(payload)).toBeNull();
    });

    it('returns null for missing results', () => {
      expect(provider.extractExternalIdentifier({ messageCount: 0 })).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // extractEventId
  // ---------------------------------------------------------------------------

  describe('extractEventId', () => {
    it('reads results[0].messageId', () => {
      const payload = makeInfobipPayload(undefined, {
        messageId: 'ABEGRHQVd0QyAhCEOHQDx2_nQGlWh5eTJdht',
      });
      expect(provider.extractEventId(payload)).toBe('ABEGRHQVd0QyAhCEOHQDx2_nQGlWh5eTJdht');
    });

    it('returns null for missing results', () => {
      expect(provider.extractEventId({ messageCount: 0 })).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // verifyRequest
  // ---------------------------------------------------------------------------

  describe('verifyRequest', () => {
    it('returns true (no Infobip signature verification)', async () => {
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

    it('select options return list type', () => {
      const result = provider.transformOutput('Pick a color', {
        elements: [
          {
            type: 'select',
            id: 'color',
            label: 'Color',
            options: [
              { id: 'red', label: 'Red' },
              { id: 'blue', label: 'Blue' },
            ],
          },
        ],
      });
      expect(result.kind).toBe('whatsapp_interactive');
      const interactive = (result as { kind: 'whatsapp_interactive'; interactive: any })
        .interactive;
      expect(interactive.type).toBe('list');
      expect(interactive.action.sections[0].rows).toHaveLength(2);
      expect(interactive.action.sections[0].rows[0].id).toBe('red');
    });

    it('truncates button labels to 20 chars', () => {
      const result = provider.transformOutput('Pick', {
        elements: [
          { type: 'button', id: 'b1', label: 'This label is way too long for WhatsApp buttons' },
        ],
      });
      const interactive = (result as { kind: 'whatsapp_interactive'; interactive: any })
        .interactive;
      expect(interactive.action.buttons[0].reply.title).toBe('This label is way to');
      expect(interactive.action.buttons[0].reply.title.length).toBe(20);
    });

    it('limits list rows to 10', () => {
      const elements = Array.from({ length: 15 }, (_, i) => ({
        type: 'button' as const,
        id: `btn_${i}`,
        label: `Option ${i}`,
      }));
      const result = provider.transformOutput('Choose', { elements });
      const interactive = (result as { kind: 'whatsapp_interactive'; interactive: any })
        .interactive;
      expect(interactive.action.sections[0].rows).toHaveLength(10);
    });

    it('WhatsApp template via richContent.whatsapp takes priority', () => {
      const whatsappJson = JSON.stringify({
        template_name: 'order_confirm',
        language: 'en_US',
        parameters: {
          body: [{ type: 'text', text: 'John' }],
        },
      });
      const result = provider.transformOutput(
        'Fallback text',
        {
          elements: [{ type: 'button', id: 'b1', label: 'Click' }],
        },
        { whatsapp: whatsappJson },
      );
      expect(result.kind).toBe('whatsapp_template');
      const template = (result as { kind: 'whatsapp_template'; template: any }).template;
      expect(template.name).toBe('order_confirm');
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
      externalIdentifier: '447860099299',
      credentials: {
        api_key: 'test-api-key-123',
        base_url: 'https://api.infobip.com',
      },
      config: {},
      status: 'active',
    };

    const baseMessage = {
      sessionId: 'sess1',
      text: 'Hello!',
      eventType: 'agent.response' as const,
      metadata: {
        whatsappFrom: '447415774332',
      },
    };

    beforeEach(() => {
      fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('text message sends correct payload to /whatsapp/1/message/text with API key auth', async () => {
      // Text endpoint returns messageId at top level (not in messages array)
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messageId: 'msg-001',
          status: { groupName: 'PENDING' },
        }),
      });

      const result = await provider.sendResponse(baseMessage, baseConnection);

      expect(result.success).toBe(true);
      expect(result.deliveryId).toBe('msg-001');

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.infobip.com/whatsapp/1/message/text');
      expect(opts.headers.Authorization).toBe('App test-api-key-123');
      expect(opts.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        from: '447860099299',
        to: '447415774332',
        content: { text: 'Hello!' },
      });
    });

    it('normalizes sender, recipient, and trailing base URL slash before sending', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messageId: 'msg-normalized',
          status: { groupName: 'PENDING' },
        }),
      });

      const result = await provider.sendResponse(
        {
          ...baseMessage,
          metadata: {
            whatsappFrom: '+447415774332',
          },
        },
        {
          ...baseConnection,
          externalIdentifier: '+447860099299',
          credentials: {
            ...baseConnection.credentials,
            base_url: 'https://api.infobip.com/',
          },
        },
      );

      expect(result.success).toBe(true);

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.infobip.com/whatsapp/1/message/text');
      expect(JSON.parse(opts.body)).toEqual({
        from: '447860099299',
        to: '447415774332',
        content: { text: 'Hello!' },
      });
    });

    it('rejects base URLs without a scheme before sending', async () => {
      const result = await provider.sendResponse(baseMessage, {
        ...baseConnection,
        credentials: {
          ...baseConnection.credentials,
          base_url: 'api.infobip.com',
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe(DELIVERY_CONFIGURATION_CUSTOMER_MESSAGE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        provider: 'infobip',
      });
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        message: expect.stringContaining('No Infobip base URL was configured'),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('interactive buttons sends to /whatsapp/1/message/interactive/buttons', async () => {
      // Interactive endpoint returns messageId at top level
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messageId: 'msg-002',
          status: { groupName: 'PENDING' },
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

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.infobip.com/whatsapp/1/message/interactive/buttons');
      const body = JSON.parse(opts.body);
      expect(body.content.action.buttons[0]).toEqual({
        type: 'REPLY',
        id: 'btn_yes',
        title: 'Yes',
      });
    });

    it('interactive list sends to /whatsapp/1/message/interactive/list', async () => {
      // Interactive endpoint returns messageId at top level
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messageId: 'msg-003',
          status: { groupName: 'PENDING' },
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

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.infobip.com/whatsapp/1/message/interactive/list');
      const body = JSON.parse(opts.body);
      expect(body.content.action.title).toBe('Options');
      expect(body.content.action.sections[0].rows).toHaveLength(2);
    });

    it('uses Basic auth header when config.authType === "basic"', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messageId: 'msg-004', status: { groupName: 'PENDING' } }),
      });

      const basicConnection = {
        ...baseConnection,
        credentials: {
          base_url: 'https://api.infobip.com',
          username: 'myuser',
          password: 'mypass',
        },
        config: { authType: 'basic' },
      };

      await provider.sendResponse(baseMessage, basicConnection);

      const [, opts] = fetchSpy.mock.calls[0];
      const expected = 'Basic ' + Buffer.from('myuser:mypass').toString('base64');
      expect(opts.headers.Authorization).toBe(expected);
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
        provider: 'infobip',
      });
    });

    it('extracts deliveryId from top-level messageId (text/interactive response format)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messageId: 'top-level-id-123',
          status: { groupName: 'PENDING' },
        }),
      });

      const result = await provider.sendResponse(baseMessage, baseConnection);
      expect(result.success).toBe(true);
      expect(result.deliveryId).toBe('top-level-id-123');
    });

    it('extracts deliveryId from messages array (template response format)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [{ messageId: 'template-msg-id-456', status: { groupName: 'PENDING' } }],
        }),
      });

      const result = await provider.sendResponse(baseMessage, baseConnection);
      expect(result.success).toBe(true);
      expect(result.deliveryId).toBe('template-msg-id-456');
    });
  });
});
