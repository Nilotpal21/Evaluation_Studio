/**
 * GET  /api/projects/:id/external-agents — List external agent configs
 * POST /api/projects/:id/external-agents — Create external agent config
 *
 * Proxies to Runtime external-agents API.
 */

import { StudioPermission } from '@/lib/permissions';
import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.EXTERNAL_AGENT_READ },
  async ({ request, tenantId, params }) => {
    const search = new URL(request.url).search;
    return proxyToRuntime(request, `/api/projects/${params.id}/external-agents${search}`, {
      tenantId,
    });
  },
);

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.EXTERNAL_AGENT_CREATE },
  async ({ request, tenantId, params }) => {
    const body = await request.json();
    return proxyToRuntime(request, `/api/projects/${params.id}/external-agents`, {
      tenantId,
      method: 'POST',
      body,
    });
  },
);
