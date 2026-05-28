import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAdminRoute, type AdminRouteContext } from '../../../../lib/with-admin-route';
import { readValidatedJsonBody } from '../../../../lib/validated-json-body';
import { logAdminAction } from '../../../../lib/audit-logger';
import {
  addPlatformAdmin,
  listAccessPolicy,
  normalizeEmail,
  revokePlatformAdmin,
} from '../../../../lib/platform-access-policy';

const adminBodySchema = z.object({ email: z.string().email().max(254) }).strict();

export const GET = withAdminRoute({ role: 'VIEWER' }, async () => {
  const policy = await listAccessPolicy();
  return NextResponse.json(policy);
});

export const POST = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const parsedBody = await readValidatedJsonBody(ctx.request, adminBodySchema);
  if (!parsedBody.success) {
    return parsedBody.response;
  }

  try {
    await addPlatformAdmin(parsedBody.data.email, ctx.user.userId);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Invalid email' },
      { status: 400 },
    );
  }

  await logAdminAction({
    actor: ctx.user.userId,
    actorRole: ctx.user.role,
    action: 'platform_admin_grant',
    target: `platform/admin/${parsedBody.data.email}`,
    ipAddress: ctx.user.ipAddress,
  });

  return NextResponse.json(await listAccessPolicy());
});

export const DELETE = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const email = normalizeEmail(ctx.request.nextUrl.searchParams.get('email') || '');
  if (!email) {
    return NextResponse.json({ success: false, error: 'Email required' }, { status: 400 });
  }

  if (email === normalizeEmail(ctx.user.email)) {
    return NextResponse.json(
      { success: false, error: 'You cannot revoke your own platform admin access.' },
      { status: 400 },
    );
  }

  let revoked: boolean;
  try {
    revoked = await revokePlatformAdmin(email);
    if (!revoked) {
      return NextResponse.json(
        { success: false, error: 'Platform admin not found' },
        { status: 404 },
      );
    }
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Invalid email' },
      { status: 400 },
    );
  }

  await logAdminAction({
    actor: ctx.user.userId,
    actorRole: ctx.user.role,
    action: 'platform_admin_revoke',
    target: `platform/admin/${email}`,
    ipAddress: ctx.user.ipAddress,
  });

  return NextResponse.json(await listAccessPolicy());
});
