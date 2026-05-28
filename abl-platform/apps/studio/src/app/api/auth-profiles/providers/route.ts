/**
 * GET /api/auth-profiles/providers
 *
 * Returns the connector catalog enriched with Nango OAuth metadata and
 * per-connector profile counts (tenant-scoped profiles only).
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { ensureDb } from '@/lib/ensure-db';
import { buildIntegrationProviders } from '@/lib/integration-provider-service';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('workspace-integration-providers-route');

export const GET = withRouteHandler(
  { permissions: StudioPermission.AUTH_PROFILE_READ },
  async ({ user, tenantId }) => {
    await ensureDb();

    const isAdmin = user.permissions?.includes(StudioPermission.AUTH_PROFILE_DECRYPT) ?? false;

    log.debug('Fetching integration providers for workspace', { tenantId });

    const providers = await buildIntegrationProviders({
      tenantId,
      projectId: null,
      userId: user.id,
      isAdmin,
    });

    return NextResponse.json({ success: true, data: providers });
  },
);
