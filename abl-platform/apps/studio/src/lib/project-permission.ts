import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  evaluateProjectPermission,
  hasExactPermission,
  hasPermission,
  isSensitiveExactPermission,
  PROJECT_ROLE_PERMISSIONS,
  PROJECT_ROLE_NAMES,
  type ProjectRoleName,
} from '@agent-platform/shared-auth/rbac';
import type { AuthenticatedUser } from './auth';
import { errorJson, ErrorCode } from './api-response';
import { ensureDb } from './ensure-db';
import { resolveProjectCustomRolePermissions } from './permission-resolver';
import { isAccessError, requireProjectAccess, type ProjectAccessResult } from './project-access';
import type { StudioPermission } from './permissions';

const log = createLogger('project-permission');
const PROJECT_TENANT_BYPASS_PERMISSION = 'project:*';
type ProjectMemberRole = ProjectRoleName | 'custom';
const PROJECT_ROLE_NAME_SET = new Set<ProjectMemberRole>([...PROJECT_ROLE_NAMES, 'custom']);

const STUDIO_PROJECT_PERMISSION_ALIASES: Partial<Record<StudioPermission, readonly string[]>> = {
  'tool:read': ['tool:read'],
  'tool:write': ['tool:write'],
  'tool:delete': ['tool:delete'],
  'tool:execute': ['tool:execute'],
  'workflow:read': ['workflow:read'],
  'workflow:write': ['workflow:write', 'workflow:create', 'workflow:update'],
  'workflow:delete': ['workflow:delete'],
  'workflow:execute': ['workflow:execute'],
  'connection:read': ['channel_connection:read'],
  'connection:write': ['channel_connection:create', 'channel_connection:update'],
  'connection:delete': ['channel_connection:delete'],
  'project:export': ['project:export'],
  'project:import': ['project:import'],
  'project:git': ['project:git'],
  'auth-profile:read': ['auth-profile:read', 'credential:read'],
  'auth-profile:write': [
    'auth-profile:create',
    'auth-profile:write',
    'credential:write',
    'credential:manage',
  ],
  'auth-profile:delete': ['auth-profile:delete', 'credential:delete', 'credential:manage'],
  'guardrail:read': ['guardrail:read'],
  'guardrail:write': ['guardrail:write'],
  'pii-pattern:read': ['pii-pattern:read'],
  'pii-pattern:write': ['pii-pattern:write'],
  'pii:reveal': ['pii:reveal'],
  'prompt:create': ['prompt:create'],
  'prompt:read': ['prompt:read'],
  'prompt:update': ['prompt:update'],
  'prompt:delete': ['prompt:delete'],
  'prompt:test': ['prompt:test'],
  'prompt:promote': ['prompt:promote'],
  'human_task:read': ['human_task:read'],
  'human_task:assign': ['human_task:assign'],
  'human_task:claim': ['human_task:claim'],
  'human_task:resolve': ['human_task:resolve'],
} as const;

export interface ProjectPermissionContext {
  project: ProjectAccessResult['project'];
  accessLevel: 'project_owner' | 'tenant_rbac' | 'project_member';
  role?: ProjectMemberRole;
  actorPermissions: readonly string[];
  customRolePermissions: readonly string[];
}

export function resolveEffectiveProjectScopedPermissions(
  context: ProjectPermissionContext,
): string[] {
  const permissions = new Set(context.actorPermissions);
  const addAliasPermissions = () => {
    const grants = (permission: string) => hasPermission([...permissions], permission);

    if (grants('channel_connection:read')) {
      permissions.add('connection:read');
    }
    if (grants('channel_connection:create') || grants('channel_connection:update')) {
      permissions.add('connection:write');
    }
    if (grants('channel_connection:delete')) {
      permissions.add('connection:delete');
    }

    if (grants('credential:read')) {
      permissions.add('auth-profile:read');
      permissions.add('auth_profile:read');
    }
    if (grants('credential:create') || grants('credential:write') || grants('credential:manage')) {
      permissions.add('auth-profile:create');
      permissions.add('auth-profile:write');
      permissions.add('auth_profile:write');
    }
    if (grants('credential:delete') || grants('credential:manage')) {
      permissions.add('auth-profile:delete');
      permissions.add('auth_profile:delete');
    }
  };

  if (context.accessLevel === 'project_owner' || context.accessLevel === 'tenant_rbac') {
    permissions.add('*:*');
    addAliasPermissions();
    return [...permissions];
  }

  if (context.role === 'custom') {
    for (const permission of context.customRolePermissions) {
      permissions.add(permission);
    }
    addAliasPermissions();
    return [...permissions];
  }

  const rolePermissions = context.role ? PROJECT_ROLE_PERMISSIONS[context.role] : [];
  for (const permission of rolePermissions) {
    permissions.add(permission);
  }
  addAliasPermissions();

  return [...permissions];
}

