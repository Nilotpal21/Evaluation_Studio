/**
 * SearchAI Proxy Utilities
 *
 * Proxies Studio API requests to the SearchAI engine and runtime services.
 * Falls back with a clear error when the SearchAI service is unavailable.
 *
 * Service defaults:
 *   - Engine (CRUD): http://localhost:3005 (apps/search-ai)
 *   - Runtime (query): http://localhost:3004 (apps/search-ai-runtime)
 */

import { NextRequest, NextResponse } from 'next/server';

function getSearchEngineUrl(): string {
  return process.env.SEARCH_AI_ENGINE_URL || process.env.SEARCH_AI_URL || 'http://localhost:3005';
}

function getSearchRuntimeUrl(): string {
  return process.env.SEARCH_AI_RUNTIME_URL || 'http://localhost:3004';
}

/**
 * Proxy a request to the SearchAI engine service (indexes, KBs, schemas, mappings).
 * @param path - Engine API path (e.g., `/api/knowledge-bases?projectId=...`)
 */
export async function proxyToSearchEngine(
  request: NextRequest,
  path: string,
  options?: {
    method?: string;
    body?: unknown;
    tenantId?: string;
    projectId?: string;
    userId?: string;
    /** Per-call timeout in ms. Defaults to 30s — raise for LLM-powered endpoints. */
    timeoutMs?: number;
  },
): Promise<NextResponse> {
  return proxyTo(getSearchEngineUrl(), request, path, options, 'SearchAI engine');
}

/**
 * Proxy a request to the SearchAI runtime service (query execution).
 * @param path - Runtime API path (e.g., `/api/search/:indexId/query`)
 */
export async function proxyToSearchRuntime(
  request: NextRequest,
  path: string,
  options?: {
    method?: string;
    body?: unknown;
    tenantId?: string;
    projectId?: string;
    userId?: string;
  },
): Promise<NextResponse> {
  return proxyTo(getSearchRuntimeUrl(), request, path, options, 'SearchAI runtime');
}

const DEFAULT_PROXY_TIMEOUT_MS = 30_000;

async function proxyTo(
  baseUrl: string,
  request: NextRequest,
  path: string,
  options:
    | {
        method?: string;
        body?: unknown;
        tenantId?: string;
        projectId?: string;
        userId?: string;
        timeoutMs?: number;
      }
    | undefined,
  serviceName: string,
): Promise<NextResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;

  if (options?.tenantId) headers['X-Tenant-Id'] = options.tenantId;
  const projectId = options?.projectId ?? request.headers.get('X-Project-Id');
  if (projectId) headers['X-Project-Id'] = projectId;
  const userId = options?.userId ?? request.headers.get('X-User-Id');
  if (userId) headers['X-User-Id'] = userId;

  const method = options?.method || request.method;

  // Timeout — prevent Studio worker from hanging if SearchAI is unresponsive
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const fetchOptions: RequestInit = { method, headers, signal: controller.signal };
  if (options?.body !== undefined) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(`${baseUrl}${path}`, fetchOptions);
    clearTimeout(timeoutId);
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      console.error(
        `[SearchAI Proxy] ${serviceName} returned non-JSON (status ${response.status}):`,
        text.slice(0, 200),
      );
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: `${serviceName} service returned an invalid response.`,
          },
        },
        { status: 503 },
      );
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    clearTimeout(timeoutId);

    // Distinguish timeout from connection failure
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.error(
        `[SearchAI Proxy] ${serviceName} timed out after ${timeoutMs / 1000}s at ${baseUrl}${path}`,
      );
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'GATEWAY_TIMEOUT',
            message: `${serviceName} service did not respond within ${timeoutMs / 1000} seconds.`,
          },
        },
        { status: 504 },
      );
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[SearchAI Proxy] ${serviceName} unreachable at ${baseUrl}${path}:`, message);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: `${serviceName} service is not available. Please ensure it is running.`,
        },
      },
      { status: 503 },
    );
  }
}
