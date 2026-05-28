/**
 * Meta Cloud API WhatsApp Provider
 *
 * Implements WhatsAppProvider for Meta's Cloud API (graph.facebook.com).
 * Extracted from WhatsAppAdapter — all Meta-specific logic lives here.
 *
 * - verifyRequest()     → HMAC-SHA256 signature verification (app secret)
 * - sendResponse()      → POST to Graph API /messages endpoint
 * - transformOutput()   → ActionSetIR → WhatsApp interactive buttons/lists
 *
 * Supports: text, interactive buttons (max 3), interactive lists (max 10 rows),
 * reactions, contact cards, location
 * Interactive reply callbacks produce ActionEvent with button_reply or list_reply
 *
 * Limits:
 * - Button labels: 20 chars
 * - Button IDs: 256 chars
 * - Interactive buttons: max 3
 * - List rows: max 10
 * - List row title: 24 chars
 */

import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import type { ActionSetIR, RichContentIR } from '@abl/compiler';
import type {
  ChannelOutput,
  NormalizedIncomingMessage,
  NormalizedOutgoingMessage,
  ResolvedConnection,
  SendResult,
} from '../../types.js';
import type { WhatsAppProvider } from '../whatsapp-provider.js';
import { META_GRAPH_API_VERSION, META_GRAPH_API_BASE } from '../meta-constants.js';
import { transformWhatsAppOutput } from './whatsapp-transform.js';
import { requireNormalizedActionEvent } from '../../../services/channels/action-event-validation.js';
import {
  buildChannelDeliveryFailure,
  buildChannelDeliveryLogContext,
  getChannelDeliveryErrorName,
  readNonEmptyDeliveryMetadataString,
} from '../../../services/channel/delivery-diagnostics.js';

const log = createLogger('meta-cloud-provider');

// =============================================================================
// WHATSAPP WEBHOOK TYPES
// =============================================================================

interface WhatsAppWebhookPayload {
  object: 'whatsapp_business_account';
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: 'whatsapp';
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: Array<{ profile: { name: string }; wa_id: string }>;
        messages?: Array<WhatsAppMessage>;
      };
      field: 'messages';
    }>;
  }>;
}

/** WhatsApp media object — shared structure across image, document, audio, video. */
interface WhatsAppMediaObject {
  id: string;
  mime_type: string;
  sha256: string;
  caption?: string;
  filename?: string; // Only present on document type
}

interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp: string;
  type:
    | 'text'
    | 'interactive'
    | 'button'
    | 'image'
    | 'audio'
    | 'video'
    | 'document'
    | 'reaction'
    | 'contacts'
    | 'location';
  text?: { body: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  // Template quick_reply button callback — populated when type is 'button'
  button?: { text: string; payload: string };
  // Reaction field — populated when type is 'reaction'
  reaction?: { message_id: string; emoji: string };
  // Media message fields — populated when type is image/audio/video/document
  image?: WhatsAppMediaObject;
  audio?: WhatsAppMediaObject;
  video?: WhatsAppMediaObject;
  document?: WhatsAppMediaObject;
  // Location field — populated when type is 'location'
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  // Contact card fields — populated when type is 'contacts'
  contacts?: Array<{
    name: { formatted_name?: string; first_name?: string; last_name?: string };
    phones?: Array<{ phone: string; type?: string }>;
    emails?: Array<{ email: string; type?: string }>;
  }>;
}

// =============================================================================
// WHATSAPP LIMITS
// =============================================================================

/**
 * Replay protection window: reject events older than 5 minutes.
 * WhatsApp timestamps are in seconds (not ms), so conversion is needed.
 */
const MAX_EVENT_AGE_MS = 5 * 60 * 1000; // 300_000ms

// =============================================================================
// META CLOUD PROVIDER
// =============================================================================

export class MetaCloudProvider implements WhatsAppProvider {
  readonly providerId = 'meta_cloud';

