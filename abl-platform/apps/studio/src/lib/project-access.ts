/**
 * Project Access — shared utility for verifying project-level authorization.
 *
 * Checks that the project exists and the user is authorized to access it
 * (project owner, tenant admin, or explicit project member).
 */

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  TENANT_ADMIN_BYPASS_PERMISSION,
  isTenantAdminRole,
} from '@agent-platform/shared-auth/rbac';
import type { AuthenticatedUser } from './auth';
import { findProjectByIdAndTenant } from '@/repos/project-repo';
import { ensureDb } from './ensure-db';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { hasPermission } from './permission-resolver';

const log = createLogger('project-access');

export interface ProjectAccessResult {
  project: {
    id: string;
    name: string;
    slug: string;
    ownerId: string;
    tenantId: string;
    [key: string]: unknown;
  };
  /**
   * Indicates which access path matched. Optional to preserve compatibility with
   * existing callers that only care about `project`.
   */
  accessPath?: 'tenant' | 'membership';
}

function isTenantAdmin(user: AuthenticatedUser): boolean {
  return (
    isTenantAdminRole(user.role) ||
    hasPermission(user.permissions ?? [], TENANT_ADMIN_BYPASS_PERMISSION)
  );
}

function normalizeProjectRecord(project: Record<string, unknown>): ProjectAccessResult['project'] {
  return {
    ...project,
    id: String(project._id ?? project.id),
  } as ProjectAccessResult['project'];
}

async function loadProjectById(projectId: string): Promise<ProjectAccessResult['project'] | null> {
  await ensureDb();

  const { Project } = await import('@agent-platform/database/models');
  const project = await Project.findOne({ _id: projectId }).lean();
  if (!project) {
    return null;
  }

  return normalizeProjectRecord(project as Record<string, unknown>);
}

export async function hasProjectMembership(projectId: string, userId: string): Promise<boolean> {
  await ensureDb();

  const { ProjectMember } = await import('@agent-platform/database/models');
  const membership = await ProjectMember.findOne({ projectId, userId }, { _id: 1 }).lean();

  return Boolean(membership);
}

/**
 * Return project IDs this user may read in their active tenant.
 *
 * Used by legacy collection routes that cannot call requireProjectAccess for a
 * single project up front. Tenant admins see all tenant projects; workspace
 * members see owned projects and explicit ProjectMember projects only.
 */
export async function findAccessibleProjectIds(user: AuthenticatedUser): Promise<string[]> {
  if (!user.id || !user.tenantId) {
    return [];
  }

  await ensureDb();

  const { Project, ProjectMember } = await import('@agent-platform/database/models');
  if (isTenantAdmin(user)) {
    const projects = await Project.find({ tenantId: user.tenantId }, { _id: 1 }).lean();
    return projects.map((project: { _id?: unknown }) => String(project._id));
  }

  const memberships = await ProjectMember.find({ userId: user.id }, { projectId: 1 }).lean();
  const memberProjectIds = memberships
    .map((membership: { projectId?: unknown }) =>
      typeof membership.projectId === 'string' ? membership.projectId : null,
    )
    .filter((projectId: string | null): projectId is string => Boolean(projectId));

  const projects = await Project.find(
    {
      tenantId: user.tenantId,
      $or: [{ ownerId: user.id }, { _id: { $in: memberProjectIds } }],
    },
    { _id: 1 },
  ).lean();

  return projects.map((project: { _id?: unknown }) => String(project._id));
}

/**
 * Verify that the authenticated user has access to the specified project.
 *
 * Access is granted if any of these conditions are met:
 * 1. User is a tenant admin in the project's tenant
 * 2. User is the project owner
 * 3. User is an explicit project member
 *
 * SECURITY: A matching tenantId alone is NOT sufficient. Non-admin workspace
 * members must have an explicit ProjectMember row to access a project.
 *
 * SECURITY: Never calls Project.findOne() without prior membership proof when
 * falling back to membership-only resolution without tenant context.
 * Returns 404 (not 403) to avoid leaking project existence to unauthorized users.
 *
 * @returns The project data or a NextResponse error (401/404)
 */
export async function requireProjectAccess(
  projectId: string,
  user: AuthenticatedUser,
): Promise<ProjectAccessResult | NextResponse> {
  // Require user identity
  if (!user.id) {
    return errorJson('Unauthorized', 401, ErrorCode.UNAUTHORIZED);
  }

  // Primary path: verify the project belongs to the caller's active tenant.
  if (user.tenantId) {
    const project = await findProjectByIdAndTenant(projectId, user.tenantId);
    if (project) {
      if (project.ownerId === user.id || isTenantAdmin(user)) {
        return { project, accessPath: 'tenant' };
      }

      try {
        if (await hasProjectMembership(projectId, user.id)) {
          return { project, accessPath: 'membership' };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('Membership check failed', { projectId, error: message });
      }
    }

    return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
  }

  // Fallback: no tenant context — require explicit membership before loading.
  try {
    // Check membership first — do not load the project without proof of membership
    const membership = await hasProjectMembership(projectId, user.id);

    if (membership) {
      // Membership confirmed — load the project record
      const memberProject = await loadProjectById(projectId);
      if (memberProject) {
        return { project: memberProject, accessPath: 'membership' };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Membership check failed', { projectId, error: message });
  }

  return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
}

/**
 * Type guard to check if requireProjectAccess returned an error response.
 */
export function isAccessError(result: ProjectAccessResult | NextResponse): result is NextResponse {
  return result instanceof NextResponse;
}
