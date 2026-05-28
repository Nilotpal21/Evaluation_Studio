import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

/**
 * GET /api/search-ai/indexes/kg-taxonomy/domains/:domainId
 * Fetch full domain definition with products, attributes, categories
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ domainId: string }> }) {
  const user = await requireAuth(req);
  if (isAuthError(user)) return user;

  const { domainId } = await params;

  return proxyToSearchEngine(req, `/api/indexes/kg-taxonomy/domains/${domainId}`, {
    tenantId: user.tenantId,
  });
}
