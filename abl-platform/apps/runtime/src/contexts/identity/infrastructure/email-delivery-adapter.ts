/**
 * Email Delivery Adapter
 *
 * Infrastructure adapter implementing the VerificationDeliveryService port
 * for email-based code delivery. Accepts an EmailSender dependency via DI
 * (structurally matching packages/shared EmailService) — the identity context
 * does NOT import packages/shared directly, preserving hexagonal architecture.
 *
 * SMS delivery is deferred (GAP-017) — logs a warning and returns failure.
 */

import { createLogger } from '@abl/compiler/platform';
import type { VerificationDeliveryService } from '../domain/verification-delivery.js';

const log = createLogger('email-delivery-adapter');

// =============================================================================
// LOCAL INTERFACE — structurally matches EmailService from packages/shared
// =============================================================================

/**
 * Minimal email sender interface. Structurally compatible with
 * `EmailService` from `@agent-platform/shared` but defined locally
 * to preserve the identity context's isolation from packages/shared.
 */
export interface EmailSender {
  sendEmail(to: string, subject: string, html: string): Promise<void>;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Escape HTML special characters to prevent injection in email templates. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class EmailDeliveryAdapter implements VerificationDeliveryService {
  constructor(private readonly emailSender: EmailSender) {}

  async deliverCode(
    channel: 'email' | 'sms',
    to: string,
    code: string,
    _metadata?: Record<string, unknown>,
  ): Promise<{ delivered: boolean; error?: string }> {
    if (channel === 'sms') {
      log.warn('SMS delivery not configured', { to });
      return { delivered: false, error: 'SMS delivery not configured' };
    }

    try {
      const subject = 'Your verification code';
      const html = this.buildEmailTemplate(code);
      await this.emailSender.sendEmail(to, subject, html);
      log.info('Verification code delivered via email', { to });
      return { delivered: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Email delivery failed', { to, error: message });
      return { delivered: false, error: message };
    }
  }

  /**
   * Build a simple HTML email template for OTP/magic-link delivery.
   * The code may be a 6-digit OTP or a magic-link token/URL.
   */
  private buildEmailTemplate(code: string): string {
    const safeCode = escapeHtml(code);

    // If the code looks like a URL, render it as a magic link
    if (code.startsWith('http://') || code.startsWith('https://')) {
      return [
        '<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">',
        '<h2>Verify your identity</h2>',
        '<p>Click the link below to verify your identity:</p>',
        `<p><a href="${safeCode}" style="display: inline-block; padding: 12px 24px; background: #0066cc; color: #fff; text-decoration: none; border-radius: 4px;">Verify Identity</a></p>`,
        '<p style="color: #666; font-size: 14px;">If you did not request this verification, you can safely ignore this email.</p>',
        '</div>',
      ].join('\n');
    }

    // Otherwise, render it as an OTP code
    return [
      '<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">',
      '<h2>Your verification code</h2>',
      `<p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; padding: 16px; background: #f5f5f5; border-radius: 8px;">${safeCode}</p>`,
      '<p>Enter this code to verify your identity. It will expire shortly.</p>',
      '<p style="color: #666; font-size: 14px;">If you did not request this verification, you can safely ignore this email.</p>',
      '</div>',
    ].join('\n');
  }
}
