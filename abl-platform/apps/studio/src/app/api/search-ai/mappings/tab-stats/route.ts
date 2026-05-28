/**
 * GET /api/search-ai/mappings/tab-stats — Field mapping statistics
 *
 * Forwards knowledgeBaseId query param to backend.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const knowledgeBaseId = request.nextUrl.searchParams.get('knowledgeBaseId');
  if (!knowledgeBaseId) {
    return NextResponse.json(
      { success: false, error: { code: 'MISSING_PARAM', message: 'knowledgeBaseId is required' } },
      { status: 400 },
    );
  }

  return proxyToSearchEngine(
    request,
    `/api/mappings/tab-stats?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`,
    { tenantId: user.tenantId },
  );
}
