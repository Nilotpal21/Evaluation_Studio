/**
 * GET  /api/tenant-models — Proxy to runtime tenant models list
 * POST /api/tenant-models — Proxy to runtime tenant model creation
 *
 * Forwards to runtime /api/tenants/:tenantId/models so the Studio
 * can browse and manage the tenant's model catalog.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { proxyToRuntime } from '@/lib/runtime-proxy';

function buildTenantModelsRuntimePath(request: NextRequest, tenantId: string) {
  const queryString = request.nextUrl.searchParams.toString();
  const path = `/api/tenants/${encodeURIComponent(tenantId)}/models`;
  return queryString ? `${path}?${queryString}` : path;
}

// Zod schemas for tenant models
const tenantModelItemSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  tier: z.string().optional(),
  useResponsesApi: z.boolean().nullable().optional(),
  useStreaming: z.boolean().nullable().optional(),
  hyperParameters: z.record(z.unknown()).nullable().optional(),
  isActive: z.boolean(),
  inferenceEnabled: z.boolean().optional(),
  _count: z.object({ connections: z.number() }).optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

const listTenantModelsResponseSchema = z.object({
  models: z.array(tenantModelItemSchema),
  total: z.number().optional(),
});

const createTenantModelSchema = z.object({
  displayName: z.string().min(1).max(255),
  modelId: z.string().optional(),
  provider: z.string().optional(),
  integrationType: z.string().optional(),
  endpointUrl: z.string().optional(),
  tier: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  hyperParameters: z.record(z.unknown()).nullable().optional(),
  isDefault: z.boolean().optional(),
  capabilities: z.array(z.string()).optional(),
  realtimeConfig: z.record(z.unknown()).optional(),
  useResponsesApi: z.boolean().nullable().optional(),
  useStreaming: z.boolean().nullable().optional(),
});

const tenantModelResponseSchema = z.object({
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

async function getHandler(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const tenantId = user.tenantId;

  try {
    return await proxyToRuntime(request, buildTenantModelsRuntimePath(request, tenantId), {
      tenantId,
    });
  } catch (error) {
    console.error('[TenantModels] Proxy GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch tenant models from runtime' },
      { status: 502 },
    );
  }
}

async function postHandler(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const tenantId = user.tenantId;

  try {
    const body = await request.json();
    const result = createTenantModelSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: result.error.issues },
        { status: 400 },
      );
    }

    return await proxyToRuntime(request, `/api/tenants/${encodeURIComponent(tenantId)}/models`, {
      method: 'POST',
      body: result.data,
      tenantId,
    });
  } catch (error) {
    console.error('[TenantModels] Proxy POST error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create tenant model via runtime' },
      { status: 502 },
    );
  }
}

export const GET = withOpenAPI(
  {
    summary: 'List tenant models',
    description: 'Retrieve all models available to a specific tenant.',
    response: listTenantModelsResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);

export const POST = withOpenAPI(
  {
    summary: 'Create tenant model',
    description: "Add a new model to a tenant's model catalog.",
    body: createTenantModelSchema,
    response: tenantModelResponseSchema,
    successStatus: 201,
    auth: true,
  },
  postHandler as any,
);
