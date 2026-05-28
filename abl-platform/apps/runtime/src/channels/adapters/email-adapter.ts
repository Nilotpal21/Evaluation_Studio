/**
 * Email Channel Adapter
 *
 * Handles email-based agent conversations.
 * Inbound: SMTP server receives email → parses → enqueues to BullMQ (handled in smtp-server.ts)
 * Outbound: Sends agent replies via nodemailer with email threading headers.
 */

import { createLogger } from '@abl/compiler/platform';
import { Marked, type Tokens } from 'marked';
import { resolveEmailTransport } from '../../services/email/transports/resolve-transport.js';
import { signFeedbackToken } from '../../services/email/feedback-token.js';
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
import {
  buildChannelDeliveryFailure,
  readNonEmptyDeliveryMetadataString,
} from '../../services/channel/delivery-diagnostics.js';

const log = createLogger('email-adapter');

/** Escape HTML entities to prevent raw HTML injection in markdown output. */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Dangerous URI schemes that must not appear in href/src attributes. */
const DANGEROUS_URI_RE = /^\s*(javascript|vbscript|data):/i;

/**
 * Safe email renderer (plain object — `this` is bound to the Renderer instance by marked).
 * Uses this.parser.parseInline(tokens) for link/image text so that:
 * - Inline formatting renders (e.g. **bold** → <strong>bold</strong>)
 * - Raw HTML in text is escaped via our html() override
 * - Links with javascript:/vbscript:/data: schemes are neutralized
 * - Images rendered as text links (prevents remote tracking pixels)
 */
const safeMarked = new Marked({
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Link) {
      const rendered = this.parser.parseInline(token.tokens);
      if (DANGEROUS_URI_RE.test(token.href)) {
        return rendered;
      }
      return `<a href="${escapeHtml(token.href)}">${rendered}</a>`;
    },
    image(
      this: { parser: { parseInline(tokens: Tokens.Generic[]): string } },
      token: Tokens.Image,
    ) {
      // Never emit <img> tags — any remote URL is a potential tracking pixel.
      // Render as a text link so the recipient can choose to open it.
      const rendered = token.tokens
        ? this.parser.parseInline(token.tokens)
        : escapeHtml(token.text || token.href);
      if (DANGEROUS_URI_RE.test(token.href)) {
        return rendered;
      }
      return `[${rendered}] <a href="${escapeHtml(token.href)}">${escapeHtml(token.href)}</a>`;
    },
  },
});

/** Minimal inline-styled HTML wrapper for email clients. */
function wrapHtml(bodyHtml: string): string {
  return [
    "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;",
    'font-size:14px;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:16px">',
    bodyHtml,
    '</div>',
  ].join('');
}

/** Build CSAT rating HTML block with 5 clickable links. */
function buildCsatBlock(token: string): string {
  const baseUrl = (
    process.env.RUNTIME_PUBLIC_BASE_URL ||
    process.env.RUNTIME_BASE_URL ||
    'http://localhost:3112'
  ).replace(/\/$/, '');
  const labels = [
    { rating: 1, emoji: '&#128545;', label: 'Very Unsatisfied' },
    { rating: 2, emoji: '&#128543;', label: 'Unsatisfied' },
    { rating: 3, emoji: '&#128528;', label: 'Neutral' },
    { rating: 4, emoji: '&#128578;', label: 'Satisfied' },
    { rating: 5, emoji: '&#128525;', label: 'Very Satisfied' },
  ];
  const links = labels
    .map(
      ({ rating, emoji, label }) =>
        `<a href="${baseUrl}/api/v1/feedback/${token}?rating=${rating}" ` +
        `style="text-decoration:none;font-size:24px;margin:0 4px" title="${label}">${emoji}</a>`,
    )
    .join('');
  return (
    '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;text-align:center">' +
    '<p style="font-size:12px;color:#6b7280;margin:0 0 8px">How was this response?</p>' +
    links +
    '</div>'
  );
}

function isEmailTransportConfigurationError(message: string): boolean {
  return message.startsWith('Graph transport requires ');
}

