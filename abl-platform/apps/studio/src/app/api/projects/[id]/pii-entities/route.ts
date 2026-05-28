/**
 * GET /api/projects/:id/pii-entities — List enabled PII entity types for a project
 *
 * Proxies to Runtime PII entities catalog (ABLP-723).
 * Populates the entity selector in the Guardrails → Sensitive Data Block preset.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';
import { StudioPermission } from '@/lib/permissions';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PII_PATTERN_READ },
  async ({ request, tenantId, params }) => {
    const search = new URL(request.url).search;
    return proxyToRuntime(request, `/api/projects/${params.id}/pii-entities${search}`, {
      tenantId,
    });
  },
);
