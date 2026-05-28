/**
 * Shared Runtime Proxy Utilities
 *
 * Helpers for Studio Next.js API routes to proxy requests to the runtime server.
 * Deduplicates boilerplate across tenant-models, service-instances, etc.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeUrl } from '@/config/runtime.server';

/**
 * Build standard proxy headers for a request to the runtime.
 * Forwards Authorization and sets X-Tenant-Id.
 */
export function buildRuntimeProxyHeaders(
  request: NextRequest,
  tenantId: string,
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  headers['X-Tenant-Id'] = tenantId;
  return headers;
}

/** Default per-call timeout for runtime proxy fetches. Matches typical REST
 *  response budgets; long-running calls (e.g. sync workflow execute) should
 *  pass `timeoutMs` explicitly rather than rely on a global ceiling. */
const DEFAULT_RUNTIME_PROXY_TIMEOUT_MS = 30_000;

/**
 * Proxy a request to the runtime server.
 *
 * @param request - Incoming Next.js request
 * @param path - Runtime API path (e.g., `/api/tenants/${tenantId}/service-instances`)
 * @param options - Optional method, body, and per-call timeout overrides
 * @returns NextResponse with the runtime response data and status
 */
export async function proxyToRuntime(
  request: NextRequest,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    tenantId: string;
    /** Per-call timeout in ms. Defaults to 30s — raise only when the
     *  downstream endpoint is known to need more (e.g. sync execute). */
    timeoutMs?: number;
  },
): Promise<NextResponse> {
  const tenantId = options.tenantId;

  const headers = buildRuntimeProxyHeaders(request, tenantId);
  const method = options?.method || request.method;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RUNTIME_PROXY_TIMEOUT_MS;

  const fetchOptions: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (options?.body !== undefined) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${getRuntimeUrl()}${path}`, fetchOptions);
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
