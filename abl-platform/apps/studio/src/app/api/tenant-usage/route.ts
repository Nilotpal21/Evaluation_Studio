/**
 * GET /api/tenant-usage — Proxy to runtime tenant usage analytics
 *
 * Legacy compatibility path. New Studio analytics consumers should use
 * /api/analytics/tenant-usage instead.
 */

import { NextRequest } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import {
  markLegacyTenantUsageRoute,
  proxyTenantUsageAnalytics,
  validateTenantUsageTenantScope,
} from '@/lib/tenant-usage-analytics-proxy';

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const scopeError = validateTenantUsageTenantScope(request, user.tenantId);
  if (scopeError) return markLegacyTenantUsageRoute(scopeError);

  return markLegacyTenantUsageRoute(
    await proxyTenantUsageAnalytics(request, {
      tenantId: user.tenantId,
      source: 'legacy',
    }),
  );
}
