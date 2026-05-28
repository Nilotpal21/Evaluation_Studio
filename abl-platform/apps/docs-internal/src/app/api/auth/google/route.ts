import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getGoogleOAuth2Client } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const redirect = request.nextUrl.searchParams.get('redirect') || '/';

  const state = crypto.randomBytes(32).toString('hex');
  const statePayload = Buffer.from(JSON.stringify({ state, redirect })).toString('base64');

  const client = getGoogleOAuth2Client();
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    state: statePayload,
  });

  const isProduction = process.env.NODE_ENV === 'production';

  const response = NextResponse.redirect(authUrl);
  response.cookies.set('oauth_state', statePayload, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 600,
    path: '/api/auth',
  });

  return response;
}
