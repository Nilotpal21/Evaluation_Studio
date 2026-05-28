import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  buildAdminLoginUrl,
  buildStudioAdminCallbackUrl,
} from '../../../../lib/admin-auth-redirect';
import { buildStudioBrowserUrl } from '../../../../lib/studio-url';

const ssoRequestSchema = z.object({
  email: z.string().email(),
  redirect: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const redirectPath = request.nextUrl.searchParams.get('redirect');
  const parsed = ssoRequestSchema.safeParse({
    email: request.nextUrl.searchParams.get('email'),
    redirect: redirectPath || undefined,
  });

  if (!parsed.success) {
    return NextResponse.redirect(
      buildAdminLoginUrl(request, {
        redirectPath,
        error: 'Enter a valid work email to continue with SSO.',
      }),
    );
  }

  const callbackUrl = buildStudioAdminCallbackUrl(request, parsed.data.redirect);
  const studioSsoUrl = buildStudioBrowserUrl('/api/sso/init');
  studioSsoUrl.searchParams.set('email', parsed.data.email);
  studioSsoUrl.searchParams.set('mode', 'redirect');
  studioSsoUrl.searchParams.set('admin_redirect', callbackUrl.toString());

  return NextResponse.redirect(studioSsoUrl);
}
