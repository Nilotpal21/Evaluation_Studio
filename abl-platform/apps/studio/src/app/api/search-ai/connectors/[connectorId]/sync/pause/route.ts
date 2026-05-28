/**
 * POST /api/search-ai/connectors/:connectorId/sync/pause — Pause sync
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ connectorId: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { connectorId } = await params;
  return proxyToSearchEngine(
    request,
    `/api/connectors/${encodeURIComponent(connectorId)}/sync/pause`,
    { method: 'POST', tenantId: user.tenantId },
  );
}
