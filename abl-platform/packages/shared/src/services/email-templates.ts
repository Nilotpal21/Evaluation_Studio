/**
 * Email Templates
 *
 * Inline HTML templates for transactional emails.
 * All user-facing strings are sourced from the i18n EmailCatalog.
 */

import { formatEmailMessage } from '@agent-platform/i18n';
import type { Locale } from '@agent-platform/i18n';

/** Escape HTML special characters to prevent XSS in email content */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function baseLayout(content: string, locale: Locale = 'en'): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background: #f4f4f5; }
    .container { max-width: 560px; margin: 40px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .header { background: #18181b; padding: 24px 32px; }
    .header h1 { color: #ffffff; font-size: 18px; margin: 0; font-weight: 600; }
    .body { padding: 32px; color: #27272a; line-height: 1.6; }
    .body p { margin: 0 0 16px; }
    .button { display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 14px; }
    .code { display: inline-block; padding: 12px 24px; background: #f4f4f5; border-radius: 6px; font-size: 24px; font-weight: 700; letter-spacing: 4px; color: #18181b; font-family: monospace; }
    .footer { padding: 16px 32px; background: #fafafa; color: #71717a; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>${formatEmailMessage('PLATFORM_NAME', undefined, locale)}</h1></div>
    <div class="body">${content}</div>
    <div class="footer">${formatEmailMessage('FOOTER', undefined, locale)}</div>
  </div>
</body>
</html>`;
}

export function verificationEmail(params: {
  name?: string;
  verificationUrl: string;
  code?: string;
  locale?: Locale;
}): { subject: string; html: string } {
  const locale = params.locale ?? 'en';
  const greeting = params.name
    ? formatEmailMessage('GREETING', { name: escapeHtml(params.name) }, locale)
    : formatEmailMessage('GREETING_DEFAULT', undefined, locale);
  const codeBlock = params.code
    ? `<p>${formatEmailMessage('VERIFY_CODE_PROMPT', undefined, locale)}</p><p><span class="code">${escapeHtml(params.code)}</span></p>`
    : '';

  return {
    subject: formatEmailMessage('VERIFY_SUBJECT', undefined, locale),
    html: baseLayout(
      `
      <p>${greeting}</p>
      <p>${formatEmailMessage('VERIFY_BODY', undefined, locale)}</p>
      <p><a href="${escapeHtml(params.verificationUrl)}" class="button">${formatEmailMessage('VERIFY_BUTTON', undefined, locale)}</a></p>
      ${codeBlock}
      <p>${formatEmailMessage('VERIFY_EXPIRY', undefined, locale)}</p>
    `,
      locale,
    ),
  };
}

export function passwordResetEmail(params: { name?: string; resetUrl: string; locale?: Locale }): {
  subject: string;
  html: string;
} {
  const locale = params.locale ?? 'en';
  const greeting = params.name
    ? formatEmailMessage('GREETING', { name: escapeHtml(params.name) }, locale)
    : formatEmailMessage('GREETING_DEFAULT', undefined, locale);

  return {
    subject: formatEmailMessage('RESET_SUBJECT', undefined, locale),
    html: baseLayout(
      `
      <p>${greeting}</p>
      <p>${formatEmailMessage('RESET_BODY', undefined, locale)}</p>
      <p><a href="${escapeHtml(params.resetUrl)}" class="button">${formatEmailMessage('RESET_BUTTON', undefined, locale)}</a></p>
      <p>${formatEmailMessage('RESET_EXPIRY', undefined, locale)}</p>
    `,
      locale,
    ),
  };
}

export function workspaceInvitationEmail(params: {
  inviterName: string;
  workspaceName: string;
  role: string;
  acceptUrl: string;
  locale?: Locale;
}): { subject: string; html: string } {
  const locale = params.locale ?? 'en';

  const INVITER_TOKEN = '__INVITER__';
  const WORKSPACE_TOKEN = '__WORKSPACE__';
  const ROLE_TOKEN = '__ROLE__';
  const body = formatEmailMessage(
    'INVITE_BODY',
    {
      inviterName: INVITER_TOKEN,
      workspaceName: WORKSPACE_TOKEN,
      role: ROLE_TOKEN,
    },
    locale,
  )
    .replace(INVITER_TOKEN, `<strong>${escapeHtml(params.inviterName)}</strong>`)
    .replace(WORKSPACE_TOKEN, `<strong>${escapeHtml(params.workspaceName)}</strong>`)
    .replace(ROLE_TOKEN, `<strong>${escapeHtml(params.role)}</strong>`);

  return {
    subject: formatEmailMessage(
      'INVITE_SUBJECT',
      { inviterName: params.inviterName, workspaceName: params.workspaceName },
      locale,
    ),
    html: baseLayout(
      `
      <p>${formatEmailMessage('GREETING_DEFAULT', undefined, locale)}</p>
      <p>${body}</p>
      <p><a href="${escapeHtml(params.acceptUrl)}" class="button">${formatEmailMessage('INVITE_BUTTON', undefined, locale)}</a></p>
      <p>${formatEmailMessage('INVITE_EXPIRY', undefined, locale)}</p>
    `,
      locale,
    ),
  };
}
