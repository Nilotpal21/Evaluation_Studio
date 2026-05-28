/**
 * GET /api/search-ai/indexes/:id/kg-configuration-status
 *
 * Check KG configuration status with workspace-aware model recommendations.
 * Proxies to SearchAI service.
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
    `/api/indexes/${encodeURIComponent(id)}/kg-configuration-status`,
    {
      tenantId: user.tenantId,
    },
  );
}
