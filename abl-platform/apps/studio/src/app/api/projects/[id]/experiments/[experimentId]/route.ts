/**
 * GET    /api/projects/:id/experiments/:experimentId — Get experiment
 * PUT    /api/projects/:id/experiments/:experimentId — Update experiment
 * DELETE /api/projects/:id/experiments/:experimentId — Delete experiment
 *
 * Proxies to Runtime experiments API.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const dynamic = 'force-dynamic';

export const GET = withRouteHandler(
  { requireProject: true },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/experiments/${params.experimentId}`,
      { tenantId },
    );
  },
);

export const PUT = withRouteHandler(
  { requireProject: true },
  async ({ request, tenantId, params }) => {
    const body = await request.json();
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/experiments/${params.experimentId}`,
      { tenantId, method: 'PUT', body },
    );
  },
);

export const DELETE = withRouteHandler(
  { requireProject: true },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/experiments/${params.experimentId}`,
      { tenantId, method: 'DELETE' },
    );
  },
);
