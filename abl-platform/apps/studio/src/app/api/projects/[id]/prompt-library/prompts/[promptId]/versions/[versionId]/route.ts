/**
 * GET   /api/projects/[id]/prompt-library/prompts/[promptId]/versions/[versionId] — Get version
 * PATCH /api/projects/[id]/prompt-library/prompts/[promptId]/versions/[versionId] — Update version
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';
import { StudioPermission } from '@/lib/permissions';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PROMPT_READ },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/prompt-library/prompts/${params.promptId}/versions/${params.versionId}`,
      { tenantId },
    );
  },
);

export const PATCH = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PROMPT_UPDATE },
  async ({ request, tenantId, params }) => {
    const body = await request.json();
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/prompt-library/prompts/${params.promptId}/versions/${params.versionId}`,
      { tenantId, body, method: 'PATCH' },
    );
  },
);
