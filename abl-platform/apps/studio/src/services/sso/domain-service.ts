/**
 * Domain Service
 *
 * Maps email domains to organizations for SSO routing.
 * Supports DNS TXT verification for domain ownership.
 */

import crypto from 'crypto';
import {
  findDomainMapping,
  upsertDomainMapping,
  updateDomainMapping,
  deleteDomainMapping,
  findDomainMappings,
  findSSOConfig,
} from '@/repos/org-repo';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';

/**
 * Look up which organization owns a domain.
 * Returns null if domain is not mapped or not verified.
 */
export async function lookupDomainOrg(emailDomain: string): Promise<{
  organizationId: string;
  ssoConfigId?: string;
} | null> {
  const mapping = await findDomainMapping(emailDomain.toLowerCase());

  if (!mapping || !mapping.verified) {
    return null;
  }

  // Find active SSO config for this org
  const ssoConfig = await findSSOConfig(mapping.organizationId);

  return {
    organizationId: mapping.organizationId,
    ssoConfigId: ssoConfig?.isActive ? ssoConfig.id : undefined,
  };
}

/**
 * Create a domain claim for an organization.
 * Generates a verification token for DNS TXT record.
 */
export async function claimDomain(
  organizationId: string,
  domain: string,
): Promise<{ verificationToken: string }> {
  const normalizedDomain = domain.toLowerCase();

  // Check for existing claim by another org
  const existing = await findDomainMapping(normalizedDomain);

  if (existing && existing.organizationId !== organizationId) {
    if (existing.verified) {
      throw new AppError(`Domain ${domain} is already claimed by another organization.`, {
        ...ErrorCodes.BAD_REQUEST,
      });
    }
    // Unverified claim by another org — allow override
    await deleteDomainMapping(normalizedDomain);
  }

  const verificationToken = `kore-verify=${crypto.randomBytes(16).toString('hex')}`;

  await upsertDomainMapping(normalizedDomain, {
    organizationId,
    verificationToken,
    verified: false,
    verifiedAt: null,
  });

  return { verificationToken };
}

/**
 * Verify domain ownership via DNS TXT record lookup.
 */
export async function verifyDomain(organizationId: string, domain: string): Promise<boolean> {
  const normalizedDomain = domain.toLowerCase();

  const mapping = await findDomainMapping(normalizedDomain);

  if (!mapping || mapping.organizationId !== organizationId) {
    throw new AppError('Domain not claimed by this organization.', { ...ErrorCodes.FORBIDDEN });
  }

  if (mapping.verified) {
    return true; // Already verified
  }

  // DNS TXT record lookup
  try {
    const dns = await import('node:dns/promises');
    const records = await dns.resolveTxt(`_kore-verification.${normalizedDomain}`);
    const flatRecords = records.flat();

    const verified = flatRecords.some((r) => r === mapping.verificationToken);

    if (verified) {
      await updateDomainMapping(normalizedDomain, {
        verified: true,
        verifiedAt: new Date(),
      });
    }

    return verified;
  } catch (error) {
    // DNS lookup failed — not verified
    return false;
  }
}

/**
 * List domains for an organization.
 */
export async function listOrgDomains(organizationId: string) {
  return findDomainMappings(organizationId);
}
