/**
 * DELETE /api/indexes/:id/sources/:sourceId — Remove a source
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string; sourceId: string }> };

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, sourceId } = await params;
  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceId)}`,
    {
      method: 'DELETE',
      tenantId: user.tenantId,
    },
  );
}
