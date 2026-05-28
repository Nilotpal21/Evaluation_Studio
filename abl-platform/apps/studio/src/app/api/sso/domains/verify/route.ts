/**
 * POST /api/sso/domains/verify - Verify domain ownership via DNS TXT record
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findTenantById, findTenantMemberByUserIdAndRoles } from '@/repos/workspace-repo';
import { findDomainMapping, updateDomainMapping } from '@/repos/org-repo';
import { AuditActions, logAuditEvent } from '@/services/audit-service';

const log = createLogger('sso-domain-verify-route');

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const { domain } = await request.json();

    if (!domain || !/^[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}$/.test(domain)) {
      return NextResponse.json({ error: 'Invalid domain format' }, { status: 400 });
    }

    // Get user's tenant membership with admin role check
    const tenantMember = await findTenantMemberByUserIdAndRoles(user.id, ['OWNER', 'ADMIN']);

    if (!tenantMember) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const tenant = await findTenantById(tenantMember.tenantId);
    if (!tenant || !tenant.organizationId) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const domainRecord = await findDomainMapping(domain);

    if (!domainRecord || domainRecord.organizationId !== tenant.organizationId) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 });
    }

    if (domainRecord.verified) {
      return NextResponse.json({ domain, verified: true, message: 'Domain already verified' });
    }

    // Verify DNS TXT record
    const dns = await import('dns');
    const { promisify } = await import('util');
    const resolveTxt = promisify(dns.resolveTxt);

    try {
      const records = await resolveTxt(`_kore-verification.${domain}`);
      const flatRecords = records.flat();
      const verified = flatRecords.includes(domainRecord.verificationToken);

      if (verified) {
        await updateDomainMapping(domain, { verified: true });

        await logAuditEvent({
          userId: user.id,
          tenantId: tenantMember.tenantId,
          action: AuditActions.SSO_DOMAIN_VERIFIED,
          ip: request.headers.get('x-forwarded-for') || undefined,
          userAgent: request.headers.get('user-agent') || undefined,
          metadata: {
            organizationId: tenant.organizationId,
            domain,
            resourceType: 'sso_domain',
            resourceId: domain,
          },
        });
      }

      return NextResponse.json({ domain, verified });
    } catch {
      return NextResponse.json({ domain, verified: false, message: 'DNS record not found' });
    }
  } catch (error) {
    log.error('SSO domain verify error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
