/**
 * POST /api/projects/:id/workflows/triggers/:triggerId/fire — Fire a trigger immediately
 *
 * Proxies to the Runtime service which forwards to workflow-engine. The
 * request body carries the trigger payload (the shape the end user edited
 * in the Fire Now modal or the curl `-d` body) — we must forward it,
 * otherwise workflow-engine's fire route sees an empty object and the
 * workflow runs with no input.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export const POST = withRouteHandler(
  { requireProject: true, permissions: 'workflow:execute' as any },
  async ({ request, tenantId, params }) => {
    // The Fire Now modal / curl may POST with an empty body (cron triggers
    // fire without a payload). Treat that as `{}` rather than propagating a
    // `{ body: undefined }` option down to the fetch, which would still drop
    // the Content-Type header on the proxied request.
    let body: Record<string, unknown> = {};
    try {
      const text = await request.clone().text();
      if (text.length > 0) {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      }
    } catch {
      // Malformed body — workflow-engine's Zod schema will reject it with a
      // clear 400, no need to duplicate validation here.
    }

    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/triggers/${params.triggerId}/fire`,
      {
        method: 'POST',
        body,
        tenantId,
      },
    );
  },
);
