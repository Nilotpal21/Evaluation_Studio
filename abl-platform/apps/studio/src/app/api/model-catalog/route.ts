/**
 * GET /api/model-catalog — Proxy to runtime model catalog
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const auth = request.headers.get('Authorization');
    if (auth) headers['Authorization'] = auth;

    const response = await fetch(`${getRuntimeUrl()}/api/model-catalog`, { headers });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[ModelCatalog] Proxy GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch model catalog from runtime' },
      { status: 502 },
    );
  }
}
