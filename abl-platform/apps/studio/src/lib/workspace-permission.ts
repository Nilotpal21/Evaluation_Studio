import { NextResponse } from 'next/server';
import {
  TENANT_ROLE_NAMES,
  TENANT_ROLE_PERMISSIONS,
  hasPermission,
  type TenantRoleName,
} from '@agent-platform/shared/rbac';
import type { AuthenticatedUser } from './auth';
import { errorJson, ErrorCode } from './api-response';
import { findTenantMember } from '@/repos/workspace-repo';

export const WORKSPACE_PERMISSIONS = {
  READ: 'tenant:read',
  UPDATE: 'tenant:update',
  MANAGE_SETTINGS: 'tenant:manage_settings',
  MANAGE_MEMBERS: 'tenant:manage_members',
  AUTH_PROFILE_READ: 'auth-profile:read',
  AUTH_PROFILE_WRITE: 'auth-profile:write',
} as const;

type WorkspaceDenyBehavior = 'forbidden' | 'not_found';

interface WorkspaceMembershipRecord extends Record<string, unknown> {
  tenantId: string;
  userId: string;
  role: string;
  status?: string;
  customRoleId?: string | null;
}

export interface WorkspacePermissionContext {
  tenantId: string;
  user: AuthenticatedUser;
  membership: WorkspaceMembershipRecord;
  permissions: readonly string[];
}

interface WorkspaceAccessOptions {
  tenantStatuses?: readonly string[];
  memberStatuses?: readonly string[];
  denyBehavior?: WorkspaceDenyBehavior;
}

const TENANT_ROLE_NAME_SET = new Set(TENANT_ROLE_NAMES);

function normalizeTenantRole(role: unknown): TenantRoleName | null {
  if (typeof role !== 'string') {
    return null;
  }

  const normalizedRole = role.trim().toUpperCase() as TenantRoleName;
  return TENANT_ROLE_NAME_SET.has(normalizedRole) ? normalizedRole : null;
}

function permissionDeniedResponse(denyBehavior: WorkspaceDenyBehavior): NextResponse {
  if (denyBehavior === 'forbidden') {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }

  return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
}

function resolveWorkspacePermissionSet(
  membership: WorkspaceMembershipRecord,
  user: AuthenticatedUser,
): readonly string[] {
  if (typeof membership.customRoleId === 'string' && membership.customRoleId.length > 0) {
    return user.permissions ?? [];
  }

  const normalizedRole = normalizeTenantRole(membership.role);
  if (!normalizedRole) {
    return user.permissions ?? [];
  }

  return TENANT_ROLE_PERMISSIONS[normalizedRole];
}

export function canWorkspacePermissionContextPerform(
  context: WorkspacePermissionContext,
  requiredPermissions: string | readonly string[],
): boolean {
  const permissions = Array.isArray(requiredPermissions)
    ? requiredPermissions
    : [requiredPermissions];

  if (permissions.length === 0) {
    return false;
  }

  return permissions.some((permission) => hasPermission(context.permissions, permission));
}

export async function resolveWorkspacePermissionContext(
  tenantId: string,
  user: AuthenticatedUser,
  options?: WorkspaceAccessOptions,
): Promise<WorkspacePermissionContext | NextResponse> {
  const denyBehavior = options?.denyBehavior ?? 'not_found';

  if (!user.id) {
    return errorJson('Unauthorized', 401, ErrorCode.UNAUTHORIZED);
  }

  if (user.tenantId && tenantId !== user.tenantId) {
    return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
  }

  const membership = await findTenantMember(tenantId, user.id, {
    tenantStatuses: options?.tenantStatuses ? [...options.tenantStatuses] : undefined,
    memberStatuses: options?.memberStatuses ? [...options.memberStatuses] : undefined,
  });
  if (!membership) {
    return permissionDeniedResponse(denyBehavior);
  }

  return {
    tenantId,
    user,
    membership: membership as WorkspaceMembershipRecord,
    permissions: resolveWorkspacePermissionSet(membership as WorkspaceMembershipRecord, user),
  };
}

export async function requireWorkspacePermission(
  tenantId: string,
  user: AuthenticatedUser,
  requiredPermissions: string | readonly string[],
  options?: WorkspaceAccessOptions,
): Promise<WorkspacePermissionContext | NextResponse> {
  const context = await resolveWorkspacePermissionContext(tenantId, user, options);
  if (context instanceof NextResponse) {
    return context;
  }

  if (canWorkspacePermissionContextPerform(context, requiredPermissions)) {
    return context;
  }

  return permissionDeniedResponse(options?.denyBehavior ?? 'not_found');
}

export async function requireWorkspaceRole(
  tenantId: string,
  user: AuthenticatedUser,
  requiredRoles: string | readonly string[],
  options?: WorkspaceAccessOptions,
): Promise<WorkspacePermissionContext | NextResponse> {
  const context = await resolveWorkspacePermissionContext(tenantId, user, options);
  if (context instanceof NextResponse) {
    return context;
  }

  const roles = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];
  if (roles.includes(context.membership.role)) {
    return context;
  }

  return permissionDeniedResponse(options?.denyBehavior ?? 'not_found');
}

export function isWorkspacePermissionError(
  result: WorkspacePermissionContext | NextResponse,
): result is NextResponse {
  return result instanceof NextResponse;
}
