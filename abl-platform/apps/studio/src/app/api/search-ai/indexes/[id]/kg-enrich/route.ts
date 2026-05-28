/**
 * POST /api/search-ai/indexes/:id/kg-enrich — Trigger KG enrichment
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  return proxyToSearchEngine(request, `/api/indexes/${encodeURIComponent(id)}/kg-enrich`, {
    method: 'POST',
    body,
    tenantId: user.tenantId,
  });
}
