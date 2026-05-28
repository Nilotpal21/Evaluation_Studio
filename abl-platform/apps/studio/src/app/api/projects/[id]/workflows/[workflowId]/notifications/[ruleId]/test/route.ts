/**
 * POST /api/projects/:id/workflows/:workflowId/notifications/:ruleId/test — Test notification rule
 *
 * Proxies to Runtime which forwards to workflow-engine.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const POST = withRouteHandler(
  { requireProject: true, permissions: 'workflow:execute' as any },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/notifications/${params.ruleId}/test`,
      { tenantId },
    );
  },
);
