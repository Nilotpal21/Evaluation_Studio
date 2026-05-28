/**
 * Workflow Engine Proxy Utilities
 *
 * Proxies Studio API requests to the workflow-engine backend service.
 *
 * Default: http://localhost:9080
 * Env var: WORKFLOW_ENGINE_URL
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';

const logger = createLogger('workflow-engine-proxy');

/** Default when no env var is set — matches workflow-engine default port */
const DEFAULT_WORKFLOW_ENGINE_URL = 'http://localhost:9080';

/**
 * Workflow-engine base URL from environment.
 * Server-side only (no NEXT_PUBLIC_ variant needed since this is never called from the browser).
 */
export function getWorkflowEngineUrl(): string {
  return process.env.WORKFLOW_ENGINE_URL ?? DEFAULT_WORKFLOW_ENGINE_URL;
}

/**
 * Build standard proxy headers for a request to the workflow-engine.
 * Forwards Authorization and sets X-Tenant-Id.
 */
function buildProxyHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  headers['X-Tenant-Id'] = tenantId;
  return headers;
}

/**
 * Proxy a request to the workflow-engine service.
 *
 * @param request - Incoming Next.js request
 * @param path - Workflow-engine API path (e.g., `/api/v1/projects/${projectId}/connections`)
 * @param options - Method, body, and tenantId
 * @returns NextResponse with the workflow-engine response data and status
 */
export async function proxyToWorkflowEngine(
  request: NextRequest,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    tenantId: string;
  },
): Promise<NextResponse> {
  const headers = buildProxyHeaders(request, options.tenantId);
  const method = options.method || request.method;

  const fetchOptions: RequestInit = { method, headers };
  if (options.body !== undefined) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const baseUrl = getWorkflowEngineUrl();

  const proxyController = new AbortController();
  const proxyTimer = setTimeout(() => proxyController.abort(), 30_000);
  fetchOptions.signal = proxyController.signal;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, fetchOptions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === 'AbortError') {
      logger.error(`Proxy request timed out after 30s: ${baseUrl}${path}`);
      return NextResponse.json(
        {
          success: false,
          error: { code: 'GATEWAY_TIMEOUT', message: 'Workflow engine request timed out' },
        },
        { status: 504 },
      );
    }
    logger.error(`Service unreachable at ${baseUrl}${path}: ${message}`);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Workflow engine service is not available',
        },
      },
      { status: 503 },
    );
  } finally {
    clearTimeout(proxyTimer);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    logger.error(
      `Non-JSON response from ${baseUrl}${path} (${response.status}): ${text.slice(0, 200)}`,
    );
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'BAD_GATEWAY',
          message: `Workflow engine returned non-JSON response (HTTP ${response.status})`,
        },
      },
      { status: 502 },
    );
  }

  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
