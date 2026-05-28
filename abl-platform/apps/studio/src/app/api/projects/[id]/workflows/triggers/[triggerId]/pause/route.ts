/**
 * POST /api/projects/:id/workflows/triggers/:triggerId/pause — Pause a trigger
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
      `/api/projects/${params.id}/workflows/triggers/${params.triggerId}/pause`,
      {
        method: 'POST',
        tenantId,
      },
    );
  },
);