function normalizeProjectMemberRole(role: unknown): ProjectMemberRole | null {
  if (typeof role !== 'string') {
    return null;
  }

  const normalizedRole = role.trim().toLowerCase() as ProjectMemberRole;
  return PROJECT_ROLE_NAME_SET.has(normalizedRole) ? normalizedRole : null;
}

export function resolveStudioProjectPermissionAliases(
  permission: StudioPermission,
): readonly string[] | null {
  return STUDIO_PROJECT_PERMISSION_ALIASES[permission] ?? null;
}

export function canProjectPermissionContextPerform(
  context: ProjectPermissionContext,
  requiredPermissions: string | readonly string[],
): boolean {
  const permissions = Array.isArray(requiredPermissions)
    ? requiredPermissions
    : [requiredPermissions];

  if (permissions.length === 0) {
    return false;
  }

  return permissions.some((permission) => {
    if (isSensitiveExactPermission(permission)) {
      return (
        hasExactPermission(context.actorPermissions, permission) ||
        (context.accessLevel === 'project_member' &&
          context.role === 'custom' &&
          hasExactPermission(context.customRolePermissions, permission))
      );
    }

    if (context.accessLevel !== 'project_member') {
      return true;
    }

    if (!context.role) {
      return false;
    }

    return evaluateProjectPermission(context.role, permission, context.customRolePermissions);
  });
}

export async function resolveProjectPermissionContext(
  projectId: string,
  user: AuthenticatedUser,
  options?: { project?: ProjectAccessResult['project'] },
): Promise<ProjectPermissionContext | NextResponse> {
  if (!user.id) {
    return errorJson('Unauthorized', 401, ErrorCode.UNAUTHORIZED);
  }

  const access = options?.project
    ? { project: options.project }
    : await requireProjectAccess(projectId, user);
  if (isAccessError(access)) {
    return access;
  }

  if (access.project.ownerId === user.id) {
    return {
      project: access.project,
      accessLevel: 'project_owner',
      actorPermissions: user.permissions ?? [],
      customRolePermissions: [],
    };
  }

  if (hasPermission(user.permissions ?? [], PROJECT_TENANT_BYPASS_PERMISSION)) {
    return {
      project: access.project,
      accessLevel: 'tenant_rbac',
      actorPermissions: user.permissions ?? [],
      customRolePermissions: [],
    };
  }

  await ensureDb();

  const { ProjectMember } = await import('@agent-platform/database/models');
  const membership = await ProjectMember.findOne(
    { projectId, userId: user.id },
    { role: 1, customRoleId: 1 },
  ).lean();

  if (!membership) {
    return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
  }

  const normalizedRole = normalizeProjectMemberRole(membership.role);
  if (!normalizedRole) {
    log.warn('Project permission denied for unsupported project member role', {
      projectId,
      userId: user.id,
      role: membership.role,
      customRoleId:
        typeof membership.customRoleId === 'string' ? membership.customRoleId : undefined,
    });
    return errorJson('Forbidden: unsupported project role', 403, ErrorCode.FORBIDDEN);
  }

  const customRolePermissions =
    normalizedRole === 'custom'
      ? await resolveProjectCustomRolePermissions(
          access.project.tenantId,
          typeof membership.customRoleId === 'string' ? membership.customRoleId : null,
        )
      : [];

  return {
    project: access.project,
    accessLevel: 'project_member',
    role: normalizedRole,
    actorPermissions: user.permissions ?? [],
    customRolePermissions,
  };
}

export async function requireProjectPermission(
  projectId: string,
  user: AuthenticatedUser,
  requiredPermissions: string | readonly string[],
  options?: { project?: ProjectAccessResult['project'] },
): Promise<ProjectPermissionContext | NextResponse> {
  const context = await resolveProjectPermissionContext(projectId, user, options);
  if (context instanceof NextResponse) {
    return context;
  }

  if (canProjectPermissionContextPerform(context, requiredPermissions)) {
    return context;
  }

  const permissions = Array.isArray(requiredPermissions)
    ? requiredPermissions
    : [requiredPermissions];
  return errorJson(
    `Forbidden: missing required project permission (${permissions.join(' | ')})`,
    403,
    ErrorCode.FORBIDDEN,
  );
}

export function isProjectPermissionError(
  result: ProjectPermissionContext | NextResponse,
): result is NextResponse {
  return result instanceof NextResponse;
}
