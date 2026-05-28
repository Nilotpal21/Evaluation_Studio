/**
 * GET  /api/search-ai/connectors/:connectorId/recommendations — Get latest
 * POST /api/search-ai/connectors/:connectorId/recommendations — Generate
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ connectorId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { connectorId } = await params;
  return proxyToSearchEngine(
    request,
    `/api/connectors/${encodeURIComponent(connectorId)}/recommendations`,
    { tenantId: user.tenantId },
  );
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { connectorId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }
  return proxyToSearchEngine(
    request,
    `/api/connectors/${encodeURIComponent(connectorId)}/recommendations`,
    { method: 'POST', body, tenantId: user.tenantId },
  );
}
