/**
 * Infobip WhatsApp Provider
 *
 * Implements WhatsAppProvider for Infobip's WhatsApp API.
 * Handles inbound message normalization for all supported message types:
 * TEXT, IMAGE, VIDEO, AUDIO, VOICE, DOCUMENT, LOCATION, CONTACT,
 * INTERACTIVE_BUTTON_REPLY, INTERACTIVE_LIST_REPLY.
 *
 * Infobip webhook payloads use a different structure than Meta Cloud API:
 * - Top-level `results` array instead of `entry[].changes[].value.messages`
 * - `from`/`to` at the result level (not nested in metadata)
 * - Message type in `message.type` (uppercase, e.g., 'TEXT' not 'text')
 * - Media URLs provided directly (no Graph API media download needed)
 * - No webhook signature verification
 */

import { createLogger } from '@abl/compiler/platform';
import type { ActionSetIR, RichContentIR } from '@abl/compiler';
import type {
  ChannelOutput,
  NormalizedIncomingMessage,
  NormalizedOutgoingMessage,
  ResolvedConnection,
  SendResult,
  WhatsAppTemplatePayload,
} from '../../types.js';
import type { WhatsAppProvider } from '../whatsapp-provider.js';
import { requireNormalizedActionEvent } from '../../../services/channels/action-event-validation.js';
import {
  buildChannelDeliveryFailure,
  buildChannelDeliveryLogContext,
  getChannelDeliveryErrorName,
} from '../../../services/channel/delivery-diagnostics.js';
import { transformWhatsAppOutput } from './whatsapp-transform.js';
import { normalizeInfobipBaseUrl, normalizeInfobipPhoneIdentifier } from './infobip-utils.js';

const log = createLogger('infobip-provider');

// =============================================================================
// INFOBIP WEBHOOK TYPES
// =============================================================================

interface InfobipWebhookPayload {
  results: Array<InfobipResult>;
  messageCount: number;
  pendingMessageCount: number;
}

interface InfobipResult {
  from: string;
  to: string;
  integrationType: string;
  receivedAt: string;
  messageId: string;
  message: InfobipMessage;
  contact?: { name: string };
}

interface InfobipMessage {
  type: string;
  text?: string;
  caption?: string;
  url?: string;
  id?: string;
  latitude?: number;
  longitude?: number;
  contacts?: Array<{
    name: { formatted_name?: string; first_name?: string; last_name?: string };
    phones?: Array<{ phone: string; type?: string }>;
    emails?: Array<{ email: string; type?: string }>;
  }>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const PROCESSABLE_MESSAGE_TYPES = new Set([
  'TEXT',
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'VOICE',
  'DOCUMENT',
  'LOCATION',
  'INTERACTIVE_BUTTON_REPLY',
  'INTERACTIVE_LIST_REPLY',
  'CONTACT',
]);

const MEDIA_MESSAGE_TYPES = new Set(['IMAGE', 'VIDEO', 'AUDIO', 'VOICE', 'DOCUMENT']);

// =============================================================================
// HELPERS
// =============================================================================

function mapInfobipMediaType(type: string): 'image' | 'video' | 'audio' | 'document' {
  switch (type) {
    case 'IMAGE':
      return 'image';
    case 'VIDEO':
      return 'video';
    case 'AUDIO':
    case 'VOICE':
      return 'audio';
    case 'DOCUMENT':
      return 'document';
    default:
      return 'document';
  }
}

export function buildInfobipAuthHeader(connection: ResolvedConnection): string {
  const authType = connection.config?.authType as string;
  if (authType === 'basic') {
    const username = connection.credentials?.username as string;
    const password = connection.credentials?.password as string;
    return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }
  const apiKey = connection.credentials?.api_key as string;
  return `App ${apiKey}`;
}

// =============================================================================
// INFOBIP PROVIDER
// =============================================================================

export class InfobipProvider implements WhatsAppProvider {
  readonly providerId = 'infobip';

  /**
   * Infobip does not use webhook signature verification.
   * Security is handled at the network/IP-allowlist level.
   */
  async verifyRequest(
    _headers: Record<string, string>,
    _body: unknown,
    _rawBody?: Buffer | string,
    _connection?: ResolvedConnection | null,
  ): Promise<boolean> {
    log.debug('Infobip does not use webhook signature verification');
    return true;
  }

  /**
   * Extract the Infobip phone number (`results[0].to`) as external identifier
   * for connection resolution.
   */
  extractExternalIdentifier(body: unknown): string | null {
    const payload = body as InfobipWebhookPayload;
    return normalizeInfobipPhoneIdentifier(payload.results?.[0]?.to);
  }

  /**
   * Extract message ID for deduplication.
   */
  extractEventId(body: unknown): string | null {
    const payload = body as InfobipWebhookPayload;
    return payload.results?.[0]?.messageId || null;
  }

