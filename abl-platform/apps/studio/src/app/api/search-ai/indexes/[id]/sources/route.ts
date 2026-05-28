/**
 * GET  /api/indexes/:id/sources — List sources for an index
 * POST /api/indexes/:id/sources — Add a source to an index
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id } = await params;
  const qs = request.nextUrl.search;
  return proxyToSearchEngine(request, `/api/indexes/${encodeURIComponent(id)}/sources${qs}`, {
    tenantId: user.tenantId,
  });
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }
  return proxyToSearchEngine(request, `/api/indexes/${encodeURIComponent(id)}/sources`, {
    method: 'POST',
    body,
    tenantId: user.tenantId,
  });
}
