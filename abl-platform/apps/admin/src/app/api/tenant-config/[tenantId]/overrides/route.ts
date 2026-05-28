import { NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../../../lib/with-admin-route';
import { getRuntimeBaseUrl, buildRuntimeHeaders } from '../../../../../lib/runtime-proxy';
import {
  deleteTenantConfigOverridesSchema,
  tenantConfigOverridesSchema,
} from '../../../../../lib/admin-proxy-schemas';
import {
  readOptionalValidatedJsonBody,
  readValidatedJsonBody,
} from '../../../../../lib/validated-json-body';

export const PUT = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const { tenantId } = ctx.params;
  const parsedBody = await readValidatedJsonBody(ctx.request, tenantConfigOverridesSchema);
  if (!parsedBody.success) {
    return parsedBody.response;
  }

  try {
    const res = await fetch(
      `${getRuntimeBaseUrl()}/api/platform/admin/tenant-config/${encodeURIComponent(tenantId)}/overrides`,
      {
        method: 'PUT',
        headers: buildRuntimeHeaders(ctx),
        body: JSON.stringify(parsedBody.data),
      },
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to connect to runtime' },
      { status: 502 },
    );
  }
});

export const POST = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const { tenantId } = ctx.params;
  const parsedBody = await readValidatedJsonBody(ctx.request, tenantConfigOverridesSchema);
  if (!parsedBody.success) {
    return parsedBody.response;
  }

  try {
    const res = await fetch(
      `${getRuntimeBaseUrl()}/api/platform/admin/tenant-config/${encodeURIComponent(tenantId)}/overrides`,
      {
        method: 'PUT',
        headers: buildRuntimeHeaders(ctx),
        body: JSON.stringify(parsedBody.data),
      },
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to connect to runtime' },
      { status: 502 },
    );
  }
});

export const DELETE = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const { tenantId } = ctx.params;
  const headers = buildRuntimeHeaders(ctx);

  // Support body with {keys: string[]} to remove specific overrides,
  // or no body to clear all overrides
  const parsedBody = await readOptionalValidatedJsonBody(
    ctx.request,
    deleteTenantConfigOverridesSchema,
  );
  if (!parsedBody.success) {
    return parsedBody.response;
  }
  const body = parsedBody.data;

  if (body?.keys && body.keys.length > 0) {
    // Selective removal: fetch current overrides, remove specified keys, PUT the rest back
    try {
      // First GET the current config to know existing overrides
      const getRes = await fetch(
        `${getRuntimeBaseUrl()}/api/platform/admin/tenant-config/${encodeURIComponent(tenantId)}`,
        { method: 'GET', headers },
      );
      const getData = await getRes.json();
      if (!getRes.ok || !getData.success) {
        return NextResponse.json(
          { success: false, error: getData.error ?? 'Failed to fetch current config' },
          { status: getRes.status },
        );
      }

      const currentOverrides: Record<string, number> = getData.overrides ?? {};
      const keysToRemove = new Set(body.keys);
      const remaining: Record<string, number> = {};
      for (const [key, val] of Object.entries(currentOverrides)) {
        if (!keysToRemove.has(key)) {
          remaining[key] = val;
        }
      }

      // If nothing remains, DELETE all overrides
      if (Object.keys(remaining).length === 0) {
        const delRes = await fetch(
          `${getRuntimeBaseUrl()}/api/platform/admin/tenant-config/${encodeURIComponent(tenantId)}/overrides`,
          { method: 'DELETE', headers },
        );
        const delData = await delRes.json();
        return NextResponse.json(delData, { status: delRes.status });
      }

      // Otherwise PUT the remaining overrides
      const putRes = await fetch(
        `${getRuntimeBaseUrl()}/api/platform/admin/tenant-config/${encodeURIComponent(tenantId)}/overrides`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify(remaining),
        },
      );
      const putData = await putRes.json();
      return NextResponse.json(putData, { status: putRes.status });
    } catch {
      return NextResponse.json(
        { success: false, error: 'Failed to connect to runtime' },
        { status: 502 },
      );
    }
  }

  // No keys specified — clear all overrides
  try {
    const res = await fetch(
      `${getRuntimeBaseUrl()}/api/platform/admin/tenant-config/${encodeURIComponent(tenantId)}/overrides`,
      { method: 'DELETE', headers },
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to connect to runtime' },
      { status: 502 },
    );
  }
});
