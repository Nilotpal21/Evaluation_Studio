import { NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../../lib/with-admin-route';
import { getRuntimeBaseUrl, buildRuntimeHeaders } from '../../../../lib/runtime-proxy';

function validatePath(path: string): NextResponse | null {
  // Reject path traversal attempts: normalize, strip null bytes, block .. and leading /
  let sanitized: string;
  try {
    sanitized = decodeURIComponent(path).replace(/\0/g, '');
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid path encoding' }, { status: 400 });
  }
  if (sanitized.includes('..') || sanitized.startsWith('/') || sanitized !== path) {
    return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
  }
  return null;
}

async function proxyToRuntime(ctx: AdminRouteContext<{ path: string[] }>, method: string) {
  const pathSegments = ctx.params.path;
  // For catch-all routes, params.path is a string with segments joined by /
  // but withAdminRoute awaits params as Record<string, string>
  // Next.js catch-all stores it as a single joined string via Promise resolution
  const path = Array.isArray(pathSegments) ? pathSegments.join('/') : String(pathSegments);

  const pathErr = validatePath(path);
  if (pathErr) return pathErr;

  const url = `${getRuntimeBaseUrl()}/api/platform/admin/resilience/${path.split('/').map(encodeURIComponent).join('/')}`;

  try {
    const fetchOptions: RequestInit = {
      method,
      headers: buildRuntimeHeaders(ctx),
    };

    if (method === 'POST') {
      const body = await ctx.request.text();
      if (body) fetchOptions.body = body;
    }

    const res = await fetch(url, fetchOptions);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to connect to runtime' },
      { status: 502 },
    );
  }
}

export const GET = withAdminRoute<{ path: string[] }>({ role: 'VIEWER' }, async (ctx) => {
  return proxyToRuntime(ctx, 'GET');
});

export const POST = withAdminRoute<{ path: string[] }>({ role: 'OPERATOR' }, async (ctx) => {
  return proxyToRuntime(ctx, 'POST');
});
