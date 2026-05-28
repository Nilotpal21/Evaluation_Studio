/**
 * POST /api/runtime/sessions/:id/pii/reveal
 *
 * Studio proxy for Runtime's audited PII reveal endpoint. Studio performs the
 * exact-sensitive permission check before forwarding and never inspects or logs
 * reveal request/response values.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { getRuntimeUrl } from '@/config/runtime.server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { isProjectPermissionError, requireProjectPermission } from '@/lib/project-permission';
import { safeJsonParse } from '@/lib/safe-proxy';

const log = createLogger('studio:session-pii-reveal-proxy');

const PROXY_TIMEOUT_MS = 20_000;
const NO_STORE_CACHE_CONTROL = 'no-store';

type RouteParams = { params: Promise<{ id: string }> };

function withNoStore(response: NextResponse | Response): NextResponse | Response {
  response.headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
  return response;
}

function buildProxyHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tenant-Id': tenantId,
  };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  return headers;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: sessionId } = await params;
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return withNoStore(
      NextResponse.json(
        {
          success: false,
          error: { code: 'MISSING_PARAM', message: 'projectId query parameter is required' },
        },
        { status: 400 },
      ),
    );
  }

  const access = await requireProjectPermission(projectId, user, 'pii:reveal');
  if (isProjectPermissionError(access)) {
    return withNoStore(access);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/pii/reveal`,
      {
        method: 'POST',
        headers: buildProxyHeaders(request, user.tenantId),
        body: await request.text(),
        signal: controller.signal,
        cache: 'no-store',
      },
    );

    const { data, status } = await safeJsonParse(response);
    return withNoStore(NextResponse.json(data, { status }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    log.error(isTimeout ? 'Timeout proxying PII reveal' : 'Error proxying PII reveal', {
      sessionId,
      projectId,
      error: message,
    });
    return withNoStore(
      NextResponse.json(
        {
          success: false,
          error: isTimeout
            ? { code: 'PROXY_TIMEOUT', message: 'Runtime did not respond within 20s' }
            : { code: 'PROXY_ERROR', message: 'Failed to reveal PII via runtime' },
        },
        { status: isTimeout ? 504 : 502 },
      ),
    );
  } finally {
    clearTimeout(timeout);
  }
}
