/**
 * GET /api/schemas/connectors/:connectorId — Get connector schema
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ connectorId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { connectorId } = await params;
  return proxyToSearchEngine(
    request,
    `/api/schemas/connectors/${encodeURIComponent(connectorId)}`,
    {
      tenantId: user.tenantId,
    },
  );
}
