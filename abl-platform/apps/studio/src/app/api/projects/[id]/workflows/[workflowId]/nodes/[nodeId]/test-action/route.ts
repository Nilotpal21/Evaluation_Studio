/**
 * POST /api/projects/:id/workflows/:workflowId/nodes/:nodeId/test-action
 *
 * Runs the integration node's underlying connector action against the stored
 * connection credentials using the params supplied in the request body, then
 * persists the result on the workflow node as `config.sampleOutput`.
 *
 * Proxies to the Runtime service which forwards to workflow-engine.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const POST = withRouteHandler(
  { requireProject: true, permissions: 'workflow:write' as any },
  async ({ request, tenantId, params }) => {
    // Read the body from the incoming request and forward it — proxyToRuntime
    // only sends a body when `options.body` is explicitly passed. Without this,
    // the params object reaches workflow-engine as `{}` and every required
    // field fails validation.
    let body: unknown = undefined;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/nodes/${params.nodeId}/test-action`,
      { tenantId, body },
    );
  },
);
