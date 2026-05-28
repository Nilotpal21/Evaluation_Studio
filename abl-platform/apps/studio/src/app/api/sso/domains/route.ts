/**
 * POST /api/sso/domains - Claim a domain for SSO
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findTenantById, findTenantMemberByUserIdAndRoles } from '@/repos/workspace-repo';
import { findDomainMapping, upsertDomainMapping } from '@/repos/org-repo';
import { checkRateLimit } from '@/lib/rate-limit';
import { getConfig, isConfigLoaded } from '@/config';
import { AUTH_CONFIG_DEFAULTS } from '@/lib/auth-constants';

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const rlConfig = isConfigLoaded()
      ? getConfig().auth.rateLimits.ssoDomains
      : AUTH_CONFIG_DEFAULTS.rateLimits.ssoDomains;
    const rl = await checkRateLimit(
      `sso-domains:${user.id}`,
      rlConfig.maxAttempts,
      rlConfig.windowMs,
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429 },
      );
    }

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

    // Check if domain is already claimed
    const existing = await findDomainMapping(domain);
    if (existing) {
      return NextResponse.json({ error: 'Domain already claimed' }, { status: 409 });
    }

    const verificationToken = crypto.randomUUID();

    await upsertDomainMapping(domain, {
      organizationId: tenant.organizationId,
      verificationToken,
      verified: false,
    });

    return NextResponse.json({
      domain,
      verificationToken,
      instructions: `Add a TXT record to _kore-verification.${domain} with value: ${verificationToken}`,
    });
  } catch (error) {
    console.error('[SSO] Domain claim error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
