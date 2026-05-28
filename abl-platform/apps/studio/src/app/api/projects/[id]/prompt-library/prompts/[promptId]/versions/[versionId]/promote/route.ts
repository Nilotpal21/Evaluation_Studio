/**
 * POST /api/projects/[id]/prompt-library/prompts/[promptId]/versions/[versionId]/promote
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';
import { StudioPermission } from '@/lib/permissions';

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PROMPT_PROMOTE },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/prompt-library/prompts/${params.promptId}/versions/${params.versionId}/promote`,
      { tenantId },
    );
  },
);
