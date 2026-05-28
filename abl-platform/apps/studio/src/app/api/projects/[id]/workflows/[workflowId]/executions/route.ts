/**
 * GET /api/projects/:id/workflows/:workflowId/executions — List workflow executions
 *
 * Proxies to runtime, which forwards to workflow-engine.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const GET = withRouteHandler(
  { requireProject: true, permissions: 'workflow:read' as any },
  async ({ request, tenantId, params }) => {
    const search = new URL(request.url).search;
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/executions${search}`,
      { tenantId },
    );
  },
);
