/**
 * GET  /api/service-nodes - List service nodes
 * POST /api/service-nodes - Create a new service node
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { findServiceNodes, createServiceNode } from '@/repos/service-node-repo';
import { findProjects } from '@/repos/project-repo';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('service-nodes');

// Zod schemas for service nodes
const createServiceNodeSchema = z.object({
  projectId: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z_][a-z0-9_]*$/, 'Must be a valid tool name (lowercase, underscores)'),
  displayName: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  endpoint: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
  authType: z.enum(['none', 'api_key', 'bearer', 'oauth2', 'custom']).default('none'),
  authConfig: z.record(z.unknown()).optional(),
  inputSchema: z.string().min(1),
  outputSchema: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  retryCount: z.number().int().min(0).max(10).default(3),
  retryDelayMs: z.number().int().min(100).max(30000).default(1000),
  rateLimitPerMinute: z.number().int().optional(),
  rateLimitPerHour: z.number().int().optional(),
  circuitBreakerThreshold: z.number().int().default(5),
  circuitBreakerResetMs: z.number().int().default(60000),
});

const serviceNodeItemSchema = z.object({
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
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

const listServiceNodesResponseSchema = z.object({
  serviceNodes: z.array(serviceNodeItemSchema),
});

async function getHandler(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const projectId = request.nextUrl.searchParams.get('projectId');

  try {
    const projects = await findProjects({
      ownerId: user.id,
      tenantId: user.tenantId,
      ...(projectId ? { id: projectId } : {}),
    });
    const projectIds = projects.map((project) => String(project.id));
    const nodes =
      projectIds.length === 0
        ? []
        : await findServiceNodes({
            tenantId: user.tenantId,
            projectId: projectId ?? { in: projectIds },
          });

    return NextResponse.json({ serviceNodes: nodes });
  } catch (error) {
    log.error('List error', { err: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function postHandler(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const body = await request.json();
  const result = createServiceNodeSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  try {
    // Verify project ownership
    const projects = await findProjects({
      id: result.data.projectId,
      ownerId: user.id,
      tenantId: user.tenantId,
    });
    if (projects.length === 0) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const { authConfig, ...rest } = result.data;
    const node = await createServiceNode({
      tenantId: user.tenantId,
      ...rest,
      authConfig: authConfig ? JSON.stringify(authConfig) : null,
    });

    await logAuditEvent({
      userId: user.id,
      action: AuditActions.SERVICE_NODE_CREATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        serviceNodeId: node.id,
        projectId: result.data.projectId,
        name: result.data.name,
      },
    });

    return NextResponse.json(node, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as any).code === 11000) {
      return NextResponse.json(
        { error: 'A service node with this name already exists in the project' },
        { status: 409 },
      );
    }
    log.error('Create error', { err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'List service nodes',
    description:
      'Retrieve all service nodes for the authenticated user, optionally filtered by project.',
    response: listServiceNodesResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);

export const POST = withOpenAPI(
  {
    summary: 'Create service node',
    description: 'Create a new service node with configuration for external API integration.',
    body: createServiceNodeSchema,
    response: serviceNodeItemSchema,
    successStatus: 201,
    auth: true,
  },
  postHandler as any,
);
