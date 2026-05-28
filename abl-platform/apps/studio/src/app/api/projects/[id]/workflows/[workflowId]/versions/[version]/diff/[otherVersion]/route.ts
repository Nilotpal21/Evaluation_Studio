/**
 * GET /api/projects/:id/workflows/:workflowId/versions/:version/diff/:otherVersion — Diff two versions
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
      `/api/projects/${params.id}/workflows/${params.workflowId}/versions/${params.version}/diff/${params.otherVersion}`,
      { tenantId },
    );
  },
);
