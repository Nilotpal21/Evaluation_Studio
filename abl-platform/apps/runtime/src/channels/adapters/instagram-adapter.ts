/**
 * Instagram Messaging Channel Adapter
 *
 * Handles Instagram Messaging API webhooks and sends responses via Send API.
 *
 * - verifyRequest()     -> HMAC-SHA256 signature verification (app secret)
 * - parseIncoming()     -> Normalizes Instagram webhook -> NormalizedIncomingMessage
 * - sendResponse()      -> POST to Graph API /{igUserId}/messages endpoint
 * - transformOutput()   -> ActionSetIR -> Instagram quick replies / generic templates
 *
 * Supports: text, quick replies (max 13), generic templates (carousel, max 10)
 * Postback and quick_reply callbacks produce ActionEvent
 *
 * Key differences from Messenger:
 * - Webhook payload has object: 'instagram' (not 'page')
 * - Session key format: instagram:{igAccountId}:{senderId}
 * - No button templates (Instagram doesn't support them) — everything goes to quick replies
 * - sendResponse uses /{igUserId}/messages (not /me/messages)
 * - Instagram-specific skip types: share, story_mention, like_heart, reel
 *
 * Limits:
 * - Quick replies: max 13
 * - Quick reply title: 20 chars
 * - Generic template elements: max 10
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
import { META_GRAPH_API_VERSION, META_GRAPH_API_BASE } from './meta-constants.js';
import {
  buildChannelDeliveryFailure,
  buildChannelDeliveryLogContext,
  getChannelDeliveryErrorName,
  readNonEmptyDeliveryMetadataString,
} from '../../services/channel/delivery-diagnostics.js';

const log = createLogger('instagram-adapter');

// =============================================================================
// INSTAGRAM WEBHOOK TYPES
// =============================================================================

interface InstagramWebhookPayload {
  object: 'instagram';
  entry: Array<{
    id: string;
    time: number;
    messaging: Array<InstagramEvent>;
  }>;
}

interface InstagramAttachment {
  type:
    | 'image'
    | 'video'
    | 'audio'
    | 'file'
    | 'share'
    | 'story_mention'
    | 'like_heart'
    | 'reel'
    | 'sticker'
    | 'fallback';
  payload?: {
    url?: string;
  };
}

interface InstagramEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload: string };
    attachments?: InstagramAttachment[];
  };
  postback?: {
    title: string;
    payload: string;
  };
}

// =============================================================================
// INSTAGRAM LIMITS
// =============================================================================

const MAX_QUICK_REPLIES = 13;
const MAX_QUICK_REPLY_TITLE = 20;
const MAX_GENERIC_TEMPLATE_ELEMENTS = 10;

/** Attachment types to skip (Instagram-specific non-processable types) */
const SKIP_ATTACHMENT_TYPES = new Set([
  'share',
  'story_mention',
  'like_heart',
  'reel',
  'sticker',
  'fallback',
]);

/** Attachment types that are processable media */
const PROCESSABLE_ATTACHMENT_TYPES = new Set(['image', 'video', 'audio', 'file']);

// =============================================================================
// ADAPTER
// =============================================================================

