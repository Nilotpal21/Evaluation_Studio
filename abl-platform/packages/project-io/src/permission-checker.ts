/**
 * Permission Checker - resolves agent-level operations through cascading rules.
 *
 * Resolution order:
 * 1. Project owner -> full access to all agents
 * 2. Agent owner (individual) -> full access to owned agent
 * 3. Team owner (member of ownerTeam) -> access based on team role
 * 4. Explicit permission grant -> specific operations
 * 5. Project member role -> derived from canonical project RBAC permissions
 */

import { evaluateProjectPermission, type ProjectRoleName } from '@agent-platform/shared-auth';
import type { AgentOperation, PrincipalType } from './types.js';

export type ProjectRole = ProjectRoleName | 'custom';
export type TeamRole = 'lead' | 'member';

export interface PermissionContext {
  userId: string;
  projectOwnerId: string;
  projectMemberRole: ProjectRole | null;
  projectMemberCustomPermissions?: readonly string[] | string | null;
  agentOwnerId: string | null;
  agentOwnerTeamId: string | null;
  userTeamMemberships: Array<{ teamId: string; role: TeamRole }>;
  explicitPermissions: Array<{
    principalType: PrincipalType;
    principalId: string;
    operations: AgentOperation[];
    expiresAt: Date | null;
  }>;
}

const FULL_ACCESS: AgentOperation[] = ['view', 'edit', 'deploy', 'delete', 'transfer_ownership'];
const TEAM_LEAD_OPS: AgentOperation[] = ['view', 'edit', 'deploy', 'delete'];
const TEAM_MEMBER_OPS: AgentOperation[] = ['view', 'edit'];
const PROJECT_ROLE_OPERATION_PERMISSIONS: Readonly<
  Partial<Record<AgentOperation, readonly string[]>>
> = {
  view: ['agent:read'],
  edit: ['agent:update'],
  deploy: ['deployment:create'],
  delete: ['agent:delete'],
};

function resolveProjectRolePermissions(
  role: ProjectRole,
  customRolePermissions?: readonly string[] | string | null,
): AgentOperation[] {
  if (evaluateProjectPermission(role, '*:*', customRolePermissions)) {
    return [...FULL_ACCESS];
  }

  const allowedOperations = new Set<AgentOperation>();

  for (const operation of Object.keys(PROJECT_ROLE_OPERATION_PERMISSIONS) as Array<
    keyof typeof PROJECT_ROLE_OPERATION_PERMISSIONS
  >) {
    const requiredPermissions = PROJECT_ROLE_OPERATION_PERMISSIONS[operation];
    if (!requiredPermissions) {
      continue;
    }

    if (
      requiredPermissions.some((permission) =>
        evaluateProjectPermission(role, permission, customRolePermissions),
      )
    ) {
      allowedOperations.add(operation);
    }
  }

  return [...allowedOperations];
}

/**
 * Check if a user can perform a specific operation on an agent.
 */
export function canPerform(ctx: PermissionContext, operation: AgentOperation): boolean {
  const allowed = resolvePermissions(ctx);
  return allowed.includes(operation);
}

/**
 * Resolve all operations a user is allowed to perform on an agent.
 */
export function resolvePermissions(ctx: PermissionContext): AgentOperation[] {
  const now = new Date();

  if (ctx.userId === ctx.projectOwnerId) {
    return [...FULL_ACCESS];
  }

  if (ctx.agentOwnerId && ctx.userId === ctx.agentOwnerId) {
    return [...FULL_ACCESS];
  }

  if (ctx.agentOwnerTeamId) {
    const teamMembership = ctx.userTeamMemberships.find(
      (membership) => membership.teamId === ctx.agentOwnerTeamId,
    );
    if (teamMembership) {
      if (teamMembership.role === 'lead') {
        return [...TEAM_LEAD_OPS];
      }
      return [...TEAM_MEMBER_OPS];
    }
  }

  const explicitOperations = new Set<AgentOperation>();
  for (const permissionGrant of ctx.explicitPermissions) {
    if (permissionGrant.expiresAt && permissionGrant.expiresAt < now) {
      continue;
    }

    if (permissionGrant.principalType === 'user' && permissionGrant.principalId === ctx.userId) {
      for (const operation of permissionGrant.operations) {
        explicitOperations.add(operation);
      }
      continue;
    }

    if (permissionGrant.principalType === 'team') {
      const isMember = ctx.userTeamMemberships.some(
        (membership) => membership.teamId === permissionGrant.principalId,
      );
      if (isMember) {
        for (const operation of permissionGrant.operations) {
          explicitOperations.add(operation);
        }
      }
    }
  }

  if (explicitOperations.size > 0) {
    return [...explicitOperations];
  }

  if (ctx.projectMemberRole) {
    return resolveProjectRolePermissions(ctx.projectMemberRole, ctx.projectMemberCustomPermissions);
  }

  return [];
}
