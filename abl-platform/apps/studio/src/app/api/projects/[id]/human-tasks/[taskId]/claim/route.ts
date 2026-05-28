/**
 * POST /api/projects/:id/human-tasks/:taskId/claim — Claim task
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const POST = withRouteHandler(
  { requireProject: true, permissions: 'human_task:claim' },
  async ({ request, tenantId, params }) => {
    const body = await request.clone().json();
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/human-tasks/${params.taskId}/claim`,
      { method: 'POST', body, tenantId },
    );
  },
);