export class InstagramAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'instagram';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: true,
    supportsStreaming: false,
    supportsMedia: true,
    supportsThreading: false,
  };

  /**
   * Verify Instagram's HMAC-SHA256 request signature.
   */
  async verifyRequest(
    headers: Record<string, string>,
    _body: unknown,
    rawBody?: Buffer | string,
    connection?: ResolvedConnection | null,
  ): Promise<boolean> {
    const appSecret =
      (connection?.credentials?.app_secret as string) || process.env.INSTAGRAM_APP_SECRET;
    if (!appSecret) {
      log.error('Instagram app secret not configured');
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
        'No channel connection found with matching verify_token — create an Instagram channel connection in Studio first',
      );
      return null;
    }

    if (token !== expectedToken) {
      log.warn('Instagram webhook verification token mismatch');
      return null;
    }

    log.info('Instagram webhook verification successful');
    return challenge;
  }

  /**
   * Extract Instagram account ID as external identifier.
   * Uses entry[0].id (canonical IG account ID) which is present on all entry types,
   * falling back to messaging[0].recipient.id for compatibility.
   */
  extractExternalIdentifier(body: unknown): string | null {
    const payload = body as InstagramWebhookPayload;
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
    const payload = body as InstagramWebhookPayload;
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
    const payload = body as InstagramWebhookPayload;
    const event = payload.entry?.[0]?.messaging?.[0];
    if (!event) return false;

    // Reject echo messages (sent by the account itself) to prevent infinite loops
    if (event.message?.is_echo) return false;

    // NOTE: No stale-event cutoff. Instagram retries delivery for up to 24 hours
    // after outages. Since shouldProcess returning false ACKs with 200 (telling Meta
    // delivery succeeded), a time-based cutoff would silently drop legitimate retries.
    // Replay protection is handled downstream by the idempotency dedup in the inbound
    // worker (Redis SET NX on message ID).

    // Process text messages, quick replies, postbacks, and processable attachments.
    // Attachment-only events with only non-processable types (share, story_mention,
    // like_heart, reel, sticker, fallback) are filtered out to avoid creating
    // blank runtime turns with no text, no action, and no media.
    const hasProcessableAttachment = event.message?.attachments?.some(
      (a) => PROCESSABLE_ATTACHMENT_TYPES.has(a.type) && a.payload?.url,
    );

    return !!(
      event.message?.text ||
      event.message?.quick_reply ||
      event.postback ||
      hasProcessableAttachment
    );
  }

  /**
   * Build NormalizedIncomingMessage from Instagram webhook payload.
   */
  buildNormalizedMessage(body: unknown): NormalizedIncomingMessage {
    const payload = body as InstagramWebhookPayload;
    const event = payload.entry?.[0]?.messaging?.[0];
    if (!event) {
      throw new Error('Invalid Instagram payload: missing messaging event');
    }
    const igAccountId = event.recipient?.id ?? payload.entry?.[0]?.id ?? 'unknown';
    const senderId = event.sender?.id ?? 'unknown';

    // Handle postback (button click)
    if (event.postback) {
      return {
        externalMessageId: `postback:${senderId}:${event.timestamp}`,
        externalSessionKey: `instagram:${igAccountId}:${senderId}`,
        text: '',
        actionEvent: requireNormalizedActionEvent({
          actionId: event.postback.payload,
          value: event.postback.payload,
          source: 'instagram',
        }),
        metadata: {
          instagramAccountId: igAccountId,
          instagramSenderId: senderId,
          instagramEventType: 'postback',
        },
        timestamp: new Date(event.timestamp),
      };
    }

    // Handle quick reply
    if (event.message?.quick_reply) {
      return {
        externalMessageId: event.message.mid,
        externalSessionKey: `instagram:${igAccountId}:${senderId}`,
        text: '',
        actionEvent: requireNormalizedActionEvent({
          actionId: event.message.quick_reply.payload,
          value: event.message.quick_reply.payload,
          source: 'instagram',
        }),
        metadata: {
          instagramAccountId: igAccountId,
          instagramSenderId: senderId,
          instagramEventType: 'quick_reply',
        },
        timestamp: new Date(event.timestamp),
      };
    }

    // Extract downloadable media attachments (skip share, story_mention, like_heart, reel, etc.)
    const instagramMediaReferences = (event.message?.attachments ?? [])
      .filter((a) => PROCESSABLE_ATTACHMENT_TYPES.has(a.type) && a.payload?.url)
      .map((a) => ({
        type: a.type as 'image' | 'video' | 'audio' | 'file',
        url: a.payload!.url!,
      }));

    // Standard text message (may also include attachments)
    return {
      externalMessageId: event.message!.mid,
      externalSessionKey: `instagram:${igAccountId}:${senderId}`,
      text: event.message!.text || '',
      metadata: {
        instagramAccountId: igAccountId,
        instagramSenderId: senderId,
        ...(instagramMediaReferences.length > 0 && { instagramMediaReferences }),
      },
      timestamp: new Date(event.timestamp),
    };
  }

  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  /**
   * Send response via Instagram Messaging Send API.
   *
   * Unlike Messenger which uses /me/messages, Instagram uses
   * /{igUserId}/messages where igUserId is the connection's externalIdentifier.
   */
  async sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult> {
    const accessToken =
      (connection.credentials?.page_access_token as string) ||
      process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;

    if (!accessToken) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'instagram',
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        operatorMessage: 'No Instagram page access token was available for outbound delivery.',
        retryable: false,
      });
    }

    const recipientId = readNonEmptyDeliveryMetadataString(message.metadata?.instagramSenderId);
    if (!recipientId) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'instagram',
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        operatorMessage: 'No Instagram recipient ID was present in message metadata.',
        retryable: false,
      });
    }

    const igUserId = connection.externalIdentifier;
    if (!igUserId) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'instagram',
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        operatorMessage: 'No Instagram user ID was present on the channel connection.',
        retryable: false,
      });
    }

    try {
      const channelOutput = message.metadata?.channelOutput as ChannelOutput | undefined;

      let body: Record<string, unknown>;
      if (channelOutput?.kind === 'instagram_template') {
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

      const url = `${META_GRAPH_API_BASE}/${META_GRAPH_API_VERSION}/${igUserId}/messages`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();

        // Surface expired messaging window error clearly
        if (resp.status === 400 && errText.includes('Cannot send message')) {
          log.error(
            'Instagram messaging window expired',
            buildChannelDeliveryLogContext({
              channelType: this.channelType,
              provider: 'instagram',
              httpStatus: resp.status,
            }),
          );
          return buildChannelDeliveryFailure({
            channelType: this.channelType,
            provider: 'instagram',
            category: 'provider',
            code: 'CHANNEL_PROVIDER_REJECTED',
            operatorMessage:
              'Instagram Messaging API rejected delivery because the messaging window expired.',
            httpStatus: resp.status,
            retryable: false,
          });
        }

        log.error(
          'Instagram API error',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'instagram',
            httpStatus: resp.status,
          }),
        );
        return buildChannelDeliveryFailure({
          channelType: this.channelType,
          provider: 'instagram',
          category: 'provider',
          code: 'CHANNEL_PROVIDER_REJECTED',
          operatorMessage: 'Instagram Messaging API rejected the outbound response.',
          httpStatus: resp.status,
          retryable: false,
        });
      }

      const result = (await resp.json()) as { message_id?: string };
      log.info('Instagram message sent', { recipientId, messageId: result.message_id });
      return { success: true, deliveryId: result.message_id };
    } catch (error) {
      const code =
        error instanceof Error && error.name === 'AbortError'
          ? 'CHANNEL_DELIVERY_TIMEOUT'
          : 'CHANNEL_DELIVERY_FAILED';
      log.error(
        'Failed to send Instagram message',
        buildChannelDeliveryLogContext({
          channelType: this.channelType,
          provider: 'instagram',
          code,
          errorName: getChannelDeliveryErrorName(error),
        }),
      );
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'instagram',
        category: 'network',
        code,
        operatorMessage: 'Instagram Messaging API failed before a provider response was available.',
        retryable: true,
      });
    }
  }

  /**
   * Send a typing indicator ("typing_on" sender action) to Instagram.
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
        process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
      if (!accessToken) return;

      const recipientId = readNonEmptyDeliveryMetadataString(metadata?.instagramSenderId);
      if (!recipientId) return;

      const igUserId = connection.externalIdentifier;
      if (!igUserId) return;

      const url = `${META_GRAPH_API_BASE}/${META_GRAPH_API_VERSION}/${igUserId}/messages`;
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
          'Instagram typing indicator failed',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'instagram',
            httpStatus: resp.status,
          }),
        );
      }
    } catch (err) {
      log.warn('Instagram typing indicator failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Transform ActionSetIR into Instagram format.
   *
   * Strategy:
   * - RichContentIR with cards JSON -> generic template (carousel, max 10 elements)
   * - Any buttons or selects -> quick replies (max 13)
   * - Inputs -> text fallback (Instagram doesn't support form inputs in messages)
   *
   * NOTE: Instagram does NOT support button templates (unlike Messenger).
   * All interactive elements go to quick replies or generic templates.
   */
  transformOutput(text: string, actions?: ActionSetIR, richContent?: RichContentIR): ChannelOutput {
    // Check for generic template cards in richContent
    if (richContent?.markdown) {
      const templateOutput = this.parseGenericTemplate(richContent.markdown, text);
      if (templateOutput) return templateOutput;
    }

    if (!actions || actions.elements.length === 0) {
      return { kind: 'text', text };
    }

    const buttons = actions.elements.filter((e) => e.type === 'button');
    const selects = actions.elements.filter((e) => e.type === 'select');

    // All buttons and selects go to quick replies (no button templates on Instagram)
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

    return { kind: 'instagram_template', message, text };
  }

  /**
   * Parse richContent.markdown as JSON cards for Instagram generic template.
   *
   * Expected JSON shape:
   * {
   *   "cards": [
   *     {
   *       "title": "Product Name",
   *       "subtitle": "Description",
   *       "image_url": "https://...",
   *       "buttons": [{ "title": "Buy", "payload": "buy_product" }]
   *     }
   *   ]
   * }
   *
   * Returns null if markdown is not valid card JSON, allowing fallback to
   * standard quick reply / text logic.
   */
  private parseGenericTemplate(markdownJson: string, fallbackText: string): ChannelOutput | null {
    try {
      const parsed = JSON.parse(markdownJson);

      if (!parsed.cards || !Array.isArray(parsed.cards) || parsed.cards.length === 0) {
        return null;
      }

      const elements = parsed.cards
        .slice(0, MAX_GENERIC_TEMPLATE_ELEMENTS)
        .map(
          (card: {
            title?: string;
            subtitle?: string;
            image_url?: string;
            buttons?: Array<{ title?: string; payload?: string; url?: string }>;
          }) => {
            const element: Record<string, unknown> = {
              title: card.title || fallbackText || 'Item',
            };

            if (card.subtitle) element.subtitle = card.subtitle;
            if (card.image_url) element.image_url = card.image_url;

            if (card.buttons && card.buttons.length > 0) {
              element.buttons = card.buttons.slice(0, 3).map((btn) => {
                if (btn.url) {
                  return {
                    type: 'web_url',
                    title: btn.title || 'Open',
                    url: btn.url,
                  };
                }
                return {
                  type: 'postback',
                  title: btn.title || 'Select',
                  payload: btn.payload || btn.title || 'select',
                };
              });
            }

            return element;
          },
        );

      const message = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'generic',
            elements,
          },
        },
      };

      return { kind: 'instagram_template', message, text: fallbackText };
    } catch {
      // Not valid JSON — fall through to standard logic
      return null;
    }
  }
}
