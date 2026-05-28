import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAdminRoute, type AdminRouteContext } from '../../../../lib/with-admin-route';
import { readValidatedJsonBody } from '../../../../lib/validated-json-body';
import { logAdminAction } from '../../../../lib/audit-logger';
import {
  addAllowedEmail,
  listAccessPolicy,
  normalizeEmail,
  revokeAllowedEmail,
} from '../../../../lib/platform-access-policy';

const emailBodySchema = z.object({ email: z.string().email().max(254) }).strict();

export const GET = withAdminRoute({ role: 'VIEWER' }, async () => {
  const policy = await listAccessPolicy();
  return NextResponse.json(policy);
});

export const POST = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const parsedBody = await readValidatedJsonBody(ctx.request, emailBodySchema);
  if (!parsedBody.success) {
    return parsedBody.response;
  }

  try {
    await addAllowedEmail(parsedBody.data.email, ctx.user.userId);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Invalid email' },
      { status: 400 },
    );
  }

  await logAdminAction({
    actor: ctx.user.userId,
    actorRole: ctx.user.role,
    action: 'platform_email_allow',
    target: `platform/email/${parsedBody.data.email}`,
    ipAddress: ctx.user.ipAddress,
  });

  return NextResponse.json(await listAccessPolicy());
});

export const DELETE = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const email = normalizeEmail(ctx.request.nextUrl.searchParams.get('email') || '');
  if (!email) {
    return NextResponse.json({ success: false, error: 'Email required' }, { status: 400 });
  }

  let removed: boolean;
  try {
    removed = await revokeAllowedEmail(email);
    if (!removed) {
      return NextResponse.json({ success: false, error: 'Email not found' }, { status: 404 });
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
    action: 'platform_email_revoke',
    target: `platform/email/${email}`,
    ipAddress: ctx.user.ipAddress,
  });

  return NextResponse.json(await listAccessPolicy());
});
