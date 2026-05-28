/**
 * GET /api/projects/:id/connectors/:connectorName/actions
 *
 * Returns action schemas (with ConnectorProperty[] props) for a specific connector.
 * Proxies through runtime (which forwards to workflow-engine) so that Studio
 * doesn't need a direct WORKFLOW_ENGINE_URL — runtime already has it configured.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';
import { StudioPermission } from '@/lib/permissions';

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: [StudioPermission.WORKFLOW_READ, StudioPermission.CONNECTION_READ],
  },
  async ({ request, tenantId, params }) => {
    const connectorName = params.connectorName;
    if (!connectorName || typeof connectorName !== 'string') {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_PARAMS', message: 'connectorName is required' },
        },
        { status: 400 },
      );
    }

    // Validate connectorName to prevent path traversal (e.g., "../../../admin")
    if (!/^[a-z0-9@_-]+$/i.test(connectorName)) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_PARAMS', message: 'Invalid connector name format' },
        },
        { status: 400 },
      );
    }

    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/connectors/${connectorName}/actions`,
      { tenantId },
    );
  },
);
