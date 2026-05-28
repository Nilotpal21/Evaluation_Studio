/**
 * GET /api/search-ai/indexes/kg-taxonomy/domains — List available KG domains
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  return proxyToSearchEngine(request, '/api/indexes/kg-taxonomy/domains', {
    tenantId: user.tenantId,
  });
}
