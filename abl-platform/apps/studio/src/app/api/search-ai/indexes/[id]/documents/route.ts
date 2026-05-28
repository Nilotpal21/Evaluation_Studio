/**
 * GET /api/search-ai/indexes/:id/documents — List documents for an index
 *
 * Forwards query params: limit, offset, sourceId, sourceType, search, status
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id } = await params;
  const qs = request.nextUrl.search;
  return proxyToSearchEngine(request, `/api/indexes/${encodeURIComponent(id)}/documents${qs}`, {
    tenantId: user.tenantId,
  });
}
