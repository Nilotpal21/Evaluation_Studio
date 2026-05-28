/**
 * GET /api/projects/[id]/prompt-library/prompts/[promptId]/references
 * Returns agent versions that reference this prompt library item.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';
import { StudioPermission } from '@/lib/permissions';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PROMPT_READ },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/prompt-library/prompts/${params.promptId}/references`,
      { tenantId },
    );
  },
);
