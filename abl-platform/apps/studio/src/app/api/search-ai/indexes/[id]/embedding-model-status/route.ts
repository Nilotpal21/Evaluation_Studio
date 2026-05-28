/**
 * GET /api/search-ai/indexes/:id/embedding-model-status — Get embedding model status
 *
 * Returns current embedding model configuration and migration status.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id } = await params;
  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/embedding-model-status`,
    {
      tenantId: user.tenantId,
    },
  );
}
