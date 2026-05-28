import { jwtVerify } from 'jose';
import { NextResponse, type NextRequest } from 'next/server';

const MAX_SESSION_AGE_MS = 8 * 60 * 60 * 1000;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function getJwtSecret(): Uint8Array | null {
  const secret = process.env.JWT_SECRET?.trim();
  return secret ? new TextEncoder().encode(secret) : null;
}

function buildLoginRedirect(request: NextRequest, error?: string): NextResponse {
  const loginUrl = new URL('/login', request.url);
  const redirectPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;

  if (redirectPath !== '/' && !redirectPath.startsWith('//')) {
    loginUrl.searchParams.set('redirect', redirectPath);
  }

  if (error) {
    loginUrl.searchParams.set('error', error);
  }

  const response = NextResponse.redirect(loginUrl);
  response.cookies.delete('admin-session');
  response.cookies.delete('admin-last-activity');
  return response;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get('admin-session')?.value;
  if (!token) {
    return buildLoginRedirect(request);
  }

  const secret = getJwtSecret();
  if (!secret) {
    return buildLoginRedirect(request, 'Admin authentication is not configured.');
  }

  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.type !== 'access' || payload.isSuperAdmin !== true) {
      return buildLoginRedirect(request, 'Platform super-admin access required.');
    }

    if (typeof payload.iat === 'number') {
      const tokenAge = Date.now() - payload.iat * 1000;
      if (tokenAge > MAX_SESSION_AGE_MS) {
        return buildLoginRedirect(request, 'Session expired. Please sign in again.');
      }
    }

    const lastActivity = request.cookies.get('admin-last-activity')?.value;
    if (lastActivity) {
      const idleTime = Date.now() - Number.parseInt(lastActivity, 10);
      if (Number.isFinite(idleTime) && idleTime > IDLE_TIMEOUT_MS) {
        return buildLoginRedirect(request, 'Session expired. Please sign in again.');
      }
    }

    const response = NextResponse.next();
    response.cookies.set('admin-last-activity', String(Date.now()), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: IDLE_TIMEOUT_MS / 1000,
    });
    return response;
  } catch {
    return buildLoginRedirect(request, 'Invalid or expired session.');
  }
}

export const config = {
  matcher: ['/((?!api|login|_next|favicon.ico|.*\\..*).*)'],
};
