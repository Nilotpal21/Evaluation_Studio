/**
 * GET /api/admin/sdk-clients - Get connected SDK client count (OWNER/ADMIN only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError, requireAdminRole } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('admin-sdk-clients');

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  try {
    // SDK WebSocket clients are managed by the runtime service
    // Studio can proxy this request to runtime or report unavailable
    const runtimeUrl = getRuntimeUrl();

    try {
      const response = await fetch(`${runtimeUrl}/api/admin/sdk-clients`, {
        headers: { Authorization: request.headers.get('authorization') || '' },
      });

      if (response.ok) {
        const data = await response.json();
        return NextResponse.json(data);
      }
    } catch {
      // Runtime not available, return empty
    }

    return NextResponse.json({
      count: 0,
      clients: [],
      message: 'SDK client data is available from the runtime service.',
    });
  } catch (error) {
    log.error('SDK clients error', { err: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
