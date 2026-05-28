/**
 * GET /api/auth/google
 * Redirect to Google OAuth consent screen
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { OAuth2Client } from 'google-auth-library';
import { getConfig, isConfigLoaded } from '@/config';
import { parseAdminCallbackUrl, setAdminRedirectCookie } from '@/lib/admin-auth-handoff';

let cachedClient: OAuth2Client | null = null;

function getOAuth2Client(): OAuth2Client {
  if (!cachedClient) {
    const cfg = isConfigLoaded() ? getConfig() : null;
    const clientId = cfg?.oauth.google.clientId || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = cfg?.oauth.google.clientSecret || process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = `${cfg?.server.frontendUrl || process.env.FRONTEND_URL || 'http://localhost:5173'}/api/auth/callback`;

    if (!clientId || !clientSecret) {
      throw new Error(
        `Google OAuth misconfigured: clientId=${clientId ? 'set' : 'MISSING'}, clientSecret=${clientSecret ? 'set' : 'MISSING'}`,
      );
    }

    cachedClient = new OAuth2Client(clientId, clientSecret, redirectUri);
  }
  return cachedClient;
}

// No response schema as this endpoint redirects to Google
async function handler(request: NextRequest) {
  const searchParams = new URL(request.url).searchParams;
  const adminRedirectParam = searchParams.get('admin_redirect');
  const adminRedirect = parseAdminCallbackUrl(adminRedirectParam);

  if (adminRedirectParam && !adminRedirect) {
    return NextResponse.json({ error: 'Invalid admin redirect URL' }, { status: 400 });
  }

  let client: OAuth2Client;
  try {
    client = getOAuth2Client();
  } catch (err) {
    console.error('[Auth/Google]', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: 'Google OAuth is not configured on this server' },
      { status: 500 },
    );
  }

  // Generate CSRF state parameter
  const state = crypto.randomBytes(32).toString('hex');

  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    prompt: 'consent',
    state,
  });

  const response = NextResponse.redirect(url);
  setAdminRedirectCookie(response, adminRedirect, state);

  // Store state in httpOnly cookie for validation in callback
  response.cookies.set('oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600, // 10 minutes
    path: '/api/auth',
  });

  // Preserve invite token through OAuth flow
  const inviteToken = searchParams.get('invite');
  if (inviteToken) {
    response.cookies.set('oauth_invite', inviteToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600, // 10 minutes
      path: '/api/auth',
    });
  }

  return response;
}

export const GET = withOpenAPI(
  {
    summary: 'Initiate Google OAuth',
    description:
      'Redirects to Google OAuth consent screen. Sets CSRF state in httpOnly cookie for validation in callback.',
    successStatus: 302,
    auth: false,
  },
  handler as any,
);
