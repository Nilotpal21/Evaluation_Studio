/**
 * GET    /api/projects/:id/workflows/:workflowId/versions/:version — Get single version
 * PATCH  /api/projects/:id/workflows/:workflowId/versions/:version — Update draft version
 * DELETE /api/projects/:id/workflows/:workflowId/versions/:version — Soft-delete version
 *
 * Proxies to runtime.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const GET = withRouteHandler(
  { requireProject: true, permissions: 'workflow:read' as any },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/versions/${params.version}`,
      { tenantId },
    );
  },
);

export const PATCH = withRouteHandler(
  { requireProject: true, permissions: 'workflow:update' as any },
  async ({ request, tenantId, params }) => {
    const body = await request.json();
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/versions/${params.version}`,
      { tenantId, method: 'PATCH', body },
    );
  },
);

export const DELETE = withRouteHandler(
  { requireProject: true, permissions: 'workflow:delete' as any },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/versions/${params.version}`,
      { tenantId, method: 'DELETE' },
    );
  },
);
