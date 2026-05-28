/**
 * POST /api/runtime/sessions/bulk-close — Proxy to runtime bulk close
 *
 * Extracts projectId from the JSON body and forwards to the project-scoped
 * runtime path: /api/projects/:projectId/sessions/bulk-close
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { safeJsonParse } from '@/lib/safe-proxy';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio:api:bulk-close');

const PROXY_TIMEOUT_MS = 15_000;

export async function POST(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const body = await request.text();
  let projectId: string | undefined;
  try {
    const parsed = JSON.parse(body);
    projectId = parsed.projectId;
  } catch {
    // body parse failed — fall through to validation below
  }

  if (!projectId) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'MISSING_PARAM', message: 'projectId is required in request body' },
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

    const response = await fetch(
      `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/sessions/bulk-close`,
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
    log.error(isTimeout ? 'Timeout proxying bulk-close' : 'Error proxying bulk-close', {
      projectId,
      error: message,
    });
    return NextResponse.json(
      {
        success: false,
        error: isTimeout
          ? { code: 'PROXY_TIMEOUT', message: 'Runtime did not respond within 15s' }
          : { code: 'PROXY_ERROR', message: 'Failed to bulk close sessions via runtime' },
      },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
