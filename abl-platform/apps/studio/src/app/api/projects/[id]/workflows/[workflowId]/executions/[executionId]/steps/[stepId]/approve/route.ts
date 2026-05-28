/**
 * POST /api/projects/:id/workflows/:workflowId/executions/:executionId/steps/:stepId/approve
 *   — Approve or reject a pending approval step
 *
 * Proxies to runtime, which forwards approvals to workflow-engine.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const POST = withRouteHandler(
  { requireProject: true, permissions: 'approval:write' as any },
  async ({ request, tenantId, params }) => {
    const body = await request.clone().json();
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/approvals/${params.workflowId}/executions/${params.executionId}/steps/${params.stepId}/approve`,
      {
        method: 'POST',
        body,
        tenantId,
      },
    );
  },
);
