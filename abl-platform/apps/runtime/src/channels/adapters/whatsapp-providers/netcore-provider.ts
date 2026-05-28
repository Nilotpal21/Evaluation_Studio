/**
 * Netcore WhatsApp Provider
 *
 * Implements WhatsAppProvider for Netcore's WhatsApp API.
 * Handles inbound message normalization for all supported message types:
 * TEXT, IMAGE, VIDEO, AUDIO, DOCUMENT, LOCATION, INTERACTIVE.
 *
 * Netcore webhook payloads use a different structure than Meta Cloud API:
 * - Top-level `incoming_message` array instead of `entry[].changes[].value.messages`
 * - `from`/`to` at the message level
 * - Message type in `message_type` (uppercase, e.g., 'TEXT' not 'text')
 * - Media referenced by ID (no direct URL)
 * - No webhook signature verification
 */

import { createHash } from 'node:crypto';
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
import { requireNormalizedActionEvent } from '../../../services/channels/action-event-validation.js';
import {
  buildChannelDeliveryFailure,
  buildChannelDeliveryLogContext,
  getChannelDeliveryErrorName,
  readNonEmptyDeliveryMetadataString,
} from '../../../services/channel/delivery-diagnostics.js';
import { transformWhatsAppOutput } from './whatsapp-transform.js';

const log = createLogger('netcore-provider');

// =============================================================================
// NETCORE WEBHOOK TYPES
// =============================================================================

interface NetcoreWebhookPayload {
  incoming_message?: Array<NetcoreMessage>;
}

interface NetcoreMessage {
  from: string;
  to: string;
  message_type: string;
  text_type?: Array<{ text: string }>;
  image_type?: { id: string; filename?: string; mime_type?: string };
  video_type?: { id: string; filename?: string; mime_type?: string };
  document_type?: { id: string; filename?: string; mime_type?: string };
  audio_type?: { id: string; filename?: string; mime_type?: string };
  location_type?: { latitude: number; longitude: number; address?: string };
  interactive_type?: {
    type: string;
    button_reply?: { id: string; title?: string };
    list_reply?: { id: string; title?: string };
  };
}

// =============================================================================
// CONSTANTS
// =============================================================================

const PROCESSABLE_MESSAGE_TYPES = new Set([
  'TEXT',
  'IMAGE',
  'VIDEO',
  'DOCUMENT',
  'AUDIO',
  'LOCATION',
  'INTERACTIVE',
]);

const MEDIA_MESSAGE_TYPES = new Set(['IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO']);

const DEFAULT_BASE_URL = 'https://cpaaswa.netcorecloud.net/api/v2/message/nc';

// =============================================================================
// HELPERS
// =============================================================================

function mapNetcoreMediaType(type: string): 'image' | 'video' | 'audio' | 'document' {
  switch (type) {
    case 'IMAGE':
      return 'image';
    case 'VIDEO':
      return 'video';
    case 'AUDIO':
      return 'audio';
    case 'DOCUMENT':
      return 'document';
    default:
      return 'document';
  }
}

function getMediaInfo(
  message: NetcoreMessage,
): { mediaId: string; mimeType: string; mediaType: string; filename?: string } | null {
  const type = message.message_type;
  switch (type) {
    case 'IMAGE': {
      const media = message.image_type;
      if (!media) return null;
      return {
        mediaId: media.id,
        mimeType: media.mime_type || '',
        mediaType: mapNetcoreMediaType(type),
        filename: media.filename,
      };
    }
    case 'VIDEO': {
      const media = message.video_type;
      if (!media) return null;
      return {
        mediaId: media.id,
        mimeType: media.mime_type || '',
        mediaType: mapNetcoreMediaType(type),
        filename: media.filename,
      };
    }
    case 'DOCUMENT': {
      const media = message.document_type;
      if (!media) return null;
      return {
        mediaId: media.id,
        mimeType: media.mime_type || '',
        mediaType: mapNetcoreMediaType(type),
        filename: media.filename,
      };
    }
    case 'AUDIO': {
      const media = message.audio_type;
      if (!media) return null;
      return {
        mediaId: media.id,
        mimeType: media.mime_type || '',
        mediaType: mapNetcoreMediaType(type),
        filename: media.filename,
      };
    }
    default:
      return null;
  }
}

