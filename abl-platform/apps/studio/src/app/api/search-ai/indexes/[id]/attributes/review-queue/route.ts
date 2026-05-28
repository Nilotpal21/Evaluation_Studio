/**
 * GET /api/search-ai/indexes/:id/attributes/review-queue — Attribute review queue
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
  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/attributes/review-queue${qs}`,
    {
      tenantId: user.tenantId,
    },
  );
}
