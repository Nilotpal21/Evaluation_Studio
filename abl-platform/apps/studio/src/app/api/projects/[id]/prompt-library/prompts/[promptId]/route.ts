/**
 * GET    /api/projects/[id]/prompt-library/prompts/[promptId] — Get prompt
 * PATCH  /api/projects/[id]/prompt-library/prompts/[promptId] — Update prompt
 * DELETE /api/projects/[id]/prompt-library/prompts/[promptId] — Delete prompt
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';
import { StudioPermission } from '@/lib/permissions';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PROMPT_READ },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/prompt-library/prompts/${params.promptId}`,
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
      `/api/projects/${params.id}/prompt-library/prompts/${params.promptId}`,
      { tenantId, body, method: 'PATCH' },
    );
  },
);

export const DELETE = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PROMPT_DELETE },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/prompt-library/prompts/${params.promptId}`,
      { tenantId, method: 'DELETE' },
    );
  },
);
