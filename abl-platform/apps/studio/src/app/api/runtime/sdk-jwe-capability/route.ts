/**
 * GET /api/runtime/sdk-jwe-capability — Proxy to Runtime SDK JWE readiness.
 *
 * Extracts projectId from query params and forwards to:
 * /api/projects/:projectId/sdk-jwe-capability
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { safeJsonParse } from '@/lib/safe-proxy';
import { buildRuntimeProxyHeaders } from '@/lib/runtime-proxy';
import {
  isSdkRuntimeChannelProxyError,
  resolveSdkRuntimeChannelProxyContext,
} from '@/lib/sdk-runtime-channel-proxy';

const log = createLogger('studio-sdk-jwe-capability-proxy');

export async function GET(request: NextRequest) {
  const proxyContext = await resolveSdkRuntimeChannelProxyContext(request, 'read');
  if (isSdkRuntimeChannelProxyError(proxyContext)) return proxyContext;

  try {
    const response = await fetch(
      `${proxyContext.runtimeUrl}/api/projects/${encodeURIComponent(proxyContext.projectId)}/sdk-jwe-capability`,
      { headers: buildRuntimeProxyHeaders(request, proxyContext.tenantId) },
    );

    const { data } = await safeJsonParse(response);
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    log.error('Failed to proxy SDK JWE capability', {
      error: error instanceof Error ? error.message : String(error),
      projectId: proxyContext.projectId,
    });
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to inspect SDK JWE capability' },
      },
      { status: 502 },
    );
  }
}
