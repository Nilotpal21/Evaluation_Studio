/**
 * Catch-all proxy for /api/search-ai/indexes/:id/connectors/:connectorId/*
 *
 * Forwards all sub-path requests (proposal, notifications, summary, etc.)
 * to the SearchAI backend with auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string; connectorId: string; path: string[] }> };

async function handler(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, connectorId, path } = await params;
  const subPath = path.join('/');
  const search = request.nextUrl.search;

  let body: unknown;
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    try {
      body = await request.json();
    } catch {
      // No body or non-JSON body — pass through without body
    }
  }

  return proxyToSearchEngine(
    request,
    `/api/indexes/${encodeURIComponent(id)}/connectors/${encodeURIComponent(connectorId)}/${subPath}${search}`,
    {
      method: request.method,
      ...(body !== undefined ? { body } : {}),
      tenantId: user.tenantId,
    },
  );
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
