/**
 * GET  /api/search-ai/indexes/:id/connectors/:connectorId — Get single connector
 * PUT  /api/search-ai/indexes/:id/connectors/:connectorId — Update connector config
 * DELETE /api/search-ai/indexes/:id/connectors/:connectorId — Delete connector
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string; connectorId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, connectorId } = await params;
  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/connectors/${encodeURIComponent(connectorId)}`,
    { tenantId: user.tenantId },
  );
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, connectorId } = await params;
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
    `/api/indexes/${encodeURIComponent(id)}/connectors/${encodeURIComponent(connectorId)}`,
    { method: 'PUT', body, tenantId: user.tenantId },
  );
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, connectorId } = await params;
  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/connectors/${encodeURIComponent(connectorId)}`,
    { method: 'DELETE', tenantId: user.tenantId },
  );
}
