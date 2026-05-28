/**
 * GET /api/projects/:id/human-tasks — List human tasks
 *
 * Proxies to Runtime human-tasks API with filter query params.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const GET = withRouteHandler(
  { requireProject: true, permissions: 'human_task:read' },
  async ({ request, tenantId, params }) => {
    const search = new URL(request.url).search;
    return proxyToRuntime(request, `/api/projects/${params.id}/human-tasks${search}`, {
      tenantId,
    });
  },
);
