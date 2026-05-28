import type { NextRequest } from 'next/server';

const DEFAULT_ADMIN_BASE_URL = 'http://localhost:3003';
const DEFAULT_REDIRECT_PATH = '/';

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\/+$/, '');
}

export function sanitizeAdminRedirectPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return DEFAULT_REDIRECT_PATH;
  }

  return value;
}

export function resolveAdminBaseUrl(request: NextRequest): string {
  return (
    normalizeBaseUrl(process.env.NEXT_PUBLIC_BASE_URL) ||
    normalizeBaseUrl(process.env.ADMIN_URL) ||
    normalizeBaseUrl(request.nextUrl.origin) ||
    DEFAULT_ADMIN_BASE_URL
  );
}

export function buildAdminLoginUrl(
  request: NextRequest,
  options: {
    redirectPath?: string | null;
    error?: string | null;
  } = {},
): URL {
  const loginUrl = new URL('/login', resolveAdminBaseUrl(request));
  const redirectPath = sanitizeAdminRedirectPath(options.redirectPath);

  if (redirectPath !== DEFAULT_REDIRECT_PATH) {
    loginUrl.searchParams.set('redirect', redirectPath);
  }

  if (options.error) {
    loginUrl.searchParams.set('error', options.error);
  }

  return loginUrl;
}

export function buildAdminPostLoginUrl(request: NextRequest, redirectPath?: string | null): URL {
  return new URL(sanitizeAdminRedirectPath(redirectPath), resolveAdminBaseUrl(request));
}

export function buildStudioAdminCallbackUrl(
  request: NextRequest,
  redirectPath?: string | null,
): URL {
  const callbackUrl = new URL('/api/auth/studio/callback', resolveAdminBaseUrl(request));
  const normalizedRedirect = sanitizeAdminRedirectPath(redirectPath);

  if (normalizedRedirect !== DEFAULT_REDIRECT_PATH) {
    callbackUrl.searchParams.set('redirect', normalizedRedirect);
  }

  return callbackUrl;
}
