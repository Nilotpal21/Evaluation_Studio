/**
 * GET /api/runtime/sessions/current — Proxy to runtime current developer session lookup
 *
 * Runtime is the authority for resumable developer execution sessions because
 * it can combine hot in-memory sessions with durable session-state snapshots.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { safeJsonParse } from '@/lib/safe-proxy';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio:current-runtime-session-proxy');

const PROXY_TIMEOUT_MS = 20_000;
const NO_STORE_CACHE_CONTROL = 'no-store';

function buildProxyHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = { 'X-Tenant-Id': tenantId };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  return headers;
}

function buildRuntimeCurrentSessionUrl(request: NextRequest, projectId: string): string {
  const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
  forwardParams.delete('projectId');
  const queryString = forwardParams.toString();
  const suffix = queryString ? `?${queryString}` : '';
  return `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/sessions/current${suffix}`;
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
    const response = await fetch(buildRuntimeCurrentSessionUrl(request, projectId), {
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
    log.error(
      isTimeout
        ? 'Timeout proxying current runtime developer session'
        : 'Error proxying current runtime developer session',
      {
        projectId,
        error: message,
      },
    );
    return NextResponse.json(
      {
        success: false,
        error: isTimeout
          ? { code: 'PROXY_TIMEOUT', message: 'Runtime did not respond within 20s' }
          : { code: 'PROXY_ERROR', message: 'Failed to fetch current runtime session' },
      },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
