/**
 * POST /api/search-ai/connectors/:connectorId/recommendations/:recommendationId/accept
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ connectorId: string; recommendationId: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { connectorId, recommendationId } = await params;
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
    `/api/connectors/${encodeURIComponent(connectorId)}/recommendations/${encodeURIComponent(recommendationId)}/accept`,
    { method: 'POST', body, tenantId: user.tenantId },
  );
}
