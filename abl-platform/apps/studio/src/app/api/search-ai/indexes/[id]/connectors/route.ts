/**
 * GET  /api/search-ai/indexes/:id/connectors — List connectors for index
 * POST /api/search-ai/indexes/:id/connectors — Create connector
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id } = await params;
  return proxyToSearchEngine(request, `/api/indexes/${encodeURIComponent(id)}/connectors`, {
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
  return proxyToSearchEngine(request, `/api/indexes/${encodeURIComponent(id)}/connectors`, {
    method: 'POST',
    body,
    tenantId: user.tenantId,
  });
}
