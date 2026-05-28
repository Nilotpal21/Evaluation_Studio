/**
 * Gupshup WhatsApp Provider
 *
 * Implements WhatsAppProvider for Gupshup's WhatsApp Business API.
 * Handles inbound message normalization for all supported message types:
 * text, image, video, document, audio, voice, location, interactive, button, contacts.
 *
 * Gupshup webhook payloads use a flat body structure:
 * - `body.mobile` = sender phone number, `body.waNumber` = our phone number
 * - `body.type` determines message type (lowercase)
 * - Media fields (image, video, etc.) and interactive/button/location/contacts/voice
 *   are JSON strings that need JSON.parse()
 * - Voice: `{url, signature}` — concatenate `url + signature` for download URL
 * - Interactive: `{type: "button_reply"|"list_reply", button_reply: {id}, list_reply: {id}}`
 * - Button: `{text: "Quick Reply Text"}`
 * - Location: `{latitude, longitude, address?}`
 *
 * Webhook verification uses JWT (HS256) with a configurable webhook_secret.
 */

import jwt, { type Algorithm } from 'jsonwebtoken';
import { createLogger } from '@abl/compiler/platform';
import {
  GUPSHUP_WEBHOOK_TOKEN_AUDIENCE,
  GUPSHUP_WEBHOOK_TOKEN_PURPOSE,
  PLATFORM_JWT_ISSUER,
} from '@agent-platform/shared-auth';
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

const log = createLogger('gupshup-provider');

// =============================================================================
// GUPSHUP WEBHOOK TYPES
// =============================================================================

interface GupshupWebhookBody {
  mobile?: string;
  waNumber?: string;
  type?: string;
  text?: string;
  name?: string;
  messageId?: string;
  timestamp?: string;
  image?: string; // JSON string
  video?: string; // JSON string
  document?: string; // JSON string
  audio?: string; // JSON string
  voice?: string; // JSON string
  location?: string; // JSON string
  interactive?: string; // JSON string
  button?: string; // JSON string
  contacts?: string; // JSON string
  [key: string]: unknown;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const GUPSHUP_API_HOST = 'https://media.smsgupshup.com/GatewayAPI/rest';

const PROCESSABLE_TYPES = new Set([
  'text',
  'image',
  'video',
  'document',
  'audio',
  'voice',
  'location',
  'interactive',
  'button',
  'contacts',
]);

const MEDIA_TYPES = new Set(['image', 'video', 'document', 'audio']);

const ALLOWED_JWT_ALGORITHMS = new Set(['HS256', 'HS512']);

// =============================================================================
// HELPERS
// =============================================================================

function safeJsonParse(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    log.warn('Failed to parse Gupshup JSON field', { value: value.slice(0, 100) });
    return null;
  }
}

