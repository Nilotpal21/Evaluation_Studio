/**
 * POST /api/projects/:id/connections/:connectionId/test — Test a connection
 *
 * Direct MongoDB access via shared ConnectionService (no WE proxy).
 *
 * For auth.type='none' connectors (Docling, …) the shared ConnectionService.test()
 * short-circuits to a hollow success — there are no credentials to validate.
 * To give the user a meaningful signal, this route layers a per-connector
 * reachability probe that actually pings the runtime service:
 *
 *   docling → search-ai `/health/docling`, which round-trips to the Docling
 *             FastAPI service at $DOCLING_SERVICE_URL.
 *
 * Failure here flips the connection status back to `expired` so the UI badge
 * stays honest.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { getConnectionService } from '@/lib/connection-service';
import { ConnectionServiceError } from '@agent-platform/connectors/services';
import { StudioPermission } from '@/lib/permissions';

const REACHABILITY_PROBE_TIMEOUT_MS = 7000;

function getSearchEngineUrl(): string {
  return process.env.SEARCH_AI_ENGINE_URL || process.env.SEARCH_AI_URL || 'http://localhost:3005';
}

interface ReachabilityResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  /** Optional upstream error code from search-ai's /health/docling body. */
  code?: string;
}

async function probeDoclingReachability(): Promise<ReachabilityResult> {
  const url = `${getSearchEngineUrl()}/health/docling`;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REACHABILITY_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      // Pull the search-ai health route's body — it returns
      // `{ status, error, suggestion }` for unreachable + `{ error, code }`
      // for 5xx, both of which carry the upstream Docling message we want
      // to surface verbatim.
      let detail = '';
      let upstreamCode: string | undefined;
      try {
        const body = (await res.json()) as {
          error?: string;
          suggestion?: string;
          code?: string;
          status?: string;
        };
        detail = body.error || body.suggestion || '';
        upstreamCode = body.code;
      } catch {
        // Body wasn't JSON — fall back to a status-only hint.
        detail = `HTTP ${res.status}`;
      }
      // Classify by status code so the UI / log can render targeted hints.
      const summary =
        res.status === 503
          ? `Docling service reachable but unhealthy (HTTP 503). The container is up; the model engine may still be loading.`
          : res.status === 404
            ? `Docling service responded with HTTP 404. Search-AI host is up but /health/docling is not registered — check search-ai version.`
            : res.status >= 500
              ? `Search-AI returned HTTP ${res.status} for /health/docling. Likely transient; retry.`
              : `Docling service health check returned HTTP ${res.status}.`;
      return {
        ok: false,
        latencyMs,
        error: detail ? `${summary} — ${detail}` : summary,
        ...(upstreamCode ? { code: upstreamCode } : {}),
      };
    }
    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        ok: false,
        latencyMs,
        error: `Docling reachability probe timed out after ${REACHABILITY_PROBE_TIMEOUT_MS / 1000}s — search-ai or the Docling container is unresponsive.`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
      return {
        ok: false,
        latencyMs,
        error: `Could not resolve the search-ai host (${message}). Check SEARCH_AI_ENGINE_URL.`,
      };
    }
    if (/ECONNREFUSED/.test(message)) {
      return {
        ok: false,
        latencyMs,
        error: `Search-ai refused the connection (${message}). The host is up but the port isn't listening — is search-ai running?`,
      };
    }
    if (/ECONNRESET|EPIPE/.test(message)) {
      return {
        ok: false,
        latencyMs,
        error: `Connection to search-ai was reset mid-probe (${message}). Likely transient; retry.`,
      };
    }
    return { ok: false, latencyMs, error: `Docling reachability probe failed: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_WRITE },
  async ({ tenantId, params }) => {
    const svc = await getConnectionService();

    try {
      const connection = await svc.getById(tenantId, params.id, params.connectionId);
      if (!connection) {
        return NextResponse.json(
          { success: false, error: 'Connection not found' },
          { status: 404 },
        );
      }

      // For auth.type='none' connectors with a known reachability probe, run the
      // probe in place of the hollow ConnectionService.test() success. Status
      // tracks the actual reachability so the UI badge is honest.
      const isNoAuth =
        (connection.metadata as { authType?: unknown } | null | undefined)?.authType === 'none';
      if (isNoAuth && connection.connectorName === 'docling') {
        const probe = await probeDoclingReachability();
        await svc.update(tenantId, params.id, params.connectionId, {
          status: probe.ok ? 'active' : 'expired',
        });
        if (!probe.ok) {
          return NextResponse.json(
            { success: false, error: probe.error || 'Docling service unreachable' },
            { status: 422 },
          );
        }
        return NextResponse.json({ success: true, data: probe });
      }

      const result = await svc.test(tenantId, params.id, params.connectionId);
      if (!result.success) {
        return NextResponse.json(
          { success: false, error: result.error || 'Connection test failed' },
          { status: 422 },
        );
      }
      return NextResponse.json({ success: true, data: result });
    } catch (err) {
      if (err instanceof ConnectionServiceError && err.code === 'NOT_FOUND') {
        return NextResponse.json(
          { success: false, error: 'Connection not found' },
          { status: 404 },
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { success: false, error: `Connection test failed: ${message}` },
        { status: 502 },
      );
    }
  },
);
