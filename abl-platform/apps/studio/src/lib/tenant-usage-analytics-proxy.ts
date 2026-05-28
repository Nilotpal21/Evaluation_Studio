import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { getRuntimeUrl } from '@/config/runtime.server';
import { buildRuntimeProxyHeaders } from '@/lib/runtime-proxy';
import { safeJsonParse } from '@/lib/safe-proxy';

const log = createLogger('studio:tenant-usage-analytics');

const PROXY_TIMEOUT_MS = 15_000;
const FORWARDED_QUERY_KEYS = ['startDate', 'endDate', 'projectId'] as const;

type ProxySource = 'analytics' | 'legacy';

function buildForwardParams(request: NextRequest): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of FORWARDED_QUERY_KEYS) {
    const value = request.nextUrl.searchParams.get(key);
    if (value) params.set(key, value);
  }
  return params;
}

function buildRuntimePath(request: NextRequest, tenantId: string): string {
  const queryString = buildForwardParams(request).toString();
  return `${getRuntimeUrl()}/api/tenants/${encodeURIComponent(tenantId)}/usage${queryString ? `?${queryString}` : ''}`;
}

export function validateTenantUsageTenantScope(
  request: NextRequest,
  tenantId: string,
): NextResponse | null {
  const requestedTenantId = request.nextUrl.searchParams.get('tenantId');
  if (requestedTenantId && requestedTenantId !== tenantId) {
    return NextResponse.json(
      { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } },
      { status: 404 },
    );
  }
  return null;
}

export function markLegacyTenantUsageRoute(response: NextResponse): NextResponse {
  response.headers.set('Deprecation', 'true');
  response.headers.set('X-ABL-Successor-Route', '/api/analytics/tenant-usage');
  return response;
}

export async function proxyTenantUsageAnalytics(
  request: NextRequest,
  options: {
    tenantId: string;
    source: ProxySource;
  },
): Promise<NextResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const response = await fetch(buildRuntimePath(request, options.tenantId), {
      method: 'GET',
      headers: buildRuntimeProxyHeaders(request, options.tenantId),
      cache: 'no-store',
      signal: controller.signal,
    });
    const { data, status } = await safeJsonParse(response);
    return NextResponse.json(data, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    log.error(
      isTimeout
        ? 'Timeout proxying tenant usage analytics request'
        : 'Failed to proxy tenant usage analytics request',
      {
        source: options.source,
        tenantId: options.tenantId,
        error: message,
      },
    );
    return NextResponse.json(
      {
        success: false,
        error: isTimeout
          ? { code: 'PROXY_TIMEOUT', message: 'Runtime did not respond within 15s' }
          : { code: 'PROXY_ERROR', message: 'Failed to fetch usage analytics from runtime' },
      },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
