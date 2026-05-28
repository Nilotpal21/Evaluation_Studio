/**
 * GET /api/mappings — List field mappings for a schema
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const schemaId = request.nextUrl.searchParams.get('schemaId');
  if (!schemaId) {
    return NextResponse.json({ error: 'schemaId query parameter is required' }, { status: 400 });
  }

  return proxyToSearchEngine(request, `/api/mappings?schemaId=${encodeURIComponent(schemaId)}`, {
    tenantId: user.tenantId,
  });
}
