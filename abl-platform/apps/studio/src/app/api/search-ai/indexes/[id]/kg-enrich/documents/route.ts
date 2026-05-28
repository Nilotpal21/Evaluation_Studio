/**
 * GET /api/search-ai/indexes/:id/kg-enrich/documents — Get classified documents
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id } = await params;
  const search = request.nextUrl.search;
  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/kg-enrich/documents${search}`,
    {
      tenantId: user.tenantId,
    },
  );
}
