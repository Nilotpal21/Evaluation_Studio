/**
 * GET /api/projects/:id/connectors — Auth-aware connector catalog
 *
 * Serves the connector catalog enriched with the same auth-profile integration
 * metadata used by the Auth Profiles integrations surface, plus static actions
 * and triggers from the generated connector catalog.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { ensureDb } from '@/lib/ensure-db';
import { buildIntegrationProviders } from '@/lib/integration-provider-service';
import {
  enrichProvidersWithCatalog,
  PROJECT_CONNECTOR_HIDDEN_NAMES,
  type ConnectorCatalogEntry,
  type EnrichmentProvider,
} from '@/lib/connector-catalog-enrichment';
import { createLogger } from '@abl/compiler/platform/logger.js';
import catalog from '@agent-platform/connectors/catalog/json';

const log = createLogger('project-connectors-route');

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: [
      StudioPermission.WORKFLOW_READ,
      StudioPermission.CONNECTION_READ,
      StudioPermission.CONNECTION_WRITE,
    ],
  },
  async ({ user, params, tenantId }) => {
    await ensureDb();

    const projectId = params.id;
    const isAdmin = user.permissions?.includes(StudioPermission.AUTH_PROFILE_DECRYPT) ?? false;

    log.debug('Fetching auth-aware connector catalog for project', { tenantId, projectId });

    const providers = await buildIntegrationProviders({
      tenantId,
      projectId,
      userId: user.id,
      isAdmin,
    });

    const visibleProviders = (providers as EnrichmentProvider[]).filter(
      (provider) => !PROJECT_CONNECTOR_HIDDEN_NAMES.has(provider.connectorName),
    );

    const data = enrichProvidersWithCatalog(visibleProviders, catalog as ConnectorCatalogEntry[]);

    return NextResponse.json({ success: true, data });
  },
);
