/**
 * GET    /api/indexes/:id — Get index detail
 * PATCH  /api/indexes/:id — Update index
 * DELETE /api/indexes/:id — Delete index
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id } = await params;
  return proxyToSearchEngine(request, `/api/indexes/${encodeURIComponent(id)}`, {
    tenantId: user.tenantId,
  });
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
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
  return proxyToSearchEngine(request, `/api/indexes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    tenantId: user.tenantId,
  });
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id } = await params;
  return proxyToSearchEngine(request, `/api/indexes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    tenantId: user.tenantId,
  });
}
