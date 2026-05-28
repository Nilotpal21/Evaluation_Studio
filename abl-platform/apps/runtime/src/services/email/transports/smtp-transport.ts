/**
 * SMTP Transport
 *
 * Implements EmailTransport using nodemailer.
 * Extracted from EmailSender to allow pluggable transport selection.
 */

import { createTransport, type Transporter } from 'nodemailer';
import { createLogger } from '@abl/compiler/platform';
import type { EmailTransport, EmailSendParams } from './transport-interface.js';

const log = createLogger('smtp-transport');

export interface SmtpTransportConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export class SmtpTransport implements EmailTransport {
  private transporter: Transporter;

  constructor(config: SmtpTransportConfig) {
    this.transporter = createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
    });
  }

  async sendReply(params: EmailSendParams): Promise<{ messageId: string }> {
    const mailOptions: Record<string, unknown> = {
      from: params.from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      headers: { 'X-ABL-Source': 'agent-platform', ...params.headers },
    };

    if (params.html) mailOptions.html = params.html;
    if (params.inReplyTo) mailOptions.inReplyTo = params.inReplyTo;
    if (params.references) mailOptions.references = params.references;
    if (params.cc && params.cc.length > 0) mailOptions.cc = params.cc;
    if (params.bcc && params.bcc.length > 0) mailOptions.bcc = params.bcc;

    const result = await this.transporter.sendMail(mailOptions);
    log.info('Email sent via SMTP', {
      to: params.to,
      subject: params.subject,
      messageId: result.messageId,
    });
    return { messageId: result.messageId };
  }

  async checkHealth(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.transporter.verify();
      return { healthy: true, latencyMs: Date.now() - start };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }
}
