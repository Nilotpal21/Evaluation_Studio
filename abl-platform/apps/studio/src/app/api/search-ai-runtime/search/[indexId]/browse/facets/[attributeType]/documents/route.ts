/**
 * GET /api/search-ai-runtime/search/:indexId/browse/facets/:attributeType/documents — Facet documents
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchRuntime } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ indexId: string; attributeType: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { indexId, attributeType } = await params;
  const qs = request.nextUrl.search;
  return proxyToSearchRuntime(
    request,
    `/api/search/${encodeURIComponent(indexId)}/browse/facets/${encodeURIComponent(attributeType)}/documents${qs}`,
    {
      tenantId: user.tenantId,
    },
  );
}