// =============================================================================
// NETCORE PROVIDER
// =============================================================================

export class NetcoreProvider implements WhatsAppProvider {
  readonly providerId = 'netcore';

  /**
   * Netcore does not use webhook signature verification.
   * Security is handled at the network/IP-allowlist level.
   */
  async verifyRequest(
    _headers: Record<string, string>,
    _body: unknown,
    _rawBody?: Buffer | string,
    _connection?: ResolvedConnection | null,
  ): Promise<boolean> {
    log.debug('Netcore does not use webhook signature verification');
    return true;
  }

  /**
   * Extract the Netcore phone number (`incoming_message[0].to`) as external identifier
   * for connection resolution.
   */
  extractExternalIdentifier(body: unknown): string | null {
    const payload = body as NetcoreWebhookPayload;
    return payload.incoming_message?.[0]?.to || null;
  }

  /**
   * Generate a deterministic message ID for deduplication.
   *
   * Netcore does not provide a unique message ID in webhook payloads.
   * We hash the first incoming message to produce a stable ID so that
   * webhook retries with the same payload are correctly deduplicated.
   */
  extractEventId(body: unknown): string | null {
    const payload = body as NetcoreWebhookPayload;
    const msg = payload.incoming_message?.[0];
    if (!msg?.from || !msg?.to) return null;
    const hash = createHash('sha256').update(JSON.stringify(msg)).digest('hex').slice(0, 16);
    return `netcore-${hash}`;
  }

  /**
   * Check if this webhook contains a processable message.
   */
  shouldProcess(body: unknown): boolean {
    const payload = body as NetcoreWebhookPayload;
    const messages = payload.incoming_message;
    if (!messages || messages.length === 0) return false;

    const message = messages[0];
    const messageType = message.message_type;
    if (!messageType) return false;

    return PROCESSABLE_MESSAGE_TYPES.has(messageType);
  }

  /**
   * Build NormalizedIncomingMessage from Netcore webhook payload.
   */
  buildNormalizedMessage(body: unknown): NormalizedIncomingMessage {
    const payload = body as NetcoreWebhookPayload;
    const message = payload.incoming_message?.[0];
    if (!message) {
      throw new Error('Invalid Netcore payload: missing incoming_message');
    }

    const msgHash = createHash('sha256').update(JSON.stringify(message)).digest('hex').slice(0, 16);
    const externalMessageId = `netcore-${msgHash}`;
    const externalSessionKey = `whatsapp:${message.to}:${message.from}`;
    const timestamp = new Date();

    const baseMetadata: Record<string, unknown> = {
      whatsappFrom: message.from,
      whatsappPhoneNumberId: message.to,
    };

    // Handle interactive replies (button or list)
    if (message.message_type === 'INTERACTIVE' && message.interactive_type) {
      const interactiveType = message.interactive_type;
      const actionId =
        interactiveType.type === 'button_reply'
          ? interactiveType.button_reply?.id || ''
          : interactiveType.list_reply?.id || '';

      return {
        externalMessageId,
        externalSessionKey,
        text: '',
        actionEvent: requireNormalizedActionEvent({
          actionId,
          value: actionId,
          source: 'whatsapp',
        }),
        metadata: baseMetadata,
        timestamp,
      };
    }

    // Handle location messages
    if (message.message_type === 'LOCATION' && message.location_type) {
      return {
        externalMessageId,
        externalSessionKey,
        text: `${message.location_type.latitude},${message.location_type.longitude}`,
        metadata: baseMetadata,
        timestamp,
      };
    }

    // Handle media messages (IMAGE, VIDEO, DOCUMENT, AUDIO)
    if (MEDIA_MESSAGE_TYPES.has(message.message_type)) {
      const mediaInfo = getMediaInfo(message);
      const whatsappMediaReferences = mediaInfo ? [mediaInfo] : [];

      return {
        externalMessageId,
        externalSessionKey,
        text: '',
        metadata: {
          ...baseMetadata,
          whatsappMediaReferences,
        },
        timestamp,
      };
    }

    // Standard text message
    const textContent = message.text_type?.[0]?.text || '';
    return {
      externalMessageId,
      externalSessionKey,
      text: textContent,
      metadata: baseMetadata,
      timestamp,
    };
  }

