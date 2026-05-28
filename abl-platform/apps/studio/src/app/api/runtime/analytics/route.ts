/**
 * GET/POST /api/runtime/analytics — Proxy to runtime analytics API
 *
 * Forwards requests to /api/projects/:projectId/analytics/:endpoint
 * with auth headers and tenant context.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { safeJsonParse } from '@/lib/safe-proxy';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio:api:analytics');

const PROXY_TIMEOUT_MS = 15_000;

function buildHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  headers['X-Tenant-Id'] = tenantId;
  return headers;
}

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

  const endpoint = request.nextUrl.searchParams.get('endpoint');
  if (!endpoint) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'MISSING_PARAM', message: 'endpoint query parameter is required' },
      },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    // Forward remaining query params (strip projectId and endpoint)
    const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
    forwardParams.delete('projectId');
    forwardParams.delete('endpoint');
    const qs = forwardParams.toString();
    const queryString = qs ? `?${qs}` : '';

    const url = `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/analytics/${encodeURIComponent(endpoint)}${queryString}`;
    const response = await fetch(url, {
      headers: buildHeaders(request, user.tenantId),
      signal: controller.signal,
    });

    const { data, status } = await safeJsonParse(response);
    return NextResponse.json(data, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    log.error(isTimeout ? 'Timeout proxying analytics GET' : 'Error proxying analytics GET', {
      projectId,
      endpoint,
      error: message,
    });
    return NextResponse.json(
      {
        success: false,
        error: isTimeout
          ? { code: 'PROXY_TIMEOUT', message: 'Runtime did not respond within 15s' }
          : { code: 'PROXY_ERROR', message: 'Failed to fetch analytics from runtime' },
      },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

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

  const endpoint = request.nextUrl.searchParams.get('endpoint');
  if (!endpoint) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'MISSING_PARAM', message: 'endpoint query parameter is required' },
      },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const body = await request.json();
    const url = `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/analytics/${encodeURIComponent(endpoint)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(request, user.tenantId),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const { data, status } = await safeJsonParse(response);
    return NextResponse.json(data, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    log.error(isTimeout ? 'Timeout proxying analytics POST' : 'Error proxying analytics POST', {
      projectId,
      endpoint,
      error: message,
    });
    return NextResponse.json(
      {
        success: false,
        error: isTimeout
          ? { code: 'PROXY_TIMEOUT', message: 'Runtime did not respond within 15s' }
          : { code: 'PROXY_ERROR', message: 'Failed to post analytics query to runtime' },
      },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
