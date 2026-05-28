/**
 * GET /api/search-ai/schemas/:id/unmapped/:connectorId
 *
 * Returns connector fields that don't have a mapping to the canonical schema.
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string; connectorId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, connectorId } = await params;
  return proxyToSearchEngine(
    request,
    `/api/schemas/${encodeURIComponent(id)}/unmapped/${encodeURIComponent(connectorId)}`,
    { tenantId: user.tenantId },
  );
}