  /**
   * Check if this webhook contains a processable message.
   */
  shouldProcess(body: unknown): boolean {
    const payload = body as InfobipWebhookPayload;
    const results = payload.results;
    if (!results || results.length === 0) return false;

    const result = results[0];
    const messageType = result.message?.type;
    if (!messageType) return false;

    return PROCESSABLE_MESSAGE_TYPES.has(messageType);
  }

  /**
   * Build NormalizedIncomingMessage from Infobip webhook payload.
   */
  buildNormalizedMessage(body: unknown): NormalizedIncomingMessage {
    const payload = body as InfobipWebhookPayload;
    const result = payload.results?.[0];
    if (!result) {
      throw new Error('Invalid Infobip payload: missing results');
    }

    const message = result.message;
    if (!message) {
      throw new Error('Invalid Infobip payload: missing message data');
    }

    const externalMessageId = result.messageId;
    const externalSessionKey = `whatsapp:${result.to}:${result.from}`;
    const timestamp = new Date(result.receivedAt);

    const baseMetadata: Record<string, unknown> = {
      whatsappFrom: result.from,
      whatsappPhoneNumberId: result.to,
      whatsappContactName: result.contact?.name,
    };

    // Handle interactive replies (button or list)
    if (message.type === 'INTERACTIVE_BUTTON_REPLY' || message.type === 'INTERACTIVE_LIST_REPLY') {
      return {
        externalMessageId,
        externalSessionKey,
        text: '',
        actionEvent: requireNormalizedActionEvent({
          actionId: message.id || '',
          value: message.id || '',
          source: 'whatsapp',
        }),
        metadata: baseMetadata,
        timestamp,
      };
    }

    // Handle location messages
    if (message.type === 'LOCATION') {
      return {
        externalMessageId,
        externalSessionKey,
        text: `${message.latitude},${message.longitude}`,
        metadata: baseMetadata,
        timestamp,
      };
    }

    // Handle contact card messages
    if (message.type === 'CONTACT' && message.contacts) {
      const contactLines = message.contacts.map((c) => {
        const name = c.name?.formatted_name || c.name?.first_name || 'Unknown';
        const details: string[] = [];
        if (c.phones?.[0]?.phone) details.push(c.phones[0].phone);
        if (c.emails?.[0]?.email) details.push(c.emails[0].email);
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
          contacts: message.contacts,
        },
        timestamp,
      };
    }

    // Handle media messages (IMAGE, VIDEO, AUDIO, VOICE, DOCUMENT)
    if (MEDIA_MESSAGE_TYPES.has(message.type)) {
      const whatsappMediaReferences = message.url
        ? [
            {
              mediaId: 'infobip-direct',
              mimeType: '',
              mediaType: mapInfobipMediaType(message.type),
              url: message.url,
            },
          ]
        : [];

      return {
        externalMessageId,
        externalSessionKey,
        text: message.caption || '',
        metadata: {
          ...baseMetadata,
          whatsappMediaReferences,
        },
        timestamp,
      };
    }

    // Standard text message
    return {
      externalMessageId,
      externalSessionKey,
      text: message.text || '',
      metadata: baseMetadata,
      timestamp,
    };
  }

