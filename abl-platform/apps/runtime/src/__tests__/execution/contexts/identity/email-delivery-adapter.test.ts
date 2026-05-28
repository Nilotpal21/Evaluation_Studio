/**
 * EmailDeliveryAdapter — Unit Tests
 *
 * Tests the email delivery adapter in isolation with an injected mock EmailSender.
 * Covers: email success, email error, SMS fallback, OTP template, magic-link URL
 * template, and HTML escaping.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  EmailDeliveryAdapter,
  type EmailSender,
} from '../../../../contexts/identity/infrastructure/email-delivery-adapter.js';

function createMockSender(): EmailSender & {
  calls: Array<{ to: string; subject: string; html: string }>;
} {
  const calls: Array<{ to: string; subject: string; html: string }> = [];
  return {
    calls,
    async sendEmail(to: string, subject: string, html: string): Promise<void> {
      calls.push({ to, subject, html });
    },
  };
}

describe('EmailDeliveryAdapter', () => {
  it('delivers OTP code via email successfully', async () => {
    const sender = createMockSender();
    const adapter = new EmailDeliveryAdapter(sender);

    const result = await adapter.deliverCode('email', 'user@example.com', '123456');

    expect(result).toEqual({ delivered: true });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].to).toBe('user@example.com');
    expect(sender.calls[0].subject).toBe('Your verification code');
    expect(sender.calls[0].html).toContain('123456');
  });

  it('returns failure for SMS channel (deferred GAP-017)', async () => {
    const sender = createMockSender();
    const adapter = new EmailDeliveryAdapter(sender);

    const result = await adapter.deliverCode('sms', '+1234567890', '123456');

    expect(result).toEqual({ delivered: false, error: 'SMS delivery not configured' });
    expect(sender.calls).toHaveLength(0);
  });

  it('returns failure when email sender throws', async () => {
    const sender: EmailSender = {
      sendEmail: vi.fn().mockRejectedValue(new Error('SMTP connection refused')),
    };
    const adapter = new EmailDeliveryAdapter(sender);

    const result = await adapter.deliverCode('email', 'user@example.com', '123456');

    expect(result).toEqual({ delivered: false, error: 'SMTP connection refused' });
  });

  it('returns failure with String(err) for non-Error throws', async () => {
    const sender: EmailSender = {
      sendEmail: vi.fn().mockRejectedValue('network timeout'),
    };
    const adapter = new EmailDeliveryAdapter(sender);

    const result = await adapter.deliverCode('email', 'user@example.com', '123456');

    expect(result).toEqual({ delivered: false, error: 'network timeout' });
  });

  it('renders OTP code as large centered text in email template', async () => {
    const sender = createMockSender();
    const adapter = new EmailDeliveryAdapter(sender);

    await adapter.deliverCode('email', 'user@example.com', '789012');

    const html = sender.calls[0].html;
    expect(html).toContain('Your verification code');
    expect(html).toContain('789012');
    expect(html).toContain('font-size: 32px');
    expect(html).not.toContain('<a href=');
  });

  it('renders magic-link URL as clickable button in email template', async () => {
    const sender = createMockSender();
    const adapter = new EmailDeliveryAdapter(sender);

    await adapter.deliverCode(
      'email',
      'user@example.com',
      'https://app.example.com/verify?token=abc123',
    );

    const html = sender.calls[0].html;
    expect(html).toContain('Verify your identity');
    expect(html).toContain('<a href=');
    expect(html).toContain('Verify Identity');
    expect(html).not.toContain('Your verification code');
  });

  it('also treats http:// URLs as magic links', async () => {
    const sender = createMockSender();
    const adapter = new EmailDeliveryAdapter(sender);

    await adapter.deliverCode('email', 'user@example.com', 'http://localhost:3000/verify?t=abc');

    const html = sender.calls[0].html;
    expect(html).toContain('<a href=');
  });

  it('HTML-escapes code to prevent injection', async () => {
    const sender = createMockSender();
    const adapter = new EmailDeliveryAdapter(sender);

    await adapter.deliverCode('email', 'user@example.com', '<script>alert("xss")</script>');

    const html = sender.calls[0].html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