function mapGupshupMediaType(type: string): 'image' | 'video' | 'audio' | 'document' {
  switch (type) {
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'document':
      return 'document';
    default:
      return 'document';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWrongPlatformPurposeToken(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }

  if (payload.iss !== PLATFORM_JWT_ISSUER) {
    return false;
  }

  return (
    payload.aud !== GUPSHUP_WEBHOOK_TOKEN_AUDIENCE ||
    payload.purpose !== GUPSHUP_WEBHOOK_TOKEN_PURPOSE
  );
}

// =============================================================================
// GUPSHUP PROVIDER
// =============================================================================

export class GupshupProvider implements WhatsAppProvider {
  readonly providerId = 'gupshup';

  /**
   * Verify webhook request using JWT (HS256) verification.
   * If no webhook_secret is configured, verification is skipped.
   */
  async verifyRequest(
    headers: Record<string, string>,
    _body: unknown,
    _rawBody?: Buffer | string,
    connection?: ResolvedConnection | null,
  ): Promise<boolean> {
    const secret = connection?.credentials?.webhook_secret as string | undefined;
    if (!secret) return true;

    const authHeader = headers.authorization || headers.Authorization;
    if (!authHeader) return false;

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return false;

    const token = parts[1];
    const algorithm = (connection?.config?.webhookAlgorithm as string) || 'HS256';

    if (!ALLOWED_JWT_ALGORITHMS.has(algorithm)) {
      log.warn('Unsupported JWT algorithm configured', { algorithm });
      return false;
    }

    try {
      const decoded = jwt.verify(token, secret, { algorithms: [algorithm as Algorithm] });
      if (isWrongPlatformPurposeToken(decoded)) {
        log.warn('Gupshup webhook JWT rejected due to incompatible platform token purpose');
        return false;
      }
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn('Gupshup webhook JWT verification failed', { error: errMsg });
      return false;
    }
  }

  /**
   * Extract the Gupshup phone number (`body.waNumber`) as external identifier
   * for connection resolution.
   */
  extractExternalIdentifier(body: unknown): string | null {
    const b = body as GupshupWebhookBody;
    return b.waNumber || null;
  }

  /**
   * Extract message ID for deduplication.
   * Falls back to `gupshup:${mobile}:${timestamp}` when messageId is absent.
   */
  extractEventId(body: unknown): string | null {
    const b = body as GupshupWebhookBody;
    if (b.messageId) return b.messageId;
    if (b.mobile && b.timestamp) return `gupshup:${b.mobile}:${b.timestamp}`;
    return null;
  }

  /**
   * Check if this webhook contains a processable message type.
   */
  shouldProcess(body: unknown): boolean {
    const b = body as GupshupWebhookBody;
    if (!b.type) return false;
    return PROCESSABLE_TYPES.has(b.type);
  }

  /**
   * Build NormalizedIncomingMessage from Gupshup webhook body.
   */
  buildNormalizedMessage(body: unknown): NormalizedIncomingMessage {
    const b = body as GupshupWebhookBody;

    const externalMessageId =
      b.messageId || (b.mobile && b.timestamp ? `gupshup:${b.mobile}:${b.timestamp}` : '');
    const externalSessionKey = `whatsapp:${b.waNumber}:${b.mobile}`;
    const timestamp = b.timestamp ? new Date(Number(b.timestamp) * 1000) : new Date();

    const baseMetadata: Record<string, unknown> = {
      whatsappFrom: b.mobile,
      whatsappPhoneNumberId: b.waNumber,
      whatsappContactName: b.name,
    };

    const messageType = b.type || 'text';

    // Handle media messages (image, video, document, audio)
    if (MEDIA_TYPES.has(messageType)) {
      const parsed = safeJsonParse(b[messageType] as string | undefined);
      const url = (parsed?.url as string) || '';
      const mimeType = (parsed?.mime_type as string) || '';
      const caption = (parsed?.caption as string) || '';

      const whatsappMediaReferences = url
        ? [
            {
              mediaId: 'gupshup-direct',
              mimeType,
              mediaType: mapGupshupMediaType(messageType),
              url,
            },
          ]
        : [];

      return {
        externalMessageId,
        externalSessionKey,
        text: caption,
        metadata: {
          ...baseMetadata,
          whatsappMediaReferences,
        },
        timestamp,
      };
    }

    // Handle voice messages
    if (messageType === 'voice') {
      const parsed = safeJsonParse(b.voice);
      const voiceUrl = (parsed?.url as string) || '';
      const signature = (parsed?.signature as string) || '';
      const fullUrl = voiceUrl + signature;

      const whatsappMediaReferences = fullUrl
        ? [
            {
              mediaId: 'gupshup-direct',
              mimeType: 'audio/ogg',
              mediaType: 'audio' as const,
              url: fullUrl,
            },
          ]
        : [];

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

    // Handle location messages
    if (messageType === 'location') {
      const parsed = safeJsonParse(b.location);
      const lat = parsed?.latitude;
      const lng = parsed?.longitude;
      const address = parsed?.address as string | undefined;

      const text = address || (lat != null && lng != null ? `${lat},${lng}` : '');

      return {
        externalMessageId,
        externalSessionKey,
        text,
        metadata: baseMetadata,
        timestamp,
      };
    }

    // Handle interactive messages (button_reply, list_reply)
    if (messageType === 'interactive') {
      const parsed = safeJsonParse(b.interactive);
      const interactiveType = parsed?.type as string | undefined;

      if (interactiveType === 'button_reply') {
        const buttonReply = parsed?.button_reply as { id?: string } | undefined;
        const actionId = buttonReply?.id || '';
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

      if (interactiveType === 'list_reply') {
        const listReply = parsed?.list_reply as { id?: string } | undefined;
        const actionId = listReply?.id || '';
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

      // Unknown interactive type — fall through to text
      return {
        externalMessageId,
        externalSessionKey,
        text: '',
        metadata: baseMetadata,
        timestamp,
      };
    }

    // Handle button messages (quick replies)
    if (messageType === 'button') {
      const parsed = safeJsonParse(b.button);
      const text = (parsed?.text as string) || '';
      return {
        externalMessageId,
        externalSessionKey,
        text,
        metadata: baseMetadata,
        timestamp,
      };
    }

    // Handle contacts messages
    if (messageType === 'contacts') {
      const parsed = safeJsonParse(b.contacts);
      if (parsed === null) {
        // Invalid JSON — fall back to raw string
        return {
          externalMessageId,
          externalSessionKey,
          text: b.contacts || '',
          metadata: baseMetadata,
          timestamp,
        };
      }

      const contactsArray = Array.isArray(parsed) ? parsed : [parsed];
      const contactLines = contactsArray.map((c: Record<string, unknown>) => {
        const nameObj = c.name as Record<string, string> | undefined;
        const name = nameObj?.formatted_name || nameObj?.first_name || 'Unknown';
        const phones = c.phones as Array<{ phone: string }> | undefined;
        const emails = c.emails as Array<{ email: string }> | undefined;
        const details: string[] = [];
        if (phones?.[0]?.phone) details.push(phones[0].phone);
        if (emails?.[0]?.email) details.push(emails[0].email);
        return details.length > 0
          ? `Shared contact: ${name} (${details.join(', ')})`
          : `Shared contact: ${name}`;
      });

      return {
        externalMessageId,
        externalSessionKey,
        text: contactLines.join('\n'),
        metadata: {
          ...baseMetadata,
          contacts: contactsArray,
        },
        timestamp,
      };
    }

    // Standard text message
    return {
      externalMessageId,
      externalSessionKey,
      text: b.text || '',
      metadata: baseMetadata,
      timestamp,
    };
  }

  /**
   * Transform ActionSetIR into WhatsApp interactive format.
   * Delegates to shared whatsapp-transform utility.
   */
  transformOutput(text: string, actions?: ActionSetIR, richContent?: RichContentIR): ChannelOutput {
    return transformWhatsAppOutput(text, actions, richContent);
  }

  /**
   * Send response via Gupshup WhatsApp API.
   *
   * Uses form-encoded POST to Gupshup's REST gateway with auth in the form body.
   * Supports text, interactive (buttons/list), and template message types.
   */
  async sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult> {
    const username = connection.credentials?.username as string;
    const password = connection.credentials?.password as string;
    if (!username || !password) {
      return buildChannelDeliveryFailure({
        channelType: 'whatsapp',
        provider: this.providerId,
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        operatorMessage: 'Gupshup outbound credentials were not configured.',
        retryable: false,
      });
    }

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

    // Build base form params — auth goes in the body, not headers
    const params = new URLSearchParams();
    params.set('auth_scheme', 'plain');
    params.set('userid', username);
    params.set('password', password);
    params.set('send_to', recipientNumber);
    params.set('v', '1.1');
    params.set('format', 'json');

    const channelOutput = message.metadata?.channelOutput as ChannelOutput | undefined;

    if (channelOutput?.kind === 'whatsapp_template') {
      params.set('method', 'SendMessage');
      params.set('interactive_type', 'dr_button');
      params.set('action', JSON.stringify(channelOutput.template));
    } else if (channelOutput?.kind === 'whatsapp_interactive') {
      const interactive = channelOutput.interactive as {
        type: string;
        body: { text: string };
        action: unknown;
      };
      params.set('method', 'SendMessage');
      params.set('msg', interactive.body.text);
      if (interactive.type === 'list') {
        params.set('interactive_type', 'list');
      } else {
        params.set('interactive_type', 'dr_button');
      }
      params.set('action', JSON.stringify(interactive.action));
    } else {
      // Plain text
      params.set('method', 'SendMessage');
      params.set('msg_type', 'Text');
      params.set('msg', message.text);
    }

    try {
      const resp = await fetch(GUPSHUP_API_HOST, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!resp.ok) {
        log.error(
          'Gupshup WhatsApp API error',
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
          operatorMessage: 'Gupshup rejected the outbound WhatsApp message.',
          httpStatus: resp.status,
          retryable: false,
        });
      }

      const result = (await resp.json()) as {
        response?: { status?: string; id?: string; details?: string };
      };
      if (result.response?.status === 'error') {
        log.error(
          'Gupshup message rejected',
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
          operatorMessage: 'Gupshup rejected the outbound WhatsApp message.',
          providerErrorCode: result.response.status,
          retryable: false,
        });
      }

      const messageId = result.response?.id;
      log.info('Gupshup WhatsApp message sent', { to: recipientNumber, messageId });
      return { success: true, deliveryId: messageId };
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      const code = isAbort ? 'CHANNEL_DELIVERY_TIMEOUT' : 'CHANNEL_DELIVERY_FAILED';
      log.error(
        'Failed to send Gupshup WhatsApp message',
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
        operatorMessage: 'Gupshup delivery failed before the provider confirmed the message.',
        retryable: true,
      });
    }
  }
}
