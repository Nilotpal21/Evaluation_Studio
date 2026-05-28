/**
 * GET /api/search-ai/connectors/:connectorId/auth/status — Poll auth status
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
    `/api/connectors/${encodeURIComponent(connectorId)}/auth/status`,
    { tenantId: user.tenantId },
  );
}
