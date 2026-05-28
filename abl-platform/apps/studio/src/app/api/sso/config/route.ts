/**
 * POST /api/sso/config - Create/update SSO configuration (admin only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findTenantById, findTenantMemberByUserIdAndRoles } from '@/repos/workspace-repo';
import { createSSOConfig } from '@/repos/org-repo';
import { AuditActions, logAuditEvent } from '@/services/audit-service';
// NOTE: Manual encryption retained — SSO configs are stored inside Organization.ssoConfigs[]
// array subdocuments, which are NOT covered by the Mongoose encryption plugin (it only
// encrypts top-level fields like billingConfig on the parent schema).
import { encryptForTenantAuto, isTenantEncryptionReady } from '@agent-platform/shared/encryption';

const log = createLogger('sso-config-route');

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const body = await request.json();
    const { protocol, forceSso, allowGoogleFallback, saml, oidc } = body;

    if (!protocol || !['saml', 'oidc'].includes(protocol)) {
      return NextResponse.json(
        { error: 'Invalid protocol. Must be "saml" or "oidc".' },
        { status: 400 },
      );
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

    const orgId = tenant.organizationId;
    const configJson = JSON.stringify({ protocol, saml, oidc });

    // Encrypt the config before storing — SSO configs contain secrets (client secrets, certs)
    if (!isTenantEncryptionReady()) {
      return NextResponse.json(
        { error: 'Tenant DEK encryption is not initialized. Cannot store SSO config.' },
        { status: 503 },
      );
    }
    const encryptedConfig = await encryptForTenantAuto(configJson, orgId, '_tenant', '_tenant');

    const ssoConfig = await createSSOConfig({
      organizationId: orgId,
      protocol,
      encryptedConfig,
      forceSso: forceSso ?? false,
      allowGoogleFallback: allowGoogleFallback ?? true,
    });

    await logAuditEvent({
      userId: user.id,
      tenantId: tenantMember.tenantId,
      action: AuditActions.SSO_CONFIG_CREATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        organizationId: orgId,
        protocol,
        forceSso: ssoConfig.forceSso,
        allowGoogleFallback: ssoConfig.allowGoogleFallback,
        resourceType: 'sso_config',
        resourceId: ssoConfig.id,
      },
    });

    return NextResponse.json({
      id: ssoConfig.id,
      protocol: ssoConfig.protocol,
      forceSso: ssoConfig.forceSso,
      allowGoogleFallback: ssoConfig.allowGoogleFallback,
    });
  } catch (error) {
    log.error('SSO config creation error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
