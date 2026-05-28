/**
 * GET /api/runtime/sessions/:id/agent-spec — Proxy to runtime session agent spec
 *
 * Uses the project-scoped runtime route so historical sessions resolve the
 * pinned agent version captured on the session rather than today's latest DSL.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { safeJsonParse } from '@/lib/safe-proxy';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio:api:session-agent-spec');

const PROXY_TIMEOUT_MS = 15_000;
const NO_STORE_CACHE_CONTROL = 'no-store';

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
    const headers: Record<string, string> = { 'X-Tenant-Id': user.tenantId };
    const auth = request.headers.get('Authorization');
    if (auth) headers['Authorization'] = auth;

    const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
    forwardParams.delete('projectId');
    const qs = forwardParams.toString();
    const queryString = qs ? `?${qs}` : '';

    const response = await fetch(
      `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(id)}/agent-spec${queryString}`,
      { headers, signal: controller.signal, cache: 'no-store' },
    );

    const { data, status } = await safeJsonParse(response);
    const nextResponse = NextResponse.json(data, { status });
    nextResponse.headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
    return nextResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    log.error(
      isTimeout ? 'Timeout proxying session agent spec' : 'Error proxying session agent spec',
      {
        sessionId: id,
        projectId,
        error: message,
      },
    );
    return NextResponse.json(
      {
        success: false,
        error: isTimeout
          ? { code: 'PROXY_TIMEOUT', message: 'Runtime did not respond within 15s' }
          : { code: 'PROXY_ERROR', message: 'Failed to fetch session agent spec from runtime' },
      },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
