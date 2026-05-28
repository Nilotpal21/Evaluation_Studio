/**
 * GET    /api/indexes/:id/vocabulary/:entryId — Get vocabulary entries by fieldRef
 * DELETE /api/indexes/:id/vocabulary/:entryId — Remove vocabulary entry
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string; entryId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, entryId } = await params;
  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/vocabulary/${encodeURIComponent(entryId)}`,
    {
      tenantId: user.tenantId,
    },
  );
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, entryId } = await params;
  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/vocabulary/${encodeURIComponent(entryId)}`,
    {
      method: 'DELETE',
      tenantId: user.tenantId,
    },
  );
}
