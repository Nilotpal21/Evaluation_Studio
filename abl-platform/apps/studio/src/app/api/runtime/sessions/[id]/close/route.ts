/**
 * POST /api/runtime/sessions/:id/close — Proxy to runtime session close
 *
 * Extracts projectId from query params and forwards to the project-scoped
 * runtime path: /api/projects/:projectId/sessions/:id/close
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { safeJsonParse } from '@/lib/safe-proxy';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio:api:session-close');

const PROXY_TIMEOUT_MS = 15_000;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const auth = request.headers.get('Authorization');
    if (auth) headers['Authorization'] = auth;
    headers['X-Tenant-Id'] = user.tenantId;

    const body = await request.text();

    const response = await fetch(
      `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(id)}/close`,
      {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      },
    );

    const { data, status } = await safeJsonParse(response);
    return NextResponse.json(data, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    log.error(isTimeout ? 'Timeout proxying session close' : 'Error proxying session close', {
      sessionId: id,
      projectId,
      error: message,
    });
    return NextResponse.json(
      {
        success: false,
        error: isTimeout
          ? { code: 'PROXY_TIMEOUT', message: 'Runtime did not respond within 15s' }
          : { code: 'PROXY_ERROR', message: 'Failed to close session via runtime' },
      },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
