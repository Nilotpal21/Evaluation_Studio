/**
 * GET /api/projects/:id/human-tasks/:taskId — Get single human task
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const GET = withRouteHandler(
  { requireProject: true, permissions: 'human_task:read' },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(request, `/api/projects/${params.id}/human-tasks/${params.taskId}`, {
      tenantId,
    });
  },
);
