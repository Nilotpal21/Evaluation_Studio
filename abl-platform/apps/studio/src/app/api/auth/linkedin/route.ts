/**
 * GET /api/auth/linkedin
 * Redirect to LinkedIn OAuth consent screen
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { getLinkedInConfig } from '@/lib/auth-helpers';
import { OAUTH_STATE_COOKIE_LINKEDIN, OAUTH_COOKIE_PATH_LINKEDIN } from '@/lib/auth-constants';

async function handler(request: NextRequest) {
  const { clientId, redirectUri, authorizeUrl, scope, stateCookieTtlSeconds } = getLinkedInConfig();

  if (!clientId) {
    console.error('[Auth/LinkedIn] OAuth misconfigured: clientId=MISSING');
    return NextResponse.json(
      { error: 'LinkedIn OAuth is not configured on this server' },
      { status: 500 },
    );
  }

  // Generate CSRF state parameter
  const state = crypto.randomBytes(32).toString('hex');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
  });

  const url = `${authorizeUrl}?${params.toString()}`;

  const response = NextResponse.redirect(url);

  // Store state in httpOnly cookie for validation in callback
  response.cookies.set(OAUTH_STATE_COOKIE_LINKEDIN, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: stateCookieTtlSeconds,
    path: OAUTH_COOKIE_PATH_LINKEDIN,
  });

  // Preserve invite token through OAuth flow
  const inviteToken = new URL(request.url).searchParams.get('invite');
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
    summary: 'Initiate LinkedIn OAuth',
    description:
      'Redirects to LinkedIn OAuth consent screen. Sets CSRF state in httpOnly cookie for validation in callback.',
    successStatus: 302,
    auth: false,
  },
  handler as any,
);
