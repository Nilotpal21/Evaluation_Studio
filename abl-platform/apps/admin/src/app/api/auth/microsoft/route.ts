import { NextRequest, NextResponse } from 'next/server';
import { buildStudioAdminCallbackUrl } from '../../../../lib/admin-auth-redirect';
import { buildStudioBrowserUrl } from '../../../../lib/studio-url';

export async function GET(request: NextRequest) {
  const redirectPath = request.nextUrl.searchParams.get('redirect');
  const studioUrl = buildStudioBrowserUrl('/api/auth/microsoft');
  studioUrl.searchParams.set(
    'admin_redirect',
    buildStudioAdminCallbackUrl(request, redirectPath).toString(),
  );

  return NextResponse.redirect(studioUrl);
}
