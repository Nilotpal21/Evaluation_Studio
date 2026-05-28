/**
 * POST /api/projects/:id/human-tasks/:taskId/resolve — Resolve task
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const POST = withRouteHandler(
  { requireProject: true, permissions: 'human_task:resolve' },
  async ({ request, tenantId, params }) => {
    const body = await request.clone().json();
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/human-tasks/${params.taskId}/resolve`,
      { method: 'POST', body, tenantId },
    );
  },
);
