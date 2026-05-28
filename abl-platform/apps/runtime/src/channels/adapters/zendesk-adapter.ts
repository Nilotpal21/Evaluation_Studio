/**
 * Zendesk Sunshine Conversations (Smooch API v2) Channel Adapter
 *
 * Handles Zendesk Sunshine webhook events and sends responses via the Smooch REST API.
 *
 * - verifyRequest()           -> HMAC-SHA256 via x-api-key header (webhook_secret)
 * - parseIncoming()           -> Returns pre-built normalized message
 * - sendResponse()            -> POST to Sunshine conversations API with Basic Auth
 * - transformOutput()         -> ActionSetIR -> zendesk_actions with reply buttons
 * - buildNormalizedMessage()  -> Normalizes Sunshine webhook -> NormalizedIncomingMessage
 *
 * Supports: conversation:message (user text), conversation:postback (button callbacks)
 * Ignores: business (bot) messages to avoid loops
 */

import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import type { ActionSetIR } from '@abl/compiler';
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
  getChannelDeliveryErrorName,
  readNonEmptyDeliveryMetadataString,
} from '../../services/channel/delivery-diagnostics.js';

const log = createLogger('zendesk-adapter');

// =============================================================================
// SUNSHINE WEBHOOK TYPES
// =============================================================================

interface SunshineWebhookPayload {
  app: { id: string };
  webhook: { id: string; version: string };
  events: Array<{
    id: string;
    type: string;
    createdAt: string;
    payload: {
      message?: {
        id: string;
        received: string;
        author: { type: string; userId: string; displayName?: string };
        content: { type: string; text?: string };
      };
      conversation?: { id: string; type: string };
      postback?: { payload: string; text: string };
      user?: { id: string };
    };
  }>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const SUNSHINE_API_BASE = 'https://api.smooch.io/v2';
const MAX_ACTION_LABEL_LENGTH = 128;

// =============================================================================
// HTML FILTERING
// =============================================================================

/**
 * Filter HTML tags from Zendesk message text.
 *
 * - Converts `<a href="mailto:...">text</a>` to the email address
 * - Converts `<a>text</a>` to the link text
 * - Converts `<br>` / `<br/>` to newlines
 * - Strips all other HTML tags
 * - Decodes common HTML entities
 */
function filterHtmlTags(text: string): string {
  let result = text;

  // Convert mailto links to email address
  result = result.replace(/<a\s+href="mailto:([^"]*)"[^>]*>[^<]*<\/a>/gi, '$1');

  // Convert other anchor tags to their text content
  result = result.replace(/<a[^>]*>([^<]*)<\/a>/gi, '$1');

  // Convert <br> variants to newline
  result = result.replace(/<br\s*\/?>/gi, '\n');

  // Strip all remaining HTML tags
  result = result.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  result = result
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  return result;
}

// =============================================================================
// ADAPTER
// =============================================================================

