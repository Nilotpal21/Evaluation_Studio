/**
 * GET /api/search-ai-runtime/search/:indexId/discover — Discovery manifest
 *
 * Proxies to search-ai-runtime discovery endpoint to get
 * filter fields, vocabulary terms, and KB capabilities.
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchRuntime } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ indexId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { indexId } = await params;
  return proxyToSearchRuntime(request, `/api/search/${encodeURIComponent(indexId)}/discover`, {
    tenantId: user.tenantId,
  });
}
