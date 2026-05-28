/**
 * GET  /api/search-ai/indexes/:id/attributes/:attrId — Get single attribute
 * PATCH /api/search-ai/indexes/:id/attributes/:attrId — Update attribute
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string; attrId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, attrId } = await params;
  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/attributes/${encodeURIComponent(attrId)}`,
    {
      tenantId: user.tenantId,
    },
  );
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, attrId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INVALID_JSON', message: 'Invalid JSON body' },
      },
      { status: 400 },
    );
  }
  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/attributes/${encodeURIComponent(attrId)}`,
    {
      method: 'PATCH',
      body,
      tenantId: user.tenantId,
    },
  );
}