  /**
   * Verify WhatsApp's HMAC-SHA256 request signature.
   * Meta signs webhooks with: HMAC-SHA256(app_secret, rawBody)
   */
  async verifyRequest(
    headers: Record<string, string>,
    _body: unknown,
    rawBody?: Buffer | string,
    connection?: ResolvedConnection | null,
  ): Promise<boolean> {
    const appSecret =
      (connection?.credentials?.app_secret as string) || process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) {
      log.error('WhatsApp app secret not configured');
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
    } catch (err) {
      log.debug('HMAC comparison failed', {
        error: err instanceof Error ? err.message : String(err),
      });
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
        'No channel connection found with matching verify_token — create a WhatsApp channel connection in Studio first',
      );
      return null;
    }

    if (token !== expectedToken) {
      log.warn('WhatsApp webhook verification token mismatch');
      return null;
    }

    log.info('WhatsApp webhook verification successful');
    return challenge;
  }

  /**
   * Extract phone_number_id as external identifier for connection resolution.
   */
  extractExternalIdentifier(body: unknown): string | null {
    const payload = body as WhatsAppWebhookPayload;
    return payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id || null;
  }

  /**
   * Extract message ID for deduplication.
   */
  extractEventId(body: unknown): string | null {
    const payload = body as WhatsAppWebhookPayload;
    const msg = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    return msg?.id || null;
  }

  /**
   * Check if this webhook contains a processable message.
   */
  shouldProcess(body: unknown): boolean {
    const payload = body as WhatsAppWebhookPayload;
    const messages = payload.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages || messages.length === 0) return false;

    const msg = messages[0];

    // Reject stale or future events (replay protection)
    // WhatsApp timestamps are in seconds, not milliseconds
    if (msg.timestamp) {
      const eventTimeMs = parseInt(msg.timestamp, 10) * 1000;
      if (Number.isNaN(eventTimeMs)) return false;
      const eventAge = Date.now() - eventTimeMs;
      if (eventAge > MAX_EVENT_AGE_MS || eventAge < -60_000) {
        log.warn('Rejecting stale or future WhatsApp event', {
          eventAge,
          timestamp: msg.timestamp,
        });
        return false;
      }
    }

    // Process text messages, interactive replies, and media messages
    const processableTypes = [
      'text',
      'interactive',
      'button',
      'image',
      'audio',
      'video',
      'document',
      'reaction',
      'contacts',
      'location',
    ];
    return processableTypes.includes(msg.type);
  }

  /**
   * Build NormalizedIncomingMessage from WhatsApp webhook payload.
   */
  buildNormalizedMessage(body: unknown): NormalizedIncomingMessage {
    const payload = body as WhatsAppWebhookPayload;
    const change = payload.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (!change || !msg) {
      throw new Error('Invalid WhatsApp payload: missing message data');
    }
    const phoneNumberId = change.metadata?.phone_number_id ?? 'unknown';
    const contact = change.contacts?.[0];

    // Handle interactive replies (button or list)
    if (msg.type === 'interactive' && msg.interactive) {
      const interactive = msg.interactive;
      const isButton = interactive.type === 'button_reply';
      const reply = isButton ? interactive.button_reply! : interactive.list_reply!;

      return {
        externalMessageId: msg.id,
        externalSessionKey: `whatsapp:${phoneNumberId}:${msg.from}`,
        text: '',
        actionEvent: requireNormalizedActionEvent({
          actionId: reply.id,
          value: reply.id,
          source: 'whatsapp',
        }),
        metadata: {
          whatsappPhoneNumberId: phoneNumberId,
          whatsappFrom: msg.from,
          whatsappContactName: contact?.profile?.name,
          whatsappInteractionType: interactive.type,
        },
        timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
      };
    }

    // Handle template quick_reply button callbacks (type: 'button')
    if (msg.type === 'button' && msg.button) {
      return {
        externalMessageId: msg.id,
        externalSessionKey: `whatsapp:${phoneNumberId}:${msg.from}`,
        text: '',
        actionEvent: requireNormalizedActionEvent({
          actionId: msg.button.payload,
          value: msg.button.payload,
          source: 'whatsapp',
        }),
        metadata: {
          whatsappPhoneNumberId: phoneNumberId,
          whatsappFrom: msg.from,
          whatsappContactName: contact?.profile?.name,
          whatsappInteractionType: 'template_quick_reply',
        },
        timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
      };
    }

    // Handle reaction messages
    if (msg.type === 'reaction' && msg.reaction) {
      const emoji = msg.reaction.emoji || '';
      return {
        externalMessageId: msg.id,
        externalSessionKey: `whatsapp:${phoneNumberId}:${msg.from}`,
        text: emoji,
        metadata: {
          whatsappPhoneNumberId: phoneNumberId,
          whatsappFrom: msg.from,
          whatsappContactName: contact?.profile?.name,
          isReaction: true,
          reactionMessageId: msg.reaction.message_id,
          ...(emoji === '' && { reactionRemoved: true }),
        },
        timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
      };
    }

    // Handle contact card messages
    if (msg.type === 'contacts' && msg.contacts) {
      const contactLines = msg.contacts.map((c) => {
        const name = c.name?.formatted_name || c.name?.first_name || 'Unknown';
        const details: string[] = [];
        if (c.phones?.[0]?.phone) details.push(c.phones[0].phone);
        if (c.emails?.[0]?.email) details.push(c.emails[0].email);
        return details.length > 0
          ? `Shared contact: ${name} (${details.join(', ')})`
          : `Shared contact: ${name}`;
      });

      return {
        externalMessageId: msg.id,
        externalSessionKey: `whatsapp:${phoneNumberId}:${msg.from}`,
        text: contactLines.join('\n'),
        metadata: {
          whatsappPhoneNumberId: phoneNumberId,
          whatsappFrom: msg.from,
          whatsappContactName: contact?.profile?.name,
          contacts: msg.contacts,
        },
        timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
      };
    }

    // Handle location messages
    if (msg.type === 'location' && msg.location) {
      const { latitude, longitude, name, address } = msg.location;
      const text = name
        ? `Location: ${name} (${latitude}, ${longitude})`
        : `Location: ${latitude}, ${longitude}`;

      return {
        externalMessageId: msg.id,
        externalSessionKey: `whatsapp:${phoneNumberId}:${msg.from}`,
        text,
        metadata: {
          whatsappPhoneNumberId: phoneNumberId,
          whatsappFrom: msg.from,
          whatsappContactName: contact?.profile?.name,
          location: msg.location,
        },
        timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
      };
    }

    // Handle media messages (image, document, audio, video)
    const mediaTypes = ['image', 'audio', 'video', 'document'] as const;
    const mediaType = mediaTypes.find((t) => t === msg.type);
    if (mediaType) {
      const mediaObj = msg[mediaType];
      const whatsappMediaReferences = mediaObj
        ? [
            {
              mediaId: mediaObj.id,
              mimeType: mediaObj.mime_type,
              mediaType,
              filename: mediaObj.filename,
            },
          ]
        : [];

      // Use caption as text (documents, images, videos can have captions)
      const caption = mediaObj?.caption ?? '';

      return {
        externalMessageId: msg.id,
        externalSessionKey: `whatsapp:${phoneNumberId}:${msg.from}`,
        text: caption,
        metadata: {
          whatsappPhoneNumberId: phoneNumberId,
          whatsappFrom: msg.from,
          whatsappContactName: contact?.profile?.name,
          whatsappMediaReferences,
        },
        timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
      };
    }

    // Standard text message
    return {
      externalMessageId: msg.id,
      externalSessionKey: `whatsapp:${phoneNumberId}:${msg.from}`,
      text: msg.text?.body || '',
      metadata: {
        whatsappPhoneNumberId: phoneNumberId,
        whatsappFrom: msg.from,
        whatsappContactName: contact?.profile?.name,
      },
      timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
    };
  }

  /**
   * Send response via WhatsApp Cloud API Graph endpoint.
   */
  async sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult> {
    const accessToken =
      (connection.credentials?.access_token as string) || process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = connection.externalIdentifier;

    if (!accessToken) {
      return buildChannelDeliveryFailure({
        channelType: 'whatsapp',
        provider: this.providerId,
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        operatorMessage: 'No Meta Cloud access token was available for outbound delivery.',
        retryable: false,
      });
    }

    const to = readNonEmptyDeliveryMetadataString(message.metadata?.whatsappFrom);
    if (!to) {
      return buildChannelDeliveryFailure({
        channelType: 'whatsapp',
        provider: this.providerId,
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        operatorMessage: 'No WhatsApp recipient phone number was present in message metadata.',
        retryable: false,
      });
    }

    try {
      const channelOutput = message.metadata?.channelOutput as ChannelOutput | undefined;

      let body: Record<string, unknown>;
      if (channelOutput?.kind === 'whatsapp_template') {
        body = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'template',
          template: channelOutput.template,
        };
      } else if (channelOutput?.kind === 'whatsapp_interactive') {
        body = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'interactive',
          interactive: channelOutput.interactive,
        };
      } else {
        body = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: message.text },
        };
      }

      const url = `${META_GRAPH_API_BASE}/${META_GRAPH_API_VERSION}/${phoneNumberId}/messages`;
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
          'WhatsApp API error',
          buildChannelDeliveryLogContext({
            channelType: 'whatsapp',
            provider: this.providerId,
            httpStatus: resp.status,
          }),
        );
        return buildChannelDeliveryFailure({
          channelType: 'whatsapp',
          provider: this.providerId,
          category: 'provider',
          code: 'CHANNEL_PROVIDER_REJECTED',
          operatorMessage: 'Meta Cloud rejected the outbound WhatsApp message.',
          httpStatus: resp.status,
          retryable: false,
        });
      }

      const result = (await resp.json()) as { messages?: Array<{ id: string }> };
      const messageId = result.messages?.[0]?.id;
      log.info('WhatsApp message sent', { to, messageId });
      return { success: true, deliveryId: messageId };
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      const code = isAbort ? 'CHANNEL_DELIVERY_TIMEOUT' : 'CHANNEL_DELIVERY_FAILED';
      log.error(
        'Failed to send WhatsApp message',
        buildChannelDeliveryLogContext({
          channelType: 'whatsapp',
          provider: this.providerId,
          code,
          errorName: getChannelDeliveryErrorName(error),
        }),
      );
      return buildChannelDeliveryFailure({
        channelType: 'whatsapp',
        provider: this.providerId,
        category: 'network',
        code,
        operatorMessage: 'Meta Cloud delivery failed before the provider confirmed the message.',
        retryable: true,
      });
    }
  }

  /**
   * Transform ActionSetIR into WhatsApp interactive format, or use a
   * WhatsApp message template when richContent.whatsapp is present.
   *
   * Delegates to shared whatsapp-transform utility.
   */
  transformOutput(text: string, actions?: ActionSetIR, richContent?: RichContentIR): ChannelOutput {
    return transformWhatsAppOutput(text, actions, richContent);
  }
}
