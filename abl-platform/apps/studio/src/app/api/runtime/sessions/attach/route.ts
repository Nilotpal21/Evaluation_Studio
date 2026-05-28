/**
 * POST /api/runtime/sessions/attach — Proxy to runtime developer-session attach validation
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { safeJsonParse } from '@/lib/safe-proxy';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio:attach-runtime-session-proxy');

const PROXY_TIMEOUT_MS = 20_000;
const NO_STORE_CACHE_CONTROL = 'no-store';

function buildProxyHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tenant-Id': tenantId,
  };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  return headers;
}

function buildRuntimeAttachSessionUrl(request: NextRequest, projectId: string): string {
  const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
  forwardParams.delete('projectId');
  const queryString = forwardParams.toString();
  const suffix = queryString ? `?${queryString}` : '';
  return `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/sessions/attach${suffix}`;
}

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
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
    const response = await fetch(buildRuntimeAttachSessionUrl(request, projectId), {
      method: 'POST',
      headers: buildProxyHeaders(request, user.tenantId),
      body: await request.text(),
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
        ? 'Timeout proxying runtime developer session attach'
        : 'Error proxying runtime developer session attach',
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
          : { code: 'PROXY_ERROR', message: 'Failed to validate runtime session attachment' },
      },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
