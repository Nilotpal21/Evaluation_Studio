/**
 * Email template catalog. English source-of-truth templates.
 * Each value is an ICU MessageFormat template.
 *
 * Follows the same pattern as ErrorCatalog in errors.ts.
 */

import { formatMessage } from './format-message.js';
import type { Locale, MessageParams } from './types.js';

export const EmailCatalog = {
  // Shared layout
  PLATFORM_NAME: 'Kore Platform',
  FOOTER:
    "This email was sent by Kore Platform. If you didn't request this, you can safely ignore it.",

  // Shared greeting (name-parameterized and default variants)
  GREETING: 'Hi {name},',
  GREETING_DEFAULT: 'Hi,',

  // Verification email
  VERIFY_SUBJECT: 'Verify your email address',
  VERIFY_BODY: 'Thanks for signing up! Please verify your email address to get started.',
  VERIFY_BUTTON: 'Verify Email',
  VERIFY_CODE_PROMPT: 'Or enter this verification code:',
  VERIFY_EXPIRY: 'This link expires in 24 hours.',

  // Password reset email
  RESET_SUBJECT: 'Reset your password',
  RESET_BODY:
    'We received a request to reset your password. Click the button below to choose a new password.',
  RESET_BUTTON: 'Reset Password',
  RESET_EXPIRY:
    "This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.",

  // Workspace invitation email
  INVITE_SUBJECT: '{inviterName} invited you to {workspaceName}',
  INVITE_BODY: '{inviterName} has invited you to join {workspaceName} as a {role}.',
  INVITE_BUTTON: 'Accept Invitation',
  INVITE_EXPIRY: 'This invitation expires in 7 days.',
} as const satisfies Record<string, string>;

export type EmailKey = keyof typeof EmailCatalog;

/**
 * Format an email template string with parameters.
 * Defaults to English; will format with the requested locale once translations are added.
 */
export function formatEmailMessage(
  key: EmailKey,
  params?: MessageParams,
  locale: Locale = 'en',
): string {
  return formatMessage(EmailCatalog[key], params, locale);
}
