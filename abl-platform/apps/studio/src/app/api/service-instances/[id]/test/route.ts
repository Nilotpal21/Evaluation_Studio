/**
 * POST /api/service-instances/:id/test — Test saved speech credential
 *
 * Proxies to runtime /api/tenants/:tenantId/service-instances/:id/test.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { proxyToRuntime } from '@/lib/runtime-proxy';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio:service-instance-test');

async function postHandler(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const tenantId = user.tenantId;

  try {
    return await proxyToRuntime(
      request,
      `/api/tenants/${encodeURIComponent(tenantId)}/service-instances/${encodeURIComponent(id)}/test`,
      { method: 'POST', tenantId, timeoutMs: 60_000 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Proxy POST test failed', { error: message, serviceInstanceId: id });
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'PROXY_ERROR',
          message: 'Failed to test service instance via runtime',
        },
      },
      { status: 502 },
    );
  }
}

export const POST = postHandler;
