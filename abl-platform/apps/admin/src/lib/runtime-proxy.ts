/**
 * Runtime Proxy Helpers
 *
 * Shared utilities for admin API routes that proxy requests to the runtime.
 * Centralizes JWT forwarding and header construction so every proxy route
 * authenticates correctly against the runtime's authMiddleware.
 */

import type { AdminRouteContext } from './with-admin-route';

const RUNTIME_API_URL = process.env.RUNTIME_API_URL || 'http://localhost:3112';

export function getRuntimeBaseUrl(): string {
  return RUNTIME_API_URL;
}

/**
 * Build the standard set of headers for proxied runtime requests.
 * Uses the verified auth context from withAdminRoute — no header/cookie reading needed.
 */
export function buildRuntimeHeaders(
  ctx: AdminRouteContext<Record<string, string | string[]>>,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ctx.token}`,
    'x-admin-user-id': ctx.user.userId,
    'x-admin-user-email': ctx.user.email,
    'x-admin-user-role': ctx.user.role,
    'x-forwarded-for': ctx.user.ipAddress,
  };
}

/**
 * @deprecated Use `buildRuntimeHeaders(ctx)` with the AdminRouteContext instead.
 * This function reads from headers/cookies which is unreliable with Turbopack.
 */
export async function getRuntimeHeaders(): Promise<Record<string, string>> {
  // Dynamic imports to avoid breaking when this deprecated function is removed
  const { cookies, headers } = await import('next/headers');
  const { getAuthContext } = await import('./auth-context');

  const auth = await getAuthContext();
  const cookieStore = await cookies();
  const hdrs_store = await headers();

  const sessionToken = cookieStore.get('admin-session')?.value;
  const authHeader = hdrs_store.get('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  const token = sessionToken || bearerToken;

  const result: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-admin-user-id': auth.userId,
    'x-admin-user-email': auth.email,
    'x-admin-user-role': auth.role,
    'x-forwarded-for': auth.ipAddress,
  };

  if (token) {
    result['Authorization'] = `Bearer ${token}`;
  }

  return result;
}
