/**
 * GET /api/projects/:id/workflows/:workflowId/usage
 *
 * Returns how many triggers fire this workflow and which `type: workflow`
 * tools wrap it, so the detail page can render a "Used by" section and the
 * list card can show count chips without an N+1 fetch per workflow.
 *
 * Proxies to runtime, which computes the rollup.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const GET = withRouteHandler(
  { requireProject: true, permissions: 'workflow:read' as any },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/usage`,
      { tenantId },
    );
  },
);
