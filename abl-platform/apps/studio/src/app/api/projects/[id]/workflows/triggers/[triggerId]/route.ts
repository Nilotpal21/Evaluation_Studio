/**
 * DELETE /api/projects/:id/workflows/triggers/:triggerId — Delete a trigger
 * PUT /api/projects/:id/workflows/triggers/:triggerId — Update a trigger
 *
 * Proxies to the Runtime service which forwards to workflow-engine.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { proxyToRuntime } from '@/lib/runtime-proxy';
import { z } from 'zod';

const updateTriggerBodySchema = z
  .object({
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

export const DELETE = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.WORKFLOW_WRITE },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/triggers/${params.triggerId}`,
      {
        method: 'DELETE',
        tenantId,
      },
    );
  },
);

export const PUT = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.WORKFLOW_WRITE,
    bodySchema: updateTriggerBodySchema,
  },
  async ({ request, tenantId, params, body }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/triggers/${params.triggerId}`,
      {
        method: 'PUT',
        body,
        tenantId,
      },
    );
  },
);
