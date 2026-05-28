/**
 * GET    /api/search-ai/indexes/:id/kg-taxonomy/domains/:domainId — Get custom domain details
 * DELETE /api/search-ai/indexes/:id/kg-taxonomy/domains/:domainId — Delete custom domain
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string; domainId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, domainId } = await params;
  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/kg-taxonomy/domains/${encodeURIComponent(domainId)}`,
    {
      tenantId: user.tenantId,
    },
  );
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, domainId } = await params;
  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/kg-taxonomy/domains/${encodeURIComponent(domainId)}`,
    {
      method: 'DELETE',
      tenantId: user.tenantId,
    },
  );
}
