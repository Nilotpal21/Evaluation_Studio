/**
 * GET  /api/projects - List user's accessible projects
 * POST /api/projects - Create a new project
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createProject, getUserProjectsWithCounts } from '@/services/project-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { requireAuth, requireTenantAuth, isAuthError } from '@/lib/auth';
import {
  successJson,
  errorJson,
  handleApiError,
  ErrorCode,
  isDuplicateKeyError,
} from '@/lib/api-response';
import { hasPermission } from '@/lib/permission-resolver';
import { PROJECT_NAME_ERROR_MESSAGE, PROJECT_NAME_PATTERN } from '@/lib/project-name-validation';

const log = createLogger('api:projects');

const createProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Project name is required')
    .max(100, 'Project name must be 100 characters or less')
    .regex(PROJECT_NAME_PATTERN, PROJECT_NAME_ERROR_MESSAGE),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().trim().max(500, 'Description must be 500 characters or less').optional(),
});

const projectItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable().optional(),
  entryAgentName: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  agentCount: z.number(),
});

const listProjectsResponseSchema = z.object({
  projects: z.array(projectItemSchema),
});

const listProjectsQuerySchema = z.object({
  tenantId: z.string().trim().min(1).optional(),
});

const projectResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable().optional(),
  ownerId: z.string(),
  tenantId: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

async function getHandler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const parsedQuery = listProjectsQuerySchema.safeParse({
    tenantId: request.nextUrl.searchParams.get('tenantId') ?? user.tenantId,
  });
  if (!parsedQuery.success) {
    return errorJson(
      parsedQuery.error.issues.map((issue) => issue.message),
      400,
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const projects = await getUserProjectsWithCounts(user.id, parsedQuery.data.tenantId);

    return successJson(
      'projects',
      projects.map((p: any) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        entryAgentName: p.entryAgentName ?? null,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        agentCount: p._count.agents,
      })),
    );
  } catch (error) {
    return handleApiError(error, 'Projects.list');
  }
}

async function postHandler(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  if (!hasPermission(user.permissions ?? [], 'project:create')) {
    return errorJson(
      'Forbidden: missing required permission (project:create)',
      403,
      ErrorCode.FORBIDDEN,
    );
  }

  const body = await request.json();
  const result = createProjectSchema.safeParse(body);

  if (!result.success) {
    return errorJson(
      result.error.issues.map((i) => i.message),
      400,
      ErrorCode.VALIDATION_ERROR,
    );
  }

  let project;
  try {
    project = await createProject({
      ...result.data,
      ownerId: user.id,
      tenantId: user.tenantId,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return errorJson('Project with the same name already exists', 409, ErrorCode.NAME_CONFLICT);
    }

    return handleApiError(error, 'Projects.create');
  }

  // Audit logging is best-effort — don't let it mask a successful creation
  logAuditEvent({
    userId: user.id,
    tenantId: user.tenantId,
    action: AuditActions.PROJECT_CREATED,
    ip: request.headers.get('x-forwarded-for') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
    metadata: {
      projectId: project.id,
      resourceType: 'project',
      resourceId: project.id,
      name: project.name,
    },
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Audit log failed for project creation', { projectId: project.id, error: message });
  });

  return successJson('project', project, 201);
}

export const GET = withOpenAPI(
  {
    summary: 'List projects',
    description: 'Retrieve all projects owned by the authenticated user with agent counts.',
    response: listProjectsResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);

export const POST = withOpenAPI(
  {
    summary: 'Create project',
    description: 'Create a new project for the authenticated user.',
    body: createProjectSchema,
    response: projectResponseSchema,
    successStatus: 201,
    auth: true,
  },
  postHandler as any,
);
