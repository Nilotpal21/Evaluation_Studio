import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LineAdapter } from '../channels/adapters/line-adapter.js';
import type { ResolvedConnection } from '../channels/types.js';

vi.stubGlobal('fetch', vi.fn());
const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;

const adapter = new LineAdapter();
const SAFE_DELIVERY_FAILURE = "I'm having trouble delivering that response. Please try again.";

const connection: ResolvedConnection = {
  id: 'conn-line-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  agentId: 'agent-1',
  channelType: 'line',
  externalIdentifier: 'Ubotdestination',
  credentials: {
    channel_access_token: 'line-access-token',
    channel_secret: 'line-secret',
  },
  config: {},
  status: 'active',
};

function okResponse(body: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function errorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('LineAdapter.verifyRequest', () => {
  it('accepts a valid signature', async () => {
    const body = { destination: 'Ubotdestination', events: [] };
    const rawBody = JSON.stringify(body);
    const signature = crypto.createHmac('sha256', 'line-secret').update(rawBody).digest('base64');

    await expect(
      adapter.verifyRequest({ 'x-line-signature': signature }, body, rawBody, connection),
    ).resolves.toBe(true);
  });

  it('rejects an invalid signature', async () => {
    const body = { destination: 'Ubotdestination', events: [] };
    await expect(
      adapter.verifyRequest(
        { 'x-line-signature': 'invalid' },
        body,
        JSON.stringify(body),
        connection,
      ),
    ).resolves.toBe(false);
  });
});

describe('LineAdapter inbound normalization', () => {
  it('extracts destination as external identifier', () => {
    expect(adapter.extractExternalIdentifier({ destination: 'Ubotdestination', events: [] })).toBe(
      'Ubotdestination',
    );
  });

  it('returns false from shouldProcess for empty event arrays', () => {
    expect(adapter.shouldProcess({ destination: 'Ubotdestination', events: [] })).toBe(false);
  });

  it('normalizes a text message event', () => {
    const [item] = adapter.buildNormalizedMessages({
      destination: 'Ubotdestination',
      events: [
        {
          type: 'message',
          timestamp: 1700000000000,
          replyToken: 'reply-1',
          source: { type: 'user', userId: 'U1' },
          message: { type: 'text', id: 'msg-1', text: 'hello line' },
        },
      ],
    });

    expect(item.message.externalMessageId).toBe('msg-1');
    expect(item.message.externalSessionKey).toBe('line:Ubotdestination:user:U1');
    expect(item.message.text).toBe('hello line');
    expect(item.message.metadata).toMatchObject({
      lineDestination: 'Ubotdestination',
      lineSourceType: 'user',
      lineUserId: 'U1',
      lineReplyToken: 'reply-1',
      lineMessageId: 'msg-1',
      lineEventType: 'message',
    });
  });

  it.each([
    ['image', 'image'],
    ['video', 'video'],
    ['audio', 'audio'],
    ['file', 'file'],
  ] as const)('normalizes %s media messages with media references', (messageType, mediaType) => {
    const [item] = adapter.buildNormalizedMessages({
      destination: 'Ubotdestination',
      events: [
        {
          type: 'message',
          timestamp: 1700000000000,
          replyToken: 'reply-1',
          source: { type: 'user', userId: 'U1' },
          message:
            messageType === 'file'
              ? { type: 'file', id: 'msg-1', fileName: 'test.pdf', fileSize: 1234 }
              : { type: messageType, id: 'msg-1' },
        },
      ],
    });

    expect(item.message.externalMessageId).toBe('msg-1');
    expect(item.message.metadata?.lineMediaReferences).toEqual([
      expect.objectContaining({ messageId: 'msg-1', mediaType }),
    ]);
  });

  it('normalizes a location message as text plus metadata', () => {
    const [item] = adapter.buildNormalizedMessages({
      destination: 'Ubotdestination',
      events: [
        {
          type: 'message',
          timestamp: 1700000000000,
          replyToken: 'reply-1',
          source: { type: 'user', userId: 'U1' },
          message: {
            type: 'location',
            id: 'msg-1',
            title: 'Office',
            address: '1 Example Street',
            latitude: 1.2,
            longitude: 3.4,
          },
        },
      ],
    });

    expect(item.message.text).toBe('1 Example Street');
    expect(item.message.metadata?.lineLocation).toEqual({
      title: 'Office',
      address: '1 Example Street',
      latitude: 1.2,
      longitude: 3.4,
    });
  });

  it('normalizes a sticker message as placeholder text plus metadata', () => {
    const [item] = adapter.buildNormalizedMessages({
      destination: 'Ubotdestination',
      events: [
        {
          type: 'message',
          timestamp: 1700000000000,
          replyToken: 'reply-1',
          source: { type: 'user', userId: 'U1' },
          message: {
            type: 'sticker',
            id: 'msg-1',
            packageId: '1',
            stickerId: '2',
            stickerResourceType: 'STATIC',
          },
        },
      ],
    });

    expect(item.message.text).toBe('User sent a sticker.');
    expect(item.message.metadata?.lineSticker).toEqual({
      packageId: '1',
      stickerId: '2',
      stickerResourceType: 'STATIC',
      keywords: undefined,
    });
  });

  it('normalizes a postback event into an action event', () => {
    const [item] = adapter.buildNormalizedMessages({
      destination: 'Ubotdestination',
      events: [
        {
          type: 'postback',
          timestamp: 1700000000000,
          replyToken: 'reply-1',
          source: { type: 'user', userId: 'U1' },
          postback: { data: 'choice_a', params: { date: '2026-03-07' } },
        },
      ],
    });

    expect(item.message.actionEvent).toEqual({
      type: 'action_event',
      actionId: 'choice_a',
      value: 'choice_a',
      formData: { date: '2026-03-07' },
      source: 'line',
    });
  });
});

describe('LineAdapter outbound behavior', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends plain text replies via the LINE reply endpoint', async () => {
    mockFetch.mockResolvedValue(okResponse());

    const result = await adapter.sendResponse(
      {
        sessionId: 'sess-1',
        text: 'Agent reply',
        eventType: 'agent.response',
        metadata: { lineReplyToken: 'reply-1' },
      },
      connection,
    );

    expect(result).toEqual({ success: true });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.line.me/v2/bot/message/reply');
    expect(options.headers.Authorization).toBe('Bearer line-access-token');
    expect(options.signal).toBeDefined();
    expect(JSON.parse(options.body)).toEqual({
      replyToken: 'reply-1',
      messages: [{ type: 'text', text: 'Agent reply' }],
    });
  });

  it('sends quick replies when transformOutput produced line_quick_reply', async () => {
    mockFetch.mockResolvedValue(okResponse());

    const result = await adapter.sendResponse(
      {
        sessionId: 'sess-1',
        text: 'Agent reply',
        eventType: 'agent.response',
        metadata: {
          lineReplyToken: 'reply-1',
          channelOutput: {
            kind: 'line_quick_reply',
            text: 'Choose one',
            quickReply: {
              items: [{ type: 'action', action: { type: 'postback', label: 'A', data: 'a' } }],
            },
          },
        },
      },
      connection,
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      replyToken: 'reply-1',
      messages: [
        {
          type: 'text',
          text: 'Choose one',
          quickReply: {
            items: [{ type: 'action', action: { type: 'postback', label: 'A', data: 'a' } }],
          },
        },
      ],
    });
  });

  it('returns an error when replyToken is missing', async () => {
    await expect(
      adapter.sendResponse(
        {
          sessionId: 'sess-1',
          text: 'Agent reply',
          eventType: 'agent.response',
          metadata: {},
        },
        connection,
      ),
    ).resolves.toEqual({
      success: false,
      error: SAFE_DELIVERY_FAILURE,
      metadata: expect.objectContaining({
        channelDiagnostic: expect.objectContaining({
          code: 'CHANNEL_DELIVERY_METADATA',
          category: 'metadata',
          provider: 'line',
        }),
      }),
    });
  });

  it('falls back to push when replyToken is missing and a push target is available', async () => {
    mockFetch.mockResolvedValue(okResponse());

    const result = await adapter.sendResponse(
      {
        sessionId: 'sess-1',
        text: 'Agent reply',
        eventType: 'agent.response',
        metadata: {
          lineSourceType: 'user',
          lineUserId: 'U1234567890',
        },
      },
      connection,
    );

    expect(result).toEqual({ success: true });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.line.me/v2/bot/message/push');
    expect(JSON.parse(options.body)).toEqual({
      to: 'U1234567890',
      messages: [{ type: 'text', text: 'Agent reply' }],
    });
  });

  it('falls back to push when the reply token is invalid', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(400, 'Invalid reply token'));
    mockFetch.mockResolvedValueOnce(okResponse());

    const result = await adapter.sendResponse(
      {
        sessionId: 'sess-1',
        text: 'Agent reply',
        eventType: 'agent.response',
        metadata: {
          lineReplyToken: 'reply-1',
          lineSourceType: 'group',
          lineGroupId: 'Cgroup123',
        },
      },
      connection,
    );

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.line.me/v2/bot/message/push');
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
      to: 'Cgroup123',
      messages: [{ type: 'text', text: 'Agent reply' }],
    });
  });

  it('surfaces reply API errors', async () => {
    mockFetch.mockResolvedValue(errorResponse(500, 'upstream error'));

    const result = await adapter.sendResponse(
      {
        sessionId: 'sess-1',
        text: 'Agent reply',
        eventType: 'agent.response',
        metadata: { lineReplyToken: 'reply-1' },
      },
      connection,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(SAFE_DELIVERY_FAILURE);
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      code: 'CHANNEL_PROVIDER_REJECTED',
      category: 'provider',
      provider: 'line',
      httpStatus: 500,
    });
  });

  it('transforms actions into LINE quick replies', () => {
    const output = adapter.transformOutput(
      'Choose',
      {
        elements: [
          { type: 'button', id: 'choice_a', label: 'Choice A' },
          {
            type: 'select',
            id: 'select_1',
            label: 'Select',
            options: [{ id: 'choice_b', label: 'Choice B' }],
          },
        ],
      } as any,
      undefined,
    );

    expect(output).toEqual({
      kind: 'line_quick_reply',
      text: 'Choose',
      quickReply: {
        items: [
          {
            type: 'action',
            action: {
              type: 'postback',
              label: 'Choice A',
              data: 'choice_a',
              displayText: 'Choice A',
            },
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: 'Choice B',
              data: 'choice_b',
              displayText: 'Choice B',
            },
          },
        ],
      },
    });
  });
});
