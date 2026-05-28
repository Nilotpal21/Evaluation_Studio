import { NextResponse } from 'next/server';
import { decodeJwt } from 'jose';

export const PLATFORM_SUPER_ADMIN_REQUIRED_MESSAGE =
  'Platform Admin requires a Studio super-admin account.';

export class AdminAuthError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'AdminAuthError';
    this.status = status;
  }
}

export interface StudioAuthSuccessPayload {
  accessToken: string;
  user: Record<string, unknown>;
}

export interface AdminSessionPayload {
  accessToken: string;
  user: Record<string, unknown>;
  role: string;
  isSuperAdmin: boolean;
}

export function createAdminSessionPayload(data: StudioAuthSuccessPayload): AdminSessionPayload {
  const claims = decodeJwt(data.accessToken);
  const isSuperAdmin = claims.isSuperAdmin === true;

  if (!isSuperAdmin) {
    throw new AdminAuthError(PLATFORM_SUPER_ADMIN_REQUIRED_MESSAGE, 403);
  }

  return {
    accessToken: data.accessToken,
    user: data.user,
    role: 'SUPER_ADMIN',
    isSuperAdmin: true,
  };
}

export function applyAdminSessionCookies(
  response: NextResponse,
  session: AdminSessionPayload,
): NextResponse {
  response.cookies.set('admin-session', session.accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 8 * 60 * 60,
  });

  response.cookies.set('admin-last-activity', String(Date.now()), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 60,
  });

  return response;
}

export function createAdminSessionResponse(session: AdminSessionPayload): NextResponse {
  const response = NextResponse.json({
    user: session.user,
    role: session.role,
    isSuperAdmin: session.isSuperAdmin,
  });

  return applyAdminSessionCookies(response, session);
}

export function createAdminSessionRedirectResponse(
  session: AdminSessionPayload,
  location: string | URL,
): NextResponse {
  return applyAdminSessionCookies(NextResponse.redirect(location), session);
}
