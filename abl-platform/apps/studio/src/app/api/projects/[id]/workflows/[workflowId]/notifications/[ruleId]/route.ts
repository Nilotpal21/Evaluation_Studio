/**
 * PUT    /api/projects/:id/workflows/:workflowId/notifications/:ruleId — Update rule
 * DELETE /api/projects/:id/workflows/:workflowId/notifications/:ruleId — Delete rule
 *
 * Proxies to Runtime which forwards to workflow-engine.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const PUT = withRouteHandler(
  { requireProject: true, permissions: 'workflow:update' as any },
  async ({ request, tenantId, params }) => {
    const body = await request.clone().json();
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/notifications/${params.ruleId}`,
      { method: 'PUT', body, tenantId },
    );
  },
);

export const DELETE = withRouteHandler(
  { requireProject: true, permissions: 'workflow:update' as any },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/notifications/${params.ruleId}`,
      { method: 'DELETE', tenantId },
    );
  },
);
