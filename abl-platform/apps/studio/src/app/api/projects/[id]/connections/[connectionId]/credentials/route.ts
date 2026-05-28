/**
 * GET /api/projects/:id/connections/:connectionId/credentials
 *
 * DEPRECATED: Connections no longer store credentials directly.
 * All credentials are managed via auth profiles.
 * This endpoint returns 410 Gone to inform clients to use auth profile APIs instead.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_WRITE },
  async () => {
    return NextResponse.json(
      {
        success: false,
        error:
          'Connections no longer store credentials directly. Use auth profile APIs for credential management.',
      },
      { status: 410 },
    );
  },
);
