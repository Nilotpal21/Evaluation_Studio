/**
 * POST /api/projects/:id/pii-patterns/test — Test a PII pattern against sample text
 *
 * Proxies to Runtime PII patterns test API.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';
import { StudioPermission } from '@/lib/permissions';

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PII_PATTERN_READ },
  async ({ request, tenantId, params }) => {
    const body = await request.clone().json();
    return proxyToRuntime(request, `/api/projects/${params.id}/pii-patterns/test`, {
      method: 'POST',
      body,
      tenantId,
    });
  },
);
