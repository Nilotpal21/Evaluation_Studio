/**
 * POST /api/projects/:id/workflows/:workflowId/executions/:executionId/cancel — Cancel execution
 *
 * Proxies to runtime, which forwards to workflow-engine.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const POST = withRouteHandler(
  { requireProject: true, permissions: 'workflow:execute' as any },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/executions/${params.executionId}/cancel`,
      { tenantId },
    );
  },
);
