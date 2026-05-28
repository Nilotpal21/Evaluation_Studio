import 'server-only';
import { createLogger } from '@abl/compiler/platform';
import { createEmailService } from '@agent-platform/shared';
import {
  addAllowedDomain as addAllowedDomainShared,
  addAllowedEmail as addAllowedEmailShared,
  addPlatformAdmin as addPlatformAdminShared,
  canUserCreateWorkspace as canUserCreateWorkspaceShared,
  DEFAULT_ALLOWED_DOMAINS,
  getEmailDomain,
  isEmailAllowedForAuth as isEmailAllowedForAuthShared,
  isPlatformAdminUser as isPlatformAdminUserShared,
  listAccessPolicy as listAccessPolicyShared,
  listAllowedDomains as listAllowedDomainsShared,
  listAllowedEmails as listAllowedEmailsShared,
  listPlatformAdminEmails,
  listPlatformAdmins as listPlatformAdminsShared,
  normalizeEmail,
  normalizeDomain,
  recordPlatformAccessRequest,
  revokeAllowedDomain,
  revokeAllowedEmail as revokeAllowedEmailShared,
  revokePlatformAdmin as revokePlatformAdminShared,
} from '@agent-platform/database/platform-access-policy';
import type { PlatformAdminPrincipal } from '@agent-platform/database/platform-access-policy';
import { ensureDb } from '@/lib/ensure-db';
import { checkIsSuperAdmin } from '@/lib/super-admin';

const log = createLogger('platform-auth-policy');

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function readBootstrapSuperAdminUserIds(): string[] {
  return (process.env.SUPER_ADMIN_USER_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function readEnvEmails(): string[] {
  const raw =
    process.env.PLATFORM_ADMIN_NOTIFICATION_EMAILS ||
    process.env.ADMIN_NOTIFICATION_EMAILS ||
    process.env.ADMIN_EMAIL ||
    '';

  return raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export {
  DEFAULT_ALLOWED_DOMAINS,
  getEmailDomain,
  normalizeDomain,
  normalizeEmail,
  revokeAllowedDomain as removeAllowedDomain,
};

export async function listAllowedDomains(): ReturnType<typeof listAllowedDomainsShared> {
  await ensureDb();
  return listAllowedDomainsShared();
}

export async function listAccessPolicy(): ReturnType<typeof listAccessPolicyShared> {
  await ensureDb();
  return listAccessPolicyShared();
}

export async function listPlatformAdmins(): ReturnType<typeof listPlatformAdminsShared> {
  await ensureDb();
  return listPlatformAdminsShared();
}

export async function isPlatformAdminUser(user: PlatformAdminPrincipal): Promise<boolean> {
  await ensureDb();
  return isPlatformAdminUserShared(user, { isBootstrapSuperAdmin: checkIsSuperAdmin });
}

export async function isEmailAllowedForAuth(
  email: string,
  opts?: { inviteToken?: string },
): Promise<boolean> {
  await ensureDb();
  return isEmailAllowedForAuthShared(email, {
    bootstrapUserIds: readBootstrapSuperAdminUserIds(),
    inviteToken: opts?.inviteToken,
  });
}

export async function addAllowedDomain(domain: string, actorUserId: string): Promise<void> {
  await ensureDb();
  return addAllowedDomainShared(domain, actorUserId);
}

export async function addPlatformAdmin(email: string, actorUserId: string): Promise<void> {
  await ensureDb();
  return addPlatformAdminShared(email, actorUserId);
}

export async function revokePlatformAdmin(email: string): Promise<boolean> {
  await ensureDb();
  return revokePlatformAdminShared(email);
}

export async function canUserCreateWorkspace(email: string): Promise<boolean> {
  await ensureDb();
  return canUserCreateWorkspaceShared(email, {
    bootstrapUserIds: readBootstrapSuperAdminUserIds(),
  });
}

export async function listAllowedEmails(): ReturnType<typeof listAllowedEmailsShared> {
  await ensureDb();
  return listAllowedEmailsShared();
}

export async function addAllowedEmail(email: string, actorUserId: string): Promise<void> {
  await ensureDb();
  return addAllowedEmailShared(email, actorUserId);
}

export async function revokeAllowedEmail(email: string): Promise<boolean> {
  await ensureDb();
  return revokeAllowedEmailShared(email);
}

async function getAccessRequestRecipients(): Promise<string[]> {
  await ensureDb();
  const admins = await listPlatformAdminEmails({
    bootstrapUserIds: readBootstrapSuperAdminUserIds(),
  });
  return [...new Set([...readEnvEmails(), ...admins].filter(Boolean))];
}

export async function sendAccessRequestEmail(params: {
  email: string;
  name?: string;
  message?: string;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  await ensureDb();
  await recordPlatformAccessRequest({
    email: params.email,
    name: params.name,
    message: params.message,
  });

  const recipients = await getAccessRequestRecipients();
  if (recipients.length === 0) {
    log.warn('No platform admin recipients configured for access request; request recorded only', {
      requesterDomain: getEmailDomain(params.email) ?? 'unknown',
    });
    return;
  }

  const subject = `Platform access request: ${params.email}`;
  const body = `
    <p>A user tried to sign in or sign up from a domain that is not allowlisted.</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse: collapse;">
      <tr><td><strong>Email</strong></td><td>${escapeHtml(params.email)}</td></tr>
      <tr><td><strong>Name</strong></td><td>${escapeHtml(params.name || 'Not provided')}</td></tr>
      <tr><td><strong>Message</strong></td><td>${escapeHtml(params.message || 'Not provided')}</td></tr>
      <tr><td><strong>IP</strong></td><td>${escapeHtml(params.ip || 'unknown')}</td></tr>
      <tr><td><strong>User agent</strong></td><td>${escapeHtml(params.userAgent || 'unknown')}</td></tr>
    </table>
    <p>Add the domain or add this user as a platform admin from the Admin Dashboard access page.</p>
  `;

  const emailService = createEmailService();
  const results = await Promise.allSettled(
    recipients.map((recipient) => emailService.sendEmail(recipient, subject, body)),
  );
  const failures = results.filter((result) => result.status === 'rejected').length;
  const successes = results.length - failures;

  if (failures > 0) {
    log.warn('Some platform admin access request notifications failed', {
      requesterDomain: getEmailDomain(params.email) ?? 'unknown',
      failures,
      total: results.length,
    });
  }

  if (successes === 0) {
    log.warn('All platform admin access request notifications failed; request is recorded', {
      requesterDomain: getEmailDomain(params.email) ?? 'unknown',
      failures,
      total: results.length,
    });
  }
}
