/**
 * POST /api/mappings/:id/confirm — Confirm a field mapping
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id } = await params;
  return proxyToSearchEngine(request, `/api/mappings/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
    tenantId: user.tenantId,
  });
}
