import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  evaluateProjectPermission,
  hasPermission,
  PROJECT_ROLE_NAMES,
  type ProjectRoleName,
} from '@agent-platform/shared/rbac';
import type { AuthenticatedUser } from './auth';
import { ensureDb } from './ensure-db';
import { findProjectByIdAndTenant } from '@/repos/project-repo';
import { resolveProjectCustomRolePermissions } from './permission-resolver';

const log = createLogger('sdk-project-access');
// Only project-wide authority can bypass project membership here. Generic
// tenant read permissions like `project:read` must not leak SDK control-plane
// access across projects within the same tenant.
const SDK_PROJECT_TENANT_BYPASS_PERMISSION = 'project:*';
type ProjectMemberRole = ProjectRoleName | 'custom';
const PROJECT_ROLE_NAME_SET = new Set<ProjectMemberRole>([...PROJECT_ROLE_NAMES, 'custom']);
const SDK_PROJECT_OPERATION_PERMISSIONS: Readonly<Record<SdkProjectAccessOperation, string>> = {
  read: 'agent:read',
  write: 'agent:update',
};

export type SdkProjectAccessOperation = 'read' | 'write';

export interface SdkProjectAccessResult {
  project: {
    id: string;
    name: string;
    slug: string;
    ownerId: string;
    tenantId: string;
    [key: string]: unknown;
  };
  accessLevel: 'project_owner' | 'tenant_rbac' | 'project_member';
}

function normalizeProjectMemberRole(role: unknown): ProjectMemberRole | null {
  if (typeof role !== 'string') {
    return null;
  }

  const normalized = role.trim().toLowerCase();
  return PROJECT_ROLE_NAME_SET.has(normalized as ProjectMemberRole)
    ? (normalized as ProjectMemberRole)
    : null;
}

function projectRoleCanAccessSdk(
  role: ProjectMemberRole,
  customRolePermissions: readonly string[],
  operation: SdkProjectAccessOperation,
): boolean {
  return evaluateProjectPermission(
    role,
    SDK_PROJECT_OPERATION_PERMISSIONS[operation],
    customRolePermissions,
  );
}

export async function requireSdkProjectAccess(
  projectId: string,
  user: AuthenticatedUser,
  operation: SdkProjectAccessOperation,
): Promise<SdkProjectAccessResult | NextResponse> {
  if (!user.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!user.tenantId) {
    return NextResponse.json({ error: 'No tenant context' }, { status: 403 });
  }

  await ensureDb();

  const project = await findProjectByIdAndTenant(projectId, user.tenantId);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  if (project.ownerId === user.id) {
    return { project, accessLevel: 'project_owner' };
  }

  if (hasPermission(user.permissions ?? [], SDK_PROJECT_TENANT_BYPASS_PERMISSION)) {
    return { project, accessLevel: 'tenant_rbac' };
  }

  const { ProjectMember } = await import('@agent-platform/database/models');
  const membership = await ProjectMember.findOne(
    { projectId, userId: user.id },
    { role: 1, customRoleId: 1 },
  ).lean();

  if (!membership) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const normalizedRole = normalizeProjectMemberRole(membership.role);
  if (!normalizedRole) {
    log.warn('SDK project access denied for unsupported project member role', {
      projectId,
      userId: user.id,
      role: membership.role,
      customRoleId:
        typeof membership.customRoleId === 'string' ? membership.customRoleId : undefined,
      operation,
    });
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const customRolePermissions =
    normalizedRole === 'custom'
      ? await resolveProjectCustomRolePermissions(
          user.tenantId,
          typeof membership.customRoleId === 'string' ? membership.customRoleId : null,
        )
      : [];

  if (!projectRoleCanAccessSdk(normalizedRole, customRolePermissions, operation)) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  return { project, accessLevel: 'project_member' };
}

export function isSdkProjectAccessError(
  result: SdkProjectAccessResult | NextResponse,
): result is NextResponse {
  return result instanceof NextResponse;
}
