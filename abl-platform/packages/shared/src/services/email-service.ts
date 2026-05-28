/**
 * Email Service
 *
 * Pluggable email abstraction — multiple providers.
 * Priority: SES (AWS_SES_REGION) > Resend (RESEND_API_KEY) > SMTP (SMTP_HOST) > Console.
 *
 * Provider SDKs (@aws-sdk/client-ses, nodemailer) are lazily imported so the
 * module can be loaded without those packages installed — the process only
 * crashes if you actually *select* a provider whose SDK is missing.
 */

export interface EmailService {
  sendEmail(to: string, subject: string, html: string): Promise<void>;
}

export class ConsoleEmailService implements EmailService {
  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    console.log(`\n[EMAIL] To: ${to}`);
    console.log(`[EMAIL] Subject: ${subject}`);
    console.log(`[EMAIL] Body:\n${html}\n`);
  }
}

export class SESEmailService implements EmailService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private clientPromise: Promise<any>;
  private from: string;

  constructor(region: string, from: string) {
    this.from = from;
    this.clientPromise = import('@aws-sdk/client-ses').then(
      ({ SESClient }) => new SESClient({ region }),
    );
  }

  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    const { SendEmailCommand } = await import('@aws-sdk/client-ses');
    const client = await this.clientPromise;
    await client.send(
      new SendEmailCommand({
        Source: this.from,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: subject },
          Body: { Html: { Data: html } },
        },
      }),
    );
  }
}

export class ResendEmailService implements EmailService {
  constructor(
    private apiKey: string,
    private from: string,
  ) {}

  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ from: this.from, to, subject, html }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Email send failed: ${response.status} ${error}`);
    }
  }
}

export class SmtpEmailService implements EmailService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private transporterPromise: Promise<any>;
  private from: string;

  constructor(opts: { host: string; port: number; user?: string; pass?: string; from: string }) {
    this.from = opts.from;
    this.transporterPromise = import('nodemailer').then(({ createTransport }) =>
      createTransport({
        host: opts.host,
        port: opts.port,
        secure: opts.port === 465,
        ...(opts.user && { auth: { user: opts.user, pass: opts.pass ?? '' } }),
      }),
    );
  }

  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    const transporter = await this.transporterPromise;
    await transporter.sendMail({ from: this.from, to, subject, html });
  }
}

let emailServiceInstance: EmailService | null = null;

export function createEmailService(): EmailService {
  if (emailServiceInstance) return emailServiceInstance;

  const sesRegion = process.env.AWS_SES_REGION;
  const resendKey = process.env.RESEND_API_KEY;
  const smtpHost = process.env.SMTP_HOST;
  const from = process.env.EMAIL_FROM || 'noreply@koreplatform.com';

  if (sesRegion) {
    emailServiceInstance = new SESEmailService(sesRegion, from);
  } else if (resendKey) {
    emailServiceInstance = new ResendEmailService(resendKey, from);
  } else if (smtpHost) {
    emailServiceInstance = new SmtpEmailService({
      host: smtpHost,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from,
    });
  } else {
    emailServiceInstance = new ConsoleEmailService();
  }

  return emailServiceInstance;
}

/** Reset the singleton — for testing only. */
export function resetEmailService(): void {
  emailServiceInstance = null;
}
