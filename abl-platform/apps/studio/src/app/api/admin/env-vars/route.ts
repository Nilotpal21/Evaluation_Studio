/**
 * GET/POST/PUT/DELETE /api/admin/env-vars — Proxy to runtime env vars API
 *
 * Forwards requests to /api/projects/:projectId/env-vars
 * with auth headers and tenant context. Project ID from query param.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError, requireAdminRole } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('admin-env-vars');

function buildHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  headers['X-Tenant-Id'] = tenantId;
  return headers;
}

function buildUrl(projectId: string, request: NextRequest): string {
  const envVarId = request.nextUrl.searchParams.get('envVarId');
  const action = request.nextUrl.searchParams.get('action');
  const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
  forwardParams.delete('projectId');
  forwardParams.delete('envVarId');
  forwardParams.delete('action');
  const qs = forwardParams.toString();
  const queryString = qs ? `?${qs}` : '';

  // Action sub-paths (copy, validate) take priority over envVarId
  if (action) {
    return `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/env-vars/${encodeURIComponent(action)}${queryString}`;
  }
  const idPath = envVarId ? `/${encodeURIComponent(envVarId)}` : '';
  return `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/env-vars${idPath}${queryString}`;
}

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json(
      { success: false, error: 'projectId query parameter is required' },
      { status: 400 },
    );
  }

  const environment = request.nextUrl.searchParams.get('environment');

  try {
    if (environment) {
      // Single environment — pass through as before
      const url = buildUrl(projectId, request);
      const response = await fetch(url, {
        headers: buildHeaders(request, user.tenantId),
      });
      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    }

    // No environment specified — aggregate across all environments for the admin UI.
    // The runtime API requires environment, so we query each and merge by key.
    const environments = ['dev', 'staging', 'production'];
    const headers = buildHeaders(request, user.tenantId);
    const baseUrl = `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/env-vars`;

    const results = await Promise.all(
      environments.map(async (env) => {
        try {
          const resp = await fetch(`${baseUrl}?environment=${env}&limit=100`, { headers });
          if (!resp.ok) return [];
          const json = await resp.json();
          return (json.variables ?? []).map((v: any) => ({ ...v, environment: env }));
        } catch {
          return [];
        }
      }),
    );

    // Merge: group by key, collect environments per key
    const byKey = new Map<string, any>();
    for (const vars of results) {
      for (const v of vars) {
        const existing = byKey.get(v.key);
        if (existing) {
          existing.environments.push(v.environment);
          // Use the most recent updatedAt
          if (v.updatedAt > existing.updatedAt) {
            existing.updatedAt = v.updatedAt;
          }
        } else {
          byKey.set(v.key, {
            id: v.id,
            key: v.key,
            environments: [v.environment],
            encrypted: v.isSecret ?? false,
            description: v.description ?? '',
            updatedAt: v.updatedAt ?? v.createdAt,
            createdAt: v.createdAt,
          });
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: Array.from(byKey.values()).sort((a: any, b: any) => a.key.localeCompare(b.key)),
    });
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

  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json(
      { success: false, error: 'projectId query parameter is required' },
      { status: 400 },
    );
  }

  try {
    const body = await request.json();
    const action = request.nextUrl.searchParams.get('action');

    // Action sub-paths (copy, validate) pass through directly
    if (action) {
      const url = buildUrl(projectId, request);
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(request, user.tenantId),
        body: JSON.stringify(body),
      });
      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    }

    // Bulk import: each pair gets created for all default environments
    if (body.bulk && Array.isArray(body.bulk)) {
      const pairs: Array<{ key: string; value: string }> = body.bulk;
      const environments = ['dev', 'staging', 'production'];
      const headers = buildHeaders(request, user.tenantId);
      const baseUrl = `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/env-vars`;
      let created = 0;
      let errors = 0;

      for (const pair of pairs) {
        for (const env of environments) {
          try {
            const resp = await fetch(baseUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                environment: env,
                key: pair.key,
                value: pair.value,
                isSecret: false,
              }),
            });
            if (resp.ok) created++;
            else errors++;
          } catch {
            errors++;
          }
        }
      }

      return NextResponse.json({ success: true, created, errors });
    }

    // Single create: the admin UI sends { key, value, environments, encrypted, description }
    // The runtime expects { environment, key, value, isSecret, description } per environment.
    const { key, value, environments, encrypted, description } = body;

    if (environments && Array.isArray(environments) && environments.length > 0) {
      const headers = buildHeaders(request, user.tenantId);
      const baseUrl = `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/env-vars`;
      const results: any[] = [];
      const errors: string[] = [];

      for (const env of environments) {
        const resp = await fetch(baseUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            environment: env,
            key,
            value,
            isSecret: encrypted ?? false,
            description,
          }),
        });
        const data = await resp.json();
        if (resp.ok) {
          results.push(data);
        } else {
          // Skip duplicate errors (variable may already exist for this env)
          if (resp.status !== 409) {
            errors.push(data.error || `Failed for ${env}`);
          }
        }
      }

      if (results.length === 0 && errors.length > 0) {
        return NextResponse.json({ success: false, error: errors.join('; ') }, { status: 400 });
      }

      return NextResponse.json({ success: true, created: results.length }, { status: 201 });
    }

    // Fallback: if body already has `environment` (single), pass through
    const url = buildUrl(projectId, request);
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(request, user.tenantId),
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
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

  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json(
      { success: false, error: 'projectId query parameter is required' },
      { status: 400 },
    );
  }

  const envVarId = request.nextUrl.searchParams.get('envVarId');

  try {
    const body = await request.json();

    // If the admin UI sends { value, environments, encrypted, description },
    // we need to update the variable in the runtime. The envVarId is the ID
    // of one environment's variable. We update that one.
    if (envVarId) {
      const headers = buildHeaders(request, user.tenantId);
      const url = `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/env-vars/${encodeURIComponent(envVarId)}`;
      const runtimeBody: Record<string, unknown> = {};
      if (body.value !== undefined) runtimeBody.value = body.value;
      if (body.description !== undefined) runtimeBody.description = body.description;
      if (body.encrypted !== undefined) runtimeBody.isSecret = body.encrypted;

      const response = await fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify(runtimeBody),
      });
      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    }

    // Fallback pass-through
    const url = buildUrl(projectId, request);
    const response = await fetch(url, {
      method: 'PUT',
      headers: buildHeaders(request, user.tenantId),
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
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

  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json(
      { success: false, error: 'projectId query parameter is required' },
      { status: 400 },
    );
  }

  try {
    const url = buildUrl(projectId, request);
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
