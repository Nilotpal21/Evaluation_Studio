/**
 * GET /api/projects/:id/auth-profiles/providers
 *
 * Returns the connector catalog enriched with Nango OAuth metadata and
 * per-connector profile counts (project + inherited tenant profiles).
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { ensureDb } from '@/lib/ensure-db';
import { buildIntegrationProviders } from '@/lib/integration-provider-service';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('integration-providers-route');

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_READ },
  async ({ user, params, tenantId }) => {
    await ensureDb();

    const projectId = params.id;
    const isAdmin = user.permissions?.includes(StudioPermission.AUTH_PROFILE_DECRYPT) ?? false;

    log.debug('Fetching integration providers for project', { tenantId, projectId });

    const providers = await buildIntegrationProviders({
      tenantId,
      projectId,
      userId: user.id,
      isAdmin,
    });

    return NextResponse.json({ success: true, data: providers });
  },
);
