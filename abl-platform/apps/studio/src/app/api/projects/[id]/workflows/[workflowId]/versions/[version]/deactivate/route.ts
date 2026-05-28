/**
 * POST /api/projects/:id/workflows/:workflowId/versions/:version/deactivate — Deactivate version
 *
 * Proxies to runtime.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const POST = withRouteHandler(
  { requireProject: true, permissions: 'workflow:update' as any },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/versions/${params.version}/deactivate`,
      { tenantId, method: 'POST', body: {} },
    );
  },
);
