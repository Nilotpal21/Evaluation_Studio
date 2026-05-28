/**
 * Project Member Service
 *
 * Encapsulates member-management business rules so the route layer stays thin
 * and downstream slices can reuse a stable contract.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { ProjectRoleName } from '@agent-platform/shared/rbac';
import { ErrorCode } from '@/lib/api-response';
import { hasPermission } from '@/lib/permission-resolver';
import type { ProjectAccessResult } from '@/lib/project-access';
import {
  createProjectMember as createProjectMemberRecord,
  deleteProjectMember as deleteProjectMemberRecord,
  findCustomRoleDefinition,
  findProjectMember,
  findProjectMembers,
  updateProjectMember as updateProjectMemberRecord,
} from '@/repos/project-member-repo';
import { findTenantMember, findTenantMembers } from '@/repos/workspace-repo';
import { AuditActions, logAuditEvent } from '@/services/audit-service';

const log = createLogger('project-member-service');
const ACTIVE_TENANT_MEMBER_STATUSES = new Set(['active', undefined, null]);

export type ProjectMemberRoleInput = ProjectRoleName | 'custom';

export interface ProjectMemberActor {
  userId: string;
  role?: string | null;
  permissions: string[];
  ip?: string;
  userAgent?: string;
}

export interface AddProjectMemberInput {
  userId: string;
  role: ProjectMemberRoleInput;
  customRoleId?: string | null;
}

export interface UpdateProjectMemberInput {
  role?: ProjectMemberRoleInput;
  customRoleId?: string | null;
}

export class ProjectMemberServiceError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly status: number;

  constructor(message: string, statusCode: number, code: ErrorCode) {
    super(message);
    this.name = 'ProjectMemberServiceError';
    this.code = code;
    this.statusCode = statusCode;
    this.status = statusCode;
  }
}

export function isProjectMemberServiceError(error: unknown): error is ProjectMemberServiceError {
  return error instanceof ProjectMemberServiceError;
}

function fail(message: string, statusCode: number, code: ErrorCode): never {
  throw new ProjectMemberServiceError(message, statusCode, code);
}

function isTenantAdmin(actor: ProjectMemberActor): boolean {
  return (
    actor.role === 'OWNER' ||
    actor.role === 'ADMIN' ||
    hasPermission(actor.permissions ?? [], 'project:*')
  );
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as Record<string, unknown>).code === 11000
  );
}

async function resolveValidatedCustomRoleId(
  tenantId: string,
  role: ProjectMemberRoleInput,
  customRoleId: string | null | undefined,
): Promise<string | null> {
  if (role !== 'custom') {
    if (customRoleId) {
      fail('customRoleId may only be set when role is "custom"', 400, ErrorCode.VALIDATION_ERROR);
    }
    return null;
  }

  if (!customRoleId) {
    fail('customRoleId is required when role is "custom"', 400, ErrorCode.VALIDATION_ERROR);
  }

  const customRole = await findCustomRoleDefinition(tenantId, customRoleId);
  if (!customRole) {
    fail(
      'customRoleId must reference an existing custom role in this workspace',
      400,
      ErrorCode.VALIDATION_ERROR,
    );
  }

  return customRole.id;
}

export async function assertCallerCanManageMembers(
  project: ProjectAccessResult['project'],
  actor: ProjectMemberActor,
): Promise<void> {
  if (await canActorManageMembers(project, actor)) {
    return;
  }

  log.warn('Denied project member mutation', {
    projectId: project.id,
    callerUserId: actor.userId,
    callerRole: actor.role,
    callerPermissions: actor.permissions,
  });

  fail('Insufficient permissions to manage project members', 403, ErrorCode.FORBIDDEN);
}

export async function canActorManageMembers(
  project: ProjectAccessResult['project'],
  actor: ProjectMemberActor,
): Promise<boolean> {
  if (project.ownerId === actor.userId || isTenantAdmin(actor)) {
    return true;
  }

  const callerMembership = await findProjectMember(project.id, actor.userId);
  return callerMembership?.role === 'admin';
}

export async function listProjectMembers(project: ProjectAccessResult['project']): Promise<any[]> {
  return findProjectMembers(project.id, { includeUser: true });
}

function isActiveTenantMemberStatus(status: unknown): boolean {
  return ACTIVE_TENANT_MEMBER_STATUSES.has(status as string | null | undefined);
}

export async function listAvailableProjectMembers(
  project: ProjectAccessResult['project'],
  actor: ProjectMemberActor,
): Promise<any[]> {
  await assertCallerCanManageMembers(project, actor);

  const [tenantMembers, projectMembers] = await Promise.all([
    findTenantMembers(project.tenantId, { includeUser: true }),
    findProjectMembers(project.id),
  ]);

  const existingUserIds = new Set(
    [
      project.ownerId,
      ...projectMembers.map((member: { userId: string }) => String(member.userId)),
    ].map(String),
  );

  return tenantMembers
    .filter((member: any) => member.user !== null)
    .filter((member: any) => isActiveTenantMemberStatus(member.status))
    .filter((member: any) => !existingUserIds.has(String(member.userId)))
    .sort((left: any, right: any) => {
      const leftName = String(left.user?.name ?? left.user?.email ?? left.userId).toLowerCase();
      const rightName = String(right.user?.name ?? right.user?.email ?? right.userId).toLowerCase();
      return leftName.localeCompare(rightName);
    });
}

export async function addProjectMember(
  project: ProjectAccessResult['project'],
  actor: ProjectMemberActor,
  input: AddProjectMemberInput,
): Promise<any> {
  await assertCallerCanManageMembers(project, actor);

  const tenantMembership = await findTenantMember(project.tenantId, input.userId);
  if (!tenantMembership) {
    fail('User is not a member of this workspace', 400, ErrorCode.VALIDATION_ERROR);
  }

  const existing = await findProjectMember(project.id, input.userId);
  if (existing) {
    fail('User is already a member of this project', 409, ErrorCode.NAME_CONFLICT);
  }

  const validatedCustomRoleId = await resolveValidatedCustomRoleId(
    project.tenantId,
    input.role,
    input.customRoleId,
  );

  let member;
  try {
    member = await createProjectMemberRecord({
      projectId: project.id,
      userId: input.userId,
      role: input.role,
      customRoleId: validatedCustomRoleId,
    });
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      fail('User is already a member of this project', 409, ErrorCode.NAME_CONFLICT);
    }
    throw error;
  }

  await logAuditEvent({
    userId: actor.userId,
    tenantId: project.tenantId,
    action: AuditActions.PROJECT_MEMBER_ADDED,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: {
      projectId: project.id,
      resourceType: 'project_member',
      resourceId: `${project.id}:${input.userId}`,
      targetUserId: input.userId,
      role: input.role,
      customRoleId: validatedCustomRoleId,
    },
  });

  return member;
}

export async function updateProjectMember(
  project: ProjectAccessResult['project'],
  actor: ProjectMemberActor,
  targetUserId: string,
  input: UpdateProjectMemberInput,
): Promise<any> {
  if (!input.role && input.customRoleId === undefined) {
    fail('At least one of role or customRoleId is required', 400, ErrorCode.VALIDATION_ERROR);
  }

  await assertCallerCanManageMembers(project, actor);

  if (targetUserId === project.ownerId) {
    fail("Cannot change the project owner's role", 400, ErrorCode.VALIDATION_ERROR);
  }

  const existing = await findProjectMember(project.id, targetUserId);
  if (!existing) {
    fail('Not found', 404, ErrorCode.NOT_FOUND);
  }

  const effectiveRole = (input.role ?? existing.role) as ProjectMemberRoleInput;
  const effectiveCustomRoleId =
    input.customRoleId !== undefined
      ? (input.customRoleId ?? null)
      : input.role !== undefined && input.role !== 'custom'
        ? null
        : (existing.customRoleId ?? null);
  const validatedCustomRoleId = await resolveValidatedCustomRoleId(
    project.tenantId,
    effectiveRole,
    effectiveCustomRoleId,
  );

  const updateData: { role?: ProjectMemberRoleInput; customRoleId?: string | null } = {};
  if (input.role !== undefined) {
    updateData.role = input.role;
    if (input.role !== 'custom') {
      updateData.customRoleId = null;
    }
  }
  if (effectiveRole === 'custom' && input.customRoleId !== undefined) {
    updateData.customRoleId = validatedCustomRoleId;
  }

  if (Object.keys(updateData).length === 0) {
    return existing;
  }

  const updated = await updateProjectMemberRecord(project.id, targetUserId, updateData);
  if (!updated) {
    fail('Not found', 404, ErrorCode.NOT_FOUND);
  }

  await logAuditEvent({
    userId: actor.userId,
    tenantId: project.tenantId,
    action: AuditActions.PROJECT_MEMBER_ROLE_CHANGED,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: {
      projectId: project.id,
      resourceType: 'project_member',
      resourceId: `${project.id}:${targetUserId}`,
      targetUserId,
      previousRole: existing.role,
      newRole: updated.role,
      previousCustomRoleId: existing.customRoleId ?? null,
      newCustomRoleId: updated.customRoleId ?? null,
    },
  });

  return updated;
}

export async function removeProjectMember(
  project: ProjectAccessResult['project'],
  actor: ProjectMemberActor,
  targetUserId: string,
): Promise<void> {
  await assertCallerCanManageMembers(project, actor);

  if (targetUserId === project.ownerId) {
    fail('Cannot remove the project owner', 400, ErrorCode.VALIDATION_ERROR);
  }

  const existing = await findProjectMember(project.id, targetUserId);
  if (!existing) {
    fail('Not found', 404, ErrorCode.NOT_FOUND);
  }

  const deleted = await deleteProjectMemberRecord(project.id, targetUserId);
  if (!deleted) {
    fail('Not found', 404, ErrorCode.NOT_FOUND);
  }

  await logAuditEvent({
    userId: actor.userId,
    tenantId: project.tenantId,
    action: AuditActions.PROJECT_MEMBER_REMOVED,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: {
      projectId: project.id,
      resourceType: 'project_member',
      resourceId: `${project.id}:${targetUserId}`,
      targetUserId,
      role: existing.role,
      customRoleId: existing.customRoleId ?? null,
    },
  });
}