export class EmailAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'email';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: true,
    supportsStreaming: false,
    supportsMedia: true,
    supportsThreading: true,
  };

  /**
   * Not used for email — the SMTP server handles inbound directly,
   * not via HTTP webhook.
   */
  async verifyRequest(): Promise<boolean> {
    return true;
  }

  /**
   * Parse inbound job payload. Already normalized by the SMTP server.
   */
  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  /**
   * Send agent response as an email reply using nodemailer.
   */
  async sendResponse(
    message: NormalizedOutgoingMessage,
    _connection: ResolvedConnection,
  ): Promise<SendResult> {
    const metadata = (message.metadata || {}) as Record<string, unknown>;
    const recipientAddress = readNonEmptyDeliveryMetadataString(metadata.from);
    const sourceMessageId = readNonEmptyDeliveryMetadataString(metadata.messageId);

    if (!recipientAddress) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'email',
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        operatorMessage: 'No email recipient address was present in message metadata.',
        retryable: false,
      });
    }

    // Build CC list: original CC minus our own address (avoid echoing back to self).
    // Do NOT pass BCC on reply — BCC recipients should not receive replies.
    // Note: plus-addressing (user+tag@example.com) is not handled — treated as distinct address.
    const rawCc = Array.isArray(metadata.cc)
      ? metadata.cc.filter((v): v is string => typeof v === 'string')
      : [];
    const selfAddress = _connection.externalIdentifier?.toLowerCase() || '';
    const cc = rawCc.filter((addr) => addr.toLowerCase() !== selfAddress);

    const config = _connection.config || {};
    const emailHeader = typeof config.emailHeader === 'string' ? config.emailHeader : '';
    const emailFooter = typeof config.emailFooter === 'string' ? config.emailFooter : '';

    const csatEnabled = !!config.csatEnabled;
    let csatBlock = '';
    if (csatEnabled) {
      const token = signFeedbackToken({
        tenantId: _connection.tenantId,
        projectId: _connection.projectId,
        sessionId: message.sessionId,
        messageId: sourceMessageId || message.sessionId,
        connectionId: _connection.id,
      });
      csatBlock = buildCsatBlock(token);
    }

    try {
      const htmlBody = wrapHtml(
        emailHeader + (await safeMarked.parse(message.text)) + csatBlock + emailFooter,
      );

      const transport = resolveEmailTransport(_connection);
      const fromAddress = _connection.externalIdentifier || 'agent@localhost';
      const fromName = (_connection.config?.fromName as string) || 'Agent';
      const subject = readNonEmptyDeliveryMetadataString(metadata.subject) || '(no subject)';
      const replySubject = subject.match(/^Re:/i) ? subject : `Re: ${subject}`;
      // RFC 5322: References = prior references chain + message-id we're replying to
      const references = readNonEmptyDeliveryMetadataString(metadata.references);
      const refChain = [references, sourceMessageId].filter(Boolean).join(' ');

      const result = await transport.sendReply({
        to: recipientAddress,
        from: `"${fromName}" <${fromAddress}>`,
        subject: replySubject,
        text: message.text,
        html: htmlBody,
        inReplyTo: sourceMessageId || undefined,
        references: refChain || undefined,
        ...(cc.length > 0 && { cc }),
        headers: { 'X-ABL-Source': 'agent-platform' },
      });

      log.info('Email response sent', {
        to: recipientAddress,
        messageId: result.messageId,
      });

      return { success: true, deliveryId: result.messageId };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      const isConfiguration = isEmailTransportConfigurationError(errMsg);
      const failure = buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'email',
        category: isConfiguration ? 'configuration' : 'network',
        code: isConfiguration ? 'CHANNEL_DELIVERY_CONFIGURATION' : 'CHANNEL_DELIVERY_FAILED',
        operatorMessage: isConfiguration
          ? 'Email transport configuration was incomplete for outbound delivery.'
          : 'Email transport failed before delivery was confirmed.',
        retryable: !isConfiguration,
      });
      const diagnostic = failure.metadata?.channelDiagnostic as { message?: string } | undefined;
      log.error('Failed to send email response', {
        error: diagnostic?.message ?? failure.error,
      });
      return failure;
    }
  }

  /** Email is text-only — no rich transforms. */
  transformOutput(text: string, _actions?: ActionSetIR): ChannelOutput {
    return { kind: 'text', text };
  }
}
