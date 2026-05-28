/**
 * GET    /api/projects/:id/workflows/:workflowId — Get workflow detail
 * PATCH  /api/projects/:id/workflows/:workflowId — Update workflow
 * DELETE /api/projects/:id/workflows/:workflowId — Delete workflow
 *
 * Proxies to the runtime service (workflow CRUD lives in runtime, not workflow-engine).
 * Note: runtime uses PUT for updates and DELETE for soft-delete.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

// ─── GET (Detail) ───────────────────────────────────────────────────────

export const GET = withRouteHandler(
  { requireProject: true, permissions: 'workflow:read' as any },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(request, `/api/projects/${params.id}/workflows/${params.workflowId}`, {
      tenantId,
    });
  },
);

// ─── PATCH (Update) ─────────────────────────────────────────────────────
// Studio sends PATCH but the runtime workflow route uses PUT — translate.

export const PATCH = withRouteHandler(
  { requireProject: true, permissions: 'workflow:update' as any },
  async ({ request, tenantId, params }) => {
    const body = await request.clone().json();
    return proxyToRuntime(request, `/api/projects/${params.id}/workflows/${params.workflowId}`, {
      method: 'PUT',
      body,
      tenantId,
    });
  },
);

// ─── DELETE (Soft-delete) ────────────────────────────────────────────────

export const DELETE = withRouteHandler(
  { requireProject: true, permissions: 'workflow:delete' as any },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(request, `/api/projects/${params.id}/workflows/${params.workflowId}`, {
      method: 'DELETE',
      tenantId,
    });
  },
);
