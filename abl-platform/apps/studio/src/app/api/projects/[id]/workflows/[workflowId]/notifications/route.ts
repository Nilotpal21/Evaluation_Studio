/**
 * GET  /api/projects/:id/workflows/:workflowId/notifications — List notification rules
 * POST /api/projects/:id/workflows/:workflowId/notifications — Create a notification rule
 *
 * Proxies to Runtime which forwards to workflow-engine.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const GET = withRouteHandler(
  { requireProject: true, permissions: 'workflow:read' as any },
  async ({ request, tenantId, params }) => {
    const search = new URL(request.url).search;
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/notifications${search}`,
      { tenantId },
    );
  },
);

export const POST = withRouteHandler(
  { requireProject: true, permissions: 'workflow:update' as any },
  async ({ request, tenantId, params }) => {
    const body = await request.clone().json();
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/notifications`,
      { method: 'POST', body, tenantId },
    );
  },
);
