/**
 * POST /api/indexes/:id/sources/:sourceId/documents — Upload document
 *
 * Streams the raw request body to SearchAI to avoid timeout on large files.
 * The Content-Type header (with multipart boundary) is forwarded as-is.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';

type Ctx = { params: Promise<{ id: string; sourceId: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, sourceId } = await params;

  const searchAIUrl =
    process.env.SEARCH_AI_ENGINE_URL || process.env.SEARCH_AI_URL || 'http://localhost:3005';
  const targetUrl = `${searchAIUrl}/api/indexes/${id}/sources/${sourceId}/documents${request.nextUrl.search}`;

  const headers: Record<string, string> = {};
  const contentType = request.headers.get('content-type');
  if (contentType) headers['Content-Type'] = contentType;
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  const tenantId = request.headers.get('X-Tenant-Id');
  if (tenantId) headers['X-Tenant-Id'] = tenantId;

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: request.body,
      // @ts-expect-error — Node fetch supports duplex for streaming
      duplex: 'half',
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[SearchAI Upload Proxy] Failed:`, message);
    return NextResponse.json({ error: `Upload proxy failed: ${message}` }, { status: 502 });
  }
}
