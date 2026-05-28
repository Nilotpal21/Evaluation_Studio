/**
 * Twilio SMS Channel Adapter
 *
 * Handles inbound Twilio SMS/MMS webhooks and sends outbound messages via
 * the Twilio REST API.
 *
 * - verifyRequest()           -> HMAC-SHA1 signature verification (auth_token + webhook URL)
 * - shouldProcess()           -> Filters processable SMS/MMS events
 * - extractEventId()          -> Returns MessageSid for deduplication
 * - buildNormalizedMessage()  -> Normalizes Twilio webhook -> NormalizedIncomingMessage
 * - parseIncoming()           -> Returns payload.message (pre-normalized in webhook handler)
 * - sendResponse()            -> POST to Twilio Messages API with Basic Auth
 * - transformOutput()         -> Plain text (SMS has no rich interactive support)
 *
 * Inbound: Twilio sends application/x-www-form-urlencoded POST with MessageSid,
 * AccountSid, From (E.164), To (E.164), Body, NumMedia, NumSegments, and optional
 * MediaUrl{N}/MediaContentType{N} fields for MMS.
 *
 * Outbound: POST to https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 * with Basic Auth (AccountSid:AuthToken), form-urlencoded body.
 *
 * Session key format: twilio_sms:{To}:{From}
 *   - To = the Twilio number (identifies the connection)
 *   - From = the user's phone number
 */

import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
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
import { resolveConnectionProviderApiBase } from './provider-api-base.js';
import {
  buildChannelDeliveryFailure,
  buildChannelDeliveryLogContext,
  getChannelDeliveryErrorName,
  readNonEmptyDeliveryMetadataString,
} from '../../services/channel/delivery-diagnostics.js';

const log = createLogger('twilio-sms-adapter');

// =============================================================================
// CONSTANTS
// =============================================================================

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';
// =============================================================================
// ADAPTER
// =============================================================================

