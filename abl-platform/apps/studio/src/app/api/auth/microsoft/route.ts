/**
 * GET /api/auth/microsoft
 * Redirect to Microsoft OAuth consent screen
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { getMicrosoftConfig } from '@/lib/auth-helpers';
import { OAUTH_STATE_COOKIE_MICROSOFT, OAUTH_COOKIE_PATH_MICROSOFT } from '@/lib/auth-constants';
import { parseAdminCallbackUrl, setAdminRedirectCookie } from '@/lib/admin-auth-handoff';

async function handler(request: NextRequest) {
  const searchParams = new URL(request.url).searchParams;
  const adminRedirectParam = searchParams.get('admin_redirect');
  const adminRedirect = parseAdminCallbackUrl(adminRedirectParam);

  if (adminRedirectParam && !adminRedirect) {
    return NextResponse.json({ error: 'Invalid admin redirect URL' }, { status: 400 });
  }

  const { clientId, tenantId, redirectUri, authorizeUrl, scope, stateCookieTtlSeconds } =
    getMicrosoftConfig();

  if (!clientId) {
    console.error('[Auth/Microsoft] OAuth misconfigured: clientId=MISSING');
    return NextResponse.json(
      { error: 'Microsoft OAuth is not configured on this server' },
      { status: 500 },
    );
  }

  // Generate CSRF state parameter
  const state = crypto.randomBytes(32).toString('hex');

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope,
    response_mode: 'query',
    state,
    prompt: 'consent',
  });

  const resolvedAuthorizeUrl = authorizeUrl.replace('{tenant}', encodeURIComponent(tenantId));
  const url = `${resolvedAuthorizeUrl}?${params.toString()}`;

  const response = NextResponse.redirect(url);
  setAdminRedirectCookie(response, adminRedirect, state);

  // Store state in httpOnly cookie for validation in callback
  response.cookies.set(OAUTH_STATE_COOKIE_MICROSOFT, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: stateCookieTtlSeconds,
    path: OAUTH_COOKIE_PATH_MICROSOFT,
  });

  // Preserve invite token through OAuth flow
  const inviteToken = searchParams.get('invite');
  if (inviteToken) {
    response.cookies.set('oauth_invite', inviteToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600,
      path: '/api/auth',
    });
  }

  return response;
}

export const GET = withOpenAPI(
  {
    summary: 'Initiate Microsoft OAuth',
    description:
      'Redirects to Microsoft OAuth consent screen. Sets CSRF state in httpOnly cookie for validation in callback.',
    successStatus: 302,
    auth: false,
  },
  handler as any,
);
