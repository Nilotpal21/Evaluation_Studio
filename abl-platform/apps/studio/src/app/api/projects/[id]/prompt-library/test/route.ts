/**
 * POST /api/projects/[id]/prompt-library/test
 * Proxies to runtime prompt library test endpoint (LLM calls; extended timeout).
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';
import { StudioPermission } from '@/lib/permissions';

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PROMPT_TEST },
  async ({ request, tenantId, params }) => {
    const body = await request.json();
    return proxyToRuntime(request, `/api/projects/${params.id}/prompt-library/test`, {
      tenantId,
      body,
      timeoutMs: 65_000,
    });
  },
);
