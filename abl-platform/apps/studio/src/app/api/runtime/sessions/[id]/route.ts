/**
 * GET /api/runtime/sessions/:id — Proxy to runtime session detail
 * DELETE /api/runtime/sessions/:id — Proxy to runtime session delete
 *
 * Both operations proxy to the Runtime service which is the authority for
 * session data (messages, trace events, state). The Runtime first checks
 * its in-memory executor for active sessions, then falls back to DB +
 * ClickHouse for historical sessions.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { safeJsonParse } from '@/lib/safe-proxy';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio:sessions-proxy');

const PROXY_TIMEOUT_MS = 20_000;
const NO_STORE_CACHE_CONTROL = 'no-store';

function buildProxyHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = { 'X-Tenant-Id': tenantId };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  return headers;
}

function buildRuntimeSessionUrl(request: NextRequest, id: string, projectId: string): string {
  const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
  forwardParams.delete('projectId');
  const queryString = forwardParams.toString();
  const suffix = queryString ? `?${queryString}` : '';
  return `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(id)}${suffix}`;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'MISSING_PARAM', message: 'projectId query parameter is required' },
      },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const response = await fetch(buildRuntimeSessionUrl(request, id, projectId), {
      headers: buildProxyHeaders(request, user.tenantId),
      signal: controller.signal,
      cache: 'no-store',
    });

    const { data, status } = await safeJsonParse(response);
    const nextResponse = NextResponse.json(data, { status });
    // Session detail drives Observatory hydration, so stale browser/proxy cache
    // can hide newly recovered historical traces for completed sessions.
    nextResponse.headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
    return nextResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    log.error(isTimeout ? 'Timeout proxying session detail' : 'Error proxying session detail', {
      sessionId: id,
      projectId,
      error: message,
    });
    return NextResponse.json(
      {
        success: false,
        error: isTimeout
          ? { code: 'PROXY_TIMEOUT', message: 'Runtime did not respond within 20s' }
          : { code: 'PROXY_ERROR', message: 'Failed to fetch session from runtime' },
      },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'MISSING_PARAM', message: 'projectId query parameter is required' },
      },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const response = await fetch(buildRuntimeSessionUrl(request, id, projectId), {
      method: 'DELETE',
      headers: buildProxyHeaders(request, user.tenantId),
      signal: controller.signal,
    });

    if (response.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    const { data, status } = await safeJsonParse(response);
    return NextResponse.json(data, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    log.error(isTimeout ? 'Timeout proxying session delete' : 'Error proxying session delete', {
      sessionId: id,
      projectId,
      error: message,
    });
    return NextResponse.json(
      {
        success: false,
        error: isTimeout
          ? { code: 'PROXY_TIMEOUT', message: 'Runtime did not respond within 20s' }
          : { code: 'PROXY_ERROR', message: 'Failed to delete session from runtime' },
      },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
