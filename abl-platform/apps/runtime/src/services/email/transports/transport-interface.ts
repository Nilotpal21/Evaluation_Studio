/**
 * Pluggable email transport interface.
 *
 * Implementations: SmtpTransport (nodemailer), GraphTransport (Microsoft Graph API).
 * Selected per channel connection via config.outbound.transport.
 */

export interface EmailSendParams {
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string>;
}

export interface EmailTransport {
  sendReply(params: EmailSendParams): Promise<{ messageId: string }>;
  checkHealth?(): Promise<{ healthy: boolean; latencyMs: number }>;
}