  /**
   * Send response via Infobip WhatsApp API.
   *
   * Maps ChannelOutput kinds to Infobip-specific endpoints and payloads:
   * - text         → POST {baseUrl}/whatsapp/1/message/text
   * - interactive  → POST {baseUrl}/whatsapp/1/message/interactive/buttons or /list
   * - template     → POST {baseUrl}/whatsapp/1/message/template
   */
  async sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult> {
    const baseUrl = normalizeInfobipBaseUrl(connection.credentials?.base_url);
    if (!baseUrl) {
      return buildChannelDeliveryFailure({
        channelType: 'whatsapp',
        provider: this.providerId,
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        operatorMessage: 'No Infobip base URL was configured for outbound delivery.',
        retryable: false,
      });
    }

    const senderNumber = normalizeInfobipPhoneIdentifier(connection.externalIdentifier);
    const recipientNumber = normalizeInfobipPhoneIdentifier(message.metadata?.whatsappFrom);
    if (!senderNumber) {
      return buildChannelDeliveryFailure({
        channelType: 'whatsapp',
        provider: this.providerId,
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        operatorMessage: 'No Infobip sender phone number was configured for outbound delivery.',
        retryable: false,
      });
    }
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

    const authType = connection.config?.authType as string;
    const username = connection.credentials?.username;
    const password = connection.credentials?.password;
    const apiKey = connection.credentials?.api_key;
    const hasBasicCredentials =
      authType === 'basic' &&
      typeof username === 'string' &&
      username.length > 0 &&
      typeof password === 'string' &&
      password.length > 0;
    const hasApiKey = authType !== 'basic' && typeof apiKey === 'string' && apiKey.length > 0;
    if (!hasBasicCredentials && !hasApiKey) {
      return buildChannelDeliveryFailure({
        channelType: 'whatsapp',
        provider: this.providerId,
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        operatorMessage: 'Infobip outbound credentials were not configured.',
        retryable: false,
      });
    }

    const authHeader = buildInfobipAuthHeader(connection);

    try {
      const channelOutput = message.metadata?.channelOutput as ChannelOutput | undefined;

      let url: string;
      let body: unknown;

      if (channelOutput?.kind === 'whatsapp_template') {
        url = `${baseUrl}/whatsapp/1/message/template`;
        body = {
          messages: [
            {
              from: senderNumber,
              to: recipientNumber,
              content: {
                templateName: channelOutput.template.name,
                templateData: channelOutput.template.components
                  ? {
                      body: { placeholders: [] },
                      ...this.mapTemplateComponents(channelOutput.template.components),
                    }
                  : undefined,
                language: channelOutput.template.language.code,
              },
            },
          ],
        };
      } else if (channelOutput?.kind === 'whatsapp_interactive') {
        const interactive = channelOutput.interactive as {
          type: string;
          body: { text: string };
          action: {
            buttons?: Array<{ type: string; reply: { id: string; title: string } }>;
            button?: string;
            sections?: Array<{
              title: string;
              rows: Array<{ id: string; title: string; description?: string }>;
            }>;
          };
        };

        if (interactive.type === 'button') {
          url = `${baseUrl}/whatsapp/1/message/interactive/buttons`;
          body = {
            from: senderNumber,
            to: recipientNumber,
            content: {
              body: { text: interactive.body.text },
              action: {
                buttons: interactive.action.buttons!.map((btn) => ({
                  type: 'REPLY',
                  id: btn.reply.id,
                  title: btn.reply.title,
                })),
              },
            },
          };
        } else {
          // list type
          url = `${baseUrl}/whatsapp/1/message/interactive/list`;
          body = {
            from: senderNumber,
            to: recipientNumber,
            content: {
              body: { text: interactive.body.text },
              action: {
                title: interactive.action.button,
                sections: interactive.action.sections!.map((section) => ({
                  title: section.title,
                  rows: section.rows.map((row) => ({
                    id: row.id,
                    title: row.title,
                    description: row.description,
                  })),
                })),
              },
            },
          };
        }
      } else {
        url = `${baseUrl}/whatsapp/1/message/text`;
        body = {
          from: senderNumber,
          to: recipientNumber,
          content: { text: message.text },
        };
      }

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        log.error(
          'Infobip WhatsApp API error',
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
          operatorMessage: 'Infobip rejected the outbound WhatsApp message.',
          httpStatus: resp.status,
          retryable: false,
        });
      }

      // Template endpoint returns { messages: [{ messageId }] }
      // Text/interactive endpoints return { messageId } at top level
      const result = (await resp.json()) as {
        messageId?: string;
        messages?: Array<{ messageId: string; status?: { groupName: string } }>;
      };
      const messageId = result.messages?.[0]?.messageId || result.messageId;
      log.info('Infobip WhatsApp message sent', { to: recipientNumber, messageId });
      return { success: true, deliveryId: messageId };
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      const code = isAbort ? 'CHANNEL_DELIVERY_TIMEOUT' : 'CHANNEL_DELIVERY_FAILED';
      log.error(
        'Failed to send Infobip WhatsApp message',
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
        operatorMessage: 'Infobip delivery failed before the provider confirmed the message.',
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

  /**
   * Map WhatsApp Cloud API template components to Infobip template data format.
   * This is a basic mapping — extend as needed for complex templates.
   */
  private mapTemplateComponents(
    components: NonNullable<WhatsAppTemplatePayload['components']>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const comp of components) {
      if (comp.type === 'header' && comp.parameters) {
        result.header = comp.parameters;
      }
      if (comp.type === 'body' && comp.parameters) {
        const placeholders = comp.parameters
          .filter((p) => p.type === 'text' && p.text)
          .map((p) => p.text);
        if (placeholders.length > 0) {
          result.body = { placeholders };
        }
      }
      if (comp.type === 'button') {
        // Infobip handles button parameters differently — map sub_type and index.
        // For quick_reply buttons, Infobip expects them in the template content.
        // Note: Infobip templates with button parameters need to be configured
        // in the Infobip dashboard. The parameters are passed through as-is.
        log.debug('Template button component detected', {
          subType: comp.sub_type,
          index: comp.index,
        });
        if (!result.buttons) {
          result.buttons = [];
        }
        (result.buttons as Array<Record<string, unknown>>).push({
          type: comp.sub_type || 'QUICK_REPLY',
          index: comp.index,
          parameters: comp.parameters,
        });
      }
    }
    return result;
  }
}
