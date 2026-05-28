/**
 * POST /api/projects/:id/connections/oauth/initiate
 *
 * DEPRECATED: OAuth connections are now created via auth profiles.
 * Use the auth profile OAuth flow (/api/projects/:id/auth-profiles/oauth/*)
 * to initiate OAuth authorization.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_WRITE },
  async () => {
    return NextResponse.json(
      {
        success: false,
        error:
          'OAuth connections are now created via auth profiles. Use the auth profile OAuth flow to initiate authorization.',
      },
      { status: 410 },
    );
  },
);
