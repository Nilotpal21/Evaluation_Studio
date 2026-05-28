/**
 * GET /api/projects/:id/agent-transfer/sessions — List transfer sessions
 *
 * Proxies to the runtime's /api/v1/agent-transfer/sessions endpoint.
 * Falls back to an empty array if the runtime endpoint is unavailable.
 */

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { getRuntimeUrl } from '@/config/runtime.server';

const log = createLogger('agent-transfer-sessions');

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_READ },
  async ({ request, tenantId, params }) => {
    const projectId = params.id;

    // Forward filter query params
    const url = request.nextUrl;
    const queryParams = new URLSearchParams();
    const provider = url.searchParams.get('provider');
    const state = url.searchParams.get('state');
    const channel = url.searchParams.get('channel');
    if (provider) queryParams.set('provider', provider);
    if (state) queryParams.set('state', state);
    if (channel) queryParams.set('channel', channel);
    const qs = queryParams.toString();

    try {
      const runtimeUrl = `${getRuntimeUrl()}/api/v1/agent-transfer/sessions${qs ? `?${qs}` : ''}`;
      const headers: Record<string, string> = {
        'X-Tenant-Id': tenantId,
        'X-Project-Id': projectId,
        'Content-Type': 'application/json',
      };
      const auth = request.headers.get('Authorization');
      if (auth) headers['Authorization'] = auth;

      const runtimeRes = await fetch(runtimeUrl, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (runtimeRes.ok) {
        const body = await runtimeRes.json();
        return NextResponse.json({ success: true, data: body.data ?? body.sessions ?? [] });
      }

      // Runtime returned an error
      log.error('Runtime returned non-OK status for transfer sessions', {
        status: runtimeRes.status,
      });
      return NextResponse.json(
        {
          success: false,
          error: { code: 'PROXY_ERROR', message: 'Failed to fetch transfer sessions' },
        },
        { status: 502 },
      );
    } catch (err) {
      log.error('Failed to fetch transfer sessions', {
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        {
          success: false,
          error: { code: 'PROXY_ERROR', message: 'Failed to fetch transfer sessions' },
        },
        { status: 502 },
      );
    }
  },
);
