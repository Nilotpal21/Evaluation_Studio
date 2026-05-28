import { createEmailService } from '@agent-platform/shared';
import {
  addAllowedDomain as addAllowedDomainShared,
  addAllowedEmail as addAllowedEmailShared,
  addPlatformAdmin as addPlatformAdminShared,
  DEFAULT_ALLOWED_DOMAINS,
  isPlatformAdminUser as isPlatformAdminUserShared,
  isValidAllowedDomain,
  isValidEmail,
  listAccessPolicy as listAccessPolicyShared,
  listPendingAccessRequestsForDomain,
  markAccessRequestsNotified,
  normalizeDomain,
  normalizeEmail,
  revokeAllowedDomain as revokeAllowedDomainShared,
  revokeAllowedEmail as revokeAllowedEmailShared,
  revokePlatformAdmin as revokePlatformAdminShared,
} from '@agent-platform/database/platform-access-policy';
import type {
  PlatformAccessPolicy,
  PlatformAccessRequestRecord,
  PlatformAdminPrincipal,
} from '@agent-platform/database/platform-access-policy';
import { ensureDb } from './ensure-db';
import { createLogger } from './logger';
import { buildStudioBrowserUrl } from './studio-url';

const log = createLogger('platform-access-policy');

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getStudioLoginUrl(): string {
  return buildStudioBrowserUrl('/auth/login').toString();
}

function buildDomainApprovedEmail(request: PlatformAccessRequestRecord): {
  subject: string;
  html: string;
} {
  const loginUrl = getStudioLoginUrl();
  const greeting = request.name ? `Hi ${escapeHtml(request.name)},` : 'Hi,';
  return {
    subject: 'Your platform access request was approved',
    html: `
      <p>${greeting}</p>
      <p>Your email domain <strong>${escapeHtml(request.domain)}</strong> has been approved for platform access.</p>
      <p>You can now sign in with <strong>${escapeHtml(request.email)}</strong>.</p>
      <p><a href="${escapeHtml(loginUrl)}">Sign in to the platform</a></p>
    `,
  };
}

export async function addAllowedDomain(domain: string, actorUserId: string): Promise<number> {
  await ensureDb();
  await addAllowedDomainShared(domain, actorUserId);
  const normalizedDomain = normalizeDomain(domain);
  const requests = await listPendingAccessRequestsForDomain(normalizedDomain);
  if (requests.length === 0) {
    return 0;
  }

  const emailService = createEmailService();
  const results = await Promise.allSettled(
    requests.map(async (request) => {
      const email = buildDomainApprovedEmail(request);
      await emailService.sendEmail(request.email, email.subject, email.html);
      return request.id;
    }),
  );

  const notifiedIds = results
    .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
    .map((result) => result.value);
  const failures = results.filter((result) => result.status === 'rejected').length;

  if (failures > 0) {
    log.warn('Some platform access approval notifications failed', {
      domain: normalizedDomain,
      failures,
      total: requests.length,
    });
  }

  await markAccessRequestsNotified(notifiedIds);
  return notifiedIds.length;
}

export async function addPlatformAdmin(email: string, actorUserId: string): Promise<void> {
  await ensureDb();
  await addPlatformAdminShared(email, actorUserId);
}

export async function isPlatformAdminUser(
  user: PlatformAdminPrincipal,
  options?: { isBootstrapSuperAdmin?: (userId: string) => boolean },
): Promise<boolean> {
  if (options?.isBootstrapSuperAdmin?.(user.id)) {
    return true;
  }

  await ensureDb();
  return isPlatformAdminUserShared(user, options);
}

export async function listAccessPolicy(): Promise<PlatformAccessPolicy> {
  await ensureDb();
  return listAccessPolicyShared();
}

export async function revokeAllowedDomain(domain: string): Promise<boolean> {
  await ensureDb();
  return revokeAllowedDomainShared(domain);
}

export async function revokePlatformAdmin(email: string): Promise<boolean> {
  await ensureDb();
  return revokePlatformAdminShared(email);
}

export async function addAllowedEmail(email: string, actorUserId: string): Promise<void> {
  await ensureDb();
  return addAllowedEmailShared(email, actorUserId);
}

export async function revokeAllowedEmail(email: string): Promise<boolean> {
  await ensureDb();
  return revokeAllowedEmailShared(email);
}

export {
  DEFAULT_ALLOWED_DOMAINS,
  isValidAllowedDomain,
  isValidEmail,
  normalizeDomain,
  normalizeEmail,
};
export type { PlatformAccessPolicy };
