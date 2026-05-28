/**
 * GET /api/v1/livekit/capabilities — Proxy to runtime LiveKit capabilities
 *
 * Authenticates via user JWT or SDK session token, then forwards to runtime.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { getRequiredRuntimeUrl } from '@/config/runtime.server';

const log = createLogger('studio-livekit-capabilities-proxy');

export async function GET(request: NextRequest) {
  const sdkToken = request.headers.get('X-SDK-Token');

  // Resolve tenantId: prefer authenticated user; SDK path lets runtime validate the token
  let tenantId: string | undefined;

  if (!sdkToken) {
    const user = await requireAuth(request);
    if (isAuthError(user)) return user;
    tenantId = user.tenantId;
  }
  // SDK token path: do NOT trust client-supplied X-Tenant-Id — the runtime
  // will extract and validate tenant from the SDK token itself.

  let runtimeUrl: string;
  try {
    runtimeUrl = getRequiredRuntimeUrl();
  } catch (error) {
    log.error('LiveKit capabilities proxy missing runtime configuration', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'RUNTIME_CONFIG_REQUIRED',
          message:
            error instanceof Error ? error.message : 'Runtime URL must be configured explicitly',
        },
      },
      { status: 500 },
    );
  }

  try {
    const headers: Record<string, string> = {};
    const auth = request.headers.get('Authorization');
    if (sdkToken) headers['X-SDK-Token'] = sdkToken;
    if (auth) headers['Authorization'] = auth;
    if (tenantId) headers['X-Tenant-Id'] = tenantId;

    const response = await fetch(`${runtimeUrl}/api/v1/livekit/capabilities`, { headers });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    log.error('LiveKit capabilities proxy error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { enabled: false, configured: false, error: 'Failed to reach runtime' },
      { status: 502 },
    );
  }
}
