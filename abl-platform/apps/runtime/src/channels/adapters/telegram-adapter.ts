/**
 * Telegram Bot API Channel Adapter
 *
 * Handles Telegram webhook updates and sends responses via Bot API.
 *
 * - verifyRequest()        -> X-Telegram-Bot-Api-Secret-Token string match
 * - parseIncoming()        -> Normalizes Telegram Update -> NormalizedIncomingMessage
 * - sendResponse()         -> POST to api.telegram.org/bot{token}/sendMessage
 * - transformOutput()      -> ActionSetIR -> inline keyboard reply_markup
 *
 * Supports: text, callback_query (inline buttons), media (photo, document, audio, video)
 * Group chats: processes messages that mention the bot or reply to the bot
 * /start command: detected as welcome event
 */

import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import type { ActionElementIR, ActionSetIR, RichContentIR } from '@abl/compiler';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelOutput,
  ChannelType,
  InboundJobPayload,
  NormalizedIncomingMessage,
  NormalizedOutgoingMessage,
  ResolvedConnection,
  SendResult,
} from '../types.js';
import { requireNormalizedActionEvent } from '../../services/channels/action-event-validation.js';
import { resolveConnectionProviderApiBase } from './provider-api-base.js';
import {
  buildChannelDeliveryFailure,
  buildChannelDeliveryLogContext,
  getChannelDeliveryErrorName,
} from '../../services/channel/delivery-diagnostics.js';

const log = createLogger('telegram-adapter');

const TELEGRAM_API_BASE = 'https://api.telegram.org';