export class ZendeskAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'zendesk';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: true,
    supportsStreaming: false,
    supportsMedia: true,
    supportsThreading: true,
  };

  /**
   * Verify Zendesk Sunshine webhook request using HMAC-SHA256.
   *
   * If webhook_secret is configured in connection credentials, verifies the
   * x-api-key header contains a valid HMAC-SHA256 signature of the raw body.
   * If no webhook_secret is configured, verification is skipped (returns true).
   */
  async verifyRequest(
    headers: Record<string, string>,
    _body: unknown,
    rawBody?: Buffer | string,
    connection?: ResolvedConnection | null,
  ): Promise<boolean> {
    const webhookSecret = connection?.credentials?.webhook_secret as string | undefined;

    // If no webhook secret configured, skip verification
    if (!webhookSecret) {
      return true;
    }

    const signature = headers['x-api-key'];
    if (!signature) {
      log.warn('Missing x-api-key header for Zendesk webhook verification');
      return false;
    }

    const bodyStr = rawBody
      ? typeof rawBody === 'string'
        ? rawBody
        : rawBody.toString('utf8')
      : JSON.stringify(_body);

    const expected = crypto.createHmac('sha256', webhookSecret).update(bodyStr).digest('hex');

    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch (err) {
      log.debug('HMAC comparison failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Extract app ID as external identifier for connection resolution.
   */
  extractExternalIdentifier(body: unknown): string | null {
    const payload = body as SunshineWebhookPayload;
    return payload.app?.id || null;
  }

  /**
   * Extract event ID for deduplication.
   */
  extractEventId(body: unknown): string | null {
    const payload = body as SunshineWebhookPayload;
    return payload.events?.[0]?.id || null;
  }

  /**
   * Check if this webhook event should be processed.
   *
   * Accepts:
   * - conversation:message with author.type !== 'business'
   * - conversation:postback
   *
   * Rejects: business messages, empty events, unknown event types.
   */
  shouldProcess(body: unknown): boolean {
    const payload = body as SunshineWebhookPayload;
    const events = payload.events;
    if (!events || events.length === 0) return false;

    const event = events[0];
    const eventType = event.type;

    if (eventType === 'conversation:postback') {
      return true;
    }

    if (eventType === 'conversation:message') {
      const authorType = event.payload?.message?.author?.type;
      // Reject business (bot) messages to avoid loops
      if (authorType === 'business') return false;
      return true;
    }

    return false;
  }

  /**
   * Build NormalizedIncomingMessage from Zendesk Sunshine webhook payload.
   */
  buildNormalizedMessage(body: unknown): NormalizedIncomingMessage {
    const payload = body as SunshineWebhookPayload;
    const event = payload.events[0];
    const appId = payload.app.id;
    const conversationId = event.payload.conversation?.id ?? 'unknown';

    // Handle postback events
    if (event.type === 'conversation:postback') {
      const postback = event.payload.postback!;
      const userId = event.payload.user?.id ?? 'unknown';

      return {
        externalMessageId: event.id,
        externalSessionKey: `zendesk:${appId}:${conversationId}`,
        text: '',
        actionEvent: requireNormalizedActionEvent({
          actionId: postback.payload,
          value: postback.payload,
          source: 'zendesk',
        }),
        metadata: {
          zendeskAppId: appId,
          zendeskConversationId: conversationId,
          zendeskAuthorId: userId,
        },
        timestamp: new Date(event.createdAt),
      };
    }

    // Handle conversation:message
    const message = event.payload.message!;
    const rawText = message.content.text ?? '';
    const text = filterHtmlTags(rawText);

    return {
      externalMessageId: message.id,
      externalSessionKey: `zendesk:${appId}:${conversationId}`,
      text,
      metadata: {
        zendeskAppId: appId,
        zendeskConversationId: conversationId,
        zendeskAuthorId: message.author.userId,
      },
      timestamp: new Date(event.createdAt),
    };
  }

  /**
   * Parse an inbound job payload into a normalized message.
   * The payload.message is already set by the webhook route using buildNormalizedMessage().
   */
  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  /**
   * Transform plain text + optional ActionSetIR into Zendesk-native output.
   *
   * - No actions -> plain text
   * - Buttons -> zendesk_actions with reply actions
   */
  transformOutput(text: string, actions?: ActionSetIR): ChannelOutput {
    if (!actions || actions.elements.length === 0) {
      return { kind: 'text', text };
    }

    const buttons = actions.elements.filter((e) => e.type === 'button');

    if (buttons.length === 0) {
      return { kind: 'text', text };
    }

    const zendeskActions = buttons.map((btn) => ({
      type: 'reply',
      text: btn.label.slice(0, MAX_ACTION_LABEL_LENGTH),
      payload: btn.id,
    }));

    return {
      kind: 'zendesk_actions',
      content: {
        type: 'text',
        text,
        actions: zendeskActions,
      },
      text,
    };
  }

  /**
   * Send a response back to Zendesk via Sunshine Conversations API.
   *
   * Uses Basic Auth with keyId:keySecret encoded in base64.
   * POST /v2/apps/{appId}/conversations/{conversationId}/messages
   */
  async sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult> {
    const keyId = connection.credentials?.key_id as string | undefined;
    const keySecret = connection.credentials?.key_secret as string | undefined;

    if (!keyId || !keySecret) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'zendesk',
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        operatorMessage:
          'No Zendesk Sunshine key ID or key secret was available for outbound delivery.',
        retryable: false,
      });
    }

    const appId = readNonEmptyDeliveryMetadataString(message.metadata?.zendeskAppId);
    const conversationId = readNonEmptyDeliveryMetadataString(
      message.metadata?.zendeskConversationId,
    );

    if (!appId || !conversationId) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'zendesk',
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        operatorMessage: 'Zendesk delivery metadata was missing app ID or conversation ID.',
        retryable: false,
      });
    }

    try {
      const channelOutput = message.metadata?.channelOutput as ChannelOutput | undefined;

      let content: Record<string, unknown>;
      if (channelOutput?.kind === 'zendesk_actions') {
        content = channelOutput.content;
      } else {
        content = { type: 'text', text: message.text };
      }

      const authToken = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
      const url = `${SUNSHINE_API_BASE}/apps/${encodeURIComponent(appId)}/conversations/${encodeURIComponent(conversationId)}/messages`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          author: { type: 'business' },
          content,
        }),
      });

      if (!response.ok) {
        log.error(
          'Zendesk Sunshine API error',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'zendesk',
            httpStatus: response.status,
          }),
        );
        return buildChannelDeliveryFailure({
          channelType: this.channelType,
          provider: 'zendesk',
          category: 'provider',
          code: 'CHANNEL_PROVIDER_REJECTED',
          operatorMessage: 'Zendesk Sunshine Conversations API rejected the outbound response.',
          httpStatus: response.status,
          retryable: false,
        });
      }

      const result = (await response.json()) as { messages?: Array<{ id: string }> };
      const messageId = result.messages?.[0]?.id;
      log.info('Zendesk message sent', { conversationId, messageId });
      return { success: true, deliveryId: messageId };
    } catch (error) {
      const code =
        error instanceof Error && error.name === 'AbortError'
          ? 'CHANNEL_DELIVERY_TIMEOUT'
          : 'CHANNEL_DELIVERY_FAILED';
      log.error(
        'Failed to send Zendesk message',
        buildChannelDeliveryLogContext({
          channelType: this.channelType,
          provider: 'zendesk',
          code,
          errorName: getChannelDeliveryErrorName(error),
        }),
      );
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'zendesk',
        category: 'network',
        code,
        operatorMessage:
          'Zendesk Sunshine Conversations API failed before a provider response was available.',
        retryable: true,
      });
    }
  }
}
