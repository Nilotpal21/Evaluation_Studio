/**
 * POST /api/projects/:id/experiments/:experimentId/stop — Stop experiment
 *
 * Proxies to Runtime experiments API.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const dynamic = 'force-dynamic';

export const POST = withRouteHandler(
  { requireProject: true },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/experiments/${params.experimentId}/stop`,
      { tenantId, method: 'POST', body: {} },
    );
  },
);
