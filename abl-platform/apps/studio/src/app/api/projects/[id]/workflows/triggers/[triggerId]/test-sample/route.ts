/**
 * POST /api/projects/:id/workflows/triggers/:triggerId/test-sample
 *
 * Runs the connector trigger's run() function with stored OAuth credentials
 * to fetch a live sample payload. Persists the result on the registration
 * so subsequent sample-payload GETs serve it immediately.
 *
 * Proxies to the Runtime service which forwards to workflow-engine.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const POST = withRouteHandler(
  { requireProject: true, permissions: 'workflow:write' as any },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/triggers/${params.triggerId}/test-sample`,
      { tenantId },
    );
  },
);
