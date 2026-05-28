/**
 * GET /api/projects/:id/workflows/triggers — List workflow triggers
 * POST /api/projects/:id/workflows/triggers — Create a workflow trigger
 *
 * Proxies to the Runtime service which forwards to workflow-engine.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

// ─── GET (List Triggers) ──────────────────────────────────────────────

export const GET = withRouteHandler(
  { requireProject: true, permissions: 'workflow:read' as any },
  async ({ request, tenantId, params }) => {
    const search = new URL(request.url).search;
    return proxyToRuntime(request, `/api/projects/${params.id}/workflows/triggers${search}`, {
      tenantId,
    });
  },
);

// ─── POST (Create Trigger) ────────────────────────────────────────────

export const POST = withRouteHandler(
  { requireProject: true, permissions: 'workflow:write' as any },
  async ({ request, tenantId, params }) => {
    const body = await request.clone().json();
    return proxyToRuntime(request, `/api/projects/${params.id}/workflows/triggers`, {
      method: 'POST',
      body,
      tenantId,
    });
  },
);
