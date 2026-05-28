/**
 * GET    /api/projects/:id/external-agents/:agentId — Get single config
 * PATCH  /api/projects/:id/external-agents/:agentId — Update config
 * DELETE /api/projects/:id/external-agents/:agentId — Delete config
 *
 * Proxies to Runtime external-agents API.
 */

import { StudioPermission } from '@/lib/permissions';
import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.EXTERNAL_AGENT_READ },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(request, `/api/projects/${params.id}/external-agents/${params.agentId}`, {
      tenantId,
    });
  },
);

export const PATCH = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.EXTERNAL_AGENT_UPDATE },
  async ({ request, tenantId, params }) => {
    const body = await request.json();
    return proxyToRuntime(request, `/api/projects/${params.id}/external-agents/${params.agentId}`, {
      tenantId,
      method: 'PATCH',
      body,
    });
  },
);

export const DELETE = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.EXTERNAL_AGENT_DELETE },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(request, `/api/projects/${params.id}/external-agents/${params.agentId}`, {
      tenantId,
      method: 'DELETE',
    });
  },
);
