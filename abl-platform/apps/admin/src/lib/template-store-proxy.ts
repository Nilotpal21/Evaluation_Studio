/**
 * Template Store Proxy Helpers
 *
 * Shared utilities for admin API routes that proxy requests to the template-store service.
 * Follows the same pattern as runtime-proxy.ts but targets the template-store service.
 */

import type { AdminRouteContext } from './with-admin-route';

const TEMPLATE_STORE_URL = process.env.TEMPLATE_STORE_URL || 'http://localhost:3115';

export function getTemplateStoreUrl(): string {
  return TEMPLATE_STORE_URL;
}

/**
 * Build the standard set of headers for proxied template-store requests.
 * Forwards the admin JWT so the template-store can verify the caller.
 */
export function buildTemplateStoreHeaders(
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
