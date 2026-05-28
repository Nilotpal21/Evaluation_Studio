/**
 * Agent Permission Helper — bridge between Studio routes and the ownership permission system.
 *
 * Loads AgentOwnership + ProjectMember records from MongoDB, builds a PermissionContext,
 * and delegates to canPerform() from @agent-platform/project-io/ownership.
 *
 * Fails closed on DB errors: logs an error and denies the request.
 */

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { PROJECT_ROLE_NAMES } from '@agent-platform/shared/rbac';
import {
  canPerform,
  type PermissionContext,
  type ProjectRole,
} from '@agent-platform/project-io/ownership';
import type { AgentOperation } from '@agent-platform/project-io';
import type { AuthenticatedUser } from './auth';
import type { ProjectAccessResult } from './project-access';
import { ensureDb } from './ensure-db';
import { errorJson, ErrorCode } from './api-response';
import { resolveProjectCustomRolePermissions } from './permission-resolver';

const log = createLogger('agent-permission');
const PROJECT_ROLE_NAME_SET = new Set<ProjectRole>([...PROJECT_ROLE_NAMES, 'custom']);

export interface AgentPermissionResult {
  allowed: boolean;
  reason?: string;
  response?: NextResponse;
}

function normalizeProjectMemberRole(role: unknown): ProjectRole | null {
  if (typeof role !== 'string') {
    return null;
  }

  const normalizedRole = role.trim().toLowerCase() as ProjectRole;
  return PROJECT_ROLE_NAME_SET.has(normalizedRole) ? normalizedRole : null;
}

/**
 * Check whether the authenticated user can perform the given operation on an agent.
 *
 * Resolution loads AgentOwnership + ProjectMember from the database, then delegates
 * to the shared permission-checker. On any DB error, the helper **fails closed** —
 * logs an error and returns `{ allowed: false }`.
 */
export async function checkAgentPermission(
  projectId: string,
  agentId: string,
  user: AuthenticatedUser,
  project: ProjectAccessResult['project'],
  operation: AgentOperation,
): Promise<AgentPermissionResult> {
  try {
    // Workspace-level authority: tenant OWNER and ADMIN bypass agent-level checks.
    // Matches the runtime's requireProjectPermission behaviour (project:* permission).
    if (user.role === 'OWNER' || user.role === 'ADMIN') {
      return { allowed: true };
    }

    await ensureDb();

    const { AgentOwnership, ProjectMember, Team } = await import('@agent-platform/database/models');

    // Load ownership and membership in parallel.
    // agentId may be the agent name (from URL params) — try both agentId and agentName fields.
    const [ownershipDoc, memberDoc, userTeams] = await Promise.all([
      AgentOwnership.findOne({
        projectId,
        $or: [{ agentId }, { agentName: agentId }],
      }).lean(),
      ProjectMember.findOne({ projectId, userId: user.id }).lean(),
      Team.find({ tenantId: project.tenantId, 'members.userId': user.id }).lean(),
    ]);

    // Build team memberships from the user's teams
    const userTeamMemberships: Array<{ teamId: string; role: 'lead' | 'member' }> = [];
    if (userTeams && Array.isArray(userTeams)) {
      for (const team of userTeams) {
        const t = team as {
          _id: string;
          members: Array<{ userId: string; role: 'lead' | 'member' }>;
        };
        const membership = t.members.find((m) => m.userId === user.id);
        if (membership) {
          userTeamMemberships.push({ teamId: String(t._id), role: membership.role });
        }
      }
    }

    const projectMemberRole = normalizeProjectMemberRole(memberDoc?.role);
    if (memberDoc && !projectMemberRole) {
      log.warn('Agent permission check denied unsupported project member role', {
        projectId,
        agentId,
        userId: user.id,
        role: memberDoc.role,
        customRoleId:
          typeof memberDoc.customRoleId === 'string' ? memberDoc.customRoleId : undefined,
      });
    }

    const projectMemberCustomPermissions =
      projectMemberRole === 'custom'
        ? await resolveProjectCustomRolePermissions(
            project.tenantId,
            typeof memberDoc?.customRoleId === 'string' ? memberDoc.customRoleId : null,
          )
        : null;

    const ctx: PermissionContext = {
      userId: user.id,
      projectOwnerId: project.ownerId,
      projectMemberRole,
      projectMemberCustomPermissions,
      agentOwnerId: ownershipDoc?.ownerId ?? null,
      agentOwnerTeamId: ownershipDoc?.ownerTeamId ?? null,
      userTeamMemberships,
      explicitPermissions: (ownershipDoc?.permissions ?? []).map(
        (p: {
          principalType: 'user' | 'team';
          principalId: string;
          operations: AgentOperation[];
          expiresAt: Date | null;
        }) => ({
          principalType: p.principalType,
          principalId: p.principalId,
          operations: p.operations,
          expiresAt: p.expiresAt,
        }),
      ),
    };

    if (canPerform(ctx, operation)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      response: errorJson(
        `You do not have permission to ${operation} this agent`,
        403,
        ErrorCode.FORBIDDEN,
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Agent permission check failed, denying access', {
      projectId,
      agentId,
      userId: user.id,
      operation,
      error: message,
    });
    return {
      allowed: false,
      reason: 'Permission check unavailable',
      response: NextResponse.json(
        {
          success: false,
          error: { code: 'PERMISSION_CHECK_FAILED', message: 'Permission check unavailable' },
        },
        { status: 403 },
      ),
    };
  }
}
