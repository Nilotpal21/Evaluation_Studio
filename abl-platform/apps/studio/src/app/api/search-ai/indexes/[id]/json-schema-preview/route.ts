import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id } = await params;

  const searchAIUrl =
    process.env.SEARCH_AI_ENGINE_URL || process.env.SEARCH_AI_URL || 'http://localhost:3005';
  const targetUrl = `${searchAIUrl}/api/indexes/${encodeURIComponent(id)}/json-schema-preview`;

  const headers: Record<string, string> = {};
  const contentType = request.headers.get('content-type');
  if (contentType) headers['Content-Type'] = contentType;
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  if (user.tenantId) headers['X-Tenant-Id'] = user.tenantId;

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
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: `Schema preview proxy failed: ${message}` },
      },
      { status: 502 },
    );
  }
}