export class TwilioSmsAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'twilio_sms';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: true,
    supportsStreaming: false,
    supportsMedia: true,
    supportsThreading: false,
  };

  /**
   * Verify Twilio's HMAC-SHA1 request signature.
   *
   * Twilio signs each webhook request by computing:
   *   HMAC-SHA1(auth_token, webhookUrl + sortedKeys.map(k => k + params[k]).join(''))
   *
   * The signature is sent as the X-Twilio-Signature header (base64-encoded).
   *
   * NOTE: The 5th parameter `webhookUrl` is an extension beyond the standard
   * ChannelAdapter interface. Twilio's HMAC includes the full webhook URL,
   * which the route handler must supply.
   */
  async verifyRequest(
    headers: Record<string, string>,
    body: unknown,
    _rawBody?: Buffer | string,
    connection?: ResolvedConnection | null,
    webhookUrl?: string,
  ): Promise<boolean> {
    const authToken = (connection?.credentials?.auth_token as string) || undefined;
    if (!authToken) {
      log.error('Twilio auth_token not configured');
      return false;
    }

    const signature = headers['x-twilio-signature'];
    if (!signature) {
      log.warn('Missing X-Twilio-Signature header');
      return false;
    }

    const params = (body && typeof body === 'object' ? body : {}) as Record<string, string>;

    if (!webhookUrl) {
      log.error('Webhook URL required for Twilio HMAC-SHA1 verification');
      return false;
    }

    // Build the validation string: URL + sorted params concatenated as key+value
    const sortedKeys = Object.keys(params).sort();
    const data = webhookUrl + sortedKeys.map((k) => k + params[k]).join('');

    const expected = crypto.createHmac('sha1', authToken).update(data).digest('base64');

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
   * Check if the inbound webhook contains a processable SMS/MMS message.
   * Requires MessageSid and either a non-empty Body or NumMedia > 0.
   */
  shouldProcess(body: unknown): boolean {
    const params = body as Record<string, string>;

    if (!params?.MessageSid) return false;

    const hasBody = typeof params.Body === 'string' && params.Body.trim().length > 0;
    const hasMedia = parseInt(params.NumMedia || '0', 10) > 0;

    return hasBody || hasMedia;
  }

  /**
   * Extract MessageSid for deduplication.
   */
  extractEventId(body: unknown): string | null {
    const params = body as Record<string, string>;
    return params?.MessageSid || null;
  }

  /**
   * Build NormalizedIncomingMessage from Twilio SMS/MMS webhook payload.
   */
  buildNormalizedMessage(body: unknown): NormalizedIncomingMessage {
    const params = body as Record<string, string>;

    const messageSid = params.MessageSid;
    const from = params.From || '';
    const to = params.To || '';
    const accountSid = params.AccountSid || '';

    const text = params.Body || '';

    // Parse media references for MMS
    const numMedia = parseInt(params.NumMedia || '0', 10);
    const mediaReferences: Array<{ url: string; contentType: string; index: number }> = [];
    for (let i = 0; i < numMedia; i++) {
      const url = params[`MediaUrl${i}`];
      const contentType = params[`MediaContentType${i}`];
      if (url) {
        mediaReferences.push({
          url,
          contentType: contentType || 'application/octet-stream',
          index: i,
        });
      }
    }

    const metadata: Record<string, unknown> = {
      twilioFrom: from,
      twilioTo: to,
      twilioAccountSid: accountSid,
    };

    if (mediaReferences.length > 0) {
      metadata.twilioMediaReferences = mediaReferences;
    }

    return {
      externalMessageId: messageSid,
      externalSessionKey: `twilio_sms:${to}:${from}`,
      text,
      metadata,
      timestamp: new Date(),
    };
  }

  /**
   * Extract the Twilio number (To field) as the external identifier
   * for connection resolution.
   */
  extractExternalIdentifier(body: unknown): string | null {
    const params = body as Record<string, string>;
    return params?.To || null;
  }

  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  /**
   * Send a response via the Twilio REST API.
   *
   * POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
   * Authorization: Basic base64(AccountSid:AuthToken)
   * Content-Type: application/x-www-form-urlencoded
   * Body: To=...&From=...&Body=...
   */
  async sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult> {
    const accountSid = connection.credentials?.account_sid as string | undefined;
    const authToken = connection.credentials?.auth_token as string | undefined;

    if (!accountSid || !authToken) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'twilio',
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        operatorMessage: 'No Twilio account SID or auth token was available for outbound delivery.',
        retryable: false,
      });
    }

    // Recipient is the user's phone number (the From of the inbound message)
    const to = readNonEmptyDeliveryMetadataString(message.metadata?.twilioFrom);
    if (!to) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'twilio',
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        operatorMessage: 'No Twilio recipient phone number was present in message metadata.',
        retryable: false,
      });
    }

    try {
      // Build form-encoded body
      const formParams = new URLSearchParams();
      formParams.set('To', to);
      formParams.set('Body', message.text);

      // Determine From/MessagingServiceSid — prefer MessagingServiceSid
      const messagingServiceSid = connection.credentials?.messaging_service_sid as
        | string
        | undefined;
      const fromNumber =
        (connection.config?.from_number as string | undefined) ||
        (message.metadata?.twilioTo as string | undefined);

      if (messagingServiceSid) {
        formParams.set('MessagingServiceSid', messagingServiceSid);
      } else if (fromNumber) {
        formParams.set('From', fromNumber);
      } else {
        return buildChannelDeliveryFailure({
          channelType: this.channelType,
          provider: 'twilio',
          category: 'configuration',
          code: 'CHANNEL_DELIVERY_CONFIGURATION',
          operatorMessage: 'No Twilio From number or MessagingServiceSid was configured.',
          retryable: false,
        });
      }

      const twilioApiBase = resolveConnectionProviderApiBase(
        connection,
        'TWILIO_API_BASE_URL',
        TWILIO_API_BASE,
        'twilioApiBaseUrl',
      );
      const url = `${twilioApiBase}/Accounts/${accountSid}/Messages.json`;
      const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formParams.toString(),
      });

      if (!resp.ok) {
        log.error(
          'Twilio API error',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'twilio',
            httpStatus: resp.status,
          }),
        );
        return buildChannelDeliveryFailure({
          channelType: this.channelType,
          provider: 'twilio',
          category: 'provider',
          code: 'CHANNEL_PROVIDER_REJECTED',
          operatorMessage: 'Twilio Messages API rejected the outbound response.',
          httpStatus: resp.status,
          retryable: false,
        });
      }

      const result = (await resp.json()) as { sid?: string; status?: string };
      log.info('Twilio SMS sent', { to, sid: result.sid });
      return { success: true, deliveryId: result.sid };
    } catch (error) {
      const code =
        error instanceof Error && error.name === 'AbortError'
          ? 'CHANNEL_DELIVERY_TIMEOUT'
          : 'CHANNEL_DELIVERY_FAILED';
      log.error(
        'Failed to send Twilio SMS',
        buildChannelDeliveryLogContext({
          channelType: this.channelType,
          provider: 'twilio',
          code,
          errorName: getChannelDeliveryErrorName(error),
        }),
      );
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'twilio',
        category: 'network',
        code,
        operatorMessage: 'Twilio Messages API failed before a provider response was available.',
        retryable: true,
      });
    }
  }

  /**
   * Transform output to plain text. SMS does not support rich interactive messages.
   */
  transformOutput(text: string): ChannelOutput {
    return { kind: 'text', text };
  }
}
