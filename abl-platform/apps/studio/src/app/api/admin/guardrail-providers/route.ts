/**
 * GET/POST/PUT/DELETE /api/admin/guardrail-providers
 *
 * Proxy to runtime /api/tenants/:tenantId/guardrail-providers
 * with auth headers and tenant context.
 *
 * Includes field mapping between Studio's UI-friendly schema and the
 * runtime's DB schema (e.g. type→adapterType, cloud→cloud_api).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError, requireAdminRole } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { IMPLEMENTED_GUARDRAIL_ADAPTER_TYPES } from '@agent-platform/database/constants/guardrail-adapters';

const log = createLogger('admin-guardrail-providers');

// =============================================================================
// SCHEMA TRANSFORMS
// =============================================================================

const HOSTING_TO_RUNTIME: Record<string, string> = {
  cloud_api: 'cloud_api',
  self_hosted: 'self_hosted',
  managed_service: 'managed_service',
  // Legacy: support old 'cloud' value from cached clients
  cloud: 'cloud_api',
};

const HOSTING_TO_STUDIO: Record<string, string> = {
  cloud_api: 'cloud_api',
  self_hosted: 'self_hosted',
  managed_service: 'managed_service',
};

/**
 * Transform a Studio request body to the runtime DB schema.
 *
 * Field mappings:
 *   type → adapterType
 *   hosting: cloud → cloud_api
 *   circuitBreaker.maxFailures → circuitBreaker.failureThreshold
 *   circuitBreaker.resetTimeout → circuitBreaker.resetTimeoutMs
 *   retry.backoff → retry.backoffBaseMs (numeric ms when numeric, default 1000 when strategy string)
 *   enabled → isActive
 */
function toRuntimeFormat(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };

  // Client now sends adapterType directly — keep legacy 'type' support
  if ('type' in out && !('adapterType' in out)) {
    out.adapterType = out.type;
    delete out.type;
  }

  // hosting enum mapping
  if (typeof out.hosting === 'string' && out.hosting in HOSTING_TO_RUNTIME) {
    out.hosting = HOSTING_TO_RUNTIME[out.hosting];
  }

  // circuitBreaker field renames
  if (out.circuitBreaker && typeof out.circuitBreaker === 'object') {
    const cb = { ...(out.circuitBreaker as Record<string, unknown>) };
    if ('maxFailures' in cb && !('failureThreshold' in cb)) {
      cb.failureThreshold = cb.maxFailures;
      delete cb.maxFailures;
    }
    if ('resetTimeout' in cb && !('resetTimeoutMs' in cb)) {
      cb.resetTimeoutMs = cb.resetTimeout;
      delete cb.resetTimeout;
    }
    out.circuitBreaker = cb;
  }

  // retry field renames — DB schema expects backoffBaseMs (number), not backoff
  if (out.retry && typeof out.retry === 'object') {
    const r = { ...(out.retry as Record<string, unknown>) };
    if ('backoff' in r && !('backoffBaseMs' in r)) {
      if (typeof r.backoff === 'number') {
        // Legacy clients sent backoff as ms number — use directly
        r.backoffBaseMs = r.backoff;
      } else if (typeof r.backoff === 'string') {
        // Form sends strategy name ('fixed'/'exponential') — map to default ms
        r.backoffBaseMs = 1000;
      }
      delete r.backoff;
    }
    out.retry = r;
  }

  // enabled → isActive
  if ('enabled' in out && !('isActive' in out)) {
    out.isActive = out.enabled;
    delete out.enabled;
  }

  return out;
}

/**
 * Transform a runtime DB response to Studio's canonical client schema.
 *
 * New Studio surfaces use the runtime DB shape. Legacy response fields are
 * normalized forward, not reintroduced.
 */
function toStudioFormat(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };

  // Keep _id and adapterType as-is — client types now match DB schema

  // hosting enum mapping
  if (typeof out.hosting === 'string' && out.hosting in HOSTING_TO_STUDIO) {
    out.hosting = HOSTING_TO_STUDIO[out.hosting];
  }

  // circuitBreaker legacy field normalization
  if (out.circuitBreaker && typeof out.circuitBreaker === 'object') {
    const cb = { ...(out.circuitBreaker as Record<string, unknown>) };
    if ('maxFailures' in cb && !('failureThreshold' in cb)) {
      cb.failureThreshold = cb.maxFailures;
    }
    if ('resetTimeout' in cb && !('resetTimeoutMs' in cb)) {
      cb.resetTimeoutMs = cb.resetTimeout;
    }
    delete cb.maxFailures;
    delete cb.resetTimeout;
    out.circuitBreaker = cb;
  }

  // retry legacy field normalization
  if (out.retry && typeof out.retry === 'object') {
    const r = { ...(out.retry as Record<string, unknown>) };
    if ('backoff' in r && !('backoffBaseMs' in r)) {
      r.backoffBaseMs = typeof r.backoff === 'number' ? r.backoff : 1000;
    }
    delete r.backoff;
    out.retry = r;
  }

  // Keep isActive as-is — client types now match DB schema

  out.apiKeyConfigured = Boolean(out.apiKeyCredentialId || out.authProfileId);

  return out;
}

