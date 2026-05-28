/**
 * POST /api/projects/:id/connections/oauth/callback
 *
 * DEPRECATED: OAuth connections are now created via auth profiles.
 * Use the auth profile OAuth flow (/api/projects/:id/auth-profiles/oauth/*)
 * to create OAuth2 credentials, then bind them via a connection.
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
          'OAuth connections are now created via auth profiles. Use the auth profile OAuth flow to create credentials, then bind them to a connection.',
      },
      { status: 410 },
    );
  },
);
