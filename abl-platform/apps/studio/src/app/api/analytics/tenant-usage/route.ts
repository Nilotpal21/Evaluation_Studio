/**
 * GET /api/analytics/tenant-usage — Proxy to runtime tenant usage analytics
 *
 * This path is reserved for analytics-only consumers that still depend on the
 * runtime tenant usage aggregation surface. Billing/reporting consumers should
 * use the published billing report routes instead.
 */

import { NextRequest } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import {
  proxyTenantUsageAnalytics,
  validateTenantUsageTenantScope,
} from '@/lib/tenant-usage-analytics-proxy';

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const scopeError = validateTenantUsageTenantScope(request, user.tenantId);
  if (scopeError) return scopeError;

  return proxyTenantUsageAnalytics(request, {
    tenantId: user.tenantId,
    source: 'analytics',
  });
}
