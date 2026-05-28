import type { NextRequest, NextResponse } from 'next/server';
import { getFrontendUrl } from '@/lib/auth-helpers';

const DEFAULT_ADMIN_ORIGIN = 'http://localhost:3003';
const ADMIN_CALLBACK_PATH = '/api/auth/studio/callback';
export const ADMIN_AUTH_REDIRECT_COOKIE = 'studio_admin_redirect';
export const ADMIN_AUTH_REDIRECT_COOKIE_PATH = '/api/auth';
const ADMIN_AUTH_REDIRECT_COOKIE_TTL_SECONDS = 600;

export interface SsoRelayStatePayload {
  orgId: string;
  adminRedirect?: string;
}

interface AdminRedirectCookiePayload {
  callbackUrl: string;
  state?: string;
}

function normalizeOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

function sanitizeRedirectPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return null;
  }

  return value;
}

function getAllowedAdminOrigin(): string {
  return (
    normalizeOrigin(process.env.NEXT_PUBLIC_ADMIN_URL) ||
    normalizeOrigin(process.env.ADMIN_URL) ||
    DEFAULT_ADMIN_ORIGIN
  );
}

export function parseAdminCallbackUrl(value: string | null | undefined): URL | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.origin !== getAllowedAdminOrigin()) {
      return null;
    }

    if (url.pathname !== ADMIN_CALLBACK_PATH) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

function parseAdminRedirectCookie(
  value: string | null | undefined,
): AdminRedirectCookiePayload | null {
  if (!value) {
    return null;
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<AdminRedirectCookiePayload>;

    if (typeof decoded.callbackUrl !== 'string' || decoded.callbackUrl.length === 0) {
      return null;
    }

    return {
      callbackUrl: decoded.callbackUrl,
      ...(typeof decoded.state === 'string' ? { state: decoded.state } : {}),
    };
  } catch {
    const fallbackUrl = parseAdminCallbackUrl(value);
    return fallbackUrl ? { callbackUrl: fallbackUrl.toString() } : null;
  }
}

export function setAdminRedirectCookie(
  response: NextResponse,
  adminCallbackUrl: URL | null,
  state?: string,
): NextResponse {
  if (!adminCallbackUrl) {
    return response;
  }

  const payload: AdminRedirectCookiePayload = {
    callbackUrl: adminCallbackUrl.toString(),
    ...(state ? { state } : {}),
  };

  response.cookies.set(
    ADMIN_AUTH_REDIRECT_COOKIE,
    Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: ADMIN_AUTH_REDIRECT_COOKIE_TTL_SECONDS,
      path: ADMIN_AUTH_REDIRECT_COOKIE_PATH,
    },
  );

  return response;
}

export function clearAdminRedirectCookie(response: NextResponse): NextResponse {
  response.cookies.set(ADMIN_AUTH_REDIRECT_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: ADMIN_AUTH_REDIRECT_COOKIE_PATH,
  });

  return response;
}

export function getAdminRedirectCookie(
  request: NextRequest,
  expectedState?: string | null,
): URL | null {
  const payload = parseAdminRedirectCookie(request.cookies.get(ADMIN_AUTH_REDIRECT_COOKIE)?.value);
  if (!payload) {
    return null;
  }

  if (expectedState && payload.state && payload.state !== expectedState) {
    return null;
  }

  if (expectedState && payload.state === undefined) {
    return null;
  }

  return parseAdminCallbackUrl(payload.callbackUrl);
}

export function buildAuthCodeRedirect(authCode: string, adminCallbackUrl: URL | null): URL {
  if (adminCallbackUrl) {
    const redirectUrl = new URL(adminCallbackUrl.toString());
    redirectUrl.searchParams.set('code', authCode);
    return redirectUrl;
  }

  const redirectUrl = new URL('/auth/callback', getFrontendUrl());
  redirectUrl.searchParams.set('code', authCode);
  return redirectUrl;
}

export function buildAuthErrorRedirect(
  error: string,
  adminCallbackUrl: URL | null,
  params?: Record<string, string | undefined>,
): URL {
  if (adminCallbackUrl) {
    const loginUrl = new URL('/login', adminCallbackUrl.origin);
    const redirectPath = sanitizeRedirectPath(adminCallbackUrl.searchParams.get('redirect'));

    if (redirectPath) {
      loginUrl.searchParams.set('redirect', redirectPath);
    }

    loginUrl.searchParams.set('error', error);
    return loginUrl;
  }

  const errorUrl = new URL('/auth/error', getFrontendUrl());
  errorUrl.searchParams.set('error', error);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) {
      errorUrl.searchParams.set(key, value);
    }
  }
  return errorUrl;
}

export function encodeSamlRelayState(payload: SsoRelayStatePayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeSamlRelayState(
  value: string | null | undefined,
): SsoRelayStatePayload | null {
  if (!value) {
    return null;
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<SsoRelayStatePayload>;

    if (typeof decoded.orgId !== 'string' || decoded.orgId.length === 0) {
      return null;
    }

    return {
      orgId: decoded.orgId,
      ...(typeof decoded.adminRedirect === 'string'
        ? { adminRedirect: decoded.adminRedirect }
        : {}),
    };
  } catch {
    return { orgId: value };
  }
}
