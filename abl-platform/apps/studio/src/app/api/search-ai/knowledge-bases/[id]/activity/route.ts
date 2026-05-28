/**
 * GET /api/search-ai/knowledge-bases/:id/activity
 *
 * Proxies to SearchAI activity endpoint.
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id } = await params;
  return proxyToSearchEngine(
    request,
    `/api/knowledge-bases/${encodeURIComponent(id)}/activity${request.nextUrl.search}`,
    {
      tenantId: user.tenantId,
    },
  );
}
