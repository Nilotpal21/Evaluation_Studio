/**
 * Email Sender
 *
 * Backward-compatible wrapper around SmtpTransport.
 * Adds reply-specific logic (Re: prefix, reference chain building)
 * before delegating to the pluggable transport layer.
 */

import { SmtpTransport, type SmtpTransportConfig } from './transports/smtp-transport.js';
import type { EmailSendParams } from './transports/transport-interface.js';

export type { EmailSendParams as SendReplyParams };

export interface EmailSenderConfig extends SmtpTransportConfig {
  fromAddress: string;
  fromName: string;
}

/** @deprecated Use resolveEmailTransport() from transports/resolve-transport.ts for new code. */
export class EmailSender {
  private transport: SmtpTransport;
  private fromAddress: string;
  private fromName: string;

  constructor(config: EmailSenderConfig) {
    this.fromAddress = config.fromAddress;
    this.fromName = config.fromName;
    this.transport = new SmtpTransport(config);
  }

  async sendReply(params: Omit<EmailSendParams, 'from'>): Promise<{ messageId: string }> {
    // Build subject with Re: prefix if not already present
    const subject = params.subject.match(/^Re:/i) ? params.subject : `Re: ${params.subject}`;

    // Build threading references chain
    const refChain = [params.references, params.inReplyTo].filter(Boolean).join(' ');

    return this.transport.sendReply({
      ...params,
      from: `"${this.fromName}" <${this.fromAddress}>`,
      subject,
      ...(refChain && { references: refChain }),
    });
  }
}

/** @deprecated Use resolveEmailTransport() from transports/resolve-transport.ts for new code. */
export function createEmailSenderFromEnv(): EmailSender {
  return new EmailSender({
    host: process.env.SMTP_RELAY_HOST || 'localhost',
    port: parseInt(process.env.SMTP_RELAY_PORT || '587', 10),
    user: process.env.SMTP_RELAY_USER || '',
    pass: process.env.SMTP_RELAY_PASS || '',
    fromAddress: process.env.EMAIL_FROM_ADDRESS || 'agent@localhost',
    fromName: process.env.EMAIL_FROM_NAME || 'Agent',
  });
}
