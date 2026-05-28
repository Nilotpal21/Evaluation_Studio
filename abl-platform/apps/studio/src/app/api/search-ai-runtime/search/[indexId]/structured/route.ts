/**
 * POST /api/search/:indexId/structured — Execute structured query
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchRuntime } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ indexId: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { indexId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }
  return proxyToSearchRuntime(request, `/api/search/${encodeURIComponent(indexId)}/structured`, {
    method: 'POST',
    body,
    tenantId: user.tenantId,
  });
}
