/**
 * GET    /api/tenant-models/:id — Get tenant model detail
 * PATCH  /api/tenant-models/:id — Update tenant model settings
 * DELETE /api/tenant-models/:id — Deactivate tenant model
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';

type RouteParams = { params: Promise<{ id: string }> };

// Zod schemas for tenant models
const pathParamsSchema = z.object({
  id: z.string(),
});

const tenantModelDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  useResponsesApi: z.boolean().nullable().optional(),
  useStreaming: z.boolean().nullable().optional(),
  hyperParameters: z.record(z.unknown()).nullable().optional(),
  isActive: z.boolean(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

const updateTenantModelSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  isActive: z.boolean().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  hyperParameters: z.record(z.unknown()).nullable().optional(),
  tier: z.string().optional(),
  isDefault: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsStructured: z.boolean().optional(),
  capabilities: z.array(z.string()).optional(),
  realtimeConfig: z.record(z.unknown()).nullable().optional(),
  inferenceEnabled: z.boolean().optional(),
  useResponsesApi: z.boolean().nullable().optional(),
  useStreaming: z.boolean().nullable().optional(),
});

const deleteResponseSchema = z.object({
  success: z.boolean(),
});

function buildProxyHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  headers['X-Tenant-Id'] = tenantId;
  return headers;
}

async function getHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const tenantId = user.tenantId;

  try {
    const headers = buildProxyHeaders(request, tenantId);
    const response = await fetch(
      `${getRuntimeUrl()}/api/tenants/${encodeURIComponent(tenantId)}/models/${encodeURIComponent(id)}`,
      {
        headers,
      },
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[TenantModels] Proxy GET detail error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch tenant model detail from runtime' },
      { status: 502 },
    );
  }
}

async function patchHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const tenantId = user.tenantId;

  try {
    const body = await request.json();
    const result = updateTenantModelSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: result.error.issues },
        { status: 400 },
      );
    }

    const headers = buildProxyHeaders(request, tenantId);
    const response = await fetch(
      `${getRuntimeUrl()}/api/tenants/${encodeURIComponent(tenantId)}/models/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(result.data),
      },
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[TenantModels] Proxy PATCH error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update tenant model via runtime' },
      { status: 502 },
    );
  }
}

async function deleteHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const tenantId = user.tenantId;

  try {
    const headers = buildProxyHeaders(request, tenantId);
    const response = await fetch(
      `${getRuntimeUrl()}/api/tenants/${encodeURIComponent(tenantId)}/models/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers,
      },
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[TenantModels] Proxy DELETE error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete tenant model via runtime' },
      { status: 502 },
    );
  }
}

export const GET = withOpenAPI(
  {
    summary: 'Get tenant model details',
    description: 'Retrieve detailed information about a specific tenant model.',
    params: pathParamsSchema,
    response: tenantModelDetailSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);

export const PATCH = withOpenAPI(
  {
    summary: 'Update tenant model',
    description: "Update a tenant model's name, description, or active status.",
    params: pathParamsSchema,
    body: updateTenantModelSchema,
    response: tenantModelDetailSchema,
    successStatus: 200,
    auth: true,
  },
  patchHandler as any,
);

export const DELETE = withOpenAPI(
  {
    summary: 'Delete tenant model',
    description: "Permanently delete a model from a tenant's model catalog.",
    params: pathParamsSchema,
    response: deleteResponseSchema,
    successStatus: 200,
    auth: true,
  },
  deleteHandler as any,
);
