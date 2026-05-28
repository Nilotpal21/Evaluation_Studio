/**
 * POST /api/projects/:id/workflows/:workflowId/execute — Execute a workflow
 *
 * Proxies to runtime, which forwards execution to workflow-engine.
 *
 * Uses `?mode=async` so the runtime returns the executionId immediately
 * (202) instead of blocking up to 30 s for sync completion. The Studio
 * debug panel polls execution status independently, so a sync wait only
 * adds latency and risks a timeout race (Studio proxy 30 s vs runtime
 * sync-wait 30 s) that surfaces as a 500 INTERNAL_ERROR.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const POST = withRouteHandler(
  { requireProject: true, permissions: 'workflow:execute' as any },
  async ({ request, tenantId, params }) => {
    // Studio's Run button may POST with no body — tolerate it.
    let body: unknown = {};
    try {
      const text = await request.clone().text();
      body = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/executions/execute?mode=async`,
      {
        method: 'POST',
        body,
        tenantId,
      },
    );
  },
);
