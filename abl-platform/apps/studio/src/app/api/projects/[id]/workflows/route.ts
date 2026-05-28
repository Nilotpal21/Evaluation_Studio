/**
 * GET  /api/projects/:id/workflows — List workflows in project
 * POST /api/projects/:id/workflows — Create a new workflow
 *
 * Proxies to the runtime service (workflow CRUD lives in runtime, not workflow-engine).
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

// ─── GET (List) ─────────────────────────────────────────────────────────

export const GET = withRouteHandler(
  { requireProject: true, permissions: 'workflow:read' as any },
  async ({ request, tenantId, params }) => {
    const search = new URL(request.url).search;
    return proxyToRuntime(request, `/api/projects/${params.id}/workflows${search}`, { tenantId });
  },
);

// ─── POST (Create) ──────────────────────────────────────────────────────

export const POST = withRouteHandler(
  { requireProject: true, permissions: 'workflow:create' as any },
  async ({ request, tenantId, params }) => {
    const body = await request.clone().json();
    return proxyToRuntime(request, `/api/projects/${params.id}/workflows`, {
      method: 'POST',
      body,
      tenantId,
    });
  },
);
