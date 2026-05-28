/**
 * GET  /api/projects/:id/experiments — List experiments
 * POST /api/projects/:id/experiments — Create experiment
 *
 * Proxies to Runtime experiments API.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const dynamic = 'force-dynamic';

export const GET = withRouteHandler(
  { requireProject: true },
  async ({ request, tenantId, params }) => {
    const search = new URL(request.url).search;
    return proxyToRuntime(request, `/api/projects/${params.id}/experiments${search}`, {
      tenantId,
    });
  },
);

export const POST = withRouteHandler(
  { requireProject: true },
  async ({ request, tenantId, params }) => {
    const body = await request.json();
    return proxyToRuntime(request, `/api/projects/${params.id}/experiments`, {
      tenantId,
      method: 'POST',
      body,
    });
  },
);
