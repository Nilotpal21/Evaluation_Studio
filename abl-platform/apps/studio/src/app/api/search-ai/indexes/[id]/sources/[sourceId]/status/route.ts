/**
 * GET /api/indexes/:id/sources/:sourceId/status — Get ingestion status
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string; sourceId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, sourceId } = await params;
  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceId)}/status`,
    {
      tenantId: user.tenantId,
    },
  );
}
