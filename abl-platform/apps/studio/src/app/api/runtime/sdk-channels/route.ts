/**
 * GET /api/runtime/sdk-channels — Proxy to runtime SDK channel list
 * POST /api/runtime/sdk-channels — Proxy to runtime SDK channel create
 *
 * Extracts projectId from query params and forwards to the project-scoped
 * runtime path: /api/projects/:projectId/sdk-channels
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { safeJsonParse } from '@/lib/safe-proxy';
import { buildRuntimeProxyHeaders } from '@/lib/runtime-proxy';
import {
  isSdkRuntimeChannelProxyError,
  resolveSdkRuntimeChannelProxyContext,
} from '@/lib/sdk-runtime-channel-proxy';

const log = createLogger('studio-sdk-channel-proxy');

export async function GET(request: NextRequest) {
  const proxyContext = await resolveSdkRuntimeChannelProxyContext(request, 'read');
  if (isSdkRuntimeChannelProxyError(proxyContext)) return proxyContext;

  try {
    // Forward remaining query params (strip projectId — it's in the path now)
    const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
    forwardParams.delete('projectId');
    const qs = forwardParams.toString();
    const queryString = qs ? `?${qs}` : '';

    const response = await fetch(
      `${proxyContext.runtimeUrl}/api/projects/${encodeURIComponent(proxyContext.projectId)}/sdk-channels${queryString}`,
      { headers: buildRuntimeProxyHeaders(request, proxyContext.tenantId) },
    );

    const { data } = await safeJsonParse(response);
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    log.error('Failed to proxy SDK channel list', {
      error: error instanceof Error ? error.message : String(error),
      projectId: proxyContext.projectId,
    });
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to fetch SDK channels from runtime' },
      },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const proxyContext = await resolveSdkRuntimeChannelProxyContext(request, 'write');
  if (isSdkRuntimeChannelProxyError(proxyContext)) return proxyContext;

  try {
    const body = await request.json();
    const headers = buildRuntimeProxyHeaders(request, proxyContext.tenantId);

    const response = await fetch(
      `${proxyContext.runtimeUrl}/api/projects/${encodeURIComponent(proxyContext.projectId)}/sdk-channels`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
    );

    const { data } = await safeJsonParse(response);
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    log.error('Failed to proxy SDK channel create', {
      error: error instanceof Error ? error.message : String(error),
      projectId: proxyContext.projectId,
    });
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to create SDK channel via runtime' },
      },
      { status: 502 },
    );
  }
}
