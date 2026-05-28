/**
 * POST /api/sso/exchange - Exchange one-time auth code for token pair
 *
 * Used by Google OAuth, OIDC SSO, and SAML SSO callback flows.
 * The auth code is single-use with a 60-second TTL.
 */

import { NextRequest, NextResponse } from 'next/server';
import { consumeAuthCode } from '@/lib/sso-auth-codes';
import { checkRateLimit } from '@/lib/rate-limit';
import { getConfig, isConfigLoaded } from '@/config';
import { AUTH_CONFIG_DEFAULTS } from '@/lib/auth-constants';

export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get('x-forwarded-for')?.split(',').pop()?.trim() || 'unknown';
    const rl = await checkRateLimit(`sso-exchange:${ip}`, 20, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
      );
    }

    const { code } = await request.json();

    if (!code || typeof code !== 'string') {
      return NextResponse.json({ error: 'Missing auth code' }, { status: 400 });
    }

    const stored = await consumeAuthCode(code);
    if (!stored) {
      return NextResponse.json({ error: 'Invalid or expired auth code' }, { status: 400 });
    }

    const responseBody: Record<string, unknown> = {
      accessToken: stored.accessToken,
      expiresIn: stored.expiresIn,
    };

    if (stored.needsOnboarding) {
      responseBody.needsOnboarding = true;
    }
    if (stored.pendingInvitations && stored.pendingInvitations > 0) {
      responseBody.pendingInvitations = stored.pendingInvitations;
    }
    if (stored.pendingInvitationChoice) {
      responseBody.pendingInvitationChoice = true;
    }
    if (stored.inviteToken) {
      responseBody.inviteToken = stored.inviteToken;
    }

    const response = NextResponse.json(responseBody);

    // Set refresh token as httpOnly cookie (not in response body)
    const refreshCookieMaxAge = isConfigLoaded()
      ? getConfig().auth.tokens.refreshCookieMaxAgeSeconds
      : AUTH_CONFIG_DEFAULTS.tokens.refreshCookieMaxAgeSeconds;
    response.cookies.set('refresh_token', stored.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: refreshCookieMaxAge,
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('[SSO] Exchange error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