// =============================================================================
// TELEGRAM UPDATE TYPES
// =============================================================================

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMessageEntity {
  type: string; // 'mention' | 'bot_command' | etc.
  offset: number;
  length: number;
  user?: TelegramUser;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  video?: TelegramVideo;
  voice?: TelegramVoice;
  reply_to_message?: TelegramMessage;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

// =============================================================================
// LIMITS
// =============================================================================

const MAX_INLINE_ROWS = 10;
const MAX_BUTTON_TEXT = 64;
const MAX_CALLBACK_DATA = 64;

// =============================================================================
// ADAPTER
// =============================================================================

export class TelegramAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'telegram';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: true,
    supportsStreaming: true,
    supportsMedia: true,
    supportsThreading: false,
  };

  /**
   * Verify Telegram webhook via X-Telegram-Bot-Api-Secret-Token header.
   * Simple string comparison against the stored secret_token.
   */
  async verifyRequest(
    headers: Record<string, string>,
    _body: unknown,
    _rawBody?: Buffer | string,
    connection?: ResolvedConnection | null,
  ): Promise<boolean> {
    const secretToken = connection?.credentials?.secret_token as string | undefined;
    if (!secretToken) {
      log.error('Telegram secret_token not configured for connection');
      return false;
    }

    const headerToken = headers['x-telegram-bot-api-secret-token'];
    if (!headerToken) {
      log.warn('Missing X-Telegram-Bot-Api-Secret-Token header');
      return false;
    }

    // Constant-time comparison to prevent timing attacks
    try {
      return crypto.timingSafeEqual(
        Buffer.from(secretToken, 'utf8'),
        Buffer.from(headerToken, 'utf8'),
      );
    } catch {
      return false;
    }
  }

  /**
   * Extract bot username as external identifier for connection resolution.
   * The identifier is set in the URL path (:identifier), so this extracts
   * from the body only as a fallback.
   */
  extractExternalIdentifier(_body: unknown): string | null {
    // For Telegram, the identifier comes from the URL path, not the body.
    // This is called only for the generic webhook route (no :identifier in URL).
    // Return null to force use of the path-based route.
    return null;
  }

  /**
   * Extract update_id for deduplication.
   */
  extractEventId(body: unknown): string | null {
    const update = body as TelegramUpdate;
    return update.update_id ? String(update.update_id) : null;
  }

  /**
   * Check if this webhook update should be processed.
   * Filters out non-message updates, channel posts, and group messages
   * not directed at the bot.
   */
  shouldProcess(body: unknown, connection?: ResolvedConnection | null): boolean {
    const update = body as TelegramUpdate;

    // Process callback queries (inline button presses)
    if (update.callback_query) return true;

    const msg = update.message;
    if (!msg) return false;

    // Ignore messages from bots
    if (msg.from?.is_bot) return false;

    // Ignore channel posts
    if (msg.chat.type === 'channel') return false;

    // Private chats: always process
    if (msg.chat.type === 'private') return true;

    // Group/supergroup: only process if message mentions the bot or is a reply to the bot
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
      // Check if it's a reply to the bot
      if (msg.reply_to_message?.from?.is_bot) return true;

      // Check for bot mention in entities
      const botUsername = connection?.externalIdentifier as string | undefined;
      if (msg.entities?.some((e) => e.type === 'mention')) {
        if (!botUsername) {
          // Connection not yet resolved — let it through for post-connection filtering
          return true;
        }
        return msg.entities.some(
          (e) =>
            e.type === 'mention' &&
            msg.text?.substring(e.offset, e.offset + e.length).toLowerCase() ===
              `@${botUsername.toLowerCase()}`,
        );
      }

      // Check for /start or /help commands (always process in groups)
      if (msg.entities?.some((e) => e.type === 'bot_command')) {
        const text = msg.text || '';
        if (text.startsWith('/start') || text.startsWith('/help')) return true;
      }

      return false;
    }

    return false;
  }

  /**
   * Build NormalizedIncomingMessage from Telegram Update payload.
   */
  buildNormalizedMessage(
    body: unknown,
    connection?: ResolvedConnection | null,
  ): NormalizedIncomingMessage {
    const update = body as TelegramUpdate;
    const botIdentifier = connection?.externalIdentifier || 'unknown';

    // Handle callback_query (inline keyboard button press)
    if (update.callback_query) {
      const cbq = update.callback_query;
      const chatId = cbq.message?.chat.id ?? cbq.from.id;

      return {
        externalMessageId: cbq.id,
        externalSessionKey: `telegram:${botIdentifier}:${chatId}`,
        text: '',
        actionEvent: requireNormalizedActionEvent({
          actionId: cbq.data || '',
          value: cbq.data || '',
          source: 'telegram',
        }),
        metadata: {
          telegramChatId: chatId,
          telegramUserId: cbq.from.id,
          telegramUserName: cbq.from.first_name,
          telegramUsername: cbq.from.username,
          telegramCallbackQueryId: cbq.id,
          isGroup: cbq.message?.chat.type !== 'private',
        },
        timestamp: new Date(),
      };
    }

    const msg = update.message;
    if (!msg) {
      throw new Error('Invalid Telegram update: no message or callback_query');
    }

    const chatId = msg.chat.id;
    const isGroup = msg.chat.type !== 'private';

    // Base metadata
    const metadata: Record<string, unknown> = {
      telegramChatId: chatId,
      telegramUserId: msg.from?.id,
      telegramUserName: msg.from?.first_name,
      telegramUsername: msg.from?.username,
      telegramMessageId: msg.message_id,
      isGroup,
    };

    if (isGroup) {
      metadata.telegramChatTitle = msg.chat.title;
    }

    // Handle /start command as welcome event
    if (msg.text?.startsWith('/start')) {
      const startPayload = msg.text.replace(/^\/start\s*/, '').trim();
      return {
        externalMessageId: String(update.update_id),
        externalSessionKey: `telegram:${botIdentifier}:${chatId}`,
        text: startPayload || '/start',
        actionEvent: requireNormalizedActionEvent({
          actionId: 'welcome',
          value: startPayload || 'start',
          source: 'telegram',
        }),
        metadata,
        timestamp: new Date(msg.date * 1000),
      };
    }

    // Handle media messages
    const mediaTypes = ['photo', 'document', 'audio', 'video', 'voice'] as const;
    for (const mediaType of mediaTypes) {
      if (mediaType === 'photo' && msg.photo && msg.photo.length > 0) {
        // Pick the largest photo
        const photo = msg.photo[msg.photo.length - 1];
        metadata.telegramMediaReferences = [
          {
            fileId: photo.file_id,
            mimeType: 'image/jpeg', // Telegram photos are always JPEG
            mediaType: 'photo',
            fileSize: photo.file_size,
          },
        ];
        return {
          externalMessageId: String(update.update_id),
          externalSessionKey: `telegram:${botIdentifier}:${chatId}`,
          text: msg.caption || '',
          metadata,
          timestamp: new Date(msg.date * 1000),
        };
      }

      if (mediaType !== 'photo' && msg[mediaType]) {
        const mediaObj = msg[mediaType]!;
        metadata.telegramMediaReferences = [
          {
            fileId: mediaObj.file_id,
            mimeType: mediaObj.mime_type || 'application/octet-stream',
            mediaType,
            fileSize: mediaObj.file_size,
            filename: (mediaObj as TelegramDocument).file_name,
          },
        ];
        return {
          externalMessageId: String(update.update_id),
          externalSessionKey: `telegram:${botIdentifier}:${chatId}`,
          text: msg.caption || '',
          metadata,
          timestamp: new Date(msg.date * 1000),
        };
      }
    }

    // Strip only the bot's mention from text in group chats
    let text = msg.text || '';
    if (isGroup && botIdentifier && msg.entities) {
      const botMention = `@${botIdentifier}`.toLowerCase();
      for (const entity of msg.entities) {
        if (entity.type === 'mention') {
          const mention = text.substring(entity.offset, entity.offset + entity.length);
          if (mention.toLowerCase() === botMention) {
            text = text.replace(mention, '').trim();
          }
        }
      }
    }

    // Standard text message
    return {
      externalMessageId: String(update.update_id),
      externalSessionKey: `telegram:${botIdentifier}:${chatId}`,
      text,
      metadata,
      timestamp: new Date(msg.date * 1000),
    };
  }

  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  /**
   * Send response via Telegram Bot API.
   */
  async sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult> {
    const botToken = connection.credentials?.bot_token as string;
    if (!botToken) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'telegram',
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        operatorMessage: 'No Telegram bot token was available for outbound delivery.',
        retryable: false,
      });
    }

    const chatId = message.metadata?.telegramChatId as number | string;
    if (!chatId) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'telegram',
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        operatorMessage: 'No Telegram chat ID was present in message metadata.',
        retryable: false,
      });
    }

    const apiBase = resolveConnectionProviderApiBase(
      connection,
      'TELEGRAM_API_BASE_URL',
      TELEGRAM_API_BASE,
      'telegramApiBaseUrl',
    );

    // Answer callback query if present (dismiss loading spinner on button)
    const callbackQueryId = message.metadata?.telegramCallbackQueryId as string | undefined;
    if (callbackQueryId) {
      try {
        await fetch(`${apiBase}/bot${botToken}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: callbackQueryId }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (err) {
        log.warn('Failed to answer callback query', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      const channelOutput = message.metadata?.channelOutput as ChannelOutput | undefined;

      let body: Record<string, unknown>;
      const method = 'sendMessage';

      // Telegram requires text to be 1-4096 characters; guard against empty responses
      const resolvedText =
        (channelOutput?.kind === 'telegram_keyboard' ? channelOutput.text : message.text) || '…';

      if (channelOutput?.kind === 'telegram_keyboard') {
        body = {
          chat_id: chatId,
          text: resolvedText,
          reply_markup: channelOutput.replyMarkup,
          parse_mode: 'Markdown',
        };
      } else {
        body = {
          chat_id: chatId,
          text: resolvedText,
          parse_mode: 'Markdown',
        };
      }

      const url = `${apiBase}/bot${botToken}/${method}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        log.error(
          'Telegram API error',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'telegram',
            httpStatus: resp.status,
          }),
        );

        // If Markdown parsing fails, retry without parse_mode
        if (resp.status === 400 && errText.includes("can't parse")) {
          delete body.parse_mode;
          const retryResp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
          });
          if (retryResp.ok) {
            const result = (await retryResp.json()) as { result?: { message_id: number } };
            return { success: true, deliveryId: String(result.result?.message_id) };
          }
        }

        return buildChannelDeliveryFailure({
          channelType: this.channelType,
          provider: 'telegram',
          category: 'provider',
          code: 'CHANNEL_PROVIDER_REJECTED',
          operatorMessage: 'Telegram Bot API rejected the outbound response.',
          httpStatus: resp.status,
          retryable: false,
        });
      }

      const result = (await resp.json()) as { ok: boolean; result?: { message_id: number } };
      const messageId = result.result?.message_id;
      log.info('Telegram message sent', { chatId, messageId });
      return { success: true, deliveryId: String(messageId) };
    } catch (error) {
      const code =
        error instanceof Error && error.name === 'AbortError'
          ? 'CHANNEL_DELIVERY_TIMEOUT'
          : 'CHANNEL_DELIVERY_FAILED';
      log.error(
        'Failed to send Telegram message',
        buildChannelDeliveryLogContext({
          channelType: this.channelType,
          provider: 'telegram',
          code,
          errorName: getChannelDeliveryErrorName(error),
        }),
      );
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'telegram',
        category: 'network',
        code,
        operatorMessage: 'Telegram Bot API failed before a provider response was available.',
        retryable: true,
      });
    }
  }

  /**
   * Send a "typing" chat action to Telegram.
   * Best-effort: silently returns on missing credentials; logs warnings on API failure.
   */
  async sendTypingIndicator(
    connection: ResolvedConnection,
    _externalSessionKey: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const botToken = connection.credentials?.bot_token as string;
      if (!botToken) return;

      const chatId = metadata?.telegramChatId as number | string;
      if (!chatId) return;

      const apiBase = resolveConnectionProviderApiBase(
        connection,
        'TELEGRAM_API_BASE_URL',
        TELEGRAM_API_BASE,
        'telegramApiBaseUrl',
      );
      const url = `${apiBase}/bot${botToken}/sendChatAction`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        log.warn(
          'Telegram typing indicator failed',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'telegram',
            httpStatus: resp.status,
          }),
        );
      }
    } catch (err) {
      log.warn('Telegram typing indicator failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Transform ActionSetIR into Telegram inline keyboard.
   */
  transformOutput(
    text: string,
    actions?: ActionSetIR,
    _richContent?: RichContentIR,
  ): ChannelOutput {
    if (!actions || actions.elements.length === 0) {
      return { kind: 'text', text };
    }

    const buttons = actions.elements.filter((e: ActionElementIR) => e.type === 'button');
    const selects = actions.elements.filter((e: ActionElementIR) => e.type === 'select');

    const rows: Array<Array<{ text: string; callback_data: string }>> = [];

    // Map buttons to inline keyboard rows (one button per row for clarity)
    for (const btn of buttons) {
      if (rows.length >= MAX_INLINE_ROWS) break;
      rows.push([
        {
          text: btn.label.slice(0, MAX_BUTTON_TEXT),
          callback_data: btn.id.slice(0, MAX_CALLBACK_DATA),
        },
      ]);
    }

    // Map selects to inline keyboard rows
    for (const sel of selects) {
      for (const opt of sel.options || []) {
        if (rows.length >= MAX_INLINE_ROWS) break;
        rows.push([
          {
            text: opt.label.slice(0, MAX_BUTTON_TEXT),
            callback_data: opt.id.slice(0, MAX_CALLBACK_DATA),
          },
        ]);
      }
    }

    if (rows.length === 0) {
      return { kind: 'text', text };
    }

    return {
      kind: 'telegram_keyboard',
      text,
      replyMarkup: { inline_keyboard: rows },
    };
  }
}
