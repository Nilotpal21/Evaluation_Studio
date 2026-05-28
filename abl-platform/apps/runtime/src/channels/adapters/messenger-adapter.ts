/**
 * Facebook Messenger Channel Adapter
 *
 * Handles Messenger Platform webhooks and sends responses via Send API.
 *
 * - verifyRequest()     → HMAC-SHA256 signature verification (app secret)
 * - parseIncoming()     → Normalizes Messenger webhook → NormalizedIncomingMessage
 * - sendResponse()      → POST to Graph API /me/messages endpoint
 * - transformOutput()   → ActionSetIR / CarouselIR → Messenger templates / quick replies
 *
 * Supports: text, button templates (max 3 buttons), quick replies (max 13),
 *           generic_template carousel (max 10 cards, 3 buttons/card)
 * Postback and quick_reply callbacks produce ActionEvent
 *
 * Limits:
 * - Button template buttons: max 3
 * - Quick replies: max 13
 * - Quick reply title: 20 chars
 * - Button title: 20 chars
 */

import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import type { ActionSetIR, RichContentIR } from '@abl/compiler';
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
import {
  buildChannelDeliveryFailure,
  buildChannelDeliveryLogContext,
  readNonEmptyDeliveryMetadataString,
} from '../../services/channel/delivery-diagnostics.js';
import { META_GRAPH_API_VERSION, META_GRAPH_API_BASE } from './meta-constants.js';

const log = createLogger('messenger-adapter');

// =============================================================================
// MESSENGER WEBHOOK TYPES
// =============================================================================

interface MessengerWebhookPayload {
  object: 'page';
  entry: Array<{
    id: string;
    time: number;
    messaging: Array<MessengerEvent>;
  }>;
}

interface MessengerAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'location' | 'fallback';
  payload?: {
    url?: string;
    sticker_id?: number;
    coordinates?: { lat: number; long: number };
  };
}

interface MessengerEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload: string };
    attachments?: MessengerAttachment[];
  };
  postback?: {
    title: string;
    payload: string;
  };
}

// =============================================================================
// MESSENGER LIMITS
// =============================================================================

/**
 * Replay protection window: reject events older than 5 minutes.
 * Messenger's retry window is up to 24 hours, so 5 minutes is intentionally
 * strict to limit replay attack surface while tolerating brief network delays.
 */
const MAX_EVENT_AGE_MS = 5 * 60 * 1000; // 300_000ms

const MAX_BUTTONS = 3;
const MAX_QUICK_REPLIES = 13;
const MAX_BUTTON_TITLE = 20;
const MAX_QUICK_REPLY_TITLE = 20;
const MAX_CAROUSEL_CARDS = 10;
const MAX_CARD_TITLE = 80;
const MAX_CARD_SUBTITLE = 80;
const MAX_CARD_BUTTONS = 3;

// =============================================================================
// ADAPTER
// =============================================================================

