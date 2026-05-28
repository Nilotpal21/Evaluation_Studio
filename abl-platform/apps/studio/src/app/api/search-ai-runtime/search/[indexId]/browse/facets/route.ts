/**
 * GET /api/search-ai-runtime/search/:indexId/browse/facets — Browse facets
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchRuntime } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ indexId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { indexId } = await params;
  const qs = request.nextUrl.search;
  return proxyToSearchRuntime(
    request,
    `/api/search/${encodeURIComponent(indexId)}/browse/facets${qs}`,
    {
      tenantId: user.tenantId,
    },
  );
}
