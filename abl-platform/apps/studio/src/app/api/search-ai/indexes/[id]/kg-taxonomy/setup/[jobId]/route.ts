/**
 * GET /api/search-ai/indexes/:id/kg-taxonomy/setup/:jobId — Get setup job status
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string; jobId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, jobId } = await params;
  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/kg-taxonomy/setup/${encodeURIComponent(jobId)}`,
    {
      tenantId: user.tenantId,
    },
  );
}
