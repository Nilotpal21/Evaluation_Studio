/**
 * GET /api/projects/:id/workflows/triggers/:triggerId/sample-payload
 *
 * Returns the last triggerPayload this trigger received. Used by the Fire Now
 * modal to pre-populate the JSON payload editor. `data.payload` is `null` when
 * the trigger has no execution history; the client then falls back to `{}`.
 *
 * Proxies to the Runtime service which forwards to workflow-engine.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const GET = withRouteHandler(
  { requireProject: true, permissions: 'workflow:read' as any },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/triggers/${params.triggerId}/sample-payload`,
      { tenantId },
    );
  },
);
