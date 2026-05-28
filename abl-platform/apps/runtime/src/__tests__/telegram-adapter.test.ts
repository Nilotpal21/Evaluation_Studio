import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramAdapter } from '../channels/adapters/telegram-adapter.js';
import type { ResolvedConnection } from '../channels/types.js';

const SAFE_DELIVERY_FAILURE = "I'm having trouble delivering that response. Please try again.";
const SAFE_CONFIGURATION_FAILURE =
  'This channel is not fully configured for response delivery. Please contact support.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

vi.stubGlobal('fetch', vi.fn());
const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;

const mockConnection: ResolvedConnection = {
  id: 'conn-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  agentId: null,
  channelType: 'telegram' as const,
  externalIdentifier: 'test_bot',
  credentials: { bot_token: 'test-token', secret_token: 'test-secret' },
  config: {},
  status: 'active',
};

function makeUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 123456,
    message: {
      message_id: 1,
      from: { id: 100, is_bot: false, first_name: 'Alice', username: 'alice' },
      chat: { id: 200, type: 'private' },
      date: 1700000000,
      text: 'Hello bot',
      ...((overrides.message as Record<string, unknown>) ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'message')),
  };
}

function telegramOkResponse(messageId = 42) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ ok: true, result: { message_id: messageId } }),
    text: () => Promise.resolve(JSON.stringify({ ok: true })),
  } as unknown as Response;
}

function telegramErrorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve(JSON.parse(body)),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;

  beforeEach(() => {
    adapter = new TelegramAdapter();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // verifyRequest
  // =========================================================================
  describe('verifyRequest', () => {
    it('returns true when secret token matches', async () => {
      const headers = { 'x-telegram-bot-api-secret-token': 'test-secret' };
      expect(await adapter.verifyRequest(headers, {}, undefined, mockConnection)).toBe(true);
    });

    it('returns false when header is missing', async () => {
      expect(await adapter.verifyRequest({}, {}, undefined, mockConnection)).toBe(false);
    });

    it('returns false when token is wrong', async () => {
      const headers = { 'x-telegram-bot-api-secret-token': 'wrong-secret' };
      expect(await adapter.verifyRequest(headers, {}, undefined, mockConnection)).toBe(false);
    });

    it('returns false when no secret_token in connection credentials', async () => {
      const conn = {
        ...mockConnection,
        credentials: { bot_token: 'test-token' },
      };
      const headers = { 'x-telegram-bot-api-secret-token': 'test-secret' };
      expect(await adapter.verifyRequest(headers, {}, undefined, conn)).toBe(false);
    });

    it('returns false when tokens have different lengths (timingSafeEqual throws)', async () => {
      const headers = { 'x-telegram-bot-api-secret-token': 'short' };
      expect(await adapter.verifyRequest(headers, {}, undefined, mockConnection)).toBe(false);
    });
  });

  // =========================================================================
  // shouldProcess
  // =========================================================================
  describe('shouldProcess', () => {
    it('returns true for callback_query', () => {
      const update = {
        update_id: 1,
        callback_query: { id: 'cb1', from: { id: 1, is_bot: false, first_name: 'A' }, data: 'x' },
      };
      expect(adapter.shouldProcess(update, mockConnection)).toBe(true);
    });

    it('returns false when no message', () => {
      expect(adapter.shouldProcess({ update_id: 1 }, mockConnection)).toBe(false);
    });

    it('returns false when message is from a bot', () => {
      const update = makeUpdate({
        message: {
          message_id: 1,
          from: { id: 100, is_bot: true, first_name: 'Bot' },
          chat: { id: 200, type: 'private' },
          date: 1700000000,
          text: 'hi',
        },
      });
      expect(adapter.shouldProcess(update, mockConnection)).toBe(false);
    });

    it('returns false for channel posts', () => {
      const update = makeUpdate({
        message: {
          message_id: 1,
          from: { id: 100, is_bot: false, first_name: 'Alice' },
          chat: { id: 200, type: 'channel' },
          date: 1700000000,
          text: 'channel msg',
        },
      });
      expect(adapter.shouldProcess(update, mockConnection)).toBe(false);
    });

    it('returns true for private chat text message', () => {
      const update = makeUpdate();
      expect(adapter.shouldProcess(update, mockConnection)).toBe(true);
    });

    it('returns true for group message that is a reply to the bot', () => {
      const update = makeUpdate({
        message: {
          message_id: 1,
          from: { id: 100, is_bot: false, first_name: 'Alice' },
          chat: { id: 300, type: 'group' },
          date: 1700000000,
          text: 'replying',
          reply_to_message: {
            message_id: 0,
            from: { id: 999, is_bot: true, first_name: 'Bot' },
            chat: { id: 300, type: 'group' },
            date: 1700000000,
          },
        },
      });
      expect(adapter.shouldProcess(update, mockConnection)).toBe(true);
    });

    it('returns true for group message with bot mention (with connection)', () => {
      const update = makeUpdate({
        message: {
          message_id: 1,
          from: { id: 100, is_bot: false, first_name: 'Alice' },
          chat: { id: 300, type: 'group' },
          date: 1700000000,
          text: '@test_bot hello',
          entities: [{ type: 'mention', offset: 0, length: 9 }],
        },
      });
      expect(adapter.shouldProcess(update, mockConnection)).toBe(true);
    });

    it('returns false for group message with non-bot mention (with connection)', () => {
      const update = makeUpdate({
        message: {
          message_id: 1,
          from: { id: 100, is_bot: false, first_name: 'Alice' },
          chat: { id: 300, type: 'group' },
          date: 1700000000,
          text: '@other_bot hello',
          entities: [{ type: 'mention', offset: 0, length: 10 }],
        },
      });
      expect(adapter.shouldProcess(update, mockConnection)).toBe(false);
    });

    it('returns true for group with mention but no connection (pre-filter)', () => {
      const update = makeUpdate({
        message: {
          message_id: 1,
          from: { id: 100, is_bot: false, first_name: 'Alice' },
          chat: { id: 300, type: 'group' },
          date: 1700000000,
          text: '@some_bot hello',
          entities: [{ type: 'mention', offset: 0, length: 9 }],
        },
      });
      // No connection → let through for post-connection filtering
      expect(adapter.shouldProcess(update, null)).toBe(true);
    });

    it('returns true for group with /start command', () => {
      const update = makeUpdate({
        message: {
          message_id: 1,
          from: { id: 100, is_bot: false, first_name: 'Alice' },
          chat: { id: 300, type: 'group' },
          date: 1700000000,
          text: '/start',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      });
      expect(adapter.shouldProcess(update, mockConnection)).toBe(true);
    });

    it('returns false for group message with no mention and no reply', () => {
      const update = makeUpdate({
        message: {
          message_id: 1,
          from: { id: 100, is_bot: false, first_name: 'Alice' },
          chat: { id: 300, type: 'group' },
          date: 1700000000,
          text: 'random chatter',
        },
      });
      expect(adapter.shouldProcess(update, mockConnection)).toBe(false);
    });
  });

  // =========================================================================
  // buildNormalizedMessage
  // =========================================================================
  describe('buildNormalizedMessage', () => {
    it('builds message for text in private chat with correct session key', () => {
      const update = makeUpdate();
      const msg = adapter.buildNormalizedMessage(update, mockConnection);

      expect(msg.externalSessionKey).toBe('telegram:test_bot:200');
      expect(msg.text).toBe('Hello bot');
      expect(msg.externalMessageId).toBe('123456');
      expect(msg.metadata?.telegramChatId).toBe(200);
      expect(msg.metadata?.telegramUserId).toBe(100);
      expect(msg.metadata?.isGroup).toBe(false);
    });

    it('builds message for callback query with actionEvent', () => {
      const update = {
        update_id: 999,
        callback_query: {
          id: 'cb-42',
          from: { id: 100, is_bot: false, first_name: 'Alice', username: 'alice' },
          message: {
            message_id: 5,
            chat: { id: 200, type: 'private' as const },
            date: 1700000000,
            from: { id: 999, is_bot: true, first_name: 'Bot' },
          },
          data: 'option_a',
        },
      };
      const msg = adapter.buildNormalizedMessage(update, mockConnection);

      expect(msg.externalSessionKey).toBe('telegram:test_bot:200');
      expect(msg.actionEvent).toEqual({
        type: 'action_event',
        actionId: 'option_a',
        value: 'option_a',
        source: 'telegram',
      });
      expect(msg.metadata?.telegramCallbackQueryId).toBe('cb-42');
      expect(msg.text).toBe('');
    });

    it('rejects malformed callback query action envelopes at ingress', () => {
      const update = {
        update_id: 999,
        callback_query: {
          id: 'cb-invalid',
          from: { id: 100, is_bot: false, first_name: 'Alice', username: 'alice' },
          message: {
            message_id: 5,
            chat: { id: 200, type: 'private' as const },
            date: 1700000000,
            from: { id: 999, is_bot: true, first_name: 'Bot' },
          },
          data: 'x'.repeat(300),
        },
      };

      expect(() => adapter.buildNormalizedMessage(update, mockConnection)).toThrow(
        'Invalid actionId in action_submit',
      );
    });

    it('builds /start command as welcome actionEvent', () => {
      const update = makeUpdate({ message: { ...makeUpdate().message, text: '/start' } });
      const msg = adapter.buildNormalizedMessage(update, mockConnection);

      expect(msg.actionEvent).toEqual({
        type: 'action_event',
        actionId: 'welcome',
        value: 'start',
        source: 'telegram',
      });
      expect(msg.text).toBe('/start');
    });

    it('extracts deep link payload from /start command', () => {
      const update = makeUpdate({
        message: { ...makeUpdate().message, text: '/start deep_link_payload' },
      });
      const msg = adapter.buildNormalizedMessage(update, mockConnection);

      expect(msg.actionEvent).toEqual({
        type: 'action_event',
        actionId: 'welcome',
        value: 'deep_link_payload',
        source: 'telegram',
      });
      expect(msg.text).toBe('deep_link_payload');
    });

    it('builds photo message with telegramMediaReferences', () => {
      const update = makeUpdate({
        message: {
          message_id: 1,
          from: { id: 100, is_bot: false, first_name: 'Alice' },
          chat: { id: 200, type: 'private' },
          date: 1700000000,
          caption: 'my photo',
          photo: [
            { file_id: 'small', file_unique_id: 's1', width: 90, height: 90 },
            { file_id: 'large', file_unique_id: 'l1', width: 800, height: 600, file_size: 50000 },
          ],
        },
      });
      const msg = adapter.buildNormalizedMessage(update, mockConnection);

      expect(msg.text).toBe('my photo');
      const refs = msg.metadata?.telegramMediaReferences as Array<Record<string, unknown>>;
      expect(refs).toHaveLength(1);
      expect(refs[0].fileId).toBe('large');
      expect(refs[0].mediaType).toBe('photo');
      expect(refs[0].mimeType).toBe('image/jpeg');
    });

    it('builds document message with mediaType and filename', () => {
      const update = makeUpdate({
        message: {
          message_id: 1,
          from: { id: 100, is_bot: false, first_name: 'Alice' },
          chat: { id: 200, type: 'private' },
          date: 1700000000,
          caption: 'a doc',
          document: {
            file_id: 'doc-1',
            file_unique_id: 'du1',
            file_name: 'report.pdf',
            mime_type: 'application/pdf',
            file_size: 12345,
          },
        },
      });
      const msg = adapter.buildNormalizedMessage(update, mockConnection);

      expect(msg.text).toBe('a doc');
      const refs = msg.metadata?.telegramMediaReferences as Array<Record<string, unknown>>;
      expect(refs).toHaveLength(1);
      expect(refs[0].mediaType).toBe('document');
      expect(refs[0].filename).toBe('report.pdf');
      expect(refs[0].mimeType).toBe('application/pdf');
    });

    it('strips bot mention from text in group messages', () => {
      const update = makeUpdate({
        message: {
          message_id: 1,
          from: { id: 100, is_bot: false, first_name: 'Alice' },
          chat: { id: 300, type: 'group' },
          date: 1700000000,
          text: '@test_bot what is the weather?',
          entities: [{ type: 'mention', offset: 0, length: 9 }],
        },
      });
      const msg = adapter.buildNormalizedMessage(update, mockConnection);

      expect(msg.text).toBe('what is the weather?');
      expect(msg.metadata?.isGroup).toBe(true);
    });

    it('preserves other mentions in group messages', () => {
      const update = makeUpdate({
        message: {
          message_id: 1,
          from: { id: 100, is_bot: false, first_name: 'Alice' },
          chat: { id: 300, type: 'group' },
          date: 1700000000,
          text: '@test_bot ask @other_user something',
          entities: [
            { type: 'mention', offset: 0, length: 9 },
            { type: 'mention', offset: 14, length: 11 },
          ],
        },
      });
      const msg = adapter.buildNormalizedMessage(update, mockConnection);

      expect(msg.text).toContain('@other_user');
      expect(msg.text).not.toContain('@test_bot');
    });
  });

  // =========================================================================
  // transformOutput
  // =========================================================================
  describe('transformOutput', () => {
    it('returns text output when no actions', () => {
      const result = adapter.transformOutput('Hello');
      expect(result).toEqual({ kind: 'text', text: 'Hello' });
    });

    it('returns text output when actions elements is empty', () => {
      const result = adapter.transformOutput('Hello', { elements: [] });
      expect(result).toEqual({ kind: 'text', text: 'Hello' });
    });

    it('returns telegram_keyboard for buttons', () => {
      const actions = {
        elements: [
          { type: 'button' as const, id: 'btn1', label: 'Yes' },
          { type: 'button' as const, id: 'btn2', label: 'No' },
        ],
      };
      const result = adapter.transformOutput('Choose:', actions);

      expect(result.kind).toBe('telegram_keyboard');
      if (result.kind === 'telegram_keyboard') {
        const keyboard = result.replyMarkup as {
          inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
        };
        expect(keyboard.inline_keyboard).toHaveLength(2);
        expect(keyboard.inline_keyboard[0][0]).toEqual({ text: 'Yes', callback_data: 'btn1' });
        expect(keyboard.inline_keyboard[1][0]).toEqual({ text: 'No', callback_data: 'btn2' });
      }
    });

    it('returns inline keyboard rows for select options', () => {
      const actions = {
        elements: [
          {
            type: 'select' as const,
            id: 'sel1',
            label: 'Pick',
            options: [
              { id: 'opt1', label: 'Option A' },
              { id: 'opt2', label: 'Option B' },
            ],
          },
        ],
      };
      const result = adapter.transformOutput('Select:', actions);

      expect(result.kind).toBe('telegram_keyboard');
      if (result.kind === 'telegram_keyboard') {
        const keyboard = result.replyMarkup as {
          inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
        };
        expect(keyboard.inline_keyboard).toHaveLength(2);
        expect(keyboard.inline_keyboard[0][0]).toEqual({ text: 'Option A', callback_data: 'opt1' });
      }
    });

    it('handles mixed buttons and selects', () => {
      const actions = {
        elements: [
          { type: 'button' as const, id: 'btn1', label: 'Go' },
          {
            type: 'select' as const,
            id: 'sel1',
            label: 'Pick',
            options: [{ id: 'opt1', label: 'A' }],
          },
        ],
      };
      const result = adapter.transformOutput('Mixed:', actions);

      if (result.kind === 'telegram_keyboard') {
        const keyboard = result.replyMarkup as {
          inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
        };
        expect(keyboard.inline_keyboard).toHaveLength(2);
        expect(keyboard.inline_keyboard[0][0].text).toBe('Go');
        expect(keyboard.inline_keyboard[1][0].text).toBe('A');
      }
    });

    it('truncates button text and callback_data to max limits', () => {
      const longLabel = 'A'.repeat(100);
      const longId = 'B'.repeat(100);
      const actions = {
        elements: [{ type: 'button' as const, id: longId, label: longLabel }],
      };
      const result = adapter.transformOutput('Truncated:', actions);

      if (result.kind === 'telegram_keyboard') {
        const keyboard = result.replyMarkup as {
          inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
        };
        expect(keyboard.inline_keyboard[0][0].text).toHaveLength(64);
        expect(keyboard.inline_keyboard[0][0].callback_data).toHaveLength(64);
      }
    });

    it('drops excess buttons beyond MAX_INLINE_ROWS (10)', () => {
      const elements = Array.from({ length: 15 }, (_, i) => ({
        type: 'button' as const,
        id: `btn${i}`,
        label: `Button ${i}`,
      }));
      const result = adapter.transformOutput('Many:', { elements });

      if (result.kind === 'telegram_keyboard') {
        const keyboard = result.replyMarkup as {
          inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
        };
        expect(keyboard.inline_keyboard).toHaveLength(10);
      }
    });
  });

  // =========================================================================
  // sendResponse
  // =========================================================================
  describe('sendResponse', () => {
    const baseOutgoing = {
      sessionId: 'session-1',
      text: 'Hello user',
      eventType: 'message' as const,
      metadata: { telegramChatId: 200 },
    };

    it('sends a successful text message', async () => {
      mockFetch.mockResolvedValueOnce(telegramOkResponse(42));

      const result = await adapter.sendResponse(baseOutgoing, mockConnection);

      expect(result.success).toBe(true);
      expect(result.deliveryId).toBe('42');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
      const body = JSON.parse(opts.body);
      expect(body.chat_id).toBe(200);
      expect(body.text).toBe('Hello user');
      expect(body.parse_mode).toBe('Markdown');
    });

    it('sends telegram keyboard with reply_markup', async () => {
      mockFetch.mockResolvedValueOnce(telegramOkResponse(43));

      const outgoing = {
        ...baseOutgoing,
        metadata: {
          telegramChatId: 200,
          channelOutput: {
            kind: 'telegram_keyboard',
            text: 'Pick one:',
            replyMarkup: { inline_keyboard: [[{ text: 'A', callback_data: 'a' }]] },
          },
        },
      };

      const result = await adapter.sendResponse(outgoing, mockConnection);

      expect(result.success).toBe(true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'A', callback_data: 'a' }]] });
      expect(body.text).toBe('Pick one:');
    });

    it('answers callback query before sending message', async () => {
      // First call: answerCallbackQuery, second call: sendMessage
      mockFetch
        .mockResolvedValueOnce(telegramOkResponse())
        .mockResolvedValueOnce(telegramOkResponse(44));

      const outgoing = {
        ...baseOutgoing,
        metadata: {
          telegramChatId: 200,
          telegramCallbackQueryId: 'cb-99',
        },
      };

      const result = await adapter.sendResponse(outgoing, mockConnection);

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const [firstUrl, firstOpts] = mockFetch.mock.calls[0];
      expect(firstUrl).toContain('/answerCallbackQuery');
      const firstBody = JSON.parse(firstOpts.body);
      expect(firstBody.callback_query_id).toBe('cb-99');

      const [secondUrl] = mockFetch.mock.calls[1];
      expect(secondUrl).toContain('/sendMessage');
    });

    it('retries without parse_mode on Markdown parse failure', async () => {
      mockFetch
        .mockResolvedValueOnce(telegramErrorResponse(400, "Bad Request: can't parse entities"))
        .mockResolvedValueOnce(telegramOkResponse(45));

      const result = await adapter.sendResponse(baseOutgoing, mockConnection);

      expect(result.success).toBe(true);
      expect(result.deliveryId).toBe('45');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const retryBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(retryBody.parse_mode).toBeUndefined();
    });

    it('returns error when bot_token is missing', async () => {
      const conn = { ...mockConnection, credentials: {} };
      const result = await adapter.sendResponse(baseOutgoing, conn);

      expect(result.success).toBe(false);
      expect(result.error).toBe(SAFE_CONFIGURATION_FAILURE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        channelType: 'telegram',
        provider: 'telegram',
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        retryable: false,
      });
    });

    it('returns error when chat_id is missing', async () => {
      const outgoing = { ...baseOutgoing, metadata: {} };
      const result = await adapter.sendResponse(outgoing, mockConnection);

      expect(result.success).toBe(false);
      expect(result.error).toBe(SAFE_DELIVERY_FAILURE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        channelType: 'telegram',
        provider: 'telegram',
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        retryable: false,
      });
    });

    it('uses fallback text when text is empty', async () => {
      mockFetch.mockResolvedValueOnce(telegramOkResponse(46));

      const outgoing = { ...baseOutgoing, text: '' };
      await adapter.sendResponse(outgoing, mockConnection);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toBe('\u2026');
    });
  });
});