export class MessengerAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'messenger';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: true,
    supportsStreaming: false,
    supportsMedia: true,
    supportsThreading: false,
  };

  /**
   * Verify Messenger's HMAC-SHA256 request signature.
   */
  async verifyRequest(
    headers: Record<string, string>,
    _body: unknown,
    rawBody?: Buffer | string,
    connection?: ResolvedConnection | null,
  ): Promise<boolean> {
    const appSecret =
      (connection?.credentials?.app_secret as string) || process.env.MESSENGER_APP_SECRET;
    if (!appSecret) {
      log.error('Messenger app secret not configured');
      return false;
    }

    const signature = headers['x-hub-signature-256'];
    if (!signature) {
      log.warn('Missing X-Hub-Signature-256 header');
      return false;
    }

    const bodyStr = rawBody
      ? typeof rawBody === 'string'
        ? rawBody
        : rawBody.toString('utf8')
      : JSON.stringify(_body);

    const expected =
      'sha256=' + crypto.createHmac('sha256', appSecret).update(bodyStr).digest('hex');

    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  /**
   * Handle Meta's GET webhook verification request.
   *
   * Meta sends: GET ?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>
   * We verify the token matches the connection's stored verify_token and
   * respond with the challenge string.
   *
   * The webhook route resolves the connection by looking up verify_token
   * across all active connections for this channel type. If no matching
   * connection is found, connection will be null and verification fails.
   */
  handleWebhookVerification(
    query: Record<string, string>,
    connection?: { credentials?: Record<string, unknown> } | null,
  ): string | null {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode !== 'subscribe' || !challenge) return null;

    const expectedToken = connection?.credentials?.verify_token as string | undefined;

    if (!expectedToken) {
      log.error(
        'No channel connection found with matching verify_token — create a Messenger channel connection in Studio first',
      );
      return null;
    }

    if (token !== expectedToken) {
      log.warn('Messenger webhook verification token mismatch');
      return null;
    }

    log.info('Messenger webhook verification successful');
    return challenge;
  }

  /**
   * Extract page ID as external identifier.
   * Uses entry[0].id (canonical page ID) which is present on all entry types,
   * falling back to messaging[0].recipient.id for compatibility.
   */
  extractExternalIdentifier(body: unknown): string | null {
    const payload = body as MessengerWebhookPayload;
    return payload.entry?.[0]?.id || payload.entry?.[0]?.messaging?.[0]?.recipient?.id || null;
  }

  /**
   * Extract message ID for deduplication.
   *
   * Text messages and quick replies use the native `mid`.
   * Postbacks lack a mid, so we generate a synthetic ID from
   * sender + payload + timestamp to enable deduplication on retry.
   */
  extractEventId(body: unknown): string | null {
    const payload = body as MessengerWebhookPayload;
    const event = payload.entry?.[0]?.messaging?.[0];
    if (event?.message?.mid) return event.message.mid;
    if (event?.postback) {
      return `postback:${event.sender?.id}:${event.postback.payload}:${event.timestamp}`;
    }
    return null;
  }

  /**
   * Check if this webhook contains a processable event.
   */
  shouldProcess(body: unknown): boolean {
    const payload = body as MessengerWebhookPayload;
    const event = payload.entry?.[0]?.messaging?.[0];
    if (!event) return false;

    // Reject echo messages (sent by the page itself) to prevent infinite loops
    if (event.message?.is_echo) return false;

    // Reject stale events (replay protection)
    if (event.timestamp) {
      const eventAge = Date.now() - event.timestamp;
      if (eventAge > MAX_EVENT_AGE_MS) {
        log.warn('Rejecting stale Messenger event', { eventAge, timestamp: event.timestamp });
        return false;
      }
    }

    // Process text messages, quick replies, postbacks, and attachments
    return !!(
      event.message?.text ||
      event.message?.quick_reply ||
      event.postback ||
      event.message?.attachments?.length
    );
  }

  /**
   * Build NormalizedIncomingMessage from Messenger webhook payload.
   */
  buildNormalizedMessage(body: unknown): NormalizedIncomingMessage {
    const payload = body as MessengerWebhookPayload;
    const event = payload.entry?.[0]?.messaging?.[0];
    if (!event) {
      throw new Error('Invalid Messenger payload: missing messaging event');
    }
    const pageId = event.recipient?.id ?? payload.entry?.[0]?.id ?? 'unknown';
    const senderId = event.sender?.id ?? 'unknown';

    // Handle postback (button click)
    if (event.postback) {
      return {
        externalMessageId: `postback:${senderId}:${event.timestamp}`,
        externalSessionKey: `messenger:${pageId}:${senderId}`,
        text: '',
        actionEvent: requireNormalizedActionEvent({
          actionId: event.postback.payload,
          value: event.postback.payload,
          source: 'messenger',
        }),
        metadata: {
          messengerPageId: pageId,
          messengerSenderId: senderId,
          messengerEventType: 'postback',
        },
        timestamp: new Date(event.timestamp),
      };
    }

    // Handle quick reply
    if (event.message?.quick_reply) {
      return {
        externalMessageId: event.message.mid,
        externalSessionKey: `messenger:${pageId}:${senderId}`,
        text: '',
        actionEvent: requireNormalizedActionEvent({
          actionId: event.message.quick_reply.payload,
          value: event.message.quick_reply.payload,
          source: 'messenger',
        }),
        metadata: {
          messengerPageId: pageId,
          messengerSenderId: senderId,
          messengerEventType: 'quick_reply',
        },
        timestamp: new Date(event.timestamp),
      };
    }

    // Extract downloadable media attachments (skip sticker, location, fallback)
    const processableTypes = ['image', 'video', 'audio', 'file'];
    const messengerMediaReferences = (event.message?.attachments ?? [])
      .filter((a) => processableTypes.includes(a.type) && a.payload?.url)
      .map((a) => ({
        type: a.type as 'image' | 'video' | 'audio' | 'file',
        url: a.payload!.url!,
      }));

    // Standard text message (may also include attachments)
    return {
      externalMessageId: event.message!.mid,
      externalSessionKey: `messenger:${pageId}:${senderId}`,
      text: event.message!.text || '',
      metadata: {
        messengerPageId: pageId,
        messengerSenderId: senderId,
        ...(messengerMediaReferences.length > 0 && { messengerMediaReferences }),
      },
      timestamp: new Date(event.timestamp),
    };
  }

  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  /**
   * Send response via Messenger Send API.
   */
  async sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult> {
    const accessToken =
      (connection.credentials?.page_access_token as string) ||
      process.env.MESSENGER_PAGE_ACCESS_TOKEN;

    if (!accessToken) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'messenger',
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        operatorMessage: 'No Messenger page access token was available for outbound delivery.',
        retryable: false,
      });
    }

    const recipientId = readNonEmptyDeliveryMetadataString(message.metadata?.messengerSenderId);
    if (!recipientId) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'messenger',
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        operatorMessage: 'No Messenger recipient ID was present in message metadata.',
        retryable: false,
      });
    }

    try {
      const channelOutput = message.metadata?.channelOutput as ChannelOutput | undefined;

      let body: Record<string, unknown>;
      if (channelOutput?.kind === 'messenger_template') {
        body = {
          recipient: { id: recipientId },
          message: channelOutput.message,
        };
      } else {
        body = {
          recipient: { id: recipientId },
          message: { text: message.text },
        };
      }

      const url = `${META_GRAPH_API_BASE}/${META_GRAPH_API_VERSION}/me/messages`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        log.error(
          'Messenger API error',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'messenger',
            httpStatus: resp.status,
          }),
        );
        return buildChannelDeliveryFailure({
          channelType: this.channelType,
          provider: 'messenger',
          category: 'provider',
          code: 'CHANNEL_PROVIDER_REJECTED',
          operatorMessage: 'Messenger Send API rejected the outbound response.',
          httpStatus: resp.status,
          retryable: false,
        });
      }

      const result = (await resp.json()) as { message_id?: string };
      log.info('Messenger message sent', { recipientId, messageId: result.message_id });
      return { success: true, deliveryId: result.message_id };
    } catch (error) {
      const failure = buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'messenger',
        category: 'network',
        code:
          error instanceof Error && error.name === 'AbortError'
            ? 'CHANNEL_DELIVERY_TIMEOUT'
            : 'CHANNEL_DELIVERY_FAILED',
        operatorMessage: 'Messenger Send API failed before a provider response was available.',
        retryable: true,
      });
      const diagnostic = failure.metadata?.channelDiagnostic as { message?: string } | undefined;
      log.error('Failed to send Messenger message', {
        error: diagnostic?.message ?? failure.error,
      });
      return failure;
    }
  }

  /**
   * Send a typing indicator ("typing_on" sender action) to Messenger.
   * Best-effort: silently returns on missing credentials; logs warnings on API failure.
   */
  async sendTypingIndicator(
    connection: ResolvedConnection,
    _externalSessionKey: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const accessToken =
        (connection.credentials?.page_access_token as string) ||
        process.env.MESSENGER_PAGE_ACCESS_TOKEN;
      if (!accessToken) return;

      const recipientId = readNonEmptyDeliveryMetadataString(metadata?.messengerSenderId);
      if (!recipientId) return;

      const url = `${META_GRAPH_API_BASE}/${META_GRAPH_API_VERSION}/me/messages`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { id: recipientId },
          sender_action: 'typing_on',
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        log.warn(
          'Messenger typing indicator failed',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'messenger',
            httpStatus: resp.status,
          }),
        );
      }
    } catch (err) {
      log.warn('Messenger typing indicator failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Transform ActionSetIR / CarouselIR into Messenger format.
   *
   * Strategy:
   * - Carousel → generic_template (max 10 cards, 80-char title/subtitle, 3 buttons/card)
   * - ≤3 buttons → button template
   * - >3 buttons or selects → quick replies (max 13)
   * - Inputs → text fallback (Messenger doesn't support form inputs in messages)
   */
  transformOutput(text: string, actions?: ActionSetIR, richContent?: RichContentIR): ChannelOutput {
    // Carousel takes priority over standalone actions
    if (richContent?.carousel && richContent.carousel.cards.length > 0) {
      const elements = richContent.carousel.cards.slice(0, MAX_CAROUSEL_CARDS).map((card) => {
        const element: Record<string, unknown> = {
          title: card.title.slice(0, MAX_CARD_TITLE),
        };
        if (card.subtitle) element.subtitle = card.subtitle.slice(0, MAX_CARD_SUBTITLE);
        if (card.image_url) element.image_url = card.image_url;
        if (card.default_action_url) {
          element.default_action = { type: 'web_url', url: card.default_action_url };
        }
        if (card.buttons && card.buttons.length > 0) {
          element.buttons = card.buttons.slice(0, MAX_CARD_BUTTONS).map((btn) => {
            if (
              btn.value &&
              (btn.value.startsWith('http://') || btn.value.startsWith('https://'))
            ) {
              return {
                type: 'web_url',
                title: btn.label.slice(0, MAX_BUTTON_TITLE),
                url: btn.value,
              };
            }
            return {
              type: 'postback',
              title: btn.label.slice(0, MAX_BUTTON_TITLE),
              payload: btn.id,
            };
          });
        }
        return element;
      });

      const message = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'generic',
            elements,
          },
        },
      };
      return { kind: 'messenger_template', message, text };
    }

    if (!actions || actions.elements.length === 0) {
      return { kind: 'text', text };
    }

    const buttons = actions.elements.filter((e) => e.type === 'button');
    const selects = actions.elements.filter((e) => e.type === 'select');

    // ≤3 buttons, no selects → button template
    if (buttons.length > 0 && buttons.length <= MAX_BUTTONS && selects.length === 0) {
      const message = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: text || 'Please choose:',
            buttons: buttons.map((btn) => ({
              type: 'postback',
              title: btn.label.slice(0, MAX_BUTTON_TITLE),
              payload: btn.id,
            })),
          },
        },
      };
      return { kind: 'messenger_template', message, text };
    }

    // >3 buttons or selects → quick replies
    const quickReplies: Array<{ content_type: string; title: string; payload: string }> = [];

    for (const btn of buttons) {
      if (quickReplies.length >= MAX_QUICK_REPLIES) break;
      quickReplies.push({
        content_type: 'text',
        title: btn.label.slice(0, MAX_QUICK_REPLY_TITLE),
        payload: btn.id,
      });
    }

    for (const sel of selects) {
      for (const opt of sel.options || []) {
        if (quickReplies.length >= MAX_QUICK_REPLIES) break;
        quickReplies.push({
          content_type: 'text',
          title: opt.label.slice(0, MAX_QUICK_REPLY_TITLE),
          payload: opt.id,
        });
      }
    }

    if (quickReplies.length === 0) {
      return { kind: 'text', text };
    }

    const message = {
      text: text || 'Please choose:',
      quick_replies: quickReplies,
    };

    return { kind: 'messenger_template', message, text };
  }
}
