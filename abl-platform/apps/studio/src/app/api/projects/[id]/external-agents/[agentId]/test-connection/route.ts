/**
 * POST /api/projects/:id/external-agents/:agentId/test-connection
 *
 * Proxies to Runtime test-connection endpoint.
 */

import { StudioPermission } from '@/lib/permissions';
import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.EXTERNAL_AGENT_UPDATE },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/external-agents/${params.agentId}/test-connection`,
      { tenantId, method: 'POST' },
    );
  },
);
