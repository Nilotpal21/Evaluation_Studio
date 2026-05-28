/**
 * GET/PUT /api/tenant-llm-policy — Proxy to runtime
 *
 * Proxies LLM policy CRUD to the runtime API.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';

function buildHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  headers['X-Tenant-Id'] = tenantId;
  return headers;
}

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const tenantId = request.nextUrl.searchParams.get('tenantId');
  if (!tenantId) {
    return NextResponse.json({ error: 'tenantId query parameter is required' }, { status: 400 });
  }

  try {
    const response = await fetch(`${getRuntimeUrl()}/api/tenants/${tenantId}/llm-policy`, {
      method: 'GET',
      headers: buildHeaders(request, tenantId),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[TenantLLMPolicy] Proxy GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch LLM policy via runtime' },
      { status: 502 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const tenantId = request.nextUrl.searchParams.get('tenantId');
  if (!tenantId) {
    return NextResponse.json({ error: 'tenantId query parameter is required' }, { status: 400 });
  }

  try {
    const body = await request.json();
    const headers = buildHeaders(request, tenantId);
    headers['Content-Type'] = 'application/json';

    const response = await fetch(`${getRuntimeUrl()}/api/tenants/${tenantId}/llm-policy`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[TenantLLMPolicy] Proxy PUT error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update LLM policy via runtime' },
      { status: 502 },
    );
  }
}
