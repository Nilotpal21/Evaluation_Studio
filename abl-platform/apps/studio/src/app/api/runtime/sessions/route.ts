/**
 * GET /api/runtime/sessions — Proxy to runtime session list
 *
 * The Runtime service is the authority for session listings because it can
 * merge persisted MongoDB history with currently active in-memory sessions.
 * Studio proxies this route so the chat sidebar and session explorer stay
 * consistent with the execution plane.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { safeJsonParse } from '@/lib/safe-proxy';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio:sessions-list-proxy');

const PROXY_TIMEOUT_MS = 20_000;
const NO_STORE_CACHE_CONTROL = 'no-store';

function buildProxyHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = { 'X-Tenant-Id': tenantId };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  return headers;
}

function buildRuntimeSessionsUrl(request: NextRequest, projectId: string): string {
  const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
  forwardParams.delete('projectId');
  const queryString = forwardParams.toString();
  const suffix = queryString ? `?${queryString}` : '';
  return `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/sessions${suffix}`;
}

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

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
    const response = await fetch(buildRuntimeSessionsUrl(request, projectId), {
      headers: buildProxyHeaders(request, user.tenantId),
      signal: controller.signal,
      cache: 'no-store',
    });

    const { data, status } = await safeJsonParse(response);
    const nextResponse = NextResponse.json(data, { status });
    nextResponse.headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
    return nextResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    log.error(isTimeout ? 'Timeout proxying session list' : 'Error proxying session list', {
      projectId,
      error: message,
    });
    return NextResponse.json(
      {
        success: false,
        error: isTimeout
          ? { code: 'PROXY_TIMEOUT', message: 'Runtime did not respond within 20s' }
          : { code: 'PROXY_ERROR', message: 'Failed to fetch sessions from runtime' },
      },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
