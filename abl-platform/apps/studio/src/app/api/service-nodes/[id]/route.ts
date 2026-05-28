/**
 * GET    /api/service-nodes/:id - Get service node details
 * PATCH  /api/service-nodes/:id - Update service node
 * DELETE /api/service-nodes/:id - Delete service node
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import {
  findServiceNodeById,
  updateServiceNode,
  deleteServiceNode,
} from '@/repos/service-node-repo';
import { findProjectByIdAndTenant } from '@/repos/project-repo';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { createLogger } from '@abl/compiler/platform/logger.js';

type RouteParams = { params: Promise<{ id: string }> };
const log = createLogger('service-node-route');

// Zod schemas for service nodes
const pathParamsSchema = z.object({
  id: z.string(),
});

const updateServiceNodeSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional().nullable(),
  endpoint: z.string().url().optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  authType: z.enum(['none', 'api_key', 'bearer', 'oauth2', 'custom']).optional(),
  authConfig: z.record(z.unknown()).optional().nullable(),
  inputSchema: z.string().min(1).optional(),
  outputSchema: z.string().optional().nullable(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  retryCount: z.number().int().min(0).max(10).optional(),
  retryDelayMs: z.number().int().min(100).max(30000).optional(),
  rateLimitPerMinute: z.number().int().optional().nullable(),
  rateLimitPerHour: z.number().int().optional().nullable(),
  circuitBreakerThreshold: z.number().int().optional(),
  circuitBreakerResetMs: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

const serviceNodeDetailSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string().nullable().optional(),
  endpoint: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  authType: z.enum(['none', 'api_key', 'bearer', 'oauth2', 'custom']),
  authConfig: z.record(z.unknown()).nullable().optional(),
  inputSchema: z.string(),
  outputSchema: z.string().nullable().optional(),
  timeoutMs: z.number().int(),
  retryCount: z.number().int(),
  retryDelayMs: z.number().int(),
  rateLimitPerMinute: z.number().int().nullable().optional(),
  rateLimitPerHour: z.number().int().nullable().optional(),
  circuitBreakerThreshold: z.number().int(),
  circuitBreakerResetMs: z.number().int(),
  isActive: z.boolean().optional(),
  project: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

const deleteResponseSchema = z.object({
  success: z.boolean(),
});

/**
 * Verify the service node belongs to a project accessible by the user.
 * Tenant-scoped: verifies the node tenant first, then confirms the parent project.
 */
async function findOwnedServiceNode(id: string, tenantId: string) {
  const node = await findServiceNodeById(id, tenantId);
  if (!node) return null;

  const project = await findProjectByIdAndTenant(node.projectId, tenantId);
  if (project) return { node, project };

  // Tenant mismatch or orphaned project — deny access (return 404 to avoid leaking existence)
  return null;
}

async function getHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  try {
    const result = await findOwnedServiceNode(id, user.tenantId);

    if (!result) {
      return NextResponse.json({ error: 'Service node not found' }, { status: 404 });
    }

    return NextResponse.json({
      ...result.node,
      project: { id: result.project.id, name: result.project.name },
    });
  } catch (error: unknown) {
    log.error('Get error', {
      serviceNodeId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function patchHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const body = await request.json();
  const result = updateServiceNodeSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  try {
    const existing = await findOwnedServiceNode(id, user.tenantId);
    if (!existing) {
      return NextResponse.json({ error: 'Service node not found' }, { status: 404 });
    }

    const { authConfig, ...rest } = result.data;
    const updateData: Record<string, unknown> = { ...rest };
    if (authConfig !== undefined) {
      updateData.authConfig = authConfig ? JSON.stringify(authConfig) : null;
    }

    const node = await updateServiceNode(id, user.tenantId, existing.node.projectId, updateData);

    await logAuditEvent({
      userId: user.id,
      action: AuditActions.SERVICE_NODE_UPDATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { serviceNodeId: id, changes: Object.keys(result.data) },
    });

    return NextResponse.json(node);
  } catch (error: unknown) {
    log.error('Update error', {
      serviceNodeId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function deleteHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  try {
    const existing = await findOwnedServiceNode(id, user.tenantId);
    if (!existing) {
      return NextResponse.json({ error: 'Service node not found' }, { status: 404 });
    }

    await deleteServiceNode(id, user.tenantId, existing.node.projectId);

    await logAuditEvent({
      userId: user.id,
      action: AuditActions.SERVICE_NODE_DELETED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { serviceNodeId: id, projectId: existing.node.projectId, name: existing.node.name },
    });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    log.error('Delete error', {
      serviceNodeId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'Get service node details',
    description: 'Retrieve detailed configuration information for a specific service node.',
    params: pathParamsSchema,
    response: serviceNodeDetailSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);

export const PATCH = withOpenAPI(
  {
    summary: 'Update service node',
    description: 'Update configuration settings for an existing service node.',
    params: pathParamsSchema,
    body: updateServiceNodeSchema,
    response: serviceNodeDetailSchema,
    successStatus: 200,
    auth: true,
  },
  patchHandler as any,
);

export const DELETE = withOpenAPI(
  {
    summary: 'Delete service node',
    description: 'Remove a service node and its associated configuration.',
    params: pathParamsSchema,
    response: deleteResponseSchema,
    successStatus: 200,
    auth: true,
  },
  deleteHandler as any,
);
