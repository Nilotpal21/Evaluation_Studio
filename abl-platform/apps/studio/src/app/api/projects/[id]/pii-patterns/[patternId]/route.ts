/**
 * GET    /api/projects/:id/pii-patterns/:patternId — Get single PII pattern
 * PUT    /api/projects/:id/pii-patterns/:patternId — Update PII pattern
 * DELETE /api/projects/:id/pii-patterns/:patternId — Delete PII pattern
 *
 * Proxies to Runtime PII patterns API.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';
import { StudioPermission } from '@/lib/permissions';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PII_PATTERN_READ },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(request, `/api/projects/${params.id}/pii-patterns/${params.patternId}`, {
      tenantId,
    });
  },
);

export const PUT = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PII_PATTERN_WRITE },
  async ({ request, tenantId, params }) => {
    const body = await request.clone().json();
    return proxyToRuntime(request, `/api/projects/${params.id}/pii-patterns/${params.patternId}`, {
      method: 'PUT',
      body,
      tenantId,
    });
  },
);

export const DELETE = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PII_PATTERN_WRITE },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(request, `/api/projects/${params.id}/pii-patterns/${params.patternId}`, {
      method: 'DELETE',
      tenantId,
    });
  },
);
