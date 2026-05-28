/**
 * GET  /api/knowledge-bases — List knowledge bases for a project
 * POST /api/knowledge-bases — Create a new knowledge base
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'projectId query parameter is required' }, { status: 400 });
  }

  // Forward all query params (projectId, limit, offset, search, sortBy, sortOrder, status)
  const qs = request.nextUrl.search;
  return proxyToSearchEngine(request, `/api/knowledge-bases${qs}`, {
    tenantId: user.tenantId,
  });
}

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }
  return proxyToSearchEngine(request, '/api/knowledge-bases', {
    method: 'POST',
    body,
    tenantId: user.tenantId,
  });
}
