/**
 * GET    /api/projects/:id - Get project details
 * PATCH  /api/projects/:id - Update project
 * DELETE /api/projects/:id - Delete project
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { getProjectWithCounts, updateProject, deleteProject } from '@/services/project-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { requireAuth, isAuthError } from '@/lib/auth';
import { successJson, errorJson, actionJson, handleApiError, ErrorCode } from '@/lib/api-response';
import { isAccessError, requireProjectAccess } from '@/lib/project-access';
import { isProjectPermissionError, requireProjectPermission } from '@/lib/project-permission';

const log = createLogger('api:projects:[id]');

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  entryAgentName: z.string().max(100).nullable().optional(),
});

const pathParamsSchema = z.object({
  id: z.string(),
});

const projectDetailsResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable().optional(),
  entryAgentName: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  agentCount: z.number(),
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

const deleteResponseSchema = z.object({
  success: z.boolean(),
});

type RouteParams = { params: Promise<{ id: string }> };

async function getHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  const access = await requireProjectAccess(id, user);
  if (isAccessError(access)) return access;

  try {
    const project = await getProjectWithCounts(id, access.project.tenantId);
    if (!project) {
      return errorJson('Project not found', 404, ErrorCode.NOT_FOUND);
    }

    return successJson('project', {
      id: project.id,
      name: project.name,
      slug: project.slug,
      description: project.description,
      entryAgentName: project.entryAgentName ?? null,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      agentCount: project._count.agents,
    });
  } catch (error) {
    return handleApiError(error, 'Projects.get');
  }
}

async function patchHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  const access = await requireProjectPermission(id, user, 'project:update');
  if (isProjectPermissionError(access)) return access;

  const body = await request.json();
  const result = updateProjectSchema.safeParse(body);

  if (!result.success) {
    return errorJson(
      result.error.issues.map((i) => i.message),
      400,
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const project = await updateProject(id, result.data, access.project.tenantId);

    logAuditEvent({
      userId: user.id,
      tenantId: access.project.tenantId,
      action: AuditActions.PROJECT_UPDATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        projectId: project.id,
        resourceType: 'project',
        resourceId: project.id,
        changes: result.data,
      },
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Audit log failed for project update', { projectId: id, error: message });
    });

    return successJson('project', project);
  } catch (error) {
    return handleApiError(error, 'Projects.update');
  }
}

async function deleteHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  const access = await requireProjectPermission(id, user, 'project:delete');
  if (isProjectPermissionError(access)) return access;

  try {
    await deleteProject(id, access.project.tenantId);

    logAuditEvent({
      userId: user.id,
      tenantId: access.project.tenantId,
      action: AuditActions.PROJECT_DELETED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        projectId: id,
        resourceType: 'project',
        resourceId: id,
      },
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Audit log failed for project deletion', { projectId: id, error: message });
    });

    return actionJson();
  } catch (error) {
    return handleApiError(error, 'Projects.delete');
  }
}

export const GET = withOpenAPI(
  {
    summary: 'Get project',
    description: 'Retrieve project details including agent count by project ID.',
    params: pathParamsSchema,
    response: projectDetailsResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);

export const PATCH = withOpenAPI(
  {
    summary: 'Update project',
    description: 'Update project name and/or description.',
    params: pathParamsSchema,
    body: updateProjectSchema,
    response: projectResponseSchema,
    successStatus: 200,
    auth: true,
  },
  patchHandler as any,
);

export const DELETE = withOpenAPI(
  {
    summary: 'Delete project',
    description: 'Permanently delete a project.',
    params: pathParamsSchema,
    response: deleteResponseSchema,
    successStatus: 200,
    auth: true,
  },
  deleteHandler as any,
);
