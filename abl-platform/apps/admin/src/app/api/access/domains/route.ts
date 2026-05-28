import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAdminRoute, type AdminRouteContext } from '../../../../lib/with-admin-route';
import { readValidatedJsonBody } from '../../../../lib/validated-json-body';
import { logAdminAction } from '../../../../lib/audit-logger';
import {
  addAllowedDomain,
  listAccessPolicy,
  revokeAllowedDomain,
  normalizeDomain,
} from '../../../../lib/platform-access-policy';

const domainBodySchema = z.object({ domain: z.string().min(1) }).strict();

export const GET = withAdminRoute({ role: 'VIEWER' }, async () => {
  const policy = await listAccessPolicy();
  return NextResponse.json(policy);
});

export const POST = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const parsedBody = await readValidatedJsonBody(ctx.request, domainBodySchema);
  if (!parsedBody.success) {
    return parsedBody.response;
  }

  try {
    await addAllowedDomain(parsedBody.data.domain, ctx.user.userId);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Invalid domain' },
      { status: 400 },
    );
  }

  await logAdminAction({
    actor: ctx.user.userId,
    actorRole: ctx.user.role,
    action: 'platform_domain_add',
    target: `platform/domain/${parsedBody.data.domain}`,
    ipAddress: ctx.user.ipAddress,
  });

  return NextResponse.json(await listAccessPolicy());
});

export const DELETE = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const domain = normalizeDomain(ctx.request.nextUrl.searchParams.get('domain') || '');
  if (!domain) {
    return NextResponse.json({ success: false, error: 'Domain required' }, { status: 400 });
  }

  let removed: boolean;
  try {
    removed = await revokeAllowedDomain(domain);
    if (!removed) {
      return NextResponse.json({ success: false, error: 'Domain not found' }, { status: 404 });
    }
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Invalid domain' },
      { status: 400 },
    );
  }

  await logAdminAction({
    actor: ctx.user.userId,
    actorRole: ctx.user.role,
    action: 'platform_domain_revoke',
    target: `platform/domain/${domain}`,
    ipAddress: ctx.user.ipAddress,
  });

  return NextResponse.json(await listAccessPolicy());
});
