import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getGoogleOAuth2Client, signToken } from '@/lib/auth';
import { getDocsConfig } from '@/lib/config';

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isValidRedirect(url: string): boolean {
  return url.startsWith('/') && !url.includes('//') && !url.includes(':');
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const stateParam = searchParams.get('state');
  const error = searchParams.get('error');

  const signInErrorUrl = (err: string) => new URL(`/auth/signin?error=${err}`, request.url);

  if (error || !code) {
    return NextResponse.redirect(signInErrorUrl('oauth_failed'));
  }

  // Validate CSRF state
  const storedStateCookie = request.cookies.get('oauth_state')?.value;
  if (!storedStateCookie || !stateParam) {
    return NextResponse.redirect(signInErrorUrl('invalid_state'));
  }

  let storedStateData: { state: string; redirect: string };
  let incomingStateData: { state: string; redirect: string };
  try {
    storedStateData = JSON.parse(Buffer.from(storedStateCookie, 'base64').toString());
    incomingStateData = JSON.parse(Buffer.from(stateParam, 'base64').toString());
  } catch {
    return NextResponse.redirect(signInErrorUrl('invalid_state'));
  }

  if (!constantTimeEqual(incomingStateData.state, storedStateData.state)) {
    return NextResponse.redirect(signInErrorUrl('invalid_state'));
  }

  // Exchange code for tokens
  const client = getGoogleOAuth2Client();
  let tokens;
  try {
    const tokenResponse = await client.getToken(code);
    tokens = tokenResponse.tokens;
  } catch {
    return NextResponse.redirect(signInErrorUrl('oauth_failed'));
  }

  // Verify ID token
  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token!,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    return NextResponse.redirect(signInErrorUrl('oauth_failed'));
  }

  if (!payload || !payload.email) {
    return NextResponse.redirect(signInErrorUrl('oauth_failed'));
  }

  const email = payload.email;
  const name = payload.name || email;
  const picture = payload.picture || '';
  const domain = email.split('@')[1];

  // Check domain allowlist
  const config = getDocsConfig();
  if (!config.allowedDomains.includes(domain)) {
    return NextResponse.redirect(signInErrorUrl('domain_not_allowed'));
  }

  // Sign JWT
  const jwt = await signToken({ email, name, picture, domain });

  // Determine redirect URL
  let redirectUrl = storedStateData.redirect || '/';
  if (!isValidRedirect(redirectUrl)) {
    redirectUrl = '/';
  }

  const isProduction = process.env.NODE_ENV === 'production';

  const response = NextResponse.redirect(new URL(redirectUrl, request.url));

  // Delete oauth_state cookie
  response.cookies.set('oauth_state', '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 0,
    path: '/api/auth',
  });

  // Set session cookie
  response.cookies.set('docs-session', jwt, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 86400,
    path: '/',
  });

  return response;
}
