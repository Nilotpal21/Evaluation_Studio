/**
 * GET  /api/projects/[id]/prompt-library/prompts/[promptId]/versions — List versions
 * POST /api/projects/[id]/prompt-library/prompts/[promptId]/versions — Create version
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';
import { StudioPermission } from '@/lib/permissions';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PROMPT_READ },
  async ({ request, tenantId, params }) => {
    const search = new URL(request.url).search;
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/prompt-library/prompts/${params.promptId}/versions${search}`,
      { tenantId },
    );
  },
);

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PROMPT_CREATE },
  async ({ request, tenantId, params }) => {
    const body = await request.json();
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/prompt-library/prompts/${params.promptId}/versions`,
      { tenantId, body },
    );
  },
);