  /**
   * Send response via Netcore WhatsApp API.
   *
   * Maps ChannelOutput kinds to Netcore-specific payloads:
   * - text         -> message_type: "text" with type_text array
   * - interactive  -> message_type: "interactive" with type_interactive
   */
  async sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult> {
    const apiKey = connection.credentials?.api_key as string;
    if (!apiKey) {
      return buildChannelDeliveryFailure({
        channelType: 'whatsapp',
        provider: this.providerId,
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        operatorMessage: 'No Netcore API key was configured for outbound delivery.',
        retryable: false,
      });
    }

    const senderNumber = connection.externalIdentifier;
    const recipientNumber = readNonEmptyDeliveryMetadataString(message.metadata?.whatsappFrom);
    if (!recipientNumber) {
      return buildChannelDeliveryFailure({
        channelType: 'whatsapp',
        provider: this.providerId,
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        operatorMessage: 'No WhatsApp recipient phone number was present in message metadata.',
        retryable: false,
      });
    }

    const baseUrl = (connection.credentials?.base_url as string) || DEFAULT_BASE_URL;

    try {
      const channelOutput = message.metadata?.channelOutput as ChannelOutput | undefined;

      const messagePayload: Record<string, unknown> = {
        recipient_type: 'individual',
        recipient_whatsapp: recipientNumber,
        source: senderNumber,
      };

      if (channelOutput?.kind === 'whatsapp_template') {
        // Template messages: merge template data into the Netcore message payload.
        // The template structure from whatsapp-transform follows the WhatsApp Cloud API
        // format which needs to be adapted for Netcore's API.
        messagePayload.message_type = 'template';
        messagePayload.type_template = {
          name: channelOutput.template.name,
          language: channelOutput.template.language,
          ...(channelOutput.template.components && {
            components: channelOutput.template.components,
          }),
        };
      } else if (channelOutput?.kind === 'whatsapp_interactive') {
        messagePayload.message_type = 'interactive';
        messagePayload.type_interactive = channelOutput.interactive;
      } else {
        messagePayload.message_type = 'text';
        messagePayload.type_text = [
          {
            preview_url: 'false',
            content: message.text,
          },
        ];
      }

      const body = {
        message: [messagePayload],
      };

      const resp = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        log.error(
          'Netcore WhatsApp API HTTP error',
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
          operatorMessage: 'Netcore rejected the outbound WhatsApp message.',
          httpStatus: resp.status,
          retryable: false,
        });
      }

      const result = (await resp.json()) as { response?: { status?: string; details?: string } };

      if (result.response?.status === 'error') {
        log.error(
          'Netcore API returned error',
          buildChannelDeliveryLogContext({
            channelType: 'whatsapp',
            provider: this.providerId,
            providerErrorCode: result.response.status,
          }),
        );
        return buildChannelDeliveryFailure({
          channelType: 'whatsapp',
          provider: this.providerId,
          category: 'provider',
          code: 'CHANNEL_PROVIDER_REJECTED',
          operatorMessage: 'Netcore rejected the outbound WhatsApp message.',
          providerErrorCode: result.response.status,
          retryable: false,
        });
      }

      log.info('Netcore WhatsApp message sent', { to: recipientNumber });
      return { success: true };
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      const code = isAbort ? 'CHANNEL_DELIVERY_TIMEOUT' : 'CHANNEL_DELIVERY_FAILED';
      log.error(
        'Failed to send Netcore WhatsApp message',
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
        operatorMessage: 'Netcore delivery failed before the provider confirmed the message.',
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