/**
 * Transform response data — handles both single objects and arrays in { data: ... }.
 */
function transformResponse(json: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(json.data)) {
    return {
      ...json,
      data: json.data.map((item: Record<string, unknown>) => toStudioFormat(item)),
    };
  }
  if (json.data && typeof json.data === 'object' && !Array.isArray(json.data)) {
    return { ...json, data: toStudioFormat(json.data as Record<string, unknown>) };
  }
  return json;
}

// =============================================================================
// HELPERS
// =============================================================================

function buildHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  headers['X-Tenant-Id'] = tenantId;
  return headers;
}

/** Adapter types that have a working runtime implementation */
const IMPLEMENTED_ADAPTER_TYPES: Set<string> = new Set(IMPLEMENTED_GUARDRAIL_ADAPTER_TYPES);

const ALLOWED_ACTIONS = new Set(['test']);

function rawApiKeyErrorResponse(): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Raw apiKey is not supported for guardrail providers; use authProfileId instead',
      },
    },
    { status: 400 },
  );
}

function hasRawApiKey(body: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(body, 'apiKey');
}

function buildUrl(tenantId: string, request: NextRequest): string {
  const providerId = request.nextUrl.searchParams.get('providerId');
  const action = request.nextUrl.searchParams.get('action');
  if (action && !ALLOWED_ACTIONS.has(action)) {
    throw new Error(`Invalid action: ${action}`);
  }
  const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
  forwardParams.delete('providerId');
  forwardParams.delete('action');
  const qs = forwardParams.toString();
  const queryString = qs ? `?${qs}` : '';
  const idPath = providerId ? `/${encodeURIComponent(providerId)}` : '';
  const actionPath = action ? `/${encodeURIComponent(action)}` : '';
  return `${getRuntimeUrl()}/api/tenants/${encodeURIComponent(tenantId)}/guardrail-providers${idPath}${actionPath}${queryString}`;
}

// =============================================================================
// ROUTES
// =============================================================================

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  try {
    const url = buildUrl(user.tenantId, request);
    const response = await fetch(url, {
      headers: buildHeaders(request, user.tenantId),
    });
    const data = await response.json();
    return NextResponse.json(transformResponse(data), { status: response.status });
  } catch (error) {
    log.error('Proxy GET failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  try {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    // If this is a test action with empty body, inject default test text
    const action = request.nextUrl.searchParams.get('action');
    if (action === 'test' && Object.keys(body).length === 0) {
      body = { text: 'Test message for guardrail evaluation' };
    }

    // Reject unimplemented adapter types early (before proxying to runtime)
    if (!action) {
      if (hasRawApiKey(body)) {
        return rawApiKeyErrorResponse();
      }
      const runtimeBody = toRuntimeFormat(body);
      const adapterType = runtimeBody.adapterType as string | undefined;
      if (adapterType && !IMPLEMENTED_ADAPTER_TYPES.has(adapterType)) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'ADAPTER_NOT_IMPLEMENTED',
              message: `Provider type "${adapterType}" is not yet available. Supported: ${[...IMPLEMENTED_ADAPTER_TYPES].join(', ')}`,
            },
          },
          { status: 400 },
        );
      }
    }

    const url = buildUrl(user.tenantId, request);
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(request, user.tenantId),
      body: JSON.stringify(action ? body : toRuntimeFormat(body)),
    });
    const data = await response.json();
    return NextResponse.json(action ? data : transformResponse(data), {
      status: response.status,
    });
  } catch (error) {
    log.error('Proxy POST failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 502 });
  }
}

export async function PUT(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  try {
    const body = await request.json();

    // Reject unimplemented adapter types early (before proxying to runtime)
    if (hasRawApiKey(body)) {
      return rawApiKeyErrorResponse();
    }
    const runtimeBody = toRuntimeFormat(body);
    const adapterType = runtimeBody.adapterType as string | undefined;
    if (adapterType && !IMPLEMENTED_ADAPTER_TYPES.has(adapterType)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'ADAPTER_NOT_IMPLEMENTED',
            message: `Provider type "${adapterType}" is not yet available. Supported: ${[...IMPLEMENTED_ADAPTER_TYPES].join(', ')}`,
          },
        },
        { status: 400 },
      );
    }

    const url = buildUrl(user.tenantId, request);
    const response = await fetch(url, {
      method: 'PUT',
      headers: buildHeaders(request, user.tenantId),
      body: JSON.stringify(runtimeBody),
    });
    const data = await response.json();
    return NextResponse.json(transformResponse(data), { status: response.status });
  } catch (error) {
    log.error('Proxy PUT failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  try {
    const url = buildUrl(user.tenantId, request);
    const response = await fetch(url, {
      method: 'DELETE',
      headers: buildHeaders(request, user.tenantId),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    log.error('Proxy DELETE failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 502 });
  }
}
