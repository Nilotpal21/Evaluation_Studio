/**
 * GET  /api/projects/:id/pii-patterns — List PII patterns
 * POST /api/projects/:id/pii-patterns — Create a PII pattern
 *
 * Proxies to Runtime PII patterns API.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';
import { StudioPermission } from '@/lib/permissions';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PII_PATTERN_READ },
  async ({ request, tenantId, params }) => {
    const search = new URL(request.url).search;
    return proxyToRuntime(request, `/api/projects/${params.id}/pii-patterns${search}`, {
      tenantId,
    });
  },
);

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PII_PATTERN_WRITE },
  async ({ request, tenantId, params }) => {
    const body = await request.clone().json();
    return proxyToRuntime(request, `/api/projects/${params.id}/pii-patterns`, {
      method: 'POST',
      body,
      tenantId,
    });
  },
);
