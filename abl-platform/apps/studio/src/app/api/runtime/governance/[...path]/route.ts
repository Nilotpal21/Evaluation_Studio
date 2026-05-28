/**
 * Catch-all proxy for /api/runtime/governance/[...path]
 *
 * Forwards all governance sub-path requests to runtime
 * at /api/projects/:projectId/governance/:path with auth + tenant headers.
 *
 * Query params consumed here:
 *   - projectId (required)
 * All other query params are forwarded as-is to runtime.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { safeJsonParse } from '@/lib/safe-proxy';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio:api:governance');
const PROXY_TIMEOUT_MS = 30_000;

function buildHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  headers['X-Tenant-Id'] = tenantId;
  const ct = request.headers.get('Content-Type');
  if (ct) headers['Content-Type'] = ct;
  return headers;
}

type Ctx = { params: Promise<{ path: string[] }> };

async function handler(request: NextRequest, { params }: Ctx) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { path } = await params;
  const projectId = request.nextUrl.searchParams.get('projectId');

  if (!projectId) {
    return NextResponse.json(
      { success: false, error: { code: 'MISSING_PARAM', message: 'projectId is required' } },
      { status: 400 },
    );
  }

  const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
  forwardParams.delete('projectId');
  const qs = forwardParams.toString();
  const queryString = qs ? `?${qs}` : '';

  const subPath = path.map(encodeURIComponent).join('/');
  const url = `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/governance/${subPath}${queryString}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    let body: BodyInit | null = null;
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      body = await request.text();
    }

    const response = await fetch(url, {
      method: request.method,
      headers: buildHeaders(request, user.tenantId),
      body: body ?? undefined,
      signal: controller.signal,
    });

    // Pass-through binary responses (CSV, PDF)
    const contentType = response.headers.get('Content-Type') ?? '';
    if (!contentType.includes('application/json')) {
      const buf = await response.arrayBuffer();
      const responseHeaders = new Headers();
      responseHeaders.set('Content-Type', contentType);
      const disposition = response.headers.get('Content-Disposition');
      if (disposition) responseHeaders.set('Content-Disposition', disposition);
      const length = response.headers.get('Content-Length');
      if (length) responseHeaders.set('Content-Length', length);
      return new NextResponse(buf, { status: response.status, headers: responseHeaders });
    }

    const { data, status } = await safeJsonParse(response);
    return NextResponse.json(data, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    log.error(isTimeout ? 'Timeout proxying governance' : 'Error proxying governance', {
      projectId,
      path: path.join('/'),
      error: message,
    });
    return NextResponse.json(
      {
        success: false,
        error: isTimeout
          ? { code: 'PROXY_TIMEOUT', message: 'Runtime did not respond within 30s' }
          : { code: 'PROXY_ERROR', message: 'Failed to reach governance service' },
      },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
